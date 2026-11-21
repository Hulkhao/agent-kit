// Durable dispatch ledger. Never stores prompt/response text or virtualized turn counts.
import { appendFile, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spacePhaseMs, stormBackoffDeadline, classifyFastStateFile, normalizeFastState, armedTransitionPatch, ARMED_REASONS } from "./state-schema.mjs";
import { verifiedReply } from "./reply-delivery.mjs";

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

// Shared dispatch storm gate. A recorded structural failure remains blocked until the
// probe writes a healthy state; expiry by itself is NOT evidence of recovery.
export async function dispatchStormGate(dir, timestamp = Date.now()) {
  const state = await readJson(`${dir}/a-fast-state.json`);
  if (state === null) return null;
  // #27 Batch 3: a legacy v3 ledger (pre arm fields) still carries the storm
  // fields this gate reads — legacy mode, not corruption. Anything else that
  // fails the schema stays fail-closed.
  if (classifyFastStateFile(state) === "corrupt") throw new Error("FAST_STATE_INVALID");
  // #27 Batch 3 P1-A fix: a recorded corrupt-state carry-over is a structural
  // failure exactly like an active storm backoff. Both the probe's corrupt
  // landing and the manager's arm-over-corrupt rewrite (armForDispatch) stamp
  // errorCode "STATE_CORRUPT"; only a healthy probe round (errorCode null)
  // reopens the gate — arming alone can never turn corruption into a pass.
  if ((state.backoffUntil !== null && state.backoffUntil > timestamp) ||
      state.errorCode === "CHAT_SURFACE_STRUCTURALLY_UNAVAILABLE" ||
      state.errorCode === "STATE_CORRUPT") {
    return "STORM_BACKOFF_PENDING";
  }
  return null;
}

export async function writeJsonAtomic(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value), "utf8");
  await rename(temp, path);
}

// ---- #27 Batch 3 P1-C round 9 (2026-11-22 ruling §三: the round-8 v2
// holder-named election is REJECTED by a deterministic counterexample → the
// pre-authorized §三.4 fallback is adopted: single-file O_EXCL exclusive
// lock, no auto-steal, no sweep, manual cleanup after crashes; supersedes
// the round-5/6/7 single-path lock, round 6 holder ownership, round 7
// PID-liveness fencing and round 8 holder-named election) ----
//
// One coordination domain serializes every writer of dispatch-identity-
// relevant state, closing the TOCTOU window the round-4 ruling identified
// between disarmAfterRelease's one-shot identity check and its final
// DISARMED_IDLE write. Round 6 (P1-C-3) moved the lock domain to the MONITOR
// ROOT scope (commitLockScopeOf), so two different conversations — and the
// disarm commit's GLOBAL otherInFlight===0 criterion — share one coordination
// domain instead of one lock per conversation directory. Participants (all
// writers of arm-relevant state):
//   armForDispatch      — the whole arm write section (dispatch-manager.mjs);
//   prepareDispatch     — the PREPARED ledger establishment below (ruling
//                         requirement 1: arm and PREPARED establishment share
//                         ONE coordination mechanism);
//   disarmAfterRelease  — the final commit section (fresh ledger identity +
//                         fresh armed-instance check + global in-flight
//                         re-scan + DISARMED_IDLE write in ONE critical
//                         section, ruling requirements 2+3);
//   retryPendingDisarm  — converges through disarmAfterRelease, so it gets the
//                         same commit protection (ruling requirement 3);
//   the archived-PREPARED recovery write in dispatch-manager main().
// Why "read the ledger once more before writeJsonAtomic" is NOT enough: that
// extra read and the write are still two unrelated file operations — a
// concurrent arm can commit between them. Under the lock, the identity
// re-verification and the write are atomic with respect to every other
// participant, and a concurrent arm that completed before the lock was taken
// is caught by the armedSupersededDispatchId stamp the arm leaves in the
// fast state (verified fresh inside the same critical section).
//
// WHY THE ROUND-8 ELECTION WAS ABANDONED (ruling §三, §三.4). Round 8 bound
// the lock identity to the path name (<scope>/a-commit-lock.<holderId>.json)
// and elected the claim with the smallest (acquiredAt, holderId) over a
// post-create readdir. The planner broke it deterministically (reproduced 3/3
// on the real fs): A exclusive-creates its claim file but has not yet written
// its JSON (empty file); B's readdir classifies A's empty file as corrupt and
// ignores it → B is elected and enters the critical section; A resumes and
// writes an EARLIER acquiredAt (captured before A's open) → A's own election
// scan also elects A → maxInside=2, mutual exclusion broken. The election
// route cannot meet §三.3's bar (no dual holders under ARBITRARY async
// delays) without protocol expansion:
//   (a) v2's write-JSON-after-create shifts the file mtime at enrichment —
//       a winner elected while its claim is empty WEAKENS its own priority
//       when it completes the write, and a third party established before
//       that enrichment but after the winner's electing readdir can then
//       also elect → dual holder;
//   (b) creating the claim via temp-file+rename inherits the temp's write
//       time, so the priority stamp ≠ establishment order — the same hole
//       shape one step earlier;
//   (c) a fully sound election needs priority assigned ATOMICALLY with
//       visibility (an immutable empty marker whose mere existence carries
//       the priority, plus a separate metadata sidecar) — exactly the
//       protocol expansion §三.4 forbids.
// §三.4's trigger condition is therefore met, and its pre-authorized minimal
// safe scheme is what this section implements.
//
// THE ROUND-9 PROTOCOL: EXISTENCE IS THE EXCLUSION. One shared path per
// scope:
//
//   <scopeRoot>/a-commit-lock.json
//
// Mutual exclusion rests on a single kernel primitive: open(lockPath, "wx")
// is an atomic exclusive create. EXISTENCE excludes — not content, not
// identity, not timestamps. There is no readdir, no classification, no
// election, no confirmation tick, no sweep, no steal, no rename, and no
// unlink of any foreign file anywhere in the protocol. acquiredAt in the
// lock content is DIAGNOSTIC ONLY: it elects nothing, orders nothing, and
// never licenses an action. Protocol (withCommitLock(dir, task, options) —
// signature unchanged):
//   acquire — a retry loop within the wait budget (poll ~50ms):
//     open(lockPath, "wx") succeeds → WE HOLD, and the JSON content
//     { schema: "ego-commit-lock/v3", holderId, holderPid: process.pid,
//     acquiredAt } is written through the SAME fd, which is then closed.
//     Between the wx-create and the content write the file exists EMPTY and
//     that is CORRECT: every other attempter sees EEXIST and is blocked by
//     existence, never by parsed content. An in-progress claim is never
//     ignorable — precisely the property that kills the round-8
//     counterexample class. EEXIST → read the current content best-effort
//     (ENOENT = a transient release race: retry at once, not a busy
//     observation), parse {holderId, holderPid}, judge the holder's
//     liveness (ESRCH-only, see commitHolderIsDead — EPERM/other = alive),
//     invoke the onLockBusy hook, sleep, retry. If the content write itself
//     fails, the acquisition fails CLOSED (COMMIT_LOCK_CONTENT_WRITE_FAILED):
//     the fd is closed and OUR OWN just-created path is removed — never hold
//     a lock whose content cannot be verified later.
//   guard   — task(guard): the holder re-reads THE shared path and verifies
//     it still carries MY holderId immediately before its final state write.
//     No protocol participant can write or remove the lock while my process
//     lives (there is no steal/sweep/rename), so a mismatch here is external
//     tampering or the manual cleanup of a live holder's lock (operator
//     error): fail-closed with COMMIT_LOCK_LOST, nothing written. The
//     irreducible guard→commit gap (an external delete landing between this
//     read and the write) is out-of-protocol, as in every round.
//   release — content-verified unlink of THE shared path (round-9 change: the
//     path is SHARED, so v2's blind own-path unlink is gone): read → parse →
//     holderId === mine → unlink; ENOENT → COMMIT_LOCK_LOST (already gone —
//     external interference, noted loudly, nothing to unlink); foreign or
//     unparseable content → COMMIT_LOCK_LOST with NO unlink and the bytes
//     preserved for the operator. A task failure still releases best-effort
//     and rethrows the ORIGINAL error.
//
// Recovery is MANUAL by design (§三.4): a crashed holder leaves the single
// file behind; the next contender times out with a COMMIT_LOCK_WAIT_TIMEOUT
// whose message carries the lock path, the parsed or unparseable content
// diagnostics, the ESRCH verdict where provable, and the remediation hint
// ("safe to manually delete <path> then retry" for a provably dead or
// identity-less holder; "holder process alive; wait or investigate"
// otherwise). A human deletes the one named file. Nothing is ever stolen,
// swept, or auto-recovered — §三.3's bar (mutual exclusion under arbitrary
// async delays) is bought by giving up automatic recovery, not by weakening
// exclusion.
//
// Fail-closed policy (unchanged): a lock the caller cannot take is never a
// license to write — arm aborts (nothing is delivered), the disarm commit
// stays armed, prepareDispatch aborts before any delivery. Error codes:
//   COMMIT_LOCK_WAIT_TIMEOUT — the wait budget expired while still
//     contending (diagnostics in the message; no auto-removal of any
//     residue, dead or alive). The only contention outcome.
//   COMMIT_LOCK_LOST    — the holder's ownership guard found foreign,
//     unparseable or missing content at THE shared path, or release could
//     not verify/remove its own hold (external tampering or manual cleanup
//     of a live holder's lock — no protocol participant can produce it):
//     fail-closed, nothing written; foreign bytes are preserved, never
//     unlinked.
//   COMMIT_LOCK_CONTENT_WRITE_FAILED — the holder lost the lock it had just
//     created because its own content write failed (pathological): the
//     empty path was removed again, the acquisition fails closed.
//   COMMIT_LOCK_STALE   — retired (the steal path it reported is long gone);
//     isCommitLockError still recognizes the name so older callers' mapping
//     tables keep matching the family.
// Migration note: pre-round-9 residue is inert. A v2 holder-named claim
// (a-commit-lock.<holderId>.json) is a DIFFERENT file the v3 protocol never
// reads — only THE single path above matters; a v1-era file at that path
// with v1 content reads as unparseable here and fails contention closed
// like any identity-less remnant (timeout + manual delete). Neither blocks
// a fresh v3 acquisition once THE path is free.
// Residual fail-closed risks (accepted by §三.4):
//   (i)  PID reuse can make a dead holder LOOK alive — contenders time out
//        with an alive diagnostic and the lock needs manual removal (same
//        residual as v2);
//   (ii) a crash between the wx-create and the content write leaves an EMPTY
//        lock — attempters see EEXIST with unparseable content, time out,
//        and a human deletes the file (narrow window, fail-closed, no
//        auto-recovery by design);
//   (iii) manual cleanup of a LIVE holder's lock is operator error — the
//        guard converts it to a COMMIT_LOCK_LOST abort except the
//        irreducible guard→commit gap, which is out-of-protocol.
// Critical sections here are short pure file operations, so the default
// leaves a wide margin: contention waits up to 30s (waitBudgetMs,
// injectable) and then fails closed.

export const COMMIT_LOCK_FILE = "a-commit-lock.json"; // THE one shared lock path (v3)
export const COMMIT_LOCK_WAIT_MS = 30_000;
const COMMIT_LOCK_POLL_MS = 50;
export const COMMIT_LOCK_SCHEMA = "ego-commit-lock/v3";

// P1-C-3 (round 6): the lock SCOPE is the monitor root — both managed
// conversation layouts (<root>/conversations/<uuid> and
// <root>/pending-new/<requestId>) resolve to <root>, so every arm, prepare,
// disarm and retry on ANY conversation of the monitor root — plus the disarm
// commit's global otherInFlight re-scan — serializes on ONE lock. Non-managed
// (flat) directories stay self-scoped.
export function commitLockScopeOf(conversationDir) {
  const parent = dirname(conversationDir);
  const base = basename(parent);
  if (base === "conversations" || base === "pending-new") return dirname(parent);
  return conversationDir;
}

// The fail-closed lock error codes; callers match on this prefix to wrap
// the primitive failure into their own site-specific code (ARM_…/DISARM_…).
export function isCommitLockError(error) {
  return String(error?.message || "").startsWith("COMMIT_LOCK_");
}

// PID-liveness judgment — DIAGNOSTICS ONLY in round 9: its verdict never
// deletes, steals, or elects anything (it only annotates contention
// diagnostics and timeout messages). kill(pid, 0) succeeding means the holder
// process exists; EPERM means it exists but we may not signal it; ONLY ESRCH
// (no such process) proves death. Any other kill failure is treated as ALIVE:
// uncertain evidence never justifies touching a foreign lock.
const commitHolderIsDead = (holderPid) => {
  try {
    process.kill(holderPid, 0);
    return false; // alive
  } catch (error) {
    return error?.code === "ESRCH"; // EPERM and anything else: alive, fail-closed
  }
};

// Best-effort parse of a lock's diagnostic content: {holderId, holderPid} with
// the v3 schema and a usable (>0) holderPid — pid 0 is never trusted
// (kill(0, 0) addresses a process GROUP, not a process — round-7 ruling note).
// Anything unparsable/schema-invalid reads as null, which in round 9 is a
// DIAGNOSTIC verdict only: the holder is whoever owns the O_EXCL create, an
// identity-less remnant BLOCKS (it is never ignorable — the round-8 lesson)
// and is resolved by manual cleanup, never by protocol action.
const parseCommitLockContent = (raw) => {
  if (typeof raw !== "string") return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  return (parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
    parsed.schema === COMMIT_LOCK_SCHEMA &&
    typeof parsed.holderId === "string" && parsed.holderId.length > 0 &&
    Number.isInteger(parsed.holderPid) && parsed.holderPid > 0)
    ? { holderId: parsed.holderId, holderPid: parsed.holderPid,
        acquiredAt: Number.isFinite(parsed.acquiredAt) ? parsed.acquiredAt : null }
    : null;
};

export async function withCommitLock(dir, task, options = {}) {
  const { now = Date.now } = options;
  // The wait budget governs CONTESTING waits: how long a contender keeps
  // re-attempting the O_EXCL create while someone else's lock exists at the
  // path. waitBudgetMs is the canonical knob; waitMs is the round-5/6 option
  // name kept as an alias for existing callers.
  const waitBudget = options.waitBudgetMs ?? options.waitMs ?? COMMIT_LOCK_WAIT_MS;
  const hooks = options.hooks ?? {}; // test-only deterministic pause points
  const holderId = randomUUID();
  const holderPid = process.pid;
  const lockPath = `${dir}/${COMMIT_LOCK_FILE}`;
  const deadline = now() + waitBudget;

  // One busy observation: who (if any process) currently holds the lock, as
  // far as the content can prove. readable=false covers the EMPTY file a
  // holder leaves between its exclusive create and its content write (an
  // in-progress claim is never ignorable — it blocks, it never elects: the
  // round-8 lesson) and the crash remnant of a holder that died inside that
  // same window.
  const busyDiagOf = (raw, readErrorCode = null) => {
    const claim = parseCommitLockContent(raw);
    return {
      lockPath,
      readable: claim !== null,
      holderId: claim?.holderId ?? null,
      holderPid: claim?.holderPid ?? null,
      acquiredAt: claim?.acquiredAt ?? null,
      holderDead: claim ? commitHolderIsDead(claim.holderPid) : null,
      readErrorCode,
      rawLength: typeof raw === "string" ? raw.length : null,
    };
  };

  const waitTimeoutError = (diag) => {
    const holderText = diag.readable
      ? `holderId=${diag.holderId} holderPid=${diag.holderPid} acquiredAt=${diag.acquiredAt} holderProcess=${diag.holderDead ? "DEAD(ESRCH)" : "alive"}`
      : `content unparseable (${diag.readErrorCode ? `read error ${diag.readErrorCode}` : `${diag.rawLength ?? 0} bytes, no usable identity`} — crash-during-write remnant or foreign/tampered bytes)`;
    const remediation = !diag.readable
      ? `safe to manually delete ${lockPath} then retry`
      : diag.holderDead
        ? `holder process is provably dead (ESRCH): safe to manually delete ${lockPath} then retry`
        : "holder process alive; wait or investigate";
    return new Error(`COMMIT_LOCK_WAIT_TIMEOUT: wait budget exhausted contending for ${lockPath}; current holder: ${holderText}; remediation: ${remediation}`);
  };

  // Ownership guard (P1-C-1 requirement 3, semantics preserved): handed to the
  // task, which calls it immediately before its final state write. Round 9
  // re-reads THE shared lock path and verifies it still carries MY holderId.
  // No protocol participant can write or remove the lock while my process
  // lives (there is no steal, no sweep, no rename), so a mismatch is external
  // tampering or the manual cleanup of a live holder's lock — operator error.
  // Fail-closed with COMMIT_LOCK_LOST, nothing written; the irreducible
  // guard→commit gap (an external delete landing between this read and the
  // caller's write) is out-of-protocol, as in every round.
  const guard = async () => {
    if (hooks.beforeGuard) await hooks.beforeGuard();
    let raw = null;
    try { raw = await readFile(lockPath, "utf8"); }
    catch (error) {
      throw new Error(`COMMIT_LOCK_LOST: ${lockPath} unreadable at guard (${error?.code || "UNKNOWN"}); nothing written`);
    }
    const claim = parseCommitLockContent(raw);
    if (claim === null || claim.holderId !== holderId) {
      throw new Error(`COMMIT_LOCK_LOST: ${lockPath} does not carry MY holderId at guard (current: ${claim ? `holderId=${claim.holderId}` : `unparseable ${raw.length} bytes`}); external tampering or manual cleanup; nothing written`);
    }
  };

  // Release MY hold on the shared path: content-verified unlink (round 9: the
  // path is SHARED, so v2's blind own-path unlink is gone). Foreign or
  // unparseable content is never removed — the bytes stay preserved for the
  // operator; the failure surfaces as COMMIT_LOCK_LOST (on the task-failure
  // path the release error is swallowed so the ORIGINAL task error
  // propagates, per the v2 semantics below).
  const releaseMine = async () => {
    let raw = null;
    try { raw = await readFile(lockPath, "utf8"); }
    catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error(`COMMIT_LOCK_LOST: ${lockPath} already gone at release (external interference; noting loudly, nothing to unlink)`);
      }
      throw new Error(`COMMIT_LOCK_LOST: ${lockPath} unreadable at release (${error?.code || "UNKNOWN"}); bytes untouched`);
    }
    const claim = parseCommitLockContent(raw);
    if (claim === null || claim.holderId !== holderId) {
      throw new Error(`COMMIT_LOCK_LOST: ${lockPath} does not carry MY holderId at release (current: ${claim ? `holderId=${claim.holderId}` : `unparseable ${raw.length} bytes`}); foreign bytes preserved, nothing unlinked — manual cleanup is the operator's call`);
    }
    await unlink(lockPath);
  };

  // ① acquire: exclusive-create THE one shared lock path. O_EXCL atomicity is
  // the whole mutual-exclusion mechanism — EXISTENCE excludes, not content,
  // not identity, not timestamps. No readdir, no classification, no election.
  for (;;) {
    let handle;
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error; // e.g. ENOENT: the dir itself is broken
      // Busy: describe the current holder best-effort (no stealing, no
      // sweeping, no unlink of any foreign file — ever), notify, wait, retry.
      let diag;
      try {
        diag = busyDiagOf(await readFile(lockPath, "utf8"));
      } catch (readError) {
        if (readError?.code === "ENOENT") continue; // transient release race: not a busy observation, retry at once
        diag = busyDiagOf(null, String(readError?.code || "UNKNOWN")); // unreadable: keep waiting, fail-closed
      }
      if (hooks.onLockBusy) await hooks.onLockBusy(diag);
      if (now() >= deadline) throw waitTimeoutError(diag);
      await new Promise((resolve) => setTimeout(resolve, COMMIT_LOCK_POLL_MS));
      continue;
    }
    // WE HOLD: the kernel granted the exclusive create. Between THIS point
    // and the content write below the file exists EMPTY — that is correct
    // and safe: other attempters see EEXIST and are blocked by existence,
    // never by parsed content (the property that kills the round-8
    // counterexample class).
    // Injection seam (deterministic tests, ruling §三.1): the barrier point
    // between the create and the JSON write.
    try {
      if (hooks.afterAcquireCreate) await hooks.afterAcquireCreate({ lockPath, holderId });
    } catch (hookError) {
      // Our own just-created empty path must not outlive a failed
      // acquisition; the only path this protocol ever removes unasked is
      // its OWN empty claim.
      await handle.close().catch(() => {});
      await unlink(lockPath).catch(() => {});
      throw hookError;
    }
    try {
      await handle.writeFile(JSON.stringify({
        schema: COMMIT_LOCK_SCHEMA, holderId, holderPid, acquiredAt: now(),
      }), "utf8");
    } catch (writeError) {
      // Pathological: the content write failed after the exclusive create.
      // Fail CLOSED — never hold a lock whose content cannot be verified
      // later (guard and release both read it back): close the fd, remove
      // OUR OWN just-created path, surface the failure. A process crash in
      // this window instead leaves the EMPTY remnant described above:
      // contenders time out and a human deletes the file (residual (ii)).
      await handle.close().catch(() => {});
      await unlink(lockPath).catch(() => {});
      throw new Error(`COMMIT_LOCK_CONTENT_WRITE_FAILED:${writeError?.code || writeError?.message || "UNKNOWN"}`);
    }
    await handle.close();
    break; // acquired: enter the critical section
  }
  // Critical section. The task runs OUTSIDE the acquire loop: a task failure
  // (e.g. the ledger's own exclusive create hitting EEXIST) must surface
  // verbatim, never be mistaken for lock contention. The release runs on both
  // the success and the failure path, so an in-process failure never orphans
  // the lock, and a task that succeeded while its own-path cleanup failed
  // loudly is not reported as success.
  let taskError = null;
  let taskResult;
  try { taskResult = await task(guard); }
  catch (error) { taskError = error; }
  try { await releaseMine(); }
  catch (releaseError) { if (taskError === null) throw releaseError; }
  if (taskError !== null) throw taskError;
  return taskResult;
}

export async function appendEvent(dir, event, fields = {}) {
  const row = { ts: Date.now(), event, ...fields };
  await appendFile(`${dir}/a-fast-events.ndjson`, JSON.stringify(row) + "\n", "utf8");
}

export async function readComposerSurface(page) {
  return page.evaluate(() => {
    // Issue #23-②: visibility needs an ACTUALLY sized box. A rendered-but
    // 0×0 hidden composer twin reports one zero-size client rect, so a bare
    // getClientRects().length>0 test lets it through and (DOM order first)
    // poisons the composer candidates. Require a rect with real extent.
    const visible = (element) => {
      const rects = element?.getClientRects?.();
      if (rects) {
        for (const rect of rects) {
          if (rect && rect.width > 0 && rect.height > 0) return true;
        }
      }
      const rect = element?.getBoundingClientRect?.();
      return Boolean(rect && rect.width > 0 && rect.height > 0);
    };
    const composerSelector = '#prompt-textarea, [data-testid="prompt-textarea"], [contenteditable="true"][role="textbox"], textarea';
    const composers = [...document.querySelectorAll(composerSelector)].filter(visible);
    // Issue #9: align composer localization with the dispatch template's COMPOSER_SEL (aria-label
    // first). The generic fallback may otherwise land on code-editor textboxes
    // ([aria-label="Edit code"]) that precede the real composer in DOM order and read as a
    // phantom foreign draft (FOREIGN_DRAFT_STOP on an actually empty composer).
    const composerLabels = new Set(["询问 ChatGPT", "Ask ChatGPT"]);
    const isCodeEditor = (element) => /code/i.test(element.getAttribute("aria-label") || "");
    const tiers = [
      composers.filter((element) => composerLabels.has(element.getAttribute("aria-label"))),
      composers.filter((element) => element.id === "prompt-textarea" ||
        element.getAttribute("data-testid") === "prompt-textarea"),
      composers.filter((element) => element.matches?.('[contenteditable="true"][role="textbox"]') &&
        !isCodeEditor(element)),
    ];
    const tier = tiers.find((matches) => matches.length > 0);
    const composer = tier?.length === 1 ? tier[0] : null;
    const composerText = !composer ? "" :
      (composer.tagName === "TEXTAREA" || composer.tagName === "INPUT"
        ? composer.value || ""
        : (document.activeElement === composer ? composer.innerText : null) ||
          composer.innerText || composer.textContent || "");
    const codexComposer = [...document.querySelectorAll('[aria-label="随心输入"]')].some(visible);
    const chatComposer = composers.some((element) => composerLabels.has(element.getAttribute("aria-label")));

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
      surfaceMode: codexComposer && !chatComposer ? "CODEX" : chatComposer ? "CHATGPT" : "UNKNOWN",
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

export function validateDispatchRecord(record) {
  const statuses = new Set(["PREPARED", "SEND_STARTED", "ACCEPTED", "UNCERTAIN", "COMPLETED", "RETRY_AUTHORIZED", "ABORTED"]);
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
      typeof record.composer_baseline === "string") &&
    // agent-kit#33 DONE_CANDIDATE post-mortem evidence: optional live-window
    // fields, same absent-or-null-is-legal contract as the R2.5 fields above.
    (record.doneLiveBodyLen === undefined || record.doneLiveBodyLen === null ||
      (Number.isInteger(record.doneLiveBodyLen) && record.doneLiveBodyLen >= 0)) &&
    (record.doneLiveLastMessageKey === undefined || record.doneLiveLastMessageKey === null ||
      typeof record.doneLiveLastMessageKey === "string"));
}

export async function readDispatchState(dir) {
  const record = await readJson(fileOf(dir));
  if (record && !validateDispatchRecord(record)) throw new Error("DISPATCH_STATE_INVALID");
  return record;
}

// Only used when the dispatch script is stopping. Read the durable ledger anew
// so a later evidence failure cannot be mistaken for a failed send. Never print
// the payload, access token or complete SHA.
export function dispatchStopSnapshot(dir, identity = null) {
  try {
    const record = JSON.parse(readFileSync(fileOf(dir), "utf8"));
    if (!validateDispatchRecord(record)) throw new Error("DISPATCH_STATE_INVALID");
    return {
      status: record.status,
      dispatchId: record.dispatchId,
      shaPrefix: typeof record.payload_sha256 === "string" ? record.payload_sha256.slice(0, 12) : null,
      matchesCurrent: identity ? record.conversationUuid === identity.conversationUuid &&
        record.taskSpace === identity.taskSpace && record.payload_sha256 === identity.payloadSha256 : null,
    };
  } catch {
    return { status: "UNAVAILABLE", dispatchId: null, shaPrefix: null, matchesCurrent: false };
  }
}

export async function prepareDispatch({ monitorDir, conversationUuid, taskSpace, pageLabel, page, payload, commitLock = null }) {
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
  // #27 Batch 3 P1-C round 5 (ruling requirement 1): the PREPARED ledger
  // establishment participates in the SAME commit lock as the arm write
  // section and the disarm commit; round 6 (P1-C-3) promoted that lock to the
  // MONITOR ROOT scope so cross-conversation disarm coordination shares one
  // domain. The browser surface reads above deliberately stay OUTSIDE the
  // lock (never hold the commit lock across browser work); the ACTIVE
  // re-check below is re-run INSIDE the lock so two concurrent sends on one
  // conversation can no longer both pass it and race their PREPARED writes.
  // Fail-closed: an unavailable lock aborts the prepare (the template then
  // aborts before any fill or delivery).
  return withCommitLock(commitLockScopeOf(monitorDir), async (guard) => {
    const inLock = await readDispatchState(monitorDir);
    if (inLock && ACTIVE.has(inLock.status)) {
      throw new Error(`ACTIVE_DISPATCH_BLOCKS_SEND:${inLock.dispatchId}:${inLock.status}`);
    }
    // #27 Batch 3 P1-C round 6 (P1-C-2): armed-state consistency at PREPARED
    // establishment. The ruling's arm→PREPARED gap: an old dispatch A whose
    // ledger was still ACTIVE when the new dispatch B armed could complete,
    // and its disarm commit — seeing no supersession stamp — could legally
    // write DISARMED_IDLE over B's arm before B's prepareDispatch ran, leaving
    // a PREPARED ledger behind a disarmed fast state. Under the lock the
    // sequence is serialized, but the DISARMED_IDLE write itself stays legal
    // whenever B's arm did not stamp the ACTIVE instance (default arm — the
    // frozen send template aborts on any in-flight ledger, so an undeclared
    // arm over an ACTIVE ledger never delivers and must never poison A's own
    // disarm with a self-blocking stamp). The invariant that must hold at
    // delivery time is therefore enforced HERE, where the PREPARED ledger is
    // established: a fast state still reading DISARMED_IDLE is re-armed to
    // DISPATCH_ACCEPTED (the frozen matrix's legal re-arm transition) in the
    // SAME critical section before the ledger write — 布防先于投递 holds for
    // every PREPARED ledger that reaches the fill stage. Missing fast state
    // (arm never ran) is left alone; an unreadable one aborts the prepare
    // fail-closed.
    const fastStatePath = `${monitorDir}/a-fast-state.json`;
    let fastRaw = null;
    try { fastRaw = JSON.parse(await readFile(fastStatePath, "utf8")); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error; // unreadable armed evidence: abort, never deliver unproven
    }
    if (fastRaw !== null) {
      const classification = classifyFastStateFile(fastRaw);
      if ((classification === "current" || classification === "legacy") &&
          fastRaw.armedReason === "DISARMED_IDLE") {
        const rearm = armedTransitionPatch("DISARMED_IDLE", "DISPATCH_ACCEPTED", {
          conversation: conversationUuid, space: taskSpace, timestamp: Date.now(),
        });
        if (rearm.ok) {
          // P1-C-1 (round 6): the re-arm write is ownership-guarded just like
          // the ledger write below — every commit-section state write
          // re-verifies the holder immediately before touching disk.
          await guard();
          await writeJsonAtomic(fastStatePath, normalizeFastState(fastRaw, rearm.patch, Date.now()));
          await appendEvent(monitorDir, "ARMED_DISPATCH_ACCEPTED", {
            source: "PREPARED_REARM", conversation: conversationUuid, space: taskSpace,
            previousReason: "DISARMED_IDLE",
          });
        }
      }
    }

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
      payload_display_sha256: payloadText === null ? null : createHash("sha256").update(
        payloadText.replace(/\r\n?/g, "\n").replace(/\n{2,}/g, "\n").trim(), "utf8").digest("hex"),
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
    // P1-C-1 (round 6): ownership re-verification immediately before the
    // ledger write — a holder displaced mid-section aborts (COMMIT_LOCK_LOST)
    // instead of co-committing with the new holder.
    await guard();
    await writeJsonAtomic(fileOf(monitorDir), record);
    await appendEvent(monitorDir, "DISPATCH_PREPARED", {
      dispatchId: record.dispatchId,
      pageLabel,
      baselineTailRole: record.baselineTailRole,
      baselineComposerLength: record.baselineComposerLength,
    });
    return record;
  }, commitLock ?? undefined);
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

// A proved, unsent PREPARED draft can be cancelled after the browser has
// cleared it and verified that it stayed empty. Preserve the ledger identity.
export async function abortPreparedDispatch(monitorDir, dispatchId) {
  return transition(monitorDir, dispatchId, ["PREPARED"], "ABORTED", {
    abortedAt: Date.now(), reasonCode: "OWNED_DRAFT_RECOVERED",
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

// agent-kit#33: freeze the live-window evidence (body length + tail identity) at
// the moment the probe judged the turn DONE_CANDIDATE, so a later collect failure
// can distinguish a server-side dead reply from an ordinary extraction failure.
// Untracked conversations (no matching record) are skipped silently; this never
// changes dispatch status or finality semantics.
export async function markDoneCandidate(dir, dispatchId, { bodyLen, lastMessageKey } = {}) {
  const record = await readDispatchState(dir);
  if (!record || record.dispatchId !== dispatchId) return null;
  // agent-kit#38/#37 defense in depth: a candidate tail identical to the
  // dispatch baseline proves nothing ever landed (or the optimistic turn
  // rolled back) — the exact vanish-mode shape that produced four false
  // DONE_CANDIDATE rounds. Refuse the evidence instead of freezing it.
  if (typeof lastMessageKey === "string" && lastMessageKey === record.baselineTailKey) {
    await appendEvent(dir, "DONE_CANDIDATE_REJECTED_BASELINE_TAIL", {
      dispatchId, lastMessageKey, baselineTailKey: record.baselineTailKey,
    }).catch(() => {});
    return null;
  }
  const next = {
    ...record,
    doneLiveBodyLen: Number.isFinite(bodyLen) && bodyLen >= 0 ? bodyLen : null,
    doneLiveLastMessageKey: typeof lastMessageKey === "string" ? lastMessageKey : null,
    updatedAt: Date.now(),
  };
  await writeJsonAtomic(fileOf(dir), next);
  return next;
}

export async function markCompleted(monitorDir, dispatchId) {
  const current = await readDispatchState(monitorDir);
  if (!current || current.dispatchId !== dispatchId || current.status !== "ACCEPTED") throw new Error("COMPLETION_REQUIRES_ACCEPTED_DISPATCH");
  const receipt = await verifiedReply(monitorDir, current);
  return transition(monitorDir, dispatchId, ["ACCEPTED"], "COMPLETED", {
    completedAt: Date.now(),
    finalVerification: receipt.source,
    replySha256: receipt.sha256,
    replyBytes: receipt.bytes,
    replyFile: receipt.file,
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

// ---- #27 Batch 3 (ruling §四.2): disarm criteria — pure in-flight check ----
//
// Every condition of the ruling must hold before a conversation's fast state
// may transition to DISARMED_IDLE:
//   1. all related dispatches COMPLETED/RELEASED — the ledger-side truth set
//      is { COMPLETED, ABORTED } (release-sweep.mjs TERMINAL_DISPATCH / P1-4:
//      the v2 validator never writes RELEASED; a RELEASED record is
//      structurally invalid and surfaces as a blocker, never as finality);
//   2. no reply awaiting collection (a COMPLETED dispatch must have its reply
//      consumed first; an ABORTED dispatch has no reply by definition);
//   3. no other in-flight dispatch (counted by the caller across the monitor
//      root; sibling ledgers it cannot prove terminal count as in-flight);
//   4. no unprocessed wake marker (un-acked a-watch-exit.json);
//   5. no unfinished supervision handoff (pending supervision alarm).
// A ledger without arm fields (legacy, ruling §四.1) is NEVER auto-disarmed:
// armedReason null is itself a blocker. The function is pure — the caller
// gathers the evidence, so unit tests inject every branch.
export function evaluateDisarmEligibility({
  armedReason = null, dispatchStatus = null, replyConsumed = false,
  unackedWakes = 0, supervisionPending = false, otherInFlight = 0,
} = {}) {
  const blockers = [];
  if (!ARMED_REASONS.has(armedReason)) blockers.push("ARM_STATE_LEGACY_NO_DISARM_INFERENCE");
  if (armedReason === "DISARMED_IDLE") blockers.push("ARM_STATE_ALREADY_DISARMED");
  if (!["COMPLETED", "ABORTED"].includes(dispatchStatus)) {
    blockers.push("DISPATCH_NOT_TERMINAL:" + (dispatchStatus ?? "ABSENT"));
  }
  if (dispatchStatus === "COMPLETED" && replyConsumed !== true) blockers.push("REPLY_NOT_CONSUMED");
  if (!(Number.isInteger(unackedWakes) && unackedWakes === 0)) blockers.push("WAKE_MARKER_UNACKNOWLEDGED");
  if (supervisionPending) blockers.push("SUPERVISION_HANDOFF_PENDING");
  if (!(Number.isInteger(otherInFlight) && otherInFlight === 0)) blockers.push("OTHER_INFLIGHT_DISPATCH");
  return { eligible: blockers.length === 0, blockers };
}

// ---- R2.5 Composer delivery reliability (planner ruling reply-r43.txt) ----

// R2.6-F adaptive chunking: target 600 user-perceived graphemes, with a hard 1200-byte UTF-8 cap.
// Keep the existing second argument as the UTF-8 byte limit for caller compatibility.
// Chunks preserve exact source text. When a boundary touches a line break, move it into the
// following line where the byte cap allows; otherwise retreat into the preceding line.
export function chunkPayload(text, byteLimit = 1200, targetChars = 600) {
  if (typeof text !== "string") throw new TypeError("PAYLOAD_NOT_STRING");
  if (!Number.isInteger(byteLimit) || byteLimit < 1) throw new TypeError("BYTE_LIMIT_NOT_POSITIVE_INT");
  if (!Number.isInteger(targetChars) || targetChars < 1) throw new TypeError("TARGET_CHARS_NOT_POSITIVE_INT");
  if (typeof Intl.Segmenter !== "function") throw new Error("GRAPHEME_SEGMENTER_UNAVAILABLE");

  const graphemes = Array.from(
    new Intl.Segmenter("und", { granularity: "grapheme" }).segment(text),
    (item) => item.segment,
  );
  const byteLengths = graphemes.map((part) => Buffer.byteLength(part, "utf8"));
  const isLineBreak = (part) => part === "\n" || part === "\r" || part === "\r\n";

  for (const byteLength of byteLengths) {
    if (byteLength > byteLimit) throw new Error("CHUNK_GRAPHEME_EXCEEDS_LIMIT");
  }

  // agent-kit#34: URL-line containment. The composer (ProseMirror) linkifies a
  // URL that arrives separated from its line context — an insertText chunk
  // boundary inside a URL-bearing line splits that line into sibling <p> nodes,
  // and the strict readback gate then (rightly) refuses the mismatched draft,
  // leaving residue no managed path may clear. So a chunk boundary must never
  // fall strictly inside a URL-bearing line: the whole line stays in one chunk.
  const urlLineSpans = [];
  {
    let lineStart = 0;
    let lineText = "";
    const closeLine = (breakIndex) => {
      // Same URL signature as isSensitivePayload — the strict-gate trigger set.
      if (/https?:\/\/|www\./.test(lineText)) urlLineSpans.push({ start: lineStart, end: breakIndex });
      lineText = "";
    };
    for (let i = 0; i < graphemes.length; i++) {
      if (isLineBreak(graphemes[i])) {
        closeLine(i);
        lineStart = i + 1;
      } else {
        lineText += graphemes[i];
      }
    }
    closeLine(graphemes.length);
  }
  for (const span of urlLineSpans) {
    let spanBytes = 0;
    for (let i = span.start; i < span.end; i++) spanBytes += byteLengths[i];
    if (spanBytes > byteLimit) {
      // Unfillable without a split: fail closed here (before any fill work),
      // never mid-fill with residue the managed paths cannot clear.
      throw new Error("CHUNK_URL_LINE_EXCEEDS_LIMIT");
    }
  }

  const chunks = [];
  let start = 0;
  while (start < graphemes.length) {
    let end = start;
    let chunkBytes = 0;
    while (end < graphemes.length && end - start < targetChars &&
      chunkBytes + byteLengths[end] <= byteLimit) {
      chunkBytes += byteLengths[end];
      end++;
    }
    if (end === start) throw new Error("CHUNK_GRAPHEME_EXCEEDS_LIMIT");

    // Do not leave a non-final chunk exactly at a line edge. Prefer crossing the line break
    // and taking one grapheme from the next line; if that cannot fit, retreat into this line.
    if (end < graphemes.length &&
      (isLineBreak(graphemes[end - 1]) || isLineBreak(graphemes[end]))) {
      let forwardEnd = end;
      let forwardBytes = chunkBytes;
      if (forwardEnd < graphemes.length && isLineBreak(graphemes[forwardEnd]) &&
        forwardBytes + byteLengths[forwardEnd] <= byteLimit) {
        forwardBytes += byteLengths[forwardEnd];
        forwardEnd++;
      }
      if (forwardEnd === graphemes.length) {
        // Trailing line breaks can be absorbed into the final chunk without a next-line character.
        end = forwardEnd;
      } else if (!isLineBreak(graphemes[forwardEnd]) &&
        forwardBytes + byteLengths[forwardEnd] <= byteLimit) {
        end = forwardEnd + 1;
      } else {
        let adjustedEnd = end;
        while (adjustedEnd > start &&
          (isLineBreak(graphemes[adjustedEnd - 1]) || isLineBreak(graphemes[adjustedEnd]))) {
          adjustedEnd--;
        }
        if (adjustedEnd > start) end = adjustedEnd;
      }
    }

    // agent-kit#34: enforce URL-line containment AFTER the line-edge adjustment
    // (that adjustment itself can push a boundary into a URL-bearing line). The
    // soft grapheme target yields to a contained line, like the line-edge
    // adjustment; the hard byte cap never does — when the line busts the cap
    // from `start`, the boundary retreats to the line start (the line alone
    // always fits: the pre-check above rejected oversized lines).
    for (let guard = 0; guard <= urlLineSpans.length; guard++) {
      const span = urlLineSpans.find((s) => end > s.start && end < s.end);
      if (!span) break;
      let bytesFromStart = 0;
      for (let i = start; i < span.end; i++) bytesFromStart += byteLengths[i];
      end = bytesFromStart <= byteLimit ? span.end : span.start;
    }

    const chunk = graphemes.slice(start, end).join("");
    if (Buffer.byteLength(chunk, "utf8") > byteLimit) throw new Error("CHUNK_BYTE_LIMIT_EXCEEDED");
    chunks.push(chunk);
    start = end;
  }
  return chunks;
}

// chunkPayload output is source-preserving; Composer normalization is readback-only.

// R2.5-F composer artifact normalization (readback only): collapse whitespace runs to one space.
// Never applied to the delivered payload itself or to sensitive-content fidelity checks.
export function collapseComposerArtifacts(text) {
  if (typeof text !== "string") return "";
  return text.replace(/\s+/g, " ");
}

// ProseMirror represents line breaks as sibling <p> nodes. Reading the whole
// contenteditable with innerText can add a *second* newline at those boundaries.
// Only reconstruct from a verified top-level paragraph structure. Unknown DOM
// shapes retain their raw readback and still fail the strict fidelity gate.
export function composerReadbackText(snapshot) {
  if (typeof snapshot === "string") return snapshot;
  if (Array.isArray(snapshot?.paragraphs) && snapshot.paragraphs.every((p) => typeof p === "string")) {
    return snapshot.paragraphs.join("\n");
  }
  return typeof snapshot?.raw === "string" ? snapshot.raw : "";
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

export function readbackMatches(payload, composerText, mode = readbackMode(payload)) {
  if (typeof payload !== "string" || typeof composerText !== "string") return false;
  if (mode === "strict") {
    return composerText === payload ||
      composerText.replace(/\r\n/g, "\n") === payload.replace(/\r\n/g, "\n");
  }
  if (mode !== "normalized") return false;
  const collapsedText = collapseComposerArtifacts(composerText).trim();
  const collapsedPayload = collapseComposerArtifacts(payload).trim();
  return collapsedText === collapsedPayload ||
    // ProseMirror can remove BOTH newlines at a pasted chunk boundary.
    collapsedText.replace(/\s/g, "") === collapsedPayload.replace(/\s/g, "");
}

export function classifyChunkReadback(previousPrefix, nextPrefix, composerText, mode = "normalized") {
  if (typeof previousPrefix !== "string" || typeof nextPrefix !== "string" ||
    typeof composerText !== "string") return "MISMATCH";
  const matches = (expected) => expected.length === 0
    ? composerText.trim().length === 0
    : readbackMatches(expected, composerText, mode);
  const nextMatches = matches(nextPrefix);
  const previousMatches = matches(previousPrefix);
  if (nextMatches && previousMatches) {
    // Whitespace normalization can make a whitespace-only insert indistinguishable.
    // Accept only raw identity (with CRLF equivalence); otherwise the result is unprovable.
    const raw = (value) => value.replace(/\r\n/g, "\n");
    if (raw(composerText) === raw(nextPrefix)) return "INSERTED";
    if (raw(composerText) === raw(previousPrefix)) return "NO_EFFECT";
    return "MISMATCH";
  }
  if (nextMatches) return "INSERTED";
  if (previousMatches) return "NO_EFFECT";
  return "MISMATCH";
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
    // Allow whitespace-loss at chunk edges for plain prose only. Do not weaken
    // ownership for URLs, shell commands, or code where whitespace is semantic.
    if (!isSensitivePayload(payload)) {
      const compact = (value) => value.replace(/\s/g, "");
      if (compact(normDraft) === compact(normPayload)) return { owned: true, kind: "full" };
      if (compact(normPayload).startsWith(compact(normDraft))) return { owned: true, kind: "prefix" };
    }
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
//
// #36 consumption lifecycle (deadlock family #36/#39-③): the freeze record's
// consumption is POST-OBSERVATION. The probe (and only the probe) consumes a
// freeze, but only AFTER it actually looked at the composer surface:
//   surface observed healthy  → consume into a HEALTHY state (errorCode null);
//   surface confirmed broken  → consume into the shared storm backoff (the
//                               pre-#36 behavior);
//   surface never observable  → the freeze stays unconsumed and EXPIRES (below)
//                               instead of locking the conversation forever.
// The old boot-time consumption wrote the storm backoff before anyone had
// looked at the page — an unconditional poisoning that, on a terminal ledger
// (COMPLETED/ABORTED, probe refused by the arm gate), made consumption itself
// the brick: the written CHAT_SURFACE_STRUCTURALLY_UNAVAILABLE errorCode could
// only be cleared by a healthy probe round that was no longer admittable.

// Unconsumed-freeze expiry (#36): an unconsumed COMPOSER_RENDER_FREEZE stops
// blocking the send Gate 0 after COMPOSER_FREEZE_STALE_MS and is stamped
// expired=true when it is finally consumed. Value rationale: a fresh freeze
// carries its own stormBackoffDeadline ≈ detectedAt + max(8min, 9min + phase)
// ≤ ~9.25 min — the natural recovery window the storm channel already owns.
// 30 min is ≈3× that worst case, so every healthy probe cycle inside one storm
// window consumes the freeze long before expiry; expiry therefore fires only
// when the consumption channel itself became unreachable (the #36/#39-③
// deadlock family: probe refused by the arm gate over a terminal ledger), and
// it is comfortably shorter than an operator loop, so no session stays locked
// past one supervision cycle. A freeze row without a finite detectedAt never
// goes stale (fail-closed: it keeps blocking Gate 0 exactly as before).
export const COMPOSER_FREEZE_STALE_MS = 30 * 60 * 1000;

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

// Shared scan (r44 P0-A1 contract preserved): missing events file = provably no
// freezes (ENOENT → ""); any other read error must THROW so the caller STOPs —
// a read failure must never masquerade as "no freeze".
async function unconsumedComposerFreezeRows(dir) {
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
  return [...freezes.values()];
}

const freezeIsStale = (freeze, now) => Number.isFinite(freeze?.detectedAt) &&
  now - freeze.detectedAt >= COMPOSER_FREEZE_STALE_MS;

// The Gate 0 blocking query (send template contract): the newest unconsumed
// freeze that is still FRESH. Each unconsumed freeze expires individually —
// expired ones no longer block (issue #36), so a "consumption unreachable"
// shape can never lock the conversation permanently.
export async function findUnconsumedComposerFreeze(dir, now = Date.now()) {
  const fresh = (await unconsumedComposerFreezeRows(dir))
    .filter((row) => !freezeIsStale(row, now));
  return fresh.length ? fresh[fresh.length - 1] : null;
}

// The consumption-time query: the newest unconsumed freeze REGARDLESS of age,
// flagged stale so the consumer can stamp EXPIRED on the consumption event
// (#36: 消费时标 EXPIRED — expiry is an audit fact, not an erasure).
export async function findComposerFreezeToConsume(dir, now = Date.now()) {
  const rows = await unconsumedComposerFreezeRows(dir);
  if (!rows.length) return null;
  const newest = rows[rows.length - 1];
  return { ...newest, stale: freezeIsStale(newest, now) };
}

// The single consumption writer, shared by the probe's healthy and storm-backoff
// paths (and by the requireArmedDispatch evidence gate through its finder). The
// verdict is the POST-OBSERVATION evidence class: "SURFACE_HEALTHY" (composer
// surface observed healthy → healthy state, no storm backoff) or "STORM_BACKOFF"
// (surface confirmed broken → the shared storm channel, pre-#36 semantics).
// Strict by contract: an events-file read failure throws (r44 P0-A1) so a
// caller can never mistake a read failure for "nothing to consume".
export async function consumeComposerFreeze(dir, { verdict, space = null, stormBackoffDeadline = null, now = Date.now() } = {}) {
  if (typeof verdict !== "string" || !/^[A-Z_]{3,40}$/.test(verdict)) {
    throw new TypeError("FREEZE_CONSUMPTION_VERDICT_REQUIRED");
  }
  const freeze = await findComposerFreezeToConsume(dir, now);
  if (!freeze) return null;
  await appendEvent(dir, "COMPOSER_FREEZE_CONSUMED", {
    freezeId: freeze.freezeId, detectedAt: freeze.detectedAt,
    consumedVia: verdict, expired: freeze.stale === true,
    stormBackoffDeadline: Number.isFinite(stormBackoffDeadline)
      ? stormBackoffDeadline : (freeze.stormBackoffDeadline ?? null),
    phaseMs: freeze.phaseMs ?? null,
    agent_id: space, space,
  });
  return freeze;
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

// Attachment evidence is tied to the same composer form. Images often have
// thumbnail chips without filename text, so compare them against the pre-upload
// image baseline instead of requiring invisible filename labels.
export function verifyAttachmentEvidence(before, after, filenames) {
  if (!Array.isArray(before) || !Array.isArray(after) || !Array.isArray(filenames) || !filenames.length) return false;
  const images = filenames.filter((name) => /\.(?:png|jpe?g|gif|webp|avif|bmp|heic|heif)$/i.test(name));
  const files = filenames.filter((name) => !images.includes(name));
  return after.some((form, index) => {
    const prior = before[index];
    return prior && form.sendEnabled === true &&
      Number.isInteger(form.images) && Number.isInteger(prior.images) &&
      form.images - prior.images >= images.length &&
      files.every((filename) => typeof form.text === "string" && form.text.includes(filename));
  });
}
