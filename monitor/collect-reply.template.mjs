// Collect one finished reply from the Agent-owned ChatGPT conversation page.
const MON = "REPLACE_WITH_DEPLOY_MONITOR_DIR";
const AGENT_ID = "REPLACE_WITH_STABLE_AGENT_ID";
const SPACE = "REPLACE_WITH_UNIQUE_TASKSPACE";
const CONV = "REPLACE_WITH_CONVERSATION_UUID";
if ([MON, AGENT_ID, SPACE, CONV].some((value) => value.startsWith("REPLACE_"))) throw new Error("ADAPTATION_REQUIRED");

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const { readDispatchState, readComposerSurface } = await import(pathToFileURL(MON + "/dispatch-state.mjs").href);
const { extractDomReply, extractDomReplyByBaseline, extractApiReply, apiTailFinality, saveReply } = await import(pathToFileURL(MON + "/reply-delivery.mjs").href);
const { assertAgentOwnedTaskSpace } = await import(pathToFileURL(MON + "/taskspace-takeover.mjs").href);
const { withAgentRegistry } = await import(pathToFileURL(MON + "/agent-space.mjs").href);
const { isConversationUrl } = await import(pathToFileURL(MON + "/page-recovery.mjs").href);

const record = await readDispatchState(MON);
const fast = JSON.parse(await readFile(MON + "/a-fast-state.json", "utf8"));
// #40: a PO_MANUAL ledger carries no payload fingerprint (the PO pasted the
// message themselves — 免 payload 指纹); its collection anchors on the
// attach-time baseline tail instead. A manual ledger without that baseline
// refuses like any other unprovable shape (fail-closed).
const manualSource = record?.source === "PO_MANUAL";
if (!record || record.status !== "ACCEPTED" || record.conversationUuid.toLowerCase() !== CONV.toLowerCase() ||
    record.taskSpace !== SPACE || (!record.payload_sha256 && !manualSource) ||
    (manualSource && typeof record.baselineTailKey !== "string") || !fast.doneCandidate || fast.generating ||
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
// #40: the PO-manual conversation's own page is opened by the PO
// (openedBy !== "agent") — it IS the human channel being tracked, so it must
// not trip the un-owned-tab stop. Any OTHER un-owned tab is still a stop.
if (tabs.some((tab) => tab.openedBy !== "agent" && !isConversationUrl(tab.url, CONV, true))) throw new Error("COLLECT_UNOWNED_TAB");
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

let reply = manualSource
  // #40: the reply boundary is the attach-time baseline tail — the PO's message
  // is unknowable to the agent, so there is no payload hash to anchor on.
  ? extractDomReplyByBaseline(units, fast.lastMessageKey, record.baselineTailKey)
  : extractDomReply(units, record.payload_sha256, fast.lastMessageKey, {
      displayHash: record.payload_display_sha256, baselineTailKey: record.baselineTailKey,
    });
// agent-kit#33 post-mortem evidence: the live body length at extraction time.
// Long threads virtualize turns out of the DOM, so this can legitimately shrink
// after a CALIBRATE refresh — the recorded doneLive* fields separate that from
// a server-side dead reply.
const domAnchorMissed = !reply;
const liveBodyLen = await page.evaluate(() => (document.body ? document.body.innerText.length : 0));
let apiFailure = null;
let finality = null;
if (!reply && !manualSource) {
  // Conversation API can lag or return 404. Its failure is never proof of a dead page.
  // (#40: skipped entirely for PO_MANUAL — both API extractors anchor on the
  // payload hash, which a manual ledger deliberately does not carry.)
  const api = await page.evaluate(async (conversation) => {
    try {
      const session = await fetch("/api/auth/session", { credentials: "include" });
      if (!session.ok) {
        console.error("COLLECT_API_FETCH stage=session status=" + session.status);
        return { ok: false, stage: "session", httpStatus: session.status };
      }
      const token = (await session.json())?.accessToken;
      if (!token) {
        console.error("COLLECT_API_FETCH stage=session-token status=" + session.status);
        return { ok: false, stage: "session-token", httpStatus: session.status };
      }
      const response = await fetch("/backend-api/conversation/" + conversation, {
        credentials: "include", headers: { Authorization: "Bearer " + token },
      });
      if (!response.ok) {
        console.error("COLLECT_API_FETCH stage=conversation status=" + response.status);
        return { ok: false, stage: "conversation", httpStatus: response.status };
      }
      const data = await response.json();
      return { ok: true, mapping: data?.mapping, current_node: data?.current_node };
    } catch (error) {
      // Surface the failure through the page console; the manager's stderr tail
      // carries it when the wrapper relays page output (523ed50 channel).
      console.error("COLLECT_API_FETCH stage=exception error=" + String(error && error.name || error));
      return { ok: false, stage: "exception", errorName: String(error && error.name || error) };
    }
  }, CONV);
  if (api && api.ok) {
    reply = extractApiReply(api, record.payload_sha256, { displayHash: record.payload_display_sha256 });
    if (!reply) finality = apiTailFinality(api, record.payload_sha256, { displayHash: record.payload_display_sha256 });
  } else {
    // Node-level copy of the fetch failure: reaches the manager's stderr tail
    // even when the page console is not relayed.
    apiFailure = api || { ok: false, stage: "exception", errorName: "UnknownError" };
    console.error("COLLECT_API_FETCH_NULL stage=" + apiFailure.stage +
      (apiFailure.httpStatus !== undefined ? " httpStatus=" + apiFailure.httpStatus : "") +
      (apiFailure.errorName ? " errorName=" + apiFailure.errorName : ""));
  }
}
if (!reply) {
  // agent-kit#33: never a bare failure — classify why the boundary/finality could
  // not be proven. Diagnostics and operator guidance only; no auto-remediation
  // (a dead reply must not be "repaired" by relaxing finality semantics).
  const details = [];
  if (domAnchorMissed) {
    details.push("COLLECT_DOM_ANCHOR_MISS payloadBytes=" + (record.payload_bytes ?? "null") +
      " liveBodyLen=" + liveBodyLen +
      (record.doneLiveBodyLen != null ? " doneLiveBodyLen=" + record.doneLiveBodyLen : ""));
  }
  if (apiFailure) {
    details.push("COLLECT_API_FETCH_NULL stage=" + apiFailure.stage +
      (apiFailure.httpStatus !== undefined ? " httpStatus=" + apiFailure.httpStatus : "") +
      (apiFailure.errorName ? " errorName=" + apiFailure.errorName : ""));
  } else if (finality) {
    details.push("COLLECT_FINALITY_NOT_REACHED end_turn=" + String(finality.endTurn) +
      " status=" + String(finality.status));
  }
  // A live window that shrank well below the DONE_CANDIDATE size (or a changed
  // tail identity) means the live page had more than the API/DOM can prove now:
  // the reply most likely died mid-generation on the server side.
  const shrank = Number.isFinite(record.doneLiveBodyLen) &&
    liveBodyLen * 1.25 < record.doneLiveBodyLen;
  const tailMoved = Boolean(record.doneLiveLastMessageKey &&
    fast.lastMessageKey !== record.doneLiveLastMessageKey);
  const diedServerSide = shrank || tailMoved;
  if (diedServerSide) {
    details.push("REPLY_GENERATION_DIED_SERVER_SIDE suspicion=live_had_more" +
      " doneLiveBodyLen=" + (record.doneLiveBodyLen ?? "null") + " liveBodyLen=" + liveBodyLen +
      (tailMoved ? " doneLiveLastMessageKey=" + record.doneLiveLastMessageKey : ""));
  }
  for (const detail of details) console.log("RECOVERY_DETAIL=" + detail);
  console.log(diedServerSide
    ? "OPERATOR_ACTION=回复疑似服务端生成中断，请到网页端确认后半段是否缺失；确认后可用 send-new 重派或人工收尾。"
    : "OPERATOR_ACTION=回复边界或终态未获证明，请到网页端人工核对该会话回复是否完整；确认完整可重试 collect，回复缺失可用 send-new 重派或人工收尾。");
  console.log("RESULT=COLLECT_BOUNDARY_OR_FINALITY_UNVERIFIED");
  process.exit(1);
}
const receipt = await saveReply(MON, record, reply, fast.lastMessageKey);
console.log("RESULT=REPLY_COLLECTED dispatchId=" + receipt.dispatchId + " bytes=" + receipt.bytes + " source=" + receipt.source);
