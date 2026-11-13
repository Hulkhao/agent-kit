#!/usr/bin/env node
// Single entry point for ChatGPT web dispatch, monitoring and page release.
// Use this command as a MANAGED foreground/background tool task: exit code 2
// carries a wake signal to the hosting Agent (only if its job API supports it).
import { readFile, writeFile, mkdir, copyFile, unlink, stat, rename, open } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { tick, acknowledge } from "./supervision-watchdog.mjs";
import { readDispatchState, markCompleted, writeJsonAtomic, validateDispatchRecord } from "./dispatch-state.mjs";
import { verifiedReply, acknowledgeReply, verifiedConsumption, sha256 } from "./reply-delivery.mjs";

const sourceDir = dirname(fileURLToPath(import.meta.url));
const kitDir = dirname(sourceDir);
const adapter = {
  "REPLACE_WITH_DEPLOY_MONITOR_DIR": "monitorDir",
  "REPLACE_WITH_UNIQUE_TASKSPACE": "space",
  "REPLACE_WITH_STABLE_AGENT_ID": "agentId",
  "REPLACE_WITH_CONVERSATION_UUID": "conversation",
  "REPLACE_WITH_COMPLETED_CONVERSATION_UUID": "conversation",
  "REPLACE_WITH_MESSAGE_FILE_PATH": "message",
  "REPLACE_WITH_ATTACHMENTS_JSON": "attachments",
  "REPLACE_WITH_NEW_CHAT_FLAG": "newChat",
  "REPLACE_WITH_RECOVER_ONLY": "recoverOnly",
};
const templates = {
  send: join(kitDir, "skills/chatgpt-web-dispatch/templates/dispatch-round.template.mjs"),
  probe: join(sourceDir, "ego-fast-probe.mjs"),
  release: join(sourceDir, "release-agent-space.template.mjs"),
  collect: join(sourceDir, "collect-reply.template.mjs"),
};
const modules = ["agent-space.mjs", "dispatch-state.mjs", "reply-delivery.mjs", "page-recovery.mjs", "state-schema.mjs", "taskspace-takeover.mjs", "supervision-policy.mjs"];
const allowed = new Set(["send", "send-new", "recover-draft", "probe", "watch", "collect", "consume", "release", "ack"]);
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;

export function parseArgs(args) {
  const [action, ...rest] = args;
  if (!allowed.has(action)) throw new Error("MANAGER_ACTION_INVALID");
  if (rest.length % 2) throw new Error("MANAGER_ARG_MISSING_VALUE");
  const params = { action };
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    if (!/^--(?:agent-id|space|conversation|request-id|message|attachments-file|monitor-dir|wake-id|ack-action|reply-sha256|archived-record)$/.test(key) || !rest[i + 1] ||
        Object.hasOwn(params, key.slice(2))) throw new Error("MANAGER_ARG_INVALID");
    const normalized = key.replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    params[normalized] = rest[i + 1];
  }
  if (!params.monitorDir) throw new Error("MONITOR_DIR_REQUIRED");
  params.monitorDir = resolve(params.monitorDir);
  params.newChat = action === "send-new";
  params.recoverOnly = action === "recover-draft";
  if (params.newChat && !params.conversation && uuid.test(params.requestId || "")) params.conversation = params.requestId;
  if (!params.agentId || !/^[a-z0-9][a-z0-9_.-]{1,63}$/i.test(params.agentId) ||
    !params.space || params.space.length > 120 || !uuid.test(params.conversation) ||
    (params.newChat && (params.conversation !== params.requestId || !uuid.test(params.requestId))) ||
    (!params.newChat && params.requestId)) throw new Error("MANAGER_IDENTITY_INVALID");
  if (action === "ack" && (!params.wakeId || !["investigated", "resolved"].includes(params.ackAction))) throw new Error("ACK_ARGS_INVALID");
  if (action === "consume" && !/^[\da-f]{64}$/i.test(params.replySha256 || "")) throw new Error("REPLY_SHA256_REQUIRED");
  if (["send", "send-new", "recover-draft"].includes(action) && !params.message) throw new Error("MESSAGE_REQUIRED");
  if (params.attachmentsFile && !["send", "send-new"].includes(action)) throw new Error("ATTACHMENTS_SEND_ONLY");
  if (params.archivedRecord && !params.recoverOnly) throw new Error("ARCHIVED_RECORD_RECOVERY_ONLY");
  return params;
}

export function adaptTemplate(source, params) {
  let result = source;
  for (const [token, key] of Object.entries(adapter)) {
    if (result.includes(token)) {
      if (key === "newChat" || key === "recoverOnly") {
        result = result.replaceAll('"' + token + '"', params[key] ? "true" : "false");
      } else if (key === "attachments") {
        if (!Array.isArray(params.attachments)) throw new Error("ADAPTER_ATTACHMENTS_INVALID");
        result = result.replaceAll('"' + token + '"', JSON.stringify(params.attachments));
      } else {
        if (typeof params[key] !== "string") throw new Error("ADAPTER_VALUE_MISSING: " + key);
        result = result.replaceAll('"' + token + '"', JSON.stringify(params[key]));
      }
    }
  }
  if (result.includes("REPLACE_WITH_")) throw new Error("ADAPTER_UNRESOLVED");
  return result;
}

// Every conversation owns a durable ledger and supervisor state, even if one
// Agent owns several pages in the same TaskSpace.
export function conversationDir(params) {
  return params.newChat
    ? join(params.monitorDir, "pending-new", params.requestId.toLowerCase())
    : join(params.monitorDir, "conversations", params.conversation.toLowerCase());
}

// A pending first-message request is durable before the browser allocates a Page.
// Retrying this request only completes a verified binding, never sends again.
export async function bindNewConversation(root, requestId, space, agentId, payloadHash) {
  const pending = join(root, "pending-new", requestId.toLowerCase());
  const mappingFile = join(root, "new-requests", requestId.toLowerCase() + ".json");
  let mapping;
  try { mapping = JSON.parse(await readFile(mappingFile, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!mapping) {
    const record = await readDispatchState(pending);
    if (!record || record.status !== "ACCEPTED" || record.taskSpace !== space ||
        record.conversationUuid.toLowerCase() !== requestId.toLowerCase()) throw new Error("NEW_CHAT_RECONCILIATION_REQUIRED");
    const pendingRequest = JSON.parse(await readFile(join(pending, "a-new-request.json"), "utf8"));
    if (record.payload_sha256 !== payloadHash || pendingRequest.requestId !== requestId.toLowerCase() ||
        pendingRequest.space !== space || pendingRequest.agentId !== agentId || pendingRequest.payloadSha256 !== payloadHash) {
      throw new Error("NEW_CHAT_REQUEST_CONFLICT");
    }
    const evidence = JSON.parse(await readFile(join(pending, "a-new-conversation.json"), "utf8"));
    if (evidence.requestId.toLowerCase() !== requestId.toLowerCase() || !uuid.test(evidence.conversationUuid) ||
        evidence.conversationUuid.toLowerCase() === requestId.toLowerCase()) throw new Error("NEW_CHAT_UUID_UNVERIFIED");
    mapping = { requestId: requestId.toLowerCase(), conversationUuid: evidence.conversationUuid.toLowerCase(), space };
    try {
      await stat(join(root, "conversations", mapping.conversationUuid));
      throw new Error("NEW_CHAT_TARGET_OCCUPIED");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await mkdir(dirname(mappingFile), { recursive: true });
    await writeJsonAtomic(mappingFile, mapping);
  }
  if (mapping.space !== space || mapping.requestId !== requestId.toLowerCase() || !uuid.test(mapping.conversationUuid)) {
    throw new Error("NEW_CHAT_BINDING_CONFLICT");
  }
  const target = join(root, "conversations", mapping.conversationUuid);
  let record = await readDispatchState(target);
  if (!record) {
    record = await readDispatchState(pending);
    if (!record || record.status !== "ACCEPTED" || record.taskSpace !== space ||
        ![requestId.toLowerCase(), mapping.conversationUuid].includes(record.conversationUuid.toLowerCase())) {
      throw new Error("NEW_CHAT_BINDING_REQUIRES_ACCEPTED");
    }
    const pendingRequest = JSON.parse(await readFile(join(pending, "a-new-request.json"), "utf8"));
    if (record.payload_sha256 !== payloadHash || pendingRequest.requestId !== requestId.toLowerCase() ||
        pendingRequest.space !== space || pendingRequest.agentId !== agentId || pendingRequest.payloadSha256 !== payloadHash) {
      throw new Error("NEW_CHAT_REQUEST_CONFLICT");
    }
    if (record.conversationUuid.toLowerCase() !== mapping.conversationUuid) {
      record = { ...record, conversationUuid: mapping.conversationUuid };
      await writeJsonAtomic(join(pending, "a-dispatch-state.json"), record);
    }
    await mkdir(dirname(target), { recursive: true });
    try {
      await stat(target);
      throw new Error("NEW_CHAT_TARGET_OCCUPIED");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await rename(pending, target);
  }
  const request = JSON.parse(await readFile(join(target, "a-new-request.json"), "utf8"));
  const evidence = JSON.parse(await readFile(join(target, "a-new-conversation.json"), "utf8"));
  if (request.requestId !== requestId.toLowerCase() || request.space !== space || request.agentId !== agentId || request.payloadSha256 !== payloadHash ||
      evidence.requestId.toLowerCase() !== requestId.toLowerCase() || evidence.conversationUuid.toLowerCase() !== mapping.conversationUuid ||
      record.taskSpace !== space || record.conversationUuid.toLowerCase() !== mapping.conversationUuid ||
      record.payload_sha256 !== payloadHash || !["ACCEPTED", "COMPLETED"].includes(record.status)) {
    throw new Error("NEW_CHAT_BOUND_RECORD_INVALID");
  }
  return mapping.conversationUuid;
}

// The presence of a conversation UUID alone never arms a browser job.
// A started send must remain observable even if acknowledgement failed; the
// probe's existing reconciliation path can then establish whether it landed.
export async function requireArmedDispatch(dir, params, action) {
  const record = await readDispatchState(dir);
  if (!record || record.conversationUuid.toLowerCase() !== params.conversation.toLowerCase() ||
      record.taskSpace !== params.space ||
      (action === "probe" ? !["SEND_STARTED", "UNCERTAIN", "ACCEPTED"].includes(record.status) :
        !["SEND_STARTED", "UNCERTAIN", "ACCEPTED", "COMPLETED"].includes(record.status))) {
    throw new Error("DISPATCH_NOT_ARMED");
  }
  return record;
}

export async function loadAttachments(file) {
  if (!file) return [];
  const value = JSON.parse(await readFile(resolve(file), "utf8"));
  if (!Array.isArray(value) || !value.length || value.some((name) => typeof name !== "string" || !isAbsolute(name))) {
    throw new Error("ATTACHMENTS_MANIFEST_INVALID");
  }
  for (const name of value) {
    if (!(await stat(name)).isFile()) throw new Error("ATTACHMENT_NOT_FILE");
  }
  return value;
}

export function classifyProbeResult({ code, result }, benignStreak = 0) {
  if (code !== 0 || !result) return { wake: true, streak: 0 };
  if (["GENERATING", "IDLE_PREDELIVERY", "PROBE_BACKOFF", "PROBE_UNAVAILABLE_RETRY"].includes(result)) {
    return { wake: false, streak: 0 };
  }
  if (result === "START_IDLE_WAKE_SUPERVISOR") {
    return { wake: benignStreak >= 20, streak: benignStreak + 1 };
  }
  return { wake: true, streak: 0 };
}

export function classifyManagerResult(action, observation, record, params) {
  if (action === "release") return observation.code === 0 && observation.result === "AGENT_SPACE_RELEASED" ? 0 : 2;
  if (action !== "send") return 2;
  const sameDispatch = record && record.conversationUuid.toLowerCase() === params.conversation.toLowerCase() &&
    record.taskSpace === params.space;
  const accepted = sameDispatch && ["ACCEPTED", "COMPLETED"].includes(record.status);
  const clean = observation.code === 0 && observation.result === "AUTO_ACCEPTED_DISPATCH_ACCEPTED";
  if (accepted && clean) return 0;
  // The ledger is authoritative even when the browser script reports STOP.
  // An accepted send with a later error needs supervision, never a resend.
  return 2;
}

async function collectCompleted(params, dir) {
  const record = await readDispatchState(dir);
  if (!record || record.conversationUuid.toLowerCase() !== params.conversation.toLowerCase() || record.taskSpace !== params.space) {
    throw new Error("COLLECT_DISPATCH_MISMATCH");
  }
  if (record.status === "COMPLETED") {
    const receipt = await verifiedReply(dir, record);
    console.log("RESULT=REPLY_STAGED file=" + join(dir, receipt.file) + " sha256=" + receipt.sha256);
    return 0;
  }
  if (record.status !== "ACCEPTED") throw new Error("COLLECT_REQUIRES_ACCEPTED");
  // A previous successful extraction may have crashed before ledger completion.
  let receipt;
  try { receipt = await verifiedReply(dir, record); }
  catch (error) { if (error.message !== "REPLY_DELIVERY_REQUIRED") throw error; }
  if (!receipt) {
    const template = await readFile(templates.collect, "utf8");
    const observation = await runEgo(adaptTemplate(template, params), dir, "collect");
    if (observation.code !== 0 || observation.result !== "REPLY_COLLECTED") return 2;
    receipt = await verifiedReply(dir, record);
  }
  await markCompleted(dir, record.dispatchId);
  console.log("RESULT=REPLY_STAGED file=" + join(dir, receipt.file) + " sha256=" + receipt.sha256);
  return 0;
}

async function releaseDelivered(params, dir) {
  const record = await readDispatchState(dir);
  if (!record || record.status !== "COMPLETED" ||
      record.conversationUuid.toLowerCase() !== params.conversation.toLowerCase() || record.taskSpace !== params.space) {
    throw new Error("RELEASE_REQUIRES_VERIFIED_COMPLETION");
  }
  await verifiedConsumption(dir, record);
  const template = await readFile(templates.release, "utf8");
  const released = await runEgo(adaptTemplate(template, params), dir, "release");
  if (released.code !== 0 || released.result !== "AGENT_SPACE_RELEASED") {
    console.log("RESULT=REPLY_DELIVERED_RELEASE_PENDING");
    return 2;
  }
  console.log("RESULT=DISPATCH_FINISHED_AND_RELEASED");
  return 0;
}

async function ensureMonitor(dir) {
  await mkdir(dir, { recursive: true });
  for (const name of modules) {
    const target = join(dir, name);
    const source = await readFile(join(sourceDir, name));
    try {
      if (!(await readFile(target)).equals(source)) throw new Error("MONITOR_CODE_VERSION_MISMATCH: " + name);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await copyFile(join(sourceDir, name), target);
    }
  }
  try { await readFile(join(dir, "supervision.config.json")); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    await copyFile(join(sourceDir, "supervision.config.json"), join(dir, "supervision.config.json"));
  }
}

// Official Windows CLI contract is nodejs -e with an imported UTF-8 script.
// The file is unique for each invocation and removed after its process exits.
async function runEgo(source, dir, name) {
  const outputPath = join(dir, name + "." + randomUUID() + ".mjs");
  await writeFile(outputPath, source, "utf8");
  try {
    const expression = "await import(" + JSON.stringify(pathToFileURL(outputPath).href) + ")";
    const child = spawn("ego-browser", ["nodejs", "-e", expression], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
    let result = null;
    let tail = "";
    child.stdout.on("data", (chunk) => {
      const output = chunk.toString("utf8");
      process.stdout.write(output);
      tail = (tail + output).slice(-65536);
    });
    const code = await new Promise((res, rej) => {
      child.once("error", rej);
      child.once("exit", (exitCode) => res(exitCode ?? 2));
    });
    for (const match of tail.matchAll(/^RESULT=([A-Z0-9_]+)(?:\s|$)/gm)) result = match[1];
    return { code, result };
  } finally {
    await unlink(outputPath).catch(() => {});
  }
}

export async function main(args = process.argv.slice(2)) {
  const p = parseArgs(args);
  // Old shared-state directories may still be active. Never silently move or
  // overwrite their ledgers when opting into per-page isolation.
  for (const name of ["a-fast-state.json", "a-dispatch-state.json", "a-watch-uuid.txt", "a-supervision-status.json"]) {
    try { await readFile(join(p.monitorDir, name)); throw new Error("LEGACY_SHARED_STATE_REQUIRES_ISOLATION"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const dir = conversationDir(p);
  p.rootMonitorDir = p.monitorDir;
  if (p.newChat) {
    p.payloadHash = sha256(await readFile(resolve(p.message), "utf8"));
    // This receipt survives a crash after the directory was moved.
    // A second invocation of the same request must not call the browser.
    try {
      const conversation = await bindNewConversation(p.monitorDir, p.requestId, p.space, p.agentId, p.payloadHash);
      console.log("RESULT=NEW_CHAT_BOUND conversation=" + conversation);
      return 0;
    } catch (error) {
      if (error.message !== "NEW_CHAT_RECONCILIATION_REQUIRED") throw error;
    }
    await mkdir(dir, { recursive: true });
    const requestFile = join(dir, "a-new-request.json");
    let handle;
    try {
      handle = await open(requestFile, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ requestId: p.requestId.toLowerCase(), space: p.space, agentId: p.agentId, payloadSha256: p.payloadHash }));
    } catch (error) {
      if (error.code === "EEXIST") throw new Error("NEW_CHAT_IN_PROGRESS_OR_RECOVERY_REQUIRED");
      throw error;
    } finally {
      await handle?.close();
    }
  }
  if (p.action === "ack") { await acknowledge(p.wakeId, p.ackAction, dir); return 0; }
  if (p.action === "consume") {
    const record = await readDispatchState(dir);
    if (!record || record.conversationUuid.toLowerCase() !== p.conversation.toLowerCase() || record.taskSpace !== p.space) {
      throw new Error("REPLY_CONSUMPTION_DISPATCH_MISMATCH");
    }
    await acknowledgeReply(dir, record, p.replySha256);
    console.log("RESULT=REPLY_CONSUMED");
    return 0;
  }
  // Check before ensureMonitor or any browser invocation. An idle watch must
  // leave both the registry and the user's open tabs untouched.
  const armed = ["watch", "probe"].includes(p.action)
    ? await requireArmedDispatch(dir, p, p.action) : null;
  await ensureMonitor(dir);
  p.monitorDir = dir;
  if (p.recoverOnly && p.archivedRecord) {
    const originalPayload = await readFile(resolve(p.message), "utf8");
    const archived = JSON.parse(await readFile(resolve(p.archivedRecord), "utf8"));
    if (!validateDispatchRecord(archived) || archived.status !== "PREPARED" ||
        archived.conversationUuid.toLowerCase() !== p.conversation.toLowerCase() ||
        archived.taskSpace !== p.space || archived.payload_sha256 !== sha256(originalPayload)) {
      throw new Error("ARCHIVED_PREPARED_IDENTITY_MISMATCH");
    }
    // Exclusive creation prevents replacing another dispatch's ledger.
    const handle = await open(join(dir, "a-dispatch-state.json"), "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(archived)); }
    finally { await handle.close(); }
    await readDispatchState(dir);
  }
  if (p.action === "collect") return collectCompleted(p, dir);
  if (p.action === "release") {
    const record = await readDispatchState(dir);
    if (!record || record.status !== "COMPLETED" || record.conversationUuid.toLowerCase() !== p.conversation.toLowerCase() || record.taskSpace !== p.space) {
      throw new Error("RELEASE_REQUIRES_VERIFIED_COMPLETION");
    }
    await verifiedConsumption(dir, record);
  }
  if (p.action === "watch") {
    await writeFile(join(dir, "a-watch-uuid.txt"), p.conversation + "\n", "utf8");
    // Restart after delivery must finish the page release, even though the
    // probe deliberately suppresses DONE_CANDIDATE for completed dispatches.
    if (armed.status === "COMPLETED") {
      try { await verifiedConsumption(dir, armed); }
      catch (error) {
        if (error.message !== "REPLY_NOT_CONSUMED") throw error;
        console.log("RESULT=REPLY_STAGED_WAKE_SUPERVISOR action=consume");
        return 2;
      }
      return releaseDelivered(p, dir);
    }
    // One managed job owns BOTH the fast probe and the slow supervisor. No idle
    // model calls; only the terminal return code wakes a compatible host.
    let benignStreak = 0;
    while (true) {
      const template = await readFile(templates.probe, "utf8");
      const observation = await runEgo(adaptTemplate(template, p), dir, "probe");
      if (observation.code === 0 && observation.result === "DONE_CANDIDATE") {
        // A completed turn needs the owning Agent to inspect and consume the
        // reply before page release. A process exit is only a wake request.
        console.log("RESULT=REPLY_READY_WAKE_SUPERVISOR action=collect");
        return 2;
      }
      const verdict = classifyProbeResult(observation, benignStreak);
      benignStreak = verdict.streak;
      if (verdict.wake) {
        console.log("RESULT=FAST_PROBE_WAKE_SUPERVISOR signal=" + (observation.result || "MISSING") + " exit=" + observation.code);
        return 2;
      }
      if (await tick(Date.now(), dir)) return 2;
      await new Promise((res) => setTimeout(res, 60_000));
    }
  }
  const file = p.newChat || p.recoverOnly ? templates.send : templates[p.action];
  const template = await readFile(file, "utf8");
  if (["send", "send-new", "recover-draft"].includes(p.action)) {
    p.message = resolve(p.message);
    p.attachments = await loadAttachments(p.attachmentsFile);
  }
  if (p.action === "probe") await writeFile(join(dir, "a-watch-uuid.txt"), p.conversation + "\n", "utf8");
  const observation = await runEgo(adaptTemplate(template, p), dir, p.action);
  if (p.recoverOnly) {
    const recovered = await readDispatchState(dir);
    return observation.code === 0 && observation.result === "OWNED_DRAFT_CLEARED" &&
      recovered?.status === "ABORTED" && recovered.payload_sha256 === sha256(await readFile(p.message, "utf8")) ? 0 : 2;
  }
  if (p.newChat) {
    // Bind only after the standard template has persisted acceptance and a
    // browser-derived conversation UUID. Failures retain the pending ledger.
    const conversation = await bindNewConversation(p.rootMonitorDir, p.requestId, p.space, p.agentId, p.payloadHash);
    if (observation.code !== 0 || observation.result !== "AUTO_ACCEPTED_DISPATCH_ACCEPTED") {
      console.error("RESULT=NEW_CHAT_RECONCILE_REQUIRED conversation=" + conversation);
      return 2;
    }
    console.log("RESULT=NEW_CHAT_BOUND conversation=" + conversation);
    return 0;
  }
  if (p.action === "probe") return classifyProbeResult(observation).wake ? 2 : 0;
  const record = p.action === "send" ? await readDispatchState(dir) : null;
  const code = classifyManagerResult(p.action, observation, record, p);
  if (p.action === "send" && code !== 0) {
    console.error("RESULT=MANAGER_SEND_REQUIRES_RECONCILIATION status=" + (record?.status || "ABSENT"));
  }
  return code;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (error) { console.error("RESULT=MANAGER_FAILURE code=" + (error.code || error.message)); process.exitCode = 2; }
}
