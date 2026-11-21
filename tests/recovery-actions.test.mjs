// issues #36 / #39-③ / #40 — the composer-freeze deadlock family and the two
// managed recovery/attach entries. Pure ledger/filesystem level: no browser is
// involved anywhere in this file (manual-attach verification is injected).
//   #36    — freeze consumption moves AFTER surface observation; unconsumed
//            freezes expire; the probe's arm gate widens by exactly one narrow
//            evidence branch (terminal ledger + unconsumed/stale freeze);
//   #39-③  — `discard-pending`: the managed cleanup/redispatch path for a
//            stuck PREPARED pending-new request (whole-dir archive, never
//            delete; same request-id becomes reusable);
//   #40    — `manual-attach`: PO-manual dispatch managed tracking (PO_MANUAL
//            UNCERTAIN ledger, 免 payload 指纹, attach-time baseline tail),
//            with the PO page staying FIXED_SESSION/kept in the release sweep.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, rm, stat, open, readdir } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  markComposerFreeze, findUnconsumedComposerFreeze, findComposerFreezeToConsume,
  consumeComposerFreeze, appendEvent, dispatchStormGate, writeJsonAtomic,
  readDispatchState, reconcileDispatch, commitLockScopeOf, withCommitLock,
} from "../monitor/dispatch-state.mjs";
import { normalizeFastState, stormRearmState } from "../monitor/state-schema.mjs";
import {
  requireArmedDispatch, discardPendingDispatch, manualAttachDispatch,
  parseVerifiedPageEvidence, parseArgs, watchExitStructureError,
  PENDING_DISCARD_AUDIT_FILE, PENDING_NEW_ARCHIVE_DIR, PO_MANUAL_SOURCE,
} from "../monitor/dispatch-manager.mjs";
import { extractDomReplyByBaseline } from "../monitor/reply-delivery.mjs";
import { sha256 } from "../monitor/reply-delivery.mjs";
import {
  anchoredDispatchCreated, classifyPageLabelLifecycle, classifySweepPage,
  PAGE_LABEL_LIFECYCLE,
} from "../monitor/release-sweep.mjs";

const uuid = "11111111-1111-4111-8111-111111111111";
const otherUuid = "55555555-5555-4555-8555-555555555555";
const dispatchUuid = "22222222-2222-4222-8222-222222222222";
const requestId = "44444444-4444-4444-8444-444444444444";
const SPACE = "GDC-执行A";
const TS = 1_800_000_000_000;

// A structurally valid v2 ledger record (validateDispatchRecord-clean).
function ledgerRecord({ status = "COMPLETED", dispatchId = dispatchUuid, conversationUuid: conv = uuid, ...extra } = {}) {
  return {
    schema: "ego-dispatch-state/v2", dispatchId, conversationUuid: conv, taskSpace: SPACE,
    pageLabel: "p1", status, baselineTailKey: "baseline-tail-key", baselineTailRole: "assistant",
    baselineComposerLength: 0, attempt: 1, createdAt: TS, payload_sha256: sha256("任务"), ...extra,
  };
}

// A PREPARED pending-new record: pre-binding, conversationUuid === requestId.
const pendingLedger = (extra = {}) => ledgerRecord({
  status: "PREPARED", conversationUuid: requestId, pageLabel: "p9",
  baselineTailKey: null, baselineTailRole: null, ...extra,
});

const paramsOf = (root, action = "probe") => ({
  monitorDir: root, agentId: "gdc-a", space: SPACE, conversation: uuid, action,
});

async function setupConversation(root, { record = null, fastState: fast = null } = {}) {
  const dir = join(root, "conversations", uuid);
  await mkdir(dir, { recursive: true });
  if (record !== null) await writeFile(join(dir, "a-dispatch-state.json"), JSON.stringify(record));
  if (fast !== null) await writeJsonAtomic(join(dir, "a-fast-state.json"), fast);
  return dir;
}

async function setupPending(root, { withRequest = true, record = null, corruptLedger = false,
    page = null, marker = null, supervision = null, requestSpace = SPACE } = {}) {
  const pending = join(root, "pending-new", requestId);
  await mkdir(pending, { recursive: true });
  if (withRequest) {
    await writeFile(join(pending, "a-new-request.json"), JSON.stringify({
      requestId, space: requestSpace, agentId: "gdc-a", payloadSha256: sha256("任务"),
    }));
  }
  if (corruptLedger) await writeFile(join(pending, "a-dispatch-state.json"), "{not-json");
  else if (record !== null) await writeFile(join(pending, "a-dispatch-state.json"), JSON.stringify(record));
  if (page !== null) await writeFile(join(pending, "a-new-page.json"), JSON.stringify(page));
  if (marker !== null) await writeFile(join(pending, "a-watch-exit.json"), JSON.stringify(marker));
  if (supervision !== null) await writeFile(join(pending, "a-supervision-status.json"), JSON.stringify(supervision));
  return pending;
}

const discardArgs = (root) => ["discard-pending", "--monitor-dir", root, "--agent-id", "gdc-a",
  "--space", SPACE, "--request-id", requestId];

// A valid but UNACKNOWLEDGED ego-watch-exit/v1 marker (the seven-field contract).
const unackedMarker = () => ({
  schema: "ego-watch-exit/v1", wakeId: randomUUID(), issuedAt: TS, exitCode: 2,
  acknowledgedAt: null, ackAction: null, exitReason: "WATCH_EXCEPTION", detail: "code=EACCES",
});

const supervisionAlarm = () => ({
  schema: "ego-supervision/v1", generationKey: dispatchUuid, progressAt: TS,
  abnormalRounds: 1, lastReviewAt: TS, pending: { id: "wake-1", reason: "DELIVERY_SUSPECTED", issuedAt: TS },
});

async function capture(fn) {
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (line) => logs.push(String(line));
  console.error = (line) => errors.push(String(line));
  try {
    return { code: await fn(), logs, errors };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

async function eventsOf(dir) {
  try {
    const raw = await readFile(join(dir, "a-fast-events.ndjson"), "utf8");
    return raw.split("\n").filter((line) => line).map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

const sameBytes = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

async function dirNames(dir) {
  try { return (await readdir(dir)).sort(); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

// ---- #36: the freeze lifecycle (consumption after observation + expiry) ----

test("issue #36 supervisor live case (e2e): COMPLETED ledger + unconsumed freeze — the probe boots, a healthy observation consumes, Gate 0 and the storm gate reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-freeze-e2e-"));
  try {
    const dir = await setupConversation(root, { record: ledgerRecord({ status: "COMPLETED" }) });
    // The live incident's poison: a previous dispatch COMPLETED, the fresh retry
    // froze at the composer render, and the only consumer (the probe) was refused
    // by the arm gate — Gate 0 shut forever. Reproduce the state exactly.
    const freeze = await markComposerFreeze(dir, { space: SPACE, error: new Error("composer render hang") });
    // Gate 0 precondition: the send template's blocking query sees the freeze.
    assert.equal((await findUnconsumedComposerFreeze(dir)).freezeId, freeze.freezeId);
    // Step 1 of the chain: the probe can now boot — requireArmedDispatch admits
    // the COMPLETED ledger because an unconsumed freeze exists (pre-#36 this
    // threw DISPATCH_NOT_ARMED and nothing could ever consume the freeze).
    const armed = await requireArmedDispatch(dir, paramsOf(root, "probe"), "probe");
    assert.equal(armed.status, "COMPLETED");
    assert.equal(armed.dispatchId, dispatchUuid);
    // Step 2: the probe observes the composer surface HEALTHY — the healthy
    // round's own writeState carries errorCode null (健康态, no poisoning).
    await writeJsonAtomic(join(dir, "a-fast-state.json"), normalizeFastState({}, {
      generationKey: dispatchUuid, uiSchema: "CHATGPT_CHAT_KNOWN", dispatchStatus: "COMPLETED",
      armedReason: "DISPATCH_ACCEPTED", lastMessageRole: "assistant", lastMessageKey: "done-tail-key",
      probeFailed: false, recoveryFailed: false, backoffUntil: null,
      unavailableStrikes: 0, unavailablePersistent: false,
    }, TS));
    // Step 3: the post-observation consumption (SURFACE_HEALTHY verdict).
    const consumed = await consumeComposerFreeze(dir, { verdict: "SURFACE_HEALTHY", space: SPACE });
    assert.equal(consumed.freezeId, freeze.freezeId);
    assert.equal(consumed.stale, false);
    // Gate 0 REOPENED: the send template's blocking query now returns null.
    assert.equal(await findUnconsumedComposerFreeze(dir), null);
    // The consumption event carries the post-observation evidence class.
    const rows = await eventsOf(dir);
    const row = rows.at(-1);
    assert.equal(row.event, "COMPOSER_FREEZE_CONSUMED");
    assert.equal(row.consumedVia, "SURFACE_HEALTHY");
    assert.equal(row.expired, false);
    assert.equal(row.freezeId, freeze.freezeId);
    assert.equal(row.space, SPACE);
    // No storm poisoning anywhere in the state: the healthy round keeps both the
    // storm gate open and errorCode null (the pre-#36 boot consume wrote
    // CHAT_SURFACE_STRUCTURALLY_UNAVAILABLE here and bricked the conversation).
    assert.equal(await dispatchStormGate(dir), null);
    const state = JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8"));
    assert.equal(state.errorCode, null);
    assert.equal(state.backoffUntil, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("issue #36 confirmed-broken surface: the freeze consumes into the shared storm channel (pre-#36 semantics preserved), Gate 0 opens, storm gate shuts", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-freeze-storm-"));
  try {
    const dir = await setupConversation(root, { record: ledgerRecord({ status: "ABORTED" }) });
    const freeze = await markComposerFreeze(dir, { space: SPACE, error: new Error("composer render hang") });
    // The probe's structural-failure branch: shared storm-channel write, then consume.
    const rearm = stormRearmState({ previous: {}, detectedAt: TS, phaseMs: 60_000 });
    await writeJsonAtomic(join(dir, "a-fast-state.json"), normalizeFastState({}, rearm, TS));
    const consumed = await consumeComposerFreeze(dir, {
      verdict: "STORM_BACKOFF", space: SPACE, stormBackoffDeadline: rearm.backoffUntil,
    });
    assert.equal(consumed.freezeId, freeze.freezeId);
    assert.equal(consumed.stale, false);
    // Gate 0 open again; the storm gate now owns the wait.
    assert.equal(await findUnconsumedComposerFreeze(dir), null);
    assert.equal(await dispatchStormGate(dir), "STORM_BACKOFF_PENDING");
    const row = (await eventsOf(dir)).at(-1);
    assert.equal(row.event, "COMPOSER_FREEZE_CONSUMED");
    assert.equal(row.consumedVia, "STORM_BACKOFF");
    assert.equal(row.expired, false);
    assert.equal(row.stormBackoffDeadline, rearm.backoffUntil);
    // The storm-retry reason labeler keeps working off the consumed deadline.
    const { lastConsumedFreezeDeadline } = await import("../monitor/dispatch-state.mjs");
    assert.equal(await lastConsumedFreezeDeadline(dir), rearm.backoffUntil);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("issue #36 freeze expiry: an unconsumed freeze stops blocking Gate 0 after 30 min and consumption stamps expired=true", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-freeze-expiry-"));
  try {
    const dir = await setupConversation(root);
    const freeze = await markComposerFreeze(dir, { space: SPACE, error: new Error("hang") });
    // Fresh: blocks Gate 0.
    assert.equal((await findUnconsumedComposerFreeze(dir)).freezeId, freeze.freezeId);
    // 29 min in: still fresh (boundary — expiry is >=, not >).
    const almost = await findUnconsumedComposerFreeze(dir, freeze.detectedAt + 29 * 60_000);
    assert.equal(almost.freezeId, freeze.freezeId);
    // 30 min in: expired — Gate 0 self-opens WITHOUT any consumption (the
    // consumption channel itself is unreachable in the #36/#39-③ shape).
    assert.equal(await findUnconsumedComposerFreeze(dir, freeze.detectedAt + 30 * 60_000), null);
    // The consumption-time query still finds it, flagged stale (audit fact,
    // not erasure — 消费时标 EXPIRED).
    const stale = await findComposerFreezeToConsume(dir, freeze.detectedAt + 30 * 60_000);
    assert.equal(stale.freezeId, freeze.freezeId);
    assert.equal(stale.stale, true);
    const consumed = await consumeComposerFreeze(dir, {
      verdict: "SURFACE_HEALTHY", space: SPACE, now: freeze.detectedAt + 30 * 60_000,
    });
    assert.equal(consumed.stale, true);
    const row = (await eventsOf(dir)).at(-1);
    assert.equal(row.event, "COMPOSER_FREEZE_CONSUMED");
    assert.equal(row.consumedVia, "SURFACE_HEALTHY");
    assert.equal(row.expired, true);
    // Nothing is left blocking.
    assert.equal(await findComposerFreezeToConsume(dir), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("issue #36 expiry is per-freeze: a fresh freeze after an expired one still blocks Gate 0", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-freeze-per-record-"));
  try {
    const dir = await setupConversation(root);
    const staleFreeze = await markComposerFreeze(dir, { space: SPACE, error: new Error("old hang") });
    const freshFreeze = await markComposerFreeze(dir, { space: SPACE, error: new Error("new hang") });
    // Rewind the FIRST freeze's detectedAt to 31 min before the fresh one (the
    // event row is the scan's source of truth, exactly as a real stale freeze sits).
    const raw = (await readFile(join(dir, "a-fast-events.ndjson"), "utf8")).split("\n").filter(Boolean);
    const firstFreezeIndex = raw.findIndex((line) => JSON.parse(line).freezeId === staleFreeze.freezeId);
    const staleRow = JSON.parse(raw[firstFreezeIndex]);
    staleRow.detectedAt = freshFreeze.detectedAt - 31 * 60_000;
    raw[firstFreezeIndex] = JSON.stringify(staleRow);
    await writeFile(join(dir, "a-fast-events.ndjson"), raw.join("\n") + "\n");
    const now = freshFreeze.detectedAt + 60_000;
    // The Gate 0 query returns only the FRESH freeze; the expired one no longer blocks.
    const blocking = await findUnconsumedComposerFreeze(dir, now);
    assert.equal(blocking.freezeId, freshFreeze.freezeId);
    assert.notEqual(blocking.freezeId, staleFreeze.freezeId);
    // Consumption takes the NEWEST unconsumed freeze regardless of age.
    const toConsume = await findComposerFreezeToConsume(dir, now);
    assert.equal(toConsume.freezeId, freshFreeze.freezeId);
    assert.equal(toConsume.stale, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("issue #36 arm gate matrix: probe widening is EXACTLY terminal-ledger + unconsumed/stale freeze; watch semantics unchanged; unreadable freeze ledger refuses", async () => {
  const base = await mkdtemp(join(tmpdir(), "ego-freeze-gate-"));
  const dirs = [];
  try {
    const make = async (name, { record, eventsFile } = {}) => {
      const root = join(base, name);
      const dir = await setupConversation(root, { record });
      if (eventsFile === "freeze") await markComposerFreeze(dir, { space: SPACE, error: new Error("hang") });
      if (eventsFile === "stale-freeze") {
        // A real stale row, written the way the scan reads it.
        await appendEvent(dir, "COMPOSER_RENDER_FREEZE", {
          freezeId: randomUUID(), detectedAt: TS - 31 * 60_000,
          stormBackoffDeadline: TS - 20 * 60_000, phaseMs: 0, agent_id: SPACE, space: SPACE,
        });
      }
      if (eventsFile === "broken") {
        // The events path is a DIRECTORY: every read fails (fail-closed input).
        await mkdir(join(dir, "a-fast-events.ndjson"));
      }
      dirs.push(root);
      return dir;
    };
    // In-flight statuses: unchanged (no freeze needed, probe + watch admit).
    const uncertain = await make("in-flight", { record: ledgerRecord({ status: "UNCERTAIN" }) });
    assert.equal((await requireArmedDispatch(uncertain, paramsOf(uncertain), "probe")).status, "UNCERTAIN");
    assert.equal((await requireArmedDispatch(uncertain, paramsOf(uncertain), "watch")).status, "UNCERTAIN");
    // Terminal ledger without a freeze: probe refused (pre-#36 shape), watch admitted.
    const completed = await make("terminal-no-freeze", { record: ledgerRecord({ status: "COMPLETED" }) });
    await assert.rejects(() => requireArmedDispatch(completed, paramsOf(completed), "probe"), /DISPATCH_NOT_ARMED/);
    assert.equal((await requireArmedDispatch(completed, paramsOf(completed), "watch")).status, "COMPLETED");
    const aborted = await make("aborted-no-freeze", { record: ledgerRecord({ status: "ABORTED" }) });
    await assert.rejects(() => requireArmedDispatch(aborted, paramsOf(aborted), "probe"), /DISPATCH_NOT_ARMED/);
    assert.equal((await requireArmedDispatch(aborted, paramsOf(aborted), "watch")).status, "ABORTED");
    // THE widening: terminal ledger + unconsumed freeze — the probe boots.
    const completedFrozen = await make("terminal-frozen", { record: ledgerRecord({ status: "COMPLETED" }), eventsFile: "freeze" });
    assert.equal((await requireArmedDispatch(completedFrozen, paramsOf(completedFrozen), "probe")).status, "COMPLETED");
    const abortedFrozen = await make("aborted-frozen", { record: ledgerRecord({ status: "ABORTED" }), eventsFile: "freeze" });
    assert.equal((await requireArmedDispatch(abortedFrozen, paramsOf(abortedFrozen), "probe")).status, "ABORTED");
    // Stale (expired) freezes still count: consumption must stay reachable.
    const completedStale = await make("terminal-stale", { record: ledgerRecord({ status: "COMPLETED" }), eventsFile: "stale-freeze" });
    assert.equal((await requireArmedDispatch(completedStale, paramsOf(completedStale), "probe")).status, "COMPLETED");
    // Fail-closed: an unreadable freeze ledger proves nothing and never widens.
    const completedBroken = await make("terminal-broken", { record: ledgerRecord({ status: "COMPLETED" }), eventsFile: "broken" });
    await assert.rejects(() => requireArmedDispatch(completedBroken, paramsOf(completedBroken), "probe"), /DISPATCH_NOT_ARMED/);
    // Non-terminal non-in-flight statuses: refused for probe AND watch.
    const prepared = await make("prepared", { record: ledgerRecord({ status: "PREPARED" }) });
    await assert.rejects(() => requireArmedDispatch(prepared, paramsOf(prepared), "probe"), /DISPATCH_NOT_ARMED/);
    await assert.rejects(() => requireArmedDispatch(prepared, paramsOf(prepared), "watch"), /DISPATCH_NOT_ARMED/);
    // Identity gates unchanged: wrong space / wrong conversation refuse everywhere.
    await assert.rejects(() => requireArmedDispatch(completedFrozen, { ...paramsOf(completedFrozen), space: "GDC-执行B" }, "probe"), /DISPATCH_NOT_ARMED/);
    await assert.rejects(() => requireArmedDispatch(completedFrozen, { ...paramsOf(completedFrozen), conversation: otherUuid }, "probe"), /DISPATCH_NOT_ARMED/);
    // The stale-freeze fixture really was stale (guard against a fixture typo).
    const rows = await eventsOf(completedStale);
    assert.equal(rows.at(-1).event, "COMPOSER_RENDER_FREEZE");
    assert.equal(await findUnconsumedComposerFreeze(completedStale, TS), null);
    assert.notEqual(await findComposerFreezeToConsume(completedStale, TS), null);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("issue #36 probe templates consume the freeze only AFTER surface observation (source pins, canonical + live)", async () => {
  for (const name of ["ego-fast-probe.mjs", "ego-fast-probe-live.mjs"]) {
    const src = await readFile(new URL(`../monitor/${name}`, import.meta.url), "utf8");
    // The unconditional boot-time consumption is gone — no freezing poisoning.
    assert.doesNotMatch(src, /findUnconsumedComposerFreeze/);
    assert.doesNotMatch(src, /pendingFreeze/);
    // Both structural-failure exits consume into the shared storm channel.
    const stormConsumes = src.split('verdict: "STORM_BACKOFF"').length - 1;
    assert.equal(stormConsumes, 2, name + ": STORM_BACKOFF consume in storm-retry AND structural branch");
    // Ordering: the final structural branch → its STORM_BACKOFF consume → the
    // branch's exit → SURFACE_HEALTHY consume → reconcileDispatch.
    const structural = src.indexOf("const strikes = previous.unavailableStrikes + 1;");
    const branchStormConsume = src.indexOf('verdict: "STORM_BACKOFF"', structural);
    const branchExit = src.indexOf("process.exit(0)", branchStormConsume);
    const healthyConsume = src.indexOf('verdict: "SURFACE_HEALTHY"');
    const reconcile = src.indexOf("await reconcileDispatch(MON, uuid, probe)");
    assert.ok(structural > 0 && branchStormConsume > structural && branchExit > branchStormConsume,
      name + ": structural branch consumes STORM_BACKOFF before exiting");
    assert.ok(healthyConsume > branchExit, name + ": healthy consume sits after the structural gate");
    assert.ok(healthyConsume < reconcile, name + ": healthy consume sits before reconcileDispatch");
    // The healthy consume is best-effort: a failed consumption leaves the freeze
    // unconsumed (Gate 0 stays shut — the safe direction).
    assert.match(src, /consumeComposerFreeze\(MON, \{ verdict: "SURFACE_HEALTHY", space: SPACE \}\)\.catch\(\(\) => \{\}\);/);
  }
});

// ---- #39 item 3: managed discard/redispatch path ----

test("issue #39-③ discard-pending happy path: the whole pending dir archives byte-preserved under pending-new-archive/, the audit row records it, the same request-id becomes redispatchable", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-discard-ok-"));
  try {
    const pending = await setupPending(root, {
      record: pendingLedger(),
      page: { requestId, status: "ALLOCATED", pageLabel: "p9" },
    });
    const ledgerBytes = await readFile(join(pending, "a-dispatch-state.json"));
    const { code, logs, errors } = await capture(() => discardPendingDispatch(
      { action: "discard-pending", monitorDir: root, agentId: "gdc-a", space: SPACE, requestId },
      { now: TS }));
    assert.equal(code, 0);
    assert.ok(logs.some((line) => line.startsWith(`RESULT=PENDING_DISCARDED requestId=${requestId} `)), JSON.stringify(logs));
    assert.ok(logs.some((line) => line.includes("draftPageLabel=p9")));
    assert.ok(errors.some((line) => line.startsWith("OPERATOR_ACTION=")));
    // The canonical pending path is FREE.
    await assert.rejects(() => stat(pending), { code: "ENOENT" });
    assert.deepEqual(await dirNames(join(root, "pending-new")), []);
    // Archived WHOLE, outside pending-new/ (where any directory counts as
    // in-flight wholesale for the disarm sibling scan).
    const archiveRoot = join(root, PENDING_NEW_ARCHIVE_DIR);
    const entries = await readdir(archiveRoot);
    assert.equal(entries.length, 1);
    assert.match(entries[0], new RegExp(`^${requestId}\\.archive-\\d+$`));
    const archived = join(archiveRoot, entries[0]);
    assert.deepEqual((await dirNames(archived)).sort(), [
      "a-dispatch-state.json", "a-fast-events.ndjson", "a-new-page.json", "a-new-request.json",
    ]);
    // Byte-preservation: the ledger round-trips unchanged and still validates.
    assert.ok(sameBytes(await readFile(join(archived, "a-dispatch-state.json")), ledgerBytes));
    const record = await readDispatchState(archived);
    assert.equal(record.status, "PREPARED");
    assert.equal(record.dispatchId, dispatchUuid);
    // The archived evidence carries the closing event (best-effort but present).
    const archivedRows = await eventsOf(archived);
    assert.equal(archivedRows.at(-1).event, "PENDING_DISCARDED");
    assert.equal(archivedRows.at(-1).requestId, requestId);
    // The monitor-root audit row is the authoritative record.
    const audit = JSON.parse((await readFile(join(root, PENDING_DISCARD_AUDIT_FILE), "utf8")).trim().split("\n").at(-1));
    assert.equal(audit.outcome, "DISCARDED");
    assert.equal(audit.requestId, requestId);
    assert.equal(audit.space, SPACE);
    assert.equal(audit.agentId, "gdc-a");
    assert.equal(audit.draftPageLabel, "p9");
    assert.equal(audit.ledgerStatus, "PREPARED");
    // REDISPATCH: the retry's first durable step (exclusive-create the request
    // file under the SAME request-id) now succeeds — the same request-id is
    // reusable, or a fresh one may be chosen.
    await mkdir(pending, { recursive: true });
    const handle = await open(join(pending, "a-new-request.json"), "wx");
    await handle.writeFile(JSON.stringify({ requestId, space: SPACE, agentId: "gdc-a" }));
    await handle.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("issue #39-③ discard-pending evidence gate: every non-PREPARED / bound / delivered / watched / alarmed shape refuses fail-closed with NO filesystem mutation", async () => {
  const base = await mkdtemp(join(tmpdir(), "ego-discard-deny-"));
  const roots = [];
  try {
    const case_ = async (name, setup) => {
      const root = join(base, name);
      roots.push(root);
      const pending = await setup(root);
      const before = await dirNames(pending);
      const { code, errors } = await capture(() => discardPendingDispatch(
        { action: "discard-pending", monitorDir: root, agentId: "gdc-a", space: SPACE, requestId }, { now: TS }));
      assert.equal(code, 2, name + ": refuses with exit 2");
      const line = errors.find((row) => row.startsWith("RESULT=PENDING_DISCARD_DENIED code="));
      assert.ok(line, name + ": expected a denial code line, got " + JSON.stringify(errors));
      return { line, before, pending, root };
    };
    // Missing pending dir entirely — nothing to prove, nothing touched.
    {
      const root = join(base, "no-dir");
      roots.push(root);
      const { code, errors } = await capture(() => discardPendingDispatch(
        { action: "discard-pending", monitorDir: root, agentId: "gdc-a", space: SPACE, requestId }, { now: TS }));
      assert.equal(code, 2);
      assert.match(errors.join("\n"), /PENDING_REQUEST_UNREADABLE/);
      await assert.rejects(() => stat(join(root, PENDING_NEW_ARCHIVE_DIR)), { code: "ENOENT" });
    }
    const expectations = [
      ["identity-mismatch", (root) => setupPending(root, { record: pendingLedger(), requestSpace: "GDC-执行B" }), "PENDING_REQUEST_IDENTITY_MISMATCH"],
      ["ledger-absent", (root) => setupPending(root, {}), "PENDING_LEDGER_ABSENT"],
      ["ledger-corrupt", (root) => setupPending(root, { corruptLedger: true }), "PENDING_LEDGER_UNREADABLE"],
      ["not-prepared", (root) => setupPending(root, { record: pendingLedger({ status: "ACCEPTED" }) }), "PENDING_LEDGER_NOT_PREPARED:ACCEPTED"],
      ["bound", (root) => setupPending(root, { record: pendingLedger({ conversationUuid: otherUuid }) }), "PENDING_BOUND_TO_CONVERSATION"],
      ["delivered", (root) => setupPending(root, { record: pendingLedger({ sendStartedAt: TS }) }), "PENDING_DELIVERY_EVIDENCE_PRESENT"],
      ["wake-open", (root) => setupPending(root, { record: pendingLedger(), marker: unackedMarker() }), "PENDING_WAKE_UNACKNOWLEDGED"],
      ["wake-corrupt", (root) => setupPending(root, { record: pendingLedger(), marker: { schema: "ego-watch-exit/v1" } }), "PENDING_WAKE_MARKER_INVALID"],
      ["alarm-open", (root) => setupPending(root, { record: pendingLedger(), supervision: supervisionAlarm() }), "PENDING_SUPERVISION_ALARM"],
    ];
    for (const [name, setup, expectedCode] of expectations) {
      const { line, before, pending } = await case_(name, setup);
      assert.ok(line.endsWith("code=" + expectedCode), `${name}: expected ${expectedCode}, got ${line}`);
      // Fail-closed: the pending dir is untouched (every original byte stays).
      assert.deepEqual(await dirNames(pending), before, name + ": pending dir unchanged");
    }
    // The marker fixture itself satisfies the seven-field contract (guard
    // against a fixture typo producing a false WAKE_MARKER_INVALID pass).
    assert.equal(watchExitStructureError(unackedMarker()), null);
    // DENIED outcomes are audited too.
    const auditFile = join(base, "not-prepared", PENDING_DISCARD_AUDIT_FILE);
    const audit = JSON.parse((await readFile(auditFile, "utf8")).trim().split("\n").at(-1));
    assert.equal(audit.outcome, "DENIED");
    assert.equal(audit.code, "PENDING_LEDGER_NOT_PREPARED:ACCEPTED");
    // The lock participant discipline: the archive write runs under the SAME
    // monitor-root commit lock every arm/prepare/disarm serializes on.
    assert.equal(commitLockScopeOf(join(base, "pending-new", requestId)), join(base));
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("issue #39-③/#40 arg contracts: discard-pending is requestId-only, manual-attach is conversation-only, both refuse foreign args", () => {
  const base = ["--monitor-dir", "m", "--agent-id", "gdc-a", "--space", SPACE];
  // discard-pending: requestId required and uuid-shaped; conversation forbidden.
  const discard = parseArgs(["discard-pending", ...base, "--request-id", requestId]);
  assert.equal(discard.action, "discard-pending");
  assert.equal(discard.requestId, requestId);
  assert.throws(() => parseArgs(["discard-pending", ...base]), /MANAGER_IDENTITY_INVALID/);
  assert.throws(() => parseArgs(["discard-pending", ...base, "--request-id", "not-a-uuid"]), /MANAGER_IDENTITY_INVALID/);
  assert.throws(() => parseArgs(["discard-pending", ...base, "--request-id", requestId, "--conversation", uuid]), /MANAGER_IDENTITY_INVALID/);
  assert.throws(() => parseArgs(["discard-pending", ...base, "--request-id", requestId, "--reason", "SOME_REASON"]), /MANAGER_IDENTITY_INVALID/);
  // manual-attach: conversation required; message/payload and wake-ack args are
  // refused, not silently ignored (the bind action never delivers anything).
  const attach = parseArgs(["manual-attach", ...base, "--conversation", uuid]);
  assert.equal(attach.action, "manual-attach");
  assert.equal(attach.conversation, uuid);
  assert.throws(() => parseArgs(["manual-attach", ...base]), /MANAGER_IDENTITY_INVALID/);
  assert.throws(() => parseArgs(["manual-attach", ...base, "--conversation", uuid, "--message", "x.txt"]), /MANAGER_IDENTITY_INVALID/);
  assert.throws(() => parseArgs(["manual-attach", ...base, "--conversation", uuid, "--request-id", requestId]), /MANAGER_IDENTITY_INVALID/);
  assert.throws(() => parseArgs(["manual-attach", ...base, "--conversation", uuid, "--wake-id", randomUUID(), "--ack-action", "resolved"]), /MANAGER_IDENTITY_INVALID/);
  // Both actions are in the allowed action set.
  for (const action of ["discard-pending", "manual-attach"]) {
    assert.doesNotThrow(() => parseArgs(action === "discard-pending"
      ? ["discard-pending", ...base, "--request-id", requestId]
      : ["manual-attach", ...base, "--conversation", uuid]));
  }
});

// ---- #40: PO-manual dispatch attach (managed tracking entry) ----

const attachEvidence = () => ({
  pageLabel: "p7", tailRole: "user", tailKey: "po-user-tail-key", tailLen: 123, composerLength: 0,
});

const verifiedOutput = (evidence = attachEvidence()) =>
  "RESULT=PO_MANUAL_PAGE_VERIFIED evidence=" + JSON.stringify(evidence);

const attachParams = (root) => ({
  action: "manual-attach", monitorDir: root, agentId: "gdc-a", space: SPACE, conversation: uuid,
});

test("issue #40 manual-attach happy path: verified page evidence binds a PO_MANUAL UNCERTAIN ledger (免 payload 指纹) under the frozen arm machine; probe/watch can then arm and reconcile upgrades it", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-manual-ok-"));
  const registryDir = join(root, "registry");
  try {
    // The registry pre-proves the agent owns the space (real withAgentRegistry
    // against an isolated directory — the rebuildSpace injection precedent).
    const { claimAgentSpace } = await import("../monitor/agent-space.mjs");
    await claimAgentSpace({ agentId: "gdc-a", spaceName: SPACE, directory: registryDir });
    const dir = join(root, "conversations", uuid);
    const verifyCalls = [];
    const runVerify = async (adapted, verifyDir) => {
      verifyCalls.push({ adapted, verifyDir });
      return { code: 0, result: "PO_MANUAL_PAGE_VERIFIED", output: verifiedOutput() };
    };
    const { code, logs } = await capture(() => manualAttachDispatch(attachParams(root),
      { now: TS, runVerify, directory: registryDir }));
    assert.equal(code, 0);
    // The verification ran exactly once, adapted for THIS conversation.
    assert.equal(verifyCalls.length, 1);
    assert.ok(verifyCalls[0].adapted.includes(JSON.stringify(uuid)));
    assert.ok(logs.some((line) => line.startsWith(`RESULT=PO_MANUAL_ATTACHED conversation=${uuid} `)));
    // The ledger: PO_MANUAL UNCERTAIN, no payload fingerprint anywhere, baseline
    // = the verified attach-time tail ONLY.
    const record = await readDispatchState(dir);
    assert.equal(record.status, "UNCERTAIN");
    assert.equal(record.source, PO_MANUAL_SOURCE);
    assert.equal(record.reasonCode, "PO_MANUAL_ATTACH");
    assert.equal(record.payload_sha256, null);
    assert.equal(record.payload_display_sha256, null);
    assert.equal(record.payload_bytes, null);
    assert.equal(record.composer_baseline, null);
    assert.equal(record.baselineTailKey, "po-user-tail-key");
    assert.equal(record.baselineTailRole, "user");
    assert.equal(record.baselineComposerLength, 0);
    assert.equal(record.pageLabel, "p7");
    assert.equal(record.taskSpace, SPACE);
    assert.equal(record.conversationUuid, uuid);
    // The arm machine ran FIRST (布防 order) — no bypass: DISPATCH_ACCEPTED via
    // the frozen v4 transition, with the conversation stamped.
    const state = JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8"));
    assert.equal(state.armedReason, "DISPATCH_ACCEPTED");
    assert.equal(state.armedConversation, uuid);
    assert.equal(state.armedSpace, SPACE);
    // The registry claim registered the conversation for collect/sweep semantics.
    const entry = JSON.parse(await readFile(join(registryDir, "ego-taskspaces.json"), "utf8")).agents["gdc-a"];
    assert.ok(entry.active.includes(uuid));
    assert.ok(entry.known.includes(uuid));
    // The attach event documents the bind (pageLabel reference included).
    const rows = await eventsOf(dir);
    const attachRow = rows.find((row) => row.event === "PO_MANUAL_ATTACHED");
    assert.equal(attachRow.dispatchId, record.dispatchId);
    assert.equal(attachRow.pageLabel, "p7");
    // PROBE/WATCHABILITY: the arm gate admits both actions on the PO_MANUAL
    // UNCERTAIN ledger — the PO's dispatch is now managed end to end.
    assert.equal((await requireArmedDispatch(dir, paramsOf(root), "probe")).status, "UNCERTAIN");
    assert.equal((await requireArmedDispatch(dir, paramsOf(root), "watch")).status, "UNCERTAIN");
    // The probe's reconcile upgrade path works on the fingerprint-free ledger:
    // tail advanced past the attach baseline + empty composer → ACCEPTED.
    const { record: upgraded, result } = await reconcileDispatch(dir, uuid, {
      hostOk: true, composerPresent: true, composerEmpty: true, generating: false,
      lastMessageKey: "po-user-tail-key-2", lastMessageRole: "user",
    });
    assert.equal(result, "ACCEPTED_RECONCILED");
    assert.equal(upgraded.status, "ACCEPTED");
    assert.ok(upgraded.acceptedAt);
    // And the arm gate still admits probe/watch on the reconciled ledger.
    assert.equal((await requireArmedDispatch(dir, paramsOf(root), "probe")).status, "ACCEPTED");
    assert.equal((await requireArmedDispatch(dir, paramsOf(root), "watch")).status, "ACCEPTED");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("issue #40 manual-attach refusals write NOTHING (fail-closed gate order: registry → ledger → verify → evidence)", async () => {
  const base = await mkdtemp(join(tmpdir(), "ego-manual-deny-"));
  try {
    const run = async (name, { record = null, corruptLedger = false, registry = true, runVerify }) => {
      const root = join(base, name);
      const dir = join(root, "conversations", uuid);
      if (registry) {
        const { claimAgentSpace } = await import("../monitor/agent-space.mjs");
        await claimAgentSpace({ agentId: "gdc-a", spaceName: SPACE, directory: join(root, "registry") });
      }
      if (corruptLedger) {
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "a-dispatch-state.json"), "{not-json");
      } else if (record !== null) {
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "a-dispatch-state.json"), JSON.stringify(record));
      }
      const verifyCalls = [];
      const spy = runVerify && (async (adapted, verifyDir) => {
        verifyCalls.push(1);
        return runVerify(adapted, verifyDir);
      });
      const { code, errors } = await capture(() => manualAttachDispatch(attachParams(root),
        { now: TS, runVerify: spy, directory: join(root, "registry") }));
      assert.equal(code, 2, name + ": refuses with exit 2");
      const line = errors.find((row) => row.startsWith("RESULT=PO_MANUAL_ATTACH_REFUSED code="));
      assert.ok(line, name + ": expected a refusal code, got " + JSON.stringify(errors));
      return {
        line, verifyCalls,
        ledgerExists: await dirNames(dir).then((names) => names?.includes("a-dispatch-state.json") ?? false),
        stateExists: await dirNames(dir).then((names) => names?.includes("a-fast-state.json") ?? false),
        registryFile: join(root, "registry", "ego-taskspaces.json"),
      };
    };
    // (1) Registry unproven: no entry for the agent — refuse BEFORE the browser.
    {
      const r = await run("registry-unproven", { registry: false, runVerify: () => { throw new Error("MUST_NOT_VERIFY"); } });
      assert.match(r.line, /PO_MANUAL_AGENT_SPACE_UNPROVEN/);
      assert.equal(r.verifyCalls.length, 0);
      assert.equal(r.ledgerExists, false);
    }
    // (2) In-flight managed lifecycle: never attach over it (no browser call).
    for (const status of ["ACCEPTED", "SEND_STARTED", "COMPLETED", "RETRY_AUTHORIZED"]) {
      const r = await run("in-flight-" + status, { record: ledgerRecord({ status }), runVerify: () => { throw new Error("MUST_NOT_VERIFY"); } });
      assert.match(r.line, new RegExp("PO_MANUAL_LEDGER_IN_MANAGED_LIFECYCLE:" + status));
      assert.equal(r.verifyCalls.length, 0, status + ": browser never invoked");
      assert.equal(r.ledgerExists, true, status + ": the managed ledger is untouched");
    }
    // (3) Corrupt ledger: never attach over an unprovable one.
    {
      const r = await run("corrupt", { corruptLedger: true, runVerify: () => { throw new Error("MUST_NOT_VERIFY"); } });
      assert.match(r.line, /PO_MANUAL_LEDGER_UNREADABLE/);
      assert.equal(r.verifyCalls.length, 0);
    }
    // (4) Verification refused: no ledger, no arm state, no registry claim.
    {
      const r = await run("verify-failed", {
        runVerify: async () => ({ code: 1, result: "PO_MANUAL_ATTACH_PAGE_NOT_FOUND", output: "RESULT=PO_MANUAL_ATTACH_PAGE_NOT_FOUND detail=conversation=" + uuid }),
      });
      assert.match(r.line, /PO_MANUAL_PAGE_VERIFY_FAILED:PO_MANUAL_ATTACH_PAGE_NOT_FOUND/);
      assert.equal(r.verifyCalls.length, 1);
      assert.equal(r.ledgerExists, false);
      assert.equal(r.stateExists, false);
      const entry = JSON.parse(await readFile(r.registryFile, "utf8")).agents["gdc-a"];
      assert.equal(entry.active.length, 0, "a refused verification never claims the conversation");
    }
    // (5) Unparseable evidence (missing tailKey): verified but unbindable.
    {
      const r = await run("evidence-bad", {
        runVerify: async () => ({ code: 0, result: "PO_MANUAL_PAGE_VERIFIED", output: "RESULT=PO_MANUAL_PAGE_VERIFIED evidence=" + JSON.stringify({ pageLabel: "p7", tailRole: "user", tailLen: 1, composerLength: 0 }) }),
      });
      assert.match(r.line, /PO_MANUAL_PAGE_EVIDENCE_UNPARSEABLE/);
      assert.equal(r.ledgerExists, false);
    }
    // (6) Missing pageLabel: the ledger schema requires a string page reference.
    {
      const r = await run("evidence-no-label", {
        runVerify: async () => ({ code: 0, result: "PO_MANUAL_PAGE_VERIFIED", output: verifiedOutput({ ...attachEvidence(), pageLabel: null }) }),
      });
      assert.match(r.line, /PO_MANUAL_PAGE_EVIDENCE_UNPARSEABLE/);
      assert.equal(r.ledgerExists, false);
    }
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("issue #40 manual-attach over an ABORTED ledger archives the replaced ledger byte-exact before writing the PO_MANUAL record", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-manual-abort-"));
  try {
    const dir = await setupConversation(root, { record: ledgerRecord({ status: "ABORTED", reasonCode: "DELIVERY_FAILED_SUSPECTED" }) });
    const oldBytes = await readFile(join(dir, "a-dispatch-state.json"));
    const { claimAgentSpace } = await import("../monitor/agent-space.mjs");
    await claimAgentSpace({ agentId: "gdc-a", spaceName: SPACE, directory: join(root, "registry") });
    const { code } = await capture(() => manualAttachDispatch(attachParams(root),
      { now: TS, runVerify: async () => ({ code: 0, result: "PO_MANUAL_PAGE_VERIFIED", output: verifiedOutput() }),
        directory: join(root, "registry") }));
    assert.equal(code, 0);
    // The replaced ABORTED instance is archived byte-exact (exclusive-create,
    // never overwritten) — 不物理删除原始证据.
    const backupFile = join(dir, "a-dispatch-state.archive-22222222-po-manual.json");
    assert.ok(sameBytes(await readFile(backupFile), oldBytes));
    // The new ledger is a DIFFERENT PO_MANUAL instance.
    const record = await readDispatchState(dir);
    assert.equal(record.status, "UNCERTAIN");
    assert.equal(record.source, PO_MANUAL_SOURCE);
    assert.notEqual(record.dispatchId, dispatchUuid);
    // The supersession stamp ties the arm to the replaced terminal instance.
    const state = JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8"));
    assert.equal(state.armedSupersededDispatchId, dispatchUuid);
    // The attach event references the backup.
    const attachRow = (await eventsOf(dir)).find((row) => row.event === "PO_MANUAL_ATTACHED");
    assert.equal(attachRow.backupFile, "a-dispatch-state.archive-22222222-po-manual.json");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("issue #40 parseVerifiedPageEvidence accepts exactly the complete evidence bundle and refuses every partial shape", () => {
  // The valid bundle round-trips.
  assert.deepEqual(parseVerifiedPageEvidence(verifiedOutput()), {
    pageLabel: "p7", tailRole: "user", tailKey: "po-user-tail-key", tailLen: 123, composerLength: 0,
  });
  // Found even when the verification output carries other lines around it.
  assert.deepEqual(parseVerifiedPageEvidence("noise\n" + verifiedOutput() + "\nmore noise"),
    { pageLabel: "p7", tailRole: "user", tailKey: "po-user-tail-key", tailLen: 123, composerLength: 0 });
  // assistant tails are legal baselines too.
  assert.equal(parseVerifiedPageEvidence(verifiedOutput({ ...attachEvidence(), tailRole: "assistant" })).tailRole, "assistant");
  // Refusals: missing/tampered fields, wrong roles, negative lengths, garbage.
  assert.equal(parseVerifiedPageEvidence("RESULT=PO_MANUAL_PAGE_VERIFIED"), null);
  assert.equal(parseVerifiedPageEvidence("RESULT=SOMETHING_ELSE evidence={}"), null);
  assert.equal(parseVerifiedPageEvidence(verifiedOutput({ ...attachEvidence(), tailKey: "" })), null);
  assert.equal(parseVerifiedPageEvidence(verifiedOutput({ ...attachEvidence(), tailRole: "system" })), null);
  assert.equal(parseVerifiedPageEvidence(verifiedOutput({ ...attachEvidence(), tailLen: -1 })), null);
  assert.equal(parseVerifiedPageEvidence(verifiedOutput({ ...attachEvidence(), composerLength: "0" })), null);
  assert.equal(parseVerifiedPageEvidence(verifiedOutput({ ...attachEvidence(), pageLabel: "" })), null);
  assert.equal(parseVerifiedPageEvidence(verifiedOutput({ ...attachEvidence(), pageLabel: null })), null);
  assert.equal(parseVerifiedPageEvidence("RESULT=PO_MANUAL_PAGE_VERIFIED evidence={broken"), null);
  assert.equal(parseVerifiedPageEvidence(null), null);
  assert.equal(parseVerifiedPageEvidence(undefined), null);
});

test("issue #40 extractDomReplyByBaseline anchors the reply boundary on the attach-time baseline tail (the PO's message is unknowable to the agent)", () => {
  const replyKey = "66666666-6666-4666-8666-666666666666";
  const partKey = "77777777-7777-4777-8777-777777777777";
  // Baseline user (the PO pasted the message last): the reply follows directly.
  const userBaseline = [
    { role: "assistant", text: "earlier", messageKey: "old" },
    { role: "user", text: "PO message", messageKey: "po-user-tail-key" },
    { role: "assistant", text: "managed reply", messageKey: replyKey },
  ];
  assert.deepEqual(extractDomReplyByBaseline(userBaseline, replyKey, "po-user-tail-key"),
    { text: "managed reply", source: "DOM_BOUNDARY_VISIBLE" });
  // Baseline assistant: exactly ONE user unit (the PO's message) then the reply.
  const assistantBaseline = [
    { role: "assistant", text: "baseline tail", messageKey: "po-user-tail-key" },
    { role: "user", text: "PO message", messageKey: "po-msg" },
    { role: "assistant", text: "part 1", messageKey: partKey },
    { role: "assistant", text: "part 2", messageKey: replyKey },
  ];
  assert.deepEqual(extractDomReplyByBaseline(assistantBaseline, replyKey, "po-user-tail-key"),
    { text: "part 1\n\npart 2", source: "DOM_BOUNDARY_VISIBLE" });
  // Fail-closed shapes: a second user unit after the baseline blurs the boundary.
  const lateKey = "88888888-8888-4888-8888-888888888888";
  assert.equal(extractDomReplyByBaseline([
    { role: "user", text: "PO", messageKey: "po-user-tail-key" },
    { role: "assistant", text: "a", messageKey: partKey },
    { role: "user", text: "more", messageKey: lateKey },
  ], lateKey, "po-user-tail-key"), null);
  // Two user units in the assistant-baseline shape (PO pasted twice) — unprovable.
  assert.equal(extractDomReplyByBaseline([
    { role: "assistant", text: "baseline", messageKey: "po-user-tail-key" },
    { role: "user", text: "PO", messageKey: "m1" },
    { role: "user", text: "PO again", messageKey: "m2" },
    { role: "assistant", text: "x", messageKey: replyKey },
  ], replyKey, "po-user-tail-key"), null);
  // The tail key must be EXACTLY the expected one (no stale-partial collection).
  assert.equal(extractDomReplyByBaseline(userBaseline, partKey, "po-user-tail-key"), null);
  // Baseline missing from the DOM (virtualized away): refuse, never guess.
  assert.equal(extractDomReplyByBaseline(userBaseline, replyKey, "gone-key"), null);
  // The expected tail key is contract-validated.
  assert.equal(extractDomReplyByBaseline(userBaseline, "not-a-uuid", "po-user-tail-key"), null);
  assert.equal(extractDomReplyByBaseline(null, replyKey, "po-user-tail-key"), null);
  assert.equal(extractDomReplyByBaseline(userBaseline, replyKey, ""), null);
});

test("issue #40 collect template: PO_MANUAL ledgers collect by baseline, the API path is skipped, and the tracked conversation's own PO page does not trip the unowned-tab stop (source pins)", async () => {
  const src = await readFile(new URL("../monitor/collect-reply.template.mjs", import.meta.url), "utf8");
  // The manual gate rides on the ledger source, not on any payload field.
  assert.match(src, /const manualSource = record\?\.source === "PO_MANUAL";/);
  // The payload-fingerprint gate exempts manual ledgers — but a manual ledger
  // WITHOUT a baseline tail still refuses (fail-closed, never unprovable).
  assert.match(src, /\(!record\.payload_sha256 && !manualSource\)/);
  assert.match(src, /manualSource && typeof record\.baselineTailKey !== "string"/);
  // The un-owned-tab stop exempts exactly the tracked conversation's own page.
  assert.match(src, /tabs\.some\(\(tab\) => tab\.openedBy !== "agent" && !isConversationUrl\(tab\.url, CONV, true\)\)/);
  // Manual extraction anchors on the attach-time baseline tail; managed sends
  // keep the payload-hash anchored extractor.
  assert.match(src, /let reply = manualSource\s*$/m);
  assert.match(src, /\?\s*extractDomReplyByBaseline\(units, fast\.lastMessageKey, record\.baselineTailKey\)/);
  assert.match(src, /extractDomReply\(units, record\.payload_sha256/);
  // The API fallback is skipped entirely for manual ledgers (both API
  // extractors anchor on the payload hash a manual ledger never carries).
  assert.match(src, /if \(!reply && !manualSource\) \{/);
  // The template imports the baseline extractor.
  assert.match(src, /import.*extractDomReply.*extractDomReplyByBaseline.*from|extractDomReplyByBaseline, extractApiReply|extractDomReply, extractDomReplyByBaseline/);
  assert.ok(src.includes("extractDomReplyByBaseline"));
});

test("issue #40 release sweep keep semantics: a PO-manual conversation has no dispatch-creation record — it classifies FIXED_SESSION and is NEVER closable, even with a COMPLETED ledger (real fs)", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-manual-sweep-"));
  try {
    const dir = join(root, "conversations", uuid);
    await mkdir(dir, { recursive: true });
    // A PO_MANUAL ledger that even reached COMPLETED (collect + consume ran).
    await writeFile(join(dir, "a-dispatch-state.json"), JSON.stringify(ledgerRecord({
      status: "COMPLETED", source: PO_MANUAL_SOURCE,
      payload_sha256: null, payload_bytes: null, composer_baseline: null,
    })));
    const record = await readDispatchState(dir);
    assert.equal(record.source, PO_MANUAL_SOURCE);
    assert.equal(record.status, "COMPLETED");
    // No a-new-request.json in the conversation dir — the durable ORIGIN record
    // proves this page was NOT created by a managed allocation.
    assert.equal(await anchoredDispatchCreated(root, uuid, SPACE), false);
    // The lifecycle classifier therefore keeps the page forever.
    const verdict = classifyPageLabelLifecycle({
      conversationUuid: uuid, known: [uuid], ledgerStatus: "COMPLETED", dispatchCreated: false,
    });
    assert.deepEqual(verdict, { lifecycle: PAGE_LABEL_LIFECYCLE.FIXED_SESSION, closable: false, reason: "FIXED_SESSION_PAGE" });
    // And the sweep decision for this page (not the release target) is KEPT.
    const swept = classifySweepPage({
      uuid, conversationUuid: otherUuid, known: [uuid], status: "COMPLETED", dispatchCreated: false,
    });
    assert.deepEqual(swept, { decision: "kept", reason: "FIXED_SESSION_PAGE" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("issue #40 commit-lock participation: both new shared-state writers use the monitor-root coordination domain (source pins)", async () => {
  const src = await readFile(new URL("../monitor/dispatch-manager.mjs", import.meta.url), "utf8");
  // discard-pending archives under the monitor-root commit lock.
  assert.match(src, /await withCommitLock\(commitLockScopeOf\(pending\), async \(\) => \{/);
  // manual-attach writes its ledger under the monitor-root commit lock (arm
  // runs through armForDispatch's own withCommitLock(commitLockScopeOf(dir))).
  assert.match(src, /await withCommitLock\(commitLockScopeOf\(dir\), async \(guard\) => \{/);
  // Both re-verify the decisive state INSIDE the lock (advisory-vs-lock TOCTOU closure).
  assert.match(src, /PENDING_DISCARD_RACE_LOST/);
  assert.match(src, /PO_MANUAL_ATTACH_RACE_LOST/);
  // And the arm itself is the frozen machine's own participant.
  assert.match(src, /await armForDispatch\(dir, \{ conversationUuid: p\.conversation, space: p\.space, timestamp: now \}\);/);
});
