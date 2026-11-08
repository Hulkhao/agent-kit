// Canonical read-only ChatGPT monitor. It never sends or retries a dispatch.
// Deployment adapters: MON, SPACE, and a-watch-uuid.txt only.
import { mkdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const MON = "REPLACE_WITH_DEPLOY_MONITOR_DIR"; // adapter 1
const SPACE = "REPLACE_WITH_UNIQUE_TASKSPACE"; // adapter 2
if (MON.startsWith("REPLACE_") || SPACE.startsWith("REPLACE_")) {
  console.error("ADAPTATION_REQUIRED");
  process.exit(1);
}

const {
  appendEvent,
  findUnconsumedComposerFreeze,
  hasResponseTailAdvanced,
  lastConsumedFreezeDeadline,
  reconcileDispatch,
  readComposerSurface,
  writeJsonAtomic,
} = await import(pathToFileURL(MON + "/dispatch-state.mjs").href);
const {
  FAST_STATE_DEFAULTS,
  FAST_STATE_SCHEMA,
  decideRoundKind,
  isBackoffActive,
  navReferenceAt,
  nextBackoffUntil,
  normalizeFastState,
  spacePhaseMs,
  stormBackoffDeadline,
  chatSurfaceReady,
  planStormRecovery,
  runStormRetry,
  stormRearmState,
  validateFastState,
} = await import(pathToFileURL(MON + "/state-schema.mjs").href);
const { selectUniqueConversationPage } = await import(pathToFileURL(MON + "/page-recovery.mjs").href);

const STATE = MON + "/a-fast-state.json";
const UUID_FILE = MON + "/a-watch-uuid.txt";
const now = () => Date.now();
const safeError = (error) => ({
  errorName: String(error?.name || "Error").slice(0, 80),
  nativeErrorCode: String(error?.code || "UNKNOWN").slice(0, 80),
});

let previous = { ...FAST_STATE_DEFAULTS };
let stateCorrupt = false;
let legacyStateMigrated = false;
try {
  const raw = await readFile(STATE, "utf8");
  const parsed = JSON.parse(raw);
  if (parsed?.schema === FAST_STATE_SCHEMA) {
    if (!validateFastState(parsed)) stateCorrupt = true;
    else previous = parsed;
  } else if (parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
      (parsed.schema == null || parsed.schema === "ego-fast-state/v2")) {
    // One-time migration from known legacy schemas; response text is not carried forward.
    previous = normalizeFastState(parsed, {}, now());
    legacyStateMigrated = true;
    await appendEvent(MON, "LEGACY_STATE_MIGRATED", { fromSchema: parsed.schema || "legacy" });
  } else {
    stateCorrupt = true;
  }
} catch (error) {
  if (error?.code !== "ENOENT") stateCorrupt = true;
}

async function writeState(patch = {}) {
  const next = normalizeFastState(previous, patch, now());
  await writeJsonAtomic(STATE, next);
  previous = next;
  return next;
}
const startupNeedsReview = legacyStateMigrated || previous.ts === 0 || previous.probeFailed || previous.recoveryFailed || previous.unavailableStrikes > 0;
const previousActivityMarkers = previous.activityMarkers;

async function saveFailureScreenshot(page, kind) {
  try {
    const dir = MON + "/diagnostics";
    await mkdir(dir, { recursive: true });
    const name = `${kind}-${now()}.png`;
    await page.screenshot({ path: dir + "/" + name });
    await appendEvent(MON, "FAILURE_SCREENSHOT_SAVED", { kind, file: name });
  } catch (error) {
    await appendEvent(MON, "FAILURE_SCREENSHOT_FAILED", { kind, ...safeError(error) });
  }
}

if (stateCorrupt) {
  await writeState({ probeFailed: true, recoveryFailed: true, errorCode: "STATE_CORRUPT", uiSchema: "UNKNOWN" });
  await appendEvent(MON, "STATE_CORRUPT", {});
  console.log("RESULT=STATE_CORRUPT");
  process.exit(0);
}

let uuid = "";
try {
  uuid = (await readFile(UUID_FILE, "utf8")).trim();
  if (!/^[0-9a-f-]{20,}$/i.test(uuid)) throw new Error("INVALID_UUID");
} catch (error) {
  await writeState({ probeFailed: true, recoveryFailed: true, errorCode: "UUID_MISSING_OR_INVALID", ...safeError(error) });
  await appendEvent(MON, "UUID_MISSING_OR_INVALID", safeError(error));
  console.log("RESULT=UUID_MISSING_OR_INVALID");
  process.exit(0);
}

// R2.5-H: consume unprocessed composer-freeze events through the shared storm channel.
// The ledger (dispatch-state) only records the event; this probe is the single writer that
// turns it into a persisted storm backoff via the existing writeState() path.
const pendingFreeze = await findUnconsumedComposerFreeze(MON).catch(() => null);
if (pendingFreeze && !isBackoffActive(previous, now())) {
  const rearm = stormRearmState({
    previous,
    detectedAt: now(),
    phaseMs: spacePhaseMs(SPACE),
    baseError: { errorName: pendingFreeze.errorName || "Error", nativeErrorCode: pendingFreeze.nativeErrorCode || "UNKNOWN" },
  });
  await writeState({ ...rearm });
  await appendEvent(MON, "COMPOSER_FREEZE_CONSUMED", {
    freezeId: pendingFreeze.freezeId, detectedAt: pendingFreeze.detectedAt,
    stormBackoffDeadline: rearm.backoffUntil, phaseMs: pendingFreeze.phaseMs,
    agent_id: SPACE, space: SPACE,
  });
  previous = { ...previous, ...rearm };
}

// backoffUntil is an absolute deadline. A backoff poll updates only ts; it never moves the deadline.
if (isBackoffActive(previous, now())) {
  await writeState({});
  console.log("state=" + JSON.stringify({ backoff: true, backoffUntil: previous.backoffUntil, unavailableStrikes: previous.unavailableStrikes }));
  console.log("RESULT=PROBE_BACKOFF");
  process.exit(0);
}

let task;
let spaceId = previous.spaceId || null;
try {
  const spaces = await listTaskSpaces();
  // The SPACE name is the stable identity; a stored spaceId only wins if its taskId still matches.
  const targetSpace = spaces.find((space) => space.taskId === SPACE || space.name === SPACE) ||
    (spaceId ? spaces.find((space) => space.id === spaceId && (!space.taskId || space.taskId === SPACE)) : null);
  if (!targetSpace || targetSpace.ownership !== "agent" ||
      (targetSpace.taskId && targetSpace.taskId !== SPACE)) {
    throw new Error(!targetSpace ? "TASKSPACE_NOT_FOUND" : "TASKSPACE_NOT_AGENT_OWNED");
  }
  spaceId = targetSpace.id;
  task = await taskSpace(spaceId);
} catch (error) {
  await writeState({ spaceId, probeFailed: true, recoveryFailed: true, errorCode: "TASKSPACE_RECOVERY_FAILED", ...safeError(error) });
  await appendEvent(MON, "TASKSPACE_RECOVERY_FAILED", safeError(error));
  console.log("RESULT=TASKSPACE_RECOVERY_FAILED");
  process.exit(0);
}

let page;
let pages = [];
let roundKind = "CALIBRATE";
try {
  const previousPageLabel = previous.pageLabel;
  pages = await task.pages();
  let selectionEvidence = "SINGLE_PAGE";
  if (pages.length === 1) {
    page = pages[0];
  } else if (pages.length > 1) {
    page = await selectUniqueConversationPage(pages, uuid);
    selectionEvidence = "UNIQUE_CONVERSATION_URL";
  } else {
    page = await task.newPage();
    selectionEvidence = "NEW_PAGE";
  }
  pages = await task.pages();
  await writeState({ spaceId, pageLabel: page.label, pageCount: pages.length, recoveryFailed: false, errorCode: null, errorName: null });
  if (previousPageLabel && previousPageLabel !== page.label) {
    await appendEvent(MON, "PAGE_LABEL_RECOVERED", {
      previousLabel: previousPageLabel, actualLabel: page.label, selectionEvidence,
    });
  }
} catch (error) {
  await writeState({ spaceId, probeFailed: true, recoveryFailed: true, errorCode: "PAGE_RECOVERY_FAILED", ...safeError(error) });
  await appendEvent(MON, "PAGE_RECOVERY_FAILED", safeError(error));
  console.log("RESULT=TASKSPACE_RECOVERY_FAILED");
  process.exit(0);
}

// R2.4: goto is no longer a per-round ritual. Every navigation goes through navigate(reason);
// regular rounds stay on the page and read the live DOM (zero navigation).
const want = "https://chatgpt.com/c/" + uuid;

let navigatedThisRound = false;
// Unified structural readiness (R2.4.1, single rule shared by all three gates).
const isChatSurfaceReady = (sample) => chatSurfaceReady({ ...sample, navigatedThisRound });

let probe = null;

async function navigate(reason) {
  navigatedThisRound = true;
  const gotoAt = now();
  await appendEvent(MON, "GOTO_ATTEMPT", {
    goto_reason: reason, at: gotoAt, agent_id: SPACE, space: SPACE,
    roundKind, lastGotoAt: gotoAt,
  });
  await writeState({ lastGotoAt: gotoAt });
  await page.goto(want, { timeout: 45000 });
  await page.waitForLoadState("load", { timeout: 30000 });
}

// Any 429_RETRY failure re-arms the storm classifier itself: storm deadline, storm errorCode,
// original cause kept in errorName/event — never the plain 8-minute goto backoff (R2.4.1.1).
async function stormRetryFailed(reason, error) {
  const detectedAt = now();
  const phaseMs = spacePhaseMs(SPACE);
  const rearm = stormRearmState({ previous, detectedAt, phaseMs, baseError: safeError(error) });
  await writeState({
    spaceId, pageLabel: page.label, pageCount: pages.length,
    uiSchema: "UNKNOWN", bodyChanged: false,
    ...rearm,
  });
  await saveFailureScreenshot(page, "chat-surface-unavailable");
  await appendEvent(MON, "429_RETRY_FAILED", {
    reason, detectedAt, stormBackoffDeadline: rearm.backoffUntil, phaseMs,
    agent_id: SPACE, space: SPACE, roundKind, strikes: rearm.unavailableStrikes,
    persistent: rearm.unavailablePersistent, spaceId, ...safeError(error),
  });
  console.log(rearm.unavailablePersistent ? "RESULT=CONVERSATION_UNAVAILABLE_PERSISTENT" : "RESULT=PROBE_UNAVAILABLE_RETRY");
  process.exit(0);
}

// 429/load-storm single-recovery path: the deadline expired and the previous round ended in the
// storm family. Exactly ONE recovery navigation now; no calibration/DEAD_PAGE_RETRY ladder.
const stormPlan = planStormRecovery(previous, now());
if (stormPlan) {
  roundKind = "RECOVER";
  // the same shared storm channel serves both sources; the event label keeps them distinguishable
  const stormRetryReason = (await lastConsumedFreezeDeadline(MON).catch(() => null)) === previous.backoffUntil
    ? "COMPOSER_FREEZE_RETRY"
    : "429_RETRY";
  let run = null;
  try {
    run = await runStormRetry({
      navigate: () => navigate(stormRetryReason),
      readAfterNavigate: () => waitForKnownUi(),
      isReady: isChatSurfaceReady,
    });
  } catch (error) {
    await stormRetryFailed("NAVIGATION_FAILED", error);
  }
  const retryProbe = run.sample;
  if (run.outcome === "READ_FAILED") {
    await stormRetryFailed("READ_FAILED", run.error);
  }
  if (run.outcome === "STRUCTURE_FAILED") {
    const detectedAt = now();
    const phaseMs = spacePhaseMs(SPACE);
    const rearm = stormRearmState({ previous, detectedAt, phaseMs });
    await writeState({
      spaceId, pageLabel: page.label, pageCount: pages.length,
      uiSchema: "UNKNOWN", bodyChanged: false,
      len: retryProbe.bodyLen, composerCount: retryProbe.composerCount,
      composerEmpty: retryProbe.composerEmpty,
      lastMessageRole: retryProbe.lastMessageRole,
      lastMessageKey: retryProbe.lastMessageKey,
      lastMessageTextLength: retryProbe.lastMessageTextLength,
      stopLabelCount: retryProbe.stopLabelCount,
      buttonLabels: retryProbe.buttonLabels,
      activityMarkers: retryProbe.activityMarkers,
      busyCount: retryProbe.busyCount,
      ...rearm,
    });
    await saveFailureScreenshot(page, "chat-surface-unavailable");
    await appendEvent(MON, "CHAT_SURFACE_STRUCTURALLY_UNAVAILABLE", {
      strikes: rearm.unavailableStrikes, persistent: rearm.unavailablePersistent,
      retry: "429_RETRY", detectedAt, stormBackoffDeadline: rearm.backoffUntil,
      phaseMs, agent_id: SPACE, space: SPACE, roundKind, spaceId,
      hostOk: retryProbe.hostOk, bodyLen: retryProbe.bodyLen,
      composerCount: retryProbe.composerCount,
    });
    console.log(rearm.unavailablePersistent ? "RESULT=CONVERSATION_UNAVAILABLE_PERSISTENT" : "RESULT=PROBE_UNAVAILABLE_RETRY");
    process.exit(0);
  }
  await writeState({
    probeFailed: false, recoveryFailed: false, backoffUntil: null,
    unavailableStrikes: 0, unavailablePersistent: false, errorCode: null, errorName: null,
  });
  probe = retryProbe;
  navigatedThisRound = true;
}

// Decide the round kind before touching the page: RECOVER > CALIBRATE > STAY.
let navRefAt = null;
if (!probe) {
try {
  const pageUrl = await page.url();
  // An evaluate failure reading page evidence is a recovery condition, not a missing timestamp.
  let timeOrigin = null;
  let timeOriginOk = false;
  try {
    timeOrigin = await page.evaluate(() => Math.round(performance.timeOrigin));
    timeOriginOk = true;
  } catch (error) { timeOrigin = null; }
  if (!timeOriginOk) {
    roundKind = "RECOVER";
    navRefAt = navReferenceAt({ lastGotoAt: previous.lastGotoAt });
  } else {
    navRefAt = navReferenceAt({ lastGotoAt: previous.lastGotoAt, timeOrigin });
    roundKind = decideRoundKind({ urlMatches: typeof pageUrl === "string" && pageUrl.includes(uuid), navRefAt, now: now() });
  }
} catch (error) {
  roundKind = "RECOVER";
}
}

if (!probe && roundKind !== "STAY") {
  try {
    await navigate(roundKind === "CALIBRATE" ? "CALIBRATION" : "RECOVERY");
  } catch (error) {
    await writeState({
      spaceId, pageLabel: page.label, pageCount: pages.length,
      probeFailed: true, recoveryFailed: false,
      backoffUntil: nextBackoffUntil(now()),
      errorCode: "GOTO_FAILED", ...safeError(error),
    });
    await saveFailureScreenshot(page, "goto-failed");
    await appendEvent(MON, "GOTO_FAILED", { pageLabel: page.label, reason: roundKind, ...safeError(error) });
    console.log("RESULT=PROBE_BACKOFF");
    process.exit(0);
  }
}

async function readPage() {
  const surface = await readComposerSurface(page);
  const pageData = await page.evaluate(() => {
    const body = document.body?.innerText || "";
    const visible = (element) => Boolean(element &&
      (element.offsetParent !== null || element.getClientRects().length > 0));
    const buttons = [...document.querySelectorAll("button[aria-label]")].filter(visible);
    const buttonLabels = [...new Set(buttons.map((button) => button.getAttribute("aria-label")).filter(Boolean))].slice(0, 32);
    const activityMarkers = [...document.querySelectorAll('[aria-busy="true"], [role="progressbar"], [aria-live]')]
      .filter(visible).slice(0, 24).map((element) => ({
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role"),
        ariaLabel: element.getAttribute("aria-label"),
        ariaBusy: element.getAttribute("aria-busy"),
        ariaLive: element.getAttribute("aria-live"),
        dataTestId: element.getAttribute("data-testid"),
      }));
    const busyCount = [...document.querySelectorAll('[aria-busy="true"], [role="progressbar"]')].filter(visible).length;
    return { bodyLen: body.length, mainCount: document.querySelectorAll("main").length, buttonLabels, activityMarkers, busyCount };
  });
  return { ...surface, ...pageData };
}

async function waitForKnownUi(rounds = 10) {
  for (let i = 0; i < rounds; i++) {
    const sample = await readPage();
    if (sample.hostOk && sample.bodyLen > 600 && sample.composerCount > 0) return sample;
    if (i + 1 < rounds) await page.waitForTimeout(4000);
  }
  return await readPage();
}

// STAY rounds validate structure on the live page; a unit-count decrease is virtualization,
// never an anomaly, and must not trigger goto. (A 429_RETRY round already set `probe` above.)
if (!probe) {
  try {
    probe = roundKind === "STAY"
      ? await readPage()
      : await waitForKnownUi();
  } catch (error) {
    // evaluate failure/timeout on a stay-on-page read: immediate recovery navigation.
    try {
      await navigate("RECOVERY");
      probe = await waitForKnownUi();
    } catch (recoveryError) {
      await writeState({
        spaceId, pageLabel: page.label, pageCount: pages.length,
        probeFailed: true, recoveryFailed: false,
        backoffUntil: nextBackoffUntil(now()),
        errorCode: "GOTO_FAILED", ...safeError(recoveryError),
      });
      await appendEvent(MON, "GOTO_FAILED", { pageLabel: page.label, reason: "RECOVERY_AFTER_EVALUATE_FAILURE", ...safeError(recoveryError) });
      console.log("RESULT=PROBE_BACKOFF");
      process.exit(0);
    }
  }
}

// Fresh loads must pass the body-readiness gate; stay-on-page rounds only need chat structure.
if (!isChatSurfaceReady(probe)) {
  for (let retry = 0; retry < 2; retry++) {
    try {
      await navigate("DEAD_PAGE_RETRY");
      probe = await waitForKnownUi(5);
      if (isChatSurfaceReady(probe)) break;
    } catch (error) {
      await appendEvent(MON, "STRUCTURAL_RETRY_FAILED", { retry: retry + 1, ...safeError(error) });
    }
  }
}

if (!isChatSurfaceReady(probe)) {
  const strikes = previous.unavailableStrikes + 1;
  const persistent = strikes >= 3;
  // Page loads but the chat surface is structurally absent: the account-level 429/load-storm family.
  // Recovery waits the LATEST of the 8-min goto backoff and 9-min + SPACE-phase storm rule; never summed.
  const detectedAt = now();
  const phaseMs = spacePhaseMs(SPACE);
  const backoffUntil = stormBackoffDeadline({ detectedAt, phaseMs });
  await writeState({
    spaceId, pageLabel: page.label, pageCount: pages.length,
    probeFailed: true, recoveryFailed: false,
    backoffUntil,
    unavailableStrikes: strikes, unavailablePersistent: persistent,
    uiSchema: "UNKNOWN", bodyChanged: false,
    len: probe.bodyLen, composerCount: probe.composerCount,
    composerEmpty: probe.composerEmpty,
    lastMessageRole: probe.lastMessageRole,
    lastMessageKey: probe.lastMessageKey,
    lastMessageTextLength: probe.lastMessageTextLength,
    stopLabelCount: probe.stopLabelCount,
    buttonLabels: probe.buttonLabels,
    activityMarkers: probe.activityMarkers,
    busyCount: probe.busyCount,
    errorCode: "CHAT_SURFACE_STRUCTURALLY_UNAVAILABLE",
  });
  await saveFailureScreenshot(page, "chat-surface-unavailable");
  await appendEvent(MON, "CHAT_SURFACE_STRUCTURALLY_UNAVAILABLE", {
    strikes, persistent, detectedAt, stormBackoffDeadline: backoffUntil, phaseMs,
    space: SPACE, roundKind, spaceId, lastGotoAt: previous.lastGotoAt,
    hostOk: probe.hostOk, bodyLen: probe.bodyLen,
    composerCount: probe.composerCount, mainCount: probe.mainCount,
  });
  console.log(persistent ? "RESULT=CONVERSATION_UNAVAILABLE_PERSISTENT" : "RESULT=PROBE_UNAVAILABLE_RETRY");
  process.exit(0);
}

let dispatchResult;
try {
  dispatchResult = await reconcileDispatch(MON, uuid, probe);
} catch (error) {
  await writeState({ spaceId, pageLabel: page.label, pageCount: pages.length, probeFailed: true, errorCode: "DISPATCH_STATE_INVALID", ...safeError(error) });
  await appendEvent(MON, "DISPATCH_STATE_INVALID", safeError(error));
  console.log("RESULT=DISPATCH_STATE_INVALID");
  process.exit(0);
}
if (dispatchResult.result === "UUID_MISMATCH") {
  await writeState({ spaceId, pageLabel: page.label, pageCount: pages.length, probeFailed: true, errorCode: "DISPATCH_UUID_MISMATCH" });
  await appendEvent(MON, "DISPATCH_UUID_MISMATCH", { dispatchId: dispatchResult.record.dispatchId });
  console.log("RESULT=DISPATCH_UUID_MISMATCH");
  process.exit(0);
}
if (dispatchResult.result === "UNCERTAIN") {
  await writeState({
    spaceId, pageLabel: page.label, pageCount: pages.length,
    probeFailed: true,
    dispatchId: dispatchResult.record.dispatchId,
    dispatchStatus: "UNCERTAIN",
    errorCode: dispatchResult.record.reasonCode || "DISPATCH_UNCERTAIN",
  });
  await appendEvent(MON, "DISPATCH_UNCERTAIN_WAKE_SUPERVISOR", {
    dispatchId: dispatchResult.record.dispatchId,
    reasonCode: dispatchResult.record.reasonCode,
  });
  console.log("RESULT=DISPATCH_UNCERTAIN_WAKE_SUPERVISOR");
  process.exit(0);
}

const dispatchId = dispatchResult.record?.dispatchId || null;
const sameGeneration = previous.generationKey === (dispatchId || "conversation");
const completedDispatch = dispatchResult.record?.status === "COMPLETED";
const everGenerating = completedDispatch ? false :
  (sameGeneration ? previous.everGenerating || probe.generating : probe.generating);
const bodyChanged = previous.len !== probe.bodyLen;
const recovered = startupNeedsReview;
const state = await writeState({
  spaceId, pageLabel: page.label, pageCount: pages.length,
  generating: probe.generating,
  everGenerating,
  generationKey: dispatchId || "conversation",
  len: probe.bodyLen,
  bodyChanged,
  lastProgressAt: bodyChanged ? now() : (previous.lastProgressAt || now()),
  startIdle: recovered && !probe.generating,
  doneCandidate: completedDispatch ? false : (sameGeneration ? previous.doneCandidate : false),
  probeFailed: false,
  backoffUntil: null,
  unavailableStrikes: 0,
  unavailablePersistent: false,
  uiSchema: "CHATGPT_CHAT_KNOWN",
  composerCount: probe.composerCount,
  composerEmpty: probe.composerEmpty,
  lastMessageRole: probe.lastMessageRole,
  lastMessageKey: probe.lastMessageKey,
  lastMessageTextLength: probe.lastMessageTextLength,
  stopLabelCount: probe.stopLabelCount,
  buttonLabels: probe.buttonLabels,
  activityMarkers: probe.activityMarkers,
  busyCount: probe.busyCount,
  dispatchId,
  dispatchStatus: dispatchResult.record?.status || "UNTRACKED",
  toolState: "UNOBSERVED",
  finalVerification: "SUPERVISOR_API_REQUIRED",
  recoveryFailed: false,
  errorName: null,
  errorCode: null,
});

if (everGenerating && JSON.stringify(probe.activityMarkers) !== JSON.stringify(previousActivityMarkers || [])) {
  await appendEvent(MON, "ACTIVITY_MARKERS_CHANGED", { dispatchId, markers: probe.activityMarkers });
}
console.log("state=" + JSON.stringify({
  roundKind, lastGotoAt: state.lastGotoAt,
  generating: state.generating, everGenerating, len: state.len,
  bodyChanged, composerEmpty: state.composerEmpty,
  dispatchStatus: state.dispatchStatus, toolState: state.toolState,
}));

if (state.startIdle) {
  await appendEvent(MON, "START_IDLE_WAKE_SUPERVISOR", { pageLabel: page.label });
  console.log("RESULT=START_IDLE_WAKE_SUPERVISOR");
  process.exit(0);
}

const responseTailAdvanced = dispatchResult.record?.status === "ACCEPTED" &&
  probe.composerEmpty && hasResponseTailAdvanced(dispatchResult.record, probe);
if (responseTailAdvanced && !everGenerating) {
  await appendEvent(MON, "RESPONSE_TAIL_ADVANCED_WITHOUT_OBSERVED_GENERATING", {
    dispatchId, lastMessageRole: probe.lastMessageRole,
  });
}
if (!probe.generating && (everGenerating || responseTailAdvanced)) {
  await new Promise((resolve) => setTimeout(resolve, 75000));
  let first = null;
  let second = null;
  try {
    first = await readPage();
    second = await readPage();
  } catch (error) {
    // A transient evaluate failure inside the confirm window is treated as NOT stable:
    // the candidate is rejected and the next round redoes the confirm (conservative).
    await writeState({ doneCandidate: false, gapRejected: state.gapRejected + 1, errorCode: "CONFIRM_READ_FAILED", ...safeError(error) });
    await appendEvent(MON, "FINAL_CANDIDATE_REJECTED", { reason: "CONFIRM_READ_FAILED", ...safeError(error) });
    console.log("RESULT=GENERATING");
    process.exit(0);
  }
  const stable = !first.generating && !second.generating &&
    first.composerPresent && second.composerPresent && first.composerEmpty && second.composerEmpty &&
    first.lastMessageRole === "assistant" && second.lastMessageRole === "assistant" &&
    Boolean(first.lastMessageKey) && first.lastMessageKey === second.lastMessageKey &&
    (!responseTailAdvanced || second.lastMessageKey !== dispatchResult.record?.baselineTailKey) &&
    first.lastMessageTextLength === second.lastMessageTextLength &&
    first.bodyLen === second.bodyLen && first.busyCount === 0 && second.busyCount === 0;
  if (!stable) {
    await writeState({
      generating: second.generating,
      len: second.bodyLen,
      composerCount: second.composerCount,
      composerEmpty: second.composerEmpty,
      lastMessageRole: second.lastMessageRole,
      lastMessageKey: second.lastMessageKey,
      lastMessageTextLength: second.lastMessageTextLength,
      stopLabelCount: second.stopLabelCount,
      buttonLabels: second.buttonLabels,
      activityMarkers: second.activityMarkers,
      busyCount: second.busyCount,
      doneCandidate: false,
      gapRejected: state.gapRejected + 1,
    });
    await appendEvent(MON, "FINAL_CANDIDATE_REJECTED", {
      composerEmpty: second.composerEmpty,
      lastMessageRole: second.lastMessageRole,
      stableTailId: Boolean(first.lastMessageKey && first.lastMessageKey === second.lastMessageKey),
      firstLen: first.bodyLen,
      secondLen: second.bodyLen,
      firstBusyCount: first.busyCount,
      secondBusyCount: second.busyCount,
    });
    console.log("RESULT=GENERATING");
  } else {
    await writeState({
      generating: false,
      len: second.bodyLen,
      composerEmpty: true,
      lastMessageRole: second.lastMessageRole,
      lastMessageKey: second.lastMessageKey,
      lastMessageTextLength: second.lastMessageTextLength,
      stopLabelCount: second.stopLabelCount,
      buttonLabels: second.buttonLabels,
      activityMarkers: second.activityMarkers,
      busyCount: second.busyCount,
      doneCandidate: true,
      toolState: "UNOBSERVED",
      finalVerification: "SUPERVISOR_API_REQUIRED",
    });
    await appendEvent(MON, "DONE_CANDIDATE", {
      dispatchId, toolState: "UNOBSERVED",
      stableTailId: true, composerEmpty: true,
      bodyLen: second.bodyLen,
    });
    console.log("TRANSITION_GENERATING_TO_IDLE_CONFIRMED");
    console.log("RESULT=DONE_CANDIDATE");
  }
} else {
  console.log("RESULT=" + (probe.generating ? "GENERATING" : "IDLE_PREDELIVERY"));
}
