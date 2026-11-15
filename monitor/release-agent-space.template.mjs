// Run through ego-browser after the Agent has extracted and handled the final reply.
// This file is a template: adapt the constants and execute in the ego runtime.
const MON = "REPLACE_WITH_DEPLOY_MONITOR_DIR";
const AGENT_ID = "REPLACE_WITH_STABLE_AGENT_ID";
const SPACE = "REPLACE_WITH_UNIQUE_TASKSPACE";
const CONV = "REPLACE_WITH_COMPLETED_CONVERSATION_UUID";
if ([MON, AGENT_ID, SPACE, CONV].some((v) => v.startsWith("REPLACE_"))) throw new Error("ADAPTATION_REQUIRED");

import { pathToFileURL } from "node:url";
const { releaseAgentConversation, withAgentRegistry, markAgentSweepPending, clearAgentSweepPending } =
  await import(pathToFileURL(MON + "/agent-space.mjs").href);
const { assertAgentOwnedTaskSpace } = await import(pathToFileURL(MON + "/taskspace-takeover.mjs").href);
const { isConversationUrl, assertManagedReleasePages } = await import(pathToFileURL(MON + "/page-recovery.mjs").href);
// #27 re-review: the sweep is a thin adapter over the injectable unit — the
// classification, ledger anchoring and audit behavior live in release-sweep.mjs.
const { sweepTaskPages, makeSweepAudit, shouldFinishSpace, releaseHasNothingOutstanding } =
  await import(pathToFileURL(MON + "/release-sweep.mjs").href);

const assigned = await withAgentRegistry((registry) => ({ changed: false, value: registry.agents[AGENT_ID] }));
if (assigned?.spaceName !== SPACE || !assigned.known?.includes(CONV)) throw new Error("CONVERSATION_NOT_REGISTERED");
// #27 re-review P1-3: the zero-browser idempotent early exit only applies when
// NOTHING is outstanding — no active conversation, no pending release intent,
// no unfinished sweep. A recorded sweepPending forces a real re-sweep below.
if (releaseHasNothingOutstanding(assigned, CONV)) {
  console.log(`RESULT=AGENT_SPACE_RELEASED finished=${assigned.active.length === 0} remaining=${assigned.active.length}`);
} else {
const spaces = await listTaskSpaces();
const owned = spaces.find((space) => space.taskId === SPACE || space.name === SPACE);
if (owned) assertAgentOwnedTaskSpace(owned, SPACE);
if (!owned && !(assigned.releasePending?.conversationUuid === CONV && assigned.releasePending.finished) &&
    !assigned.sweepPending) {
  throw new Error("TASKSPACE_NOT_FOUND");
}
const task = owned ? await taskSpace(owned.id) : null;
const tabs = task ? await task.tabs() : [];
const pages = task ? await task.pages() : [];
// Preflight before writing releasePending. Restart blanks require verified
// TaskSpace ownership, managed Page evidence, and no contradictory user tab.
if (task) await assertManagedReleasePages(pages, tabs, assigned.known);
const matches = [];
for (const page of pages) {
  if (isConversationUrl(await page.url(), CONV, true)) matches.push(page);
}
// On a sweepPending rerun the release is already committed (no active, no
// releasePending) and the target page is expected to be gone — an empty match
// set is the normal recovery shape there, not a stop condition.
const releaseCommitted = !assigned.active.includes(CONV) && !assigned.releasePending;
if (matches.length > 1 ||
    (matches.length === 0 && !releaseCommitted &&
     !(assigned.releasePending?.conversationUuid === CONV &&
       (assigned.releasePending.finished || Boolean(task))))) {
  throw new Error("COMPLETED_PAGE_NOT_UNIQUE_STOP");
}
const target = matches[0] || null;

// #27 re-review P1-3: intent-first — record the sweep intent BEFORE any browser
// mutation, mirroring the releasePending discipline. A crash at any later point
// leaves sweepPending behind, so the rerun performs a real re-sweep instead of
// silently reporting success over an unfinished cleanup.
await markAgentSweepPending({ agentId: AGENT_ID, spaceName: SPACE, conversationUuid: CONV });

const result = await releaseAgentConversation({
  agentId: AGENT_ID, spaceName: SPACE, conversationUuid: CONV,
  alreadyReleased: async (entry) => entry.releasePending?.conversationUuid === CONV &&
    (entry.releasePending.finished ? !task : target === null),
  closePage: async () => { if (!target) throw new Error("COMPLETED_PAGE_NOT_FOUND"); await target.close(); },
  // #27 re-review P1-2: the last conversation no longer uses
  // task.finish({keep:[]}) — ego's finish `keep` semantics are undocumented
  // (the handbook only shows keep:[]), so a blanket finish would destroy pages
  // the conservative boundary must keep. The managed path closes ONLY the
  // release-target page; the sweep below classifies every remaining page and
  // decides the space's fate (finish only a provably empty space).
  finishSpace: async (entry) => {
    if (!task || (!target && !entry.releasePending?.finished)) throw new Error("COMPLETED_SPACE_NOT_FOUND");
    if (target) await target.close();
  },
});

// #27 re-review (ruling §3.3 + P1-2/P1-4): every remaining page is classified
// by the injectable unit in release-sweep.mjs. Closed = registry-known AND a
// structurally valid, conversation- and space-anchored TERMINAL dispatch
// ledger (COMPLETED/ABORTED — "RELEASED" is not a real ledger state, see
// release-sweep.mjs TERMINAL_DISPATCH). Active / unproven / blank /
// unattributable pages are kept. Every handled page leaves one audit line;
// any failure increments failed and is reported truthfully below.
const sweepAuditFile = MON + "/a-release-sweep-audit.ndjson";
const sweep = await sweepTaskPages({
  task, monitorDir: MON, agentId: AGENT_ID, space: SPACE, conversationUuid: CONV,
  known: assigned.known, auditFile: sweepAuditFile,
});
console.log(`RELEASE_SWEEP closed=${sweep.closed} kept=${sweep.kept} backfilled=${sweep.backfilled} failed=${sweep.failed} unconfirmed=${sweep.unconfirmed}`);

// Space fate (P1-2): finish ONLY a provably empty space. When the sweep kept
// any page (active dispatch, unproven ledger, blank, unattributable), the
// space stays alive with those pages for their owner to dispose of later —
// the registry already records the release as complete.
if (shouldFinishSpace({ finished: result.finished, hasTask: Boolean(task), kept: sweep.kept, failed: sweep.failed })) {
  const audit = makeSweepAudit({ auditFile: sweepAuditFile, agentId: AGENT_ID, space: SPACE, conversationUuid: CONV });
  try { await task.finish({ keep: [] }); }
  catch (error) {
    sweep.failed++;
    await audit({ page: null, decision: "sweep-failed",
      reason: "SPACE_FINISH_FAILED:" + String(error?.code || error?.message || "UNKNOWN").slice(0, 80) })
      .catch(() => { sweep.failed++; });
  }
}

if (sweep.failed > 0 || sweep.unconfirmed > 0) {
  // sweepPending intentionally stays: the rerun release performs a real
  // re-sweep (recoverable state, re-review P1-3) and unconfirmed close-intents
  // are backfilled from the persisted intent record (re-review② P1-A.5/.7).
  console.log(`RESULT=AGENT_SPACE_RELEASE_SWEEP_FAILED closed=${sweep.closed} kept=${sweep.kept} failed=${sweep.failed}`);
} else {
  // The sweep (and, when applicable, the empty-space finish) succeeded AND
  // every close-intent has an audit disposition: only now is the release
  // complete and the recoverable flag cleared (re-review② P1-A.7). Repeat
  // calls take the zero-browser early exit at the top.
  await clearAgentSweepPending({ agentId: AGENT_ID, spaceName: SPACE, conversationUuid: CONV });
  console.log(`RESULT=AGENT_SPACE_RELEASED finished=${result.finished} remaining=${result.active.length}`);
}
}
