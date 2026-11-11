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
