# 运维手册：空间归属与清理合同（#27 Batch 2，含复审修订）

> 版本 1.1（2026-11-16）。依据：规划师裁决 `docs/planning/issue-27-ruling-20261116.md` §三 + §六 Batch 2 表，及规划师 Batch 2 复审修复令（P1-1..P1-4）。
> 口径：**V1**——TaskSpace 归属以「命名规范 + 注册表账本 + probe 日志 + 审计行」承载。第 0 步只读检查未发现 ego lite 暴露 TaskSpace 自定义 label/description/owner 元数据 API（证据见 §5），不等待、不臆测 API；V2（原生元数据）待取得正式 API 能力证据后另行立项。

## 1. 命名规范（冻结形态，裁决 §三.2 + 复审 P1-1）

- **新建** TaskSpace 必须命名：`<project>-<purpose>-<AGENT_ID>-<YYYYMMDD>`。
  - `project` / `purpose` 段：字母数字与点、下划线（不含连字符，保证 AGENT_ID 字面量无歧义）；
  - `AGENT_ID`：跨任务稳定（不得用临时 session ID，不得省略），即注册表绑定的那个 id；
  - `YYYYMMDD`：8 位创建日期。
- **校验落点 = 写注册表之前的共享前置门，fail-closed**（复审 P1-1）：canonical 函数为 `agent-space.mjs` 的 `isValidNewTaskSpaceName` + `assertTaskSpaceNamingAllowed(space, agentId, spaceExists)`。`ego-fast-probe.mjs` 与 `dispatch-round.template.mjs` 均先做**只读 `listTaskSpaces()` 存在性检查**，再调用 `claimAgentSpace()`：
  - 目标空间**已存在** → 旧名复用放行（任意名称，含 legacy）；
  - 目标空间**不存在**且要走创建 → 名称不过规范即 `TASKSPACE_NAMING_VIOLATION_STOP`，**claim 都不许做**——违规新名无法进入注册表，也就无法借道 rebuild-space 的 LEDGER_PROOF 授权创建；
  - probe/dispatch-round 的自举创建分支内保留第二道同款校验（存在性竞态防御）。
- **只约束新建**：不迁移、不改名旧空间。复用路径（已存在空间的命中分支）与受管 `rebuild-space` 恢复路径**不做命名校验**（rebuild 走 #31 授权链：registry binding → spaceTaken → allowlist → deny）。
- `listTaskSpaces()` 使用处一律不加改名逻辑（V1 无归属元数据）。

## 2. AGENT_ID 稳定性与 owner 日志

- `AGENT_ID` 是注册表（`~/.agents/ego-taskspaces.json`）绑定与全部审计行的归属主键；更换 AGENT_ID 视同归属易主，需 PO 授权。
- probe 启动行打印 Owner（空格分隔格式不变）：
  `PROBE_BOOT version=<ver> space=<space> mon=<mon> owner=<AGENT_ID>`
  用途：stale-copy 哨兵 + 归属核对；监控输出流中即可核对「哪个 Agent 在守哪个空间」。

## 3. release 状态机与清理边界（裁决 §三.3 + 复审 P1-2/P1-3）

落点：`monitor/release-agent-space.template.mjs`（release 主流程收尾后的受管 sweep），分类/账本铻定/审计的可注入实现在 `monitor/release-sweep.mjs`，审计文件 `<监控根>/a-release-sweep-audit.ndjson`。

### 3.1 注册表状态机（新增 sweepPending 字段）

条目可选字段：`sweepPending = { conversationUuid, startedAt }`（复审 P1-3，持久可恢复状态）。

```
release(CONV)
  ├─ 无 active、无 releasePending、无 sweepPending → 早退成功（零浏览器副作用，幂等）
  ├─ 置 sweepPending（intent-first，浏览器动作之前）
  │    ├─ 他话会话已有 sweepPending → AGENT_SPACE_SWEEP_PENDING 拒绝
  │    └─ 旧版遗留 releasePending（他话会话，升级兼容场景）→ AGENT_SPACE_RELEASE_PENDING 拒绝，
  │       不写任何标志（复审② P1-B：先恢复旧 releasePending 那笔，否则 A 阻 B、B 阻 A 死锁）；
  │       同会话的 releasePending 属正常恢复形态，放行
  ├─ releaseAgentConversation：目标页关闭 / 最后会话 finish 分支 / releasePending 恢复
  ├─ sweepTaskPages：逐页分类（见 3.2；close-intent 见 3.3）
  ├─ space-finish 决策：仅「最后会话 + 零保留页 + 零失败」才 finish 空间
  ├─ 全部成功（failed=0 且全部 intent 有处置确认）→ 清 sweepPending → RESULT=AGENT_SPACE_RELEASED
  └─ 任一失败或存在未确认 intent → sweepPending 保留 → RESULT=AGENT_SPACE_RELEASE_SWEEP_FAILED（exit 2）
       └─ 重跑 release：命中 sweepPending → 不走早退 → 真实重扫（需要浏览器）→ 成功才清标志
```

- 重跑时目标页已不存在属正常恢复形态（release 已提交，matches 为空不报 STOP）；
- 空间已被上轮 finish 销毁的重跑：`task=null` → zero-close 成功 → 清标志 → 完整成功。

### 3.2 逐页分类边界表（保守默认 fail-closed）

| 对象 | 处置 | 判据 / 审计 reason |
|---|---|---|
| 当前 release 会话页 | 关闭 | 既有受管路径（最后会话 = finishSpace 只关目标页，**不再用 `finish({keep:[]})` 一把全关**）；残留只保留不关，`RELEASE_TARGET_RESIDUAL` |
| 其他会话页：账本**终态** | **关闭** | 注册表 known 集合内 + `validateDispatchRecord` 通过 + conversationUuid/taskSpace 与页面铻定一致 + 状态 ∈ {COMPLETED, ABORTED}；`TEMP_RESULT_PAGE_FINISHED_DISPATCH` |
| 其他会话页：账本**活跃** | 保留 | `ACTIVE_DISPATCH_LEDGER` |
| 会话页账本缺失 / 不可读 / **结构不合法** / 铻定不一致 | 保留 | `LEDGER_UNPROVEN`（复审 P1-4：裸 `{"status":"COMPLETED"}` 之类残缺对象一律不信任） |
| 空白页（about:blank 等） | 保留 | 无法证明「临时」，保守默认；`OWNERSHIP_UNPROVEN` |
| URL 不可读 / 未注册 / 归属不明 | 保留 | `OWNERSHIP_UNPROVEN` |
| TaskSpace 本身 | 不删除 | sweep 只关页；**仅当最后会话 + 零保留页 + 零失败**才 `task.finish({keep:[]})` 销毁空空间；有任何保留页 → 空间带着保留页继续存活，注册表侧记录 release 完成态，由归属者后续处置 |

- **RELEASED 状态统一判定（复审 P1-4）**：`validateDispatchRecord` 的合法状态集合是 schema 真源且不含 RELEASED，也无任何代码路径写入它——统一方式是**收窄 sweep 终态集合为 {COMPLETED, ABORTED}**，不放宽 schema。带 RELEASED 状态的账本 = 结构不合法 = `LEDGER_UNPROVEN` 保留。
- **ego finish keep 语义取舍（复审 P1-2）**：手册仅见 `finish({keep:[]})` 用法，`keep` 的保留语义无权威文档，且 finish 可能连空间一起销毁、保留页无法存活。故不赌 keep 语义：受管 finish 分支只关目标页；空间仅在「可证明为空」时销毁；有保留页时空间不销毁。
- **保守默认（fail-closed）**：无法明确归属「临时」的页面一律不关。
- **逐页审计**：每页一行 `{ts, action:"release-sweep", agentId, space, conversation, page:{label,uuid}, decision, reason}`（decision = closed / kept / close-failed / sweep-failed）。只记录 id 类字段与理由，不含任务/回复正文。
- **幂等**：无临时页 → zero-close 也算成功（`RESULT=AGENT_SPACE_RELEASED`）；完整成功后的重复 release 走注册表早退，零浏览器调用。

### 3.3 close-intent 与审计恢复（复审② P1-A）+ 两种审计文件的写失败策略表

**intent 存储位置**：与最终审计行同文件——`<监控根>/a-release-sweep-audit.ndjson`（单一证据文件，不新增第二写失败面）。行形态：
- intent 行：`{..., page:{label,uuid}, decision:"close-intent", intentId, reason}`——**必须在 page.close() 之前写入**；
- 处置行：`{..., page:{label,uuid}, decision, reason, intentId}`——intentId 回指其 intent（decision = closed / close-failed / closed-backfilled / kept）；
- 补齐行：`{..., decision:"closed-backfilled", intentId, note:"PAGE_GONE_CLOSE_CONFIRMED_BY_BACKFILL"}`——与实时 `closed` 行靠 decision 字段区分。

**intent 与最终审计行的关系**：intentId 把两者配对；扫描文件中「有 intent 行、无任何处置行回指」即为未确认 intent（机器可独立发现）。intent 写失败 → **该页禁止关闭**（跳过、failed++，走 SWEEP_FAILED）；审计写失败后**停止后续一切关页**（保留页照常审计 kept，但不再 close 任何页，页行 reason=`AUDIT_UNAVAILABLE_NO_CLOSE`）。

**审计恢复成功判定**：重跑时（同一 task/页面集合贯穿）逐页重扫——
- 页面仍存在 → 重新执行关闭（intent 已持久化的复用原 intentId）；
- 页面已消失且本跑无身份不可知页 → 依据持久化 intent 写 `closed-backfilled` 补齐行（仅补**上轮遗留** intent；本轮新产生且处置行写失败的 intent 保留到下轮，不在自身写失败的同跑内自证）；
- 枚举失败或存在 URL 不可读页 → 无法证明缺席，不补齐（fail-closed）。

**sweepPending 最终清除条件**：`failed === 0` **且** `unconfirmed === 0`（每个 intent 都有处置行确认）且审计链可校验（文件可解析）。任一不满足 → SWEEP_FAILED exit 2，sweepPending 保留，重跑真实重扫。

| 审计文件 | 写失败语义 |
|---|---|
| `a-release-sweep-audit.ndjson`（release sweep） | **计入清理失败**：每次写失败 = 一条缺失证据行 = `failed++` → SWEEP_FAILED exit 2，sweepPending 保留；关闭动作有 intent 先行持久化，缺失的最终行可由重跑按 intent 补齐（见上）。审计是本机制的验收证据，写不出证据必须如实上报，不得静默。 |
| `a-wake-ack-audit.ndjson`（受管 ack，Batch 1） | **尽力写入**：写失败输出 `ACK_AUDIT_WRITE_FAILED`（stderr），不改变 ack 业务结果；审计文件不可写时不能保证该次操作留下审计行（规划师 r5 澄清，Batch 1 已验收口径，零改动）。 |
| `a-space-rebuild-audit.ndjson`（rebuild-space） | DENIED 行尽力写入（失败不掩盖拒绝结果）；授权决策行与 outcome 行写失败以异常浮出（manager exit 2），不静默、不伪装成功。 |

## 4. claim 归属字段（裁决 §三.4，审计用）

- `claimSpace` 审计行新增：`ownerAgentId`（= 调用者声明的 agentId）、`taskSpaceId`、`taskSpaceName`（取自模板认领后回读注册表的证据行 `SPACE_CLAIMED_TASK_ID/NAME`；取不到留 null，不臆造）、`conversation: null`（claim 无会话账本，不臆造）。
- **边界（裁决原文）**：Owner 元数据只用于归属识别与审计，**不得改变 #33 原有权限判断**——授权链 ledger binding → spaceTaken → allowlist → deny 未动一行。

## 5. 第 0 步元数据能力检查结论（2026-11-16，只读）

- 证据源：`EGO-LITE-HANDBOOK.md`（§2 TaskSpace/Page 模型、probe 钉扎自举、接管门条目）、`~/.agents/ego-taskspaces.json` 实际结构（schema/agents/{spaceName,active,known,releasePending,sweepPending}）、`agent-space.mjs`、`ego-fast-probe.mjs`、`dispatch-round/rebuild-space/claim-space/release-agent-space` 模板对 `listTaskSpaces()` 返回对象的字段使用。
- `listTaskSpaces()` / `taskSpace()` 对象在全部既有代码与手册中仅见字段：`id`、`taskId`、`name`、`ownership`（agent/user/null）、创建期 `profileId`；Page 对象见 `label`、`targetId`、`openedBy`、`url()`。
- **未发现任何 TaskSpace 自定义 label/description/owner 元数据接口** → 结论：**V1**（命名规范 + probe 日志 + 注册表 + 审计）。V2 仅在取得正式 API 能力证据后启用。
