// #27 Batch 3 (ruling §四, docs/planning/issue-27-ruling-20261116.md): the
// arm-on-wait machine at unit level — frozen four-state transition matrix,
// arm-before-delivery ordering, disarm criteria, legacy-ledger compatibility
// and the two page-label lifecycles. 11-scenario live acceptance and the
// 4-item resource comparison are a separate supervised phase (task brief).
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARMED_REASONS, IN_FLIGHT_DISPATCH_STATUSES, FAST_STATE_DEFAULTS,
  canTransitionArmedReason, armedTransitionPatch, armedReasonOnPeerGeneration,
  armedReasonOnProbeRound, classifyFastStateFile, normalizeFastState, validateFastState,
} from "../monitor/state-schema.mjs";
import { evaluateDisarmEligibility } from "../monitor/dispatch-state.mjs";
import {
  armForDispatch, disarmAfterRelease, classifyPageLabelLifecycle, PAGE_LABEL_LIFECYCLE,
  releaseDelivered,
} from "../monitor/dispatch-manager.mjs";
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

async function completedConsumed(dir) {
  const record = dispatchRecord();
  await writeFile(join(dir, "a-dispatch-state.json"), JSON.stringify(record));
  const receipt = await saveReply(dir, record, { text: "已消费回复", source: "DOM_BOUNDARY_VISIBLE" }, uuid);
  await acknowledgeReply(dir, record, receipt.sha256);
  return record;
}

test("#27 B3 disarmAfterRelease: satisfied criteria write DISARMED_IDLE after terminal confirmation (ruling order)", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-disarm-ok-"));
  try {
    const dir = await makeConversation(root, { "a-fast-state.json": armedState("PEER_GENERATING") });
    await completedConsumed(dir);
    const result = await disarmAfterRelease(dir, { rootMonitorDir: root });
    assert.deepEqual(result, { disarmed: true, alreadyDisarmed: false, blockers: [] });
    const state = JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8"));
    assert.equal(state.armedReason, "DISARMED_IDLE");
    assert.equal(validateFastState(state), true);
    const events = await readFile(join(dir, "a-fast-events.ndjson"), "utf8");
    assert.match(events, /DISARMED_IDLE/);
    // Idempotent: a repeat reports success without touching the state.
    const again = await disarmAfterRelease(dir, { rootMonitorDir: root });
    assert.deepEqual(again, { disarmed: true, alreadyDisarmed: true, blockers: [] });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#27 B3 disarmAfterRelease: every unmet criterion blocks and leaves the armed state untouched", async () => {
  const caseOf = async (name, mutate, expectBlocker) => {
    const root = await mkdtemp(join(tmpdir(), "ego-disarm-block-"));
    try {
      const dir = await makeConversation(root, { "a-fast-state.json": armedState("DISPATCH_ACCEPTED") });
      await mutate(dir, root);
      const result = await disarmAfterRelease(dir, { rootMonitorDir: root });
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

test("#27 B3 disarmAfterRelease: legacy arm fields are never auto-disarmed; ARMED_UNKNOWN may disarm on explicit confirmation", async () => {
  // Legacy ledger (no arm fields): refuses even with everything else satisfied.
  const legacyRoot = await mkdtemp(join(tmpdir(), "ego-disarm-legacy-"));
  try {
    const dir = await makeConversation(legacyRoot, {
      "a-fast-state.json": JSON.stringify({ schema: "ego-fast-state/v3", ts: 5 }),
    });
    await completedConsumed(dir);
    const result = await disarmAfterRelease(dir, { rootMonitorDir: legacyRoot });
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
    const result = await disarmAfterRelease(dir, { rootMonitorDir: unknownRoot });
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

// ---- Requirement 4 (ruling §四.4): two page-label lifecycles ----

test("#27 B4 label lifecycles: fixed-session labels are never closable; dispatch-temp labels close only on a provably terminal ledger", () => {
  const known = [uuid.toUpperCase()];
  // Ownership unproven: fixed-session, never touched by any cleanup.
  assert.deepEqual(classifyPageLabelLifecycle({ conversationUuid: otherUuid, known, ledgerStatus: "COMPLETED" }),
    { lifecycle: PAGE_LABEL_LIFECYCLE.FIXED_SESSION, closable: false, reason: "OWNERSHIP_UNPROVEN" });
  assert.deepEqual(classifyPageLabelLifecycle({ conversationUuid: null, known, ledgerStatus: null }),
    { lifecycle: PAGE_LABEL_LIFECYCLE.FIXED_SESSION, closable: false, reason: "OWNERSHIP_UNPROVEN" });
  // Known + terminal: dispatch-temp, closable through the shared release-sweep mechanism.
  assert.deepEqual(classifyPageLabelLifecycle({ conversationUuid: uuid, known, ledgerStatus: "COMPLETED" }),
    { lifecycle: PAGE_LABEL_LIFECYCLE.DISPATCH_TEMP, closable: true, reason: "TEMP_RESULT_PAGE_FINISHED_DISPATCH" });
  assert.deepEqual(classifyPageLabelLifecycle({ conversationUuid: uuid, known, ledgerStatus: "ABORTED" }),
    { lifecycle: PAGE_LABEL_LIFECYCLE.DISPATCH_TEMP, closable: true, reason: "TEMP_RESULT_PAGE_FINISHED_DISPATCH" });
  // Known + active ledger: temp but not yet closable.
  assert.deepEqual(classifyPageLabelLifecycle({ conversationUuid: uuid, known, ledgerStatus: "ACCEPTED" }),
    { lifecycle: PAGE_LABEL_LIFECYCLE.DISPATCH_TEMP, closable: false, reason: "ACTIVE_DISPATCH_LEDGER" });
  // Known but no provable ledger: conservative default keeps the label.
  assert.deepEqual(classifyPageLabelLifecycle({ conversationUuid: uuid, known, ledgerStatus: null }),
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
