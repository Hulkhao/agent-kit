// #27 Batch 3 (ruling §四, docs/planning/issue-27-ruling-20261116.md): the
// arm-on-wait machine at unit level — frozen four-state transition matrix,
// arm-before-delivery ordering, disarm criteria, legacy-ledger compatibility
// and the two page-label lifecycles. 11-scenario live acceptance and the
// 4-item resource comparison are a separate supervised phase (task brief).
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, rm, mkdtemp, readdir, chmod, stat, utimes } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  ARMED_REASONS, IN_FLIGHT_DISPATCH_STATUSES, FAST_STATE_DEFAULTS,
  canTransitionArmedReason, armedTransitionPatch, armedReasonOnPeerGeneration,
  armedReasonOnProbeRound, classifyFastStateFile, classifyProbeBootState, normalizeFastState, validateFastState,
} from "../monitor/state-schema.mjs";
import { evaluateDisarmEligibility, dispatchStormGate, prepareDispatch, withCommitLock, isCommitLockError, COMMIT_LOCK_FILE, COMMIT_LOCK_PREFIX, COMMIT_LOCK_SCHEMA } from "../monitor/dispatch-state.mjs";
import {
  armForDispatch, disarmAfterRelease, retryPendingDisarm, managedAcknowledge, acknowledgeWake,
  classifyPageLabelLifecycle, PAGE_LABEL_LIFECYCLE,
  releaseDelivered, directRelease,
  watchExitStructureError, supervisionStatusStructureError,
} from "../monitor/dispatch-manager.mjs";
import {
  watchExitStructureError as wakeContextWatchExitStructureError,
  supervisionStatusStructureError as wakeContextSupervisionStructureError,
} from "../plugins/chatgpt-dispatch-guard/hooks/wake-context.mjs";
import { saveReply, acknowledgeReply, sha256 } from "../monitor/reply-delivery.mjs";

const uuid = "11111111-1111-4111-8111-111111111111";
const otherUuid = "22222222-2222-4222-8222-222222222222";

const dispatchRecord = (overrides = {}) => ({
  schema: "ego-dispatch-state/v2", dispatchId: uuid, conversationUuid: uuid,
  taskSpace: "GDC-执行A", pageLabel: "p1", status: "COMPLETED",
  baselineTailKey: null, baselineTailRole: null, baselineComposerLength: 0,
  attempt: 1, createdAt: Date.now(), payload_sha256: sha256("任务"), ...overrides,
});

const armedState = (armedReason, overrides = {}) =>
  normalizeFastState({}, { ts: Date.now(), armedReason, ...overrides });

async function makeConversation(root, files = {}) {
  const dir = join(root, "conversations", uuid);
  await mkdir(dir, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    await writeFile(join(dir, name), typeof value === "string" ? value : JSON.stringify(value), "utf8");
  }
  return dir;
}

// ---- Requirement 1 (ruling §四.1): the frozen four-state machine ----

test("#27 B3 transition matrix: every frozen pair, and only those, is legal", () => {
  const legal = new Map([
    [null, ["DISPATCH_ACCEPTED", "ARMED_UNKNOWN"]],
    ["DISPATCH_ACCEPTED", ["DISPATCH_ACCEPTED", "PEER_GENERATING", "DISARMED_IDLE", "ARMED_UNKNOWN"]],
    ["PEER_GENERATING", ["PEER_GENERATING", "DISPATCH_ACCEPTED", "DISARMED_IDLE", "ARMED_UNKNOWN"]],
    // re-arm on a new dispatch goes through DISPATCH_ACCEPTED; a peer-generating
    // claim straight out of idle would be unproven inference
    ["DISARMED_IDLE", ["DISARMED_IDLE", "DISPATCH_ACCEPTED", "ARMED_UNKNOWN"]],
    ["ARMED_UNKNOWN", ["ARMED_UNKNOWN", "DISPATCH_ACCEPTED", "PEER_GENERATING", "DISARMED_IDLE"]],
  ]);
  for (const [from, targets] of legal) {
    for (const to of ARMED_REASONS) {
      assert.equal(canTransitionArmedReason(from, to), targets.includes(to),
        `${from} -> ${to}`);
    }
  }
  // Illegal: legacy idle cannot claim peer generation, legacy cannot claim
  // PEER_GENERATING at all.
  assert.equal(canTransitionArmedReason(null, "PEER_GENERATING"), false);
  assert.equal(canTransitionArmedReason(null, "DISARMED_IDLE"), false);
  assert.equal(canTransitionArmedReason("DISARMED_IDLE", "PEER_GENERATING"), false);
  // A foreign "from" value (hand-edited file) is read as legacy-null, fail-closed.
  assert.equal(canTransitionArmedReason("WEIRD", "DISPATCH_ACCEPTED"), true);
  assert.equal(canTransitionArmedReason("WEIRD", "PEER_GENERATING"), false);
  assert.equal(canTransitionArmedReason("DISPATCH_ACCEPTED", "WEIRD"), false);
});

test("#27 B3 armedTransitionPatch: legal pairs produce the full anchor patch, illegal pairs are refused", () => {
  const ok = armedTransitionPatch("DISPATCH_ACCEPTED", "PEER_GENERATING", { conversation: uuid, space: "s", timestamp: 42 });
  assert.deepEqual(ok, { ok: true, patch: { armedReason: "PEER_GENERATING", armedAt: 42, armedConversation: uuid, armedSpace: "s" } });
  assert.equal(armedTransitionPatch("DISARMED_IDLE", "PEER_GENERATING").ok, false);
  assert.equal(armedTransitionPatch("DISARMED_IDLE", "PEER_GENERATING").patch, null);
  // Timestamps default to now, never invented constants.
  const defaulted = armedTransitionPatch(null, "DISPATCH_ACCEPTED");
  assert.ok(Math.abs(defaulted.patch.armedAt - Date.now()) < 5000);
});

test("#27 B3 peer-generation upgrade: only observed generation upgrades, idle is never promoted, legacy stays null", () => {
  assert.equal(armedReasonOnPeerGeneration("DISPATCH_ACCEPTED", true), "PEER_GENERATING");
  assert.equal(armedReasonOnPeerGeneration("ARMED_UNKNOWN", true), "PEER_GENERATING");
  assert.equal(armedReasonOnPeerGeneration("PEER_GENERATING", true), "PEER_GENERATING");
  assert.equal(armedReasonOnPeerGeneration("DISPATCH_ACCEPTED", false), "DISPATCH_ACCEPTED");
  assert.equal(armedReasonOnPeerGeneration("DISARMED_IDLE", true), "DISARMED_IDLE");
  assert.equal(armedReasonOnPeerGeneration(null, true), null);
  assert.equal(armedReasonOnPeerGeneration(null, false), null);
});

test("#27 B3 probe-round resolution: upgrade, hold, fail-closed ARMED_UNKNOWN over an in-flight legacy ledger", () => {
  // Armed states upgrade on observed generation only.
  assert.equal(armedReasonOnProbeRound("DISPATCH_ACCEPTED", { generating: true }), "PEER_GENERATING");
  assert.equal(armedReasonOnProbeRound("DISPATCH_ACCEPTED", { generating: false }), "DISPATCH_ACCEPTED");
  assert.equal(armedReasonOnProbeRound("ARMED_UNKNOWN", { generating: true }), "PEER_GENERATING");
  assert.equal(armedReasonOnProbeRound("PEER_GENERATING", { generating: false }), "PEER_GENERATING");
  // Disarm stays manager-owned: a stray probe never upgrades idle and never disarms.
  assert.equal(armedReasonOnProbeRound("DISARMED_IDLE", { generating: true, dispatchInFlight: true }), "DISARMED_IDLE");
  // Legacy null: no arm inference — EXCEPT the fail-closed catch-all for an
  // in-flight ledger with a missing arm field (状态缺失 → ARMED_UNKNOWN).
  assert.equal(armedReasonOnProbeRound(null, { generating: true, dispatchInFlight: false }), null);
  assert.equal(armedReasonOnProbeRound(null, { generating: false, dispatchInFlight: true }), "ARMED_UNKNOWN");
  assert.equal(armedReasonOnProbeRound(null, { generating: true, dispatchInFlight: true }), "ARMED_UNKNOWN");
});

test("#27 B3 schema: the in-flight status set matches the ledger's active set; arm fields survive normalize/validate", () => {
  assert.deepEqual([...IN_FLIGHT_DISPATCH_STATUSES].sort(),
    ["ACCEPTED", "PREPARED", "RETRY_AUTHORIZED", "SEND_STARTED", "UNCERTAIN"]);
  assert.equal(IN_FLIGHT_DISPATCH_STATUSES.has("COMPLETED"), false);
  assert.equal(IN_FLIGHT_DISPATCH_STATUSES.has("RELEASED"), false);
  for (const reason of ARMED_REASONS) {
    const state = armedState(reason);
    assert.equal(validateFastState(state), true, reason);
    assert.equal(state.armedReason, reason);
  }
  // Foreign reason values are coerced to legacy-null on read — no invented
  // state is ever trusted (hand-edited file defense).
  const coerced = normalizeFastState({}, { armedReason: "WEIRD" });
  assert.equal(coerced.armedReason, null);
  assert.equal(validateFastState({ ...armedState("DISPATCH_ACCEPTED"), armedReason: "WEIRD" }), false);
});

// ---- Requirement 5 (ruling §四.1): legacy ledger compatibility ----

test("#27 B3 legacy ledger: v3 classification, arm fields absent on read, never auto-disarmed or auto-promoted", async () => {
  // A minimal pre-arm v3 ledger reads as legacy, and its migrated form has a
  // null armedReason (legacy mode, no arm information invented).
  const legacy = { schema: "ego-fast-state/v3", ts: 123 };
  assert.equal(classifyFastStateFile(legacy), "legacy");
  assert.equal(normalizeFastState(legacy, {}, 123).armedReason, null);
  assert.equal(classifyFastStateFile(armedState("DISPATCH_ACCEPTED")), "current");
  assert.equal(classifyFastStateFile({ schema: "ego-fast-state/v4", junk: true }), "corrupt");
  assert.equal(classifyFastStateFile("not an object"), "corrupt");

  // Writing side: a legacy ledger refuses disarm (no disarm inference).
  assert.deepEqual(
    evaluateDisarmEligibility({ armedReason: null, dispatchStatus: "COMPLETED", replyConsumed: true }),
    { eligible: false, blockers: ["ARM_STATE_LEGACY_NO_DISARM_INFERENCE"] });
  // …and the probe keeps it null even while the peer generates (no PEER_GENERATING inference).
  assert.equal(armedReasonOnProbeRound(null, { generating: true }), null);
});

// ---- Requirement 2 (ruling §四.2): arm before delivery ----

test("#27 B3 armForDispatch: missing ledger arms DISPATCH_ACCEPTED durably with anchors and event", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-arm-missing-"));
  try {
    const dir = await makeConversation(root);
    const before = Date.now();
    const next = await armForDispatch(dir, { conversationUuid: uuid, space: "GDC-执行A" });
    assert.equal(next.armedReason, "DISPATCH_ACCEPTED");
    assert.equal(next.armedConversation, uuid);
    assert.equal(next.armedSpace, "GDC-执行A");
    assert.ok(next.armedAt >= before);
    assert.equal(validateFastState(next), true);
    const onDisk = JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8"));
    assert.equal(onDisk.armedReason, "DISPATCH_ACCEPTED");
    const events = await readFile(join(dir, "a-fast-events.ndjson"), "utf8");
    assert.match(events, /ARMED_DISPATCH_ACCEPTED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#27 B3 armForDispatch: every prior state re-arms through the matrix; corrupt state lands in ARMED_UNKNOWN; legacy arms without losing its fields", async () => {
  for (const [prior, expected] of [
    ["DISPATCH_ACCEPTED", "DISPATCH_ACCEPTED"],
    ["PEER_GENERATING", "DISPATCH_ACCEPTED"],
    ["DISARMED_IDLE", "DISPATCH_ACCEPTED"],
    ["ARMED_UNKNOWN", "DISPATCH_ACCEPTED"],
  ]) {
    const root = await mkdtemp(join(tmpdir(), "ego-arm-rearm-"));
    try {
      const dir = await makeConversation(root, { "a-fast-state.json": armedState(prior) });
      const next = await armForDispatch(dir, { conversationUuid: uuid, space: "GDC-执行A" });
      assert.equal(next.armedReason, expected, prior);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
  // Corrupt fast state: fail-closed ARMED_UNKNOWN, never a clean armed claim.
  {
    const root = await mkdtemp(join(tmpdir(), "ego-arm-corrupt-"));
    try {
      const dir = await makeConversation(root, { "a-fast-state.json": "{corrupted" });
      const next = await armForDispatch(dir, { conversationUuid: uuid, space: "GDC-执行A" });
      assert.equal(next.armedReason, "ARMED_UNKNOWN");
      assert.equal(validateFastState(next), true);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
  // Legacy v3 ledger: arms the new dispatch and keeps the legacy payload fields.
  {
    const root = await mkdtemp(join(tmpdir(), "ego-arm-legacy-"));
    try {
      const dir = await makeConversation(root, {
        "a-fast-state.json": JSON.stringify({ schema: "ego-fast-state/v3", ts: 777, pageLabel: "legacy-label" }),
      });
      const next = await armForDispatch(dir, { conversationUuid: uuid, space: "GDC-执行A" });
      assert.equal(next.armedReason, "DISPATCH_ACCEPTED");
      assert.equal(next.pageLabel, "legacy-label");
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("#27 B3 P1-A: arming over a corrupt fast state archives the evidence and the storm gate stays shut", async () => {
  // A corrupt ledger that carries live storm evidence: parses, fails the v4
  // schema (unknown field). Under the pre-fix behavior armForDispatch rebuilt
  // a legal v4 over it and the delivery-side gate lost its judgment basis —
  // a corrupted block became a delivery pass.
  const corruptBytes = JSON.stringify({
    schema: "ego-fast-state/v4", notAField: 1,
    backoffUntil: Date.now() + 9 * 60_000,
    errorCode: "CHAT_SURFACE_STRUCTURALLY_UNAVAILABLE",
  });
  const root = await mkdtemp(join(tmpdir(), "ego-arm-corrupt-gate-"));
  try {
    const dir = await makeConversation(root, { "a-fast-state.json": corruptBytes });
    const next = await armForDispatch(dir, { conversationUuid: uuid, space: "GDC-执行A" });
    // The arm state is fail-closed ARMED_UNKNOWN WITH the readable carry-over
    // marker the delivery-side gate refuses on.
    assert.equal(next.armedReason, "ARMED_UNKNOWN");
    assert.equal(next.errorCode, "STATE_CORRUPT");
    assert.equal(next.probeFailed, true);
    assert.equal(validateFastState(next), true);
    // The delivery-side storm gate sees the carry-over: no delivery permission.
    assert.equal(await dispatchStormGate(dir), "STORM_BACKOFF_PENDING");
    // The original corrupt bytes survive verbatim in an exclusive-create
    // archive next to the ledger.
    const archive = join(dir, "a-fast-state.archive-corrupt-arm.json");
    assert.equal(await readFile(archive, "utf8"), corruptBytes);
    const events = await readFile(join(dir, "a-fast-events.ndjson"), "utf8");
    assert.match(events, /"corruptArchive":"a-fast-state\.archive-corrupt-arm\.json"/);
    assert.match(events, /"stormCarryOver":"STATE_CORRUPT"/);
    // Repeated arms never reopen the gate and never overwrite the archive.
    await armForDispatch(dir, { conversationUuid: uuid, space: "GDC-执行A" });
    assert.equal(await dispatchStormGate(dir), "STORM_BACKOFF_PENDING");
    assert.equal(await readFile(archive, "utf8"), corruptBytes);
    assert.ok(!(await readFile(join(dir, "a-fast-events.ndjson"), "utf8")).split("\n")
      .filter((line) => line.includes("ARMED_DISPATCH_ACCEPTED")).some((line) => line.includes("archive-corrupt-arm-")));
  } finally { await rm(root, { recursive: true, force: true }); }
  // Control: a clean (missing) ledger arms without any gate side effect.
  {
    const cleanRoot = await mkdtemp(join(tmpdir(), "ego-arm-clean-gate-"));
    try {
      const dir = await makeConversation(cleanRoot);
      await armForDispatch(dir, { conversationUuid: uuid, space: "GDC-执行A" });
      assert.equal(await dispatchStormGate(dir), null);
    } finally { await rm(cleanRoot, { recursive: true, force: true }); }
  }
});

test("#27 B3 P1-A round 2: an archive failure aborts the arm write and preserves the original corrupt ledger", async () => {
  // Forcing (real filesystem behavior, no mocks): the archive's
  // exclusive-create name is occupied by a DIRECTORY, and the collision-retry
  // name carries a timestamp whose string conversion fails, so the archive can
  // never be created (the exclusive-create retry loop stays bounded and
  // deterministic on every platform: attempt 0 is EEXIST, the next attempt
  // deterministically throws).
  const corruptBytes = JSON.stringify({ schema: "ego-fast-state/v4", notAField: 1 });
  const root = await mkdtemp(join(tmpdir(), "ego-arm-archive-fail-"));
  try {
    const dir = await makeConversation(root, { "a-fast-state.json": corruptBytes });
    await mkdir(join(dir, "a-fast-state.archive-corrupt-arm.json"), { recursive: true });
    const poisoned = { toString() { throw new TypeError("SIMULATED_ARCHIVE_FAILURE"); } };
    await assert.rejects(
      armForDispatch(dir, { conversationUuid: uuid, space: "GDC-执行A", timestamp: poisoned }),
      /ARM_CORRUPT_STATE_ARCHIVE_FAILED/);
    // The original corrupt ledger survives byte-for-byte — nothing overwrote it
    // for the sake of arming (the storm gate still refuses on it, fail-closed).
    assert.equal(await readFile(join(dir, "a-fast-state.json"), "utf8"), corruptBytes);
    await assert.rejects(dispatchStormGate(dir), /FAST_STATE_INVALID/);
    // No new arm state and no archive artifact: the only archive-named entry is
    // the DIRECTORY that occupied the exclusive-create name (the forcing state).
    const entries = await readdir(dir);
    assert.equal(entries.includes("a-fast-state.json"), true);
    assert.deepEqual(entries.filter((name) => name.startsWith("a-fast-state.archive-")),
      ["a-fast-state.archive-corrupt-arm.json"]);
    // Event audit trail: the failure is recorded, no arm event is.
    const events = await readFile(join(dir, "a-fast-events.ndjson"), "utf8");
    assert.match(events, /CORRUPT_STATE_ARCHIVE_FAILED/);
    assert.equal(events.includes("ARMED_DISPATCH_ACCEPTED"), false);
    // Recovery: a retry with a working archive path (the occupied name moves
    // aside via the collision loop) arms again with the STATE_CORRUPT carry-over.
    const next = await armForDispatch(dir, { conversationUuid: uuid, space: "GDC-执行A" });
    assert.equal(next.armedReason, "ARMED_UNKNOWN");
    assert.equal(next.errorCode, "STATE_CORRUPT");
    assert.equal(await dispatchStormGate(dir), "STORM_BACKOFF_PENDING");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#27 B3 P1-D: the shared boot contract classifies v3 as legacy-migrate, never corrupt; both probe variants use it", async () => {
  // v3 — the previous OFFICIAL schema — is legacy (migrate), exactly the
  // classifyFastStateFile contract; the probes' old branch missed it.
  assert.equal(classifyProbeBootState({ schema: "ego-fast-state/v3", ts: 1 }), "migrate");
  assert.equal(classifyProbeBootState({ schema: "ego-fast-state/v3", junk: true }), "migrate");
  // Pre-v3 shapes keep migrating (unchanged behavior).
  assert.equal(classifyProbeBootState({ schema: "ego-fast-state/v2", ts: 1 }), "migrate");
  assert.equal(classifyProbeBootState({ ts: 1 }), "migrate");
  // Valid v4 is current; v4 schema violations and unknown schemas are corrupt.
  assert.equal(classifyProbeBootState(armedState("DISPATCH_ACCEPTED")), "current");
  assert.equal(classifyProbeBootState({ schema: "ego-fast-state/v4", notAField: 1 }), "corrupt");
  assert.equal(classifyProbeBootState({ schema: "ego-fast-state/v5", ts: 1 }), "corrupt");
  assert.equal(classifyProbeBootState([1, 2, 3]), "corrupt");
  assert.equal(classifyProbeBootState(null), "corrupt");
  assert.equal(classifyProbeBootState("{junk"), "corrupt");
  // Both probe variants must boot through the shared contract (source pin:
  // the old per-probe schema branch is gone).
  for (const probeFile of ["ego-fast-probe.mjs", "ego-fast-probe-live.mjs"]) {
    const source = await readFile(
      fileURLToPath(new URL("../monitor/" + probeFile, import.meta.url)), "utf8");
    assert.match(source, /const bootState = classifyProbeBootState\(parsed\);/, probeFile);
    assert.match(source, /bootState === "migrate"/, probeFile);
    assert.doesNotMatch(source, /parsed\.schema == null \|\| parsed\.schema === "ego-fast-state\/v2"\)\) \{/, probeFile);
  }
});

test("#27 B3 P1-B: the mirrored wake-guard structure contracts are verdict-equivalent to the hook's", async () => {
  // dispatch-manager.mjs mirrors wake-context.mjs verbatim (the monitor
  // runtime never copies the plugins tree and the hook stays import-free of
  // monitor/**); this equivalence pin makes drift impossible to miss.
  const markerCases = [
    undefined, null, 42, "x", [],
    {},
    { schema: "ego-watch-exit/v1" },
    { schema: "ego-watch-exit/v1", wakeId: uuid, issuedAt: Date.now(), exitCode: 2, acknowledgedAt: null, ackAction: null },
    { schema: "ego-watch-exit/v1", wakeId: uuid, issuedAt: Date.now(), exitCode: 2, acknowledgedAt: Date.now(), ackAction: "investigated" },
    { schema: "ego-watch-exit/v1", wakeId: uuid, issuedAt: Date.now(), exitCode: 2, acknowledgedAt: Date.now(), ackAction: "resolved" },
    { schema: "ego-watch-exit/v1", wakeId: uuid, issuedAt: Date.now(), exitCode: 2, acknowledgedAt: "yesterday", ackAction: "investigated" },
    { schema: "ego-watch-exit/v1", wakeId: uuid, issuedAt: Date.now(), exitCode: 2, acknowledgedAt: null, ackAction: "investigated" },
    { schema: "ego-watch-exit/v1", wakeId: uuid, issuedAt: Date.now(), exitCode: 2, acknowledgedAt: Date.now(), ackAction: null },
    { schema: "ego-watch-exit/v1", wakeId: uuid, issuedAt: "x", exitCode: 2, acknowledgedAt: null, ackAction: null },
    { schema: "ego-watch-exit/v1", wakeId: "short", issuedAt: Date.now(), exitCode: 2, acknowledgedAt: null, ackAction: null },
    { schema: "ego-watch-exit/v2", wakeId: uuid, issuedAt: Date.now(), exitCode: 2, acknowledgedAt: null, ackAction: null },
    { schema: "ego-watch-exit/v1", wakeId: uuid, issuedAt: Date.now(), exitCode: 0, acknowledgedAt: null, ackAction: null },
  ];
  for (const [index, marker] of markerCases.entries()) {
    assert.equal(watchExitStructureError(marker), wakeContextWatchExitStructureError(marker),
      "marker case " + index);
  }
  const supervisionCases = [
    undefined, null, 42, "x", [],
    {},
    { schema: "ego-supervision/v1" },
    { schema: "ego-supervision/v1", abnormalRounds: 0, progressAt: 0, lastReviewAt: 0 },
    { schema: "ego-supervision/v1", abnormalRounds: 0, progressAt: 0, lastReviewAt: 0, pending: null },
    { schema: "ego-supervision/v1", abnormalRounds: 0, progressAt: 0, lastReviewAt: 0, pending: { id: "w1", issuedAt: 5, reason: "X" } },
    { schema: "ego-supervision/v1", abnormalRounds: 0, progressAt: 0, lastReviewAt: 0, pending: {} },
    { schema: "ego-supervision/v1", abnormalRounds: 0, progressAt: 0, lastReviewAt: 0, pending: { id: "", issuedAt: 5 } },
    { schema: "ego-supervision/v1", abnormalRounds: 0, progressAt: 0, lastReviewAt: 0, pending: { id: "w1" } },
    { schema: "ego-supervision/v1", abnormalRounds: -1, progressAt: 0, lastReviewAt: 0, pending: null },
    { schema: "ego-supervision/v1", abnormalRounds: 0, progressAt: "x", lastReviewAt: 0, pending: null },
    { schema: "ego-supervision/v2", abnormalRounds: 0, progressAt: 0, lastReviewAt: 0, pending: null },
    { schema: "ego-supervision/v1", abnormalRounds: 0, progressAt: 0, lastReviewAt: 0, pending: 7 },
  ];
  for (const [index, status] of supervisionCases.entries()) {
    assert.equal(supervisionStatusStructureError(status), wakeContextSupervisionStructureError(status),
      "supervision case " + index);
  }
});

test("#27 B3 arm-before-delivery ordering is pinned in main(): send/send-new arm before the delivery template runs, recover-draft never arms", async () => {
  const source = await readFile(
    fileURLToPath(new URL("../monitor/dispatch-manager.mjs", import.meta.url)), "utf8");
  const armIdx = source.indexOf("await armForDispatch(dir, { conversationUuid: p.conversation, space: p.space });");
  const runEgoIdx = source.indexOf("const observation = await runEgo(adaptTemplate(template, p), dir, p.action);");
  assert.ok(armIdx > 0, "main() arms the dispatch");
  assert.ok(runEgoIdx > armIdx, "the arm write must precede the delivery template run");
  // The arm guard lists exactly send/send-new (recover-draft is a draft-
  // cleanup action and must not write an armed claim).
  const guardStart = source.lastIndexOf("if ([", armIdx);
  const guardLine = source.slice(guardStart, source.indexOf(")", guardStart) + 2);
  assert.equal(guardLine, 'if (["send", "send-new"].includes(p.action))');
  assert.match(source, /\["send", "send-new", "recover-draft"\]\.includes\(p\.action\)/);
});

// ---- Requirement 2 (ruling §四.2): the disarm criteria ----

test("#27 B3 disarm criteria: each blocker fires alone and the happy path is eligible", () => {
  const base = { armedReason: "PEER_GENERATING", dispatchStatus: "COMPLETED", replyConsumed: true };
  assert.deepEqual(evaluateDisarmEligibility(base), { eligible: true, blockers: [] });
  const expect = (patch, blocker) => {
    const verdict = evaluateDisarmEligibility({ ...base, ...patch });
    assert.equal(verdict.eligible, false);
    assert.deepEqual(verdict.blockers, [blocker]);
  };
  expect({ armedReason: null }, "ARM_STATE_LEGACY_NO_DISARM_INFERENCE");
  expect({ armedReason: "DISARMED_IDLE" }, "ARM_STATE_ALREADY_DISARMED");
  expect({ dispatchStatus: "ACCEPTED" }, "DISPATCH_NOT_TERMINAL:ACCEPTED");
  expect({ dispatchStatus: null }, "DISPATCH_NOT_TERMINAL:ABSENT");
  expect({ dispatchStatus: "RELEASED" }, "DISPATCH_NOT_TERMINAL:RELEASED");
  expect({ replyConsumed: false }, "REPLY_NOT_CONSUMED");
  expect({ unackedWakes: 1 }, "WAKE_MARKER_UNACKNOWLEDGED");
  expect({ supervisionPending: true }, "SUPERVISION_HANDOFF_PENDING");
  expect({ otherInFlight: 1 }, "OTHER_INFLIGHT_DISPATCH");
  // ABORTED dispatches have no reply to consume.
  assert.deepEqual(
    evaluateDisarmEligibility({ armedReason: "DISPATCH_ACCEPTED", dispatchStatus: "ABORTED", replyConsumed: false }),
    { eligible: true, blockers: [] });
});

async function completedConsumed(dir, record = dispatchRecord()) {
  await writeFile(join(dir, "a-dispatch-state.json"), JSON.stringify(record));
  const receipt = await saveReply(dir, record, { text: "已消费回复", source: "DOM_BOUNDARY_VISIBLE" }, uuid);
  await acknowledgeReply(dir, record, receipt.sha256);
  return record;
}

// P1-C round 3: companion release-success credential (a-disarm-credential.json)
// helpers for the retry-gate tests.
const disarmCredential = (dispatchId = uuid) =>
  ({ schema: "ego-disarm-credential/v1", dispatchId, issuedAt: Date.now() });

async function writeDisarmCredential(dir, credential) {
  await writeFile(join(dir, "a-disarm-credential.json"),
    typeof credential === "string" ? credential : JSON.stringify(credential), "utf8");
}

test("#27 B3 disarmAfterRelease: satisfied criteria write DISARMED_IDLE after terminal confirmation (ruling order)", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-disarm-ok-"));
  try {
    const dir = await makeConversation(root, { "a-fast-state.json": armedState("PEER_GENERATING") });
    await completedConsumed(dir);
    const result = await disarmAfterRelease(dir, { rootMonitorDir: root, expectedDispatchId: uuid });
    assert.deepEqual(result, { disarmed: true, alreadyDisarmed: false, blockers: [] });
    const state = JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8"));
    assert.equal(state.armedReason, "DISARMED_IDLE");
    assert.equal(validateFastState(state), true);
    const events = await readFile(join(dir, "a-fast-events.ndjson"), "utf8");
    assert.match(events, /DISARMED_IDLE/);
    // Idempotent: a repeat reports success without touching the state.
    const again = await disarmAfterRelease(dir, { rootMonitorDir: root, expectedDispatchId: uuid });
    assert.deepEqual(again, { disarmed: true, alreadyDisarmed: true, blockers: [] });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#27 B3 disarmAfterRelease: every unmet criterion blocks and leaves the armed state untouched", async () => {
  const caseOf = async (name, mutate, expectBlocker) => {
    const root = await mkdtemp(join(tmpdir(), "ego-disarm-block-"));
    try {
      const dir = await makeConversation(root, { "a-fast-state.json": armedState("DISPATCH_ACCEPTED") });
      await mutate(dir, root);
      const result = await disarmAfterRelease(dir, { rootMonitorDir: root, expectedDispatchId: uuid });
      assert.equal(result.disarmed, false, name);
      assert.ok(result.blockers.includes(expectBlocker), name + " -> " + JSON.stringify(result.blockers));
      const rawState = await readFile(join(dir, "a-fast-state.json"), "utf8");
      if (name === "corrupt arm state") {
        // A corrupt state must survive a refused disarm byte-for-byte.
        assert.equal(rawState, "{corrupted");
      } else {
        assert.equal(JSON.parse(rawState).armedReason, "DISPATCH_ACCEPTED", name);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  };
  // Dispatch not terminal (no in-flight confirmation).
  await caseOf("in-flight dispatch", async (dir) => {
    await writeFile(join(dir, "a-dispatch-state.json"),
      JSON.stringify(dispatchRecord({ status: "ACCEPTED" })));
  }, "DISPATCH_NOT_TERMINAL:ACCEPTED");
  // No dispatch ledger at all: never a vacuous disarm.
  await caseOf("missing ledger", async () => {}, "DISPATCH_LEDGER_ABSENT");
  // Reply awaiting collection.
  await caseOf("reply unconsumed", async (dir) => {
    const record = dispatchRecord();
    await writeFile(join(dir, "a-dispatch-state.json"), JSON.stringify(record));
    await saveReply(dir, record, { text: "未消费", source: "DOM_BOUNDARY_VISIBLE" }, uuid);
  }, "REPLY_NOT_CONSUMED");
  // Unprocessed wake marker.
  await caseOf("unacked wake marker", async (dir) => {
    await completedConsumed(dir);
    await writeFile(join(dir, "a-watch-exit.json"), JSON.stringify({
      schema: "ego-watch-exit/v1", wakeId: otherUuid, reason: "FAST_PROBE_WAKE_SUPERVISOR",
      issuedAt: Date.now(), exitCode: 2, acknowledgedAt: null, ackAction: null,
    }));
  }, "WAKE_MARKER_UNACKNOWLEDGED");
  // Unfinished supervision handoff.
  await caseOf("supervision pending", async (dir) => {
    await completedConsumed(dir);
    await writeFile(join(dir, "a-supervision-status.json"), JSON.stringify({
      schema: "ego-supervision/v1", progressAt: 0, abnormalRounds: 0, lastReviewAt: 0,
      pending: { id: otherUuid, reason: "NO_SUBSTANTIVE_PROGRESS", issuedAt: Date.now() },
    }));
  }, "SUPERVISION_HANDOFF_PENDING");
  // Another dispatch of the same monitor root still in flight.
  await caseOf("sibling in flight", async (dir, root) => {
    await completedConsumed(dir);
    const sibling = join(root, "conversations", otherUuid);
    await mkdir(sibling, { recursive: true });
    await writeFile(join(sibling, "a-dispatch-state.json"),
      JSON.stringify(dispatchRecord({ dispatchId: otherUuid, conversationUuid: otherUuid, status: "ACCEPTED" })));
  }, "OTHER_INFLIGHT_DISPATCH");
  // A sibling ledger that cannot be proven terminal counts as in-flight (P1-4 default).
  await caseOf("sibling ledger unproven", async (dir, root) => {
    await completedConsumed(dir);
    const sibling = join(root, "conversations", otherUuid);
    await mkdir(sibling, { recursive: true });
    await writeFile(join(sibling, "a-dispatch-state.json"), JSON.stringify({ status: "COMPLETED" }));
  }, "OTHER_INFLIGHT_DISPATCH");
  // Corrupt fast state is unconfirmable.
  await caseOf("corrupt arm state", async (dir) => {
    await completedConsumed(dir);
    await writeFile(join(dir, "a-fast-state.json"), "{corrupted");
  }, "ARM_STATE_UNREADABLE");
});

test("#27 B3 P1-B: a supervision ledger that is only parseable ({}) blocks the disarm", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-disarm-superv-empty-"));
  try {
    const dir = await makeConversation(root, { "a-fast-state.json": armedState("DISPATCH_ACCEPTED") });
    await completedConsumed(dir);
    // The pre-fix code read Boolean(status?.pending) — a bare {} parsed fine
    // and read as "no pending". The mirrored ego-supervision/v1 contract
    // rejects it as corruption.
    await writeFile(join(dir, "a-supervision-status.json"), "{}");
    const result = await disarmAfterRelease(dir, { rootMonitorDir: root, expectedDispatchId: uuid });
    assert.equal(result.disarmed, false);
    assert.ok(result.blockers.includes("SUPERVISION_STATUS_INVALID"),
      JSON.stringify(result.blockers));
    assert.equal(JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8")).armedReason, "DISPATCH_ACCEPTED");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#27 B3 P1-B: an illegal acknowledgedAt string is corruption, never a proof of acknowledgement", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-disarm-ack-invalid-"));
  try {
    const dir = await makeConversation(root, { "a-fast-state.json": armedState("DISPATCH_ACCEPTED") });
    await completedConsumed(dir);
    await writeFile(join(dir, "a-watch-exit.json"), JSON.stringify({
      schema: "ego-watch-exit/v1", wakeId: otherUuid, reason: "FAST_PROBE_WAKE_SUPERVISOR",
      issuedAt: Date.now(), exitCode: 2, acknowledgedAt: "yesterday", ackAction: "investigated",
    }));
    const result = await disarmAfterRelease(dir, { rootMonitorDir: root, expectedDispatchId: uuid });
    assert.equal(result.disarmed, false);
    assert.ok(result.blockers.includes("WAKE_MARKER_INVALID"),
      JSON.stringify(result.blockers));
    // A legally acked marker keeps the disarm path open (acked: finite ts + legal action).
    await writeFile(join(dir, "a-watch-exit.json"), JSON.stringify({
      schema: "ego-watch-exit/v1", wakeId: otherUuid, reason: "FAST_PROBE_WAKE_SUPERVISOR",
      issuedAt: Date.now(), exitCode: 2, acknowledgedAt: Date.now(), ackAction: "resolved",
    }));
    const ok = await disarmAfterRelease(dir, { rootMonitorDir: root, expectedDispatchId: uuid });
    assert.deepEqual(ok, { disarmed: true, alreadyDisarmed: false, blockers: [] });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#27 B3 P1-B: the already-disarmed idempotent success is re-validated on fresh evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-disarm-idempotent-"));
  try {
    const dir = await makeConversation(root, { "a-fast-state.json": armedState("DISARMED_IDLE") });
    await completedConsumed(dir);
    // Clean evidence: the idempotent success survives re-validation.
    const ok = await disarmAfterRelease(dir, { rootMonitorDir: root, expectedDispatchId: uuid });
    assert.deepEqual(ok, { disarmed: true, alreadyDisarmed: true, blockers: [] });
    assert.equal(JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8")).armedReason, "DISARMED_IDLE");
    // Conflict 1: a new dispatch re-opened the ledger (the forbidden window) —
    // the pre-fix code returned success before ever looking at the ledger.
    await writeFile(join(dir, "a-dispatch-state.json"),
      JSON.stringify(dispatchRecord({ status: "ACCEPTED" })));
    const conflict = await disarmAfterRelease(dir, { rootMonitorDir: root, expectedDispatchId: uuid });
    assert.equal(conflict.disarmed, false);
    assert.ok(conflict.blockers.includes("DISPATCH_NOT_TERMINAL:ACCEPTED"),
      JSON.stringify(conflict.blockers));
    // Conflict 2: a fresh un-acked wake marker appears after the disarm.
    await writeFile(join(dir, "a-dispatch-state.json"), JSON.stringify(dispatchRecord()));
    await writeFile(join(dir, "a-watch-exit.json"), JSON.stringify({
      schema: "ego-watch-exit/v1", wakeId: otherUuid, reason: "FAST_PROBE_WAKE_SUPERVISOR",
      issuedAt: Date.now(), exitCode: 2, acknowledgedAt: null, ackAction: null,
    }));
    const staled = await disarmAfterRelease(dir, { rootMonitorDir: root, expectedDispatchId: uuid });
    assert.equal(staled.disarmed, false);
    assert.ok(staled.blockers.includes("WAKE_MARKER_UNACKNOWLEDGED"),
      JSON.stringify(staled.blockers));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#27 B3 P1-B: the sibling scan covers pending-new — an in-flight new-session request blocks the disarm", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-disarm-pending-new-"));
  try {
    const dir = await makeConversation(root, { "a-fast-state.json": armedState("DISPATCH_ACCEPTED") });
    await completedConsumed(dir);
    const pendingDir = join(root, "pending-new", otherUuid);
    await mkdir(pendingDir, { recursive: true });
    // A pending-new ledger with an in-flight status is an in-flight dispatch.
    await writeFile(join(pendingDir, "a-dispatch-state.json"),
      JSON.stringify(dispatchRecord({ dispatchId: otherUuid, conversationUuid: otherUuid, status: "ACCEPTED" })));
    const blocked = await disarmAfterRelease(dir, { rootMonitorDir: root, expectedDispatchId: uuid });
    assert.equal(blocked.disarmed, false);
    assert.ok(blocked.blockers.includes("OTHER_INFLIGHT_DISPATCH"),
      JSON.stringify(blocked.blockers));
    // The durable request directory itself is already in-flight evidence: a
    // pending-new conversation WITHOUT a ledger still blocks (the allocation
    // was never reconciled into conversations/).
    await rm(join(pendingDir, "a-dispatch-state.json"));
    const noLedger = await disarmAfterRelease(dir, { rootMonitorDir: root, expectedDispatchId: uuid });
    assert.equal(noLedger.disarmed, false);
    assert.ok(noLedger.blockers.includes("OTHER_INFLIGHT_DISPATCH"),
      JSON.stringify(noLedger.blockers));
    // An empty pending-new root is the benign state and never blocks.
    await rm(pendingDir, { recursive: true, force: true });
    const clean = await disarmAfterRelease(dir, { rootMonitorDir: root, expectedDispatchId: uuid });
    assert.deepEqual(clean, { disarmed: true, alreadyDisarmed: false, blockers: [] });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#27 B3 disarmAfterRelease: legacy arm fields are never auto-disarmed; ARMED_UNKNOWN may disarm on explicit confirmation", async () => {
  // Legacy ledger (no arm fields): refuses even with everything else satisfied.
  const legacyRoot = await mkdtemp(join(tmpdir(), "ego-disarm-legacy-"));
  try {
    const dir = await makeConversation(legacyRoot, {
      "a-fast-state.json": JSON.stringify({ schema: "ego-fast-state/v3", ts: 5 }),
    });
    await completedConsumed(dir);
    const result = await disarmAfterRelease(dir, { rootMonitorDir: legacyRoot, expectedDispatchId: uuid });
    assert.equal(result.disarmed, false);
    assert.deepEqual(result.blockers, ["ARM_STATE_LEGACY_NO_DISARM_INFERENCE"]);
    // The legacy v3 ledger is untouched: still schema v3, still no arm field.
    const state = JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8"));
    assert.equal(state.schema, "ego-fast-state/v3");
    assert.equal("armedReason" in state, false);
  } finally { await rm(legacyRoot, { recursive: true, force: true }); }
  // ARMED_UNKNOWN is the fail-closed catch-all, and an explicit confirmation
  // (all criteria proved on the durable ledgers) may recover it to idle.
  const unknownRoot = await mkdtemp(join(tmpdir(), "ego-disarm-unknown-"));
  try {
    const dir = await makeConversation(unknownRoot, { "a-fast-state.json": armedState("ARMED_UNKNOWN") });
    await completedConsumed(dir);
    const result = await disarmAfterRelease(dir, { rootMonitorDir: unknownRoot, expectedDispatchId: uuid });
    assert.equal(result.disarmed, true);
    const state = JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8"));
    assert.equal(state.armedReason, "DISARMED_IDLE");
  } finally { await rm(unknownRoot, { recursive: true, force: true }); }
});

test("#27 B3 releaseDelivered: the watch path disarms only after a verified release and keeps armed on a pending release", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-release-disarm-"));
  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  try {
    const dir = await makeConversation(root, { "a-fast-state.json": armedState("DISPATCH_ACCEPTED") });
    await completedConsumed(dir);
    const params = { conversation: uuid, space: "GDC-执行A", agentId: "gdc-a", monitorDir: root, rootMonitorDir: root };
    console.log = (line) => logs.push(String(line));
    console.error = (line) => logs.push(String(line));
    // Release failure: the release stays pending, the arm state stays armed.
    const pending = await releaseDelivered(params, dir, {
      runScript: async () => ({ code: 1, result: "SPACE_RELEASE_ACCOUNT_UNPROVEN" }),
    });
    assert.equal(pending, 2);
    assert.equal(JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8")).armedReason, "DISPATCH_ACCEPTED");
    // Ack the REPLY_DELIVERED_RELEASE_PENDING marker, then a verified release
    // completes: disarm is written, then the watch stops (return 0).
    const marker = JSON.parse(await readFile(join(dir, "a-watch-exit.json"), "utf8"));
    await writeFile(join(dir, "a-watch-exit.json"), JSON.stringify(
      { ...marker, acknowledgedAt: Date.now(), ackAction: "investigated" }));
    logs.length = 0;
    const clean = await releaseDelivered(params, dir, {
      runScript: async () => ({ code: 0, result: "AGENT_SPACE_RELEASED" }),
    });
    assert.equal(clean, 0);
    assert.ok(logs.some((line) => line === "RESULT=DISPATCH_FINISHED_AND_RELEASED"));
    assert.equal(JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8")).armedReason, "DISARMED_IDLE");
  } finally {
    console.log = originalLog;
    console.error = originalError;
    await rm(root, { recursive: true, force: true });
  }
});

test("#27 B3 P1-C: a deferred disarm exits the watch through the durable DISARM_DEFERRED_WAKE_SUPERVISOR ledger, never a silent success", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-disarm-deferred-"));
  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  try {
    const dir = await makeConversation(root, { "a-fast-state.json": armedState("DISPATCH_ACCEPTED") });
    await completedConsumed(dir);
    // One outstanding criterion (an un-acked wake marker) defers the disarm.
    await writeFile(join(dir, "a-watch-exit.json"), JSON.stringify({
      schema: "ego-watch-exit/v1", wakeId: otherUuid, reason: "FAST_PROBE_WAKE_SUPERVISOR",
      issuedAt: Date.now(), exitCode: 2, acknowledgedAt: null, ackAction: null,
    }));
    const params = { conversation: uuid, space: "GDC-执行A", agentId: "gdc-a", monitorDir: root, rootMonitorDir: root };
    console.log = (line) => logs.push(String(line));
    console.error = (line) => logs.push(String(line));
    const code = await releaseDelivered(params, dir, {
      runScript: async () => ({ code: 0, result: "AGENT_SPACE_RELEASED" }),
    });
    // The watch does NOT exit 0 over a stranded armed ledger: it exits through
    // the durable wake ledger with a structured handoff reason.
    assert.equal(code, 2);
    assert.equal(JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8")).armedReason, "DISPATCH_ACCEPTED");
    const marker = JSON.parse(await readFile(join(dir, "a-watch-exit.json"), "utf8"));
    assert.equal(marker.schema, "ego-watch-exit/v1");
    assert.equal(marker.reason, "DISARM_DEFERRED_WAKE_SUPERVISOR");
    assert.equal(marker.exitCode, 2);
    assert.equal(marker.acknowledgedAt, null);
    assert.ok(logs.some((line) => line.startsWith("RESULT=DISARM_DEFERRED_WAKE_SUPERVISOR ") && line.includes(" wakeId=")),
      JSON.stringify(logs));
    // The managed ack of that wake is the handoff: acking clears the marker's
    // own blocker and the managed retry converges the disarm in the same call.
    const ackCode = await managedAcknowledge({
      agentId: "gdc-a", space: "GDC-执行A", conversation: uuid,
      wakeId: marker.wakeId, ackAction: "investigated", monitorDir: root,
    });
    assert.equal(ackCode, 0);
    assert.equal(JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8")).armedReason, "DISARMED_IDLE");
    const ackedMarker = JSON.parse(await readFile(join(dir, "a-watch-exit.json"), "utf8"));
    assert.notEqual(ackedMarker.acknowledgedAt, null);
    assert.ok(logs.some((line) => line === "RESULT=DISARM_RETRY_COMPLETED"), JSON.stringify(logs));
  } finally {
    console.log = originalLog;
    console.error = originalError;
    await rm(root, { recursive: true, force: true });
  }
});

test("#27 B3 P1-C rounds 2+3: the managed retry path requires a release-success credential bound to THIS dispatch and converges exactly once", async () => {
  // Ruling rewrite: the previous version of this test FIXED THE BUGGY BEHAVIOR —
  // it expected a disarm from a COMPLETED + already-consumed ledger with NO
  // release evidence at all. A retry is a convergence of a prior SUCCESSFUL
  // release only; its credential is the durable DISARM_DEFERRED_WAKE_SUPERVISOR
  // wake marker a verified release leaves when it defers the disarm.
  // Round 3: the marker alone is no longer the credential — the gate also
  // requires the companion a-disarm-credential.json naming the ledger's
  // CURRENT dispatchId.
  const root = await mkdtemp(join(tmpdir(), "ego-disarm-retry-"));
  try {
    const dir = await makeConversation(root, { "a-fast-state.json": armedState("DISPATCH_ACCEPTED") });
    await completedConsumed(dir);
    // No credential (and no marker): the retry is a no-op and the ledger stays armed.
    const unproven = await retryPendingDisarm(dir, { rootMonitorDir: root });
    assert.deepEqual(unproven, { disarmed: false, alreadyDisarmed: false, blockers: ["RELEASE_SUCCESS_UNPROVEN"] });
    assert.equal(JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8")).armedReason, "DISPATCH_ACCEPTED");
    // A DISARM_DEFERRED marker without its companion credential (round-2 shape
    // alone, e.g. the credential write failed or was cleared) is unproven.
    await writeFile(join(dir, "a-watch-exit.json"), JSON.stringify({
      schema: "ego-watch-exit/v1", wakeId: otherUuid, reason: "DISARM_DEFERRED_WAKE_SUPERVISOR",
      issuedAt: Date.now(), exitCode: 2, acknowledgedAt: null, ackAction: null,
    }));
    const markerOnly = await retryPendingDisarm(dir, { rootMonitorDir: root });
    assert.deepEqual(markerOnly, { disarmed: false, alreadyDisarmed: false, blockers: ["RELEASE_SUCCESS_UNPROVEN"] });
    // The full credential SHAPE (marker + companion file) with its own wake
    // still unacked: blocked (fail-closed) by the wake criterion itself until
    // the supervisor acks.
    await writeDisarmCredential(dir, disarmCredential());
    const unacked = await retryPendingDisarm(dir, { rootMonitorDir: root });
    assert.equal(unacked.disarmed, false);
    assert.ok(unacked.blockers.includes("WAKE_MARKER_UNACKNOWLEDGED"), JSON.stringify(unacked.blockers));
    // Acked credential (the real post-ack state of the deferred wake): the retry
    // converges the disarm exactly once.
    await writeFile(join(dir, "a-watch-exit.json"), JSON.stringify({
      schema: "ego-watch-exit/v1", wakeId: otherUuid, reason: "DISARM_DEFERRED_WAKE_SUPERVISOR",
      issuedAt: Date.now(), exitCode: 2, acknowledgedAt: Date.now(), ackAction: "investigated",
    }));
    const first = await retryPendingDisarm(dir, { rootMonitorDir: root });
    assert.deepEqual(first, { disarmed: true, alreadyDisarmed: false, blockers: [] });
    assert.equal(JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8")).armedReason, "DISARMED_IDLE");
    // Repeated retries are idempotent — no rewrite, exactly one DISARMED_IDLE event.
    const again = await retryPendingDisarm(dir, { rootMonitorDir: root });
    assert.deepEqual(again, { disarmed: true, alreadyDisarmed: true, blockers: [] });
    const events = (await readFile(join(dir, "a-fast-events.ndjson"), "utf8")).trim().split("\n");
    assert.equal(events.filter((line) => line.includes("DISARMED_IDLE")).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
  // Gate component checks (round 3, still on the armed-conversation shape):
  // a companion credential that fails any ownership criterion keeps the ledger
  // armed, and a later failed release overwriting the marker invalidates the
  // pair even though the credential file itself is still on disk.
  const gateRoot = await mkdtemp(join(tmpdir(), "ego-disarm-retry-gate-"));
  try {
    const dir = await makeConversation(gateRoot, { "a-fast-state.json": armedState("DISPATCH_ACCEPTED") });
    await completedConsumed(dir);
    await writeFile(join(dir, "a-watch-exit.json"), JSON.stringify({
      schema: "ego-watch-exit/v1", wakeId: otherUuid, reason: "DISARM_DEFERRED_WAKE_SUPERVISOR",
      issuedAt: Date.now(), exitCode: 2, acknowledgedAt: Date.now(), ackAction: "investigated",
    }));
    // Foreign dispatchId in the credential: the ledger's current dispatch
    // instance is never proven -> RELEASE_SUCCESS_UNPROVEN.
    await writeDisarmCredential(dir, disarmCredential(otherUuid));
    const foreign = await retryPendingDisarm(dir, { rootMonitorDir: gateRoot });
    assert.deepEqual(foreign, { disarmed: false, alreadyDisarmed: false, blockers: ["RELEASE_SUCCESS_UNPROVEN"] });
    // Corrupt credential bytes: unproven.
    await writeDisarmCredential(dir, "{corrupted");
    const corrupt = await retryPendingDisarm(dir, { rootMonitorDir: gateRoot });
    assert.deepEqual(corrupt, { disarmed: false, alreadyDisarmed: false, blockers: ["RELEASE_SUCCESS_UNPROVEN"] });
    // Foreign schema: unproven.
    await writeDisarmCredential(dir, { schema: "ego-disarm-credential/v2", dispatchId: uuid, issuedAt: Date.now() });
    const foreignSchema = await retryPendingDisarm(dir, { rootMonitorDir: gateRoot });
    assert.deepEqual(foreignSchema, { disarmed: false, alreadyDisarmed: false, blockers: ["RELEASE_SUCCESS_UNPROVEN"] });
    // Valid credential, but the marker no longer records a deferred disarm (a
    // later FAILED release overwrote it): the pair is invalidated -> unproven.
    await writeDisarmCredential(dir, disarmCredential());
    await writeFile(join(dir, "a-watch-exit.json"), JSON.stringify({
      schema: "ego-watch-exit/v1", wakeId: otherUuid, reason: "REPLY_DELIVERED_RELEASE_PENDING",
      issuedAt: Date.now(), exitCode: 2, acknowledgedAt: Date.now(), ackAction: "investigated",
    }));
    const overwritten = await retryPendingDisarm(dir, { rootMonitorDir: gateRoot });
    assert.deepEqual(overwritten, { disarmed: false, alreadyDisarmed: false, blockers: ["RELEASE_SUCCESS_UNPROVEN"] });
    assert.equal(JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8")).armedReason, "DISPATCH_ACCEPTED");
    // The gate never fired a disarm through any of the failing shapes above.
    await assert.rejects(readFile(join(dir, "a-fast-events.ndjson"), "utf8"), /ENOENT/);
  } finally { await rm(gateRoot, { recursive: true, force: true }); }
  // Wiring pin (unchanged): consume and the managed ack both run the retry after
  // their own managed work succeeded; both deferred-disarm exits share one reason.
  const source = await readFile(
    fileURLToPath(new URL("../monitor/dispatch-manager.mjs", import.meta.url)), "utf8");
  assert.match(source, /await acknowledgeReply\(dir, record, p\.replySha256\);[\s\S]{0,400}?await retryPendingDisarm\(dir, \{ rootMonitorDir: p\.rootMonitorDir \}\)/);
  assert.match(source, /await retryPendingDisarm\(dir, \{ rootMonitorDir: p\.monitorDir \}\);/);
  assert.match(source, /return exitWatching\(dir, "DISARM_DEFERRED_WAKE_SUPERVISOR"/g);
});

test("#27 B3 P1-C round 2: production incident sequence — a release FAILURE followed by ack/consume never converges the disarm", async () => {
  // The exact production sequence from the ruling: dispatch COMPLETED + reply
  // consumed -> release FAILED (SPACE_HAS_UNREGISTERED_PAGE_STOP) ->
  // REPLY_DELIVERED_RELEASE_PENDING -> supervisor ack -> the old un-gated retry
  // wrote DISARMED_IDLE while the page was still open. The gated retry must
  // keep the ledger armed through the whole sequence.
  const root = await mkdtemp(join(tmpdir(), "ego-disarm-incident-"));
  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  try {
    const dir = await makeConversation(root, { "a-fast-state.json": armedState("DISPATCH_ACCEPTED") });
    await completedConsumed(dir);
    const params = { conversation: uuid, space: "GDC-执行A", agentId: "gdc-a", monitorDir: root, rootMonitorDir: root };
    console.log = (line) => logs.push(String(line));
    console.error = (line) => logs.push(String(line));
    // Release fails through the real watch path: the durable wake marker
    // records the failure, the arm state stays armed.
    const code = await releaseDelivered(params, dir, {
      runScript: async () => ({ code: 1, result: "SPACE_HAS_UNREGISTERED_PAGE_STOP" }),
    });
    assert.equal(code, 2);
    assert.equal(JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8")).armedReason, "DISPATCH_ACCEPTED");
    const marker = JSON.parse(await readFile(join(dir, "a-watch-exit.json"), "utf8"));
    assert.equal(marker.reason, "REPLY_DELIVERED_RELEASE_PENDING");
    // consume-style touch after the failed release: no credential -> no disarm.
    const consumed = await retryPendingDisarm(dir, { rootMonitorDir: root });
    assert.deepEqual(consumed, { disarmed: false, alreadyDisarmed: false, blockers: ["RELEASE_SUCCESS_UNPROVEN"] });
    // The supervisor acks the release-pending wake: the managed retry runs…
    const ackCode = await managedAcknowledge({
      agentId: "gdc-a", space: "GDC-执行A", conversation: uuid,
      wakeId: marker.wakeId, ackAction: "investigated", monitorDir: root,
    });
    assert.equal(ackCode, 0);
    // …and STILL must not converge the disarm: the page was never released.
    assert.equal(JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8")).armedReason, "DISPATCH_ACCEPTED");
    // No disarm event was ever written (the events file may not even exist —
    // no step in this sequence legitimately appends one).
    const incidentEvents = await readFile(join(dir, "a-fast-events.ndjson"), "utf8").catch(
      (error) => (error.code === "ENOENT" ? "" : Promise.reject(error)));
    assert.equal(incidentEvents.includes("DISARMED_IDLE"), false);
    // A repeated ack of the same wake fails closed and touches nothing.
    await assert.rejects(managedAcknowledge({
      agentId: "gdc-a", space: "GDC-执行A", conversation: uuid,
      wakeId: marker.wakeId, ackAction: "investigated", monitorDir: root,
    }), /WAKE_ID_ALREADY_ACKNOWLEDGED/);
    assert.equal(JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8")).armedReason, "DISPATCH_ACCEPTED");
  } finally {
    console.log = originalLog;
    console.error = originalError;
    await rm(root, { recursive: true, force: true });
  }
});

test("#27 B3 P1-C round 2: consume-before-release keeps the ledger armed — no successful release has happened yet", async () => {
  // The normal managed order is collect -> consume -> release. At consume time
  // no release has succeeded, so the consume-triggered retry must be a no-op
  // even though the ledger is terminal and the reply is consumed.
  const root = await mkdtemp(join(tmpdir(), "ego-disarm-consume-first-"));
  try {
    const dir = await makeConversation(root, { "a-fast-state.json": armedState("DISPATCH_ACCEPTED") });
    await completedConsumed(dir);
    // The realistic durable trace at this point: the watch woke the supervisor
    // with REPLY_READY_WAKE_SUPERVISOR (unacked) when the probe saw the reply.
    await writeFile(join(dir, "a-watch-exit.json"), JSON.stringify({
      schema: "ego-watch-exit/v1", wakeId: otherUuid, reason: "REPLY_READY_WAKE_SUPERVISOR",
      issuedAt: Date.now(), exitCode: 2, acknowledgedAt: null, ackAction: null,
    }));
    const result = await retryPendingDisarm(dir, { rootMonitorDir: root });
    assert.deepEqual(result, { disarmed: false, alreadyDisarmed: false, blockers: ["RELEASE_SUCCESS_UNPROVEN"] });
    assert.equal(JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8")).armedReason, "DISPATCH_ACCEPTED");
    // Same verdict on a conversation with no watch-exit marker at all — a
    // normal reply wake or a bare consume never carries a release credential.
    await rm(join(dir, "a-watch-exit.json"));
    const bare = await retryPendingDisarm(dir, { rootMonitorDir: root });
    assert.deepEqual(bare, { disarmed: false, alreadyDisarmed: false, blockers: ["RELEASE_SUCCESS_UNPROVEN"] });
    assert.equal(JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8")).armedReason, "DISPATCH_ACCEPTED");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#27 B3 P1-C round 3 (ruling scenario): a surviving stale deferred marker can never authorize a NEW dispatch's disarm", async () => {
  // The exact attack path from the round-3 ruling: old dispatch released
  // successfully with a deferred disarm (sibling in flight) -> supervisor acked
  // and the credential survived -> the SAME fixed conversation page started a
  // NEW dispatch -> the new dispatch's REPLY_READY marker write FAILED (we
  // reproduce the post-failure durable state exactly: exitWatching swallows
  // write errors, so the old acked DISARM_DEFERRED marker simply survives on
  // disk) -> the new dispatch completed and consumed its reply. The retry must
  // stay armed until the NEW dispatch itself releases successfully.
  const root = await mkdtemp(join(tmpdir(), "ego-disarm-cross-"));
  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  try {
    const dir = await makeConversation(root, { "a-fast-state.json": armedState("DISPATCH_ACCEPTED") });
    const oldRecord = await completedConsumed(dir);
    // Sibling dispatch in flight -> the old dispatch's disarm defers.
    const sibling = join(root, "conversations", otherUuid);
    await mkdir(sibling, { recursive: true });
    await writeFile(join(sibling, "a-dispatch-state.json"),
      JSON.stringify(dispatchRecord({ dispatchId: otherUuid, conversationUuid: otherUuid, status: "ACCEPTED" })));
    const params = { conversation: uuid, space: "GDC-执行A", agentId: "gdc-a", monitorDir: root, rootMonitorDir: root };
    console.log = (line) => logs.push(String(line));
    console.error = (line) => logs.push(String(line));
    const deferred = await releaseDelivered(params, dir, {
      runScript: async () => ({ code: 0, result: "AGENT_SPACE_RELEASED" }),
    });
    assert.equal(deferred, 2);
    // The deferred handoff issued the companion credential for the OLD dispatch.
    const oldCredential = JSON.parse(await readFile(join(dir, "a-disarm-credential.json"), "utf8"));
    assert.equal(oldCredential.schema, "ego-disarm-credential/v1");
    assert.equal(oldCredential.dispatchId, oldRecord.dispatchId);
    // Supervisor acks the deferred wake; the sibling still blocks the retry,
    // so the ledger stays armed and the credential is retained.
    let marker = JSON.parse(await readFile(join(dir, "a-watch-exit.json"), "utf8"));
    assert.equal(marker.reason, "DISARM_DEFERRED_WAKE_SUPERVISOR");
    const ackCode = await managedAcknowledge({
      agentId: "gdc-a", space: "GDC-执行A", conversation: uuid,
      wakeId: marker.wakeId, ackAction: "investigated", monitorDir: root,
    });
    assert.equal(ackCode, 0);
    assert.equal(JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8")).armedReason, "DISPATCH_ACCEPTED");
    assert.equal((await readFile(join(dir, "a-disarm-credential.json"), "utf8")).length > 0, true);
    // The sibling finishes. Instead of a retry, the SAME fixed conversation
    // page now starts a NEW dispatch: arming must clear the stale credential.
    await rm(sibling, { recursive: true, force: true });
    await armForDispatch(dir, { conversationUuid: uuid, space: "GDC-执行A" });
    assert.equal(await readFile(join(dir, "a-disarm-credential.json"), "utf8")
      .then(() => true, (error) => error.code === "ENOENT" ? false : Promise.reject(error)), false);
    // The new dispatch replaces the ledger (same conversation, new instance).
    // Realistic order: the reply is staged while the new dispatch is ACCEPTED
    // (this archives the old dispatch's consumed reply), then the ledger
    // completes and the reply is consumed.
    const acceptedRecord = dispatchRecord({ dispatchId: otherUuid, status: "ACCEPTED" });
    await writeFile(join(dir, "a-dispatch-state.json"), JSON.stringify(acceptedRecord));
    const newReceipt = await saveReply(dir, acceptedRecord, { text: "已消费回复", source: "DOM_BOUNDARY_VISIBLE" }, uuid);
    const newRecord = { ...acceptedRecord, status: "COMPLETED" };
    await writeFile(join(dir, "a-dispatch-state.json"), JSON.stringify(newRecord));
    await acknowledgeReply(dir, newRecord, newReceipt.sha256);
    assert.notEqual(newRecord.dispatchId, oldRecord.dispatchId);
    // The new watch marker write fails: the OLD acked DISARM_DEFERRED marker
    // survives on disk (durable state identical to a swallowed write error).
    marker = JSON.parse(await readFile(join(dir, "a-watch-exit.json"), "utf8"));
    assert.equal(marker.reason, "DISARM_DEFERRED_WAKE_SUPERVISOR");
    assert.notEqual(marker.acknowledgedAt, null);
    // The retry against the stale marker must NOT disarm the new dispatch.
    const stale = await retryPendingDisarm(dir, { rootMonitorDir: root });
    assert.deepEqual(stale, { disarmed: false, alreadyDisarmed: false, blockers: ["RELEASE_SUCCESS_UNPROVEN"] });
    assert.equal(JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8")).armedReason, "DISPATCH_ACCEPTED");
    // Even a FORGED/leftover credential naming the OLD dispatchId cannot
    // bridge the instance gap (dispatchId mismatch -> stays armed).
    await writeDisarmCredential(dir, disarmCredential(oldRecord.dispatchId));
    const mismatch = await retryPendingDisarm(dir, { rootMonitorDir: root });
    assert.deepEqual(mismatch, { disarmed: false, alreadyDisarmed: false, blockers: ["RELEASE_SUCCESS_UNPROVEN"] });
    // A corrupt credential is equally unproven.
    await writeDisarmCredential(dir, "{corrupted");
    const corrupt = await retryPendingDisarm(dir, { rootMonitorDir: root });
    assert.deepEqual(corrupt, { disarmed: false, alreadyDisarmed: false, blockers: ["RELEASE_SUCCESS_UNPROVEN"] });
    // No DISARMED_IDLE was ever written for the unreleased new dispatch.
    const beforeRelease = (await readFile(join(dir, "a-fast-events.ndjson"), "utf8")).trim().split("\n")
      .filter((line) => line.includes("DISARMED_IDLE"));
    assert.equal(beforeRelease.length, 0);
    // Only the NEW dispatch's own verified release converges the disarm.
    logs.length = 0;
    const released = await releaseDelivered(params, dir, {
      runScript: async () => ({ code: 0, result: "AGENT_SPACE_RELEASED" }),
    });
    assert.equal(released, 0);
    assert.ok(logs.some((line) => line === "RESULT=DISPATCH_FINISHED_AND_RELEASED"));
    assert.equal(JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8")).armedReason, "DISARMED_IDLE");
    const afterRelease = (await readFile(join(dir, "a-fast-events.ndjson"), "utf8")).trim().split("\n")
      .filter((line) => line.includes("DISARMED_IDLE"));
    assert.equal(afterRelease.length, 1);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    await rm(root, { recursive: true, force: true });
  }
});

test("#27 B3 P1-C round 3: armForDispatch fails closed when a stale credential cannot be cleared", async () => {
  // Forcing (real filesystem behavior, no mocks): the credential's path is
  // occupied by a DIRECTORY, so unlink can never succeed. Arming a new
  // dispatch over a leftover credential would reopen the inheritance gap, so
  // the arm aborts before any state write.
  const root = await mkdtemp(join(tmpdir(), "ego-arm-credential-clear-"));
  try {
    const dir = await makeConversation(root);
    await mkdir(join(dir, "a-disarm-credential.json"), { recursive: true });
    await assert.rejects(
      armForDispatch(dir, { conversationUuid: uuid, space: "GDC-执行A" }),
      /ARM_DISARM_CREDENTIAL_CLEAR_FAILED/);
    // Nothing was armed: no fast state was written and no arm event exists.
    await assert.rejects(readFile(join(dir, "a-fast-state.json"), "utf8"), /ENOENT/);
    await assert.rejects(readFile(join(dir, "a-fast-events.ndjson"), "utf8"), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// ---- P1-C round 4 (planner ruling reply 2d9bdde7): credential lifecycle + identity isolation ----

test("#27 B3 P1-C round 4: a structurally incomplete credential (missing or non-finite issuedAt) is unproven — stays armed", async () => {
  // The marker side of the pair is fully valid AND acked in every step — the
  // only variable under test is the companion credential's structure. The
  // round-3 gap: a bare {schema, dispatchId} credential passed the gate.
  const root = await mkdtemp(join(tmpdir(), "ego-credential-shape-"));
  try {
    const dir = await makeConversation(root, { "a-fast-state.json": armedState("DISPATCH_ACCEPTED") });
    await completedConsumed(dir);
    await writeFile(join(dir, "a-watch-exit.json"), JSON.stringify({
      schema: "ego-watch-exit/v1", wakeId: otherUuid, reason: "DISARM_DEFERRED_WAKE_SUPERVISOR",
      issuedAt: Date.now(), exitCode: 2, acknowledgedAt: Date.now(), ackAction: "investigated",
    }));
    // Missing issuedAt (ruling gap 1): corruption, never a proof of release.
    await writeDisarmCredential(dir, { schema: "ego-disarm-credential/v1", dispatchId: uuid });
    const missing = await retryPendingDisarm(dir, { rootMonitorDir: root });
    assert.deepEqual(missing, { disarmed: false, alreadyDisarmed: false, blockers: ["RELEASE_SUCCESS_UNPROVEN"] });
    assert.equal(JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8")).armedReason, "DISPATCH_ACCEPTED");
    // Wrong type (string issuedAt): equally unproven.
    await writeDisarmCredential(dir, { schema: "ego-disarm-credential/v1", dispatchId: uuid, issuedAt: "yesterday" });
    const wrongType = await retryPendingDisarm(dir, { rootMonitorDir: root });
    assert.deepEqual(wrongType, { disarmed: false, alreadyDisarmed: false, blockers: ["RELEASE_SUCCESS_UNPROVEN"] });
    assert.equal(JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8")).armedReason, "DISPATCH_ACCEPTED");
    // A non-finite number never survives JSON (NaN/Infinity serialize to
    // null) — equally unproven.
    await writeDisarmCredential(dir, { schema: "ego-disarm-credential/v1", dispatchId: uuid, issuedAt: null });
    const nonFinite = await retryPendingDisarm(dir, { rootMonitorDir: root });
    assert.deepEqual(nonFinite, { disarmed: false, alreadyDisarmed: false, blockers: ["RELEASE_SUCCESS_UNPROVEN"] });
    assert.equal(JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8")).armedReason, "DISPATCH_ACCEPTED");
    // No disarm was ever written through the incomplete shapes.
    await assert.rejects(readFile(join(dir, "a-fast-events.ndjson"), "utf8"), /ENOENT/);
    // Positive control: the COMPLETE credential is the proof — same marker,
    // the retry converges the disarm.
    await writeDisarmCredential(dir, disarmCredential());
    const ok = await retryPendingDisarm(dir, { rootMonitorDir: root });
    assert.deepEqual(ok, { disarmed: true, alreadyDisarmed: false, blockers: [] });
    assert.equal(JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8")).armedReason, "DISARMED_IDLE");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#27 B3 P1-C round 4 (ruling scenario): a repeated release attempt clears the stale credential first — a failed retry with a surviving old marker never disarms", async () => {
  // The exact sequence from the ruling gap 3: success deferred -> ack ->
  // the SAME dispatch releases again and FAILS -> its wake marker write
  // fails too (the old acked DISARM_DEFERRED marker survives, exactly like a
  // swallowed exitWatching write error) -> a repeated consume retriggers the
  // retry. The pre-attempt credential clear breaks the stale pair, so the
  // old marker alone can never disarm. Forcing (real fs, no mocks): the
  // marker file is made read-only, so writeJsonAtomic's rename is refused
  // with EPERM and exitWatching's swallowed error leaves the old bytes.
  const root = await mkdtemp(join(tmpdir(), "ego-retry-inherit-"));
  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  try {
    const dir = await makeConversation(root, { "a-fast-state.json": armedState("DISPATCH_ACCEPTED") });
    const record = dispatchRecord();
    await writeFile(join(dir, "a-dispatch-state.json"), JSON.stringify(record));
    const receipt = await saveReply(dir, record, { text: "已消费回复", source: "DOM_BOUNDARY_VISIBLE" }, uuid);
    await acknowledgeReply(dir, record, receipt.sha256);
    // Sibling in flight -> the first successful release defers its disarm.
    const sibling = join(root, "conversations", otherUuid);
    await mkdir(sibling, { recursive: true });
    await writeFile(join(sibling, "a-dispatch-state.json"),
      JSON.stringify(dispatchRecord({ dispatchId: otherUuid, conversationUuid: otherUuid, status: "ACCEPTED" })));
    const params = { conversation: uuid, space: "GDC-执行A", agentId: "gdc-a", monitorDir: root, rootMonitorDir: root };
    console.log = (line) => logs.push(String(line));
    console.error = (line) => logs.push(String(line));
    // 1. Success deferred: credential issued for THIS dispatch, marker written.
    const first = await releaseDelivered(params, dir, {
      runScript: async () => ({ code: 0, result: "AGENT_SPACE_RELEASED" }),
    });
    assert.equal(first, 2);
    let marker = JSON.parse(await readFile(join(dir, "a-watch-exit.json"), "utf8"));
    assert.equal(marker.reason, "DISARM_DEFERRED_WAKE_SUPERVISOR");
    const credential = JSON.parse(await readFile(join(dir, "a-disarm-credential.json"), "utf8"));
    assert.equal(credential.dispatchId, record.dispatchId);
    // 2. Supervisor acks; the sibling keeps the retry blocked, credential retained.
    const ackCode = await managedAcknowledge({
      agentId: "gdc-a", space: "GDC-执行A", conversation: uuid,
      wakeId: marker.wakeId, ackAction: "investigated", monitorDir: root,
    });
    assert.equal(ackCode, 0);
    marker = JSON.parse(await readFile(join(dir, "a-watch-exit.json"), "utf8"));
    assert.notEqual(marker.acknowledgedAt, null);
    // 3. The same dispatch releases AGAIN, this attempt fails, and its marker
    //    write fails as well — the OLD acked deferred marker survives. Inside
    //    the release script the stale credential must ALREADY be gone: a
    //    release attempt never runs carrying a previous round's success.
    await chmod(join(dir, "a-watch-exit.json"), 0o444);
    let credentialGoneAtScriptTime = null;
    const second = await releaseDelivered(params, dir, {
      runScript: async () => {
        credentialGoneAtScriptTime = await readFile(join(dir, "a-disarm-credential.json"), "utf8")
          .then(() => false, (error) => error.code === "ENOENT");
        return { code: 1, result: "SPACE_RELEASE_ACCOUNT_UNPROVEN" };
      },
    });
    await chmod(join(dir, "a-watch-exit.json"), 0o666);
    assert.equal(second, 2);
    assert.equal(credentialGoneAtScriptTime, true, "the stale credential must be cleared before the release attempt runs");
    // The pre-attempt clear (not the release failure) removed the credential.
    assert.equal(await readFile(join(dir, "a-disarm-credential.json"), "utf8")
      .then(() => true, (error) => error.code === "ENOENT" ? false : Promise.reject(error)), false);
    // The old marker survived the failed write: the stale pair's marker half.
    marker = JSON.parse(await readFile(join(dir, "a-watch-exit.json"), "utf8"));
    assert.equal(marker.reason, "DISARM_DEFERRED_WAKE_SUPERVISOR");
    assert.notEqual(marker.acknowledgedAt, null);
    // 4. Repeated consume (acknowledgeReply allows repeat receipts) retriggers
    //    the retry — without the credential the pair is unproven: stays armed.
    await acknowledgeReply(dir, record, receipt.sha256);
    const repeat = await retryPendingDisarm(dir, { rootMonitorDir: root });
    assert.deepEqual(repeat, { disarmed: false, alreadyDisarmed: false, blockers: ["RELEASE_SUCCESS_UNPROVEN"] });
    assert.equal(JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8")).armedReason, "DISPATCH_ACCEPTED");
    const events = await readFile(join(dir, "a-fast-events.ndjson"), "utf8")
      .catch((error) => error.code === "ENOENT" ? "" : Promise.reject(error));
    assert.equal(events.includes("DISARMED_IDLE"), false);
    // 5. Recovery contract: only a NEW successful release re-issues a
    //    credential (the sibling is gone, so this one disarms outright — no
    //    credential is even needed).
    await rm(sibling, { recursive: true, force: true });
    const third = await releaseDelivered(params, dir, {
      runScript: async () => ({ code: 0, result: "AGENT_SPACE_RELEASED" }),
    });
    assert.equal(third, 0);
    assert.equal(JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8")).armedReason, "DISARMED_IDLE");
    assert.equal(await readFile(join(dir, "a-disarm-credential.json"), "utf8")
      .then(() => true, (error) => error.code === "ENOENT" ? false : Promise.reject(error)), false);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    await rm(root, { recursive: true, force: true });
  }
});

test("#27 B3 P1-C round 4 (ruling scenario): direct release keeps the verified dispatch identity across a concurrent send — A's success never disarms or credentials B", async () => {
  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  try {
    // Happy-path control: the extracted direct release keeps its plain flow —
    // verified success converges the disarm with the entry-verified identity.
    const controlRoot = await mkdtemp(join(tmpdir(), "ego-direct-release-ok-"));
    const controlDir = await makeConversation(controlRoot, { "a-fast-state.json": armedState("DISPATCH_ACCEPTED") });
    await completedConsumed(controlDir);
    console.log = (line) => logs.push(String(line));
    console.error = (line) => logs.push(String(line));
    const ok = await directRelease(
      { conversation: uuid, space: "GDC-执行A", agentId: "gdc-a", monitorDir: controlRoot, rootMonitorDir: controlRoot, action: "release" },
      controlDir, { runScript: async () => ({ code: 0, result: "AGENT_SPACE_RELEASED" }) });
    assert.equal(ok, 0);
    assert.equal(JSON.parse(await readFile(join(controlDir, "a-fast-state.json"), "utf8")).armedReason, "DISARMED_IDLE");
    await assert.rejects(readFile(join(controlDir, "a-watch-exit.json"), "utf8"), /ENOENT/);
    await assert.rejects(readFile(join(controlDir, "a-disarm-credential.json"), "utf8"), /ENOENT/);
    await rm(controlRoot, { recursive: true, force: true });

    // The ruling's attack path: A verified at release entry, B's send starts
    // mid-release (the send template only guards in-flight ledgers, so a
    // COMPLETED ledger is lawfully replaced), A's release then SUCCEEDS.
    const root = await mkdtemp(join(tmpdir(), "ego-direct-identity-"));
    const dir = await makeConversation(root, { "a-fast-state.json": armedState("DISPATCH_ACCEPTED") });
    const oldRecord = await completedConsumed(dir);
    const params = { conversation: uuid, space: "GDC-执行A", agentId: "gdc-a", monitorDir: root, rootMonitorDir: root, action: "release" };
    logs.length = 0;
    const code = await directRelease(params, dir, {
      runScript: async () => {
        // B starts while A's release is in flight: re-arm + replace the ledger.
        await armForDispatch(dir, { conversationUuid: uuid, space: "GDC-执行A" });
        await writeFile(join(dir, "a-dispatch-state.json"), JSON.stringify(
          dispatchRecord({ dispatchId: otherUuid, conversationUuid: uuid, status: "ACCEPTED" })));
        return { code: 0, result: "AGENT_SPACE_RELEASED" };
      },
    });
    // A's deferred handoff: exit through the durable wake ledger, armed state
    // untouched, explicit identity blocker — never a silent misbinding.
    assert.equal(code, 2);
    assert.equal(JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8")).armedReason, "DISPATCH_ACCEPTED");
    assert.ok(logs.some((line) => line.startsWith("RESULT=DISARM_DEFERRED") &&
      line.includes("DISARM_LEDGER_IDENTITY_CHANGED")), JSON.stringify(logs));
    const marker = JSON.parse(await readFile(join(dir, "a-watch-exit.json"), "utf8"));
    assert.equal(marker.reason, "DISARM_DEFERRED_WAKE_SUPERVISOR");
    // The credential names the ORIGINALLY VERIFIED dispatchId (A) — never the
    // ledger's current id after the swap (the round-3 misbinding gap).
    const credential = JSON.parse(await readFile(join(dir, "a-disarm-credential.json"), "utf8"));
    assert.equal(credential.dispatchId, oldRecord.dispatchId);
    assert.notEqual(credential.dispatchId, otherUuid);
    // B completes and consumes its own reply.
    const bAccepted = JSON.parse(await readFile(join(dir, "a-dispatch-state.json"), "utf8"));
    assert.equal(bAccepted.dispatchId, otherUuid);
    const bReceipt = await saveReply(dir, bAccepted, { text: "已消费回复", source: "DOM_BOUNDARY_VISIBLE" }, uuid);
    const bCompleted = { ...bAccepted, status: "COMPLETED" };
    await writeFile(join(dir, "a-dispatch-state.json"), JSON.stringify(bCompleted));
    await acknowledgeReply(dir, bCompleted, bReceipt.sha256);
    // B's consume-triggered retry: A's credential names A, not B — the gate
    // is unproven and B stays armed (RELEASE_SUCCESS_UNPROVEN).
    const bRetry = await retryPendingDisarm(dir, { rootMonitorDir: root });
    assert.deepEqual(bRetry, { disarmed: false, alreadyDisarmed: false, blockers: ["RELEASE_SUCCESS_UNPROVEN"] });
    assert.equal(JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8")).armedReason, "DISPATCH_ACCEPTED");
    const events = await readFile(join(dir, "a-fast-events.ndjson"), "utf8");
    assert.equal(events.includes("DISARMED_IDLE"), false);
    // Wiring pins: main() routes release through directRelease, and both
    // release paths thread the entry-verified dispatchId into the disarm.
    const source = await readFile(
      fileURLToPath(new URL("../monitor/dispatch-manager.mjs", import.meta.url)), "utf8");
    assert.match(source, /if \(p\.action === "release"\) return directRelease\(p, dir\);/);
    // Three threading sites: the watch path, the direct path and the managed
    // retry all carry the dispatchId they verified into the disarm write.
    assert.equal((source.match(/expectedDispatchId: verifiedDispatchId/g) || []).length, 3);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

test("#27 B3 P1-C round 4: the watch release path is bound by the same dispatch identity contract", async () => {
  // Same interleaving as the direct path, through releaseDelivered: the two
  // release paths must share ONE identity contract (ruling gap 2 closing).
  const root = await mkdtemp(join(tmpdir(), "ego-watch-identity-"));
  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  try {
    const dir = await makeConversation(root, { "a-fast-state.json": armedState("DISPATCH_ACCEPTED") });
    const oldRecord = await completedConsumed(dir);
    const params = { conversation: uuid, space: "GDC-执行A", agentId: "gdc-a", monitorDir: root, rootMonitorDir: root };
    console.log = (line) => logs.push(String(line));
    console.error = (line) => logs.push(String(line));
    const code = await releaseDelivered(params, dir, {
      runScript: async () => {
        await armForDispatch(dir, { conversationUuid: uuid, space: "GDC-执行A" });
        await writeFile(join(dir, "a-dispatch-state.json"), JSON.stringify(
          dispatchRecord({ dispatchId: otherUuid, conversationUuid: uuid, status: "ACCEPTED" })));
        return { code: 0, result: "AGENT_SPACE_RELEASED" };
      },
    });
    assert.equal(code, 2);
    assert.equal(JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8")).armedReason, "DISPATCH_ACCEPTED");
    assert.ok(logs.some((line) => line.startsWith("RESULT=DISARM_DEFERRED") &&
      line.includes("DISARM_LEDGER_IDENTITY_CHANGED")), JSON.stringify(logs));
    const marker = JSON.parse(await readFile(join(dir, "a-watch-exit.json"), "utf8"));
    assert.equal(marker.reason, "DISARM_DEFERRED_WAKE_SUPERVISOR");
    const credential = JSON.parse(await readFile(join(dir, "a-disarm-credential.json"), "utf8"));
    assert.equal(credential.dispatchId, oldRecord.dispatchId);
    assert.notEqual(credential.dispatchId, otherUuid);
    const bAccepted = JSON.parse(await readFile(join(dir, "a-dispatch-state.json"), "utf8"));
    const bReceipt = await saveReply(dir, bAccepted, { text: "已消费回复", source: "DOM_BOUNDARY_VISIBLE" }, uuid);
    const bCompleted = { ...bAccepted, status: "COMPLETED" };
    await writeFile(join(dir, "a-dispatch-state.json"), JSON.stringify(bCompleted));
    await acknowledgeReply(dir, bCompleted, bReceipt.sha256);
    const bRetry = await retryPendingDisarm(dir, { rootMonitorDir: root });
    assert.deepEqual(bRetry, { disarmed: false, alreadyDisarmed: false, blockers: ["RELEASE_SUCCESS_UNPROVEN"] });
    assert.equal(JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8")).armedReason, "DISPATCH_ACCEPTED");
    const events = await readFile(join(dir, "a-fast-events.ndjson"), "utf8");
    assert.equal(events.includes("DISARMED_IDLE"), false);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    await rm(root, { recursive: true, force: true });
  }
});

test("#27 B3 P1-C round 4: a release attempt aborts fail-closed when the stale credential cannot be cleared (both release paths)", async () => {
  // Forcing (real filesystem behavior, no mocks): the credential's path is
  // occupied by a DIRECTORY, so the pre-attempt clear can never succeed. A
  // release must never run carrying a previous round's success: both release
  // paths abort BEFORE the release script, and the armed state is untouched.
  // Round-5 injection correction (ruling §三): the wrappers now FORWARD the
  // caller's hooks, so the scriptRan assertion below really monitors the
  // callback the production path executes (the previous wrappers fixed their
  // own runScript and silently ignored the third argument, so the assertion
  // could never fail).
  for (const runRelease of [
    (params, dir, hooks = {}) => releaseDelivered(params, dir, hooks),
    (params, dir, hooks = {}) => directRelease(params, dir, hooks),
  ]) {
    const root = await mkdtemp(join(tmpdir(), "ego-release-clear-fail-"));
    try {
      const dir = await makeConversation(root, { "a-fast-state.json": armedState("DISPATCH_ACCEPTED") });
      await completedConsumed(dir);
      await mkdir(join(dir, "a-disarm-credential.json"), { recursive: true });
      let scriptRan = false;
      await assert.rejects(
        runRelease({ conversation: uuid, space: "GDC-执行A", agentId: "gdc-a", monitorDir: root, rootMonitorDir: root, action: "release" }, dir, {
          runScript: async () => { scriptRan = true; return { code: 0, result: "AGENT_SPACE_RELEASED" }; },
        }),
        /RELEASE_DISARM_CREDENTIAL_CLEAR_FAILED/);
      assert.equal(scriptRan, false, "the release script must never run behind an unclearable stale credential");
      assert.equal(JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8")).armedReason, "DISPATCH_ACCEPTED");
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

// ---- P1-C round 8 (2026-11-22 ruling: P1-C-1 REMAINS BLOCKED → holder-named
// ---- locks + deterministic election; supersedes round 7's PID-liveness fencing)
// Deterministic evidence, no clock gambles: a claim's holder is judged by
// process liveness, so the tests construct PROVABLY dead holders (a spawned
// child that already exited — process.kill(pid, 0) rejects with ESRCH from
// then on) and PROVABLY live holders (this very test process). Round 8 locks
// are HOLDER-NAMED — <scope>/a-commit-lock.<holderId>.json, the path IS the
// identity: no protocol participant ever writes or deletes a foreign path
// (source-pinned in T9), and a dead claim is unlinked by name only.

// A live-looking commit lock claim (schema v2, holderPid = this process —
// provably alive), as a real holder would leave it on disk. acquiredAt
// defaults to an AGED stamp so every later contender deterministically loses
// the (acquiredAt, holderId) election against it and fails closed. Round 6
// (P1-C-3): the claim lives at the commit-lock SCOPE — the monitor root — so
// these helpers take the root. Returns the claim's path for cleanup.
const lockHeldAt = async (dir, holderId = "ext-holder", holderPid = process.pid, acquiredAt = Date.now() - 60_000) => {
  const path = join(dir, `${COMMIT_LOCK_PREFIX}${holderId}.json`);
  await writeFile(path,
    JSON.stringify({ schema: COMMIT_LOCK_SCHEMA, acquiredAt, holderId, holderPid }), "utf8");
  return path;
};

// A claim whose holder process is PROVABLY dead: its holderPid belongs to a
// spawned child that has already exited. The death sweep recovers it
// regardless of file age (acquiredAt is deliberately fresh in most tests —
// age must have no vote once a holderPid is present).
const deadPid = async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  await new Promise((resolve) => child.once("exit", resolve));
  return child.pid;
};
const deadHolderLockAt = async (dir, acquiredAt = Date.now()) => {
  const holderId = `dead-${randomUUID()}`;
  const holderPid = await deadPid();
  const path = join(dir, `${COMMIT_LOCK_PREFIX}${holderId}.json`);
  await writeFile(path,
    JSON.stringify({ schema: COMMIT_LOCK_SCHEMA, acquiredAt, holderId, holderPid }), "utf8");
  return { holderId, holderPid, path };
};

// The scope holds no commit-lock claim file at all (a v2 release leaves none,
// and a swept dead claim leaves none either; round 6: the scope is the monitor
// root, shared by every conversation's participants).
const lockReleased = async (dir) =>
  (await readdir(dir)).every((name) => !name.startsWith(COMMIT_LOCK_PREFIX));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// No stolen/retiring residue anywhere in the scope (round 8 never produces
// either; the pin also guards against a regression reintroducing them).
const noLockResidue = async (root) => {
  const names = await readdir(root);
  return names.every((name) => !name.includes(".retiring-") && !name.includes(".stolen-"));
};

// Every holder-named claim file currently in the scope, with its content
// (name = identity in round 8). Unparsable residue surfaces as claim: null so
// corrupt-file scenarios can be observed without throwing.
const claimFiles = async (root) => {
  const names = (await readdir(root)).filter((name) => name.startsWith(COMMIT_LOCK_PREFIX)).sort();
  return Promise.all(names.map(async (name) => {
    const path = join(root, name);
    const raw = await readFile(path, "utf8");
    let claim = null;
    try { claim = JSON.parse(raw); } catch { claim = null; }
    return { name, path, claim, raw };
  }));
};

// The (acquiredAt, holderId) election — mirrored from dispatch-state.mjs so
// tests can observe who a contender will yield to.
const electWinnerOf = (live) => live.reduce((best, entry) => (best === null ||
  entry.claim.acquiredAt < best.claim.acquiredAt ||
  (entry.claim.acquiredAt === best.claim.acquiredAt &&
   entry.claim.holderId < best.claim.holderId)) ? entry : best, null);

// A pre-round-5 v4 fast state on disk: the armedSupersededDispatchId stamp
// field does not exist yet (the tolerant-read migration shape).
const preStampV4State = (armedReason, overrides = {}) => {
  const { armedSupersededDispatchId, ...rest } = normalizeFastState({}, { ts: Date.now(), armedReason, ...overrides });
  return rest;
};

// Browser DOM boundary stub for prepareDispatch (runScript precedent: only the
// page readback is injected; prepareDispatch itself runs for real and writes
// the real ledger). The composer must read as a verified empty slate.
const stubComposerPage = () => ({ evaluate: async () => ({
  hostOk: true, surfaceMode: "CHATGPT", composerCount: 1, composerPresent: true,
  composerEmpty: true, composerLength: 0, generating: false, stopLabelCount: 0,
  lastMessageRole: null, lastMessageKey: null, lastMessageTextLength: 0,
}) });

const assertNoDisarmEvent = async (dir) => {
  let events = "";
  try { events = await readFile(join(dir, "a-fast-events.ndjson"), "utf8"); }
  catch (error) { if (error?.code !== "ENOENT") throw error; } // absent file = no events at all
  assert.equal(events.split("\n").some((line) => line.includes("DISARMED_IDLE")), false,
    "no DISARMED_IDLE may be written through a refused commit");
};

test("#27 B3 P1-C round 5 (ruling scenario): direct release — a dispatch that arms AND prepares inside the identity-check→commit window is never clobbered", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-round5-direct-"));
  try {
    const dir = await makeConversation(root, { "a-fast-state.json": armedState("DISPATCH_ACCEPTED") });
    await completedConsumed(dir);
    let bDispatchId = null;
    const result = await disarmAfterRelease(dir, {
      rootMonitorDir: root,
      expectedDispatchId: uuid,
      // Ruling injection window: A's advisory identity check just passed, A
      // holds NO lock here, and B now really runs its arm AND its PREPARED
      // ledger establishment (real armForDispatch + real prepareDispatch on
      // the real filesystem; only the browser DOM readback is stubbed).
      beforeCommit: async () => {
        await armForDispatch(dir, { conversationUuid: uuid, space: "GDC-执行A" });
        const prepared = await prepareDispatch({
          monitorDir: dir, conversationUuid: uuid, taskSpace: "GDC-执行A",
          pageLabel: "p1", page: stubComposerPage(), payload: "新派单内容",
        });
        bDispatchId = prepared.dispatchId;
      },
    });
    // A's commit re-read the ledger INSIDE the lock: it belongs to B now.
    assert.notEqual(bDispatchId, null);
    assert.deepEqual(result, { disarmed: false, alreadyDisarmed: false, blockers: ["DISARM_LEDGER_IDENTITY_CHANGED"] });
    // B's armed state survived untouched — the ruling's core invariant: the
    // old dispatch's disarm write never overwrites the new dispatch's arm.
    const state = JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8"));
    assert.equal(state.armedReason, "DISPATCH_ACCEPTED");
    assert.equal(state.armedSupersededDispatchId, uuid);
    await assertNoDisarmEvent(dir);
    assert.equal(await lockReleased(root), true);
    // Convergence: only B's own verified release disarms the conversation.
    // (Realistic order per the round-3 test: the reply is staged while B is
    // ACCEPTED, then the ledger completes and the reply is consumed.)
    const bPrepared = JSON.parse(await readFile(join(dir, "a-dispatch-state.json"), "utf8"));
    const bAccepted = { ...bPrepared, status: "ACCEPTED" };
    await writeFile(join(dir, "a-dispatch-state.json"), JSON.stringify(bAccepted));
    const receipt = await saveReply(dir, bAccepted, { text: "已消费回复", source: "DOM_BOUNDARY_VISIBLE" }, uuid);
    const bCompleted = { ...bAccepted, status: "COMPLETED" };
    await writeFile(join(dir, "a-dispatch-state.json"), JSON.stringify(bCompleted));
    await acknowledgeReply(dir, bCompleted, receipt.sha256);
    const converged = await disarmAfterRelease(dir, { rootMonitorDir: root, expectedDispatchId: bDispatchId });
    assert.deepEqual(converged, { disarmed: true, alreadyDisarmed: false, blockers: [] });
    assert.equal(JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8")).armedReason, "DISARMED_IDLE");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#27 B3 P1-C round 5 (ruling scenario): the arm→PREPARED gap — a concurrent arm alone (ledger still the old instance) blocks the commit", async () => {
  // The window the one-shot ledger check cannot cover: B's arm committed (fast
  // state stamped with A's instance) but B's template has not reached
  // prepareDispatch yet, so the ledger still reads A COMPLETED. The in-lock
  // armedSupersededDispatchId re-verification is what refuses here.
  const root = await mkdtemp(join(tmpdir(), "ego-round5-armgap-"));
  try {
    const dir = await makeConversation(root, { "a-fast-state.json": armedState("DISPATCH_ACCEPTED") });
    await completedConsumed(dir);
    const result = await disarmAfterRelease(dir, {
      rootMonitorDir: root,
      expectedDispatchId: uuid,
      beforeCommit: async () => {
        await armForDispatch(dir, { conversationUuid: uuid, space: "GDC-执行A" });
      },
    });
    assert.deepEqual(result, { disarmed: false, alreadyDisarmed: false, blockers: ["DISARM_ARMED_INSTANCE_SUPERSEDED"] });
    const state = JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8"));
    assert.equal(state.armedReason, "DISPATCH_ACCEPTED");
    assert.equal(state.armedSupersededDispatchId, uuid);
    const ledger = JSON.parse(await readFile(join(dir, "a-dispatch-state.json"), "utf8"));
    assert.equal(ledger.dispatchId, uuid);
    assert.equal(ledger.status, "COMPLETED");
    await assertNoDisarmEvent(dir);
    assert.equal(await lockReleased(root), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#27 B3 P1-C round 5 (ruling scenario): the retry path — a dispatch racing the credential→commit window keeps its armed state", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-round5-retry-"));
  try {
    const dir = await makeConversation(root, { "a-fast-state.json": armedState("DISPATCH_ACCEPTED") });
    await completedConsumed(dir);
    // A's full deferred-disarm evidence pair (round 3/4 contract): acked
    // DISARM_DEFERRED marker + companion credential naming A.
    await writeFile(join(dir, "a-watch-exit.json"), JSON.stringify({
      schema: "ego-watch-exit/v1", wakeId: otherUuid, reason: "DISARM_DEFERRED_WAKE_SUPERVISOR",
      issuedAt: Date.now(), exitCode: 2, acknowledgedAt: Date.now(), ackAction: "investigated",
    }));
    await writeDisarmCredential(dir, disarmCredential());
    const result = await retryPendingDisarm(dir, {
      rootMonitorDir: root,
      // Injection window: the credential pair was just verified for A, A holds
      // NO lock, B really arms and replaces the ledger before the commit.
      beforeCommit: async () => {
        await armForDispatch(dir, { conversationUuid: uuid, space: "GDC-执行A" });
        await writeFile(join(dir, "a-dispatch-state.json"), JSON.stringify(
          dispatchRecord({ dispatchId: otherUuid, conversationUuid: uuid, status: "ACCEPTED" })));
      },
    });
    assert.equal(result.disarmed, false);
    assert.ok(result.blockers.includes("DISARM_LEDGER_IDENTITY_CHANGED"), JSON.stringify(result.blockers));
    const state = JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8"));
    assert.equal(state.armedReason, "DISPATCH_ACCEPTED");
    assert.equal(state.armedSupersededDispatchId, uuid);
    await assertNoDisarmEvent(dir);
    assert.equal(await lockReleased(root), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#27 B3 P1-C round 5: pre-stamp v4 fast states stay readable (tolerant read) and existing normal flows still converge the disarm", async () => {
  // Tolerant read: a v4 ledger written before armedSupersededDispatchId existed
  // is "current", not corrupt; normalize migrates the field in as null.
  const legacy = preStampV4State("DISPATCH_ACCEPTED");
  assert.equal("armedSupersededDispatchId" in legacy, false);
  assert.equal(classifyFastStateFile(legacy), "current");
  assert.equal(validateFastState(legacy), true);
  assert.equal(normalizeFastState(legacy, {}).armedSupersededDispatchId, null);
  // Migration convergence: the 存量会话 normal flow — armed pre-stamp state,
  // terminal consumed ledger, verified release — disarms under the new
  // serialized commit (missing stamp + in-lock ledger identity = provable).
  const root = await mkdtemp(join(tmpdir(), "ego-round5-migrate-"));
  try {
    const dir = await makeConversation(root, { "a-fast-state.json": JSON.stringify(legacy) });
    await completedConsumed(dir);
    const result = await disarmAfterRelease(dir, { rootMonitorDir: root, expectedDispatchId: uuid });
    assert.deepEqual(result, { disarmed: true, alreadyDisarmed: false, blockers: [] });
    const state = JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8"));
    assert.equal(state.armedReason, "DISARMED_IDLE");
    assert.equal(validateFastState(state), true);
  } finally { await rm(root, { recursive: true, force: true }); }
  // Positive control: a NEW-style state whose stamp names the PREVIOUS
  // dispatch (its own arm's supersession evidence) converges for its OWN id.
  const controlRoot = await mkdtemp(join(tmpdir(), "ego-round5-stamp-prev-"));
  try {
    const dir = await makeConversation(controlRoot, {
      "a-fast-state.json": armedState("DISPATCH_ACCEPTED", { armedSupersededDispatchId: otherUuid }),
    });
    await completedConsumed(dir);
    const ok = await disarmAfterRelease(dir, { rootMonitorDir: controlRoot, expectedDispatchId: uuid });
    assert.deepEqual(ok, { disarmed: true, alreadyDisarmed: false, blockers: [] });
  } finally { await rm(controlRoot, { recursive: true, force: true }); }
});

test("#27 B3 P1-C round 5 (round 7 rework): commit-lock contention is fail-closed for both the disarm commit and the arm section", async () => {
  // Disarm commit: a claim with no provably dead holder keeps the state armed
  // (explicit blocker), never writes; once the claim is removed, the same call
  // converges. (Round 7: the contender fails with COMMIT_LOCK_WAIT_TIMEOUT —
  // the identity-less claim has no holder process to prove dead, and its fresh
  // age is no evidence of abandonment.)
  {
    const root = await mkdtemp(join(tmpdir(), "ego-round5-lock-disarm-"));
    try {
      const dir = await makeConversation(root, { "a-fast-state.json": armedState("DISPATCH_ACCEPTED") });
      await completedConsumed(dir);
      // A provably LIVE foreign claim (holderPid = this process, aged key —
      // every contender deterministically loses the election against it).
      const heldPath = await lockHeldAt(root);
      const blocked = await disarmAfterRelease(dir, {
        rootMonitorDir: root, expectedDispatchId: uuid, commitLock: { waitBudgetMs: 60 },
      });
      assert.deepEqual(blocked, { disarmed: false, alreadyDisarmed: false,
        blockers: ["DISARM_COMMIT_LOCK_FAILED:COMMIT_LOCK_WAIT_TIMEOUT"] });
      assert.equal(JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8")).armedReason, "DISPATCH_ACCEPTED");
      await rm(heldPath);
      const ok = await disarmAfterRelease(dir, { rootMonitorDir: root, expectedDispatchId: uuid, commitLock: { waitBudgetMs: 60 } });
      assert.deepEqual(ok, { disarmed: true, alreadyDisarmed: false, blockers: [] });
    } finally { await rm(root, { recursive: true, force: true }); }
  }
  // Arm: an unavailable lock aborts the arm before ANY state write — main()
  // would then abort before the delivery template (nothing is sent).
  {
    const root = await mkdtemp(join(tmpdir(), "ego-round5-lock-arm-"));
    try {
      const dir = await makeConversation(root);
      await lockHeldAt(root);
      await assert.rejects(
        armForDispatch(dir, { conversationUuid: uuid, space: "GDC-执行A", commitLock: { waitBudgetMs: 60 } }),
        /ARM_COMMIT_LOCK_FAILED:COMMIT_LOCK_WAIT_TIMEOUT/);
      await assert.rejects(readFile(join(dir, "a-fast-state.json"), "utf8"), /ENOENT/);
      await assert.rejects(readFile(join(dir, "a-fast-events.ndjson"), "utf8"), /ENOENT/);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("#27 B3 P1-C round 8 T2: a PROVABLY DEAD holder's claim is swept immediately — age has no vote — and a live-looking claim is never touched (arm path)", async () => {
  // T2 (dead claim swept immediately): the claim's holderPid belongs to an
  // already-exited child and acquiredAt is FRESH — file age says "young", the
  // OS says "holder dead": the death sweep licenses the name-bound unlink
  // without any age wait, and the real arm caller recovers the lock through
  // its normal wait-budget path. (Round 8: no steal and no theft artifact —
  // the dead claim's own named path is simply removed.)
  const root = await mkdtemp(join(tmpdir(), "ego-round8-dead-sweep-"));
  try {
    const dir = await makeConversation(root);
    const dead = await deadHolderLockAt(root, Date.now()); // fresh age, dead holder
    const next = await armForDispatch(dir, { conversationUuid: uuid, space: "GDC-执行A", commitLock: { waitBudgetMs: 5_000 } });
    assert.equal(next.armedReason, "DISPATCH_ACCEPTED");
    assert.equal(await lockReleased(root), true);
    const names = await readdir(root);
    assert.equal(names.some((n) => n.includes(".stolen") || n.includes(".retiring")), false,
      "no theft/retiring residue: round 8 never produces any");
    // The claim THIS caller established, observed mid-section: a fresh
    // holderId bound into the path name, holderPid = the calling process
    // (never the dead pid) — the exact claim shape the death sweep later
    // interrogates.
    const secondDead = await deadHolderLockAt(root, Date.now());
    const seen = await withCommitLock(root, async () => (await claimFiles(root))[0], { waitBudgetMs: 0 });
    assert.match(seen.name, /^a-commit-lock\.[\da-f-]{36}\.json$/, "the claim path binds the holderId");
    assert.equal(seen.claim.holderId, seen.name.slice(COMMIT_LOCK_PREFIX.length, -".json".length));
    assert.equal(seen.claim.holderPid, process.pid);
    assert.notEqual(seen.claim.holderPid, secondDead.holderPid);
    assert.equal(seen.claim.schema, COMMIT_LOCK_SCHEMA);
    assert.equal(await lockReleased(root), true);
  } finally { await rm(root, { recursive: true, force: true }); }
  // T1b (live holder never displaced): a claim whose holderPid is THIS test
  // process — provably alive — and whose key is 60s aged. Age would have
  // licensed a round-6 steal; under round-8 liveness the age has no vote, the
  // contender loses the election and fails closed immediately (zero budget),
  // removing only its OWN claim; the live claim bytes stay untouched.
  {
    const liveRoot = await mkdtemp(join(tmpdir(), "ego-round8-live-keep-"));
    try {
      const dir = await makeConversation(liveRoot);
      const livePath = await lockHeldAt(liveRoot, "self-holder");
      const liveClaim = await readFile(livePath, "utf8");
      await assert.rejects(
        armForDispatch(dir, { conversationUuid: uuid, space: "GDC-执行A", commitLock: { waitBudgetMs: 0 } }),
        /ARM_COMMIT_LOCK_FAILED:COMMIT_LOCK_WAIT_TIMEOUT/);
      assert.equal(await readFile(livePath, "utf8"), liveClaim,
        "the live holder's claim bytes are untouched");
      assert.equal(await noLockResidue(liveRoot), true, "no theft attempted against a live holder");
      assert.equal((await claimFiles(liveRoot)).length, 1,
        "the contender removed its own claim before failing closed");
      await assert.rejects(readFile(join(dir, "a-fast-state.json"), "utf8"), /ENOENT/);
    } finally { await rm(liveRoot, { recursive: true, force: true }); }
  }
  // A claim file with no readable identity (zero bytes — a crash between the
  // exclusive create and the content write) is CORRUPT in round 8: it carries
  // no orderable identity, takes no part in the election (it cannot commit —
  // its holder's own guard fails COMMIT_LOCK_LOST on unreadable content) and
  // is swept by age only. A fresh one therefore does NOT block a contender
  // (round 7 failed closed here); it is left in place until it ages out.
  {
    const corruptRoot = await mkdtemp(join(tmpdir(), "ego-round8-corrupt-young-"));
    try {
      const dir = await makeConversation(corruptRoot);
      const corruptPath = join(corruptRoot, `${COMMIT_LOCK_PREFIX}crash-remnant.json`);
      await writeFile(corruptPath, "", "utf8");
      const next = await armForDispatch(dir, { conversationUuid: uuid, space: "GDC-执行A", commitLock: { waitBudgetMs: 5_000 } });
      assert.equal(next.armedReason, "DISPATCH_ACCEPTED");
      assert.equal((await stat(corruptPath)).size, 0,
        "young corrupt residue is neither swept nor blocking");
      // The arm's own claim was released; only the corrupt remnant remains.
      const remaining = await claimFiles(corruptRoot);
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].path, corruptPath);
    } finally { await rm(corruptRoot, { recursive: true, force: true }); }
  }
});

test("#27 B3 P1-C round 8 T1: a LIVE holder (this process) is never displaced even with an aged key — a zero-budget contender yields by election and fails closed immediately, and only its own claim is removed", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-round8-t1-live-"));
  try {
    // The claim carries holderPid = THIS test process (provably alive) and an
    // aged key: under round-6 age rules this would have been stolen; under
    // round-8 liveness the age has no vote, the contender deterministically
    // loses the election and fails closed after unlinking only its own path.
    const livePath = await lockHeldAt(root, "t1-self");
    const liveClaim = await readFile(livePath, "utf8");
    await assert.rejects(withCommitLock(root, async () => "should-not-run", { waitBudgetMs: 0 }),
      /COMMIT_LOCK_WAIT_TIMEOUT/);
    assert.equal(await readFile(livePath, "utf8"), liveClaim,
      "the live holder's claim bytes are untouched");
    assert.equal(await noLockResidue(root), true, "no theft artifacts against a live holder");
    assert.equal((await claimFiles(root)).length, 1,
      "the contender removed its own claim before failing closed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#27 B3 P1-C round 8 T3: the ownership guard fires COMMIT_LOCK_LOST when MY path's content is tampered mid-section (no protocol participant can produce this), and the name-bound release removes only MY path while the foreign holder's own path stays byte-intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-round8-t3-release-"));
  try {
    // B's REAL claim lives at B's OWN holder-named path (round 8: claims never
    // share a path, so "foreign lock" means a foreign PATH, not foreign bytes
    // at my path).
    const bPath = join(root, `${COMMIT_LOCK_PREFIX}foreign-holder-B.json`);
    const bClaim = JSON.stringify({ schema: COMMIT_LOCK_SCHEMA, acquiredAt: Date.now(), holderId: "foreign-holder-B", holderPid: process.pid });
    let aInfo = null;
    const run = withCommitLock(root, async (guard) => {
      await guard(); // ours, passes
      // Tamper while A is mid-section: (a) B establishes its own named claim;
      // (b) B's identity bytes are planted AT A's path, replacing A's claim
      // content. No protocol participant could produce (b) (holders never
      // write foreign paths); the test plays the tamper directly to pin the
      // guard as the backstop.
      await writeFile(bPath, bClaim, "utf8");
      await writeFile(aInfo.myPath,
        JSON.stringify({ schema: COMMIT_LOCK_SCHEMA, acquiredAt: Date.now(), holderId: "foreign-holder-B", holderPid: process.pid }), "utf8");
      await guard(); // the content no longer reads as A's → COMMIT_LOCK_LOST
      return "task-done";
    }, { waitBudgetMs: 5_000, hooks: { afterClassify: async (info) => { aInfo ??= info; } } });
    await assert.rejects(run, /COMMIT_LOCK_LOST/);
    // A's name-bound release removed the tampered bytes at A's OWN path only.
    await assert.rejects(stat(aInfo.myPath), /ENOENT/);
    // B's own path — the actual live claim of the foreign holder — survives
    // byte-for-byte; nothing else in the scope exists or was touched.
    assert.equal(await readFile(bPath, "utf8"), bClaim);
    assert.equal((await claimFiles(root)).length, 1);
    assert.equal(await noLockResidue(root), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#27 B3 P1-C round 8 T5 (source pin): the round-8 lock protocol has no steal, no rename, no restore and no stolen/retiring intermediate state — the only unlink targets are my own path and swept entry paths, and the only exclusive create is my own path", async () => {
  const src = await readFile(fileURLToPath(new URL("../monitor/dispatch-state.mjs", import.meta.url)), "utf8");
  const section = src.slice(src.indexOf("#27 Batch 3 P1-C round 8"), src.indexOf("export async function appendEvent"));
  assert.equal(/rename\s*\(/.test(section), false,
    "no rename anywhere in the lock protocol (the steal/restore mechanism is deleted)");
  assert.equal(/export (async )?function \w*(restore|recover)/i.test(src), false,
    "no exported restore/recovery function on the lock surface");
  assert.equal(section.includes(".stolen"), false, "no stolen intermediate state");
  assert.equal(section.includes(".retiring"), false, "no retiring intermediate state");
  // Every unlink targets the holder's OWN path or a swept entry path (the
  // name-bound death/corrupt sweep) — never any other holder's path.
  const unlinkTargets = [...section.matchAll(/unlink\(([A-Za-z.$]+)\)/g)].map((m) => m[1]);
  assert.ok(unlinkTargets.length >= 3, JSON.stringify(unlinkTargets));
  for (const target of unlinkTargets) {
    assert.ok(target === "myPath" || target === "entry.path", `unexpected unlink target: ${target}`);
  }
  assert.equal(section.split('await open(myPath, "wx"').length - 1, 1,
    "exactly one exclusive create — of the holder's own path");
  assert.equal(section.split("handle.writeFile(").length - 1, 1,
    "the only content write goes through my own claim's handle");
});

test("#27 B3 P1-C round 8 T6: a live holder's guard→commit section cannot be displaced — a zero-budget contender yields by election and fails closed while the holder commits and releases normally (window-3 structural closure)", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-round8-t6-window3-"));
  try {
    const dir = await makeConversation(root);
    const marker = join(root, "commit-marker.txt");
    let holderInside, resumeHolder, holderInfo = null;
    const insidePromise = new Promise((resolve) => { holderInside = resolve; });
    const gate = new Promise((resolve) => { resumeHolder = resolve; });
    const holderRun = withCommitLock(dir, async (guard) => {
      holderInside();
      await gate; // holder paused mid-section; its claim is live (this process holds it)
      await guard(); // ownership re-verified immediately before the write
      await writeFile(marker, "committed", "utf8");
      return "HOLDER_COMMITTED";
    }, { waitBudgetMs: 5_000, hooks: { afterClassify: async (info) => { holderInfo ??= info; } } });
    await insidePromise;
    const holderClaimBefore = await readFile(holderInfo.myPath, "utf8");
    // Barrier: with the holder provably mid-section, a zero-budget contender
    // deterministically loses the election (its clock is shifted forward, so
    // its key is strictly larger) — it yields, removing only its OWN claim,
    // and fails closed immediately without any clock dependency.
    await assert.rejects(withCommitLock(dir, async () => "should-not-run",
      { waitBudgetMs: 0, now: () => Date.now() + 60_000 }),
      /COMMIT_LOCK_WAIT_TIMEOUT/);
    assert.equal(await readFile(holderInfo.myPath, "utf8"), holderClaimBefore,
      "the live holder's claim was never touched by the yielding contender");
    resumeHolder();
    assert.equal(await holderRun, "HOLDER_COMMITTED");
    // The guarded commit landed; the claim was released normally with no
    // residue — the guard→commit window saw zero displacement.
    assert.equal(await readFile(marker, "utf8"), "committed");
    assert.equal(await lockReleased(root), true);
    assert.equal(await noLockResidue(root), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#27 B3 P1-C round 5: the commit lock really serializes concurrent participants (no interleaving, no leaked lock)", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-round5-serial-"));
  try {
    const dir = await makeConversation(root);
    const order = [];
    const section = (name) => withCommitLock(dir, async () => {
      order.push(name + ":start");
      // Real async boundaries inside the critical section.
      const raw = await readFile(join(dir, "a-fast-state.json"), "utf8").catch(() => "{}");
      await writeFile(join(dir, "a-fast-state.json"), raw);
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push(name + ":end");
    }, { waitBudgetMs: 2_000 });
    await Promise.all([section("A"), section("B")]);
    // Sections never interleave: each ":end" immediately precedes the other's
    // ":start" (single-holder mutual exclusion under real contention).
    assert.equal(order.length, 4, JSON.stringify(order));
    assert.match(order[0], /:start$/);
    assert.equal(order[1], order[0].replace(":start", ":end"));
    assert.match(order[2], /:start$/);
    assert.equal(order[3], order[2].replace(":start", ":end"));
    assert.notEqual(order[0], order[2]);
    assert.equal(await lockReleased(dir), true);
    assert.equal(await noLockResidue(root), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#27 B3 P1-C round 5 (ruling requirement 1): the PREPARED ledger establishment participates in the same commit lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-round5-prepare-"));
  try {
    const dir = await makeConversation(root);
    // Contention: a provably LIVE foreign claim (holderPid = this process,
    // aged key) aborts the prepare before any ledger write (the template
    // would then abort before any fill or delivery). Round 6: the prepare
    // serializes on the MONITOR ROOT commit lock.
    const heldPath = await lockHeldAt(root);
    await assert.rejects(
      prepareDispatch({ monitorDir: dir, conversationUuid: uuid, taskSpace: "GDC-执行A", pageLabel: "p1",
        page: stubComposerPage(), payload: "新派单内容", commitLock: { waitBudgetMs: 60 } }),
      /COMMIT_LOCK_WAIT_TIMEOUT/);
    await assert.rejects(readFile(join(dir, "a-dispatch-state.json"), "utf8"), /ENOENT/);
    await rm(heldPath);
    // Happy path: the real prepare writes the PREPARED ledger and releases the
    // lock (short critical section — no browser work is held inside it).
    const prepared = await prepareDispatch({ monitorDir: dir, conversationUuid: uuid, taskSpace: "GDC-执行A",
      pageLabel: "p1", page: stubComposerPage(), payload: "新派单内容" });
    assert.equal(prepared.status, "PREPARED");
    assert.equal(JSON.parse(await readFile(join(dir, "a-dispatch-state.json"), "utf8")).status, "PREPARED");
    assert.equal(await lockReleased(root), true);
    // In-lock ACTIVE re-check: a second send on the same conversation can no
    // longer race its own PREPARED write past the first one.
    await assert.rejects(
      prepareDispatch({ monitorDir: dir, conversationUuid: uuid, taskSpace: "GDC-执行A", pageLabel: "p1",
        page: stubComposerPage(), payload: "另一条" }),
      /ACTIVE_DISPATCH_BLOCKS_SEND/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// ---- P1-C round 6 (planner ruling reply 365689e8): lock ownership + ACTIVE supersession + global coordination ----

test("#27 B3 P1-C round 8 T7: three contenders race a DEAD holder's claim — the death sweep cleans it by name, exactly one contender is elected, the losers fail closed, no interleaving", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-round8-t7-race-"));
  try {
    // A dead holder's claim that THREE contenders simultaneously face — all
    // with a zero wait budget, so every judgment is immediate and no timing
    // luck is involved.
    const dead = await deadHolderLockAt(root, Date.now());
    const order = [];
    const contender = (name) => withCommitLock(root, async (guard) => {
      await guard();
      order.push(name + ":start");
      await sleep(30);
      order.push(name + ":end");
    }, { waitBudgetMs: 0 });
    const outcomes = await Promise.all([contender("A"), contender("B"), contender("C")]
      .map((run) => run.then(() => "ACQUIRED", (error) => String(error.message))));
    // Exactly one contender was elected; the losers failed closed after
    // removing only their own claims — none of them touched the winner's or
    // each other's paths.
    assert.equal(outcomes.filter((outcome) => outcome === "ACQUIRED").length, 1,
      JSON.stringify(outcomes));
    for (const outcome of outcomes) {
      if (outcome !== "ACQUIRED") assert.equal(outcome, "COMMIT_LOCK_WAIT_TIMEOUT", outcome);
    }
    // No critical section ever interleaved (single-holder execution).
    assert.equal(order.length, 2, JSON.stringify(order));
    assert.match(order[0], /:start$/);
    assert.equal(order[1], order[0].replace(":start", ":end"));
    // The dead claim's own named path was swept by whichever contender swept
    // first (concurrent sweeps tolerate the ENOENT); no theft/retiring
    // residue exists in round 8.
    const names = await readdir(root);
    assert.equal(names.some((name) => name.includes(dead.holderId)), false,
      "the dead claim's named path was swept");
    assert.equal(names.some((name) => name.includes(".stolen") || name.includes(".retiring")), false);
    // After all contenders settle, a follow-up holder acquires cleanly.
    assert.equal(await lockReleased(root), true);
    await withCommitLock(root, async () => {}, { waitBudgetMs: 1_000 });
    assert.equal(await lockReleased(root), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#27 B3 P1-C round 8 (P1-C-1 ruling reqs 3+4): the pre-write ownership guard aborts fail-closed when MY claim content is tampered mid-section (no protocol participant can produce this against a live holder), and the name-bound release cleans only MY path", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-round8-displaced-"));
  try {
    let resumeX, xInside, xInfo = null;
    const gateX = new Promise((resolve) => { resumeX = resolve; });
    const xInsidePromise = new Promise((resolve) => { xInside = resolve; });
    const marker = join(root, "x-commit-marker.txt");
    // X holds the claim and pauses mid-section (a slow commit section).
    const xRun = withCommitLock(root, async (guard) => {
      xInside();
      await gateX;
      // The pre-write ownership re-verification detects that MY path no
      // longer reads as X's claim — fail-closed, X never co-commits.
      await guard();
      await writeFile(marker, "x-committed", "utf8");
    }, { waitBudgetMs: 10_000, hooks: { afterClassify: async (info) => { xInfo ??= info; } } })
      .then(() => "X_COMMITTED", (error) => String(error.message));
    await xInsidePromise;
    // Tamper X's claim content AT X's OWN path (the path name stays X's —
    // round 8 claims are name-bound; no protocol participant writes foreign
    // paths, so the test plays the tamper directly: the guard remains the
    // backstop for exactly this class of event).
    await writeFile(xInfo.myPath,
      JSON.stringify({ schema: COMMIT_LOCK_SCHEMA, acquiredAt: Date.now(), holderId: "foreign-Y", holderPid: process.pid }), "utf8");
    resumeX();
    assert.equal(await xRun, "COMMIT_LOCK_LOST");
    // X's guarded commit never happened.
    await assert.rejects(stat(marker), /ENOENT/);
    // X's name-bound release removed the tampered bytes at X's OWN path; the
    // foreign identity never had a path of its own, so the scope holds no
    // claim file at all.
    await assert.rejects(stat(xInfo.myPath), /ENOENT/);
    assert.equal((await claimFiles(root)).length, 0);
    // Convergence: a fresh holder acquires cleanly and the scope ends clean.
    await withCommitLock(root, async () => {}, { waitBudgetMs: 1_000 });
    assert.equal(await lockReleased(root), true);
    assert.equal(await noLockResidue(root), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#27 B3 P1-C round 8 (P1-C-1): the disarm commit aborts fail-closed when its claim content is tampered mid-section (hook-barrier tamper — no protocol participant can produce this against a live holder); the victim's name-bound release cleans the tampered path and the retry converges", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-round8-guard-disarm-"));
  try {
    const dir = await makeConversation(root, { "a-fast-state.json": armedState("DISPATCH_ACCEPTED") });
    await completedConsumed(dir);
    // Deterministic barrier: the victim's withCommitLock is paused through
    // the injected afterClassify seam (fires after each round's sweep) on its
    // SECOND round — the confirmation round, whose snapshot has already
    // classified its own claim live. The external tamper then replaces the
    // claim CONTENT at the victim's own path (the path name stays the
    // victim's identity; no protocol participant writes foreign paths, so
    // only the test can produce this), and the victim is released into its
    // election: it enters on the pre-tamper snapshot (as the protocol
    // allows), and the pre-write ownership guard then reads the tampered
    // bytes off the disk — COMMIT_LOCK_LOST, fail-closed.
    const thiefClaimBytes = JSON.stringify({ schema: COMMIT_LOCK_SCHEMA, acquiredAt: Date.now(), holderId: "thief-Z", holderPid: process.pid });
    let victimPausedResolve; const victimPaused = new Promise((resolve) => { victimPausedResolve = resolve; });
    let tamperDoneResolve; const tamperDone = new Promise((resolve) => { tamperDoneResolve = resolve; });
    let victimRounds = 0;
    const disarmRun = disarmAfterRelease(dir, {
      rootMonitorDir: root, expectedDispatchId: uuid,
      commitLock: { hooks: { afterClassify: async (info) => {
        victimRounds++;
        if (victimRounds === 2) {
          victimPausedResolve(info.myPath);
          await tamperDone; // the external tamper has landed on MY path
        }
      } } },
    });
    const victimPath = await victimPaused;
    await writeFile(victimPath, thiefClaimBytes, "utf8"); // external tamper
    tamperDoneResolve();
    // The victim's commit: the ownership guard fires COMMIT_LOCK_LOST (its
    // claim content was tampered mid-section) and the disarm stays armed
    // fail-closed.
    const result = await disarmRun;
    assert.deepEqual(result, { disarmed: false, alreadyDisarmed: false,
      blockers: ["DISARM_COMMIT_LOCK_FAILED:COMMIT_LOCK_LOST"] });
    assert.equal(JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8")).armedReason,
      "DISPATCH_ACCEPTED");
    await assertNoDisarmEvent(dir);
    // The victim's name-bound release removed the tampered content at its OWN
    // path; the thief identity never had a path of its own.
    assert.equal((await claimFiles(root)).length, 0);
    // Convergence: the victim's retry — no contender left, no in-flight
    // sibling — disarms cleanly.
    const retry = await disarmAfterRelease(dir, { rootMonitorDir: root, expectedDispatchId: uuid });
    assert.deepEqual(retry, { disarmed: true, alreadyDisarmed: false, blockers: [] });
  } finally { await rm(root, { recursive: true, force: true }); }
});

// ---- P1-C round 8 (2026-11-22 ruling ①): deterministic T8-T12 --------------
// Barriers are injected through options.hooks.afterClassify (fires after the
// sweep's classification, BEFORE any foreign-path action) and through task/
// event gates — every wait is on an observable protocol state, no sleep
// gambles. Clock shifts (options.now) only ever make an election outcome
// deterministic; age/grace checks advance in real time.

test("#27 B3 P1-C round 8 T8 (ruling-point timing): A judges D dead and pauses; B claims its OWN path, wins the election, passes its guard and holds; A resumes, yields by election and acquires only after B releases — B's claim bytes never change and the mutex counter never exceeds 1", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-round8-t8-"));
  try {
    // D: a dead holder's claim at D's OWN holder-named path (the round-7
    // counterexample's shared single path no longer exists).
    const dead = await deadHolderLockAt(root, Date.now());
    const mutex = { inside: 0, maxInside: 0 };
    const events = [];
    const track = (name) => { mutex.inside++; mutex.maxInside = Math.max(mutex.maxInside, mutex.inside); events.push(name + ":start"); };
    const untrack = (name) => { mutex.inside--; events.push(name + ":end"); };

    // ① A judges D dead (its hook fires BEFORE any foreign-path action) and
    // ② pauses there.
    let resumeA; const aGate = new Promise((resolve) => { resumeA = resolve; });
    let aPausedResolve; const aPaused = new Promise((resolve) => { aPausedResolve = resolve; });
    let aYieldResolve; const aYieldObserved = new Promise((resolve) => { aYieldResolve = resolve; });
    let aInfo = null, aResumed = false;
    const aRun = withCommitLock(root, async (guard) => {
      track("A"); await guard(); untrack("A"); return "A_DONE";
    }, { waitBudgetMs: 10_000, hooks: { afterClassify: async (info) => {
      aInfo ??= info;
      if (!aResumed && info.dead.some((entry) => entry.holderId === dead.holderId)) {
        aResumed = true;
        aPausedResolve(info); // A has judged D dead and acted on nothing foreign yet
        await aGate; // the ruling pause: judge-dead → … → B holds → resume
        return;
      }
      if (aResumed && bInfo !== null) {
        const winner = electWinnerOf(info.live);
        if (winner !== null && winner.holderId === bInfo.holderId) aYieldResolve(info);
      }
    } } });
    const pausedInfo = await aPaused;
    assert.equal(pausedInfo.dead.some((entry) => entry.holderId === dead.holderId), true);
    assert.equal(pausedInfo.live.length, 1, "only A's own claim is live at the pause");

    // ③ B runs its own full protocol (in round 8 there is no recovery of D):
    // claims B's OWN path, sweeps (A live; D dead → swept), wins the election
    // over A (B's clock shifted onto a 5s epoch base that advances in real
    // time, so B's key is deterministically smaller), passes the confirmation
    // tick, enters, and passes its guard while holding.
    const bStart = Date.now();
    const bNow = () => 5_000 + (Date.now() - bStart);
    let bInfo = null, resumeB; const bGate = new Promise((resolve) => { resumeB = resolve; });
    let bStartedResolve; const bStarted = new Promise((resolve) => { bStartedResolve = resolve; });
    let bEntryBytes = null, bExitBytes = null;
    const bRun = withCommitLock(root, async (guard) => {
      bEntryBytes = await readFile(bInfo.myPath, "utf8"); // B's own named claim
      track("B");
      await guard(); // B passes the ownership guard while holding
      bStartedResolve();
      await bGate; // B holds the live lock until the test releases it
      bExitBytes = await readFile(bInfo.myPath, "utf8"); // re-read across the whole hold
      untrack("B");
      return "B_DONE";
    }, { now: bNow, waitBudgetMs: 10_000, hooks: { afterClassify: async (info) => { bInfo ??= info; } } });
    await bStarted;
    assert.equal(bInfo.holderId, bEntryBytes ? JSON.parse(bEntryBytes).holderId : null);
    assert.equal(JSON.parse(bEntryBytes).holderPid, process.pid);

    // Mid-sequence state: D's named path is gone (swept while A was paused);
    // exactly A's and B's claims exist.
    assert.equal((await readdir(root)).some((name) => name.includes(dead.holderId)), false,
      "D's dead claim was swept while A was paused");
    const midFiles = await claimFiles(root);
    assert.equal(midFiles.length, 2, JSON.stringify(midFiles.map((file) => file.name)));

    // ④ A resumes: its own dead-sweep hits ENOENT (tolerated), the election
    // shows B's smaller live key → A yields, touching only its own path.
    resumeA();
    await aYieldObserved;

    // ⑤⑥ B commits and releases; only then does A acquire — "B commits + C
    // holds" is structurally impossible (the election admits one winner).
    resumeB();
    assert.equal(await bRun, "B_DONE");
    assert.equal(await aRun, "A_DONE");

    // ⑦ aftermath: B's claim bytes never changed across its whole hold (A's
    // resume + yield + re-claim happened entirely inside it); A entered the
    // critical section strictly after B exited; the mutex counter never
    // exceeded 1; the scope ends with no residue.
    assert.equal(bExitBytes, bEntryBytes, "B's claim bytes are byte-identical across the hold");
    assert.deepEqual(events, ["B:start", "B:end", "A:start", "A:end"], JSON.stringify(events));
    assert.equal(mutex.maxInside, 1);
    assert.equal(await lockReleased(root), true);
    assert.equal(await noLockResidue(root), true);
    assert.equal((await claimFiles(root)).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#27 B3 P1-C round 8 end-to-end: the planner counterexample's full sequence on the real protocol — three concurrent withCommitLock calls with barrier injection, mutex preserved end to end", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-round8-e2e-"));
  try {
    const dead = await deadHolderLockAt(root, Date.now());
    const mutex = { inside: 0, maxInside: 0 };
    const events = [];
    const track = (name) => { mutex.inside++; mutex.maxInside = Math.max(mutex.maxInside, mutex.inside); events.push(name + ":start"); };
    const untrack = (name) => { mutex.inside--; events.push(name + ":end"); };

    // ① A judges D dead → ② A pauses (the hook fires before any foreign action).
    let resumeA; const aGate = new Promise((resolve) => { resumeA = resolve; });
    let aPausedResolve; const aPaused = new Promise((resolve) => { aPausedResolve = resolve; });
    let aResumed = false;
    const aRun = withCommitLock(root, async (guard) => {
      track("A"); await guard(); untrack("A"); return "A_DONE";
    }, { waitBudgetMs: 10_000, hooks: { afterClassify: async (info) => {
      if (!aResumed && info.dead.some((entry) => entry.holderId === dead.holderId)) {
        aResumed = true; aPausedResolve(); await aGate; return;
      }
    } } });
    await aPaused;

    // ③ B claims its OWN path, wins the election, passes its guard, holds.
    const bStart = Date.now();
    const bNow = () => 5_000 + (Date.now() - bStart);
    let bInfo = null, resumeB; const bGate = new Promise((resolve) => { resumeB = resolve; });
    let bStartedResolve; const bStarted = new Promise((resolve) => { bStartedResolve = resolve; });
    let bEntryBytes = null, bExitBytes = null;
    const bRun = withCommitLock(root, async (guard) => {
      bEntryBytes = await readFile(bInfo.myPath, "utf8");
      track("B"); await guard();
      bStartedResolve();
      await bGate;
      bExitBytes = await readFile(bInfo.myPath, "utf8");
      untrack("B"); return "B_DONE";
    }, { now: bNow, waitBudgetMs: 10_000, hooks: { afterClassify: async (info) => { bInfo ??= info; } } });
    await bStarted;

    // ⑤ C arrives at the "vacancy" while B holds: the election admits exactly
    // one winner, so C (real clock ⇒ strictly larger key) yields and, with a
    // zero budget, fails closed — it never enters.
    let cOutcome = null;
    const cRun = withCommitLock(root, async (guard) => {
      track("C"); await guard(); untrack("C"); return "C_DONE";
    }, { waitBudgetMs: 0 }).then((value) => (cOutcome = value), (error) => (cOutcome = String(error.message)));
    await cRun;
    assert.equal(cOutcome, "COMMIT_LOCK_WAIT_TIMEOUT", "C fails closed against B's live claim");
    assert.equal(events.some((event) => event.startsWith("C:")), false, "C never entered the critical section");

    // ④ A resumes → its dead-sweep hits ENOENT (B swept D) → the election
    // shows B's smaller live key → A yields (only its own path touched).
    resumeA();
    // ⑥ B commits and releases; A re-contends and acquires afterward — "B
    // commits while C holds" cannot happen (C already failed closed).
    resumeB();
    assert.equal(await bRun, "B_DONE");
    assert.equal(await aRun, "A_DONE");

    // ⑦ aftermath: no restore path, no residue, B's claim bytes never changed,
    // mutex counter never exceeded 1, and the entry order proves A acquired
    // strictly after B released.
    assert.equal(bExitBytes, bEntryBytes);
    assert.deepEqual(events, ["B:start", "B:end", "A:start", "A:end"], JSON.stringify(events));
    assert.equal(mutex.maxInside, 1);
    assert.equal((await readdir(root)).some((name) => name.includes(dead.holderId)), false,
      "the dead claim was swept by name");
    assert.equal(await noLockResidue(root), true);
    assert.equal(await lockReleased(root), true);
    assert.equal((await claimFiles(root)).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#27 B3 P1-C round 8 T9: yield and release touch only the contender's OWN path — foreign claim bytes stay intact (behavior), and the source pins the only foreign-path action to the name-bound death sweep", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-round8-t9-"));
  try {
    // Behavior 1: a contender facing a LIVE foreign claim yields (unlinks its
    // own claim) and fails closed; the foreign claim is byte-identical after.
    const foreignPath = await lockHeldAt(root, "foreign-holder");
    const foreignBefore = await readFile(foreignPath, "utf8");
    await assert.rejects(withCommitLock(root, async () => "should-not-run", { waitBudgetMs: 0 }),
      /COMMIT_LOCK_WAIT_TIMEOUT/);
    assert.equal(await readFile(foreignPath, "utf8"), foreignBefore,
      "the foreign claim was never written or removed by the yielding contender");
    assert.equal((await claimFiles(root)).length, 1,
      "only the foreign claim remains: the contender removed its own");
    // Behavior 2: a failed task's release still removes the holder's OWN
    // claim and nothing else.
    await rm(foreignPath);
    let holderInfo = null;
    await assert.rejects(withCommitLock(root, async () => { throw new Error("TASK_FAILED"); },
      { waitBudgetMs: 5_000, hooks: { afterClassify: async (info) => { holderInfo ??= info; } } }),
      /TASK_FAILED/);
    await assert.rejects(stat(holderInfo.myPath), /ENOENT/,
      "the failed holder's own claim was released");
    assert.equal(await lockReleased(root), true);
  } finally { await rm(root, { recursive: true, force: true }); }
  // Source pin (round-8 lock section only): every unlink targets the holder's
  // own path or a swept entry path; the only exclusive create and the only
  // content write are the holder's own claim; no rename, no stolen/retiring
  // intermediate state exists anywhere in the protocol.
  const src = await readFile(fileURLToPath(new URL("../monitor/dispatch-state.mjs", import.meta.url)), "utf8");
  const section = src.slice(src.indexOf("#27 Batch 3 P1-C round 8"), src.indexOf("export async function appendEvent"));
  const unlinkTargets = [...section.matchAll(/unlink\(([A-Za-z.$]+)\)/g)].map((match) => match[1]);
  assert.ok(unlinkTargets.length >= 3, JSON.stringify(unlinkTargets));
  for (const target of unlinkTargets) {
    assert.ok(target === "myPath" || target === "entry.path", `unexpected unlink target: ${target}`);
  }
  assert.equal(section.split('await open(myPath, "wx"').length - 1, 1,
    "exactly one exclusive create — of the holder's own path");
  assert.equal(section.split("handle.writeFile(").length - 1, 1,
    "the only content write is my own claim's");
  assert.equal(/rename\s*\(/.test(section), false);
  assert.equal(section.includes(".stolen"), false);
  assert.equal(section.includes(".retiring"), false);
});

test("#27 B3 P1-C round 8 T10: the electing readdir is a FRESH re-list taken after the claim's create — a later creator sees the earlier live claimant and yields (behavior), and the create→re-list order plus the confirmation re-list are pinned in source", async () => {
  // Behavior: an earlier live claimant with an aged key is ALWAYS seen by a
  // later contender (whose key is strictly newer), which yields and fails
  // closed on a zero budget; the earlier claimant's bytes never change.
  const root = await mkdtemp(join(tmpdir(), "ego-round8-t10-"));
  try {
    const earlyPath = await lockHeldAt(root, "early-holder"); // aged key ⇒ deterministically wins
    const earlyBefore = await readFile(earlyPath, "utf8");
    await assert.rejects(withCommitLock(root, async () => "should-not-run", { waitBudgetMs: 0 }),
      /COMMIT_LOCK_WAIT_TIMEOUT/);
    assert.equal(await readFile(earlyPath, "utf8"), earlyBefore,
      "the later creator saw the earlier claimant and yielded without touching it");
    assert.equal((await claimFiles(root)).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
  // Source pin: within the acquisition loop, the exclusive create of my own
  // path precedes the sweep's readdir, and the confirmation tick loops back
  // through that same sweep before entering — the election never runs on a
  // stale or pre-create snapshot.
  const src = await readFile(fileURLToPath(new URL("../monitor/dispatch-state.mjs", import.meta.url)), "utf8");
  const section = src.slice(src.indexOf("#27 Batch 3 P1-C round 8"), src.indexOf("export async function appendEvent"));
  const loop = section.slice(section.indexOf("① claim"), section.indexOf("break; // confirmed winner"));
  const createAt = loop.indexOf('await open(myPath, "wx"');
  const sweepAt = loop.indexOf("await sweepCommitLockClaims(dir)");
  const confirmAt = loop.indexOf("COMMIT_LOCK_POLL_MS) {");
  assert.ok(createAt >= 0 && sweepAt > createAt,
    "the electing readdir happens after my own claim's create");
  assert.ok(confirmAt > sweepAt && loop.indexOf("continue;", confirmAt) > confirmAt,
    "an unconfirmed winner loops back through the fresh sweep before entering");
});

test("#27 B3 P1-C round 8 T11: five concurrent contenders over a domain holding a dead claim — the dead claim is swept by name, exactly one contender is elected per round, sections never interleave, the shared counter loses no update, the scope ends clean", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-round8-t11-"));
  try {
    const dead = await deadHolderLockAt(root, Date.now());
    const order = [];
    const probe = join(root, "probe.txt");
    const section = (name) => withCommitLock(root, async (guard) => {
      await guard();
      order.push(name + ":start");
      const raw = await readFile(probe, "utf8").catch(() => "0");
      await writeFile(probe, String(Number(raw) + 1), "utf8");
      await new Promise((resolve) => setTimeout(resolve, 15));
      order.push(name + ":end");
    }, { waitBudgetMs: 10_000 });
    const outcomes = await Promise.all([1, 2, 3, 4, 5].map((i) => section("C" + i)
      .then(() => "ACQUIRED", (error) => String(error.message))));
    assert.equal(outcomes.every((outcome) => outcome === "ACQUIRED"), true, JSON.stringify(outcomes));
    // Every contender entered exactly once, sections never interleaved, and
    // the in-lock read-modify-write lost no update (a mutex break would lose
    // increments).
    assert.equal(order.length, 10, JSON.stringify(order));
    for (let i = 0; i < 10; i += 2) {
      assert.match(order[i], /:start$/);
      assert.equal(order[i + 1], order[i].replace(":start", ":end"));
    }
    assert.equal(await readFile(probe, "utf8"), "5");
    // The dead claim's named path was swept (ENOENT races between sweepers
    // tolerated); no residue anywhere.
    const names = await readdir(root);
    assert.equal(names.some((name) => name.includes(dead.holderId)), false);
    assert.equal(await noLockResidue(root), true);
    assert.equal(await lockReleased(root), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#27 B3 P1-C round 8 T12: corrupt claim files carry no identity — aged residue is swept by name (the legacy v1 path decays the same way), a young one blocks nobody and is left in place, and a live holder whose own claim turns corrupt fails its guard (COMMIT_LOCK_LOST) instead of committing", async () => {
  // (a) Aged corrupt residue is swept by name by the next contender's sweep.
  const root = await mkdtemp(join(tmpdir(), "ego-round8-t12-aged-"));
  try {
    const agedCorrupt = join(root, `${COMMIT_LOCK_PREFIX}crash-remnant.json`);
    await writeFile(agedCorrupt, "", "utf8");
    const legacyV1 = join(root, COMMIT_LOCK_FILE); // legacy v1 single path: name parses to no identity
    await writeFile(legacyV1, JSON.stringify({ schema: "ego-commit-lock/v1", acquiredAt: Date.now() }), "utf8");
    const stale = new Date(Date.now() - 40_000);
    await utimes(agedCorrupt, stale, stale);
    await utimes(legacyV1, stale, stale);
    const result = await withCommitLock(root, async () => "acquired", { waitBudgetMs: 5_000 });
    assert.equal(result, "acquired");
    await assert.rejects(stat(agedCorrupt), /ENOENT/, "aged corrupt residue swept by name");
    await assert.rejects(stat(legacyV1), /ENOENT/, "the legacy v1 path decays through the corrupt class");
    assert.equal(await lockReleased(root), true);
  } finally { await rm(root, { recursive: true, force: true }); }
  // (b) A YOUNG corrupt file is not swept and blocks nobody.
  {
    const youngRoot = await mkdtemp(join(tmpdir(), "ego-round8-t12-young-"));
    try {
      const youngCorrupt = join(youngRoot, `${COMMIT_LOCK_PREFIX}young-remnant.json`);
      await writeFile(youngCorrupt, "", "utf8");
      const result = await withCommitLock(youngRoot, async () => "acquired", { waitBudgetMs: 5_000 });
      assert.equal(result, "acquired");
      assert.equal((await stat(youngCorrupt)).size, 0, "young corrupt residue is left alone");
      // The holder's own claim was released; only the young remnant remains.
      const remaining = await claimFiles(youngRoot);
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].path, youngCorrupt);
    } finally { await rm(youngRoot, { recursive: true, force: true }); }
  }
  // (c) A live holder whose own claim content is tampered corrupt fails its
  // guard fail-closed (it can never commit); the young corrupt file is not
  // swept by a concurrent contender, whose election simply cannot see it.
  {
    const tamperRoot = await mkdtemp(join(tmpdir(), "ego-round8-t12-tamper-"));
    try {
      const marker = join(tamperRoot, "commit-marker.txt");
      let resumeX; const gateX = new Promise((resolve) => { resumeX = resolve; });
      let xInsideResolve; const xInside = new Promise((resolve) => { xInsideResolve = resolve; });
      let xInfo = null;
      const xRun = withCommitLock(tamperRoot, async (guard) => {
        xInsideResolve();
        await gateX;
        await guard(); // the tampered-corrupt content fires COMMIT_LOCK_LOST here
        await writeFile(marker, "committed", "utf8");
        return "X_COMMITTED";
      }, { waitBudgetMs: 10_000, hooks: { afterClassify: async (info) => { xInfo ??= info; } } });
      await xInside;
      await writeFile(xInfo.myPath, "", "utf8"); // tamper X's own claim to zero bytes
      const contender = await withCommitLock(tamperRoot, async () => "C_ACQUIRED", { waitBudgetMs: 5_000 });
      assert.equal(contender, "C_ACQUIRED", "the corrupt claim is invisible to the election");
      assert.equal((await stat(xInfo.myPath)).size, 0, "the young corrupt file was not swept");
      resumeX();
      await assert.rejects(xRun, /COMMIT_LOCK_LOST/, "X never commits through a corrupt claim");
      await assert.rejects(stat(marker), /ENOENT/);
      // X's name-bound release cleaned its own (corrupt) path; C released
      // its own; the scope ends clean.
      assert.equal(await lockReleased(tamperRoot), true);
      assert.equal(await noLockResidue(tamperRoot), true);
    } finally { await rm(tamperRoot, { recursive: true, force: true }); }
  }
});

test("#27 B3 P1-C round 6 (P1-C-2 ruling sequence): B arms over A's ACTIVE ledger declaring the supersession — A is blocked from disarming, and B's PREPARED stays DISPATCH_ACCEPTED-consistent", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-round6-active-stamp-"));
  try {
    const dir = await makeConversation(root, { "a-fast-state.json": armedState("DISPATCH_ACCEPTED") });
    // ① A's dispatch is still in flight (ACCEPTED).
    await writeFile(join(dir, "a-dispatch-state.json"), JSON.stringify(
      dispatchRecord({ status: "ACCEPTED" })), "utf8");
    // ② B arms while A is ACTIVE, declaring that this new dispatch will
    //    replace A's instance; the ACTIVE supersession is recorded.
    const bArm = await armForDispatch(dir, {
      conversationUuid: uuid, space: "GDC-执行A", supersedesActiveInstance: true,
    });
    assert.equal(bArm.armedReason, "DISPATCH_ACCEPTED");
    assert.equal(bArm.armedSupersededDispatchId, uuid);
    // ③ A completes (terminal) and its reply is consumed.
    const aCompleted = dispatchRecord({ status: "COMPLETED" });
    await writeFile(join(dir, "a-dispatch-state.json"), JSON.stringify(aCompleted));
    const receipt = await saveReply(dir, aCompleted, { text: "已消费回复", source: "DOM_BOUNDARY_VISIBLE" }, uuid);
    await acknowledgeReply(dir, aCompleted, receipt.sha256);
    // ④ A's release+disarm commit: the in-lock stamp re-verification refuses —
    //    B's declared arm superseded A's instance while A was ACTIVE.
    const aDisarm = await disarmAfterRelease(dir, { rootMonitorDir: root, expectedDispatchId: uuid });
    assert.deepEqual(aDisarm, { disarmed: false, alreadyDisarmed: false,
      blockers: ["DISARM_ARMED_INSTANCE_SUPERSEDED"] });
    await assertNoDisarmEvent(dir);
    // ⑤ B's prepareDispatch now succeeds (A is terminal — the in-lock ACTIVE
    //    re-check passes).
    const prepared = await prepareDispatch({ monitorDir: dir, conversationUuid: uuid,
      taskSpace: "GDC-执行A", pageLabel: "p1", page: stubComposerPage(), payload: "新派单内容" });
    // ⑥ B's PREPARED and DISPATCH_ACCEPTED are consistent — B's 布防 stands.
    assert.equal(prepared.status, "PREPARED");
    const state = JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8"));
    assert.equal(state.armedReason, "DISPATCH_ACCEPTED");
    assert.equal(state.armedSupersededDispatchId, uuid);
    // ⑦ A can never revoke B's arm: its instance no longer owns the ledger,
    //    and the fast state stays armed for B.
    const revoke = await disarmAfterRelease(dir, { rootMonitorDir: root, expectedDispatchId: uuid });
    assert.equal(revoke.disarmed, false);
    assert.ok(revoke.blockers.includes("DISARM_LEDGER_IDENTITY_CHANGED"),
      JSON.stringify(revoke.blockers));
    assert.equal(JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8")).armedReason,
      "DISPATCH_ACCEPTED");
    assert.equal(await lockReleased(root), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#27 B3 P1-C round 6 (P1-C-2): an undeclared arm over an ACTIVE ledger never poisons it — the PREPARED establishment re-arms the state A's legal disarm clobbered", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-round6-active-repair-"));
  try {
    const dir = await makeConversation(root, { "a-fast-state.json": armedState("DISPATCH_ACCEPTED") });
    await writeFile(join(dir, "a-dispatch-state.json"), JSON.stringify(
      dispatchRecord({ status: "ACCEPTED" })), "utf8");
    // B arms WITHOUT the declaration (the frozen send template aborts on any
    // in-flight ledger, so an undeclared arm cannot deliver): stamp null — the
    // ruling's self-re-arm trap is avoided by construction.
    const bArm = await armForDispatch(dir, { conversationUuid: uuid, space: "GDC-执行A" });
    assert.equal(bArm.armedReason, "DISPATCH_ACCEPTED");
    assert.equal(bArm.armedSupersededDispatchId, null);
    // A completes; its disarm commit converges through the tolerant no-stamp
    // path (legal: nothing in flight at commit time).
    const aCompleted = dispatchRecord({ status: "COMPLETED" });
    await writeFile(join(dir, "a-dispatch-state.json"), JSON.stringify(aCompleted));
    const receipt = await saveReply(dir, aCompleted, { text: "已消费回复", source: "DOM_BOUNDARY_VISIBLE" }, uuid);
    await acknowledgeReply(dir, aCompleted, receipt.sha256);
    const aDisarm = await disarmAfterRelease(dir, { rootMonitorDir: root, expectedDispatchId: uuid });
    assert.deepEqual(aDisarm, { disarmed: true, alreadyDisarmed: false, blockers: [] });
    // B's PREPARED establishment: the in-lock consistency repair re-arms the
    // DISARMED_IDLE state to DISPATCH_ACCEPTED in the same critical section
    // BEFORE the ledger lands — 布防先于投递 holds for the new dispatch.
    const prepared = await prepareDispatch({ monitorDir: dir, conversationUuid: uuid,
      taskSpace: "GDC-执行A", pageLabel: "p1", page: stubComposerPage(), payload: "新派单内容" });
    assert.equal(prepared.status, "PREPARED");
    const state = JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8"));
    assert.equal(state.armedReason, "DISPATCH_ACCEPTED");
    const events = await readFile(join(dir, "a-fast-events.ndjson"), "utf8");
    assert.match(events, /ARMED_DISPATCH_ACCEPTED.*PREPARED_REARM/);
    // A cannot revoke B's arm (its instance no longer owns the ledger).
    const revoke = await disarmAfterRelease(dir, { rootMonitorDir: root, expectedDispatchId: uuid });
    assert.equal(revoke.disarmed, false);
    assert.ok(revoke.blockers.includes("DISARM_LEDGER_IDENTITY_CHANGED"),
      JSON.stringify(revoke.blockers));
    assert.equal(JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8")).armedReason,
      "DISPATCH_ACCEPTED");
    assert.equal(await lockReleased(root), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#27 B3 P1-C round 6 (P1-C-3 ruling scenario): a sibling conversation's arm+PREPARED inside the scan→commit window keeps the old conversation armed (global root coordination)", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-round6-global-"));
  try {
    const dirA = await makeConversation(root, { "a-fast-state.json": armedState("DISPATCH_ACCEPTED") });
    await completedConsumed(dirA);
    const dirB = join(root, "conversations", otherUuid);
    await mkdir(dirB, { recursive: true });
    // A's advisory global scan just passed (no sibling in flight). The
    // injection window: sibling B — a DIFFERENT conversation — really arms
    // and really establishes its PREPARED ledger on the real filesystem,
    // serializing on the SAME monitor-root commit lock.
    let bDispatchId = null;
    const result = await disarmAfterRelease(dirA, {
      rootMonitorDir: root,
      expectedDispatchId: uuid,
      beforeCommit: async () => {
        await armForDispatch(dirB, { conversationUuid: otherUuid, space: "GDC-执行B" });
        const prepared = await prepareDispatch({ monitorDir: dirB, conversationUuid: otherUuid,
          taskSpace: "GDC-执行B", pageLabel: "p2", page: stubComposerPage(), payload: "兄弟派单" });
        bDispatchId = prepared.dispatchId;
      },
    });
    // The in-lock global re-scan sees B's in-flight PREPARED ledger: no disarm.
    assert.notEqual(bDispatchId, null);
    assert.deepEqual(result, { disarmed: false, alreadyDisarmed: false,
      blockers: ["OTHER_INFLIGHT_DISPATCH"] });
    await assertNoDisarmEvent(dirA);
    assert.equal(JSON.parse(await readFile(join(dirA, "a-fast-state.json"), "utf8")).armedReason,
      "DISPATCH_ACCEPTED");
    assert.equal(JSON.parse(await readFile(join(dirB, "a-fast-state.json"), "utf8")).armedReason,
      "DISPATCH_ACCEPTED");
    // Convergence: B settles (terminal + consumed), disarms through the same
    // coordinated lock; then A's expired scan no longer matters — its commit
    // re-scan proves the root has nothing in flight and converges.
    const bAccepted = JSON.parse(await readFile(join(dirB, "a-dispatch-state.json"), "utf8"));
    const bCompleted = { ...bAccepted, status: "COMPLETED" };
    await writeFile(join(dirB, "a-dispatch-state.json"), JSON.stringify(bCompleted));
    const receipt = await saveReply(dirB, bCompleted, { text: "兄弟已消费", source: "DOM_BOUNDARY_VISIBLE" }, otherUuid);
    await acknowledgeReply(dirB, bCompleted, receipt.sha256);
    const bDisarm = await disarmAfterRelease(dirB, { rootMonitorDir: root, expectedDispatchId: bDispatchId });
    assert.deepEqual(bDisarm, { disarmed: true, alreadyDisarmed: false, blockers: [] });
    const aDisarm = await disarmAfterRelease(dirA, { rootMonitorDir: root, expectedDispatchId: uuid });
    assert.deepEqual(aDisarm, { disarmed: true, alreadyDisarmed: false, blockers: [] });
    assert.equal(await lockReleased(root), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#27 B3 P1-C round 6 (P1-C-1 wiring): every participant's commit section re-verifies lock ownership immediately before its final state write", async () => {
  const manager = await readFile(
    fileURLToPath(new URL("../monitor/dispatch-manager.mjs", import.meta.url)), "utf8");
  const state = await readFile(
    fileURLToPath(new URL("../monitor/dispatch-state.mjs", import.meta.url)), "utf8");
  // armForDispatch: guard immediately before the fast-state write.
  const armSection = manager.slice(
    manager.indexOf("export async function armForDispatch"),
    manager.indexOf("// ---- #27 Batch 3 P1-B"));
  assert.match(armSection, /await guard\(\);\s*\n\s*await writeJsonAtomic\(fastStateFileOf\(dir\)/);
  // prepareDispatch: guard immediately before the PREPARED ledger write —
  // and before the P1-C-2 consistency re-arm write.
  const prepareSection = state.slice(
    state.indexOf("export async function prepareDispatch"),
    state.indexOf("async function transition("));
  assert.match(prepareSection, /await guard\(\);\s*\n\s*await writeJsonAtomic\(fileOf\(monitorDir\)/);
  assert.match(prepareSection, /await guard\(\);\s*\n\s*await writeJsonAtomic\(fastStatePath/);
  // disarmAfterRelease's serialized commit: guard immediately before the
  // DISARMED_IDLE write, after the global in-flight re-scan.
  const disarmSection = manager.slice(
    manager.indexOf("// ---- Serialized commit"),
    manager.indexOf("// ---- #27 Batch 3 (ruling §四.4)"));
  assert.match(disarmSection, /await guard\(\);\s*\n\s*await writeJsonAtomic\(fastStateFileOf\(dir\)/);
  assert.match(disarmSection, /countInFlightSiblings\(root, dir\)/);
  // COMMIT_LOCK_LOST joins the fail-closed lock error family every caller
  // maps through isCommitLockError.
  assert.equal(isCommitLockError(new Error("COMMIT_LOCK_LOST")), true);
  assert.equal(isCommitLockError(new Error("COMMIT_LOCK_WAIT_TIMEOUT")), true);
  assert.equal(isCommitLockError(new Error("COMMIT_LOCK_STALE")), true);
  assert.equal(isCommitLockError(new Error("OTHER_FAILURE")), false);
});

// ---- Requirement 4 (ruling §四.4): two page-label lifecycles ----
test("#27 B4 label lifecycles (P1-E): the durable ORIGIN record, never attribution or ledger status alone, decides fixed-session vs dispatch-temp", () => {
  const known = [uuid.toUpperCase()];
  // Ownership unproven: fixed-session, never touched by any cleanup.
  assert.deepEqual(classifyPageLabelLifecycle({ conversationUuid: otherUuid, known, ledgerStatus: "COMPLETED" }),
    { lifecycle: PAGE_LABEL_LIFECYCLE.FIXED_SESSION, closable: false, reason: "OWNERSHIP_UNPROVEN" });
  assert.deepEqual(classifyPageLabelLifecycle({ conversationUuid: null, known, ledgerStatus: null }),
    { lifecycle: PAGE_LABEL_LIFECYCLE.FIXED_SESSION, closable: false, reason: "OWNERSHIP_UNPROVEN" });
  // 归属 ≠ 生命周期: a REGISTERED fixed-session page stays fixed even with a
  // COMPLETED ledger — the planner's exact counterexample.
  assert.deepEqual(classifyPageLabelLifecycle({ conversationUuid: uuid, known, ledgerStatus: "COMPLETED", dispatchCreated: false }),
    { lifecycle: PAGE_LABEL_LIFECYCLE.FIXED_SESSION, closable: false, reason: "FIXED_SESSION_PAGE" });
  assert.deepEqual(classifyPageLabelLifecycle({ conversationUuid: uuid, known, ledgerStatus: "ABORTED", dispatchCreated: false }),
    { lifecycle: PAGE_LABEL_LIFECYCLE.FIXED_SESSION, closable: false, reason: "FIXED_SESSION_PAGE" });
  // Dispatch-created (anchored a-new-request.json) + terminal: temp, closable
  // through the shared release-sweep mechanism.
  assert.deepEqual(classifyPageLabelLifecycle({ conversationUuid: uuid, known, ledgerStatus: "COMPLETED", dispatchCreated: true }),
    { lifecycle: PAGE_LABEL_LIFECYCLE.DISPATCH_TEMP, closable: true, reason: "TEMP_RESULT_PAGE_FINISHED_DISPATCH" });
  assert.deepEqual(classifyPageLabelLifecycle({ conversationUuid: uuid, known, ledgerStatus: "ABORTED", dispatchCreated: true }),
    { lifecycle: PAGE_LABEL_LIFECYCLE.DISPATCH_TEMP, closable: true, reason: "TEMP_RESULT_PAGE_FINISHED_DISPATCH" });
  // Dispatch-created but still active / unproven: temp, not yet closable.
  assert.deepEqual(classifyPageLabelLifecycle({ conversationUuid: uuid, known, ledgerStatus: "ACCEPTED", dispatchCreated: true }),
    { lifecycle: PAGE_LABEL_LIFECYCLE.DISPATCH_TEMP, closable: false, reason: "ACTIVE_DISPATCH_LEDGER" });
  assert.deepEqual(classifyPageLabelLifecycle({ conversationUuid: uuid, known, ledgerStatus: null, dispatchCreated: true }),
    { lifecycle: PAGE_LABEL_LIFECYCLE.DISPATCH_TEMP, closable: false, reason: "LEDGER_UNPROVEN" });
});

test("#27 B4 label closing is exclusively the release mechanism: the probe holds no close call and the disarm path writes no close", async () => {
  for (const probeFile of ["ego-fast-probe.mjs", "ego-fast-probe-live.mjs"]) {
    const source = await readFile(
      fileURLToPath(new URL("../monitor/" + probeFile, import.meta.url)), "utf8");
    assert.doesNotMatch(source, /page\.close\(\)/, probeFile);
    assert.doesNotMatch(source, /armedReason: "DISARMED_IDLE"/, probeFile);
  }
  const manager = await readFile(
    fileURLToPath(new URL("../monitor/dispatch-manager.mjs", import.meta.url)), "utf8");
  // The disarm sequence routes label cleanup through releaseDelivered's
  // release template (the P1-A sweep), never a direct page close.
  assert.doesNotMatch(manager, /page\.close\(\)/);
  assert.match(manager, /DISARMED_IDLE/);
});
