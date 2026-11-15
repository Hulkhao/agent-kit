# #27 规划师裁决记录（2026-11-16）

> 裁决人：原始网页 ChatGPT High（总规划师）｜整理：本机项目主管 Agent
> 源回复：本机规划师会话 6aef2c2e…（派单 bf84a6e7，回复 18743 字节，API_FINAL_VERIFIED，SHA256 77bab370cb9cc4dd6e9d587629913a8ee1b213c7a5922390ab55400c9015051e，原文存于本机 .monitors/planner-27 会话目录）
> 请求任务书：docs/planning/issue-27-planner-brief-20261116.md（commit 375fcd6）

# 一、总裁决

**#27 = CONDITIONAL GO。两提案均批准，分三批次实施：Batch 1（wake-guard 可靠性，P0）→ Batch 2（TaskSpace 归属治理，P1）→ Batch 3（arm-on-wait，P2，依赖 Batch 1）。**

关键判断：#25 的 E1~E4 通过意味着 wake-guard 可以承担新责任，但不等于具备任意场景的 24×7 监控能力；「事件驱动恢复」≠「持续监控」。

# 二、四项实机设计观察裁决

## 观察 A：wake-guard 整块抑制 → 修正后采纳：改逐事件冷却
- 废除「events[0] 命中冷却 → 整块返回 null」；改为逐事件冷却（冷却中的旧事件不得吞掉同块新事件）。
- 事件身份键：`eventType + wakeId + monitorRoot`（无 wakeId 用稳定来源标识）。
- 同批 4 个新事件：展示前 3 个，其余 additional 计数。
- 落点 wake-context.mjs；验收六步：A 冷却中 B 正常注入；A、B 同块重复出现块内去重；重复 B 按 B 自己冷却；不同 root 的 UNKNOWN 不互相掩盖；等（详见裁决原文）。

## 观察 B：跨会话 ack → 修正后采纳：分级 ack 权限（**需 PO 确认 2**）
- 不采用绝对 Owning-only；分级：`investigated` = 任何有明确身份的授权 Agent 实际调查后可执行；`resolved` = Owning 会话或受管 claim 接管者。
- 非 Owner 宣告 resolved 必须 fail-closed；claim 是跨会话接管的唯一受管通道，ack 不得绕过 claim。
- 审计要求：wakeId、ackAction、执行 Agent、可靠时的 session/conversation ID、时间；独立审计记录承载（不扩 #25 冻结的 ego-watch-exit/v1 七字段合同）。

## 观察 C：hook fail-open → 收紧：PreToolUse 加 onError:"deny"（**重大变更，需 PO 确认 1**）
- 负责工具权限门禁的 PreToolUse hook 必须 onError:"deny"：进程无法启动/异常退出 → 拒绝工具调用。
- 范围严格限定权限门禁规则；wake-context 文件读取失败维持 UNKNOWN，不变健康；不因注入失败改 deny 判断。
- 安装器幂等写入 + verify 检查；重复规则报错不静默修复。
- 代价（PO 需知悉）：node 损坏/hook 无法启动时工具被阻断——安全性与可用性的明确取舍。

## 观察 D：配置快照 → 采纳现有机制，否决运行时检测
- 保留安装时 RESTART REQUIRED 醒目提示；verify 只管磁盘配置正确性；否决 PreToolUse 自检推测宿主快照与新增后台监控。

# 三、提案 1（TaskSpace 归属标注）裁决

1. **元数据 API 能力未证实 → 两级方案**：V1 立即采用命名规范 + probe 启动日志（不等待 V2）；V2 仅在取得正式 API 能力证据后启用原生元数据。
2. **命名规范冻结**：`<project>-<purpose>-<AGENT_ID>-<YYYYMMDD>`；AGENT_ID 必须跨任务稳定（不用临时 session ID，不许省略）；probe 启动日志必须打印 TaskSpace 名称与 Owner Agent ID。
3. **清理纪律落点 = 受管 release 动作扩展**：只清理当前任务拥有的 TaskSpace 的临时标签/临时结果页；活跃会话页、用户明确保留页、其他 Agent 页面、归属不明页不触碰；不删空间本身；清理结果入审计；清理失败必须报告不得伪装完整 release；重复 release 幂等。
4. **claim/audit 补 owner 归属字段**（ownerAgentId/taskSpaceId/taskSpaceName，可靠时加 conversation/session 标识）；**只用于归属识别与审计，不得扩大 #33 权限**——原授权链 ledger binding → spaceTaken → allowlist → deny 原样保持。

# 四、提案 2（arm-on-wait）裁决

1. **armed_reason 状态机**：a-fast-state 增字段，冻结四态：`DISPATCH_ACCEPTED`（布防运行）/`PEER_GENERATING`（运行）/`DISARMED_IDLE`（撤防停止）/`ARMED_UNKNOWN`（保持运行，状态缺失/损坏/冲突/无法确认一律进此态，不得擅自撤防）。旧账本无字段按旧模式运行，不得自动推断撤防。
2. **布防判据**：派单 ACCEPTED 前后先持久化布防状态再投递；对端确认生成后升 PEER_GENERATING；任一在途即保持布防。**撤防判据（全部满足）**：所有相关 dispatch COMPLETED/RELEASED + 无待收回复 + 无其他在途 + 无未处置 wake marker + 无未完成监督接棒；顺序：新派单先布防再投递（不得出现「已派出但显示撤防」窗口）；正常结束先确认终态无在途，再写撤防，最后停 watch。
3. **WATCH_STALE 豁免表**：DISARMED_IDLE 且交叉验证通过 → 豁免；DISARMED_IDLE 但 dispatch-state 仍有在途 → UNKNOWN 不豁免；DISARMED_IDLE 但有未 ack wake → 保留对应唤醒事件；WAKE_PENDING/SUPERVISION_PENDING/读取失败一律不豁免。
4. **按需标签两类生命周期**（固定会话标签长期保留；派单临时标签用完即关），关闭动作与 release 清理共用一套机制。
5. **否决新增 10 分钟慢看守**：撤防期间完全交给 wake-guard + 下一回合核查。边界：wake-guard 是事件驱动恢复，非 OS 级 24×7 守护；宿主完全无新事件时 watch 死亡不能保证立即发现，文档不得承诺实时发现；若 PO 需要「无论宿主是否活动 10 分钟内发现异常」属独立架构需求另行立项。

# 五、三项方向性重大变更（PO 确认结果 2026-11-16，AskUserQuestion 实答）

| # | 变更 | 规划师裁决 | **PO 终局** | 处置 |
|---|------|-----------|------------|------|
| 1 | PreToolUse fail-open → deny-on-error | 收紧（重大变更） | **维持 fail-open** | **PO 否决收紧建议，实施范围剔除该项**；按冲突处置纪律记录双方观点与风险：规划师认为 fail-open 与 #25 fail-closed 合同冲突（78 条 hook.run.failed 静默放行的装机事故为据）；PO 选择保持可用性优先，风险自知并接受（hook 进程故障时守卫静默放行，依赖探针判别法兜底）。后续如需重启讨论，以本记录为凭 |
| 2 | 跨会话 ack 权限分级 | 分级（修正后采纳） | **采纳分级** | Batch 1 落地：investigated 开放 / resolved 限 Owner 或 claim 接管者；独立审计承载 |
| 3 | 常驻 fast-poll → 按需布防 | 分阶段批准 | **采纳按需** | Batch 3 落地，依赖 Batch 1；撤防期兜底 = wake-guard + 下一回合核查 |

# 五-原、三项方向性重大变更（规划师原始裁决，供对照）

1. **PreToolUse fail-open → deny-on-error**：hook 进程异常将直接阻断工具调用（安全性↑可用性↓）。
2. **跨会话 ack 权限分级**：investigated 开放给调查后的授权 Agent；resolved 限 Owner/claim 接管者。
3. **常驻 fast-poll → 按需 fast-poll**：空闲撤防省资源；撤防期间不再有持续轮询。

# 六、实施批次与验收门禁

## Batch 1（P0，先做）：wake-guard 可靠性修订
- 落点：hooks/wake-context.mjs（逐事件冷却+块内去重）、hooks/pre-tool-use.mjs（ack 身份与权限分级）、monitor/install-zcode-guard.mjs（deny-on-error）、tests/wake-guard.test.mjs、tests/dispatch-governance.test.mjs、docs/ACCEPTANCE-PLAYBOOK.md（回归合同）。
- 验收：冷却中的旧事件不阻断新事件；跨会话 investigated 正常；非 Owner resolved 被拒；claim 接管后 resolved 正常；hook 进程故障→工具调用被拒；健康路径 deny 行为不变；安装器幂等、verify 可识别配置错误。

## Batch 2（P1）：TaskSpace 归属治理
- 落点：TaskSpace 创建/list/probe 调用模块（命名规范+Owner 注入）、probe 启动日志打印 owner、dispatch-manager release 清理接线、claim Owner 审计字段、测试、OPERATIONS.md 空间归属与清理合同。
- 第一步先只读检查 Ego API 元数据接口（无证据直接走 V1）；验收 7 项（新建空间必含 AGENT_ID、probe 打印 owner、release 只关临时标签、活跃页/保留页不受影响、重复 release 无副作用、claim/audit 记录归属、原权限门禁全过）。

## Batch 3（P2，依赖 Batch 1）：arm-on-wait
- 落点：dispatch-manager 布防/撤防触发、dispatch-state 在途核对、a-fast-state 写入模块 armed_reason、wake-context 合法撤防豁免、测试、playbook 新增按需布防实机验收。
- 验收矩阵 11 场景 + 资源对照 4 项（空闲/在途进程数、空闲无意义 goto、新派单布防空窗）。

## 派单顺序
1. 先向 PO 呈报三项重大变更取得方向确认 → 2. Batch 1 → 3. 独立验收 Batch 1（新旧行为对照）→ 4. Batch 2 → 5. Batch 3 → 6. 最终 E2E（派单→布防→生成→唤醒→调查→ack→release→撤防全链）。
