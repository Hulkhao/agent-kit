// Run through ego-browser after the Agent has extracted and handled the final reply.
// This file is a template: adapt the three constants and execute in the ego runtime.
const MON = "REPLACE_WITH_DEPLOY_MONITOR_DIR";
const AGENT_ID = "REPLACE_WITH_STABLE_AGENT_ID";
const SPACE = "REPLACE_WITH_UNIQUE_TASKSPACE";
const CONV = "REPLACE_WITH_COMPLETED_CONVERSATION_UUID";
if ([MON, AGENT_ID, SPACE, CONV].some((v) => v.startsWith("REPLACE_"))) throw new Error("ADAPTATION_REQUIRED");

import { pathToFileURL } from "node:url";
const { releaseAgentConversation, withAgentRegistry } = await import(pathToFileURL(MON + "/agent-space.mjs").href);
const { assertAgentOwnedTaskSpace } = await import(pathToFileURL(MON + "/taskspace-takeover.mjs").href);
const { isConversationUrl, assertManagedReleasePages } = await import(pathToFileURL(MON + "/page-recovery.mjs").href);
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
console.log(`RESULT=AGENT_SPACE_RELEASED finished=${result.finished} remaining=${result.active.length}`);
}
