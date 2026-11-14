# EGO-BROWSER（ego lite）完全替代 chrome-use/chatgpt-use 使用手册（唯一真源）

> 2026-11-07 由 GDC V5 任务一天内实战全链路验证整理（派单/监控/提取/迁移/429 应对全部真浏览器跑通）。
> **2026-11-08 定为唯一真源**：已并入《ego-lite工作流交接文档》全部增量；交接文档及旧版手册副本已删除，不再维护。
> **2026-11-14 节奏修订（PO 令）**：快轮询 **30 秒**；看门狗在无实质进展默认 **10 分钟**后唤醒 Agent，间隔可由 `monitor/supervision.config.json` 动态修改；3 轮无进展升级 PO，详见 §6。
> **规范监控脚本唯一存放点：agent-kit 官方仓库 `monitor/` 目录（PO 令 2026-11-08 并入，原独立 ego-tools 本地仓库停用为历史归档）**；本手册不贴脚本源码，只指向。
> 适用：Windows + ChatGPT 网页多 Agent 派单场景。目标读者：接管派单与监控的执行 Agent。

## 0. 一句话总纲

**接口会骗人（限流/陈旧/冻结），页面才会说真话——但要先确认页面自己没死/没冻结；轮询用 DOM（零配额），提取才伸手 API（单次、必带 Bearer）；判定用状态翻转不用内容基线；每次唤醒都先「启动即提取」防吞交付；监控退出必须有人接棒；基线钉死在派单时刻。**

---

## 1. 环境与登录

1. 安装 ego lite（本机实测 0.6.2.8，CLI 命令 `ego-browser`，skill 版本 2.2.0）。安装后运行 `ego-browser skill`，它会打印与所装版本匹配的使用指南（**任何浏览器任务前必跑；升级后重跑**）。指南结尾必须是 `[ego-browser:skill] end of guide`，缺了=输出被截断，按指南存文件分段读。
2. **登录态（口径裁定 2026-11-08）**：**首次使用先检查是否已登录**；未登录则在 ego 浏览器窗口登一次，登录一次后长期有效。实测记载两种情形并存——一项目实测与主 Chrome 共享登录态（免登）、另一项目实测为独立 profile（需登一次）——**以实机为准，不预设**。
   **多 profile 机器必须账号钉扎（PO 令 2026-11-08，issue #7 根因）**：`taskSpace(名字)` 按名复用旧空间，`profileId` 只在创建空间时生效（`taskSpace(名字, { profileId })`，`profiles()` 列本机 profile）——复用错号建的旧空间会永远用错号跑（实测：无会员账号整会话静默 mini 档）。因此：①本机先配 `~/.agents/ego-profile.json`（模板见 skill `config/ego-profile.example.json`，含 defaultProfileId/defaultAccount/spaceExpect，**永不进仓库**）；②新建空间一律带 profileId；③派单发送前核对页面实际账号（`/api/auth/session` 的 user.email）与钉扎是否一致，不符/无配置/字段缺失一律 STOP 报人，不猜账号；④旧空间不能换账号，不符只能重建空间或人工登录正确账号。校验工具：本仓库 `monitor/ego-profile-check.mjs`。
3. 编程模型：`ego-browser nodejs < 脚本.mjs`（Git Bash 支持重定向）跑脚本；**每次运行都是新进程**，但 TaskSpace/页面标签（p1/p2…）持久，用 `taskSpace("唯一名")` 恢复。Windows PowerShell 不支持 heredoc；**脚本一律走 UTF-8 `.mjs` 文件**：
   - **#17 三环境命令对照（agent-kit#17，2026-11-10 复现）**：Git Bash：`ego-browser nodejs < script.mjs`（stdin 重定向）；cmd：`ego-browser nodejs < script.mjs`（stdin 重定向）；PowerShell：`ego-browser nodejs -e "await import('file:///C:/path/script.mjs')"`（`-e` 动态导入文件）。
   - **#17 错误用法**：`ego-browser nodejs script.mjs`（将路径直接作为参数）→ CLI 把路径当内联 JS 求值，不会打开文件；实测报 `ReferenceError: round is not defined`（具体标识符随文件名变化）。
   - 每轮新写完整文件（round-01.mjs、round-02.mjs…），不要改旧文件重放（每轮是新进程，旧步骤会重跑）。
   - 一个目标一个目录，如 `C:/Users/<name>/ego/<目标>-<日期时间>/`。
   - **中文只能进文件，不能进 `-e` 参数**（Windows PowerShell 5.1 会把 native 参数截断/乱码）。
   - 文件用编辑器工具写（UTF-8），不要用 PowerShell `Set-Content/Out-File/>`（会写 ANSI/UTF-16）。
   - 脚本在 Node.js 里跑，不在页面里：文件读写用 `await import("node:fs/promises")`；`process.env` 不继承 shell 环境变量，一切输入写死在脚本里；路径用绝对路径、正斜杠。
4. 只用指南列出的 API（TaskSpace/Page/mouse/keyboard），它不是 Playwright；缺的功能用 `page.evaluate()` / `page.cdp()` 逃生通道。

## 2. TaskSpace / Page 模型（易错点最多）

- **一个 Agent 一个固定 TaskSpace，多个任务多个 Page**。每个 Agent 设置稳定 `AGENT_ID`（如 `gdc-exec-a`）和易读中文 `SPACE`（如 `GDC-本地执行A`），两者跨任务保持不变；同机登记账本 `~/.agents/ego-taskspaces.json` 会拒绝同 Agent 第二空间及不同 Agent 共享空间。任务在同一空间内用会话 UUID 区分，不能按标签序号猜页面归属。
- **空间生命周期**：使用 `monitor/dispatch-manager.mjs` 统一执行发送、探测、监控、完整回复收集及释放。内部通过 `agent-space.mjs` 登记；收集完整回复并校验本地回执后，关闭该 Page；最后一个任务结束才 `task.finish({keep:[]})`，并检查所有标签均为已登记的 Agent 来源。旧英文空间保持既有名称；不能因新规范抢占用户空间或更名运行中的空间。
- **ego lite 0.6.2.10 升级接管门（#25）**：`listTabs()` / `taskSpace()` / `task.pages()` 遇到 `You now control this task space. Reply 'continue' when ready and I will resume.`（包括被其他错误包装的原因），或 `listTaskSpaces()` 查到目标空间 `ownership=user/null`，均视作 `EGO_TASKSPACE_TAKEOVER_REQUIRED`，不可按页面死亡反复 goto。监控与派单在访问页面前统一验证空间归属，空间缺失时派单禁止隐式新建。主管先 `listTaskSpaces()` 找目标空间的 `id` → 人工确认后执行 `claimTaskSpace(id)` → 重跑 probe → 恢复双循环监控。脚本只报警，绝不自动抢回用户接管的空间。升级后新会话 `page.fill('询问 ChatGPT', ...)` 可能抛 `ElementResolutionError`，不能据此断言 aria-label 已改变；按模板分级定位 Composer，并以实际 DOM 全文回读验收。
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
| 填充 | **600 grapheme 目标 + 1200 UTF-8 字节硬上限；每块 `insertText` 后回读整个 Composer 的累计前缀**（R2.6-F） | 以 Composer 实际内容为准，调用 CDP `Input.insertText`，以 Composer 累计前缀回读证明成功；禁用 `document.execCommand`；只有仍等于上一累计前缀才允许当前块重试一次；部分、乱序或无法判定立即 STOP。原生 `paste()`、`fill()` 和单次长文本插入不作为可靠投递通道 |
| 回读核对 | 每块回读整个 Composer 并核对累计前缀；最终块结果复用为 Gate 6 全文 verdict | 未完全一致不得发送；`goto` 后旧草稿复活 = STOP 标 `DRAFT_PERSISTED`，不覆盖、不追加、不发送；Composer 空态 innerText 是 `"\n"`（长度 1），勿用 `length===0` 判空 |
| **发送** | **`page.focus("@ref")` + 单次 `page.keyboard.press("Enter")`** | 先把 `SEND_STARTED` 持久化，Enter 执行后用尾部 user unit-key 与生成态双验。抛错或双验不足先检查账本并标 `UNCERTAIN`，禁止再点 click 或重发；发送前按钮 disabled 时先按恢复合同重读。页面内 `el.focus()` 不足以路由键盘事件，必须 ego 级 `page.focus("@ref")` |
| URL 确认 | 发送后等 5~10 秒再取 URL | 过渡地址 `local-chatgpt%` 开头=草稿 id，必须重取真 `/c/<uuid>` |
| 发送双验 | 结构化证据：**尾部 unit key 前进为 `:user`** + 停止按钮出现（生成态）——缺一不可 | 命令「✓ Done」回执不可信（假成功事故多起）；「你说：/You said:」计数在虚拟化 DOM 下不可靠，禁作基线 |
| 响应检测 | 结构化尾部（`data-content-search-unit-key` 末段 role + assistant DIL UUID，见 §6.2 DOM 契约）+ 可见停止按钮 | `data-message-author-role` 属性已彻底消失（§11.10），文本标记（「你说」等）禁作状态依据 |
| 页内 API | `page.fetch("/api/auth/session")` 拿 accessToken，再带 `Authorization: Bearer` 打 `/backend-api/conversation/<uuid>` | 同源带 cookie；**仅允许 GET 只读诊断/提取，每次唤醒最多 2 个调用，禁止后台 API POST/PUT/PATCH/DELETE 代发消息，禁止轮询**；404 `conversation_inaccessible`（见 §4）不得据此判会话死亡 |

**模型/思考强度 UI 预检（2026-11-08 实测）**：禁用 chip 文案匹配档位（中文界面也可能显示英文 High）。模型选择读取 `menuitemradio` 的 `aria-checked`，目标 GPT-6 必须 `aria-checked=true`；思考强度读取 `slider` 的 `aria-valuemin`/`aria-valuemax`/`aria-valuenow`（Plus 实测 min=0、max=2、now=2 对应 High）。**不再匹配旧文案「高，第 3 项，共 3 项」**；五档会员的 High 数值需独立校准。**locale 边界（R2.5 裁定）：读取属性 locale 无关，但入口按钮不是**——中文按钮 `aria-label="选择 ChatGPT 模型"` 在英文界面不存在（部分英文界面变体甚至没有模型菜单入口，agent-kit#7 实测）；菜单打不开或读不到 = `LEVEL_GATE_MENU_UNAVAILABLE_STOP` fail-closed，**禁止静默跳过预检继续发送**（实测事故：跳过后会话从建号起静默跑在 mini 档）。英文界面 Agent 的兜底：把 chatgpt.com 界面语言切回中文，或事后用 conversation API 的 `metadata.model_slug` 审计已产出的回复档位。**composer 定位必须按 aria-label 定向**（`询问 ChatGPT`/`Ask ChatGPT`），禁止「第一个 contenteditable」——半渲染代码块的 Edit code 编辑器与其同类，会误吸填充（#7 实测）。

**静默生成死亡**（实测两次）：user 气泡入库、页面转空闲、但服务端没有任何 assistant 节点——用 API 核实后发短消息催办即可激活。

**附件上传 DOM 契约（2026-11-08 实测 19 文件一次挂载成功，issue #4；挂载验证补强 2026-11-09，issue #12）**：源码/任意类型附件走 composer 的 `input[aria-label="附加文件"]`（accept 为空的通用 input）；「拍照/添加照片/附加照片或视频」类按钮均限 `accept=image|video`，**不能用于源码附件**。顺序固定：**先 `setInputFiles` 一次性挂全部文件 → 再 fill 文本 → Enter 一次发送**（不要挂一个发一个）。**挂载验证（#12-3 实测）**：`data-testid=attachment-token/file-token` 类选择器在当前 UI 匹配 0，按文件类型验收：普通文件查 form 内文件名 chip，图片查上传前后缩略图数量增量；所有类型都要确认发送按钮 enabled；且**上传进行中发送按钮保持 disabled**——chips 出现≠可发送，必须轮询发送键 enabled 再 Enter（~50-100KB md 附件实测 4-8s）。附件落在代码解释器 `/mnt/data`，可绕过「沙箱无法承接多文件」类阻断。**大 payload 分流（2026-11-10 更新）**：payload 超过约 4KB 时优先按 §3.2 走 GitHub 文件指针；若仓库不可读，可使用已授权文档连接器或本节附件通道。附件发送只在 Composer 放短封面（派单号、附件清单、验收标准、第一步动作），上传完成且发送按钮可用后再发；分块 insertText 用于短文本及文件通道均不可用时的少量兜底，不再将 75KB 级任务书作为长正文发送。**产物下载通道序（2026-11-09 补，PO 确认方向）**：取对端产物文件（代码解释器输出、ZIP/PATCH、导出文件等）按序降级——①**首选 `page.waitForEvent("download")`**（ego 官方一等 API，`ego-browser skill` 指南有全例）：**先 arm 事件再点下载触发钮**（竞态），`download.saveAs("/绝对路径")` 必须在脚本回合内完成（临时文件回合结束即删）；②事件超时或 UI 无下载钮 → 页内 fetch 文件端点（`/backend-api/files/<id>/download` 带 Bearer）写盘，遵守 §页内 API 纪律（token 只留内存、每次唤醒 ≤2 调用）；③末端才是 DOM 抄文本/要求对端贴全文（字节保真无保证，敏感红线同 §11）。禁止在不知道①存在的情况下直接跳②③绕远路。监控侧与模板均采用分级 Composer 定位：`dispatch-state.mjs` 的 `readComposerSurface` 与模板的 `evaluateComposer` 都用 `querySelectorAll` 枚举可见候选，按 aria-label（`询问 ChatGPT`/`Ask ChatGPT`）→ id/testid（`prompt-textarea`）→ 非代码编辑器的 contenteditable 分级选择；模板读取、清空、填充复用同一定位逻辑，不再用按 DOM 文档序返回首个匹配的 `querySelector`（#14）。含代码块页面不再误读出假 FOREIGN_DRAFT_STOP（#9 实测）。**严格度差别（终审裁决 2026-11-10）**：模板 evaluateComposer 同级多匹配即 fail-closed（返回空/走失败路径）；监控侧 readComposerSurface 为 find-first 取第一个可见候选——两者分级顺序一致但歧义处理严格度不同，监控侧以读取为主、无同级多匹配误判实测证据，暂不收紧。


**键盘输入约束（#29）**：禁止用 `page.keyboard.type` 注入含换行符的正文，换行可能触发真实 Enter 造成分段误发。统一入口使用 CDP `Input.insertText` 分块填充、累计回读、发送前聚焦与一次 Enter。

### 3.1 R2.5 派单冻结事务链（R2.6-F 自适应填充扩展，LIMITED GO · AUTHORIZED，规划师裁决 reply-r43）

**核心验收哲学**：不会误发、不会重复发、不会覆盖用户草稿、不会因页面冻结丢失派单。完整链路：**PREPARED → 分块插入 + 每块累计前缀回读 → Gate 6 全文 verdict → 刷新 Composer ref → 所有权确认 → SEND_STARTED → Enter → AUTO_ACCEPTED**；任何一步无法证明，都不得进入下一步。规范模板：`templates/dispatch-round.template.mjs`（九闸门实现，新派单任务照抄改适配器，不要徒手重写）。

**R2.5 复审补强（reply-r44 REWORK REQUIRED 定点修正，全部已落地模板）**：①账本读取 fail-closed——冻结事件/派单账本**文件缺失=可证明为空**，**读取损坏/IO 错误必须 STOP**（`FREEZE_LEDGER_READ_FAILED`/`DISPATCH_LEDGER_READ_FAILED`），绝不把读失败当「没有记录」；②PREPARED 持久化**前移到首次填充之前**（中断后凭持久化身份恢复，不靠运行时现场）；③导航只有**一个 `navigate(reason)` 入口**（单一 gotoAt 时间戳 + GOTO_ATTEMPT 事件），模板禁止直接 `page.goto`；**任何 goto 后必须重跑草稿复活检查**（重读 Composer → 所有权 → 必要时清空 → 验空）；④发送路径**只允许 snapshot/ref/focus 重试**：focus 成功后发送最多执行一次——发送按钮**不存在也是 STOP**（`SEND_BUTTON_MISSING_STOP`），SEND_STARTED 后先对当前 Composer 做最终内容复核，Enter 单独 try、抛错即标 UNCERTAIN 且**绝不重进发送循环**；⑤**所有 Composer evaluate/读取统一包进冻结通道**（composerOp 包装），初始表面读、草稿读、清空、复核无一例外。

- **账本指纹化（R2.5 起）**：PREPARED 记录只存 `payload_sha256` / `payload_bytes` / `composer_baseline`，**禁止保存完整提示词正文、前缀后缀片段、事件日志正文、诊断用 Composer 全文副本**。哈希是指纹不是匿名化——泄漏原文的风险不因哈希消除，绝不能把哈希当脱敏后仍可外发的原文用。
- **R2.6-F 填充分块规则**：以 grapheme cluster 为单位（`Intl.Segmenter`），600 grapheme 为目标、1200 UTF-8 byte 为硬上限；非末块边界尽量移入下一行内部，字节上限不允许时回退到上一行内部；`chunks.join()` 必须精确还原原文；单个 grapheme 超过字节上限报 `CHUNK_GRAPHEME_EXCEEDS_LIMIT`。每块 `insertText` 后回读整个 Composer：累计前缀等于预期新前缀=成功（不使用 `document.execCommand`）；仍等于上一前缀=等待后复读，确认仍未变化才重试当前块一次；部分、乱序或无法证明= `CHUNK_READBACK_MISMATCH` STOP；最后一块回读复用 Gate 6，不重复读取。
- **两级回读核对**：普通文本走**归一化**（折叠空白伪影 `\s+→" "` 后比对）；含 URL / 代码块 / 命令行（`/https?:\/\/|www\.|```|^\s*[$>]/m` 命中）走**严格保真**原文比对；每块累计前缀使用**完整 payload 的 readbackMode**，不能因敏感标记尚在后续块而提前降级为普通文本；innerText 无法证明严格保真即 STOP（`SENSITIVE_FIDELITY_UNPROVEN`）。
- **草稿所有权（R2.5-O）**：Composer 现文必须等于本次 payload 全文、或为其按顺序的有效前缀（同样空白折叠后比对），才算「我们的草稿」；历史草稿只凭持久化哈希精确匹配认领；**禁止把任意子串当所有权证据**；空草稿是独立分支。不归属 → `FOREIGN_DRAFT_STOP` 停止；确认为自己的残留才清空（`selectNodeContents` + `deleteFromDocument`，清空后必须回验空态）。
- **URL × CJK 分块回读与残留草稿恢复（#30）**：严格模式对 contenteditable 顶层连续 `<p>` 使用逐段 `innerText`、以单换行拼接，避免浏览器整体 `innerText` 在段落边界额外插入换行；无法识别段落结构仍由严格保真门禁拒绝。因中断遗留草稿时，先核对会话 UUID、TaskSpace、原始任务全文和 PREPARED 账本。原账本仍在会话目录时，使用 `recover-draft` 携带原文文件；原账本已归档时额外传 `--archived-record`，仅在现行账本缺失且归档中的 PREPARED 指纹和身份一致时独占恢复。例：`node monitor/dispatch-manager.mjs recover-draft --monitor-dir <监控根目录> --agent-id <AgentID> --space <空间名> --conversation <UUID> --message <原始v1全文文件> --archived-record <归档PREPARED账本路径>`。命令只经管理器清除**归属已证实**的残留草稿并验空，将账本置 `ABORTED`，输出 `OWNED_DRAFT_CLEARED` 后才允许另行 `send` 新任务。命令失败、原文缺失或草稿归属无法证明时保留现场，不人工清稿、不发 v2。
- **SEND_STARTED 后锁定**：状态一旦进入 SEND_STARTED 及之后，禁止清空、重填、重发；进程重启后先对账，UNCERTAIN 由主管人工裁定，不自动重发（at-most-once）。
- **发送 ref 生命周期**：每次 focus 尝试前重新 `page.snapshot()` 取新 ref（旧 ref 跨尝试不复用）；最多 3 次 focus 尝试；发送按钮 `disabled` = 陈旧页，先 goto 刷新重读再发；`markSendStarted` 必须持久化在 Enter **之前**。
- **FRESHEN 机制**：距上次成功导航已累计 ≥3 次完整填充尝试 → **在下一次填充之前**（绝不之后——goto 会毁掉当前草稿）执行 `navigate("FRESHEN")` 并清零计数，防 Composer 冻结后 ref 陈旧、事件失灵。
- **Composer 冻结处置**：填充/回读中 evaluate 报错 → 记 `COMPOSER_RENDER_FREEZE` 事件（单写入口：只允许 dispatch-state.mjs 写，probe 只消费）→ 走共享风暴通道（`CHAT_SURFACE_STRUCTURALLY_UNAVAILABLE` + ≥9 分钟绝对 deadline，按 SPACE 相位错峰，实测退避约 9~11 分钟）→ 退避到期**单次** `COMPOSER_FREEZE_RETRY`。注意语义：重试的是「页面恢复」这一步，**不是盲重发消息**——消息本体在恢复后由派单模板走完整九闸门续投，PREPARED 指纹账本保证不重复发送。重试失败重新武装（更长退避），绝不退化成 GOTO_FAILED/8 分钟通道。
- **Gate 7.1 model_slug 历史诊断（#26 补充）**：标准模板在 SEND_STARTED 之前调用 conversation API；历史 slug（包括 mini/wm）仅写 `MODEL_HISTORY_AUX`，不能代表当前轮次所选模型，也不能拦截已通过当前 Chat 模式与 High 滑杆门禁的派单。接口 429/404/无权限/缺字段 → 记录 `MODEL_HISTORY_AUX_UNAVAILABLE`。**统一 STOP 合同按持久账本判定发送结果，适用于所有失败原因**：先输出 `DISPATCH_LEDGER`（status、dispatchId、SHA 前 12 位、matchesCurrent）；只有 conversation UUID、TaskSpace 与本轮 payload SHA 全匹配，才能把 `ACCEPTED/COMPLETED` 判为 `DISPATCH_ACCEPTED_WAKE_SUPERVISOR`（已接受，立即布防双循环，禁止重发），把 `SEND_STARTED/UNCERTAIN` 判为 `DISPATCH_ATTEMPTED_WAKE_SUPERVISOR`（接受未证实，先对账，禁止重发）。同时输出原始 `STOP_CAUSE`；账本为旧消息或不匹配时保留原始 STOP，不得声称本轮已发送。每轮派单 API 预算仍为 2 次（session + conversation），accessToken 不落日志。
- **Probe 钉扎式自举（r45 LIMITED GO，issue #6）**：目标空间不存在时，probe 必须读本机 `~/.agents/ego-profile.json` 的 `defaultProfileId` 显式传 `taskSpace(SPACE, { profileId })` 创建——无配置（`TASKSPACE_BOOTSTRAP_NO_PIN`）、Profile 不在 `profiles()` 清单（`TASKSPACE_BOOTSTRAP_PROFILE_UNKNOWN`）即停；创建后复核 name/ownership/profileId（`TASKSPACE_BOOTSTRAP_VERIFY_FAILED`），成功留 `SPACE_BOOTSTRAPPED` 事件。已存在空间 Profile 不符（双侧都暴露时）= `TASKSPACE_PROFILE_MISMATCH_STOP`，不删除不抢占。**禁止裸 `taskSpace(SPACE)` 自动创建**——那是 mini 事故根因。

### 3.2 GitHub 优先的项目材料交接（两人项目组）

**文件走 GitHub，网页只发短消息和定位指针。** 项目已有 GitHub 仓库、双方已有读写权限时，任务书、代码摘录、证据、测试结果、补丁与交付文件优先放对应**项目仓库**。既有项目材料直接指向版本化路径；临时往返材料在同仓库单独建 `handoff/YYYYMMDD-任务名` 分支，并集中放在 `.handoff/任务名/` 下。临时分支与开发主线隔离，不将交接文件直接混进 `dev` / `main`。不为两人协作引入额外服务或审批层。

**发送流程**：发送方将材料提交并推送到已授权的项目仓库 → 获取**完整 40 位 commit SHA** → 通过网页发一条短消息，包含 `owner/repo`、分支、完整 SHA、材料路径、任务目标和交付要求。收件方先按 `SHA:文件路径` 读取，并核对路径与版本；成功读取再执行任务，不能只看到分支名就假定读的是原文件。更新材料或返回产物时再提交新 commit，回传新 SHA 和路径；同一轮不得默默改用分支最新 HEAD 覆盖原锚点。

**失败与备用通道**：用户已明确确认收件方的 GitHub 仓库权限时，单次 SSL/网络故障不能当作对端无权限；先记录真实连接错误并恢复后重试读取。仓库不存在、实际权限不足、SHA/路径错误或读取失败，原样报告实际错误及未获取的材料。若已授权 Google Drive 等文档连接器且能读取该文件，改发连接器可访问的文档链接/标识；否则使用 ChatGPT 附件通道（§3 的挂载、确认规则），**不退回大段网页正文反复粘贴**。只有短指令、短问答直接用 Composer；原 §3 的约 4KB 阈值只用于选择“短文本还是文件”，文件默认先选 GitHub，再选文档连接器/附件。

**清理与边界**：任务收件方确认已获取且交付完成后，临时分支可以由有权限的人员按既有授权清理；删除分支或 `.handoff/` 文件**不代表从 Git 历史、镜像、缓存彻底删除**。Cookie、Token、密钥、客户隐私和不适合进入远端历史的材料不得提交；这类材料仅使用获准的私密通道。不得为了传料强制推送、改动无关代码或更换仓库/账号绕过权限。GitHub 仅承载材料；§3.1 的网页发送九闸门、派单幂等和 §6 监控不变。

## 4. 回复提取（2026-11-08 起：以页面 DOM 结构化证据为准，API 为辅助通道）

**本机实测事实（2026-11-08，R2 验收裁决）：**
- 当前账号的 conversation API **不携带 `execution_output`**（工具输出 mapping 的 `len=0`）；API 未返回工具输出 ≠ 助手没有生成输出。
- `page.fetch` 的 `/backend-api/conversation/{id}` 返回 404 `conversation_inaccessible`（提示要求登录）；同一授权上下文下 conversations 列表虽 200 但 `items=[]`——页面 fetch 通道缺可用 bearer token。
- **不得把该 404 解释为会话已删除、不存在或永久死亡**，也不得据单一账号实测推断所有授权环境均不可用。
- 当前监控以页面 DOM 的结构化 unit-key 与 assistant DIL UUID 为消息身份依据（§6.2 DOM 契约）；conversation API 只有在授权上下文明确且返回有效内容时才可作辅助证据，**不得覆盖 DOM 身份证据**。
- 分块交付以页面 DOM 实际可见的助手文本为提取来源；无法提取时由发送方/助手以纯文本重发；每块独立 SHA256 + 整包 SHA256 验证，不得仅凭分块数量或页面「已分析」提示认定完整。

标准姿势（授权上下文可用时，每次唤醒最多 2 个调用）：

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

### 5.1 判定「回复完成」——结构化状态翻转，不用内容基线

- UI 状态只由结构化证据判定：**generating 只认可见 Stop 控件（`offsetParent!==null`）**，禁匹配「正在思考」等文本；**dead/unavailable 禁全文/子串匹配「无法加载此 ChatGPT 对话」等可被会话引用的字符串**。
- 页面不可用：以 ChatGPT 主机、就绪门槛、Composer 控件等结构化证据判断；结构缺失时重试记 strike（状态字段 `unavailableStrikes` / `unavailablePersistent`），三次仍失败只报告 `CONVERSATION_UNAVAILABLE_PERSISTENT`，**不声称已证明会话永久死亡**。
- 可靠信号：**「有可见停止按钮 → 没有停止按钮」的翻转** = 回答完成候选。DONE 判定（75 秒确认窗后）：生成控件消失 + **Composer 为空（判空语义 = `composerText.trim() === ''`，`composerLength` 固定保留原始 `innerText.length`，R2.3 已核实落地实现）** + **尾部 assistant DIL UUID 稳定** + 消息长度稳定 + 无 busy/progress 控件。仍只是 `DONE_CANDIDATE`，主管终验后才 COMPLETED。
- 工具调用专用选择器未取得真实 DOM/Accessibility 样本前，`toolState=UNOBSERVED`，不得伪造工具状态。
- **两个致命误判源**：
  1. 转写里折叠的活动日志含「正在思考」字样——**生成态探测只认可见的停止按钮，禁止文本匹配**（会永久误判生成中）；
  2. 长工具链中间页面显示空闲（工具调用间隙）——**假完成**。对策：检测到翻转后等 75 秒再探一次（间隙会恢复生成，真完成保持空闲）+ 主管终验。
- **基线吞噬铁律**：完成判定用状态翻转或「派单时刻钉死的计数基线」，**禁止用回复完成后采集的内容哈希/计数当基线**——那会把完整回复吞进基线、相对变化永不触发（实测漏抓 15 分钟）。**监控随派单启动就是这个危险时序**：监视器启动/重启时页面已空闲 → 必须先做一次「启动即提取」比对派单基线（见 §6.3 startIdle）。

**等待轮执行约束（#28）**：必须调用统一管理器 `watch/probe` 及 `readComposerSurface` 的结构化状态。单个停止按钮信号或文字标记不构成生成/完成判定；持续一个确认窗仍有矛盾时先取尾部 key、长度和 DOM 状态证据，不得原样反复运行临时探针。

**已发生的案例**：页面恢复后，停止按钮持续显示、正文停在约 295 字超过 5 小时、未观察到活动标记；执行 Agent 复核后手动点击停止。该案例证明需要“看门狗唤醒 Agent 复核”这条应急路径，但**文本一段时间不增长、停止按钮持续出现或单次 15 分钟超时，均不足以自动判定僵尸轮**；长工具链可能长时间没有可见正文。

看门狗配置的无进展窗口触发、快轮询状态超过 7 分钟未更新，或其他明确异常出现时，由本地 Agent 执行：

1. **留现场**：记录时间、会话 UUID、最后状态文件时间戳、`generating` / `startIdle` / 尾部消息标识、最近几条脱敏监控事件；不记录提示词正文、令牌或客户数据。
2. **复核是否仍有进展**：单次读取结构化 DOM 状态和既有事件日志，比较前后有无尾部 assistant UUID 变化、工具活动或进度信号；页面不可用按 §6.2 死页/退避梯子，不用高频刷新制造压力。证据不足就保留现有任务、重新布防并在下个窗口复核。
3. **裁定后动作**：若已确认收到完整回复，按 §4 提取并关闭本轮监控；若确认僵死，先保留证据再由 Agent 决定是否手动停止、发短催办或迁移会话。停止后核对旧轮确已终止、提交账本状态明确，再考虑新轮；禁止一边旧轮仍在生成一边重派同一任务。
4. **预案无法覆盖**：按 §9.1 查重/上报 Issue，说明“疑似”“已确认”分别有哪些证据；能继续的主线继续，不能恢复的明确报告阻塞。**不通过故意卡死、密集刷新、异常注入来演练。**

## 6. 双循环监控（PO 定稿架构，勿改结构）

**规范脚本唯一存放点：agent-kit 官方仓库 `monitor/` 目录（PO 令 2026-11-08 并入）**——`dispatch-manager.mjs` 为统一入口，内部复用 `ego-fast-probe.mjs`、`supervision-watchdog.mjs`、`dispatch-state.mjs`、`collect-reply.template.mjs` 和 `release-agent-space.template.mjs`。`fast-poll.sh` 与 `watchdog.sh` 仅保留用于旧部署迁移。**要改脚本只改 agent-kit 仓库 monitor/ 这一份**。
> 历史说明（2026-11-08）：原 ego-tools 内容已并入 `agent-kit/monitor/`。新机以当前 `agent-kit/monitor/` 为来源部署监控脚本，无需再克隆已归档的 ego-tools。

架构（PO 2026-11-11 修订）：一个受管 `watch` 任务运行两条逻辑循环。每约 30 秒快探测 DOM，并读取配置与结构化状态，默认连续 **10 分钟无实质进展**才退出要求 Agent 智能审查。完成候选触发 `REPLY_READY_WAKE_SUPERVISOR`，由接棒 Agent 调用 `collect` 提取全文并保存回执、`consume` 确认交付、`release` 回收 Page；提取失败立即要求审查。正常长任务有真实进展时无需唤醒。三轮都无进展升级 PO，外部消息通知后续另接。

### 6.1 部署（新项目接入）

1. 各机更新 agent-kit 并运行 `deploy.ps1`。ZCode `PreToolUse` Hook 安装器会保留原有配置并备份。首次部署后需在真实 ZCode 会话核对 Hook 的拒绝行为。
2. 选定稳定的 `--agent-id` 和易读的中文 `--space`，以及 `--monitor-dir`（项目监控目录）。一个 Agent 的任务共用同一空间，任务以各自 `--conversation` UUID 隔离。
3. 已知会话用 `send --conversation <UUID> --message <文件路径>` 派单；新会话用 `send-new --request-id <请求UUID> --message <文件路径>`，由管理器绑定并返回真实会话 UUID，后续用实际 UUID 启动受管命令 `node monitor/dispatch-manager.mjs watch --monitor-dir <目录> --agent-id gdc-exec-a --space GDC-本地执行A --conversation <UUID>`。管理器负责初始化模板及会话目录中的状态文件。出现 `REPLY_READY_WAKE_SUPERVISOR` 时 Agent 执行 `collect`、读取回执文件并交付结果，再 `consume --reply-sha256 <回执SHA256>`，最后执行 `release`；以上命令复用同一组身份参数。
4. 如需调节干预频率，修改 `<目录>/conversations/<UUID>/supervision.config.json` 中的 `supervisionMinutes`（1–60，默认 10）与 `maxAbnormalRounds`（默认 3）。Agent 复核后使用 `node monitor/dispatch-manager.mjs ack --monitor-dir <目录> --agent-id <ID> --space <空间名> --conversation <UUID> --wake-id <唤醒ID> --ack-action investigated`，问题已解决改为 `resolved`。
5. 以宿主受管任务方式运行 `watch`，核对其退出能实际递交给本地 Agent 的通知或回调。`WAKE_SUPERVISOR` 日志和退出码仅是信号；无实际接棒证据时按 §6.4 上报能力缺失。保留既有空间和运行中的 Page，不对用户空间做破坏性测试。

### 6.2 设计要点（每条都是实测事故换来的）

- 快轮询 **DOM 为主要状态证据**，不在正常每 30 秒轮询中调用 conversation API（R2.4 起驻页探测约 6 次 goto/小时，见 §7）。判定=「可见停止按钮」的生成→空闲翻转 + 75 秒确认窗（滤工具链间隙假阳性）。完成候选由管理器优先 DOM 提取，必要时一次 API 辅助验证；无法确认本次派单边界就停止释放并交给 Agent。
- 监督模块 `supervision-watchdog.mjs` 在每轮快探测之后执行，重读会话目录配置。`supervisionMinutes` 允许 1–60（默认 10），`maxAbnormalRounds` 默认 3。无真实进展超过间隔才唤醒；接棒 Agent 完成实际检查后使用管理器 `ack`，`investigated` 重新计时，已解决用 `resolved` 重置异常轮次。未确认的唤醒再次运行只输出 `MONITOR_WAKE_UNACKNOWLEDGED`，禁止假装已处理。第三轮仍无进展输出 `USER_ESCALATION_REQUIRED`，由主管联系 PO；IM/邮件暂不自动发送。
- **退出后必须有实际接棒**：任何告警后先确认本地 Agent 收到任务退出通知并处理；未证明通知链路时不得宣称“已唤醒”或“有人值守”（实测 7 小时空转事故的根因）。
- **良性信号自愈（issue #8，2026-11-09 起）**：fast-poll.sh wrapper 对 `START_IDLE_WAKE_SUPERVISOR` 类「重启即自愈」良性信号自动重启 probe 并留痕（`BENIGN_SIGNAL_SELFHEAL=… streak=n/20`），连续超过 20 轮仍良性才真退出唤醒——消除「wrapper 退出后接棒单点」的 50 分钟空窗形态（实测 2026-11-08）。`REPLY_ARRIVED`（DONE_CANDIDATE）/`CONVERSATION_DEAD` 等需主管裁决的信号维持真退出。
- **长任务巡检纪律（issue #8）**：主管处于长任务链（派单/执行/多任务并行）时，值守健康巡检（`a-fast-state.json` 时间戳、fast-history.log 尾部）纳入任务步骤前后的检查点；发现 `STATE_MISSING` 或 wrapper 已退出（日志尾部 `fast-poller exit`）立即接力重启，不允许把唤醒留给「之后有空再说」。
- probe 内置硬化（规范版已含，勿删）：**R2.4 起快轮询三分支驻页探测（FINAL PASS 65c78e4）**——STAY 轮（页面就绪）0 goto 零加载；CALIBRATE 轮（距 navRef ≥10 分钟）1 次 goto 校准；RECOVER 轮（页面失就绪/timeOrigin 读取失败）走恢复。navRef = max(lastGotoAt, performance.timeOrigin)；goto 全部收敛到统一 `navigate(reason)` 入口（单一 `gotoAt` 时间戳 + GOTO_ATTEMPT 事件）。就绪等待只认**正文 >600 字符**（上限 40s——空壳也带「发送」按钮，按按钮判就绪会假阳性）；**例外：NEW_CONV 类导航（新聊天落地页，无会话体可渲染，#12-1 实测 bodyLen 455-467）**就绪改认结构化证据——composer（aria-label 口径）与模型菜单按钮同时存在且 bodyLen>300，空壳防线不放宽（会话页仍按 >600）。goto/渲染失败 → **8 分钟退避**（退避期只刷状态文件时间戳）；**死页梯子**：见死标 → 刷 2 次 → 仍死记 1 strike → **8 分钟后再试** → 连续 3 strikes 才判会话真死并唤醒主管；恢复渲染后 strike 清零。dispatch 侧 `PAGE_NOT_READY_AFTER_NAVIGATE` / `COMPOSER_SURFACE_UNAVAILABLE` abort 后**不自行重试导航**，转交既有 probe 恢复流程（含本梯子），避免双责任方写同一梯子状态（规划师裁决 2026-11-10）；会话页 `bodyLen≈305-308`（侧栏完整、主区空）是实测可恢复形态（#21/#23），梯子轮次内不判死。429/加载风暴与 Composer 冻结走共享风暴通道（`CHAT_SURFACE_STRUCTURALLY_UNAVAILABLE` + `stormBackoffDeadline` = max(8min, 9min+SPACE相位)，单次重试由 planStormRecovery 把关，失败重新武装，详见 §3.1）。
- **恢复首轮若为空闲态 → startIdle=true → 强制走「启动即提取」复核**（防吞退避期间已到达的回复）。
- **Page 恢复顺序（#18 R1，send 自动恢复补充）**：先盘点 `task.pages()` 受管 Page 与 `task.tabs()`（含 unmanaged）。受管 Page 按目标 conversation UUID 的 URL 完整路径段判定：唯一匹配即复用；多匹配 `PAGE_URL_MATCH_AMBIGUOUS` 立即 STOP，绝不按历史 `pageLabel` 消歧。受管零匹配时，先查 unmanaged：仅有一条目标 UUID 匹配、host 严格为 `chatgpt.com`（HTTPS）且 `openedBy=agent`、`targetId`/Page 身份证据齐全才 `adopt`；多条匹配熔断，证据不全 `PAGE_ADOPTION_EVIDENCE_INCOMPLETE` STOP，不接管用户来源页。无可收养目标时，`send` 可复用唯一已确认 Agent-owned 空白 Page（`about:blank` 或 `chrome://new-tab-page/`，匹配 tabs 的 label/targetId），或在其它受管 Page 全部为已识别会话、没有空白页时为目标会话 `newPage()`；零 Page 时同样新建。新建和空白页复用均走 `navigate("CONVERSATION_PAGE_RECOVERY")` 恢复原 UUID，再通过原派单闸门。此类自动恢复无需向 PO 申请重开页。未知 URL、URL 读取失败、多空白页或所有权不明时按证据报错并停止，避免占用其它任务 Page。probe 维持自身已有的恢复与 reservation 契约。
- **自写 round 脚本常见踩坑（issue #12 实测 2026-11-09）**：①`taskSpace(SPACE, {profileId})` 只允许出现在**创建分支**——对已存在空间带 profileId 调用会报错；复用路径必须先 `listTaskSpaces()` 找到已有空间后按 id 裸调用（规范 probe 自举即此写法，照抄）；②**ref 跨进程不复用**：旧 ego-browser 进程快照里的 ref 在新进程中一律失效（比「跨尝试不复用」更严），跨进程只信任结构化重定位（aria-label/URL/UUID）；③派单账本文件名是 `a-dispatch-state.json`（带 `a-` 前缀），自定义脚本 patch 时易写错。
- **当前 ChatGPT 尾部消息 DOM 契约（实测 2026-11-08，R2.2 落地于 `dispatch-state.mjs`）**：
  - 读取最后一个可见 `[data-content-search-unit-key]`，取 key 最后一个冒号后的 `user` / `assistant` 作为 `lastMessageRole`。
  - assistant 的 `lastMessageKey` 只取该 unit 内唯一一个 `[data-dil-response][data-dil-message-id]` 的完整 UUID；缺失、格式非法或出现多个候选时置空并 fail-closed。
  - user 的 `lastMessageKey` 使用 unit key（例如 `fallback-turn-N:M:user`），只用于证明派单后 user tail 前进；**不宣称该 key 跨刷新稳定**。
  - **不再使用** `[data-message-author-role]`、`[data-message-id]`、`article` 作为消息身份锚点（2026-11-08 实测页面全部为 0）；**不匹配** `MarkdownRoot-*`、`DilRenderer-*` 等带构建哈希的类名。
  - `data-chatgpt-selection-conversation-id`、`data-chatgpt-selection-message-id` 仅作辅助锚点，不替代尾部 assistant DIL UUID。
  - **goto/刷新后 DOM 先处于骨架屏 hydration 窗口**：立即读取得到 `null` ≠ 消息丢失或状态损坏。复用现有页面就绪轮询预算（≤40 秒）等结构化 unit 出现后再读；超时按页面未就绪/探测失败处理，不得伪造尾部身份。
  - **DOM 虚拟化裁剪规则（R2.3 冻结文字）**：长会话可能从 DOM 移除较早的 unit，实测 unit 数量可从 10 降至 8，因此 unit 数量不保证单调增长。等待、就绪及派单状态判定不得依赖 unitCount 增长；必须以当前尾部 unit 的 role、key、assistant UUID 等结构化语义，与派单前基线进行比较。unit 数量仅可作为诊断信息，不得作为消息到达或页面就绪的唯一依据。unit key（`fallback-turn-N:M:*`）在重渲染时会整体重排（实测 turn 序号随虚拟化裁剪平移），跨渲染比较只信任 assistant DIL UUID。
- 判定元素：状态文件 `a-fast-state.json`（ts/generating/everGenerating/doneCandidate/startIdle/len/gapRejected/unavailableStrikes…），看门狗读它判「快轮询死了（≥7 分钟没更新）/startIdle/未处理」。**Windows 上 Python `open()` 默认 GBK，状态文件含中文必须 `encoding='utf-8'`**（实测崩溃教训；规范版 watchdog 已修）。

### 6.3 唤醒信号处置表

| 信号 | 含义 | 主管动作 |
|---|---|---|
| `REPLY_ARRIVED_WAKE_SUPERVISOR`（脚本1） | 翻转确认，回复到达候选 | API 单次终验（tail assistant+end_turn=true）→ 提取结果 |
| `CONVERSATION_DEAD_WAKE_SUPERVISOR`（脚本1） | 死页梯子 3 strikes，会话判死 | 深查/重派/迁移 → 全套重启 |
| `WAKE_SUPERVISOR reason=NO_SUBSTANTIVE_PROGRESS`（脚本2） | 配置窗口无实质进展 | 本地 Agent 检查状态/工具/页面，按 wakeId 回执并重新布防 |
| `WAKE_SUPERVISOR reason=REPLY_UNHANDLED` | 回复到达但还未交付 | 立即提取、处理结果，再回执 |
| `USER_ESCALATION_REQUIRED` | 连续 3 轮异常且没有实质进展 | 联系 PO；不能把第三次告警直接当“会话死亡” |
| `STATE_MISSING / WATCHDOG_TRIGGER(stale>=7min)` | 快轮询死亡 | 修快轮询（页面失附→重新 goto）→全套重启 |
| `startIdle=true` | 监视器启动/恢复时页面已空闲（基线时序风险） | 「启动即提取」：单次 API 比对派单基线，防吞已到达回复 |
| `STATE_CORRUPT`（watchdog/probe） | 状态文件 JSON 损坏、缺字段或类型错误（v3 Schema 校验拒绝） | 不猜状态：按现场恢复流程重建状态后全套重启 |
| `UUID_MISSING_OR_INVALID` | 被监视 UUID 文件缺失或格式非法 | 补 uuid 文件后重启 |
| `TASKSPACE_RECOVERY_FAILED`（含 `PAGE_URL_MATCH_*`） | Page 恢复 fail-closed（多标签歧义/无匹配/URL 不可读） | 人工清空间残留标签或核对 UUID 后重启 |
| `EGO_TASKSPACE_TAKEOVER_REQUIRED`（#25） | ego 升级后 TaskSpace 接管门阻止脚本访问 | 先 `listTaskSpaces()` 找 id，人工 `claimTaskSpace(id)`，再重跑 probe/布防双循环；不得误走死页梯子 |
| `DISPATCH_ACCEPTED_WAKE_SUPERVISOR` / `DISPATCH_ATTEMPTED_WAKE_SUPERVISOR`（#26） | 任意 STOP 时本轮消息身份匹配且账本已 ACCEPTED 或已进入发送尝试 | 查看 `DISPATCH_LEDGER` + `STOP_CAUSE`；ACCEPTED 立即布防监控，SEND_STARTED/UNCERTAIN 先对账；都不得盲重发 |
| `DISPATCH_UNCERTAIN_WAKE_SUPERVISOR` | 派单账本处于 UNCERTAIN，无法证明已接受 | 先对账（结构化 unit 证据）再裁定；未接受才授权重试 |
| `CONVERSATION_UNAVAILABLE_PERSISTENT` | 死页梯子 3 strikes | 只报「持续不可用」，深查/重派/迁移；不声称会话永久死亡 |
| `START_IDLE_WAKE_SUPERVISOR` | 恢复首轮空闲，存在基线时序风险（issue #8 起属良性：wrapper 自动重启自愈并留痕，连续 >20 轮才升级唤醒） | 单次出现无需处置；wrapper 日志见 `BENIGN_SIGNAL_SELFHEAL` 留痕可审计 |

### 6.4 异常接棒、监控健康与重新布防

**双轨职责**：统一管理器约每 30 秒执行低成本 DOM 快探测，并用监督模块根据配置和实际进展判断，快探测状态陈旧（≥7 分钟）则报错。脚本**不会自行启动或唤醒大模型推理**；真正的接棒方是本地 Agent 的受管任务通知/回调。每轮 `wakeId` 必须由接棒 Agent 检查后通过管理器执行 `ack`，不能把打印日志当已唤醒。

**派单后核对**：`watch` 受管任务有可追踪 ID，任务的结束/异常退出能进入当前本地 Agent 的可处理通知或回调。在现有运行平台上拿不到此保障，就报告“监控接棒能力缺失”，说明缺的是哪条通知链路，不宣称闭环。无需特意制造网页卡死来验收。

**收到唤醒后**：先读 §6.3 的具体信号和状态文件，判断是完整回复、正常长工具链、页面不可用、进程崩溃还是疑似僵尸轮（§5.2）；保留证据后选 `collect`、继续等待、有限恢复、人工停轮或迁移。完成实际诊断后执行 `ack` 并重新运行受管 `watch`；管理器在完整提取并写入校验回执后才能执行 `release`。

**异常处理闭环**：脚本退出或某条 `WAKE_SUPERVISOR` 日志出现后，本地 Agent 若未实际接到通知，按“监控能力缺失”上报 §9.1，不能把写日志视为恢复成功。未能照预案恢复的实战问题同样进入 Issues；普通执行 Agent 不私改 `monitor/` 或 Skill。

## 7. 统一参数表（唯一口径）

| 参数 | 值 | 适用场景 | 备注 |
|---|---|---|---|
| 快轮询间隔 | **30 秒**（从探测开始计时，耗时超过 30 秒则直接进入下一轮） | ego 双循环脚本1 | PO 2026-11-14 调整（原 1 分钟）；**旧 16 铁律的「90~100 秒」是 chrome-use/chatgpt-use 路由口径，不适用于 ego 纯 DOM 双循环** |
| 快轮询页面加载频次 | **约 6 次 goto/小时/Agent**（R2.4 起实测口径） | 配额观察项 | **R2.4 FINAL PASS（65c78e4）修订**：快轮询改驻页 STAY 轮 0 goto，仅 CALIBRATE（距上次导航 ≥10 分钟）1 次 goto + 异常 RECOVER，收敛到约 6 次/小时；旧「60 次 goto/小时」是 pre-R2.4 每轮 goto 口径，已作废。异常恢复与 429/冻结走共享风暴通道（≥9 分钟 + SPACE 相位错峰）。若观察到 429/加载变慢征兆仍按 §5 处置并回调节奏 |
| 智能监督间隔 | `supervision.config.json` 默认 10 分钟（1–60 可改） | 脚本2 | 仅无实质进展才唤醒；配置运行时每轮生效；第 3 个未改善异常轮升级 PO |
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

**冻结参数边界（2026-11-08 R2.2 裁决）**：除 2026-11-14 调整快轮询为 30 秒外，上表其余参数保持原值；DOM 选择器属于 §6.2 的运行时 UI 契约，不属于 §7 冻结参数。DOM 改版不构成变更任何计时、轮询或退避参数的理由。

## 8. Windows / Git Bash 环境坑（与 ego 无关但同场实测）

1. Windows 编码三坑：Python `open()` 默认 GBK（加 `encoding='utf-8'`）；subprocess 输出默认 GBK（加 `encoding='utf-8', errors='replace'`）；PowerShell 5.1 把 UTF-8 文件读成 ANSI（长脚本一律走 .mjs 文件）。
2. Git Bash 里 `powershell -Command "...$_..."` 会被 bash 展开毁掉——复杂 PowerShell 逻辑写成 `.ps1` 文件再 `-File` 执行。
3. Windows 后台进程要杀 ego/node 时：`Get-CimInstance Win32_Process` 按 Name+CommandLine 过滤拿 PID 再 `Stop-Process`（`wmic` 已不可靠）。
4. 跨 bash/pwsh 传路径一律 Windows 绝对路径（Git Bash 的 `/tmp` 会被 pwsh 解析成 `C:\tmp`）。
5. **node:test 在 ego 内置 Electron node 上不可用作测试证据（2026-11-10 本机实测）**：`run({files})` 只报文件级计数且不反映内部用例失败（故意失败的文件仍报 pass 1，阴性对照证伪）；TAP stdout 输出触发 `ERR_UNKNOWN_ENCODING: buffer` 崩溃。验收测试用独立便携版 Node 官方 `node --test`（本机 `D:/Users/Administrator/ego/node-portable/` v20.18.0）。限定为本机观察结果，其他机器以实机为准。

## 9. 其他实战纪律（沿用 16 铁律中仍适用者）

1. 填充后必须回读核对（归一化 diff），发送后必须双验（user 气泡+生成态）。
2. 多会话并发时每个 Agent 用独立 taskSpace 名；操作前核对页面 URL，防串会话误发。
3. 发送内容先查敏感信息（密钥/密码/内网地址/客户隐私）。
4. 一问一答：网页 GPT 不会自主推进，收到阶段性回复必须立即裁定并下发下一步，不留无主空转会话。
5. 会话用完 `task.finish({keep:[]})` 或按需保留；测试产生的草稿会话记得清理（长期值守的监控空间除外，见 §2）。
6. 大输出不整读进主上下文：提取先落盘文件再脚本化解析。
7. 长寿命会话要主动管理轮次（大会话是定时炸弹）；监控使用有退出通知的受管后台任务，实际唤醒与重新布防按 §6.4 复核。

### 9.1 实战故障通过 GitHub Issues 上报（两人团队）

**触发**：实际派单、监控、网页恢复、材料交接出现手册预案无法解决的故障，或发现监控退出后无人接棒。执行 Agent 先按 §5/§6 进行一次有界处置和现场保全，随后对固定仓库 `Hulkhao/agent-kit` 查重 Issues（含已关闭的相似问题）。

**有权限时直接上报**：已有 Issue 描述相同根因/症状就追加一条脱敏现场证据；没有就新建 Issue。内容只需写明：现象与影响、发生时间和任务环境、预期与实际结果、触发信号/状态摘要、已执行的有限恢复及其结果、相关手册章节、能否继续主线。不得附 Cookie、Token、客户资料、完整提示词/回答、原始无脱敏日志。不要为复现而高频刷新或诱发偶发异常。

**权限/失败分支**：读取、查重、评论、创建任一步遭遇认证/权限/网络/限流错误，记录**该步的实际错误**，停止该次上报；不换仓库/账号规避，也不把失败说成成功。确实无法验证 Issue 已创建时报告“提交结果未确认”，先查询同仓库是否已有该记录，避免重复开单。成功则向 PO 明确通知：`Issue #编号 已上报：<链接>；当前任务：可继续/阻塞（原因）`；失败则通知：`未上报：<失败操作与实际错误>；当前任务：...`。

**维护归口**：PO 指定的 Skill 维护 Agent 负责分析、修复、发布和关闭 Issue。普通执行 Agent 有能力按既有预案继续则继续执行，不能继续就标明阻塞并交还 PO；不临时修改已部署 Skill、脚本或他人仓库来绕过故障。

## 10. 新机快速上手顺序

1. 安装 ego lite → 打开 ego 浏览器，**先检查 ChatGPT 是否已登录**（§1 口径），未登录登一次。
2. `ego-browser skill` 通读指南（升级后重跑）。
3. 使用 agent-kit 的 `monitor/dispatch-manager.mjs`，给同一 Agent 固定 `--agent-id` 和 `--space`，每个任务单独指定 `--conversation` 和 `--monitor-dir`。
4. 通过管理器 `send --message <文件>` 派单；它负责九闸门、状态记录与派单结果确认，禁止单独重写填充/发送脚本。
5. 启动管理器 `watch` 为受管后台任务（不得用 `&` 脱离后台）；接棒后按 §6.3 诊断并 `ack`，收到完整回复后检查交付回执与 Page 释放。宿主通知链路需另行实测。
6. 会话消息数接近 2000 → 提前按 §5 迁移（自包含简报开新会话）。

---

## 11. 上游 ChatGPT Web 运行时可靠性经验（2026-11-08）

本节将上游项目 [miuuyy/codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web) 的运行经验抽象到 ego-browser 工作流。参考了其 v6.1.17 README、架构说明、安全模型、故障排除和发布验证文档。这里吸收的是状态管理与故障处置方法，不是把 Electron、Responses API 或 MCP 代码搬进 ego-browser。

**优先级：** 本节补充现有手册，不覆盖 §2–§7 已经实测冻结的 ego-browser 规则。尤其 30 秒快轮询、可配置默认 10 分钟主管监督、75 秒翻转确认、8 分钟死页退避、429 页面重试至少 9 分钟、每次唤醒最多 2 次 API 调用，仍以本手册现行值为准。

### 11.1 把页面、轮次、工具调用拆成独立状态

不要用一个布尔值表示「ChatGPT 正在工作」。至少区分以下状态：

| 状态 | 进入条件 | 退出条件 / 动作 |
|---|---|---|
| READY | 目标会话 URL 正确，composer 可用 | 填入本轮内容 |
| PREPARED | fill 后回读与待发送文本一致 | 发送前先持久化状态 |
| SEND_STARTED | 已把本轮标记写入本地派单记录，准备执行 Enter/click | 通过 §3 的 DOM 双验后标为 ACCEPTED；进程此时退出则标为 UNCERTAIN |
| ACCEPTED | 新 user 气泡与生成态均得到确认 | 进入生成监控，不再发送同一轮 |
| GENERATING | 可见停止按钮，或已观察到本轮 assistant 输出推进 | 工具调用开始时转入 TOOL_PENDING；停止按钮消失时只进入 FINAL_CANDIDATE |
| TOOL_PENDING | 页面出现本轮工具调用/执行中状态，且尚未观察到对应结果 | 工具结果返回后等待 assistant 在工具结果之后继续输出 |
| FINAL_CANDIDATE | 曾观察到停止按钮，现已消失，并通过 75 秒确认窗 | 无待处理工具、assistant 最终文本稳定且终验通过后才标 COMPLETED |
| COMPLETED | 终态证据成立 | 归档本轮记录 |
| UNCERTAIN | 发送后、接受确认前发生进程退出、页面崩溃或传输超时 | 先恢复并对账；证据不足时交主管判断，禁止自动重发 |

页面存活不代表轮次仍在生成；页面空闲不代表工具调用已经结束；停止按钮消失也不代表最终答案已经完整呈现。这三个判断必须分别记录。

### 11.2 流式输出与工具调用状态监控

快轮询仍按 §6 的节奏执行，但每轮除 generating 外，还应记录可验证的进度信号：

- assistant 正文长度或可见正文版本号，以及最近一次正文变化时间。
- 最近一次页面活动时间、当前轮次阶段。
- 是否存在尚未返回结果的工具调用；最近一次工具状态变化时间。
- 最近一次工具结果返回后，assistant 是否产生了新的正文。
- 停止按钮当前是否可见，以及本轮是否曾经观察到它。

这些字段只记录时间、数量、阶段和状态，不把整段提示词、回答或工具参数写入状态文件。assistant 正文与页面状态行分开观察；「正在思考」等本地化文本不能单独作为生成态依据。

**工具调用采用因果边界：**

1. 观察到工具调用开始时，记录当时的 assistant 正文版本，并标记存在待处理工具。
2. 工具执行期间，即使停止按钮短暂消失、正文暂时不增长，也保持 TOOL_PENDING，不得判完成。
3. 工具结果返回后，记录结果返回时刻/活动版本；必须观察到该时刻之后新的 assistant 输出，才能进入最终完成候选。
4. 若工具结果仍未返回，按长任务规则继续等待或唤醒主管，不得把页面空闲当作成功。
5. stream reconnect、页面重新连接或辅助进程重启只是传输/运行时事件，不是新一轮 Send，也不应创建第二份派单。

上游项目采用「工具调用前记录当前回答投影，工具结果返回后要求出现新的最终回答投影，再复读页面并确认活动版本未变化」的完成栅栏。ego-browser 可以按同一思路执行：最终提交完成状态前，重新读取一次页面；若期间出现新工具活动、停止按钮重现或正文继续变化，撤销完成候选并重新计时。

### 11.3 Stop 消失后的延迟最终答案

沿用 §5.1 的「可见停止按钮由有到无 + 75 秒确认窗」，并增加以下检查：

1. Stop 消失只记 FINAL_CANDIDATE，不直接写 COMPLETED。
2. 75 秒窗口内若停止按钮重现、assistant 正文继续变化、工具状态变化或工具结果尚未返回，撤销候选。
3. 确认窗结束后，分别读取页面状态与 assistant 正文；至少两次独立读取结果稳定，且没有待处理工具，才进行终态提取。
4. API 终验仍按 §4 单次提取执行：尾部 assistant 必须满足 end_turn=true 且 status=finished_successfully。API 索引延迟或端点冻结时，按 §4 的 DOM 兜底处理；不得因为 API 尚未追平而重新发送任务。
5. 内容长度/正文版本可用于判断「候选完成后是否仍在变化」，但不能拿完成后采集的哈希或计数充当派单基线。派单基线仍必须在发送时钉死。

上游版本专门修复过 Stop 消失早于最终答案、延迟最终内容出现的问题；其特定桥接实现允许最长 10 分钟无可观察响应活动。该上游 10 分钟值不适用于 ego-browser，不替换本手册的 75 秒确认和可配置主管监督间隔（默认 10 分钟）。

### 11.4 长任务、等待与超时分类

超时必须绑定具体阶段，不要设置一个超时后就杀掉整个任务：

| 阶段 | 超时/异常的解释 | 固定动作 |
|---|---|---|
| 页面导航/就绪 | 页面尚未达到 §6.2 的就绪条件 | 按现有 40 秒上限、8 分钟退避和死页梯子处理 |
| 填充/发送确认 | 没有完成发送双验 | 记录 UNCERTAIN 或发送未确认；先查 user 气泡、composer 和本地派单记录 |
| assistant 生成 | 暂时没有新正文，不足以证明任务失败 | 结合停止按钮、正文变化、工具状态和可配置主管监督（默认 10 分钟）判断 |
| 工具执行 | 工具仍处于执行中或等待结果 | 分段等待；每次等待返回后检查同一任务状态，不启动第二次 Send |
| API 提取 | 404、429、端点滞后或冻结 | 按 §4、§5 处理；API 不是快轮询通道 |
| stream/辅助进程 | Reconnecting、stream disconnected、进程退出 | 先恢复原页面和原轮次，读取完整错误；不能直接推断 ChatGPT 未接受任务 |

长任务采用「短等待—检查状态—继续等待」而不是一次无限阻塞。每次等待结束都保留原任务标识；如果仍在运行，继续等待同一个任务。上游项目的 90 秒 MCP 调用期限、60 秒命令轮询上限属于其自身协议，不复制为 ego-browser 参数。

遇到 Reconnecting、stream disconnected、通用 502 或等待超时：

- 先读取完整错误和原 ChatGPT 页面，不只记录一个笼统的 Reconnecting。
- 检查原会话是否有 user 气泡、assistant 输出、待处理工具或最终答案。
- 保留原会话作为故障现场；只有确认原轮次已结束或明确死亡，才新建任务。
- 禁止把等待超时当成「未发送」；禁止以新会话重派来掩盖原轮次状态不明。

### 11.5 浏览器辅助进程重启与会话恢复

进程重启会丢失 JavaScript 变量，但不一定意味着 TaskSpace、浏览器上下文或 ChatGPT 会话消失。恢复顺序：

1. 用原 TaskSpace 名重新连接；不要创建第二个同目标 TaskSpace。
2. 通过 task.pages() 枚举现有标签，再按标签找到页面对象。继续遵守 §2：task.page(label) 在标签不存在时可能异步抛错，不能用同步 try/catch 判断是否存在。
3. 检查页面 URL 是否仍包含原 conversation UUID；项目 URL 允许有额外路径，按 includes(uuid) 判断。
4. 页面仍可用时复用原页面；若页面渲染冻结，按 §6.2 的全新 goto 与死页梯子恢复，不把 page.reload() 当默认恢复动作。
5. 页面进程已丢失时，才新建页面并导航到原 /c/<uuid>；先核对原 user 气泡、assistant 状态和工具状态，再决定后续动作。
6. 采用有限重启预算。达到上限仍未恢复时停止自动重启，保存现场并唤醒主管；不得无限重启形成 crash loop。

关闭正在运行的浏览器标签会终止该轮任务。恢复过程中不要为了「清理页面」关闭仍在生成或等待工具结果的标签。只有确认轮次已完成、已取消或已判死，才释放对应页面。

### 11.6 防止辅助进程重启后重复提交

网页发送无法提供真正的 exactly-once 保证，因此采用「持久化状态 + 发送后对账 + 不确定时不重发」的 at-most-once 策略。

每个逻辑派单生成一个稳定 dispatch_id，并在本地状态文件/派单日志中记录：

- dispatch_id、TaskSpace 名、页面标签、conversation UUID。
- 发送前最后一条 user 消息的可识别基线（优先使用当前页面确实存在且经过验证的逻辑消息 ID；没有时记录消息数量和时间基线）。
- 当前状态：PREPARED、SEND_STARTED、ACCEPTED、COMPLETED 或 UNCERTAIN。
- 发送开始时间、接受确认时间、最近一次恢复次数和最后错误类别。

执行规则：

1. fill 和回读通过后，先把 SEND_STARTED 原子写入本地记录，再执行单次 Enter。即使键盘命令返回错误也须先对账，禁止立即用 click 再试。
2. 只有通过 §3 的 user 气泡 + 生成态双验，才标记 ACCEPTED；若页面能提供稳定逻辑 turn ID，一并记录。不要依赖会随虚拟列表重排的显示序号。
3. 进程在 SEND_STARTED 后重启时，必须先恢复原会话并检查是否已出现新 user 消息/assistant 轮次。发现已接受则补记 ACCEPTED，绝不重发。
4. 找不到确定证据时标记 UNCERTAIN，交主管核查；禁止因没有收到本地回执、页面短暂空白、stream reconnect 或 API 暂时 404 而自动再发。
5. 只有明确证明原 Send 未被接受（没有新增 user 消息/轮次，原文本仍留在 composer，且页面状态一致）后，才允许主管批准重新发送，并记录同一 dispatch_id 的新 attempt。
6. 已标记 ACCEPTED 的消息绝不为了修复 DOM、恢复流连接或补取最终答案而重新提交。

上游实现用逻辑 data-turn-id 和持久化消息容器识别真实新轮次，避免虚拟列表重新挂载旧消息被误认为新提交；ego-browser 当前页面不保证存在同名属性。只有现场验证后才能使用该属性，不能把它写成硬编码前提。当前手册的 user 气泡 + 停止按钮双验仍然有效。

### 11.7 失败现场与安全诊断日志

故障第一次出现时立即保存诊断，不要等重装、刷新多次或再次派单后再采集。建议分成两类文件：

**安全状态日志（默认开启，可用于汇报）：**

- 时间戳、操作系统、ego-browser/skill 版本、监控脚本版本。
- TaskSpace、页面标签、会话 UUID（仅内部保存；外发前脱敏）。
- 当前阶段、停止按钮可见性、composer 是否存在、最近正文变化时间、待处理工具数量。
- 派单状态、dispatch_id、消息基线/新增消息数量、重启次数、退避/strike 计数。
- 完整错误类别与错误文本；清理其中的凭据、私有路径和 URL 查询参数。

**浏览器检查点（默认关闭或仅失败时采集）：**

- 可选截图和 accessibility snapshot，用来证明当时页面结构、控件和状态。
- 检查点保存在本机独立诊断目录，不混入普通状态日志。
- 截图和快照可能含客户信息、提示词或回答，只能先本地留存；对外分享前必须人工脱敏。
- 可参考上游项目的留存策略：失败检查点最多保留 3 天、完成检查点总预算 100 MB，失败样本优先于成功样本，清理时绝不删除仍在写入的活动检查点。安全日志导出与浏览器检查点分开管理。

**禁止进入日志或 PR 附件：** Cookie、localStorage、完整浏览器 profile、Authorization/Bearer/session token、API key、Tunnel ID、完整提示词、完整回答、工具参数和含客户隐私的工具输出。需要复现内容时，另行制作人工脱敏的最小样本。

对外故障报告至少包含：准确复现步骤、首次失败时间、完整错误、操作系统与浏览器/ego 版本、目标模型/思考档位、是否发生工具调用、页面最终答案是否出现、是否在新任务中复现，以及脱敏后的安全状态日志。原始浏览器检查点不等同于安全日志，不要直接上传。

### 11.8 UI 漂移与验收边界

ChatGPT 页面不是稳定 API。composer、模型选择器、轮次渲染器和工具活动区分别维护可验证的 DOM/Accessibility 证据：

- 新 UI 结构无法识别时，明确报结构不匹配并保留现场；不要静默切换模型、发送方式或传输通道。
- 修选择器前先采集当前真实页面结构；只保留已经实测可用的布局分支。
- 浏览器冒烟测试通过只证明当时的登录态和基础控件可用，不等于真实任务完整通过。完整验收至少覆盖：发送接受、流式正文增长、工具调用及结果返回、最终答案、取消、进程重启恢复、长任务继续和失败诊断导出。
- 任何取消、关闭标签或重启动作，都要验证原任务确实停止/恢复，不能只看 UI 按钮状态。

### 11.9 上游实现细节的适用边界

以下数值或实现属于 codex-chatgpt-web 自身协议，**不得直接替换本手册参数**：Electron WebContentsView、最多 5 个并发标签、Responses API/SSE、MCP turn token、90 秒 MCP 调用期限、60 秒命令轮询上限、10 分钟无响应活动窗口，以及其专用 data-turn-id 选择器。

本节可迁移的结论是：状态分层、工具调用因果边界、稳定最终答案确认、持久化派单记录、恢复前对账、有限重启、安全诊断和 UI 漂移显式失败。ego-browser 的具体 API、选择器和时间参数仍以实机验证及本手册 §1–§10 为准。

### 11.10 R2.2 迁移记录与跨机器 SHA256 基准（2026-11-08 验收补充）

**验收基线**：（原 ego-tools 仓库，已并入本仓库 monitor/）R2.2 正式验收 commit `fd6da71`（父基线 `32c3658`，R2 为 `74a0b58`）；五项真实场景（assistant UUID 读取 / user 尾部识别 / 派单接受状态 / 连续读取稳定 / 刷新后 UUID 恢复）全部 PASS。本次验收不解锁 P0-3 工具调用专用识别或 Browser Process 真崩溃恢复，两项继续 HOLD。

**消息身份锚点迁移（禁恢复旧锚）**：

- 旧锚点 `[data-message-author-role]`、`[data-message-id]`、`article` 在 2026-11-08 实测页面中均不存在（计数 0），**禁止恢复使用**。
- 新锚点：`[data-content-search-unit-key]`（role 在 key 末段）与 assistant 的 `[data-dil-response][data-dil-message-id]`（36 位 UUID）；assistant DIL UUID 已完成连续读取与刷新后真机验证。
- 刷新后的短暂 `null` 属于 DOM hydration 窗口：复用既有 40 秒就绪预算等待结构化 unit，不得伪造尾部身份。

**conversation API 状态**：当前账号请求缺少 bearer token，`conversation_inaccessible` 404；该结果不能用来判断会话是否存在或是否死亡（详见 §4）。

**修 Bug 系统级原则（PO 令 2026-11-08，细则见用户级 AGENTS.md）**：修复 Bug 前先追溯根因并审视全局业务逻辑；优先用最少、最通用的规则覆盖最多场景，从系统层消灭一类问题；禁止按单个现象堆补丁，禁止引入无实际用途的特殊分支。本批归并为两条系统规则：①UI 状态只由结构化证据判定，不从会话正文提取状态标志；②状态由完整 Schema 和绝对 deadline 管理，不以滑动时间或部分字段推断状态。

**跨机器文件校验（每个 SHA256 必须注明哈希对象和字节基准，不得只给裸哈希）**：

| 验证对象 | SHA256 基准 |
|---|---|
| Git 源码文件 | **Git blob 原始字节**（`git cat-file blob HEAD:<path>` 再哈希）；不得拿 checkout 行尾转换后的磁盘副本哈希与 blob 哈希直接比较（实测 CRLF 陷阱：`core.autocrlf=true` 使磁盘字节≠blob 字节） |
| 下载的 ZIP / PATCH | 下载文件原始字节 |
| 实际部署副本 | 磁盘原始字节，并注明 LF/CRLF |
| Base64 分块 | 解码后的分块原始字节 |

不为解决哈希口径问题擅自修改全局 `core.autocrlf`。

**R2.3 归档记录（2026-11-08）**：Composer 空态判定为**已有实现**（`dispatch-state.mjs` 的 `composerEmpty = composerText.trim() === ''`，`composerLength` 保留原始 `innerText.length`），此前「结构上不可能通过 markAccepted」的诊断有误——两笔 UNCERTAIN 的真因是陈旧页发送静默失败（发送按钮 `disabled=true`），非空态判定。真火证明：真实派单 `64f8f821` 由 `markAccepted` 自动进入 ACCEPTED（证据 `COMPOSER_EMPTY_AND_GENERATING`，发送后 1.5 秒首轮即成立），无主管手工结算。UNCERTAIN 主管兜底机制保留未动。

**上游参考：**

- [README.zh-CN.md（当前主分支）](https://github.com/miuuyy/codex-chatgpt-web/blob/main/README.zh-CN.md)
- [v6.1.17 发布说明](https://github.com/miuuyy/codex-chatgpt-web/releases/tag/v6.1.17)
- [架构说明](https://github.com/miuuyy/codex-chatgpt-web/blob/main/docs/architecture.md)
- [安全模型](https://github.com/miuuyy/codex-chatgpt-web/blob/main/docs/security-model.md)
- [故障排除](https://github.com/miuuyy/codex-chatgpt-web/blob/main/TROUBLESHOOTING.md)
- [发布验证](https://github.com/miuuyy/codex-chatgpt-web/blob/main/docs/release-validation.md)
