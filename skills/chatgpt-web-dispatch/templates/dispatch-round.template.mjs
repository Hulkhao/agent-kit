// Standard ChatGPT dispatch round — R2.5 frozen transaction chain (planner rulings reply-r43 + reply-r44).
//
// PREPARED → 填充 → 完整回读 → 刷新 Composer ref → 所有权复核 → SEND_STARTED → Enter → AUTO_ACCEPTED
// 任何一步无法证明，都不得进入下一步。
//
// Deployment adapters (edit only these four constants):
const MON = "REPLACE_WITH_DEPLOY_MONITOR_DIR"; // monitor dir with dispatch-state.mjs + state-schema.mjs
const SPACE = "REPLACE_WITH_UNIQUE_TASKSPACE"; // unique per agent/monitor instance; account pinned via ~/.agents/ego-profile.json (Gate 1.5)
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

// Targeted composer selection: the first contenteditable may be a rendered code block's "Edit code"
// editor (EN-UI field test, agent-kit#7) — aria-label wins, generic fallbacks last.
const COMPOSER_SEL = '[contenteditable="true"][role="textbox"][aria-label="询问 ChatGPT"], [contenteditable="true"][role="textbox"][aria-label="Ask ChatGPT"], #prompt-textarea, [contenteditable="true"][role="textbox"], [data-testid="prompt-textarea"]';

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

const readRaw = () => composerOp(() => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  return el ? (el.innerText || "") : "";
}, COMPOSER_SEL));

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
if (surface0.generating) abort("PREVIOUS_GENERATION_STILL_ACTIVE");

let existing = null;
try { existing = await readDispatchState(MON); }
catch (error) { abort("DISPATCH_LEDGER_READ_FAILED"); }

// Resume only a PREPARED record of THIS exact payload (interrupted dispatch of the same message).
const resume = existing?.status === "PREPARED" && existing.payload_sha256 === payloadHash;
if (existing && ["SEND_STARTED", "ACCEPTED", "UNCERTAIN", "RETRY_AUTHORIZED"].includes(existing.status)) {
  abort("DISPATCH_IN_FLIGHT_" + existing.status); // already sent: acceptance reconciliation only
}
if (existing?.status === "PREPARED" && !resume) {
  abort("STALE_PREPARED_RECORD_STOP"); // interrupted dispatch of a DIFFERENT payload: supervisor
}

// ---- Gate 1.5: account pin (PO 令 2026-11-08, issue #7 root cause) — profileId only applies at
// space CREATION, so a resumed space keeps whatever account it was born with. Verify the account
// actually logged in on this page against the machine-local pin BEFORE anything is filled or sent.
let profileCfg = null;
try { profileCfg = JSON.parse(await fs.readFile(homedir() + "/.agents/ego-profile.json", "utf-8")); }
catch { abort("ACCOUNT_CONFIG_MISSING_STOP"); } // no pin on this machine: stop, never guess the account
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
  const surface = await composerOp(() => readComposerSurface(page));
  if (surface.composerEmpty) return;
  const draft = await readRaw();
  const ownership = verifyDraftOwnership({ draft, payload, record: existing });
  if (!ownership.owned) abort(ownership.kind === "empty" ? "DRAFT_STATE_CONFLICT_STOP" : "FOREIGN_DRAFT_STOP:" + (ownership.reason || ownership.kind));
  if (ownership.kind === "historical-identity" && !resume) abort("HISTORICAL_DRAFT_STOP");
  const cleared = await composerOp(() => evaluateClearComposer(COMPOSER_SEL));
  if (!cleared) abort("DRAFT_CLEAR_FAILED");
  await page.waitForTimeout(600);
  const after = await composerOp(() => readComposerSurface(page));
  if (!after.composerEmpty) abort("DRAFT_CLEAR_UNVERIFIED");
};

// ---- Gate 3: FRESHEN — 3 completed fill attempts since the last successful navigation.
// Navigation funnels through the ONE navigate() entry (single gotoAt timestamp + GOTO_ATTEMPT event);
// the template must not open a second navigation channel (r44 P0-B1). After any goto the full
// draft-resurrection check re-runs (r44 P0-B2).
const evaluateClearComposer = (sel) => page.evaluate((selArg) => {
  const el = document.querySelector(selArg);
  if (!el) return false;
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel2 = window.getSelection();
  sel2.removeAllRanges();
  sel2.addRange(range);
  sel2.deleteFromDocument();
  return true;
}, sel);

const navigate = async (reason) => {
  const gotoAt = Date.now(); // single timestamp per navigation (R2.4 unified entry contract)
  await appendEvent(MON, "GOTO_ATTEMPT", { goto_reason: reason, at: gotoAt, agent_id: SPACE, space: SPACE, lastGotoAt: gotoAt });
  await page.goto("https://chatgpt.com/c/" + CONV, { timeout: 45000 });
  await page.waitForLoadState("load", { timeout: 30000 });
  let ready = false;
  for (let i = 0; i < 20 && !ready; i++) {
    const len = await composerOp(() => page.evaluate(() => document.body.innerText.length));
    if (len > 600) { ready = true; break; }
    await page.waitForTimeout(2000);
  }
  if (!ready) abort("PAGE_NOT_READY_AFTER_NAVIGATE");
  await page.waitForTimeout(1000);
};

await ensureOwnEmptyComposer(); // Gate 2 (initial)

if (await getFillCount(MON, SPACE) >= 3) { // Gate 3 (FRESHEN)
  await navigate("FRESHEN");
  await resetFillCount(MON, SPACE);
  await ensureOwnEmptyComposer(); // resurrection check, never skipped
}

// ---- Gate 4: PREPARED persisted BEFORE the first insertText (r44 P0-B3 — frozen chain order:
// PREPARED → 填充 → 回读 → …). An interrupted fill then resumes from the persisted dispatch identity,
// not from runtime file contents.
const dispatch = resume ? existing :
  await prepareDispatch({ monitorDir: MON, conversationUuid: CONV, taskSpace: SPACE, pageLabel: page.label, page, payload });

// ---- Gate 5: fill (R2.5-F chunk rule); one whole round = one fill attempt ----
await recordFillAttempt(MON, SPACE);
const chunks = chunkPayload(payload, 1200);
for (const chunk of chunks) {
  let ok = false;
  for (let attempt = 0; attempt < 2 && !ok; attempt++) {
    const r = await composerOp(() => page.evaluate(({ sel, text }) => {
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
    }, { sel: COMPOSER_SEL, text: chunk }));
    ok = r?.ok === true;
    if (!ok && attempt === 0) await page.waitForTimeout(2500);
  }
  if (!ok) abort("CHUNK_INSERT_FAILED");
  await page.waitForTimeout(450);
}

// ---- Gate 6: full readback, two-level per payload class (R2.5-F) ----
let composerText = "";
for (let a = 0; a < 8 && !composerText; a++) {
  composerText = await readRaw();
  if (!composerText) await page.waitForTimeout(3000);
}
// strict mode (URL/code/commands): raw compare only — rendered innerText cannot prove fidelity,
// so a mismatch means STOP; normalized mode (plain text): collapse DOM block artifacts first.
if (!readbackMatches(payload, composerText)) {
  abort(readbackMode(payload) === "strict" ? "SENSITIVE_FIDELITY_UNPROVEN" : "READBACK_NOT_VERIFIED_ABORT");
}

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

// ---- Gate 7.1: model_slug NEGATIVE diagnostic (r45 LIMITED GO — auxiliary evidence, NEVER a pass key).
// It records which model produced PAST assistant turns; it cannot prove the next send's model or
// effort level, so the live aria gate above stays primary. session+conversation = the 2-call
// per-wake API budget exactly.
const convEvidence = await composerOp(() => page.evaluate(async ({ uuid, token }) => {
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
if (!convEvidence.ok || !convEvidence.slug) abort("MODEL_EVIDENCE_UNAVAILABLE_STOP");
if (/mini/i.test(convEvidence.slug)) abort("MODEL_HISTORY_MISMATCH"); // negative-only: historical mini = stop, supervisor decides
await appendEvent(MON, "MODEL_HISTORY_AUX", { slug: String(convEvidence.slug).slice(0, 60) }); // compliant slug = auxiliary record only

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

// ---- Gate 9: acceptance evidence (at-most-once preserved; UNCERTAIN never auto-resends) ----
let accepted = null, acceptErr = null;
for (let i = 0; i < 24 && !accepted; i++) {
  await page.waitForTimeout(1500);
  try {
    const s = await composerOp(() => readComposerSurface(page));
    if (s.composerEmpty && (s.generating || (s.lastMessageRole === "assistant" && s.lastMessageKey && s.lastMessageKey !== dispatch.baselineTailKey))) {
      try { accepted = await markAccepted(MON, dispatch.dispatchId, page); }
      catch (error) { acceptErr = String(error).slice(0, 120); }
    }
  } catch {}
}
if (!accepted) await markUncertain(MON, dispatch.dispatchId, "SEND_ACK_MISSING").catch(() => {});
console.log({ dispatchId: dispatch.dispatchId, accepted: accepted?.status || null, acceptErr });
console.log(accepted ? "RESULT=AUTO_ACCEPTED_DISPATCH_ACCEPTED" : "RESULT=NOT_AUTO_ACCEPTED_MARKED_UNCERTAIN");
