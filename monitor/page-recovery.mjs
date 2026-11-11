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
