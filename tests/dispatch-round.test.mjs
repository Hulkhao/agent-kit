// Structural contract tests for the R2.5 frozen dispatch transaction chain (r43 + r44 rework).
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

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
    "if (!readbackMatches(payload, composerText, fillReadbackMode))",
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

test("adaptive chunk fill is readback-driven; retry only when the previous cumulative prefix remains", async () => {
  const src = await template();
  const fillStart = src.indexOf("// ---- Gate 5: adaptive fill");
  const gate6 = src.indexOf("// ---- Gate 6: final full-payload verdict");
  const fill = src.slice(fillStart, gate6);
  assert.match(fill, /chunkPayload\(payload, 1200, 600\)/);
  assert.match(fill, /classifyChunkReadback\(expectedPrefix, nextPrefix, composerText, fillReadbackMode\)/);
  assert.match(fill, /readbackState === "INSERTED"/);
  assert.match(fill, /readbackState === "MISMATCH"/);
  assert.match(fill, /retryReadbackState = classifyChunkReadback/);
  assert.match(fill, /retryReadbackState === "INSERTED"/);
  assert.match(fill, /CHUNK_READBACK_MISMATCH/);
  assert.match(fill, /CHUNK_INSERT_NO_EFFECT/);
  assert.match(fill, /attempt < 2/);
  assert.doesNotMatch(fill, /ok = r\?\.ok === true/);
  const gate6Body = src.slice(gate6, src.indexOf("// ---- Gate 7:"));
  assert.match(gate6Body, /readbackMatches\(payload, composerText, fillReadbackMode\)/);
  assert.match(gate6Body, /if \(chunks.length === 0\) composerText = await readRaw\(\)/);
  assert.equal((gate6Body.match(/readRaw\(/g) || []).length, 1);
  assert.match(src, /composerOp/);
});

test("two-level readback: strict for sensitive payloads, normalized only for plain text", async () => {
  const src = await template();
  assert.match(src, /fillReadbackMode === "strict" \? "SENSITIVE_FIDELITY_UNPROVEN" : "READBACK_NOT_VERIFIED_ABORT"/);
  assert.match(src, /readbackMatches\(payload, composerText, fillReadbackMode\)/);
  assert.match(src, /classifyChunkReadback\(expectedPrefix, nextPrefix, composerText, fillReadbackMode\)/);
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
  assert.match(src, /abort\("DRAFT_RESURRECTED_AFTER_CLEAR"\)/);
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
  assert.match(src, /abort\("DRAFT_RESURRECTED_AFTER_CLEAR"\)/);
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
  assert.match(src, /const readRaw = \(\) => composerOp\(\(\) => evaluateComposer\("read"\)\)/);
  assert.match(src, /const evaluateClearComposer = \(\) => evaluateComposer\("clear"\)/);
  assert.match(src, /await page\.cdp\("Input\.insertText", \{ text: chunk \}\)/);
  assert.doesNotMatch(src, /document\.querySelector\(COMPOSER_SEL\)/);
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

test("r45 Gate 7.1: historical model metadata is diagnostic only; live level gate is authoritative", async () => {
  const src = await template();
  const gate7 = src.indexOf('abort("LEVEL_GATE_FAIL_ABORT")');
  const gate71 = src.indexOf('await appendEvent(MON, "MODEL_HISTORY_AUX"');
  const gate8 = src.indexOf("---- Gate 8");
  assert.ok(gate7 > 0 && gate71 > gate7 && gate71 < gate8, "Gate 7.1 must sit between the level gate and Gate 8");
  assert.doesNotMatch(src, /abort\("MODEL_EVIDENCE_UNAVAILABLE_STOP"\)/);
  assert.doesNotMatch(src, /abort\("MODEL_HISTORY_MISMATCH"\)/);
  assert.match(src, /MODEL_HISTORY_AUX_UNAVAILABLE/);
  assert.match(src, /MODEL_HISTORY_AUX/);
  assert.doesNotMatch(src, /console\.log\([^)]*token/);
  assert.doesNotMatch(src, /appendEvent\([^)]*token/);
});

test("#25: task takeover gates dispatch before any send or page recovery", async () => {
  const src = await template();
  assert.match(src, /const spaces = await listTaskSpaces\(\)/);
  assert.match(src, /assertAgentOwnedTaskSpace\(targetSpace, SPACE\)/);
  assert.match(src, /task = await taskSpace\(targetSpace\.id\)/);
  assert.match(src, /isTaskSpaceTakeover\(error\) \? TASKSPACE_TAKEOVER_SIGNAL : "TASKSPACE_RECOVERY_FAILED"/);
  assert.ok(src.indexOf("isTaskSpaceTakeover(error) ? TASKSPACE_TAKEOVER_SIGNAL") < src.indexOf("// ---- Gate 0"));
});

test("#26: every STOP is classified by the current dispatch identity and send state", async () => {
  const src = await template();
  const start = src.indexOf("const abort = (code) => {");
  const end = src.indexOf("// Read the account pin", start);
  assert.ok(start > 0 && end > start);
  function simulate(status, code, matchesCurrent = true) {
    const lines = [];
    const abort = runInNewContext(src.slice(start, end) + "\nabort", {
      MON: "unused", CONV: "conv-25", SPACE: "space-25", payloadHash: "abcdef1234567890",
      dispatchStopSnapshot: () => ({ status, dispatchId: "round-25", shaPrefix: "abcdef123456", matchesCurrent }),
      console: { log: (line) => lines.push(line) },
      process: { exit: () => { throw new Error("EXIT"); } },
    });
    assert.throws(() => abort(code), /EXIT/);
    return lines;
  }
  const accepted = simulate("ACCEPTED", "MODEL_EVIDENCE_UNAVAILABLE_STOP");
  assert.ok(accepted.includes("RESULT=DISPATCH_ACCEPTED_WAKE_SUPERVISOR"));
  assert.ok(accepted.includes("ACTION=ARM_MONITORS_NO_RESEND"));
  assert.ok(accepted.includes("STOP_CAUSE=MODEL_EVIDENCE_UNAVAILABLE_STOP"));
  assert.ok(accepted.some((line) => line.includes('"status":"ACCEPTED"') && line.includes('"dispatchId":"round-25"')));
  const uncertain = simulate("SEND_STARTED", "MODEL_EVIDENCE_UNAVAILABLE_STOP");
  assert.ok(uncertain.includes("RESULT=DISPATCH_ATTEMPTED_WAKE_SUPERVISOR"));
  assert.ok(uncertain.includes("ACTION=RECONCILE_SEND_NO_RESEND"));
  const unsent = simulate("PREPARED", "MODEL_EVIDENCE_UNAVAILABLE_STOP");
  assert.ok(unsent.includes("RESULT=MODEL_EVIDENCE_UNAVAILABLE_STOP"));
  assert.ok(unsent.some((line) => line.startsWith("DISPATCH_LEDGER=")));
  const other = simulate("ACCEPTED", "DISPATCH_IN_FLIGHT_ACCEPTED");
  assert.ok(other.includes("RESULT=DISPATCH_ACCEPTED_WAKE_SUPERVISOR"));
  const differentPayload = simulate("ACCEPTED", "MODEL_EVIDENCE_UNAVAILABLE_STOP", false);
  assert.ok(differentPayload.includes("RESULT=MODEL_EVIDENCE_UNAVAILABLE_STOP"));
  assert.ok(!differentPayload.some((line) => line.startsWith("ACTION=")));
  const otherFailure = simulate("ACCEPTED", "COMPOSER_RENDER_FREEZE");
  assert.ok(otherFailure.includes("RESULT=DISPATCH_ACCEPTED_WAKE_SUPERVISOR"));
});

// Execute the template's actual browser-side callback against a minimal DOM, not a copy of its
// selector rules. querySelectorAll returns document order (Edit code precedes the real Composer).
function composerNode({ label = null, id = "", testid = null, visible = true, text = "", tagName = "DIV" } = {}) {
  return {
    id, tagName, innerText: text, value: text, offsetParent: visible ? {} : null,
    getClientRects: () => visible ? [{}] : [],
    getAttribute: (key) => ({ "aria-label": label, "data-testid": testid })[key] ?? null,
    matches: (selector) => selector === '[contenteditable="true"][role="textbox"]' && tagName === "DIV",
    focus() { this.focused = true; },
  };
}

async function composerHarness(nodes) {
  const src = await template();
  const start = src.indexOf('const evaluateComposer = (action, text = "") => page.evaluate(');
  const end = src.indexOf('const readRaw = () =>', start);
  assert.ok(start > 0 && end > start, "expected browser composer implementation in template");
  let selected = null;
  const document = {
    activeElement: null,
    querySelectorAll(selector) {
      assert.match(selector, /#prompt-textarea/);
      return nodes; // preserves order: code editor first
    },
    querySelector() { throw new Error("document-order querySelector must not be called"); },
    createRange() {
      return {
        selectNodeContents(node) { this.node = node; },
        collapse() {},
      };
    },
    execCommand(command, _showUI, text) {
      assert.equal(command, "insertText");
      assert.ok(selected, "insertion must have a selected composer");
      selected.innerText += text;
      return true;
    },
  };
  const window = {
    getSelection: () => ({
      removeAllRanges() { selected = null; },
      addRange(range) { selected = range.node; },
      deleteFromDocument() { selected.innerText = ""; },
    }),
  };
  const selStart = src.indexOf("const COMPOSER_SEL = ");
  const selEnd = src.indexOf(";", selStart) + 1;
  assert.ok(selStart > 0 && selEnd > selStart);
  for (const node of nodes) node.focus = function () { this.focused = true; document.activeElement = this; };
  const insertStart = src.indexOf("const insertChunk = async (chunk) => {");
  const insertEnd = src.indexOf("// ---- Gate 0:", insertStart);
  assert.ok(insertStart > end && insertEnd > insertStart);
  const page = {
    evaluate: (fn, arg) => fn(arg),
    cdp: async (method, args) => {
      if (method === "Input.insertText") {
        assert.equal(document.activeElement?.getAttribute("aria-label"), "Ask ChatGPT");
        document.activeElement.innerText += args.text;
      }
    },
  };
  const api = runInNewContext(src.slice(selStart, selEnd) + "\n" +
    src.slice(start, end) + src.slice(insertStart, insertEnd) +
    "\n({ evaluateComposer, insertChunk })", { document, window, page });
  api.evaluateComposer.insertChunk = api.insertChunk;
  return api.evaluateComposer;
}

test("agent-kit#14: Edit code before Composer cannot intercept read, clear or Gate 5 insert", async () => {
  const editor = composerNode({ label: "Edit code", text: "editor source" });
  const composer = composerNode({ label: "Ask ChatGPT", text: "old owned draft" });
  const evaluateComposer = await composerHarness([editor, composer]);
  assert.equal(await evaluateComposer("read"), "old owned draft");
  assert.equal(await evaluateComposer("clear"), true);
  assert.equal(composer.innerText, "");
  await evaluateComposer.insertChunk("new payload");
  assert.equal(await evaluateComposer("read"), "new payload");
  assert.equal(editor.innerText, "editor source", "Edit code must never be modified");
  assert.equal(editor.focused, undefined, "Edit code must never receive focus");
});

test("agent-kit#14: id/testid, visibility, generic fallback, and ambiguity fail-closed", async () => {
  const editor = composerNode({ label: "Edit code", text: "untouched" });
  const hidden = composerNode({ label: "Ask ChatGPT", visible: false });
  const byId = composerNode({ id: "prompt-textarea", text: "id target" });
  const idTier = await composerHarness([editor, hidden, byId]);
  assert.equal(await idTier("read"), "id target", "hidden aria-label must not beat visible id");

  const byTestid = composerNode({ testid: "prompt-textarea", text: "testid target" });
  assert.equal(await (await composerHarness([editor, byTestid]))("read"), "testid target");

  const fallback = composerNode({ text: "generic target" });
  const genericTier = await composerHarness([editor, fallback]);
  assert.equal(await genericTier("read"), "generic target");

  const unsafe = await composerHarness([editor]);
  assert.equal(await unsafe("read"), "");
  assert.equal(await unsafe("clear"), false);
  assert.equal(await unsafe("insert", "MUST NOT INSERT"), false);
  assert.equal(editor.innerText, "untouched");

  const another = composerNode({ label: "Ask ChatGPT", text: "other" });
  const ambiguous = await composerHarness([
    composerNode({ label: "询问 ChatGPT", text: "one" }), another,
  ]);
  assert.equal(await ambiguous("clear"), false, "two labeled Composers cannot be resolved uniquely");
  assert.equal(await ambiguous("insert", "MUST NOT INSERT"), false);
  assert.equal(another.innerText, "other");
});
