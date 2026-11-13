# ZCode 回执监控与 Codex 按需接棒

本能力按**单次任务需要**手动启动。2026-11-13 已撤销 `Codex-ZCode-Reply-Watcher` Windows 登录计划任务。平时不运行，也不注册计划任务。

## 启动与停止

在 Windows PowerShell 中进入 `C:\Users\haohao\agent-kit`，派单前或等待新回执时启动：

```powershell
pwsh -File .\monitor\start-zcode-reply-watcher.ps1 -ThreadId <现有 Codex 会话 UUID>
```

默认目录 `D:\Downloads\zcode-codex交流\replies\`，每 5 秒扫描，检测回执完成后等待 120 秒。监听进程占用当前终端，按 `Ctrl+C` 停止。可用 `-Folder <目录>` 和 `-DelaySeconds <秒数>` 改变参数，启动脚本仅调用 Node 监听器。

若已有 `CODEX_THREAD_ID` 环境变量，`-ThreadId` 可省略。必须指定**要继续开发的原 Codex 会话 UUID**，避免向其他会话派发消息。底层监听器位于 `monitor/watch-zcode-replies.mjs`。

在 `app-server daemon` 无法运行、但已有独立 WebSocket `app-server` 的主机，可传入 `-CodexRemote ws://127.0.0.1:31173`。Codex CLI 不在 `PATH` 时，再用 `-CodexPath <codex.exe 完整路径>` 指定。启动前确认对应 WebSocket 服务已运行。

## 工作方式

1. ZCode 一旦认领新请求，先立即写 `replies/<请求名>.ack.md.tmp`，内容包含请求名、接单时间和执行者，末行独占 `ACK`，然后原子改名为 `<请求名>.ack.md`。写好 ACK 才开始耗时任务。接单 ACK 表示已收到且开始处理，不代表任务完成。
2. 监听器每 5 秒扫描 ACK，见到新文件立即记录 `ACK_RECEIVED`，按内容哈希去重，不触发 Codex 模型接棒，也不启动两分钟计时。若 ACK 缺失，可判定接收状态尚未证实。
3. ZCode 完成后将正式交付写至 `replies/<请求名>.reply.md`，先写临时文件再原子改名，末行独占 `DONE`。首次启动将**已存在**的完整回执记为基线，不重复派发。启动后新增或修改的完整回执，计时约两分钟。
   如更正回执文件名并移走旧文件，监听器会将尚未派送的旧文件标记为 `superseded`，只派送仍存在的完整回执，避免改名造成重复通知。
4. 到期后汇总待处理回执，执行 `codex queue --thread <UUID> --message <接棒通知> --resume`。通知要求会话读取回执和对应请求，核对证据后继续开发。队列或恢复是否真正运行，以 Codex 宿主结果为准。
5. 状态及日志保存在 `%LOCALAPPDATA%\agent-kit\codex-zcode-replies-<UUID>.json` 及同名 `.log`，按会话区分。相同内容哈希重复扫描不会重复派发。

回执可见并不等于成功唤醒。队列失败会记录 `QUEUE_FAILED` 和 `failed` 状态，并停止监控，**不会无条件重试**。出现 `QUEUE_UNCERTAIN`、`queued_unwoken` 等情况时先查 Codex 会话是否已经收到消息，确认后再人工处理状态，避免二次派发。每次接棒后续工作仍遵循当前任务的授权与验收条件。

## 2026-11-13 实测记录

- Node 测试 `node --test monitor/test-watch-zcode-replies.mjs`，覆盖接单 ACK、基线、临时文件过滤、末行 DONE、两分钟延迟、批量接棒、进程重启去重与队列异常留痕。测试中的 `queue` 为模拟函数。
- Codex 26.1106 CLI 提供 `codex queue --thread ... --message ... --resume`。使用不存在的会话 ID 时，CLI 返回 `no rollout found`，证明命令链可到达本机线程存储。
- 真实 app-server `daemon start` 在本次受限宿主执行时报 `start the Windows daemon from a non-elevated terminal`。因此**不在监听脚本启动时强制执行 daemon start**。
- 先前安装的 Windows 计划任务启动失败，日志中有上述 daemon 错误。用户要求按需调用后，已撤销计划任务并改用手动入口。
- **尚未验证**真实 ZCode 新回执触发 `queue --resume` 后，原 Codex 会话自动恢复并完成下一轮开发。只有观察到原会话实际继续工作，才可将这一项标为端到端 PASS。

## 再次启用时的验收

在实际需要接棒的任务里，先启动监听器，再派一条新请求。等待 ZCode 原子写入 `replies/<请求名>.reply.md` 并以 `DONE` 结束，随后核对 `.log` 是否依次出现 `REPLY_FOUND` 和 `QUEUED_RESUME_REQUESTED`，最后查看原 Codex 会话是否真实收到消息、读取对应回执且继续处理任务。若 Codex CLI 报错，以错误内容排查，不以日志中的 `QUEUED_RESUME_REQUESTED` 单独宣布成功。
