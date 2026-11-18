// Wake-guard tests (agent-kit #25 gap 3, plan A): read-only anomaly detection,
// frozen injection format, PreToolUse deny coexistence, rate-limit ledger,
// Stop one-shot handoff, and installer idempotency for the Stop rule.
// Run under the repo-root `node --test` suite.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectWakeAnomalies, formatWakeContext, summarizeEvents, readMonitorRoots, parseLedger, injectionCooldownActive, stopCooldownActive, withInjection, withStopBlock, eventIdentity, selectWakeEvents, watchStaleExemption, readArmClaim, WATCH_STALE_EXEMPTION, ARM_STATE_CONFLICT_DETAIL, FAST_STATE_SCHEMA_V4 } from "../plugins/chatgpt-dispatch-guard/hooks/wake-context.mjs";
import { install, installConfig, verifyConfig } from "../monitor/install-zcode-guard.mjs";

const hooksDir = join(import.meta.dirname, "../plugins/chatgpt-dispatch-guard/hooks");
const realScript = join(hooksDir, "pre-tool-use.mjs");
const realStopScript = join(hooksDir, "stop.mjs");
const uuid = "11111111-1111-4111-8111-111111111111";
// Structured validation (WG-01) pins wakeId to a legal UUID, so fixtures use one.
const wakeUuid = "22222222-2222-4222-8222-222222222222";

const watchExit = (issuedAt, overrides = {}) => ({
  schema: "ego-watch-exit/v1", wakeId: wakeUuid, reason: "FAST_PROBE_WAKE_SUPERVISOR",
  issuedAt, exitCode: 2, acknowledgedAt: null, ackAction: null, ...overrides,
});
const supervisionStatus = (pending, overrides = {}) => ({
  schema: "ego-supervision/v1", generationKey: null, progressAt: 0, abnormalRounds: 0, lastReviewAt: 0, pending, ...overrides,
});
const dispatchRecord = (createdAt, overrides = {}) => ({
  schema: "ego-dispatch-state/v2", dispatchId: "dispatch-1", conversationUuid: uuid,
  taskSpace: "Space A", pageLabel: "w1", status: "ACCEPTED", baselineTailRole: null,
  baselineTailKey: null, baselineComposerLength: 0, attempt: 1, createdAt,
  payload_sha256: null, payload_bytes: null, composer_baseline: null, ...overrides,
});

async function makeRoot(now, files = {}) {
  const root = await mkdtemp(join(tmpdir(), "ego-wake-root-"));
  const dir = join(root, "conversations", uuid);
  await mkdir(dir, { recursive: true });
  const write = async (name, value) => {
    await writeFile(join(dir, name), typeof value === "string" ? value : JSON.stringify(value), "utf8");
  };
  for (const [name, value] of Object.entries(files)) {
    if (value !== undefined) await write(name, value);
  }
  return { root, dir, write };
}

const run = (name, payload, env = {}) => spawnSync(process.execPath, [join(hooksDir, name)], {
  input: typeof payload === "string" ? payload : JSON.stringify(payload),
  encoding: "utf8", env: { ...process.env, ...env },
});

const profileWith = async (dir, roots) => writeFile(join(dir, "ego-profile.json"), JSON.stringify({ monitorRoots: roots }), "utf8");

test("WAKE_PENDING: un-acked watch exit reports immediately with age", async () => {
  const now = 1_800_000_000_000;
  const { root, write } = await makeRoot(now, { "a-watch-exit.json": watchExit(now - 181_000) });
  const { healthy, events } = await detectWakeAnomalies([root], now);
  assert.equal(healthy, false);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "WAKE_PENDING");
  assert.equal(events[0].wakeId, wakeUuid);
  assert.equal(events[0].reason, "FAST_PROBE_WAKE_SUPERVISOR");
  assert.equal(events[0].ageMs, 181_000);
  await rm(root, { recursive: true, force: true });
});

test("WAKE_PENDING: acknowledged exit produces no event (history is kept, not re-raised)", async () => {
  const now = 1_800_000_000_000;
  const { root } = await makeRoot(now, {
    "a-watch-exit.json": watchExit(now - 500_000, { acknowledgedAt: now - 100_000, ackAction: "investigated" }),
  });
  const { healthy, events } = await detectWakeAnomalies([root], now);
  assert.equal(healthy, true);
  assert.deepEqual(events, []);
  await rm(root, { recursive: true, force: true });
});

test("SUPERVISION_PENDING: 59s silence, 60s/61s report", async () => {
  const now = 1_800_000_000_000;
  for (const [age, expect] of [[59_000, false], [60_000, true], [61_000, true]]) {
    const { root, write } = await makeRoot(now);
    await write("a-supervision-status.json", supervisionStatus({ id: "sup-1", reason: "NO_SUBSTANTIVE_PROGRESS", issuedAt: now - age }));
    const { healthy, events } = await detectWakeAnomalies([root], now);
    assert.equal(healthy, !expect, `age=${age}`);
    if (expect) {
      assert.equal(events[0].type, "SUPERVISION_PENDING");
      assert.equal(events[0].wakeId, "sup-1");
      assert.equal(events[0].ageMs, age);
    } else assert.deepEqual(events, []);
    await rm(root, { recursive: true, force: true });
  }
});

test("WATCH_STALE: 7-minute boundary on both fast state and dispatch record", async () => {
  const now = 1_800_000_000_000;
  // Just-dispatched protection: record younger than 7min -> no event even with missing fast state.
  {
    const { root } = await makeRoot(now, {
      "a-dispatch-state.json": dispatchRecord(now - 6 * 60_000),
    });
    const { healthy, events } = await detectWakeAnomalies([root], now);
    assert.equal(healthy, true);
    assert.deepEqual(events, []);
    await rm(root, { recursive: true, force: true });
  }
  // Fresh fast state suppresses the event even if the record is old.
  {
    const { root } = await makeRoot(now, {
      "a-dispatch-state.json": dispatchRecord(now - 60 * 60_000),
      "a-fast-state.json": { ts: now - 60_000 },
    });
    const { healthy, events } = await detectWakeAnomalies([root], now);
    assert.equal(healthy, true);
    assert.deepEqual(events, []);
    await rm(root, { recursive: true, force: true });
  }
  // Both stale -> WATCH_STALE (fast state exactly 7min: still fresh at ==; stale past it).
  {
    const { root } = await makeRoot(now, {
      "a-dispatch-state.json": dispatchRecord(now - 8 * 60_000),
      "a-fast-state.json": { ts: now - 7 * 60_000 - 1 },
    });
    const { healthy, events } = await detectWakeAnomalies([root], now);
    assert.equal(healthy, false);
    assert.equal(events[0].type, "WATCH_STALE");
    assert.equal(events[0].dispatchStatus, "ACCEPTED");
    assert.equal(events[0].fastStateAgeMs, 7 * 60_000 + 1);
    await rm(root, { recursive: true, force: true });
  }
});

test("terminal or missing dispatch records never raise events", async () => {
  const now = 1_800_000_000_000;
  for (const status of ["COMPLETED", "ABORTED", "RELEASED"]) {
    const { root } = await makeRoot(now, {
      "a-dispatch-state.json": dispatchRecord(now - 3 * 60 * 60_000, { status }),
      "a-fast-state.json": { ts: now - 3 * 60 * 60_000 },
    });
    const { healthy, events } = await detectWakeAnomalies([root], now);
    assert.equal(healthy, true, status);
    assert.deepEqual(events, []);
    await rm(root, { recursive: true, force: true });
  }
  {
    const { root } = await makeRoot(now, { "a-fast-state.json": { ts: now - 3 * 60 * 60_000 } });
    const { healthy, events } = await detectWakeAnomalies([root], now);
    assert.equal(healthy, true);
    assert.deepEqual(events, []);
    await rm(root, { recursive: true, force: true });
  }
});

test("corrupt key state JSON yields WAKE_STATUS_UNKNOWN, never health", async () => {
  const now = 1_800_000_000_000;
  for (const [files, expectUnknown] of [
    [{ "a-watch-exit.json": "{not json" }, true],
    [{ "a-dispatch-state.json": "{not json" }, true],
    [{ "a-supervision-status.json": "{not json" }, true],
    [{ "a-dispatch-state.json": dispatchRecord(now - 60 * 60_000), "a-fast-state.json": "{not json" }, true],
  ]) {
    const { root } = await makeRoot(now, files);
    const { healthy, events } = await detectWakeAnomalies([root], now);
    assert.equal(healthy, false);
    assert.equal(events[0]?.type, "WAKE_STATUS_UNKNOWN");
    assert.equal(expectUnknown, true);
    await rm(root, { recursive: true, force: true });
  }
});

test("detection never throws: only ENOENT roots/files are absence, other failures are UNKNOWN", async () => {
  const now = 1_800_000_000_000;
  const { root } = await makeRoot(now); // empty conversations dir
  // WG-01A: a monitorRoot that does not exist at all is UNKNOWN, never health —
  // ENOENT on the root cannot be distinguished from an unplugged/renamed root.
  const missing = await detectWakeAnomalies([join(root, "missing")], now);
  assert.equal(missing.healthy, false);
  assert.equal(missing.events.length, 1);
  assert.equal(missing.events[0].type, "WAKE_STATUS_UNKNOWN");
  assert.equal(missing.events[0].detail, "ENOENT");
  // WG-01A: a root that exists but has no conversations directory yet IS the
  // benign empty state and stays healthy.
  const bareRoot = await mkdtemp(join(tmpdir(), "ego-wake-bare-"));
  const benign = await detectWakeAnomalies([bareRoot], now);
  assert.equal(benign.healthy, true);
  assert.deepEqual(benign.events, []);
  await rm(bareRoot, { recursive: true, force: true });
  // A root that cannot be read at all is UNKNOWN, never health (WG-01).
  const failing = { readdir: async () => { throw new Error("boom"); }, readFile: async () => { throw new Error("boom"); } };
  const broken = await detectWakeAnomalies(["C:/whatever"], now, failing);
  assert.equal(broken.healthy, false);
  assert.equal(broken.events.length, 1);
  assert.equal(broken.events[0].type, "WAKE_STATUS_UNKNOWN");
  assert.equal(broken.events[0].source, "C:/whatever");
  // Unreadable key-state files (non-ENOENT readFile failure) are UNKNOWN too.
  const unreadable = {
    readdir: async () => [{ isDirectory: () => true, name: uuid }],
    readFile: async () => { const error = new Error("EIO"); error.code = "EIO"; throw error; },
  };
  const blockedFiles = await detectWakeAnomalies(["C:/whatever"], now, unreadable);
  assert.equal(blockedFiles.healthy, false);
  // One UNKNOWN per unreadable key-state file (watch-exit, supervision, dispatch).
  assert.deepEqual(blockedFiles.events.map((e) => [e.type, e.detail]),
    [["WAKE_STATUS_UNKNOWN", "EIO"], ["WAKE_STATUS_UNKNOWN", "EIO"], ["WAKE_STATUS_UNKNOWN", "EIO"]]);
  await rm(root, { recursive: true, force: true });
});

test("monitorRoot permission denied (EACCES readdir) yields WAKE_STATUS_UNKNOWN, never health", async () => {
  const now = 1_800_000_000_000;
  const denied = {
    readdir: async () => { const error = new Error("denied"); error.code = "EACCES"; throw error; },
    readFile: async () => { throw new Error("not reached"); },
  };
  const { healthy, events } = await detectWakeAnomalies(["C:/guarded-root"], now, denied);
  assert.equal(healthy, false);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "WAKE_STATUS_UNKNOWN");
  assert.equal(events[0].detail, "EACCES");
  // The failing root itself is named, not its conversations subdirectory.
  assert.equal(events[0].source, "C:/guarded-root");
});

test("root readable but conversations unreadable (non-ENOENT) is UNKNOWN, not benign", async () => {
  const now = 1_800_000_000_000;
  const mixed = {
    async readdir(path) {
      if (String(path).endsWith("conversations")) { const e = new Error("EACCES"); e.code = "EACCES"; throw e; }
      return readdir(path, { withFileTypes: true });
    },
    readFile,
  };
  const root = await mkdtemp(join(tmpdir(), "ego-wake-conv-eacces-"));
  try {
    const { healthy, events } = await detectWakeAnomalies([root], now, mixed);
    assert.equal(healthy, false);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "WAKE_STATUS_UNKNOWN");
    assert.equal(events[0].detail, "EACCES");
    assert.match(events[0].source, /conversations$/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("one failing monitorRoot does not mask detection on the remaining roots", async () => {
  const now = 1_800_000_000_000;
  const { root } = await makeRoot(now, { "a-watch-exit.json": watchExit(now - 181_000) });
  const { healthy, events } = await detectWakeAnomalies(["C:/guarded-root", root], now, {
    async readdir(path) {
      if (String(path).includes("guarded-root")) { const e = new Error("denied"); e.code = "EACCES"; throw e; }
      return readdir(path, { withFileTypes: true });
    },
    readFile,
  });
  assert.equal(healthy, false);
  assert.equal(events.some((e) => e.type === "WAKE_STATUS_UNKNOWN" && e.detail === "EACCES"), true);
  assert.equal(events.some((e) => e.type === "WAKE_PENDING" && e.wakeId === wakeUuid), true);
  await rm(root, { recursive: true, force: true });
});

test("structurally invalid state files violate their contract and yield WAKE_STATUS_UNKNOWN", async () => {
  const now = 1_800_000_000_000;
  const cases = [
    // watch-exit: wrong schema, junk wakeId, bad issuedAt, wrong exitCode, illegal ack combos.
    [{ "a-watch-exit.json": watchExit(now - 181_000, { schema: "ego-watch-exit/v9" }) }, "WATCH_EXIT_SCHEMA_INVALID"],
    [{ "a-watch-exit.json": watchExit(now - 181_000, { wakeId: "wake-1" }) }, "WATCH_EXIT_WAKE_ID_INVALID"],
    [{ "a-watch-exit.json": watchExit(now - 181_000, { issuedAt: "yesterday" }) }, "WATCH_EXIT_ISSUED_AT_INVALID"],
    [{ "a-watch-exit.json": watchExit(now - 181_000, { exitCode: 0 }) }, "WATCH_EXIT_EXIT_CODE_INVALID"],
    [{ "a-watch-exit.json": watchExit(now - 181_000, { acknowledgedAt: now - 1, ackAction: null }) }, "WATCH_EXIT_ACK_COMBINATION_INVALID"],
    [{ "a-watch-exit.json": watchExit(now - 181_000, { acknowledgedAt: null, ackAction: "resolved" }) }, "WATCH_EXIT_ACK_COMBINATION_INVALID"],
    [{ "a-watch-exit.json": watchExit(now - 181_000, { acknowledgedAt: now - 1, ackAction: "bogus" }) }, "WATCH_EXIT_ACK_COMBINATION_INVALID"],
    [{ "a-watch-exit.json": {} }, "WATCH_EXIT_SCHEMA_INVALID"],
    // supervision-status: wrong schema, junk pending id or issuedAt.
    [{ "a-supervision-status.json": supervisionStatus({ id: "sup-1", reason: "R", issuedAt: now - 61_000 }, { schema: "ego-supervision/v9" }) }, "SUPERVISION_SCHEMA_INVALID"],
    [{ "a-supervision-status.json": supervisionStatus({ id: "", reason: "R", issuedAt: now - 61_000 }) }, "SUPERVISION_PENDING_ID_INVALID"],
    [{ "a-supervision-status.json": supervisionStatus({ id: "sup-1", reason: "R", issuedAt: "old" }) }, "SUPERVISION_PENDING_ISSUED_AT_INVALID"],
    // dispatch-state: wrong schema, empty status, non-finite timestamps.
    [{ "a-dispatch-state.json": dispatchRecord(now - 60 * 60_000, { schema: "ego-dispatch-state/v1" }) }, "DISPATCH_SCHEMA_INVALID"],
    [{ "a-dispatch-state.json": dispatchRecord(now - 60 * 60_000, { status: "" }) }, "DISPATCH_STATUS_INVALID"],
    [{ "a-dispatch-state.json": dispatchRecord(now - 60 * 60_000, { updatedAt: "later" }) }, "DISPATCH_UPDATED_AT_INVALID"],
    [{ "a-dispatch-state.json": dispatchRecord("early") }, "DISPATCH_CREATED_AT_INVALID"],
    // WG-01B: supervision ledgers missing the loadStatus() required fields.
    [{ "a-supervision-status.json": supervisionStatus(null, { abnormalRounds: undefined }) }, "SUPERVISION_ABNORMAL_ROUNDS_INVALID"],
    [{ "a-supervision-status.json": supervisionStatus(null, { abnormalRounds: -1 }) }, "SUPERVISION_ABNORMAL_ROUNDS_INVALID"],
    [{ "a-supervision-status.json": supervisionStatus(null, { abnormalRounds: 1.5 }) }, "SUPERVISION_ABNORMAL_ROUNDS_INVALID"],
    [{ "a-supervision-status.json": supervisionStatus(null, { progressAt: undefined }) }, "SUPERVISION_PROGRESS_AT_INVALID"],
    [{ "a-supervision-status.json": supervisionStatus(null, { progressAt: "now" }) }, "SUPERVISION_PROGRESS_AT_INVALID"],
    [{ "a-supervision-status.json": supervisionStatus(null, { lastReviewAt: undefined }) }, "SUPERVISION_LAST_REVIEW_AT_INVALID"],
    [{ "a-supervision-status.json": supervisionStatus(null, { lastReviewAt: "never" }) }, "SUPERVISION_LAST_REVIEW_AT_INVALID"],
    [{ "a-supervision-status.json": { schema: "ego-supervision/v1", abnormalRounds: 0, progressAt: 0, lastReviewAt: 0 } }, "SUPERVISION_PENDING_MISSING"],
    // WG-01C: structurally incomplete terminal dispatch ledgers are corruption,
    // never silently healthy.
    [{ "a-dispatch-state.json": dispatchRecord(now - 60 * 60_000, { status: "COMPLETED", createdAt: undefined }) }, "DISPATCH_CREATED_AT_INVALID"],
    [{ "a-dispatch-state.json": dispatchRecord(now - 60 * 60_000, { status: "COMPLETED", dispatchId: undefined }) }, "DISPATCH_ID_INVALID"],
    [{ "a-dispatch-state.json": dispatchRecord(now - 60 * 60_000, { status: "COMPLETED", dispatchId: 7 }) }, "DISPATCH_ID_INVALID"],
    [{ "a-dispatch-state.json": dispatchRecord(now - 60 * 60_000, { status: "COMPLETED", pageLabel: undefined }) }, "DISPATCH_PAGE_LABEL_INVALID"],
    [{ "a-dispatch-state.json": dispatchRecord(now - 60 * 60_000, { status: "COMPLETED", taskSpace: undefined }) }, "DISPATCH_TASKSPACE_INVALID"],
    [{ "a-dispatch-state.json": dispatchRecord(now - 60 * 60_000, { status: "COMPLETED", conversationUuid: undefined }) }, "DISPATCH_CONVERSATION_INVALID"],
    [{ "a-dispatch-state.json": dispatchRecord(now - 60 * 60_000, { status: "COMPLETED", attempt: 0 }) }, "DISPATCH_ATTEMPT_INVALID"],
    [{ "a-dispatch-state.json": dispatchRecord(now - 60 * 60_000, { status: "COMPLETED", attempt: 0.5 }) }, "DISPATCH_ATTEMPT_INVALID"],
    [{ "a-dispatch-state.json": dispatchRecord(now - 60 * 60_000, { status: "COMPLETED", baselineComposerLength: -1 }) }, "DISPATCH_BASELINE_LENGTH_INVALID"],
    [{ "a-dispatch-state.json": dispatchRecord(now - 60 * 60_000, { status: "COMPLETED", baselineTailRole: 5 }) }, "DISPATCH_BASELINE_ROLE_INVALID"],
    [{ "a-dispatch-state.json": dispatchRecord(now - 60 * 60_000, { status: "COMPLETED", baselineTailKey: 5 }) }, "DISPATCH_BASELINE_KEY_INVALID"],
    // Optional-field type contract, verbatim from validateDispatchRecord():
    // null/undefined is legal, any other wrong type is corruption.
    [{ "a-dispatch-state.json": dispatchRecord(now - 60 * 60_000, { status: "COMPLETED", payload_sha256: 123 }) }, "DISPATCH_PAYLOAD_SHA_INVALID"],
    [{ "a-dispatch-state.json": dispatchRecord(now - 60 * 60_000, { status: "COMPLETED", payload_bytes: "invalid" }) }, "DISPATCH_PAYLOAD_BYTES_INVALID"],
    [{ "a-dispatch-state.json": dispatchRecord(now - 60 * 60_000, { status: "COMPLETED", composer_baseline: 123 }) }, "DISPATCH_COMPOSER_BASELINE_INVALID"],
  ];
  for (const [files, expectedDetail] of cases) {
    const { root } = await makeRoot(now, files);
    const { healthy, events } = await detectWakeAnomalies([root], now);
    assert.equal(healthy, false, expectedDetail);
    assert.equal(events.length, 1, expectedDetail);
    assert.equal(events[0].type, "WAKE_STATUS_UNKNOWN", expectedDetail);
    assert.equal(events[0].detail, expectedDetail, expectedDetail);
    await rm(root, { recursive: true, force: true });
  }
});

test("optional dispatch ledger fields: null and absent both pass validation with no events", async () => {
  const now = 1_800_000_000_000;
  // The writer's normal shape carries the optional fields as null -> healthy.
  {
    const { root } = await makeRoot(now, {
      "a-dispatch-state.json": dispatchRecord(now - 60 * 60_000, { status: "COMPLETED" }),
    });
    const { healthy, events } = await detectWakeAnomalies([root], now);
    assert.equal(healthy, true);
    assert.deepEqual(events, []);
    await rm(root, { recursive: true, force: true });
  }
  // Older ledgers without the optional keys at all are equally valid.
  {
    const record = dispatchRecord(now - 60 * 60_000, { status: "COMPLETED" });
    delete record.payload_sha256;
    delete record.payload_bytes;
    delete record.composer_baseline;
    const { root } = await makeRoot(now, { "a-dispatch-state.json": record });
    const { healthy, events } = await detectWakeAnomalies([root], now);
    assert.equal(healthy, true);
    assert.deepEqual(events, []);
    await rm(root, { recursive: true, force: true });
  }
});

test("injection format: frozen header, action mapping, 3-event cap with additional count, healthy zero output", () => {
  assert.equal(formatWakeContext([]), null);
  assert.equal(formatWakeContext(null), null);
  const events = [
    { type: "WAKE_PENDING", wakeId: "w1", reason: "FAST_PROBE_WAKE_SUPERVISOR", ageMs: 181_000, key: "wake:w1" },
    { type: "SUPERVISION_PENDING", wakeId: "s1", reason: "NO_SUBSTANTIVE_PROGRESS", ageMs: 90_000, key: "wake:s1" },
    { type: "WATCH_STALE", dispatchStatus: "ACCEPTED", fastStateAgeMs: 3 * 60 * 60_000, ageMs: null, key: "stale:d1" },
    { type: "WAKE_STATUS_UNKNOWN", key: "unknown:x" },
    { type: "WAKE_PENDING", wakeId: "w2", reason: "REPLY_STAGED_WAKE_SUPERVISOR", ageMs: 5_000, key: "wake:w2" },
  ];
  const context = formatWakeContext(events);
  const lines = context.split("\n");
  assert.equal(lines[0], "[AGENT_KIT_WAKE_GUARD]");
  assert.match(context, /state=WAKE_PENDING\nwakeId=w1\nreason=FAST_PROBE_WAKE_SUPERVISOR\nage=181s\naction=INSPECT_AND_ACK_REQUIRED/);
  assert.match(context, /state=SUPERVISION_PENDING[\s\S]*action=INSPECT_AND_ACK_REQUIRED/);
  assert.match(context, /state=WATCH_STALE\ndispatch=ACCEPTED\nfastStateAge=3h\naction=REARM_WATCH_AND_VERIFY/);
  assert.doesNotMatch(context, /wakeId=w2/); // capped at 3 events
  assert.equal(lines.at(-1), "additional=2 suppressed by cap");
  // The 4th event is beyond the cap; its shape is checked on its own.
  assert.equal(formatWakeContext([events[3]]), "[AGENT_KIT_WAKE_GUARD]\nstate=WAKE_STATUS_UNKNOWN\naction=INSPECT_MONITOR_STATE");
  assert.equal(summarizeEvents(events).split("; ").length, 3);
  assert.match(summarizeEvents(events), /\(\+2 more\)/);
});

test("monitorRoots config: missing, empty or junk disables detection (config gap, not health)", () => {
  assert.deepEqual(readMonitorRoots({}), []);
  assert.deepEqual(readMonitorRoots({ monitorRoots: [] }), []);
  assert.deepEqual(readMonitorRoots(undefined), []);
  assert.deepEqual(readMonitorRoots({ monitorRoots: ["C:/m", " ", 42] }), ["C:/m"]);
});

test("ledger: 60s injection cooldown and 90s session-scoped stop cooldown arithmetic", () => {
  const now = 1_800_000_000_000;
  const ledger = withStopBlock(withInjection(parseLedger(null), "s1:wake-1", now), "s1", now);
  assert.equal(injectionCooldownActive(ledger, "s1:wake-1", now + 59_999), true);
  assert.equal(injectionCooldownActive(ledger, "s1:wake-1", now + 60_000), false);
  assert.equal(injectionCooldownActive(ledger, "s2:wake-1", now + 1), false); // other session
  assert.equal(stopCooldownActive(ledger, "s1", now + 89_999), true);
  assert.equal(stopCooldownActive(ledger, "s1", now + 90_000), false);
  assert.equal(stopCooldownActive(ledger, "s2", now + 1), false); // other session: never suppressed
  const reparsed = parseLedger(JSON.stringify(ledger));
  assert.equal(reparsed.schema, "ego-wake-guard-state/v1");
  assert.deepEqual(reparsed.stopBlocks, { s1: now });
  assert.throws(() => parseLedger('{"schema":"other/v9"}'), /WAKE_GUARD_LEDGER_INVALID/);
});

test("ledger: legacy global stopBlockAt migrates to the \"global\" session key only", () => {
  const now = 1_800_000_000_000;
  const legacy = JSON.stringify({ schema: "ego-wake-guard-state/v1", injections: {}, stopBlockAt: now });
  const parsed = parseLedger(legacy);
  assert.deepEqual(parsed.stopBlocks, { global: now });
  // Named sessions are independent of the migrated global cooldown.
  assert.equal(stopCooldownActive(parsed, "global", now + 1), true);
  assert.equal(stopCooldownActive(parsed, "sess-1", now + 1), false);
});

// ---- #27 observation A (Batch 1): per-event cooldown, in-batch dedup,
// display cap, cross-root isolation. Ruling acceptance steps a–f plus the cap. ----

const wakeA = "33333333-3333-4333-8333-333333333333";
const wakeB = "44444444-4444-4444-8444-444444444444";
const wakeC = "55555555-5555-4555-8555-555555555555";
const wakeD = "66666666-6666-4666-8666-666666666666";

test("#27 A identity key: type + wakeId + monitorRoot; source fallback isolates roots", () => {
  const root = "C:/monitor-a";
  const wake = { type: "WAKE_PENDING", wakeId: wakeA, source: root + "/conversations/x", monitorRoot: root };
  assert.equal(eventIdentity(wake), "WAKE_PENDING:" + wakeA + ":" + root);
  // Same wakeId under a different monitorRoot is a DIFFERENT identity (step f).
  assert.notEqual(eventIdentity(wake), eventIdentity({ ...wake, monitorRoot: "C:/monitor-b" }));
  // Unknown events have no wakeId: the stable source path is the identity, and
  // it embeds the root, so two roots' UNKNOWN events never collide.
  const unknown = { type: "WAKE_STATUS_UNKNOWN", wakeId: null, source: root + "/conversations/x/a-watch-exit.json", monitorRoot: root };
  assert.equal(eventIdentity(unknown), "WAKE_STATUS_UNKNOWN:" + unknown.source + ":" + root);
  assert.notEqual(eventIdentity(unknown), eventIdentity({ ...unknown, source: "C:/monitor-b/conversations/x/a-watch-exit.json", monitorRoot: "C:/monitor-b" }));
  // Same source, different type: never the same identity.
  assert.notEqual(eventIdentity(wake), eventIdentity({ ...wake, type: "WATCH_STALE" }));
});

test("#27 A ruling six steps: per-event cooldown, in-batch dedup, cross-root isolation", async () => {
  const t0 = 1_800_000_000_000;
  const roots = [];
  const conv = async (root, name, wakeId) => {
    const dir = join(root, "conversations", name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a-watch-exit.json"),
      JSON.stringify(watchExit(t0 - 181_000, { wakeId })), "utf8");
  };
  const newRoot = async (prefix) => {
    const root = await mkdtemp(join(tmpdir(), prefix));
    roots.push(root);
    return root;
  };
  try {
    const root1 = await newRoot("ego-wake-six-r1-");
    let ledger = parseLedger(null);
    const detect = (list) => detectWakeAnomalies(list, t0 + 0);
    const select = (events, at) => selectWakeEvents(events, ledger, "sess-6", at);
    const stamp = (result, at) => { for (const { key } of result.shown) ledger = withInjection(ledger, key, at); };

    // a. A first appearance -> injected.
    await conv(root1, "conv-a", wakeA);
    const a = select((await detect([root1])).events, t0);
    assert.deepEqual(a.shown.map(({ event }) => event.wakeId), [wakeA]);
    assert.equal(a.additional, 0);
    stamp(a, t0);

    // b. A repeats within 60s -> suppressed (by A's own cooldown only).
    assert.deepEqual(select((await detect([root1])).events, t0 + 30_000).shown, []);

    // c. While A cools, new event B appears in the same batch -> A suppressed,
    //    B injected (the whole-block suppression is abolished).
    await conv(root1, "conv-b", wakeB);
    const c = select((await detect([root1])).events, t0 + 40_000);
    assert.deepEqual(c.shown.map(({ event }) => event.wakeId), [wakeB]);
    stamp(c, t0 + 40_000);

    // d. A and B duplicated within one batch (same wakeId, same root, two
    //    conversation dirs) -> in-batch dedup: each identity appears once.
    //    Both cooldowns have now expired (A stamped at t0, B at t0+40s; 101s
    //    elapsed), so both identities are fresh again.
    await conv(root1, "conv-a2", wakeA);
    await conv(root1, "conv-b2", wakeB);
    const d = select((await detect([root1])).events, t0 + 101_000);
    assert.deepEqual(d.shown.map(({ event }) => event.wakeId).sort(), [wakeA, wakeB].sort());
    stamp(d, t0 + 101_000);

    // e. Repeating B -> suppressed by B's OWN cooldown period (A likewise).
    assert.deepEqual(select((await detect([root1])).events, t0 + 102_000).shown, []);

    // f. UNKNOWN events of different monitorRoots never mask each other.
    const root2 = await newRoot("ego-wake-six-r2-");
    const root3 = await newRoot("ego-wake-six-r3-");
    const root4 = await newRoot("ego-wake-six-r4-");
    for (const root of [root2, root3, root4]) {
      const dir = join(root, "conversations", uuid);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "a-watch-exit.json"), "{corrupted", "utf8");
    }
    ledger = parseLedger(null); // fresh ledger for the isolation check
    const both = select((await detect([root2, root3])).events, t0);
    assert.equal(both.shown.length, 2); // each root's UNKNOWN shown independently
    assert.deepEqual(new Set(both.shown.map(({ event }) => event.monitorRoot)), new Set([root2, root3]));
    stamp(both, t0);
    assert.deepEqual(select((await detect([root2, root3])).events, t0 + 1_000).shown, []);
    // A third root's new UNKNOWN is not masked by the cooled ones.
    const third = select((await detect([root2, root3, root4])).events, t0 + 2_000);
    assert.equal(third.shown.length, 1);
    assert.equal(third.shown[0].event.monitorRoot, root4);
  } finally {
    for (const root of roots) await rm(root, { recursive: true, force: true });
  }
});

test("#27 A display cap: 4 fresh events show 3 + additional count; the capped tail stays eligible", async () => {
  const t0 = 1_800_000_000_000;
  const root = await mkdtemp(join(tmpdir(), "ego-wake-cap-"));
  try {
    for (const [name, wakeId] of [["c1", wakeA], ["c2", wakeB], ["c3", wakeC], ["c4", wakeD]]) {
      const dir = join(root, "conversations", name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "a-watch-exit.json"),
        JSON.stringify(watchExit(t0 - 181_000, { wakeId })), "utf8");
    }
    const { events } = await detectWakeAnomalies([root], t0);
    assert.equal(events.length, 4);
    let ledger = parseLedger(null);
    const first = selectWakeEvents(events, ledger, "sess-cap", t0);
    assert.equal(first.shown.length, 3);
    assert.equal(first.additional, 1);
    const shown1 = first.shown.map(({ event }) => event.wakeId).sort();
    const context = formatWakeContext(first.shown.map(({ event }) => event), 3, first.additional);
    assert.equal(context.split("\n").at(-1), "additional=1 suppressed by cap");
    for (const { key } of first.shown) ledger = withInjection(ledger, key, t0);
    // Second batch: the three shown events are cooled; the capped 4th was
    // never displayed (hence never stamped) and now surfaces on its own.
    const second = selectWakeEvents(events, ledger, "sess-cap", t0 + 1_000);
    assert.equal(second.shown.length, 1);
    assert.equal(second.additional, 0);
    assert.deepEqual([...shown1, second.shown[0].event.wakeId].sort(),
      [wakeA, wakeB, wakeC, wakeD].sort());
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#27 A hook integration: cooled event no longer swallows a new batch-mate", async () => {
  const now = 1_800_000_000_000;
  const { root } = await makeRoot(now, { "a-watch-exit.json": watchExit(now - 181_000) });
  const home = await mkdtemp(join(tmpdir(), "ego-wake-home7-"));
  await profileWith(home, [root]);
  const env = { EGO_WAKE_GUARD_PROFILE_PATH: join(home, "ego-profile.json"), EGO_WAKE_GUARD_LEDGER_PATH: join(home, "ledger.json") };
  const ev = { hookEventName: "PreToolUse", toolName: "Read", toolInput: {}, sessionId: "sess-abc" };
  try {
    // a. A injected.
    const first = run("pre-tool-use.mjs", ev, env);
    const ctx1 = JSON.parse(first.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx1, new RegExp("wakeId=" + wakeUuid));
    // b. A repeat within 60s -> suppressed.
    assert.equal(run("pre-tool-use.mjs", ev, env).stdout, "");
    // c. New event B in the same batch -> B injected while A stays suppressed.
    const dirB = join(root, "conversations", "conv-b");
    await mkdir(dirB, { recursive: true });
    await writeFile(join(dirB, "a-watch-exit.json"),
      JSON.stringify(watchExit(now - 181_000, { wakeId: wakeB })), "utf8");
    const third = run("pre-tool-use.mjs", ev, env);
    const ctx3 = JSON.parse(third.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx3, new RegExp("wakeId=" + wakeB));
    assert.doesNotMatch(ctx3, new RegExp("wakeId=" + wakeUuid));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("#27 A hook integration: duplicate identity within one batch shows exactly once", async () => {
  const now = 1_800_000_000_000;
  const { root } = await makeRoot(now, { "a-watch-exit.json": watchExit(now - 181_000, { wakeId: wakeB }) });
  // A second conversation dir carrying the SAME wakeId under the SAME root:
  // identical identity -> deduped inside the block.
  const dir2 = join(root, "conversations", "conv-b2");
  await mkdir(dir2, { recursive: true });
  await writeFile(join(dir2, "a-watch-exit.json"),
    JSON.stringify(watchExit(now - 181_000, { wakeId: wakeB })), "utf8");
  const home = await mkdtemp(join(tmpdir(), "ego-wake-home8-"));
  await profileWith(home, [root]);
  const env = { EGO_WAKE_GUARD_PROFILE_PATH: join(home, "ego-profile.json"), EGO_WAKE_GUARD_LEDGER_PATH: join(home, "ledger.json") };
  try {
    const result = run("pre-tool-use.mjs", { hookEventName: "PreToolUse", toolName: "Read", toolInput: {}, sessionId: "sess-dedup" }, env);
    const ctx = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    assert.equal((ctx.match(new RegExp("wakeId=" + wakeB, "g")) || []).length, 1);
    // Repeat -> suppressed by the (single) identity's own cooldown.
    assert.equal(run("pre-tool-use.mjs", { hookEventName: "PreToolUse", toolName: "Read", toolInput: {}, sessionId: "sess-dedup" }, env).stdout, "");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("#27 A hook integration: at most 3 events displayed, capped 4th surfaces next batch", async () => {
  const now = 1_800_000_000_000;
  const root = await mkdtemp(join(tmpdir(), "ego-wake-cap-hook-"));
  for (const [name, wakeId] of [["c1", wakeA], ["c2", wakeB], ["c3", wakeC], ["c4", wakeD]]) {
    const dir = join(root, "conversations", name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a-watch-exit.json"),
      JSON.stringify(watchExit(now - 181_000, { wakeId })), "utf8");
  }
  const home = await mkdtemp(join(tmpdir(), "ego-wake-home9-"));
  await profileWith(home, [root]);
  const env = { EGO_WAKE_GUARD_PROFILE_PATH: join(home, "ego-profile.json"), EGO_WAKE_GUARD_LEDGER_PATH: join(home, "ledger.json") };
  const ev = { hookEventName: "PreToolUse", toolName: "Read", toolInput: {}, sessionId: "sess-cap" };
  try {
    const ctx1 = JSON.parse(run("pre-tool-use.mjs", ev, env).stdout).hookSpecificOutput.additionalContext;
    assert.equal((ctx1.match(/state=WAKE_PENDING/g) || []).length, 3);
    assert.equal(ctx1.split("\n").at(-1), "additional=1 suppressed by cap");
    // The capped event was never shown, so it is not cooled: next batch it
    // surfaces alone while the three displayed ones sit out their cooldown.
    const ctx2 = JSON.parse(run("pre-tool-use.mjs", ev, env).stdout).hookSpecificOutput.additionalContext;
    assert.equal((ctx2.match(/state=WAKE_PENDING/g) || []).length, 1);
    assert.doesNotMatch(ctx2, /additional=/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("#27 A hook integration: UNKNOWN events of different monitorRoots never mask each other", async () => {
  const now = 1_800_000_000_000;
  const rootA = await makeRoot(now, { "a-watch-exit.json": "{corrupted" });
  const rootB = await makeRoot(now, { "a-watch-exit.json": "{corrupted" });
  const rootC = await makeRoot(now, { "a-watch-exit.json": "{corrupted" });
  const home = await mkdtemp(join(tmpdir(), "ego-wake-home10-"));
  await profileWith(home, [rootA.root, rootB.root]);
  const env = { EGO_WAKE_GUARD_PROFILE_PATH: join(home, "ego-profile.json"), EGO_WAKE_GUARD_LEDGER_PATH: join(home, "ledger.json") };
  const ev = { hookEventName: "PreToolUse", toolName: "Read", toolInput: {}, sessionId: "sess-cross" };
  try {
    // Both roots' UNKNOWN events are injected independently.
    const ctx1 = JSON.parse(run("pre-tool-use.mjs", ev, env).stdout).hookSpecificOutput.additionalContext;
    assert.equal((ctx1.match(/state=WAKE_STATUS_UNKNOWN/g) || []).length, 2);
    // Repeat: both suppressed by their own identities — and a third root's
    // brand-new UNKNOWN is NOT masked by the cooled ones.
    assert.equal(run("pre-tool-use.mjs", ev, env).stdout, "");
    await profileWith(home, [rootA.root, rootB.root, rootC.root]);
    const ctx3 = JSON.parse(run("pre-tool-use.mjs", ev, env).stdout).hookSpecificOutput.additionalContext;
    assert.equal((ctx3.match(/state=WAKE_STATUS_UNKNOWN/g) || []).length, 1);
  } finally {
    for (const { root } of [rootA, rootB, rootC]) await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("#27 A backward compatibility: legacy ledger keys stay valid, new-format keys append", async () => {
  const now = 1_800_000_000_000;
  const { root } = await makeRoot(now, { "a-watch-exit.json": watchExit(now - 181_000) });
  const home = await mkdtemp(join(tmpdir(), "ego-wake-home11-"));
  await profileWith(home, [root]);
  const ledgerPath = join(home, "ledger.json");
  const legacyKey = "sess-old:wake:" + wakeUuid;
  await writeFile(ledgerPath, JSON.stringify({
    schema: "ego-wake-guard-state/v1",
    injections: { [legacyKey]: 1 },
    stopBlocks: {},
  }), "utf8");
  try {
    // The pre-#27 state file parses and the hook appends new-format identity
    // keys without wiping legacy entries.
    const result = run("pre-tool-use.mjs", { hookEventName: "PreToolUse", toolName: "Read", toolInput: {}, sessionId: "sess-new" },
      { EGO_WAKE_GUARD_PROFILE_PATH: join(home, "ego-profile.json"), EGO_WAKE_GUARD_LEDGER_PATH: ledgerPath });
    assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /^\[AGENT_KIT_WAKE_GUARD\]/);
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
    assert.equal(ledger.injections[legacyKey], 1);
    assert.ok(Object.keys(ledger.injections).some((key) => key.startsWith("sess-new:WAKE_PENDING:" + wakeUuid + ":")));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("#27 A: the whole-block suppression is abolished in the hook source", async () => {
  const source = await readFile(realScript, "utf8");
  assert.match(source, /selectWakeEvents\(events, ledger, sessionId, now\)/);
  // The old whole-block key (events[0] alone deciding the fate of the block)
  // and its direct cooldown check are gone from the wrapper layer.
  assert.doesNotMatch(source, /events\[0\]\?\.key/);
  assert.doesNotMatch(source, /injectionCooldownActive/);
});

test("PreToolUse: deny and additionalContext coexist with the deny reason byte-for-byte", async () => {
  const now = 1_800_000_000_000;
  const { root, write } = await makeRoot(now, { "a-watch-exit.json": watchExit(now - 181_000) });
  const home = await mkdtemp(join(tmpdir(), "ego-wake-home-"));
  await profileWith(home, [root]);
  const denyEvent = { hookEventName: "PreToolUse", toolName: "Bash", toolInput: { command: "curl -X POST https://chatgpt.com/backend-api/conversation" }, sessionId: "sess-deny" };
  const result = run("pre-tool-use.mjs", denyEvent, { EGO_WAKE_GUARD_PROFILE_PATH: join(home, "ego-profile.json"), EGO_WAKE_GUARD_LEDGER_PATH: join(home, "ledger.json") });
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(output.hookSpecificOutput.permissionDecisionReason, "CHATGPT_DISPATCH_MANAGER_REQUIRED: direct ChatGPT backend API write denied");
  assert.match(output.hookSpecificOutput.additionalContext, /^\[AGENT_KIT_WAKE_GUARD\]\nstate=WAKE_PENDING\nwakeId=/);
  assert.equal(output.hookSpecificOutput.additionalContext.split("\n")[0], "[AGENT_KIT_WAKE_GUARD]");
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

test("PreToolUse: anomaly without deny emits pure additionalContext (never an allow)", async () => {
  const now = 1_800_000_000_000;
  const { root, write } = await makeRoot(now, { "a-watch-exit.json": watchExit(now - 181_000) });
  const home = await mkdtemp(join(tmpdir(), "ego-wake-home2-"));
  await profileWith(home, [root]);
  const result = run("pre-tool-use.mjs", { hookEventName: "PreToolUse", toolName: "Read", toolInput: { path: "a.txt" }, sessionId: "s" }, { EGO_WAKE_GUARD_PROFILE_PATH: join(home, "ego-profile.json"), EGO_WAKE_GUARD_LEDGER_PATH: join(home, "ledger.json") });
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(output), ["hookSpecificOutput"]);
  assert.deepEqual(Object.keys(output.hookSpecificOutput), ["hookEventName", "additionalContext"]);
  assert.equal(output.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.match(output.hookSpecificOutput.additionalContext, /^\[AGENT_KIT_WAKE_GUARD\]/);
  assert.equal(JSON.stringify(output).includes("permissionDecision"), false);
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

test("PreToolUse: healthy monitor or unconfigured monitorRoots produce zero output", async () => {
  const now = 1_800_000_000_000;
  const { root } = await makeRoot(now); // nothing pending
  const home = await mkdtemp(join(tmpdir(), "ego-wake-home3-"));
  await profileWith(home, [root]);
  const env = { EGO_WAKE_GUARD_PROFILE_PATH: join(home, "ego-profile.json"), EGO_WAKE_GUARD_LEDGER_PATH: join(home, "ledger.json") };
  const healthy = run("pre-tool-use.mjs", { hookEventName: "PreToolUse", toolName: "Read", toolInput: {} }, env);
  assert.equal(healthy.stdout, "");
  // Unconfigured roots: anomalies on disk exist but detection is disabled.
  const { root: root2, write } = await makeRoot(now, { "a-watch-exit.json": watchExit(now - 181_000) });
  const home2 = await mkdtemp(join(tmpdir(), "ego-wake-home4-"));
  await writeFile(join(home2, "ego-profile.json"), JSON.stringify({}), "utf8");
  const unconfigured = run("pre-tool-use.mjs", { hookEventName: "PreToolUse", toolName: "Read", toolInput: {} }, { EGO_WAKE_GUARD_PROFILE_PATH: join(home2, "ego-profile.json"), EGO_WAKE_GUARD_LEDGER_PATH: join(home2, "ledger.json") });
  assert.equal(unconfigured.stdout, "");
  await rm(root, { recursive: true, force: true });
  await rm(root2, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
  await rm(home2, { recursive: true, force: true });
});

test("PreToolUse: 60s rate limit per session+event identity, ledger written with frozen schema", async () => {
  const now = 1_800_000_000_000;
  const { root, write } = await makeRoot(now, { "a-watch-exit.json": watchExit(now - 181_000) });
  const home = await mkdtemp(join(tmpdir(), "ego-wake-home5-"));
  await profileWith(home, [root]);
  const env = { EGO_WAKE_GUARD_PROFILE_PATH: join(home, "ego-profile.json"), EGO_WAKE_GUARD_LEDGER_PATH: join(home, "ledger.json") };
  const event = { hookEventName: "PreToolUse", toolName: "Read", toolInput: {}, sessionId: "sess-1" };
  const first = run("pre-tool-use.mjs", event, env);
  assert.match(JSON.parse(first.stdout).hookSpecificOutput.additionalContext, /^\[AGENT_KIT_WAKE_GUARD\]/);
  const ledger = JSON.parse(await readFile(join(home, "ledger.json"), "utf8"));
  assert.equal(ledger.schema, "ego-wake-guard-state/v1");
  // Observation A identity keys: <session>:<type>:<wakeId>:<monitorRoot>.
  assert.ok(Object.keys(ledger.injections).some((key) => key.startsWith("sess-1:WAKE_PENDING:" + wakeUuid + ":")));
  const second = run("pre-tool-use.mjs", event, env);
  assert.equal(second.stdout, ""); // same session + same identity inside 60s
  const otherSession = run("pre-tool-use.mjs", { ...event, sessionId: "sess-2" }, env);
  assert.match(JSON.parse(otherSession.stdout).hookSpecificOutput.additionalContext, /^\[AGENT_KIT_WAKE_GUARD\]/);
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

test("PreToolUse: an unwritable rate-limit ledger still injects the identified wake", async () => {
  const now = 1_800_000_000_000;
  const { root } = await makeRoot(now, { "a-watch-exit.json": watchExit(now - 181_000) });
  const home = await mkdtemp(join(tmpdir(), "ego-wake-home6-"));
  await profileWith(home, [root]);
  // The ledger path IS a directory: the atomic rename inside saveLedger fails,
  // simulating an unwritable rate-limit ledger.
  const ledgerDir = join(home, "ledger.json");
  await mkdir(ledgerDir, { recursive: true });
  const result = run("pre-tool-use.mjs", { hookEventName: "PreToolUse", toolName: "Read", toolInput: {}, sessionId: "sess-io" },
    { EGO_WAKE_GUARD_PROFILE_PATH: join(home, "ego-profile.json"), EGO_WAKE_GUARD_LEDGER_PATH: ledgerDir });
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.match(output.hookSpecificOutput.additionalContext, /^\[AGENT_KIT_WAKE_GUARD\]/);
  assert.ok(output.hookSpecificOutput.additionalContext.includes("state=WAKE_PENDING"));
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

test("PreToolUse: broken input stays fail-closed deny (unchanged behavior)", () => {
  for (const payload of ["{not json", ""]) {
    const result = run("pre-tool-use.mjs", payload, { EGO_WAKE_GUARD_PROFILE_PATH: "C:/absent.json" });
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
    assert.equal(output.hookSpecificOutput.permissionDecisionReason, "CHATGPT_DISPATCH_GUARD_INPUT_INVALID");
  }
});

test("checkDispatchTool source is unchanged by the wake-guard work (pure policy)", async () => {
  const source = await readFile(join(hooksDir, "policy.mjs"), "utf8");
  const fn = source.slice(source.indexOf("export function checkDispatchTool"));
  assert.match(fn, /blocked\("CHATGPT_DISPATCH_MANAGER_REQUIRED: use the managed web dispatch entry point"\)/);
  assert.match(fn, /blocked\("CHATGPT_DISPATCH_MANAGER_REQUIRED: direct ChatGPT backend API write denied"\)/);
  assert.match(fn, /blocked\("CHATGPT_DISPATCH_MANAGER_REQUIRED: direct ego-browser invocation denied"\)/);
  assert.match(fn, /blocked\("CHATGPT_DISPATCH_MANAGER_REQUIRED: ad-hoc ChatGPT browser script denied"\)/);
  // The pure function must not know about wake context injection.
  assert.doesNotMatch(fn, /additionalContext|wake-context|WAKE_|formatWakeContext/);
  // The whole policy file stays free of injection wiring.
  assert.doesNotMatch(source, /additionalContext|wake-context\.mjs/);
});

test("Stop: anomaly forces exactly one continuation with decision:block (no permission semantics)", async () => {
  const now = 1_800_000_000_000;
  const { root, write } = await makeRoot(now, { "a-watch-exit.json": watchExit(now - 181_000) });
  const home = await mkdtemp(join(tmpdir(), "ego-wake-stop1-"));
  await profileWith(home, [root]);
  const env = { EGO_WAKE_GUARD_PROFILE_PATH: join(home, "ego-profile.json"), EGO_WAKE_GUARD_LEDGER_PATH: join(home, "ledger.json") };
  const event = { sessionId: "s", stop_hook_active: false };
  const first = run("stop.mjs", event, env);
  assert.equal(first.status, 0);
  const output = JSON.parse(first.stdout);
  assert.deepEqual(Object.keys(output), ["decision", "reason"]);
  assert.equal(output.decision, "block");
  assert.match(output.reason, /^\[AGENT_KIT_WAKE_GUARD\] state=WAKE_PENDING wakeId=/);
  assert.ok(output.reason.includes("wakeId=" + wakeUuid));
  assert.equal(first.stdout.includes("permissionDecision"), false);
  // Double insurance 2: within the 90s cooldown the same stop flow is not blocked again.
  const second = run("stop.mjs", event, env);
  assert.equal(second.stdout, "");
  const ledger = JSON.parse(await readFile(join(home, "ledger.json"), "utf8"));
  assert.equal(ledger.schema, "ego-wake-guard-state/v1");
  assert.ok(ledger.stopBlocks.s > 0);
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

test("Stop: stop_hook_active=true never blocks (insurance 1)", async () => {
  const now = 1_800_000_000_000;
  const { root, write } = await makeRoot(now, { "a-watch-exit.json": watchExit(now - 181_000) });
  const home = await mkdtemp(join(tmpdir(), "ego-wake-stop2-"));
  await profileWith(home, [root]);
  const result = run("stop.mjs", { sessionId: "s", stop_hook_active: true }, { EGO_WAKE_GUARD_PROFILE_PATH: join(home, "ego-profile.json"), EGO_WAKE_GUARD_LEDGER_PATH: join(home, "ledger.json") });
  assert.equal(result.stdout, "");
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

test("Stop: 90s cooldown pre-seeded in the ledger suppresses block; past it blocks again", async () => {
  const now = 1_800_000_000_000;
  const { root } = await makeRoot(now, { "a-watch-exit.json": watchExit(now - 181_000) });
  const home = await mkdtemp(join(tmpdir(), "ego-wake-stop3-"));
  await profileWith(home, [root]);
  const ledgerPath = join(home, "ledger.json");
  const env = { EGO_WAKE_GUARD_PROFILE_PATH: join(home, "ego-profile.json"), EGO_WAKE_GUARD_LEDGER_PATH: ledgerPath };
  await writeFile(ledgerPath, JSON.stringify(parseLedger(null)), "utf8");
  // Fresh ledger (no stopBlocks entry) -> blocks.
  assert.equal(JSON.parse(run("stop.mjs", { sessionId: "s" }, env).stdout).decision, "block");
  const after = parseLedger(await readFile(ledgerPath, "utf8"));
  assert.equal(stopCooldownActive(after, "s", after.stopBlocks.s + 89_999), true);
  assert.equal(stopCooldownActive(after, "s", after.stopBlocks.s + 90_000), false);
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

test("Stop: healthy monitor produces zero output", async () => {
  const now = 1_800_000_000_000;
  const { root } = await makeRoot(now);
  const home = await mkdtemp(join(tmpdir(), "ego-wake-stop4-"));
  await profileWith(home, [root]);
  const result = run("stop.mjs", { sessionId: "s" }, { EGO_WAKE_GUARD_PROFILE_PATH: join(home, "ego-profile.json"), EGO_WAKE_GUARD_LEDGER_PATH: join(home, "ledger.json") });
  assert.equal(result.stdout, "");
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

test("Stop: two sessions within 90s each block independently (no cross-session suppression)", async () => {
  const now = 1_800_000_000_000;
  const { root } = await makeRoot(now, { "a-watch-exit.json": watchExit(now - 181_000) });
  const home = await mkdtemp(join(tmpdir(), "ego-wake-stop5-"));
  await profileWith(home, [root]);
  const env = { EGO_WAKE_GUARD_PROFILE_PATH: join(home, "ego-profile.json"), EGO_WAKE_GUARD_LEDGER_PATH: join(home, "ledger.json") };
  // Session A raises the anomaly and takes the Stop block.
  const first = run("stop.mjs", { sessionId: "session-a", stop_hook_active: false }, env);
  assert.equal(JSON.parse(first.stdout).decision, "block");
  // Within the 90s cooldown session B's independent Stop is NOT suppressed.
  const second = run("stop.mjs", { sessionId: "session-b", stop_hook_active: false }, env);
  assert.equal(JSON.parse(second.stdout).decision, "block");
  // Session A itself stays suppressed inside its own 90s window.
  const third = run("stop.mjs", { sessionId: "session-a", stop_hook_active: false }, env);
  assert.equal(third.stdout, "");
  // Session B now also sits inside its own cooldown.
  const fourth = run("stop.mjs", { sessionId: "session-b", stop_hook_active: false }, env);
  assert.equal(fourth.stdout, "");
  const ledger = JSON.parse(await readFile(join(home, "ledger.json"), "utf8"));
  assert.ok(ledger.stopBlocks["session-a"] > 0);
  assert.ok(ledger.stopBlocks["session-b"] > 0);
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

test("installer: old PreToolUse-only config gains exactly one canonical Stop entry", () => {
  const old = { hooks: { enabled: true, events: { PreToolUse: [
    { matcher: "Bash", hooks: [{ type: "process", command: "rtk", args: ["hook", "claude"] }] },
    { hooks: [{ type: "process", command: "node", args: [realScript], timeoutMs: 5000 }] },
  ] } } };
  const { config, changed } = installConfig(old);
  assert.equal(changed, true);
  assert.equal(config.hooks.events.Stop.length, 1);
  // Canonical install output carries the resolved node command (full path).
  assert.deepEqual(config.hooks.events.Stop[0], { hooks: [{ type: "process", command: process.execPath, args: [realStopScript], timeoutMs: 5000 }] });
  verifyConfig(config);
});

test("installer: repeated installs are idempotent (no stacking)", () => {
  let config = { hooks: { enabled: true, events: { PreToolUse: [
    { matcher: "Bash", hooks: [{ type: "process", command: "rtk", args: ["hook", "claude"] }] },
  ] } } };
  for (let round = 0; round < 3; round++) config = installConfig(config).config;
  assert.equal(config.hooks.events.Stop.length, 1);
  assert.equal(config.hooks.events.PreToolUse.length, 2);
  verifyConfig(config);
});

test("installer: duplicate AgentKit Stop entries fail install and verify (no silent repair)", () => {
  const stop = { hooks: [{ type: "process", command: "node", args: [realStopScript], timeoutMs: 5000 }] };
  const config = { hooks: { enabled: true, events: { PreToolUse: [
    { matcher: "Bash", hooks: [{ type: "process", command: "rtk", args: ["hook", "claude"] }] },
    { hooks: [{ type: "process", command: "node", args: [realScript], timeoutMs: 5000 }] },
  ], Stop: [stop, stop] } } };
  assert.throws(() => installConfig(config), /ZCODE_GUARD_DUPLICATE_RULES/);
  assert.throws(() => verifyConfig(config), /ZCODE_GUARD_DUPLICATE_RULES/);
});

test("installer: two AgentKit hooks inside one group fail install like VERIFY (hook-level count)", () => {
  const duplicated = { hooks: [
    { type: "process", command: "node", args: [realScript], timeoutMs: 5000 },
    { type: "process", command: "node", args: [realScript], timeoutMs: 5000 },
  ] };
  const config = { hooks: { enabled: true, events: { PreToolUse: [
    { matcher: "Bash", hooks: [{ type: "process", command: "rtk", args: ["hook", "claude"] }] },
    duplicated,
  ], Stop: [{ hooks: [{ type: "process", command: "node", args: [realStopScript], timeoutMs: 5000 }] }] } } };
  assert.throws(() => installConfig(config), /ZCODE_GUARD_DUPLICATE_RULES/);
  assert.throws(() => verifyConfig(config), /ZCODE_GUARD_DUPLICATE_RULES/);
  // Same rule for the Stop event path.
  const duplicatedStop = { hooks: [
    { type: "process", command: "node", args: [realStopScript], timeoutMs: 5000 },
    { type: "process", command: "node", args: [realStopScript], timeoutMs: 5000 },
  ] };
  const stopConfig = { hooks: { enabled: true, events: { PreToolUse: [
    { matcher: "Bash", hooks: [{ type: "process", command: "rtk", args: ["hook", "claude"] }] },
    { hooks: [{ type: "process", command: "node", args: [realScript], timeoutMs: 5000 }] },
  ], Stop: [duplicatedStop] } } };
  assert.throws(() => installConfig(stopConfig), /ZCODE_GUARD_DUPLICATE_RULES/);
  assert.throws(() => verifyConfig(stopConfig), /ZCODE_GUARD_DUPLICATE_RULES/);
});

test("installer: user hooks and legacy matcher repair behavior are preserved alongside Stop", () => {
  const old = { hooks: { enabled: false, events: { PreToolUse: [
    { matcher: "*", hooks: [{ type: "process", command: "node", args: ["C:/old/plugins/chatgpt-dispatch-guard/hooks/pre-tool-use.mjs"], timeoutMs: 5000 }] },
    { matcher: "Bash", hooks: [{ type: "process", command: "rtk", args: ["hook", "claude"] }] },
  ] } } };
  const { config, changed } = installConfig(old, "C:/old/plugins/chatgpt-dispatch-guard/hooks/pre-tool-use.mjs", "C:/old/plugins/chatgpt-dispatch-guard/hooks/stop.mjs");
  assert.equal(changed, true);
  assert.equal(config.hooks.enabled, true);
  // The user's rtk rule is untouched; the guard group is repaired in place; Stop is added.
  // Repaired/added groups carry the resolved node command (full path), not bare "node".
  assert.deepEqual(config.hooks.events.PreToolUse[1], { matcher: "Bash", hooks: [{ type: "process", command: "rtk", args: ["hook", "claude"] }] });
  assert.deepEqual(config.hooks.events.PreToolUse[0], { hooks: [{ type: "process", command: process.execPath, args: ["C:/old/plugins/chatgpt-dispatch-guard/hooks/pre-tool-use.mjs"], timeoutMs: 5000 }] });
  assert.deepEqual(config.hooks.events.Stop, [{ hooks: [{ type: "process", command: process.execPath, args: ["C:/old/plugins/chatgpt-dispatch-guard/hooks/stop.mjs"], timeoutMs: 5000 }] }]);
  verifyConfig(config, "C:/old/plugins/chatgpt-dispatch-guard/hooks/pre-tool-use.mjs", "C:/old/plugins/chatgpt-dispatch-guard/hooks/stop.mjs");
});

test("hooks.json manifest carries the Stop entry in the installer-canonical shape", async () => {
  const manifest = JSON.parse(await readFile(join(hooksDir, "hooks.json"), "utf8"));
  const stop = manifest.hooks.Stop;
  assert.ok(Array.isArray(stop) && stop.length === 1);
  assert.deepEqual(stop[0], { hooks: [{ type: "process", command: "node", args: ["${ZCODE_PLUGIN_ROOT}/hooks/stop.mjs"], timeoutMs: 5000 }] });
  assert.deepEqual(manifest.hooks.PreToolUse[0].hooks[0], { type: "process", command: "node", args: ["${ZCODE_PLUGIN_ROOT}/hooks/pre-tool-use.mjs"], timeoutMs: 5000 });
});

test("installer --verify passes end to end against a real installed config (all checks)", async () => {
  const { verify } = await import("../monitor/install-zcode-guard.mjs");
  const dir = await mkdtemp(join(tmpdir(), "ego-wake-verify-"));
  const file = join(dir, "config.json");
  const base = { hooks: { enabled: true, events: { PreToolUse: [
    { matcher: "Bash", hooks: [{ type: "process", command: "rtk", args: ["hook", "claude"] }] },
  ] } } };
  await writeFile(file, JSON.stringify(base, null, 2) + "\n", "utf8");
  assert.equal(await install(file), true);
  assert.equal(await verify(file), true);
  const listing = await readdir(dir);
  assert.ok(listing.some((f) => f === "config.json.pre-chatgpt-guard.bak"));
  await rm(dir, { recursive: true, force: true });
});

// ---- #27 Batch 3 (ruling §四.3): WATCH_STALE exemption table for the armed
// state. Pure table rows plus the scan wiring: a DISARMED_IDLE claim against
// an in-flight dispatch ledger is the forbidden "sent but disarmed" window
// (UNKNOWN, never an exemption); armed claims, legacy ledgers and unreadable
// state never exempt; wake events are retained in every branch. ----

test("#27 B3 exemption table: frozen rows, pure function", () => {
  const structured = { structured: true, armReason: "DISARMED_IDLE" };
  // DISARMED_IDLE 且交叉验证通过 -> 豁免
  assert.equal(watchStaleExemption({ ...structured, dispatchActive: false, hasUnackedWake: false }),
    WATCH_STALE_EXEMPTION.EXEMPT);
  // DISARMED_IDLE 但 dispatch-state 有在途 -> UNKNOWN 不豁免
  assert.equal(watchStaleExemption({ ...structured, dispatchActive: true, hasUnackedWake: false }),
    WATCH_STALE_EXEMPTION.CONFLICT_UNKNOWN);
  // DISARMED_IDLE 但有未 ack wake -> 保留对应唤醒事件（stale 异常本身豁免）
  assert.equal(watchStaleExemption({ ...structured, dispatchActive: false, hasUnackedWake: true }),
    WATCH_STALE_EXEMPTION.KEEP_WAKE_EVENTS);
  // Conflict and unacked wake together: the conflict verdict stands and the
  // wake events are retained regardless (never suppressed by any branch).
  assert.equal(watchStaleExemption({ ...structured, dispatchActive: true, hasUnackedWake: true }),
    WATCH_STALE_EXEMPTION.CONFLICT_UNKNOWN);
  // Armed claims are never exempt — while armed the watch must be running.
  for (const armReason of ["DISPATCH_ACCEPTED", "PEER_GENERATING", "ARMED_UNKNOWN"]) {
    assert.equal(watchStaleExemption({ structured: true, armReason, dispatchActive: true, hasUnackedWake: false }),
      WATCH_STALE_EXEMPTION.NOT_EXEMPT, armReason);
  }
  // 读取失败 / legacy / foreign reason: no arm information, never exempt.
  for (const claim of [
    { structured: false, armReason: null },                 // missing / unreadable
    { structured: false, armReason: null },                 // legacy v3 (no schema v4)
    { structured: false, armReason: null },                 // foreign reason value
  ]) {
    assert.equal(watchStaleExemption({ ...claim, dispatchActive: true, hasUnackedWake: false }),
      WATCH_STALE_EXEMPTION.NOT_EXEMPT);
  }
});

test("#27 B3 readArmClaim: only a v4 ledger with a frozen four-state value carries an arm claim", () => {
  assert.deepEqual(readArmClaim({ schema: FAST_STATE_SCHEMA_V4, armedReason: "DISARMED_IDLE" }),
    { structured: true, armReason: "DISARMED_IDLE" });
  assert.deepEqual(readArmClaim({ schema: FAST_STATE_SCHEMA_V4, armedReason: null }),
    { structured: true, armReason: null });
  // Legacy schemas, absent values and junk carry no arm information.
  assert.deepEqual(readArmClaim({ schema: "ego-fast-state/v3", armedReason: "DISARMED_IDLE" }),
    { structured: false, armReason: null });
  assert.deepEqual(readArmClaim({ ts: 5 }), { structured: false, armReason: null });
  assert.deepEqual(readArmClaim(null), { structured: false, armReason: null });
  assert.deepEqual(readArmClaim("{junk"), { structured: false, armReason: null });
  // A hand-edited foreign value is untrustworthy, never an exemption basis.
  assert.deepEqual(readArmClaim({ schema: FAST_STATE_SCHEMA_V4, armedReason: "WEIRD" }),
    { structured: false, armReason: null });
});

test("#27 B3 exemption wiring: an armed claim keeps WATCH_STALE, a DISARMED_IDLE claim over an in-flight dispatch becomes the forbidden-window UNKNOWN", async () => {
  const now = 1_800_000_000_000;
  const staleFast = (armedReason, schema = FAST_STATE_SCHEMA_V4) => ({
    schema, ts: now - 8 * 60_000, ...(armedReason === null ? {} : { armedReason }),
  });
  // Armed claim (DISPATCH_ACCEPTED) + stale + ACCEPTED ledger -> WATCH_STALE stands.
  {
    const { root } = await makeRoot(now, {
      "a-dispatch-state.json": dispatchRecord(now - 60 * 60_000),
      "a-fast-state.json": staleFast("DISPATCH_ACCEPTED"),
    });
    const { healthy, events } = await detectWakeAnomalies([root], now);
    assert.equal(healthy, false);
    assert.equal(events[0].type, "WATCH_STALE");
    await rm(root, { recursive: true, force: true });
  }
  // DISARMED_IDLE claim + in-flight (ACCEPTED) ledger = "已派出但显示撤防"
  // forbidden window -> WAKE_STATUS_UNKNOWN, never an exemption.
  {
    const { root } = await makeRoot(now, {
      "a-dispatch-state.json": dispatchRecord(now - 60 * 60_000),
      "a-fast-state.json": staleFast("DISARMED_IDLE"),
    });
    const { healthy, events } = await detectWakeAnomalies([root], now);
    assert.equal(healthy, false);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "WAKE_STATUS_UNKNOWN");
    assert.equal(events[0].detail, ARM_STATE_CONFLICT_DETAIL);
    await rm(root, { recursive: true, force: true });
  }
  // Legacy fast state (pre-arm ledger): legacy mode, WATCH_STALE unchanged.
  {
    const { root } = await makeRoot(now, {
      "a-dispatch-state.json": dispatchRecord(now - 60 * 60_000),
      "a-fast-state.json": staleFast(null, "ego-fast-state/v3"),
    });
    const { healthy, events } = await detectWakeAnomalies([root], now);
    assert.equal(healthy, false);
    assert.equal(events[0].type, "WATCH_STALE");
    await rm(root, { recursive: true, force: true });
  }
  // ARMED_UNKNOWN claim: fail-closed armed, WATCH_STALE stands.
  {
    const { root } = await makeRoot(now, {
      "a-dispatch-state.json": dispatchRecord(now - 60 * 60_000),
      "a-fast-state.json": staleFast("ARMED_UNKNOWN"),
    });
    const { healthy, events } = await detectWakeAnomalies([root], now);
    assert.equal(healthy, false);
    assert.equal(events[0].type, "WATCH_STALE");
    await rm(root, { recursive: true, force: true });
  }
});

test("#27 B3 exemption wiring: a post-disarm shape never swallows a pending wake event", async () => {
  const now = 1_800_000_000_000;
  // Terminal dispatch (cross-validation passes) + DISARMED_IDLE claim + stale
  // fast state: no stale anomaly is raised — and an un-acked watch exit is
  // STILL retained (the exemption never suppresses wake events).
  {
    const { root } = await makeRoot(now, {
      "a-dispatch-state.json": dispatchRecord(now - 3 * 60 * 60_000, { status: "COMPLETED" }),
      "a-fast-state.json": { schema: FAST_STATE_SCHEMA_V4, ts: now - 3 * 60 * 60_000, armedReason: "DISARMED_IDLE" },
      "a-watch-exit.json": watchExit(now - 181_000, { acknowledgedAt: now - 1, ackAction: "investigated" }),
    });
    const { healthy, events } = await detectWakeAnomalies([root], now);
    assert.equal(healthy, true);
    assert.deepEqual(events, []);
    await rm(root, { recursive: true, force: true });
  }
  {
    const { root } = await makeRoot(now, {
      "a-dispatch-state.json": dispatchRecord(now - 3 * 60 * 60_000, { status: "COMPLETED" }),
      "a-fast-state.json": { schema: FAST_STATE_SCHEMA_V4, ts: now - 3 * 60 * 60_000, armedReason: "DISARMED_IDLE" },
      "a-watch-exit.json": watchExit(now - 181_000),
    });
    const { healthy, events } = await detectWakeAnomalies([root], now);
    assert.equal(healthy, false);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "WAKE_PENDING");
    assert.equal(events[0].wakeId, wakeUuid);
    await rm(root, { recursive: true, force: true });
  }
});

test("#27 B3 P1-D: the disarm conflict check is decoupled from WATCH_STALE — every active status conflicts regardless of staleness", async () => {
  const now = 1_800_000_000_000;
  const freshFast = (armedReason) => ({
    schema: FAST_STATE_SCHEMA_V4, ts: now - 30_000, ...(armedReason === null ? {} : { armedReason }),
  });
  // A structured DISARMED_IDLE claim over ANY active dispatch ledger is the
  // forbidden "sent but disarmed" window — the pre-fix code ran the conflict
  // check only after the ACCEPTED-only stale ladder, so SEND_STARTED /
  // UNCERTAIN / RETRY_AUTHORIZED / PREPARED (and fresh ACCEPTED) passed
  // silently. Now they surface immediately, no staleness precondition.
  for (const status of ["PREPARED", "SEND_STARTED", "ACCEPTED", "UNCERTAIN", "RETRY_AUTHORIZED"]) {
    const { root } = await makeRoot(now, {
      "a-dispatch-state.json": dispatchRecord(now, { status }),
      "a-fast-state.json": freshFast("DISARMED_IDLE"),
    });
    const { healthy, events } = await detectWakeAnomalies([root], now);
    assert.equal(healthy, false, status);
    assert.equal(events.length, 1, status);
    assert.equal(events[0].type, "WAKE_STATUS_UNKNOWN", status);
    assert.equal(events[0].detail, ARM_STATE_CONFLICT_DETAIL, status);
    await rm(root, { recursive: true, force: true });
  }
  // Armed claims over a fresh active ledger raise nothing: the legacy timeout
  // rules (WATCH_STALE only for ACCEPTED + stale + stale record) are unchanged.
  {
    const { root } = await makeRoot(now, {
      "a-dispatch-state.json": dispatchRecord(now, { status: "SEND_STARTED" }),
      "a-fast-state.json": freshFast("DISPATCH_ACCEPTED"),
    });
    const { healthy, events } = await detectWakeAnomalies([root], now);
    assert.equal(healthy, true);
    assert.deepEqual(events, []);
    await rm(root, { recursive: true, force: true });
  }
  // Legacy v3 fast state carries no arm claim: no conflict event on an active
  // ledger, and legacy mode never invents one.
  {
    const { root } = await makeRoot(now, {
      "a-dispatch-state.json": dispatchRecord(now, { status: "SEND_STARTED" }),
      "a-fast-state.json": { schema: "ego-fast-state/v3", ts: now - 30_000 },
    });
    const { healthy, events } = await detectWakeAnomalies([root], now);
    assert.equal(healthy, true);
    assert.deepEqual(events, []);
    await rm(root, { recursive: true, force: true });
  }
  // Even a fully stale SEND_STARTED ledger never raises WATCH_STALE — that
  // legacy rule stays exactly as it was (only ACCEPTED raises stale).
  {
    const { root } = await makeRoot(now, {
      "a-dispatch-state.json": dispatchRecord(now - 60 * 60_000, { status: "SEND_STARTED" }),
      "a-fast-state.json": { schema: FAST_STATE_SCHEMA_V4, ts: now - 8 * 60_000, armedReason: "DISPATCH_ACCEPTED" },
    });
    const { healthy, events } = await detectWakeAnomalies([root], now);
    assert.equal(healthy, true);
    assert.deepEqual(events, []);
    await rm(root, { recursive: true, force: true });
  }
});
