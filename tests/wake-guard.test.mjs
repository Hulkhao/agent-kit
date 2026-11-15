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
import { detectWakeAnomalies, formatWakeContext, summarizeEvents, readMonitorRoots, parseLedger, injectionCooldownActive, stopCooldownActive, withInjection, withStopBlock } from "../plugins/chatgpt-dispatch-guard/hooks/wake-context.mjs";
import { install, installConfig, verifyConfig } from "../monitor/install-zcode-guard.mjs";

const hooksDir = join(import.meta.dirname, "../plugins/chatgpt-dispatch-guard/hooks");
const realScript = join(hooksDir, "pre-tool-use.mjs");
const realStopScript = join(hooksDir, "stop.mjs");
const uuid = "11111111-1111-4111-8111-111111111111";

const watchExit = (issuedAt, overrides = {}) => ({
  schema: "ego-watch-exit/v1", wakeId: "wake-1", reason: "FAST_PROBE_WAKE_SUPERVISOR",
  issuedAt, exitCode: 2, acknowledgedAt: null, ackAction: null, ...overrides,
});
const supervisionStatus = (pending) => ({
  schema: "ego-supervision/v1", generationKey: null, progressAt: 0, abnormalRounds: 0, lastReviewAt: 0, pending,
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
  assert.equal(events[0].wakeId, "wake-1");
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

test("detection never throws: unreadable roots/files degrade, missing conversations is silent", async () => {
  const now = 1_800_000_000_000;
  const { root } = await makeRoot(now); // empty conversations dir
  const { healthy } = await detectWakeAnomalies([join(root, "missing"), root], now);
  assert.equal(healthy, true);
  const failing = { readdir: async () => { throw new Error("boom"); }, readFile: async () => { throw new Error("boom"); } };
  const broken = await detectWakeAnomalies(["C:/whatever"], now, failing);
  assert.equal(broken.healthy, true); // root read failure skips the root, never throws
  await rm(root, { recursive: true, force: true });
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
  assert.equal(lines.at(-1), "additional=2");
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

test("ledger: 60s injection cooldown and 90s stop cooldown arithmetic", () => {
  const now = 1_800_000_000_000;
  const ledger = withStopBlock(withInjection(parseLedger(null), "s1:wake-1", now), now);
  assert.equal(injectionCooldownActive(ledger, "s1:wake-1", now + 59_999), true);
  assert.equal(injectionCooldownActive(ledger, "s1:wake-1", now + 60_000), false);
  assert.equal(injectionCooldownActive(ledger, "s2:wake-1", now + 1), false); // other session
  assert.equal(stopCooldownActive(ledger, now + 89_999), true);
  assert.equal(stopCooldownActive(ledger, now + 90_000), false);
  assert.equal(parseLedger(JSON.stringify(ledger)).schema, "ego-wake-guard-state/v1");
  assert.throws(() => parseLedger('{"schema":"other/v9"}'), /WAKE_GUARD_LEDGER_INVALID/);
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
  assert.match(output.hookSpecificOutput.additionalContext, /^\[AGENT_KIT_WAKE_GUARD\]\nstate=WAKE_PENDING\nwakeId=wake-1/);
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

test("PreToolUse: 60s rate limit per session+wakeId, ledger written with frozen schema", async () => {
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
  assert.ok(Object.keys(ledger.injections).some((key) => key.startsWith("sess-1:wake:")));
  const second = run("pre-tool-use.mjs", event, env);
  assert.equal(second.stdout, ""); // same session + same wakeId inside 60s
  const otherSession = run("pre-tool-use.mjs", { ...event, sessionId: "sess-2" }, env);
  assert.match(JSON.parse(otherSession.stdout).hookSpecificOutput.additionalContext, /^\[AGENT_KIT_WAKE_GUARD\]/);
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
  assert.match(output.reason, /^\[AGENT_KIT_WAKE_GUARD\] state=WAKE_PENDING wakeId=wake-1 action=INSPECT_AND_ACK_REQUIRED/);
  assert.equal(first.stdout.includes("permissionDecision"), false);
  // Double insurance 2: within the 90s cooldown the same stop flow is not blocked again.
  const second = run("stop.mjs", event, env);
  assert.equal(second.stdout, "");
  const ledger = JSON.parse(await readFile(join(home, "ledger.json"), "utf8"));
  assert.equal(ledger.schema, "ego-wake-guard-state/v1");
  assert.ok(ledger.stopBlockAt > 0);
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
  // Fresh ledger (stopBlockAt=0) -> blocks.
  assert.equal(JSON.parse(run("stop.mjs", { sessionId: "s" }, env).stdout).decision, "block");
  const after = parseLedger(await readFile(ledgerPath, "utf8"));
  assert.equal(stopCooldownActive(after, after.stopBlockAt + 89_999), true);
  assert.equal(stopCooldownActive(after, after.stopBlockAt + 90_000), false);
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

test("installer: old PreToolUse-only config gains exactly one canonical Stop entry", () => {
  const old = { hooks: { enabled: true, events: { PreToolUse: [
    { matcher: "Bash", hooks: [{ type: "process", command: "rtk", args: ["hook", "claude"] }] },
    { hooks: [{ type: "process", command: "node", args: [realScript], timeoutMs: 5000 }] },
  ] } } };
  const { config, changed } = installConfig(old);
  assert.equal(changed, true);
  assert.equal(config.hooks.events.Stop.length, 1);
  assert.deepEqual(config.hooks.events.Stop[0], { hooks: [{ type: "process", command: "node", args: [realStopScript], timeoutMs: 5000 }] });
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

test("installer: user hooks and legacy matcher repair behavior are preserved alongside Stop", () => {
  const old = { hooks: { enabled: false, events: { PreToolUse: [
    { matcher: "*", hooks: [{ type: "process", command: "node", args: ["C:/old/plugins/chatgpt-dispatch-guard/hooks/pre-tool-use.mjs"], timeoutMs: 5000 }] },
    { matcher: "Bash", hooks: [{ type: "process", command: "rtk", args: ["hook", "claude"] }] },
  ] } } };
  const { config, changed } = installConfig(old, "C:/old/plugins/chatgpt-dispatch-guard/hooks/pre-tool-use.mjs", "C:/old/plugins/chatgpt-dispatch-guard/hooks/stop.mjs");
  assert.equal(changed, true);
  assert.equal(config.hooks.enabled, true);
  // The user's rtk rule is untouched; the guard group is repaired in place; Stop is added.
  assert.deepEqual(config.hooks.events.PreToolUse[1], { matcher: "Bash", hooks: [{ type: "process", command: "rtk", args: ["hook", "claude"] }] });
  assert.deepEqual(config.hooks.events.PreToolUse[0], { hooks: [{ type: "process", command: "node", args: ["C:/old/plugins/chatgpt-dispatch-guard/hooks/pre-tool-use.mjs"], timeoutMs: 5000 }] });
  assert.deepEqual(config.hooks.events.Stop, [{ hooks: [{ type: "process", command: "node", args: ["C:/old/plugins/chatgpt-dispatch-guard/hooks/stop.mjs"], timeoutMs: 5000 }] }]);
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
