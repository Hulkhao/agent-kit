// One schema and one normalizer for every probe outcome.
import { createHash } from "node:crypto";

export const FAST_STATE_SCHEMA = "ego-fast-state/v3";

export const FAST_STATE_DEFAULTS = Object.freeze({
  schema: FAST_STATE_SCHEMA,
  ts: 0,
  spaceId: null,
  pageLabel: null,
  generationKey: null,
  pageCount: 0,
  generating: false,
  everGenerating: false,
  len: 0,
  bodyChanged: false,
  lastProgressAt: null,
  lastGotoAt: null,
  startIdle: false,
  doneCandidate: false,
  gapRejected: 0,
  probeFailed: false,
  backoffUntil: null,
  unavailableStrikes: 0,
  unavailablePersistent: false,
  uiSchema: "UNKNOWN",
  composerCount: 0,
  composerEmpty: null,
  lastMessageRole: null,
  lastMessageKey: null,
  lastMessageTextLength: 0,
  stopLabelCount: 0,
  buttonLabels: [],
  activityMarkers: [],
  busyCount: 0,
  dispatchId: null,
  dispatchStatus: "UNTRACKED",
  toolState: "UNOBSERVED",
  finalVerification: "SUPERVISOR_API_REQUIRED",
  recoveryFailed: false,
  errorName: null,
  errorCode: null,
});

const ARRAY_FIELDS = new Set(["buttonLabels", "activityMarkers"]);
const BOOL_FIELDS = new Set([
  "generating", "everGenerating", "bodyChanged", "startIdle", "doneCandidate",
  "probeFailed", "unavailablePersistent", "recoveryFailed",
]);
const NUMBER_FIELDS = new Set([
  "ts", "pageCount", "len", "gapRejected", "unavailableStrikes", "composerCount",
  "lastMessageTextLength", "stopLabelCount", "busyCount",
]);

export function normalizeFastState(previous = {}, patch = {}, timestamp = Date.now()) {
  const merged = { ...FAST_STATE_DEFAULTS };
  if (previous && !Object.hasOwn(previous, "unavailableStrikes") && Number.isFinite(previous.deadStrikes)) {
    merged.unavailableStrikes = previous.deadStrikes;
  }
  for (const key of Object.keys(FAST_STATE_DEFAULTS)) {
    if (key === "schema" || key === "ts") continue;
    if (Object.hasOwn(previous, key)) merged[key] = previous[key];
  }
  for (const key of Object.keys(FAST_STATE_DEFAULTS)) {
    if (Object.hasOwn(patch, key) && key !== "schema" && key !== "ts") {
      merged[key] = patch[key];
    }
  }
  merged.schema = FAST_STATE_SCHEMA;
  merged.ts = timestamp;
  for (const key of BOOL_FIELDS) {
    if (typeof merged[key] !== "boolean") merged[key] = FAST_STATE_DEFAULTS[key];
  }
  for (const key of NUMBER_FIELDS) {
    if (!Number.isFinite(merged[key]) || merged[key] < 0) merged[key] = FAST_STATE_DEFAULTS[key];
  }
  for (const key of ARRAY_FIELDS) {
    if (!Array.isArray(merged[key])) merged[key] = [];
  }
  for (const key of ["pageLabel", "generationKey", "lastMessageRole", "lastMessageKey", "dispatchId", "errorName", "errorCode"]) {
    if (merged[key] !== null && typeof merged[key] !== "string") merged[key] = null;
  }
  if (merged.spaceId !== null && typeof merged.spaceId !== "string" &&
      !(typeof merged.spaceId === "number" && Number.isFinite(merged.spaceId))) merged.spaceId = null;
  if (merged.composerEmpty !== null && typeof merged.composerEmpty !== "boolean") merged.composerEmpty = null;
  for (const key of ["backoffUntil", "lastProgressAt", "lastGotoAt"]) {
    if (merged[key] !== null && (!Number.isFinite(merged[key]) || merged[key] < 0)) merged[key] = null;
  }
  for (const key of ["uiSchema", "dispatchStatus", "toolState", "finalVerification"]) {
    if (typeof merged[key] !== "string") merged[key] = FAST_STATE_DEFAULTS[key];
  }
  // A legacy response-tail field is deliberately never carried forward.
  delete merged.tail;
  return merged;
}

export function validateFastState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.schema !== FAST_STATE_SCHEMA) return false;
  const allowed = new Set(Object.keys(FAST_STATE_DEFAULTS));
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  for (const key of Object.keys(FAST_STATE_DEFAULTS)) {
    if (!Object.hasOwn(value, key)) return false;
    const current = value[key];
    if (ARRAY_FIELDS.has(key) && !Array.isArray(current)) return false;
    if (BOOL_FIELDS.has(key) && typeof current !== "boolean") return false;
    if (NUMBER_FIELDS.has(key) && (!Number.isFinite(current) || current < 0)) return false;
    }
  if (value.backoffUntil !== null && (!Number.isFinite(value.backoffUntil) || value.backoffUntil < 0)) return false;
  if (value.lastProgressAt !== null && (!Number.isFinite(value.lastProgressAt) || value.lastProgressAt < 0)) return false;
  if (value.lastGotoAt !== null && (!Number.isFinite(value.lastGotoAt) || value.lastGotoAt < 0)) return false;
  const nullableStrings = ["pageLabel", "generationKey", "lastMessageRole", "lastMessageKey", "dispatchId", "errorName", "errorCode"];
  for (const key of nullableStrings) {
    if (value[key] !== null && typeof value[key] !== "string") return false;
  }
  if (value.spaceId !== null && !(typeof value.spaceId === "string" ||
      (typeof value.spaceId === "number" && Number.isFinite(value.spaceId)))) return false;
  if (value.composerEmpty !== null && typeof value.composerEmpty !== "boolean") return false;
  if (typeof value.uiSchema !== "string" || typeof value.dispatchStatus !== "string" ||
      typeof value.toolState !== "string" || typeof value.finalVerification !== "string") return false;
  return true;
}

export function isBackoffActive(state, now = Date.now()) {
  return Number.isFinite(state?.backoffUntil) && state.backoffUntil > now;
}

export function nextBackoffUntil(now = Date.now(), durationMs = 8 * 60 * 1000) {
  return now + durationMs;
}

// ---- R2.4 stay-on-page round logic (pure helpers, unit-testable) ----

export const CALIBRATION_INTERVAL_MS = 10 * 60 * 1000;
export const STORM_MIN_429_MS = 9 * 60 * 1000;
export const STORM_PHASE_SPAN_MS = 9 * 60 * 1000;

// Stable per-SPACE phase in [0, 9min) for 429/load-storm recovery staggering.
// uint32(SHA256(SPACE)[0..4]) % 540000 per the R2.4 contract.
export function spacePhaseMs(space) {
  if (typeof space !== "string" || !space) throw new TypeError("SPACE_NAME_REQUIRED");
  const digest = createHash("sha256").update(space, "utf8").digest();
  return digest.readUInt32BE(0) % STORM_PHASE_SPAN_MS;
}

// The most recent known real navigation time of the current page document:
// probe-owned goto bookkeeping and any external navigation (performance.timeOrigin).
export function navReferenceAt({ lastGotoAt = null, timeOrigin = null } = {}) {
  const candidates = [lastGotoAt, timeOrigin].filter((v) => Number.isFinite(v) && v >= 0);
  return candidates.length ? Math.max(...candidates) : null;
}

// Decide the round kind: RECOVER (page lost/mismatched) > CALIBRATE (nav older than interval) > STAY.
export function decideRoundKind({ urlMatches, navRefAt = null, now = Date.now(), calibrationIntervalMs = CALIBRATION_INTERVAL_MS } = {}) {
  if (urlMatches !== true) return "RECOVER";
  if (!Number.isFinite(navRefAt) || now - navRefAt >= calibrationIntervalMs) return "CALIBRATE";
  return "STAY";
}

// Unified structural readiness (R2.4.1): any navigation this round (fresh load) must also pass
// the body-readiness gate; stay-on-page reads only need the chat structure.
export function chatSurfaceReady({ hostOk, composerCount, bodyLen = 0, navigatedThisRound = false } = {}) {
  return Boolean(hostOk === true && composerCount > 0 && (!navigatedThisRound || bodyLen > 600));
}

// 429/load-storm single-recovery scheduler (R2.4.1.1): a fresh probe process consults this
// before the normal round-kind ladder. Exactly one 429_RETRY navigation per expiry; any failure
// re-arms through the storm classifier, never the plain 8-minute goto backoff.
export function planStormRecovery(previous, now = Date.now()) {
  if (previous?.errorCode !== "CHAT_SURFACE_STRUCTURALLY_UNAVAILABLE") return null;
  if (!Number.isFinite(previous?.backoffUntil)) return null;
  if (previous.backoffUntil > now) return null;
  return { action: "429_RETRY" };
}

// Executable 429 retry runner (R2.4.1.1): performs EXACTLY ONE navigation attempt and classifies
// the outcome. Navigation failure propagates as a rejection; read failure and structural failure
// return without any further navigation. Injectable deps make the branch mock-executable.
export async function runStormRetry({ navigate, readAfterNavigate, isReady }) {
  await navigate();
  let sample = null;
  try {
    sample = await readAfterNavigate();
  } catch (error) {
    return { outcome: "READ_FAILED", gotoCount: 1, error };
  }
  if (!isReady(sample)) return { outcome: "STRUCTURE_FAILED", gotoCount: 1, sample };
  return { outcome: "RECOVERED", gotoCount: 1, sample };
}

// The re-arm patch for any 429_RETRY failure: storm deadline recomputed, storm classifier kept,
// strikes advanced. Shared by every failure path so the semantics cannot drift apart.
export function stormRearmState({ previous, detectedAt, phaseMs, baseError = {} }) {
  const strikes = (previous?.unavailableStrikes || 0) + 1;
  return {
    probeFailed: true, recoveryFailed: false,
    backoffUntil: stormBackoffDeadline({ detectedAt, phaseMs }),
    unavailableStrikes: strikes,
    unavailablePersistent: strikes >= 3,
    errorCode: "CHAT_SURFACE_STRUCTURALLY_UNAVAILABLE",
    ...baseError,
  };
}

// 429/load-storm recovery deadline: 8-min goto backoff vs 9-min storm rule + phase — take the LATEST,
// never sum them (R2.4: no double waiting).
export function stormBackoffDeadline({ detectedAt = Date.now(), phaseMs = 0, baseBackoffMs = 8 * 60 * 1000 } = {}) {
  if (!Number.isFinite(detectedAt) || detectedAt < 0) throw new TypeError("DETECTED_AT_REQUIRED");
  if (!Number.isFinite(phaseMs) || phaseMs < 0 || phaseMs >= STORM_PHASE_SPAN_MS) throw new TypeError("PHASE_MS_OUT_OF_RANGE");
  return Math.max(detectedAt + baseBackoffMs, detectedAt + STORM_MIN_429_MS + phaseMs);
}
