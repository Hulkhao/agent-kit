// #27 Batch 2 re-review: injectable release-sweep unit. The release template
// (run inside the ego-browser runtime) is a thin adapter over this module; the
// behavioral tests inject fake task/pages/ledger/audit doubles instead of
// matching source text. Plain Node only — no browser globals here.
import { readFile, appendFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
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
//
// #27 Batch 3 fix round (P1-E): the close decision now runs through the page
// LABEL LIFECYCLE classifier below, whose basis is the page's ORIGIN, not its
// attribution provability — a registered fixed-session page can carry a
// COMPLETED ledger too, so "ledger terminal + known" alone never closes a page.
export function classifySweepPage({ uuid, conversationUuid, known, status, dispatchCreated }) {
  if (!uuid || !known.some((k) => typeof k === "string" && k.toLowerCase() === String(uuid).toLowerCase())) {
    return { decision: "kept", reason: "OWNERSHIP_UNPROVEN" };
  }
  if (String(uuid).toLowerCase() === String(conversationUuid).toLowerCase()) {
    return { decision: "kept", reason: "RELEASE_TARGET_RESIDUAL" };
  }
  const verdict = classifyPageLabelLifecycle({ conversationUuid: uuid, known, ledgerStatus: status, dispatchCreated });
  if (verdict.lifecycle === PAGE_LABEL_LIFECYCLE.DISPATCH_TEMP && verdict.closable) {
    return { decision: "closed", reason: verdict.reason };
  }
  return { decision: "kept", reason: verdict.reason };
}

// ---- #27 Batch 3 fix round (P1-E): two page-label lifecycles with a RELIABLE
// distinction basis. The frozen ruling (§四.4) fixed-session labels are
// long-lived: only their OWN managed release may close them; dispatch-temp
// labels are closed once provably finished dispatch residue. The planner's
// re-review rejected the previous basis (attribution provability) because a
// REGISTERED fixed-session page can equally carry a COMPLETED ledger —
// 归属 ≠ 生命周期. The basis here is the page's durable ORIGIN record:
//   DISPATCH_TEMP  — the conversation+page was CREATED by the managed new-chat
//     dispatch allocation flow. Durable writer-anchored evidence:
//     a-new-request.json in the conversation's own ledger directory (written
//     exclusively before the browser is touched, carried into conversations/
//     by the binding rename — see dispatch-manager bindNewConversation).
//   FIXED_SESSION — every other registry-known conversation page (standing
//     session pages reached through `send` page recovery, no allocation
//     record). Never closable by any sweep; only their own release closes
//     them. Unattributable pages stay FIXED_SESSION/kept (fail-closed, the
//     release-sweep conservative default is unchanged).
// Lifecycle is decided at creation time and never inferred back from a ledger
// status: a COMPLETED ledger on a fixed-session page does not make it temp.
export const PAGE_LABEL_LIFECYCLE = Object.freeze({
  FIXED_SESSION: "fixed-session",
  DISPATCH_TEMP: "dispatch-temp",
});

export function classifyPageLabelLifecycle({ conversationUuid = null, known = [], ledgerStatus = null, dispatchCreated = false } = {}) {
  const knownList = Array.isArray(known) ? known : [];
  const ownershipProven = typeof conversationUuid === "string" &&
    knownList.some((k) => typeof k === "string" && k.toLowerCase() === conversationUuid.toLowerCase());
  if (!ownershipProven) {
    return { lifecycle: PAGE_LABEL_LIFECYCLE.FIXED_SESSION, closable: false, reason: "OWNERSHIP_UNPROVEN" };
  }
  if (dispatchCreated !== true) {
    return { lifecycle: PAGE_LABEL_LIFECYCLE.FIXED_SESSION, closable: false, reason: "FIXED_SESSION_PAGE" };
  }
  if (ledgerStatus === "COMPLETED" || ledgerStatus === "ABORTED") {
    return { lifecycle: PAGE_LABEL_LIFECYCLE.DISPATCH_TEMP, closable: true, reason: "TEMP_RESULT_PAGE_FINISHED_DISPATCH" };
  }
  if (typeof ledgerStatus === "string" && ledgerStatus !== "") {
    return { lifecycle: PAGE_LABEL_LIFECYCLE.DISPATCH_TEMP, closable: false, reason: "ACTIVE_DISPATCH_LEDGER" };
  }
  return { lifecycle: PAGE_LABEL_LIFECYCLE.DISPATCH_TEMP, closable: false, reason: "LEDGER_UNPROVEN" };
}

// The durable dispatch-creation evidence for one conversation: its own
// a-new-request.json, verifying the client requestId ↔ real conversationUuid
// ASSOCIATION bindNewConversation persists at binding time, anchored to the
// page's uuid AND this TaskSpace. P1-E (re-review round 2): the pre-fix check
// compared request.requestId (the CLIENT dispatch UUID) against the real
// conversation UUID — a comparison that never holds in the real send-new flow,
// so every production temp page read as FIXED_SESSION. ENOENT, a missing
// association field (pre-fix bound records — they heal in place on the next
// send-new replay of the same requestId, see bindNewConversation) or any
// mismatch/unreadable file is `false` — an unprovable origin is never promoted
// to "dispatch-created" (fail-closed: the page stays open).
const REQUEST_ID_PATTERN = /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;

export async function anchoredDispatchCreated(monitorDir, uuid, space) {
  try {
    const request = JSON.parse(
      await readFile(monitorDir + "/conversations/" + String(uuid).toLowerCase() + "/a-new-request.json", "utf8"));
    return typeof request?.requestId === "string" && REQUEST_ID_PATTERN.test(request.requestId) &&
      typeof request?.conversationUuid === "string" &&
      request.conversationUuid.toLowerCase() === String(uuid).toLowerCase() &&
      request?.space === space &&
      typeof request?.agentId === "string" && request.agentId !== "" &&
      /^[a-f\d]{64}$/i.test(request?.payloadSha256 || "");
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// P1-A close-intent design. Storage form: intents live in the SAME
// a-release-sweep-audit.ndjson as the final results — one designated evidence
// file (no second write-failure surface, no evidence split across files),
// distinguishable by decision:"close-intent" plus a unique intentId that every
// disposition line references. "Intent without confirmation" is independently
// discoverable by scanning the file for intents whose intentId no later
// disposition line references. Rationale mirrored in docs/OPERATIONS.md §3.3.
// ---------------------------------------------------------------------------

// Load this release's open (unconfirmed) close-intents from the audit trail.
// ENOENT = the trail does not exist yet = no intents (trustworthy). A corrupt
// line makes the trail unverifiable → untrustworthy → the caller must NOT
// clear sweepPending this run (fail-closed). Any later line that references an
// intentId with a decision other than "close-intent" is a disposition of that
// intent (closed / close-failed / closed-backfilled / kept-superseded) and
// confirms it.
export async function loadSweepIntents(auditFile, { agentId, space, conversationUuid }) {
  let raw;
  try { raw = await readFile(auditFile, "utf8"); }
  catch (error) {
    if (error.code === "ENOENT") return { unconfirmed: new Map(), trustworthy: true };
    return { unconfirmed: new Map(), trustworthy: false };
  }
  const open = new Map(); // uuid(lower) -> intent line
  const confirmed = new Set();
  try {
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (entry?.action !== "release-sweep" || entry.agentId !== agentId ||
          entry.space !== space || entry.conversation !== conversationUuid) continue;
      if (entry.decision === "close-intent" && entry.intentId && entry.page?.uuid) {
        open.set(String(entry.page.uuid).toLowerCase(), entry);
      } else if (entry.intentId && entry.decision !== "close-intent") {
        confirmed.add(entry.intentId);
      }
    }
  } catch { return { unconfirmed: new Map(), trustworthy: false }; }
  for (const [uuidLower, intent] of [...open]) {
    if (confirmed.has(intent.intentId)) open.delete(uuidLower);
  }
  return { unconfirmed: open, trustworthy: true };
}

// Sweep every page of the TaskSpace. Dependencies are injectable: `task` (with
// async pages()), `ledgerStatusOf(monitorDir, uuid, space)` and `audit(entry)`
// can be replaced by test doubles; defaults use the real ledger files and the
// ndjson audit writer.
//
// Failure accounting (documented in docs/OPERATIONS.md §3.3): every page.close()
// failure, every audit WRITE failure (= one missing evidence line) and every
// page forbidden from closing because its intent could not be persisted counts
// into `failed`; `unconfirmed` counts intents still lacking a disposition.
// The caller reports RESULT=AGENT_SPACE_RELEASE_SWEEP_FAILED when either is
// non-zero and leaves sweepPending in the registry (re-review P1-A/P1-3).
// Idempotent: zero pages to close with a fully confirmed trail is a zero-close
// success.
export async function sweepTaskPages({
  task, monitorDir, agentId, space, conversationUuid, known, auditFile,
  ledgerStatusOf = anchoredLedgerStatus,
  dispatchCreatedOf = anchoredDispatchCreated,
  audit = makeSweepAudit({ auditFile, agentId, space, conversationUuid }),
}) {
  let closed = 0;
  let kept = 0;
  let failed = 0;
  let backfilled = 0;
  const prior = await loadSweepIntents(auditFile, { agentId, space, conversationUuid });
  if (!prior.trustworthy) failed++; // unverifiable trail: fail closed this run
  let auditBroken = !prior.trustworthy;
  const open = prior.unconfirmed; // uuid(lower) -> open intent (intentId reused)
  // Intents carried over from a PRIOR run are backfillable when their page is
  // positively absent. An intent born in THIS run whose disposition write just
  // failed stays open instead (P1-A.4): the rerun re-proves absence and
  // backfills it (P1-A.5) — never fabricate a confirmation inside the run
  // whose own writer is failing.
  const carried = new Set(prior.unconfirmed.keys());

  // An audit write failure = one missing evidence line. It also switches the
  // run into no-close mode: without a persistable intent, a destructive close
  // must not happen (P1-A.2/.6).
  const write = async (entry) => {
    try { await audit(entry); return true; }
    catch { auditBroken = true; failed++; return false; }
  };

  // pageId is an AUDIT-RECORD field only — a page label never proves identity;
  // identity comes exclusively from the conversation URL's valid uuid.
  const pageId = (page, uuid) => ({ label: page?.label ?? null, uuid: uuid ?? null });
  let remaining = [];
  let enumerated = false;
  // A page whose URL read threw OR parsed to no valid conversation uuid (e.g.
  // about:blank — assertManagedReleasePages may legitimately pass a managed
  // blank) has UNKNOWABLE identity: while any such page exists, this run
  // cannot prove a carried intent's page is absent, so absence backfill is
  // blocked (re-review 4fa17a8: a surviving-but-blanked page must never be
  // audited as closed).
  let sawUnidentifiablePage = false;
  if (task) {
    try { remaining = [...await task.pages()]; enumerated = true; }
    catch (error) {
      failed++;
      await write({ page: null, decision: "sweep-failed", reason: "PAGE_ENUMERATION_FAILED",
        code: String(error?.code || error?.message || "UNKNOWN").slice(0, 80) });
    }
  }

  for (const page of enumerated ? remaining : []) {
    let uuid = null;
    try { uuid = conversationIdFromUrl(await page.url(), true); }
    catch { uuid = null; }
    if (!uuid) sawUnidentifiablePage = true;
    const status = uuid ? await ledgerStatusOf(monitorDir, uuid, space) : null;
    // P1-E: the lifecycle basis is read alongside the ledger — a page is only
    // ever closable when its durable dispatch-creation record anchors it.
    const dispatchCreated = uuid ? await dispatchCreatedOf(monitorDir, uuid, space) === true : false;
    const verdict = classifySweepPage({ uuid, conversationUuid, known, status, dispatchCreated });
    const priorIntent = uuid ? open.get(uuid.toLowerCase()) : null;
    let decision = verdict.decision;
    let reason = verdict.reason;
    let intentId = priorIntent ? priorIntent.intentId : null;

    let dispositionWritten = false;
    if (decision === "closed") {
      if (auditBroken) {
        // P1-A.2/.6: persistable intent unavailable → the page stays open.
        decision = "kept";
        reason = "AUDIT_UNAVAILABLE_NO_CLOSE";
      } else {
        if (!intentId) {
          intentId = randomUUID();
          const persisted = await write({ page: pageId(page, uuid), decision: "close-intent", intentId, reason });
          if (!persisted) { intentId = null; decision = "kept"; reason = "AUDIT_UNAVAILABLE_NO_CLOSE"; }
          else open.set(uuid.toLowerCase(), { intentId, page: pageId(page, uuid), reason });
        }
        if (decision === "closed") {
          try { await page.close(); closed++; }
          catch (error) {
            decision = "close-failed";
            reason = "PAGE_CLOSE_FAILED:" + String(error?.code || error?.message || "UNKNOWN").slice(0, 80);
            failed++;
          }
          const confirmed = await write({ page: pageId(page, uuid), decision, reason, intentId });
          if (confirmed && intentId) open.delete(uuid.toLowerCase());
          dispositionWritten = true;
        }
      }
    }
    if (!dispositionWritten) {
      // Kept pages (and forbidden closes) are audited too; a disposition line
      // carrying a prior intent id resolves that intent as superseded.
      const confirmed = await write({ page: pageId(page, uuid), decision, reason, intentId });
      if (confirmed && intentId) open.delete(uuid.toLowerCase());
    }
    if (decision === "kept") kept++;
  }

  // P1-A.5: an intent still open whose page is positively absent (the space is
  // gone, or this run's enumeration proves absence) means the earlier close
  // actually succeeded — backfill the missing result line, distinguishable
  // from a live "closed" line (decision:"closed-backfilled" + intent
  // reference). When any page's identity was unknowable this run, absence
  // cannot be proven → the intents stay open (fail-closed; SWEEP_FAILED, the
  // flag is not cleared).
  const absenceProvable = !task || (enumerated && !sawUnidentifiablePage);
  if (absenceProvable) {
    for (const [uuidLower, intent] of [...open]) {
      if (!carried.has(uuidLower)) continue; // born this run → waits for the rerun
      const ok = await write({ page: { label: intent.page?.label ?? null, uuid: intent.page?.uuid ?? null },
        decision: "closed-backfilled", reason: intent.reason ?? "TEMP_RESULT_PAGE_FINISHED_DISPATCH",
        intentId: intent.intentId, note: "PAGE_GONE_CLOSE_CONFIRMED_BY_BACKFILL" });
      if (ok) { backfilled++; open.delete(uuidLower); }
    }
  }
  return { closed, kept, failed, backfilled, unconfirmed: open.size };
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
