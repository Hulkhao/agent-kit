import { validateFastState } from "./state-schema.mjs";

// The dispatch-time tail is a durable completion baseline, even after the
// monitor process restarts and has never observed the generating phase.
export function shouldReviewStartupIdle(startIdle, responseTailAdvanced) {
  return Boolean(startIdle && !responseTailAdvanced);
}

export function parseSupervisionConfig(value) {
  if (!value || !Number.isInteger(value.supervisionMinutes) || value.supervisionMinutes < 1 || value.supervisionMinutes > 60 ||
      !Number.isInteger(value.maxAbnormalRounds) || value.maxAbnormalRounds < 1 || value.maxAbnormalRounds > 10) {
    throw new Error("SUPERVISION_CONFIG_INVALID");
  }
  return { supervisionMinutes: value.supervisionMinutes, maxAbnormalRounds: value.maxAbnormalRounds };
}

// agent-kit#38 F3: a vanished send leaves exactly two observable signatures in
// the fast state while the dispatch ledger still says ACCEPTED and nothing is
// generating — (a) the tail rolled back onto / never left the dispatch baseline
// (nothing ever persisted server-side), or (b) an optimistic user turn is
// sitting unanswered at the tail. A real assistant tail beyond the baseline is
// proof of delivery and always wins over both signatures. Requires the
// dispatch-time baselineTailKey from the ledger; without it the class never
// fires (fail-safe, the ordinary progress rules stay in charge).
export function deliverySuspected(state, baselineTailKey) {
  if (state.dispatchStatus !== "ACCEPTED") return false;
  if (state.generating) return false;
  if (typeof baselineTailKey !== "string" || !baselineTailKey) return false;
  if (state.lastMessageRole === "assistant" && state.lastMessageKey &&
      state.lastMessageKey !== baselineTailKey) return false;
  return state.lastMessageKey === baselineTailKey || state.lastMessageRole === "user";
}

// A stop button, a repaint and the probe timestamp do not qualify as progress.
export function classifySupervision(state, { now = Date.now(), lastReviewAt = 0, minutes = 10, baselineTailKey = null } = {}) {
  if (!validateFastState(state)) return "STATE_CORRUPT";
  // Every acknowledged intervention starts a new observation window, including
  // persistent abnormal states. Otherwise three rounds can fire in three minutes.
  if (lastReviewAt > 0 && now - lastReviewAt < minutes * 60_000) return null;
  if (state.doneCandidate || state.dispatchStatus === "COMPLETED") return "REPLY_UNHANDLED";
  const progressAt = state.lastProgressAt ?? state.ts;
  // #38 F3: the delivery-suspect signatures use the same progress discipline as
  // NO_SUBSTANTIVE_PROGRESS — both must be sustained beyond the supervision
  // window with no progress — but rank above it (a vanished send is a specific,
  // actionable diagnosis; "no progress" is not).
  if (deliverySuspected(state, baselineTailKey) &&
      now - Math.max(progressAt, lastReviewAt) >= minutes * 60_000) {
    return "DELIVERY_SUSPECTED";
  }
  if (now - state.ts > 7 * 60_000) return "FAST_POLL_STALE";
  if (state.startIdle || state.recoveryFailed || state.probeFailed || state.unavailablePersistent ||
      state.uiSchema === "UNKNOWN" || state.dispatchStatus === "UNCERTAIN") return "MONITOR_STATE_ABNORMAL";
  return now - Math.max(progressAt, lastReviewAt) >= minutes * 60_000 ? "NO_SUBSTANTIVE_PROGRESS" : null;
}

export function nextSupervisionRound(status, state) {
  const generationKey = state.generationKey || state.dispatchId || "unknown";
  const progressAt = state.lastProgressAt ?? state.ts;
  const progressChanged = status.generationKey !== generationKey || progressAt > (status.progressAt || 0);
  return {
    ...status,
    generationKey,
    progressAt,
    abnormalRounds: progressChanged ? 0 : (status.abnormalRounds || 0),
    lastReviewAt: progressChanged ? 0 : (status.lastReviewAt || 0),
  };
}
