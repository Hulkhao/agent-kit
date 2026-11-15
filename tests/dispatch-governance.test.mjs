import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, rm, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { normalizeFastState } from "../monitor/state-schema.mjs";
import { tick, acknowledge } from "../monitor/supervision-watchdog.mjs";
import { shouldReviewStartupIdle } from "../monitor/supervision-policy.mjs";
import { parseArgs, adaptTemplate, bindNewConversation, classifyManagerResult, loadAttachments, requireArmedDispatch, main, readEgoOutcome, ensureMonitor, authorizeSpaceRebuild, rebuildSpace, claimSpace, taskspaceOwnershipLost, announceTaskspaceOwnershipLoss, exitWatching, acknowledgeWake, releaseDelivered, managedAcknowledge, ackOwnershipEvidence, ACK_RESOLVED_OWNERSHIP_REQUIRED, ACK_AUDIT_FILE } from "../monitor/dispatch-manager.mjs";
import { withAgentRegistry, isValidNewTaskSpaceName, assertTaskSpaceNamingAllowed } from "../monitor/agent-space.mjs";
import { taskspaceOperatorAction } from "../monitor/taskspace-takeover.mjs";
import { checkDispatchTool } from "../plugins/chatgpt-dispatch-guard/hooks/policy.mjs";
import { installConfig, install } from "../monitor/install-zcode-guard.mjs";
import { extractDomReply, extractApiReply, apiTailFinality, saveReply, verifiedReply, acknowledgeReply, verifiedConsumption, sha256, visibleTextHash } from "../monitor/reply-delivery.mjs";
import { dispatchStormGate, markCompleted, markDoneCandidate, readDispatchState, validateDispatchRecord, verifyAttachmentEvidence } from "../monitor/dispatch-state.mjs";

const uuid = "11111111-1111-4111-8111-111111111111";

test("managed watch probes every 30 seconds from the previous probe start", async () => {
  const source = await readFile(new URL("../monitor/dispatch-manager.mjs", import.meta.url), "utf8");
  const watch = source.slice(source.indexOf('if (p.action === "watch")'), source.indexOf('if (p.action === "probe") await writeFile'));
  assert.match(watch, /const pollIntervalMs = 30_000;/);
  assert.match(watch, /const pollStartedAt = Date\.now\(\);/);
  assert.match(watch, /setTimeout\(res, Math\.max\(0, pollIntervalMs - \(Date\.now\(\) - pollStartedAt\)\)\)/);
  assert.doesNotMatch(watch, /setTimeout\(res, 60_000\)|sleep 300/);
});

test("#31: ego result parsing waits for stdout to drain after process exit", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  const reading = readEgoOutcome(child, () => {});
  child.emit("exit", 0);
  child.stdout.emit("data", Buffer.from("RESULT=GEN"));
  child.stdout.emit("data", Buffer.from("ERATING\n"));
  child.emit("close", 0);
  assert.deepEqual(await reading, { code: 0, result: "GENERATING", detail: null });
});

test("#31: managed module copies refresh without replacing runtime state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ego-module-refresh-"));
  try {
    await writeFile(join(dir, "agent-space.mjs"), "// stale copy\n");
    await writeFile(join(dir, "a-fast-state.json"), "runtime-evidence");
    await ensureMonitor(dir);
    assert.equal(await readFile(join(dir, "agent-space.mjs"), "utf8"),
      await readFile(new URL("../monitor/agent-space.mjs", import.meta.url), "utf8"));
    assert.equal(await readFile(join(dir, "a-fast-state.json"), "utf8"), "runtime-evidence");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("#31: an old consumed reply is archived and cannot block next collection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ego-reply-next-"));
  const previous = { dispatchId: uuid, conversationUuid: uuid, status: "COMPLETED" };
  const next = { dispatchId: "22222222-2222-4222-8222-222222222222", conversationUuid: uuid, status: "ACCEPTED" };
  try {
    const oldReceipt = await saveReply(dir, previous, { text: "旧回复", source: "API_FINAL_VERIFIED" }, uuid);
    await acknowledgeReply(dir, previous, oldReceipt.sha256);
    await assert.rejects(verifiedReply(dir, next), /REPLY_DELIVERY_REQUIRED/);
    const archived = JSON.parse(await readFile(join(dir, ".archive", `reply-consumed-${uuid}.json`), "utf8"));
    assert.equal(archived.receipt.sha256, oldReceipt.sha256);
    assert.equal(archived.consumed.sha256, oldReceipt.sha256);
    const newReceipt = await saveReply(dir, next, { text: "新回复", source: "API_FINAL_VERIFIED" }, uuid);
    assert.equal((await verifiedReply(dir, next)).sha256, newReceipt.sha256);
    assert.equal(await readFile(join(dir, `reply-${uuid}.txt`), "utf8"), "旧回复");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("#31: an unconsumed or tampered old receipt cannot be archived or replaced", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ego-reply-unconsumed-"));
  const old = { dispatchId: uuid, conversationUuid: uuid, status: "COMPLETED" };
  const next = { dispatchId: "22222222-2222-4222-8222-222222222222", conversationUuid: uuid, status: "ACCEPTED" };
  try {
    const receipt = await saveReply(dir, old, { text: "原始交付", source: "API_FINAL_VERIFIED" }, uuid);
    await assert.rejects(verifiedReply(dir, next), /REPLY_RECEIPT_MISMATCH/);
    await assert.rejects(saveReply(dir, next, { text: "新回复", source: "API_FINAL_VERIFIED" }, uuid), /REPLY_RECEIPT_MISMATCH/);
    assert.equal((await verifiedReply(dir, old)).sha256, receipt.sha256);
    await acknowledgeReply(dir, old, receipt.sha256);
    await writeFile(join(dir, receipt.file), "遭篡改");
    await assert.rejects(verifiedReply(dir, next), /REPLY_RECEIPT_MISMATCH/);
    assert.equal(JSON.parse(await readFile(join(dir, "a-reply-delivery.json"), "utf8")).dispatchId, uuid);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("#24: dispatch waits for probe-confirmed recovery after storm deadline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ego-storm-gate-"));
  const start = 1_800_000_000_000;
  const stateFile = join(dir, "a-fast-state.json");
  try {
    const unavailable = normalizeFastState({}, {
      errorCode: "CHAT_SURFACE_STRUCTURALLY_UNAVAILABLE",
      backoffUntil: start + 9 * 60_000,
    }, start);
    await writeFile(stateFile, JSON.stringify(unavailable));
    assert.equal(await dispatchStormGate(dir, start + 60_000), "STORM_BACKOFF_PENDING");
    assert.equal(await dispatchStormGate(dir, start + 10 * 60_000), "STORM_BACKOFF_PENDING");

    const recovered = normalizeFastState(unavailable, {
      errorCode: null,
      backoffUntil: null,
    }, start + 11 * 60_000);
    await writeFile(stateFile, JSON.stringify(recovered));
    assert.equal(await dispatchStormGate(dir, start + 11 * 60_000), null);
    await writeFile(stateFile, "{}");
    await assert.rejects(dispatchStormGate(dir, start + 12 * 60_000), /FAST_STATE_INVALID/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("startup with a dispatch-time reply tail enters the full completion confirmation", () => {
  assert.equal(shouldReviewStartupIdle(true, true), false);
  assert.equal(shouldReviewStartupIdle(true, false), true);
  assert.equal(shouldReviewStartupIdle(false, false), false);
});

test("reply collection includes multiple assistant units and respects current user boundary", () => {
  const payload = sha256("本次派单");
  const tail = "22222222-2222-4222-8222-222222222222";
  const units = [
    { role: "user", text: "旧任务" },
    { role: "assistant", text: "旧回复" },
    { role: "user", text: "本次派单" },
    { role: "assistant", text: "工具分析过程", messageKey: uuid },
    { role: "assistant", text: "最终内容", messageKey: tail },
  ];
  assert.deepEqual(extractDomReply(units, payload, tail), { text: "工具分析过程\n\n最终内容", source: "DOM_BOUNDARY_VISIBLE" });
  assert.equal(extractDomReply(units.slice(0, 2), payload, tail), null);
  assert.equal(extractDomReply([...units, { role: "user", text: "下一轮" }], payload, tail), null);
  assert.equal(extractDomReply(units, payload, uuid), null);
});

test("DOM extraction uses the current dispatch boundary when its rendered blank lines differ", () => {
  const tail = "33333333-3333-4333-8333-333333333333";
  const before = "44444444-4444-4444-8444-444444444444";
  const original = "第一段\n\n第二段";
  const units = [
    { role: "user", text: "上一轮任务" },
    { role: "assistant", text: "上一轮回复", messageKey: before },
    { role: "user", text: "第一段\n第二段" },
    { role: "assistant", text: "完整答复", messageKey: tail },
  ];
  const options = { displayHash: visibleTextHash(original), baselineTailKey: before };
  assert.deepEqual(extractDomReply(units, sha256(original), tail, options),
    { text: "完整答复", source: "DOM_BOUNDARY_VISIBLE" });
  assert.equal(extractDomReply(units, sha256(original), tail), null);
  assert.equal(extractDomReply(units, sha256(original), tail, { ...options, baselineTailKey: tail }), null);
  assert.equal(extractDomReply([...units.slice(0, 2), { role: "user", text: "其他任务" }, ...units.slice(2)],
    sha256(original), tail, options), null);
  assert.equal(extractDomReply([...units, { role: "user", text: "后续提问" }], sha256(original), tail, options), null);
});

test("API extraction follows active conversation branch and requires finished final turn", () => {
  const payload = sha256("任务原文");
  const message = (role, text, final = false) => ({ author: { role }, content: { parts: [text] },
    end_turn: final, status: final ? "finished_successfully" : "in_progress" });
  const branch = { current_node: "final", mapping: {
    root: { parent: null },
    user: { parent: "root", message: message("user", "任务原文") },
    step: { parent: "user", message: message("assistant", "计算步骤") },
    final: { parent: "step", message: message("assistant", "回答", true) },
    other: { parent: "user", message: message("user", "另一个分支") },
  } };
  assert.deepEqual(extractApiReply(branch, payload), { text: "计算步骤\n\n回答", source: "API_FINAL_VERIFIED" });
  assert.equal(extractApiReply({ ...branch, current_node: "other" }, payload), null);
  assert.equal(extractApiReply({ ...branch, mapping: { ...branch.mapping, final: { ...branch.mapping.final,
    message: message("assistant", "未完成") } } }, payload), null);
  assert.equal(extractApiReply({ ...branch, mapping: { ...branch.mapping, final: { ...branch.mapping.final, parent: "final" } } }, payload), null);
});

test("completion requires intact per-dispatch reply receipt and prevents forged completion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ego-reply-delivery-"));
  const record = { schema: "ego-dispatch-state/v2", dispatchId: uuid, conversationUuid: uuid,
    taskSpace: "GDC-执行A", pageLabel: "p1", status: "ACCEPTED", baselineTailKey: null,
    baselineTailRole: null, baselineComposerLength: 0, attempt: 1, createdAt: Date.now(), payload_sha256: sha256("本次派单") };
  try {
    await writeFile(join(dir, "a-dispatch-state.json"), JSON.stringify(record));
    await assert.rejects(markCompleted(dir, uuid), /REPLY_DELIVERY_REQUIRED/);
    await saveReply(dir, record, { text: "结果完整", source: "DOM_BOUNDARY_VISIBLE" }, uuid);
    assert.equal((await verifiedReply(dir, record)).bytes, Buffer.byteLength("结果完整"));
    await writeFile(join(dir, `reply-${uuid}.txt`), "被篡改");
    await assert.rejects(markCompleted(dir, uuid), /REPLY_CONTENT_MISMATCH/);
    await saveReply(dir, record, { text: "结果完整", source: "DOM_BOUNDARY_VISIBLE" }, uuid);
    assert.equal((await markCompleted(dir, uuid)).status, "COMPLETED");
    assert.equal((await readDispatchState(dir)).replyBytes, Buffer.byteLength("结果完整"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("reply staging cannot release a page before owning Agent confirms the reply bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ego-reply-consumed-"));
  const record = { dispatchId: uuid, conversationUuid: uuid, taskSpace: "GDC-执行A", status: "COMPLETED" };
  try {
    const receipt = await saveReply(dir, record, { text: "已处理结果", source: "DOM_BOUNDARY_VISIBLE" }, uuid);
    await assert.rejects(verifiedConsumption(dir, record), /REPLY_NOT_CONSUMED/);
    await assert.rejects(acknowledgeReply(dir, record, sha256("其他内容")), /REPLY_CONSUMPTION_EVIDENCE_INVALID/);
    await acknowledgeReply(dir, record, receipt.sha256);
    assert.equal((await verifiedConsumption(dir, record)).sha256, receipt.sha256);
    await assert.rejects(verifiedConsumption(dir, { ...record, dispatchId: "22222222-2222-4222-8222-222222222222" }), /REPLY_RECEIPT_MISMATCH/);
    await writeFile(join(dir, `reply-${uuid}.txt`), "内容被改动");
    await assert.rejects(verifiedConsumption(dir, record), /REPLY_CONTENT_MISMATCH/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("manager validates identity and adapts the frozen code without evaluating payload", () => {
  const args = ["send", "--monitor-dir", ".monitor/job1", "--agent-id", "gdc-a", "--space", "GDC-执行A", "--conversation", uuid, "--message", "payload.md"];
  const parsed = parseArgs(args);
  assert.equal(parsed.space, "GDC-执行A");
  assert.equal(parsed.action, "send");
  assert.throws(() => parseArgs(args.slice(0, -1)), /MANAGER_ARG_MISSING_VALUE/);
  assert.throws(() => parseArgs([...args, "--space", "other"]), /MANAGER_ARG_INVALID/);
  assert.throws(() => parseArgs(args.map((v) => v === uuid ? "invalid" : v)), /MANAGER_IDENTITY_INVALID/);
  assert.throws(() => parseArgs(["consume", ...args.slice(1, -2)]), /REPLY_SHA256_REQUIRED/);
  assert.equal(parseArgs(["consume", ...args.slice(1, -2), "--reply-sha256", "a".repeat(64)]).action, "consume");
  assert.equal(adaptTemplate('const SPACE = "REPLACE_WITH_UNIQUE_TASKSPACE";', parsed), 'const SPACE = "GDC-执行A";');
  assert.throws(() => adaptTemplate('"REPLACE_WITH_UNIQUE_TASKSPACE" "REPLACE_WITH_UNSUPPORTED"', parsed), /ADAPTER_UNRESOLVED/);
  assert.equal(adaptTemplate('const ATTACHMENTS = "REPLACE_WITH_ATTACHMENTS_JSON";', { ...parsed, attachments: ["C:\\图像\\庭院.jpg"] }),
    'const ATTACHMENTS = ["C:\\\\图像\\\\庭院.jpg"];');
  assert.throws(() => parseArgs(["probe", "--monitor-dir", ".monitor/job1", "--agent-id", "gdc-a", "--space", "GDC-执行A", "--conversation", uuid, "--attachments-file", "images.json"]), /ATTACHMENTS_SEND_ONLY/);
});

test("attachment manifest accepts existing absolute files and rejects missing paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ego-attachments-"));
  const file = join(dir, "photo.png");
  const manifest = join(dir, "files.json");
  try {
    await writeFile(file, "example");
    await writeFile(manifest, JSON.stringify([file]));
    assert.deepEqual(await loadAttachments(manifest), [file]);
    await writeFile(manifest, JSON.stringify(["relative.png"]));
    await assert.rejects(loadAttachments(manifest), /ATTACHMENTS_MANIFEST_INVALID/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("image thumbnails must increase on the composer form and file chips need filenames", () => {
  const before = [{ text: "", images: 3 }, { text: "", images: 1 }];
  const after = [{ text: "image.jpg file.pdf", images: 5, sendEnabled: true },
    { text: "file.pdf", images: 2, sendEnabled: true }];
  assert.equal(verifyAttachmentEvidence(before, after, ["image.jpg", "file.pdf"]), true);
  assert.equal(verifyAttachmentEvidence(before, [{ text: "file.pdf", images: 3, sendEnabled: true }], ["image.jpg", "file.pdf"]), false);
  assert.equal(verifyAttachmentEvidence(before, [{ text: "file.pdf", images: 4, sendEnabled: false }], ["image.jpg", "file.pdf"]), false);
  assert.equal(verifyAttachmentEvidence(before, [{ text: "file.pdf", images: 4, sendEnabled: true }], ["image.jpg", "file.pdf"]), true);
  assert.equal(verifyAttachmentEvidence(before, [{ text: "", images: 4, sendEnabled: true }], ["image.jpg", "file.pdf"]), false);
});

test("manager requires both browser success and matching accepted ledger", () => {
  const params = { conversation: uuid, space: "GDC-执行A" };
  const accepted = { conversationUuid: uuid, taskSpace: params.space, status: "ACCEPTED" };
  const outcome = { code: 0, result: "AUTO_ACCEPTED_DISPATCH_ACCEPTED" };
  assert.equal(classifyManagerResult("send", outcome, accepted, params), 0);
  assert.equal(classifyManagerResult("send", { code: 0, result: "STOP" }, accepted, params), 2);
  assert.equal(classifyManagerResult("send", outcome, { ...accepted, status: "UNCERTAIN" }, params), 2);
  assert.equal(classifyManagerResult("send", outcome, { ...accepted, conversationUuid: "22222222-2222-4222-8222-222222222222" }, params), 2);
  assert.equal(classifyManagerResult("send", outcome, null, params), 2);
  assert.equal(classifyManagerResult("send", { code: 1, result: "DISPATCH_ACCEPTED_WAKE_SUPERVISOR" }, accepted, params), 2);
  assert.equal(classifyManagerResult("release", { code: 0, result: "STOP" }, null, params), 2);
  assert.equal(classifyManagerResult("release", { code: 0, result: "AGENT_SPACE_RELEASED" }, null, params), 0);
});

test("#30: managed recovery needs original payload and a matching archived PREPARED identity", async () => {
  const base = ["--monitor-dir", ".monitor", "--agent-id", "gdc-a", "--space", "GDC-执行A", "--conversation", uuid];
  assert.throws(() => parseArgs(["recover-draft", ...base]), /MESSAGE_REQUIRED/);
  assert.throws(() => parseArgs(["send", ...base, "--message", "v2.txt", "--archived-record", "old.json"]), /ARCHIVED_RECORD_RECOVERY_ONLY/);
  assert.throws(() => parseArgs(["recover-draft", ...base, "--message", "v1.txt", "--attachments-file", "files.json"]), /ATTACHMENTS_SEND_ONLY/);
  const p = parseArgs(["recover-draft", ...base, "--message", "v1.txt", "--archived-record", "old.json"]);
  assert.equal(p.recoverOnly, true);
  assert.equal(adaptTemplate('const RECOVER_ONLY = "REPLACE_WITH_RECOVER_ONLY";', p), "const RECOVER_ONLY = true;");
});

test("#30: malformed archived PREPARED cannot replace a live dispatch ledger", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-archived-guard-"));
  const messageFile = join(root, "original.txt");
  const archiveFile = join(root, "archived.json");
  const payload = "发送 http://example.com/\n第二行";
  const args = ["recover-draft", "--monitor-dir", root, "--agent-id", "gdc-a",
    "--space", "GDC-执行A", "--conversation", uuid, "--message", messageFile,
    "--archived-record", archiveFile];
  const dir = join(root, "conversations", uuid);
  const liveRecord = join(dir, "a-dispatch-state.json");
  const valid = { schema: "ego-dispatch-state/v2", status: "PREPARED", dispatchId: uuid,
    conversationUuid: uuid, taskSpace: "GDC-执行A", pageLabel: "p1",
    baselineTailKey: null, baselineTailRole: null, baselineComposerLength: 0,
    attempt: 1, createdAt: Date.now(), payload_sha256: sha256(payload) };
  try {
    await writeFile(messageFile, payload);
    await writeFile(archiveFile, JSON.stringify({ ...valid, pageLabel: null }));
    await assert.rejects(main(args), /ARCHIVED_PREPARED_IDENTITY_MISMATCH/);
    await assert.rejects(readFile(liveRecord), { code: "ENOENT" });
    await writeFile(archiveFile, JSON.stringify(valid));
    await mkdir(dir, { recursive: true });
    await writeFile(liveRecord, JSON.stringify({ ...valid, status: "ACCEPTED" }));
    await assert.rejects(main(args), { code: "EEXIST" });
    assert.equal((await readDispatchState(dir)).status, "ACCEPTED");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("new chat binding verifies request identity before committing mapping and survives a replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-new-chat-"));
  const requestId = uuid;
  const conversationId = "22222222-2222-4222-8222-222222222222";
  const space = "GDC-执行A";
  const agentId = "gdc-a";
  const message = "首次派单内容";
  const digest = sha256(message);
  const pending = join(root, "pending-new", requestId);
  const mappingFile = join(root, "new-requests", requestId + ".json");
  const record = { schema: "ego-dispatch-state/v2", dispatchId: requestId,
    conversationUuid: requestId, taskSpace: space, pageLabel: "p1", status: "ACCEPTED",
    baselineTailKey: null, baselineTailRole: null, baselineComposerLength: 0,
    attempt: 1, createdAt: Date.now(), payload_sha256: digest };
  const command = (path) => ["send-new", "--monitor-dir", root, "--agent-id", agentId,
    "--space", space, "--request-id", requestId, "--message", path];
  try {
    await mkdir(pending, { recursive: true });
    await writeFile(join(pending, "a-new-request.json"), JSON.stringify({ requestId, space, agentId, payloadSha256: digest }));
    await writeFile(join(pending, "a-new-conversation.json"), JSON.stringify({ requestId, conversationUuid: conversationId }));
    await writeFile(join(pending, "a-dispatch-state.json"), JSON.stringify(record));
    await assert.rejects(bindNewConversation(root, requestId, space, "other-agent", digest), /NEW_CHAT_REQUEST_CONFLICT/);
    await assert.rejects(bindNewConversation(root, requestId, space, agentId, sha256("替换消息")), /NEW_CHAT_REQUEST_CONFLICT/);
    await assert.rejects(readFile(mappingFile), { code: "ENOENT" });
    assert.equal(await bindNewConversation(root, requestId, space, agentId, digest), conversationId);
    assert.equal(await bindNewConversation(root, requestId, space, agentId, digest), conversationId);
    assert.equal((await readDispatchState(join(root, "conversations", conversationId))).conversationUuid, conversationId);

    const messageFile = join(root, "message.txt");
    await writeFile(messageFile, message);
    assert.equal(await main(command(messageFile)), 0);
    await writeFile(messageFile, "替换消息");
    await assert.rejects(main(command(messageFile)), /NEW_CHAT_BOUND_RECORD_INVALID/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("new chat binding refuses a target conversation already owned by another dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-new-chat-conflict-"));
  const conversationId = "22222222-2222-4222-8222-222222222222";
  const pending = join(root, "pending-new", uuid);
  const target = join(root, "conversations", conversationId);
  const digest = sha256("待派单");
  try {
    await mkdir(pending, { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(pending, "a-new-request.json"), JSON.stringify({ requestId: uuid, space: "GDC-执行A", agentId: "gdc-a", payloadSha256: digest }));
    await writeFile(join(pending, "a-new-conversation.json"), JSON.stringify({ requestId: uuid, conversationUuid: conversationId }));
    await writeFile(join(pending, "a-dispatch-state.json"), JSON.stringify({ schema: "ego-dispatch-state/v2",
      dispatchId: uuid, conversationUuid: uuid, taskSpace: "GDC-执行A", pageLabel: "p1", status: "ACCEPTED",
      baselineTailKey: null, baselineTailRole: null, baselineComposerLength: 0,
      attempt: 1, createdAt: Date.now(), payload_sha256: digest }));
    const other = { schema: "ego-dispatch-state/v2", dispatchId: conversationId,
      conversationUuid: conversationId, taskSpace: "OTHER", pageLabel: "p2", status: "ACCEPTED",
      baselineTailKey: null, baselineTailRole: null, baselineComposerLength: 0,
      attempt: 1, createdAt: Date.now(), payload_sha256: sha256("其他任务") };
    await writeFile(join(target, "a-dispatch-state.json"), JSON.stringify(other));
    await assert.rejects(bindNewConversation(root, uuid, "GDC-执行A", "gdc-a", digest), /NEW_CHAT_TARGET_OCCUPIED/);
    await assert.rejects(readFile(join(root, "new-requests", uuid + ".json")), { code: "ENOENT" });
    assert.equal((await readDispatchState(target)).taskSpace, "OTHER");
    assert.equal((await readDispatchState(pending)).conversationUuid, uuid);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("watch and probe require a matching accepted ledger before touching browser or state files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ego-dispatch-arm-"));
  const params = { monitorDir: dir, agentId: "gdc-a", space: "GDC-执行A", conversation: uuid };
  const command = (action) => [action, "--monitor-dir", dir, "--agent-id", params.agentId,
    "--space", params.space, "--conversation", uuid];
  const convDir = join(dir, "conversations", uuid);
  try {
    await assert.rejects(main(command("watch")), /DISPATCH_NOT_ARMED/);
    await assert.rejects(main(command("probe")), /DISPATCH_NOT_ARMED/);
    await assert.rejects(readFile(join(convDir, "a-watch-uuid.txt")), { code: "ENOENT" });
    const record = { schema: "ego-dispatch-state/v2", dispatchId: uuid,
      conversationUuid: uuid, taskSpace: params.space, pageLabel: "p1", status: "ACCEPTED",
      baselineTailKey: null, baselineTailRole: null, baselineComposerLength: 0,
      attempt: 1, createdAt: Date.now(), payload_sha256: sha256("任务") };
    await import("node:fs/promises").then(({ mkdir }) => mkdir(convDir, { recursive: true }));
    await writeFile(join(convDir, "a-dispatch-state.json"), JSON.stringify(record));
    assert.equal((await requireArmedDispatch(convDir, params, "watch")).status, "ACCEPTED");
    assert.equal((await requireArmedDispatch(convDir, params, "probe")).status, "ACCEPTED");
    await writeFile(join(convDir, "a-dispatch-state.json"), JSON.stringify({ ...record, status: "COMPLETED" }));
    assert.equal((await requireArmedDispatch(convDir, params, "watch")).status, "COMPLETED");
    await assert.rejects(requireArmedDispatch(convDir, params, "probe"), /DISPATCH_NOT_ARMED/);
    await assert.rejects(requireArmedDispatch(convDir, { ...params, space: "other" }, "watch"), /DISPATCH_NOT_ARMED/);
    for (const status of ["SEND_STARTED", "UNCERTAIN"]) {
      await writeFile(join(convDir, "a-dispatch-state.json"), JSON.stringify({ ...record, status }));
      assert.equal((await requireArmedDispatch(convDir, params, "watch")).status, status);
      assert.equal((await requireArmedDispatch(convDir, params, "probe")).status, status);
    }
    for (const status of ["PREPARED", "RETRY_AUTHORIZED"]) {
      await writeFile(join(convDir, "a-dispatch-state.json"), JSON.stringify({ ...record, status }));
      await assert.rejects(main(command("watch")), /DISPATCH_NOT_ARMED/);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("ZCode hook blocks direct browser dispatch but preserves unrelated tools", () => {
  const ev = (tool_name, tool_input) => ({ hook_event_name: "PreToolUse", tool_name, tool_input });
  const native = (toolName, toolInput) => ({ hookEventName: "PreToolUse", toolName, toolInput, toolCallId: "probe-1" });
  assert.equal(checkDispatchTool(native("Bash", { command: "curl -X POST https://chatgpt.com/backend-api/conversation" })).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(checkDispatchTool(native("Bash", { command: "ego-browser nodejs -e run" })).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(checkDispatchTool(native("Read", { file_path: "allow.txt" })), null);
  assert.equal(checkDispatchTool({ hookEventName: "PreToolUse", toolInput: { command: "curl -X POST https://chatgpt.com/backend-api/conversation" }, toolCallId: "probe-2" }).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(checkDispatchTool({ hookEventName: "PreToolUse", toolInput: { command: "ego-browser nodejs -e run" }, toolCallId: "probe-3" }).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(checkDispatchTool({ hookEventName: "PreToolUse", toolInput: { file_path: "allow.txt" }, toolCallId: "probe-4" }), null);
  assert.equal(checkDispatchTool(ev("Bash", { command: "ego-browser nodejs < rogue.mjs" })).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(checkDispatchTool(ev("mcp__ego_browser", { url: "https://chatgpt.com/c/123" })).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(checkDispatchTool(ev("Bash", { command: "node monitor/dispatch-manager.mjs send --monitor-dir .monitor" })), null);
  assert.equal(checkDispatchTool(ev("Bash", { command: "node C:\\tmp\\ego-browser-bypass-probe.mjs open https://chatgpt.com" })).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(checkDispatchTool({ hookEventName: "PreToolUse", toolInput: { command: "node C:\\tmp\\ego-browser-bypass-probe.mjs open https://chatgpt.com" }, toolCallId: "probe-5" }).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(checkDispatchTool(ev("Bash", { command: "node monitor/dispatch-manager.mjs --help" })), null);
  assert.equal(checkDispatchTool(ev("Bash", { command: "ego-browser skill" })), null);
  assert.equal(checkDispatchTool(ev("mcp__ego_browser", { url: "https://example.com" })), null);
  assert.equal(checkDispatchTool(ev("Read", { file_path: "README.md" })), null);
  assert.equal(checkDispatchTool(ev("Bash", { command: "curl -X POST https://chatgpt.com/backend-api/conversation" })).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(checkDispatchTool(ev("PowerShell", { command: "Invoke-RestMethod -Method Post -Uri https://chatgpt.com/backend-api/conversation" })).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(checkDispatchTool(ev("Bash", { command: "curl https://chatgpt.com/backend-api/conversation" })), null);
});

test("ZCode PreToolUse process entry handles native camelCase hook events", () => {
  const script = new URL("../plugins/chatgpt-dispatch-guard/hooks/pre-tool-use.mjs", import.meta.url);
  const check = (toolName, command) => {
    const event = { hookEventName: "PreToolUse", toolName, toolInput: { command }, toolCallId: "probe" };
    const result = spawnSync(process.execPath, [fileURLToPath(script)], {
      input: JSON.stringify(event), encoding: "utf8", windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput.permissionDecision : null;
  };
  assert.equal(check("Bash", "curl -X POST https://chatgpt.com/backend-api/conversation"), "deny");
  assert.equal(check("Bash", "ego-browser nodejs -e run"), "deny");
  assert.equal(check("Read", "allow.txt"), null);
});

test("user hook installer keeps existing hook rules, makes a backup and does not duplicate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ego-zcode-hooks-"));
  const configFile = join(dir, "config.json");
  const initial = { hooks: { enabled: true, events: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "process", command: "rtk", args: ["hook", "claude"] }] }] } }, plugins: { other: true } };
  try {
    await writeFile(configFile, JSON.stringify(initial));
    assert.equal(await install(configFile), true);
    assert.equal(await install(configFile), false);
    const result = JSON.parse(await readFile(configFile));
    assert.equal(result.hooks.events.PreToolUse.length, 2);
    assert.deepEqual(result.hooks.events.PreToolUse[0], initial.hooks.events.PreToolUse[0]);
    assert.deepEqual(result.plugins, initial.plugins);
    // Install writes the resolved node command (full path), not bare "node" —
    // portable-node hosts have no system node (field-observed 2026-11-16).
    assert.equal(result.hooks.events.PreToolUse[1].hooks[0].command, process.execPath);
    assert.equal(Object.hasOwn(result.hooks.events.PreToolUse[1], "matcher"), false);
    assert.deepEqual(JSON.parse(await readFile(configFile + ".pre-chatgpt-guard.bak")), initial);
    assert.equal(installConfig(result).changed, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("installer repairs older invalid matcher and disabled hooks without duplicate rules", () => {
  const old = { hooks: { enabled: false, events: { PreToolUse: [
    { matcher: "*", hooks: [{ type: "process", command: "node", args: ["C:/agent-kit/plugins/chatgpt-dispatch-guard/hooks/pre-tool-use.mjs"], timeoutMs: 5000, enabled: true }] },
  ] } } };
  const { config, changed } = installConfig(old, "C:/agent-kit/plugins/chatgpt-dispatch-guard/hooks/pre-tool-use.mjs");
  assert.equal(changed, true);
  assert.equal(config.hooks.enabled, true);
  assert.equal(config.hooks.events.PreToolUse.length, 1);
  assert.deepEqual(config.hooks.events.PreToolUse[0], { hooks: [
    { type: "process", command: process.execPath, args: ["C:/agent-kit/plugins/chatgpt-dispatch-guard/hooks/pre-tool-use.mjs"], timeoutMs: 5000 },
  ] });
  assert.equal(installConfig(config, "C:/agent-kit/plugins/chatgpt-dispatch-guard/hooks/pre-tool-use.mjs").changed, false);
});

test("supervisor re-arms after review, escalates at round 3, resets on progress", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ego-supervision-"));
  const start = 1_800_000_000_000;
  const writeState = (state) => writeFile(join(dir, "a-fast-state.json"), JSON.stringify(state));
  try {
    await writeFile(join(dir, "supervision.config.json"), JSON.stringify({ supervisionMinutes: 10, maxAbnormalRounds: 3 }));
    const state = normalizeFastState({}, { generationKey: "one", lastProgressAt: start, uiSchema: "CHATGPT_CHAT_KNOWN", dispatchStatus: "ACCEPTED" }, start);
    await writeState(normalizeFastState(state, {}, start + 10 * 60_000));
    assert.equal(await tick(start + 10 * 60_000, dir), true);
    let status = JSON.parse(await readFile(join(dir, "a-supervision-status.json")));
    assert.equal(status.abnormalRounds, 1);
    assert.equal(await tick(start + 10 * 60_000 + 1000, dir), true);
    status = JSON.parse(await readFile(join(dir, "a-supervision-status.json")));
    assert.equal(status.abnormalRounds, 1);
    await acknowledge(status.pending.id, "investigated", dir, start + 10 * 60_000);
    await writeState(normalizeFastState(state, {}, start + 19 * 60_000));
    assert.equal(await tick(start + 19 * 60_000, dir), false);
    await writeState(normalizeFastState(state, {}, start + 20 * 60_000));
    assert.equal(await tick(start + 20 * 60_000, dir), true);
    status = JSON.parse(await readFile(join(dir, "a-supervision-status.json")));
    assert.equal(status.abnormalRounds, 2);
    await acknowledge(status.pending.id, "investigated", dir, start + 20 * 60_000);
    await writeState(normalizeFastState(state, {}, start + 30 * 60_000));
    assert.equal(await tick(start + 30 * 60_000, dir), true);
    status = JSON.parse(await readFile(join(dir, "a-supervision-status.json")));
    assert.equal(status.abnormalRounds, 3);
    // A genuinely new tail or tool progress cancels a pending third alarm.
    await writeState(normalizeFastState(state, { lastProgressAt: start + 31 * 60_000 }, start + 31 * 60_000));
    assert.equal(await tick(start + 31 * 60_000, dir), false);
    status = JSON.parse(await readFile(join(dir, "a-supervision-status.json")));
    assert.equal(status.pending, null);
    assert.equal(status.abnormalRounds, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("#31: rebuild-space parses space-level identity and rejects dispatch-only args", () => {
  const base = ["--monitor-dir", ".monitor", "--agent-id", "gdc-a", "--space", "GDC-执行A"];
  const p = parseArgs(["rebuild-space", ...base]);
  assert.equal(p.action, "rebuild-space");
  assert.equal(p.monitorDir, resolve(".monitor"));
  assert.throws(() => parseArgs(["rebuild-space", ...base, "--conversation", uuid]), /MANAGER_IDENTITY_INVALID/);
  assert.throws(() => parseArgs(["rebuild-space", ...base, "--request-id", uuid]), /MANAGER_IDENTITY_INVALID/);
  assert.throws(() => parseArgs(["rebuild-space", ...base, "--message", "msg.txt"]), /MANAGER_IDENTITY_INVALID/);
  assert.throws(() => parseArgs(["rebuild-space", "--monitor-dir", ".monitor", "--space", "GDC-执行A"]), /MANAGER_IDENTITY_INVALID/);
  assert.throws(() => parseArgs(["rebuild-space", ...base, "--bogus", "x"]), /MANAGER_ARG_INVALID/);
});

test("#31: rebuild-space authorization requires ledger proof or an explicit allowlist", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-rebuild-auth-"));
  try {
    await assert.rejects(authorizeSpaceRebuild("gdc-a", "GDC-执行A", { directory: root }), /SPACE_REBUILD_NOT_AUTHORIZED/);
    await withAgentRegistry((registry) => {
      registry.agents["gdc-a"] = { spaceName: "GDC-执行A", active: [], known: [] };
      return { changed: true };
    }, root);
    assert.equal(await authorizeSpaceRebuild("gdc-a", "GDC-执行A", { directory: root }), "LEDGER_PROOF");
    await assert.rejects(authorizeSpaceRebuild("gdc-a", "其他空间", { directory: root }), /SPACE_REBUILD_AGENT_BOUND_TO_OTHER_SPACE/);
    await withAgentRegistry((registry) => {
      registry.agents["gdc-b"] = { spaceName: "B空间", active: [], known: [] };
      return { changed: true };
    }, root);
    await assert.rejects(authorizeSpaceRebuild("gdc-c", "B空间", { directory: root, profileConfig: { spaceRebuildAllowlist: ["B空间"] } }),
      /SPACE_OWNED_BY_ANOTHER_AGENT/);
    await withAgentRegistry((registry) => {
      registry.agents["gdc-a"].releasePending = { conversationUuid: uuid, finished: false };
      return { changed: true };
    }, root);
    await assert.rejects(authorizeSpaceRebuild("gdc-a", "GDC-执行A", { directory: root }), /AGENT_SPACE_RELEASE_PENDING/);
    assert.equal(await authorizeSpaceRebuild("gdc-c", "新空间", { directory: root, profileConfig: { spaceRebuildAllowlist: ["新空间"] } }), "ALLOWLIST");
    await assert.rejects(authorizeSpaceRebuild("gdc-c", "新空间", { directory: root, profileConfig: {} }), /SPACE_REBUILD_NOT_AUTHORIZED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#31: rebuild-space denies before any browser call and audits the denial", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-rebuild-deny-"));
  try {
    assert.equal(await main(["rebuild-space", "--monitor-dir", root, "--agent-id", "gdc-a", "--space", "GDC-执行A"]), 2);
    const audit = JSON.parse(await readFile(join(root, "a-space-rebuild-audit.ndjson"), "utf8"));
    assert.equal(audit.decision, "DENIED");
    assert.equal(audit.agentId, "gdc-a");
    assert.equal(audit.space, "GDC-执行A");
    assert.match(audit.code, /SPACE_REBUILD|AGENT_SPACE_RELEASE_PENDING/);
    // A space-level action must not create the per-conversation layout.
    await assert.rejects(stat(join(root, "conversations")), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#31: rebuild-space runs the adapted template and audits the browser outcome", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-rebuild-run-"));
  try {
    await withAgentRegistry((registry) => {
      registry.agents["gdc-a"] = { spaceName: "GDC-执行A", active: [], known: [] };
      return { changed: true };
    }, root);
    const p = parseArgs(["rebuild-space", "--monitor-dir", root, "--agent-id", "gdc-a", "--space", "GDC-执行A"]);
    const scripts = [];
    assert.equal(await rebuildSpace(p, {
      directory: root,
      runScript: async (script, dir) => {
        scripts.push({ script, dir });
        return { code: 0, result: "SPACE_REBUILT_ACCOUNT_VERIFIED" };
      },
    }), 0);
    assert.equal(scripts.length, 1);
    assert.equal(scripts[0].dir, root);
    assert.match(scripts[0].script, /const SPACE = "GDC-执行A";/);
    assert.doesNotMatch(scripts[0].script, /REPLACE_WITH_/);
    const audit = (await readFile(join(root, "a-space-rebuild-audit.ndjson"), "utf8")).trim().split("\n");
    assert.equal(JSON.parse(audit[0]).decision, "LEDGER_PROOF");
    assert.equal(JSON.parse(audit[0]).outcome, "REBUILT");
    assert.equal(await rebuildSpace(p, {
      directory: root,
      runScript: async () => ({ code: 1, result: "SPACE_REBUILD_ACCOUNT_UNPROVEN" }),
    }), 2);
    const lines = (await readFile(join(root, "a-space-rebuild-audit.ndjson"), "utf8")).trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[1]).outcome, "FAILED");
    assert.equal(JSON.parse(lines[1]).result, "SPACE_REBUILD_ACCOUNT_UNPROVEN");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#31: the rebuild template is standalone, pins creation, and closes its page", async () => {
  const source = await readFile(new URL("../monitor/rebuild-space.template.mjs", import.meta.url), "utf8");
  assert.match(source, /taskSpace\(SPACE, \{ profileId: pin\.defaultProfileId \}\)/);
  assert.match(source, /RESULT=SPACE_REBUILT_ACCOUNT_VERIFIED/);
  assert.match(source, /EGO_TASKSPACE_TAKEOVER_REQUIRED/);
  assert.match(source, /page\.close\(\)/);
  // Standalone: no monitor-module imports, so it runs before any conversation
  // directory (and its managed module copies) exists.
  assert.doesNotMatch(source, /dispatch-state\.mjs|agent-space\.mjs|MON\s*\+/);
  const p = parseArgs(["rebuild-space", "--monitor-dir", ".monitor", "--agent-id", "gdc-a", "--space", "GDC-执行A"]);
  const adapted = adaptTemplate(source, p);
  assert.match(adapted, /const SPACE = "GDC-执行A";/);
  assert.doesNotMatch(adapted, /REPLACE_WITH_/);
});

test("#31: probe and send point at rebuild-space only when the registry lost the space", async () => {
  const probe = await readFile(new URL("../monitor/ego-fast-probe.mjs", import.meta.url), "utf8");
  assert.match(probe, /spaceRegistryMissing/);
  assert.match(probe, /RECOVERY_HINT=SPACE_REGISTRY_LOST/);
  assert.match(probe, /spaceRegistryMissing && !isTaskSpaceTakeover\(error\)/);
  const send = await readFile(new URL("../skills/chatgpt-web-dispatch/templates/dispatch-round.template.mjs", import.meta.url), "utf8");
  assert.match(send, /RECOVERY_HINT=SPACE_REGISTRY_LOST/);
  assert.match(send, /spaceRegistryMissing && !spaceReady && !isTaskSpaceTakeover\(error\)/);
});

test("#31: the guard keeps the managed rebuild-space entry point allowed", () => {
  const native = (toolName, toolInput) => ({ hookEventName: "PreToolUse", toolName, toolInput, toolCallId: "probe-rebuild" });
  const command = "node monitor/dispatch-manager.mjs rebuild-space --monitor-dir .monitor --agent-id gdc-a --space GDC-执行A";
  assert.equal(checkDispatchTool(native("Bash", { command })), null);
  // The ad-hoc rebuild path the guard exists to block stays blocked.
  const adhoc = "ego-browser nodejs -e \"await import('file:///C:/tmp/adhoc-rebuild.mjs')\"";
  assert.equal(checkDispatchTool(native("Bash", { command: adhoc })).hookSpecificOutput.permissionDecision, "deny");
});

test("#31: a RESULT-less exit carries the last stderr line as diagnostic detail", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const reading = readEgoOutcome(child, () => {});
  child.stderr.emit("data", Buffer.from("spawn warning\n"));
  child.stderr.emit("data", Buffer.from("/bin/sh: 1: ego-browser: command not found\n"));
  child.emit("close", 127);
  const observation = await reading;
  assert.equal(observation.code, 127);
  assert.equal(observation.result, null);
  assert.equal(observation.detail, "/bin/sh: 1: ego-browser: command not found");
  assert.ok(observation.detail.includes("ego-browser: command not found"));
  assert.ok(observation.detail.length <= 200);
});

test("#31: a parsed RESULT line leaves diagnostic detail null", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const reading = readEgoOutcome(child, () => {});
  child.stdout.emit("data", Buffer.from("noise before the answer\nRESULT=GENERATING\n"));
  child.stderr.emit("data", Buffer.from("harmless stderr noise\n"));
  child.emit("close", 0);
  assert.deepEqual(await reading, { code: 0, result: "GENERATING", detail: null });
});

test("#31: diagnostic detail truncates to 200 characters without a RESULT line", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const reading = readEgoOutcome(child, () => {});
  const long = "E".repeat(500) + " tail-marker";
  child.stderr.emit("data", Buffer.from(long + "\n"));
  child.emit("close", 1);
  const observation = await reading;
  assert.equal(observation.result, null);
  assert.equal(observation.detail.length, 200);
  assert.ok(observation.detail.startsWith("E".repeat(200)));
  assert.ok(!observation.detail.includes("tail-marker"));
});

test("#31: the watch wake line appends diagnostic detail when present", async () => {
  const source = await readFile(new URL("../monitor/dispatch-manager.mjs", import.meta.url), "utf8");
  const watch = source.slice(source.indexOf('if (p.action === "watch")'), source.indexOf('if (p.action === "probe") await writeFile'));
  // The unified exit still emits RESULT=FAST_PROBE_WAKE_SUPERVISOR signal=<result>
  // exit=<code>[ detail=<tail>] and now appends the ledger wakeId.
  assert.match(watch, /exitWatching\(dir, "FAST_PROBE_WAKE_SUPERVISOR", \{/);
  assert.match(watch, /"signal=" \+ \(observation\.result \|\| "MISSING"\) \+ " exit=" \+ observation\.code \+/);
  assert.match(watch, /\(observation\.detail \? " detail=" \+ observation\.detail : ""\)/);
});

const WATCH_EXIT_FILE = "a-watch-exit.json";

test("#25: exitWatching persists the frozen ego-watch-exit/v1 ledger before the wake exit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ego-watch-exit-"));
  const logs = [];
  const originalLog = console.log;
  console.log = (line) => logs.push(String(line));
  let code;
  try {
    code = await exitWatching(dir, "FAST_PROBE_WAKE_SUPERVISOR");
  } finally { console.log = originalLog; }
  assert.equal(code, 2);
  const stored = JSON.parse(await readFile(join(dir, WATCH_EXIT_FILE), "utf8"));
  // The schema is frozen: exactly these seven fields, no task or reply body.
  assert.deepEqual(Object.keys(stored).sort(),
    ["ackAction", "acknowledgedAt", "exitCode", "issuedAt", "reason", "schema", "wakeId"]);
  assert.equal(stored.schema, "ego-watch-exit/v1");
  assert.equal(stored.reason, "FAST_PROBE_WAKE_SUPERVISOR");
  assert.equal(stored.exitCode, 2);
  assert.equal(stored.acknowledgedAt, null);
  assert.equal(stored.ackAction, null);
  assert.equal(Number.isFinite(stored.issuedAt), true);
  assert.match(stored.wakeId, /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/);
  // The wake line announces the same wakeId so the host can ack directly.
  const announced = logs.filter((line) => line.startsWith("RESULT=FAST_PROBE_WAKE_SUPERVISOR"));
  assert.equal(announced.length, 1);
  assert.equal(announced[0], "RESULT=FAST_PROBE_WAKE_SUPERVISOR wakeId=" + stored.wakeId);
});

test("#25: a failed watch-exit marker write keeps the wake exit and records stderr", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-watch-exit-fail-"));
  const missing = join(root, "no-such-dir", "conv");
  const errors = [];
  const logs = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (line) => errors.push(String(line));
  console.log = (line) => logs.push(String(line));
  let code;
  try {
    code = await exitWatching(missing, "WATCH_EXCEPTION");
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
  // The write failure must not upgrade the wake into a success.
  assert.equal(code, 2);
  await assert.rejects(readFile(join(missing, WATCH_EXIT_FILE)), { code: "ENOENT" });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /RESULT=WATCH_EXIT_MARKER_WRITE_FAILED wakeId=[\da-f-]{36} reason=WATCH_EXCEPTION code=ENOENT/);
  // The wake reason is still announced on stdout; the loss lands on stderr only.
  assert.equal(logs.filter((line) => line.startsWith("RESULT=")).length, 1);
  assert.match(logs[0], /RESULT=WATCH_EXCEPTION wakeId=/);
});

test("#25: a staged-but-unconsumed reply exits watch through the durable ledger", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-watch-staged-"));
  const dir = join(root, "conversations", uuid);
  const logs = [];
  const originalLog = console.log;
  try {
    await mkdir(dir, { recursive: true });
    const record = { schema: "ego-dispatch-state/v2", dispatchId: uuid, conversationUuid: uuid,
      taskSpace: "GDC-执行A", pageLabel: "p1", status: "COMPLETED",
      baselineTailKey: null, baselineTailRole: null, baselineComposerLength: 0,
      attempt: 1, createdAt: Date.now(), payload_sha256: sha256("任务") };
    await writeFile(join(dir, "a-dispatch-state.json"), JSON.stringify(record));
    await saveReply(dir, record, { text: "已暂存回复", source: "DOM_BOUNDARY_VISIBLE" }, uuid);
    console.log = (line) => logs.push(String(line));
    const code = await main(["watch", "--monitor-dir", root, "--agent-id", "gdc-a",
      "--space", "GDC-执行A", "--conversation", uuid]);
    assert.equal(code, 2);
    const marker = JSON.parse(await readFile(join(dir, WATCH_EXIT_FILE), "utf8"));
    assert.equal(marker.schema, "ego-watch-exit/v1");
    assert.equal(marker.reason, "REPLY_STAGED_WAKE_SUPERVISOR");
    assert.equal(marker.exitCode, 2);
    assert.equal(marker.acknowledgedAt, null);
    assert.equal(marker.ackAction, null);
    assert.deepEqual(Object.keys(marker).sort(),
      ["ackAction", "acknowledgedAt", "exitCode", "issuedAt", "reason", "schema", "wakeId"]);
    assert.ok(logs.some((line) => line === "RESULT=REPLY_STAGED_WAKE_SUPERVISOR action=consume wakeId=" + marker.wakeId),
      "wake line must carry the ledger wakeId: " + JSON.stringify(logs));
  } finally {
    console.log = originalLog;
    await rm(root, { recursive: true, force: true });
  }
});

test("#25 WG-03: RELEASE_PENDING exits through the durable watch-exit ledger (real execution)", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-release-pending-"));
  const dir = join(root, "conversations", uuid);
  const logs = [];
  const originalLog = console.log;
  try {
    await mkdir(dir, { recursive: true });
    const record = { schema: "ego-dispatch-state/v2", dispatchId: uuid, conversationUuid: uuid,
      taskSpace: "GDC-执行A", pageLabel: "p1", status: "COMPLETED",
      baselineTailKey: null, baselineTailRole: null, baselineComposerLength: 0,
      attempt: 1, createdAt: Date.now(), payload_sha256: sha256("任务") };
    await writeFile(join(dir, "a-dispatch-state.json"), JSON.stringify(record));
    // The reply is verified consumed — only the page release itself fails.
    const receipt = await saveReply(dir, record, { text: "已消费回复", source: "DOM_BOUNDARY_VISIBLE" }, uuid);
    await acknowledgeReply(dir, record, receipt.sha256);
    await verifiedConsumption(dir, record);
    const params = { conversation: uuid, space: "GDC-执行A", agentId: "gdc-a", monitorDir: root };
    console.log = (line) => logs.push(String(line));
    const code = await releaseDelivered(params, dir, {
      runScript: async () => ({ code: 1, result: "SPACE_RELEASE_ACCOUNT_UNPROVEN" }),
    });
    assert.equal(code, 2);
    const marker = JSON.parse(await readFile(join(dir, WATCH_EXIT_FILE), "utf8"));
    assert.equal(marker.schema, "ego-watch-exit/v1");
    assert.equal(marker.reason, "REPLY_DELIVERED_RELEASE_PENDING");
    assert.equal(marker.exitCode, 2);
    // Un-acked: the host must still inspect and ack this wake.
    assert.equal(marker.acknowledgedAt, null);
    assert.equal(marker.ackAction, null);
    assert.deepEqual(Object.keys(marker).sort(),
      ["ackAction", "acknowledgedAt", "exitCode", "issuedAt", "reason", "schema", "wakeId"]);
    // The RESULT line keeps its text and appends the ledger wakeId.
    assert.ok(logs.some((line) => line === "RESULT=REPLY_DELIVERED_RELEASE_PENDING wakeId=" + marker.wakeId),
      "wake line must announce REPLY_DELIVERED_RELEASE_PENDING with the ledger wakeId: " + JSON.stringify(logs));
    // The marker is ackable through the normal ack path.
    await acknowledgeWake(marker.wakeId, "investigated", dir, Date.now());
    const after = JSON.parse(await readFile(join(dir, WATCH_EXIT_FILE), "utf8"));
    assert.equal(after.ackAction, "investigated");
    // Success path unchanged: a verified release still exits 0 without a marker.
    await rm(join(dir, WATCH_EXIT_FILE), { force: true });
    console.log = (line) => logs.push(String(line));
    const clean = await releaseDelivered(params, dir, {
      runScript: async () => ({ code: 0, result: "AGENT_SPACE_RELEASED" }),
    });
    assert.equal(clean, 0);
    assert.ok(logs.some((line) => line === "RESULT=DISPATCH_FINISHED_AND_RELEASED"));
    await assert.rejects(readFile(join(dir, WATCH_EXIT_FILE)), { code: "ENOENT" });
  } finally {
    console.log = originalLog;
    await rm(root, { recursive: true, force: true });
  }
});

test("#25 WG-03A: ensureMonitor failure after watch identity confirmation exits through the durable ledger", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-ensuremon-fail-"));
  const dir = join(root, "conversations", uuid);
  const logs = [];
  const originalLog = console.log;
  try {
    await mkdir(dir, { recursive: true });
    // A terminal COMPLETED dispatch whose identity requireArmedDispatch accepts.
    const record = { schema: "ego-dispatch-state/v2", dispatchId: uuid, conversationUuid: uuid,
      taskSpace: "GDC-执行A", pageLabel: "p1", status: "COMPLETED",
      baselineTailKey: null, baselineTailRole: null, baselineComposerLength: 0,
      attempt: 1, createdAt: Date.now(), payload_sha256: sha256("任务") };
    await writeFile(join(dir, "a-dispatch-state.json"), JSON.stringify(record));
    // A managed module copy target that is a directory makes ensureMonitor's
    // refresh fail with EISDIR after the watch identity was already confirmed.
    await mkdir(join(dir, "agent-space.mjs"));
    console.log = (line) => logs.push(String(line));
    const code = await main(["watch", "--monitor-dir", root, "--agent-id", "gdc-a",
      "--space", "GDC-执行A", "--conversation", uuid]);
    assert.equal(code, 2);
    const marker = JSON.parse(await readFile(join(dir, WATCH_EXIT_FILE), "utf8"));
    assert.equal(marker.schema, "ego-watch-exit/v1");
    assert.equal(marker.reason, "WATCH_EXCEPTION");
    assert.equal(marker.exitCode, 2);
    assert.equal(marker.acknowledgedAt, null);
    assert.equal(marker.ackAction, null);
    // The frozen schema: exactly these seven fields, no task or reply body.
    assert.deepEqual(Object.keys(marker).sort(),
      ["ackAction", "acknowledgedAt", "exitCode", "issuedAt", "reason", "schema", "wakeId"]);
    // The announced wakeId matches the persisted marker byte-for-byte.
    assert.ok(logs.includes(`RESULT=WATCH_EXCEPTION code=EISDIR wakeId=${marker.wakeId}`),
      "wake line must announce WATCH_EXCEPTION with the ledger wakeId: " + JSON.stringify(logs));
  } finally {
    console.log = originalLog;
    await rm(root, { recursive: true, force: true });
  }
});

test("#25: every watch exit-2 path persists the ego-watch-exit ledger and announces its wakeId", async () => {
  const source = await readFile(new URL("../monitor/dispatch-manager.mjs", import.meta.url), "utf8");
  const watch = source.slice(source.indexOf('if (p.action === "watch")'), source.indexOf('if (p.action === "probe") await writeFile'));
  // Path 4: REPLY_STAGED (staged reply, consumption still owed).
  assert.match(watch, /exitWatching\(dir, "REPLY_STAGED_WAKE_SUPERVISOR", \{ detail: "action=consume" \}\)/);
  // Path 1: DONE_CANDIDATE -> REPLY_READY.
  assert.match(watch, /exitWatching\(dir, "REPLY_READY_WAKE_SUPERVISOR", \{ detail: "action=collect" \}\)/);
  // Path 2: fast-probe anomaly, original wake fields preserved.
  assert.match(watch, /exitWatching\(dir, "FAST_PROBE_WAKE_SUPERVISOR", \{/);
  assert.match(watch, /"signal=" \+ \(observation\.result \|\| "MISSING"\) \+ " exit=" \+ observation\.code \+/);
  // Path 3: abnormal supervision round reuses the supervision pending id so
  // both ledgers share one wakeId; tick() already announced that line.
  assert.match(watch, /exitWatching\(dir, supervisionReason, \{/);
  assert.match(watch, /a-supervision-status\.json/);
  assert.match(watch, /wakeId: pending && typeof pending\.id === "string" \? pending\.id : undefined/);
  assert.match(watch, /pending\.reason : "MONITOR_WAKE_UNACKNOWLEDGED"/);
  assert.match(watch, /announce: false/);
  // Path 5: any catchable watch-branch failure — init, reconciliation, release
  // or the poll loop — leaves the ledger behind and exits 2 (WG-03): the whole
  // branch body is wrapped in one try whose catch lands on exitWatching.
  assert.match(watch, /try \{[\s\S]*while \(true\)[\s\S]*\} catch \(error\) \{[\s\S]*return await exitWatching\(dir, "WATCH_EXCEPTION"/);
  assert.match(watch, /"code=" \+ \(\(error && \(error\.code \|\| error\.message\)\) \|\| "UNKNOWN"\)/);
});

test("#25: the watch-exit marker is written atomically with a fail-open-on-write exit", async () => {
  const source = await readFile(new URL("../monitor/dispatch-manager.mjs", import.meta.url), "utf8");
  const fn = source.slice(source.indexOf("// Unified watch exit"), source.indexOf("export async function acknowledgeWake"));
  assert.match(source, /const WATCH_EXIT_SCHEMA = "ego-watch-exit\/v1";/);
  assert.match(fn, /writeJsonAtomic\(join\(dir, "a-watch-exit\.json"\), marker\)/);
  assert.match(fn, /schema: WATCH_EXIT_SCHEMA/);
  assert.match(fn, /exitCode: 2/);
  assert.match(fn, /acknowledgedAt: null/);
  assert.match(fn, /ackAction: null/);
  // Write failure: stderr record, exit code stays 2, never a success path.
  assert.match(fn, /WATCH_EXIT_MARKER_WRITE_FAILED/);
  assert.doesNotMatch(fn, /return 0|return 1/);
  assert.match(fn, /SIGKILL|power loss/);
});

const supervisionLedger = (id, overrides = {}) => ({
  schema: "ego-supervision/v1", generationKey: null, progressAt: 0,
  abnormalRounds: 1, lastReviewAt: 0,
  pending: { id, reason: "FAST_POLL_STALE", issuedAt: 1000 }, ...overrides,
});

test("#25: ack confirms the watch-exit ledger and retains it as evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ego-ack-watch-exit-"));
  try {
    const wakeId = randomUUID();
    const write = (marker) => writeFile(join(dir, WATCH_EXIT_FILE), JSON.stringify(marker));
    await write({ schema: "ego-watch-exit/v1", wakeId, reason: "REPLY_READY_WAKE_SUPERVISOR",
      issuedAt: 1234, exitCode: 2, acknowledgedAt: null, ackAction: null });
    await assert.rejects(acknowledgeWake(wakeId, "bogus", dir), /ACK_ARGS_INVALID/);
    await acknowledgeWake(wakeId, "investigated", dir, 5000);
    const marker = JSON.parse(await readFile(join(dir, WATCH_EXIT_FILE), "utf8"));
    assert.equal(marker.acknowledgedAt, 5000);
    assert.equal(marker.ackAction, "investigated");
    // Historical evidence is retained, not deleted or rewritten.
    assert.equal(marker.wakeId, wakeId);
    assert.equal(marker.reason, "REPLY_READY_WAKE_SUPERVISOR");
    assert.equal(marker.issuedAt, 1234);
    assert.deepEqual(Object.keys(marker).sort(),
      ["ackAction", "acknowledgedAt", "exitCode", "issuedAt", "reason", "schema", "wakeId"]);
    // A repeated ack of the already-acknowledged marker is rejected.
    await assert.rejects(acknowledgeWake(wakeId, "resolved", dir, 6000), /WAKE_ID_ALREADY_ACKNOWLEDGED/);
    const after = JSON.parse(await readFile(join(dir, WATCH_EXIT_FILE), "utf8"));
    assert.equal(after.ackAction, "investigated");
    assert.equal(after.acknowledgedAt, 5000);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("#25: one ack clears both ledgers sharing the same wakeId", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ego-ack-dual-"));
  try {
    const wakeId = randomUUID();
    await writeFile(join(dir, "a-supervision-status.json"), JSON.stringify(supervisionLedger(wakeId)));
    await writeFile(join(dir, WATCH_EXIT_FILE), JSON.stringify({ schema: "ego-watch-exit/v1", wakeId,
      reason: "FAST_POLL_STALE", issuedAt: 1000, exitCode: 2, acknowledgedAt: null, ackAction: null }));
    await acknowledgeWake(wakeId, "resolved", dir, 7000);
    const status = JSON.parse(await readFile(join(dir, "a-supervision-status.json"), "utf8"));
    assert.equal(status.pending, null);
    assert.equal(status.lastReviewAt, 7000);
    assert.equal(status.abnormalRounds, 0);
    const marker = JSON.parse(await readFile(join(dir, WATCH_EXIT_FILE), "utf8"));
    assert.equal(marker.acknowledgedAt, 7000);
    assert.equal(marker.ackAction, "resolved");
    assert.equal(marker.wakeId, wakeId);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("#25: an unknown or unreadable wake id still fails closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ego-ack-failclosed-"));
  const other = "22222222-2222-4222-8222-222222222222";
  try {
    await assert.rejects(acknowledgeWake(randomUUID(), "investigated", dir), /WAKE_ID_NOT_PENDING/);
    // Neither ledger matches the acked id: both stay untouched.
    await writeFile(join(dir, "a-supervision-status.json"), JSON.stringify(supervisionLedger(other)));
    const markerId = randomUUID();
    await writeFile(join(dir, WATCH_EXIT_FILE), JSON.stringify({ schema: "ego-watch-exit/v1", wakeId: markerId,
      reason: "WATCH_EXCEPTION", issuedAt: 1, exitCode: 2, acknowledgedAt: null, ackAction: null }));
    await assert.rejects(acknowledgeWake(randomUUID(), "resolved", dir), /WAKE_ID_NOT_PENDING/);
    const status = JSON.parse(await readFile(join(dir, "a-supervision-status.json"), "utf8"));
    assert.equal(status.pending.id, other);
    const marker = JSON.parse(await readFile(join(dir, WATCH_EXIT_FILE), "utf8"));
    assert.equal(marker.acknowledgedAt, null);
    // A corrupted watch-exit ledger must not be silently acknowledged.
    await writeFile(join(dir, WATCH_EXIT_FILE), "{corrupted");
    await assert.rejects(acknowledgeWake(markerId, "investigated", dir), /JSON at position|Unexpected token/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("#25: supervision-only wake ids keep the existing ack semantics", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ego-ack-supervision-"));
  try {
    const pendingId = randomUUID();
    await writeFile(join(dir, "a-supervision-status.json"), JSON.stringify(supervisionLedger(pendingId, { abnormalRounds: 2 })));
    await acknowledgeWake(pendingId, "investigated", dir, 9000);
    const status = JSON.parse(await readFile(join(dir, "a-supervision-status.json"), "utf8"));
    assert.equal(status.pending, null);
    assert.equal(status.lastReviewAt, 9000);
    assert.equal(status.abnormalRounds, 2);
    // A supervision ack never fabricates a watch-exit marker.
    await assert.rejects(readFile(join(dir, WATCH_EXIT_FILE)), { code: "ENOENT" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---- #27 observation B (Batch 1): managed ack tiering + ack audit ledger ----

// Fixture: one conversation with a dispatch ledger (taskSpace), an un-acked
// ego-watch-exit marker and a parsed ack command for a given agent/space/action.
async function ackFixture(root, { agentId = "gdc-a", space = "GDC-执行A", ackAction = "resolved", wakeId = randomUUID() } = {}) {
  const dir = join(root, "conversations", uuid);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "a-dispatch-state.json"), JSON.stringify({
    schema: "ego-dispatch-state/v2", dispatchId: uuid, conversationUuid: uuid,
    taskSpace: "GDC-执行A", pageLabel: "p1", status: "ACCEPTED", baselineTailKey: null,
    baselineTailRole: null, baselineComposerLength: 0, attempt: 1, createdAt: Date.now(),
    payload_sha256: null, payload_bytes: null, composer_baseline: null,
  }));
  await writeFile(join(dir, WATCH_EXIT_FILE), JSON.stringify({
    schema: "ego-watch-exit/v1", wakeId, reason: "REPLY_READY_WAKE_SUPERVISOR",
    issuedAt: 1234, exitCode: 2, acknowledgedAt: null, ackAction: null,
  }));
  const p = parseArgs(["ack", "--monitor-dir", root, "--agent-id", agentId, "--space", space,
    "--conversation", uuid, "--wake-id", wakeId, "--ack-action", ackAction]);
  return { dir, wakeId, p };
}

const ackAuditLines = async (root) => (await readFile(join(root, ACK_AUDIT_FILE), "utf8")).trim().split("\n").map((line) => JSON.parse(line));

test("#27 B: owner resolved succeeds via registry binding; the pre-binding attempt is denied fail-closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-ack-owner-"));
  const errors = [];
  const originalError = console.error;
  try {
    const { dir, wakeId, p } = await ackFixture(root);
    console.error = (line) => errors.push(String(line));
    // No registry binding yet: resolved is denied with the new error code,
    // OPERATOR guidance, and ZERO writes to either wake ledger.
    assert.equal(await managedAcknowledge(p, { directory: root }), 2);
    const deniedMarker = JSON.parse(await readFile(join(dir, WATCH_EXIT_FILE), "utf8"));
    assert.equal(deniedMarker.acknowledgedAt, null);
    assert.equal(deniedMarker.ackAction, null);
    assert.deepEqual(Object.keys(deniedMarker).sort(),
      ["ackAction", "acknowledgedAt", "exitCode", "issuedAt", "reason", "schema", "wakeId"]);
    await assert.rejects(readFile(join(dir, "a-supervision-status.json")), { code: "ENOENT" });
    const denied = (await ackAuditLines(root))[0];
    for (const field of ["ts", "agentId", "space", "conversation", "wakeId", "ackAction", "outcome"]) {
      assert.ok(field in denied, "audit field " + field);
    }
    assert.equal(denied.outcome, "DENIED");
    assert.equal(denied.reason, ACK_RESOLVED_OWNERSHIP_REQUIRED);
    assert.equal(denied.wakeId, wakeId);
    assert.equal(denied.ackAction, "resolved");
    assert.equal(errors.filter((line) => line.includes("OPERATOR_ACTION=")).length, 1);
    assert.match(errors.find((line) => line.includes("OPERATOR_ACTION=")), /claim.*investigated/s);
    assert.match(errors.find((line) => line.startsWith("RESULT=")), new RegExp(ACK_RESOLVED_OWNERSHIP_REQUIRED));
    // Bind the owner agent to the ledger's taskSpace -> registry evidence grants.
    await withAgentRegistry((registry) => {
      registry.agents["gdc-a"] = { spaceName: "GDC-执行A", active: [], known: [] };
      return { changed: true };
    }, root);
    assert.equal(await managedAcknowledge(p, { directory: root }), 0);
    const marker = JSON.parse(await readFile(join(dir, WATCH_EXIT_FILE), "utf8"));
    assert.notEqual(marker.acknowledgedAt, null);
    assert.equal(marker.ackAction, "resolved");
    // The #25-frozen seven-field marker schema is untouched by the ack gate.
    assert.deepEqual(Object.keys(marker).sort(),
      ["ackAction", "acknowledgedAt", "exitCode", "issuedAt", "reason", "schema", "wakeId"]);
    const lines = await ackAuditLines(root);
    assert.equal(lines.length, 2);
    assert.equal(lines[1].outcome, "GRANTED");
    assert.equal(lines[1].evidence, "REGISTRY");
    assert.equal(lines[1].agentId, "gdc-a");
    assert.equal(lines[1].space, "GDC-执行A");
    assert.equal(lines[1].conversation, uuid);
  } finally {
    console.error = originalError;
    await rm(root, { recursive: true, force: true });
  }
});

test("#27 B: a non-owner resolved is denied even when another agent owns the space", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-ack-foreign-"));
  try {
    const { dir, p } = await ackFixture(root, { agentId: "gdc-x" });
    // gdc-b owns the ledger's taskSpace; gdc-x owns nothing.
    await withAgentRegistry((registry) => {
      registry.agents["gdc-b"] = { spaceName: "GDC-执行A", active: [], known: [] };
      registry.agents["gdc-x"] = { spaceName: "别家空间", active: [], known: [] };
      return { changed: true };
    }, root);
    assert.equal(await managedAcknowledge(p, { directory: root }), 2);
    const marker = JSON.parse(await readFile(join(dir, WATCH_EXIT_FILE), "utf8"));
    assert.equal(marker.acknowledgedAt, null);
    assert.equal(marker.ackAction, null);
    const audit = await ackAuditLines(root);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].outcome, "DENIED");
    assert.equal(audit[0].reason, ACK_RESOLVED_OWNERSHIP_REQUIRED);
    assert.equal(audit[0].agentId, "gdc-x");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#27 B: managed claim takeover evidence grants resolved without a registry binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-ack-claim-"));
  try {
    // No registry entry at all: only the recorded claim takeover can grant.
    const { dir, p } = await ackFixture(root);
    await writeFile(join(root, "a-space-rebuild-audit.ndjson"), JSON.stringify({
      ts: new Date().toISOString(), action: "claim", agentId: "gdc-a", space: "GDC-执行A",
      decision: "LEDGER_PROOF", outcome: "CLAIMED",
      result: "SPACE_CLAIMED_OWNERSHIP_VERIFIED", exit: 0,
    }) + "\n", "utf8");
    assert.equal(await managedAcknowledge(p, { directory: root }), 0);
    const marker = JSON.parse(await readFile(join(dir, WATCH_EXIT_FILE), "utf8"));
    assert.equal(marker.ackAction, "resolved");
    assert.notEqual(marker.acknowledgedAt, null);
    const lines = await ackAuditLines(root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].outcome, "GRANTED");
    assert.equal(lines[0].evidence, "CLAIM");

    // Negative controls: a FAILED claim, a foreign agentId or a foreign space
    // row does NOT grant — a fresh resolved without real evidence stays denied.
    const writeRow = (row) => writeFile(join(root, "a-space-rebuild-audit.ndjson"), JSON.stringify(row) + "\n", "utf8");
    for (const row of [
      { action: "claim", agentId: "gdc-a", space: "GDC-执行A", outcome: "FAILED" },
      { action: "claim", agentId: "gdc-b", space: "GDC-执行A", outcome: "CLAIMED" },
      { action: "claim", agentId: "gdc-a", space: "别家空间", outcome: "CLAIMED" },
      { action: "rebuild-space", agentId: "gdc-a", space: "GDC-执行A", outcome: "REBUILT" },
    ]) {
      const { dir: dirN, wakeId: wakeN, p: pN } = await ackFixture(root, { wakeId: randomUUID() });
      await writeRow(row);
      assert.equal(await managedAcknowledge(pN, { directory: root }), 2, JSON.stringify(row));
      const deniedMarker = JSON.parse(await readFile(join(dirN, WATCH_EXIT_FILE), "utf8"));
      assert.equal(deniedMarker.acknowledgedAt, null);
      assert.equal(deniedMarker.ackAction, null);
    }
    // Evidence lookup itself: REGISTRY outranks nothing here (no registry), and
    // the claim row is matched exactly once per qualifying line.
    await writeRow({ action: "claim", agentId: "gdc-a", space: "GDC-执行A", outcome: "CLAIMED" });
    const { dir: dirE, p: pE } = await ackFixture(root, { wakeId: randomUUID() });
    assert.equal(await ackOwnershipEvidence("gdc-a", "GDC-执行A", uuid, root, dirE, { directory: root }), "CLAIM");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#27 B: investigated stays open to any valid agent identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-ack-investigated-"));
  const errors = [];
  const originalError = console.error;
  try {
    // No registry entry, no claim audit — investigated is still granted.
    const { dir, wakeId, p } = await ackFixture(root, { agentId: "gdc-c", ackAction: "investigated" });
    console.error = (line) => errors.push(String(line));
    assert.equal(await managedAcknowledge(p, { directory: root }), 0);
    const marker = JSON.parse(await readFile(join(dir, WATCH_EXIT_FILE), "utf8"));
    assert.equal(marker.ackAction, "investigated");
    assert.notEqual(marker.acknowledgedAt, null);
    const lines = await ackAuditLines(root);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].outcome, "GRANTED");
    assert.equal("evidence" in lines[0], false);
    assert.equal(lines[0].agentId, "gdc-c");
    assert.equal(lines[0].wakeId, wakeId);
    // An ack that resolves to nothing still fails closed AND leaves a DENIED
    // audit line with the failure reason.
    const pUnknown = parseArgs(["ack", "--monitor-dir", root, "--agent-id", "gdc-c", "--space", "GDC-执行A",
      "--conversation", uuid, "--wake-id", randomUUID(), "--ack-action", "investigated"]);
    await assert.rejects(managedAcknowledge(pUnknown, { directory: root }), /WAKE_ID_NOT_PENDING/);
    const after = await ackAuditLines(root);
    assert.equal(after.length, 2);
    assert.equal(after[1].outcome, "DENIED");
    assert.equal(after[1].reason, "WAKE_ID_NOT_PENDING");
  } finally {
    console.error = originalError;
    await rm(root, { recursive: true, force: true });
  }
});

test("#27 B: the managed ack path is wired into main and the primitive stays intact", async () => {
  const source = await readFile(new URL("../monitor/dispatch-manager.mjs", import.meta.url), "utf8");
  assert.match(source, /if \(p\.action === "ack"\) return managedAcknowledge\(p\);/);
  // acknowledgeWake keeps its legacy signature and semantics (low-level
  // primitive; the tiering lives only on the managed path above it).
  assert.match(source, /export async function acknowledgeWake\(id, action, dir, now = Date\.now\(\)\)/);
  // The gate itself: evidence (a) registry binding, evidence (b) claim row.
  assert.match(source, /export async function ackOwnershipEvidence\(agentId, space, conversation, monitorDir, dir, \{ directory \} = \{\}\)/);
  assert.match(source, /return "REGISTRY";/);
  assert.match(source, /return "CLAIM";/);
  // B-02: audit failures are reported, never allowed to flip the ack verdict.
  assert.match(source, /ACK_AUDIT_WRITE_FAILED/);
});

// ---- planner re-review (B-01): the ownership precondition chain is anchored
// to the TARGET conversation's ledger, before either evidence path runs. ----

test("#27 B-01: registry evidence is refused when --space does not match the ledger taskSpace", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-ack-b01-space-"));
  try {
    // Registry binding would match the ledger perfectly — but the caller
    // declares a different space, so precondition 3 must block it.
    const { dir, p } = await ackFixture(root, { agentId: "gdc-a", space: "别家空间" });
    await withAgentRegistry((registry) => {
      registry.agents["gdc-a"] = { spaceName: "GDC-执行A", active: [], known: [] };
      return { changed: true };
    }, root);
    assert.equal(await ackOwnershipEvidence("gdc-a", "别家空间", uuid, root, dir, { directory: root }), null);
    assert.equal(await managedAcknowledge(p, { directory: root }), 2);
    const marker = JSON.parse(await readFile(join(dir, WATCH_EXIT_FILE), "utf8"));
    assert.equal(marker.acknowledgedAt, null);
    assert.equal(marker.ackAction, null);
    const audit = await ackAuditLines(root);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].outcome, "DENIED");
    assert.equal(audit[0].reason, ACK_RESOLVED_OWNERSHIP_REQUIRED);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#27 B-01: claim evidence is refused when --space does not match the ledger taskSpace", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-ack-b01-claim-space-"));
  try {
    // The claim row itself would match the DECLARED space — the precondition
    // chain (and the record-anchored row comparison) must still refuse it.
    const { dir, p } = await ackFixture(root, { agentId: "gdc-a", space: "别家空间" });
    await writeFile(join(root, "a-space-rebuild-audit.ndjson"), JSON.stringify({
      ts: new Date().toISOString(), action: "claim", agentId: "gdc-a", space: "别家空间",
      decision: "LEDGER_PROOF", outcome: "CLAIMED", result: "SPACE_CLAIMED_OWNERSHIP_VERIFIED", exit: 0,
    }) + "\n", "utf8");
    assert.equal(await ackOwnershipEvidence("gdc-a", "别家空间", uuid, root, dir, { directory: root }), null);
    assert.equal(await managedAcknowledge(p, { directory: root }), 2);
    const marker = JSON.parse(await readFile(join(dir, WATCH_EXIT_FILE), "utf8"));
    assert.equal(marker.acknowledgedAt, null);
    assert.equal(marker.ackAction, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#27 B-01: claim evidence is refused when the dispatch ledger is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-ack-b01-noledger-"));
  try {
    // A claim row alone must never grant: without a valid dispatch ledger the
    // precondition chain cannot even anchor the TaskSpace (fail-closed).
    const dir = join(root, "conversations", uuid);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, WATCH_EXIT_FILE), JSON.stringify({
      schema: "ego-watch-exit/v1", wakeId: randomUUID(), reason: "REPLY_READY_WAKE_SUPERVISOR",
      issuedAt: 1234, exitCode: 2, acknowledgedAt: null, ackAction: null,
    }));
    await writeFile(join(root, "a-space-rebuild-audit.ndjson"), JSON.stringify({
      ts: new Date().toISOString(), action: "claim", agentId: "gdc-a", space: "GDC-执行A",
      decision: "LEDGER_PROOF", outcome: "CLAIMED", result: "SPACE_CLAIMED_OWNERSHIP_VERIFIED", exit: 0,
    }) + "\n", "utf8");
    const p = parseArgs(["ack", "--monitor-dir", root, "--agent-id", "gdc-a", "--space", "GDC-执行A",
      "--conversation", uuid, "--wake-id", randomUUID(), "--ack-action", "resolved"]);
    assert.equal(await ackOwnershipEvidence("gdc-a", "GDC-执行A", uuid, root, dir, { directory: root }), null);
    assert.equal(await managedAcknowledge(p, { directory: root }), 2);
    const marker = JSON.parse(await readFile(join(dir, WATCH_EXIT_FILE), "utf8"));
    assert.equal(marker.acknowledgedAt, null);
    assert.equal(marker.ackAction, null);
    await assert.rejects(readFile(join(dir, "a-dispatch-state.json")), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#27 B-01: a --conversation that mismatches the ledger record.conversationUuid is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-ack-b01-conv-"));
  try {
    // The ledger lives in the addressed directory but belongs to ANOTHER
    // conversation; registry binding AND a matching claim row both exist, and
    // the conversation precondition must still refuse the grant.
    const other = "22222222-2222-4222-8222-222222222222";
    const { dir, p } = await ackFixture(root);
    await writeFile(join(dir, "a-dispatch-state.json"), JSON.stringify({
      schema: "ego-dispatch-state/v2", dispatchId: other, conversationUuid: other,
      taskSpace: "GDC-执行A", pageLabel: "p1", status: "ACCEPTED", baselineTailKey: null,
      baselineTailRole: null, baselineComposerLength: 0, attempt: 1, createdAt: Date.now(),
      payload_sha256: null, payload_bytes: null, composer_baseline: null,
    }));
    await withAgentRegistry((registry) => {
      registry.agents["gdc-a"] = { spaceName: "GDC-执行A", active: [], known: [] };
      return { changed: true };
    }, root);
    await writeFile(join(root, "a-space-rebuild-audit.ndjson"), JSON.stringify({
      ts: new Date().toISOString(), action: "claim", agentId: "gdc-a", space: "GDC-执行A",
      decision: "LEDGER_PROOF", outcome: "CLAIMED", result: "SPACE_CLAIMED_OWNERSHIP_VERIFIED", exit: 0,
    }) + "\n", "utf8");
    assert.equal(await ackOwnershipEvidence("gdc-a", "GDC-执行A", uuid, root, dir, { directory: root }), null);
    assert.equal(await managedAcknowledge(p, { directory: root }), 2);
    const marker = JSON.parse(await readFile(join(dir, WATCH_EXIT_FILE), "utf8"));
    assert.equal(marker.acknowledgedAt, null);
    assert.equal(marker.ackAction, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// ---- planner re-review (B-02): the audit verdict never diverges from the ack
// business result; audit write failures are reported, never fatal to the ack. ----

test("#27 B-02: a succeeded ack with a failed GRANTED audit stays exit 0, never a fake DENIED", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-ack-b02-granted-"));
  const errors = [];
  const originalError = console.error;
  try {
    const { dir, p } = await ackFixture(root, { agentId: "gdc-c", ackAction: "investigated" });
    // The audit target IS a directory: every appendFile to it fails (EISDIR)
    // while the ack itself proceeds normally.
    const auditPath = join(root, ACK_AUDIT_FILE);
    await mkdir(auditPath, { recursive: true });
    console.error = (line) => errors.push(String(line));
    assert.equal(await managedAcknowledge(p, { directory: root }), 0);
    // The ack really succeeded and was never misrecorded as a failure.
    const marker = JSON.parse(await readFile(join(dir, WATCH_EXIT_FILE), "utf8"));
    assert.notEqual(marker.acknowledgedAt, null);
    assert.equal(marker.ackAction, "investigated");
    // The audit failure is reported on stderr, without any DENIED downgrade.
    assert.equal(errors.filter((line) => line.includes("ACK_AUDIT_WRITE_FAILED")).length, 1);
    assert.equal(errors.some((line) => line.includes("ACK_DENIED")), false);
    // Nothing was written through the unwritable audit target.
    assert.equal((await stat(auditPath)).isDirectory(), true);
  } finally {
    console.error = originalError;
    await rm(root, { recursive: true, force: true });
  }
});

test("#27 B-02: a failed ack with a working audit records the DENIED accurately", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-ack-b02-denied-"));
  const errors = [];
  const originalError = console.error;
  try {
    const { p } = await ackFixture(root, { agentId: "gdc-c", ackAction: "investigated" });
    // Point the ack at a wake id that matches no ledger: acknowledgeWake
    // fails, the DENIED audit must record exactly that reason.
    const unknown = parseArgs(["ack", "--monitor-dir", root, "--agent-id", "gdc-c", "--space", "GDC-执行A",
      "--conversation", uuid, "--wake-id", randomUUID(), "--ack-action", "investigated"]);
    console.error = (line) => errors.push(String(line));
    await assert.rejects(managedAcknowledge(unknown, { directory: root }), /WAKE_ID_NOT_PENDING/);
    const audit = await ackAuditLines(root);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].outcome, "DENIED");
    assert.equal(audit[0].reason, "WAKE_ID_NOT_PENDING");
    assert.equal(errors.some((line) => line.includes("ACK_AUDIT_WRITE_FAILED")), false);
    // The rethrown error is the ORIGINAL ack failure, not an audit artifact.
    assert.equal(errors.filter((line) => line.includes("RESULT=")).length, 0);
  } finally {
    console.error = originalError;
    await rm(root, { recursive: true, force: true });
  }
});

test("#27 B-02: an ownership denial still denies (exit 2) when its audit write fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-ack-b02-denyfail-"));
  const errors = [];
  const originalError = console.error;
  try {
    const { dir, p } = await ackFixture(root, { agentId: "gdc-a", ackAction: "resolved" });
    // No registry binding, no claim row: the resolved is denied — and the
    // audit target is a directory, so even the DENIED line cannot be written.
    const auditPath = join(root, ACK_AUDIT_FILE);
    await mkdir(auditPath, { recursive: true });
    console.error = (line) => errors.push(String(line));
    assert.equal(await managedAcknowledge(p, { directory: root }), 2);
    // The business ledgers keep zero changes (fail-closed denial stands).
    const marker = JSON.parse(await readFile(join(dir, WATCH_EXIT_FILE), "utf8"));
    assert.equal(marker.acknowledgedAt, null);
    assert.equal(marker.ackAction, null);
    await assert.rejects(readFile(join(dir, "a-supervision-status.json")), { code: "ENOENT" });
    assert.equal(errors.filter((line) => line.includes("ACK_AUDIT_WRITE_FAILED")).length, 1);
    assert.ok(errors.some((line) => line.includes("ACK_DENIED code=" + ACK_RESOLVED_OWNERSHIP_REQUIRED)));
    assert.equal((await stat(auditPath)).isDirectory(), true);
  } finally {
    console.error = originalError;
    await rm(root, { recursive: true, force: true });
  }
});

test("#27 B-02: a normal audit run writes exactly one line per operation with the matching outcome", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-ack-b02-normal-"));
  const errors = [];
  const originalError = console.error;
  try {
    const { p } = await ackFixture(root, { agentId: "gdc-c", ackAction: "investigated" });
    console.error = (line) => errors.push(String(line));
    assert.equal(await managedAcknowledge(p, { directory: root }), 0);
    const audit = await ackAuditLines(root);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].outcome, "GRANTED");
    for (const field of ["ts", "agentId", "space", "conversation", "wakeId", "ackAction", "outcome"]) {
      assert.ok(field in audit[0], "audit field " + field);
    }
    assert.equal(errors.some((line) => line.includes("ACK_AUDIT_WRITE_FAILED")), false);
  } finally {
    console.error = originalError;
    await rm(root, { recursive: true, force: true });
  }
});

// ---- agent-kit#33: managed claim action + takeover operator guidance ----

test("#33: claim parses space-level identity and rejects dispatch-only args", () => {
  const base = ["--monitor-dir", ".monitor", "--agent-id", "gdc-a", "--space", "GDC-执行A"];
  const p = parseArgs(["claim", ...base]);
  assert.equal(p.action, "claim");
  assert.throws(() => parseArgs(["claim", ...base, "--conversation", uuid]), /MANAGER_IDENTITY_INVALID/);
  assert.throws(() => parseArgs(["claim", ...base, "--request-id", uuid]), /MANAGER_IDENTITY_INVALID/);
  assert.throws(() => parseArgs(["claim", ...base, "--message", "msg.txt"]), /MANAGER_IDENTITY_INVALID/);
  assert.throws(() => parseArgs(["claim", "--monitor-dir", ".monitor", "--space", "GDC-执行A"]), /MANAGER_IDENTITY_INVALID/);
  assert.throws(() => parseArgs(["claim", ...base, "--bogus", "x"]), /MANAGER_ARG_INVALID/);
});

test("#33: claim runs the adapted template, audits CLAIMED/FAILED in the shared ledger", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-claim-run-"));
  try {
    await withAgentRegistry((registry) => {
      registry.agents["gdc-a"] = { spaceName: "GDC-执行A", active: [], known: [] };
      return { changed: true };
    }, root);
    const p = parseArgs(["claim", "--monitor-dir", root, "--agent-id", "gdc-a", "--space", "GDC-执行A"]);
    const scripts = [];
    assert.equal(await claimSpace(p, {
      directory: root,
      runScript: async (script, dir) => {
        scripts.push({ script, dir });
        return { code: 0, result: "SPACE_CLAIMED_ACCOUNT_VERIFIED" };
      },
    }), 0);
    assert.equal(scripts.length, 1);
    assert.equal(scripts[0].dir, root);
    assert.match(scripts[0].script, /const SPACE = "GDC-执行A";/);
    assert.doesNotMatch(scripts[0].script, /REPLACE_WITH_/);
    const audit = (await readFile(join(root, "a-space-rebuild-audit.ndjson"), "utf8")).trim().split("\n");
    assert.equal(JSON.parse(audit[0]).action, "claim");
    assert.equal(JSON.parse(audit[0]).decision, "LEDGER_PROOF");
    assert.equal(JSON.parse(audit[0]).outcome, "CLAIMED");
    assert.equal(JSON.parse(audit[0]).result, "SPACE_CLAIMED_OWNERSHIP_VERIFIED");
    assert.equal(JSON.parse(audit[0]).exit, 0);
    // A failed browser outcome stays exit 2 and audits FAILED with the raw result.
    assert.equal(await claimSpace(p, {
      directory: root,
      runScript: async () => ({ code: 1, result: "SPACE_CLAIM_OWNERSHIP_UNVERIFIED" }),
    }), 2);
    const lines = (await readFile(join(root, "a-space-rebuild-audit.ndjson"), "utf8")).trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[1]).decision, "LEDGER_PROOF");
    assert.equal(JSON.parse(lines[1]).outcome, "FAILED");
    assert.equal(JSON.parse(lines[1]).result, "SPACE_CLAIM_OWNERSHIP_UNVERIFIED");
    assert.equal(JSON.parse(lines[1]).exit, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#33: claim authorization three states: DENIED audited, ALLOWLIST claimed", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-claim-auth-"));
  try {
    // DENIED before any browser call, audited into the shared rebuild ledger.
    assert.equal(await main(["claim", "--monitor-dir", root, "--agent-id", "gdc-a", "--space", "GDC-执行A"]), 2);
    const audit = JSON.parse(await readFile(join(root, "a-space-rebuild-audit.ndjson"), "utf8"));
    assert.equal(audit.action, "claim");
    assert.equal(audit.decision, "DENIED");
    assert.equal(audit.agentId, "gdc-a");
    assert.equal(audit.space, "GDC-执行A");
    assert.match(audit.code, /SPACE_REBUILD|AGENT_SPACE_RELEASE_PENDING/);
    // A space-level action must not create the per-conversation layout.
    await assert.rejects(stat(join(root, "conversations")), { code: "ENOENT" });
    // ALLOWLIST authorization claims without any ledger entry.
    const p = parseArgs(["claim", "--monitor-dir", root, "--agent-id", "gdc-c", "--space", "新空间"]);
    let ran = 0;
    assert.equal(await claimSpace(p, {
      directory: root,
      profileConfig: { spaceRebuildAllowlist: ["新空间"] },
      runScript: async () => { ran++; return { code: 0, result: "SPACE_CLAIMED_ACCOUNT_VERIFIED" }; },
    }), 0);
    assert.equal(ran, 1);
    const lines = (await readFile(join(root, "a-space-rebuild-audit.ndjson"), "utf8")).trim().split("\n");
    assert.equal(JSON.parse(lines[1]).decision, "ALLOWLIST");
    assert.equal(JSON.parse(lines[1]).outcome, "CLAIMED");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("#33: the claim template is standalone, claims by name and verifies agent ownership", async () => {
  const source = await readFile(new URL("../monitor/claim-space.template.mjs", import.meta.url), "utf8");
  assert.match(source, /claimTaskSpace\(target\.id\)/);
  assert.match(source, /ownership !== "agent"/);
  assert.match(source, /RESULT=SPACE_CLAIMED_ACCOUNT_VERIFIED/);
  assert.match(source, /TASKSPACE_NOT_FOUND/);
  // Standalone: no monitor-module imports, no monitor-dir adapter (space-level action).
  assert.doesNotMatch(source, /dispatch-state\.mjs|agent-space\.mjs|REPLACE_WITH_DEPLOY_MONITOR_DIR/);
  const p = parseArgs(["claim", "--monitor-dir", ".monitor", "--agent-id", "gdc-a", "--space", "GDC-执行A"]);
  const adapted = adaptTemplate(source, p);
  assert.match(adapted, /const SPACE = "GDC-执行A";/);
  assert.doesNotMatch(adapted, /REPLACE_WITH_/);
});

test("#33: takeover-classified failures announce the hand-back/claim operator guidance", () => {
  const takeover = { code: 1, result: "EGO_TASKSPACE_TAKEOVER_REQUIRED", output: "RESULT=EGO_TASKSPACE_TAKEOVER_REQUIRED\n" };
  const notOwned = { code: 1, result: "TASKSPACE_RECOVERY_FAILED", detail: null,
    output: "RECOVERY_DETAIL=TASKSPACE_NOT_AGENT_OWNED\nRESULT=TASKSPACE_RECOVERY_FAILED\n" };
  const wrapped = { code: 2, result: null, detail: "Error: You now control this task space" };
  const plain = { code: 1, result: "STOP", output: "RESULT=STOP\n" };
  assert.equal(taskspaceOwnershipLost(takeover), true);
  assert.equal(taskspaceOwnershipLost(notOwned), true);
  assert.equal(taskspaceOwnershipLost(wrapped), true);
  assert.equal(taskspaceOwnershipLost(plain), false);
  assert.equal(taskspaceOwnershipLost(null), false);
  assert.equal(taskspaceOwnershipLost({ code: 1, result: "TASKSPACE_NOT_FOUND" }), false);
  const guidance = taskspaceOperatorAction("GDC-执行A");
  assert.match(guidance, /^OPERATOR_ACTION=/);
  assert.match(guidance, /交还给 Agent/);
  assert.match(guidance, /dispatch-manager\.mjs claim 受管认领/);
  assert.match(guidance, /GDC-执行A/);
  const errors = [];
  const originalError = console.error;
  console.error = (line) => errors.push(String(line));
  try {
    assert.equal(announceTaskspaceOwnershipLoss(notOwned, "GDC-执行A"), true);
    assert.equal(announceTaskspaceOwnershipLoss(plain, "GDC-执行A"), false);
  } finally { console.error = originalError; }
  assert.equal(errors.length, 1);
  assert.match(errors[0], /OPERATOR_ACTION=/);
  assert.match(errors[0], /交还/);
  assert.match(errors[0], /claim 受管认领/);
});

test("#33: the manager wires takeover guidance into send-family and collect failures", async () => {
  const source = await readFile(new URL("../monitor/dispatch-manager.mjs", import.meta.url), "utf8");
  assert.match(source,
    /if \(observation\.code !== 0 && p\.action !== "probe"\) \{\s*\n\s*announceTaskspaceOwnershipLoss\(observation, p\.space\);/);
  const collect = source.slice(source.indexOf("async function collectCompleted"), source.indexOf("export async function releaseDelivered"));
  assert.match(collect, /announceTaskspaceOwnershipLoss\(observation, params\.space\)/);
  // The probe announces guidance itself at its two takeover exits; the rebuild
  // template does the same at its EGO_TASKSPACE_TAKEOVER_REQUIRED stops.
  const probe = await readFile(new URL("../monitor/ego-fast-probe.mjs", import.meta.url), "utf8");
  assert.match(probe, /if \(isTaskspaceOwnershipLoss\(error\)\) console\.log\(taskspaceOperatorAction\(SPACE\)\);/);
  assert.equal((probe.match(/taskspaceOperatorAction\(SPACE\)/g) || []).length, 2);
  const rebuild = await readFile(new URL("../monitor/rebuild-space.template.mjs", import.meta.url), "utf8");
  assert.equal((rebuild.match(/takeoverOperatorAction\(\);/g) || []).length, 2);
  assert.match(rebuild, /OPERATOR_ACTION=ego 空间/);
});

test("#33: dispatch record accepts optional doneLive fields and rejects wrong types", () => {
  const base = { schema: "ego-dispatch-state/v2", dispatchId: uuid, conversationUuid: uuid,
    taskSpace: "GDC-执行A", pageLabel: "p1", status: "ACCEPTED", baselineTailKey: null,
    baselineTailRole: null, baselineComposerLength: 0, attempt: 1, createdAt: Date.now(),
    payload_sha256: sha256("任务") };
  assert.equal(validateDispatchRecord(base), true);
  assert.equal(validateDispatchRecord({ ...base, doneLiveBodyLen: 10338,
    doneLiveLastMessageKey: "22222222-2222-4222-8222-222222222222" }), true);
  assert.equal(validateDispatchRecord({ ...base, doneLiveBodyLen: 0, doneLiveLastMessageKey: null }), true);
  assert.equal(validateDispatchRecord({ ...base, doneLiveBodyLen: -1 }), false);
  assert.equal(validateDispatchRecord({ ...base, doneLiveBodyLen: "10338" }), false);
  assert.equal(validateDispatchRecord({ ...base, doneLiveBodyLen: 1.5 }), false);
  assert.equal(validateDispatchRecord({ ...base, doneLiveLastMessageKey: 42 }), false);
});

test("#33: DONE_CANDIDATE live-window evidence lands in the dispatch record only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ego-done-candidate-"));
  const scratch = await mkdtemp(join(tmpdir(), "ego-done-untracked-"));
  try {
    const record = { schema: "ego-dispatch-state/v2", dispatchId: uuid, conversationUuid: uuid,
      taskSpace: "GDC-执行A", pageLabel: "p1", status: "ACCEPTED", baselineTailKey: null,
      baselineTailRole: null, baselineComposerLength: 0, attempt: 1, createdAt: Date.now(),
      payload_sha256: sha256("任务") };
    await writeFile(join(dir, "a-dispatch-state.json"), JSON.stringify(record));
    const next = await markDoneCandidate(dir, uuid, { bodyLen: 10338, lastMessageKey: "22222222-2222-4222-8222-222222222222" });
    assert.equal(next.doneLiveBodyLen, 10338);
    assert.equal(next.status, "ACCEPTED");
    const stored = await readDispatchState(dir);
    assert.equal(stored.doneLiveBodyLen, 10338);
    assert.equal(stored.doneLiveLastMessageKey, "22222222-2222-4222-8222-222222222222");
    // Missing evidence normalizes to null without failing.
    await markDoneCandidate(dir, uuid, { bodyLen: undefined, lastMessageKey: 5 });
    assert.equal((await readDispatchState(dir)).doneLiveBodyLen, null);
    assert.equal((await readDispatchState(dir)).doneLiveLastMessageKey, null);
    // An unknown dispatch id or untracked directory is skipped silently.
    assert.equal(await markDoneCandidate(dir, "22222222-2222-4222-8222-222222222222", { bodyLen: 10 }), null);
    assert.equal(await markDoneCandidate(scratch, uuid, { bodyLen: 10 }), null);
    await assert.rejects(readFile(join(scratch, "a-dispatch-state.json")), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
});

test("#33: API finality evidence exposes end_turn/status without relaxing extraction", () => {
  const payload = sha256("任务原文");
  const message = (role, text, endTurn, status) => ({ author: { role }, content: { parts: [text] },
    end_turn: endTurn, status });
  const branch = { current_node: "final", mapping: {
    root: { parent: null },
    user: { parent: "root", message: message("user", "任务原文", true, "finished_successfully") },
    final: { parent: "user", message: message("assistant", "死亡回复", false, "in_progress") },
  } };
  assert.deepEqual(apiTailFinality(branch, payload), { endTurn: false, status: "in_progress" });
  assert.deepEqual(apiTailFinality({ ...branch, mapping: { ...branch.mapping,
    final: { parent: "user", message: message("assistant", "完成", true, "finished_successfully") } } }, payload),
    { endTurn: true, status: "finished_successfully" });
  // A dead reply still never passes extraction, and an unprovable branch yields null.
  assert.equal(extractApiReply(branch, payload), null);
  assert.equal(apiTailFinality({ ...branch, current_node: "missing" }, payload), null);
});

test("#33: the probe freezes doneLive evidence into the dispatch record at DONE_CANDIDATE", async () => {
  const source = await readFile(new URL("../monitor/ego-fast-probe.mjs", import.meta.url), "utf8");
  const done = source.slice(source.indexOf('await appendEvent(MON, "DONE_CANDIDATE"'), source.indexOf("TRANSITION_GENERATING_TO_IDLE_CONFIRMED"));
  assert.match(done, /markDoneCandidate\(MON, dispatchId, \{ bodyLen: second\.bodyLen, lastMessageKey: second\.lastMessageKey \}\)/);
});

test("#33: collect failures are classified with post-mortem details and operator guidance", async () => {
  const source = await readFile(new URL("../monitor/collect-reply.template.mjs", import.meta.url), "utf8");
  assert.match(source, /COLLECT_DOM_ANCHOR_MISS payloadBytes=/);
  assert.match(source, /COLLECT_API_FETCH_NULL stage=/);
  assert.match(source, /COLLECT_FINALITY_NOT_REACHED end_turn=/);
  assert.match(source, /REPLY_GENERATION_DIED_SERVER_SIDE suspicion=live_had_more/);
  assert.match(source, /record\.doneLiveBodyLen/);
  assert.match(source, /OPERATOR_ACTION=回复疑似服务端生成中断/);
  assert.match(source, /OPERATOR_ACTION=回复边界或终态未获证明/);
  // The in-page fetch catch must log a diagnostic line instead of returning null silently.
  assert.match(source, /catch \(error\) \{\s*\n\s*\/\/ Surface the failure through the page console[\s\S]*?console\.error\("COLLECT_API_FETCH stage=exception/);
  // The boundary failure exits through a classified RESULT, never a bare throw.
  assert.match(source, /console\.log\("RESULT=COLLECT_BOUNDARY_OR_FINALITY_UNVERIFIED"\)/);
  assert.doesNotMatch(source, /throw new Error\("COLLECT_BOUNDARY_OR_FINALITY_UNVERIFIED"\)/);
});

// ---- #27 Batch 2: TaskSpace ownership governance (V1: naming + probe owner
// log + managed release sweep + claim attribution audit) ----

test("#27 B2: the frozen naming convention gates NEW-space creation only", async () => {
  const agent = "gdc-b1-planner"; // contains dashes: the literal is regex-anchored
  // Legal names pass (project/purpose exclude dashes, so AGENT_ID is unambiguous).
  assert.equal(isValidNewTaskSpaceName("agentkit-dispatch-gdc-b1-planner-20261116", agent), true);
  assert.equal(isValidNewTaskSpaceName("agentkit.fix-db_sync-gdc-b1-planner-20261116", agent), true);
  // Missing / wrong AGENT_ID is rejected (ruling: AGENT_ID is mandatory and stable).
  assert.equal(isValidNewTaskSpaceName("agentkit-dispatch-20261116", agent), false);
  assert.equal(isValidNewTaskSpaceName("agentkit-dispatch-other-agent-20261116", agent), false);
  assert.equal(isValidNewTaskSpaceName("agentkit-dispatch-gdc-b1-planner-2026", agent), false);
  assert.equal(isValidNewTaskSpaceName("agentkit-dispatch-gdc-b1-planner-2026111", agent), false);
  assert.equal(isValidNewTaskSpaceName("-dispatch-gdc-b1-planner-20261116", agent), false);
  assert.equal(isValidNewTaskSpaceName("agentkit--gdc-b1-planner-20261116", agent), false);
  assert.equal(isValidNewTaskSpaceName("x".repeat(115) + "-20261116", agent), false);
  assert.equal(isValidNewTaskSpaceName("", agent), false);
  assert.equal(isValidNewTaskSpaceName("agentkit-dispatch-gdc-b1-planner-20261116", ""), false);
  // Legacy space names fail the NEW-creation rule BY DESIGN — but are never
  // renamed: reuse and rebuild paths never call the validator.
  assert.equal(isValidNewTaskSpaceName("GDC-执行A", agent), false);
  const probe = await readFile(new URL("../monitor/ego-fast-probe.mjs", import.meta.url), "utf8");
  const round = await readFile(new URL("../skills/chatgpt-web-dispatch/templates/dispatch-round.template.mjs", import.meta.url), "utf8");
  const rebuild = await readFile(new URL("../monitor/rebuild-space.template.mjs", import.meta.url), "utf8");
  // Both creation branches fail closed immediately before the creation call.
  assert.match(probe, /if \(!isValidNewTaskSpaceName\(SPACE, AGENT_ID\)\) throw new Error\("TASKSPACE_NAMING_VIOLATION_STOP"\);\s*\n\s*task = await taskSpace\(SPACE, \{ profileId: pinnedProfileId \}\)/);
  assert.match(round, /if \(!isValidNewTaskSpaceName\(SPACE, AGENT_ID\)\) abort\("TASKSPACE_NAMING_VIOLATION_STOP"\);\s*\n\s*task = await taskSpace\(SPACE, \{ profileId: profileCfg\.defaultProfileId \}\)/);
  // The violation keeps its own code instead of being masked as a registry loss.
  assert.match(probe, /error\?\.message === "TASKSPACE_NAMING_VIOLATION_STOP" \? "TASKSPACE_NAMING_VIOLATION_STOP"/);
  // re-review P1-1: the shared pre-claim gate runs BEFORE claimAgentSpace in
  // both entry points, after the read-only existence check — a violating new
  // name can never reach the registry (behavioral coverage in
  // tests/release-sweep.test.mjs).
  assert.match(probe, /const spaceExists = existingSpaces\.some\(\(space\) => space\.taskId === SPACE \|\| space\.name === SPACE\);\s*\n\s*assertTaskSpaceNamingAllowed\(SPACE, AGENT_ID, spaceExists\);\s*\n\s*await claimAgentSpace\(\{ agentId: AGENT_ID, spaceName: SPACE \}\);/);
  assert.match(round, /const spaceExists = existingSpaces\.some\(\(space\) => space\.taskId === SPACE \|\| space\.name === SPACE\);\s*\n\s*assertTaskSpaceNamingAllowed\(SPACE, AGENT_ID, spaceExists\);\s*\n\s*await claimAgentSpace\(\{ agentId: AGENT_ID, spaceName: SPACE \}\);/);
  // The legacy recovery path has NO naming gate: old spaces are recovered under
  // their proven original names (registry loss → managed rebuild-space).
  assert.doesNotMatch(rebuild, /isValidNewTaskSpaceName|TASKSPACE_NAMING/);
});

test("#27 B2: the probe boot line announces the stable Owner next to the space", async () => {
  const probe = await readFile(new URL("../monitor/ego-fast-probe.mjs", import.meta.url), "utf8");
  // Same space-separated frozen format; owner is the adapted stable AGENT_ID.
  assert.match(probe, /PROBE_BOOT version=\$\{PROBE_VERSION\} space=\$\{SPACE\} mon=\$\{MON\} owner=\$\{AGENT_ID\}/);
});

test("#27 B2: the release sweep keeps the conservative boundary and reports truthfully", async () => {
  const unit = await readFile(new URL("../monitor/release-sweep.mjs", import.meta.url), "utf8");
  // P1-4 unification: terminal = schema-validated terminal statuses only.
  // "RELEASED" is not a real ledger state (nothing writes it and
  // validateDispatchRecord rejects it) — the sweep set narrowed instead of
  // loosening the frozen dispatch-state v2 validator.
  assert.match(unit, /const TERMINAL_DISPATCH = new Set\(\["COMPLETED", "ABORTED"\]\)/);
  assert.match(unit, /validateDispatchRecord\(record\)/);
  assert.match(unit, /record\.conversationUuid\.toLowerCase\(\) !== String\(uuid\)\.toLowerCase\(\)/);
  assert.match(unit, /record\.taskSpace !== space/);
  // Conservative boundary: closed only provably finished pages of THIS agent.
  assert.match(unit, /TEMP_RESULT_PAGE_FINISHED_DISPATCH/);
  assert.match(unit, /ACTIVE_DISPATCH_LEDGER/);
  assert.match(unit, /LEDGER_UNPROVEN/);
  assert.match(unit, /OWNERSHIP_UNPROVEN/);
  assert.match(unit, /RELEASE_TARGET_RESIDUAL/);
  assert.match(unit, /PAGE_CLOSE_FAILED:/);
  assert.match(unit, /PAGE_ENUMERATION_FAILED/);
  // The TaskSpace itself is never deleted by the sweep.
  assert.doesNotMatch(unit, /deleteTaskSpace|removeTaskSpace/);
  // P1-2: finish applies only to a provably empty space; P1-3: the early exit
  // requires no outstanding sweep.
  assert.match(unit, /finished && hasTask && kept === 0 && failed === 0/);
  assert.match(unit, /!entry\.releasePending && !entry\.sweepPending/);
  const template = await readFile(new URL("../monitor/release-agent-space.template.mjs", import.meta.url), "utf8");
  // P1-2: the managed finish closes ONLY the release-target page — no blanket
  // task.finish({keep:[]}) that would destroy pages the boundary must keep.
  assert.match(template, /finishSpace: async \(entry\) => \{\s*\n\s*if \(!task \|\| \(!target && !entry\.releasePending\?\.finished\)\) throw new Error\("COMPLETED_SPACE_NOT_FOUND"\);\s*\n\s*if \(target\) await target\.close\(\);\s*\n\s*\},/);
  // The space fate is decided by the injectable gate, never unconditionally.
  assert.match(template, /if \(shouldFinishSpace\(\{ finished: result\.finished, hasTask: Boolean\(task\), kept: sweep\.kept, failed: sweep\.failed \}\)\)/);
  // P1-3: intent-first — sweepPending is recorded BEFORE the browser release,
  // and cleared only in the all-success branch; the failure branch keeps it.
  assert.ok(template.indexOf("await markAgentSweepPending(") < template.indexOf("const result = await releaseAgentConversation("),
    "sweepPending must be marked before the browser release");
  const tail = template.slice(template.indexOf("if (sweep.failed > 0 || sweep.unconfirmed > 0) {"));
  assert.match(tail, /RESULT=AGENT_SPACE_RELEASE_SWEEP_FAILED closed=\$\{sweep\.closed\} kept=\$\{sweep\.kept\} failed=\$\{sweep\.failed\}/);
  assert.ok(tail.indexOf("await clearAgentSweepPending(") > tail.indexOf("} else {"),
    "clearAgentSweepPending must live in the success branch only");
  const failedBranch = tail.slice(0, tail.indexOf("} else {"));
  assert.doesNotMatch(failedBranch, /clearAgentSweepPending/);
  // A sweepPending rerun with the space already gone is the normal recovery
  // shape; TASKSPACE_NOT_FOUND only fires when nothing justifies the absence.
  assert.match(template, /!assigned\.sweepPending\) \{\s*\n\s*throw new Error\("TASKSPACE_NOT_FOUND"\);/);
  // Idempotency: the registry early-exit path (repeat release) stays a
  // zero-close success with zero browser calls.
  const early = template.slice(template.indexOf("releaseHasNothingOutstanding(assigned, CONV)"), template.indexOf("const spaces = await listTaskSpaces();"));
  assert.match(early, /RESULT=AGENT_SPACE_RELEASED/);
  assert.doesNotMatch(early, /task\.pages|page\.close|finish\(|listTaskSpaces/);
  // Manager wiring: the sweep failure is classified exit 2 with operator guidance,
  // and the new module ships through ensureMonitor's managed copies.
  const manager = await readFile(new URL("../monitor/dispatch-manager.mjs", import.meta.url), "utf8");
  assert.match(manager, /if \(released\.result === "AGENT_SPACE_RELEASE_SWEEP_FAILED"\)/);
  assert.match(manager, /OPERATOR_ACTION=release 临时页清理未完整完成/);
  assert.match(manager, /if \(p\.action === "release" && observation\.result === "AGENT_SPACE_RELEASE_SWEEP_FAILED"\)/);
  assert.match(manager, /"release-sweep\.mjs"/);
});

test("#27 B2: claim audit rows carry owner attribution without touching the #33 chain", async () => {
  const root = await mkdtemp(join(tmpdir(), "ego-claim-owner-"));
  try {
    await withAgentRegistry((registry) => {
      registry.agents["gdc-a"] = { spaceName: "GDC-执行A", active: [], known: [] };
      return { changed: true };
    }, root);
    const p = parseArgs(["claim", "--monitor-dir", root, "--agent-id", "gdc-a", "--space", "GDC-执行A"]);
    // The template's post-claim registry readback feeds the owner fields.
    assert.equal(await claimSpace(p, {
      directory: root,
      runScript: async () => ({ code: 0, result: "SPACE_CLAIMED_ACCOUNT_VERIFIED",
        output: "probe noise\nSPACE_CLAIMED_TASK_ID=t-123 SPACE_CLAIMED_TASK_NAME=GDC-执行A\n" }),
    }), 0);
    const claimed = JSON.parse((await readFile(join(root, "a-space-rebuild-audit.ndjson"), "utf8")).trim().split("\n").at(-1));
    assert.equal(claimed.ownerAgentId, "gdc-a");
    assert.equal(claimed.taskSpaceId, "t-123");
    assert.equal(claimed.taskSpaceName, "GDC-执行A");
    assert.equal(claimed.conversation, null); // a claim has no conversation ledger
    // Missing readback evidence stays null (never invented).
    assert.equal(await claimSpace(p, {
      directory: root,
      runScript: async () => ({ code: 0, result: "SPACE_CLAIMED_ACCOUNT_VERIFIED" }),
    }), 0);
    const again = JSON.parse((await readFile(join(root, "a-space-rebuild-audit.ndjson"), "utf8")).trim().split("\n").at(-1));
    assert.equal(again.ownerAgentId, "gdc-a");
    assert.equal(again.taskSpaceId, null);
    assert.equal(again.taskSpaceName, null);
    assert.equal(again.conversation, null);
    // The template exposes the claimed identity for the manager to audit, and
    // only when ego actually reported it.
    const template = await readFile(new URL("../monitor/claim-space.template.mjs", import.meta.url), "utf8");
    assert.match(template, /SPACE_CLAIMED_TASK_ID=/);
    assert.match(template, /SPACE_CLAIMED_TASK_NAME=/);
    assert.match(template, /if \(claimed\.taskId\)/);
    assert.match(template, /if \(claimed\.name\)/);
    // Boundary (ruling §3.4): the owner fields live ONLY in audit rows — the
    // #33 authorization chain keeps its original evidence order untouched.
    const source = await readFile(new URL("../monitor/dispatch-manager.mjs", import.meta.url), "utf8");
    const authorize = source.slice(source.indexOf("export async function authorizeSpaceRebuild"), source.indexOf("export async function rebuildSpace"));
    assert.match(authorize, /SPACE_REBUILD_AGENT_BOUND_TO_OTHER_SPACE/);
    assert.match(authorize, /SPACE_OWNED_BY_ANOTHER_AGENT/);
    assert.match(authorize, /AGENT_SPACE_RELEASE_PENDING/);
    assert.match(authorize, /spaceRebuildAllowlist/);
    assert.match(authorize, /SPACE_REBUILD_NOT_AUTHORIZED/);
    assert.doesNotMatch(authorize, /ownerAgentId|taskSpaceId|taskSpaceName/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
