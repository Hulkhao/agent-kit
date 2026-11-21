// Durable dispatch ledger. Never stores prompt/response text or virtualized turn counts.
import { appendFile, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
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

// ---- #27 Batch 3 P1-C round 8 (2026-11-22 ruling: P1-C-1 REMAINS BLOCKED →
// holder-named locks + deterministic election; supersedes the round-5/6/7
// single-path lock, round 6 holder ownership, round 7 PID-liveness fencing) ----
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
// THE ROUND-7 RACE AND ITS STRUCTURAL CURE. Round 7 fenced a single shared
// lock path with PID-liveness steal gating, but every participant still READ
// that one shared path and then ACTED on it (judge dead → steal-rename). The
// planner's counterexample survives any such read-then-act scheme: A reads the
// path, judges the holder dead; before A's rename lands, B recovers the same
// path into a live claim and passes its guard; A's rename then moves B's LIVE
// lock; C takes the vacancy — two writers. Round 8 removes the pattern by
// binding the lock identity to the path NAME:
//
//   <scopeRoot>/a-commit-lock.<holderId>.json
//
// holderId is a random UUID minted per withCommitLock call; the path IS the
// identity. Every protocol participant only ever WRITES or DELETES its own
// named path. Every other claim path is read-only EXCEPT for one narrow,
// provably safe action: a claim whose holderPid the OS proves dead
// (process.kill(pid, 0) rejecting with ESRCH) is unlinked BY ITS NAME. A
// misjudgment is the only way that action can touch a foreign path, and
// kill(pid, 0) never reports ESRCH for a living process (EPERM and every
// other failure = alive; uncertain evidence never deletes). There is no
// steal, no rename, no restore, and no stolen/retiring intermediate state
// anywhere in the protocol.
//
// Protocol (withCommitLock(dir, task, options) — signature unchanged):
//   claim   — open(myPath, "wx") exclusive-creates MY path atomically, then
//     the claim content is written into it:
//     { schema: "ego-commit-lock/v2", holderId, holderPid: process.pid,
//     acquiredAt }. No tmp+swap is needed: other participants only ever READ
//     this path, and a crash between create and write leaves a zero-byte file
//     that classifies as corrupt (swept by age, below) — never as a live
//     holder.
//   sweep   — one readdir of the scope root filtered to the a-commit-lock.
//     prefix; the electing readdir happens AFTER my create (mandatory: a
//     pre-create snapshot would miss claimants that must see me). Name =
//     identity: the holderId is parsed from the file name and cross-checked
//     against the content. Entries classify as
//       live    — readable claim, name = content identity, holderPid proven
//                 alive (kill(pid, 0) succeeds or fails with EPERM);
//       dead    — readable claim, name = content identity, holderPid proven
//                 dead (ESRCH only);
//       corrupt — zero-byte / unparseable / schema-invalid / name ≠ content
//                 (including the legacy v1 single path): no orderable
//                 identity. Corrupt entries never take part in the election
//                 (they cannot commit — the holder's own guard fails
//                 COMMIT_LOCK_LOST on unreadable content) and are unlinked by
//                 name once their mtime age exceeds COMMIT_LOCK_STALE_MS; a
//                 young one may be a live holder mid-write and is left alone.
//   elect   — the winner is the live entry with the smallest (acquiredAt,
//     holderId) — a global total order. If I am not the winner I unlink MY
//     path (always safe) and re-contend within the wait budget; budget
//     exhaustion fails closed with COMMIT_LOCK_WAIT_TIMEOUT. Entering
//     requires the ELECTING READDIR ITSELF to postdate my acquiredAt by
//     COMMIT_LOCK_POLL_MS (the confirmation tick): a round whose snapshot
//     predates the grace re-lists and re-elects instead of entering.
//     Soundness: any claimant created after my electing readdir
//     stamps acquiredAt later than that tick (same-machine clock), so it
//     loses to me by key and yields when it sees me in CS; any
//     same-millisecond claimant — the one case where holderId luck could
//     outrank me — must have created its file more than this interval before
//     my tick, so my fresh re-list sees it and I yield instead. One
//     post-grace re-list therefore makes "I saw no smaller live claimant"
//     hold against every claimant that will ever enter.
//   guard   — task(guard): the holder re-reads MY path and verifies the
//     content still carries MY holderId immediately before its final state
//     write. No protocol participant can change or remove my path while my
//     process lives, so a mismatch is external tampering only — fail-closed
//     with COMMIT_LOCK_LOST, nothing written.
//   release — unlink MY path; ENOENT silent. A live holder's path can never
//     be removed by a protocol participant (the death judgment cannot
//     misfire on a live process), so release never needs a content check to
//     be safe.
//
// Why the round-7 planner counterexample is closed, step by step:
//   ① A judges D dead            → A's sweep puts D's NAME-BOUND path on the
//                                  unlink list — nothing else.
//   ② A pauses                   → A has touched only its own path so far.
//   ③ B recovers "D" and holds   → in round 8 there is no recovery of D: B
//                                  runs its own protocol and claims B's OWN
//                                  path; B's live claim lives at B's name.
//   ④ A moves B's live lock      → impossible: A's only foreign unlink is
//                                  name-bound to PROVABLY dead holders; B's
//                                  process is alive, so B's path is never on
//                                  A's unlink list — and the rename step no
//                                  longer exists in the source at all.
//   ⑤ C takes the vacancy        → the election admits exactly one winner
//                                  over the live set — B and C cannot both
//                                  pass (their keys total-order and each sees
//                                  the other by its confirmation tick).
//   ⑥ B commits + C holds        → cannot happen (⑤); the deterministic T8 /
//                                  T11 tests pin the mutex counter at 1.
//   ⑦ restore aftermath          → no restore path exists (source-pinned by
//                                  the round-8 tests; no rename in the lock
//                                  section at all).
//
// Fail-closed policy (unchanged): a lock the caller cannot take is never a
// license to write — arm aborts (nothing is delivered), the disarm commit
// stays armed, prepareDispatch aborts before any delivery. Error codes:
//   COMMIT_LOCK_WAIT_TIMEOUT — the wait budget expired while still
//     contending (every current claimant is provably alive, or the
//     corrupt/dead residue did not clear); the contender's own claim is
//     removed before throwing. Replaces the round-5/6 COMMIT_LOCK_TIMEOUT
//     and round-7's live-holder refusal as the only contention outcome.
//   COMMIT_LOCK_LOST    — the holder's ownership guard found MY path missing
//     or carrying a different holderId (external tampering — no protocol
//     participant can produce it): fail-closed, nothing written.
//   COMMIT_LOCK_STALE   — retired by round 8 (the steal path it reported is
//     gone); isCommitLockError still recognizes the name so older callers'
//     mapping tables keep matching the family.
// Critical sections here are short pure file operations, so the defaults
// leave a wide margin: contention waits up to 30s (waitBudgetMs, injectable)
// and then fails closed; a dead holder's claim is swept by the next
// contender's readdir regardless of file age (age has no vote on liveness);
// an orphan with no identity (crash between create and write) decays after
// ~30s. Residual fail-closed risks (smaller than round 7's): PID reuse can
// make a dead claim look alive — contenders then time out and the claim
// needs manual removal; a hung live holder blocks contenders until their
// budget expires; a violent backwards wall-clock step between two claimants
// is absorbed unless it exceeds the confirmation interval (25 ms), in which
// case the election degenerates to fail-closed timeouts, never to two
// writers.

export const COMMIT_LOCK_FILE = "a-commit-lock.json"; // legacy v1 single path — recognized only so it decays (corrupt class)
export const COMMIT_LOCK_PREFIX = "a-commit-lock.";
export const COMMIT_LOCK_WAIT_MS = 30_000;
export const COMMIT_LOCK_STALE_MS = 30_000;
const COMMIT_LOCK_POLL_MS = 25;
export const COMMIT_LOCK_SCHEMA = "ego-commit-lock/v2";

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

// A v2 claim read from a holder-named lock file. Every v2 writer stamps a
// usable holderPid, so a claim without one is NOT a claim: pid 0 is never
// trusted (kill(0, 0) addresses a process GROUP, not a process — round-7
// ruling note), and anything unparsable/short/stale-schema is corrupt residue
// with no orderable identity.
const parseCommitLockClaim = (raw) =>
  (raw && typeof raw === "object" && !Array.isArray(raw) &&
    raw.schema === COMMIT_LOCK_SCHEMA && Number.isFinite(raw.acquiredAt) &&
    typeof raw.holderId === "string" && raw.holderId.length > 0 &&
    Number.isInteger(raw.holderPid) && raw.holderPid > 0)
    ? { acquiredAt: raw.acquiredAt, holderId: raw.holderId, holderPid: raw.holderPid, readable: true }
    : null;

// The path IS the identity: the holderId is parsed from the file name and
// must match the claim content (a mismatch is tampering or corruption, never
// a claim). The legacy v1 single path (a-commit-lock.json) parses to an empty
// identity and therefore decays through the corrupt class.
const holderIdOfLockName = (name) => {
  if (!name.startsWith(COMMIT_LOCK_PREFIX) || !name.endsWith(".json")) return null;
  const holderId = name.slice(COMMIT_LOCK_PREFIX.length, name.length - ".json".length);
  return holderId.length > 0 ? holderId : null;
};

const commitLockPathOf = (dir, holderId) => `${dir}/${COMMIT_LOCK_PREFIX}${holderId}.json`;

// PID-liveness judgment: kill(pid, 0) succeeding means the holder process
// exists; EPERM means it exists but we may not signal it; ONLY ESRCH (no such
// process) proves death — and only death puts a foreign path on the unlink
// list. Any other kill failure is treated as ALIVE: uncertain evidence never
// deletes.
const commitHolderIsDead = (claim) => {
  try {
    process.kill(claim.holderPid, 0);
    return false; // alive
  } catch (error) {
    return error?.code === "ESRCH"; // EPERM and anything else: alive, never touch
  }
};

// One readdir sweep of the scope root; each a-commit-lock. file's NAME is the
// holder identity. Classifies to:
//   live    — readable claim, name = content identity, holderPid proven alive;
//   dead    — readable claim, name = content identity, holderPid proven dead;
//   corrupt — zero-byte / unparsable / schema-invalid / name ≠ content (and
//             the legacy v1 single path): no orderable identity — never
//             elected, swept by age only.
async function sweepCommitLockClaims(dir) {
  const names = await readdir(dir); // a broken scope dir (ENOENT) propagates: fail-closed
  const live = [], dead = [], corrupt = [];
  for (const name of names) {
    if (!name.startsWith(COMMIT_LOCK_PREFIX) || !name.endsWith(".json")) continue; // not a commit-lock claim file at all
    const holderId = holderIdOfLockName(name);
    const path = `${dir}/${name}`;
    let claim = null;
    try { claim = parseCommitLockClaim(JSON.parse(await readFile(path, "utf8"))); }
    catch { claim = null; }
    if (holderId === null || claim === null || claim.holderId !== holderId) {
      // No orderable identity (zero bytes, unparsable, stale schema, name ≠
      // content, or the legacy v1 single path whose name parses to no
      // holderId): swept by age only, never elected.
      corrupt.push({ holderId, path });
      continue;
    }
    (commitHolderIsDead(claim) ? dead : live).push({ holderId, path, claim });
  }
  return { live, dead, corrupt };
}

export async function withCommitLock(dir, task, options = {}) {
  const { now = Date.now } = options;
  // The wait budget governs CONTESTING waits: how long a contender keeps
  // claiming and yielding while someone else is the elected winner. It does
  // NOT cut short a winner's own confirmation tick (one bounded poll below).
  // waitBudgetMs is the canonical knob; waitMs is the round-5/6 option name
  // kept as an alias for existing callers.
  const waitBudget = options.waitBudgetMs ?? options.waitMs ?? COMMIT_LOCK_WAIT_MS;
  const hooks = options.hooks ?? {}; // test-only deterministic pause points
  const holderId = randomUUID();
  const myPath = commitLockPathOf(dir, holderId);
  const deadline = now() + waitBudget;
  // Set once my claim content is on disk; null means I hold no claim file, so
  // every exit path knows whether MY path still needs its unlink.
  let myAcquiredAt = null;
  // Release my own claim: unlink MY path — the only path release ever touches
  // (bound by name; ENOENT silent).
  const releaseMine = async () => {
    try { await unlink(myPath); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    myAcquiredAt = null;
  };
  // Ownership guard (P1-C-1 requirement 3, semantics unchanged): handed to the
  // task, which calls it immediately before its final state write. Round 8
  // reads MY OWN named path: no protocol participant can write or remove it
  // while my process lives, so missing/foreign/corrupt content here is
  // external tampering only — fail-closed with COMMIT_LOCK_LOST, nothing
  // written.
  const guard = async () => {
    let claim = null;
    try { claim = parseCommitLockClaim(JSON.parse(await readFile(myPath, "utf8"))); }
    catch { claim = null; }
    if (claim === null || claim.holderId !== holderId) throw new Error("COMMIT_LOCK_LOST");
  };
  try {
    for (;;) {
      // ① claim: exclusive-create MY OWN named path (O_EXCL — the create is
      // atomic), then write the claim content into it. Other participants
      // only ever READ this path; a crash between create and write leaves a
      // zero-byte file that classifies corrupt (swept by age), never live.
      if (myAcquiredAt === null) {
        const stamp = now();
        let handle;
        try {
          handle = await open(myPath, "wx", 0o600);
        } catch (error) {
          if (error.code !== "EEXIST") throw error; // e.g. ENOENT: the dir itself is broken
          // My very own path exists before I created it: with a per-call
          // random holderId no protocol participant can have made it, so it
          // is either my own leftover claim (a winner's confirmation tick
          // re-enters the loop without unlinking) or external tampering. It
          // must still read as mine, else fail closed.
          let mine = null;
          try { mine = parseCommitLockClaim(JSON.parse(await readFile(myPath, "utf8"))); }
          catch { mine = null; }
          if (mine === null || mine.holderId !== holderId) throw new Error("COMMIT_LOCK_LOST");
          myAcquiredAt = mine.acquiredAt; // reuse my own leftover claim verbatim
        }
        if (myAcquiredAt === null) {
          try {
            await handle.writeFile(JSON.stringify({
              schema: COMMIT_LOCK_SCHEMA, holderId, holderPid: process.pid, acquiredAt: stamp,
            }), "utf8");
          } finally { await handle.close(); }
          myAcquiredAt = stamp;
        }
      }
      // ② sweep + elect on a FRESH readdir taken AFTER my create (mandatory:
      // a pre-create snapshot would miss claimants that must see me and
      // yield). The snapshot's wall time is kept: only a readdir that itself
      // postdates my confirmation grace may elect (see ④). PROVABLY dead
      // claims are unlinked BY NAME — the only foreign-path action in the
      // whole protocol, bound to the judged holder's own identity. Corrupt
      // residue is unlinked by name only past the age bound (a young corrupt
      // file may be a live holder mid-write; it cannot commit anyway — its
      // own guard fails on unreadable content).
      const sweptAt = now();
      const { live, dead, corrupt } = await sweepCommitLockClaims(dir);
      // Injection seam (deterministic tests): fires after classification and
      // BEFORE any foreign-path action — the pause point where this contender
      // has judged dead holders but has not yet acted on them.
      if (hooks.afterClassify) await hooks.afterClassify({ live, dead, corrupt, holderId, myPath });
      for (const entry of dead) {
        try { await unlink(entry.path); }
        catch (error) {
          // ENOENT: another contender's sweep removed it first. EPERM/EBUSY:
          // the Windows delete-pending window while a concurrent sweep's
          // delete of the SAME name-bound path is still in flight. A sweep
          // unlink that did not land simply stays behind for a later round's
          // sweep to retry — the path is bound to a PROVABLY dead holder or
          // aged corrupt residue, neither of which is ever elected, so the
          // leftover is inert. Anything else is real breakage and propagates.
          if (error?.code !== "ENOENT" && error?.code !== "EPERM" && error?.code !== "EBUSY") throw error;
        }
      }
      for (const entry of corrupt) {
        let mtimeMs = 0;
        try { mtimeMs = (await stat(entry.path)).mtimeMs; } catch { continue; } // vanished meanwhile
        if (now() - mtimeMs > COMMIT_LOCK_STALE_MS) {
          try { await unlink(entry.path); }
          catch (error) {
            // Same tolerance set as the dead sweep above (see there).
            if (error?.code !== "ENOENT" && error?.code !== "EPERM" && error?.code !== "EBUSY") throw error;
          }
        }
      }
      // ③ election: the smallest (acquiredAt, holderId) among the LIVE claims
      // wins — a global total order. My own claim is in the set (complete
      // content on disk before this readdir started, holderPid = my live
      // process). Losing means unlinking MY path and re-contending within
      // the budget; budget exhaustion fails closed.
      const winner = live.reduce((best, entry) => (best === null ||
        entry.claim.acquiredAt < best.claim.acquiredAt ||
        (entry.claim.acquiredAt === best.claim.acquiredAt &&
         entry.claim.holderId < best.claim.holderId)) ? entry : best, null);
      if (winner === null || winner.holderId !== holderId) {
        await releaseMine();
        if (now() >= deadline) throw new Error("COMMIT_LOCK_WAIT_TIMEOUT");
        await new Promise((resolve) => setTimeout(resolve, COMMIT_LOCK_POLL_MS));
        continue;
      }
      // ④ confirmation tick: entering requires THE ELECTING READDIR ITSELF to
      // have happened at least COMMIT_LOCK_POLL_MS after MY acquiredAt — not
      // merely that "now" has passed it. A round whose snapshot predates the
      // grace (a slow round, or a test hook that paused this contender
      // mid-round) must never elect: claimants created after such a snapshot
      // are exactly the ones the stale view cannot see. Re-listing after the
      // grace closes the last election window: any claimant created after my
      // electing readdir stamps acquiredAt later than that readdir (same-
      // machine clock), so it loses to me by key and yields when it sees me
      // in CS; any same-millisecond claimant — the one case where holderId
      // luck could outrank me — must have created its file more than this
      // interval before the electing readdir, so the readdir sees it and I
      // yield instead. A pause AFTER a valid electing readdir stays safe:
      // claimants created during it still stamp keys later than the readdir,
      // so they lose to me. My claim stays in place while I wait for the
      // tick (the loop reuses it through the EEXIST branch above).
      if (sweptAt - myAcquiredAt < COMMIT_LOCK_POLL_MS) {
        await new Promise((resolve) => setTimeout(resolve, COMMIT_LOCK_POLL_MS));
        continue;
      }
      break; // confirmed winner: enter the critical section
    }
  } catch (error) {
    // A failed contention round never orphans my claim: a contender that
    // gives up (timeout, broken dir, hook failure) removes its own live-
    // looking path so others never wait on a ghost. Only a process crash
    // leaves one, and that is what the death sweep recovers from.
    await releaseMine().catch(() => {});
    throw error;
  }
  // Critical section. The task runs OUTSIDE the contention catch: a task
  // failure (e.g. the ledger's own exclusive create hitting EEXIST) must
  // surface verbatim, never be mistaken for lock contention. The release runs
  // on both the success and the failure path, so an in-process failure never
  // orphans the lock, and a task that succeeded while its own-path cleanup
  // failed loudly is not reported as success.
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
