// #38 fix 3: managed abort / expire semantics — evidence gate, identity gate,
// byte-level backup semantics, audit event, and the probe/watch observation
// wiring. Pure ledger level: no browser involved anywhere in this file.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeFastState } from "../monitor/state-schema.mjs";
import { parseArgs, main, evaluateAbortEvidence, ABORT_EVIDENCE_REQUIRED } from "../monitor/dispatch-manager.mjs";
import { readDispatchState } from "../monitor/dispatch-state.mjs";
import { sha256 } from "../monitor/reply-delivery.mjs";

const uuid = "11111111-1111-4111-8111-111111111111";
const dispatchUuid = "22222222-2222-4222-8222-222222222222";
const otherDispatchUuid = "33333333-3333-4333-8333-333333333333";
const SPACE = "GDC-执行A";
const BASELINE = "baseline-tail-key";

function ledgerRecord({ status = "ACCEPTED", dispatchId = dispatchUuid, baselineTailKey = BASELINE } = {}) {
  return { schema: "ego-dispatch-state/v2", dispatchId, conversationUuid: uuid,
    taskSpace: SPACE, pageLabel: "p1", status,
    baselineTailKey, baselineTailRole: "assistant", baselineComposerLength: 0,
    attempt: 1, createdAt: 1_800_000_000_000, payload_sha256: sha256("任务") };
}

const fastState = (patch = {}) => normalizeFastState({}, {
  generationKey: dispatchUuid, uiSchema: "CHATGPT_CHAT_KNOWN", dispatchStatus: "ACCEPTED",
  lastMessageRole: "assistant", lastMessageKey: "reply-tail-key", ...patch,
}, 1_800_000_000_000);

const supervisionStatus = (pendingReason = null) => ({
  schema: "ego-supervision/v1", generationKey: dispatchUuid, progressAt: 1_800_000_000_000,
  abnormalRounds: 1, lastReviewAt: 0,
  pending: pendingReason ? { id: "wake-1", reason: pendingReason, issuedAt: 1_800_000_000_000 } : null,
});

async function setupConversation(root, { record = ledgerRecord(), fastState: fast = null, supervision = null } = {}) {
  const dir = join(root, "conversations", uuid);
  await mkdir(dir, { recursive: true });
  if (record !== null) await writeFile(join(dir, "a-dispatch-state.json"), JSON.stringify(record));
  if (fast !== null) await writeFile(join(dir, "a-fast-state.json"), JSON.stringify(fast));
  if (supervision !== null) await writeFile(join(dir, "a-supervision-status.json"), JSON.stringify(supervision));
  return dir;
}

function abortArgs(root, dispatchId = dispatchUuid) {
  return ["abort", "--monitor-dir", root, "--agent-id", "gdc-a", "--space", SPACE,
    "--conversation", uuid, "--dispatch-id", dispatchId, "--reason", "DELIVERY_FAILED_SUSPECTED"];
}

const sameBytes = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

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

function evidenceJsonOf(errors) {
  const line = errors.find((l) => l.startsWith("RESULT=" + ABORT_EVIDENCE_REQUIRED));
  assert.ok(line, "expected an ABORT_EVIDENCE_REQUIRED line: " + JSON.stringify(errors));
  return JSON.parse(line.slice(line.indexOf("evidence=") + "evidence=".length));
}

async function lastEvent(dir) {
  const raw = await readFile(join(dir, "a-fast-events.ndjson"), "utf8");
  return JSON.parse(raw.trim().split("\n").at(-1));
}

test("#38 fix 3: abort args are validated and exclusive to the abort action", () => {
  assert.throws(() => parseArgs(["abort", "--monitor-dir", "x", "--agent-id", "gdc-a", "--space", "s",
    "--conversation", uuid, "--reason", "SOME_REASON"]), /ABORT_DISPATCH_ID_REQUIRED/);
  assert.throws(() => parseArgs(["abort", "--monitor-dir", "x", "--agent-id", "gdc-a", "--space", "s",
    "--conversation", uuid, "--dispatch-id", dispatchUuid, "--reason", "lowercase"]), /ABORT_REASON_CODE_INVALID/);
  assert.throws(() => parseArgs(["send", "--monitor-dir", "x", "--agent-id", "gdc-a", "--space", "s",
    "--conversation", uuid, "--message", "m", "--dispatch-id", dispatchUuid]), /ABORT_ARGS_ABORT_ONLY/);
  const ok = parseArgs(abortArgs("x"));
  assert.equal(ok.dispatchId, dispatchUuid);
  assert.equal(ok.reason, "DELIVERY_FAILED_SUSPECTED");
});

test("#38 fix 3: the pure evidence gate accepts exactly the three delivery-failure sources", () => {
  // (a) supervision DELIVERY_SUSPECTED
  assert.deepEqual(evaluateAbortEvidence({ ledgerStatus: "ACCEPTED", supervisionPendingReason: "DELIVERY_SUSPECTED" }),
    { ok: true, source: "SUPERVISION_DELIVERY_SUSPECTED" });
  // (b) fast-state deliveryFailedCandidate
  assert.deepEqual(evaluateAbortEvidence({ ledgerStatus: "ACCEPTED", deliveryFailedCandidate: true }),
    { ok: true, source: "FAST_STATE_DELIVERY_FAILED_CANDIDATE" });
  // (c) UNCERTAIN + tail on baseline + not generating
  assert.deepEqual(evaluateAbortEvidence({ ledgerStatus: "UNCERTAIN", fastTailKeyEqualsBaseline: true, fastStateGenerating: false }),
    { ok: true, source: "BASELINE_TAIL_UNADVANCED_UNCERTAIN" });
  // Fail-closed: null (unprovable) never satisfies a branch.
  assert.equal(evaluateAbortEvidence({}).ok, false);
  assert.equal(evaluateAbortEvidence({ deliveryFailedCandidate: null, supervisionPendingReason: null }).ok, false);
  // (c) needs all three conditions simultaneously.
  assert.equal(evaluateAbortEvidence({ ledgerStatus: "UNCERTAIN", fastTailKeyEqualsBaseline: true, fastStateGenerating: true }).ok, false);
  assert.equal(evaluateAbortEvidence({ ledgerStatus: "ACCEPTED", fastTailKeyEqualsBaseline: true, fastStateGenerating: false }).ok, false);
});

test("#38 fix 3: abort succeeds on supervision DELIVERY_SUSPECTED evidence (source a)", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-abort-a-"));
  try {
    const dir = await setupConversation(root, {
      supervision: supervisionStatus("DELIVERY_SUSPECTED"),
    });
    const before = await readFile(join(dir, "a-dispatch-state.json"));
    const { code, logs } = await capture(() => main(abortArgs(root)));
    assert.equal(code, 0);
    const record = await readDispatchState(dir);
    assert.equal(record.status, "ABORTED");
    assert.equal(record.abortReason, "DELIVERY_FAILED_SUSPECTED");
    assert.equal(record.abortedBy, "gdc-a");
    assert.equal(typeof record.abortedAt, "number");
    assert.equal(record.payload_sha256, sha256("任务")); // identity fields preserved
    assert.ok(logs.some((l) => l.startsWith("RESULT=DISPATCH_ABORTED dispatchId=" + dispatchUuid +
      " reason=DELIVERY_FAILED_SUSPECTED evidence=SUPERVISION_DELIVERY_SUSPECTED backup=")));
    // The pre-abort backup is byte-exact with the ledger before the write.
    const backupFile = join(dir, `a-dispatch-state.archive-${dispatchUuid.slice(0, 8)}-abort.json`);
    assert.ok(sameBytes(await readFile(backupFile), before), "backup must be byte-exact");
    const event = await lastEvent(dir);
    assert.equal(event.event, "DISPATCH_ABORTED");
    assert.equal(event.reason, "DELIVERY_FAILED_SUSPECTED");
    assert.equal(event.evidence, "SUPERVISION_DELIVERY_SUSPECTED");
    assert.equal(event.abortedBy, "gdc-a");
    assert.equal(event.backupFile, `a-dispatch-state.archive-${dispatchUuid.slice(0, 8)}-abort.json`);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#38 fix 3: abort succeeds on fast-state deliveryFailedCandidate evidence (source b)", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-abort-b-"));
  try {
    const dir = await setupConversation(root, {
      fastState: fastState({ deliveryFailedCandidate: true, lastMessageKey: BASELINE }),
    });
    const { code } = await capture(() => main(abortArgs(root)));
    assert.equal(code, 0);
    const record = await readDispatchState(dir);
    assert.equal(record.status, "ABORTED");
    const event = await lastEvent(dir);
    assert.equal(event.evidence, "FAST_STATE_DELIVERY_FAILED_CANDIDATE");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#38 fix 3: abort succeeds on UNCERTAIN + baseline-tail-never-advanced evidence (source c)", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-abort-c-"));
  try {
    const dir = await setupConversation(root, {
      record: ledgerRecord({ status: "UNCERTAIN" }),
      fastState: fastState({ lastMessageKey: BASELINE, generating: false, deliveryFailedCandidate: false }),
      supervision: supervisionStatus(null),
    });
    const { code } = await capture(() => main(abortArgs(root)));
    assert.equal(code, 0);
    const record = await readDispatchState(dir);
    assert.equal(record.status, "ABORTED");
    const event = await lastEvent(dir);
    assert.equal(event.evidence, "BASELINE_TAIL_UNADVANCED_UNCERTAIN");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#38 fix 3: abort without any delivery-failure evidence is refused fail-closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-abort-noev-"));
  try {
    const dir = await setupConversation(root, {
      record: ledgerRecord({ status: "UNCERTAIN" }),
      fastState: fastState({ lastMessageKey: "reply-tail-key", generating: false }),
      supervision: supervisionStatus(null),
    });
    const before = await readFile(join(dir, "a-dispatch-state.json"));
    const { code, errors } = await capture(() => main(abortArgs(root)));
    assert.equal(code, 2);
    const summary = evidenceJsonOf(errors);
    assert.equal(summary.ledger, "UNCERTAIN");
    assert.equal(summary.dispatchIdMatch, true);
    assert.equal(summary.deliveryFailedCandidate, false);
    assert.equal(summary.supervisionPendingReason, null);
    assert.equal(summary.fastTailKeyEqualsBaseline, false);
    // Nothing was written: ledger unchanged, no backup, no audit event.
    assert.ok(sameBytes(await readFile(join(dir, "a-dispatch-state.json")), before), "ledger must stay unchanged");
    await assert.rejects(readFile(join(dir, "a-dispatch-state.archive-" + dispatchUuid.slice(0, 8) + "-abort.json")), { code: "ENOENT" });
    await assert.rejects(readFile(join(dir, "a-fast-events.ndjson")), { code: "ENOENT" });
    assert.ok(errors.some((l) => l.includes("OPERATOR_ACTION=abort")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#38 fix 3: unreadable evidence files are never evidence (ABORT_EVIDENCE_REQUIRED)", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-abort-corrupt-"));
  try {
    const dir = await setupConversation(root, {});
    await writeFile(join(dir, "a-fast-state.json"), "{not json");
    await writeFile(join(dir, "a-supervision-status.json"), "{broken");
    const { code, errors } = await capture(() => main(abortArgs(root)));
    assert.equal(code, 2);
    const summary = evidenceJsonOf(errors);
    assert.equal(summary.fastState, "UNREADABLE");
    assert.equal(summary.supervisionPendingReason, "UNREADABLE");
    assert.equal(summary.deliveryFailedCandidate, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#38 fix 3: a structurally invalid fast state proves nothing either", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-abort-badfs-"));
  try {
    const dir = await setupConversation(root, {});
    // Parses fine but fails the v4 contract — the arm/disarm fail-closed precedent.
    await writeFile(join(dir, "a-fast-state.json"), JSON.stringify({ schema: "ego-fast-state/v9", deliveryFailedCandidate: true }));
    const { code, errors } = await capture(() => main(abortArgs(root)));
    assert.equal(code, 2);
    const summary = evidenceJsonOf(errors);
    assert.equal(summary.fastState, "CORRUPT");
    assert.equal(summary.deliveryFailedCandidate, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#38 fix 3: abort on an absent ledger is refused (ABORT_EVIDENCE_REQUIRED)", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-abort-absent-"));
  try {
    const dir = await setupConversation(root, { record: null });
    const { code, errors } = await capture(() => main(abortArgs(root)));
    assert.equal(code, 2);
    const summary = evidenceJsonOf(errors);
    assert.equal(summary.ledger, "ABSENT");
    assert.equal(summary.dispatchIdMatch, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#38 fix 3: a --dispatch-id mismatch is refused before any evidence is read", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-abort-mismatch-"));
  try {
    const dir = await setupConversation(root, { supervision: supervisionStatus("DELIVERY_SUSPECTED") });
    const before = await readFile(join(dir, "a-dispatch-state.json"));
    const { code, errors } = await capture(() => main(abortArgs(root, otherDispatchUuid)));
    assert.equal(code, 2);
    assert.ok(errors.some((l) => l.startsWith("RESULT=ABORT_DISPATCH_ID_MISMATCH")));
    const summary = JSON.parse(errors[0].slice(errors[0].indexOf("evidence=") + "evidence=".length));
    assert.equal(summary.dispatchIdMatch, false);
    assert.ok(sameBytes(await readFile(join(dir, "a-dispatch-state.json")), before), "ledger must stay unchanged");
    await assert.rejects(readFile(join(dir, "a-fast-events.ndjson")), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#38 fix 3: conversation or space mismatch is refused (ABORT_IDENTITY_MISMATCH)", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-abort-space-"));
  try {
    const dir = await setupConversation(root, { supervision: supervisionStatus("DELIVERY_SUSPECTED") });
    const before = await readFile(join(dir, "a-dispatch-state.json"));
    const { code, errors } = await capture(() => main(
      ["abort", "--monitor-dir", root, "--agent-id", "gdc-a", "--space", "别的空间",
        "--conversation", uuid, "--dispatch-id", dispatchUuid, "--reason", "DELIVERY_FAILED_SUSPECTED"]));
    assert.equal(code, 2);
    assert.ok(errors.some((l) => l.startsWith("RESULT=ABORT_IDENTITY_MISMATCH")));
    assert.ok(sameBytes(await readFile(join(dir, "a-dispatch-state.json")), before), "ledger must stay unchanged");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#38 fix 3: terminal ledgers refuse a repeated abort (ABORT_NOT_APPLICABLE)", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-abort-terminal-"));
  try {
    for (const status of ["COMPLETED", "ABORTED"]) {
      const dir = await setupConversation(root, { record: ledgerRecord({ status }) });
      const before = await readFile(join(dir, "a-dispatch-state.json"));
      const { code, errors } = await capture(() => main(abortArgs(root)));
      assert.equal(code, 2, status);
      assert.ok(errors.some((l) => l === "RESULT=ABORT_NOT_APPLICABLE status=" + status), status);
      assert.ok(sameBytes(await readFile(join(dir, "a-dispatch-state.json")), before), status + " ledger must stay unchanged");
      await rm(dir, { recursive: true, force: true });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#38 fix 3: an existing abort backup is never overwritten — a timestamped sibling is written", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-abort-bkexist-"));
  try {
    const dir = await setupConversation(root, { supervision: supervisionStatus("DELIVERY_SUSPECTED") });
    const backupName = `a-dispatch-state.archive-${dispatchUuid.slice(0, 8)}-abort.json`;
    await writeFile(join(dir, backupName), "PRESERVE-ME");
    const before = await readFile(join(dir, "a-dispatch-state.json"));
    const { code, logs } = await capture(() => main(abortArgs(root)));
    assert.equal(code, 0);
    // The pre-existing backup is untouched.
    assert.equal(await readFile(join(dir, backupName), "utf8"), "PRESERVE-ME");
    // The new backup is a timestamped sibling, still byte-exact with the pre-abort ledger.
    const logged = logs.find((l) => l.startsWith("RESULT=DISPATCH_ABORTED"));
    const backupField = logged.match(/backup=(\S+)/)[1];
    assert.match(backupField, new RegExp(`^a-dispatch-state\\.archive-${dispatchUuid.slice(0, 8)}-abort-\\d+\\.json$`));
    assert.ok(sameBytes(await readFile(join(dir, backupField)), before), "timestamped backup must be byte-exact");
    const event = await lastEvent(dir);
    assert.equal(event.backupFile, backupField);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#38 fix 3: watch arms on an ABORTED ledger and exits through the durable wake ledger", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-abort-watch-"));
  try {
    const dir = await setupConversation(root, { record: ledgerRecord({ status: "ABORTED" }) });
    const { code, logs } = await capture(() => main(["watch", "--monitor-dir", root, "--agent-id", "gdc-a",
      "--space", SPACE, "--conversation", uuid]));
    assert.equal(code, 2);
    const marker = JSON.parse(await readFile(join(dir, "a-watch-exit.json"), "utf8"));
    assert.equal(marker.reason, "DISPATCH_ABORTED_WAKE_SUPERVISOR");
    assert.equal(marker.exitCode, 2);
    assert.equal(marker.acknowledgedAt, null);
    assert.ok(logs.some((l) => l === "RESULT=DISPATCH_ABORTED_WAKE_SUPERVISOR action=watch wakeId=" + marker.wakeId));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#38 fix 3: both probes treat ABORTED as terminal and wake the watch loop", async () => {
  for (const name of ["ego-fast-probe.mjs", "ego-fast-probe-live.mjs"]) {
    const source = await readFile(new URL(`../monitor/${name}`, import.meta.url), "utf8");
    assert.match(source, /if \(abortedDispatch\) \{/, name);
    assert.match(source, /await appendEvent\(MON, "DISPATCH_ABORTED_OBSERVED", \{ dispatchId \}\);/, name);
    assert.match(source, /console\.log\("RESULT=DISPATCH_ABORTED_WAKE_SUPERVISOR"\);/, name);
    assert.match(source, /process\.exit\(0\);/, name);
  }
  // The watch loop short-circuits the probe's abort signal at the same slot as
  // DONE_CANDIDATE, and the startup terminal check covers an ABORTED ledger too.
  const source = await readFile(new URL("../monitor/dispatch-manager.mjs", import.meta.url), "utf8");
  const watch = source.slice(source.indexOf('if (p.action === "watch")'), source.indexOf('if (p.action === "probe") await writeFile'));
  assert.match(watch, /observation\.result === "DISPATCH_ABORTED_WAKE_SUPERVISOR"/);
  assert.match(watch, /exitWatching\(dir, "DISPATCH_ABORTED_WAKE_SUPERVISOR", \{ detail: "action=probe" \}\)/);
  assert.match(watch, /if \(armed\.status === "ABORTED"\) \{/);
  assert.match(watch, /exitWatching\(dir, "DISPATCH_ABORTED_WAKE_SUPERVISOR", \{ detail: "action=watch" \}\)/);
  // requireArmedDispatch accepts ABORTED for watch (never for probe).
  const armed = source.slice(source.indexOf("export async function requireArmedDispatch"), source.indexOf("export async function loadAttachments"));
  assert.match(armed, /"SEND_STARTED", "UNCERTAIN", "ACCEPTED", "COMPLETED", "ABORTED"/);
});
