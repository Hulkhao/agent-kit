# #27 裁决请求：TaskSpace 归属标注 + arm-on-wait 按需布防（附 4 项实机设计观察）

> 递交：原始网页 ChatGPT High（总规划师）｜递交人：本机项目主管 Agent｜日期 2026-11-16
> 本文件为自包含任务书：假设读者无本机近期会话上下文。所有事实均附出处。

## 一、背景与请求性质

Issue #27（PO 令 2026-11-11）提出两项改进提案，PO 指示送规划师裁决。**本请求只请求裁决与实施计划，不含已实施代码**；裁决结果由本地 Agent 另行排期实施。

- **提案 1（空间归属标注）**：TaskSpace 命名规范 `<project>-<用途>-<agent标识>-<日期>` 已部分执行，但缺归属字段，PO 无法判断空间是谁建的；期望 TaskSpace 支持 label/description 元数据（含 owner agent 名）且 `listTaskSpaces()` 可暴露，或至少固化命名规范并在 probe 启动日志打印 owner；另加清理纪律（会话级任务结束时关闭本空间全部非保留标签）。
- **提案 2（arm-on-wait 按需布防）**：现状 fast-poll 每分钟 goto 重载，即使「对端空闲、无待收回复」也常驻（耗配额+内存）。建议：仅在「已派单待回复/对端生成中」时布防快轮询，空闲即撤防；派单用按需标签（用完即关）；布防/撤防写账本（a-fast-state 增 `armed_reason` 字段）防止「撤防后忘布防」新盲区。原边界条件：撤防期间责任转移 = 派单 Agent 下一回合主动核查（当时引用 #25 缺口③ hook 强制注入方案——**现已实装实机验证，见下**）。

## 二、裁决依据的新实机证据（本机 2026-11-16，均已回报 GitHub）

1. **#25 缺口③ wake-guard 已实装并实机验收 E1~E4 全 PASS**（#25 评论 6901368270 / 6901378431 / 6901462764；E4 由 PO 确认全程零介入）：
   - 延迟唤醒回填注入（WAKE_PENDING + 60s 冷却 + Stop 接棒强制续回合）、watch 死亡检测重布防（WATCH_STALE）、守卫 deny 与注入并存、幂等安装、verify 只读。
   - 装机事故沉淀已落代码（commit 8d7f341：便携 node 机器裸 `node` ENOENT → install 写 node 全路径）。
   - **意义**：提案 2 的「撤防期间责任转移」从纸面方案升级为已验证的机器级强制机制，撤防安全性显著升级。
2. **#33 两缺口已实施落地**（commit def8784，评论 6901692504）：
   - collect 失败诊断三路 RECOVERY_DETAIL（DOM 锚点缺失 / API 取回分级失败 / 终态未证）+ DONE_CANDIDATE 活体证据冻结 + 服务端生成中断疑点启发式（>20% 缩水或 tailKey 变化 → OPERATOR_ACTION）。
   - 受管 `claim` 动作：与 rebuild-space 同构授权门（ledger 绑定 → spaceTaken → 机器本地 allowlist → deny）与审计台账；**绝不从接管信号自动触发**；接管失败路径统一输出 OPERATOR_ACTION 指引（交还 Ego UI 或受管 claim）。
   - **与提案 1 的关联**：若 TaskSpace 未来获得 owner 元数据，claim/audit 链可直接记录 owner 归属，提案 1 与 #33 天然衔接。

## 三、请求裁决的 4 项实机设计观察（E-25③ 实测发现，未修代码，留设计复核）

| # | 观察 | 行为证据 | 待裁决点 |
|---|------|----------|----------|
| a | wake-guard「整块抑制」：事件块首个 key 命中 60s 冷却 → 整块静默返回 null，同块其他**新**事件一并被吞 | E2 实测：首次 WATCH_STALE 展示被压一次，重放（重滚时间戳）才干净捕获 | 单键冷却 vs 逐事件冷却的取舍；是否改为逐事件冷却+块级去重 |
| b | 守卫机器级作用域：注入到达 PO 其他工作会话的工具调用，那些会话的 agent 依各自上下文把未处置标记 ack 成 `investigated`（非 Owning 会话、非 resolved） | E1 实测：两个跨会话 ack（本例良性，标记确实该处置） | 唤醒所有权语义：仅 Owning 会话可 ack？非 Owning 会话收到注入应如何处置？ |
| c | fail-open：AgentKit hook 规则未配 `onError:"deny"`，hook 进程级失败时工具调用静默放行 | 装机事故：node ENOENT 期间 78 条 hook.run.failed 全部静默放行（后修复） | 收紧为 deny-on-error 还是保持 fail-open（可用性 vs 强制力） |
| d | 宿主 hook 配置会话启动快照：中途改 config 不生效，必须重启 | 装机事故：修复后探针仍 failed，重启②后才生效 | 是否需要守卫自检/提醒机制（如 install 输出「需重启」醒目提示已有，是否还需运行时检测） |

## 四、提案 1 具体裁决问题

1. ego（ego lite）当前/规划中的 API 是否支持 TaskSpace 自定义元数据（label/description/owner）？若不支持或短期不可得，退而求其次的「命名规范固化 + probe 启动日志打印 owner」是否足够定版？
2. 命名规范最终形态：是否在 `<project>-<用途>-<agent标识>-<日期>` 基础上强制 agent 标识字段？与现有 `AGENT_ID`（跨任务稳定，如 gdc-b1-planner）如何对齐？
3. 清理纪律落点：会话结束关闭非保留标签——放进 `release` 动作扩展（受管、可审计）还是派单模板内置？需要保留哪些标签（如活跃会话页）？
4. 与 #33 claim 的衔接：空间 owner 元数据是否进 claim/audit 台账？

## 五、提案 2 具体裁决问题

1. `armed_reason` 状态机：布防触发（已派单 ACCEPTED/对端生成中）、撤防触发（COMPLETED/RELEASED 且无在途）的精确判据；账本字段与现有 a-fast-state/dispatch-state 的关系。
2. **与 wake-guard 的交互（关键）**：撤防后 watch 进程不存在，fast-state 陈旧——wake-guard 的 WATCH_STALE 判定会不会把「合法撤防」误报为「watch 死亡」？是否需要 disarm 状态豁免（armed_reason=DISARMED_IDLE 时静默）？
3. 按需标签生命周期：派单用完即关的标签与固定会话页的划分；对 #27 实测「常驻标签 4→2」的进一步收敛空间。
4. 撤防期间的兜底责任：wake-guard 已实证（E1/E2/E4），撤防是否还需额外的慢看守（如 10 分钟 API 慢看守仅在途时挂），还是完全交给 wake-guard + 下一回合核查？

## 六、本轮要求与约束

- **产出**：对第三~五节各项给出明确裁决（采纳/修正/否决 + 理由），并形成实施计划（落点仓库项、优先级排序、验收方式）；可指回 GitHub issue 或 handoff 分支承载设计文档。
- **约束**：实施仍由本地 Agent 按裁决执行；监控脚本/skill 维护口径不变（只改 agent-kit 仓库源）；PO 最终保留对方向性事项的否决权（裁决中如有方向性重大变更请单独标注，便于升级 PO）。
