import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendEvent,
  hasResponseTailAdvanced,
  markAccepted,
  markSendStarted,
  prepareDispatch,
  readDispatchState,
  readComposerSurface,
  reconcileDispatch,
} from "./dispatch-state.mjs";
import { selectUniqueConversationPage } from "./page-recovery.mjs";
import {
  CALIBRATION_INTERVAL_MS,
  chatSurfaceReady,
  decideRoundKind,
  planStormRecovery,
  runStormRetry,
  stormRearmState,
  FAST_STATE_DEFAULTS,
  FAST_STATE_SCHEMA,
  isBackoffActive,
  navReferenceAt,
  nextBackoffUntil,
  normalizeFastState,
  spacePhaseMs,
  STORM_PHASE_SPAN_MS,
  stormBackoffDeadline,
  validateFastState,
} from "./state-schema.mjs";


test("safe error metadata cannot overwrite application error classifications", async () => {
  const source = await readFile(new URL("./ego-fast-probe.mjs", import.meta.url), "utf8");
  assert.match(source, /nativeErrorCode:\s*String\(error\?\.code/);
  assert.doesNotMatch(source, /errorCode:\s*String\(error\?\.code/);
  // Property, not a fixed count: every classified write keeps a specific code (never UNKNOWN).
  const classifiedWrites = source.match(/errorCode:\s*"([A-Z0-9_]+)",\s*\.\.\.safeError\(error\)/g) || [];
  assert.ok(classifiedWrites.length >= 5, `expected at least 5 classified writes, got ${classifiedWrites.length}`);
  const codes = classifiedWrites.map((m) => m.match(/errorCode:\s*"([A-Z0-9_]+)"/)[1]);
  assert.ok(codes.every((code) => code !== "UNKNOWN"), `unknown-clobbered site present: ${codes.join(",")}`);
});

test("watchdog REQUIRED set stays in lockstep with the probe state schema (issue #11)", async () => {
  const schemaSource = await readFile(new URL("./state-schema.mjs", import.meta.url), "utf8");
  const watchdogSource = await readFile(new URL("./watchdog.sh", import.meta.url), "utf8");
  const defaultsBlock = schemaSource.match(/FAST_STATE_DEFAULTS = Object\.freeze\(\{([\s\S]*?)\}\);/);
  assert.ok(defaultsBlock, "FAST_STATE_DEFAULTS block not found");
  const schemaFields = [...defaultsBlock[1].matchAll(/^\s{2}([a-zA-Z]+):/gm)].map((m) => m[1]);
  assert.ok(schemaFields.length >= 30, `unexpectedly few schema fields: ${schemaFields.length}`);
  const requiredBlock = watchdogSource.match(/REQUIRED = \{([\s\S]*?)\}/);
  assert.ok(requiredBlock, "watchdog REQUIRED block not found");
  const watchdogFields = [...requiredBlock[1].matchAll(/"([a-zA-Z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    watchdogFields.filter((field) => !schemaFields.includes(field)).sort(),
    [],
    `watchdog REQUIRED has fields the probe never writes: ${watchdogFields.filter((f) => !schemaFields.includes(f)).join(",")}`,
  );
  assert.deepEqual(
    schemaFields.filter((field) => !watchdogFields.includes(field)).sort(),
    [],
    `probe writes fields watchdog REQUIRED does not accept (STATE_CORRUPT every window): ${schemaFields.filter((f) => !watchdogFields.includes(f)).join(",")}`,
  );
});

test("SPACE phase is a stable deterministic value in the 0-9min span", () => {
  const phase = spacePhaseMs("fast-poll-6aef5b8c-mon");
  assert.equal(phase, spacePhaseMs("fast-poll-6aef5b8c-mon"));
  assert.ok(Number.isInteger(phase) && phase >= 0 && phase < STORM_PHASE_SPAN_MS);
  const others = ["fast-poll-aaaaaaaa-mon", "fast-poll-bbbbbbbb-mon", "fast-poll-cccccccc-mon", "watch-x"];
  assert.notEqual(new Set([phase, ...others.map(spacePhaseMs)]).size, 1);
  assert.throws(() => spacePhaseMs(""), TypeError);
});

test("nav reference takes the most recent of probe goto and external navigation", () => {
  const t0 = 1_000_000;
  assert.equal(navReferenceAt({ lastGotoAt: t0, timeOrigin: t0 + 5000 }), t0 + 5000);
  assert.equal(navReferenceAt({ lastGotoAt: t0, timeOrigin: t0 - 5000 }), t0);
  assert.equal(navReferenceAt({ lastGotoAt: t0, timeOrigin: null }), t0);
  assert.equal(navReferenceAt({ lastGotoAt: null, timeOrigin: t0 }), t0);
  assert.equal(navReferenceAt({}), null);
  assert.equal(navReferenceAt({ lastGotoAt: -1, timeOrigin: "x" }), null);
});

test("round kind: stay within calibration window, calibrate past it, recover on page mismatch", () => {
  const t = 10_000_000;
  const nav = t - 60_000; // navigated 1 minute ago
  assert.equal(decideRoundKind({ urlMatches: true, navRefAt: nav, now: t }), "STAY");
  assert.equal(decideRoundKind({ urlMatches: true, navRefAt: t - CALIBRATION_INTERVAL_MS, now: t }), "CALIBRATE");
  assert.equal(decideRoundKind({ urlMatches: true, navRefAt: t - CALIBRATION_INTERVAL_MS + 1, now: t }), "STAY");
  assert.equal(decideRoundKind({ urlMatches: false, navRefAt: nav, now: t }), "RECOVER");
  assert.equal(decideRoundKind({ urlMatches: null, navRefAt: nav, now: t }), "RECOVER");
  // unknown navigation age (no state field, no readable timeOrigin) must not stay on page
  assert.equal(decideRoundKind({ urlMatches: true, navRefAt: null, now: t }), "CALIBRATE");
});

test("storm deadline takes the latest of 8min goto backoff and 9min+phase, never sums them", () => {
  const detectedAt = 5_000_000;
  assert.equal(stormBackoffDeadline({ detectedAt, phaseMs: 0 }), detectedAt + 9 * 60 * 1000);
  assert.equal(stormBackoffDeadline({ detectedAt, phaseMs: 120_000 }), detectedAt + 9 * 60 * 1000 + 120_000);
  // with phase 0 the storm rule (9min) dominates the 8min base backoff — this proves no summation
  assert.notEqual(stormBackoffDeadline({ detectedAt, phaseMs: 0 }), detectedAt + 8 * 60 * 1000);
  assert.notEqual(stormBackoffDeadline({ detectedAt, phaseMs: 0 }), detectedAt + 17 * 60 * 1000);
  assert.throws(() => stormBackoffDeadline({ detectedAt, phaseMs: STORM_PHASE_SPAN_MS }), TypeError);
  assert.throws(() => stormBackoffDeadline({ detectedAt: -1, phaseMs: 0 }), TypeError);
});

test("lastGotoAt is an optional v3 field: old states normalize to null and stay valid", () => {
  const t = 1_000_000;
  const legacy = { ...JSON.parse(JSON.stringify(FAST_STATE_DEFAULTS)), ts: t, lastGotoAt: undefined };
  delete legacy.lastGotoAt;
  const migrated = normalizeFastState(legacy, {}, t);
  assert.equal(migrated.lastGotoAt, null);
  assert.equal(validateFastState(migrated), true);

  const stamped = normalizeFastState(migrated, { lastGotoAt: t + 500 }, t + 1000);
  assert.equal(stamped.lastGotoAt, t + 500);
  assert.equal(validateFastState(stamped), true);

  const bad = { ...stamped, lastGotoAt: "not-a-number" };
  assert.equal(validateFastState(bad), false);
  const negative = normalizeFastState(stamped, { lastGotoAt: -5 }, t + 2000);
  assert.equal(negative.lastGotoAt, null);
});

test("probe navigates only through the unified entry that stamps lastGotoAt and GOTO_ATTEMPT", async () => {
  const source = await readFile(new URL("./ego-fast-probe.mjs", import.meta.url), "utf8");
  // exactly one raw navigation site: inside the unified navigate(reason) entry
  const gotoSites = source.match(/page\.goto\(/g) || [];
  assert.equal(gotoSites.length, 1);
  assert.match(source, /async function navigate\(reason\)/);
  assert.match(source, /await writeState\(\{ lastGotoAt: gotoAt \}\)/);
  assert.match(source, /GOTO_ATTEMPT/);
  const callSites = source.match(/await navigate\(/g) || [];
  assert.ok(callSites.length >= 3, `expected at least 3 navigate call sites, got ${callSites.length}`);
  const reasons = source.match(/"(CALIBRATION|RECOVERY|DEAD_PAGE_RETRY|429_RETRY)"/g) || [];
  assert.ok(reasons.length >= 3, `expected all contract reason codes wired, got ${reasons.length}`);
  // storm deadline is wired into the structurally-unavailable path (computed from detectedAt + phase)
  assert.match(source, /stormBackoffDeadline\(\{ detectedAt, phaseMs \}\)/);
});

test("multiple Pages resolve only by one exact ChatGPT conversation URL match", async () => {
  const uuid = "12345678-1234-1234-1234-123456789abc";
  const other = { label: "p1", url: async () => "https://chatgpt.com/c/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" };
  const target = { label: "p2", url: async () => `https://chatgpt.com/g/g-p-project/c/${uuid}` };
  assert.equal(await selectUniqueConversationPage([other, target], uuid), target);
});

test("multiple Pages fail closed when no URL or more than one URL matches", async () => {
  const uuid = "12345678-1234-1234-1234-123456789abc";
  const makePage = (label, url) => ({ label, url: async () => url });
  const targetUrl = `https://chatgpt.com/g/g-p-project/c/${uuid}`;
  await assert.rejects(
    selectUniqueConversationPage([makePage("p1", "about:blank"), makePage("p2", "https://example.com/")], uuid),
    { code: "PAGE_URL_MATCH_NOT_FOUND" },
  );
  await assert.rejects(
    selectUniqueConversationPage([makePage("p1", targetUrl), makePage("p2", targetUrl)], uuid),
    { code: "PAGE_URL_MATCH_AMBIGUOUS" },
  );
});

test("multiple Pages fail closed if any URL cannot be inspected", async () => {
  const uuid = "12345678-1234-1234-1234-123456789abc";
  const target = { label: "p1", url: async () => `https://chatgpt.com/c/${uuid}` };
  const unavailable = { label: "p2", url: async () => { throw new Error("page lost"); } };
  await assert.rejects(
    selectUniqueConversationPage([target, unavailable], uuid),
    { code: "PAGE_URL_INSPECTION_FAILED" },
  );
});

// The probe recovery flow is inline; assert its branch order and required
// evidence instead of importing the adapter-bound executable monitor.
async function probeRecoverySource() {
  const source = await readFile(new URL("./ego-fast-probe.mjs", import.meta.url), "utf8");
  const start = source.indexOf("  const previousPageLabel = previous.pageLabel;");
  const end = source.indexOf("  pages = await task.pages();\n  await writeState(", start);
  assert.ok(start >= 0 && end > start, "probe page-recovery block not found");
  return source.slice(start, end);
}

test("probe recovery: zero matching pages creates a Page only after checking unmanaged tabs", async () => {
  const block = await probeRecoverySource();
  const inventory = block.indexOf("const tabs = await task.tabs()");
  const unmanaged = block.indexOf("const unmanagedMatches = tabs.filter");
  const create = block.indexOf("page = await task.newPage()");
  assert.ok(block.includes("pages = await task.pages()"));
  assert.ok(inventory > 0 && unmanaged > inventory && create > unmanaged);
  assert.match(block, /if \(unmanagedMatches\.length === 1\) \{[\s\S]*?\} else \{\s*page = await task\.newPage\(\)/);
  assert.equal((block.match(/task\.newPage\(/g) || []).length, 1);
});

test("probe recovery: one managed URL match reuses its Page without relying on label", async () => {
  const block = await probeRecoverySource();
  assert.match(block, /pages\.length === 1[\s\S]*?currentUrl = await pages\[0\]\.url\(\)/);
  assert.match(block, /if \(urlMatchesConversation\(currentUrl\)\) \{\s*page = pages\[0\]/);
  assert.doesNotMatch(block, /page = pages\.find\(/);
  assert.doesNotMatch(block, /previousPageLabel === page\.label/);
});

test("probe recovery: duplicate managed UUID URLs retain the ambiguous-page stop", async () => {
  const uuid = "12345678-1234-1234-1234-123456789abc";
  const makePage = (label) => ({ label, url: async () => `https://chatgpt.com/c/${uuid}` });
  await assert.rejects(selectUniqueConversationPage([makePage("p1"), makePage("p2")], uuid), {
    code: "PAGE_URL_MATCH_AMBIGUOUS",
  });
  const block = await probeRecoverySource();
  assert.match(block, /pages\.length > 1[\s\S]*?selectUniqueConversationPage\(pages, uuid\)/);
  assert.match(block, /error\?\.code !== "PAGE_URL_MATCH_NOT_FOUND"\) throw error/);
});

test("probe recovery: unique unmanaged UUID tab is adopted only with structured evidence", async () => {
  const block = await probeRecoverySource();
  assert.match(block, /exactHost \? parsed\.hostname === "chatgpt\.com"/);
  assert.match(block, /parsed\.pathname\.split\("\/"\)\.includes\(uuid\)/);
  assert.match(block, /!tab\.label && urlMatchesConversation\(tab\.url, true\)/);
  assert.match(block, /unmanagedMatches\.length > 1[\s\S]*?PAGE_URL_MATCH_AMBIGUOUS/);
  assert.match(block, /candidate\.openedBy !== "agent"[\s\S]*?candidate\.targetId/);
  assert.match(block, /page = await task\.adopt\(candidate\.page\)/);
  assert.match(block, /selectionEvidence = "UNIQUE_UNMANAGED_CONVERSATION_URL"/);
  assert.match(block, /appendEvent\(MON, "PAGE_ADOPTED"/);
  assert.ok(block.indexOf("PAGE_ADOPTED") < block.indexOf("page = await task.newPage()"));
});

function makeSurface({ composerText = "prompt body", role = "assistant", key = "11111111-1111-4111-8111-111111111111", generating = false, includeUnit = true, includeDilId = true } = {}) {
  const composer = {
    id: "prompt-textarea", tagName: "DIV", value: "", innerText: composerText,
    textContent: composerText, offsetParent: {},
    getClientRects: () => [{}],
    getAttribute: (name) => name === "data-testid" ? "prompt-textarea" : null,
  };
  const message = {
    innerText: "opaque message text", textContent: "opaque message text",
    offsetParent: {}, getClientRects: () => [{}],
    getAttribute: (name) => name === "data-dil-message-id" ? key : null,
  };
  const unitKey = role === "user" ? key : `fallback-turn-5:1:${role}`;
  const unit = {
    innerText: "opaque unit text", textContent: "opaque unit text",
    offsetParent: {}, getClientRects: () => [{}],
    getAttribute: (name) => name === "data-content-search-unit-key" ? unitKey : null,
    matches: () => false,
    querySelectorAll: (selector) => selector === "[data-dil-response][data-dil-message-id]" && includeDilId && role === "assistant"
      ? [message] : [],
  };
  const stop = {
    offsetParent: generating ? {} : null,
    getClientRects: () => generating ? [{}] : [],
    getAttribute: (name) => name === "aria-label" ? "Stop generating" : null,
  };
  const doc = {
    querySelectorAll(selector) {
      if (selector.includes("prompt-textarea") || selector.includes("contenteditable") || selector === "textarea") return [composer];
      if (selector === "[data-content-search-unit-key]") return includeUnit ? [unit] : [];
      if (selector === "[data-message-author-role]") return []; // retired selector must not be used
      if (selector === "button[aria-label]") return generating ? [stop] : [];
      if (selector.includes("aria-busy") || selector.includes("progressbar")) return [];
      return [];
    },
  };
  return { composer, message, unit, stop, doc };
}

function fakePage(surface) {
  return {
    async evaluate(fn) {
      const oldDoc = globalThis.document;
      const oldLocation = globalThis.location;
      globalThis.document = surface.doc;
      globalThis.location = { hostname: "chatgpt.com" };
      try { return await fn(); }
      finally {
        if (oldDoc === undefined) delete globalThis.document; else globalThis.document = oldDoc;
        if (oldLocation === undefined) delete globalThis.location; else globalThis.location = oldLocation;
      }
    },
  };
}

test("current DOM contract reads assistant role from the unit and UUID from the DIL response", async () => {
  const page = fakePage(makeSurface({
    role: "assistant",
    key: "36f4d3b1-5a26-4f19-9c87-9e4d8f2c1a30",
  }));
  const surface = await readComposerSurface(page);
  assert.equal(surface.lastMessageRole, "assistant");
  assert.equal(surface.lastMessageKey, "36f4d3b1-5a26-4f19-9c87-9e4d8f2c1a30");
  assert.equal(surface.lastMessageTextLength, "opaque message text".length);
});

test("assistant DIL UUID is also read when the content unit is the response element", async () => {
  const surface = makeSurface();
  surface.unit.matches = (selector) => selector === "[data-dil-response][data-dil-message-id]";
  surface.unit.getAttribute = (name) => {
    if (name === "data-content-search-unit-key") return "fallback-turn-5:1:assistant";
    if (name === "data-dil-message-id") return "36f4d3b1-5a26-4f19-9c87-9e4d8f2c1a30";
    return null;
  };
  surface.unit.querySelectorAll = () => [];
  const measured = await readComposerSurface(fakePage(surface));
  assert.equal(measured.lastMessageRole, "assistant");
  assert.equal(measured.lastMessageKey, "36f4d3b1-5a26-4f19-9c87-9e4d8f2c1a30");
});

test("current DOM contract uses the unit key as the user-tail identity", async () => {
  const page = fakePage(makeSurface({ role: "user", key: "fallback-turn-8:0:user" }));
  const surface = await readComposerSurface(page);
  assert.equal(surface.lastMessageRole, "user");
  assert.equal(surface.lastMessageKey, "fallback-turn-8:0:user");
});

test("tail identity fails closed when the unit or assistant DIL UUID is unavailable", async () => {
  const noUnit = await readComposerSurface(fakePage(makeSurface({ includeUnit: false })));
  assert.equal(noUnit.lastMessageRole, null);
  assert.equal(noUnit.lastMessageKey, null);

  const noAssistantId = await readComposerSurface(fakePage(makeSurface({ includeDilId: false })));
  assert.equal(noAssistantId.lastMessageRole, "assistant");
  assert.equal(noAssistantId.lastMessageKey, null);
});

test("assistant tail identity rejects non-UUID and ambiguous DIL identifiers", async () => {
  const malformed = await readComposerSurface(fakePage(makeSurface({
    key: "fallback-turn-5:1:assistant",
  })));
  assert.equal(malformed.lastMessageRole, "assistant");
  assert.equal(malformed.lastMessageKey, null);

  const ambiguousSurface = makeSurface();
  ambiguousSurface.unit.querySelectorAll = () =>
    [ambiguousSurface.message, ambiguousSurface.message];
  const ambiguous = await readComposerSurface(fakePage(ambiguousSurface));
  assert.equal(ambiguous.lastMessageRole, "assistant");
  assert.equal(ambiguous.lastMessageKey, null);
});

test("absolute backoff deadline does not slide when state timestamp advances", () => {
  const t0 = 100000;
  const deadline = nextBackoffUntil(t0);
  const state = normalizeFastState({}, { backoffUntil: deadline, probeFailed: true }, t0 + 60000);
  const next = normalizeFastState(state, {}, t0 + 120000);
  assert.equal(next.backoffUntil, deadline);
  assert.equal(next.ts, t0 + 120000);
  assert.equal(isBackoffActive(next, deadline - 1), true);
  assert.equal(isBackoffActive(next, deadline), false);
});

test("every normalized outcome has the complete schema and drops legacy response text", () => {
  const state = normalizeFastState({ ts: 123, tail: "private answer", generating: true }, { errorCode: "GOTO_FAILED" }, 456);
  assert.equal(state.schema, FAST_STATE_SCHEMA);
  assert.equal(state.ts, 456);
  assert.equal(state.tail, undefined);
  assert.equal(validateFastState(state), true);
  assert.deepEqual(Object.keys(state).sort(), Object.keys(FAST_STATE_DEFAULTS).sort());
});

test("malformed legacy fields normalize to schema defaults", () => {
  const state = normalizeFastState({ ts: "bad", deadStrikes: 2, composerEmpty: "false", spaceId: true }, {}, 900);
  assert.equal(state.ts, 900);
  assert.equal(state.unavailableStrikes, 2);
  assert.equal(state.composerEmpty, null);
  assert.equal(state.spaceId, null);
  assert.equal(validateFastState(state), true);
});

test("malformed or partial v3 state is rejected by the schema validator", () => {
  const state = normalizeFastState({}, {}, 1000);
  assert.equal(validateFastState(state), true);
  const partial = { ...state };
  delete partial.generating;
  assert.equal(validateFastState(partial), false);
  const wrongType = { ...state, deadStrikes: "2" };
  assert.equal(validateFastState(wrongType), false);
  const legacyLeak = { ...state, tail: "private response" };
  assert.equal(validateFastState(legacyLeak), false);
});

test("dispatch baseline uses composer and stable tail identity, never virtualized user-turn counts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ego-dispatch-"));
  try {
    const surface = makeSurface({ composerText: "", role: "assistant", key: "11111111-1111-4111-8111-111111111111" });
    const page = fakePage(surface);
    const measured = await readComposerSurface(page);
    assert.equal(measured.composerEmpty, true);
    assert.equal(measured.lastMessageKey, "11111111-1111-4111-8111-111111111111");
    assert.equal("userTurns" in measured, false);

    const dispatch = await prepareDispatch({
      monitorDir: dir, conversationUuid: "12345678-1234-1234-1234-123456789abc",
      taskSpace: "monitor-test", pageLabel: "p1", page,
    });
    await markSendStarted(dir, dispatch.dispatchId);
    const stored = await readFile(join(dir, "a-dispatch-state.json"), "utf8");
    assert.equal(stored.includes("secret prompt"), false);
    assert.equal(stored.includes("baselineUserCount"), false);

    surface.composer.innerText = "";
    surface.composer.textContent = "";
    surface.unit.getAttribute = (name) => name === "data-content-search-unit-key"
      ? "fallback-turn-6:0:user" : null;
    const accepted = await markAccepted(dir, dispatch.dispatchId, page);
    assert.equal(accepted.status, "ACCEPTED");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("completed assistant tail is a structural acceptance signal without user-turn counts", () => {
  const record = { baselineTailKey: "old-message" };
  assert.equal(hasResponseTailAdvanced(record, {
    lastMessageKey: "new-assistant-message", lastMessageRole: "assistant",
  }), true);
  assert.equal(hasResponseTailAdvanced(record, {
    lastMessageKey: "old-message", lastMessageRole: "assistant",
  }), false);
});

test("restart reconciliation refuses to accept a composer draft that survived goto", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ego-reconcile-"));
  try {
    const surface = makeSurface({ composerText: "", role: "assistant", key: "11111111-1111-4111-8111-111111111111" });
    const page = fakePage(surface);
    const dispatch = await prepareDispatch({
      monitorDir: dir, conversationUuid: "12345678-1234-1234-1234-123456789abc",
      taskSpace: "monitor-test", pageLabel: "p1", page,
    });
    await markSendStarted(dir, dispatch.dispatchId);
    // the draft "survived goto": composer still holds text at reconciliation time (r44 P0-B3: PREPARED is pre-fill, so the draft surface is supplied here)
    const draftPage = fakePage(makeSurface({ composerText: "secret prompt", role: "assistant", key: "11111111-1111-4111-8111-111111111111" }));
    const result = await reconcileDispatch(dir, dispatch.conversationUuid, await readComposerSurface(draftPage));
    assert.equal(result.result, "UNCERTAIN");
    assert.equal(result.record.reasonCode, "DRAFT_PERSISTED");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- R2.4.1 regression: unified structural readiness, 429 single-retry, timeOrigin failure ----

test("chatSurfaceReady: STAY passes on short body; navigated rounds need body > 600", () => {
  const ok = { hostOk: true, composerCount: 1 };
  // STAY + bodyLen 43 / 500 with intact structure: pass (planner acceptance rows 1-2)
  assert.equal(chatSurfaceReady({ ...ok, bodyLen: 43, navigatedThisRound: false }), true);
  assert.equal(chatSurfaceReady({ ...ok, bodyLen: 500, navigatedThisRound: false }), true);
  // STAY round that recovered via navigation + bodyLen 500: fail (row 3)
  assert.equal(chatSurfaceReady({ ...ok, bodyLen: 500, navigatedThisRound: true }), false);
  // RECOVER + bodyLen 500: fail (row 4)
  assert.equal(chatSurfaceReady({ ...ok, bodyLen: 500, navigatedThisRound: true }), false);
  // navigated + bodyLen > 600: pass
  assert.equal(chatSurfaceReady({ ...ok, bodyLen: 601, navigatedThisRound: true }), true);
  // structure missing is never ready regardless of body length
  assert.equal(chatSurfaceReady({ hostOk: true, composerCount: 0, bodyLen: 5000, navigatedThisRound: false }), false);
  assert.equal(chatSurfaceReady({ hostOk: false, composerCount: 1, bodyLen: 5000, navigatedThisRound: false }), false);
});

test("probe uses one shared readiness gate at all three checkpoints (R2.4.1 BLOCKER 1)", async () => {
  const source = await readFile(new URL("./ego-fast-probe.mjs", import.meta.url), "utf8");
  const uses = source.match(/isChatSurfaceReady\(/g) || [];
  assert.ok(uses.length >= 3, `expected readiness gate shared across checkpoints (calls + wiring), got ${uses.length}`);
  assert.match(source, /const isChatSurfaceReady = \(sample\) => chatSurfaceReady/);
  // the contradicting old gates must be gone
  assert.doesNotMatch(source, /roundKind === "STAY" \? true : probe\.bodyLen > 600/);
  assert.doesNotMatch(source, /probe\.hostOk && probe\.bodyLen > 600 && probe\.composerCount > 0/);
  assert.match(source, /let navigatedThisRound = false;/);
  assert.match(source, /async function navigate\(reason\) \{\s*navigatedThisRound = true;/);
});

test("probe performs exactly one 429_RETRY navigation when the storm deadline expires (R2.4.1 BLOCKER 2)", async () => {
  const source = await readFile(new URL("./ego-fast-probe.mjs", import.meta.url), "utf8");
  // scheduling decision lives in the pure planner consulted by the probe
  assert.match(source, /const stormPlan = planStormRecovery\(previous, now\(\)\);/);
  assert.match(source, /navigate: \(\) => navigate\(stormRetryReason\)/);
  assert.match(source, /"COMPOSER_FREEZE_RETRY"\s*:\s*"429_RETRY"/);
  // the single recovery navigation sits before the round-kind decision and its ladder
  assert.ok(source.indexOf("const stormRetryReason") < source.indexOf("decideRoundKind({"));
  assert.ok(source.indexOf("const stormRetryReason") < source.indexOf('navigate("DEAD_PAGE_RETRY")'));
  // failed retry re-arms a fresh absolute storm deadline via the shared re-arm builder
  const retryBranch = source.slice(source.indexOf("const stormRetryReason"), source.indexOf("decideRoundKind({"));
  assert.match(retryBranch, /const rearm = stormRearmState\(\{ previous, detectedAt, phaseMs \}\);/);
  assert.doesNotMatch(retryBranch, /navigate\("DEAD_PAGE_RETRY"\)/);
  assert.match(source, /unavailableStrikes: 0, unavailablePersistent: false, errorCode: null, errorName: null/);
});

test("probe treats timeOrigin evaluate failure as RECOVER, not a missing timestamp (R2.4.1)", async () => {
  const source = await readFile(new URL("./ego-fast-probe.mjs", import.meta.url), "utf8");
  assert.match(source, /timeOriginOk = false;/);
  assert.match(source, /if \(!timeOriginOk\) \{\s*roundKind = "RECOVER";/);
});

// ---- R2.4.1.1 execution-level 429 recovery tests (planner acceptance table) ----

test("429 deadline not reached: recovery planner returns null → 0 goto", () => {
  const t = 1_800_000_000_000;
  const prev = { errorCode: "CHAT_SURFACE_STRUCTURALLY_UNAVAILABLE", backoffUntil: t + 9 * 60 * 1000 };
  assert.equal(planStormRecovery(prev, t), null);
  assert.equal(planStormRecovery(prev, t + 9 * 60 * 1000 - 1), null);
  // other error classes and missing fields never schedule a storm retry
  assert.equal(planStormRecovery({ errorCode: "GOTO_FAILED", backoffUntil: t }, t), null);
  assert.equal(planStormRecovery({ errorCode: "CHAT_SURFACE_STRUCTURALLY_UNAVAILABLE", backoffUntil: null }, t), null);
  assert.equal(planStormRecovery(null, t), null);
});

test("429 deadline expired: recovery planner schedules exactly one retry; process restart reads the persisted re-armed deadline", () => {
  const t = 1_800_000_000_000;
  const phase = spacePhaseMs("fast-poll-6aef5b8c-mon-r24-039");
  // first expiry → exactly one retry decision
  const prev = { errorCode: "CHAT_SURFACE_STRUCTURALLY_UNAVAILABLE", backoffUntil: t };
  assert.deepEqual(planStormRecovery(prev, t), { action: "429_RETRY" });
  assert.deepEqual(planStormRecovery(prev, t + 5 * 60 * 1000), { action: "429_RETRY" });
  // failure re-arms a storm-classified deadline (>= 9min, never the plain 8-min goto backoff)
  const detectedAt = t + 6 * 60 * 1000;
  const rearm = stormBackoffDeadline({ detectedAt, phaseMs: phase });
  assert.ok(rearm >= detectedAt + 9 * 60 * 1000, "storm re-arm must be at least 9 minutes");
  assert.ok(rearm >= detectedAt + 8 * 60 * 1000);
  // cross-process restart: the re-armed state persists, validates, and gates the next process
  const normalized = normalizeFastState(FAST_STATE_DEFAULTS, {
    errorCode: "CHAT_SURFACE_STRUCTURALLY_UNAVAILABLE",
    backoffUntil: rearm,
    unavailableStrikes: 2,
    unavailablePersistent: false,
  }, detectedAt);
  assert.equal(validateFastState(normalized), true);
  assert.equal(normalized.errorCode, "CHAT_SURFACE_STRUCTURALLY_UNAVAILABLE");
  assert.equal(isBackoffActive(normalized, rearm - 1), true, "next process must stay in backoff until the re-armed deadline");
  assert.equal(planStormRecovery(normalized, rearm - 1), null);
  assert.deepEqual(planStormRecovery(normalized, rearm), { action: "429_RETRY" });
});

test("429 failure paths keep storm semantics: navigation failure and read failure re-arm, never GOTO_FAILED/8-min", async () => {
  const source = await readFile(new URL("./ego-fast-probe.mjs", import.meta.url), "utf8");
  const stormBranch = source.slice(source.indexOf("const stormPlan"), source.indexOf("// Decide the round kind"));
  // both failure exits route through the storm re-arm helper, not nextBackoffUntil/GOTO_FAILED
  assert.match(stormBranch, /stormRetryFailed\("NAVIGATION_FAILED", error\)/);
  assert.match(stormBranch, /stormRetryFailed\("READ_FAILED", run\.error\)/);
  assert.doesNotMatch(stormBranch, /nextBackoffUntil/);
  assert.doesNotMatch(stormBranch, /errorCode: "GOTO_FAILED"/);
  // the re-arm helper itself persists the storm classifier and a recomputed storm deadline
  const helper = source.slice(source.indexOf("async function stormRetryFailed"), source.indexOf("const stormPlan"));
  assert.match(helper, /const rearm = stormRearmState\(\{ previous, detectedAt, phaseMs, baseError: safeError\(error\) \}\);/);
  assert.match(helper, /appendEvent\(MON, "429_RETRY_FAILED"/);
  // recovery round is labeled RECOVER, and the storm event carries full scheduling evidence
  assert.match(stormBranch, /roundKind = "RECOVER";/);
  for (const field of ["detectedAt", "stormBackoffDeadline: rearm.backoffUntil", "phaseMs", "space: SPACE"]) {
    assert.ok(stormBranch.includes(field) || helper.includes(field), `missing event evidence: ${field}`);
  }
  // the original detection site records the same evidence set
  const detectBranch = source.slice(source.indexOf("CHAT_SURFACE_STRUCTURALLY_UNAVAILABLE", source.indexOf("// Fresh loads") + 100));
  assert.match(detectBranch, /detectedAt, stormBackoffDeadline: backoffUntil, phaseMs/);
});

// ---- R2.4.1.1 final wrap-up: mock-executed 429 branch + unified gotoAt timestamp ----

test("mock-executed 429 branch: exactly one goto per invocation across all four outcomes", async () => {
  const t = 1_800_000_000_000;
  const phase = spacePhaseMs("fast-poll-6aef5b8c-mon-r24-039");
  const ok = { hostOk: true, composerCount: 1, bodyLen: 8000 };
  const runOnce = async (navigateImpl, readImpl, sample) => {
    let gotoCount = 0;
    const result = {};
    try {
      result.run = await runStormRetry({
        navigate: async () => { gotoCount++; return navigateImpl ? navigateImpl() : undefined; },
        readAfterNavigate: async () => (readImpl ? readImpl() : sample),
        isReady: (s) => chatSurfaceReady({ ...s, navigatedThisRound: true }),
      });
    } catch (error) {
      result.error = error;
    }
    return { gotoCount, ...result };
  };

  // 1. success: exactly 1 goto, then the storm state is cleared
  {
    const { gotoCount, run, error } = await runOnce(null, null, ok);
    assert.equal(error, undefined);
    assert.equal(gotoCount, 1);
    assert.equal(run.outcome, "RECOVERED");
    const clear = { probeFailed: false, recoveryFailed: false, backoffUntil: null, unavailableStrikes: 0, unavailablePersistent: false, errorCode: null, errorName: null };
    assert.equal(clear.errorCode, null);
    assert.equal(clear.backoffUntil, null);
  }
  // 2. navigation failure: exactly 1 goto, storm re-arm semantics (never plain 8-min)
  {
    let gotoCount = 0;
    let rearmCalls = 0;
    let captured = null;
    const detectedAt = t + 6 * 60 * 1000;
    try {
      await runStormRetry({
        navigate: async () => { gotoCount++; throw new Error("net down"); },
        readAfterNavigate: async () => ok,
        isReady: () => true,
      });
      assert.fail("navigation failure must propagate");
    } catch (error) {
      captured = stormRearmState({ previous: { unavailableStrikes: 0 }, detectedAt, phaseMs: phase, baseError: { errorName: "Error" } });
      rearmCalls++;
      assert.equal(error.message, "net down");
    }
    assert.equal(gotoCount, 1);
    assert.equal(rearmCalls, 1);
    assert.equal(captured.errorCode, "CHAT_SURFACE_STRUCTURALLY_UNAVAILABLE");
    assert.ok(captured.backoffUntil >= detectedAt + 9 * 60 * 1000, "re-arm must be at least 9 minutes");
    assert.equal(captured.unavailableStrikes, 1);
  }
  // 3. read failure after navigation: exactly 1 goto, no second navigation
  {
    const { gotoCount, run } = await runOnce(null, async () => { throw new Error("evaluate timeout"); }, ok);
    assert.equal(gotoCount, 1);
    assert.equal(run.outcome, "READ_FAILED");
    assert.equal(run.gotoCount, 1);
    // the original injected exception must survive intact for diagnostics
    assert.ok(run.error instanceof Error);
    assert.equal(run.error.message, "evaluate timeout");
    const rearm = stormRearmState({ previous: { unavailableStrikes: 0 }, detectedAt: t, phaseMs: phase });
    assert.equal(rearm.errorCode, "CHAT_SURFACE_STRUCTURALLY_UNAVAILABLE");
    assert.ok(rearm.backoffUntil >= t + 9 * 60 * 1000);
  }
  // 4. structure still missing: exactly 1 goto, re-arm again
  {
    const { gotoCount, run } = await runOnce(null, null, { hostOk: true, composerCount: 0, bodyLen: 43 });
    assert.equal(gotoCount, 1);
    assert.equal(run.outcome, "STRUCTURE_FAILED");
    const detectedAt = t;
    const rearm = stormRearmState({ previous: { unavailableStrikes: 2 }, detectedAt, phaseMs: phase });
    assert.equal(rearm.errorCode, "CHAT_SURFACE_STRUCTURALLY_UNAVAILABLE");
    assert.ok(rearm.backoffUntil >= detectedAt + 9 * 60 * 1000);
    assert.equal(rearm.unavailablePersistent, true);
    assert.equal(rearm.unavailableStrikes, 3);
  }
});

test("probe stamps one shared gotoAt and emits goto_reason/agent_id on GOTO_ATTEMPT", async () => {
  const source = await readFile(new URL("./ego-fast-probe.mjs", import.meta.url), "utf8");
  assert.match(source, /const gotoAt = now\(\);/);
  assert.match(source, /goto_reason: reason, at: gotoAt, agent_id: SPACE, space: SPACE,\s*roundKind, lastGotoAt: gotoAt,/s);
  assert.match(source, /await writeState\(\{ lastGotoAt: gotoAt \}\);/);
  // no stray now() calls left inside the navigate entry
  const navigateBody = source.slice(source.indexOf("async function navigate(reason)"), source.indexOf("async function stormRetryFailed"));
  assert.equal((navigateBody.match(/now\(\)/g) || []).length, 1);
  // storm evidence events carry agent_id too
  assert.match(source, /agent_id: SPACE, space: SPACE, roundKind, strikes: rearm\.unavailableStrikes/);
  assert.match(source, /retry: "429_RETRY", detectedAt, stormBackoffDeadline: rearm\.backoffUntil/);
});

// ---- R2.5 Composer delivery reliability: chunk/ownership/ledger/freeze helpers ----

test("chunkPayload: 600-grapheme target, 1200-byte hard cap, exact reconstruction, and line-edge adjustment", async () => {
  const { chunkPayload } = await import("./dispatch-state.mjs");
  const countGraphemes = (value) =>
    Array.from(new Intl.Segmenter("und", { granularity: "grapheme" }).segment(value)).length;

  const longLines = Array.from({ length: 24 }, (_, i) => "line-" + i + ":" + "园".repeat(80)).join("\n");
  const chunks = chunkPayload(longLines);
  assert.equal(chunks.join(""), longLines);
  for (const chunk of chunks) {
    assert.ok(Buffer.byteLength(chunk, "utf8") <= 1200, "chunk exceeds the hard UTF-8 byte limit");
    assert.ok(countGraphemes(chunk) <= 602, "chunk exceeded the 600-grapheme target beyond line adjustment");
  }
  assert.ok(chunks.slice(0, -1).every((chunk) => !chunk.endsWith("\n") && !chunk.endsWith("\r")),
    "non-final chunks should not end at a line break when an interior boundary is available");

  // An 1831-character payload remains lossless and is split by the target size.
  const incidentSample = "x".repeat(1831);
  const incidentChunks = chunkPayload(incidentSample);
  assert.equal(incidentChunks.join(""), incidentSample);
  assert.deepEqual(incidentChunks.map(countGraphemes), [600, 600, 600, 31]);

  // A boundary immediately before or after a line break moves into the next line.
  const beforeBreak = "a".repeat(20) + "\n" + "b".repeat(30);
  assert.equal(chunkPayload(beforeBreak, 100, 20)[0], "a".repeat(20) + "\nb");
  const afterBreak = "a".repeat(19) + "\n" + "b".repeat(30);
  assert.equal(chunkPayload(afterBreak, 100, 20)[0], "a".repeat(19) + "\nb");
  const byteLimitedEdge = "a".repeat(1199) + "\n" + "b".repeat(10);
  const byteLimitedChunks = chunkPayload(byteLimitedEdge, 1200, 2000);
  assert.equal(byteLimitedChunks.join(""), byteLimitedEdge);
  assert.equal(byteLimitedChunks[0], "a".repeat(1198));

  // Long blank-line runs must not make a boundary adjustment exceed the chunk target.
  const blankLineRun = "a".repeat(19) + "\n" + "\n".repeat(1000) + "b".repeat(30);
  const blankLineChunks = chunkPayload(blankLineRun, 100, 20);
  assert.equal(blankLineChunks.join(""), blankLineRun);
  assert.ok(blankLineChunks.every((chunk) => countGraphemes(chunk) <= 22));
  assert.ok(blankLineChunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= 100));

  // CJK reaches the byte cap before the grapheme target.
  const cjk = "庭".repeat(900);
  const cjkChunks = chunkPayload(cjk);
  assert.equal(cjkChunks.join(""), cjk);
  assert.ok(cjkChunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= 1200));
  assert.deepEqual(cjkChunks.map(countGraphemes), [400, 400, 100]);

  // Emoji ZWJ sequences and combining marks are indivisible grapheme clusters.
  const family = "👨‍👩‍👧‍👦";
  const emojiChunks = chunkPayload(family.repeat(5), 120, 2);
  assert.deepEqual(emojiChunks, [family + family, family + family, family]);
  const composed = "e\u0301";
  assert.deepEqual(chunkPayload(composed.repeat(5), 100, 2), [composed + composed, composed + composed, composed]);

  // CRLF/LF and trailing separators survive exactly.
  const mixedLines = "a\r\nb\nc\r\n";
  const mixedChunks = chunkPayload(mixedLines, 100, 2);
  assert.equal(mixedChunks.join(""), mixedLines);
  assert.ok(mixedChunks.slice(0, -1).every((chunk) => !chunk.endsWith("\n") && !chunk.endsWith("\r")));
  assert.deepEqual(chunkPayload("", 1200, 600), []);
  assert.deepEqual(chunkPayload("hello", 1200, 600), ["hello"]);
  assert.throws(() => chunkPayload("a" + "\u0301".repeat(700), 1200, 600),
    { message: "CHUNK_GRAPHEME_EXCEEDS_LIMIT" });
  assert.throws(() => chunkPayload("hello", 0, 600), { message: "BYTE_LIMIT_NOT_POSITIVE_INT" });
  assert.throws(() => chunkPayload("hello", 1200, 0), { message: "TARGET_CHARS_NOT_POSITIVE_INT" });
});

test("composer artifact normalization is collapse-to-one-space and chunk readback outcomes are explicit", async () => {
  const m = await import("./dispatch-state.mjs");
  const payload = "alpha line\nbeta line\nfinal";
  assert.equal(m.collapseComposerArtifacts("alpha line\n\nbeta line\n\nfinal"), "alpha line beta line final");
  assert.equal(m.readbackMatches(payload, "alpha line\n\nbeta line\n\nfinal"), true);
  assert.equal(m.readbackMatches(payload, "alpha line\nbeta line\nfinal"), true);
  assert.equal(m.readbackMatches(payload, "alpha line\nbeta line CHANGED"), false);
  assert.equal(m.readbackMode(payload), "normalized");

  const fence = String.fromCharCode(96).repeat(3);
  const sensitive = "check https://example.com/a b and " + fence + "code" + fence;
  assert.equal(m.readbackMode(sensitive), "strict");
  assert.equal(m.readbackMatches(sensitive, sensitive), true);
  assert.equal(m.readbackMatches("safe prefix", "safe prefix\n", "strict"), false);
  assert.equal(m.readbackMatches("safe prefix", "safe prefix\n", "normalized"), true);

  assert.equal(m.classifyChunkReadback("", "first chunk", "\n", "normalized"), "NO_EFFECT");
  assert.equal(m.classifyChunkReadback("", "first chunk", "first chunk", "strict"), "INSERTED");
  assert.equal(m.classifyChunkReadback("first", "first second", "first second", "strict"), "INSERTED");
  assert.equal(m.classifyChunkReadback("first", "first second", "first", "strict"), "NO_EFFECT");
  assert.equal(m.classifyChunkReadback("first", "first second", "second first", "normalized"), "MISMATCH");
  // A whitespace-only chunk is accepted only when raw readback proves which side won.
  assert.equal(m.classifyChunkReadback("prefix", "prefix ", "prefix ", "normalized"), "INSERTED");
  assert.equal(m.classifyChunkReadback("prefix", "prefix ", "prefix", "normalized"), "NO_EFFECT");
  assert.equal(m.classifyChunkReadback("prefix", "prefix ", "prefix  ", "normalized"), "MISMATCH");
  assert.equal(m.readbackMatches("see https://x.com/a\nb", "see https://x.com/a\n\nb"), false);
  assert.equal(m.readbackMatches("$deploy --flag\nsecond line", "$deploy  --flag\nsecond line"), false);
});

test("verifyDraftOwnership: full/prefix for current dispatch, hash identity for historical, never substrings", async () => {
  const m = await import("./dispatch-state.mjs");
  const payload = "first paragraph of the dispatch\nsecond paragraph with more words here\nthird";
  const prepared = { status: "PREPARED" };
  // full (with composer block artifacts)
  assert.deepEqual(m.verifyDraftOwnership({ draft: "first paragraph of the dispatch\n\nsecond paragraph with more words here\n\nthird", payload, record: prepared }), { owned: true, kind: "full" });
  // in-order valid prefix (interrupted mid-fill)
  assert.deepEqual(m.verifyDraftOwnership({ draft: "first paragraph of the dispatch\n\nsecond", payload, record: prepared }), { owned: true, kind: "prefix" });
  // reordered fragment / arbitrary substring is NOT owned
  const foreign = m.verifyDraftOwnership({ draft: "second paragraph with more words here", payload, record: prepared });
  assert.equal(foreign.owned, false);
  assert.equal(foreign.kind, "foreign");
  // empty draft is its own branch
  assert.deepEqual(m.verifyDraftOwnership({ draft: "\n", payload, record: prepared }), { owned: true, kind: "empty" });
  // SEND_STARTED and later: locked, never cleared or refilled
  const locked = m.verifyDraftOwnership({ draft: "first paragraph of the dispatch", payload, record: { status: "SEND_STARTED" } });
  assert.equal(locked.owned, false);
  assert.equal(locked.kind, "send-started-locked");
  // historical: only a persisted full-content fingerprint proves ownership
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update("old dispatch text", "utf8").digest("hex");
  assert.deepEqual(m.verifyDraftOwnership({ draft: "old dispatch text", payload: null, record: { status: "COMPLETED", payload_sha256: hash } }), { owned: true, kind: "historical-identity" });
  const hist = m.verifyDraftOwnership({ draft: "something else entirely", payload: null, record: { status: "COMPLETED", payload_sha256: hash } });
  assert.equal(hist.owned, false);
  // no evidence at all → STOP
  assert.equal(m.verifyDraftOwnership({ draft: "mystery draft", payload: null, record: { status: "COMPLETED" } }).owned, false);
});

test("ledger PREPARED stores fingerprint + bytes, never the payload text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ego-ledger-"));
  try {
    const m = await import("./dispatch-state.mjs");
    const payload = "TOP SECRET dispatch body line one\nline two https://example.com";
    const surface = makeSurface({ composerText: "", role: "assistant", key: "22222222-2222-4222-8222-222222222222" });
    const page = fakePage(surface);
    const dispatch = await m.prepareDispatch({
      monitorDir: dir, conversationUuid: "12345678-1234-1234-1234-123456789abc",
      taskSpace: "monitor-test", pageLabel: "p1", page, payload,
    });
    const stored = JSON.parse(await readFile(join(dir, "a-dispatch-state.json"), "utf8"));
    const serialized = JSON.stringify(stored);
    assert.ok(!serialized.includes("TOP SECRET"), "ledger must not contain the payload text");
    assert.ok(!serialized.includes("example.com"), "ledger must not contain payload fragments");
    const { createHash } = await import("node:crypto");
    assert.equal(stored.payload_sha256, createHash("sha256").update(payload, "utf8").digest("hex"));
    assert.equal(stored.payload_bytes, Buffer.byteLength(payload, "utf8"));
    assert.equal(typeof stored.composer_baseline, "string");
    assert.deepEqual(JSON.parse(stored.composer_baseline), { composerLength: 0, composerEmpty: true, lastMessageRole: "assistant", lastMessageKey: "22222222-2222-4222-8222-222222222222" });
    assert.equal(dispatch.dispatchId.length > 0, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fill counter persists per space and resets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ego-fillcount-"));
  try {
    const m = await import("./dispatch-state.mjs");
    assert.equal(await m.getFillCount(dir, "space-a"), 0);
    assert.equal(await m.recordFillAttempt(dir, "space-a"), 1);
    assert.equal(await m.recordFillAttempt(dir, "space-a"), 2);
    assert.equal(await m.recordFillAttempt(dir, "space-b"), 1);
    assert.equal(await m.getFillCount(dir, "space-a"), 2);
    assert.equal(await m.resetFillCount(dir, "space-a"), 0);
    assert.equal(await m.getFillCount(dir, "space-a"), 0);
    assert.equal(await m.getFillCount(dir, "space-b"), 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("markComposerFreeze records the event; probe consumption writes the shared storm channel once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ego-freeze-"));
  try {
    const m = await import("./dispatch-state.mjs");
    await copyFile(new URL("./state-schema.mjs", import.meta.url), join(dir, "state-schema.mjs"));
    const freeze = await m.markComposerFreeze(dir, { space: "fast-poll-6aef5b8c-mon-r24-039", error: new Error("PageEvaluationTimeout") });
    assert.ok(freeze.freezeId && Number.isFinite(freeze.stormBackoffDeadline));
    const pending = await m.findUnconsumedComposerFreeze(dir);
    assert.equal(pending.freezeId, freeze.freezeId);
    assert.equal(pending.event, "COMPOSER_RENDER_FREEZE");
    assert.ok(pending.stormBackoffDeadline >= freeze.detectedAt + 9 * 60 * 1000);
    const freeze2 = await m.markComposerFreeze(dir, { space: "fast-poll-6aef5b8c-mon-r24-039", error: new Error("again") });
    assert.equal((await m.findUnconsumedComposerFreeze(dir)).freezeId, freeze2.freezeId);
    await m.appendEvent(dir, "COMPOSER_FREEZE_CONSUMED", { freezeId: freeze2.freezeId, stormBackoffDeadline: freeze2.stormBackoffDeadline });
    await m.appendEvent(dir, "COMPOSER_FREEZE_CONSUMED", { freezeId: freeze.freezeId, stormBackoffDeadline: freeze.stormBackoffDeadline });
    assert.equal(await m.findUnconsumedComposerFreeze(dir), null);
    assert.equal(await m.lastConsumedFreezeDeadline(dir), freeze.stormBackoffDeadline);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// r44 P0-A1: ledger reads are fail-closed — missing file = provably empty, read error = throw.
test("ledger reads: ENOENT is provably empty, real read errors throw (never fail-open)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ego-ledgerread-"));
  try {
    const m = await import("./dispatch-state.mjs");
    await copyFile(new URL("./state-schema.mjs", import.meta.url), join(dir, "state-schema.mjs"));
    // missing files = provably empty, both channels
    assert.equal(await m.readDispatchState(dir), null);
    assert.equal(await m.findUnconsumedComposerFreeze(dir), null);
    // a-frozen events path being a directory = real read error → must throw, not fake-empty
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "a-fast-events.ndjson"));
    await assert.rejects(() => m.findUnconsumedComposerFreeze(dir));
    // corrupt dispatch ledger JSON = real read error → must throw
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "a-dispatch-state.json"), "{not json", "utf8");
    await assert.rejects(() => m.readDispatchState(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// r45 LIMITED GO (issue #6): probe bootstrap requires the account pin — bare taskSpace(SPACE) creation forbidden.
test("probe bootstrap is pin-locked: explicit profileId creation + post-create verification + mismatch STOP", async () => {
  const src = await readFile(new URL("./ego-fast-probe.mjs", import.meta.url), "utf8");
  for (const marker of ["TASKSPACE_BOOTSTRAP_NO_PIN", "TASKSPACE_BOOTSTRAP_PROFILE_UNKNOWN", "TASKSPACE_BOOTSTRAP_VERIFY_FAILED", "TASKSPACE_PROFILE_MISMATCH_STOP", "SPACE_BOOTSTRAPPED"]) {
    assert.ok(src.includes(marker), `missing bootstrap marker: ${marker}`);
  }
  assert.match(src, /taskSpace\(SPACE, \{ profileId: pinnedProfileId \}\)/);
  assert.doesNotMatch(src, /await taskSpace\(SPACE\)/, "bare taskSpace(SPACE) creation call is forbidden");
});
