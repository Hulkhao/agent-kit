// #27 Batch 2 re-review: injectable release-sweep unit. The release template
// (run inside the ego-browser runtime) is a thin adapter over this module; the
// behavioral tests inject fake task/pages/ledger/audit doubles instead of
// matching source text. Plain Node only — no browser globals here.
import { readFile, appendFile } from "node:fs/promises";
import { validateDispatchRecord } from "./dispatch-state.mjs";
import { conversationIdFromUrl } from "./page-recovery.mjs";

// P1-4 status unification (judgment recorded in the re-review report): the
// dispatch-state v2 validator (validateDispatchRecord) is the schema truth and
// its legal set does NOT contain "RELEASED" — no code path ever writes it.
// Unifying therefore narrows the SWEEP terminal set instead of widening the
// frozen schema: a ledger whose status is not in the validator set is
// structurally invalid here → unproven → kept (conservative default).
export const TERMINAL_DISPATCH = new Set(["COMPLETED", "ABORTED"]);

// Audit writer factory: one ndjson line per handled page (or per sweep-level
// failure). Only ids and reasons are recorded — never task or reply bodies.
export function makeSweepAudit({ auditFile, agentId, space, conversationUuid }) {
  return async (entry) => appendFile(auditFile, JSON.stringify({
    ts: new Date().toISOString(), action: "release-sweep",
    agentId, space, conversation: conversationUuid, ...entry,
  }) + "\n", "utf8");
}

// P1-4: a page's dispatch ledger counts ONLY when the record passes the FULL
// structural validation (validateDispatchRecord — a bare {"status":"COMPLETED"}
// object is rejected) AND anchors to the page's own conversation uuid and this
// TaskSpace. Unreadable / invalid / mismatched → null → LEDGER_UNPROVEN → kept.
export async function anchoredLedgerStatus(monitorDir, uuid, space) {
  try {
    const record = JSON.parse(
      await readFile(monitorDir + "/conversations/" + String(uuid).toLowerCase() + "/a-dispatch-state.json", "utf8"));
    if (!validateDispatchRecord(record)) return null;
    if (record.conversationUuid.toLowerCase() !== String(uuid).toLowerCase()) return null;
    if (record.taskSpace !== space) return null;
    return record.status;
  } catch { return null; }
}

// Conservative boundary (ruling §3.3 + re-review P1-2): a page is closed ONLY
// when it is provably a finished conversation page of THIS agent — registry
// known AND a structurally valid, conversation- and space-anchored TERMINAL
// ledger. Blank pages, unknown URLs, active ledgers and anything unproven or
// unattributable are kept. The release target itself is handled exclusively by
// the managed close/finish path, so a residual target page is kept, never
// double-closed here.
export function classifySweepPage({ uuid, conversationUuid, known, status }) {
  if (!uuid || !known.some((k) => typeof k === "string" && k.toLowerCase() === String(uuid).toLowerCase())) {
    return { decision: "kept", reason: "OWNERSHIP_UNPROVEN" };
  }
  if (String(uuid).toLowerCase() === String(conversationUuid).toLowerCase()) {
    return { decision: "kept", reason: "RELEASE_TARGET_RESIDUAL" };
  }
  if (status && TERMINAL_DISPATCH.has(status)) {
    return { decision: "closed", reason: "TEMP_RESULT_PAGE_FINISHED_DISPATCH" };
  }
  if (status) return { decision: "kept", reason: "ACTIVE_DISPATCH_LEDGER" };
  return { decision: "kept", reason: "LEDGER_UNPROVEN" };
}

// Sweep every page of the TaskSpace. Dependencies are injectable: `task` (with
// async pages()), `ledgerStatusOf(monitorDir, uuid, space)` and `audit(entry)`
// can be replaced by test doubles; defaults use the real ledger files and the
// ndjson audit writer. A page.close() failure, an enumeration failure or an
// audit-write failure all increment `failed` — the caller reports
// RESULT=AGENT_SPACE_RELEASE_SWEEP_FAILED and leaves the recoverable
// sweepPending flag in the registry (re-review P1-3). Idempotent: zero pages
// to close is a zero-close success.
export async function sweepTaskPages({
  task, monitorDir, agentId, space, conversationUuid, known, auditFile,
  ledgerStatusOf = anchoredLedgerStatus,
  audit = makeSweepAudit({ auditFile, agentId, space, conversationUuid }),
}) {
  let closed = 0;
  let kept = 0;
  let failed = 0;
  if (!task) return { closed, kept, failed };
  let remaining = [];
  try { remaining = await task.pages(); }
  catch (error) {
    failed++;
    await audit({ page: null, decision: "sweep-failed", reason: "PAGE_ENUMERATION_FAILED",
      code: String(error?.code || error?.message || "UNKNOWN").slice(0, 80) }).catch(() => { failed++; });
    return { closed, kept, failed };
  }
  for (const page of remaining) {
    let uuid = null;
    try { uuid = conversationIdFromUrl(await page.url(), true); } catch { uuid = null; }
    const status = uuid ? await ledgerStatusOf(monitorDir, uuid, space) : null;
    const verdict = classifySweepPage({ uuid, conversationUuid, known, status });
    let decision = verdict.decision;
    let reason = verdict.reason;
    if (decision === "closed") {
      try { await page.close(); closed++; }
      catch (error) {
        decision = "close-failed";
        failed++;
        reason = "PAGE_CLOSE_FAILED:" + String(error?.code || error?.message || "UNKNOWN").slice(0, 80);
      }
    } else kept++;
    try { await audit({ page: { label: page.label ?? null, uuid: uuid ?? null }, decision, reason }); }
    catch { failed++; } // an unauditable cleanup counts as incomplete, never silent
  }
  return { closed, kept, failed };
}

// P1-2 space-fate decision: ego's finish `keep` semantics are undocumented
// (the handbook only shows finish({keep:[]})), so finish may destroy the
// space together with pages the conservative boundary must keep. The space is
// therefore finished ONLY when it is provably empty: last conversation
// released, zero pages kept by the sweep, zero failures. Any kept page keeps
// the space alive for its owner to dispose of later.
export function shouldFinishSpace({ finished, hasTask, kept, failed }) {
  return Boolean(finished && hasTask && kept === 0 && failed === 0);
}

// P1-3: the zero-browser idempotent early exit applies ONLY when nothing is
// outstanding — no active conversation, no pending release intent, no
// unfinished sweep. A recorded sweepPending forces a real re-sweep.
export function releaseHasNothingOutstanding(entry, conversationUuid) {
  return Boolean(entry) && !entry.active?.includes(conversationUuid) &&
    !entry.releasePending && !entry.sweepPending;
}
