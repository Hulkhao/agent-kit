---
name: chatgpt-web-dispatch
description: ChatGPT 网页 Agent 派单工作流（ego-browser）——向 ChatGPT 网页会话派发任务、双循环监控回复、API 提取、会话迁移、429/死页/巨型会话处置。凡涉及 chatgpt.com 会话的派单、监控、提取、迁移任务（含关键词：派单/值守/看门狗/快轮询/提取/迁移会话）必读本 skill。Use for any ChatGPT web conversation dispatch, reply monitoring, extraction, or migration task driven by ego-browser.
metadata:
  version: "1.2.0"
  date: "2026-11-08"
---

# ChatGPT 网页派单（ego-browser 工作流）

任何 ChatGPT 网页派单/监控/提取/迁移任务，动手前必做两件事：

1. **通读本 skill 目录下的唯一真源手册 `references/EGO-LITE-HANDBOOK.md`**——派单全链路（§3）、回复提取（§4）、故障模式与巨型会话迁移（§5）、双循环监控部署（§6）、统一参数表（§7）、新机上手顺序（§10）、上游可靠性补充（§11）。细则与参数一律以手册为准。
2. **跑 `ego-browser skill`** 获取与所装版本匹配的 API 指南（ego 升级后重跑；输出缺 `[ego-browser:skill] end of guide` 尾行 = 被截断，存文件分段读）。

维护口径：本 skill 随 agent-kit git 仓库多机同步；**改手册/skill 只改仓库内这一份**（各机全局公用 `~/.agents/skills/` 下是 `deploy.ps1` 生成的部署副本，勿直接改），改完 commit → push → 各机 pull + 重新 deploy。

## 七条铁律（细则见手册）

1. 脚本一律 UTF-8 `.mjs` 文件（`ego-browser nodejs < round-N.mjs`），中文不进 `-e` 参数，每轮新写完整文件。
2. 完成判定=「可见停止按钮」消失的状态翻转 + 75 秒确认窗；待处理工具未结清或工具结果后没有新 assistant 输出时不得判完成；禁文本匹配「正在思考」、禁用回复完成后采集的内容哈希/计数当基线；监视器启动即提取比对派单基线。
3. 快轮询纯 DOM 零 API 配额；API 仅唤醒后单次提取（auth/session + conversation 共 2 调用）；429 期停一切 API 与密集导航，页面重试 ≥9 分钟。
4. 双循环监控（1 分钟快轮询 + 15 分钟看门狗）一律受管后台任务，退出即接力；消息数接近 2000 提前自包含简报迁移。
5. 发送默认 focus+Enter（失败回退 click），发送前持久化派单状态，发送后等 5~10 秒取真 `/c/<uuid>` 并 DOM 双验；进程重启后先对账，禁止盲目重发；向外发送前查敏感信息。
6. 任务状态分离：浏览器存活、轮次生成、工具调用、最终完成是不同状态；超时或 stream reconnect 不等于任务失败。
7. 崩溃恢复采用有上限的重启与安全诊断；失败后立即保留状态证据，禁止记录 Cookie、Token、提示词正文和工具参数。

## 相关事实源

- 监控脚本唯一存放点：ego-tools 仓库（路径与本机部署状态见手册 §6；要改脚本只改那一份）。
- 通用浏览器操作（非 ChatGPT 派单流）见 `ego-browser` skill。
- 弃用声明：chrome-use / chatgpt-use 已全面弃用，仅存量旧脚本可读，禁止新建依赖。

