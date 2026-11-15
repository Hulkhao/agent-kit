// Managed TaskSpace rebuild after an ego restart lost the space registry (agent-kit#31).
// The manager has already proven ownership (ledger binding or machine-local allowlist)
// and writes the audit line. This script only touches the browser: create the missing
// space on the pinned profile, verify what actually got created, then prove the pinned
// account on a real page (same evidence standard as dispatch Gate 1.5) and close that
// page again. Every unprovable step stops fail-closed; a failure must be reported to
// the operator, never retried blindly.
// This template is standalone: it imports no monitor modules, because a space-level
// rebuild runs before any conversation directory (and its managed copies) exists.
const SPACE = "REPLACE_WITH_UNIQUE_TASKSPACE";
if (SPACE.startsWith("REPLACE_")) {
  console.log("RESULT=ADAPTATION_REQUIRED");
  process.exit(1);
}

import * as fs from "node:fs/promises";
import { homedir } from "node:os";

const stop = (code, detail) => {
  if (detail) console.log("RECOVERY_DETAIL=" + String(detail).slice(0, 220));
  console.log("RESULT=" + code);
  process.exit(1);
};
const isTaskSpaceTakeover = (error) => {
  for (let cause = error, depth = 0; cause && depth < 5; cause = cause.cause, depth++) {
    if (/You now control this task space/i.test(String(cause.message || cause))) return true;
  }
  return false;
};
// Standalone template: no module imports, so the guidance text is inlined here
// (agent-kit#33: the takeover stop must tell the operator how to hand the space
// back or reclaim it; reminder only, never an automatic claim).
const takeoverOperatorAction = () =>
  console.log("OPERATOR_ACTION=ego 空间 " + SPACE + " 已不在 Agent 所有态。请在 Ego UI 将该空间交还给 Agent 或运行 dispatch-manager.mjs claim 受管认领。常见诱因：用户误点「接管」、关闭空间内最后一个标签页、Ego 升级。");

// Machine-local account pin (PO 令 2026-11-08, issue #7): profileId only applies at
// space CREATION, so the pin drives creation and the page session proves the result.
let pin = null;
try { pin = JSON.parse(await fs.readFile(homedir() + "/.agents/ego-profile.json", "utf8")); }
catch { stop("SPACE_REBUILD_NO_PIN"); }
const expectedAccount = (pin.spaceExpect && pin.spaceExpect[SPACE]) || pin.defaultAccount;
if (!pin.defaultProfileId || !expectedAccount) stop("SPACE_REBUILD_PIN_INCOMPLETE");

let task;
try {
  const spaces = await listTaskSpaces();
  const target = spaces.find((space) => space.taskId === SPACE || space.name === SPACE);
  if (target) {
    // Reuse an existing space only when ego still reports it as agent-owned.
    // A user-owned or unclaimed name is a takeover situation, not a rebuild.
    if (target.ownership !== "agent") {
      takeoverOperatorAction();
      stop("EGO_TASKSPACE_TAKEOVER_REQUIRED");
    }
    task = await taskSpace(target.id);
  } else {
    const knownProfiles = await profiles();
    if (!knownProfiles.some((profile) => profile.id === pin.defaultProfileId)) stop("SPACE_REBUILD_PROFILE_UNKNOWN");
    task = await taskSpace(SPACE, { profileId: pin.defaultProfileId });
    const created = (await listTaskSpaces()).find((space) => space.taskId === SPACE || space.name === SPACE);
    if (!created || created.ownership !== "agent" || (created.taskId && created.taskId !== SPACE) ||
        (created.profileId && created.profileId !== pin.defaultProfileId)) {
      stop("SPACE_REBUILD_VERIFY_FAILED");
    }
  }
} catch (error) {
  if (isTaskSpaceTakeover(error)) {
    takeoverOperatorAction();
    stop("EGO_TASKSPACE_TAKEOVER_REQUIRED");
  }
  stop("SPACE_REBUILD_TASKSPACE_FAILED", error && error.message || error);
}

// Prove the space actually runs the pinned account before any dispatch resumes on
// it. In-page fetch (window.fetch + credentials) is the reliable evidence channel;
// the email is compared in memory only — never logged, never persisted.
let failure = null;
let failureDetail = null;
let page = null;
try {
  page = await task.newPage();
  await page.goto("https://chatgpt.com", { timeout: 45000 });
  await page.waitForLoadState("load", { timeout: 30000 });
  let ready = false;
  for (let i = 0; i < 20 && !ready; i++) {
    const length = await page.evaluate(() => (document.body ? document.body.innerText.length : 0));
    if (length > 300) ready = true;
    else await page.waitForTimeout(2000);
  }
  if (!ready) {
    failure = "SPACE_REBUILD_PAGE_NOT_READY";
  } else {
    const session = await page.evaluate(async () => {
      try {
        const r = await fetch("/api/auth/session", { credentials: "include" });
        const j = await r.json();
        return { email: (j && j.user && j.user.email) || null };
      } catch { return null; }
    });
    if (!session || !session.email || session.email !== expectedAccount) failure = "SPACE_REBUILD_ACCOUNT_UNPROVEN";
  }
} catch (error) {
  failure = "SPACE_REBUILD_PAGE_CHECK_FAILED";
  failureDetail = error && error.message || error;
} finally {
  // A landing page left behind would break later conversation-page recovery
  // (page-recovery.mjs stops on non-conversation URLs), so always close ours —
  // including on the failure paths above.
  if (page) {
    try { await page.close(); }
    catch (error) {
      if (!failure) { failure = "SPACE_REBUILD_PAGE_CLOSE_FAILED"; failureDetail = error && error.message || error; }
    }
  }
}
if (failure) stop(failure, failureDetail);
console.log("RESULT=SPACE_REBUILT_ACCOUNT_VERIFIED");
