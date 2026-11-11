// Narrow scope: protect ChatGPT dispatch, leaving unrelated browser usage intact.
// A subprocess launched by the approved manager is not a ZCode tool call.
const blocked = (reason) => ({ hookSpecificOutput: {
  hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason,
} });

export function checkDispatchTool(event) {
  if (event?.hook_event_name !== "PreToolUse") return null;
  const name = String(event.tool_name || "");
  const input = event.tool_input || {};
  const raw = JSON.stringify(input);
  const browserTool = /(?:ego.browser|browser|playwright|puppeteer)/i.test(name);
  const browserTarget = /chatgpt\.com|chat\.openai\.com|taskSpace\s*\(|listTaskSpaces\s*\(/i.test(raw);
  if (browserTool && browserTarget) return blocked("CHATGPT_DISPATCH_MANAGER_REQUIRED: use the managed web dispatch entry point");
  const shellTool = /(?:bash|shell|terminal|exec|powershell|command)/i.test(name);
  if (!shellTool) return null;
  // Shell-driven HTTP writes bypass the visual composer, readback and ledger.
  // Restrict this guard to commands that explicitly target ChatGPT backend APIs.
  if (/\/(?:backend-api|backend-anon)\//i.test(raw) &&
      /(?:curl|Invoke-RestMethod|Invoke-WebRequest|fetch\s*\(|axios\.|requests\.|httpx\.)/i.test(raw) &&
      /(?:\b(?:POST|PUT|PATCH|DELETE)\b|method[\s"':=]+(?:post|put|patch|delete)|axios\.(?:post|put|patch|delete)|requests\.(?:post|put|patch|delete)|httpx\.(?:post|put|patch|delete))/i.test(raw)) {
    return blocked("CHATGPT_DISPATCH_MANAGER_REQUIRED: direct ChatGPT backend API write denied");
  }
  // Protect both direct calls and generated one-off scripts whose command line
  // explicitly launches the browser automation runtime.
  if (/\bego-browser\s+(?:nodejs|run|eval)\b/i.test(raw)) return blocked("CHATGPT_DISPATCH_MANAGER_REQUIRED: direct ego-browser invocation denied");
  if (browserTarget && /(?:nodejs\s+-e|eval\s*\(|page\.goto\s*\(|page\.evaluate\s*\(|cdp\s*\()/i.test(raw)) {
    return blocked("CHATGPT_DISPATCH_MANAGER_REQUIRED: ad-hoc ChatGPT browser script denied");
  }
  return null;
}
