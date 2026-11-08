// Durable dispatch ledger. Never stores prompt/response text or virtualized turn counts.
import { appendFile, readFile, rename, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { spacePhaseMs, stormBackoffDeadline } from "./state-schema.mjs";

const ACTIVE = new Set(["PREPARED", "SEND_STARTED", "ACCEPTED", "UNCERTAIN", "RETRY_AUTHORIZED"]);
const fileOf = (dir) => `${dir}/a-dispatch-state.json`;

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeJsonAtomic(path, value) {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, JSON.stringify(value), "utf8");
  await rename(temp, path);
}

export async function appendEvent(dir, event, fields = {}) {
  const row = { ts: Date.now(), event, ...fields };
  await appendFile(`${dir}/a-fast-events.ndjson`, JSON.stringify(row) + "\n", "utf8");
}

export async function readComposerSurface(page) {
  return page.evaluate(() => {
    const visible = (element) => Boolean(element &&
      (element.offsetParent !== null || element.getClientRects().length > 0));
    const composerSelector = '#prompt-textarea, [data-testid="prompt-textarea"], [contenteditable="true"][role="textbox"], textarea';
    const composers = [...document.querySelectorAll(composerSelector)].filter(visible);
    const composer = composers.find((element) => element.id === "prompt-textarea" ||
      element.getAttribute("data-testid") === "prompt-textarea") || composers[0] || null;
    const composerText = !composer ? "" :
      (composer.tagName === "TEXTAREA" || composer.tagName === "INPUT"
        ? composer.value || ""
        : composer.innerText || composer.textContent || "");

    // Current ChatGPT DOM contract: the last content unit carries the role suffix.
    // Assistant identity comes from its DIL response UUID; user identity uses the unit key.
    const units = [...document.querySelectorAll("[data-content-search-unit-key]")].filter(visible);
    const tailUnit = units.at(-1) || null;
    const tailUnitKey = tailUnit?.getAttribute("data-content-search-unit-key") || null;
    const roleMatch = typeof tailUnitKey === "string" ? tailUnitKey.match(/:(user|assistant)$/) : null;
    const lastMessageRole = roleMatch?.[1] || null;
    let lastMessageKey = null;
    let tailContent = tailUnit;
    if (lastMessageRole === "assistant" && tailUnit) {
      const dilSelector = "[data-dil-response][data-dil-message-id]";
      const dilResponses = [
        ...(tailUnit.matches?.(dilSelector) ? [tailUnit] : []),
        ...tailUnit.querySelectorAll(dilSelector),
      ];
      const messageId = dilResponses.length === 1
        ? dilResponses[0].getAttribute("data-dil-message-id")
        : null;
      const isUuid = typeof messageId === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(messageId);
      if (isUuid) {
        lastMessageKey = messageId;
        tailContent = dilResponses[0];
      }
    } else if (lastMessageRole === "user") {
      // fallback-turn keys are only used to detect a post-dispatch user-tail advance;
      // they are not claimed to be durable identities across refreshes.
      lastMessageKey = tailUnitKey;
    }

    const buttons = [...document.querySelectorAll("button[aria-label]")].filter(visible);
    const stopLabels = new Set(["停止", "Stop", "Stop generating", "Stop streaming"]);
    const generating = buttons.some((button) => stopLabels.has(button.getAttribute("aria-label")));

    return {
      hostOk: location.hostname === "chatgpt.com" || location.hostname.endsWith(".chatgpt.com"),
      composerCount: composers.length,
      composerPresent: Boolean(composer),
      composerEmpty: Boolean(composer) && composerText.trim().length === 0,
      composerLength: composerText.length,
      generating,
      stopLabelCount: buttons.filter((button) => stopLabels.has(button.getAttribute("aria-label"))).length,
      lastMessageRole,
      lastMessageKey,
      lastMessageTextLength: tailContent ? (tailContent.innerText || tailContent.textContent || "").length : 0,
    };
  });
}

function validateDispatchRecord(record) {
  const statuses = new Set(["PREPARED", "SEND_STARTED", "ACCEPTED", "UNCERTAIN", "COMPLETED", "RETRY_AUTHORIZED"]);
  return Boolean(record && typeof record === "object" && !Array.isArray(record) &&
    record.schema === "ego-dispatch-state/v2" &&
    typeof record.dispatchId === "string" && typeof record.conversationUuid === "string" &&
    typeof record.taskSpace === "string" && typeof record.pageLabel === "string" &&
    statuses.has(record.status) &&
    (typeof record.baselineTailRole === "string" || record.baselineTailRole === null) &&
    (typeof record.baselineTailKey === "string" || record.baselineTailKey === null) &&
    // r44 P0-B3: PREPARED persists pre-fill, so the baseline composer is the verified EMPTY slate — length 0 is the valid norm.
    Number.isFinite(record.baselineComposerLength) && record.baselineComposerLength >= 0 &&
    Number.isInteger(record.attempt) && record.attempt >= 1 && Number.isFinite(record.createdAt) &&
    // R2.5 ledger fields: content fingerprint + byte length only; never the payload text itself.
    (record.payload_sha256 === null || record.payload_sha256 === undefined ||
      typeof record.payload_sha256 === "string") &&
    (record.payload_bytes === null || record.payload_bytes === undefined ||
      Number.isInteger(record.payload_bytes)) &&
    (record.composer_baseline === null || record.composer_baseline === undefined ||
      typeof record.composer_baseline === "string"));
}

export async function readDispatchState(dir) {
  const record = await readJson(fileOf(dir));
  if (record && !validateDispatchRecord(record)) throw new Error("DISPATCH_STATE_INVALID");
  return record;
}

export async function prepareDispatch({ monitorDir, conversationUuid, taskSpace, pageLabel, page, payload }) {
  const current = await readDispatchState(monitorDir);
  if (current && ACTIVE.has(current.status)) {
    throw new Error(`ACTIVE_DISPATCH_BLOCKS_SEND:${current.dispatchId}:${current.status}`);
  }
  const surface = await readComposerSurface(page);
  if (!surface.hostOk || !surface.composerPresent) throw new Error("COMPOSER_SURFACE_UNAVAILABLE");
  // r44 P0-B3: PREPARED persists BEFORE the fill — the composer must be a verified EMPTY slate here
  // (Gate 2 just ensured it); the payload lands after this record exists. A non-empty composer at
  // this point means the pre-fill ownership check was bypassed → fail closed.
  if (!surface.composerEmpty) throw new Error("COMPOSER_NOT_EMPTY_BEFORE_PREPARED");
  if (surface.generating) throw new Error("PREVIOUS_GENERATION_STILL_ACTIVE");
  if (surface.lastMessageRole === "user") throw new Error("PREVIOUS_USER_TURN_UNRESOLVED");

  // R2.5 ledger contract: store the content fingerprint and byte length, never the payload text.
  const payloadText = payload === undefined || payload === null ? null : String(payload);
  const record = {
    schema: "ego-dispatch-state/v2",
    dispatchId: randomUUID(),
    conversationUuid,
    taskSpace,
    pageLabel,
    baselineTailKey: surface.lastMessageKey,
    baselineTailRole: surface.lastMessageRole,
    baselineComposerLength: surface.composerLength,
    payload_sha256: payloadText === null ? null : createHash("sha256").update(payloadText, "utf8").digest("hex"),
    payload_bytes: payloadText === null ? null : Buffer.byteLength(payloadText, "utf8"),
    composer_baseline: payloadText === null ? null : JSON.stringify({
      composerLength: surface.composerLength,
      composerEmpty: surface.composerEmpty,
      lastMessageRole: surface.lastMessageRole,
      lastMessageKey: surface.lastMessageKey,
    }),
    status: "PREPARED",
    attempt: 1,
    createdAt: Date.now(),
  };
  await writeJsonAtomic(fileOf(monitorDir), record);
  await appendEvent(monitorDir, "DISPATCH_PREPARED", {
    dispatchId: record.dispatchId,
    pageLabel,
    baselineTailRole: record.baselineTailRole,
    baselineComposerLength: record.baselineComposerLength,
  });
  return record;
}

async function transition(monitorDir, dispatchId, allowed, status, fields = {}) {
  const record = await readDispatchState(monitorDir);
  if (!record || record.dispatchId !== dispatchId) throw new Error("DISPATCH_ID_MISMATCH");
  if (!allowed.includes(record.status)) throw new Error(`DISPATCH_TRANSITION_REJECTED:${record.status}->${status}`);
  const next = { ...record, ...fields, status, updatedAt: Date.now() };
  if (status === "SEND_STARTED" && record.status === "RETRY_AUTHORIZED") {
    next.attempt = Number(record.attempt || 1) + 1;
  }
  await writeJsonAtomic(fileOf(monitorDir), next);
  await appendEvent(monitorDir, status, { dispatchId, attempt: next.attempt });
  return next;
}

export async function markSendStarted(monitorDir, dispatchId) {
  return transition(monitorDir, dispatchId, ["PREPARED", "RETRY_AUTHORIZED"], "SEND_STARTED", {
    sendStartedAt: Date.now(),
  });
}

export function hasResponseTailAdvanced(record, surface) {
  return Boolean(record && surface?.lastMessageKey &&
    surface.lastMessageKey !== record.baselineTailKey &&
    surface.lastMessageRole === "assistant");
}

function acceptedBySurface(record, surface) {
  if (!surface?.hostOk || !surface.composerPresent || !surface.composerEmpty) return false;
  if (surface.generating) return true;
  return hasResponseTailAdvanced(record, surface) || Boolean(
    surface.lastMessageKey && surface.lastMessageKey !== record.baselineTailKey &&
    surface.lastMessageRole === "user"
  );
}

export async function markAccepted(monitorDir, dispatchId, page) {
  const record = await readDispatchState(monitorDir);
  if (!record || record.dispatchId !== dispatchId) throw new Error("DISPATCH_ID_MISMATCH");
  const surface = await readComposerSurface(page);
  if (!acceptedBySurface(record, surface)) {
    throw new Error("DISPATCH_ACCEPTANCE_NOT_PROVEN");
  }
  return transition(monitorDir, dispatchId, ["SEND_STARTED"], "ACCEPTED", {
    acceptedAt: Date.now(),
    acceptedEvidence: surface.generating ? "COMPOSER_EMPTY_AND_GENERATING" : "COMPOSER_EMPTY_AND_TAIL_ADVANCED",
  });
}

export async function markUncertain(monitorDir, dispatchId, reasonCode = "SEND_ACK_MISSING") {
  if (typeof reasonCode !== "string" || !/^[A-Z0-9_]{3,48}$/.test(reasonCode)) throw new Error("INVALID_REASON_CODE");
  return transition(monitorDir, dispatchId, ["SEND_STARTED"], "UNCERTAIN", {
    uncertainAt: Date.now(),
    reasonCode,
  });
}

export async function markCompleted(monitorDir, dispatchId) {
  return transition(monitorDir, dispatchId, ["ACCEPTED"], "COMPLETED", {
    completedAt: Date.now(),
    finalVerification: "SUPERVISOR_API_CONFIRMED",
  });
}

export async function authorizeRetry(monitorDir, dispatchId, reasonCode) {
  if (typeof reasonCode !== "string" || !/^[A-Z0-9_]{3,48}$/.test(reasonCode)) throw new Error("RETRY_REASON_CODE_REQUIRED");
  return transition(monitorDir, dispatchId, ["UNCERTAIN"], "RETRY_AUTHORIZED", {
    retryAuthorizedAt: Date.now(),
    retryReasonCode: reasonCode,
  });
}

export async function reconcileDispatch(monitorDir, conversationUuid, surface) {
  const record = await readDispatchState(monitorDir);
  if (!record) return { record: null, result: "UNTRACKED" };
  if (record.conversationUuid !== conversationUuid) return { record, result: "UUID_MISMATCH" };
  if (["SEND_STARTED", "UNCERTAIN"].includes(record.status)) {
    if (acceptedBySurface(record, surface)) {
      const next = {
        ...record,
        status: "ACCEPTED",
        acceptedAt: record.acceptedAt || Date.now(),
        acceptedEvidence: surface.generating ? "COMPOSER_EMPTY_AND_GENERATING" : "COMPOSER_EMPTY_AND_TAIL_ADVANCED",
        reconciledAfterRestart: true,
        updatedAt: Date.now(),
      };
      await writeJsonAtomic(fileOf(monitorDir), next);
      await appendEvent(monitorDir, "DISPATCH_ACCEPTED_RECONCILED", {
        dispatchId: record.dispatchId,
        acceptedEvidence: next.acceptedEvidence,
      });
      return { record: next, result: "ACCEPTED_RECONCILED" };
    }
    const reasonCode = !surface?.composerPresent ? "COMPOSER_UNAVAILABLE" :
      !surface.composerEmpty ? "DRAFT_PERSISTED" :
      !surface.lastMessageKey ? "TAIL_ID_UNAVAILABLE" : "NO_ACCEPTANCE_EVIDENCE";
    const next = {
      ...record,
      status: "UNCERTAIN",
      uncertainAt: record.uncertainAt || Date.now(),
      reasonCode,
      updatedAt: Date.now(),
    };
    await writeJsonAtomic(fileOf(monitorDir), next);
    await appendEvent(monitorDir, "DISPATCH_UNCERTAIN", { dispatchId: record.dispatchId, reasonCode });
    return { record: next, result: "UNCERTAIN" };
  }
  return { record, result: record.status };
}

// ---- R2.5 Composer delivery reliability (planner ruling reply-r43.txt) ----

// R2.5-F chunk rule (frozen): split by lines; every non-last chunk carries its own trailing
// newline; each chunk stays within the UTF-8 byte limit. join() reconstructs the payload exactly.
export function chunkPayload(text, limit = 1200) {
  if (typeof text !== "string") throw new TypeError("PAYLOAD_NOT_STRING");
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError("LIMIT_NOT_POSITIVE_INT");
  const byteLen = (s) => Buffer.byteLength(s, "utf8");
  const lines = text.split("\n");
  const chunks = [];
  let current = "";
  for (let i = 0; i < lines.length; i++) {
    // every non-last line carries its own newline, so chunk boundaries never eat separators
    const piece = i < lines.length - 1 ? lines[i] + "\n" : lines[i];
    if (piece && byteLen(piece) > limit) throw new Error("CHUNK_LINE_EXCEEDS_LIMIT");
    if (current && byteLen(current + piece) > limit) {
      chunks.push(current);
      current = "";
    }
    current += piece;
  }
  if (current) chunks.push(current);
  return chunks;
}

// R2.5-F composer artifact normalization (readback only): collapse whitespace runs to one space.
// Never applied to the delivered payload itself or to sensitive-content fidelity checks.
export function collapseComposerArtifacts(text) {
  if (typeof text !== "string") return "";
  return text.replace(/\s+/g, " ");
}

// R2.5-F sensitive-content gate: URLs, fenced code, and command lines cannot tolerate any
// whitespace or ordering change, so their readback comparison must be strict.
export function isSensitivePayload(text) {
  if (typeof text !== "string") return false;
  return /https?:\/\/|www\.|```|^\s*[$>]/m.test(text);
}

// Readback verdict for a payload: "strict" (sensitive: compare raw), "normalized" (plain text:
// compare after collapsing composer artifacts), or "stop" (sensitive but only rendered innerText
// is available to prove it — never fake-pass; STOP instead).
export function readbackMode(payload) {
  return isSensitivePayload(payload) ? "strict" : "normalized";
}

export function readbackMatches(payload, composerText) {
  if (typeof payload !== "string" || typeof composerText !== "string") return false;
  if (readbackMode(payload) === "strict") {
    return composerText === payload ||
      composerText.replace(/\r\n/g, "\n") === payload.replace(/\r\n/g, "\n");
  }
  return collapseComposerArtifacts(composerText).trim() === collapseComposerArtifacts(payload).trim();
}

// R2.5-O ownership verification (frozen): full text or in-order valid prefix of the CURRENT
// dispatch payload; historical drafts only via a persisted full-content fingerprint; never
// arbitrary substrings or reordered fragments. Empty drafts are a separate branch, not a match.
export function verifyDraftOwnership({ draft, payload = null, record = null } = {}) {
  const draftText = typeof draft === "string" ? draft : "";
  if (draftText.trim().length === 0) return { owned: true, kind: "empty" };
  if (typeof payload === "string" && payload.length > 0) {
    if (record && ["SEND_STARTED", "ACCEPTED", "UNCERTAIN", "RETRY_AUTHORIZED"].includes(record.status)) {
      return { owned: false, kind: "send-started-locked",
        reason: "SEND_STARTED_LOCKED_ACCEPTANCE_RECONCILIATION_REQUIRED" };
    }
    const normDraft = collapseComposerArtifacts(draftText).trim();
    const normPayload = collapseComposerArtifacts(payload).trim();
    if (normDraft === normPayload) return { owned: true, kind: "full" };
    if (normPayload.startsWith(normDraft)) return { owned: true, kind: "prefix" };
    // exact raw identity is still acceptable even when collapsed forms diverge
    if (draftText.replace(/\r\n/g, "\n") === payload.replace(/\r\n/g, "\n")) {
      return { owned: true, kind: "full" };
    }
    return { owned: false, kind: "foreign", reason: "DRAFT_NOT_OWNED" };
  }
  if (record?.payload_sha256) {
    const raw = draftText.replace(/\r\n/g, "\n");
    if (createHash("sha256").update(raw, "utf8").digest("hex") === record.payload_sha256) {
      return { owned: true, kind: "historical-identity" };
    }
    return { owned: false, kind: "foreign",
      reason: "HISTORICAL_DRAFT_IDENTITY_UNPROVEN" };
  }
  return { owned: false, kind: "foreign", reason: "NO_OWNERSHIP_EVIDENCE" };
}

// ---- R2.5-O fill-attempt counter (FRESHEN cadence), persisted per task space ----

const fillCounterFileOf = (dir) => `${dir}/a-fill-counter.json`;

async function readFillCounter(dir) {
  const raw = await readJson(fillCounterFileOf(dir));
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

export async function getFillCount(dir, space) {
  const counter = await readFillCounter(dir);
  const value = counter[space];
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

export async function recordFillAttempt(dir, space) {
  const counter = await readFillCounter(dir);
  counter[space] = (Number.isInteger(counter[space]) ? counter[space] : 0) + 1;
  await writeJsonAtomic(fillCounterFileOf(dir), counter);
  return counter[space];
}

export async function resetFillCount(dir, space) {
  const counter = await readFillCounter(dir);
  counter[space] = 0;
  await writeJsonAtomic(fillCounterFileOf(dir), counter);
  return 0;
}

// ---- R2.5-H composer render freeze: the ledger records the event; the probe consumes it ----

export async function markComposerFreeze(dir, { space, error } = {}) {
  if (typeof space !== "string" || !space) throw new TypeError("SPACE_REQUIRED");
  const detectedAt = Date.now();
  const phaseMs = spacePhaseMs(space);
  const stormBackoff = stormBackoffDeadline({ detectedAt, phaseMs });
  const freezeId = randomUUID();
  await appendEvent(dir, "COMPOSER_RENDER_FREEZE", {
    freezeId, detectedAt, stormBackoffDeadline: stormBackoff, phaseMs,
    agent_id: space, space, ...safeEventError(error),
  });
  return { freezeId, detectedAt, stormBackoffDeadline: stormBackoff, phaseMs };
}

export async function findUnconsumedComposerFreeze(dir) {
  // r44 P0-A1: missing events file = provably no freezes (ENOENT → ""); any other read error
  // must THROW so the caller STOPs — a read failure must never masquerade as "no freeze".
  let raw;
  try {
    raw = await readFile(`${dir}/a-fast-events.ndjson`, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") raw = "";
    else throw error;
  }
  const freezes = new Map();
  const consumed = new Set();
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.event === "COMPOSER_RENDER_FREEZE" && typeof row.freezeId === "string") {
      freezes.set(row.freezeId, row);
    } else if (row.event === "COMPOSER_FREEZE_CONSUMED" && typeof row.freezeId === "string") {
      consumed.add(row.freezeId);
    }
  }
  for (const freezeId of consumed) freezes.delete(freezeId);
  const remaining = [...freezes.values()];
  return remaining.length ? remaining[remaining.length - 1] : null;
}

function safeEventError(error) {
  return {
    errorName: String(error?.name || "Error").slice(0, 80),
    nativeErrorCode: String(error?.code || "UNKNOWN").slice(0, 80),
    message: String(error?.message || "").slice(0, 200),
  };
}

// Newest COMPOSER_FREEZE_CONSUMED deadline, for the probe to label the storm retry reason.
export async function lastConsumedFreezeDeadline(dir) {
  const raw = await readFile(`${dir}/a-fast-events.ndjson`, "utf8").catch(() => "");
  let deadline = null;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.event === "COMPOSER_FREEZE_CONSUMED" && Number.isFinite(row.stormBackoffDeadline)) {
      deadline = row.stormBackoffDeadline;
    }
  }
  return deadline;
}
