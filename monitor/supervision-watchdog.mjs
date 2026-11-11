#!/usr/bin/env node
// A managed task must deliver this process's exit to the Agent. stdout alone is not a wake.
import { randomUUID } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseSupervisionConfig, classifySupervision, nextSupervisionRound } from "./supervision-policy.mjs";

const defaultDir = dirname(fileURLToPath(import.meta.url));
const SCHEMA = "ego-supervision/v1";
const empty = () => ({ schema: SCHEMA, generationKey: null, progressAt: 0, abnormalRounds: 0, lastReviewAt: 0, pending: null });

async function loadStatus(dir = defaultDir) {
  const statusFile = join(dir, "a-supervision-status.json");
  try {
    const value = JSON.parse(await readFile(statusFile, "utf8"));
    if (value.schema !== SCHEMA || !Number.isInteger(value.abnormalRounds) || value.abnormalRounds < 0 ||
        !Number.isFinite(value.progressAt) || !Number.isFinite(value.lastReviewAt) ||
        (value.pending && (typeof value.pending.id !== "string" || !Number.isFinite(value.pending.issuedAt)))) {
      throw new Error("SUPERVISION_STATUS_INVALID");
    }
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return empty();
    throw error;
  }
}

async function store(value, dir = defaultDir) {
  const statusFile = join(dir, "a-supervision-status.json");
  const temporary = statusFile + "." + randomUUID() + ".tmp";
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(temporary, statusFile);
}

export async function acknowledge(id, action, dir = defaultDir, now = Date.now()) {
  if (!id || !["investigated", "resolved"].includes(action)) throw new Error("ACK_ARGS_INVALID");
  const status = await loadStatus(dir);
  if (!status.pending || status.pending.id !== id) throw new Error("WAKE_ID_NOT_PENDING");
  status.pending = null;
  status.lastReviewAt = now;
  if (action === "resolved") status.abnormalRounds = 0;
  await store(status, dir);
  console.log("SUPERVISION_ACKNOWLEDGED=" + action);
}

export async function tick(now = Date.now(), dir = defaultDir) {
  const config = parseSupervisionConfig(JSON.parse(await readFile(join(dir, "supervision.config.json"), "utf8")));
  let status = await loadStatus(dir);
  let state;
  try { state = JSON.parse(await readFile(join(dir, "a-fast-state.json"), "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    state = null;
  }
  // Progress observed after the alarm supersedes the pending alarm and its counter.
  if (state) {
    const advanced = nextSupervisionRound(status, state);
    if (advanced.progressAt !== status.progressAt || advanced.generationKey !== status.generationKey) {
      status = { ...advanced, pending: null };
      await store(status, dir);
    }
  }
  if (status.pending) {
    console.log(`RESULT=MONITOR_WAKE_UNACKNOWLEDGED wakeId=${status.pending.id} round=${status.abnormalRounds}`);
    return true;
  }
  const prior = status;
  if (state) status = nextSupervisionRound(status, state);
  const reason = state ? classifySupervision(state, { now, lastReviewAt: status.lastReviewAt, minutes: config.supervisionMinutes }) : "STATE_MISSING";
  if (!reason) {
    if (status.generationKey !== prior.generationKey || status.progressAt !== prior.progressAt || status.abnormalRounds !== prior.abnormalRounds) await store(status, dir);
    return false;
  }
  status.abnormalRounds += 1;
  status.pending = { id: randomUUID(), reason, issuedAt: now, progressAt: status.progressAt };
  await store(status, dir);
  console.log(`RESULT=${status.abnormalRounds >= config.maxAbnormalRounds ? "USER_ESCALATION_REQUIRED" : "WAKE_SUPERVISOR"} reason=${reason} round=${status.abnormalRounds}/${config.maxAbnormalRounds} wakeId=${status.pending.id}`);
  return true;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (process.argv[2] === "ack") await acknowledge(process.argv[3], process.argv[4], process.argv[5] || defaultDir);
    else {
      const dir = process.argv[2] || defaultDir;
      while (true) {
        if (await tick(Date.now(), dir)) process.exit(2);
        await new Promise((resolve) => setTimeout(resolve, 60_000));
      }
    }
  } catch (error) {
    console.error("RESULT=SUPERVISION_FAILURE code=" + (error.message || "UNKNOWN"));
    process.exitCode = 2;
  }
}
