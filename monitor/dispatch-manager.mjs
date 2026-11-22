#!/usr/bin/env node
// Single entry point for ChatGPT web dispatch, monitoring and page release.
// Use this command as a MANAGED foreground/background tool task: exit code 2
// carries a wake signal to the hosting Agent (only if its job API supports it).
import { readFile, writeFile, mkdir, copyFile, unlink, stat, rename, open, appendFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { tick, acknowledge } from "./supervision-watchdog.mjs";
import { readDispatchState, markCompleted, writeJsonAtomic, validateDispatchRecord, evaluateDisarmEligibility, appendEvent, withCommitLock, commitLockScopeOf, isCommitLockError, findComposerFreezeToConsume } from "./dispatch-state.mjs";
import { ARMED_REASONS, IN_FLIGHT_DISPATCH_STATUSES, armedTransitionPatch, classifyFastStateFile, normalizeFastState } from "./state-schema.mjs";
import { verifiedReply, acknowledgeReply, verifiedConsumption, sha256 } from "./reply-delivery.mjs";
import { withAgentRegistry, claimAgentSpace, assertTaskSpaceNamingAllowed } from "./agent-space.mjs";
import { taskspaceOperatorAction } from "./taskspace-takeover.mjs";

const sourceDir = dirname(fileURLToPath(import.meta.url));
const kitDir = dirname(sourceDir);
const adapter = {
  "REPLACE_WITH_DEPLOY_MONITOR_DIR": "monitorDir",
  "REPLACE_WITH_UNIQUE_TASKSPACE": "space",
  "REPLACE_WITH_STABLE_AGENT_ID": "agentId",
  "REPLACE_WITH_CONVERSATION_UUID": "conversation",
  "REPLACE_WITH_COMPLETED_CONVERSATION_UUID": "conversation",
  "REPLACE_WITH_MESSAGE_FILE_PATH": "message",
  "REPLACE_WITH_ATTACHMENTS_JSON": "attachments",
  "REPLACE_WITH_NEW_CHAT_FLAG": "newChat",
  "REPLACE_WITH_RECOVER_ONLY": "recoverOnly",
};
const templates = {
  send: join(kitDir, "skills/chatgpt-web-dispatch/templates/dispatch-round.template.mjs"),
  probe: join(sourceDir, "ego-fast-probe.mjs"),
  release: join(sourceDir, "release-agent-space.template.mjs"),
  collect: join(sourceDir, "collect-reply.template.mjs"),
  "rebuild-space": join(sourceDir, "rebuild-space.template.mjs"),
  claim: join(sourceDir, "claim-space.template.mjs"),
  // #40: page verification for the PO-manual attach (URL + tail-message evidence
  // BEFORE any ledger is written — fail-closed binding).
  "manual-attach": join(sourceDir, "po-manual-attach.template.mjs"),
};
const modules = ["agent-space.mjs", "release-sweep.mjs", "dispatch-state.mjs", "reply-delivery.mjs", "page-recovery.mjs", "state-schema.mjs", "taskspace-takeover.mjs", "supervision-policy.mjs"];
const allowed = new Set(["send", "send-new", "recover-draft", "probe", "watch", "collect", "consume", "release", "ack", "abort", "rebuild-space", "claim", "discard-pending", "manual-attach"]);
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;

export function parseArgs(args) {
  const [action, ...rest] = args;
  if (!allowed.has(action)) throw new Error("MANAGER_ACTION_INVALID");
  if (rest.length % 2) throw new Error("MANAGER_ARG_MISSING_VALUE");
  const params = { action };
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    if (!/^--(?:agent-id|space|conversation|request-id|message|attachments-file|monitor-dir|wake-id|ack-action|reply-sha256|archived-record|dispatch-id|reason)$/.test(key) || !rest[i + 1] ||
        Object.hasOwn(params, key.slice(2))) throw new Error("MANAGER_ARG_INVALID");
    const normalized = key.replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    params[normalized] = rest[i + 1];
  }
  if (!params.monitorDir) throw new Error("MONITOR_DIR_REQUIRED");
  params.monitorDir = resolve(params.monitorDir);
  params.newChat = action === "send-new";
  params.recoverOnly = action === "recover-draft";
  if (params.newChat && !params.conversation && uuid.test(params.requestId || "")) params.conversation = params.requestId;
  // Space-level rebuild/claim is authorized by agent+space identity alone; a
  // conversation or payload would mean this is really a dispatch action, not a
  // registry-level operation.
  if (action === "rebuild-space" || action === "claim") {
    if (["conversation", "requestId", "message", "attachmentsFile", "wakeId", "ackAction", "replySha256", "archivedRecord"]
        .some((key) => params[key])) throw new Error("MANAGER_IDENTITY_INVALID");
    if (!params.agentId || !/^[a-z0-9][a-z0-9_.-]{1,63}$/i.test(params.agentId) ||
        !params.space || params.space !== params.space.trim() || params.space.length > 120) {
      throw new Error("MANAGER_IDENTITY_INVALID");
    }
    return params;
  }
  // #39 item 3: the stuck pending request is addressed by its client requestId
  // ALONE. A --conversation value would imply a bound conversation, which this
  // action must never touch (fail-closed — the binding path owns those). This
  // special case MUST sit before the generic identity check below, which
  // forbids a bare requestId on every non-send-new action.
  if (action === "discard-pending") {
    if (!uuid.test(params.requestId || "")) throw new Error("MANAGER_IDENTITY_INVALID");
    if (["conversation", "message", "attachmentsFile", "wakeId", "ackAction", "replySha256", "archivedRecord", "dispatchId", "reason"]
        .some((key) => params[key])) throw new Error("MANAGER_IDENTITY_INVALID");
    if (!params.agentId || !/^[a-z0-9][a-z0-9_.-]{1,63}$/i.test(params.agentId) ||
        !params.space || params.space.length > 120) throw new Error("MANAGER_IDENTITY_INVALID");
    return params;
  }
  if (!params.agentId || !/^[a-z0-9][a-z0-9_.-]{1,63}$/i.test(params.agentId) ||
    !params.space || params.space.length > 120 || !uuid.test(params.conversation) ||
    (params.newChat && (params.conversation !== params.requestId || !uuid.test(params.requestId))) ||
    (!params.newChat && params.requestId)) throw new Error("MANAGER_IDENTITY_INVALID");
  if (action === "ack" && (!params.wakeId || !["investigated", "resolved"].includes(params.ackAction))) throw new Error("ACK_ARGS_INVALID");
  // #38 fix 3: abort is the only consumer of --dispatch-id / --reason (same
  // exclusive-arg precedent as ARCHIVED_RECORD_RECOVERY_ONLY). The dispatch id
  // must be a full ledger UUID and the reason a fail-closed code.
  if (action === "abort") {
    if (!uuid.test(params.dispatchId || "")) throw new Error("ABORT_DISPATCH_ID_REQUIRED");
    if (typeof params.reason !== "string" || !/^[A-Z0-9_]{3,48}$/.test(params.reason)) throw new Error("ABORT_REASON_CODE_INVALID");
    return params;
  }
  // #40: manual-attach binds an existing conversation — message payloads and
  // watch-ack arguments have no meaning on a bind action; refused, not ignored.
  if (action === "manual-attach" && ["message", "wakeId", "ackAction", "requestId"].some((key) => params[key])) {
    throw new Error("MANAGER_IDENTITY_INVALID");
  }
  if ((params.reason || params.dispatchId) && action !== "abort") throw new Error("ABORT_ARGS_ABORT_ONLY");
  if (action === "consume" && !/^[\da-f]{64}$/i.test(params.replySha256 || "")) throw new Error("REPLY_SHA256_REQUIRED");
  if (["send", "send-new", "recover-draft"].includes(action) && !params.message) throw new Error("MESSAGE_REQUIRED");
  if (params.attachmentsFile && !["send", "send-new"].includes(action)) throw new Error("ATTACHMENTS_SEND_ONLY");
  if (params.archivedRecord && !params.recoverOnly) throw new Error("ARCHIVED_RECORD_RECOVERY_ONLY");
  return params;
}

export function adaptTemplate(source, params) {
  let result = source;
  for (const [token, key] of Object.entries(adapter)) {
    if (result.includes(token)) {
      if (key === "newChat" || key === "recoverOnly") {
        result = result.replaceAll('"' + token + '"', params[key] ? "true" : "false");
      } else if (key === "attachments") {
        if (!Array.isArray(params.attachments)) throw new Error("ADAPTER_ATTACHMENTS_INVALID");
        result = result.replaceAll('"' + token + '"', JSON.stringify(params.attachments));
      } else {
        if (typeof params[key] !== "string") throw new Error("ADAPTER_VALUE_MISSING: " + key);
        result = result.replaceAll('"' + token + '"', JSON.stringify(params[key]));
      }
    }
  }
  if (result.includes("REPLACE_WITH_")) throw new Error("ADAPTER_UNRESOLVED");
  return result;
}

// Every conversation owns a durable ledger and supervisor state, even if one
// Agent owns several pages in the same TaskSpace.
export function conversationDir(params) {
  return params.newChat
    ? join(params.monitorDir, "pending-new", params.requestId.toLowerCase())
    : join(params.monitorDir, "conversations", params.conversation.toLowerCase());
}

// A pending first-message request is durable before the browser allocates a Page.
// Retrying this request only completes a verified binding, never sends again.
// P1-E (re-review round 2): at binding time the origin record (a-new-request.json)
// is rewritten — the original client requestId field is KEPT and conversationUuid
// (the real browser-allocated UUID) plus boundAt are added — so the durable
// record moved into conversations/ self-verifies the client requestId ↔ real
// conversationUuid association the release sweep's anchoredDispatchCreated
// checks. The rewrite happens BEFORE the pending→conversations rename (the
// rename carries the complete record; a crash leaves no half-bound shape) and
// is idempotent: an already-associated record is left byte-identical.
export async function bindNewConversation(root, requestId, space, agentId, payloadHash) {
  const pending = join(root, "pending-new", requestId.toLowerCase());
  const mappingFile = join(root, "new-requests", requestId.toLowerCase() + ".json");
  let mapping;
  try { mapping = JSON.parse(await readFile(mappingFile, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!mapping) {
    const record = await readDispatchState(pending);
    if (!record || record.status !== "ACCEPTED" || record.taskSpace !== space ||
        record.conversationUuid.toLowerCase() !== requestId.toLowerCase()) throw new Error("NEW_CHAT_RECONCILIATION_REQUIRED");
    const pendingRequest = JSON.parse(await readFile(join(pending, "a-new-request.json"), "utf8"));
    if (record.payload_sha256 !== payloadHash || pendingRequest.requestId !== requestId.toLowerCase() ||
        pendingRequest.space !== space || pendingRequest.agentId !== agentId || pendingRequest.payloadSha256 !== payloadHash) {
      throw new Error("NEW_CHAT_REQUEST_CONFLICT");
    }
    const evidence = JSON.parse(await readFile(join(pending, "a-new-conversation.json"), "utf8"));
    if (evidence.requestId.toLowerCase() !== requestId.toLowerCase() || !uuid.test(evidence.conversationUuid) ||
        evidence.conversationUuid.toLowerCase() === requestId.toLowerCase()) throw new Error("NEW_CHAT_UUID_UNVERIFIED");
    mapping = { requestId: requestId.toLowerCase(), conversationUuid: evidence.conversationUuid.toLowerCase(), space };
    try {
      await stat(join(root, "conversations", mapping.conversationUuid));
      throw new Error("NEW_CHAT_TARGET_OCCUPIED");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await mkdir(dirname(mappingFile), { recursive: true });
    await writeJsonAtomic(mappingFile, mapping);
  }
  if (mapping.space !== space || mapping.requestId !== requestId.toLowerCase() || !uuid.test(mapping.conversationUuid)) {
    throw new Error("NEW_CHAT_BINDING_CONFLICT");
  }
  const target = join(root, "conversations", mapping.conversationUuid);
  let record = await readDispatchState(target);
  if (!record) {
    record = await readDispatchState(pending);
    if (!record || record.status !== "ACCEPTED" || record.taskSpace !== space ||
        ![requestId.toLowerCase(), mapping.conversationUuid].includes(record.conversationUuid.toLowerCase())) {
      throw new Error("NEW_CHAT_BINDING_REQUIRES_ACCEPTED");
    }
    const pendingRequest = JSON.parse(await readFile(join(pending, "a-new-request.json"), "utf8"));
    if (record.payload_sha256 !== payloadHash || pendingRequest.requestId !== requestId.toLowerCase() ||
        pendingRequest.space !== space || pendingRequest.agentId !== agentId || pendingRequest.payloadSha256 !== payloadHash) {
      throw new Error("NEW_CHAT_REQUEST_CONFLICT");
    }
    if (record.conversationUuid.toLowerCase() !== mapping.conversationUuid) {
      record = { ...record, conversationUuid: mapping.conversationUuid };
      await writeJsonAtomic(join(pending, "a-dispatch-state.json"), record);
    }
    // P1-E: persist the client requestId ↔ real conversationUuid association in
    // the origin record BEFORE the rename (same writeJsonAtomic tmp+rename
    // precedent as the ledger rewrite above — no open-handle window on Windows,
    // and the directory rename then carries the complete record atomically).
    if (pendingRequest.conversationUuid !== mapping.conversationUuid) {
      await writeJsonAtomic(join(pending, "a-new-request.json"), {
        ...pendingRequest, conversationUuid: mapping.conversationUuid, boundAt: Date.now(),
      });
    }
    await mkdir(dirname(target), { recursive: true });
    try {
      await stat(target);
      throw new Error("NEW_CHAT_TARGET_OCCUPIED");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await rename(pending, target);
  }
  const request = JSON.parse(await readFile(join(target, "a-new-request.json"), "utf8"));
  const evidence = JSON.parse(await readFile(join(target, "a-new-conversation.json"), "utf8"));
  if (request.requestId !== requestId.toLowerCase() || request.space !== space || request.agentId !== agentId || request.payloadSha256 !== payloadHash ||
      evidence.requestId.toLowerCase() !== requestId.toLowerCase() || evidence.conversationUuid.toLowerCase() !== mapping.conversationUuid ||
      record.taskSpace !== space || record.conversationUuid.toLowerCase() !== mapping.conversationUuid ||
      record.payload_sha256 !== payloadHash || !["ACCEPTED", "COMPLETED"].includes(record.status)) {
    throw new Error("NEW_CHAT_BOUND_RECORD_INVALID");
  }
  // P1-E heal (idempotent): bound directories written before the association
  // field existed get conversationUuid/boundAt backfilled here, so a replay of
  // the same send-new request upgrades the durable origin record in place.
  // Without it, a pre-fix record would read as unproven origin forever (the
  // sweep would keep the page FIXED_SESSION — fail-closed, never destructive).
  if (request.conversationUuid !== mapping.conversationUuid) {
    await writeJsonAtomic(join(target, "a-new-request.json"), {
      ...request, conversationUuid: mapping.conversationUuid, boundAt: Date.now(),
    });
  }
  return mapping.conversationUuid;
}

// The presence of a conversation UUID alone never arms a browser job.
// A started send must remain observable even if acknowledgement failed; the
// probe's existing reconciliation path can then establish whether it landed.
//
// #36 (freeze deadlock family): the ONLY widened branch. A probe may boot on a
// TERMINAL ledger (COMPLETED/ABORTED) when an unconsumed composer freeze exists
// in the conversation dir — fresh OR already expired — because the freeze
// record's only consumer is the probe itself, and the #36/#39-③ live incident
// proved the deadlock shape: Gate 0 blocks the send on the unconsumed freeze,
// the probe is refused by the arm gate over the terminal ledger, and nothing
// else can ever consume it. The admitted probe consumes + observes the surface
// and then exits through its existing semantics (healthy round / storm backoff /
// terminal wake). Everything else of the arm-on-wait contract is unchanged:
// the freeze ledger read is fail-closed (an unreadable freeze ledger proves
// nothing and never widens the gate), and watch semantics stay exactly as the
// #38 fix left them.
export async function requireArmedDispatch(dir, params, action) {
  const record = await readDispatchState(dir);
  if (!record || record.conversationUuid.toLowerCase() !== params.conversation.toLowerCase() ||
      record.taskSpace !== params.space) {
    throw new Error("DISPATCH_NOT_ARMED");
  }
  if (action === "probe") {
    if (["SEND_STARTED", "UNCERTAIN", "ACCEPTED"].includes(record.status)) return record;
    if (record.status === "COMPLETED" || record.status === "ABORTED") {
      let freeze = null;
      try { freeze = await findComposerFreezeToConsume(dir); }
      catch { freeze = null; } // unreadable freeze ledger proves nothing (fail-closed)
      if (freeze) return record;
    }
    throw new Error("DISPATCH_NOT_ARMED");
  }
  // #38 fix 3: watch may arm on a freshly ABORTED ledger — its terminal
  // short-circuit below then exits with DISPATCH_ABORTED_WAKE_SUPERVISOR
  // instead of a bare DISPATCH_NOT_ARMED.
  if (!["SEND_STARTED", "UNCERTAIN", "ACCEPTED", "COMPLETED", "ABORTED"].includes(record.status)) {
    throw new Error("DISPATCH_NOT_ARMED");
  }
  return record;
}

export async function loadAttachments(file) {
  if (!file) return [];
  const value = JSON.parse(await readFile(resolve(file), "utf8"));
  if (!Array.isArray(value) || !value.length || value.some((name) => typeof name !== "string" || !isAbsolute(name))) {
    throw new Error("ATTACHMENTS_MANIFEST_INVALID");
  }
  for (const name of value) {
    if (!(await stat(name)).isFile()) throw new Error("ATTACHMENT_NOT_FILE");
  }
  return value;
}

export function classifyProbeResult({ code, result }, benignStreak = 0) {
  if (code !== 0 || !result) return { wake: true, streak: 0 };
  if (["GENERATING", "IDLE_PREDELIVERY", "PROBE_BACKOFF", "PROBE_UNAVAILABLE_RETRY"].includes(result)) {
    return { wake: false, streak: 0 };
  }
  if (result === "START_IDLE_WAKE_SUPERVISOR") {
    return { wake: benignStreak >= 20, streak: benignStreak + 1 };
  }
  return { wake: true, streak: 0 };
}

// Frozen ledger schema for the durable watch-exit event (agent-kit#25 plan C).
// The marker is the wake event a ZCode host hook can discover after the watch
// process is gone; it never carries task or reply content.
const WATCH_EXIT_SCHEMA = "ego-watch-exit/v1";

// #38 F3: structured supervision classes that need a more specific exitWatching
// wake reason map here. Unmapped reasons (REPLY_UNHANDLED, NO_SUBSTANTIVE_PROGRESS,
// MONITOR_STATE_ABNORMAL, ...) keep the historical passthrough behavior: the
// pending.reason string becomes the exitWatching reason verbatim.
export const SUPERVISION_WAKE_REASON_MAP = Object.freeze({
  DELIVERY_SUSPECTED: "DELIVERY_SUSPECTED_WAKE_SUPERVISOR",
});

// Unified watch exit, in contract order: generate wakeId -> atomically write
// <conversationDir>/a-watch-exit.json -> announce the wake reason -> exit 2.
// A failed marker write must never upgrade the wake into a success: the exit
// code stays 2 and stderr records the loss so plan A's stale detection can
// take over. SIGKILL, power loss and similar abrupt terminations never reach
// this function at all, so no exit-code promise is made for those cases.
export async function exitWatching(dir, reason, { wakeId = randomUUID(), detail = "", announce = true } = {}) {
  const marker = {
    schema: WATCH_EXIT_SCHEMA,
    wakeId,
    reason,
    issuedAt: Date.now(),
    exitCode: 2,
    acknowledgedAt: null,
    ackAction: null,
  };
  try {
    await writeJsonAtomic(join(dir, "a-watch-exit.json"), marker);
  } catch (error) {
    console.error("RESULT=WATCH_EXIT_MARKER_WRITE_FAILED wakeId=" + wakeId + " reason=" + reason +
      " code=" + ((error && (error.code || error.message)) || "UNKNOWN"));
  }
  if (announce) console.log("RESULT=" + reason + (detail ? " " + detail : "") + " wakeId=" + wakeId);
  return 2;
}

// Plan C ack extension (agent-kit#25): one ack may have to clear both durable
// ledgers that share a wakeId — the supervision pending alarm and the
// watch-exit marker. An unknown id still fails closed; an already
// acknowledged marker is rejected instead of silently succeeding, and the
// acknowledged record is retained as historical evidence.
export async function acknowledgeWake(id, action, dir, now = Date.now()) {
  if (!id || !["investigated", "resolved"].includes(action)) throw new Error("ACK_ARGS_INVALID");
  const exitFile = join(dir, "a-watch-exit.json");
  let marker = null;
  try { marker = JSON.parse(await readFile(exitFile, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const markerMatches = marker && marker.schema === WATCH_EXIT_SCHEMA && marker.wakeId === id;
  let supervisionMatched = false;
  try {
    await acknowledge(id, action, dir, now);
    supervisionMatched = true;
  } catch (error) {
    if (error.message !== "WAKE_ID_NOT_PENDING") throw error;
  }
  if (markerMatches && marker.acknowledgedAt === null) {
    await writeJsonAtomic(exitFile, { ...marker, acknowledgedAt: now, ackAction: action });
    console.log("WATCH_EXIT_ACKNOWLEDGED=" + action);
  }
  if (!supervisionMatched && !markerMatches) throw new Error("WAKE_ID_NOT_PENDING");
  if (!supervisionMatched && markerMatches && marker.acknowledgedAt !== null) throw new Error("WAKE_ID_ALREADY_ACKNOWLEDGED");
}

// ---- #27 observation B (Batch 1): managed ack tiering ----

export const ACK_AUDIT_FILE = "a-wake-ack-audit.ndjson";
export const ACK_RESOLVED_OWNERSHIP_REQUIRED = "ACK_RESOLVED_OWNERSHIP_REQUIRED";

// Ownership evidence for a `resolved` ack (ruling #27 observation B; planner
// re-review B-01/B-03). A unified precondition chain runs BEFORE either
// evidence path — any unprovable step returns null and the caller fails
// closed. Boundary wording (planner re-review B-03): this gate verifies the
// ownership relation between the caller-DECLARED agentId and the target
// TaskSpace; it does NOT verify the calling process's real Agent identity and
// does NOT prevent an actively forged agentId — an operational-governance
// mechanism, not security authentication.
//
// Precondition chain (all must hold; record is the anchor):
//   1. the conversation's dispatch ledger exists and is structurally valid
//      (readDispatchState throws on corruption);
//   2. record.conversationUuid matches the target conversation (toLowerCase
//      comparison, same precedent as the consume branch);
//   3. record.taskSpace === the declared space (p.space).
// Evidence paths (evaluated only after the chain holds):
//   (a) REGISTRY: the machine-wide ownership ledger
//       (~/.agents/ego-taskspaces.json, withAgentRegistry) binds this agentId
//       to record.taskSpace. An unreadable registry proves nothing.
//   (b) CLAIM: a managed claim takeover recorded in the monitor root's shared
//       a-space-rebuild-audit.ndjson — a row with action:"claim",
//       outcome:"CLAIMED", row agentId === the declared agentId and
//       row space === record.taskSpace (anchored to the ledger, not to the
//       caller's declared space — precondition 3 already equates them).
//       Claim is the only managed cross-session takeover channel; an ack must
//       not bypass it.
export async function ackOwnershipEvidence(agentId, space, conversation, monitorDir, dir, { directory } = {}) {
  // Precondition chain (fail-closed): an absent, unreadable or corrupt ledger,
  // a conversation mismatch or a space mismatch can never be bridged by any
  // evidence below.
  let record = null;
  try { record = await readDispatchState(dir); }
  catch { return null; }
  if (!record) return null;
  if (typeof record.conversationUuid !== "string" ||
      record.conversationUuid.toLowerCase() !== String(conversation ?? "").toLowerCase()) return null;
  if (record.taskSpace !== space) return null;
  let boundSpace = null;
  try {
    // withAgentRegistry actions return { changed, value } — read-only here.
    boundSpace = await withAgentRegistry((registry) => ({
      changed: false,
      value: registry.agents[agentId]?.spaceName ?? null,
    }), directory);
  } catch { boundSpace = null; } // unreadable registry proves nothing
  if (typeof boundSpace === "string" && boundSpace === record.taskSpace) return "REGISTRY";
  try {
    const raw = await readFile(join(monitorDir, "a-space-rebuild-audit.ndjson"), "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row.action === "claim" && row.outcome === "CLAIMED" &&
          row.agentId === agentId && row.space === record.taskSpace) {
        return "CLAIM";
      }
    }
  } catch { /* unreadable audit ledger proves nothing */ }
  return null;
}

// The managed ack path (`dispatch-manager.mjs ack`): tiered permissions per the
// #27 ruling — `investigated` stays open to any valid agent identity that
// actually inspected the wake; `resolved` requires ownership evidence (registry
// binding or managed claim takeover). A resolved without evidence is denied
// with ACK_RESOLVED_OWNERSHIP_REQUIRED + operator guidance, and is fail-closed:
// the watch-exit marker and supervision ledger keep zero changes.
//
// PLACEMENT NOTE (kept for the planner's per-item acceptance): the ruling's
// Batch-1 table lists hooks/pre-tool-use.mjs as the落点, but the hook layer only
// sees a command string and a session id — there is no reliable
// session↔agent identity mapping there, and the ruling itself demands that
// resolved fail closed whenever a declared identity's ownership cannot be
// verified. Gating resolved at the hook layer would therefore reject every
// Owner's legitimate resolved. The gate lives in this managed ack path — the
// only layer that can verify the DECLARED agentId's ownership relation to the
// target TaskSpace (registry binding and the conversation ledger are both
// readable here). It verifies declared-identity ownership, not the calling
// process's real Agent identity, and does not prevent an actively forged
// agentId (B-03 boundary wording).
//
// Every managed ack attempt appends one audit line to
// <monitorDir>/a-wake-ack-audit.ndjson:
//   { ts, agentId, space, conversation, wakeId, ackAction, outcome[, reason, evidence] }
// outcome is GRANTED or DENIED; denials (including ownership denials and
// WAKE_ID_NOT_PENDING failures) leave evidence too.
//
// Audit/result consistency (planner re-review B-02): the audit verdict is
// kept SEPARATE from the ack business result. A succeeded ack can never be
// recorded as DENIED — if its GRANTED audit write fails, the failure is
// reported as ACK_AUDIT_WRITE_FAILED on stderr and the ack still returns 0
// (the exit code reflects the ack result, the audit failure is reported
// separately). A failed ack best-effort writes DENIED (a failed DENIED write
// is likewise reported, then the original error is rethrown). The ego-watch-exit/v1
// marker schema is untouched (#25 frozen seven-field contract).
export async function managedAcknowledge(p, { directory, now = Date.now() } = {}) {
  const dir = conversationDir(p);
  const auditFile = join(p.monitorDir, ACK_AUDIT_FILE);
  const audit = (entry) => appendFile(auditFile, JSON.stringify({
    ts: new Date().toISOString(), agentId: p.agentId, space: p.space,
    conversation: p.conversation, wakeId: p.wakeId, ackAction: p.ackAction, ...entry,
  }) + "\n", "utf8");
  // Warn-only reporting: an audit write failure never flips the ack verdict.
  const auditWriteFailed = (error) => console.error("RESULT=ACK_AUDIT_WRITE_FAILED code=" +
    String(error?.code || error?.message || "UNKNOWN"));
  let evidence = null;
  if (p.ackAction === "resolved") {
    try { evidence = await ackOwnershipEvidence(p.agentId, p.space, p.conversation, p.monitorDir, dir, { directory }); }
    catch { evidence = null; } // evidence lookup failure never grants
    if (!evidence) {
      // Ownership denial: business ledgers stay untouched (fail-closed). The
      // DENIED audit is best-effort — a write failure is reported but the
      // denial stands (exit 2).
      try { await audit({ outcome: "DENIED", reason: ACK_RESOLVED_OWNERSHIP_REQUIRED }); }
      catch (error) { auditWriteFailed(error); }
      console.error("RESULT=ACK_DENIED code=" + ACK_RESOLVED_OWNERSHIP_REQUIRED);
      console.error("OPERATOR_ACTION=resolved 需空间所有权证据：先用受管 claim 接管该空间" +
        "（node monitor/dispatch-manager.mjs claim --monitor-dir <根> --agent-id <ID> --space <空间>），" +
        "或将本次 ack 降级为 investigated");
      return 2;
    }
  }
  try {
    await acknowledgeWake(p.wakeId, p.ackAction, dir, now);
  } catch (error) {
    // Ack failed: best-effort DENIED audit, then rethrow the ORIGINAL error —
    // a failed audit write must not mask or replace the ack failure.
    try { await audit({ outcome: "DENIED", reason: String(error.code || error.message) }); }
    catch (auditError) { auditWriteFailed(auditError); }
    throw error;
  }
  // P1-C: the ack is a managed touch of the conversation ledgers — re-run the
  // idempotent disarm retry. Acking DISARM_DEFERRED_WAKE_SUPERVISOR clears its
  // own unacked-wake blocker, so the deferred disarm converges right here; the
  // retry itself first verifies the release-success credential inside
  // retryPendingDisarm, so acks of release-FAILURE wakes never disarm.
  await retryPendingDisarm(dir, { rootMonitorDir: p.monitorDir });
  // The ack succeeded: it can never be recorded as DENIED. A failed GRANTED
  // audit write is reported separately and the ack still returns 0.
  try { await audit(evidence ? { outcome: "GRANTED", evidence } : { outcome: "GRANTED" }); }
  catch (error) { auditWriteFailed(error); }
  return 0;
}

// ---- #38 fix 3 (Issue #38 repair option 3): managed abort / expire semantics ----
//
// A ledger stuck ACCEPTED/UNCERTAIN with the send never persisted server-side
// (vanish mode) previously had no managed close path — only manual byte-level
// backups plus hand-edited JSON. `abort` closes that in-flight ledger WITHOUT
// any browser dependency, fail-closed:
//   identity gate — --dispatch-id must match the ledger's current dispatchId
//     (plus conversation/space anchoring, consume-branch precedent); a terminal
//     ledger (COMPLETED/ABORTED) refuses a repeated abort;
//   evidence gate — aborting a delivery verdict requires DELIVERY-FAILURE
//     evidence, any one of:
//     (a) the conversation's a-supervision-status.json pending.reason ===
//         "DELIVERY_SUSPECTED" (#38 F3 supervision classification);
//     (b) the conversation's a-fast-state.json deliveryFailedCandidate === true
//         (#38/#37 probe vanish-mode signature);
//     (c) the ledger status === "UNCERTAIN" AND the fast-state tail
//         lastMessageKey still equals the ledger's dispatch-time baselineTailKey
//         AND generating === false (nothing ever advanced past the baseline).
//     Unreadable/missing evidence is never evidence (fail-closed): the gate
//     emits ABORT_EVIDENCE_REQUIRED with a sanitized evidence summary.
// Write path: byte-level backup of a-dispatch-state.json FIRST
// (a-dispatch-state.archive-<dispatchId前8>-abort.json; an existing backup is
// never overwritten — a timestamped sibling is created instead), then the
// existing atomic write pattern transitions the ledger to ABORTED with
// abortReason/abortedAt/abortedBy (same fields the #38 manual surgery used),
// plus a DISPATCH_ABORTED audit event carrying the reason and evidence source.

export const ABORT_EVIDENCE_REQUIRED = "ABORT_EVIDENCE_REQUIRED";

// Pure evidence gate (fail-closed). `null` means "unprovable" — an unreadable
// or absent file never satisfies its branch. Exported for unit tests; the
// abort flow gathers the durable values around it.
export function evaluateAbortEvidence({
  ledgerStatus = null,
  supervisionPendingReason = null,
  deliveryFailedCandidate = null,
  fastStateGenerating = null,
  fastTailKeyEqualsBaseline = null,
} = {}) {
  if (supervisionPendingReason === "DELIVERY_SUSPECTED") {
    return { ok: true, source: "SUPERVISION_DELIVERY_SUSPECTED" };
  }
  if (deliveryFailedCandidate === true) {
    return { ok: true, source: "FAST_STATE_DELIVERY_FAILED_CANDIDATE" };
  }
  if (ledgerStatus === "UNCERTAIN" && fastTailKeyEqualsBaseline === true && fastStateGenerating === false) {
    return { ok: true, source: "BASELINE_TAIL_UNADVANCED_UNCERTAIN" };
  }
  return { ok: false, source: null };
}

// Byte-level, exclusive-create backup of the dispatch ledger. The raw bytes
// are copied verbatim (no re-serialization), so the backup is a byte-exact
// pre-abort restore point. An existing backup file is never overwritten: the
// first candidate gets a timestamp suffix, and further collisions get a
// counter, so a backup can never destroy another backup. `suffix` marks the
// writing flow in the archive name ("abort" default; "po-manual" for the #40
// attach's replaced-terminal-ledger backup).
const ABORT_BACKOFF_SUFFIX = "abort";

async function backupLedgerBytes(dir, dispatchId, now = Date.now(), suffix = ABORT_BACKOFF_SUFFIX) {
  const bytes = await readFile(join(dir, "a-dispatch-state.json"));
  const base = `a-dispatch-state.archive-${dispatchId.slice(0, 8)}-${suffix}`;
  for (let attempt = 0; ; attempt++) {
    const target = attempt === 0 ? `${base}.json` : `${base}-${now}${attempt > 1 ? "-" + attempt : ""}.json`;
    try {
      const handle = await open(join(dir, target), "wx", 0o600);
      try { await handle.writeFile(bytes); } finally { await handle.close(); }
      return { file: target, bytes: bytes.byteLength };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
}

function abortSummaryLine(summary) {
  return "evidence=" + JSON.stringify(summary);
}

export async function abortDispatch(p, { now = Date.now() } = {}) {
  const dir = conversationDir(p);
  const summary = {
    ledger: "ABSENT", dispatchIdMatch: false, conversationMatch: false, spaceMatch: false,
    supervisionPendingReason: null, fastState: "MISSING", deliveryFailedCandidate: null,
    fastStateGenerating: null, fastTailKeyEqualsBaseline: null,
  };
  const evidenceRequired = () => {
    console.error("RESULT=" + ABORT_EVIDENCE_REQUIRED + " " + abortSummaryLine(summary));
    console.error("OPERATOR_ACTION=abort 仅在交付失败证据成立时可用（DELIVERY_SUSPECTED 监督告警 / fast-state deliveryFailedCandidate / UNCERTAIN+尾部未越派单基线）。请先用受管 probe 复核服务端真态，再凭证据重试。");
    return 2;
  };
  let record = null;
  try { record = await readDispatchState(dir); }
  catch (error) {
    summary.ledger = "UNREADABLE:" + String(error.code || error.message || "UNKNOWN").slice(0, 80);
    return evidenceRequired();
  }
  if (!record) return evidenceRequired();
  summary.ledger = record.status;
  summary.dispatchIdMatch = record.dispatchId === p.dispatchId;
  summary.conversationMatch = typeof record.conversationUuid === "string" &&
    record.conversationUuid.toLowerCase() === p.conversation.toLowerCase();
  summary.spaceMatch = record.taskSpace === p.space;
  // Identity gate first: an abort against the wrong ledger must never look at
  // (let alone act on) any other dispatch's evidence.
  if (!summary.dispatchIdMatch) {
    console.error("RESULT=ABORT_DISPATCH_ID_MISMATCH " + abortSummaryLine(summary));
    return 2;
  }
  if (!summary.conversationMatch || !summary.spaceMatch) {
    console.error("RESULT=ABORT_IDENTITY_MISMATCH " + abortSummaryLine(summary));
    return 2;
  }
  if (record.status === "COMPLETED" || record.status === "ABORTED") {
    console.error("RESULT=ABORT_NOT_APPLICABLE status=" + record.status);
    return 2;
  }
  // Evidence gathering — every unreadable step degrades to "unprovable" (null),
  // never to a truthy value.
  try {
    const status = JSON.parse(await readFile(join(dir, "a-supervision-status.json"), "utf8"));
    summary.supervisionPendingReason = status?.pending && typeof status.pending.reason === "string"
      ? status.pending.reason : null;
  } catch (error) {
    summary.supervisionPendingReason = error?.code === "ENOENT" ? null : "UNREADABLE";
  }
  let fast = null;
  try { fast = JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8")); }
  catch (error) {
    summary.fastState = error?.code === "ENOENT" ? "MISSING" : "UNREADABLE";
  }
  if (fast) {
    // A structurally invalid fast state proves nothing — same fail-closed
    // classification the arm/disarm decisions use.
    if (classifyFastStateFile(fast) === "corrupt") {
      summary.fastState = "CORRUPT";
    } else {
      summary.fastState = "READ";
      summary.deliveryFailedCandidate = fast.deliveryFailedCandidate === true;
      summary.fastStateGenerating = fast.generating === true;
      summary.fastTailKeyEqualsBaseline = typeof fast.lastMessageKey === "string" &&
        Boolean(fast.lastMessageKey) && typeof record.baselineTailKey === "string" &&
        fast.lastMessageKey === record.baselineTailKey;
    }
  }
  const verdict = evaluateAbortEvidence({
    ledgerStatus: record.status,
    supervisionPendingReason: summary.supervisionPendingReason === "UNREADABLE" ? null : summary.supervisionPendingReason,
    deliveryFailedCandidate: summary.deliveryFailedCandidate,
    fastStateGenerating: summary.fastStateGenerating,
    fastTailKeyEqualsBaseline: summary.fastTailKeyEqualsBaseline,
  });
  if (!verdict.ok) return evidenceRequired();
  // Backup BEFORE any mutation; then the existing atomic write pattern.
  const backup = await backupLedgerBytes(dir, record.dispatchId, now);
  const next = {
    ...record,
    status: "ABORTED",
    abortReason: p.reason,
    abortedAt: now,
    abortedBy: p.agentId,
    updatedAt: now,
  };
  await writeJsonAtomic(join(dir, "a-dispatch-state.json"), next);
  await appendEvent(dir, "DISPATCH_ABORTED", {
    dispatchId: record.dispatchId, reason: p.reason,
    evidence: verdict.source, abortedBy: p.agentId, backupFile: backup.file,
  });
  console.log("RESULT=DISPATCH_ABORTED dispatchId=" + record.dispatchId +
    " reason=" + p.reason + " evidence=" + verdict.source + " backup=" + backup.file);
  return 0;
}

// ---- #39 item 3: managed discard/redispatch path for a stuck pending-new request ----
//
// A send-new interrupted before acceptance (e.g. LEVEL_GATE_FAIL_ABORT after
// prepareDispatch) leaves pending-new/<requestId>/ with a PREPARED ledger and
// no managed way out: a same-requestId retry hits NEW_CHAT_IN_PROGRESS_OR_
// RECOVERY_REQUIRED (a-new-request.json EEXIST), bindNewConversation requires
// ACCEPTED, abort's evidence gate does not accept PREPARED, and recover-draft
// only parses conversations/<uuid>/. `discard-pending` opens the ONE managed
// path: archive the whole pending directory (byte-preserving, non-destructive)
// so the canonical pending-new path is free and the same requestId can be
// reused — or a fresh one chosen. The browser is never touched: the leftover
// draft page (if the fill already happened) is the operator's to close; its
// label is recorded in the audit row so it can be found.
//
// Evidence gate (fail-closed — every step must PROVE, never assume):
//   PENDING_REQUEST_UNREADABLE        — pending dir or its a-new-request.json missing/unreadable;
//   PENDING_REQUEST_IDENTITY_MISMATCH — requestId/space/agentId do not anchor the request record;
//   PENDING_LEDGER_UNREADABLE         — ledger corrupt (readDispatchState throws);
//   PENDING_LEDGER_ABSENT             — no ledger yet (never prepared);
//   PENDING_LEDGER_NOT_PREPARED:<st>  — any non-PREPARED status (delivery/binding lifecycles own those);
//   PENDING_BOUND_TO_CONVERSATION     — conversationUuid ≠ requestId: a binding happened (or is
//                                       in flight) and bindNewConversation owns the outcome;
//   PENDING_DELIVERY_EVIDENCE_PRESENT — sendStartedAt/acceptedAt/completedAt/replyFile present:
//                                       something was delivered or claimed delivered;
//   PENDING_WAKE_UNACKNOWLEDGED       — an unacked ego-watch-exit/v1 marker: a wake is still open;
//   PENDING_WAKE_MARKER_INVALID(_UNREADABLE) — marker corruption is never "no watch";
//   PENDING_SUPERVISION_ALARM(_INVALID/_UNREADABLE) — an open supervision handoff owns the dir;
//   PENDING_DISCARD_RACE_LOST         — in-lock re-check: the ledger changed between the advisory
//                                       read and the commit;
//   PENDING_DISCARD_LOCK_FAILED:<msg> — the monitor-root commit lock was unavailable (fail-closed,
//                                       same participant discipline as every shared-state writer).
// Write path: ONE monitor-root commit-lock section (commitLockScopeOf — pending-new
// resolves to the root, the same domain arm/prepare/disarm serialize on) re-proving
// the decisive ledger identity and then atomically renaming the directory to
// <root>/pending-new-archive/<requestId>.archive-<ts>[-n]. The rename — not a copy+delete
// — keeps every original byte (不物理删除原始证据) and moves the dir OUT of pending-new/,
// where any directory counts as in-flight wholesale for disarm's global sibling scan.
export const PENDING_DISCARD_AUDIT_FILE = "a-pending-discard-audit.ndjson";
export const PENDING_NEW_ARCHIVE_DIR = "pending-new-archive";

export async function discardPendingDispatch(p, { now = Date.now() } = {}) {
  const pending = join(p.monitorDir, "pending-new", p.requestId.toLowerCase());
  const auditFile = join(p.monitorDir, PENDING_DISCARD_AUDIT_FILE);
  const audit = (entry) => appendFile(auditFile, JSON.stringify({
    ts: new Date().toISOString(), action: "discard-pending", agentId: p.agentId,
    space: p.space, requestId: p.requestId.toLowerCase(), ...entry,
  }) + "\n", "utf8");
  const refuse = async (code, detail = {}) => {
    await audit({ outcome: "DENIED", code, ...detail }).catch(() => {});
    console.error("RESULT=PENDING_DISCARD_DENIED code=" + code);
    console.error("OPERATOR_ACTION=discard-pending 仅清理未绑定、无投递证据的 PREPARED pending 目录；按失败码核对后重试，或显式换新 request-id 走 send-new。");
    return 2;
  };

  let request = null;
  try { request = JSON.parse(await readFile(join(pending, "a-new-request.json"), "utf8")); }
  catch { return await refuse("PENDING_REQUEST_UNREADABLE"); }
  if (typeof request?.requestId !== "string" || request.requestId.toLowerCase() !== p.requestId.toLowerCase() ||
      request.space !== p.space || request.agentId !== p.agentId) {
    return await refuse("PENDING_REQUEST_IDENTITY_MISMATCH");
  }
  let record = null;
  try { record = await readDispatchState(pending); }
  catch { return await refuse("PENDING_LEDGER_UNREADABLE"); }
  if (!record) return await refuse("PENDING_LEDGER_ABSENT");
  if (record.status !== "PREPARED") return await refuse("PENDING_LEDGER_NOT_PREPARED:" + record.status);
  if (typeof record.conversationUuid !== "string" ||
      record.conversationUuid.toLowerCase() !== p.requestId.toLowerCase()) {
    return await refuse("PENDING_BOUND_TO_CONVERSATION");
  }
  if (record.sendStartedAt != null || record.acceptedAt != null ||
      record.completedAt != null || record.replyFile != null) {
    return await refuse("PENDING_DELIVERY_EVIDENCE_PRESENT");
  }
  // No in-flight watch: an unacked wake marker or an open supervision handoff
  // means a supervision loop still owns this directory. Marker/status corruption
  // is never read as "no watch" (fail-closed, same contracts as the disarm scan).
  try {
    const marker = JSON.parse(await readFile(join(pending, "a-watch-exit.json"), "utf8"));
    const structureError = watchExitStructureError(marker);
    if (structureError) return await refuse("PENDING_WAKE_MARKER_INVALID");
    if (marker.acknowledgedAt === null) return await refuse("PENDING_WAKE_UNACKNOWLEDGED");
  } catch (error) {
    if (error?.code !== "ENOENT") return await refuse("PENDING_WAKE_MARKER_UNREADABLE");
  }
  try {
    const status = JSON.parse(await readFile(join(pending, "a-supervision-status.json"), "utf8"));
    const structureError = supervisionStatusStructureError(status);
    if (structureError) return await refuse("PENDING_SUPERVISION_STATUS_INVALID");
    if (status.pending !== null) return await refuse("PENDING_SUPERVISION_ALARM");
  } catch (error) {
    if (error?.code !== "ENOENT") return await refuse("PENDING_SUPERVISION_STATUS_UNREADABLE");
  }
  // The leftover draft-page reference (a-new-page.json, written by the send
  // template before task.newPage()) — evidence only; the browser is never touched.
  let draftPageLabel = null;
  try {
    draftPageLabel = JSON.parse(await readFile(join(pending, "a-new-page.json"), "utf8"))?.pageLabel ?? null;
  } catch { draftPageLabel = null; }

  let archivedTo = null;
  try {
    await withCommitLock(commitLockScopeOf(pending), async () => {
      // In-lock re-verification: the ledger must still be the SAME unbound
      // PREPARED instance this decision was made on — a concurrent binding or
      // recovery that moved it wins, and this discard aborts fail-closed.
      const fresh = await readDispatchState(pending);
      if (!fresh || fresh.dispatchId !== record.dispatchId || fresh.status !== "PREPARED" ||
          typeof fresh.conversationUuid !== "string" ||
          fresh.conversationUuid.toLowerCase() !== p.requestId.toLowerCase()) {
        throw new Error("PENDING_DISCARD_RACE_LOST");
      }
      const archiveRoot = join(p.monitorDir, PENDING_NEW_ARCHIVE_DIR);
      await mkdir(archiveRoot, { recursive: true });
      for (let attempt = 0; ; attempt++) {
        const target = join(archiveRoot,
          `${p.requestId.toLowerCase()}.archive-${now}${attempt > 0 ? "-" + attempt : ""}`);
        try {
          await rename(pending, target);
          archivedTo = target;
          break;
        } catch (error) {
          if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") throw error;
        }
      }
      // The audit trail rides with the archived evidence (best-effort; the
      // monitor-root audit row below is the authoritative record).
      await appendEvent(archivedTo, "PENDING_DISCARDED", {
        requestId: p.requestId.toLowerCase(), space: p.space, agentId: p.agentId,
        ledgerDispatchId: record.dispatchId,
      }).catch(() => {});
    });
  } catch (error) {
    if (isCommitLockError(error)) {
      return await refuse("PENDING_DISCARD_LOCK_FAILED:" + error.message);
    }
    if (error?.message === "PENDING_DISCARD_RACE_LOST") {
      return await refuse("PENDING_DISCARD_RACE_LOST");
    }
    throw error;
  }
  await audit({ outcome: "DISCARDED", archivedTo, ledgerDispatchId: record.dispatchId,
    ledgerStatus: record.status, draftPageLabel }).catch(() => {});
  console.log("RESULT=PENDING_DISCARDED requestId=" + p.requestId.toLowerCase() +
    " archivedTo=" + archivedTo +
    (draftPageLabel ? " draftPageLabel=" + draftPageLabel : ""));
  console.error("OPERATOR_ACTION=pending 目录已整体归档（原目录字节保留）；同 request-id 现在可直接重派 send-new，或显式换新。残留草稿页（如已填充）需人工关闭，浏览器侧未做任何改动。");
  return 0;
}

// ---- #40: PO-manual dispatch attach (managed tracking entry) ----
//
// When the managed dispatch gate fails repeatedly and the PO is authorized to
// send the message by hand in the existing conversation page, the local Agent
// previously had NO managed way to track that dispatch (probe/watch refused
// with DISPATCH_NOT_ARMED — the PO's message never enters a ledger). `manual-attach`
// binds the existing conversation into the managed tracking machinery:
//   ledger  — source=PO_MANUAL, status=UNCERTAIN (honest: a send happened but
//             acceptance is unproven; the probe's reconcileDispatch upgrades it
//             with real surface evidence), payload_sha256/payload_bytes/composer_
//             baseline all null (免 payload 指纹 — the PO's message text never
//             transits the agent), and ONLY the verified attach-time baseline
//             tail (baselineTailKey/Role) as the reply boundary.
//   arm     — armForDispatch (the frozen v4 arm machine), same 布防 order as
//             managed sends (arm before the ledger establishment); no
//             armedReason bypass anywhere.
//   registry— claimAgentSpace registers the conversation (known+active), so
//             collect's ownership check and the release sweep's keep semantics
//             anchor on it.
//   release — the PO-opened page stays 非 agent 所有: the sweep classifies it
//             FIXED_SESSION (no dispatch-created record) and never closes it;
//             the release preflight's unowned-tab stop keeps failing closed
//             while the PO's tab is open (existing keep semantics, unchanged).
//
// Fail-closed gates, in order (any failure writes NOTHING):
//   PO_MANUAL_AGENT_SPACE_UNPROVEN      — the declared agent does not provably own the space (registry);
//   PO_MANUAL_LEDGER_UNREADABLE         — corrupt ledger: never attach over an unprovable one;
//   PO_MANUAL_LEDGER_IN_MANAGED_LIFECYCLE:<st> — only an ABSENT or ABORTED (terminal) ledger may be
//                                         replaced; every other status is a managed lifecycle;
//   PO_MANUAL_PAGE_VERIFY_FAILED:<why>  — the browser verification refused (see the template:
//                                         space not found/foreign-owned, page not unique by exact
//                                         URL, surface unavailable, generation still active, tail
//                                         identity unavailable) — 绑定前必须核实页面属于该会话;
//   PO_MANUAL_PAGE_EVIDENCE_UNPARSEABLE — the verification output lacks complete evidence fields;
//   PO_MANUAL_REGISTRY_CLAIM_FAILED:<c> — claim refused (release pending / foreign space / ...);
//   PO_MANUAL_ARM_FAILED:<msg>          — the v4 arm write failed (incl. commit lock);
//   PO_MANUAL_ATTACH_RACE_LOST          — in-lock re-check: the ledger changed between the advisory
//                                         read and the commit;
//   PO_MANUAL_COMMIT_LOCK_FAILED:<msg>  — the monitor-root commit lock unavailable.
// A replaced ABORTED ledger is first archived byte-exact (exclusive-create
// a-dispatch-state.archive-<id8>-po-manual.json, never overwritten).
export const PO_MANUAL_SOURCE = "PO_MANUAL";

// Parse the verification template's evidence line:
//   RESULT=PO_MANUAL_PAGE_VERIFIED evidence={"pageLabel":...,"tailRole":"user|assistant",
//                                           "tailKey":"...","tailLen":N,"composerLength":N}
// Returns null on any absent/invalid field (fail-closed) — the ledger baseline is
// built ONLY from a complete, structurally valid evidence bundle.
export function parseVerifiedPageEvidence(output) {
  const line = String(output || "").split(/\r?\n/).reverse()
    .find((row) => row.startsWith("RESULT=PO_MANUAL_PAGE_VERIFIED"));
  if (!line) return null;
  const match = line.match(/ evidence=(\{.*\})\s*$/);
  if (!match) return null;
  let evidence;
  try { evidence = JSON.parse(match[1]); } catch { return null; }
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return null;
  const { pageLabel, tailRole, tailKey, tailLen, composerLength } = evidence;
  // pageLabel must be a real string: the ledger schema (validateDispatchRecord)
  // requires one, and the audit trail's draft-page reference needs it — an
  // unlabeled page refuses instead of writing a schema-invalid ledger.
  if (typeof pageLabel !== "string" || !pageLabel ||
      (tailRole !== "user" && tailRole !== "assistant") ||
      typeof tailKey !== "string" || !tailKey ||
      !Number.isFinite(tailLen) || tailLen < 0 ||
      !Number.isFinite(composerLength) || composerLength < 0) return null;
  return { pageLabel, tailRole, tailKey, tailLen, composerLength };
}

export async function manualAttachDispatch(p, { now = Date.now(), runVerify = null, directory = undefined } = {}) {
  const dir = conversationDir(p);
  const refuse = (code, hint) => {
    console.error("RESULT=PO_MANUAL_ATTACH_REFUSED code=" + code);
    console.error("OPERATOR_ACTION=" + hint);
    return 2;
  };
  // 1. Registry preflight (read-only): the declared agent must provably own the space.
  //    (`directory` is the rebuildSpace-precedent injection point — production
  //    callers use the machine registry.)
  let boundSpace = null;
  try {
    boundSpace = await withAgentRegistry((registry) => ({
      changed: false, value: registry.agents[p.agentId]?.spaceName ?? null,
    }), directory);
  } catch { boundSpace = null; } // an unreadable registry proves nothing
  if (boundSpace !== p.space) {
    return refuse("PO_MANUAL_AGENT_SPACE_UNPROVEN",
      "先用受管 claim 接管该空间（node monitor/dispatch-manager.mjs claim --monitor-dir <根> --agent-id <ID> --space <空间>），或核对 --agent-id/--space。");
  }
  // 2. Ledger pre-state: only ABSENT or a terminal ABORTED ledger may be attached over.
  let current = null;
  try { current = await readDispatchState(dir); }
  catch {
    return refuse("PO_MANUAL_LEDGER_UNREADABLE",
      "派单账本损坏：先人工备份 a-dispatch-state.json 并修复后再 attach；拒绝在不可读账本上建立。");
  }
  if (current && current.status !== "ABORTED") {
    return refuse("PO_MANUAL_LEDGER_IN_MANAGED_LIFECYCLE:" + current.status,
      current.status === "COMPLETED"
        ? "既有派单已 COMPLETED：先走受管 collect/consume/release 收尾，再考虑 attach。"
        : "既有受管派单仍在生命周期内（未终态）：等待其收敛，attach 不接管在途派单。");
  }
  // 3. Page verification (browser work stays OUTSIDE any commit lock). The
  // template fails closed unless exactly one page carries the conversation URL
  // AND a stable, non-generating tail identity is readable.
  const template = await readFile(templates["manual-attach"], "utf8");
  const observation = runVerify
    ? await runVerify(adaptTemplate(template, p), dir)
    : await runEgo(adaptTemplate(template, p), dir, "manual-attach");
  if (observation.code !== 0 || observation.result !== "PO_MANUAL_PAGE_VERIFIED") {
    announceTaskspaceOwnershipLoss(observation, p.space);
    return refuse("PO_MANUAL_PAGE_VERIFY_FAILED:" + String(observation.result || "EXIT_" + observation.code).slice(0, 80),
      "绑定前必须核实页面属于该会话（URL 精确匹配 + 尾消息证据）；按失败码排查（空间归属/页面唯一性/表面可用性/生成中/尾标识缺失）后重试。");
  }
  const evidence = parseVerifiedPageEvidence(observation.output);
  if (!evidence) {
    return refuse("PO_MANUAL_PAGE_EVIDENCE_UNPARSEABLE",
      "验证输出缺少完整证据字段（pageLabel/tailRole/tailKey/tailLen/composerLength）；重试 manual-attach。");
  }
  // 4. Registry claim — registers the conversation for collect ownership and
  // the sweep's keep semantics. Fail-closed: a refused claim writes no ledger.
  try {
    await claimAgentSpace({ agentId: p.agentId, spaceName: p.space, conversationUuid: p.conversation, directory });
  } catch (error) {
    return refuse("PO_MANUAL_REGISTRY_CLAIM_FAILED:" + String(error.code || error.message).slice(0, 80),
      "注册表 claim 失败：按失败码处理（release 挂起/空间他属/身份冲突）后重试。");
  }
  // 5. Arm FIRST (v4 arm machine, no bypass — same 布防-before-establishment
  // order as managed sends). The conversation ledger directory may not exist
  // yet (the PO-manual conversation was never managed before this attach), so
  // establish it here — the arm write is the first durable artifact.
  await mkdir(dir, { recursive: true });
  try {
    await armForDispatch(dir, { conversationUuid: p.conversation, space: p.space, timestamp: now });
  } catch (error) {
    return refuse("PO_MANUAL_ARM_FAILED:" + String(error.message || error.code || "UNKNOWN").slice(0, 80),
      "布防写入失败（含提交锁不可用）：状态保持原样，按失败码处理后重试。");
  }
  // 6. Ledger establishment under the monitor-root commit lock (the same
  // coordination domain every arm/prepare/disarm serializes on).
  let dispatchId = null;
  try {
    await withCommitLock(commitLockScopeOf(dir), async (guard) => {
      const fresh = await readDispatchState(dir);
      if (!fresh !== !current || (fresh && (fresh.status !== "ABORTED" || fresh.dispatchId !== current.dispatchId))) {
        throw new Error("PO_MANUAL_ATTACH_RACE_LOST");
      }
      let backup = null;
      if (fresh) backup = await backupLedgerBytes(dir, fresh.dispatchId, now, "po-manual");
      const record = {
        schema: "ego-dispatch-state/v2",
        dispatchId: randomUUID(),
        conversationUuid: p.conversation,
        taskSpace: p.space,
        pageLabel: evidence.pageLabel,
        baselineTailKey: evidence.tailKey,
        baselineTailRole: evidence.tailRole,
        baselineComposerLength: evidence.composerLength,
        // 免 payload 指纹 (#40): the PO pasted the message themselves; the text
        // never transits the agent, so there is no hash to store — the reply
        // boundary is the verified attach-time baseline tail alone.
        payload_sha256: null,
        payload_display_sha256: null,
        payload_bytes: null,
        composer_baseline: null,
        status: "UNCERTAIN",
        attempt: 1,
        createdAt: now,
        source: PO_MANUAL_SOURCE,
        uncertainAt: now,
        reasonCode: "PO_MANUAL_ATTACH",
      };
      await guard();
      await writeJsonAtomic(join(dir, "a-dispatch-state.json"), record);
      await appendEvent(dir, "PO_MANUAL_ATTACHED", {
        dispatchId: record.dispatchId, conversation: p.conversation, space: p.space,
        pageLabel: evidence.pageLabel, baselineTailRole: evidence.tailRole,
        ...(backup ? { backupFile: backup.file } : {}),
      });
      dispatchId = record.dispatchId;
    });
  } catch (error) {
    if (error?.message === "PO_MANUAL_ATTACH_RACE_LOST") {
      return refuse("PO_MANUAL_ATTACH_RACE_LOST",
        "账本在绑定期间被并发修改：重跑 manual-attach 以当前真态重新判定。");
    }
    if (isCommitLockError(error)) {
      return refuse("PO_MANUAL_COMMIT_LOCK_FAILED:" + error.message,
        "提交锁不可用（fail-closed）：稍后重跑 manual-attach；布防已写入但账本未变。");
    }
    return refuse("PO_MANUAL_LEDGER_WRITE_FAILED:" + String(error.code || error.message || "UNKNOWN").slice(0, 80),
      "账本写入失败：布防已写入但账本未建立，重跑 manual-attach。");
  }
  console.log("RESULT=PO_MANUAL_ATTACHED conversation=" + p.conversation + " dispatchId=" + dispatchId +
    " source=" + PO_MANUAL_SOURCE + " baselineTailRole=" + evidence.tailRole);
  console.error("OPERATOR_ACTION=已按 PO_MANUAL 受管绑定：现在可用受管 probe/watch 值守（回复就绪走受管 collect）。注意 PO 手动页面在 release 生命周期属非 agent 所有：清扫不会关闭它，PO 自行关闭页面前 release 保持 fail-closed。");
  return 0;
}

export function classifyManagerResult(action, observation, record, params) {
  if (action === "release") return observation.code === 0 && observation.result === "AGENT_SPACE_RELEASED" ? 0 : 2;
  // Managed claim: the template must prove the post-claim agent ownership.
  if (action === "claim") return observation.code === 0 && observation.result === "SPACE_CLAIMED_ACCOUNT_VERIFIED" ? 0 : 2;
  if (action !== "send") return 2;
  const sameDispatch = record && record.conversationUuid.toLowerCase() === params.conversation.toLowerCase() &&
    record.taskSpace === params.space;
  const accepted = sameDispatch && ["ACCEPTED", "COMPLETED"].includes(record.status);
  const clean = observation.code === 0 && observation.result === "AUTO_ACCEPTED_DISPATCH_ACCEPTED";
  if (accepted && clean) return 0;
  // The ledger is authoritative even when the browser script reports STOP.
  // An accepted send with a later error needs supervision, never a resend.
  return 2;
}

async function collectCompleted(params, dir) {
  const record = await readDispatchState(dir);
  if (!record || record.conversationUuid.toLowerCase() !== params.conversation.toLowerCase() || record.taskSpace !== params.space) {
    throw new Error("COLLECT_DISPATCH_MISMATCH");
  }
  if (record.status === "COMPLETED") {
    const receipt = await verifiedReply(dir, record);
    console.log("RESULT=REPLY_STAGED file=" + join(dir, receipt.file) + " sha256=" + receipt.sha256);
    return 0;
  }
  if (record.status !== "ACCEPTED") throw new Error("COLLECT_REQUIRES_ACCEPTED");
  // A previous successful extraction may have crashed before ledger completion.
  let receipt;
  try { receipt = await verifiedReply(dir, record); }
  catch (error) { if (error.message !== "REPLY_DELIVERY_REQUIRED") throw error; }
  if (!receipt) {
    const template = await readFile(templates.collect, "utf8");
    const observation = await runEgo(adaptTemplate(template, params), dir, "collect");
    if (observation.code !== 0 || observation.result !== "REPLY_COLLECTED") {
      // agent-kit#33: a takeover signal surfacing from collect must carry the
      // operator guidance; other failures keep their bare exit.
      announceTaskspaceOwnershipLoss(observation, params.space);
      return 2;
    }
    receipt = await verifiedReply(dir, record);
  }
  await markCompleted(dir, record.dispatchId);
  console.log("RESULT=REPLY_STAGED file=" + join(dir, receipt.file) + " sha256=" + receipt.sha256);
  return 0;
}

// ---- #27 Batch 3 (ruling §四.1/.2): arm-on-wait — armed-state persistence ----
//
// The frozen four-state machine lives in state-schema.mjs (ARMED_REASONS /
// armedTransitionPatch). This module owns the TRIGGERS:
//   arm  — a new dispatch persists its armed state BEFORE delivery, so there
//          is never a window where a message was sent while the state still
//          reads disarmed (ruling §四.2 "新派单先布防再投递");
//   disarm — the release path writes DISARMED_IDLE only after the full
//          criteria of evaluateDisarmEligibility() hold, in the ruling's
//          order: confirm terminal with nothing in flight -> write disarm ->
//          stop the watch (returning from the watch loop).
// The probe (ego-fast-probe.mjs) owns the DISPATCH_ACCEPTED ->
// PEER_GENERATING upgrade via armedReasonOnProbeRound() and never disarms.

const fastStateFileOf = (dir) => join(dir, "a-fast-state.json");

// Read the fast state for an arm/disarm decision. Missing and legacy v3
// ledgers are distinct outcomes; anything that fails the v4 contract is
// "corrupt" and is handled fail-closed by the callers (ARMED_UNKNOWN /
// blockers), never as a clean slate to write over silently.
async function readFastStateForDecision(dir) {
  let parsed;
  try { parsed = JSON.parse(await readFile(fastStateFileOf(dir), "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") return { classification: "missing", value: null };
    return { classification: "corrupt", value: null };
  }
  const classification = classifyFastStateFile(parsed);
  if (classification === "current") return { classification, value: parsed };
  if (classification === "legacy") {
    return { classification, value: normalizeFastState(parsed, {}, Number.isFinite(parsed?.ts) ? parsed.ts : Date.now()) };
  }
  return { classification: "corrupt", value: null };
}

function currentArmedReasonOf(classification, value) {
  if ((classification === "current" || classification === "legacy") &&
      ARMED_REASONS.has(value?.armedReason)) return value.armedReason;
  return null;
}

// P1-A (planner BLOCKED ruling §二): a corrupt fast state is durable blocking
// evidence, never a clean slate. Arming over it must (a) preserve the original
// bytes in an exclusive-create archive (never overwritten — collisions get
// timestamp/counter siblings, the abort-backup precedent) and (b) leave a
// carry-over marker the delivery-side storm gate reads (dispatch-state.mjs
// dispatchStormGate refuses on errorCode "STATE_CORRUPT"), so a corrupted
// ledger cannot gain delivery permission by executing arm. The archive is
// forensics; the gate closure rests on the carry-over marker alone.
async function archiveCorruptFastState(dir, timestamp = Date.now()) {
  const bytes = await readFile(fastStateFileOf(dir));
  const base = "a-fast-state.archive-corrupt-arm";
  for (let attempt = 0; ; attempt++) {
    const target = attempt === 0 ? `${base}.json` : `${base}-${timestamp}${attempt > 1 ? "-" + attempt : ""}.json`;
    try {
      const handle = await open(join(dir, target), "wx", 0o600);
      try { await handle.writeFile(bytes); } finally { await handle.close(); }
      return target;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
}

// Persist the arm state for a new dispatch. Idempotent per state machine: an
// already-armed state simply re-anchors DISPATCH_ACCEPTED. A missing ledger
// arms cleanly from null; a CORRUPT fast state must not be re-read as health —
// it lands in ARMED_UNKNOWN (fail-closed armed, never auto-disarmed, ruling
// §四.1) WITH the P1-A corrupt carry-over so the storm gate stays shut. A
// legacy v3 ledger arms from null for the new dispatch (the ruling's legacy
// clause forbids inferring DISARM, not recording an explicit new arm).
//
// P1-C round 5 (ruling requirements 1+4): the whole arm write section runs
// under the serialized commit lock (withCommitLock, dispatch-state.mjs) — the
// same coordination mechanism prepareDispatch's PREPARED ledger establishment
// and disarmAfterRelease's final commit use; round 6 (P1-C-3) promoted the
// lock to the MONITOR ROOT scope (commitLockScopeOf), so arms on different
// conversations of one monitor root serialize against the disarm commit's
// global in-flight criterion. Fail-closed: an unavailable lock aborts the arm
// BEFORE any state write, so main() never reaches the delivery template
// (ARM_COMMIT_LOCK_FAILED, exit 2, nothing sent).
// The arm also stamps armedSupersededDispatchId with the dispatchId of the
// TERMINAL ledger observed at arm time (dispatch-manager's route-(a) instance
// mark): the disarm commit of THAT instance reads the stamp fresh under the
// lock and refuses when a newer dispatch armed over it in the identity-check →
// write window. Round 6 (P1-C-2): the arm may ALSO stamp an ACTIVE (in-flight)
// ledger instance — but only when the caller explicitly declares
// `supersedesActiveInstance` (a new dispatch that WILL replace that instance
// once it reaches terminal state). The default stays stamp-null for ACTIVE
// ledgers, and deliberately so: an undeclared arm over an in-flight ledger is
// exactly the frozen template's abort/resume flows (DISPATCH_IN_FLIGHT_* /
// same-payload PREPARED resume / recover-draft) — stamping those would poison
// the in-flight instance's own later disarm with a permanent
// DISARM_ARMED_INSTANCE_SUPERSEDED blocker (the self-re-arm trap the ruling
// names). A declared superseding arm over an ACTIVE ledger closes the ruling's
// remaining interleave: A (ACTIVE) → B arms (declared) → A completes → A's
// disarm commit reads the stamp under the lock and refuses, so B's PREPARED
// establishment can never land behind A's DISARMED_IDLE. The consistency
// repair in prepareDispatch (dispatch-state.mjs) covers the undeclared path.
// An unreadable ledger stamps nothing (the disarm commit's own in-lock ledger
// re-read stays fail-closed for that case).
export async function armForDispatch(dir, { conversationUuid = null, space = null, timestamp = Date.now(), commitLock = null, supersedesActiveInstance = false } = {}) {
  try {
    return await withCommitLock(commitLockScopeOf(dir), async (guard) => {
      // P1-C round 3: a new dispatch never inherits the previous round's release
      // success — any leftover companion credential is cleared BEFORE the new arm
      // state is written. A failed clear aborts the whole arm fail-closed (arming
      // over a stale credential would reopen the cross-dispatch inheritance gap;
      // the same ordering precedent as the P1-A archive-before-write).
      try { await unlink(join(dir, DISARM_CREDENTIAL_FILE)); }
      catch (error) {
        if (error.code !== "ENOENT") throw new Error("ARM_DISARM_CREDENTIAL_CLEAR_FAILED");
      }
      // The supersession stamp (round 5 terminal, round 6 declared-ACTIVE):
      // which dispatch instance, if any, did this arm supersede? Read INSIDE
      // the lock, same critical section as the fast-state write below.
      let superseded = null;
      try {
        const ledger = await readDispatchState(dir);
        if (ledger) {
          if (ledger.status === "COMPLETED" || ledger.status === "ABORTED") {
            superseded = ledger.dispatchId;
          } else if (supersedesActiveInstance && IN_FLIGHT_DISPATCH_STATUSES.has(ledger.status)) {
            superseded = ledger.dispatchId;
          }
        }
      } catch { /* unreadable ledger stamps nothing — fail-closed stays with the disarm commit */ }
      const { classification, value } = await readFastStateForDecision(dir);
      const current = currentArmedReasonOf(classification, value);
      const target = classification === "corrupt" ? "ARMED_UNKNOWN" : "DISPATCH_ACCEPTED";
      const decision = armedTransitionPatch(current, target, { conversation: conversationUuid, space, timestamp });
      if (!decision.ok) throw new Error(`ARM_TRANSITION_REJECTED:${current}->${target}`);
      let corruptArchive = null;
      if (classification === "corrupt") {
        try { corruptArchive = await archiveCorruptFastState(dir, timestamp); }
        catch (error) {
          // P1-A (re-review round 2): an archive failure aborts THIS arm write.
          // The original corrupt ledger is durable blocking evidence the storm
          // gate refuses on as-is, so it is never overwritten just to arm — the
          // write below (and the ARMED_DISPATCH_ACCEPTED event) never run. The
          // failure stays in the event audit, then the whole arm fails closed and
          // the send surfaces MANAGER_FAILURE without any delivery.
          await appendEvent(dir, "CORRUPT_STATE_ARCHIVE_FAILED", {
            code: String(error?.code || error?.message || "UNKNOWN").slice(0, 80),
          }).catch(() => {});
          throw new Error("ARM_CORRUPT_STATE_ARCHIVE_FAILED");
        }
      }
      const armPatch = { ...decision.patch, armedSupersededDispatchId: superseded };
      const next = normalizeFastState(classification === "current" || classification === "legacy" ? value : {},
        classification === "corrupt"
          // P1-A carry-over: mirrors the probe's own corrupt landing (probeFailed +
          // errorCode STATE_CORRUPT) so every reader that treats the marker as a
          // structural failure — the storm gate included — keeps refusing.
          ? { ...armPatch, probeFailed: true, recoveryFailed: true, errorCode: "STATE_CORRUPT" }
          : armPatch, timestamp);
      // P1-C-1 (round 6): ownership re-verification immediately before the
      // fast-state write — a holder displaced mid-section aborts
      // (COMMIT_LOCK_LOST → ARM_COMMIT_LOCK_FAILED, nothing armed, nothing
      // delivered) instead of co-committing with the new holder.
      await guard();
      await writeJsonAtomic(fastStateFileOf(dir), next);
      await appendEvent(dir, "ARMED_DISPATCH_ACCEPTED", {
        conversation: conversationUuid, space: space ?? null,
        previousReason: current, sourceClassification: classification,
        ...(superseded ? { supersededDispatchId: superseded } : {}),
        ...(corruptArchive ? { corruptArchive, stormCarryOver: "STATE_CORRUPT" } : {}),
      });
      return next;
    }, commitLock ?? undefined);
  } catch (error) {
    // Fail-closed (ruling requirement 4): an arm that cannot take the commit
    // lock never arms and never delivers — main() aborts before the template.
    if (isCommitLockError(error)) throw new Error("ARM_COMMIT_LOCK_FAILED:" + error.message);
    throw error;
  }
}

// ---- #27 Batch 3 P1-B: mirrored wake-guard structure contracts ----
//
// SELF-CONTAINED MIRROR of plugins/chatgpt-dispatch-guard/hooks/wake-context.mjs
// (watchExitStructureError / supervisionStatusStructureError, exported there by
// the same fix round). Design note (ruling §二 P1-B "复用已有校验口径，不发明
// 新规则"): the guard hook must stay import-free of monitor/** (it cannot be
// allowed to fail when monitor modules are mid-refresh) and the monitor
// runtime copies never include the plugins tree, so the contract is mirrored
// verbatim and pinned by equivalence tests that run BOTH implementations over
// the same case table and require identical verdicts (tests/arm-machine.test.mjs).
// Any contract change must land on both sides in the same commit.

const UUID_PATTERN = /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const ACK_ACTIONS = new Set(["investigated", "resolved"]);
const SUPERVISION_SCHEMA = "ego-supervision/v1";

export function watchExitStructureError(marker) {
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return "WATCH_EXIT_MARKER_INVALID";
  if (marker.schema !== WATCH_EXIT_SCHEMA) return "WATCH_EXIT_SCHEMA_INVALID";
  if (typeof marker.wakeId !== "string" || !UUID_PATTERN.test(marker.wakeId)) return "WATCH_EXIT_WAKE_ID_INVALID";
  if (!Number.isFinite(marker.issuedAt)) return "WATCH_EXIT_ISSUED_AT_INVALID";
  if (marker.exitCode !== 2) return "WATCH_EXIT_EXIT_CODE_INVALID";
  // Un-acked: both ack fields null. Acked: finite acknowledgedAt plus a legal
  // action. Any other combination violates ego-watch-exit/v1 — an illegal
  // acknowledgedAt string is corruption, never a proof of acknowledgement.
  const unacked = marker.acknowledgedAt === null && marker.ackAction === null;
  const acked = Number.isFinite(marker.acknowledgedAt) && ACK_ACTIONS.has(marker.ackAction);
  if (!unacked && !acked) return "WATCH_EXIT_ACK_COMBINATION_INVALID";
  return null;
}

export function supervisionStatusStructureError(status) {
  if (!status || typeof status !== "object" || Array.isArray(status)) return "SUPERVISION_STATUS_INVALID";
  if (status.schema !== SUPERVISION_SCHEMA) return "SUPERVISION_SCHEMA_INVALID";
  // loadStatus() contract (supervision-watchdog.mjs): the watchdog never writes
  // a ledger without these three fields being valid.
  if (!Number.isInteger(status.abnormalRounds) || status.abnormalRounds < 0) return "SUPERVISION_ABNORMAL_ROUNDS_INVALID";
  if (!Number.isFinite(status.progressAt)) return "SUPERVISION_PROGRESS_AT_INVALID";
  if (!Number.isFinite(status.lastReviewAt)) return "SUPERVISION_LAST_REVIEW_AT_INVALID";
  // A missing pending property is NOT the same as pending: null — the watchdog's
  // empty() always writes pending: null explicitly. A bare {} is corruption.
  if (!("pending" in status)) return "SUPERVISION_PENDING_MISSING";
  const pending = status.pending;
  if (pending === null) return null; // no alarm armed
  if (typeof pending !== "object" || Array.isArray(pending)) return "SUPERVISION_PENDING_INVALID";
  if (typeof pending.id !== "string" || pending.id === "") return "SUPERVISION_PENDING_ID_INVALID";
  if (!Number.isFinite(pending.issuedAt)) return "SUPERVISION_PENDING_ISSUED_AT_INVALID";
  return null;
}

// P1-C (re-review round 2): the release-success credential for DEFERRED disarm
// retries. Two different release outcomes leave two different durable wake
// reasons in the conversation's ego-watch-exit ledger (exitWatching): a
// VERIFIED release (AGENT_SPACE_RELEASED) whose disarm was blocked writes
// DISARM_DEFERRED_WAKE_SUPERVISOR; a FAILED release writes
// REPLY_DELIVERED_RELEASE_PENDING. Only the first is proof a real release
// succeeded. The credential rides the existing wake marker (the ruling's
// sanctioned carrier — no new file format, no daemon): every watch exit
// overwrites it, so a later failed release automatically invalidates a stale
// credential, and the frozen ego-watch-exit/v1 structure contract keeps a
// hand-edited or corrupt marker from counting. This closes the production
// incident: dispatch COMPLETED + reply consumed -> release FAILED
// (SPACE_HAS_UNREGISTERED_PAGE_STOP) -> REPLY_DELIVERED_RELEASE_PENDING ->
// supervisor ack -> an un-gated retry wrote DISARMED_IDLE while the page was
// still open. Normal reply wakes, normal acks and normal consumes carry no
// credential and can never disarm through the retry path.
//
// P1-C (re-review round 3): the round-2 marker reason alone was not bound to a
// dispatch INSTANCE. A stale DISARM_DEFERRED marker that survives a later
// dispatch's failed marker write (exitWatching swallows write errors and
// exits) would still authorize a disarm for a dispatch that never released.
// The credential is therefore a COMPANION FILE issued only at the two
// deferred-disarm handoff sites, and the retry gate requires the PAIR:
//   write — issueDisarmCredential() atomically writes
//     a-disarm-credential.json ({ schema, dispatchId, issuedAt }) right before
//     the DISARM_DEFERRED handoff, in releaseDelivered (watch path) and the
//     direct release action of main(); both after a release VERIFIED successful
//     in the same call whose disarm was deferred.
//   clear — armForDispatch unlinks the credential BEFORE writing the new arm
//     state, so a new dispatch on the same conversation never inherits the
//     previous round's release success; a failed clear aborts the arm
//     fail-closed (ARM_DISARM_CREDENTIAL_CLEAR_FAILED).
//   verify — hasDeferredReleaseCredential() requires BOTH a structurally valid
//     ego-watch-exit/v1 marker still recording DISARM_DEFERRED (a later failed
//     release overwrites the marker and invalidates the pair, preserving the
//     round-2 property) AND a schema-valid companion credential whose
//     dispatchId equals the dispatch ledger's CURRENT dispatchId. Absent,
//     corrupt, foreign-schema or wrong-instance credentials all read as
//     unproven (fail-closed, stays armed). The seven-field ego-watch-exit/v1
//     marker contract, the ack mechanism and the release state machine are
//     untouched; the marker's ack discipline is still enforced by the
//     WAKE_MARKER_UNACKNOWLEDGED criterion of the frozen
//     evaluateDisarmEligibility contract — no second close-page channel.
//
// P1-C (re-review round 4): three closures on top of the companion credential:
//   structure — the credential must carry a finite issuedAt as well; an
//     incomplete {schema, dispatchId} credential is corruption, never proof.
//   lifecycle — every REAL release attempt (watch releaseDelivered AND the
//     direct release action) first clears THIS dispatch's leftover credential
//     (clearDisarmCredential); a failed clear aborts the release before any
//     browser work, so a release never runs while carrying a previous round's
//     success. A credential is (re)issued only when THIS attempt verifies
//     successful and defers its disarm.
//   identity — the dispatchId verified at release entry (terminal + consumed)
//     is carried through the whole flow: disarmAfterRelease requires the
//     ledger to STILL belong to that instance (blocker
//     DISARM_LEDGER_IDENTITY_CHANGED — a concurrent send may lawfully replace
//     a COMPLETED ledger, the send template only guards in-flight states) and
//     the credential is written with the ORIGINALLY VERIFIED dispatchId, never
//     a re-read of a possibly replaced ledger. Both release paths share this
//     one contract; the retry path (retryPendingDisarm) re-proves the same
//     instance between credential verification and the disarm write.
const DISARM_DEFERRED_REASON = "DISARM_DEFERRED_WAKE_SUPERVISOR";
const DISARM_CREDENTIAL_SCHEMA = "ego-disarm-credential/v1";
const DISARM_CREDENTIAL_FILE = "a-disarm-credential.json";

// Best-effort issuance of the companion release-success credential for a
// deferred disarm of THIS dispatch instance. A failed write is fail-closed
// safe: the retry gate then finds no credential and the ledger simply stays
// armed; the structured wake handoff the caller performs next owns the
// escalation either way.
async function issueDisarmCredential(dir, dispatchId, timestamp = Date.now()) {
  try {
    await writeJsonAtomic(join(dir, DISARM_CREDENTIAL_FILE), {
      schema: DISARM_CREDENTIAL_SCHEMA, dispatchId, issuedAt: timestamp,
    });
  } catch (error) {
    console.error("RESULT=DISARM_CREDENTIAL_WRITE_FAILED dispatchId=" + dispatchId +
      " code=" + String(error?.code || error?.message || "UNKNOWN").slice(0, 80));
  }
}

// P1-C round 4 (gap 3): clear THIS dispatch's previous release-success
// credential before a real release attempt starts. The only legitimate way a
// credential exists while a release begins is a stale one from a prior attempt
// of the same dispatch (success deferred, then acked, then the retry failed) —
// carrying it through a FAILED attempt would leave the stale pair (old
// deferred marker + old credential) armed behind a release failure, and a
// repeated consume would then converge a disarm this dispatch never re-proved.
// Fail-closed: a failed clear aborts the release before any browser work.
async function clearDisarmCredential(dir) {
  try {
    await unlink(join(dir, DISARM_CREDENTIAL_FILE));
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("RELEASE_DISARM_CREDENTIAL_CLEAR_FAILED");
  }
}

// Verify the deferred-disarm evidence pair (wake marker + companion
// credential). Returns the dispatchId the pair is bound to — which must equal
// the dispatch ledger's CURRENT dispatchId — or null when unproven, so the
// caller re-proves the SAME dispatch instance at disarm time (closing the
// check/write race between this verification and the arm-state write).
// Fail-closed: absent, unreadable, corrupt, foreign-schema, structurally
// incomplete (no finite issuedAt, round 4 gap 1), or foreign-instance
// evidence all read as unproven and the state stays armed.
async function hasDeferredReleaseCredential(dir) {
  // Criterion 1: the wake marker still records a deferred disarm of a verified
  // release (the frozen round-2 structure contract still applies). Any later
  // watch exit — a reply wake, a release failure, an exception — overwrites
  // the marker and invalidates the pair.
  try {
    const marker = JSON.parse(await readFile(join(dir, "a-watch-exit.json"), "utf8"));
    if (watchExitStructureError(marker)) return null;
    if (marker.reason !== DISARM_DEFERRED_REASON) return null;
  } catch { return null; } // absent/unreadable = unproven (fail-closed)
  // Criterion 2: the companion credential exists, carries the frozen schema,
  // a finite issuedAt (round 4 gap 1: an incomplete {schema, dispatchId}
  // credential is corruption, never proof), and names the dispatch ledger's
  // CURRENT dispatchId. Anything else — absent, unreadable, corrupt,
  // foreign-schema, or issued for a previous dispatch instance (the
  // cross-dispatch inheritance gap) — cannot prove that THIS dispatch ever
  // released, so the state stays armed.
  let credential = null;
  try { credential = JSON.parse(await readFile(join(dir, DISARM_CREDENTIAL_FILE), "utf8")); }
  catch { return null; }
  if (!credential || typeof credential !== "object" || Array.isArray(credential) ||
      credential.schema !== DISARM_CREDENTIAL_SCHEMA ||
      typeof credential.dispatchId !== "string" ||
      !Number.isFinite(credential.issuedAt)) return null;
  let record = null;
  try { record = await readDispatchState(dir); }
  catch { return null; } // unreadable ledger = unprovable ownership (fail-closed)
  if (!record || credential.dispatchId !== record.dispatchId) return null;
  return credential.dispatchId;
}

// P1-C round 6 (P1-C-3): the GLOBAL in-flight scan shared by the advisory
// pass and the serialized commit of disarmAfterRelease. Counts every sibling
// dispatch ledger under <root>/conversations and <root>/pending-new (own
// directory excluded) that cannot be proven terminal — unreadable or
// structurally invalid ledgers count as in-flight (P1-4 conservative
// default), and a lingering pending-new directory counts as in-flight
// wholesale. `unreadable` flags a base directory that could not be listed
// (a missing directory proves no sibling exists; any other read failure is
// unconfirmable).
async function countInFlightSiblings(root, ownDir) {
  let count = 0;
  let unreadable = false;
  const scanBase = async (base, { missingCountsInFlight }) => {
    let entries;
    try { entries = await readdir(base, { withFileTypes: true }); }
    catch (error) {
      if (error?.code !== "ENOENT") unreadable = true;
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || join(base, entry.name) === ownDir) continue;
      try {
        const sibling = JSON.parse(await readFile(join(base, entry.name, "a-dispatch-state.json"), "utf8"));
        if (!validateDispatchRecord(sibling) || IN_FLIGHT_DISPATCH_STATUSES.has(sibling.status)) count++;
      } catch (error) {
        if (error?.code !== "ENOENT" || missingCountsInFlight) count++;
      }
    }
  };
  await scanBase(join(root, "conversations"), { missingCountsInFlight: false });
  await scanBase(join(root, "pending-new"), { missingCountsInFlight: true });
  return { count, unreadable };
}

// Write DISARMED_IDLE for a conversation whose release just completed. All
// ruling §四.2 criteria are gathered here and passed to the pure
// evaluateDisarmEligibility(); any blocker (or any unreadable evidence —
// fail-closed) leaves the armed state untouched: staying armed is the safe
// direction, and the wake-guard plus the next dispatch round own the fallout.
// Idempotent: an already DISARMED_IDLE state with satisfied criteria reports
// success without rewriting. A legacy ledger without arm fields is never
// auto-disarmed (ruling §四.1). The caller sequence already confirmed the
// terminal state with nothing in flight (verified release + consumption), so
// this function re-proves the criteria on the durable ledgers before writing.
// P1-C round 4 (gap 2): the caller must also carry the dispatchId whose
// release it actually VERIFIED (expectedDispatchId) — the disarm only fires
// while the ledger still belongs to that instance. The send template only
// guards in-flight ledgers, so a new dispatch may lawfully start while a
// release of the previous COMPLETED dispatch is running; without this binding
// the disarm would read the replaced ledger's terminal/consumption state and
// the credential would be misbound to the new instance.
//
// P1-C round 5 (ruling requirements 2+3+4): the FINAL identity confirmation
// and the DISARMED_IDLE write are ONE critical section under the
// per-conversation commit lock. The evidence gathering above stays outside the
// lock (it is advisory); the authoritative sequence inside the lock is:
//   acquire lock → re-read ledger → identity re-verification (expectedDispatchId)
//   → re-read fast state → armed-instance re-verification
//     (armedSupersededDispatchId, stamped by every coordinated arm) →
//   global sibling in-flight re-scan (round 6, P1-C-3) → transition check →
//   ownership guard (round 6, P1-C-1) → write DISARMED_IDLE → release lock.
// A concurrent dispatch B that armed (and/or replaced the ledger) either did so
// BEFORE the lock was taken — then the in-lock re-reads see B's stamp or B's
// ledger and refuse — or must WAIT for the lock, and then re-arms over the
// already-written DISARMED_IDLE (the legal DISARMED_IDLE → DISPATCH_ACCEPTED
// transition). Either way B's armed state is never overwritten (ruling
// requirement 4). `beforeCommit` is a test injection point (runScript
// precedent): it runs AFTER the advisory checks and BEFORE the lock is taken —
// exactly the un-held window the ruling's behavior tests must interleave into.
// `commitLock` forwards withCommitLock options (test-only bounded waits).
export async function disarmAfterRelease(dir, { rootMonitorDir = null, timestamp = Date.now(), expectedDispatchId = null, beforeCommit = null, commitLock = null } = {}) {
  const root = rootMonitorDir ?? dirname(dirname(dir));
  const blockers = [];
  // Arm state (current fast state). Missing/corrupt = unconfirmable.
  const { classification, value } = await readFastStateForDecision(dir);
  const current = currentArmedReasonOf(classification, value);
  if (classification === "missing") blockers.push("ARM_STATE_MISSING");
  else if (classification === "corrupt") blockers.push("ARM_STATE_UNREADABLE");
  else if (current === null) blockers.push("ARM_STATE_LEGACY_NO_DISARM_INFERENCE");
  // P1-B gap 3: the already-disarmed idempotent shortcut is never trusted
  // blindly — every remaining criterion is re-proven on fresh durable
  // evidence below before an alreadyDisarmed success is reported.
  const alreadyDisarmed = current === "DISARMED_IDLE";

  // Dispatch ledger: terminal + reply consumed.
  let record = null;
  try { record = await readDispatchState(dir); }
  catch { blockers.push("DISPATCH_LEDGER_UNREADABLE"); }
  if (!record && !blockers.includes("DISPATCH_LEDGER_UNREADABLE")) blockers.push("DISPATCH_LEDGER_ABSENT");
  // P1-C round 4 (gap 2): identity binding — an absent expectedDispatchId is
  // exactly as unprovable as a changed one (fail-closed; no caller may disarm
  // on the strength of a ledger state it never verified for an instance).
  if (record && (typeof expectedDispatchId !== "string" || record.dispatchId !== expectedDispatchId)) {
    blockers.push("DISARM_LEDGER_IDENTITY_CHANGED");
  }
  let replyConsumed = false;
  if (record?.status === "COMPLETED") {
    try { await verifiedConsumption(dir, record); replyConsumed = true; }
    catch { replyConsumed = false; }
  } else if (record?.status === "ABORTED") replyConsumed = true;

  // Unprocessed wake marker (un-acked ego-watch-exit ledger). P1-B gap 2: the
  // marker must pass the FULL ego-watch-exit/v1 structure contract (mirrored
  // above from wake-context.mjs) — a parseable JSON with an illegal ack
  // combination (e.g. a garbage acknowledgedAt string) is corruption, never
  // a proof of acknowledgement.
  let unackedWakes = 1;
  try {
    const marker = JSON.parse(await readFile(join(dir, "a-watch-exit.json"), "utf8"));
    const structureError = watchExitStructureError(marker);
    if (structureError) blockers.push("WAKE_MARKER_INVALID");
    else unackedWakes = marker.acknowledgedAt === null ? 1 : 0;
  } catch (error) {
    if (error?.code !== "ENOENT") blockers.push("WAKE_MARKER_UNREADABLE");
    else unackedWakes = 0;
  }

  // Unfinished supervision handoff. P1-B gap 1: a parseable file that violates
  // the ego-supervision/v1 structure contract (e.g. a bare {}) is corruption,
  // never "no pending" — mirrored above from wake-context.mjs, fail-closed.
  let supervisionPending = true;
  try {
    const status = JSON.parse(await readFile(join(dir, "a-supervision-status.json"), "utf8"));
    const structureError = supervisionStatusStructureError(status);
    if (structureError) blockers.push("SUPERVISION_STATUS_INVALID");
    else supervisionPending = status.pending !== null;
  } catch (error) {
    if (error?.code !== "ENOENT") blockers.push("SUPERVISION_STATUS_UNREADABLE");
    else supervisionPending = false;
  }

  // No other in-flight dispatch anywhere in this monitor root. A sibling
  // ledger that cannot be proven terminal (unreadable or structurally
  // invalid, P1-4 conservative default) counts as in-flight. P1-B gap 4: the
  // scan also covers pending-new/ — a durable new-session request still
  // sitting there is an in-flight dispatch (a completed binding is renamed
  // into conversations/ by bindNewConversation, so a lingering directory
  // means the allocation never finished). Round 6 (P1-C-3): this advisory
  // scan runs BEFORE the commit lock is taken, so the SAME scan is re-run
  // INSIDE the serialized commit below (shared countInFlightSiblings helper)
  // — the global otherInFlight===0 criterion is re-confirmed in the same
  // critical section as the DISARMED_IDLE write, under the MONITOR-ROOT
  // commit lock every sibling arm/prepare also serializes on. A sibling
  // dispatch that armed+prepared inside the scan→commit window is therefore
  // either already visible to the re-scan (blocker, no disarm) or still
  // waiting for the same lock (it re-arms legally over the written
  // DISARMED_IDLE) — an expired scan can never complete a disarm over a
  // sibling's in-flight dispatch.
  const siblingScan = await countInFlightSiblings(root, dir);
  if (siblingScan.unreadable) blockers.push("SIBLING_LEDGERS_UNREADABLE");
  const otherInFlight = siblingScan.count;

  // The ruling criteria are evaluated only on clean evidence; any
  // unreadable/unprovable step above already carries its own blocker.
  if (blockers.length) return { disarmed: false, alreadyDisarmed, blockers };
  // For the idempotent path the arm-state criterion is bypassed (it would
  // always fire ARM_STATE_ALREADY_DISARMED) — everything else runs through
  // the SAME frozen evaluateDisarmEligibility contract.
  const verdict = evaluateDisarmEligibility({
    armedReason: alreadyDisarmed ? "DISPATCH_ACCEPTED" : current,
    dispatchStatus: record.status,
    replyConsumed, unackedWakes, supervisionPending, otherInFlight,
  });
  if (verdict.blockers.length) {
    return { disarmed: false, alreadyDisarmed, blockers: verdict.blockers };
  }
  if (alreadyDisarmed) {
    // P1-B gap 3: re-verified idempotent success — no rewrite needed (and no
    // write means no commit-lock critical section is required here).
    return { disarmed: true, alreadyDisarmed: true, blockers: [] };
  }

  // Round 5 injection window (test-only, runScript precedent): between the
  // advisory identity confirmation above and the serialized commit below, A
  // holds NO lock — the exact window the ruling's behavior tests interleave a
  // concurrent new dispatch (real armForDispatch + real ledger replacement on
  // the real filesystem) into. Production callers never pass it.
  if (beforeCommit) await beforeCommit();

  // ---- Serialized commit (ruling requirements 2+4): identity confirmation and
  // the DISARMED_IDLE write are atomic under the MONITOR-ROOT commit lock
  // (round 6, P1-C-3) — the same lock every sibling conversation's arm and
  // PREPARED establishment serialize on, so the global otherInFlight===0
  // criterion is coordinated with them, not scanned past them.
  try {
    return await withCommitLock(commitLockScopeOf(dir), async (guard) => {
      // Fresh ledger identity — the authoritative check of THIS critical
      // section (the advisory record above may be stale by now).
      let fresh = null;
      try { fresh = await readDispatchState(dir); }
      catch { return { disarmed: false, alreadyDisarmed: false, blockers: ["DISPATCH_LEDGER_UNREADABLE"] }; }
      if (!fresh) return { disarmed: false, alreadyDisarmed: false, blockers: ["DISPATCH_LEDGER_ABSENT"] };
      if (typeof expectedDispatchId !== "string" || fresh.dispatchId !== expectedDispatchId) {
        return { disarmed: false, alreadyDisarmed: false, blockers: ["DISARM_LEDGER_IDENTITY_CHANGED"] };
      }
      // Fresh arm state: the fast state the write below is based on is re-read
      // INSIDE the lock, so a concurrent arm that committed after the advisory
      // read is never overwritten with the stale snapshot (the round-4 ruling's
      // exact race: A wrote DISARMED_IDLE from its pre-B read over B's arm).
      const armNow = await readFastStateForDecision(dir);
      if (armNow.classification === "missing") {
        return { disarmed: false, alreadyDisarmed: false, blockers: ["ARM_STATE_MISSING"] };
      }
      if (armNow.classification === "corrupt") {
        return { disarmed: false, alreadyDisarmed: false, blockers: ["ARM_STATE_UNREADABLE"] };
      }
      const freshCurrent = currentArmedReasonOf(armNow.classification, armNow.value);
      if (armNow.classification === "legacy" || freshCurrent === null) {
        return { disarmed: false, alreadyDisarmed: false, blockers: ["ARM_STATE_LEGACY_NO_DISARM_INFERENCE"] };
      }
      if (freshCurrent === "DISARMED_IDLE") {
        // Disarmed concurrently before this contender got the lock: nothing to
        // write, the state already IS the target.
        return { disarmed: true, alreadyDisarmed: true, blockers: [] };
      }
      // Armed-instance re-verification (route (a)): every coordinated arm
      // stamps armedSupersededDispatchId with the TERMINAL ledger it observed.
      // If that stamp is THIS dispatch's verified instance, a newer dispatch
      // armed over A's state inside the check→write window — A's disarm must
      // not clobber it. A missing stamp is the tolerant-read migration path
      // (see FAST_STATE_DEFAULTS): under the lock it certifies that no
      // coordinated arm has superseded this state (any coordinated arm WRITES
      // the stamp), so the in-lock ledger identity check alone suffices and
      // 存量会话 still converge.
      const stamp = typeof armNow.value?.armedSupersededDispatchId === "string"
        ? armNow.value.armedSupersededDispatchId : null;
      if (stamp !== null && stamp === expectedDispatchId) {
        return { disarmed: false, alreadyDisarmed: false, blockers: ["DISARM_ARMED_INSTANCE_SUPERSEDED"] };
      }
      // P1-C-3 (round 6): the GLOBAL in-flight criterion re-confirmed in the
      // same critical section as the write below. A sibling conversation's
      // dispatch that armed + prepared inside the advisory-scan→commit window
      // is visible here (its PREPARED ledger counts as in-flight) and keeps
      // this state armed; a sibling still waiting for this very lock cannot
      // have committed yet and re-arms legally afterwards.
      const inLockSiblings = await countInFlightSiblings(root, dir);
      if (inLockSiblings.unreadable) {
        return { disarmed: false, alreadyDisarmed: false, blockers: ["SIBLING_LEDGERS_UNREADABLE"] };
      }
      if (inLockSiblings.count > 0) {
        return { disarmed: false, alreadyDisarmed: false, blockers: ["OTHER_INFLIGHT_DISPATCH"] };
      }
      const decision = armedTransitionPatch(freshCurrent, "DISARMED_IDLE", {
        conversation: fresh.conversationUuid ?? null, space: fresh.taskSpace ?? null, timestamp,
      });
      if (!decision.ok) {
        return { disarmed: false, alreadyDisarmed: false, blockers: [`ARM_TRANSITION_REJECTED:${freshCurrent}->DISARMED_IDLE`] };
      }
      // P1-C-1 (round 6): ownership re-verification immediately before the
      // DISARMED_IDLE write — a holder displaced mid-section aborts
      // (COMMIT_LOCK_LOST → the state stays armed) instead of co-committing
      // with the new holder.
      await guard();
      await writeJsonAtomic(fastStateFileOf(dir), normalizeFastState(armNow.value, decision.patch, timestamp));
      await appendEvent(dir, "DISARMED_IDLE", { conversation: fresh.conversationUuid ?? null });
      return { disarmed: true, alreadyDisarmed: false, blockers: [] };
    }, commitLock ?? undefined);
  } catch (error) {
    // Fail-closed (ruling requirement 4): an unavailable commit lock keeps the
    // state armed — the deferred handoff (caller) owns the escalation.
    if (isCommitLockError(error)) {
      return { disarmed: false, alreadyDisarmed: false, blockers: ["DISARM_COMMIT_LOCK_FAILED:" + error.message] };
    }
    throw error;
  }
}

// ---- #27 Batch 3 (ruling §四.4): two page-label lifecycles ----
//
// The lifecycle classifier and its RELIABLE origin basis (P1-E fix round) live
// in release-sweep.mjs — the module the release cleanup template actually
// imports at runtime (dispatch-manager itself is never copied into a monitor
// dir, so the classifier must sit in a `modules`-copied file to be usable by
// both sides). It is re-exported here unchanged so the manager, the arm
// machine tests and the sweep share ONE definition:
//   FIXED_SESSION — registry-known page without a dispatch allocation record;
//     never closed by any sweep (only its own managed release closes it).
//   DISPATCH_TEMP — page created by the managed new-chat allocation flow
//     (durable a-new-request.json anchored to the conversation + space);
//     closable once its ledger is provably terminal.
export {
  PAGE_LABEL_LIFECYCLE, classifyPageLabelLifecycle, anchoredDispatchCreated,
} from "./release-sweep.mjs";

// Exported for testing with a runScript injection (rebuildSpace precedent);
// production callers use the default browser path.
export async function releaseDelivered(params, dir, { runScript } = {}) {
  const record = await readDispatchState(dir);
  if (!record || record.status !== "COMPLETED" ||
      record.conversationUuid.toLowerCase() !== params.conversation.toLowerCase() || record.taskSpace !== params.space) {
    throw new Error("RELEASE_REQUIRES_VERIFIED_COMPLETION");
  }
  await verifiedConsumption(dir, record);
  // P1-C round 4 (gap 2): bind THIS release to the dispatch instance verified
  // at entry; the id rides through the script run, the disarm and the
  // credential write below — never re-read from a ledger a concurrent send
  // may have replaced in the meantime (same identity contract as the direct
  // release path).
  const verifiedDispatchId = record.dispatchId;
  // P1-C round 4 (gap 3): a real release attempt never carries a previous
  // attempt's success credential — clear it first; a failed clear aborts the
  // release fail-closed (the error surfaces as watch scope above).
  await clearDisarmCredential(dir);
  const template = await readFile(templates.release, "utf8");
  const released = runScript
    ? await runScript(adaptTemplate(template, params), dir)
    : await runEgo(adaptTemplate(template, params), dir, "release");
  if (released.code !== 0 || released.result !== "AGENT_SPACE_RELEASED") {
    // #27 Batch 2: the release template may finish the ledger close but leave
    // temp-page cleanup incomplete (RESULT=AGENT_SPACE_RELEASE_SWEEP_FAILED).
    // The classification stays fail-closed (exit 2 below); the operator is
    // pointed at the sweep audit and the idempotent re-release.
    if (released.result === "AGENT_SPACE_RELEASE_SWEEP_FAILED") {
      console.error("OPERATOR_ACTION=release 临时页清理未完整完成（明细见监控根 a-release-sweep-audit.ndjson）：处置后重跑 release，幂等收尾。");
    }
    // The dispatch is already COMPLETED here, so wake-context's WATCH_STALE
    // backstop would never re-raise it; the only durable handoff is the
    // watch-exit marker. Exit 2 therefore goes through exitWatching (WG-03),
    // keeping the RESULT line text with the appended ledger wakeId.
    return exitWatching(dir, "REPLY_DELIVERED_RELEASE_PENDING");
  }
  console.log("RESULT=DISPATCH_FINISHED_AND_RELEASED");
  // #27 Batch 3 (ruling §四.2): the normal end sequence — the terminal state
  // with nothing in flight was just confirmed (verified release + consumption
  // above), so write the disarm BEFORE stopping the watch (returning 0 ends
  // the watch loop). A deferred disarm keeps the state armed (safe direction)
  // and MUST NOT leave the ledger stranded behind a success exit (P1-C): the
  // watch exits through the durable wake ledger instead, the supervisor acks
  // DISARM_DEFERRED_WAKE_SUPERVISOR, and the managed retry paths (ack /
  // consume / a re-run release) converge the disarm afterwards.
  const disarm = await disarmAfterRelease(dir, {
    rootMonitorDir: params.rootMonitorDir ?? dirname(dirname(dir)),
    expectedDispatchId: verifiedDispatchId,
  });
  if (!disarm.disarmed) {
    console.error("RESULT=DISARM_DEFERRED code=" + disarm.blockers.join(","));
    // P1-C round 3: the deferred handoff issues the companion release-success
    // credential (best-effort — a failed write just leaves the retry gate
    // unproven and the ledger armed) before the marker write; the retry gate
    // then requires the marker+credential pair. P1-C round 4 (gap 2): the
    // credential names the ORIGINALLY VERIFIED dispatchId even when the
    // ledger was replaced mid-release (the identity blocker above already
    // keeps the retry from ever converging on a foreign instance).
    await issueDisarmCredential(dir, verifiedDispatchId);
    return exitWatching(dir, "DISARM_DEFERRED_WAKE_SUPERVISOR", {
      detail: "code=" + disarm.blockers.join(","),
    });
  }
  return 0;
}

// P1-C round 4 (gap 2): the direct `release` action of main(), extracted so
// the dispatch identity binding is behaviorally testable (runScript
// injection, the releaseDelivered precedent). The dispatch instance verified
// at entry (terminal + consumed) is carried through the whole flow: the
// release script, the disarm convergence and the companion credential all
// bind to THAT id — the ledger is never re-read for a newer dispatchId, so a
// concurrent send on the same conversation (lawful while the previous ledger
// is COMPLETED) can never receive this release's success credential or have
// its ledger disarmed by it. Same identity contract as the watch path.
// NOTE: the first parameter is named `p` on purpose — it is the parsed arg
// object of the release action and the sweep-failure guidance line below
// keeps its pinned source form.
export async function directRelease(p, dir, { runScript } = {}) {
  const record = await readDispatchState(dir);
  if (!record || record.status !== "COMPLETED" ||
      record.conversationUuid.toLowerCase() !== p.conversation.toLowerCase() || record.taskSpace !== p.space) {
    throw new Error("RELEASE_REQUIRES_VERIFIED_COMPLETION");
  }
  await verifiedConsumption(dir, record);
  const verifiedDispatchId = record.dispatchId;
  // P1-C round 4 (gap 3): same pre-attempt credential clear as the watch
  // path — fail-closed (the error surfaces as MANAGER_FAILURE, exit 2).
  await clearDisarmCredential(dir);
  const template = await readFile(templates.release, "utf8");
  const observation = runScript
    ? await runScript(adaptTemplate(template, p), dir)
    : await runEgo(adaptTemplate(template, p), dir, "release");
  // agent-kit#33: takeover guidance on release failures, same as the watch path.
  if (observation.code !== 0) {
    announceTaskspaceOwnershipLoss(observation, p.space);
  }
  // #27 Batch 2: same truthful reporting for the direct `release` action —
  // the sweep-failure RESULT is already classified as exit 2 by
  // classifyManagerResult below.
  if (p.action === "release" && observation.result === "AGENT_SPACE_RELEASE_SWEEP_FAILED") {
    console.error("OPERATOR_ACTION=release 临时页清理未完整完成（明细见监控根 a-release-sweep-audit.ndjson）：处置后重跑 release，幂等收尾。");
  }
  const code = classifyManagerResult("release", observation, null, p);
  if (code !== 0) return code;
  // #27 Batch 3 (ruling §四.2): the direct release action follows the same
  // end sequence as the watch path — terminal confirmed (verified completion +
  // consumption + AGENT_SPACE_RELEASED), then write the disarm. No watch
  // process is involved here, so a deferred disarm is reported and left armed,
  // handing over through the same durable wake ledger as the watch path —
  // never a clean exit 0 over a stranded armed ledger.
  const disarm = await disarmAfterRelease(dir, {
    rootMonitorDir: p.rootMonitorDir ?? dirname(dirname(dir)),
    expectedDispatchId: verifiedDispatchId,
  });
  if (!disarm.disarmed) {
    console.error("RESULT=DISARM_DEFERRED code=" + disarm.blockers.join(","));
    // P1-C round 4 (gap 2): the credential is written with the ORIGINALLY
    // VERIFIED dispatchId — never a re-read of a ledger the concurrent send
    // may have replaced (the cross-dispatch misbinding this round closes).
    await issueDisarmCredential(dir, verifiedDispatchId);
    return exitWatching(dir, "DISARM_DEFERRED_WAKE_SUPERVISOR", {
      detail: "code=" + disarm.blockers.join(","),
    });
  }
  return 0;
}

// P1-C: the managed idempotent disarm retry shared by every action that
// touches a conversation's ledgers (consume, ack; release re-runs go through
// releaseDelivered's own disarm, which runs only after a release just verified
// as successful in the same call). P1-C re-review round 2: a retry only
// CONVERGES a prior successful release whose disarm was deferred — the
// DISARM_DEFERRED_WAKE_SUPERVISOR credential is verified BEFORE any arm-state
// touch, so release-failure wakes, normal reply wakes, normal acks and normal
// consumes never disarm through here. P1-C re-review round 3: the credential
// check is bound to the dispatch INSTANCE (marker reason + companion
// a-disarm-credential.json naming the ledger's current dispatchId — see
// hasDeferredReleaseCredential), so a stale surviving marker from a previous
// dispatch can never authorize this dispatch's disarm. P1-C re-review round 4
// (gap 2): the instance proven at verification time is carried into the
// disarm (expectedDispatchId), so a ledger replaced between the check and the
// write cannot be disarmed on evidence verified for the previous instance.
// P1-C round 5 (ruling requirement 3): the retry path converges through
// disarmAfterRelease's serialized commit section, so the credential
// verification → DISARMED_IDLE write window carries the SAME per-conversation
// commit-lock protection as the direct release paths. `beforeCommit` /
// `commitLock` are forwarded unchanged (test injection, runScript precedent —
// production callers never pass them).
// Best-effort by contract: a retry failure never flips the hosting action's
// result — the structured wake (above) owns the escalation when the disarm
// stays blocked. No background daemon, no change to the existing watch
// scheduling.
export async function retryPendingDisarm(dir, { rootMonitorDir = null, beforeCommit = null, commitLock = null } = {}) {
  try {
    const verifiedDispatchId = await hasDeferredReleaseCredential(dir);
    if (!verifiedDispatchId) {
      return { disarmed: false, alreadyDisarmed: false, blockers: ["RELEASE_SUCCESS_UNPROVEN"] };
    }
    const retry = await disarmAfterRelease(dir, {
      rootMonitorDir: rootMonitorDir ?? dirname(dirname(dir)),
      expectedDispatchId: verifiedDispatchId,
      ...(beforeCommit ? { beforeCommit } : {}),
      ...(commitLock ? { commitLock } : {}),
    });
    if (retry.disarmed && !retry.alreadyDisarmed) {
      console.log("RESULT=DISARM_RETRY_COMPLETED");
    }
    return retry;
  } catch (error) {
    console.error("RESULT=DISARM_RETRY_FAILED code=" +
      String(error?.code || error?.message || "UNKNOWN").slice(0, 80));
    return { disarmed: false, alreadyDisarmed: false, blockers: ["DISARM_RETRY_FAILED"] };
  }
}

async function readLocalProfileConfig() {
  try { return JSON.parse(await readFile(join(homedir(), ".agents", "ego-profile.json"), "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error("SPACE_REBUILD_PIN_CONFIG_INVALID");
  }
}

// A rebuilt TaskSpace must be provably owned before any browser is touched —
// otherwise the guard would be right to block ad-hoc rebuilds (agent-kit#31).
// Primary evidence: the machine-wide ownership ledger still binds this agent to
// this space (it survives ego restarts; releasePending still blocks). Fallback:
// an explicit machine-local allowlist for spaces whose ledger entry is gone too —
// and never for a space another agent still owns.
export async function authorizeSpaceRebuild(agentId, space, { directory, profileConfig } = {}) {
  const evidence = await withAgentRegistry((registry) => ({
    changed: false,
    value: {
      entry: registry.agents[agentId] ? structuredClone(registry.agents[agentId]) : null,
      spaceTaken: Object.entries(registry.agents).some(([id, owned]) => id !== agentId && owned.spaceName === space),
    },
  }), directory);
  if (evidence.entry) {
    if (evidence.entry.spaceName !== space) throw new Error("SPACE_REBUILD_AGENT_BOUND_TO_OTHER_SPACE");
    if (evidence.entry.releasePending) throw new Error("AGENT_SPACE_RELEASE_PENDING");
    return "LEDGER_PROOF";
  }
  if (evidence.spaceTaken) throw new Error("SPACE_OWNED_BY_ANOTHER_AGENT");
  const config = profileConfig ?? await readLocalProfileConfig();
  if (Array.isArray(config?.spaceRebuildAllowlist) && config.spaceRebuildAllowlist.includes(space)) return "ALLOWLIST";
  throw new Error("SPACE_REBUILD_NOT_AUTHORIZED");
}

// One audited, self-service recovery step: rebuild a TaskSpace whose registry
// entry an ego restart lost. The audit line records denials too, so blind
// retries leave evidence instead of silently hammering the browser.
export async function rebuildSpace(p, { directory, profileConfig, runScript } = {}) {
  await mkdir(p.monitorDir, { recursive: true });
  const auditFile = join(p.monitorDir, "a-space-rebuild-audit.ndjson");
  const audit = (entry) => appendFile(auditFile, JSON.stringify({
    ts: new Date().toISOString(), action: "rebuild-space", agentId: p.agentId, space: p.space, ...entry,
  }) + "\n", "utf8");
  let decision;
  try { decision = await authorizeSpaceRebuild(p.agentId, p.space, { directory, profileConfig }); }
  catch (error) {
    const code = error.message || "SPACE_REBUILD_NOT_AUTHORIZED";
    await audit({ decision: "DENIED", code }).catch(() => {});
    console.log("RESULT=SPACE_REBUILD_DENIED code=" + code);
    return 2;
  }
  const template = await readFile(templates["rebuild-space"], "utf8");
  const source = adaptTemplate(template, p);
  const observation = runScript
    ? await runScript(source, p.monitorDir)
    : await runEgo(source, p.monitorDir, "rebuild-space");
  const rebuilt = observation.code === 0 && observation.result === "SPACE_REBUILT_ACCOUNT_VERIFIED";
  await audit({ decision, outcome: rebuilt ? "REBUILT" : "FAILED", result: observation.result || "MISSING", exit: observation.code });
  if (rebuilt) {
    console.log("RESULT=SPACE_REBUILT space=" + p.space);
    return 0;
  }
  console.log("RESULT=SPACE_REBUILD_FAILED result=" + (observation.result || "MISSING") + " exit=" + observation.code);
  return 2;
}

// TaskSpace ownership evidence may appear anywhere in the captured streams: the
// takeover RESULT codes, a RECOVERY_DETAIL line carrying TASKSPACE_NOT_AGENT_OWNED
// from assertAgentOwnedTaskSpace, or the wrapped ego error text.
const TASKSPACE_OWNERSHIP_LOSS = /TASKSPACE_NOT_AGENT_OWNED|EGO_TASKSPACE_TAKEOVER_REQUIRED|You now control this task space/i;

export function taskspaceOwnershipLost(observation) {
  const evidence = [observation?.result, observation?.detail, observation?.output]
    .filter(Boolean).join("\n");
  return TASKSPACE_OWNERSHIP_LOSS.test(evidence);
}

// Guidance only (agent-kit#33, PO requirement): a space that left the agent-owned
// state is announced to the operator with the hand-back / claim instruction. The
// takeover gate itself stays fail-closed and claim is never run automatically.
export function announceTaskspaceOwnershipLoss(observation, space) {
  if (!taskspaceOwnershipLost(observation)) return false;
  console.error(taskspaceOperatorAction(space));
  return true;
}

// Managed, audited re-claim of a TaskSpace ego handed back to the user
// (agent-kit#33). Same authorization bar and audit ledger as rebuildSpace; the
// action exists only because an operator-initiated recovery path was missing —
// it is never triggered by the takeover signal itself.
export async function claimSpace(p, { directory, profileConfig, runScript } = {}) {
  await mkdir(p.monitorDir, { recursive: true });
  const auditFile = join(p.monitorDir, "a-space-rebuild-audit.ndjson");
  const audit = (entry) => appendFile(auditFile, JSON.stringify({
    ts: new Date().toISOString(), action: "claim", agentId: p.agentId, space: p.space, ...entry,
  }) + "\n", "utf8");
  let decision;
  try { decision = await authorizeSpaceRebuild(p.agentId, p.space, { directory, profileConfig }); }
  catch (error) {
    const code = error.message || "SPACE_REBUILD_NOT_AUTHORIZED";
    await audit({ decision: "DENIED", code }).catch(() => {});
    console.log("RESULT=SPACE_CLAIM_DENIED code=" + code);
    return 2;
  }
  const template = await readFile(templates.claim, "utf8");
  const source = adaptTemplate(template, p);
  const observation = runScript
    ? await runScript(source, p.monitorDir)
    : await runEgo(source, p.monitorDir, "claim");
  const claimed = classifyManagerResult("claim", observation) === 0;
  // #27 Batch 2 owner-attribution fields (audit/identification ONLY — they
  // never feed the #33 authorization chain, whose order is unchanged). Taken
  // from the template's post-claim registry readback when present; anything
  // ego does not expose stays null and a claim has no conversation ledger
  // (conversation stays null, never invented).
  const taskSpaceId = claimed
    ? (observation.output?.match(/SPACE_CLAIMED_TASK_ID=(\S+)/)?.[1] ?? null) : null;
  const taskSpaceName = claimed
    ? (observation.output?.match(/SPACE_CLAIMED_TASK_NAME=(.+?)\s*$/m)?.[1]?.trim() ?? null) : null;
  // The audit row records the verified-ownership verdict, not the raw template code.
  await audit({ decision, outcome: claimed ? "CLAIMED" : "FAILED",
    result: claimed ? "SPACE_CLAIMED_OWNERSHIP_VERIFIED" : (observation.result || "MISSING"),
    exit: observation.code,
    ownerAgentId: p.agentId, taskSpaceId, taskSpaceName, conversation: null });
  if (claimed) {
    console.log("RESULT=SPACE_CLAIMED space=" + p.space);
    return 0;
  }
  console.log("RESULT=SPACE_CLAIM_FAILED result=" + (observation.result || "MISSING") + " exit=" + observation.code);
  return 2;
}

export async function ensureMonitor(dir) {
  await mkdir(dir, { recursive: true });
  for (const name of modules) {
    const target = join(dir, name);
    const source = await readFile(join(sourceDir, name));
    try {
      if ((await readFile(target)).equals(source)) continue;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    // Replace only managed code copies, preserving conversation ledgers and runtime state.
    const temporary = target + "." + randomUUID() + ".tmp";
    try {
      await writeFile(temporary, source);
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  try { await readFile(join(dir, "supervision.config.json")); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    await copyFile(join(sourceDir, "supervision.config.json"), join(dir, "supervision.config.json"));
  }
}

export function readEgoOutcome(child, emitOutput) {
  let tail = "";
  // ego-browser wrappers may relay the inner script's console.log through
  // stderr (observed 2026-11-14: probe stdout reached the terminal but never
  // the piped stream, so every RESULT= parse returned null and the watch loop
  // exited on its first GENERATING poll — agent-kit#31 item 1). Capture both
  // streams into the outcome tail; RESULT= parsing is line-anchored.
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk) => {
      const output = chunk.toString("utf8");
      emitOutput(output);
      tail = (tail + output).slice(-65536);
    });
  }
  return new Promise((res, rej) => {
    child.once("error", rej);
    // 'exit' precedes the final stdout data on some hosts. 'close' drains it.
    child.once("close", (exitCode) => {
      let result = null;
      for (const match of tail.matchAll(/^RESULT=([A-Z0-9_]+)(?:\s|$)/gm)) result = match[1];
      // When no RESULT line was parsed (observed 2026-11: watch probe exited 127
      // with no RESULT at all — agent-kit#31), surface the last non-empty,
      // non-RESULT line of the captured streams so an exit like 127 (command
      // not found) is distinguishable from a script crash. Same truncation
      // precedent as rebuild-space's RECOVERY_DETAIL, shortened to 200.
      let detail = null;
      if (!result) {
        for (const line of tail.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith("RESULT=")) detail = trimmed;
        }
        if (detail) detail = detail.slice(0, 200);
      }
      res({ code: exitCode ?? 2, result, detail });
    });
  });
}

// Official Windows CLI contract is nodejs -e with an imported UTF-8 script.
// The file is unique for each invocation and removed after its process exits.
// The captured stream tail rides along as `output` (manager-side consumers only;
// readEgoOutcome's own contract stays exactly { code, result, detail }).
async function runEgo(source, dir, name) {
  const outputPath = join(dir, name + "." + randomUUID() + ".mjs");
  await writeFile(outputPath, source, "utf8");
  let output = "";
  try {
    const expression = "await import(" + JSON.stringify(pathToFileURL(outputPath).href) + ")";
    const child = spawn("ego-browser", ["nodejs", "-e", expression], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const outcome = await readEgoOutcome(child, (chunk) => {
      output = (output + chunk).slice(-16384);
      process.stdout.write(chunk);
    });
    return { ...outcome, output };
  } finally {
    await unlink(outputPath).catch(() => {});
  }
}

// #43 (F1): the pending-new naming gate must fire BEFORE the shell exists.
// The probe-side gate only runs inside the round — by then this directory is
// already created — so an invalid name used to leave an uncleanable
// pending-new shell that permanently counts as in-flight. Existence here is
// the agent-side registry ledger (ego's live registry is only reachable from
// ego-runtime scripts): a space any agent entry has claimed keeps its
// (possibly legacy) name; a lost legacy space recovers through rebuild-space,
// which intentionally bypasses this gate. An unreadable ledger counts as
// unknown, so the name must conform — never a silent pass.
export const AGENT_REGISTRY_DIR_ENV = "EGO_AGENT_REGISTRY_DIR";

export async function agentRegistryKnowsSpace(space, directory = process.env[AGENT_REGISTRY_DIR_ENV] || join(homedir(), ".agents")) {
  let registry;
  try { registry = JSON.parse(await readFile(join(directory, "ego-taskspaces.json"), "utf8")); }
  catch { return false; }
  if (!registry || registry.schema !== "ego-agent-spaces/v1" || !registry.agents ||
      typeof registry.agents !== "object" || Array.isArray(registry.agents)) return false;
  return Object.values(registry.agents).some((entry) => entry && entry.spaceName === space);
}

export async function assertNewChatNamingAllowed({ space, agentId, registryDirectory } = {}) {
  await assertTaskSpaceNamingAllowed(space, agentId, await agentRegistryKnowsSpace(space, registryDirectory));
}

export async function main(args = process.argv.slice(2)) {
  const p = parseArgs(args);
  // Old shared-state directories may still be active. Never silently move or
  // overwrite their ledgers when opting into per-page isolation.
  for (const name of ["a-fast-state.json", "a-dispatch-state.json", "a-watch-uuid.txt", "a-supervision-status.json"]) {
    try { await readFile(join(p.monitorDir, name)); throw new Error("LEGACY_SHARED_STATE_REQUIRES_ISOLATION"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  // A space-level rebuild owns no conversation ledger; route it before the
  // per-conversation directory layout is touched at all. Same for claim.
  if (p.action === "rebuild-space") return rebuildSpace(p);
  if (p.action === "claim") return claimSpace(p);
  // #39 item 3: the managed pending-new discard is a pure filesystem operation
  // over pending-new/<requestId>/ — it routes before conversationDir(), which
  // would otherwise resolve to the conversations/ layout.
  if (p.action === "discard-pending") return discardPendingDispatch(p);
  const dir = conversationDir(p);
  p.rootMonitorDir = p.monitorDir;
  if (p.newChat) {
    p.payloadHash = sha256(await readFile(resolve(p.message), "utf8"));
    // This receipt survives a crash after the directory was moved.
    // A second invocation of the same request must not call the browser.
    try {
      const conversation = await bindNewConversation(p.monitorDir, p.requestId, p.space, p.agentId, p.payloadHash);
      console.log("RESULT=NEW_CHAT_BOUND conversation=" + conversation);
      return 0;
    } catch (error) {
      if (error.message !== "NEW_CHAT_RECONCILIATION_REQUIRED") throw error;
    }
    // #43 (F1): naming gate BEFORE any byte of the pending-new shell — see
    // assertNewChatNamingAllowed(). The offline receipt-bind above stays
    // ahead of the gate, so recovery of an existing request never regresses.
    await assertNewChatNamingAllowed({ space: p.space, agentId: p.agentId });
    await mkdir(dir, { recursive: true });
    const requestFile = join(dir, "a-new-request.json");
    let handle;
    try {
      handle = await open(requestFile, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ requestId: p.requestId.toLowerCase(), space: p.space, agentId: p.agentId, payloadSha256: p.payloadHash }));
    } catch (error) {
      if (error.code === "EEXIST") throw new Error("NEW_CHAT_IN_PROGRESS_OR_RECOVERY_REQUIRED");
      throw error;
    } finally {
      await handle?.close();
    }
  }
  if (p.action === "ack") return managedAcknowledge(p);
  // #38 fix 3: managed abort is a pure ledger operation — it runs before the
  // armed check and ensureMonitor, so it never touches the browser, the
  // registry or module copies, and it works on ACCEPTED/UNCERTAIN ledgers the
  // armed check would refuse.
  if (p.action === "abort") return abortDispatch(p);
  if (p.action === "consume") {
    const record = await readDispatchState(dir);
    if (!record || record.conversationUuid.toLowerCase() !== p.conversation.toLowerCase() || record.taskSpace !== p.space) {
      throw new Error("REPLY_CONSUMPTION_DISPATCH_MISMATCH");
    }
    await acknowledgeReply(dir, record, p.replySha256);
    console.log("RESULT=REPLY_CONSUMED");
    // P1-C: consuming the reply clears its disarm blocker (REPLY_NOT_CONSUMED)
    // — every managed touch re-runs the idempotent disarm retry, which first
    // verifies the durable release-success credential, so a consume that
    // happens before (or after a failed) release never converges the disarm.
    await retryPendingDisarm(dir, { rootMonitorDir: p.rootMonitorDir });
    return 0;
  }
  // Check before ensureMonitor or any browser invocation. An idle watch must
  // leave both the registry and the user's open tabs untouched.
  const armed = ["watch", "probe"].includes(p.action)
    ? await requireArmedDispatch(dir, p, p.action) : null;
  // After requireArmedDispatch() the watch identity (conversation, space,
  // status) is confirmed, so an ensureMonitor() failure is catchable watch
  // scope (WG-03A): it must leave the durable wake marker via exitWatching —
  // a bare MANAGER_FAILURE on a possibly terminal dispatch has no marker and
  // no WATCH_STALE backstop. Other actions keep MANAGER_FAILURE semantics.
  if (p.action === "watch") {
    try { await ensureMonitor(dir); }
    catch (error) {
      return exitWatching(dir, "WATCH_EXCEPTION", {
        detail: "code=" + ((error && (error.code || error.message)) || "UNKNOWN"),
      });
    }
  } else {
    await ensureMonitor(dir);
  }
  p.monitorDir = dir;
  // #40: PO-manual attach — the managed tracking entry for a dispatch the PO
  // sent by hand. Runs after ensureMonitor (the verification template imports
  // the module copies from the conversation dir) and before any dispatch-
  // lifecycle branch; its own gates refuse before anything is written.
  if (p.action === "manual-attach") return manualAttachDispatch(p);
  if (p.recoverOnly && p.archivedRecord) {
    const originalPayload = await readFile(resolve(p.message), "utf8");
    const archived = JSON.parse(await readFile(resolve(p.archivedRecord), "utf8"));
    if (!validateDispatchRecord(archived) || archived.status !== "PREPARED" ||
        archived.conversationUuid.toLowerCase() !== p.conversation.toLowerCase() ||
        archived.taskSpace !== p.space || archived.payload_sha256 !== sha256(originalPayload)) {
      throw new Error("ARCHIVED_PREPARED_IDENTITY_MISMATCH");
    }
    // Exclusive creation prevents replacing another dispatch's ledger.
    // P1-C round 5 (ruling requirement 1): this is a PREPARED ledger
    // establishment, so it joins the same commit lock as the arm section and
    // the disarm commit; round 6 (P1-C-3): the lock scope is the monitor root,
    // shared with every sibling conversation's writers (fail-closed: an
    // unavailable lock aborts the recovery before any ledger write).
    await withCommitLock(commitLockScopeOf(dir), async (guard) => {
      // P1-C-1 (round 6): ownership re-verification before the ledger write.
      await guard();
      const handle = await open(join(dir, "a-dispatch-state.json"), "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(archived)); }
      finally { await handle.close(); }
      await readDispatchState(dir);
    });
  }
  if (p.action === "collect") return collectCompleted(p, dir);
  // P1-C round 4 (gap 2): the whole direct release flow — entry verification,
  // pre-attempt credential clear, release run, disarm convergence and
  // credential write — lives in directRelease(), where the dispatch identity
  // verified at entry is carried through every step (behaviorally testable,
  // releaseDelivered precedent).
  if (p.action === "release") return directRelease(p, dir);
  if (p.action === "watch") {
    // Branch-external initialization above (requireArmedDispatch / ensureMonitor)
    // runs before watch identity is confirmed and keeps its MANAGER_FAILURE
    // semantics on purpose. Everything inside this branch — init writes,
    // COMPLETED reconciliation, release and the poll loop — is catchable watch
    // scope (WG-03): any failure must leave the durable ego-watch-exit ledger
    // behind via exitWatching(WATCH_EXCEPTION), never a bare exit 2.
    try {
      await writeFile(join(dir, "a-watch-uuid.txt"), p.conversation + "\n", "utf8");
      // Restart after delivery must finish the page release, even though the
      // probe deliberately suppresses DONE_CANDIDATE for completed dispatches.
      // #38 fix 3: an already-aborted dispatch is terminal with no reply —
      // the same terminal short-circuit slot wakes the supervisor instead.
      if (armed.status === "ABORTED") {
        return await exitWatching(dir, "DISPATCH_ABORTED_WAKE_SUPERVISOR", { detail: "action=watch" });
      }
      if (armed.status === "COMPLETED") {
        try { await verifiedConsumption(dir, armed); }
        catch (error) {
          if (error.message !== "REPLY_NOT_CONSUMED") throw error;
          return await exitWatching(dir, "REPLY_STAGED_WAKE_SUPERVISOR", { detail: "action=consume" });
        }
        return await releaseDelivered(p, dir);
      }
      // One managed job owns BOTH the fast probe and the slow supervisor. No idle
      // model calls; only the terminal return code wakes a compatible host, and
      // every wake path first persists the ego-watch-exit ledger (agent-kit#25).
      const pollIntervalMs = 30_000;
      let benignStreak = 0;
      while (true) {
        const pollStartedAt = Date.now();
        const template = await readFile(templates.probe, "utf8");
        const observation = await runEgo(adaptTemplate(template, p), dir, "probe");
        if (observation.code === 0 && observation.result === "DONE_CANDIDATE") {
          // A completed turn needs the owning Agent to inspect and consume the
          // reply before page release. A process exit is only a wake request.
          return await exitWatching(dir, "REPLY_READY_WAKE_SUPERVISOR", { detail: "action=collect" });
        }
        // #38 fix 3: the probe reports a terminal ABORTED ledger observed
        // mid-watch — no reply exists, so collect/consume must never run.
        if (observation.code === 0 && observation.result === "DISPATCH_ABORTED_WAKE_SUPERVISOR") {
          return await exitWatching(dir, "DISPATCH_ABORTED_WAKE_SUPERVISOR", { detail: "action=probe" });
        }
        const verdict = classifyProbeResult(observation, benignStreak);
        benignStreak = verdict.streak;
        if (verdict.wake) {
          return await exitWatching(dir, "FAST_PROBE_WAKE_SUPERVISOR", {
            detail: "signal=" + (observation.result || "MISSING") + " exit=" + observation.code +
              (observation.detail ? " detail=" + observation.detail : ""),
          });
        }
        if (await tick(Date.now(), dir)) {
          // Reuse the supervision pending id so both ledgers share one wakeId
          // and one ack clears both. tick() already announced its wake line
          // with that id, so no second RESULT line is printed here.
          let pending = null;
          try { pending = JSON.parse(await readFile(join(dir, "a-supervision-status.json"), "utf8")).pending ?? null; }
          catch { pending = null; }
          const supervisionReason = pending && typeof pending.reason === "string" && pending.reason
            ? (SUPERVISION_WAKE_REASON_MAP[pending.reason] || pending.reason) : "MONITOR_WAKE_UNACKNOWLEDGED";
          return await exitWatching(dir, supervisionReason, {
            wakeId: pending && typeof pending.id === "string" ? pending.id : undefined,
            announce: false,
          });
        }
        await new Promise((res) => setTimeout(res, Math.max(0, pollIntervalMs - (Date.now() - pollStartedAt))));
      }
    } catch (error) {
      // A watch-branch crash still leaves the durable wake ledger behind; exit
      // code 2 is preserved instead of turning the failure into a clean exit.
      return await exitWatching(dir, "WATCH_EXCEPTION", {
        detail: "code=" + ((error && (error.code || error.message)) || "UNKNOWN"),
      });
    }
  }
  const file = p.newChat || p.recoverOnly ? templates.send : templates[p.action];
  const template = await readFile(file, "utf8");
  if (["send", "send-new", "recover-draft"].includes(p.action)) {
    p.message = resolve(p.message);
    p.attachments = await loadAttachments(p.attachmentsFile);
  }
  // #27 Batch 3 (ruling §四.2): a new dispatch persists its armed state BEFORE
  // the delivery template runs — there must be no window where a message was
  // sent while the fast state still read disarmed. Recovery of an owned draft
  // (recover-draft) sends nothing and stays out of this path.
  if (["send", "send-new"].includes(p.action)) {
    await armForDispatch(dir, { conversationUuid: p.conversation, space: p.space });
  }
  if (p.action === "probe") await writeFile(join(dir, "a-watch-uuid.txt"), p.conversation + "\n", "utf8");
  const observation = await runEgo(adaptTemplate(template, p), dir, p.action);
  // agent-kit#33: takeover guidance on send-family failures. The probe announces
  // it at its own takeover exits, so it is not repeated here for probe runs.
  // (The direct release action keeps the same guidance inside directRelease.)
  if (observation.code !== 0 && p.action !== "probe") {
    announceTaskspaceOwnershipLoss(observation, p.space);
  }
  if (p.recoverOnly) {
    const recovered = await readDispatchState(dir);
    return observation.code === 0 && observation.result === "OWNED_DRAFT_CLEARED" &&
      recovered?.status === "ABORTED" && recovered.payload_sha256 === sha256(await readFile(p.message, "utf8")) ? 0 : 2;
  }
  if (p.newChat) {
    // Bind only after the standard template has persisted acceptance and a
    // browser-derived conversation UUID. Failures retain the pending ledger.
    const conversation = await bindNewConversation(p.rootMonitorDir, p.requestId, p.space, p.agentId, p.payloadHash);
    if (observation.code !== 0 || observation.result !== "AUTO_ACCEPTED_DISPATCH_ACCEPTED") {
      console.error("RESULT=NEW_CHAT_RECONCILE_REQUIRED conversation=" + conversation);
      return 2;
    }
    console.log("RESULT=NEW_CHAT_BOUND conversation=" + conversation);
    return 0;
  }
  if (p.action === "probe") return classifyProbeResult(observation).wake ? 2 : 0;
  const record = p.action === "send" ? await readDispatchState(dir) : null;
  const code = classifyManagerResult(p.action, observation, record, p);
  if (p.action === "send" && code !== 0) {
    console.error("RESULT=MANAGER_SEND_REQUIRES_RECONCILIATION status=" + (record?.status || "ABSENT"));
  }
  return code;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (error) { console.error("RESULT=MANAGER_FAILURE code=" + (error.code || error.message)); process.exitCode = 2; }
}
