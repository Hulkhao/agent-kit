// Behavioral tests for the #27 re-review (P1-1..P1-4). The sweep/classification
// logic is exercised through the injectable unit in monitor/release-sweep.mjs
// with fake task/pages/ledger/audit doubles — no ego-browser runtime, no source
// regex matching. Registry-level recovery (sweepPending) runs against the real
// ego-taskspaces.json state machine in a temp directory.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TERMINAL_DISPATCH, anchoredLedgerStatus, classifySweepPage, sweepTaskPages,
  makeSweepAudit, shouldFinishSpace, releaseHasNothingOutstanding,
} from "../monitor/release-sweep.mjs";
import {
  withAgentRegistry, claimAgentSpace, releaseAgentConversation,
  assertTaskSpaceNamingAllowed, markAgentSweepPending, clearAgentSweepPending,
} from "../monitor/agent-space.mjs";
import { authorizeSpaceRebuild, classifyManagerResult } from "../monitor/dispatch-manager.mjs";

const AGENT = "gdc-a";
const SPACE = "agentkit-dispatch-gdc-a-20261116";
const CONV = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const THIRD = "33333333-3333-4333-8333-333333333333";

const chatUrl = (uuid) => "https://chatgpt.com/c/" + uuid;

// A structurally valid dispatch record (validateDispatchRecord passes).
const validLedger = (uuid, status, space = SPACE) => ({
  schema: "ego-dispatch-state/v2", dispatchId: randomUUID(), conversationUuid: uuid,
  taskSpace: space, pageLabel: "p1", status,
  baselineTailKey: null, baselineTailRole: null, baselineComposerLength: 0,
  attempt: 1, createdAt: Date.now(), payload_sha256: null, payload_bytes: null,
});

async function writeLedger(root, uuid, record) {
  const dir = join(root, "conversations", uuid.toLowerCase());
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "a-dispatch-state.json"), JSON.stringify(record));
}

const fakePage = (url, log, closeError) => ({
  label: "L-" + url.slice(-6),
  url: async () => { if (url === "THROW") throw new Error("URL_UNREADABLE"); return url; },
  close: async () => {
    if (closeError) throw closeError;
    log?.push(url);
  },
});

const fakeTask = (pages, { enumError } = {}) => ({
  pages: async () => { if (enumError) throw enumError; return pages; },
});

test("#27 re-review P1-1: an illegal NEW name stops before any registry binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-naming-gate-"));
  try {
    // The shared gate fails closed for a missing, non-conforming space.
    await assert.throws(() => assertTaskSpaceNamingAllowed("agentkit-dispatch", AGENT, false),
      (error) => error.code === "TASKSPACE_NAMING_VIOLATION_STOP");
    // Template-shaped flow (gate → claim): the gate throws, the claim never
    // runs, and the registry shows NO binding increment for the agent.
    let claimed = false;
    try {
      assertTaskSpaceNamingAllowed("agentkit-dispatch", AGENT, false);
      await claimAgentSpace({ agentId: AGENT, spaceName: "agentkit-dispatch", directory: root });
      claimed = true;
    } catch (error) {
      assert.equal(error.code, "TASKSPACE_NAMING_VIOLATION_STOP");
    }
    assert.equal(claimed, false);
    // No binding increment — the registry file isn't even created when the
    // gate rejects before the claim.
    const registry = await readFile(join(root, "ego-taskspaces.json"), "utf8")
      .then((raw) => JSON.parse(raw))
      .catch((error) => (error.code === "ENOENT" ? null : Promise.reject(error)));
    assert.equal(registry, null);
    // The polluted-binding detour is closed: with no registry entry and no
    // allowlist, rebuild-space still refuses to authorize the creation.
    await assert.rejects(authorizeSpaceRebuild(AGENT, "agentkit-dispatch", { directory: root }),
      /SPACE_REBUILD_NOT_AUTHORIZED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#27 re-review P1-1: legacy reuse stays legal; conforming new names claim and rebuild", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-naming-legacy-"));
  try {
    // An EXISTING space passes the gate under ANY name — legacy names keep
    // working (no rename, no migration).
    assert.doesNotThrow(() => assertTaskSpaceNamingAllowed("GDC-执行A", AGENT, true));
    assert.doesNotThrow(() => assertTaskSpaceNamingAllowed("agentkit-dispatch", AGENT, true));
    // A missing space with a conforming name passes and claims normally.
    assert.doesNotThrow(() => assertTaskSpaceNamingAllowed(SPACE, AGENT, false));
    assertTaskSpaceNamingAllowed(SPACE, AGENT, false);
    const entry = await claimAgentSpace({ agentId: AGENT, spaceName: SPACE, directory: root });
    assert.equal(entry.spaceName, SPACE);
    // The #31 rebuild authorization chain keeps working for the bound agent.
    assert.equal(await authorizeSpaceRebuild(AGENT, SPACE, { directory: root }), "LEDGER_PROOF");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#27 re-review P1-2: the last-conversation sweep keeps blank/active/unproven pages open", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-sweep-keep-"));
  try {
    await writeLedger(root, OTHER, validLedger(OTHER, "ACCEPTED")); // active ledger
    const pages = [
      fakePage("about:blank", null),                    // blank → OWNERSHIP_UNPROVEN
      fakePage("chrome://newtab/", null),               // blank variant → OWNERSHIP_UNPROVEN
      fakePage(chatUrl(OTHER), null),                   // active ledger → ACTIVE_DISPATCH_LEDGER
      fakePage(chatUrl(THIRD), null),                   // no ledger file → LEDGER_UNPROVEN
      fakePage("https://example.com/c/" + OTHER, null), // foreign host → OWNERSHIP_UNPROVEN
      fakePage("THROW", null),                          // unreadable URL → OWNERSHIP_UNPROVEN
    ];
    const closed = [];
    const auditFile = join(root, "a-release-sweep-audit.ndjson");
    const sweep = await sweepTaskPages({
      task: fakeTask(pages), monitorDir: root, agentId: AGENT, space: SPACE,
      conversationUuid: CONV, known: [CONV, OTHER], auditFile,
    });
    assert.equal(sweep.failed, 0);
    assert.equal(sweep.closed, 0);
    assert.deepEqual(closed, []); // not a single page.close() ran
    const lines = (await readFile(auditFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.length, pages.length);
    for (const line of lines) {
      assert.equal(line.decision, "kept");
      assert.ok(["OWNERSHIP_UNPROVEN", "ACTIVE_DISPATCH_LEDGER", "LEDGER_UNPROVEN"].includes(line.reason),
        "unexpected keep reason: " + line.reason);
    }
    // Kept pages block the space finish — the space stays alive for its owner.
    assert.equal(shouldFinishSpace({ finished: true, hasTask: true, kept: sweep.kept, failed: 0 }), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#27 re-review P1-2/P1-4: valid terminal-ledger pages close; an empty space may finish", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-sweep-close-"));
  try {
    await writeLedger(root, OTHER, validLedger(OTHER, "COMPLETED"));
    await writeLedger(root, THIRD, validLedger(THIRD, "ABORTED"));
    const closed = [];
    const auditFile = join(root, "a-release-sweep-audit.ndjson");
    const sweep = await sweepTaskPages({
      task: fakeTask([fakePage(chatUrl(OTHER), closed), fakePage(chatUrl(THIRD), closed)]),
      monitorDir: root, agentId: AGENT, space: SPACE,
      conversationUuid: CONV, known: [CONV, OTHER, THIRD], auditFile,
    });
    assert.equal(sweep.failed, 0);
    assert.equal(sweep.closed, 2);
    assert.deepEqual(closed.sort(), [chatUrl(OTHER), chatUrl(THIRD)].sort());
    const lines = (await readFile(auditFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    for (const line of lines) {
      assert.equal(line.decision, "closed");
      assert.equal(line.reason, "TEMP_RESULT_PAGE_FINISHED_DISPATCH");
      assert.equal(line.action, "release-sweep");
    }
    // Last conversation, nothing kept, no failures → the provably empty space
    // may be finished (documented finish({keep:[]}) form).
    assert.equal(shouldFinishSpace({ finished: true, hasTask: true, kept: 0, failed: 0 }), true);
    assert.equal(shouldFinishSpace({ finished: false, hasTask: true, kept: 0, failed: 0 }), false);
    assert.equal(shouldFinishSpace({ finished: true, hasTask: false, kept: 0, failed: 0 }), false);
    assert.equal(shouldFinishSpace({ finished: true, hasTask: true, kept: 0, failed: 1 }), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#27 re-review P1-4: structurally broken or unanchored ledgers never close a page", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-sweep-ledger-"));
  try {
    // The exact defect class: a bare terminal-looking object must be rejected.
    await writeLedger(root, OTHER, { status: "COMPLETED" });
    // Valid structure but wrong conversation / wrong space.
    await writeLedger(root, THIRD, validLedger(CONV, "COMPLETED"));           // uuid mismatch
    await writeLedger(root, CONV, validLedger(CONV, "COMPLETED", "other-space")); // space mismatch
    // "RELEASED" is not in the validator's frozen status set — nothing writes it.
    const closed = [];
    const auditFile = join(root, "a-release-sweep-audit.ndjson");
    const sweep = await sweepTaskPages({
      task: fakeTask([fakePage(chatUrl(OTHER), closed), fakePage(chatUrl(THIRD), closed), fakePage(chatUrl(CONV), closed)]),
      monitorDir: root, agentId: AGENT, space: SPACE,
      conversationUuid: CONV, known: [CONV, OTHER, THIRD], auditFile,
    });
    assert.equal(sweep.closed, 0);
    assert.equal(sweep.failed, 0);
    assert.deepEqual(closed, []);
    assert.equal(await anchoredLedgerStatus(root, OTHER, SPACE), null); // bare object → null
    assert.equal(await anchoredLedgerStatus(root, THIRD, SPACE), null); // uuid mismatch → null
    assert.equal(await anchoredLedgerStatus(root, CONV, SPACE), null);  // space mismatch → null
    assert.equal(TERMINAL_DISPATCH.has("RELEASED"), false);             // unified set
    // The unified set never lets "RELEASED" close a page: a ledger whose
    // status fails the frozen validator set arrives as null → LEDGER_UNPROVEN
    // (kept); even the raw string would only ever be kept, never closed.
    assert.equal(await anchoredLedgerStatus(root, OTHER, SPACE) === "RELEASED", false);
    const verdict = classifySweepPage({ uuid: OTHER, conversationUuid: CONV,
      known: [OTHER], status: "RELEASED" });
    assert.equal(verdict.decision, "kept");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#27 re-review P1-3: a close failure keeps sweepPending; the rerun really re-sweeps", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-sweep-retry-"));
  try {
    await claimAgentSpace({ agentId: AGENT, spaceName: SPACE, directory: root });
    await writeLedger(root, OTHER, validLedger(OTHER, "COMPLETED"));
    const auditFile = join(root, "a-release-sweep-audit.ndjson");
    // First attempt: page.close fails.
    const broken = new Error("ECONNRESET"); broken.code = "ECONNRESET";
    const first = await sweepTaskPages({
      task: fakeTask([fakePage(chatUrl(OTHER), null, broken)]),
      monitorDir: root, agentId: AGENT, space: SPACE,
      conversationUuid: CONV, known: [CONV, OTHER], auditFile,
    });
    assert.equal(first.failed, 1);
    assert.equal(first.closed, 0);
    const firstLine = JSON.parse((await readFile(auditFile, "utf8")).trim().split("\n").at(-1));
    assert.equal(firstLine.decision, "close-failed");
    assert.match(firstLine.reason, /PAGE_CLOSE_FAILED:ECONNRESET/);
    assert.equal(shouldFinishSpace({ finished: true, hasTask: true, kept: 0, failed: first.failed }), false);
    // Manager classification: the incomplete cleanup is exit 2, never success.
    assert.equal(classifyManagerResult("release", { code: 0, result: "AGENT_SPACE_RELEASE_SWEEP_FAILED" }, null, {}), 2);
    // Intent recorded → the rerun may NOT take the zero-browser early exit.
    await markAgentSweepPending({ agentId: AGENT, spaceName: SPACE, conversationUuid: CONV, directory: root });
    const pendingEntry = await withAgentRegistry((registry) => ({
      changed: false, value: registry.agents[AGENT],
    }), root);
    assert.equal(pendingEntry.sweepPending.conversationUuid, CONV);
    assert.equal(releaseHasNothingOutstanding(pendingEntry, CONV), false);
    // Rerun with a healthy page: the sweep really executes this time.
    const rerunClosed = [];
    const second = await sweepTaskPages({
      task: fakeTask([fakePage(chatUrl(OTHER), rerunClosed)]),
      monitorDir: root, agentId: AGENT, space: SPACE,
      conversationUuid: CONV, known: [CONV, OTHER], auditFile,
    });
    assert.deepEqual({ closed: second.closed, failed: second.failed }, { closed: 1, failed: 0 });
    assert.deepEqual(rerunClosed, [chatUrl(OTHER)]);
    // Only a fully successful sweep clears the flag; afterwards the repeat
    // release may take the zero-browser early exit again.
    await clearAgentSweepPending({ agentId: AGENT, spaceName: SPACE, conversationUuid: CONV, directory: root });
    const cleanEntry = await withAgentRegistry((registry) => ({
      changed: false, value: registry.agents[AGENT],
    }), root);
    assert.equal(cleanEntry.sweepPending, undefined);
    assert.equal(releaseHasNothingOutstanding(cleanEntry, CONV), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#27 re-review P1-3: an enumeration failure is recoverable and never overwrites another conversation's flag", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-sweep-enum-"));
  try {
    await claimAgentSpace({ agentId: AGENT, spaceName: SPACE, directory: root });
    const auditFile = join(root, "a-release-sweep-audit.ndjson");
    const boom = new Error("DETACHED");
    const first = await sweepTaskPages({
      task: fakeTask([], { enumError: boom }),
      monitorDir: root, agentId: AGENT, space: SPACE,
      conversationUuid: CONV, known: [CONV], auditFile,
    });
    assert.equal(first.failed, 1);
    const line = JSON.parse((await readFile(auditFile, "utf8")).trim().split("\n").at(-1));
    assert.equal(line.decision, "sweep-failed");
    assert.equal(line.reason, "PAGE_ENUMERATION_FAILED");
    assert.equal(releaseHasNothingOutstanding({ active: [], sweepPending: { conversationUuid: CONV } }, CONV), false);
    // A second conversation must not steal the recovery slot (fail-closed).
    await markAgentSweepPending({ agentId: AGENT, spaceName: SPACE, conversationUuid: CONV, directory: root });
    await assert.rejects(
      markAgentSweepPending({ agentId: AGENT, spaceName: SPACE, conversationUuid: OTHER, directory: root }),
      (error) => error.code === "AGENT_SPACE_SWEEP_PENDING");
    // Clearing a different conversation's flag is a no-op, not an error.
    await clearAgentSweepPending({ agentId: AGENT, spaceName: SPACE, conversationUuid: OTHER, directory: root });
    const entry = await withAgentRegistry((registry) => ({ changed: false, value: registry.agents[AGENT] }), root);
    assert.equal(entry.sweepPending.conversationUuid, CONV); // untouched
    // Recovery: a healthy rerun succeeds and clears.
    const recovered = await sweepTaskPages({
      task: fakeTask([]), monitorDir: root, agentId: AGENT, space: SPACE,
      conversationUuid: CONV, known: [CONV], auditFile,
    });
    assert.deepEqual(recovered, { closed: 0, kept: 0, failed: 0 }); // zero-close success
    await clearAgentSweepPending({ agentId: AGENT, spaceName: SPACE, conversationUuid: CONV, directory: root });
    const clean = await withAgentRegistry((registry) => ({ changed: false, value: registry.agents[AGENT] }), root);
    assert.equal(releaseHasNothingOutstanding(clean, CONV), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#27 re-review: an audit-write failure counts as incomplete cleanup and is recoverable on rerun", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-sweep-audit-"));
  try {
    await claimAgentSpace({ agentId: AGENT, spaceName: SPACE, directory: root });
    await writeLedger(root, OTHER, validLedger(OTHER, "COMPLETED"));
    // The audit target is a directory → every appendFile fails (EISDIR).
    const first = await sweepTaskPages({
      task: fakeTask([fakePage(chatUrl(OTHER), null)]),
      monitorDir: root, agentId: AGENT, space: SPACE,
      conversationUuid: CONV, known: [CONV, OTHER], auditFile: root, // directory!
    });
    assert.equal(first.closed, 1); // the close itself succeeded…
    assert.equal(first.failed, 1); // …but the unauditable cleanup is incomplete
    // Real failure shape of the default writer.
    const audit = makeSweepAudit({ auditFile: root, agentId: AGENT, space: SPACE, conversationUuid: CONV });
    await assert.rejects(audit({ decision: "kept", reason: "X" }));
    // Recovery rerun with a writable audit file: zero failures, lines written.
    const auditFile = join(root, "a-release-sweep-audit.ndjson");
    const second = await sweepTaskPages({
      task: fakeTask([fakePage(chatUrl(OTHER), null)]),
      monitorDir: root, agentId: AGENT, space: SPACE,
      conversationUuid: CONV, known: [CONV, OTHER], auditFile,
    });
    assert.deepEqual({ closed: second.closed, failed: second.failed }, { closed: 1, failed: 0 });
    const lines = (await readFile(auditFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].page.uuid, OTHER);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#27 re-review: sweepPending coexists with the release state machine; full success is zero-browser idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-sweep-state-"));
  try {
    await claimAgentSpace({ agentId: AGENT, spaceName: SPACE, conversationUuid: CONV, directory: root });
    await markAgentSweepPending({ agentId: AGENT, spaceName: SPACE, conversationUuid: CONV, directory: root });
    // The managed release still works with sweepPending present — the flags
    // are orthogonal (releasePending guards the target page, sweepPending the sweep).
    const closed = [];
    const result = await releaseAgentConversation({
      agentId: AGENT, spaceName: SPACE, conversationUuid: CONV, directory: root,
      closePage: async () => { closed.push("target"); },
      finishSpace: async () => { closed.push("space"); },
      alreadyReleased: async () => false,
    });
    // CONV is the only active conversation → the finish branch runs (in the
    // template that branch is the P1-2 target-only close, no blanket finish).
    assert.deepEqual(closed, ["space"]);
    assert.equal(result.finished, true);
    assert.equal(result.active.length, 0);
    // A space-gone rerun shape: no task → zero-close success, nothing thrown.
    const sweep = await sweepTaskPages({
      task: null, monitorDir: root, agentId: AGENT, space: SPACE,
      conversationUuid: CONV, known: [CONV],
    });
    assert.deepEqual(sweep, { closed: 0, kept: 0, failed: 0 });
    // Full success clears the flag; afterwards the repeat release takes the
    // zero-browser early exit (no active, no releasePending, no sweepPending).
    await clearAgentSweepPending({ agentId: AGENT, spaceName: SPACE, conversationUuid: CONV, directory: root });
    const entry = await withAgentRegistry((registry) => ({ changed: false, value: registry.agents[AGENT] }), root);
    assert.equal(releaseHasNothingOutstanding(entry, CONV), true);
    // The remaining out-states all force a real run.
    assert.equal(releaseHasNothingOutstanding({ active: [CONV] }, CONV), false);
    assert.equal(releaseHasNothingOutstanding({ active: [], releasePending: { conversationUuid: CONV } }, CONV), false);
    assert.equal(releaseHasNothingOutstanding({ active: [], sweepPending: { conversationUuid: CONV } }, CONV), false);
    assert.equal(releaseHasNothingOutstanding(null, CONV), false);
    // Boundary: sweepPending does NOT change the #33 rebuild chain — the
    // authorized rebuild decision stays LEDGER_PROOF (chain untouched).
    assert.equal(await authorizeSpaceRebuild(AGENT, SPACE, { directory: root }), "LEDGER_PROOF");
  } finally { await rm(root, { recursive: true, force: true }); }
});
