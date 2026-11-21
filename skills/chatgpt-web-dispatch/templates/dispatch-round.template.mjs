// Standard ChatGPT dispatch round — R2.5 frozen transaction chain (planner rulings reply-r43 + reply-r44).
//
// PREPARED → 填充 → 完整回读 → 刷新 Composer ref → 所有权复核 → SEND_STARTED → Enter → AUTO_ACCEPTED
// 任何一步无法证明，都不得进入下一步。
//
// ADAPTATION_REQUIRED 级红线（issue #12-4 实测：自定义 round 脚本漏抄即卡死）：
// ① resume 分支（Gate 1 内 status==="PREPARED" && payload_sha256 匹配的复用路径）必须原样保留，
//    删除它 = 派单中断后 PREPARED 记录永久 ACTIVE_BLOCKS_SEND；
// ② 派单账本文件名是 a-dispatch-state.json（带 a- 前缀，与 a-fast-state.json 同族），patch 时勿写错。
//
// Deployment adapters:
const MON = "REPLACE_WITH_DEPLOY_MONITOR_DIR"; // monitor dir with dispatch-state.mjs + state-schema.mjs
const SPACE = "REPLACE_WITH_UNIQUE_TASKSPACE"; // stable Agent-owned space, Chinese display name allowed
const AGENT_ID = "REPLACE_WITH_STABLE_AGENT_ID"; // fixed per Agent, shared by all its conversations
const MSG_FILE = "REPLACE_WITH_MESSAGE_FILE_PATH"; // UTF-8 file holding the payload text
const CONV = "REPLACE_WITH_CONVERSATION_UUID"; // page located by URL containing CONV, never by label
const ATTACHMENTS = "REPLACE_WITH_ATTACHMENTS_JSON"; // managed JSON array of absolute file paths
const NEW_CHAT = "REPLACE_WITH_NEW_CHAT_FLAG"; // true only for a durable send-new request
const RECOVER_ONLY = "REPLACE_WITH_RECOVER_ONLY"; // clear only a verified PREPARED draft
const ATTACH_CHANNEL_EVIDENCE = ""; // #28 §3.2 precheck, only needed when attachments are sent: "USER_STATED:<peer repo permission the user stated in-session>" or "MEASURED_FAIL:<recorded GitHub-read failure>"

if ([MON, SPACE, CONV, AGENT_ID].some((v) => v.startsWith("REPLACE_")) || MSG_FILE.startsWith("REPLACE_")) {
  console.log("RESULT=ADAPTATION_REQUIRED");
  process.exit(1);
}

import * as fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { unlinkSync, readFileSync } from "node:fs";

const {
  appendEvent, prepareDispatch, markSendStarted, markAccepted, markUncertain, abortPreparedDispatch,
  writeJsonAtomic,
  readComposerSurface, readDispatchState,
  dispatchStopSnapshot,
  chunkPayload, readbackMatches, readbackMode, classifyChunkReadback, verifyDraftOwnership, composerReadbackText,
  getFillCount, recordFillAttempt, resetFillCount,
  markComposerFreeze, findUnconsumedComposerFreeze,
  dispatchStormGate,
  verifyAttachmentEvidence,
} = await import(pathToFileURL(MON + "/dispatch-state.mjs").href);
const { isTaskSpaceTakeover, TASKSPACE_TAKEOVER_SIGNAL, assertAgentOwnedTaskSpace } =
  await import(pathToFileURL(MON + "/taskspace-takeover.mjs").href);
const { claimAgentSpace, isValidNewTaskSpaceName, assertTaskSpaceNamingAllowed } = await import(pathToFileURL(MON + "/agent-space.mjs").href);
const { recoverConversationPage, conversationIdFromUrl } = await import(pathToFileURL(MON + "/page-recovery.mjs").href);

const payload = await fs.readFile(MSG_FILE, "utf-8");
const payloadHash = createHash("sha256").update(payload, "utf8").digest("hex");
const abort = (code) => {
  const ledger = dispatchStopSnapshot(MON, {
    conversationUuid: CONV, taskSpace: SPACE, payloadSha256: payloadHash,
  });
  const delivered = ledger.matchesCurrent && ["ACCEPTED", "COMPLETED"].includes(ledger.status);
  const attempted = ledger.matchesCurrent && ["SEND_STARTED", "UNCERTAIN"].includes(ledger.status);
  const signal = delivered ? "DISPATCH_ACCEPTED_WAKE_SUPERVISOR" :
    attempted ? "DISPATCH_ATTEMPTED_WAKE_SUPERVISOR" : code;
  console.log("DISPATCH_LEDGER=" + JSON.stringify(ledger));
  if (delivered || attempted) {
    console.log("STOP_CAUSE=" + code);
    console.log(delivered ? "ACTION=ARM_MONITORS_NO_RESEND" : "ACTION=RECONCILE_SEND_NO_RESEND");
  }
  console.log("RESULT=" + signal);
  process.exit(1);
};

// Read the account pin before creating any TaskSpace or Page.
let profileCfg = null;
try { profileCfg = JSON.parse(await fs.readFile(homedir() + "/.agents/ego-profile.json", "utf-8")); }
catch { abort("ACCOUNT_CONFIG_MISSING_STOP"); }
if (!profileCfg?.defaultProfileId || !((profileCfg.spaceExpect && profileCfg.spaceExpect[SPACE]) || profileCfg.defaultAccount)) {
  abort("ACCOUNT_CONFIG_INCOMPLETE_STOP");
}

// The empty new-chat draft is shared across tabs of the same ChatGPT account.
// A machine-wide exclusive lock covers the complete prepare/fill/send transaction.
// Stale locks after a hard kill require supervisor reconciliation before removal.
const LOCK = homedir() + "/.agents/ego-composer.lock";
const lockOwner = randomUUID();
let lockHandle = null;
try {
  lockHandle = await fs.open(LOCK, "wx", 0o600);
  await lockHandle.writeFile(JSON.stringify({ owner: lockOwner, pid: process.pid, space: SPACE, since: Date.now() }));
} catch (error) {
  if (lockHandle) await lockHandle.close();
  abort(error?.code === "EEXIST" ? "COMPOSER_LOCK_BUSY" : "COMPOSER_LOCK_UNAVAILABLE");
}
process.on("exit", () => {
  try { if (JSON.parse(readFileSync(LOCK, "utf8")).owner === lockOwner) unlinkSync(LOCK); } catch {}
});

try {
  // #27 re-review P1-1: the naming gate precedes ANY registry write. A
  // read-only listTaskSpaces() decides whether SPACE already exists (legacy
  // reuse stays legal); a MISSING space must pass the frozen naming convention
  // BEFORE claimAgentSpace(), so a violating new name can never enter the
  // registry — and from there borrow rebuild-space's LEDGER_PROOF creation.
  const existingSpaces = await listTaskSpaces();
  const spaceExists = existingSpaces.some((space) => space.taskId === SPACE || space.name === SPACE);
  assertTaskSpaceNamingAllowed(SPACE, AGENT_ID, spaceExists);
  await claimAgentSpace({ agentId: AGENT_ID, spaceName: SPACE });
} catch (error) { abort(error.code || "AGENT_SPACE_REGISTRY_INVALID"); }

// Run BEFORE any browser API; storm expiry alone does not grant dispatch permission.
const checkStorm = async () => {
  let pending;
  try { pending = await dispatchStormGate(MON); }
  catch { abort("STORM_STATE_UNREADABLE_STOP"); }
  if (pending) abort(pending);
};
await checkStorm();

let task;
let page = null;
let pageNeedsNavigation = false;
// Distinguish the two failure domains inside the shared try: a bootstrap attempt
// that never completed means the registry lost the space (agent-kit#31), which
// the managed rebuild-space step can fix; later page-recovery failures must not.
let spaceRegistryMissing = false;
let spaceReady = false;
try {
  const spaces = await listTaskSpaces();
  let targetSpace = spaces.find((space) => space.taskId === SPACE || space.name === SPACE);
  if (!targetSpace) {
    // r48: ego restart clears the space registry. Bootstrap the pinned space for
    // BOTH new chats and existing-conversation sends (same rule as ego-fast-probe),
    // instead of failing send with TASKSPACE_NOT_FOUND until a new chat happens.
    spaceRegistryMissing = true;
    if (!profileCfg.defaultProfileId) abort("ACCOUNT_CONFIG_MISSING_STOP");
    // #27 Batch 2 frozen naming convention: only NEW space creation is
    // constrained — an existing space keeps its (possibly legacy) name, the
    // reuse branch above never calls the validator. A legacy-named space lost
    // from the registry recovers through the managed rebuild-space path.
    if (!isValidNewTaskSpaceName(SPACE, AGENT_ID)) abort("TASKSPACE_NAMING_VIOLATION_STOP");
    task = await taskSpace(SPACE, { profileId: profileCfg.defaultProfileId });
    targetSpace = (await listTaskSpaces()).find((space) => space.taskId === SPACE || space.name === SPACE);
  }
  assertAgentOwnedTaskSpace(targetSpace, SPACE);
  if (!task) task = await taskSpace(targetSpace.id);
  spaceReady = true;
  if (NEW_CHAT) {
    const request = JSON.parse(await fs.readFile(MON + "/a-new-request.json", "utf8"));
    if (request.requestId.toLowerCase() !== CONV.toLowerCase() || request.space !== SPACE ||
        request.agentId !== AGENT_ID || request.payloadSha256 !== payloadHash) {
      abort("NEW_CHAT_REQUEST_MISMATCH");
    }
    // Persist the allocation intent before creating a Page. A crash may leave
    // an unknown Page, so resuming requires inspection rather than another newPage().
    await writeJsonAtomic(MON + "/a-new-page.json", { requestId: CONV, status: "ALLOCATING" });
    page = await task.newPage();
    await writeJsonAtomic(MON + "/a-new-page.json", { requestId: CONV, status: "ALLOCATED", pageLabel: page.label });
  } else {
    const recovered = await recoverConversationPage(task, CONV);
    page = recovered.page;
    pageNeedsNavigation = recovered.needsNavigation;
    if (pageNeedsNavigation || recovered.selectionEvidence === "AGENT_OWNED_TAB_ADOPTED") {
      await appendEvent(MON, "CONVERSATION_PAGE_RECOVERED", {
        conversationUuid: CONV, pageLabel: page.label, selectionEvidence: recovered.selectionEvidence,
      });
    }
  }
} catch (error) {
  console.log("RECOVERY_DETAIL=" + String(error && error.message || error).slice(0, 220));
  if (spaceRegistryMissing && !spaceReady && !isTaskSpaceTakeover(error)) {
    console.log('RECOVERY_HINT=SPACE_REGISTRY_LOST command="dispatch-manager.mjs rebuild-space --monitor-dir <monitor-dir> --agent-id <agent-id> --space <space>"');
  }
  abort(isTaskSpaceTakeover(error) ? TASKSPACE_TAKEOVER_SIGNAL : "TASKSPACE_RECOVERY_FAILED");
}
if (!page) abort("CONVERSATION_PAGE_MISSING");
if (!NEW_CHAT) {
  try {
    await claimAgentSpace({ agentId: AGENT_ID, spaceName: SPACE, conversationUuid: CONV });
  } catch (error) { abort(error.code || "AGENT_SPACE_REGISTRY_INVALID"); }
}

// Query all visible composer candidates; selector order does NOT express priority.
// Resolve by aria-label, then id/testid, then non-code contenteditable (agent-kit#14).
const COMPOSER_SEL = '#prompt-textarea, [data-testid="prompt-textarea"], [contenteditable="true"][role="textbox"], textarea';

// Unified composer-operation wrapper: EVERY composer evaluate/read sits inside the freeze channel.
// A renderer freeze (PageEvaluationTimeout family) is recorded through the SHARED single-writer
// entry then routed to storm backoff by the probe — no composer entry point bypasses it (r44 P0-B5).
const composerOp = async (fn) => {
  try { return await fn(); }
  catch (error) {
    await markComposerFreeze(MON, { space: SPACE, error }).catch(() => {});
    abort("COMPOSER_RENDER_FREEZE");
  }
};

// Every navigation (including the first new-chat landing) uses one audited channel.
const navigate = async (reason) => {
  await checkStorm();
  const gotoAt = Date.now(); // single timestamp per navigation (R2.4 unified entry contract)
  await appendEvent(MON, "GOTO_ATTEMPT", { goto_reason: reason, at: gotoAt, agent_id: SPACE, space: SPACE, lastGotoAt: gotoAt });
  await page.goto(NEW_CHAT ? "https://chatgpt.com" : "https://chatgpt.com/c/" + CONV, { timeout: 45000 });
  await page.waitForLoadState("load", { timeout: 30000 });
  let ready = false;
  for (let i = 0; i < 20 && !ready; i++) {
    if (NEW_CHAT) {
      const surface = await composerOp(() => readComposerSurface(page));
      ready = surface.hostOk && surface.composerPresent;
    } else {
      const len = await composerOp(() => page.evaluate(() => document.body.innerText.length));
      ready = len > 600;
    }
    if (!ready) await page.waitForTimeout(2000);
  }
  if (!ready) abort("PAGE_NOT_READY_AFTER_NAVIGATE");
  await page.waitForTimeout(1000);
};

if (NEW_CHAT) await navigate("NEW_CHAT_INITIAL");
else if (pageNeedsNavigation) await navigate("CONVERSATION_PAGE_RECOVERY");

// Same tier order and visibility rule as monitor/dispatch-state.mjs readComposerSurface.
// One page-evaluate implementation covers read, clear and fill; ambiguous tiers fail closed.
const evaluateComposer = (action, text = "") => page.evaluate(({ sel, action, text }) => {
  const visible = (element) => {
    const rect = element?.getBoundingClientRect?.();
    return Boolean((rect && rect.width > 0 && rect.height > 0) ||
      element?.getClientRects?.().length > 0);
  };
  const composers = [...document.querySelectorAll(sel)].filter(visible);
  const composerLabels = new Set(["询问 ChatGPT", "Ask ChatGPT"]);
  const isCodeEditor = (element) => /code/i.test(element.getAttribute("aria-label") || "");
  const tiers = [
    composers.filter((element) => composerLabels.has(element.getAttribute("aria-label"))),
    composers.filter((element) => element.id === "prompt-textarea" ||
      element.getAttribute("data-testid") === "prompt-textarea"),
    composers.filter((element) => element.matches('[contenteditable="true"][role="textbox"]') &&
      !isCodeEditor(element)),
  ];
  const tier = tiers.find((matches) => matches.length > 0);
  const el = tier?.length === 1 ? tier[0] : null; // multiple matches at the highest tier are unsafe
  if (!el) return action === "read" ? "" : false;
  if (action === "read") {
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return el.value || "";
    const nodes = [...(el.childNodes || [])];
    const paragraphs = nodes.length && nodes.every((node) =>
      (node.nodeType === 1 && node.tagName === "P") ||
      (node.nodeType === 3 && !(node.textContent || "").trim()))
      ? nodes.filter((node) => node.nodeType === 1).map((node) => node.innerText ?? node.textContent ?? "")
      : null;
    return { raw: el.innerText || "", paragraphs };
  }
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel2 = window.getSelection();
  sel2.removeAllRanges();
  if (action === "clear") {
    sel2.addRange(range);
    sel2.deleteFromDocument();
    return true;
  }
  return false;
}, { sel: COMPOSER_SEL, action, text });

const readRaw = async () => composerReadbackText(await composerOp(() => evaluateComposer("read")));
const ensureFocused = async () => {
  await page.cdp("Page.bringToFront");
  const focused = await composerOp(() => page.evaluate(() => document.hasFocus()));
  if (!focused) abort("HASFOCUS_FALSE_AFTER_BRINGTOFRONT");
};
const activateComposer = async () => {
  await ensureFocused();
  const snap = await page.snapshot({ scope: "full_page" });
  const line = snap.split("\n").reverse().find((l) => /textfield "(询问 ChatGPT|Ask ChatGPT)"/.test(l));
  const ref = line && (line.match(/\[ref=(\d+)/) || [])[1];
  if (!ref) abort("COMPOSER_ACTIVATION_REF_MISSING");
  await page.click("@" + ref);
  const active = await composerOp(() => page.evaluate(() =>
    ["询问 ChatGPT", "Ask ChatGPT"].includes(document.activeElement?.getAttribute("aria-label"))));
  if (!active) abort("COMPOSER_ACTIVATION_FAILED");
};
const insertChunk = async (chunk) => {
  await page.cdp("Input.dispatchKeyEvent", {
    type: "keyDown", key: "End", code: "End", windowsVirtualKeyCode: 35, modifiers: 2,
  });
  await page.cdp("Input.dispatchKeyEvent", {
    type: "keyUp", key: "End", code: "End", windowsVirtualKeyCode: 35, modifiers: 2,
  });
  await page.cdp("Input.insertText", { text: chunk });
};

// ---- Gate 0: unprocessed composer freeze (R2.5-H) — the probe owns the storm backoff.
// Fail-closed read (r44 P0-A1): a ledger read failure must never masquerade as "no freeze".
let pendingFreeze = null;
try { pendingFreeze = await findUnconsumedComposerFreeze(MON); }
catch (error) { abort("FREEZE_LEDGER_READ_FAILED"); }
if (pendingFreeze) abort("FROZEN_BACKOFF_PENDING");

// ---- Gate 1: surface gates + dispatch ledger — fail-closed read (r44 P0-A1).
let surface0 = null;
try { surface0 = await readComposerSurface(page); }
catch (error) {
  await markComposerFreeze(MON, { space: SPACE, error }).catch(() => {});
  abort("COMPOSER_RENDER_FREEZE");
}
if (!surface0.hostOk || !surface0.composerPresent) abort("COMPOSER_SURFACE_UNAVAILABLE");
if (surface0.surfaceMode !== "CHATGPT") abort("CHATGPT_MODE_REQUIRED");
if (surface0.generating) abort("PREVIOUS_GENERATION_STILL_ACTIVE");

let existing = null;
try { existing = await readDispatchState(MON); }
catch (error) { abort("DISPATCH_LEDGER_READ_FAILED"); }

// Resume only a PREPARED record of THIS exact payload (interrupted dispatch of the same message).
const resume = existing?.status === "PREPARED" && existing.payload_sha256 === payloadHash;
if (RECOVER_ONLY && (!resume || NEW_CHAT || ATTACHMENTS.length)) abort("RECOVERY_REQUIRES_MATCHING_PREPARED");
if (existing && ["SEND_STARTED", "ACCEPTED", "UNCERTAIN", "RETRY_AUTHORIZED"].includes(existing.status)) {
  abort("DISPATCH_IN_FLIGHT_" + existing.status); // already sent: acceptance reconciliation only
}
if (existing?.status === "PREPARED" && !resume) {
  abort("STALE_PREPARED_RECORD_STOP"); // interrupted dispatch of a DIFFERENT payload: supervisor
}

// ---- Gate 1.5: account pin (PO 令 2026-11-08, issue #7 root cause) — profileId only applies at
// space CREATION, so a resumed space keeps whatever account it was born with. Verify the account
// actually logged in on this page against the machine-local pin BEFORE anything is filled or sent.
const expectedAccount = (profileCfg.spaceExpect && profileCfg.spaceExpect[SPACE]) || profileCfg.defaultAccount;
if (!expectedAccount || !profileCfg.defaultProfileId) abort("ACCOUNT_CONFIG_INCOMPLETE_STOP");
// In-page fetch (window.fetch + credentials): ego's page.fetch wrapper can return null on a freshly
// navigated page; the in-page call is the reliable evidence channel. Email+token in memory only —
// never logged, never persisted (handbook §11.7).
const sessionEvidence = await composerOp(() => page.evaluate(async () => {
  try { const r = await fetch("/api/auth/session", { credentials: "include" }); const j = await r.json(); return { email: (j && j.user && j.user.email) || null, token: (j && j.accessToken) || null }; }
  catch { return null; }
}));
const accountEmail = sessionEvidence ? sessionEvidence.email : null;
if (!accountEmail) abort("ACCOUNT_UNPROVEN_STOP");
if (accountEmail !== expectedAccount) abort("ACCOUNT_MISMATCH_STOP:" + SPACE);

// ---- Gate 2 as a REUSABLE procedure: ownership + clear + verify-empty, re-run after EVERY goto —
// a goto can resurrect an old draft (r44 P0-B2).
const ensureOwnEmptyComposer = async () => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const surface = await composerOp(() => readComposerSurface(page));
    if (!surface.composerEmpty) {
      const draft = await readRaw();
      const ownership = verifyDraftOwnership({ draft, payload, record: existing });
      if (!ownership.owned) abort(ownership.kind === "empty" ? "DRAFT_STATE_CONFLICT_STOP" : "FOREIGN_DRAFT_STOP:" + (ownership.reason || ownership.kind));
      if (ownership.kind === "historical-identity" && !resume) abort("HISTORICAL_DRAFT_STOP");
      const cleared = await composerOp(() => evaluateClearComposer());
      if (!cleared) abort("DRAFT_CLEAR_FAILED");
    }
    // Hydration can refill a previously empty composer without navigation.
    let resurrected = false;
    for (const delay of [0, 700, 1100, 1500]) {
      if (delay) await page.waitForTimeout(delay);
      const after = await composerOp(() => readComposerSurface(page));
      if (!after.composerEmpty) { resurrected = true; break; }
    }
    if (!resurrected) return;
  }
  abort("DRAFT_RESURRECTED_AFTER_CLEAR");
};

// ---- Gate 3: FRESHEN — 3 completed fill attempts since the last successful navigation.
// Navigation funnels through the ONE navigate() entry (single gotoAt timestamp + GOTO_ATTEMPT event);
// the template must not open a second navigation channel (r44 P0-B1). After any goto the full
// draft-resurrection check re-runs (r44 P0-B2).
const evaluateClearComposer = () => evaluateComposer("clear");

await ensureOwnEmptyComposer(); // Gate 2 (initial)

if (RECOVER_ONLY) {
  await abortPreparedDispatch(MON, existing.dispatchId);
  console.log("RESULT=OWNED_DRAFT_CLEARED");
  process.exit(0);
}

if (await getFillCount(MON, SPACE) >= 3) { // Gate 3 (FRESHEN)
  await checkStorm();
  await navigate("FRESHEN");
  await resetFillCount(MON, SPACE);
  await ensureOwnEmptyComposer(); // resurrection check, never skipped
}

// ---- #28 §3.2 attachment-channel precheck — fail-closed BEFORE any PREPARED ledger write ----
// GitHub-first is the default material channel (handbook §3.2). Downgrading to the
// attachment channel requires an explicitly recorded basis in ATTACH_CHANNEL_EVIDENCE:
// USER_STATED:<peer repo permission the user stated in-session> or MEASURED_FAIL:<the
// actual GitHub-read failure, never an assumption>. A missing or malformed basis stops
// the dispatch before PREPARED, so the corrected next round starts without ledger state,
// and the basis is echoed to the output stream as the downgrade's written record.
if (ATTACHMENTS.length > 0) {
  if (!ATTACH_CHANNEL_EVIDENCE) abort("ATTACHMENT_CHANNEL_PRECHECK_MISSING");
  if (!/^(USER_STATED|MEASURED_FAIL):/.test(ATTACH_CHANNEL_EVIDENCE) || ATTACH_CHANNEL_EVIDENCE.length > 220) {
    abort("ATTACHMENT_CHANNEL_PRECHECK_INVALID");
  }
  console.log("ATTACH_CHANNEL_BASIS=" + ATTACH_CHANNEL_EVIDENCE.slice(0, 220));
}

// ---- Gate 4: PREPARED persisted BEFORE the first insertText (r44 P0-B3 — frozen chain order:
// PREPARED → 填充 → 回读 → …). An interrupted fill then resumes from the persisted dispatch identity,
// not from runtime file contents.
const dispatch = resume ? existing :
  await prepareDispatch({ monitorDir: MON, conversationUuid: CONV, taskSpace: SPACE, pageLabel: page.label, page, payload });

// ---- Gate 5: adaptive fill with cumulative-prefix readback (R2.6-F) ----
const attachmentSurface = () => page.evaluate(() => [...document.querySelectorAll("form")].map((form) => {
    const send = form.querySelector("button[aria-label='发送'], button[data-testid='send-button']");
    return {
      text: form.innerText || "",
      images: form.querySelectorAll("img").length,
      sendEnabled: Boolean(send && !send.disabled && send.getAttribute("aria-disabled") !== "true"),
    };
  }));
let attachmentBefore = null;
let attachmentNames = [];
if (ATTACHMENTS.length > 0) {
  if (resume) abort("ATTACHMENT_RESUME_REQUIRES_RECONCILIATION");
  attachmentBefore = await composerOp(attachmentSurface);
  await page.waitForSelector('input[aria-label="附加文件"]', { state: "attached" });
  await page.setInputFiles('input[aria-label="附加文件"] >> nth=-1', ATTACHMENTS);
  attachmentNames = ATTACHMENTS.map((file) => file.replace(/\\/g, "/").split("/").at(-1));
}
await recordFillAttempt(MON, SPACE);
if (payload.length > 0) await activateComposer(); // one real click, before all chunks
const chunks = chunkPayload(payload, 1200, 600);
const fillReadbackMode = readbackMode(payload);
let expectedPrefix = "";
let composerText = "";
for (const chunk of chunks) {
  const nextPrefix = expectedPrefix + chunk;
  let verified = false;
  for (let attempt = 0; attempt < 2 && !verified; attempt++) {
    await composerOp(() => insertChunk(chunk));
    await page.waitForTimeout(450);
    composerText = await readRaw();

    const readbackState = classifyChunkReadback(expectedPrefix, nextPrefix, composerText, fillReadbackMode);
    if (readbackState === "INSERTED") {
      expectedPrefix = nextPrefix;
      verified = true;
      break;
    }
    // Retry only when the Composer is provably unchanged. Partial, reordered, or foreign
    // content is not repaired automatically; stop before it can reach the send gate.
    if (readbackState === "MISMATCH") abort("CHUNK_READBACK_MISMATCH");
    if (attempt === 0) {
      await page.waitForTimeout(1000);
      // Re-read immediately before retry: a delayed insertion may have completed during the wait.
      composerText = await readRaw();
      const retryReadbackState = classifyChunkReadback(expectedPrefix, nextPrefix, composerText, fillReadbackMode);
      if (retryReadbackState === "INSERTED") {
        expectedPrefix = nextPrefix;
        verified = true;
        break;
      }
      if (retryReadbackState === "MISMATCH") abort("CHUNK_READBACK_MISMATCH");
    }
  }
  if (!verified) abort("CHUNK_INSERT_NO_EFFECT");
}

// ---- Gate 6: final full-payload verdict, using the last cumulative readback (no duplicate DOM read).
// Empty payloads have no chunks, so read the Composer once to establish their empty-slate state.
if (chunks.length === 0) composerText = await readRaw();
if (!readbackMatches(payload, composerText, fillReadbackMode)) {
  abort(fillReadbackMode === "strict" ? "SENSITIVE_FIDELITY_UNPROVEN" : "READBACK_NOT_VERIFIED_ABORT");
}
if (attachmentBefore) {
  // Wait for thumbnails/chips to mount and for the actual send control to enable.
  let mounted = false;
  for (let attempt = 0; attempt < 4 && !mounted; attempt++) {
    mounted = verifyAttachmentEvidence(attachmentBefore, await composerOp(attachmentSurface), attachmentNames);
    if (!mounted) await page.waitForTimeout(800);
  }
  if (!mounted) {
    // #39-① evidence: the live composer form/action bar has drifted from the
    // attachmentSurface assumptions (form.text, send-button selector, filename chips).
    // Dump the actual region before the fail-closed stop — read-only; the abort below
    // is unchanged. Field facts wanted: whether forms/editors exist, which send
    // control is present and whether it is disabled, how many file inputs carry the
    // mounted files, and whether any element text hits the attachment filenames.
    try {
      const evidence = await page.evaluate((names) => {
        const visible = (el) => {
          try {
            const s = getComputedStyle(el);
            if (s.display === "none" || s.visibility === "hidden") return false;
          } catch {}
          if (el.getClientRects().length > 0) return true;
          const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
          return Boolean(rect && rect.width > 0 && rect.height > 0);
        };
        const attr = (el, name) => String(el.getAttribute(name) || "").slice(0, 40);
        const buttonBrief = (el) => ({
          tag: el.tagName,
          ariaLabel: attr(el, "aria-label"),
          title: attr(el, "title"),
          text: String(el.textContent || "").trim().slice(0, 16),
          disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true",
        });
        const fileBrief = (inp) => ({
          ariaLabel: attr(inp, "aria-label"),
          accept: String(inp.getAttribute("accept") || "").slice(0, 60),
          files: inp.files ? inp.files.length : null,
        });
        const forms = [...document.querySelectorAll("form")].slice(0, 4).map((form) => {
          const send = form.querySelector("button[aria-label='发送'], button[data-testid='send-button']");
          const text = String(form.innerText || "");
          return {
            visible: visible(form),
            text: text.slice(0, 100),
            images: form.querySelectorAll("img").length,
            sendButton: send ? {
              ariaLabel: attr(send, "aria-label"),
              disabled: send.disabled === true || send.getAttribute("aria-disabled") === "true",
            } : null,
            fileInputs: [...form.querySelectorAll("input[type='file']")].map(fileBrief),
            buttons: [...form.querySelectorAll("button")].filter(visible).slice(0, 12).map(buttonBrief),
            filenameHits: names.filter((name) => text.includes(name)).length,
          };
        });
        // Composer action-bar fallback: buttons around activeElement (form + 3 ancestors)
        // even when the composer area is not inside a form.
        const scopes = new Set();
        let node = document.activeElement;
        for (let depth = 0; node && depth < 4; depth++) {
          scopes.add(node);
          if (node.form) scopes.add(node.form);
          node = node.parentElement;
        }
        const nearbyButtons = [];
        const seenButtons = new Set();
        for (const scope of scopes) {
          for (const b of scope.querySelectorAll("button")) {
            if (visible(b) && !seenButtons.has(b)) { seenButtons.add(b); nearbyButtons.push(buttonBrief(b)); }
          }
        }
        return {
          forms,
          composerNearbyButtons: nearbyButtons.slice(0, 12),
          allFileInputs: [...document.querySelectorAll("input[type='file']")].map(fileBrief).slice(0, 8),
          filenameTextEls: names.map((name) =>
            [...document.querySelectorAll("*")].filter((el) => el.children.length === 0 &&
              String(el.textContent || "").includes(name)).length),
          names: names.map((name) => String(name).slice(0, 40)),
        };
      }, attachmentNames);
      console.log("ATTACH_DUMP=" + JSON.stringify(evidence).slice(0, 900));
    } catch {}
    abort("ATTACHMENT_NOT_VERIFIED");
  }
}

// ---- Gate 7: chat mode is mandatory before thinking-level precheck.
const chatMode = await composerOp(() => page.evaluate(() => {
  // r48.2: the mode state lives in the toggle's aria-label ("切换模式，当前模式：ChatGPT");
  // aria-pressed mode buttons no longer exist on the current UI. Chat-family labels
  // accepted: ChatGPT / 聊天 / Chat. Work-family: Codex / 工作 / Work.
  const toggle = [...document.querySelectorAll('button')]
    .find((el) => /切换模式|Switch mode|current mode/i.test(el.getAttribute('aria-label') || ''));
  const current = toggle ? (toggle.getAttribute('aria-label').match(/(?:当前模式：|current mode:?\s*)([A-Za-z一-龥]+)/) || [])[1] || '' : '';
  if (current) return /^(ChatGPT|聊天|Chat)$/i.test(current.trim());
  // fallback: aria-pressed pair (older UIs)
  const modes = [...document.querySelectorAll('button[aria-pressed]')]
    .filter((el) => el.getClientRects().length > 0)
    .map((el) => ({ label: (el.textContent || "").trim(), pressed: el.getAttribute("aria-pressed") }))
    .filter(({ label }) => /^(聊天|Chat|ChatGPT|工作|Work|Codex)$/i.test(label));
  const chat = modes.filter(({ label }) => /^(聊天|Chat|ChatGPT)$/i.test(label));
  const work = modes.filter(({ label }) => /^(工作|Work|Codex)$/i.test(label));
  return chat.length >= 1 && chat.every((m) => m.pressed === "true") &&
    (work.length === 0 || work.every((m) => m.pressed === "false"));
}));
if (!chatMode) {
  try {
    const dump = await page.evaluate(() => [...document.querySelectorAll('button[aria-pressed]')]
      .filter((el) => el.getClientRects().length > 0)
      .map((el) => (el.textContent || "").trim().slice(0, 20) + "=" + el.getAttribute("aria-pressed")));
    console.log("MODE_LABELS=" + JSON.stringify(dump).slice(0, 300));
  } catch {}
  // #39-② (+#21) evidence: on the live UI the old toggle/aria-pressed carriers are gone
  // and the mode state has moved elsewhere. Dump every plausible carrier before the
  // fail-closed stop — read-only; the abort below is unchanged. Field facts: visible
  // aria-pressed buttons carry empty textContent, and the composer aria-label itself is
  // the mode carrier (chat = 询问 ChatGPT, codex = 随心输入), which matches no mode
  // keyword — so editors and popup controls are dumped explicitly.
  try {
    const evidence = await page.evaluate(() => {
      const visible = (el) => {
        try {
          const s = getComputedStyle(el);
          if (s.display === "none" || s.visibility === "hidden") return false;
        } catch {}
        if (el.getClientRects().length > 0) return true;
        const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        return Boolean(rect && rect.width > 0 && rect.height > 0);
      };
      const attr = (el, name) => String(el.getAttribute(name) || "").slice(0, 40);
      const modeBrief = (el) => ({
        tag: el.tagName,
        ariaLabel: attr(el, "aria-label"),
        title: attr(el, "title"),
        pressed: el.getAttribute("aria-pressed"),
        expanded: el.getAttribute("aria-expanded"),
        text: String(el.textContent || "").trim().slice(0, 16),
      });
      // Composer identity carriers (any visible editable surface).
      const editors = [...document.querySelectorAll('[contenteditable="true"], [role="textbox"]')]
        .filter(visible).slice(0, 6)
        .map((el) => ({
          tag: el.tagName,
          ariaLabel: attr(el, "aria-label"),
          placeholder: String(el.getAttribute("data-placeholder") || el.getAttribute("placeholder") || "").slice(0, 20),
        }));
      // Keyword carrier: any element whose aria-label/title hints at a mode surface.
      const modeRe = /模式|mode|聊天|chat|codex|工作|Switch/i;
      const modeAttrEls = [...document.querySelectorAll("*")]
        .filter((el) => modeRe.test(String(el.getAttribute("aria-label") || "") + "\u0000" + String(el.getAttribute("title") || "")) && visible(el))
        .slice(0, 12).map(modeBrief);
      // Popup/combobox surfaces that can host a mode menu.
      const popupControls = [...document.querySelectorAll("[aria-haspopup], [role='combobox']")]
        .filter(visible).slice(0, 8)
        .map((el) => ({ tag: el.tagName, ariaLabel: attr(el, "aria-label"), expanded: el.getAttribute("aria-expanded") }));
      // Buttons around the composer: activeElement plus its form and three ancestor levels.
      const scopes = new Set();
      let node = document.activeElement;
      for (let depth = 0; node && depth < 4; depth++) {
        scopes.add(node);
        if (node.form) scopes.add(node.form);
        node = node.parentElement;
      }
      const nearbyButtons = [];
      const seenButtons = new Set();
      for (const scope of scopes) {
        for (const b of scope.querySelectorAll("button")) {
          if (visible(b) && !seenButtons.has(b)) { seenButtons.add(b); nearbyButtons.push(modeBrief(b)); }
        }
      }
      const active = document.activeElement;
      return {
        activeElement: active ? { tag: active.tagName, ariaLabel: attr(active, "aria-label"), title: attr(active, "title") } : null,
        editors,
        visibleAriaPressedButtons: [...document.querySelectorAll("button[aria-pressed]")].filter(visible).length,
        modeAttrEls,
        popupControls,
        composerNearbyButtons: nearbyButtons.slice(0, 16),
      };
    });
    console.log("MODE_DUMP=" + JSON.stringify(evidence).slice(0, 900));
  } catch {}
  abort("CHAT_MODE_UNVERIFIED_STOP");
}

// Thinking-level precheck — READ is locale-independent (aria attrs); ENTRY is bilingual.
// The EN-UI variant may have NO model menu at all (agent-kit#7): a click failure or missing menu is
// a fail-closed STOP, never a silent skip — a skipped gate is how a session ran unnoticed on mini.
let menuInfo = null;
try {
  // r48.3 hardening (2026-11-14 live): fresh page hydration needs retries; the radix
  // menu renders into popper wrappers, not always [role=menu]. Same recipe as the
  // field-proven hardened dispatcher: 3 attempts x (hydration wait + native click +
  // multi-wrapper radios poll), Escape between attempts.
  for (let attempt = 0; attempt < 3 && !menuInfo; attempt++) {
    if (attempt > 0) {
      try { await page.keyboard.press("Escape"); } catch {}
      await page.waitForTimeout(2000);
    }
    for (let hw = 0; hw < 20; hw++) {
      const bl = await page.evaluate(() => (document.body ? document.body.innerText.length : 0));
      if (bl > 5000) break;
      await page.waitForTimeout(1500);
    }
    let clicked = false;
    try { await page.click('button[aria-label="选择 ChatGPT 模型"], button[aria-label="Model selector"]', { label: "open model menu", timeout: 8000 }); clicked = true; } catch {}
    if (!clicked) {
      await page.evaluate(() => {
        const b = document.querySelector('button[aria-label="选择 ChatGPT 模型"], button[aria-label="Model selector"]');
        if (b) b.click();
      });
    }
    for (let poll = 0; poll < 8 && !menuInfo; poll++) {
      await page.waitForTimeout(800);
      menuInfo = await page.evaluate(() => {
        // 2026-11-19 field evidence (LEVEL_GATE_READBACK): hidden/stray radix
        // wrappers (e.g. the sidebar sort popover with 分项目显示/合并显示
        // radios) matched first and starved the real model menu — the gate
        // then read an empty slider set and aborted a genuinely-High session.
        // Match only VISIBLE wrappers and prefer the model menu's unique
        // signature (an effort slider); pass criteria stay unchanged.
        const isVisible = (el) => {
          const s = getComputedStyle(el);
          if (s.display === "none" || s.visibility === "hidden") return false;
          return el.getClientRects().length > 0;
        };
        const candidates = [];
        for (const m of document.querySelectorAll("[data-radix-popper-content-wrapper], [role='menu'], [role='dialog']")) {
          if (!isVisible(m)) continue;
          const radios = [...m.querySelectorAll("[role='menuitemradio']")].map((el) => ({ label: (el.textContent || "").trim().slice(0, 30), checked: el.getAttribute("aria-checked") }));
          if (!radios.length) continue;
          const sliders = [...m.querySelectorAll("[role='slider']")].map((el) => ({ now: el.getAttribute("aria-valuenow"), max: el.getAttribute("aria-valuemax") }));
          candidates.push({ radios, sliders, hasSlider: sliders.length > 0 });
        }
        const picked = candidates.find((c) => c.hasSlider) || candidates[0] || null;
        return picked ? { radios: picked.radios, sliders: picked.sliders } : null;
      });
    }
  }
} catch (error) {
  abort("LEVEL_GATE_MENU_UNAVAILABLE_STOP"); // dispatch surface unprovable here; do NOT send
}
await page.keyboard.press("Escape");
await page.waitForTimeout(600);
const modelOk = menuInfo && menuInfo.radios.some((r) => r.label === "GPT-6" && r.checked === "true");
const levelOk = menuInfo && menuInfo.sliders.some((s) => String(s.now) === "2" && String(s.max) === "2");
if (!menuInfo || !modelOk || !levelOk) {
  // Gate 7a diagnosability (2026-11-19): abort used to be blind — a UI drift
  // (radio label change, effort-slider scale recalibration) was indistinguishable
  // from a genuinely wrong level. Print the sanitized readback so the mismatch
  // is provable from the output stream alone. Read-only evidence; the fail-closed
  // pass criteria above are unchanged.
  console.log("LEVEL_GATE_READBACK=" + JSON.stringify({
    radios: menuInfo ? menuInfo.radios : null,
    sliders: menuInfo ? menuInfo.sliders : null,
    modelOk: Boolean(modelOk), levelOk: Boolean(levelOk),
  }));
  abort("LEVEL_GATE_FAIL_ABORT");
}

// ---- Gate 7.1: model_slug NEGATIVE diagnostic (r45 LIMITED GO — auxiliary evidence, NEVER a pass key).
// It records which model produced PAST assistant turns; it cannot prove the next send's model or
// effort level, so the live aria gate above stays primary. session+conversation = the 2-call
// per-wake API budget exactly.
const convEvidence = NEW_CHAT ? { ok: false } : await composerOp(() => page.evaluate(async ({ uuid, token }) => {
  try {
    const r = await fetch("/backend-api/conversation/" + uuid, { credentials: "include", headers: token ? { Authorization: "Bearer " + token } : {} });
    if (!r.ok) return { ok: false };
    const j = await r.json();
    let slug = null;
    for (const k of Object.keys((j && j.mapping) || {})) {
      const m = j.mapping[k] && j.mapping[k].message;
      if (m && m.author && m.author.role === "assistant" && m.metadata && m.metadata.model_slug) slug = m.metadata.model_slug;
    }
    return { ok: true, slug };
  } catch { return { ok: false }; }
}, { uuid: CONV, token: sessionEvidence ? sessionEvidence.token : null }));
// Historical model metadata is best-effort. A 429/404 or a missing past slug
// cannot override the verified live Chat + slider gate or block a new chat.
if (convEvidence.ok && convEvidence.slug) {
  await appendEvent(MON, "MODEL_HISTORY_AUX", { slug: String(convEvidence.slug).slice(0, 60) });
} else {
  await appendEvent(MON, "MODEL_HISTORY_AUX_UNAVAILABLE", {});
}

// ---- Gate 8: ref lifecycle (r44 P0-A2) — ONLY snapshot/ref/focus may retry. Once focus succeeds,
// the send path runs exactly once: button-missing = STOP (fail-closed), final content recheck on the
// CURRENT composer (r44 P0-B4), SEND_STARTED persisted, then a single Enter in its own try — an Enter
// error marks UNCERTAIN and never re-enters the loop (at-most-once).
let sent = false;
for (let focusAttempt = 1; focusAttempt <= 3 && !sent; focusAttempt++) {
  let ref = null;
  try {
    const snap = await page.snapshot({ scope: "full_page" });
    const tfLine = snap.split("\n").reverse().find((l) => /textfield "(询问 ChatGPT|Ask ChatGPT)"/.test(l));
    ref = tfLine && (tfLine.match(/\[ref=(\d+)/) || [])[1];
    if (!ref) continue;
    await page.focus("@" + ref);
  } catch (error) {
    if (focusAttempt === 3) abort("FOCUS_FAILED_AFTER_RETRIES");
    await page.waitForTimeout(1500); // stale ref → next iteration takes a fresh snapshot
    continue;
  }
  // ---- focus succeeded: the send path below runs at most once, never re-entered ----
  await ensureFocused();
  await page.waitForTimeout(800);
  const btn = await composerOp(() => page.evaluate(() => {
    const el = document.querySelector("button[aria-label='发送'], button[data-testid='send-button']");
    return el ? { disabled: el.disabled, ariaDisabled: el.getAttribute("aria-disabled") } : null;
  }));
  if (!btn) abort("SEND_BUTTON_MISSING_STOP"); // button not found: fail-closed, never skip the check
  if (btn.disabled || btn.ariaDisabled === "true") abort("SEND_DISABLED_ABORT");
  const finalText = await readRaw();
  if (!finalText || !readbackMatches(payload, finalText)) {
    abort(readbackMode(payload) === "strict" ? "SENSITIVE_FINAL_RECHECK_UNPROVEN" : "FINAL_RECHECK_NOT_VERIFIED_ABORT");
  }
  await markSendStarted(MON, dispatch.dispatchId);
  try { await page.keyboard.press("Enter"); }
  catch (error) {
    await markUncertain(MON, dispatch.dispatchId, "SEND_ENTER_ERROR").catch(() => {});
    abort("SEND_ENTER_ERROR_MARKED_UNCERTAIN"); // reconciliation decides next action; no auto-resend
  }
  sent = true;
}
if (!sent) abort("SEND_NOT_EXECUTED");
const sentAt = Date.now(); // Gate 9b persistence checks anchor on the actual send time

// ---- Gate 9b: send persistence verification (issue #38 vanish mode + issue #37
// false done-candidate). Gate 9's client evidence (empty composer + generating
// spinner) cannot distinguish a stored send from a vanished one: both vanish
// dispatches passed every gate yet the optimistic user turn later ROLLED BACK to
// the baseline assistant tail, and a fresh CALIBRATE goto proved the server never
// stored the message. Only a tail key ADVANCED past the dispatch baseline proves
// persistence. Two bounded re-reads (~20s and ~80s after the send) decide:
//   VERIFIED   — a check reads lastMessageKey != baselineTailKey (the dispatched
//                user turn or an even-newer assistant reply) → markAccepted.
//   UNVERIFIED — both checks still read the baseline assistant tail, or a
//                surface read failed even after one retry → fail-closed to
//                UNCERTAIN, never a silent ACCEPT.
const PERSISTENCE_CHECK_DELAYS_MS = [20000, 80000];
const verifySendPersistence = async (fromAt) => {
  let vanished = false;
  for (const delayMs of PERSISTENCE_CHECK_DELAYS_MS) {
    const wait = fromAt + delayMs - Date.now();
    if (wait > 0) await page.waitForTimeout(wait);
    let sample = null;
    let lastReadError = null;
    // Fail-safe read: one bounded retry, then the whole verdict is UNVERIFIED —
    // a read failure must never be mistaken for persistence evidence.
    for (let attempt = 0; attempt < 2 && !sample; attempt++) {
      try { sample = await readComposerSurface(page); }
      catch (error) {
        lastReadError = error;
        if (attempt === 0) await page.waitForTimeout(3000);
      }
    }
    if (!sample) {
      await markComposerFreeze(MON, { space: SPACE, error: lastReadError }).catch(() => {});
      await appendEvent(MON, "SEND_PERSISTENCE_UNVERIFIED", {
        dispatchId: dispatch.dispatchId, baselineTailKey: dispatch.baselineTailKey,
        reason: "SURFACE_READ_FAILED", checkDelayMs: delayMs,
      }).catch(() => {});
      return { verdict: "UNVERIFIED", reason: "SURFACE_READ_FAILED" };
    }
    if (sample.lastMessageKey && sample.lastMessageKey !== dispatch.baselineTailKey) {
      await appendEvent(MON, "SEND_PERSISTENCE_VERIFIED", {
        dispatchId: dispatch.dispatchId, baselineTailKey: dispatch.baselineTailKey,
        lastMessageKey: sample.lastMessageKey, lastMessageRole: sample.lastMessageRole,
        checkDelayMs: delayMs,
      });
      return { verdict: "VERIFIED" };
    }
    vanished = sample.lastMessageKey === dispatch.baselineTailKey && sample.lastMessageRole === "assistant";
  }
  await appendEvent(MON, "SEND_PERSISTENCE_UNVERIFIED", {
    dispatchId: dispatch.dispatchId, baselineTailKey: dispatch.baselineTailKey,
    reason: vanished ? "BASELINE_TAIL_UNCHANGED" : "TAIL_IDENTITY_UNPROVEN", vanished,
  });
  return { verdict: "UNVERIFIED", reason: vanished ? "BASELINE_TAIL_UNCHANGED" : "TAIL_IDENTITY_UNPROVEN" };
};

// ---- Gate 9: acceptance evidence (at-most-once preserved; UNCERTAIN never auto-resends) ----
let accepted = null, acceptErr = null;
let persistenceUnverified = false;
for (let i = 0; i < 24 && !accepted; i++) {
  await page.waitForTimeout(1500);
  try {
    const s = await composerOp(() => readComposerSurface(page));
    const tailAlreadyAdvanced = s.lastMessageRole === "assistant" && s.lastMessageKey &&
      s.lastMessageKey !== dispatch.baselineTailKey;
    if (s.composerEmpty && (s.generating || tailAlreadyAdvanced)) {
      // Gate 9b: persistence is proven BEFORE markAccepted. A real assistant
      // reply already past the baseline IS persistence evidence by itself;
      // otherwise the two bounded re-reads decide.
      if (tailAlreadyAdvanced) {
        await appendEvent(MON, "SEND_PERSISTENCE_VERIFIED", {
          dispatchId: dispatch.dispatchId, baselineTailKey: dispatch.baselineTailKey,
          lastMessageKey: s.lastMessageKey, lastMessageRole: s.lastMessageRole,
          evidence: "GATE9_TAIL_ADVANCED",
        });
      } else {
        const verdict = await verifySendPersistence(sentAt);
        if (verdict.verdict !== "VERIFIED") {
          persistenceUnverified = true;
          break; // vanish suspected or unprovable: NEVER markAccepted
        }
      }
      try { accepted = await markAccepted(MON, dispatch.dispatchId, page); }
      catch (error) { acceptErr = String(error).slice(0, 120); }
    }
  } catch {}
}
if (!accepted) {
  if (persistenceUnverified) await markUncertain(MON, dispatch.dispatchId, "SEND_PERSISTENCE_UNVERIFIED").catch(() => {});
  else await markUncertain(MON, dispatch.dispatchId, "SEND_ACK_MISSING").catch(() => {});
}
if (accepted && NEW_CHAT) {
  let actualUuid = null;
  for (let i = 0; i < 12 && !actualUuid; i++) {
    actualUuid = conversationIdFromUrl(await page.url(), true);
    if (!actualUuid) await page.waitForTimeout(1500);
  }
  if (!actualUuid || actualUuid === CONV) abort("NEW_CHAT_UUID_NOT_OBSERVED");
  try { await claimAgentSpace({ agentId: AGENT_ID, spaceName: SPACE, conversationUuid: actualUuid }); }
  catch (error) { abort(error.code || "NEW_CHAT_REGISTRY_BIND_FAILED"); }
  await writeJsonAtomic(MON + "/a-new-conversation.json",
    { requestId: CONV, conversationUuid: actualUuid, pageLabel: page.label });
}
console.log({ dispatchId: dispatch.dispatchId, accepted: accepted?.status || null, acceptErr });
console.log(accepted ? "RESULT=AUTO_ACCEPTED_DISPATCH_ACCEPTED" : "RESULT=NOT_AUTO_ACCEPTED_MARKED_UNCERTAIN");
