// Resolve a monitored conversation among multiple managed Pages using URL evidence.
// A multi-Page space is never selected by label alone when the target UUID is not unique.
export function conversationIdFromUrl(rawUrl, exactHost = false) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { return null; }
  const hostOk = exactHost ? parsed.hostname === "chatgpt.com" :
    parsed.hostname === "chatgpt.com" || parsed.hostname.endsWith(".chatgpt.com");
  if (!hostOk || parsed.protocol !== "https:") return null;
  // Both ordinary and project conversations end in /c/<UUID>.
  const match = parsed.pathname.match(/(?:^|\/)c\/([0-9a-f-]{36})\/?$/i);
  return match?.[1]?.toLowerCase() || null;
}

export function isConversationUrl(rawUrl, conversationUuid, exactHost = false) {
  return typeof conversationUuid === "string" &&
    conversationIdFromUrl(rawUrl, exactHost) === conversationUuid.toLowerCase();
}

export async function selectUniqueConversationPage(pages, conversationUuid) {
  if (!Array.isArray(pages) || pages.length < 2) {
    throw new TypeError("PAGE_URL_SELECTION_REQUIRES_MULTIPLE_PAGES");
  }
  if (typeof conversationUuid !== "string" || !conversationUuid) {
    throw new TypeError("INVALID_CONVERSATION_UUID");
  }

  const matches = [];
  for (const page of pages) {
    let currentUrl;
    try {
      currentUrl = await page.url();
    } catch (cause) {
      const error = new Error("PAGE_URL_INSPECTION_FAILED", { cause });
      error.code = "PAGE_URL_INSPECTION_FAILED";
      throw error;
    }

    if (isConversationUrl(currentUrl, conversationUuid)) {
      matches.push(page);
    }
  }

  if (matches.length !== 1) {
    const code = matches.length > 1 ? "PAGE_URL_MATCH_AMBIGUOUS" : "PAGE_URL_MATCH_NOT_FOUND";
    const error = new Error(code);
    error.code = code;
    throw error;
  }
  return matches[0];
}

const recoveryError = (code) => Object.assign(new Error(code), { code });
const blankPageUrl = (url) => url === "about:blank" || url === "chrome://new-tab-page/";

// Existing-conversation sends can restore an agent-owned Page without operator intervention.
// The caller must verify the TaskSpace owner and account pin before invoking this function.
export async function recoverConversationPage(task, conversationUuid) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(conversationUuid || "")) {
    throw recoveryError("INVALID_CONVERSATION_UUID");
  }
  const pages = await task.pages();
  const tabs = await task.tabs();
  const matches = [];
  const blanks = [];
  for (const page of pages) {
    let url;
    try { url = await page.url(); }
    catch { throw recoveryError("PAGE_URL_INSPECTION_FAILED"); }
    if (isConversationUrl(url, conversationUuid)) matches.push(page);
    else if (blankPageUrl(url)) blanks.push({ page, url });
    else if (!conversationIdFromUrl(url)) throw recoveryError("PAGE_URL_MATCH_NOT_FOUND");
  }
  if (matches.length > 1) throw recoveryError("PAGE_URL_MATCH_AMBIGUOUS");
  if (matches.length === 1) {
    return { page: matches[0], needsNavigation: false, selectionEvidence: "UNIQUE_CONVERSATION_URL" };
  }

  const unmanaged = tabs.filter((tab) => !tab.label && isConversationUrl(tab.url, conversationUuid, true));
  if (unmanaged.length > 1) throw recoveryError("PAGE_URL_MATCH_AMBIGUOUS");
  if (unmanaged.length === 1) {
    const tab = unmanaged[0];
    if (tab.openedBy !== "agent" || !tab.page || !tab.targetId ||
        (tab.page.targetId && tab.page.targetId !== tab.targetId)) {
      throw recoveryError("PAGE_ADOPTION_EVIDENCE_INCOMPLETE");
    }
    const page = await task.adopt(tab.page);
    return { page, needsNavigation: false, selectionEvidence: "AGENT_OWNED_TAB_ADOPTED" };
  }

  if (blanks.length > 1) throw recoveryError("BLANK_PAGE_AMBIGUOUS");
  if (blanks.length === 1) {
    const { page, url } = blanks[0];
    const proof = tabs.filter((tab) => tab.label === page.label && tab.url === url &&
      tab.openedBy === "agent" && typeof tab.targetId === "string" && tab.targetId &&
      (!page.targetId || tab.targetId === page.targetId));
    if (proof.length !== 1) throw recoveryError("BLANK_PAGE_OWNERSHIP_UNPROVEN");
    return { page, needsNavigation: true, selectionEvidence: "AGENT_OWNED_BLANK_PAGE" };
  }

  // All remaining managed Pages belong to other, identified conversations.
  // A retry after an interrupted allocation reuses the blank Page above.
  const page = await task.newPage();
  return { page, needsNavigation: true, selectionEvidence: "NEW_PAGE_FOR_EXISTING_CONVERSATION" };
}
