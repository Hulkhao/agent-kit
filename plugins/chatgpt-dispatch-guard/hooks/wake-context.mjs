// Read-only wake-anomaly detection for the chatgpt-dispatch-guard hooks
// (agent-kit #25 gap 3, plan A: PreToolUse wake summary + Stop one-shot handoff).
//
// Self-contained by design: this module imports nothing from monitor/** so the
// hook cannot fail when monitor modules are mid-refresh.
//
// Privacy contract: it only ever reads or returns ids, reason names, timestamps,
// file names and paths. It never reads or returns task bodies, reply bodies,
// cookies or tokens.
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Frozen wire schemas (ruling §3.1 / dispatch-state.mjs). Detection only READS
// a-watch-exit.json; the writer side lives in dispatch-manager (plan C).
export const WATCH_EXIT_SCHEMA = "ego-watch-exit/v1";

// Terminal dispatch statuses never produce wake events (completed work must
// not be re-raised). RELEASED covers released task-space sessions.
export const TERMINAL_DISPATCH_STATUSES = new Set(["COMPLETED", "ABORTED", "RELEASED"]);
// An "active" dispatch makes unreadable key state a WAKE_STATUS_UNKNOWN instead
// of a silent pass (must never interpret read failure as health).
export const ACTIVE_DISPATCH_STATUSES = new Set(["PREPARED", "SEND_STARTED", "ACCEPTED", "UNCERTAIN", "RETRY_AUTHORIZED"]);

// ---- #27 Batch 3 (ruling §四.1/.3): armed-state awareness ----
//
// Schema pin mirrored from monitor/state-schema.mjs (this module stays
// self-contained and imports nothing from monitor/**). Only a structurally
// valid v4 fast state carries an arm claim; legacy v3/v2/no-schema ledgers
// (and foreign reason values) carry NO arm information — legacy mode, the
// exemption table never fires on inference.
export const FAST_STATE_SCHEMA_V4 = "ego-fast-state/v4";
const ARMED_REASONS_V4 = new Set(["DISPATCH_ACCEPTED", "PEER_GENERATING", "DISARMED_IDLE", "ARMED_UNKNOWN"]);
// Frozen exemption verdicts (ruling §四.3 table rows).
export const WATCH_STALE_EXEMPTION = Object.freeze({
  EXEMPT: "EXEMPT",                       // DISARMED_IDLE + cross-validation passed
  CONFLICT_UNKNOWN: "CONFLICT_UNKNOWN",   // DISARMED_IDLE but an in-flight dispatch exists
  KEEP_WAKE_EVENTS: "KEEP_WAKE_EVENTS",   // DISARMED_IDLE + un-acked wake: wakes stay visible
  NOT_EXEMPT: "NOT_EXEMPT",               // armed claims, legacy, missing, unreadable
});
export const ARM_STATE_CONFLICT_DETAIL = "ARM_STATE_CONFLICT_DISARMED_WITH_INFLIGHT_DISPATCH";

// Read the arm claim out of a parsed a-fast-state.json value (null = file
// absent). Structured ONLY for a v4 file whose armedReason is null or one of
// the frozen four states; anything else (legacy schema, foreign value) has no
// trustworthy arm information and must never enable the exemption.
export function readArmClaim(fast) {
  if (!fast || typeof fast !== "object" || Array.isArray(fast)) return { structured: false, armReason: null };
  if (fast.schema !== FAST_STATE_SCHEMA_V4) return { structured: false, armReason: null };
  const reason = fast.armedReason;
  if (reason !== null && !ARMED_REASONS_V4.has(reason)) return { structured: false, armReason: null };
  return { structured: true, armReason: reason ?? null };
}

// WATCH_STALE exemption table (ruling §四.3), frozen rows:
//   DISARMED_IDLE 且交叉验证通过            -> EXEMPT (the stale fast state is the
//        expected post-disarm shape; no stale anomaly is raised)
//   DISARMED_IDLE 但 dispatch-state 有在途  -> CONFLICT_UNKNOWN (the forbidden
//        "sent but disarmed" window; fail-closed UNKNOWN instead of exemption)
//   DISARMED_IDLE 但有未 ack wake           -> KEEP_WAKE_EVENTS (the stale
//        anomaly is exempt but corresponding wake events stay raised — in the
//        wiring they are pushed before this table is consulted and are never
//        suppressed by it in any branch)
//   WAKE_PENDING / SUPERVISION_PENDING / 读取失败 -> NOT_EXEMPT (separate event
//        types are never suppressed here; an unreadable fast state proves no
//        legitimate disarm, so the stale anomaly stands)
//   Any armed claim (DISPATCH_ACCEPTED / PEER_GENERATING / ARMED_UNKNOWN) is
//   NOT_EXEMPT: while armed the watch must be running and a stale fast state
//   is a real WATCH_STALE.
export function watchStaleExemption({ structured = false, armReason = null, dispatchActive = false, hasUnackedWake = false } = {}) {
  if (!structured) return WATCH_STALE_EXEMPTION.NOT_EXEMPT;
  if (armReason === "DISARMED_IDLE") {
    if (dispatchActive) return WATCH_STALE_EXEMPTION.CONFLICT_UNKNOWN;
    if (hasUnackedWake) return WATCH_STALE_EXEMPTION.KEEP_WAKE_EVENTS;
    return WATCH_STALE_EXEMPTION.EXEMPT;
  }
  return WATCH_STALE_EXEMPTION.NOT_EXEMPT;
}

// Frozen thresholds (ruling §2.3).
// FAST_STATE_STALE_MS deliberately equals the 7 * 60_000 FAST_POLL_STALE check
// in monitor/supervision-policy.mjs classifySupervision() — one time standard,
// not a second one.
export const WATCH_EXIT_ACK_GRACE_MS = 0; // un-acked watch exit: report immediately
export const SUPERVISION_PENDING_MS = 60_000; // supervision pending un-acked
export const FAST_STATE_STALE_MS = 7 * 60_000; // active dispatch + stale fast state
export const INJECTION_COOLDOWN_MS = 60_000; // same session + same wake key
export const STOP_BLOCK_COOLDOWN_MS = 90_000; // one forced continuation per stop flow

export const ACTIONS = {
  WAKE_PENDING: "INSPECT_AND_ACK_REQUIRED",
  SUPERVISION_PENDING: "INSPECT_AND_ACK_REQUIRED",
  WATCH_STALE: "REARM_WATCH_AND_VERIFY",
  WAKE_STATUS_UNKNOWN: "INSPECT_MONITOR_STATE",
};

export const DEFAULT_PROFILE_PATH = join(homedir(), ".agents", "ego-profile.json");
export const DEFAULT_LEDGER_PATH = join(homedir(), ".agents", "ego-wake-guard-state.json");
export const LEDGER_SCHEMA = "ego-wake-guard-state/v1";

const defaultIo = { readdir, readFile };

// monitorRoots is an explicit machine-local pinning config. Missing or empty
// disables detection entirely — this is a CONFIG GAP, not a health signal, and
// produces zero output rather than a "healthy" verdict.
export function readMonitorRoots(profile) {
  const roots = profile?.monitorRoots;
  if (!Array.isArray(roots)) return [];
  return roots.filter((root) => typeof root === "string" && root.trim() !== "");
}

function readJson(io, path) {
  // Returns: { present:false } ONLY for ENOENT (file absent), { present:true,
  // value } for parsed JSON, { present:true, error } for any other failure
  // (never throws). Non-ENOENT read errors (EACCES/EPERM/EIO/...) mean
  // "exists but unreadable" and MUST surface as WAKE_STATUS_UNKNOWN — a read
  // failure is never allowed to pass as absence/health (WG-01).
  return io.readFile(path, "utf8").then(
    (text) => {
      try { return { present: true, value: JSON.parse(text) }; }
      catch { return { present: true, error: "JSON_PARSE_FAILED" }; }
    },
    (error) => error?.code === "ENOENT"
      ? { present: false }
      : { present: true, error: error?.code || "READ_FAILED" },
  );
}

function unknownEvent(source, detail) {
  return { type: "WAKE_STATUS_UNKNOWN", key: `unknown:${source}`, source, detail };
}

// Structured state validation (WG-01): a file that parses but violates its
// frozen contract is corruption, not health — it always yields
// WAKE_STATUS_UNKNOWN. Validation checks STRUCTURE only; classification (e.g.
// which dispatch statuses are terminal) stays separate.
const UUID_PATTERN = /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const ACK_ACTIONS = new Set(["investigated", "resolved"]);
// Frozen schema pins, mirrored from their writers (monitor/supervision-watchdog.mjs
// SCHEMA and monitor/dispatch-state.mjs) — this module stays self-contained and
// imports nothing from monitor/**.
const SUPERVISION_SCHEMA = "ego-supervision/v1";
const DISPATCH_SCHEMA = "ego-dispatch-state/v2";

// Exported for the #27 P1-B contract-equivalence pin: monitor/dispatch-manager.mjs
// mirrors these two validators verbatim (it cannot import this module — the
// monitor runtime copies never include the plugins tree — and this hook must
// stay import-free of monitor/**), and the equivalence tests run BOTH
// implementations over the same case table. Contract changes must land on
// both sides in the same commit.
export function watchExitStructureError(marker) {
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return "WATCH_EXIT_MARKER_INVALID";
  if (marker.schema !== WATCH_EXIT_SCHEMA) return "WATCH_EXIT_SCHEMA_INVALID";
  if (typeof marker.wakeId !== "string" || !UUID_PATTERN.test(marker.wakeId)) return "WATCH_EXIT_WAKE_ID_INVALID";
  if (!Number.isFinite(marker.issuedAt)) return "WATCH_EXIT_ISSUED_AT_INVALID";
  if (marker.exitCode !== 2) return "WATCH_EXIT_EXIT_CODE_INVALID";
  // Un-acked: both ack fields null. Acked: finite acknowledgedAt plus a legal
  // action. Any other combination violates ego-watch-exit/v1.
  const unacked = marker.acknowledgedAt === null && marker.ackAction === null;
  const acked = Number.isFinite(marker.acknowledgedAt) && ACK_ACTIONS.has(marker.ackAction);
  if (!unacked && !acked) return "WATCH_EXIT_ACK_COMBINATION_INVALID";
  return null;
}

// Exported for the #27 P1-B contract-equivalence pin (see watchExitStructureError).
export function supervisionStatusStructureError(status) {
  if (!status || typeof status !== "object" || Array.isArray(status)) return "SUPERVISION_STATUS_INVALID";
  if (status.schema !== SUPERVISION_SCHEMA) return "SUPERVISION_SCHEMA_INVALID";
  // loadStatus() contract (supervision-watchdog.mjs): the watchdog never writes
  // a ledger without these three fields being valid.
  if (!Number.isInteger(status.abnormalRounds) || status.abnormalRounds < 0) return "SUPERVISION_ABNORMAL_ROUNDS_INVALID";
  if (!Number.isFinite(status.progressAt)) return "SUPERVISION_PROGRESS_AT_INVALID";
  if (!Number.isFinite(status.lastReviewAt)) return "SUPERVISION_LAST_REVIEW_AT_INVALID";
  // A missing pending property is NOT the same as pending: null — the watchdog's
  // empty() always writes pending: null explicitly.
  if (!("pending" in status)) return "SUPERVISION_PENDING_MISSING";
  const pending = status.pending;
  if (pending === null) return null; // no alarm armed
  if (typeof pending !== "object" || Array.isArray(pending)) return "SUPERVISION_PENDING_INVALID";
  if (typeof pending.id !== "string" || pending.id === "") return "SUPERVISION_PENDING_ID_INVALID";
  if (!Number.isFinite(pending.issuedAt)) return "SUPERVISION_PENDING_ISSUED_AT_INVALID";
  return null;
}

function dispatchStructureError(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return "DISPATCH_STATE_INVALID";
  if (record.schema !== DISPATCH_SCHEMA) return "DISPATCH_SCHEMA_INVALID";
  // Structure only: status is any non-empty string; no status whitelist here.
  if (typeof record.status !== "string" || record.status === "") return "DISPATCH_STATUS_INVALID";
  // validateDispatchRecord() contract (dispatch-state.mjs): identity, baseline
  // and attempt fields are always present with these types — a terminal record
  // missing them is corruption and must surface as UNKNOWN, never silent health.
  if (typeof record.dispatchId !== "string") return "DISPATCH_ID_INVALID";
  if (typeof record.conversationUuid !== "string") return "DISPATCH_CONVERSATION_INVALID";
  if (typeof record.taskSpace !== "string") return "DISPATCH_TASKSPACE_INVALID";
  if (typeof record.pageLabel !== "string") return "DISPATCH_PAGE_LABEL_INVALID";
  if (typeof record.baselineTailRole !== "string" && record.baselineTailRole !== null) return "DISPATCH_BASELINE_ROLE_INVALID";
  if (typeof record.baselineTailKey !== "string" && record.baselineTailKey !== null) return "DISPATCH_BASELINE_KEY_INVALID";
  if (!Number.isFinite(record.baselineComposerLength) || record.baselineComposerLength < 0) return "DISPATCH_BASELINE_LENGTH_INVALID";
  if (!Number.isInteger(record.attempt) || record.attempt < 1) return "DISPATCH_ATTEMPT_INVALID";
  // Optional R2.5 fields, type contract copied verbatim from
  // validateDispatchRecord(): absent or null is legal, a wrong type is corruption.
  if (!(record.payload_sha256 === null || record.payload_sha256 === undefined ||
        typeof record.payload_sha256 === "string")) return "DISPATCH_PAYLOAD_SHA_INVALID";
  if (!(record.payload_bytes === null || record.payload_bytes === undefined ||
        Number.isInteger(record.payload_bytes))) return "DISPATCH_PAYLOAD_BYTES_INVALID";
  if (!(record.composer_baseline === null || record.composer_baseline === undefined ||
        typeof record.composer_baseline === "string")) return "DISPATCH_COMPOSER_BASELINE_INVALID";
  if (("updatedAt" in record) && !Number.isFinite(record.updatedAt)) return "DISPATCH_UPDATED_AT_INVALID";
  if (!Number.isFinite(record.createdAt)) return "DISPATCH_CREATED_AT_INVALID";
  return null;
}

async function scanConversation(dir, name, now, io, events) {
  // #27 Batch 3 (ruling §四.3): whether this scan already raised a wake event
  // (WAKE_PENDING / SUPERVISION_PENDING). The WATCH_STALE exemption table
  // never suppresses these events in any branch — it only ever decides the
  // fate of the stale-fast-state anomaly itself.
  let unackedWakeSeen = false;
  // a-watch-exit.json: an un-acknowledged watch exit is reported immediately
  // (no grace threshold). Parse or structure failure is UNKNOWN, never health.
  const exitFile = join(dir, "a-watch-exit.json");
  const exitRead = await readJson(io, exitFile);
  if (exitRead.present && exitRead.error) {
    events.push(unknownEvent(exitFile, exitRead.error));
  } else if (exitRead.present) {
    const marker = exitRead.value;
    const structureError = watchExitStructureError(marker);
    if (structureError) {
      events.push(unknownEvent(exitFile, structureError));
    } else if (marker.acknowledgedAt === null) {
      unackedWakeSeen = true;
      events.push({
        type: "WAKE_PENDING",
        key: `wake:${marker.wakeId ?? name}`,
        wakeId: marker.wakeId ?? null,
        reason: marker.reason ?? null,
        ageMs: Number.isFinite(marker.issuedAt) ? Math.max(0, now - marker.issuedAt) : null,
        source: dir,
      });
    }
  }

  // a-supervision-status.json: pending older than 60s; malformed ledger is
  // UNKNOWN (schema pin + pending.id/pending.issuedAt structure).
  const statusFile = join(dir, "a-supervision-status.json");
  const statusRead = await readJson(io, statusFile);
  if (statusRead.present && statusRead.error) {
    events.push(unknownEvent(statusFile, statusRead.error));
  } else if (statusRead.present) {
    const status = statusRead.value;
    const structureError = supervisionStatusStructureError(status);
    if (structureError) {
      events.push(unknownEvent(statusFile, structureError));
    } else if (status.pending) {
      const issuedAt = status.pending.issuedAt;
      if (now - issuedAt >= SUPERVISION_PENDING_MS) {
        unackedWakeSeen = true;
        events.push({
          type: "SUPERVISION_PENDING",
          key: `wake:${status.pending.id ?? name}`,
          wakeId: status.pending.id ?? null,
          reason: status.pending.reason ?? null,
          ageMs: Math.max(0, now - issuedAt),
          source: dir,
        });
      }
    }
  }

  // Dispatch ledger: terminal or missing -> silence; unreadable or
  // structurally invalid -> UNKNOWN; ACCEPTED with stale fast state AND a
  // dispatch record that is itself older than the stale window -> WATCH_STALE.
  // The record-timestamp clause suppresses false positives for a dispatch that
  // was just sent (the watch may not have written its first fast state yet).
  const dispatchRead = await readJson(io, join(dir, "a-dispatch-state.json"));
  if (dispatchRead.present && dispatchRead.error) {
    events.push(unknownEvent(join(dir, "a-dispatch-state.json"), dispatchRead.error));
    return;
  }
  if (!dispatchRead.present) return;
  const dispatch = dispatchRead.value;
  const dispatchStructure = dispatchStructureError(dispatch);
  if (dispatchStructure) {
    events.push(unknownEvent(join(dir, "a-dispatch-state.json"), dispatchStructure));
    return;
  }
  if (TERMINAL_DISPATCH_STATUSES.has(dispatch.status)) return;
  if (!ACTIVE_DISPATCH_STATUSES.has(dispatch.status) && dispatch.status !== "ACCEPTED") return;

  const fastRead = await readJson(io, join(dir, "a-fast-state.json"));
  if (fastRead.present && fastRead.error) {
    events.push(unknownEvent(join(dir, "a-fast-state.json"), fastRead.error));
    return;
  }

  // #27 Batch 3 P1-D fix: the arm/disarm CONFLICT detection is independent of
  // the WATCH_STALE timeout machinery. Any ACTIVE dispatch ledger — SEND_STARTED,
  // UNCERTAIN and RETRY_AUTHORIZED included, not just ACCEPTED — paired with a
  // structured DISARMED_IDLE claim is the forbidden "sent but disarmed" window
  // and is reported immediately, regardless of any staleness threshold. A
  // structured=false read (legacy v3/v2, missing, foreign reason values)
  // carries no disarm claim, so the legacy timeout rules below are untouched.
  const armClaim = readArmClaim(fastRead.present ? fastRead.value : null);
  if (armClaim.structured && armClaim.armReason === "DISARMED_IDLE") {
    events.push(unknownEvent(join(dir, "a-fast-state.json"), ARM_STATE_CONFLICT_DETAIL));
    return;
  }

  if (dispatch.status !== "ACCEPTED") return; // only ACCEPTED raises WATCH_STALE

  const fast = fastRead.present ? fastRead.value : null;
  const fastTs = fast?.ts;
  const fastMissing = !fast || !Number.isFinite(fastTs);
  const fastStale = fastMissing || now - fastTs > FAST_STATE_STALE_MS;
  if (!fastStale) return;

  const recordTs = Number.isFinite(dispatch.updatedAt) ? dispatch.updatedAt : dispatch.createdAt;
  const recordStale = !Number.isFinite(recordTs) || now - recordTs > FAST_STATE_STALE_MS;
  if (!recordStale) return;

  // #27 Batch 3 (ruling §四.3): the frozen WATCH_STALE exemption table,
  // consulted against the fast state's arm claim before the anomaly is raised.
  // A DISARMED_IDLE claim against an in-flight dispatch ledger is the forbidden
  // "sent but disarmed" window and surfaces as WAKE_STATUS_UNKNOWN (it already
  // returned at the P1-D conflict check above for every active status); a
  // verified post-disarm shape is exempt; armed claims, legacy ledgers and
  // unreadable state are never exempt. Wake events raised earlier in this scan
  // are retained in every branch. The arm claim was resolved once, before the
  // conflict check — the same readArmClaim verdict feeds the table.
  const exemption = watchStaleExemption({
    structured: armClaim.structured,
    armReason: armClaim.armReason,
    dispatchActive: ACTIVE_DISPATCH_STATUSES.has(dispatch.status),
    hasUnackedWake: unackedWakeSeen,
  });
  if (exemption === WATCH_STALE_EXEMPTION.CONFLICT_UNKNOWN) {
    events.push(unknownEvent(join(dir, "a-fast-state.json"), ARM_STATE_CONFLICT_DETAIL));
    return;
  }
  if (exemption === WATCH_STALE_EXEMPTION.EXEMPT || exemption === WATCH_STALE_EXEMPTION.KEEP_WAKE_EVENTS) return;

  events.push({
    type: "WATCH_STALE",
    key: `stale:${dispatch.dispatchId ?? name}`,
    wakeId: dispatch.dispatchId ?? null,
    reason: "FAST_POLL_STALE",
    ageMs: Number.isFinite(recordTs) ? Math.max(0, now - recordTs) : null,
    fastStateAgeMs: fastMissing ? null : Math.max(0, now - fastTs),
    dispatchStatus: dispatch.status,
    source: dir,
  });
}

// Enumerate <root>/conversations/*/ and collect wake anomalies. Any single
// directory or file failure is tolerated: detection never throws, and a failed
// read of key state surfaces as WAKE_STATUS_UNKNOWN, never as health.
//
// Root vs conversations distinction (WG-01A): the configured monitorRoot is
// verified to exist and be readable FIRST. A missing or unreadable root is
// UNKNOWN — it must never pass as a benign empty state. Only after the root is
// proven readable may a missing conversations subdirectory count as the benign
// "root configured but not yet created" state; any other conversations read
// failure is UNKNOWN. One failing root never masks the other roots.
export async function detectWakeAnomalies(monitorRoots, now, io = defaultIo) {
  const events = [];
  for (const root of Array.isArray(monitorRoots) ? monitorRoots : []) {
    const from = events.length;
    let rootReadable = true;
    try {
      await io.readdir(root, { withFileTypes: true });
    } catch (error) {
      // The whole monitorRoot is absent or unreadable (ENOENT/EACCES/...):
      // fail closed as UNKNOWN.
      rootReadable = false;
      events.push(unknownEvent(root, error?.code || "READ_FAILED"));
    }
    if (rootReadable) {
      const conversationsDir = join(root, "conversations");
      let entries = null;
      try {
        entries = await io.readdir(conversationsDir, { withFileTypes: true });
      } catch (error) {
        // Root exists, conversations not yet created: benign empty state.
        // Any other conversations read failure is UNKNOWN.
        if (error?.code !== "ENOENT") events.push(unknownEvent(conversationsDir, error?.code || "READ_FAILED"));
      }
      if (entries) {
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          try { await scanConversation(join(conversationsDir, entry.name), entry.name, now, io, events); }
          catch { events.push(unknownEvent(join(conversationsDir, entry.name), "SCAN_FAILED")); }
        }
      }
    }
    // Observation A (#27 ruling): pin every event to the monitorRoot that
    // produced it, so per-event cooldown identities isolate roots — an event
    // of one root never masks (or inherits a cooldown from) another root's.
    for (let i = from; i < events.length; i++) events[i].monitorRoot = root;
  }
  return { healthy: events.length === 0, events };
}

function formatAge(ageMs) {
  if (!Number.isFinite(ageMs)) return null;
  const seconds = Math.floor(ageMs / 1000);
  return seconds < 3600 ? `${seconds}s` : `${Math.floor(seconds / 3600)}h`;
}

function eventLines(event) {
  const action = ACTIONS[event.type] ?? "INSPECT_MONITOR_STATE";
  const lines = [`state=${event.type}`];
  const append = (line) => { if (line !== null) lines.push(line); };
  if (event.type === "WATCH_STALE") {
    append(`dispatch=${event.dispatchStatus ?? "UNKNOWN"}`);
    append(event.fastStateAgeMs === null || event.fastStateAgeMs === undefined
      ? "fastState=missing" : `fastStateAge=${formatAge(event.fastStateAgeMs)}`);
  } else {
    append(event.wakeId ? `wakeId=${event.wakeId}` : null);
    append(event.reason ? `reason=${event.reason}` : null);
    append(event.ageMs === null || event.ageMs === undefined ? null : `age=${formatAge(event.ageMs)}`);
  }
  lines.push(`action=${action}`);
  return lines;
}

// Frozen injection format (ruling §2.2, as amended by #27 observation A): a
// single text block whose first line is [AGENT_KIT_WAKE_GUARD], at most 3
// events (excess reported as an additional count — "additional=N suppressed by
// cap"), zero output for a healthy state (returns null). No permission
// semantics here. `additional` may be passed explicitly by the caller when the
// displayed events were pre-filtered (per-event cooldown selection) and the
// capped tail is not part of `events`.
export function formatWakeContext(events, maxEvents = 3, additional = null) {
  if (!Array.isArray(events) || events.length === 0) return null;
  const lines = ["[AGENT_KIT_WAKE_GUARD]"];
  events.slice(0, maxEvents).forEach((event, index) => {
    if (index > 0) lines.push("");
    lines.push(...eventLines(event));
  });
  const extra = additional ?? Math.max(0, events.length - maxEvents);
  if (extra > 0) lines.push(`additional=${extra} suppressed by cap`);
  return lines.join("\n");
}

// One-line summary for the Stop hook's block reason.
export function summarizeEvents(events, maxEvents = 3) {
  if (!Array.isArray(events) || events.length === 0) return null;
  const parts = events.slice(0, maxEvents)
    .map((event) => eventLines(event).filter((line) => line.startsWith("state=") || line.startsWith("wakeId=") || line.startsWith("action=")).join(" "));
  return parts.join("; ") + (events.length > maxEvents ? ` (+${events.length - maxEvents} more)` : "");
}

// Rate-limit ledger: an independent hook state file under ~/.agents/. It never
// touches supervision or dispatch business ledgers.
//
// Stop cooldown is SESSION-scoped (WG-04): stopBlocks maps <sessionId> -> the
// timestamp of that session's last Stop block, so one session's 90s cooldown
// never suppresses another session's independent wake handoff. The 90s duration
// and the "same session only takes over one round" rule are unchanged.
export function parseLedger(text) {
  if (text === null || text === undefined || text === "") {
    return { schema: LEDGER_SCHEMA, injections: {}, stopBlocks: {} };
  }
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== LEDGER_SCHEMA) {
    throw new Error("WAKE_GUARD_LEDGER_INVALID");
  }
  const stopBlocks = value.stopBlocks && typeof value.stopBlocks === "object" && !Array.isArray(value.stopBlocks)
    ? Object.fromEntries(Object.entries(value.stopBlocks).filter(([, ts]) => Number.isFinite(ts)))
    : {};
  // Old-format migration (WG-04): the pre-session-level ledger stored one global
  // stopBlockAt timestamp. Migrate it to the "global" session key — the same
  // fallback key stop.mjs uses when an event carries no sessionId — so an
  // in-flight cooldown is not lost while still never suppressing other named
  // sessions.
  if (Number.isFinite(value.stopBlockAt) && value.stopBlockAt > 0) {
    stopBlocks.global ??= value.stopBlockAt;
  }
  return {
    schema: LEDGER_SCHEMA,
    injections: value.injections && typeof value.injections === "object" && !Array.isArray(value.injections)
      ? value.injections : {},
    stopBlocks,
  };
}

export function injectionCooldownActive(ledger, key, now, cooldownMs = INJECTION_COOLDOWN_MS) {
  const last = ledger.injections?.[key];
  return Number.isFinite(last) && now - last < cooldownMs;
}

export function stopCooldownActive(ledger, sessionId, now, cooldownMs = STOP_BLOCK_COOLDOWN_MS) {
  const last = ledger.stopBlocks?.[sessionId];
  return Number.isFinite(last) && last > 0 && now - last < cooldownMs;
}

export function withInjection(ledger, key, now) {
  return { ...ledger, injections: { ...ledger.injections, [key]: now } };
}

export function withStopBlock(ledger, sessionId, now) {
  return { ...ledger, stopBlocks: { ...ledger.stopBlocks, [sessionId]: now } };
}

// Observation A (#27 ruling): per-event identity key = eventType + wakeId +
// monitorRoot. Events without a wakeId (WAKE_STATUS_UNKNOWN and friends) fall
// back to their stable source identifier — the source path already pins both
// the file and the monitorRoot, so two roots' UNKNOWN events never share an
// identity (step f: cross-root isolation).
export function eventIdentity(event) {
  const type = typeof event?.type === "string" && event.type !== "" ? event.type : "EVENT";
  const id = typeof event?.wakeId === "string" && event.wakeId !== "" ? event.wakeId
    : typeof event?.source === "string" && event.source !== "" ? event.source : "anonymous";
  const root = typeof event?.monitorRoot === "string" ? event.monitorRoot : "";
  return `${type}:${id}:${root}`;
}

// Observation A: per-event cooldown selection, replacing the whole-block
// suppression (the old events[0]-hit-cooldown path swallowed every batch-mate).
// Pipeline, in order:
// 1. in-batch dedup — one identity appears at most once per event block;
// 2. per-event cooldown — a cooled identity is suppressed by ITSELF only and
//    never hides a fresh batch-mate;
// 3. display cap — at most `cap` events are shown; the fresh tail is reported
//    as an additional count. Cooldown bookkeeping is stamped ONLY for
//    displayed events: an event hidden behind the cap has not been shown, so
//    it must stay eligible for the next block.
// Returns { shown: [{ event, key }], additional }. Ledger keys are
// "<sessionId>:<identity>" — new-format keys coexist with the pre-#27
// "<sessionId>:wake:<id>" keys, which stay in the state file untouched.
export function selectWakeEvents(events, ledger, sessionId, now, cooldownMs = INJECTION_COOLDOWN_MS, cap = 3) {
  const seen = new Set();
  const fresh = [];
  for (const event of Array.isArray(events) ? events : []) {
    const key = (sessionId ?? "global") + ":" + eventIdentity(event);
    if (seen.has(key)) continue; // in-batch dedup: same identity shows once per block
    seen.add(key);
    if (injectionCooldownActive(ledger, key, now, cooldownMs)) continue; // per-event cooldown
    fresh.push({ event, key });
  }
  const shown = fresh.slice(0, cap);
  return { shown, additional: Math.max(0, fresh.length - cap) };
}
