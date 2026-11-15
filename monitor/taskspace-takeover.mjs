// ego lite may hand a TaskSpace back to the user after an upgrade. The supervisor
// must explicitly reclaim it; automated probes must not seize user-owned spaces.
export const TASKSPACE_TAKEOVER_SIGNAL = "EGO_TASKSPACE_TAKEOVER_REQUIRED";

export function isTaskSpaceTakeover(error) {
  // ego operations may wrap the original ownership error (e.g. page.url()).
  for (let cause = error, depth = 0; cause && depth < 5; cause = cause.cause, depth++) {
    if (cause.code === TASKSPACE_TAKEOVER_SIGNAL ||
        /You now control this task space/i.test(String(cause.message || cause))) return true;
  }
  return false;
}

export function taskSpaceNeedsClaim(space) {
  return Boolean(space && (space.ownership === null || space.ownership === "user"));
}

// Every "space left the agent-owned state" signal: the explicit takeover error,
// or an ownership value that is neither agent nor missing (assertAgentOwnedTaskSpace).
// A genuinely missing space stays out on purpose — registry loss has its own
// rebuild-space hint and must not be mistaken for a user takeover.
export function isTaskspaceOwnershipLoss(error) {
  for (let cause = error, depth = 0; cause && depth < 5; cause = cause.cause, depth++) {
    if (cause.code === TASKSPACE_TAKEOVER_SIGNAL || cause.code === "TASKSPACE_NOT_AGENT_OWNED" ||
        /You now control this task space/i.test(String(cause.message || cause))) return true;
  }
  return false;
}

// Operator guidance (agent-kit#33, PO requirement): every manager/monitor failure
// that shows the space left the agent-owned state must point the operator at the
// Ego UI hand-back or the managed claim action. Reminder only — the takeover gate
// stays fail-closed and claim is never run automatically.
export function taskspaceOperatorAction(space) {
  return "OPERATOR_ACTION=ego 空间 " + space + " 已不在 Agent 所有态。请在 Ego UI 将该空间交还给 Agent 或运行 dispatch-manager.mjs claim 受管认领。常见诱因：用户误点「接管」、关闭空间内最后一个标签页、Ego 升级。";
}

// Common entry guard for monitor and dispatch. A missing space must never be
// implicitly created by a bare taskSpace(name) during an existing dispatch.
export function assertAgentOwnedTaskSpace(space, name) {
  const code = !space ? "TASKSPACE_NOT_FOUND" :
    taskSpaceNeedsClaim(space) ? TASKSPACE_TAKEOVER_SIGNAL :
      space.ownership !== "agent" || (space.taskId && space.taskId !== name)
        ? "TASKSPACE_NOT_AGENT_OWNED" : null;
  if (code) {
    const error = new Error(code);
    error.code = code;
    throw error;
  }
  return space;
}
