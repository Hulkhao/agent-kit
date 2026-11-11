# agent-kit — 跨机同步的 Agent 技能包

多台电脑同步 ZCode skills 的唯一真源仓库。当前收录：

- `skills/chatgpt-web-dispatch/` — ChatGPT 网页派单工作流（入口 SKILL.md + 唯一真源手册 `references/EGO-LITE-HANDBOOK.md`）

## 铁律

- **只改本仓库**：各机 `~/.agents/skills/` 下是 `deploy.ps1` 生成的部署副本，禁止直接改。
- 手册/skill 改动流程：仓库内修改 → `git add -A && git commit` → `git push` → 各机 `git pull` → `pwsh -File deploy.ps1`。

## 新机器首次接入

1. `git clone <远端地址> agent-kit`
2. `pwsh -File agent-kit\deploy.ps1`（装到全局公用 `~/.agents/skills`，ZCode 及其他 Agent CLI 均从此读取；如某工具只读 `~/.zcode/skills` 加 `-AlsoZCode`）
3. 新开 ZCode 会话，skill 列表应出现 `chatgpt-web-dispatch`
4. 浏览器自动化另需：安装 ego lite（手册 §10），并跑一次 `ego-browser skill`

## 远端设置（一次性，PO 填私有地址）

```
git remote add origin <私有仓库地址>
git push -u origin master
```

## ChatGPT 网页派单统一入口

`monitor/dispatch-manager.mjs` 提供 `send`、`send-new`、`probe`、`watch`、`collect`、`consume`、`release` 和 `ack`。每个 Agent 用固定 `--agent-id` 与可读中文 `--space`，每个会话用 `--conversation`（UUID）隔离账本、回复及监控状态。`send` 还需 `--message` 指向任务文件。新聊天使用 `send-new --request-id <新请求UUID> --message <文件路径>`，由管理器返回实际会话 UUID。同一请求只能以同一身份与正文哈希恢复绑定，禁止盲目重发。

```powershell
node monitor/dispatch-manager.mjs watch --monitor-dir <项目监控目录> --agent-id gdc-exec-a --space GDC-本地执行A --conversation <会话UUID>
```

以受管任务启动 `watch`，内置每分钟 DOM 快探测与监督判定。监控目录的 `conversations/<UUID>/supervision.config.json` 可设置 `supervisionMinutes`（默认 10）和 `maxAbnormalRounds`（默认 3）。收到 `REPLY_READY_WAKE_SUPERVISOR` 后，Agent 执行 `collect`，读取并交付完整回执，再用 `consume --reply-sha256 <回执SHA256>` 确认，最后执行 `release` 关闭任务 Page。接棒者完成异常复核后用 `ack --wake-id <ID> --ack-action investigated` 确认，问题已解决则用 `resolved`。ZCode 强制入口由 `deploy.ps1` 安装 PreToolUse Hook，`-SkipZCodeGuard` 可跳过。

退出码和 `WAKE_SUPERVISOR` 输出需要宿主实际转交给 Agent 才构成唤醒。未验证宿主退出通知时，不能声称已完成自动接棒。

## ChatGPT 网页派单治理目标与复核表

以下六项是本 Skill 的**长期验收合同**。Skill 维护 Agent 在修改派单逻辑、处理相关 Issue、准备发布时逐项复核；使用本 Skill 的 Agent 在实际运行中发现偏差时按表取证并上报。每项只按**可复现的行为与证据**判定，不以代码存在、测试用例通过或 Agent 自述代替端到端结果。

| 目标 | 现场检查与通过条件 | 不满足时的动作 |
| --- | --- | --- |
| **1. 空间管理** | 同一 `AGENT_ID` 始终认领一个归属明确、中文可读的 TaskSpace；多个任务使用独立 Page；完成后只释放该任务 Page，最后一个任务结束才回收空间。核查所有权登记和实际 Page 列表。 | 发现重复空间、错领空间或残留 Page，停止自动回收，记录归属与现场并报 Issue。 |
| **2. 强制执行** | ZCode 实机验证 PreToolUse Hook 能拦截绕过统一入口的 ChatGPT 网页操作，允许管理器合法操作，且原有 Hook 正常工作；核查工具权限与部署配置。 | 拦截失效或误拦截，保留复现命令和 Hook 判定，报 Issue 并阻止将强制入口标记为通过。 |
| **3. 可靠派单** | 通过统一管理器验证发送前后回读、持久账本、恢复、完整回复提取、交付确认和释放；发送状态不确定时不重复发送，也不覆盖用户草稿。核查每轮日志、会话 UUID 和回复哈希。 | 任一环节缺乏确认，保留现场、停止该轮后续写操作，先判定根因再恢复。 |
| **4. 自动监控** | 受管 `watch` 每分钟轻量探测页面；正常观察期间无模型调用和 Token 消耗；页面刷新、任务切换后仍能关联正确会话。核查轮询记录及模型调用记录。 | 轮询漏检、串会话或额外消耗 Token，记录发生时间及监控状态并报 Issue。 |
| **5. 智能介入** | 默认观察窗口 10 分钟，可通过 `supervisionMinutes` 调整；只在停滞、证据矛盾或无法判断时触发 Agent 复核，正常持续产出的长任务保持运行。核查进展时间戳、告警原因和宿主实际接棒记录。 | 误唤醒、漏唤醒或无法证实接棒，留存监控事件与宿主记录并报 Issue。 |
| **6. 异常升级** | 每轮复核后重新观察；连续三轮无有效进展才标记需通知 PO；有新进展即重置计数，正常长任务持续监控。核查三轮时间线与升级标记。**外部聊天/邮件通知仍为后续事项。** | 提前升级、漏升级或错误重置时，保留连续轮次记录并报 Issue。 |

**复核输出**：记录版本/commit、使用的 Agent 与会话、六项各自的 `PASS / FAIL / 未验证`、对应日志或测试链接，以及未通过项的 GitHub Issue。缺少实机证据的项目填写「未验证」；修复后针对失败路径复测，再更新 Issue。参考具体操作和故障处理规范见 `skills/chatgpt-web-dispatch/SKILL.md` 与 `skills/chatgpt-web-dispatch/references/EGO-LITE-HANDBOOK.md`。
