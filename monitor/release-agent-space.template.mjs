// Run through ego-browser after the Agent has extracted and handled the final reply.
// This file is a template: adapt the constants and execute in the ego runtime.
const MON = "REPLACE_WITH_DEPLOY_MONITOR_DIR";
const AGENT_ID = "REPLACE_WITH_STABLE_AGENT_ID";
const SPACE = "REPLACE_WITH_UNIQUE_TASKSPACE";
const CONV = "REPLACE_WITH_COMPLETED_CONVERSATION_UUID";
if ([MON, AGENT_ID, SPACE, CONV].some((v) => v.startsWith("REPLACE_"))) throw new Error("ADAPTATION_REQUIRED");

import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const { releaseAgentConversation, withAgentRegistry } = await import(pathToFileURL(MON + "/agent-space.mjs").href);
const { assertAgentOwnedTaskSpace } = await import(pathToFileURL(MON + "/taskspace-takeover.mjs").href);
const { conversationIdFromUrl, isConversationUrl, assertManagedReleasePages } = await import(pathToFileURL(MON + "/page-recovery.mjs").href);
const assigned = await withAgentRegistry((registry) => ({ changed: false, value: registry.agents[AGENT_ID] }));
if (assigned?.spaceName !== SPACE || !assigned.known?.includes(CONV)) throw new Error("CONVERSATION_NOT_REGISTERED");
if (!assigned.active.includes(CONV) && !assigned.releasePending) {
  console.log(`RESULT=AGENT_SPACE_RELEASED finished=${assigned.active.length === 0} remaining=${assigned.active.length}`);
} else {
const spaces = await listTaskSpaces();
const owned = spaces.find((space) => space.taskId === SPACE || space.name === SPACE);
if (owned) assertAgentOwnedTaskSpace(owned, SPACE);
if (!owned && !(assigned.releasePending?.conversationUuid === CONV && assigned.releasePending.finished)) {
  throw new Error("TASKSPACE_NOT_FOUND");
}
const task = owned ? await taskSpace(owned.id) : null;
const tabs = task ? await task.tabs() : [];
const pages = task ? await task.pages() : [];
// Preflight before writing releasePending. Restart blanks require verified
// TaskSpace ownership, managed Page evidence, and no contradictory user tab.
if (task) await assertManagedReleasePages(pages, tabs, assigned.known);
const matches = [];
for (const page of pages) {
  if (isConversationUrl(await page.url(), CONV, true)) matches.push(page);
}
if (matches.length > 1 ||
    (matches.length === 0 && !(assigned.releasePending?.conversationUuid === CONV &&
      (assigned.releasePending.finished || Boolean(task))))) {
  throw new Error("COMPLETED_PAGE_NOT_UNIQUE_STOP");
}
const target = matches[0] || null;

const result = await releaseAgentConversation({
  agentId: AGENT_ID, spaceName: SPACE, conversationUuid: CONV,
  alreadyReleased: async (entry) => entry.releasePending?.conversationUuid === CONV &&
    (entry.releasePending.finished ? !task : target === null),
  closePage: async () => { if (!target) throw new Error("COMPLETED_PAGE_NOT_FOUND"); await target.close(); },
  finishSpace: async (entry) => {
    if (!task || (!target && !entry.releasePending?.finished)) throw new Error("COMPLETED_SPACE_NOT_FOUND");
    await task.finish({ keep: [] });
  },
});

// #27 Batch 2 (ruling §3.3): managed temp-result-page sweep. Conservative by
// default — a page is closed ONLY when it is provably a finished conversation
// page of THIS agent (registry-known conversation AND a terminal dispatch
// ledger). Active conversation pages, blank pages, unknown URLs and anything
// unattributable are kept. The TaskSpace itself is never deleted. Every page
// leaves one audit line; any cleanup failure is reported truthfully and never
// disguised as a full release (RESULT=AGENT_SPACE_RELEASE_SWEEP_FAILED, which
// the manager classifies as exit 2 so the supervisor wakes).
const TERMINAL_DISPATCH = new Set(["COMPLETED", "ABORTED", "RELEASED"]);
const sweepAuditFile = MON + "/a-release-sweep-audit.ndjson";
const sweepAudit = (entry) => appendFile(sweepAuditFile, JSON.stringify({
  ts: new Date().toISOString(), action: "release-sweep", agentId: AGENT_ID, space: SPACE,
  conversation: CONV, ...entry,
}) + "\n", "utf8");
const ledgerStatusOf = async (uuid) => {
  // Only the dispatch status is read here (privacy contract: ids and status
  // names, never task or reply bodies). Unreadable = unproven = keep.
  try {
    const record = JSON.parse(await readFile(MON + "/conversations/" + uuid.toLowerCase() + "/a-dispatch-state.json", "utf8"));
    return record && typeof record.status === "string" ? record.status : null;
  } catch { return null; }
};
let closed = 0;
let kept = 0;
let failed = 0;
if (result.finished) {
  // Last active conversation: task.finish({keep:[]}) already closed every page;
  // record the skip so the audit trail covers the whole release.
  await sweepAudit({ page: null, decision: "skipped", reason: "SPACE_FINISHED_BY_RELEASE" }).catch(() => { failed++; });
} else if (task) {
  let remaining = [];
  try { remaining = await task.pages(); }
  catch (error) {
    failed++;
    await sweepAudit({ page: null, decision: "sweep-failed", reason: "PAGE_ENUMERATION_FAILED",
      code: String(error?.code || error?.message || "UNKNOWN").slice(0, 80) }).catch(() => { failed++; });
  }
  for (const page of remaining) {
    let uuid = null;
    try { uuid = conversationIdFromUrl(await page.url(), true); } catch { uuid = null; }
    let decision = "kept";
    let reason = "OWNERSHIP_UNPROVEN"; // blank pages, unknown/unreadable URLs: never closed
    if (uuid && assigned.known.some((k) => typeof k === "string" && k.toLowerCase() === uuid.toLowerCase())) {
      if (uuid.toLowerCase() === CONV.toLowerCase()) {
        reason = "RELEASE_TARGET_RESIDUAL"; // the target is handled by the managed close/finish path only
      } else {
        const status = await ledgerStatusOf(uuid);
        if (status && TERMINAL_DISPATCH.has(status)) {
          decision = "closed";
          reason = "TEMP_RESULT_PAGE_FINISHED_DISPATCH";
        } else if (status) {
          reason = "ACTIVE_DISPATCH_LEDGER";
        } else {
          reason = "LEDGER_UNPROVEN";
        }
      }
    }
    if (decision === "closed") {
      try { await page.close(); closed++; }
      catch (error) {
        decision = "close-failed";
        failed++;
        reason = "PAGE_CLOSE_FAILED:" + String(error?.code || error?.message || "UNKNOWN").slice(0, 80);
      }
    } else kept++;
    try { await sweepAudit({ page: { label: page.label ?? null, uuid: uuid ?? null }, decision, reason }); }
    catch { failed++; } // an unauditable cleanup counts as incomplete, never silent
  }
  console.log(`RELEASE_SWEEP closed=${closed} kept=${kept} failed=${failed}`);
}
if (failed > 0) {
  console.log(`RESULT=AGENT_SPACE_RELEASE_SWEEP_FAILED closed=${closed} kept=${kept} failed=${failed}`);
} else {
  console.log(`RESULT=AGENT_SPACE_RELEASED finished=${result.finished} remaining=${result.active.length}`);
}
}
