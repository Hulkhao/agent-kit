---
name: chatgpt-web-dispatch
description: 两人项目组的 ChatGPT 网页派单工作流（ego-browser）——GitHub 优先交接材料、双循环监控与异常接管、回复提取、会话迁移、GitHub Issues 反馈。凡涉及 chatgpt.com 会话派单、监控、提取、迁移或故障上报必读本 skill。Use for ChatGPT web dispatch, GitHub handoff, reply monitoring, recovery, and issue reporting.
metadata:
  version: "1.7.0"
  date: "2026-11-11"
---

# ChatGPT 网页派单（ego-browser 工作流）

任何 ChatGPT 网页派单/监控/提取/迁移任务，动手前必做三件事：

1. **开工前自检更新（每次任务前）**：`cd` 本机 agent-kit 仓库 → `git pull` → 若有新提交则跑 `deploy.ps1` 并重读部署副本（新会话自动生效）。**只在任务边界更新**——值守循环运行中禁止热更新（监控脚本换文件会让运行中循环行为不一致）。远程/同事机器同样适用：仓库地址 `github.com/Hulkhao/agent-kit`，pull + deploy 即完成更新，无需等通知。
2. **通读本 skill 目录下的唯一真源手册 `references/EGO-LITE-HANDBOOK.md`**——派单（§3.1）、GitHub 交接（§3.2）、故障与应急（§5）、双循环监控和接棒（§6）、Issues 上报（§9.1）、统一参数（§7）。细则与参数一律以手册为准。
3. **跑 `ego-browser skill`** 获取与所装版本匹配的 API 指南（ego 升级后重跑；输出缺 `[ego-browser:skill] end of guide` 尾行 = 被截断，存文件分段读）。

维护口径：本 skill 随 agent-kit git 仓库多机同步；**改手册/skill 只改仓库内这一份**（各机全局公用 `~/.agents/skills/` 下是 `deploy.ps1` 生成的部署副本，勿直接改），改完 commit → push → 各机 pull + 重新 deploy。

**目标复核**：仓库根 `README.md` 的「ChatGPT 网页派单治理目标与复核表」是六项长期验收合同。实战发现异常时，对照相关项核查行为证据，按 §9.1 查重并报 Issue；维护 Agent 每次修复、发布前复核六项，逐项记录 `PASS / FAIL / 未验证` 与证据。未取得宿主实机回执的 Hook 拦截、Agent 唤醒与回复接棒均填「未验证」，不得只凭单元测试结案。

## 本机账号钉扎（ego-profile.json，PO 令 2026-11-08，首次使用本 skill 前必配）

**为什么**：`taskSpace(名字)` 按名字复用已存在的空间，ego 的 profileId 只在「创建空间」那一刻生效——复用一个早期用错账号建的空间，就会一直用那个账号跑（实测事故：复用了无会员账号的空间，整个会话静默跑在 mini 档，见 agent-kit#7）。所以账号必须本机钉死+使用前验证。

**配置（机器本地，绝不进仓库、绝不写真实邮箱进 Git）**：复制 `config/ego-profile.example.json` 到本机 `~/.agents/ego-profile.json`（Windows 即 `C:\Users\<你>\.agents\ego-profile.json`），填本机值：

- `defaultProfileId`：本机 ego 的 profile id（跑 `ego-profile-check.mjs` MODE=list 可列出，或 nodejs 里 `await profiles()`）；选登录了 ChatGPT Plus 的那个。
- `defaultAccount`：该 profile 应登录的账号邮箱——派单模板发送前会用它核对（`/api/auth/session`，每轮 1 次调用）。
- `spaceExpect`：个别空间要用其他账号时的覆盖项。

**行为口径**：本机没有该配置文件或字段缺失 → `ACCOUNT_CONFIG_MISSING_STOP` / `ACCOUNT_CONFIG_INCOMPLETE_STOP`，**立即停止报人，不猜测账号**；页面实测账号与钉扎不符 → `ACCOUNT_MISMATCH_STOP`。**新建空间**一律 `taskSpace(名字, { profileId })` 带上钉扎的 profile；**旧空间无法换账号**——核对不符只能换空间名重建或人工登录正确账号。

**TaskSpace 归属**：一个 Agent 固定一个空间，任务各占一个 Page；空间显示名可用中文（如 `GDC-本地执行A`），技术归属使用跨任务稳定的 `AGENT_ID`。派单、探测、监管、回复提取和释放统一通过 `monitor/dispatch-manager.mjs` 的 `send/send-new/probe/watch/collect/consume/release/ack` 执行；新会话 `send-new` 必须带稳定的 `--request-id`，返回真实会话 UUID 后使用该 UUID 监控。完成候选唤醒后，Agent `collect` 并读取完整回执，再 `consume --reply-sha256`，最后 `release`。同一 Agent 创建第二空间或抢用别人的空间直接 STOP。旧空间照原名复用，不擅自迁移。

校验工具：本仓库 `monitor/ego-profile-check.mjs`（`ego-browser nodejs < ego-profile-check.mjs`，MODE=list/init/verify，详见文件头注释）。

**#17 `ego-browser nodejs` 脚本调用（agent-kit#17）**：Git Bash/cmd：`ego-browser nodejs < script.mjs`（stdin 重定向）；PowerShell：`ego-browser nodejs -e "await import('file:///C:/path/script.mjs')"`；错误用法 `ego-browser nodejs script.mjs` 会把路径当内联 JS 求值并报错。

## 七条铁律（细则见手册）

1. 脚本一律 UTF-8 `.mjs` 文件（`ego-browser nodejs < round-N.mjs`），中文不进 `-e` 参数，每轮新写完整文件。
2. UI 状态只由结构化证据判定（可见停止按钮、尾部 `data-content-search-unit-key` / assistant DIL UUID），不从会话正文提取状态标志；完成判定=「可见停止按钮」消失的状态翻转 + 75 秒确认窗 + 尾部 assistant DIL UUID 稳定；禁文本匹配「正在思考」、禁用回复完成后采集的内容哈希/计数当基线；监视器启动即提取比对派单基线。
3. 快轮询纯 DOM 零 API 配额；API 仅唤醒后单次提取（每唤醒最多 2 调用）；`page.fetch` 的 conversation API 返回 404 `conversation_inaccessible` ≠ 会话死亡（授权上下文缺 token，见手册 §4），以页面 DOM 结构化证据为准；429 期停一切 API 与密集导航，页面重试 ≥9 分钟。
4. 双循环监控统一运行一个受管 `dispatch-manager.mjs watch` 任务，内含 1 分钟快轮询和默认 10 分钟监管判定；修改各会话监控目录 `conversations/<UUID>/supervision.config.json` 的 `supervisionMinutes`，可动态设为 15/20/30 等分钟。**启动时确认受管任务退出能实际通知并唤醒本地 Agent**；收到唤醒、完成诊断后通过管理器 `ack` 确认 `wakeId`，未确认不得宣称已接棒。连续 3 轮无进展要求联系 PO（即时聊天/邮件接入暂缓）；消息数接近 2000 提前迁移。
5. 发送前确认「发送」按钮可用，再执行一次 focus+Enter；进入 `SEND_STARTED` 后无论 Enter 的返回结果如何，都先按账本与 DOM 双验对账，无法证明未发送即标 `UNCERTAIN` 并 STOP，禁止补点 click 或盲目重发。按钮 `disabled=true` 时先按页面恢复契约处理。填充用 600 grapheme 目标 / 1200 UTF-8 byte 硬上限；每块 CDP `Input.insertText` 后回读累计前缀，只有确认内容未变化才重试当前块一次，错位立即 STOP；fill/原生 paste/单次长文本不作为可靠通道；Composer 空态是 innerText=`"\n"`（长度 1），勿用 `length===0` 判空；向外发送前查敏感信息。
6. 任务状态分离：浏览器存活、轮次生成、工具调用、最终完成是不同状态；超时或 stream reconnect 不等于任务失败。
7. 崩溃恢复采用有上限的重启与安全诊断；失败后立即保留状态证据，禁止记录 Cookie、Token、提示词正文和工具参数。

## 项目材料交接（两人工作流，细则见手册 §3.2）

**文件走 GitHub，网页走短消息。** 项目源码、任务书、证据与补丁优先使用对应项目仓库；临时材料放独立 `handoff/<日期>-<任务>` 分支。网页派单正文给出 **仓库 + 分支 + 完整 Commit SHA + 文件路径 + 本轮要求**，收件方按 SHA 读取并确认版本。无法读取时报告真实错误，再选已授权的文档连接器或既有附件通道；不要把大材料退化成反复网页粘贴。**敏感资料不得入 Git 历史**，清理分支也无法保证历史彻底消失。

此规则仅改变材料承载位置；现有派单九闸门、Composer 校验与监控流程照常执行。

## 相关事实源

- 监控脚本唯一存放点：**本仓库 `monitor/` 目录（PO 令 2026-11-08 并入 agent-kit；原独立 ego-tools 本地仓库停用为历史归档）**；要改脚本只改仓库内这一份，禁止本地另立孤本副本。**开工前 `git pull` 同步官方最新**（任务边界更新，skill 与脚本天然同版交付）。状态机文件：`dispatch-state.mjs`（派单账本 + 结构化 Composer/尾部读取）、`state-schema.mjs`（v3 Schema + 绝对 deadline）、`page-recovery.mjs`（多 Page URL-UUID 消歧）、`ego-profile-check.mjs`（本机账号钉扎校验）。
- **派单规范模板**：`templates/dispatch-round.template.mjs`（R2.5 九闸门冻结事务链 + R2.6-F 自适应填充，见手册 §3.1）。统一管理器内部使用此模板生成每轮脚本，业务 Agent 不手改模板适配器。遇到 `ADAPTATION_REQUIRED` 说明环境与模板假设不符，STOP 上报，不要徒手重写链路。
- 跨机器交付的 SHA256 必须注明哈希对象与字节基准（Git blob / 下载文件 / 部署磁盘，注明 LF/CRLF），见手册 §11.10。
- 通用浏览器操作（非 ChatGPT 派单流）见 `ego-browser` skill。
- 弃用声明：chrome-use / chatgpt-use 已全面弃用，仅存量旧脚本可读，禁止新建依赖。

## 实战问题协作方式（PO 令 2026-11-08，所有使用本 skill 的 Agent 遵守）

不通过高频刷新或故意制造网页故障来测试应急方案；Skill **在实际派单任务中迭代**。实战遇到问题时的标准路径（完整处置和权限错误分支见手册 §5.2、§6.4、§9.1）：

1. **当场止损**：按手册对应章节处置（STOP / 退避 / 对账），保住现场证据（状态文件、事件日志，脱敏后留存），不盲目重试。
2. **查重并报 Issue**：先搜索 `Hulkhao/agent-kit` 的现有 Issues；重复问题补充脱敏证据，新问题直接创建。GitHub 明确拒绝读写时报告原始错误并停止该上报动作，不能声称“已上报”；不要换仓库或账号绕过权限。
3. **通知 PO**：提交成功才通知“Issue #编号 已上报”，附链接、当前任务能否继续；失败则明确“未上报”及错误。由 PO 的 **Skill 维护 Agent** 统一处理，普通执行 Agent 不自行修改 Skill/监控脚本。
4. **继续主线**：能恢复则按手册既有路径恢复并重新布防；不能继续则保留当前进度、定位阻塞，通知 PO，不盲目重派。

这样其他 Agent 遇到同类问题能直接查 issue 看到已知现象与修复进度，避免各自踩坑、各自打补丁。

