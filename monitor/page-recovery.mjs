// Resolve a monitored conversation among multiple managed Pages using URL evidence.
// A multi-Page space is never selected by label alone when the target UUID is not unique.
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

    let parsed;
    try {
      parsed = new URL(currentUrl);
    } catch {
      continue;
    }
    const chatGptHost = parsed.hostname === "chatgpt.com" || parsed.hostname.endsWith(".chatgpt.com");
    if (chatGptHost && parsed.pathname.split("/").includes(conversationUuid)) {
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
