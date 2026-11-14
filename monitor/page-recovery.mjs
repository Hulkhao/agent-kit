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

// A TaskSpace release may finish only its own registered conversations and
// managed blank Pages left by a browser restart.
export async function assertManagedReleasePages(pages, tabs, known) {
  const knownIds = new Set(known.map((id) => id.toLowerCase()));
  const pageUrls = await Promise.all(pages.map(async (page) => ({ page, url: await page.url() })));
  for (const { page, url } of pageUrls) {
    const id = conversationIdFromUrl(url, true);
    if (id && knownIds.has(id)) continue;
    if (!blankPageUrl(url)) throw recoveryError("SPACE_HAS_UNREGISTERED_PAGE_STOP");
    const matchingTabs = tabs.filter((tab) => tab.label === page.label ||
      (page.targetId && tab.targetId === page.targetId));
    if (matchingTabs.some((tab) => tab.openedBy !== "agent" ||
        tab.label !== page.label ||
        (tab.targetId && page.targetId && tab.targetId !== page.targetId))) {
      throw recoveryError("SPACE_HAS_UNOWNED_TAB_STOP");
    }
  }
  for (const tab of tabs) {
    if (tab.openedBy !== "agent") throw recoveryError("SPACE_HAS_UNOWNED_TAB_STOP");
    const id = conversationIdFromUrl(tab.url, true);
    if (id && knownIds.has(id)) continue;
    if (!blankPageUrl(tab.url) || !pageUrls.some(({ page, url }) =>
      blankPageUrl(url) && page.label === tab.label &&
      (!tab.targetId || !page.targetId || tab.targetId === page.targetId))) {
      throw recoveryError("SPACE_HAS_UNREGISTERED_PAGE_STOP");
    }
  }
}

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
    // The caller has verified ownership of this TaskSpace. A Page returned by
    // task.pages() remains managed even if restart lost its tab metadata.
    // Contradictory user ownership still blocks reuse.
    const contradictory = tabs.some((tab) =>
      (tab.label === page.label || (page.targetId && tab.targetId === page.targetId)) &&
      (tab.openedBy !== "agent" || tab.label !== page.label ||
        (page.targetId && tab.targetId && tab.targetId !== page.targetId)));
    if (contradictory) throw recoveryError("BLANK_PAGE_OWNERSHIP_UNPROVEN");
    const proof = tabs.filter((tab) => tab.label === page.label && tab.url === url &&
      tab.openedBy === "agent" && typeof tab.targetId === "string" && tab.targetId &&
      (!page.targetId || tab.targetId === page.targetId));
    if (proof.length > 1) throw recoveryError("BLANK_PAGE_AMBIGUOUS");
    return { page, needsNavigation: true, selectionEvidence: proof.length ? "AGENT_OWNED_BLANK_PAGE" : "MANAGED_BLANK_PAGE_RESTORED" };
  }

  // All remaining managed Pages belong to other, identified conversations.
  // A retry after an interrupted allocation reuses the blank Page above.
  const page = await task.newPage();
  return { page, needsNavigation: true, selectionEvidence: "NEW_PAGE_FOR_EXISTING_CONVERSATION" };
}
