// Structural contract tests for the R2.5 frozen dispatch transaction chain (r43 + r44 rework).
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const template = () => readFile(new URL("../skills/chatgpt-web-dispatch/templates/dispatch-round.template.mjs", import.meta.url), "utf8");

test("template freezes the transaction chain: PREPARED before fill, ownership before send (r43 + r44 P0-B3)", async () => {
  const src = await template();
  const order = [
    "FROZEN_BACKOFF_PENDING",
    "STALE_PREPARED_RECORD_STOP",
    "ensureOwnEmptyComposer(); // Gate 2 (initial)",
    'await navigate("FRESHEN")',
    "prepareDispatch({ monitorDir: MON",
    "recordFillAttempt(MON, SPACE)",
    "if (!readbackMatches(payload, composerText))",
    "markSendStarted(MON",
    "markAccepted(MON",
    'markUncertain(MON, dispatch.dispatchId, "SEND_ACK_MISSING")',
  ];
  let pos = -1;
  for (const marker of order) {
    const at = src.indexOf(marker);
    assert.ok(at >= 0, `missing lifecycle marker: ${marker}`);
    assert.ok(at > pos, `lifecycle order violated at: ${marker}`);
    pos = at;
  }
});

test("r44 P0-A1: ledger reads are fail-closed — read failure must STOP, never masquerade as empty", async () => {
  const src = await template();
  assert.match(src, /try \{ pendingFreeze = await findUnconsumedComposerFreeze\(MON\); \}\s*catch \(error\) \{ abort\("FREEZE_LEDGER_READ_FAILED"\); \}/);
  assert.match(src, /try \{ existing = await readDispatchState\(MON\); \}\s*catch \(error\) \{ abort\("DISPATCH_LEDGER_READ_FAILED"\); \}/);
  // no fail-open catches on the two ledgers
  assert.doesNotMatch(src, /findUnconsumedComposerFreeze\(MON\)\.catch/);
  assert.doesNotMatch(src, /readDispatchState\(MON\)\.catch/);
});

test("r44 P0-A2: Enter is outside the focus-retry scope — after SEND_STARTED the loop is never re-entered", async () => {
  const src = await template();
  const loopStart = src.indexOf("for (let focusAttempt = 1");
  const loopBody = src.slice(loopStart, src.indexOf("if (!sent) abort"));
  const tryStart = loopBody.indexOf("try { await page.keyboard.press(\"Enter\")");
  assert.ok(tryStart > 0, "Enter must live in its own try block");
  const enterTry = loopBody.slice(tryStart, loopBody.indexOf("sent = true"));
  assert.match(enterTry, /markUncertain\(MON, dispatch\.dispatchId, "SEND_ENTER_ERROR"\)/);
  assert.match(enterTry, /abort\("SEND_ENTER_ERROR_MARKED_UNCERTAIN"\)/);
  // focus-failure catch sits strictly before the send path and cannot swallow Enter
  const focusCatch = loopBody.indexOf("if (focusAttempt === 3) abort(\"FOCUS_FAILED_AFTER_RETRIES\")");
  assert.ok(focusCatch > 0 && focusCatch < tryStart, "focus retry catch must precede the Enter try block");
});

test("r44 P0-A2: missing send button is fail-closed; final content recheck precedes SEND_STARTED", async () => {
  const src = await template();
  assert.match(src, /abort\("SEND_BUTTON_MISSING_STOP"\)/);
  const btnAt = src.indexOf("SEND_BUTTON_MISSING_STOP");
  const recheckAt = src.indexOf("SENSITIVE_FINAL_RECHECK_UNPROVEN");
  const sendAt = src.indexOf("markSendStarted(MON");
  assert.ok(btnAt > 0 && recheckAt > btnAt && sendAt > recheckAt, "button check → final recheck → SEND_STARTED order violated");
  assert.match(src, /FINAL_RECHECK_NOT_VERIFIED_ABORT/);
});

test("chunk rule: line-boundary chunks, byte limit, freeze channel wired via composerOp", async () => {
  const src = await template();
  assert.match(src, /chunkPayload\(payload, 1200\)/);
  assert.match(src, /composerOp/);
  assert.match(src, /markComposerFreeze\(MON, \{ space: SPACE, error \}\)/);
});

test("two-level readback: strict for sensitive payloads, normalized only for plain text", async () => {
  const src = await template();
  assert.match(src, /readbackMode\(payload\) === "strict" \? "SENSITIVE_FIDELITY_UNPROVEN" : "READBACK_NOT_VERIFIED_ABORT"/);
  assert.match(src, /readbackMatches\(payload, composerText\)/);
});

test("r44 P0-B1: exactly ONE navigation channel — page.goto appears only inside navigate(reason)", async () => {
  const src = await template();
  const gotos = [...src.matchAll(/await page\.goto\(/g)].map((m) => m.index);
  assert.equal(gotos.length, 1, "page.goto must appear exactly once (inside navigate)");
  const navDef = src.indexOf("const navigate = async (reason)");
  assert.ok(gotos[0] > navDef, "the single goto must live inside navigate()");
  assert.match(src, /GOTO_ATTEMPT/);
  assert.match(src, /const gotoAt = Date\.now\(\); \/\/ single timestamp per navigation/);
});

test("r44 P0-B2: ownership+clear+verify is a reusable procedure re-run after FRESHEN", async () => {
  const src = await template();
  assert.match(src, /const ensureOwnEmptyComposer = async \(\)/);
  const defAt = src.indexOf("const ensureOwnEmptyComposer = async () => {");
  const freshenAt = src.indexOf('await navigate("FRESHEN")');
  const recallAt = src.indexOf("await ensureOwnEmptyComposer(); // resurrection check");
  assert.ok(defAt > 0 && freshenAt > defAt && recallAt > freshenAt, "resurrection check must re-run after the FRESHEN goto");
  assert.match(src, /abort\("DRAFT_CLEAR_UNVERIFIED"\)/);
});

test("ref lifecycle: fresh snapshot per attempt, at most 3 focus tries, SEND_STARTED before Enter", async () => {
  const src = await template();
  assert.match(src, /for \(let focusAttempt = 1; focusAttempt <= 3 && !sent; focusAttempt\+\+\)/);
  const loopStart = src.indexOf("for (let focusAttempt = 1");
  const loopBody = src.slice(loopStart, src.indexOf("if (!sent) abort"));
  assert.ok(loopBody.indexOf("page.snapshot") < loopBody.indexOf("page.focus"), "snapshot must precede focus inside the retry loop");
  assert.ok(loopBody.indexOf("markSendStarted") < loopBody.indexOf("keyboard.press(\"Enter\")"), "SEND_STARTED must precede Enter");
});

test("ownership: never clears a draft that is not provably ours; empty is its own branch", async () => {
  const src = await template();
  assert.match(src, /verifyDraftOwnership\(\{ draft, payload, record: existing \}\)/);
  assert.match(src, /FOREIGN_DRAFT_STOP:" \+ \(ownership\.reason \|\| ownership\.kind\)/);
  assert.match(src, /abort\("DRAFT_CLEAR_UNVERIFIED"\)/);
  assert.match(src, /abort\("DISPATCH_IN_FLIGHT_" \+ existing\.status\)/);
  assert.match(src, /abort\("STALE_PREPARED_RECORD_STOP"\)/);
});

test("ledger stores fingerprint only: payload never embedded in the template's ledger calls", async () => {
  const src = await template();
  assert.match(src, /prepareDispatch\(\{ monitorDir: MON, conversationUuid: CONV, taskSpace: SPACE, pageLabel: page\.label, page, payload \}\)/);
  assert.doesNotMatch(src, /payload: payload\.slice|payload\.substring/);
});

test("FRESHEN: fires before the fill, resets the counter", async () => {
  const src = await template();
  assert.match(src, /if \(await getFillCount\(MON, SPACE\) >= 3\) \{/);
  const freshenAt = src.indexOf('await navigate("FRESHEN")');
  const fillAt = src.indexOf("recordFillAttempt(MON, SPACE)");
  assert.ok(freshenAt > 0 && freshenAt < fillAt, "FRESHEN must precede the fill");
  assert.match(src, /resetFillCount\(MON, SPACE\)/);
});

test("agent-kit#7: level-gate entry is fail-closed (no silent skip) and bilingual; composer is targeted not first-contenteditable", async () => {
  const src = await template();
  assert.match(src, /aria-label="选择 ChatGPT 模型"\], button\[aria-label="Model selector"\]/);
  assert.match(src, /abort\("LEVEL_GATE_MENU_UNAVAILABLE_STOP"\)/);
  const gate7 = src.slice(src.indexOf("Gate 7"), src.indexOf("Gate 8"));
  assert.match(gate7, /!menuInfo \|\| !modelOk \|\| !levelOk/, "missing menu must abort, not pass");
  const sel = src.match(/const COMPOSER_SEL = ([^;]+);/)[1];
  assert.ok(sel.indexOf('aria-label="询问 ChatGPT"') < sel.indexOf('#prompt-textarea'), "targeted composer selector must precede generic fallback");
  assert.match(src, /textfield "\(询问 ChatGPT\|Ask ChatGPT\)"/);
});

test("agent-kit#7 root cause: account pin gate precedes ownership; missing/incomplete config stops, never guesses", async () => {
  const src = await template();
  const order = [
    'abort("ACCOUNT_CONFIG_MISSING_STOP")',
    'abort("ACCOUNT_CONFIG_INCOMPLETE_STOP")',
    'abort("ACCOUNT_UNPROVEN_STOP")',
    'abort("ACCOUNT_MISMATCH_STOP:" + SPACE)',
    "verifyDraftOwnership({ draft, payload, record: existing })",
  ];
  let pos = -1;
  for (const marker of order) {
    const at = src.indexOf(marker);
    assert.ok(at >= 0, `missing account-pin marker: ${marker}`);
    assert.ok(at > pos, `account-pin order violated at: ${marker}`);
    pos = at;
  }
  assert.match(src, /homedir\(\) \+ "\/.agents\/ego-profile\.json"/);
  // evidence channel is the in-page session fetch (page.fetch wrapper can return null)
  assert.match(src, /fetch\("\/api\/auth\/session", \{ credentials: "include" \}\)/);
});
