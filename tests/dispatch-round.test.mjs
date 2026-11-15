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

test("#30: URL strict readback reconstructs paragraph text and recover-only stops before fill", async () => {
  const src = await template();
  assert.match(src, /const paragraphs = nodes\.length && nodes\.every/);
  assert.match(src, /composerReadbackText\(await composerOp\(\(\) => evaluateComposer\("read"\)\)\)/);
  const clearAt = src.indexOf("await ensureOwnEmptyComposer(); // Gate 2 (initial)");
  const cancelAt = src.indexOf("abortPreparedDispatch(MON, existing.dispatchId)");
  const fillAt = src.indexOf("recordFillAttempt(MON, SPACE)");
  assert.ok(clearAt > 0 && cancelAt > clearAt && fillAt > cancelAt);
  assert.match(src, /if \(RECOVER_ONLY && \(!resume \|\| NEW_CHAT \|\| ATTACHMENTS\.length\)\) abort\("RECOVERY_REQUIRES_MATCHING_PREPARED"\)/);
  assert.match(src, /console\.log\("RESULT=OWNED_DRAFT_CLEARED"\)/);
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

test("existing conversation send automatically recovers a missing Page through the audited navigation channel", async () => {
  const src = await template();
  assert.match(src, /await recoverConversationPage\(task, CONV\)/);
  assert.match(src, /else if \(pageNeedsNavigation\) await navigate\("CONVERSATION_PAGE_RECOVERY"\)/);
  assert.ok(src.indexOf("assertAgentOwnedTaskSpace(targetSpace, SPACE)") < src.indexOf("await recoverConversationPage(task, CONV)"));
  assert.ok(src.indexOf("await recoverConversationPage(task, CONV)") < src.indexOf("// ---- Gate 0"));
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
  assert.match(src, /const readRaw = async \(\) => composerReadbackText\(await composerOp\(\(\) => evaluateComposer\("read"\)\)\)/);
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
function composerNode({ label = null, id = "", testid = null, visible = true, text = "", tagName = "DIV", childNodes } = {}) {
  return {
    id, tagName, innerText: text, value: text, childNodes, offsetParent: visible ? {} : null,
    getClientRects: () => visible ? [{}] : [],
    getAttribute: (key) => ({ "aria-label": label, "data-testid": testid })[key] ?? null,
    matches: (selector) => selector === '[contenteditable="true"][role="textbox"]' && tagName === "DIV",
    focus() { this.focused = true; },
  };
}

async function composerHarness(nodes) {
  const src = await template();
  const start = src.indexOf('const evaluateComposer = (action, text = "") => page.evaluate(');
  const end = src.indexOf('const readRaw = async () =>', start);
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
  assert.equal((await evaluateComposer("read")).raw, "old owned draft");
  assert.equal(await evaluateComposer("clear"), true);
  assert.equal(composer.innerText, "");
  await evaluateComposer.insertChunk("new payload");
  assert.equal((await evaluateComposer("read")).raw, "new payload");
  assert.equal(editor.innerText, "editor source", "Edit code must never be modified");
  assert.equal(editor.focused, undefined, "Edit code must never receive focus");
});

test("agent-kit#14: id/testid, visibility, generic fallback, and ambiguity fail-closed", async () => {
  const editor = composerNode({ label: "Edit code", text: "untouched" });
  const hidden = composerNode({ label: "Ask ChatGPT", visible: false });
  const byId = composerNode({ id: "prompt-textarea", text: "id target" });
  const idTier = await composerHarness([editor, hidden, byId]);
  assert.equal((await idTier("read")).raw, "id target", "hidden aria-label must not beat visible id");

  const byTestid = composerNode({ testid: "prompt-textarea", text: "testid target" });
  assert.equal((await (await composerHarness([editor, byTestid]))("read")).raw, "testid target");

  const fallback = composerNode({ text: "generic target" });
  const genericTier = await composerHarness([editor, fallback]);
  assert.equal((await genericTier("read")).raw, "generic target");

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

test("#30: real composer callback extracts top-level paragraphs for strict URL readback", async () => {
  const { composerReadbackText, readbackMatches } = await import("../monitor/dispatch-state.mjs");
  const original = "中文 http://example.com/a\n第二行";
  const composer = composerNode({
    label: "Ask ChatGPT", text: "中文 http://example.com/a\n\n第二行",
    childNodes: [
      { nodeType: 1, tagName: "P", innerText: "中文 http://example.com/a" },
      { nodeType: 1, tagName: "P", innerText: "第二行" },
    ],
  });
  const evaluate = await composerHarness([composer]);
  assert.equal(readbackMatches(original, composerReadbackText(await evaluate("read"))), true);
  composer.childNodes[1].innerText = "篡改第二行";
  assert.equal(readbackMatches(original, composerReadbackText(await evaluate("read"))), false);
  composer.childNodes = [{ nodeType: 1, tagName: "DIV", innerText: original }];
  assert.equal(readbackMatches(original, composerReadbackText(await evaluate("read"))), false);
});

// ---- #30 closure: edge cases for the landed readback repair (#30 + #23-3) ----

test("#30: URL payload strict mode — paragraph join matches, raw double-newline artifact fails closed", async () => {
  const { composerReadbackText, readbackMatches, readbackMode } = await import("../monitor/dispatch-state.mjs");
  const payload = "打开 https://example.com/admin?tab=1\n第二行 URL 说明";
  assert.equal(readbackMode(payload), "strict");
  // Verified top-level <p> structure: ProseMirror's per-paragraph readback reconstructs the
  // single newline the payload contains, despite the raw innerText carrying a block-boundary
  // double-newline artifact.
  const good = {
    raw: "打开 https://example.com/admin?tab=1\n\n第二行 URL 说明",
    paragraphs: ["打开 https://example.com/admin?tab=1", "第二行 URL 说明"],
  };
  assert.equal(readbackMatches(payload, composerReadbackText(good), "strict"), true);
  // The same composer WITHOUT a recognized paragraph structure keeps the raw artifact
  // ("…\n\n…") — strict fidelity must reject it, never normalize on the caller's behalf.
  assert.equal(readbackMatches(payload, composerReadbackText({ raw: good.raw, paragraphs: null }), "strict"), false);
  assert.equal(readbackMatches(payload, composerReadbackText(good.raw), "strict"), false);
  // Strict also rejects reordering: paragraph order is part of the payload's identity.
  const swapped = {
    raw: "第二行 URL 说明\n\n打开 https://example.com/admin?tab=1",
    paragraphs: ["第二行 URL 说明", "打开 https://example.com/admin?tab=1"],
  };
  assert.equal(readbackMatches(payload, composerReadbackText(swapped), "strict"), false);
});

test("#30: CJK multi-line payload matches via per-paragraph single-newline reconstruction", async () => {
  const { composerReadbackText, readbackMatches } = await import("../monitor/dispatch-state.mjs");
  const payload = "修复 https://example.com/issue-30\n中文第二行：逐段回读\n第三行结尾";
  const snapshot = {
    raw: "修复 https://example.com/issue-30\n\n中文第二行：逐段回读\n\n第三行结尾",
    paragraphs: ["修复 https://example.com/issue-30", "中文第二行：逐段回读", "第三行结尾"],
  };
  assert.equal(readbackMatches(payload, composerReadbackText(snapshot), "strict"), true);
  // A stray trailing CR inside one paragraph stays CRLF-equivalent in strict mode.
  const crlf = {
    raw: "修复 https://example.com/issue-30\r\n\r\n中文第二行：逐段回读\r\n\r\n第三行结尾",
    paragraphs: ["修复 https://example.com/issue-30\r", "中文第二行：逐段回读", "第三行结尾"],
  };
  assert.equal(readbackMatches(payload, composerReadbackText(crlf), "strict"), true);
  // One character dropped inside a paragraph → strict mismatch, no whitespace forgiveness.
  const drifted = {
    ...snapshot,
    paragraphs: ["修复 https://example.com/issue-30", "中文第二行：逐段回读!", "第三行结尾"],
  };
  assert.equal(readbackMatches(payload, composerReadbackText(drifted), "strict"), false);
});

test("#23-3: block-boundary double-newline collapse matches in normalized mode and classifies INSERTED", async () => {
  const { readbackMatches, classifyChunkReadback } = await import("../monitor/dispatch-state.mjs");
  const payload = "前缀段落\n\n后续段落";
  const collapsed = "前缀段落后续段落"; // ProseMirror removed BOTH newlines at the pasted chunk boundary
  assert.equal(readbackMatches(payload, collapsed, "normalized"), true);
  assert.equal(classifyChunkReadback("前缀段落", payload, collapsed, "normalized"), "INSERTED");
  // The identical shape must NOT pass the strict gate — the normalized relaxation never
  // leaks into sensitive payloads.
  assert.equal(readbackMatches(payload, collapsed, "strict"), false);
  // Unrelated text remains a mismatch even under normalized comparison.
  assert.equal(readbackMatches(payload, "前缀段落别的段落", "normalized"), false);
});

test("#30: strict readback on unrecognized DOM drift yields MISMATCH (fidelity gate refuses)", async () => {
  const { readbackMatches, classifyChunkReadback } = await import("../monitor/dispatch-state.mjs");
  const payload = "step1 https://a.example/x\nstep2";
  // Raw innerText with a block-boundary artifact and no paragraph structure.
  const artifact = "step1 https://a.example/x\n\nstep2";
  assert.equal(readbackMatches(payload, artifact, "strict"), false);
  assert.equal(classifyChunkReadback("", payload, artifact, "strict"), "MISMATCH");
  // Plain content drift is equally refused.
  const drifted = "step1 https://a.example/x\nstep2 补句";
  assert.equal(classifyChunkReadback("", payload, drifted, "strict"), "MISMATCH");
  // Contrast: exact and CRLF-equivalent readbacks still classify normally in strict mode.
  assert.equal(classifyChunkReadback("", payload, payload, "strict"), "INSERTED");
  assert.equal(classifyChunkReadback("", payload, "step1 https://a.example/x\r\nstep2", "strict"), "INSERTED");
  assert.equal(classifyChunkReadback(payload, payload + "\nstep3", payload, "strict"), "NO_EFFECT");
});

test("#30: verifyDraftOwnership fidelity — sensitive whitespace loss rejected, compact prefix owned, historical SHA256 only", async () => {
  const { verifyDraftOwnership } = await import("../monitor/dispatch-state.mjs");
  const { createHash } = await import("node:crypto");

  // Sensitive payload (URL): newline lost at a chunk edge → NOT owned. The compact
  // whitespace-loss fallback is reserved for plain prose and must never apply here.
  const sensitive = "请访问 https://example.com/docs\n参数 --mode=strict";
  const lostNewline = "请访问 https://example.com/docs参数 --mode=strict";
  assert.deepEqual(verifyDraftOwnership({ draft: lostNewline, payload: sensitive }),
    { owned: false, kind: "foreign", reason: "DRAFT_NOT_OWNED" });
  // Byte-identical raw content (CRLF-equivalent) is still owned in full.
  assert.deepEqual(verifyDraftOwnership({ draft: "请访问 https://example.com/docs\r\n参数 --mode=strict", payload: sensitive }),
    { owned: true, kind: "full" });

  // Plain prose: whitespace loss at a chunk edge keeps an in-order compact prefix owned.
  const plain = "第一段落内容\n第二段落内容\n第三段落内容";
  assert.deepEqual(verifyDraftOwnership({ draft: "第一段落内容第二段落内", payload: plain }),
    { owned: true, kind: "prefix" });
  // Reordered fragments stay foreign even for plain prose.
  assert.deepEqual(verifyDraftOwnership({ draft: "第二段落内容第一段落内", payload: plain }),
    { owned: false, kind: "foreign", reason: "DRAFT_NOT_OWNED" });

  // Historical identity: only the SHA256 of the full CRLF-normalized draft proves ownership.
  const historical = { payload_sha256: createHash("sha256").update("历史草稿全文\n第二行", "utf8").digest("hex") };
  assert.deepEqual(verifyDraftOwnership({ draft: "历史草稿全文\n第二行", record: historical }),
    { owned: true, kind: "historical-identity" });
  assert.deepEqual(verifyDraftOwnership({ draft: "历史草稿全文\r\n第二行", record: historical }),
    { owned: true, kind: "historical-identity" });
  assert.equal(verifyDraftOwnership({ draft: "历史草稿全文\n第二行改动", record: historical }).owned, false);
  assert.equal(verifyDraftOwnership({
    draft: "历史草稿全文\n第二行",
    record: { payload_sha256: createHash("sha256").update("另一份历史草稿", "utf8").digest("hex") },
  }).owned, false);

  // In-flight interlock: once the ledger reached SEND_STARTED, even the exact draft is locked.
  assert.deepEqual(verifyDraftOwnership({ draft: sensitive, payload: sensitive, record: { status: "SEND_STARTED" } }),
    { owned: false, kind: "send-started-locked",
      reason: "SEND_STARTED_LOCKED_ACCEPTANCE_RECONCILIATION_REQUIRED" });
});

test("#30: recover-draft ledger semantics — only a proved PREPARED aborts to ABORTED, everything else is rejected", async () => {
  const { abortPreparedDispatch, writeJsonAtomic } = await import("../monitor/dispatch-state.mjs");
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "ego-recover-draft-"));
  const dispatchId = "30aaaaaa-3030-4030-8030-000000000030";
  const ledger = join(root, "a-dispatch-state.json");
  const record = (status) => ({ schema: "ego-dispatch-state/v2", dispatchId,
    conversationUuid: dispatchId, taskSpace: "GDC-执行A", pageLabel: "p1",
    baselineTailKey: null, baselineTailRole: null, baselineComposerLength: 0,
    attempt: 1, createdAt: Date.now(), payload_sha256: null, payload_bytes: null,
    composer_baseline: null, status });
  try {
    await writeJsonAtomic(ledger, record("PREPARED"));
    const aborted = await abortPreparedDispatch(root, dispatchId);
    assert.equal(aborted.status, "ABORTED");
    assert.equal(aborted.reasonCode, "OWNED_DRAFT_RECOVERED");
    const events = await readFile(join(root, "a-fast-events.ndjson"), "utf8");
    assert.match(events, /"event":"ABORTED"/);
    assert.match(events, /"attempt":1/);
    // The recovery is single-shot: an ABORTED draft cannot be aborted again.
    await assert.rejects(() => abortPreparedDispatch(root, dispatchId),
      /DISPATCH_TRANSITION_REJECTED:ABORTED->ABORTED/);
    // A draft that was already sent (or is awaiting reconciliation) can never be "recovered".
    for (const status of ["SEND_STARTED", "ACCEPTED", "UNCERTAIN", "RETRY_AUTHORIZED"]) {
      await writeJsonAtomic(ledger, record(status));
      await assert.rejects(() => abortPreparedDispatch(root, dispatchId),
        new RegExp(`DISPATCH_TRANSITION_REJECTED:${status}->ABORTED`));
    }
    // Ledger identity mismatch fails closed.
    await writeJsonAtomic(ledger, record("PREPARED"));
    await assert.rejects(() => abortPreparedDispatch(root, "other-dispatch-id"), /DISPATCH_ID_MISMATCH/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
