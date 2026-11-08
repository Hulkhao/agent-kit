// Standard ChatGPT dispatch round — R2.5 frozen transaction chain (planner ruling reply-r43.txt).
//
// PREPARED → 填充 → 完整回读 → 刷新 Composer ref → 所有权确认 → SEND_STARTED → Enter → AUTO_ACCEPTED
// 任何一步无法证明，都不得进入下一步。
//
// Deployment adapters (edit only these four constants):
const MON = "REPLACE_WITH_DEPLOY_MONITOR_DIR"; // monitor dir with dispatch-state.mjs + state-schema.mjs
const SPACE = "REPLACE_WITH_UNIQUE_TASKSPACE"; // unique per agent/monitor instance
const MSG_FILE = "REPLACE_WITH_MESSAGE_FILE_PATH"; // UTF-8 file holding the payload text
const CONV = "REPLACE_WITH_CONVERSATION_UUID"; // page located by URL containing CONV, never by label

if ([MON, SPACE, CONV].some((v) => v.startsWith("REPLACE_")) || MSG_FILE.startsWith("REPLACE_")) {
  console.log("RESULT=ADAPTATION_REQUIRED");
  process.exit(1);
}

import * as fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { homedir } from "node:os";

const {
  appendEvent, prepareDispatch, markSendStarted, markAccepted, markUncertain,
  readComposerSurface, readDispatchState,
  chunkPayload, readbackMatches, readbackMode, verifyDraftOwnership,
  getFillCount, recordFillAttempt, resetFillCount,
  markComposerFreeze, findUnconsumedComposerFreeze,
} = await import(pathToFileURL(MON + "/dispatch-state.mjs").href);

const payload = await fs.readFile(MSG_FILE, "utf-8");
const payloadHash = createHash("sha256").update(payload, "utf8").digest("hex");

const task = await taskSpace(SPACE);
let page = null;
for (const p of (await task.pages())) {
  try { if ((await p.url()).includes(CONV)) { page = p; break; } } catch {}
}
if (!page) { console.log("RESULT=CONVERSATION_PAGE_MISSING"); process.exit(1); }

const abort = (code) => { console.log("RESULT=" + code); process.exit(1); };
// Targeted composer selection: the first contenteditable on the page may be a rendered
// code block's "Edit code" editor (EN-UI field test, agent-kit#7) — aria-label wins, generic fallbacks last.
const COMPOSER_SEL = '[contenteditable="true"][role="textbox"][aria-label="询问 ChatGPT"], [contenteditable="true"][role="textbox"][aria-label="Ask ChatGPT"], #prompt-textarea, [data-testid="prompt-textarea"], [contenteditable="true"][role="textbox"]';

const readRaw = () => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  return el ? (el.innerText || "") : "";
}, COMPOSER_SEL);

// ---- Gate 0: unprocessed composer freeze (R2.5-H) — the probe owns the storm backoff ----
const pendingFreeze = await findUnconsumedComposerFreeze(MON).catch(() => null);
if (pendingFreeze) abort("FROZEN_BACKOFF_PENDING");

// ---- Gate 1: ledger state + surface gates ----
const surface0 = await readComposerSurface(page);
if (!surface0.hostOk || !surface0.composerPresent) abort("COMPOSER_SURFACE_UNAVAILABLE");
if (surface0.generating) abort("PREVIOUS_GENERATION_STILL_ACTIVE");

const existing = await readDispatchState(MON).catch(() => null);

// ---- Gate 1.5: account pin (PO 令 2026-11-08, issue #7 root cause) — profileId only applies at
// space CREATION, so a resumed space keeps whatever account it was born with. Verify the account
// actually logged in on this page against the machine-local pin BEFORE anything is filled or sent.
let profileCfg = null;
try { profileCfg = JSON.parse(await fs.readFile(homedir() + "/.agents/ego-profile.json", "utf-8")); }
catch { abort("ACCOUNT_CONFIG_MISSING_STOP"); } // no pin on this machine: stop, never guess the account
const expectedAccount = (profileCfg.spaceExpect && profileCfg.spaceExpect[SPACE]) || profileCfg.defaultAccount;
if (!expectedAccount || !profileCfg.defaultProfileId) abort("ACCOUNT_CONFIG_INCOMPLETE_STOP");
let session = null;
try { session = await page.fetch("/api/auth/session"); } catch {} // 1 call, inside the ≤2-per-wake budget
const accountEmail = session?.user?.email || null;
if (!accountEmail) abort("ACCOUNT_UNPROVEN_STOP");
if (accountEmail !== expectedAccount) abort("ACCOUNT_MISMATCH_STOP:" + SPACE);

// Resume only a PREPARED record of THIS exact payload (interrupted fill of the same message).
const resume = existing?.status === "PREPARED" && existing.payload_sha256 === payloadHash;
if (existing && ["SEND_STARTED", "ACCEPTED", "UNCERTAIN", "RETRY_AUTHORIZED"].includes(existing.status)) {
  abort("DISPATCH_IN_FLIGHT_" + existing.status); // already sent: acceptance reconciliation only
}
if (existing?.status === "PREPARED" && !resume) {
  abort("STALE_PREPARED_RECORD_STOP"); // interrupted dispatch of a DIFFERENT payload: supervisor
}

// ---- Gate 2: draft ownership (R2.5-O) — full text / in-order prefix of THIS dispatch only ----
if (!surface0.composerEmpty) {
  const draft = await readRaw();
  const ownership = verifyDraftOwnership({ draft, payload, record: existing });
  if (!ownership.owned) abort(ownership.kind === "empty" ? "DRAFT_STATE_CONFLICT_STOP" : "FOREIGN_DRAFT_STOP:" + (ownership.reason || ownership.kind));
  if (ownership.kind === "historical-identity" && !resume) abort("HISTORICAL_DRAFT_STOP");
  if (ownership.kind !== "empty") {
    // ownership proven for THIS dispatch: clear → re-read → prove empty → refill
    const cleared = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel2 = window.getSelection();
      sel2.removeAllRanges();
      sel2.addRange(range);
      sel2.deleteFromDocument();
      return true;
    }, COMPOSER_SEL);
    if (!cleared) abort("DRAFT_CLEAR_FAILED");
    await page.waitForTimeout(600);
    const after = await readComposerSurface(page);
    if (!after.composerEmpty) abort("DRAFT_CLEAR_UNVERIFIED");
  }
}

// ---- Gate 3: FRESHEN (R2.5-H) — 3 completed fill attempts since the last successful navigation;
// refresh happens BEFORE this round's fill, never after (a goto would destroy the fresh draft) ----
if (await getFillCount(MON, SPACE) >= 3) {
  await appendEvent(MON, "GOTO_ATTEMPT", { goto_reason: "FRESHEN", at: Date.now(), agent_id: SPACE, space: SPACE });
  await page.goto("https://chatgpt.com/c/" + CONV, { timeout: 45000 });
  await page.waitForLoadState("load", { timeout: 30000 });
  await resetFillCount(MON, SPACE);
  await page.waitForTimeout(2000);
}

// ---- Gate 4: fill (R2.5-F chunk rule); one whole round = one fill attempt ----
await recordFillAttempt(MON, SPACE);
const chunks = chunkPayload(payload, 1200);
for (const chunk of chunks) {
  let ok = false;
  for (let attempt = 0; attempt < 2 && !ok; attempt++) {
    let r = null;
    try {
      r = await page.evaluate(({ sel, text }) => {
        const el = document.querySelector(sel);
        if (!el) return { ok: false };
        el.focus();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const selObj = window.getSelection();
        selObj.removeAllRanges();
        selObj.addRange(range);
        return { ok: !!document.execCommand("insertText", false, text) };
      }, { sel: COMPOSER_SEL, text: chunk });
    } catch (error) {
      await markComposerFreeze(MON, { space: SPACE, error }); // PageEvaluationTimeout family → storm channel
      abort("COMPOSER_RENDER_FREEZE");
    }
    ok = r?.ok === true;
    if (!ok && attempt === 0) await page.waitForTimeout(2500);
  }
  if (!ok) abort("CHUNK_INSERT_FAILED");
  await page.waitForTimeout(450);
}

// ---- Gate 5: full readback, two-level per payload class (R2.5-F) ----
let composerText = "";
for (let a = 0; a < 8 && !composerText; a++) {
  try { composerText = await readRaw(); } catch (error) {
    await markComposerFreeze(MON, { space: SPACE, error });
    abort("COMPOSER_RENDER_FREEZE");
  }
  if (!composerText) await page.waitForTimeout(3000);
}
// strict mode (URL/code/commands): raw compare only — rendered innerText cannot prove fidelity,
// so a mismatch means STOP; normalized mode (plain text): collapse DOM block artifacts first.
if (!readbackMatches(payload, composerText)) {
  abort(readbackMode(payload) === "strict" ? "SENSITIVE_FIDELITY_UNPROVEN" : "READBACK_NOT_VERIFIED_ABORT");
}

// ---- Gate 6: PREPARED before send, with fingerprint-only ledger (R2.5-O) ----
const dispatch = resume ? existing :
  await prepareDispatch({ monitorDir: MON, conversationUuid: CONV, taskSpace: SPACE, pageLabel: page.label, page, payload });

// ---- Gate 7: thinking-level precheck — READ is locale-independent (aria attrs); ENTRY is bilingual.
// The EN-UI variant may have NO model menu at all (agent-kit#7): a click failure or missing menu is
// a fail-closed STOP, never a silent skip — a skipped gate is how a session ran unnoticed on mini.
let menuInfo = null;
try {
  await page.click('button[aria-label="选择 ChatGPT 模型"], button[aria-label="Model selector"]', { label: "open model menu" });
  await page.waitForTimeout(1500);
  menuInfo = await page.evaluate(() => {
    const m = document.querySelector("[role='menu']");
    if (!m) return null;
    return {
      radios: [...m.querySelectorAll("[role='menuitemradio']")].map((el) => ({ label: (el.textContent || "").trim().slice(0, 30), checked: el.getAttribute("aria-checked") })),
      sliders: [...m.querySelectorAll("[role='slider']")].map((el) => ({ now: el.getAttribute("aria-valuenow"), max: el.getAttribute("aria-valuemax") })),
    };
  });
} catch (error) {
  abort("LEVEL_GATE_MENU_UNAVAILABLE_STOP"); // dispatch surface unprovable here; do NOT send
}
await page.keyboard.press("Escape");
await page.waitForTimeout(600);
const modelOk = menuInfo && menuInfo.radios.some((r) => r.label === "GPT-6" && r.checked === "true");
const levelOk = menuInfo && menuInfo.sliders.some((s) => String(s.now) === "2" && String(s.max) === "2");
if (!menuInfo || !modelOk || !levelOk) abort("LEVEL_GATE_FAIL_ABORT");

// ---- Gate 8: fresh ref lifecycle (R2.5-S) — every attempt re-snapshots; ≤3 focus tries;
// send-button disabled check; SEND_STARTED persisted BEFORE Enter; old refs never reused ----
let sent = false;
for (let focusAttempt = 1; focusAttempt <= 3 && !sent; focusAttempt++) {
  const snap = await page.snapshot({ scope: "full_page" });
  const tfLine = snap.split("\n").reverse().find((l) => /textfield "(询问 ChatGPT|Ask ChatGPT)"/.test(l));
  const ref = tfLine && (tfLine.match(/\[ref=(\d+)/) || [])[1];
  if (!ref) continue;
  try {
    await page.focus("@" + ref);
    await page.waitForTimeout(800);
    const btn = await page.evaluate(() => {
      const el = document.querySelector("button[aria-label='发送'], button[data-testid='send-button']");
      return el ? { disabled: el.disabled, ariaDisabled: el.getAttribute("aria-disabled") } : null;
    });
    if (btn && (btn.disabled || btn.ariaDisabled === "true")) abort("SEND_DISABLED_ABORT");
    await markSendStarted(MON, dispatch.dispatchId);
    await page.keyboard.press("Enter");
    sent = true;
  } catch (error) {
    if (focusAttempt === 3) abort("FOCUS_FAILED_AFTER_RETRIES");
    await page.waitForTimeout(1500); // stale ref → next iteration takes a fresh snapshot
  }
}
if (!sent) abort("SEND_NOT_EXECUTED");

// ---- Gate 9: acceptance evidence (at-most-once preserved; UNCERTAIN never auto-resends) ----
let accepted = null, acceptErr = null;
for (let i = 0; i < 24 && !accepted; i++) {
  await page.waitForTimeout(1500);
  try {
    const s = await readComposerSurface(page);
    if (s.composerEmpty && (s.generating || (s.lastMessageRole === "assistant" && s.lastMessageKey && s.lastMessageKey !== dispatch.baselineTailKey))) {
      try { accepted = await markAccepted(MON, dispatch.dispatchId, page); }
      catch (error) { acceptErr = String(error).slice(0, 120); }
    }
  } catch {}
}
if (!accepted) await markUncertain(MON, dispatch.dispatchId, "SEND_ACK_MISSING").catch(() => {});
console.log({ dispatchId: dispatch.dispatchId, accepted: accepted?.status || null, acceptErr });
console.log(accepted ? "RESULT=AUTO_ACCEPTED_DISPATCH_ACCEPTED" : "RESULT=NOT_AUTO_ACCEPTED_MARKED_UNCERTAIN");
