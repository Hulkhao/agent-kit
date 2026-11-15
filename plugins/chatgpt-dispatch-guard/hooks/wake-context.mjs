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

function watchExitStructureError(marker) {
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

function supervisionStatusStructureError(status) {
  if (!status || typeof status !== "object" || Array.isArray(status)) return "SUPERVISION_STATUS_INVALID";
  if (status.schema !== SUPERVISION_SCHEMA) return "SUPERVISION_SCHEMA_INVALID";
  const pending = status.pending;
  if (pending === null || pending === undefined) return null; // no alarm armed
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
  if (("updatedAt" in record) && !Number.isFinite(record.updatedAt)) return "DISPATCH_UPDATED_AT_INVALID";
  if (("createdAt" in record) && !Number.isFinite(record.createdAt)) return "DISPATCH_CREATED_AT_INVALID";
  return null;
}

async function scanConversation(dir, name, now, io, events) {
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
  if (dispatch.status !== "ACCEPTED") return; // only ACCEPTED raises WATCH_STALE

  const fast = fastRead.present ? fastRead.value : null;
  const fastTs = fast?.ts;
  const fastMissing = !fast || !Number.isFinite(fastTs);
  const fastStale = fastMissing || now - fastTs > FAST_STATE_STALE_MS;
  if (!fastStale) return;

  const recordTs = Number.isFinite(dispatch.updatedAt) ? dispatch.updatedAt : dispatch.createdAt;
  const recordStale = !Number.isFinite(recordTs) || now - recordTs > FAST_STATE_STALE_MS;
  if (!recordStale) return;

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
// read of key state surfaces as WAKE_STATUS_UNKNOWN, never as health. A root
// whose conversations directory cannot be read at all is also UNKNOWN — only
// ENOENT (a configured root that has no conversations directory yet) is a
// benign empty state (WG-01). One failing root never masks the other roots.
export async function detectWakeAnomalies(monitorRoots, now, io = defaultIo) {
  const events = [];
  for (const root of Array.isArray(monitorRoots) ? monitorRoots : []) {
    const conversationsDir = join(root, "conversations");
    let entries;
    try {
      entries = await io.readdir(conversationsDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue; // configured but not yet created: benign empty state
      // Unreadable root (EACCES/EPERM/EIO/...): fail closed as UNKNOWN.
      events.push(unknownEvent(conversationsDir, error?.code || "READ_FAILED"));
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try { await scanConversation(join(conversationsDir, entry.name), entry.name, now, io, events); }
      catch { events.push(unknownEvent(join(conversationsDir, entry.name), "SCAN_FAILED")); }
    }
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

// Frozen injection format (ruling §2.2): a single text block whose first line
// is [AGENT_KIT_WAKE_GUARD], at most 3 events (excess reported as a count),
// zero output for a healthy state (returns null). No permission semantics here.
export function formatWakeContext(events, maxEvents = 3) {
  if (!Array.isArray(events) || events.length === 0) return null;
  const lines = ["[AGENT_KIT_WAKE_GUARD]"];
  events.slice(0, maxEvents).forEach((event, index) => {
    if (index > 0) lines.push("");
    lines.push(...eventLines(event));
  });
  if (events.length > maxEvents) lines.push(`additional=${events.length - maxEvents}`);
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
