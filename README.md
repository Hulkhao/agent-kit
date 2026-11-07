# agent-kit — 跨机同步的 Agent 技能包

多台电脑同步 ZCode skills 的唯一真源仓库。当前收录：

- `skills/chatgpt-web-dispatch/` — ChatGPT 网页派单工作流（入口 SKILL.md + 唯一真源手册 `references/EGO-LITE-HANDBOOK.md`）

## 铁律

- **只改本仓库**：各机 `~/.agents/skills/` 下是 `deploy.ps1` 生成的部署副本，禁止直接改。
- 手册/skill 改动流程：仓库内修改 → `git add -A && git commit` → `git push` → 各机 `git pull` → `pwsh -File deploy.ps1`。

## 新机器首次接入

1. `git clone <远端地址> agent-kit`
2. `pwsh -File agent-kit\deploy.ps1`（装到全局公用 `~/.agents/skills`，ZCode 及其他 Agent CLI 均从此读取；如某工具只读 `~/.zcode/skills` 加 `-AlsoZCode`）
3. 新开 ZCode 会话，skill 列表应出现 `chatgpt-web-dispatch`
4. 浏览器自动化另需：安装 ego lite（手册 §10），并跑一次 `ego-browser skill`

## 远端设置（一次性，PO 填私有地址）

```
git remote add origin <私有仓库地址>
git push -u origin master
```

## 未来收编预留

- ego-tools 监控脚本三件套（现只在 haohao 机）可迁入本仓库 `monitor/`；迁入后同步更新手册 §6 存放点口径，两机统一同步。
