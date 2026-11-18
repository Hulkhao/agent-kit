// Canonical read-only ChatGPT monitor. It never sends or retries a dispatch.
// Deployment adapters: MON, SPACE, AGENT_ID, and a-watch-uuid.txt.
import { mkdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";

const MON = "REPLACE_WITH_DEPLOY_MONITOR_DIR"; // adapter 1
const SPACE = "REPLACE_WITH_UNIQUE_TASKSPACE"; // adapter 2
const AGENT_ID = "REPLACE_WITH_STABLE_AGENT_ID"; // stable across this Agent's tasks
if ([MON, SPACE, AGENT_ID].some((value) => value.startsWith("REPLACE_"))) {
  console.error("ADAPTATION_REQUIRED");
  process.exit(1);
}

// Issue #4-3 stale-copy sentinel: every probe run announces its version and identity in the
// output stream, so a stale project-local copy (old params, drifted tags) is immediately
// visible in fast-out.txt instead of failing silently forever.
const PROBE_VERSION = "r45.2";
// #27 Batch 2: the boot line carries the stable Owner id next to the space, so
// a stale/deployed copy's identity (and its TaskSpace ownership) is checkable
// from the output stream alone. Same space-separated frozen format.
console.log(`PROBE_BOOT version=${PROBE_VERSION} space=${SPACE} mon=${MON} owner=${AGENT_ID}`);

const {
  appendEvent,
  findUnconsumedComposerFreeze,
  hasResponseTailAdvanced,
  lastConsumedFreezeDeadline,
  markDoneCandidate,
  reconcileDispatch,
  readComposerSurface,
  writeJsonAtomic,
} = await import(pathToFileURL(MON + "/dispatch-state.mjs").href);
const {
  FAST_STATE_DEFAULTS,
  FAST_STATE_SCHEMA,
  IN_FLIGHT_DISPATCH_STATUSES,
  armedReasonOnProbeRound,
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
const { selectUniqueConversationPage, isConversationUrl, probeOriginVerdict } = await import(pathToFileURL(MON + "/page-recovery.mjs").href);
const { TASKSPACE_TAKEOVER_SIGNAL, isTaskSpaceTakeover, isTaskspaceOwnershipLoss,
  assertAgentOwnedTaskSpace, taskspaceOperatorAction } =
  await import(pathToFileURL(MON + "/taskspace-takeover.mjs").href);
const { isValidNewTaskSpaceName, assertTaskSpaceNamingAllowed } = await import(pathToFileURL(MON + "/agent-space.mjs").href);
const { claimAgentSpace, reserveAgentPage } = await import(pathToFileURL(MON + "/agent-space.mjs").href);
const { shouldReviewStartupIdle } = await import(pathToFileURL(MON + "/supervision-policy.mjs").href);

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
  // #27 Batch 3 (ruling §四.1): a corrupt fast state is unconfirmable — it
  // lands in the ARMED_UNKNOWN catch-all (fail-closed armed, never a silent
  // clean slate the next reader could mistake for a legal disarm claim).
  await writeState({ probeFailed: true, recoveryFailed: true, errorCode: "STATE_CORRUPT", uiSchema: "UNKNOWN", armedReason: "ARMED_UNKNOWN" });
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

// F4 (agent-kit#38 probe diagnostic split): a listTaskSpaces() THROW is a registry
// READ failure, not a missing space. It gets its own code TASKSPACE_LIST_FAILED
// with the rebuild-space hint — a registry loss must never flow into the naming
// gate below, which can only see "space absent" and would misreport a lost
// registry as a naming decision. Only a successful list that lacks the space
// proceeds to the naming-gate branch.
let existingSpaces = null;
try { existingSpaces = await listTaskSpaces(); }
catch (error) {
  await writeState({ probeFailed: true, recoveryFailed: true, errorCode: "TASKSPACE_LIST_FAILED", ...safeError(error) });
  await appendEvent(MON, "TASKSPACE_LIST_FAILED", safeError(error)).catch(() => {});
  console.log('RECOVERY_HINT=SPACE_REGISTRY_LOST command="dispatch-manager.mjs rebuild-space --monitor-dir <monitor-dir> --agent-id <agent-id> --space <space>"');
  console.log("RESULT=TASKSPACE_LIST_FAILED");
  process.exit(0);
}
try {
  // #27 re-review P1-1: the naming gate precedes ANY registry write. A
  // read-only listTaskSpaces() decides whether SPACE already exists (legacy
  // reuse stays legal); a MISSING space must pass the frozen naming convention
  // BEFORE claimAgentSpace(), so a violating new name can never enter the
  // registry — and from there borrow rebuild-space's LEDGER_PROOF creation.
  const spaceExists = existingSpaces.some((space) => space.taskId === SPACE || space.name === SPACE);
  assertTaskSpaceNamingAllowed(SPACE, AGENT_ID, spaceExists);
  await claimAgentSpace({ agentId: AGENT_ID, spaceName: SPACE });
} catch (error) {
  await writeState({ probeFailed: true, recoveryFailed: true, errorCode: error.code || "AGENT_SPACE_REGISTRY_INVALID" });
  await appendEvent(MON, error.code || "AGENT_SPACE_REGISTRY_INVALID", safeError(error)).catch(() => {});
  console.log("RESULT=" + (error.code || "AGENT_SPACE_REGISTRY_INVALID"));
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
// Set once the bootstrap branch is entered; a failure there means the registry
// lost the space (agent-kit#31), which the managed rebuild-space step can fix.
let spaceRegistryMissing = false;
// r45 LIMITED GO (issue #6): the probe may bootstrap a MISSING space, but ONLY with the machine-local
// account pin — bare taskSpace(SPACE) creation is forbidden (it recreates the wrong-account space,
// the exact root cause of the mini-tier incident). Existing-space reuse keeps the prior checks.
const readPinnedProfileId = async () => {
  try {
    const cfg = JSON.parse(await readFile(homedir() + "/.agents/ego-profile.json", "utf8"));
    return (cfg && cfg.defaultProfileId) || null;
  } catch { return null; }
};
try {
  // F4: same diagnostic split as the naming gate above — a bootstrap list
  // failure is TASKSPACE_LIST_FAILED, never a generic recovery failure.
  let spaces;
  try { spaces = await listTaskSpaces(); }
  catch (listError) {
    await writeState({ spaceId, probeFailed: true, recoveryFailed: true, errorCode: "TASKSPACE_LIST_FAILED", ...safeError(listError) });
    await appendEvent(MON, "TASKSPACE_LIST_FAILED", { spaceId, ...safeError(listError) }).catch(() => {});
    console.log('RECOVERY_HINT=SPACE_REGISTRY_LOST command="dispatch-manager.mjs rebuild-space --monitor-dir <monitor-dir> --agent-id <agent-id> --space <space>"');
    console.log("RESULT=TASKSPACE_LIST_FAILED");
    process.exit(0);
  }
  // The SPACE name is the stable identity; a stored spaceId only wins if its taskId still matches.
  const targetSpace = spaces.find((space) => space.taskId === SPACE || space.name === SPACE) ||
    (spaceId ? spaces.find((space) => space.id === spaceId && (!space.taskId || space.taskId === SPACE)) : null);
  if (!targetSpace) {
    spaceRegistryMissing = true;
    const pinnedProfileId = await readPinnedProfileId();
    if (!pinnedProfileId) throw new Error("TASKSPACE_BOOTSTRAP_NO_PIN");
    const knownProfiles = await profiles();
    if (!knownProfiles.some((p) => p.id === pinnedProfileId)) throw new Error("TASKSPACE_BOOTSTRAP_PROFILE_UNKNOWN");
    // #27 Batch 2 frozen naming convention: only NEW space creation is
    // constrained — an existing space keeps its (possibly legacy) name, the
    // reuse branch above never calls the validator. A legacy-named space lost
    // from the registry recovers through the managed rebuild-space path.
    if (!isValidNewTaskSpaceName(SPACE, AGENT_ID)) throw new Error("TASKSPACE_NAMING_VIOLATION_STOP");
    task = await taskSpace(SPACE, { profileId: pinnedProfileId });
    // verify what actually got created before continuing (name/taskId, ownership, profileId when exposed)
    const created = (await listTaskSpaces()).find((space) => space.taskId === SPACE || space.name === SPACE);
    if (!created || created.ownership !== "agent" ||
        (created.taskId && created.taskId !== SPACE) ||
        (created.profileId && created.profileId !== pinnedProfileId)) {
      throw new Error("TASKSPACE_BOOTSTRAP_VERIFY_FAILED");
    }
    await appendEvent(MON, "SPACE_BOOTSTRAPPED", { space: SPACE, profileId: pinnedProfileId });
    spaceId = created.id;
  } else {
    spaceId = targetSpace.id;
    assertAgentOwnedTaskSpace(targetSpace, SPACE);
    // profile mismatch check fires only when BOTH sides expose the profile (fail-closed per r45)
    const pinnedProfileId = await readPinnedProfileId();
    if (targetSpace.profileId && pinnedProfileId && targetSpace.profileId !== pinnedProfileId) {
      throw new Error("TASKSPACE_PROFILE_MISMATCH_STOP");
    }
    spaceId = targetSpace.id;
    task = await taskSpace(spaceId);
  }
} catch (error) {
  // A naming violation keeps its own code (it is a config/usage error, not a
  // registry loss): brand-new non-conforming names stay blocked, while a
  // legacy-named space routed to rebuild-space recovers under its proven name.
  const code = isTaskSpaceTakeover(error) ? TASKSPACE_TAKEOVER_SIGNAL :
    error?.message === "TASKSPACE_NAMING_VIOLATION_STOP" ? "TASKSPACE_NAMING_VIOLATION_STOP" : "TASKSPACE_RECOVERY_FAILED";
  await writeState({ spaceId, probeFailed: true, recoveryFailed: true, errorCode: code, ...safeError(error) });
  await appendEvent(MON, code, { spaceId, ...safeError(error) });
  console.log("RECOVERY_DETAIL=" + String(error && error.message || error).slice(0, 200));
  if (spaceRegistryMissing && !isTaskSpaceTakeover(error)) {
    console.log('RECOVERY_HINT=SPACE_REGISTRY_LOST command="dispatch-manager.mjs rebuild-space --monitor-dir <monitor-dir> --agent-id <agent-id> --space <space>"');
  }
  if (isTaskspaceOwnershipLoss(error)) console.log(taskspaceOperatorAction(SPACE));
  console.log("RESULT=" + code);
  process.exit(0);
}

let page;
let pages = [];
let roundKind = "CALIBRATE";
try {
  const previousPageLabel = previous.pageLabel;
  pages = await task.pages();
  const tabs = await task.tabs();
  // Resolve managed Pages by conversation URL; never select by a stale page label.
  const urlMatchesConversation = (rawUrl, exactHost = false) => isConversationUrl(rawUrl, uuid, exactHost);
  // Blank-page reuse (agent-kit#18 R1): a fresh ego Page may sit on either URL;
  // "chrome://newtab/" is the short spelling persisted tab metadata can report for
  // the same blank (field-observed 2026-11-16, see page-recovery.mjs blankPageUrl).
  const isBlankPageUrl = (rawUrl) => rawUrl === "about:blank" || rawUrl === "chrome://new-tab-page/" || rawUrl === "chrome://newtab/";
  let selectionEvidence = null;
  let singlePageUrl = null;
  if (pages.length > 1) {
    try {
      page = await selectUniqueConversationPage(pages, uuid);
      selectionEvidence = "UNIQUE_CONVERSATION_URL";
    } catch (error) {
      if (error?.code !== "PAGE_URL_MATCH_NOT_FOUND") throw error;
    }
  } else if (pages.length === 1) {
    try { singlePageUrl = await pages[0].url(); }
    catch (cause) {
      const error = new Error("PAGE_URL_INSPECTION_FAILED", { cause });
      error.code = "PAGE_URL_INSPECTION_FAILED";
      throw error;
    }
    if (urlMatchesConversation(singlePageUrl)) {
      page = pages[0];
      selectionEvidence = "SINGLE_CONVERSATION_URL";
    }
  }
  if (!page) {
    // Unmanaged tabs may be adopted only with a unique exact-host URL and agent ownership.
    const unmanagedMatches = tabs.filter((tab) => !tab.label && urlMatchesConversation(tab.url, true));
    if (unmanagedMatches.length > 1) {
      const error = new Error("PAGE_URL_MATCH_AMBIGUOUS");
      error.code = "PAGE_URL_MATCH_AMBIGUOUS";
      throw error;
    }
    if (unmanagedMatches.length === 1) {
      const candidate = unmanagedMatches[0];
      if (candidate.openedBy !== "agent" || !candidate.page ||
          typeof candidate.targetId !== "string" || !candidate.targetId ||
          (candidate.page.targetId && candidate.page.targetId !== candidate.targetId)) {
        const error = new Error("PAGE_ADOPTION_EVIDENCE_INCOMPLETE");
        error.code = "PAGE_ADOPTION_EVIDENCE_INCOMPLETE";
        throw error;
      }
      page = await task.adopt(candidate.page);
      selectionEvidence = "UNIQUE_UNMANAGED_CONVERSATION_URL";
      await appendEvent(MON, "PAGE_ADOPTED", {
        spaceId, pageLabel: page.label, targetId: candidate.targetId,
        conversationUuid: uuid, host: "chatgpt.com", selectionEvidence,
      });
    } else if (pages.length === 1 && isBlankPageUrl(singlePageUrl) &&
        tabs.filter((tab) => tab.label === pages[0].label &&
          tab.openedBy === "agent" && isBlankPageUrl(tab.url) &&
          typeof tab.targetId === "string" && tab.targetId &&
          (!pages[0].targetId || pages[0].targetId === tab.targetId)).length === 1) {
      // Reuse the same agent-owned blank Page; the existing RECOVER path navigates it.
      page = pages[0];
      selectionEvidence = "AGENT_OWNED_BLANK_PAGE";
    } else {
      // Reserve a fresh UUID exactly once before allocating another managed Page.
      // An existing UUID with a missing Page requires reconciliation, not a retry.
      await reserveAgentPage({ agentId: AGENT_ID, spaceName: SPACE, conversationUuid: uuid });
      page = await task.newPage();
      selectionEvidence = "RESERVED_NEW_PAGE";
    }
  }
  pages = await task.pages();
  await claimAgentSpace({ agentId: AGENT_ID, spaceName: SPACE, conversationUuid: uuid });
  await writeState({ spaceId, pageLabel: page.label, pageCount: pages.length, recoveryFailed: false, errorCode: null, errorName: null });
  if (previousPageLabel && previousPageLabel !== page.label) {
    await appendEvent(MON, "PAGE_LABEL_RECOVERED", {
      previousLabel: previousPageLabel, actualLabel: page.label, selectionEvidence,
    });
  }
  // Issue #25 gap 1: probe origin self-check (false-blind guard, issue-kit#25). After
  // selection the managed Page must sit on the watched conversation URL or on a blank
  // transition (fresh Page before its first navigation, #18 blank reuse, RECOVER-round
  // blank). Any other source makes every in-page request fail while the probe still
  // "looks alive", which the structural gate alone would misread as ordinary unavailable
  // strikes and back off instead of escalating. Exit immediately with PROBE_INVALID_ORIGIN;
  // the manager's classifyProbeResult default branch turns that into a wake signal.
  let originUrl;
  try {
    originUrl = await page.url();
  } catch (cause) {
    // Fail-closed: an unreadable URL keeps the existing PAGE_URL_INSPECTION_FAILED path
    // (it surfaces through the selection catch below); never a silent pass.
    const error = new Error("PAGE_URL_INSPECTION_FAILED", { cause });
    error.code = "PAGE_URL_INSPECTION_FAILED";
    throw error;
  }
  // Blank transitions stay legal here on purpose: the round ladder below already turns
  // them into the usual RECOVER/CALIBRATE navigation. Only a non-blank, non-session
  // source (chrome:// inner pages, foreign hosts, unreadable strings) exits.
  if (probeOriginVerdict(originUrl, uuid) === "INVALID") {
    await writeState({
      spaceId, pageLabel: page.label, pageCount: pages.length,
      probeFailed: true, recoveryFailed: false,
      errorCode: "PROBE_INVALID_ORIGIN",
    });
    await appendEvent(MON, "PROBE_INVALID_ORIGIN", {
      spaceId, selectionEvidence, conversationUuid: uuid,
      rawUrl: String(originUrl).slice(0, 200),
    });
    console.log("RESULT=PROBE_INVALID_ORIGIN");
    process.exit(0);
  }
} catch (error) {
  const takeover = isTaskSpaceTakeover(error);
  const code = takeover ? TASKSPACE_TAKEOVER_SIGNAL : "PAGE_RECOVERY_FAILED";
  await writeState({ spaceId, probeFailed: true, recoveryFailed: true, errorCode: code, ...safeError(error) });
  await appendEvent(MON, code, { spaceId, ...safeError(error) });
  console.log("RECOVERY_DETAIL=" + String(error && error.message || error).slice(0, 200));
  if (isTaskspaceOwnershipLoss(error)) console.log(taskspaceOperatorAction(SPACE));
  console.log("RESULT=" + (takeover ? TASKSPACE_TAKEOVER_SIGNAL : "TASKSPACE_RECOVERY_FAILED"));
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
    if (isChatSurfaceReady(sample)) return sample;
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
// agent-kit#38/#37: the dispatch-time tail is the durable delivery baseline.
// A live tail still sitting on it means the message never persisted server-side
// (vanish mode) — such a round must never be promoted to a done candidate.
const ledgerBaselineTailKey = dispatchResult.record?.baselineTailKey || null;
const tailKeyEqualsBaseline = ["SEND_STARTED", "ACCEPTED"].includes(dispatchResult.record?.status) &&
  Boolean(probe.lastMessageKey) && probe.lastMessageKey === ledgerBaselineTailKey;
const sameGeneration = previous.generationKey === (dispatchId || "conversation");
const completedDispatch = dispatchResult.record?.status === "COMPLETED";
// #38 fix 3: an ABORTED ledger is terminal — same non-in-flight treatment as
// COMPLETED (never a done candidate, never a delivery-failure candidate).
const abortedDispatch = dispatchResult.record?.status === "ABORTED";
const terminalDispatch = completedDispatch || abortedDispatch;
const everGenerating = terminalDispatch ? false :
  (sameGeneration ? previous.everGenerating || probe.generating : probe.generating);
const bodyChanged = previous.len !== probe.bodyLen;
const substantiveProgress = (probe.lastMessageRole === "assistant" && (
  (probe.lastMessageKey && probe.lastMessageKey !== previous.lastMessageKey) ||
  (probe.lastMessageTextLength > previous.lastMessageTextLength)
)) || (everGenerating && JSON.stringify(probe.activityMarkers) !== JSON.stringify(previousActivityMarkers || []));
const recovered = startupNeedsReview;
const state = await writeState({
  spaceId, pageLabel: page.label, pageCount: pages.length,
  generating: probe.generating,
  everGenerating,
  generationKey: dispatchId || "conversation",
  len: probe.bodyLen,
  bodyChanged,
  lastProgressAt: substantiveProgress || !sameGeneration ? now() : (previous.lastProgressAt ?? previous.ts ?? now()),
  startIdle: recovered && !probe.generating,
  doneCandidate: terminalDispatch ? false : (sameGeneration ? previous.doneCandidate : false),
  deliveryFailedCandidate: terminalDispatch ? false : tailKeyEqualsBaseline,
  // #27 Batch 3 (ruling §四.1/.2): the peer-confirmed generation upgrade and
  // the fail-closed ARMED_UNKNOWN catch-all for a missing arm field over an
  // in-flight ledger. The probe never writes DISARMED_IDLE — disarm is
  // manager-owned (disarmAfterRelease).
  armedReason: armedReasonOnProbeRound(previous.armedReason, {
    generating: probe.generating === true,
    dispatchInFlight: IN_FLIGHT_DISPATCH_STATUSES.has(dispatchResult.record?.status || ""),
  }),
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
if (abortedDispatch) {
  // #38 fix 3: the ledger was closed by the managed abort — terminal, no reply
  // exists, so never fall through to the DONE_CANDIDATE window; wake the watch.
  await appendEvent(MON, "DISPATCH_ABORTED_OBSERVED", { dispatchId });
  console.log("RESULT=DISPATCH_ABORTED_WAKE_SUPERVISOR");
  process.exit(0);
}

const responseTailAdvanced = dispatchResult.record?.status === "ACCEPTED" &&
  probe.composerEmpty && hasResponseTailAdvanced(dispatchResult.record, probe);
if (shouldReviewStartupIdle(state.startIdle, responseTailAdvanced)) {
  await appendEvent(MON, "START_IDLE_WAKE_SUPERVISOR", { pageLabel: page.label });
  console.log("RESULT=START_IDLE_WAKE_SUPERVISOR");
  process.exit(0);
}
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
  if (stable && ledgerBaselineTailKey && second.lastMessageKey === ledgerBaselineTailKey) {
    // agent-kit#38/#37: a "stable" tail identical to the dispatch baseline is the
    // vanish-mode signature — nothing ever landed (or the optimistic user turn
    // rolled back). The old window confirmed DONE_CANDIDATE here 4x because
    // everGenerating bypassed the tail-advance guard. NEVER set doneCandidate on
    // a baseline tail; mark the delivery-failure candidate instead and let the
    // supervision layer raise DELIVERY_SUSPECTED after its window.
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
      doneCandidate: false,
      deliveryFailedCandidate: true,
    });
    await appendEvent(MON, "DONE_CANDIDATE_REFUSED_BASELINE_TAIL", {
      dispatchId, lastMessageKey: second.lastMessageKey, baselineTailKey: ledgerBaselineTailKey,
      bodyLen: second.bodyLen,
    });
    console.log("RESULT=GENERATING");
  } else if (!stable) {
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
    // agent-kit#33: freeze the live-window evidence into the dispatch record so a
    // later collect failure can tell a server-side dead reply from virtualization.
    // A record-write failure is diagnostic only — the wake must still go out.
    try { await markDoneCandidate(MON, dispatchId, { bodyLen: second.bodyLen, lastMessageKey: second.lastMessageKey }); }
    catch (error) { await appendEvent(MON, "DONE_CANDIDATE_RECORD_FAILED", safeError(error)).catch(() => {}); }
    console.log("TRANSITION_GENERATING_TO_IDLE_CONFIRMED");
    console.log("RESULT=DONE_CANDIDATE");
  }
} else {
  console.log("RESULT=" + (probe.generating ? "GENERATING" : "IDLE_PREDELIVERY"));
}
