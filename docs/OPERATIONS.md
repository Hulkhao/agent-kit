# 运维手册：空间归属与清理合同（#27 Batch 2）

> 版本 1.0（2026-11-16）。依据：规划师裁决 `docs/planning/issue-27-ruling-20261116.md` §三 + §六 Batch 2 表。
> 口径：**V1**——TaskSpace 归属以「命名规范 + 注册表账本 + probe 日志 + 审计行」承载。第 0 步只读检查未发现 ego lite 暴露 TaskSpace 自定义 label/description/owner 元数据 API（证据见 §5），不等待、不臆测 API；V2（原生元数据）待取得正式 API 能力证据后另行立项。

## 1. 命名规范（冻结形态，裁决 §三.2）

- **新建** TaskSpace 必须命名：`<project>-<purpose>-<AGENT_ID>-<YYYYMMDD>`。
  - `project` / `purpose` 段：字母数字与点、下划线（不含连字符，保证 AGENT_ID 字面量无歧义）；
  - `AGENT_ID`：跨任务稳定（不得用临时 session ID，不得省略），即注册表绑定的那个 id；
  - `YYYYMMDD`：8 位创建日期。
- **校验落点 = 新建分支，fail-closed**：`ego-fast-probe.mjs` 自举分支与 `dispatch-round.template.mjs` Gate 1.5 创建分支在调用 `taskSpace(SPACE, { profileId })` 创建前执行校验（canonical 函数 `agent-space.mjs` 的 `isValidNewTaskSpaceName`），不匹配即 `TASKSPACE_NAMING_VIOLATION_STOP`，不创建。
- **只约束新建**：不迁移、不改名旧空间。复用路径（probe/round 的 `targetSpace` 命中分支）与受管 `rebuild-space` 恢复路径**不做命名校验**——旧命名空间照原名复用/恢复是既定纪律（rebuild 走 #31 授权链：registry binding → spaceTaken → allowlist → deny）。
- `listTaskSpaces()` 使用处一律不加改名逻辑（V1 无归属元数据）。

## 2. AGENT_ID 稳定性与 owner 日志

- `AGENT_ID` 是注册表（`~/.agents/ego-taskspaces.json`）绑定与全部审计行的归属主键；更换 AGENT_ID 视同归属易主，需 PO 授权。
- probe 启动行打印 Owner（空格分隔格式不变）：
  `PROBE_BOOT version=<ver> space=<space> mon=<mon> owner=<AGENT_ID>`
  用途：stale-copy 哨兵 + 归属核对；监控输出流中即可核对「哪个 Agent 在守哪个空间」。

## 3. release 清理边界表（裁决 §三.3，受管 release 动作扩展）

落点：`monitor/release-agent-space.template.mjs`（release 主流程收尾后的受管 sweep），审计文件 `<监控根>/a-release-sweep-audit.ndjson`。

| 对象 | 处置 | 判据 / 审计 reason |
|---|---|---|
| 当前 release 会话页 | 关闭 | 既有 closePage / finish 逻辑（不在 sweep 内重复处理；残留只保留不关，`RELEASE_TARGET_RESIDUAL`） |
| 其他会话页：账本**终态**（COMPLETED/ABORTED/RELEASED） | **关闭** | 注册表 known 集合内 + 会话账本状态终态；`TEMP_RESULT_PAGE_FINISHED_DISPATCH` |
| 其他会话页：账本**活跃**（未终态） | 保留 | `ACTIVE_DISPATCH_LEDGER` |
| 会话页账本缺失 / 不可读 / 结构损坏 | 保留 | `LEDGER_UNPROVEN` |
| 空白页（about:blank 等） | 保留 | 无法证明「临时」，保守默认（send 恢复路径可能复用） |
| URL 不可读 / 未注册 / 归属不明 | 保留 | `OWNERSHIP_UNPROVEN` |
| TaskSpace 本身 | **不删除** | sweep 只关页，不动空间 |

- **保守默认（fail-closed）**：无法明确归属「临时」的页面一律不关。
- **逐页审计**：每页一行 `{ts, action:"release-sweep", agentId, space, conversation, page:{label,uuid}, decision, reason}`（decision = closed / kept / close-failed / skipped / sweep-failed）。只记录 id 类字段与理由，不含任务/回复正文。
- **清理失败必须报告**：任一应关页关闭失败、页面枚举失败或审计行写失败 → `RESULT=AGENT_SPACE_RELEASE_SWEEP_FAILED`（manager 分类为 exit 2，真实上报，不伪装完整 release）；OPERATOR 指引指向 sweep 审计文件与幂等重跑。
- **幂等**：无临时页 → zero-close 也算成功（`RESULT=AGENT_SPACE_RELEASED`）；重复 release 命中注册表早退路径，直接成功且零浏览器调用。

## 4. claim 归属字段（裁决 §三.4，审计用）

- `claimSpace` 审计行新增：`ownerAgentId`（= 调用者声明的 agentId）、`taskSpaceId`、`taskSpaceName`（取自模板认领后回读注册表的证据行 `SPACE_CLAIMED_TASK_ID/NAME`；取不到留 null，不臆造）、`conversation: null`（claim 无会话账本，不臆造）。
- **边界（裁决原文）**：Owner 元数据只用于归属识别与审计，**不得改变 #33 原有权限判断**——授权链 ledger binding → spaceTaken → allowlist → deny 未动一行。

## 5. 第 0 步元数据能力检查结论（2026-11-16，只读）

- 证据源：`EGO-LITE-HANDBOOK.md`（§2 TaskSpace/Page 模型、probe 钉扎自举、接管门条目）、`~/.agents/ego-taskspaces.json` 实际结构（schema/agents/{spaceName,active,known,releasePending}）、`agent-space.mjs`、`ego-fast-probe.mjs`、`dispatch-round/rebuild-space/claim-space/release-agent-space` 模板对 `listTaskSpaces()` 返回对象的字段使用。
- `listTaskSpaces()` / `taskSpace()` 对象在全部既有代码与手册中仅见字段：`id`、`taskId`、`name`、`ownership`（agent/user/null）、创建期 `profileId`；Page 对象见 `label`、`targetId`、`openedBy`、`url()`。
- **未发现任何 TaskSpace 自定义 label/description/owner 元数据接口** → 结论：**V1**（命名规范 + probe 日志 + 注册表 + 审计）。V2 仅在取得正式 API 能力证据后启用。
