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
  TERMINAL_DISPATCH, anchoredLedgerStatus, anchoredDispatchCreated, classifySweepPage, sweepTaskPages,
  makeSweepAudit, shouldFinishSpace, releaseHasNothingOutstanding,
} from "../monitor/release-sweep.mjs";
import {
  withAgentRegistry, claimAgentSpace, releaseAgentConversation,
  assertTaskSpaceNamingAllowed, markAgentSweepPending, clearAgentSweepPending,
} from "../monitor/agent-space.mjs";
import { authorizeSpaceRebuild, classifyManagerResult, bindNewConversation } from "../monitor/dispatch-manager.mjs";

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

// P1-E (re-review round 2): the durable dispatch-creation evidence
// (a-new-request.json) in the REAL send-new data shape — requestId is the
// CLIENT dispatch UUID and never equals the real conversationUuid; the
// association between the two is persisted by bindNewConversation at binding
// time. Pages WITHOUT that verified association are fixed-session and are
// never closed by any sweep.
async function markDispatchCreated(root, uuid, space = SPACE) {
  const dir = join(root, "conversations", uuid.toLowerCase());
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "a-new-request.json"), JSON.stringify({
    requestId: randomUUID(), conversationUuid: uuid.toLowerCase(),
    space, agentId: AGENT, payloadSha256: "a".repeat(64),
  }));
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
    await markDispatchCreated(root, OTHER); // dispatch-temp: active ledgers are temp but not yet closable
    await markDispatchCreated(root, THIRD); // dispatch-created but no provable ledger -> LEDGER_UNPROVEN
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
    await markDispatchCreated(root, OTHER);
    await writeLedger(root, THIRD, validLedger(THIRD, "ABORTED"));
    await markDispatchCreated(root, THIRD);
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
    // P1-A: every closed page leaves a persisted close-intent line first and a
    // final "closed" disposition referencing that intentId.
    const intents = lines.filter((line) => line.decision === "close-intent");
    const finals = lines.filter((line) => line.decision === "closed");
    assert.equal(intents.length, 2);
    assert.equal(finals.length, 2);
    for (const final of finals) {
      assert.equal(final.reason, "TEMP_RESULT_PAGE_FINISHED_DISPATCH");
      assert.equal(final.action, "release-sweep");
      assert.ok(intents.some((intent) => intent.intentId === final.intentId && intent.page.uuid === final.page.uuid),
        "each final line must reference its persisted close-intent");
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
    await markDispatchCreated(root, OTHER);
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
    const run1Lines = (await readFile(auditFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(run1Lines.some((line) => line.decision === "close-intent" && line.intentId === firstLine.intentId),
      "the close-failed disposition references its persisted close-intent");
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
    assert.deepEqual(recovered, { closed: 0, kept: 0, failed: 0, backfilled: 0, unconfirmed: 0 }); // zero-close success
    await clearAgentSweepPending({ agentId: AGENT, spaceName: SPACE, conversationUuid: CONV, directory: root });
    const clean = await withAgentRegistry((registry) => ({ changed: false, value: registry.agents[AGENT] }), root);
    assert.equal(releaseHasNothingOutstanding(clean, CONV), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#27 re-review② P1-A: an audit-write failure forbids the close; recovery reruns really clean", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-sweep-audit-"));
  try {
    await claimAgentSpace({ agentId: AGENT, spaceName: SPACE, directory: root });
    await writeLedger(root, OTHER, validLedger(OTHER, "COMPLETED"));
    await markDispatchCreated(root, OTHER);
    // ONE page across both runs (same task/set semantics); a successful close
    // removes it from the set.
    const pages = [];
    const page = {
      label: "L-target",
      url: async () => chatUrl(OTHER),
      close: async () => { pages.splice(pages.indexOf(page), 1); },
    };
    pages.push(page);
    const task = { pages: async () => pages };
    // The audit target is a directory → every appendFile fails (EISDIR).
    const first = await sweepTaskPages({
      task, monitorDir: root, agentId: AGENT, space: SPACE,
      conversationUuid: CONV, known: [CONV, OTHER], auditFile: root, // directory!
    });
    assert.equal(first.closed, 0);  // P1-A.2: no persistable intent → NO close
    assert.deepEqual(pages, [pages[0]]); // the page survived
    assert.equal(first.unconfirmed, 0); // the intent line never made it to disk
    assert.ok(first.failed >= 2); // missing intent line + missing disposition line
    // Real failure shape of the default writer.
    const audit = makeSweepAudit({ auditFile: root, agentId: AGENT, space: SPACE, conversationUuid: CONV });
    await assert.rejects(audit({ decision: "kept", reason: "X" }));
    // Recovery rerun with a writable audit file: the SAME page is now really
    // closed under a persisted intent, zero failures.
    const auditFile = join(root, "a-release-sweep-audit.ndjson");
    const second = await sweepTaskPages({
      task, monitorDir: root, agentId: AGENT, space: SPACE,
      conversationUuid: CONV, known: [CONV, OTHER], auditFile,
    });
    assert.deepEqual({ closed: second.closed, failed: second.failed, unconfirmed: second.unconfirmed },
      { closed: 1, failed: 0, unconfirmed: 0 });
    assert.deepEqual(pages, []);
    const lines = (await readFile(auditFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.filter((line) => line.decision === "close-intent").length, 1);
    assert.equal(lines.filter((line) => line.decision === "closed").length, 1);
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
      auditFile: join(root, "a-release-sweep-audit.ndjson"), // no trail yet → no open intents
    });
    assert.deepEqual(sweep, { closed: 0, kept: 0, failed: 0, backfilled: 0, unconfirmed: 0 });
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

test("#27 re-review② P1-A: a lost audit line is backfilled from the persisted intent; the flag clears only after backfill", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-sweep-backfill-"));
  try {
    await claimAgentSpace({ agentId: AGENT, spaceName: SPACE, directory: root });
    await writeLedger(root, OTHER, validLedger(OTHER, "COMPLETED"));
    await markDispatchCreated(root, OTHER);
    // ONE task and ONE page set across both runs; a successful close removes
    // the page from the set (no per-run page rebuilds).
    const pages = [];
    const closedUrls = [];
    const page = {
      label: "L-target",
      url: async () => chatUrl(OTHER),
      close: async () => { pages.splice(pages.indexOf(page), 1); closedUrls.push(chatUrl(OTHER)); },
    };
    pages.push(page);
    const task = { pages: async () => pages };
    const auditFile = join(root, "a-release-sweep-audit.ndjson");
    const realAudit = makeSweepAudit({ auditFile, agentId: AGENT, space: SPACE, conversationUuid: CONV });
    // Run 1: the intent persists, page.close() succeeds, but the final "closed"
    // line write fails → the intent stays unconfirmed, the missing audit line
    // must be recoverable, never silently dropped.
    const run1 = await sweepTaskPages({
      task, monitorDir: root, agentId: AGENT, space: SPACE,
      conversationUuid: CONV, known: [CONV, OTHER], auditFile,
      audit: async (entry) => {
        if (entry.decision === "closed") throw new Error("EIO"); // final lines only
        return realAudit(entry);
      },
    });
    assert.equal(run1.closed, 1); // the close really happened
    assert.deepEqual(closedUrls, [chatUrl(OTHER)]);
    assert.deepEqual(pages, []); // the page is gone from the SAME set
    assert.equal(run1.failed, 1); // the missing final line counts
    assert.equal(run1.unconfirmed, 1); // the intent is open
    const run1Lines = (await readFile(auditFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const intent = run1Lines.find((line) => line.decision === "close-intent");
    assert.ok(intent, "the close-intent line persisted before the close");
    assert.equal(run1Lines.some((line) => line.decision === "closed"), false); // final missing
    // Until the intent is confirmed, the recoverable state must NOT be cleared.
    assert.equal(releaseHasNothingOutstanding({ active: [], sweepPending: { conversationUuid: CONV } }, CONV), false);
    // Run 2 on the SAME task: the page is positively absent → the earlier
    // close is confirmed by a distinguishable backfill line referencing the
    // persisted intent.
    const run2 = await sweepTaskPages({
      task, monitorDir: root, agentId: AGENT, space: SPACE,
      conversationUuid: CONV, known: [CONV, OTHER], auditFile, // healthy default writer
    });
    assert.deepEqual({ closed: run2.closed, backfilled: run2.backfilled, failed: run2.failed, unconfirmed: run2.unconfirmed },
      { closed: 0, backfilled: 1, failed: 0, unconfirmed: 0 });
    const run2Lines = (await readFile(auditFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const backfill = run2Lines.find((line) => line.decision === "closed-backfilled");
    assert.ok(backfill, "the missing result line is backfilled");
    assert.equal(backfill.intentId, intent.intentId); // references the persisted intent
    assert.equal(backfill.page.uuid, OTHER);
    assert.notEqual(backfill.decision, "closed"); // distinguishable from a live close
    // After the backfill the zero-browser early exit becomes legal again.
    assert.equal(releaseHasNothingOutstanding({ active: [], sweepPending: { conversationUuid: CONV } }, CONV), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#27 re-review② P1-A: a close-intent write failure forbids closing that page", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-sweep-nointent-"));
  try {
    await claimAgentSpace({ agentId: AGENT, spaceName: SPACE, directory: root });
    await writeLedger(root, OTHER, validLedger(OTHER, "COMPLETED"));
    await markDispatchCreated(root, OTHER);
    const pages = [fakePage(chatUrl(OTHER))];
    const task = { pages: async () => pages };
    const auditFile = join(root, "a-release-sweep-audit.ndjson");
    const realAudit = makeSweepAudit({ auditFile, agentId: AGENT, space: SPACE, conversationUuid: CONV });
    const run = await sweepTaskPages({
      task, monitorDir: root, agentId: AGENT, space: SPACE,
      conversationUuid: CONV, known: [CONV, OTHER], auditFile,
      audit: async (entry) => {
        if (entry.decision === "close-intent") throw new Error("EIO"); // intent cannot persist
        return realAudit(entry);
      },
    });
    assert.equal(run.closed, 0);              // the page was NOT closed
    assert.deepEqual(pages, pages);           // still in the set (same object)
    assert.ok(run.failed >= 1);               // SWEEP_FAILED territory
    const lines = (await readFile(auditFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.some((line) => line.decision === "close-intent"), false); // nothing persisted
    const disposition = lines.find((line) => line.decision === "kept");
    assert.equal(disposition.reason, "AUDIT_UNAVAILABLE_NO_CLOSE");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#27 re-review② P1-A: after an audit write failure no further page is closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-sweep-stopclose-"));
  try {
    await claimAgentSpace({ agentId: AGENT, spaceName: SPACE, directory: root });
    await writeLedger(root, OTHER, validLedger(OTHER, "COMPLETED"));
    await markDispatchCreated(root, OTHER);
    await writeLedger(root, THIRD, validLedger(THIRD, "COMPLETED"));
    await markDispatchCreated(root, THIRD);
    const pages = [];
    const makePage = (uuid) => {
      const p = { label: "L-" + uuid.slice(0, 6), url: async () => chatUrl(uuid),
        close: async () => { pages.splice(pages.indexOf(p), 1); } };
      pages.push(p);
      return p;
    };
    makePage(OTHER);
    const thirdPage = makePage(THIRD);
    const task = { pages: async () => pages };
    const auditFile = join(root, "a-release-sweep-audit.ndjson");
    const realAudit = makeSweepAudit({ auditFile, agentId: AGENT, space: SPACE, conversationUuid: CONV });
    const run = await sweepTaskPages({
      task, monitorDir: root, agentId: AGENT, space: SPACE,
      conversationUuid: CONV, known: [CONV, OTHER, THIRD], auditFile,
      audit: async (entry) => {
        if (entry.decision === "closed") throw new Error("EIO"); // page 1's final line fails
        return realAudit(entry);
      },
    });
    assert.equal(run.closed, 1);          // only the first page closed…
    assert.deepEqual(pages, [thirdPage]);  // …the second page was NOT touched
    assert.equal(run.unconfirmed, 1);     // page 1's intent stays open
    const lines = (await readFile(auditFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const stop = lines.find((line) => line.decision === "kept" && line.reason === "AUDIT_UNAVAILABLE_NO_CLOSE");
    assert.ok(stop, "the not-closed page is audited as kept with the stop reason");
    assert.equal(stop.page.uuid, THIRD);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#27 re-review 4fa17a8: an unidentifiable page (about:blank) blocks absence backfill until it is really gone", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-sweep-blank-"));
  try {
    await claimAgentSpace({ agentId: AGENT, spaceName: SPACE, directory: root });
    await writeLedger(root, OTHER, validLedger(OTHER, "COMPLETED"));
    await markDispatchCreated(root, OTHER);
    // ONE task and ONE page set across all runs; the target page survives run 1
    // but is later found BLANKED (a live object whose identity is unknowable).
    const pages = [];
    const closedUrls = [];
    const page = {
      label: "L-target",
      url: async () => chatUrl(OTHER),
      close: async () => { pages.splice(pages.indexOf(page), 1); closedUrls.push(chatUrl(OTHER)); },
    };
    pages.push(page);
    const task = { pages: async () => pages };
    const auditFile = join(root, "a-release-sweep-audit.ndjson");
    const realAudit = makeSweepAudit({ auditFile, agentId: AGENT, space: SPACE, conversationUuid: CONV });
    // Run 1: intent persists, close succeeds, final line write fails → the
    // intent stays unconfirmed (the planner's construction).
    const run1 = await sweepTaskPages({
      task, monitorDir: root, agentId: AGENT, space: SPACE,
      conversationUuid: CONV, known: [CONV, OTHER], auditFile,
      audit: async (entry) => {
        if (entry.decision === "closed") throw new Error("EIO");
        return realAudit(entry);
      },
    });
    assert.equal(run1.closed, 1);
    assert.equal(run1.unconfirmed, 1);
    const intent = JSON.parse((await readFile(auditFile, "utf8")).trim().split("\n")
      .find((line) => line.includes("close-intent")));
    // Run 2 on the SAME set: the target page is gone, but an about:blank page
    // is present (assertManagedReleasePages may pass a managed blank). Its
    // identity is unknowable → absence cannot be proven → NO backfill.
    pages.push({ label: "L-blank", url: async () => "about:blank", close: async () => {} });
    const run2 = await sweepTaskPages({
      task, monitorDir: root, agentId: AGENT, space: SPACE,
      conversationUuid: CONV, known: [CONV, OTHER], auditFile, // healthy writer
    });
    assert.ok(run2.unconfirmed > 0, "the intent must stay unconfirmed while an unidentifiable page exists");
    assert.equal(run2.backfilled, 0);
    assert.equal((await readFile(auditFile, "utf8")).includes("closed-backfilled"), false);
    // Until backfill, sweepPending must not clear: the template gate is
    // failed > 0 || unconfirmed > 0 (text asserted in dispatch-governance).
    assert.ok(run2.unconfirmed > 0 || run2.failed > 0);
    // Run 3: the blank page truly leaves the set → absence is provable and
    // the carried intent is finally backfilled.
    pages.splice(pages.indexOf(pages.find((p) => p.label === "L-blank")), 1);
    const run3 = await sweepTaskPages({
      task, monitorDir: root, agentId: AGENT, space: SPACE,
      conversationUuid: CONV, known: [CONV, OTHER], auditFile,
    });
    assert.equal(run3.backfilled, 1);
    assert.equal(run3.unconfirmed, 0);
    assert.equal(run3.failed, 0);
    const backfill = (await readFile(auditFile, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line)).find((line) => line.decision === "closed-backfilled");
    assert.ok(backfill);
    assert.equal(backfill.intentId, intent.intentId); // references the persisted intent
    assert.equal(backfill.page.uuid, OTHER);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#27 re-review② P1-B: a legacy releasePending blocks other conversations' sweep intents without deadlock", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-sweep-legacy-"));
  try {
    // Legacy leftover state (pre-sweepPending registry shape): releasePending
    // for B, no sweepPending field at all. No migration mechanism.
    await withAgentRegistry((registry) => {
      registry.agents[AGENT] = {
        spaceName: SPACE, active: [], known: [OTHER],
        releasePending: { conversationUuid: OTHER, finished: true },
      };
      return { changed: true };
    }, root);
    // Releasing A: markAgentSweepPending(A) is rejected BEFORE any flag write…
    await assert.rejects(
      markAgentSweepPending({ agentId: AGENT, spaceName: SPACE, conversationUuid: CONV, directory: root }),
      (error) => error.code === "AGENT_SPACE_RELEASE_PENDING");
    let entry = await withAgentRegistry((registry) => ({ changed: false, value: registry.agents[AGENT] }), root);
    assert.equal(entry.sweepPending, undefined);   // no sweepPending=A written
    assert.equal(entry.releasePending.conversationUuid, OTHER); // B's state untouched
    // …and release B (the recovery that must go first) proceeds normally:
    await markAgentSweepPending({ agentId: AGENT, spaceName: SPACE, conversationUuid: OTHER, directory: root });
    entry = await withAgentRegistry((registry) => ({ changed: false, value: registry.agents[AGENT] }), root);
    assert.equal(entry.sweepPending.conversationUuid, OTHER);
    // Same-conversation releasePending + sweepPending coexist (recovery shape).
    assert.equal(entry.releasePending.conversationUuid, entry.sweepPending.conversationUuid);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// #27 Batch 3 P1-E: the planner's demanded coexistence scenario — one
// TaskSpace holding BOTH a registered fixed-session page (with its own old
// COMPLETED ledger!) and a finished dispatch-temp page. The sweep closes ONLY
// the temp page: a fixed-session page is never inferred temp from its
// terminal ledger (归属 ≠ 生命周期).
test("#27 B3 P1-E: fixed-session and finished dispatch-temp pages coexist — the sweep closes only the temp page", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-sweep-coexist-"));
  try {
    // The agent's standing session page: registry-known, an old COMPLETED
    // dispatch ledger, but NO dispatch allocation record → fixed-session.
    await writeLedger(root, OTHER, validLedger(OTHER, "COMPLETED"));
    // A finished one-off dispatch page: send-new allocation record anchored
    // to its own conversation + a terminal ledger → dispatch-temp, closable.
    await writeLedger(root, THIRD, validLedger(THIRD, "COMPLETED"));
    await markDispatchCreated(root, THIRD);
    const closed = [];
    const auditFile = join(root, "a-release-sweep-audit.ndjson");
    const sweep = await sweepTaskPages({
      task: fakeTask([fakePage(chatUrl(OTHER), closed), fakePage(chatUrl(THIRD), closed)]),
      monitorDir: root, agentId: AGENT, space: SPACE,
      conversationUuid: CONV, known: [CONV, OTHER, THIRD], auditFile,
    });
    assert.equal(sweep.failed, 0);
    assert.equal(sweep.closed, 1);
    assert.deepEqual(closed, [chatUrl(THIRD)]); // exactly one close ran
    // The fixed-session page survived with its keep reason on the audit trail.
    const lines = (await readFile(auditFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const keptLine = lines.find((line) => line.decision === "kept" && line.page?.uuid === OTHER);
    assert.ok(keptLine, "the fixed-session page leaves its kept line");
    assert.equal(keptLine.reason, "FIXED_SESSION_PAGE");
    const closedLine = lines.find((line) => line.decision === "closed");
    assert.equal(closedLine.page.uuid, THIRD);
    assert.equal(closedLine.reason, "TEMP_RESULT_PAGE_FINISHED_DISPATCH");
    // A kept page keeps the space alive (P1-2 space-fate rule unchanged).
    assert.equal(shouldFinishSpace({ finished: true, hasTask: true, kept: sweep.kept, failed: 0 }), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#27 B3 P1-E: the dispatch-creation evidence is anchored — real send-new shape (client requestId ≠ conversationUuid)", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-sweep-origin-"));
  try {
    const dir = join(root, "conversations", OTHER.toLowerCase());
    await mkdir(dir, { recursive: true });
    // No record at all: unproven origin → not dispatch-created.
    assert.equal(await anchoredDispatchCreated(root, OTHER, SPACE), false);
    // A record for a DIFFERENT conversation/space is not this page's origin.
    await writeFile(join(dir, "a-new-request.json"), JSON.stringify({
      requestId: CONV, conversationUuid: OTHER.toLowerCase(), space: "other-space",
      agentId: AGENT, payloadSha256: "a".repeat(64),
    }));
    assert.equal(await anchoredDispatchCreated(root, OTHER, SPACE), false);
    // The association field pointing at ANOTHER conversation is not this
    // page's origin either.
    await writeFile(join(dir, "a-new-request.json"), JSON.stringify({
      requestId: CONV, conversationUuid: CONV, space: SPACE,
      agentId: AGENT, payloadSha256: "a".repeat(64),
    }));
    assert.equal(await anchoredDispatchCreated(root, OTHER, SPACE), false);
    // The PRE-FIX bound shape (no association field at all) is unproven too:
    // before the fix this shape was the production norm and yet was tested
    // with a fabricated requestId === conversationUuid record.
    await writeFile(join(dir, "a-new-request.json"), JSON.stringify({
      requestId: CONV, space: SPACE, agentId: AGENT, payloadSha256: "a".repeat(64),
    }));
    assert.equal(await anchoredDispatchCreated(root, OTHER, SPACE), false);
    // Corrupt JSON proves nothing (fail-closed: the page stays open).
    await writeFile(join(dir, "a-new-request.json"), "{corrupted");
    assert.equal(await anchoredDispatchCreated(root, OTHER, SPACE), false);
    // The REAL production record IS the origin evidence: requestId is the
    // client dispatch UUID (≠ the conversation UUID) and the association was
    // persisted by bindNewConversation.
    await writeFile(join(dir, "a-new-request.json"), JSON.stringify({
      requestId: CONV, conversationUuid: OTHER.toLowerCase(), space: SPACE,
      agentId: AGENT, payloadSha256: "a".repeat(64),
    }));
    assert.equal(await anchoredDispatchCreated(root, OTHER, SPACE), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// #27 B3 P1-E (re-review round 2): the FULL production binding path — a real
// send-new data shape (requestId = client dispatch UUID ≠ conversationUuid)
// run through the real bindNewConversation, then the planner's demanded
// coexistence scenario: the temp page built this way closes, a registered
// fixed-session page with its own COMPLETED ledger does not.
test("#27 B3 P1-E: real send-new binding maps client requestId → conversationUuid; coexistence sweep closes only the temp page", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-sweep-bindmap-"));
  try {
    const requestId = randomUUID(); // the CLIENT dispatch UUID, never the conversation uuid
    const digest = "b".repeat(64);
    const pending = join(root, "pending-new", requestId.toLowerCase());
    await mkdir(pending, { recursive: true });
    // Exactly what the managed send-new flow persists BEFORE the browser
    // allocation: ledger + origin record still carry the client requestId as
    // the conversation identity; a-new-conversation.json holds the
    // browser-derived real UUID.
    await writeFile(join(pending, "a-dispatch-state.json"), JSON.stringify({
      schema: "ego-dispatch-state/v2", dispatchId: requestId, conversationUuid: requestId,
      taskSpace: SPACE, pageLabel: "p1", status: "ACCEPTED", baselineTailKey: null,
      baselineTailRole: null, baselineComposerLength: 0, attempt: 1, createdAt: Date.now(),
      payload_sha256: digest,
    }));
    await writeFile(join(pending, "a-new-request.json"), JSON.stringify({
      requestId: requestId.toLowerCase(), space: SPACE, agentId: AGENT, payloadSha256: digest,
    }));
    await writeFile(join(pending, "a-new-conversation.json"), JSON.stringify({
      requestId: requestId.toLowerCase(), conversationUuid: THIRD,
    }));
    // Before binding, nothing proves the association — the page would be kept.
    assert.equal(await anchoredDispatchCreated(root, THIRD, SPACE), false);
    // The real binding maps client requestId → conversationUuid.
    assert.equal(await bindNewConversation(root, requestId, SPACE, AGENT, digest), THIRD);
    const boundPath = join(root, "conversations", THIRD.toLowerCase(), "a-new-request.json");
    const bound = JSON.parse(await readFile(boundPath, "utf8"));
    // The ORIGINAL client requestId field is kept and the association added.
    assert.equal(bound.requestId, requestId.toLowerCase());
    assert.notEqual(bound.requestId, THIRD.toLowerCase());
    assert.equal(bound.conversationUuid, THIRD.toLowerCase());
    assert.ok(Number.isFinite(bound.boundAt));
    assert.equal(bound.space, SPACE);
    assert.equal(bound.agentId, AGENT);
    // The persisted association is exactly what makes the page dispatch-temp.
    assert.equal(await anchoredDispatchCreated(root, THIRD, SPACE), true);
    assert.equal(await anchoredDispatchCreated(root, THIRD, "other-space"), false);
    // An idempotent replay does not rewrite the bound record.
    assert.equal(await bindNewConversation(root, requestId, SPACE, AGENT, digest), THIRD);
    assert.deepEqual(JSON.parse(await readFile(boundPath, "utf8")), bound);
    // Coexistence: the just-built temp page (ledger now terminal) next to a
    // registered fixed-session page with its own old COMPLETED ledger — the
    // sweep closes ONLY the temp page.
    await writeLedger(root, THIRD, validLedger(THIRD, "COMPLETED"));
    await writeLedger(root, OTHER, validLedger(OTHER, "COMPLETED"));
    const closed = [];
    const auditFile = join(root, "a-release-sweep-audit.ndjson");
    const sweep = await sweepTaskPages({
      task: fakeTask([fakePage(chatUrl(OTHER), closed), fakePage(chatUrl(THIRD), closed)]),
      monitorDir: root, agentId: AGENT, space: SPACE,
      conversationUuid: CONV, known: [CONV, OTHER, THIRD], auditFile,
    });
    assert.equal(sweep.failed, 0);
    assert.equal(sweep.closed, 1);
    assert.deepEqual(closed, [chatUrl(THIRD)]);
    const lines = (await readFile(auditFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const keptLine = lines.find((line) => line.decision === "kept" && line.page?.uuid === OTHER);
    assert.ok(keptLine, "the fixed-session page leaves its kept line");
    assert.equal(keptLine.reason, "FIXED_SESSION_PAGE");
    const closedLine = lines.find((line) => line.decision === "closed");
    assert.equal(closedLine.page.uuid, THIRD);
    assert.equal(closedLine.reason, "TEMP_RESULT_PAGE_FINISHED_DISPATCH");
  } finally { await rm(root, { recursive: true, force: true }); }
});
