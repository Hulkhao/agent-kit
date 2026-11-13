import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeFastState } from "../monitor/state-schema.mjs";
import { tick, acknowledge } from "../monitor/supervision-watchdog.mjs";
import { shouldReviewStartupIdle } from "../monitor/supervision-policy.mjs";
import { parseArgs, adaptTemplate, bindNewConversation, classifyManagerResult, loadAttachments, requireArmedDispatch, main } from "../monitor/dispatch-manager.mjs";
import { checkDispatchTool } from "../plugins/chatgpt-dispatch-guard/hooks/policy.mjs";
import { installConfig, install } from "../monitor/install-zcode-guard.mjs";
import { extractDomReply, extractApiReply, saveReply, verifiedReply, acknowledgeReply, verifiedConsumption, sha256, visibleTextHash } from "../monitor/reply-delivery.mjs";
import { dispatchStormGate, markCompleted, readDispatchState, verifyAttachmentEvidence } from "../monitor/dispatch-state.mjs";

const uuid = "11111111-1111-4111-8111-111111111111";

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
