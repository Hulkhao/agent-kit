// Managed, operator-initiated re-claim of a TaskSpace ego handed back to the
// user (agent-kit#33). The manager has already proven ownership (ledger binding
// or machine-local allowlist) and writes the audit line. This script only touches
// the browser: find the space by its stable name, claim it, then verify what the
// registry reports afterwards — the same fail-closed evidence standard as
// rebuild-space. Never run automatically from a takeover signal.
// This template is standalone: it imports no monitor modules, because a
// space-level action runs before any conversation directory (and its managed
// copies) exists.
const SPACE = "REPLACE_WITH_UNIQUE_TASKSPACE";
if (SPACE.startsWith("REPLACE_")) {
  console.log("RESULT=ADAPTATION_REQUIRED");
  process.exit(1);
}

const stop = (code, detail) => {
  if (detail) console.log("RECOVERY_DETAIL=" + String(detail).slice(0, 220));
  console.log("RESULT=" + code);
  process.exit(1);
};

let target = null;
try {
  const spaces = await listTaskSpaces();
  target = spaces.find((space) => space.taskId === SPACE || space.name === SPACE);
} catch (error) {
  stop("SPACE_CLAIM_LIST_FAILED", error && error.message || error);
}
if (!target) stop("TASKSPACE_NOT_FOUND");

try {
  await claimTaskSpace(target.id);
} catch (error) {
  stop((error && error.code) || "SPACE_CLAIM_FAILED", error && error.message || error);
}

// Prove what actually got claimed: the registry must now report agent ownership
// for the same stable space name. A post-claim non-agent state stops fail-closed.
let claimed = null;
try {
  claimed = (await listTaskSpaces()).find((space) => space.taskId === SPACE || space.name === SPACE);
} catch (error) {
  stop("SPACE_CLAIM_VERIFY_FAILED", error && error.message || error);
}
if (!claimed || claimed.ownership !== "agent" || (claimed.taskId && claimed.taskId !== SPACE)) {
  stop("SPACE_CLAIM_OWNERSHIP_UNVERIFIED");
}
console.log("RESULT=SPACE_CLAIMED_ACCOUNT_VERIFIED");
