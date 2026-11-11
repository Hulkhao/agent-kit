import { checkDispatchTool } from "./policy.mjs";

try {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const result = checkDispatchTool(JSON.parse(raw));
  if (result) process.stdout.write(JSON.stringify(result));
} catch {
  // A broken hook must not silently waive an unsafe call.
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: "PreToolUse", permissionDecision: "deny",
    permissionDecisionReason: "CHATGPT_DISPATCH_GUARD_INPUT_INVALID",
  } }));
}
