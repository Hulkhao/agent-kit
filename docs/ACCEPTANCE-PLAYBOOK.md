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

## E-27 Batch 1：wake-guard 可靠性回归合同（issue #27，规划师裁决 + PO 终局 dcc8701）

**范围**：观察 A 逐事件冷却、观察 B ack 权限分级（受管 ack 路径）、C 项 fail-open 维持记录。前置：git pull 至含 Batch 1 的 commit；`node monitor/install-zcode-guard.mjs --verify` 通过；新开 ZCode 会话（运行中会话不热加载 hook）；`~/.agents/ego-profile.json` 已配 `monitorRoots`。

1. **逐事件冷却合同**（落点 `plugins/chatgpt-dispatch-guard/hooks/wake-context.mjs` + `pre-tool-use.mjs`；对应 `tests/wake-guard.test.mjs` #27 A 用例）：
   - a. 事件 A 首次出现 → 注入 A；
   - b. A 60s 内重复 → 抑制 A（按 A 自己的冷却）；
   - c. A 冷却期间同批次出现新事件 B → 只抑制 A，B 正常注入（**整块抑制废除**：`events[0]` 命中冷却不得吞掉同块新事件）；
   - d. 同一事件在同一事件块内重复出现 → 块内去重，只展示一次；
   - e. 重复 B → 按 B 自己的 60s 冷却周期抑制；
   - f. 不同 monitorRoot 的 UNKNOWN 事件互不掩盖（跨 root 隔离）；
   - g. 一批超过 3 个新事件 → 展示前 3 个，其余以 `additional=N suppressed by cap` 计数；**被计数隐藏的事件本轮不写冷却**（未被展示过，下一批仍可见）。
   - 身份键 = `eventType + wakeId + monitorRoot`（无 wakeId 的事件用稳定来源标识，UNKNOWN 的来源路径已含 root）；冷却期维持 60s 不变。
   - **向后兼容（数据保留口径）**：旧冷却状态文件 `~/.agents/ego-wake-guard-state.json` 原样解析，旧键（`<session>:wake:<id>` 形态）保留、不清洗，新键按 `<session>:<TYPE>:<id>:<root>` 形态追加。注意：旧键保留**不等于**旧键冷却效果在新身份体系下继续生效——新逻辑只匹配新格式身份键，升级后允许发生一次重复注入。

2. **ack 分级合同**（落点 `monitor/dispatch-manager.mjs` 受管 ack 路径；对应 `tests/dispatch-governance.test.mjs` #27 B 用例）：
   - `investigated`：任意合法 `--agent-id` 实际调查后即可 ack（现状行为不变）；
   - `resolved`：需所有权证据，满足其一即 GRANTED：①注册表绑定——`ego-taskspaces.json`（withAgentRegistry）中该 agentId 的 spaceName === 会话账本（`conversations/<conversation>/a-dispatch-state.json`）的 taskSpace；②claim 接管证据——`--monitor-dir` 下 `a-space-rebuild-audit.ndjson` 存在 `action:"claim"` 且 `outcome:"CLAIMED"` 且 agentId、space 均匹配的行；
   - 无证据的 resolved → `ACK_RESOLVED_OWNERSHIP_REQUIRED` + OPERATOR 指引（先受管 claim 或降级 investigated），exit 2，**账本与 ego-watch-exit 标记零改动（fail-closed）**；
   - 每次受管 ack 在 `--monitor-dir` 下 `a-wake-ack-audit.ndjson` 追加一行 `{ts, agentId, space, conversation, wakeId, ackAction, outcome[, reason, evidence]}`；DENIED（含所有权拒绝与 WAKE_ID_NOT_PENDING 失败）也留痕；
   - **审计尽力写入（规划师 r5 遗留项澄清）**：审计记录采用尽力写入；写入失败输出 `ACK_AUDIT_WRITE_FAILED`，不改变 ack 业务结果。审计文件不可写时，不能保证该次操作留下审计行。
   - **落点偏离说明**：裁决表格列的落点是 hooks/pre-tool-use.mjs，但 hook 层只有命令字符串与 session_id，无可靠的会话↔agent 身份映射；裁决自身规定「无法取得可靠会话身份时 resolved 必须 fail-closed」——在 hook 层执行 resolved 门禁会拒绝所有 Owner 的合法 resolved，与分级设计矛盾。故门禁落在唯一能核验声明身份与目标 TaskSpace 所有权关系的 dispatch-manager 受管 ack 路径（注册表绑定与会话账本均在此可读），hook 层不加拦截。此偏离需规划师逐项验收时裁定；
   - **身份边界说明（规划师复审 B-03）**：本门禁验证的是调用者**声明**的 agentId 与目标 TaskSpace 的所有权关系；不验证调用进程的真实 Agent 身份，不防止主动伪造 agentId——这是操作治理机制，不是安全认证；
   - **ego-watch-exit/v1 七字段合同零改动**（#25 冻结，现有 marker 测试原样通过）。

3. **fail-open 维持记录（PO 决策 dcc8701）**：PreToolUse hook 进程故障/无法启动时，工具调用**静默放行**——安装器 `install-zcode-guard.mjs` 零改动、不写 `onError`，hooks config 写入形态不变。守卫不阻断工具，依赖 wake 注入（本批次观察 A 修订后可靠性更高）与探针判别法兜底。规划师的 deny-on-error 收紧建议被 PO 否决，双方观点与风险已按冲突处置纪律记录于 `docs/planning/issue-27-ruling-20261116.md` §五第 1 项；如需重启讨论，以该记录为凭。

**PASS 判据**：1a~1g 与 2 各条全部符合，且与 `tests/wake-guard.test.mjs`、`tests/dispatch-governance.test.mjs` 对应用例一一对应；3 项为记录性条款（无实机动作），核对安装器产物不含 `onError` 即可。

## E-27 Batch 2：TaskSpace 归属治理回归合同（issue #27，V1 口径，规划师裁决 §三 + §六）

**范围**：命名规范固化、probe owner 日志、release 清理扩展、claim 归属审计字段。前置：git pull 至含 Batch 2 的 commit；验收空间命名按 §1 规范新建（`-accept-` 前缀纪律与命名规范并用）。对应测试：`tests/dispatch-governance.test.mjs` #27 B2 用例。归属与清理合同正文见 `docs/OPERATIONS.md`。

1. **命名规范合同**（冻结形态 `<project>-<purpose>-<AGENT_ID>-<YYYYMMDD>`）：
   - 合法名（含 AGENT_ID、8 位日期）通过校验；缺 AGENT_ID / 错 AGENT_ID / 非 8 位日期 / 超 120 字符 / 空 project/purpose 段拒绝；
   - 校验只落**新建分支**（probe 自举 + dispatch-round Gate 1.5）：不匹配即 `TASKSPACE_NAMING_VIOLATION_STOP`，fail-closed 不创建；不匹配的**新**名无法借道 probe 失败→rebuild-space 绕过（rebuild 需 #31 授权链，无账本绑定即 DENIED）；
   - **旧空间名复用不受影响**：复用路径与 rebuild-space 恢复路径无命名校验，旧名照原名复用/恢复，不改名不迁移；
   - probe 启动行 `PROBE_BOOT version=... space=... mon=... owner=<AGENT_ID>` 带 Owner 标识。
2. **release 清理合同**（受管 release 动作扩展 + `a-release-sweep-audit.ndjson` 逐页审计）：
   - 应关：注册表 known 集合内、账本终态（COMPLETED/ABORTED/RELEASED）的其他会话页（`TEMP_RESULT_PAGE_FINISHED_DISPATCH`）；
   - 保留：账本活跃页（`ACTIVE_DISPATCH_LEDGER`）、账本不可证页（`LEDGER_UNPROVEN`）、空白页与归属不明页（`OWNERSHIP_UNPROVEN`）、release 目标残留（`RELEASE_TARGET_RESIDUAL`，由既有受管路径独占处理）；
   - TaskSpace 本身不删除；其他 Agent 页面/用户页面不可触碰（unmanaged tab 由既有 `assertManagedReleasePages` 前置拦截）；
   - 清理失败（关页失败/枚举失败/审计写失败）→ `RESULT=AGENT_SPACE_RELEASE_SWEEP_FAILED` exit 2，真实上报不伪装完整 release，OPERATOR 指引幂等重跑；
   - 幂等：无临时页 zero-close 算成功；重复 release 走注册表早退，零浏览器调用直接成功。
3. **claim 归属字段合同**：claim 审计行含 `ownerAgentId`、`taskSpaceId`、`taskSpaceName`、`conversation:null`；模板回读证据（`SPACE_CLAIMED_TASK_ID/NAME`）缺失时字段如实留 null；**#33 授权链（ledger binding → spaceTaken → allowlist → deny）零变化**（`authorizeSpaceRebuild` 源码与既有用例原样通过）。
4. **V1 口径记录**：第 0 步只读检查未发现 ego lite TaskSpace 自定义元数据 API（详见 `docs/OPERATIONS.md` §5），V2 待正式 API 能力证据后另行立项。

**PASS 判据**：1~3 各条全部符合，且与 `tests/dispatch-governance.test.mjs` #27 B2 用例一一对应；实机验收时新建空间走规范名、旧空间原样复用一次、release 后核对 sweep 审计行与幂等重跑。

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
