# EGO-BROWSER（ego lite）完全替代 chrome-use/chatgpt-use 使用手册（唯一真源）

> 2026-11-07 由 GDC V5 任务一天内实战全链路验证整理（派单/监控/提取/迁移/429 应对全部真浏览器跑通）。
> **2026-11-08 定为唯一真源**：已并入《ego-lite工作流交接文档》全部增量；交接文档及旧版手册副本已删除，不再维护。
> **2026-11-08 节奏修订（PO 令）**：快轮询 3 分钟→**1 分钟**，看门狗 31 分钟→**15 分钟**（15 分钟无响应即主管介入判定「卡死/仍在处理」后重新布防）；配额影响与观察项见 §7。
> **规范监控脚本唯一存放点：`C:\Users\haohao\ego-tools`（独立 git 仓库）**；本手册不贴脚本源码，只指向。
> 适用：Windows + ChatGPT 网页多 Agent 派单场景。目标读者：接管派单与监控的执行 Agent。

## 0. 一句话总纲

**接口会骗人（限流/陈旧/冻结），页面才会说真话——但要先确认页面自己没死/没冻结；轮询用 DOM（零配额），提取才伸手 API（单次、必带 Bearer）；判定用状态翻转不用内容基线；每次唤醒都先「启动即提取」防吞交付；监控退出必须有人接棒；基线钉死在派单时刻。**

---

## 1. 环境与登录

1. 安装 ego lite（本机实测 0.6.2.8，CLI 命令 `ego-browser`，skill 版本 2.2.0）。安装后运行 `ego-browser skill`，它会打印与所装版本匹配的使用指南（**任何浏览器任务前必跑；升级后重跑**）。指南结尾必须是 `[ego-browser:skill] end of guide`，缺了=输出被截断，按指南存文件分段读。
2. **登录态（口径裁定 2026-11-08）**：**首次使用先检查是否已登录**；未登录则在 ego 浏览器窗口登一次，登录一次后长期有效。实测记载两种情形并存——一项目实测与主 Chrome 共享登录态（免登）、另一项目实测为独立 profile（需登一次）——**以实机为准，不预设**。
3. 编程模型：`ego-browser nodejs < 脚本.mjs`（Git Bash 支持重定向）跑脚本；**每次运行都是新进程**，但 TaskSpace/页面标签（p1/p2…）持久，用 `taskSpace("唯一名")` 恢复。Windows PowerShell 不支持 heredoc；**脚本一律走 UTF-8 `.mjs` 文件**：
   - 每轮新写完整文件（round-01.mjs、round-02.mjs…），不要改旧文件重放（每轮是新进程，旧步骤会重跑）。
   - 一个目标一个目录，如 `C:/Users/<name>/ego/<目标>-<日期时间>/`。
   - **中文只能进文件，不能进 `-e` 参数**（Windows PowerShell 5.1 会把 native 参数截断/乱码）。
   - 文件用编辑器工具写（UTF-8），不要用 PowerShell `Set-Content/Out-File/>`（会写 ANSI/UTF-16）。
   - 脚本在 Node.js 里跑，不在页面里：文件读写用 `await import("node:fs/promises")`；`process.env` 不继承 shell 环境变量，一切输入写死在脚本里；路径用绝对路径、正斜杠。
4. 只用指南列出的 API（TaskSpace/Page/mouse/keyboard），它不是 Playwright；缺的功能用 `page.evaluate()` / `page.cdp()` 逃生通道。

## 2. TaskSpace / Page 模型（易错点最多）

- **一个目标一个 TaskSpace**，跨轮用 `taskSpace("名字")` 复用（名字唯一；撞了别人的空间报 `EGO_TASK_SPACE_NAME_IN_USE`，换名即可）。
- Page 有永久标签（p1、p2…），跨轮持久；**JS 变量不持久**。
- **坑 1**：`task.page("p2")` 在标签不存在时是**异步抛错**，不是返回 falsy——`try { task.page("p2") } catch {}` 接不住。正确写法：
  ```js
  const pages = await task.pages();
  const page = pages.find(p => p.label === "p2") || await task.newPage();
  ```
- 复用 Page 用 `goto()`，不要每轮 newPage；**goto 前比对 URL 用 `includes(uuid)`，不要精确相等**——项目内会话 URL 形如 `https://chatgpt.com/g/g-p-xxx-项目名/c/<uuid>`，裸 `chatgpt.com/c/<uuid>` 会被重定向到项目 URL，精确比对会每轮误判重复导航。
- 任务完成才 `finish({ keep: [] })`；**长期值守的监控空间不要 finish**。
- 快照：`page.snapshot()` 取可交互树（含 ref），`{ scope: "full_page" }` 取全文（正文在视口外时必须用 full_page，结尾有 `[more content below the viewport]` 提示）。

## 3. ChatGPT 网页派单全链路（实测可靠序列）

| 环节 | 正确做法 | 坑 |
|---|---|---|
| 导航 | `page.goto(url)` + `waitForLoadState("load")` | 刚 load 完立刻 snapshot 可能缺 composer（水合瞬态），重取一次快照即可；URL 比对用 `includes(uuid)`（见 §2） |
| 观察页面 | `page.snapshot()` 语义快照带 ref；**输入框不在默认视口快照里，必须 `snapshot({scope:"full_page"})`** | 会话页 composer 是 `textfield "询问 ChatGPT"`，项目页新聊天是 `textfield "在"XX"中新建聊天"`；输入框是 contenteditable 不是 textbox；**坑 2：snapshot 偶尔不出 textbox 行——在发送按钮附近按行号上下文找** |
| ref 提取 | 快照行内格式是 `[ref=368]`，提取正则用 `ref=(\d+)` | 不是 `@368` 格式 |
| 填充 | `page.fill("@368", 文本)` | ProseMirror 富编辑器可直接 fill，长中文 markdown 精确落入；模型档位按钮旁直接显示「高」即高思考档就位 |
| 回读核对 | evaluate 取 `[contenteditable='true']` 的 innerText + **空白归一化 diff** | 旧选择器 `#prompt-textarea` 已随改版失效；fill 回执「formatted the text」警告**不算失败**；填充失败会静默，回读是唯一防线 |
| **发送** | **默认 `page.focus("@ref")` + `page.keyboard.press("Enter")`** | **口径裁定 2026-11-08：统一默认 Enter + 双验；Enter 失败再回退 click「发送」按钮**。实测记录：一项目 click 可用、另一项目新 composer 上 click 静默无效（文字留框、零气泡、无报错）——默认序=Enter，click 作回退双通道兜底 |
| URL 确认 | 发送后等 5~10 秒再取 URL | 过渡地址 `local-chatgpt%` 开头=草稿 id，必须重取真 `/c/<uuid>` |
| 发送双验 | DOM 确认 user 气泡 + 生成态（「停止」按钮出现）——缺一不可 | 命令「✓ Done」回执不可信（假成功事故多起） |
| 响应检测 | DOM 文本（「你说：」「ChatGPT 说：」） | 气泡 `data-message-author-role` 属性已彻底消失（见 §4 坑 5），以文本+停止按钮为准 |
| 页内 API | `page.fetch("/api/auth/session")` 拿 accessToken，再带 `Authorization: Bearer` 打 `/backend-api/conversation/<uuid>` | 同源带 cookie；**这是唯一允许的 API 用法：单次验证/提取，每次唤醒最多 2 个调用，禁止轮询** |

**静默生成死亡**（实测两次）：user 气泡入库、页面转空闲、但服务端没有任何 assistant 节点——用 API 核实后发短消息催办即可激活。

## 4. 回复提取（API 是唯一可靠全文通道）

标准姿势（在任一 chatgpt.com 页面上，每次唤醒最多 2 个调用）：

```js
const s = await page.fetch("/api/auth/session", { timeout: 25000 });
const token = JSON.parse(s.body).accessToken;   // 坑 3：不带 Authorization 头一律 404
const r = await page.fetch("/backend-api/conversation/" + uuid,
  { headers: { "Authorization": "Bearer " + token }, timeout: 30000 });
```

- **坑 4**：刚建的会话 API 可能 404（索引延迟），页面 DOM 却有内容——走 DOM 兜底（见下），稍后 API 自然可用。
- **坑 5**：ChatGPT 改版后 DOM 里 **`data-message-author-role` 属性已彻底消失**（连同 conversation-turn/agent-turn/article 全没），老的 evaluate 选择器全失效。可靠的 DOM 兜底 = **accessibility snapshot 全文落盘后按行解析**（取 `text "..."` 行，定位「ChatGPT 可能会出错」为终点）。
- 解析规则：mapping 的 messages 过滤 user/assistant/tool，按 create_time 排序；**提取作用域绝对化：以本次派单的 user 消息为界，之后的全部 assistant text parts 合并**（长回复拆多条、分块藏中段，禁只看尾部、禁与历史回复混淆）；完成终验 = 尾部 assistant `end_turn===true && status==="finished_successfully"`；卡死双证 = 尾部 `status==="in_progress"` 且 `create_time` 距今 >30 分钟（仅消息计数冻结不足为证——可能是单个超长工具调用未入库；死亡轮的 in_progress 消息 len=0，无内容可挽救）。
- **分块交付协议**（补丁类交付的可靠通道）：≤6KB 分块 base64，**必须经代码解释器 tool 输出打印**（正文手打必失真），每块 sha256 + 整包 sha256 三位一体；中途「消息传输超时」恢复后从断点续块不重打。
- **端点滞后/冻结**：实测页面持续推进（正文增长、回答完成）而 conversation GET 的 total 冻结在旧值、尾部停在 tool 消息——**端点会撒谎，页面是实时真相**。完成态与内容以 DOM 为准；API 提取等它追平（几分钟级）或直接走 DOM 提取（滚动+full_page 快照/evaluate 拉转写全文）。

## 5. ChatGPT 页面故障模式与处置（全部实测发生过）

| 故障 | 症状 | 处置 |
|---|---|---|
| **巨型会话（>2000 条消息）——最重要** | 发送通道坏死：提交即崩（Unknown error）、「✓ Done」假成功，会话越大越必然；页面渲染死：主区对话体永远出不来（空壳/挂 spinner，bodyLen≈400、0 消息气泡），侧栏报「无法加载历史记录」；侧栏列表本身还能渲染（登录是好的）；**API 读取仍然可用——只死发送不死读取**（page.fetch 带 Bearer 照样 200 拿全量 mapping） | **提前迁移，不要等坏死**：消息数接近 2000 或页面加载明显变慢即启动迁移。新会话首条消息发自包含简报（仓库基线 SHA、白名单、任务条款、交付协议、第一步动作），一发即活；旧会话转只读归档。**处置前先查远端 git 是否已有推送**（执行代理习惯增量提交，死的常只是聊天回复）。迁移时机禁忌：旧会话还有正在生成的回合时**不要**往新会话派同样任务（两个 Agent 重复造同一份补丁），先等生成结束（或确认死亡）再切 |
| 会话瞬断 | 「无法加载此 ChatGPT 对话」，刷新 1~2 次即恢复 | 按 PO 口径**先刷两次再判死**（死页梯子第一步，见 §6.2；同一会话一天内两次瞬断、第一次一刷就好） |
| 页面加载风暴 / 账号级 429 | **任何浏览器**打开会话页都报「无法加载此 ChatGPT 对话」或卡「正在加载个人资料」；API 同步 429「Too many requests」；侧栏列表可能仍渲染。根源：监控轮询+人工核查+发送共享同一账号配额，叠加超限 | **立刻停止一切 API 轮询（页面重载也耗配额！）**，只保留 DOM 读；**页面重试间隔 ≥9 分钟**、每次单发，期间只走 API 通道；窗口通常几十分钟内自行消退，消退判据=单次 API 探测 200。预防：快轮询必须纯 DOM（零配额），API 只用于唤醒后的单次验证/提取 |
| 生成静默死亡 | user 气泡在库、无 assistant 节点、页面空闲 | API 核实后发短消息催办即恢复（§3） |
| 新会话 API 索引延迟 | 刚建的会话 API 404，页面 DOM 却有内容 | 走 DOM 提取兜底，稍后 API 自然可用（§4 坑 4） |
| 端点滞后/冻结 | 页面实时推进而 conversation GET total 冻结在旧值 | 完成态与内容以 DOM 为准（§4） |
| 长回复分块 | 长回复拆多条 assistant 消息，分块可能藏在轮次中段的 tool 输出里 | **提取必须扫全响应并合并，禁只看尾部**（§4 分块交付协议） |

### 5.1 判定「回复完成」——状态翻转，不用内容基线

- 可靠信号：**「有可见停止按钮 → 没有停止按钮」的翻转** = 回答完成候选。再以 API 单次提取终验：尾部消息 `role=="assistant" && end_turn==true && status=="finished_successfully"`。
- **两个致命误判源**：
  1. 转写里折叠的活动日志含「正在思考」字样——**生成态探测只认可见的停止按钮（`offsetParent!==null`），禁止文本匹配「正在思考」**（会永久误判生成中）；
  2. 长工具链中间页面显示空闲（工具调用间隙）——**假完成**。对策：检测到翻转后等 75 秒再探一次（间隙会恢复生成，真完成保持空闲）+ 主管 API 终验。
- **基线吞噬铁律**：完成判定用状态翻转或「派单时刻钉死的计数基线」，**禁止用回复完成后采集的内容哈希/计数当基线**——那会把完整回复吞进基线、相对变化永不触发（实测漏抓 15 分钟）。**监控随派单启动就是这个危险时序**：监视器启动/重启时页面已空闲 → 必须先做一次「启动即提取」比对派单基线（见 §6.3 startIdle）。

## 6. 双循环监控（PO 定稿架构，勿改结构）

**规范脚本唯一存放点：`C:\Users\haohao\ego-tools\monitor\`（独立 git 仓库）**——`ego-fast-probe.mjs`（探测本体）+ `fast-poll.sh`（脚本1 快轮询）+ `watchdog.sh`（脚本2 看门狗）+ `a-watch-uuid.txt.example`。**要改脚本只改 ego-tools 这一份**（历史实战副本在 GDC 各项目 worktree 里，随任务清理失效，不再引用）。
> 本机部署状态（2026-11-08）：ego-tools 仓库部署于 haohao 机；本机（Administrator）尚无副本。本机需要跑双循环监控时，先从源机同步/克隆 ego-tools 到本机固定位置并在此登记路径，不得在项目里散落脚本副本。

架构（PO 定稿；节奏 2026-11-08 修订，原 3 分钟/31 分钟）：**脚本1** 每 1 分钟轮询一次窗口，看是否抓到回复；**脚本2** 每 15 分钟看一下结果有没有得到处理，没有得到处理就退出唤醒主管——**大模型介入一次：判定是卡死了还是仍在处理，然后重新激发脚本**；全面智能审查什么卡住了、有没有得到结果，然后整个重新做计划。

### 6.1 部署（新项目接入 4 步）

1. 把 `monitor\` 三个脚本复制到目标项目监控目录（如 `<项目>\.monitor\`）。
2. 改 `ego-fast-probe.mjs` 头部两个适配点：①`MON`=本部署监控目录（正斜杠绝对路径）；②`SPACE`=taskSpace 唯一名（每项目/每 Agent 一个，撞名报 `EGO_TASK_SPACE_NAME_IN_USE`）。
3. 复制 `a-watch-uuid.txt.example` 为 `a-watch-uuid.txt`，填被监视会话 UUID（`chatgpt.com/c/` 后那串，一行纯文本）。
4. 两个脚本都用受管后台任务跑（如 ZCode Bash 的 run_in_background，**绝不能 `&` 脱离后台**——脱离后退出叫不醒人，实测要靠杀进程重建），**脚本退出=任务通知=唤醒信号**。

### 6.2 设计要点（每条都是实测事故换来的）

- 脚本1（快轮询）**纯 DOM 读，零脚本侧 API 配额**——这是快轮询节奏的前提（1 分钟节奏下页面加载 60 次/小时，配额观察项见 §7）。判定=「可见停止按钮」的生成→空闲翻转 + 75 秒确认窗（滤工具链间隙假阳性）。它只报候选，真伪由主管 API 终验。
- 脚本2（看门狗）**单实例=单 15 分钟窗口**：先睡满 15 分钟再判定（等待在前、判定在后），结果未处理即退出唤醒主管；主管审查后**必须重新布防**（重启脚本2；脚本1 若因抓到回复退出，取走交付后也重启）。
- **退出即接力**：任何唤醒处理后不允许出现无脚本值守的空窗（实测 7 小时空转事故的根因）。
- probe 内置硬化（规范版已含，勿删）：每轮全新 `goto`（ChatGPT SPA 会冻结渲染，`page.reload()` 常落 43 字符空壳）；就绪等待只认**正文 >600 字符**（上限 40s——空壳也带「发送」按钮，按按钮判就绪会假阳性）；goto/渲染失败 → **8 分钟退避**（退避期只刷状态文件时间戳）；**死页梯子**：见死标 → 刷 2 次 → 仍死记 1 strike → **8 分钟后再试** → 连续 3 strikes 才判会话真死并唤醒主管；恢复渲染后 strike 清零。
- **恢复首轮若为空闲态 → startIdle=true → 强制走「启动即提取」复核**（防吞退避期间已到达的回复）。
- 判定元素：状态文件 `a-fast-state.json`（ts/generating/everGenerating/doneCandidate/startIdle/len/gapRejected/deadStrikes…），看门狗读它判「快轮询死了（≥7 分钟没更新）/startIdle/未处理」。**Windows 上 Python `open()` 默认 GBK，状态文件含中文必须 `encoding='utf-8'`**（实测崩溃教训；规范版 watchdog 已修）。

### 6.3 唤醒信号处置表

| 信号 | 含义 | 主管动作 |
|---|---|---|
| `REPLY_ARRIVED_WAKE_SUPERVISOR`（脚本1） | 翻转确认，回复到达候选 | API 单次终验（tail assistant+end_turn=true）→ 提取结果 |
| `CONVERSATION_DEAD_WAKE_SUPERVISOR`（脚本1） | 死页梯子 3 strikes，会话判死 | 深查/重派/迁移 → 全套重启 |
| `WATCHDOG_15MIN_NO_REPLY_WAKE_SUPERVISOR`（脚本2） | 15 分钟窗口结束结果未处理 | 全面审查：状态文件 generating=？ 仍在生成→简短复核后重启看门狗；卡死→深查/重派/迁移→全套重启 |
| `REPLY_ARRIVED_BUT_UNHANDLED_15MIN_WAKE_SUPERVISOR` | 回复到达但主管没处理（跟丢保护） | 立即提取，并复盘第一次唤醒为何没接 |
| `STATE_MISSING / WATCHDOG_TRIGGER(stale>=7min)` | 快轮询死亡 | 修快轮询（页面失附→重新 goto）→全套重启 |
| `startIdle=true` | 监视器启动/恢复时页面已空闲（基线时序风险） | 「启动即提取」：单次 API 比对派单基线，防吞已到达回复 |

## 7. 统一参数表（唯一口径）

| 参数 | 值 | 适用场景 | 备注 |
|---|---|---|---|
| 快轮询间隔 | **1 分钟**（sleep 60s + 探测耗时，有效 ~65~100s/轮） | ego 双循环脚本1 | PO 2026-11-08 令（原 3 分钟）；**旧 16 铁律的「90~100 秒」是 chrome-use/chatgpt-use 路由口径，不适用于 ego 纯 DOM 双循环** |
| 快轮询页面加载频次 | 60 次 goto/小时（600 轮上限 ≈10h 值守） | 配额观察项 | 每轮全新 goto=页面重载，页面自身拉会话数据、耗账号配额（3 分钟→1 分钟压力 ×3）；出现加载变慢/429 征兆按 §5 处置并回调节奏（如回 3 分钟） |
| 看门狗窗口 | 15 分钟 | 脚本2 单实例 | 睡满再判（等待在前、判定在后）；未处理即退出唤醒，主管介入判定卡死/仍在处理后重新布防 |
| 翻转确认窗 | 75 秒 | 生成→空闲翻转后 | 滤工具链间隙假完成 |
| 状态陈旧阈值 | ≥7 分钟 | 看门狗判快轮询死 | 快轮询死亡信号 |
| 死页梯子 | 刷 2 次 → strike → **8 分钟退避** → 3 strikes 判死 | monitor probe 内 | 恢复渲染 strike 清零；恢复首轮空闲强制启动即提取 |
| goto/渲染失败退避 | 8 分钟 | monitor probe | 退避期只刷状态文件时间戳 |
| 429/加载风暴页面重试 | **≥9 分钟**、每次单发 | 账号级限流期 | 期间停一切 API 轮询、只走 API 通道取数（§5） |
| 卡死判定 | `in_progress` 且 create_time 距今 >30 分钟 | API 终验 | 双证才算死；仅计数冻结不足为证 |
| 巨型会话迁移阈值 | 消息数接近 2000 或页面明显变慢 | 迁移时机 | 提前迁移，不等坏死（§5） |
| 发送后取真 URL | 等 5~10 秒 | 派单 | `local-chatgpt%` 过渡地址作废 |
| 页面就绪判定 | 正文 >600 字符（等待上限 40s） | monitor probe | 空壳也带「发送」按钮，勿按按钮判就绪 |
| 分块大小 | ≤6KB base64 | 补丁类交付 | 必经代码解释器 tool 输出打印（§4） |
| API 用量 | 每次唤醒最多 2 个调用 | 验证/提取 | 禁轮询；429 期停一切 API 轮询 |

## 8. Windows / Git Bash 环境坑（与 ego 无关但同场实测）

1. Windows 编码三坑：Python `open()` 默认 GBK（加 `encoding='utf-8'`）；subprocess 输出默认 GBK（加 `encoding='utf-8', errors='replace'`）；PowerShell 5.1 把 UTF-8 文件读成 ANSI（长脚本一律走 .mjs 文件）。
2. Git Bash 里 `powershell -Command "...$_..."` 会被 bash 展开毁掉——复杂 PowerShell 逻辑写成 `.ps1` 文件再 `-File` 执行。
3. Windows 后台进程要杀 ego/node 时：`Get-CimInstance Win32_Process` 按 Name+CommandLine 过滤拿 PID 再 `Stop-Process`（`wmic` 已不可靠）。
4. 跨 bash/pwsh 传路径一律 Windows 绝对路径（Git Bash 的 `/tmp` 会被 pwsh 解析成 `C:\tmp`）。

## 9. 其他实战纪律（沿用 16 铁律中仍适用者）

1. 填充后必须回读核对（归一化 diff），发送后必须双验（user 气泡+生成态）。
2. 多会话并发时每个 Agent 用独立 taskSpace 名；操作前核对页面 URL，防串会话误发。
3. 发送内容先查敏感信息（密钥/密码/内网地址/客户隐私）。
4. 一问一答：网页 GPT 不会自主推进，收到阶段性回复必须立即裁定并下发下一步，不留无主空转会话。
5. 会话用完 `task.finish({keep:[]})` 或按需保留；测试产生的草稿会话记得清理（长期值守的监控空间除外，见 §2）。
6. 大输出不整读进主上下文：提取先落盘文件再脚本化解析。
7. 长寿命会话要主动管理轮次（大会话是定时炸弹）；监控永远做成「退出即唤醒」的受管后台任务（§6.1）。

## 10. 新机快速上手顺序

1. 安装 ego lite → 打开 ego 浏览器，**先检查 ChatGPT 是否已登录**（§1 口径），未登录登一次。
2. `ego-browser skill` 通读指南（升级后重跑）。
3. 取规范脚本：复制（或 clone）`C:\Users\haohao\ego-tools\monitor\` 三件套到目标项目 `.monitor\`，按 §6.1 改 2 个适配点 + 填 uuid。
4. 派单流程：goto 会话页 → full_page 快照找 textfield（§3 两种文案）→ fill+回读 → **focus+Enter**（失败回退 click）→ 5~10 秒后取真 UUID → DOM 双验。
5. 同时启动 fast-poll.sh + watchdog.sh（受管后台，不得 `&`）；被唤醒按 §6.3 处置；处理完重新布防。
6. 会话消息数接近 2000 → 提前按 §5 迁移（自包含简报开新会话）。
