// Wrapper layer: composes the pure checkDispatchTool policy (kept unchanged,
// in policy.mjs) with the read-only wake-context detection from wake-context.mjs.
//
// Output contract (ruling §2.4, frozen):
// - deny + wake context coexist inside one hookSpecificOutput; the deny reason
//   is passed through byte-for-byte, never rewritten.
// - a non-denied call with anomalies emits ONLY additionalContext (never an
//   explicit allow — absence of permissionDecision leaves the decision to the
//   host's normal permission flow).
// - broken input stays fail-closed deny.
// - every wake-context failure (profile missing, file errors, ledger errors)
//   degrades to "no injection" and can never relax or amplify a decision.
import { readFile, writeFile, rename } from "node:fs/promises";
import { checkDispatchTool } from "./policy.mjs";
import {
  detectWakeAnomalies, formatWakeContext, readMonitorRoots,
  parseLedger, selectWakeEvents, withInjection,
  DEFAULT_PROFILE_PATH, DEFAULT_LEDGER_PATH,
} from "./wake-context.mjs";

// Test seams: the production paths are the ~/.agents defaults; tests may point
// these at fixture directories via environment overrides. Overrides only
// change where read-only config/ledger files are looked up — they cannot
// change any permission decision.
const profilePath = process.env.EGO_WAKE_GUARD_PROFILE_PATH || DEFAULT_PROFILE_PATH;
const ledgerPath = process.env.EGO_WAKE_GUARD_LEDGER_PATH || DEFAULT_LEDGER_PATH;

async function saveLedger(ledger, now) {
  // Atomic write, best effort. Failure here means at worst a repeated
  // injection on the next call — it never changes a permission decision.
  const temporary = ledgerPath + ".tmp";
  await writeFile(temporary, JSON.stringify(ledger, null, 2) + "\n", "utf8");
  await rename(temporary, ledgerPath);
}

async function wakeContext(event, now = Date.now()) {
  try {
    // monitorRoots is explicitly configured in the machine-local ego profile.
    // Missing or empty disables detection: zero output. That is a config gap,
    // NOT a health signal — it never asserts "monitor healthy".
    const profile = JSON.parse(await readFile(profilePath, "utf8"));
    const roots = readMonitorRoots(profile);
    if (!roots.length) return null;
    let ledger;
    try { ledger = parseLedger(await readFile(ledgerPath, "utf8")); }
    catch { ledger = parseLedger(null); } // unreadable ledger: skip dedup (worst case: repeated injection)
    const { events } = await detectWakeAnomalies(roots, now);
    if (!events.length) return null; // healthy state: zero output
    const sessionId = event?.sessionId ?? event?.session_id ?? "global";
    // Observation A (#27 ruling): per-event cooldown — a cooled event never
    // suppresses its batch-mates; in-batch duplicates collapse to one
    // identity; at most 3 events are displayed with an additional count for
    // the capped tail (the pre-#27 whole-block suppression is abolished).
    const { shown, additional } = selectWakeEvents(events, ledger, sessionId, now);
    if (!shown.length) return null; // every identity cooled or duplicated
    const context = formatWakeContext(shown.map(({ event: shownEvent }) => shownEvent), 3, additional);
    // The rate-limit ledger write is best-effort ONLY (WG-02): the anomaly is
    // already identified, so it must still be injected. A write failure means
    // at worst a repeated injection on the next call — never a dropped wake.
    // Only DISPLAYED events are stamped: a capped event was never shown and
    // must stay eligible for the next block.
    let next = ledger;
    for (const { key } of shown) next = withInjection(next, key, now);
    try { await saveLedger(next, now); }
    catch { /* ledger unwritable: skip dedup bookkeeping, keep the injection */ }
    return context;
  } catch {
    // Any detection failure must not interfere with the guard's decision.
    return null;
  }
}

try {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const event = JSON.parse(raw);
  // 1. The pure policy decides first; its deny object (reason included) is the
  //    base output. If it throws, the catch below fail-closes as before.
  const deny = checkDispatchTool(event);
  // 2. Wake detection is additive context only.
  const context = await wakeContext(event);
  if (deny) {
    if (context) deny.hookSpecificOutput.additionalContext = context;
    process.stdout.write(JSON.stringify(deny));
  } else if (context) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: {
      hookEventName: "PreToolUse", additionalContext: context,
    } }));
  }
} catch {
  // A broken hook must not silently waive an unsafe call.
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: "PreToolUse", permissionDecision: "deny",
    permissionDecisionReason: "CHATGPT_DISPATCH_GUARD_INPUT_INVALID",
  } }));
}
