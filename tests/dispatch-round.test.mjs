// Structural contract tests for the R2.5 frozen dispatch transaction chain.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const template = () => readFile(new URL("../skills/chatgpt-web-dispatch/templates/dispatch-round.template.mjs", import.meta.url), "utf8");

test("template freezes the transaction chain order: ownership before fill, PREPARED before send", async () => {
  const src = await template();
  const order = [
    "FROZEN_BACKOFF_PENDING",
    "STALE_PREPARED_RECORD_STOP",
    'abort(ownership.kind === "empty"',
    "if (await getFillCount(MON, SPACE) >= 3)",
    "recordFillAttempt(MON, SPACE)",
    "if (!readbackMatches(payload, composerText))",
    "prepareDispatch({ monitorDir: MON",
    "markSendStarted(MON",
    "markAccepted(MON",
    "markUncertain(MON",
  ];
  let pos = -1;
  for (const marker of order) {
    const at = src.indexOf(marker);
    assert.ok(at >= 0, `missing lifecycle marker: ${marker}`);
    assert.ok(at > pos, `lifecycle order violated at: ${marker}`);
    pos = at;
  }
});

test("chunk rule: line-boundary chunks, byte limit, join-reconstruct guarantee documented and wired", async () => {
  const src = await template();
  assert.match(src, /chunkPayload\(payload, 1200\)/);
  assert.match(src, /abort\("COMPOSER_RENDER_FREEZE"\)/);
  // freeze abort must wrap composer evaluate calls (fill + readback)
  assert.match(src, /await markComposerFreeze\(MON, \{ space: SPACE, error \}\);/);
});

test("two-level readback: strict for sensitive payloads, normalized only for plain text", async () => {
  const src = await template();
  assert.match(src, /readbackMode\(payload\) === "strict" \? "SENSITIVE_FIDELITY_UNPROVEN" : "READBACK_NOT_VERIFIED_ABORT"/);
  assert.match(src, /readbackMatches\(payload, composerText\)/);
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
  // in-flight states never clear/refill/resend
  assert.match(src, /abort\("DISPATCH_IN_FLIGHT_" \+ existing\.status\)/);
  assert.match(src, /abort\("STALE_PREPARED_RECORD_STOP"\)/);
});

test("ledger stores fingerprint only: payload never embedded in the template's ledger calls", async () => {
  const src = await template();
  assert.match(src, /prepareDispatch\(\{ monitorDir: MON, conversationUuid: CONV, taskSpace: SPACE, pageLabel: page\.label, page, payload \}\)/);
  assert.doesNotMatch(src, /payload: payload\.slice|payload\.substring/);
});

test("FRESHEN: fires before the fill, resets the counter, distinct goto_reason", async () => {
  const src = await template();
  assert.match(src, /if \(await getFillCount\(MON, SPACE\) >= 3\) \{/);
  assert.match(src, /goto_reason: "FRESHEN"/);
  const freshenAt = src.indexOf('goto_reason: "FRESHEN"');
  const fillAt = src.indexOf("recordFillAttempt(MON, SPACE)");
  assert.ok(freshenAt < fillAt, "FRESHEN must precede the fill");
  assert.match(src, /resetFillCount\(MON, SPACE\)/);
});
