// Issue #25 gap 1: probe origin self-check (PROBE_INVALID_ORIGIN).
// The probe must verify the managed Page sits on the watched conversation source (or a
// legal blank transition) before reading it; any other origin makes every in-page request
// fail while the probe "looks alive" — false-blind monitoring that strikes and backs off
// instead of waking the supervisor. The probe script itself is deployment-adapted and
// exits at boot, so its behavior is pinned here by source-slice assertions.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { probeOriginVerdict } from "../monitor/page-recovery.mjs";
import { classifyProbeResult } from "../monitor/dispatch-manager.mjs";

const target = "12345678-1234-1234-1234-123456789abc";
const other = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const conversation = (uuid) => `https://chatgpt.com/c/${uuid}`;
const probeSource = await readFile(
  fileURLToPath(new URL("../monitor/ego-fast-probe.mjs", import.meta.url)), "utf8");

test("watched conversation sources are OK", () => {
  assert.equal(probeOriginVerdict(conversation(target), target), "OK");
  assert.equal(probeOriginVerdict(conversation(target) + "/", target), "OK");
  // project conversations end in /c/<uuid> too (same contract as conversationIdFromUrl)
  assert.equal(probeOriginVerdict(`https://chatgpt.com/g/p-x/project/c/${target}`, target), "OK");
  assert.equal(probeOriginVerdict(`https://chat.chatgpt.com/c/${target}`, target), "OK");
});

test("blank navigation intermediates are TRANSITION, never INVALID", () => {
  // The three legal blank-transition flows (RECOVER-round blank page, fresh Page before
  // navigation, #18 blank reuse) must keep the existing navigate ladder — the verdict
  // itself only has to guarantee they are not reported as INVALID.
  assert.equal(probeOriginVerdict("about:blank", target), "TRANSITION");
  assert.equal(probeOriginVerdict("chrome://new-tab-page/", target), "TRANSITION");
  // Short spelling that persisted tab metadata can report for the same blank
  // (field-observed 2026-11-16 E-30: task.tabs() "chrome://newtab/" vs page.url()
  // "chrome://new-tab-page/", same targetId). Not accepting it misclassifies an
  // agent-owned blank as INVALID / unregistered and blocks release.
  assert.equal(probeOriginVerdict("chrome://newtab/", target), "TRANSITION");
  // The probe's own inline blank predicate must stay in lockstep with the shared
  // helper (source-slice pin, same style as the rest of this file).
  assert.match(probeSource, /isBlankPageUrl = \(rawUrl\) => rawUrl === "about:blank" \|\| rawUrl === "chrome:\/\/new-tab-page\/" \|\| rawUrl === "chrome:\/\/newtab\/"/);
});

test("every other source is INVALID, fail-closed", () => {
  // chrome:// inner pages other than the new-tab intermediate
  assert.equal(probeOriginVerdict("chrome://settings/", target), "INVALID");
  assert.equal(probeOriginVerdict("chrome-error://chromewebdata/", target), "INVALID");
  // foreign hosts, including ChatGPT-lookalike paths
  assert.equal(probeOriginVerdict("https://example.org/c/" + target, target), "INVALID");
  assert.equal(probeOriginVerdict("https://chatgpt.com.evil.example/c/" + target, target), "INVALID");
  // chatgpt.com but not the watched conversation: not provably the session source
  assert.equal(probeOriginVerdict("https://chatgpt.com/", target), "INVALID");
  assert.equal(probeOriginVerdict(conversation(other), target), "INVALID");
  // unreadable or malformed URL evidence
  assert.equal(probeOriginVerdict("", target), "INVALID");
  assert.equal(probeOriginVerdict(null, target), "INVALID");
  assert.equal(probeOriginVerdict(undefined, target), "INVALID");
  assert.equal(probeOriginVerdict("not a url", target), "INVALID");
});

test("probe exits with PROBE_INVALID_ORIGIN only from the INVALID gate", () => {
  // The exit path exists and is gated on the INVALID verdict alone — blank transitions
  // (TRANSITION) never reach it and keep the existing RECOVER/navigate flow below.
  assert.match(probeSource, /if \(probeOriginVerdict\(originUrl, uuid\) === "INVALID"\) \{/);
  assert.match(probeSource, /console\.log\("RESULT=PROBE_INVALID_ORIGIN"\)/);
  const gate = probeSource.slice(
    probeSource.indexOf('if (probeOriginVerdict(originUrl, uuid) === "INVALID")'),
    probeSource.indexOf('console.log("RESULT=PROBE_INVALID_ORIGIN")'));
  assert.match(gate, /errorCode: "PROBE_INVALID_ORIGIN"/);
  assert.match(gate, /appendEvent\(MON, "PROBE_INVALID_ORIGIN"/);
  assert.match(gate, /probeFailed: true/);
  assert.doesNotMatch(gate, /TRANSITION/);
});

test("origin self-check runs before unavailable/dead classification and before recovery navigation", () => {
  const exitIdx = probeSource.indexOf('console.log("RESULT=PROBE_INVALID_ORIGIN")');
  const stormIdx = probeSource.indexOf("const stormPlan = planStormRecovery(");
  const unavailableIdx = probeSource.indexOf('errorCode: "CHAT_SURFACE_STRUCTURALLY_UNAVAILABLE"');
  assert.ok(exitIdx > 0 && stormIdx > 0 && unavailableIdx > 0);
  assert.ok(exitIdx < stormIdx, "origin check must precede the storm RECOVER navigation");
  assert.ok(exitIdx < unavailableIdx, "origin check must precede unavailable strike classification");
});

test("unreadable page.url() keeps the existing PAGE_URL_INSPECTION_FAILED path", () => {
  // Fail-closed: the self-check wraps its own url() read and rethrows
  // PAGE_URL_INSPECTION_FAILED into the selection catch (PAGE_RECOVERY_FAILED handling).
  const head = probeSource.slice(0, probeSource.indexOf('if (probeOriginVerdict(originUrl, uuid) === "INVALID")'));
  assert.match(head, /originUrl = await page\.url\(\);/);
  assert.match(head, /error\.code = "PAGE_URL_INSPECTION_FAILED";/);
});

test("legal blank-transition flows remain wired in the probe", () => {
  // #18 blank reuse and fresh-Page-before-navigation evidence still exist, and the
  // INVALID gate sits after selection, so those flows pass the check untouched.
  assert.match(probeSource, /selectionEvidence = "AGENT_OWNED_BLANK_PAGE";/);
  assert.match(probeSource, /selectionEvidence = "RESERVED_NEW_PAGE";/);
});

test("manager wakes on PROBE_INVALID_ORIGIN (classifyProbeResult default branch)", () => {
  assert.deepEqual(classifyProbeResult({ code: 0, result: "PROBE_INVALID_ORIGIN" }),
    { wake: true, streak: 0 });
  // The contrast is the whole point of gap 1: the old ordinary-unavailable outcome was
  // classified benign, which is what produced the silent false-blind loop.
  assert.equal(classifyProbeResult({ code: 0, result: "PROBE_UNAVAILABLE_RETRY" }).wake, false);
  assert.equal(classifyProbeResult({ code: 0, result: "PROBE_BACKOFF" }).wake, false);
});
