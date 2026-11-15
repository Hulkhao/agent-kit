# ChatGPT 派单治理实机验收手册（ACCEPTANCE-PLAYBOOK）

> 版本 1.0（2026-11-16）。本文件是各 issue「代码已落地、待实机验收」项的唯一汇总清单，随 git 同步到各机。
> 执行纪律：验收前先按 skill「开工三件事」（pull + deploy → 通读手册 → `ego-browser skill`）；只在**带账号钉扎配置（`~/.agents/ego-profile.json`）的派单机**执行；验收过程遵守手册 §3 九闸门与 §9.1 上报路径；每项验收完成后把结果（PASS/FAIL + 脱敏证据）回报到对应 issue。
> 结果口径：PASS = 全部判据满足且证据落盘；任何判据不满足即 FAIL，FAIL 时停止该项并按 §9.1 查重/上报，不盲试。

## 通用前置（所有验收项共享）

1. 派单机已 `git pull` 至 ≥ `18f815a` 并跑过 `deploy.ps1`；`node monitor/dispatch-manager.mjs` 可用（system PATH 有 ego-browser）。
2. 便携版 Node 测试基线确认：`node --test --test-reporter=dot` 根套件 ≥144 PASS、`node --test monitor/test-monitor-state.mjs monitor/test-install-zcode-guard-verify.mjs monitor/test-watch-zcode-replies.mjs` 共 62 PASS。
3. 账号钉扎三件套就位：`ego-profile.json`（defaultProfileId/defaultAccount/spaceExpect）、`ego-profile-check.mjs MODE=verify` 通过。
4. 验收用空间名一律带 `-accept-` 前缀（如 `验收-E31-空间`），结束后 `release` 回收；不在用户空间做破坏性操作。

## E-31 Test E：注册表丢失 → rebuild-space → probe 恢复全链（issue #31）

**前置**：某 agent 的派单空间已在账本（跑过至少一次 `send`/`probe`）；monitor 目录干净。

1. 正常 `send` 一条短任务并 `watch` 布防（建立基线）。
2. **[PO 手工步骤]** Agent 禁止终止或重启 Ego Lite 宿主 `ego.exe` 及其进程树（skill 1.7.1 硬禁令，PR#32）。由 PO 手工杀 ego 主进程 → 手工删除 ego 内该空间（或用 ego 提供的清理路径），确保 `listTaskSpaces` 无此空间；Agent 只保留 PO 操作前后的脱敏现场记录。
3. **[PO 手工]** PO 重启 ego，完成后 Agent 接手：跑 `probe`。r48 起为双分支：空间自举成功 → `SPACE_BOOTSTRAPPED`（注册表丢失自愈，无 HINT，监控继续）；自举也失败且非 takeover → `TASKSPACE_RECOVERY_FAILED` 且 stdout 含 `RECOVERY_HINT=SPACE_REGISTRY_LOST`（ego-fast-probe.mjs：HINT 仅在 `spaceRegistryMissing && !takeover && 自举抛错` 时输出）。健康机器上注册表丢失通常走自举分支（本机实测 2026-11-16）；因此步骤 4 的 rebuild-space 须趁空间仍缺失时执行，才能取得 `LEDGER_PROOF` 审计行。
4. 跑 `node monitor/dispatch-manager.mjs rebuild-space --monitor-dir <根> --agent-id <ID> --space <空间>`：期望 `RESULT=SPACE_REBUILT`、exit 0；`<根>/a-space-rebuild-audit.ndjson` 出现 `decision=LEDGER_PROOF, outcome=REBUILT` 行。
5. 重跑 `probe`/`watch`：期望空间恢复、页面恢复走既有链路（`SPACE_BOOTSTRAPPED` 不再出现，`AGENT_OWNED_BLANK_PAGE`/`NEW_PAGE_FOR_EXISTING_CONVERSATION` 任一恢复路径），任务继续到 DONE → collect/consume/release 全链。
6. **allowlist 兜底一次**：另取一个未入账本的空间名，加入本机 `ego-profile.json` `spaceRebuildAllowlist` → rebuild-space：期望 `decision=ALLOWLIST`；对不在白名单且无账本的第三个名字：期望 `SPACE_REBUILD_DENIED code=SPACE_REBUILD_NOT_AUTHORIZED`（审计行 decision=DENIED）。
7. **HINT 边界**：在 takeover 场景（ego 升级把空间还给用户）跑 probe：期望不出现 HINT、报 `EGO_TASKSPACE_TAKEOVER_REQUIRED`。

**PASS 判据**：3~7 全部符合（3 按上述双分支任一，且与现场一致）；audit 文件每个动作一行 JSON（含 DENIED）。
**附带复测**：若 watch 再次异常退出，按 §6.3 三段判定归因（detail=command not found / 堆栈行 / 无 detail），把归因结果回报 #31。

## E-25：接管门 + 源自验 + 升级回归（issue #25）

1. **接管门复测**（490a182 遗留）：模拟升级后 user-owned 空间跑 probe → 期望 `EGO_TASKSPACE_TAKEOVER_REQUIRED`，probe 不自动抢占；人工 claim 后恢复。
2. **源自验**（952b395）：受管页漂到 `chrome://settings/`（或杀掉导航让页停在错误页）→ probe 一轮内报 `RESULT=PROBE_INVALID_ORIGIN`（不记 strike）；对照：RECOVER 轮空白页/新建页导航前不误报。
3. **升级回归**（缺口②核实结论）：制造持续 probe 失败 → 验证看门狗第 3 异常轮输出 `USER_ESCALATION_REQUIRED` 到达 Agent。
4. **缺口③ wake-guard 实机验收（ChatGPT High 裁决 A+C LIMITED GO，2026-11-16）**。前置：本机 `node monitor/install-zcode-guard.mjs` 安装（幂等升级）且 `--verify` 通过 → **新开 ZCode 会话**（运行中会话不热加载 hook）→ `~/.agents/ego-profile.json` 已配 `monitorRoots`（指向验收用监控根）。
   - **E1 延迟唤醒**：制造未 ack 的 `WAKE_PENDING`（`a-watch-exit.json` 的 issuedAt 回拨 180s）→ 宿主继续正常任务 → 下次 PreToolUse 收到 `[AGENT_KIT_WAKE_GUARD] WAKE_PENDING`（wakeId 一致）→ 尝试收尾回合 → Stop 强制继续一轮 → 处置并 `ack` → 该 wakeId 不再注入。
   - **E2 watch 死亡接棒**：真实 active dispatch + 正常 watch → 记录 fast-state 时间戳 → 强杀 watch 进程（不走退出路径）→ fast-state 回拨 3h → 下次 PreToolUse 见 `WATCH_STALE` → 重新布防后提示消失。对照三项：完成/终态 dispatch 不误报；新鲜 watch 不误报；状态文件损坏报 `WAKE_STATUS_UNKNOWN` 不报健康。
   - **E3 守卫兼容**：ChatGPT 直连浏览器调用/Backend API 直写照常 DENY；无关工具不受影响；deny+注入并存且 deny 原因原文不变；安装两次无重复条目（重复即 VERIFY 失败不静默修）；`--verify` 只读全过。
   - **E4 端到端**：真实 ZCode 宿主完成 E1/E2 两场景，PO 确认两种历史失效形态（唤醒排队 3 分钟 / watch 死 3 小时）均被宿主主动发现并接棒。
   - **PASS 判据**：E1~E3 全过 + wakeId 全程一致 + Stop 每停止流程只接棒一轮；E4 由 PO 在实机确认后才算关闭 #25 缺口③。

## E-20：composer 全机锁双 Agent 并发（issue #20）

1. 同账号、两个空间、两个会话目录，用两个受管 `send`（脚本化并发，间隔 <30s 启动）。
2. 期望其一正常全链，另一者报 `COMPOSER_LOCK_BUSY`（exit 1）且**无任何填充发生**；锁释放后重试成功。
3. **PASS 判据**：无串稿（两页 composer 互不出现对方 payload 片段）、无混合发送、锁文件 `~/.agents/ego-composer.lock` 在成功方退出后消失。

## E-19：派单八项端到端（issue #19，多标签/附件）

按 ①~⑧ 逐项复现（详情见 issue 正文与手册 §3）：钉扎空间认领 / finish 语义（最终回合才 finish）/ 前台焦点门（hasFocus）/ CDP insertText 可靠通道 / 循环前单击+Ctrl+End（modifiers=2）/ 附件三坑（attached + `>> nth=-1` + 全 form 遍历）/ markAccepted 第三参与状态机不可跳转 / 账本结转流程。**每项 PASS 判据 = 现象按手册处置生效且账本/回执完整**；任一项 FAIL 截图（脱敏）+ STOP_CAUSE 回报。

## E-21：模式识别两场景（issue #21）

1. goto 项目落地页主区不渲染（bodyLen≈47）→ 死页梯子行为符合 §6.2，不误派单。
2. 新会话默认 Codex 模式 → Gate 7/模式门拒绝（`CHAT_MODE_UNVERIFIED_STOP` 或等价 STOP），切回 Chat 后正常派单；GPT-6.1 Sol 8 档 UI 下档位门口径校准结果回报 issue。

## E-23：巨会话迁移 + 极端空白折叠（issue #23）

1. 会话逼近 2000 条消息 → 迁移流程（首条自包含简报新会话）按 §5 执行成功。
2. 0×0 假身 composer 在真身前 → 统一定位取真身（readComposerSurface 证据正确）。
3. paste 分块极端空白折叠 → normalized 兜底命中（#23-3），全链发送成功；strict payload 同场景必须 STOP 不放行。

## E-29：landing 五现象阻断（issue #29）

延迟回填草稿（>600ms 复现）｜聊天/工作模式门｜locale 混排档位 chip｜`POST /backend-api` 直写被守卫 deny｜landing focus 门（focus+Enter 一次过，`keyboard.type` 不用）——五项全部验证「被阻断/按预期处置」；对照细节见 #29 正文。**PASS 判据**：无一现象导致误发或静默继续。

## E-30：B48 复跑（issue #30，闭环关闭条件）

见 #30 2026-11-16 评论「B48 实机复跑验收」五步：中断填充 → 确认残留 → `recover-draft` 清稿（`OWNED_DRAFT_CLEARED` + ABORTED/OWNED_DRAFT_RECOVERED）→ 无 URL v2 重发全链 → 回执核对。全过即可关闭 #30。

## 观察项（不设专门验收，实战中按 §9.1 记录）

- **#27**：多 Agent 空间归属可辨、按需布防/撤防的资源占用、撤防期责任转移（依赖 #25 缺口③裁决）。
- **#28**：下次实战确认无私自降级附件通道、等待轮一律复用 `readComposerSurface` 结构化探针。
- **#31 附带**：watch exit 127 归因（E-31 附带复测）；巨会话/长生成下 watch 连续运行稳定性。

## 结果回报格式（回 issue 用）

```
E-<编号> 验收 <PASS|FAIL> @<机器名> @<日期>
- 判据逐条：…（PASS/FAIL）
- 证据：日志片段/audit 行（脱敏，不含 payload 全文/邮箱/令牌）
- FAIL 时：STOP_CAUSE + 已做的止损 + 是否已另立/查重 issue
```
