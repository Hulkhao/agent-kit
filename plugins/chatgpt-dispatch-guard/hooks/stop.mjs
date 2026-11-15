// Stop-event hook: one-shot handoff when the host tries to end its turn while
// a wake anomaly is still unhandled (agent-kit #25 gap 3, plan A).
//
// Output contract (ruling §2.1/§2.4, frozen):
// - anomaly present and not in cooldown -> {"decision":"block","reason":"[AGENT_KIT_WAKE_GUARD] ..."}
//   (Stop's decision:block is NOT a PreToolUse permission decision — this hook
//   never emits permissionDecision and never grants or denies a tool call.)
// - healthy state, suppressed continuation or broken input -> zero output.
//
// Double insurance against blocking the same stop flow repeatedly:
// 1. stop_hook_active === true -> never block (the host is already continuing
//    because of a previous Stop block).
// 2. a per-session stopBlocks entry in the rate-limit ledger suppresses further
//    blocks for 90s (one forced continuation per stop flow, scoped to the
//    session that raised it — different sessions never suppress each other).
import { readFile, writeFile, rename } from "node:fs/promises";
import {
  detectWakeAnomalies, summarizeEvents, readMonitorRoots,
  parseLedger, stopCooldownActive, withStopBlock,
  DEFAULT_PROFILE_PATH, DEFAULT_LEDGER_PATH,
} from "./wake-context.mjs";

// Test seams, same semantics as in pre-tool-use.mjs: path lookups only, no
// decision semantics can be changed by environment.
const profilePath = process.env.EGO_WAKE_GUARD_PROFILE_PATH || DEFAULT_PROFILE_PATH;
const ledgerPath = process.env.EGO_WAKE_GUARD_LEDGER_PATH || DEFAULT_LEDGER_PATH;

async function saveLedger(ledger) {
  const temporary = ledgerPath + ".tmp";
  await writeFile(temporary, JSON.stringify(ledger, null, 2) + "\n", "utf8");
  await rename(temporary, ledgerPath);
}

try {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const event = JSON.parse(raw);
  if (event?.stop_hook_active === true) process.exit(0); // insurance 1
  // Session-scoped cooldown (WG-04): the ledger key is the ZCode session id, so
  // each session's 90s cooldown is independent. Events without an id share the
  // "global" fallback key (which also receives migrated pre-session ledgers).
  const sessionId = event?.sessionId ?? event?.session_id ?? "global";
  let ledger;
  try { ledger = parseLedger(await readFile(ledgerPath, "utf8")); }
  catch { ledger = parseLedger(null); } // unreadable ledger: cooldown unenforceable
  if (stopCooldownActive(ledger, sessionId, Date.now())) process.exit(0); // insurance 2
  const profile = JSON.parse(await readFile(profilePath, "utf8"));
  const roots = readMonitorRoots(profile);
  if (!roots.length) process.exit(0); // config gap, not health; nothing to hand off
  const { events } = await detectWakeAnomalies(roots, Date.now());
  const summary = summarizeEvents(events);
  if (!summary) process.exit(0); // healthy: zero output
  // Record the block before emitting it. If the ledger write fails, blocking
  // still happens — the worst case is one extra continuation, never a silent
  // pass over an unhandled wake.
  await saveLedger(withStopBlock(ledger, sessionId, Date.now())).catch(() => {});
  process.stdout.write(JSON.stringify({ decision: "block", reason: "[AGENT_KIT_WAKE_GUARD] " + summary }));
} catch {
  // Unparseable input: stop_hook_active is unknown, so blocking could loop the
  // host. Zero output here is safe — tool-call safety stays with PreToolUse.
}
