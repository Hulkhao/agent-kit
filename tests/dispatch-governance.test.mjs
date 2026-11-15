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
import { parseArgs, adaptTemplate, bindNewConversation, classifyManagerResult, loadAttachments, requireArmedDispatch, main, readEgoOutcome, ensureMonitor, authorizeSpaceRebuild, rebuildSpace, exitWatching, acknowledgeWake, releaseDelivered } from "../monitor/dispatch-manager.mjs";
import { withAgentRegistry } from "../monitor/agent-space.mjs";
import { checkDispatchTool } from "../plugins/chatgpt-dispatch-guard/hooks/policy.mjs";
import { installConfig, install } from "../monitor/install-zcode-guard.mjs";
import { extractDomReply, extractApiReply, saveReply, verifiedReply, acknowledgeReply, verifiedConsumption, sha256, visibleTextHash } from "../monitor/reply-delivery.mjs";
import { dispatchStormGate, markCompleted, readDispatchState, verifyAttachmentEvidence } from "../monitor/dispatch-state.mjs";

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
    assert.equal(result.hooks.events.PreToolUse[1].hooks[0].command, "node");
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
    { type: "process", command: "node", args: ["C:/agent-kit/plugins/chatgpt-dispatch-guard/hooks/pre-tool-use.mjs"], timeoutMs: 5000 },
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
    assert.ok(logs.some((line) => line.startsWith("RESULT=WATCH_EXCEPTION code=EISDIR wakeId=")),
      "wake line must announce WATCH_EXCEPTION with the failing ensureMonitor code: " + JSON.stringify(logs));
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
