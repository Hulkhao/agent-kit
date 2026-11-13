import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFileSync, existsSync, unlinkSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const DEFAULT_FOLDER = "D:\\Downloads\\zcode-codex交流";
const DEFAULT_DELAY_MS = 120_000;
const DEFAULT_POLL_MS = 5_000;
let logFile = null;

export function queueArgs({ thread, codexRemote }) {
  const args = ["queue", "--thread", thread, "--message", "MESSAGE_PLACEHOLDER", "--resume"];
  // On hosts with UAC disabled every token is elevated, so `app-server daemon
  // start` refuses to run; resume through a standalone app-server endpoint.
  if (codexRemote) args.push("--remote", codexRemote);
  return args;
}

function log(event, details = "") {
  const line = `${new Date().toISOString()} ${event}${details ? ` ${details}` : ""}`;
  console.log(line);
  if (logFile) appendFileSync(logFile, line + "\n");
}

function hasFinalMarker(content, marker) {
  return content.trimEnd().split(/\r?\n/).at(-1)?.trim() === marker;
}

async function completedReplies(folder, suffix = ".reply.md", marker = "DONE") {
  const files = await readdir(join(folder, "replies"), { withFileTypes: true });
  const ready = [];
  for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!file.isFile() || !file.name.endsWith(suffix)) continue;
    let content;
    try {
      content = await readFile(join(folder, "replies", file.name), "utf8");
    } catch (error) {
      if (error.code === "ENOENT") continue; // Renamed between enumeration and read.
      throw error;
    }
    if (!hasFinalMarker(content, marker)) continue;
    ready.push({ name: file.name, sha: createHash("sha256").update(content).digest("hex") });
  }
  return ready;
}

async function saveState(stateFile, state) {
  await mkdir(dirname(stateFile), { recursive: true });
  const temp = `${stateFile}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(state, null, 2) + "\n", "utf8");
  await rename(temp, stateFile);
}

export function createReplyWatcher({ folder, thread, stateFile, delayMs = DEFAULT_DELAY_MS, queue }) {
  let state;
  return {
    async init() {
      const normalizedFolder = resolve(folder);
      if (existsSync(stateFile)) {
        state = JSON.parse(await readFile(stateFile, "utf8"));
        if (state.version !== 1 || state.thread !== thread || state.folder !== normalizedFolder) {
          throw new Error(`STATE_MISMATCH ${stateFile}`);
        }
        const uncertain = Object.values(state.replies).filter((reply) => reply.status === "queuing").length;
        if (uncertain) log("QUEUE_UNCERTAIN", `count=${uncertain}; inspect queue before manual reset`);
      } else {
        // Files already present when the watcher is first installed form its baseline.
        const initial = await completedReplies(normalizedFolder);
        state = { version: 1, folder: normalizedFolder, thread, replies: {}, acknowledgements: {} };
        for (const reply of initial) {
          state.replies[reply.name] = { sha: reply.sha, status: "baseline" };
        }
        await saveState(stateFile, state);
        log("BASELINE", `existing=${initial.length}`);
      }
      state.acknowledgements ??= {};
    },

    async scan(now = Date.now()) {
      const acknowledgements = await completedReplies(folder, ".ack.md", "ACK");
      const replies = await completedReplies(folder);
      let changed = false;
      for (const ack of acknowledgements) {
        if (state.acknowledgements[ack.name]?.sha === ack.sha) continue;
        state.acknowledgements[ack.name] = { sha: ack.sha, receivedAt: now };
        log("ACK_RECEIVED", `file=${ack.name}`);
        changed = true;
      }
      for (const reply of replies) {
        const previous = state.replies[reply.name];
        if (previous?.sha === reply.sha) continue;
        state.replies[reply.name] = { sha: reply.sha, status: "pending", firstSeenAt: now };
        log("REPLY_FOUND", `file=${reply.name} wakeAfter=${new Date(now + delayMs).toISOString()}`);
        changed = true;
      }
      const currentNames = new Set(replies.map((reply) => reply.name));
      for (const [name, item] of Object.entries(state.replies)) {
        if (item.status === "pending" && !currentNames.has(name)) {
          item.status = "superseded";
          log("REPLY_SUPERSEDED", `file=${name}`);
          changed = true;
        }
      }
      if (changed) await saveState(stateFile, state);

      const due = Object.entries(state.replies)
        .filter(([, item]) => item.status === "pending" && now - item.firstSeenAt >= delayMs)
        .map(([name]) => name);
      if (!due.length) return { due: 0, queued: false };

      for (const name of due) state.replies[name].status = "queuing";
      await saveState(stateFile, state);
      // Persist QUEUING before the CLI call so a crash never silently re-queues a prompt.
      let result;
      try {
        result = await queue(due);
      } catch (error) {
        for (const name of due) state.replies[name].status = "failed";
        await saveState(stateFile, state);
        log("QUEUE_FAILED", String(error));
        throw error;
      }
      for (const name of due) state.replies[name].status = result.resumed ? "delivered" : "queued_unwoken";
      await saveState(stateFile, state);
      log(result.resumed ? "QUEUED_RESUME_REQUESTED" : "QUEUED_RESUME_FAILED", `count=${due.length}`);
      return { due: due.length, queued: true, resumed: result.resumed };
    },

    getState() {
      return structuredClone(state);
    },
  };
}

async function acquireLock(lockFile) {
  await mkdir(dirname(lockFile), { recursive: true });
  try {
    const existing = JSON.parse(await readFile(lockFile, "utf8"));
    if (Number.isInteger(existing.pid) && existing.pid > 0) {
      try {
        process.kill(existing.pid, 0);
        throw new Error(`WATCHER_ALREADY_RUNNING pid=${existing.pid}`);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    await unlink(lockFile);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const handle = await open(lockFile, "wx");
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  } finally {
    await handle.close();
  }
  process.on("exit", () => {
    try { unlinkSync(lockFile); } catch { /* lock is also recovered at next startup */ }
  });
}

function getOptions(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--") || argv[i + 1] === undefined) {
      throw new Error(`Expected --key value, got ${argv[i]}`);
    }
    flags[argv[i].slice(2)] = argv[i + 1];
  }
  const thread = flags.thread || process.env.CODEX_THREAD_ID;
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(thread || "")) {
    throw new Error("Pass the Codex session UUID with --thread <uuid>");
  }
  const delayMs = flags["delay-ms"] === undefined ? DEFAULT_DELAY_MS : Number(flags["delay-ms"]);
  const pollMs = flags["poll-ms"] === undefined ? DEFAULT_POLL_MS : Number(flags["poll-ms"]);
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || !Number.isSafeInteger(pollMs) || pollMs < 50) {
    throw new Error("Invalid delay-ms or poll-ms");
  }
  return {
    thread,
    folder: resolve(flags.folder || DEFAULT_FOLDER),
    stateFile: resolve(flags.state || join(process.env.LOCALAPPDATA || homedir(), "agent-kit", `codex-zcode-replies-${thread}.json`)),
    codex: flags.codex || process.env.CODEX_APP_RUNTIME_CLI_PATH || "codex",
    codexRemote: flags["codex-remote"] || process.env.CODEX_APP_REMOTE_ENDPOINT || "",
    delayMs,
    pollMs,
  };
}

async function main() {
  const options = getOptions(process.argv.slice(2));
  await stat(join(options.folder, "replies"));
  await acquireLock(`${options.stateFile}.lock`);
  logFile = `${options.stateFile}.log`;
  const queue = async (names) => {
    const paths = names.map((name) => `replies/${name}`).join("\n");
    const message = [
      "ZCode 回复已完整落盘，监控已延迟约两分钟，自动接棒当前任务。",
      `交流目录 ${options.folder}`,
      "本轮回执文件：", paths,
      "逐份读取回执和对应请求，核对证据，继续此前尚未完成的开发与必要派单。按约定回复文件以 .reply.md 结尾、末行 DONE。",
      "不要重复已完成的工作。派单后由目录监控接续下一份回执。",
    ].join("\n");
    const args = queueArgs(options);
    args[args.indexOf("MESSAGE_PLACEHOLDER")] = message;
    const { stdout, stderr } = await execFileAsync(
      options.codex,
      args,
      { cwd: resolve(import.meta.dirname, ".."), windowsHide: true, timeout: 60_000, maxBuffer: 256 * 1024 },
    );
    if (stdout.trim()) log("CODEX_STDOUT", stdout.trim());
    if (stderr.trim()) log("CODEX_STDERR", stderr.trim());
    return { resumed: !/failed to resume|resume failed|could not resume/i.test(stdout + stderr) };
  };
  const watcher = createReplyWatcher({ ...options, queue });
  await watcher.init();
  log("WATCHING", `folder=${options.folder} thread=${options.thread} delayMs=${options.delayMs}`);
  for (;;) {
    await new Promise((done) => setTimeout(done, options.pollMs));
    await watcher.scan();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    log("WATCHER_STOPPED", error.stack || String(error));
    process.exitCode = 1;
  });
}
