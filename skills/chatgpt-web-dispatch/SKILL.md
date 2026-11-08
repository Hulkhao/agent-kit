---
name: chatgpt-web-dispatch
description: ChatGPT 网页 Agent 派单工作流（ego-browser）——向 ChatGPT 网页会话派发任务、双循环监控回复、API 提取、会话迁移、429/死页/巨型会话处置。凡涉及 chatgpt.com 会话的派单、监控、提取、迁移任务（含关键词：派单/值守/看门狗/快轮询/提取/迁移会话）必读本 skill。Use for any ChatGPT web conversation dispatch, reply monitoring, extraction, or migration task driven by ego-browser.
metadata:
  version: "1.5.0"
  date: "2026-11-08"
---

# ChatGPT 网页派单（ego-browser 工作流）

任何 ChatGPT 网页派单/监控/提取/迁移任务，动手前必做三件事：

1. **开工前自检更新（每次任务前）**：`cd` 本机 agent-kit 仓库 → `git pull` → 若有新提交则跑 `deploy.ps1` 并重读部署副本（新会话自动生效）。**只在任务边界更新**——值守循环运行中禁止热更新（监控脚本换文件会让运行中循环行为不一致）。远程/同事机器同样适用：仓库地址 `github.com/Hulkhao/agent-kit`，pull + deploy 即完成更新，无需等通知。
2. **通读本 skill 目录下的唯一真源手册 `references/EGO-LITE-HANDBOOK.md`**——派单全链路（§3）、回复提取（§4）、故障模式与巨型会话迁移（§5）、双循环监控部署（§6）、统一参数表（§7）、新机上手顺序（§10）、上游可靠性补充（§11）。细则与参数一律以手册为准。
3. **跑 `ego-browser skill`** 获取与所装版本匹配的 API 指南（ego 升级后重跑；输出缺 `[ego-browser:skill] end of guide` 尾行 = 被截断，存文件分段读）。

维护口径：本 skill 随 agent-kit git 仓库多机同步；**改手册/skill 只改仓库内这一份**（各机全局公用 `~/.agents/skills/` 下是 `deploy.ps1` 生成的部署副本，勿直接改），改完 commit → push → 各机 pull + 重新 deploy。

## 本机账号钉扎（ego-profile.json，PO 令 2026-11-08，首次使用本 skill 前必配）

**为什么**：`taskSpace(名字)` 按名字复用已存在的空间，ego 的 profileId 只在「创建空间」那一刻生效——复用一个早期用错账号建的空间，就会一直用那个账号跑（实测事故：复用了无会员账号的空间，整个会话静默跑在 mini 档，见 agent-kit#7）。所以账号必须本机钉死+使用前验证。

**配置（机器本地，绝不进仓库、绝不写真实邮箱进 Git）**：复制 `config/ego-profile.example.json` 到本机 `~/.agents/ego-profile.json`（Windows 即 `C:\Users\<你>\.agents\ego-profile.json`），填本机值：

- `defaultProfileId`：本机 ego 的 profile id（跑 `ego-profile-check.mjs` MODE=list 可列出，或 nodejs 里 `await profiles()`）；选登录了 ChatGPT Plus 的那个。
- `defaultAccount`：该 profile 应登录的账号邮箱——派单模板发送前会用它核对（`/api/auth/session`，每轮 1 次调用）。
- `spaceExpect`：个别空间要用其他账号时的覆盖项。

**行为口径**：本机没有该配置文件或字段缺失 → `ACCOUNT_CONFIG_MISSING_STOP` / `ACCOUNT_CONFIG_INCOMPLETE_STOP`，**立即停止报人，不猜测账号**；页面实测账号与钉扎不符 → `ACCOUNT_MISMATCH_STOP`。**新建空间**一律 `taskSpace(名字, { profileId })` 带上钉扎的 profile；**旧空间无法换账号**——核对不符只能换空间名重建或人工登录正确账号。

校验工具：ego-tools 仓库 `monitor/ego-profile-check.mjs`（`ego-browser nodejs < ego-profile-check.mjs`，MODE=list/init/verify，详见文件头注释）。

## 七条铁律（细则见手册）

1. 脚本一律 UTF-8 `.mjs` 文件（`ego-browser nodejs < round-N.mjs`），中文不进 `-e` 参数，每轮新写完整文件。
2. UI 状态只由结构化证据判定（可见停止按钮、尾部 `data-content-search-unit-key` / assistant DIL UUID），不从会话正文提取状态标志；完成判定=「可见停止按钮」消失的状态翻转 + 75 秒确认窗 + 尾部 assistant DIL UUID 稳定；禁文本匹配「正在思考」、禁用回复完成后采集的内容哈希/计数当基线；监视器启动即提取比对派单基线。
3. 快轮询纯 DOM 零 API 配额；API 仅唤醒后单次提取（每唤醒最多 2 调用）；`page.fetch` 的 conversation API 返回 404 `conversation_inaccessible` ≠ 会话死亡（授权上下文缺 token，见手册 §4），以页面 DOM 结构化证据为准；429 期停一切 API 与密集导航，页面重试 ≥9 分钟。
4. 双循环监控（1 分钟快轮询 + 15 分钟看门狗）一律受管后台任务，退出即接力；消息数接近 2000 提前自包含简报迁移。
5. 发送默认 focus+Enter（失败回退 click）；发送前确认「发送」按钮可用（`disabled=true`=陈旧页，先 goto 刷新再重读，陈旧页上 Enter 与 click 都会静默无效）；填充用 ~1.2KB 线边界分块 `execCommand("insertText")`，fill/原生 paste/单次长文本不作为可靠通道；Composer 空态是 innerText=`"\n"`（长度 1），勿用 `length===0` 判空；发送前持久化派单状态，发送后以结构化证据双验（user unit-key 尾部前进 + 停止按钮出现）；进程重启后先对账，禁止盲目重发；向外发送前查敏感信息。
6. 任务状态分离：浏览器存活、轮次生成、工具调用、最终完成是不同状态；超时或 stream reconnect 不等于任务失败。
7. 崩溃恢复采用有上限的重启与安全诊断；失败后立即保留状态证据，禁止记录 Cookie、Token、提示词正文和工具参数。

## 相关事实源

- 监控脚本唯一存放点：ego-tools 仓库（R2.2 验收基线 `fd6da71`，父基线 `32c3658`；路径与本机部署状态见手册 §6；要改脚本只改那一份）。状态机文件：`dispatch-state.mjs`（派单账本 + 结构化 Composer/尾部读取）、`state-schema.mjs`（v3 Schema + 绝对 deadline）、`page-recovery.mjs`（多 Page URL-UUID 消歧）。
- **派单规范模板**：`templates/dispatch-round.template.mjs`（R2.5 九闸门冻结事务链，见手册 §3.1）。新派单任务以它为底本，只改顶部适配器常量（MON/SPACE/MSG_FILE/CONV），遇到 `ADAPTATION_REQUIRED` 说明环境与模板假设不符，STOP 上报，不要徒手重写链路。
- 跨机器交付的 SHA256 必须注明哈希对象与字节基准（Git blob / 下载文件 / 部署磁盘，注明 LF/CRLF），见手册 §11.10。
- 通用浏览器操作（非 ChatGPT 派单流）见 `ego-browser` skill。
- 弃用声明：chrome-use / chatgpt-use 已全面弃用，仅存量旧脚本可读，禁止新建依赖。

## 实战问题协作方式（PO 令 2026-11-08，所有使用本 skill 的 Agent 遵守）

不搞独立测试战役：skill 的能力**在实际派单任务中验证**。实战遇到问题时的标准路径：

1. **当场止损**：按手册对应章节处置（STOP / 退避 / 对账），保住现场证据（状态文件、事件日志，脱敏后留存），不盲目重试。
2. **报 GitHub issue**：到 `github.com/Hulkhao/agent-kit/issues` 留言——现象、复现轮次、现场证据摘要（**不含提示词正文/Cookie/Token**）、手册或模板哪一节不符。监控脚本类问题（ego-tools）也先报到 agent-kit issues 记账。
3. **等修复发布**：issue 由 skill 维护会话解决并 commit → push → deploy；修复落地前不要自行改动仓库源或部署副本（维护口径见上）。
4. **继续主线**：修复发布前主线任务不受阻——按手册兜底路径继续推进，把 issue 编号留在值班记录里供后续回归验证。

这样其他 Agent 遇到同类问题能直接查 issue 看到已知现象与修复进度，避免各自踩坑、各自打补丁。

