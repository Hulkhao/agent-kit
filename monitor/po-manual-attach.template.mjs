// #40: PO-manual attach page verification. Run through ego-browser BEFORE any
// ledger is written — the binding may only land when the page provably belongs
// to the target conversation (exact-host URL evidence) AND a stable tail
// identity is readable (尾消息证据). This template is read-only: it never
// clicks, fills, navigates or closes anything.
const MON = "REPLACE_WITH_DEPLOY_MONITOR_DIR";
const AGENT_ID = "REPLACE_WITH_STABLE_AGENT_ID";
const SPACE = "REPLACE_WITH_UNIQUE_TASKSPACE";
const CONV = "REPLACE_WITH_CONVERSATION_UUID";
if ([MON, AGENT_ID, SPACE, CONV].some((value) => value.startsWith("REPLACE_"))) throw new Error("ADAPTATION_REQUIRED");

import { pathToFileURL } from "node:url";
const { readComposerSurface } = await import(pathToFileURL(MON + "/dispatch-state.mjs").href);
const { isConversationUrl } = await import(pathToFileURL(MON + "/page-recovery.mjs").href);
const { assertAgentOwnedTaskSpace } = await import(pathToFileURL(MON + "/taskspace-takeover.mjs").href);

const refuse = (code, detail = "") => {
  console.log("RESULT=PO_MANUAL_ATTACH_" + code + (detail ? " detail=" + detail : ""));
  process.exit(1);
};

// Space gate: the TaskSpace must exist AND be agent-owned — a foreign or
// missing space is never a verification pass (fail-closed).
const spaces = await listTaskSpaces();
const owned = spaces.find((space) => space.taskId === SPACE || space.name === SPACE);
if (!owned) refuse("SPACE_NOT_FOUND", "space=" + SPACE);
try {
  assertAgentOwnedTaskSpace(owned, SPACE);
} catch (error) {
  refuse("SPACE_OWNERSHIP_UNPROVEN", String(error?.code || error?.message || "UNKNOWN").slice(0, 80));
}
const task = await taskSpace(owned.id);
const pages = await task.pages();

// URL evidence: exactly ONE page may carry the conversation URL (exact host).
// Zero or several matches leave the page identity unproven — no attach.
const matches = [];
for (const page of pages) {
  let url = null;
  try { url = await page.url(); } catch { url = null; }
  if (url && isConversationUrl(url, CONV, true)) matches.push(page);
}
if (matches.length === 0) refuse("PAGE_NOT_FOUND", "conversation=" + CONV);
if (matches.length > 1) refuse("PAGE_NOT_UNIQUE", "matches=" + matches.length);
const page = matches[0];

// Tail evidence: the composer surface must be readable and carry a stable tail
// identity. A generation still running at attach time would make the baseline
// tail race the reply — refuse and let the operator retry once idle.
let surface = null;
try { surface = await readComposerSurface(page); }
catch (error) {
  refuse("SURFACE_READ_FAILED", String(error?.name || error?.message || "UNKNOWN").slice(0, 80));
}
if (!surface.hostOk || !surface.composerPresent) refuse("SURFACE_UNAVAILABLE");
if (surface.generating) refuse("GENERATION_ACTIVE", "retry-attach-once-idle");
if (!surface.lastMessageRole || !surface.lastMessageKey) refuse("TAIL_ID_UNAVAILABLE");

// The verified evidence bundle. Single line, JSON-encoded, no spaces — the
// manager parses it verbatim (parseVerifiedPageEvidence) and builds the
// PO_MANUAL ledger baseline from EXACTLY these fields. A page without a label
// (page.label null) is refused by the manager's evidence gate: label the page
// in ego-browser first — the ledger schema requires a durable page reference.
console.log("RESULT=PO_MANUAL_PAGE_VERIFIED evidence=" + JSON.stringify({
  pageLabel: page.label ?? null,
  tailRole: surface.lastMessageRole,
  tailKey: surface.lastMessageKey,
  tailLen: surface.lastMessageTextLength,
  composerLength: surface.composerLength,
}));
