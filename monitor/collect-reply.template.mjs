// Collect one finished reply from the Agent-owned ChatGPT conversation page.
const MON = "REPLACE_WITH_DEPLOY_MONITOR_DIR";
const AGENT_ID = "REPLACE_WITH_STABLE_AGENT_ID";
const SPACE = "REPLACE_WITH_UNIQUE_TASKSPACE";
const CONV = "REPLACE_WITH_CONVERSATION_UUID";
if ([MON, AGENT_ID, SPACE, CONV].some((value) => value.startsWith("REPLACE_"))) throw new Error("ADAPTATION_REQUIRED");

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const { readDispatchState, readComposerSurface } = await import(pathToFileURL(MON + "/dispatch-state.mjs").href);
const { extractDomReply, extractApiReply, saveReply } = await import(pathToFileURL(MON + "/reply-delivery.mjs").href);
const { assertAgentOwnedTaskSpace } = await import(pathToFileURL(MON + "/taskspace-takeover.mjs").href);
const { withAgentRegistry } = await import(pathToFileURL(MON + "/agent-space.mjs").href);
const { isConversationUrl } = await import(pathToFileURL(MON + "/page-recovery.mjs").href);

const record = await readDispatchState(MON);
const fast = JSON.parse(await readFile(MON + "/a-fast-state.json", "utf8"));
if (!record || record.status !== "ACCEPTED" || record.conversationUuid.toLowerCase() !== CONV.toLowerCase() ||
    record.taskSpace !== SPACE || !record.payload_sha256 || !fast.doneCandidate || fast.generating ||
    fast.dispatchId !== record.dispatchId || fast.lastMessageRole !== "assistant" ||
    !fast.lastMessageKey || fast.dispatchStatus !== "ACCEPTED") {
  throw new Error("COLLECT_REQUIRES_STABLE_ACCEPTED_REPLY");
}
const assigned = await withAgentRegistry((registry) => ({ changed: false, value: registry.agents[AGENT_ID] }));
if (assigned?.spaceName !== SPACE || !assigned.active?.includes(CONV)) throw new Error("COLLECT_AGENT_OWNERSHIP_INVALID");
const spaces = await listTaskSpaces();
const owned = spaces.find((space) => space.taskId === SPACE || space.name === SPACE);
assertAgentOwnedTaskSpace(owned, SPACE);
const task = await taskSpace(owned.id);
const tabs = await task.tabs();
if (tabs.some((tab) => tab.openedBy !== "agent")) throw new Error("COLLECT_UNOWNED_TAB");
const pages = await task.pages();
const matches = [];
for (const page of pages) {
  if (isConversationUrl(await page.url(), CONV, true)) matches.push(page);
}
if (matches.length !== 1) throw new Error("COLLECT_PAGE_NOT_UNIQUE");
const page = matches[0];
const first = await readComposerSurface(page);
const units = await page.evaluate(() => [...document.querySelectorAll("[data-content-search-unit-key]")].map((unit) => {
  const key = unit.getAttribute("data-content-search-unit-key") || "";
  const role = key.match(/:(user|assistant)$/)?.[1] || null;
  const selector = "[data-dil-response][data-dil-message-id]";
  const dil = role === "assistant" ? [
    ...(unit.matches(selector) ? [unit] : []),
    ...unit.querySelectorAll(selector),
  ] : [];
  return {
    role,
    text: unit.innerText || "",
    messageKey: dil.length === 1 ? dil[0].getAttribute("data-dil-message-id") : null,
  };
}));
const second = await readComposerSurface(page);
const stable = [first, second].every((surface) => surface.hostOk && surface.composerPresent &&
  surface.composerEmpty && !surface.generating && surface.lastMessageRole === "assistant" &&
  surface.lastMessageKey === fast.lastMessageKey &&
  surface.lastMessageTextLength === fast.lastMessageTextLength);
if (!stable || first.lastMessageTextLength !== second.lastMessageTextLength) throw new Error("COLLECT_PAGE_UNSTABLE");

let reply = extractDomReply(units, record.payload_sha256, fast.lastMessageKey, {
  displayHash: record.payload_display_sha256, baselineTailKey: record.baselineTailKey,
});
if (!reply) {
  // Conversation API can lag or return 404. Its failure is never proof of a dead page.
  const mapping = await page.evaluate(async (conversation) => {
    try {
      const session = await fetch("/api/auth/session", { credentials: "include" });
      if (!session.ok) return null;
      const token = (await session.json())?.accessToken;
      if (!token) return null;
      const response = await fetch("/backend-api/conversation/" + conversation, {
        credentials: "include", headers: { Authorization: "Bearer " + token },
      });
      if (!response.ok) return null;
      const data = await response.json();
      return { mapping: data?.mapping, current_node: data?.current_node };
    } catch { return null; }
  }, CONV);
  reply = extractApiReply(mapping, record.payload_sha256, { displayHash: record.payload_display_sha256 });
}
if (!reply) throw new Error("COLLECT_BOUNDARY_OR_FINALITY_UNVERIFIED");
const receipt = await saveReply(MON, record, reply, fast.lastMessageKey);
console.log("RESULT=REPLY_COLLECTED dispatchId=" + receipt.dispatchId + " bytes=" + receipt.bytes + " source=" + receipt.source);
