# dsh-quest

> 科研实验的任务线调度台 —— 让 AI 只负责"立项与验收"，长任务交给独立后台服务，结果自动推送 IM。
> An agent-agnostic pipeline orchestrator for research experiments: dispatch long-running tasks to an independent background service, get judged results and AI-written summaries pushed to your phone — while the agent conversation stays clean.

## 为什么做这个 / Why

在 AI 对话客户端里跑长实验有三个老毛病：

1. **通知污染**：任务完成通知直接注入主对话（followup 模式），主对话越喂越大——一个 1049 轮的会话每轮要吃 44 万 token 上下文；
2. **轮询风暴**：插件轮询进程表/会话文件做检测，拖垮宿主（我们在生产环境实测过 63% CPU 被 GC 吃掉的案例）；
3. **单终端排队**：多个实验挤一个共享终端，互相阻塞。

dsh-quest 用一套**事件驱动**架构解决：进程退出由操作系统事件感知（零轮询），AI 总结由**一次性 worker 会话**完成（用完归档，主对话零增长），失败由**带预算的 fixer 会话**自动修复（改前 .bak 备份 + 客观 diff 上报）。

### 为什么不是用 agent 自带的后台就够了 / Why not just the agent's own background jobs

Claude Code、Codex、ZCode 这类 agent 都自带后台执行（`run_in_background`、Bash 后台、Task 子代理）。**跑个命令过会儿回来看**这件事它们确实能办——但那个后台是**会话的私有财产**：

| 维度 | agent 自带后台 | quest |
|---|---|---|
| **活多久** | 会话/CLI 结束即消失（或成无人管的孤儿进程） | 独立服务，**跨会话、跨 agent、跨进程重启**都在 |
| **谁看护** | 没人——要模型自己 Sleep 轮询（假死根源） | 服务自己判：超时杀、失败修、跑完通知 |
| **状态在哪** | 内存，会话一关就蒸发 | 账本 + plan.md + progress.md，全部落盘 |
| **换 agent 之后** | 断片：Claude Code 的任务，Codex 完全不知道 | 同一份任务线，谁接手都看得见（见下文 MCP） |
| **无人时** | 无任何机制 | 过夜跑、崩溃自愈、结果推手机 |
| **判定与编排** | 无（靠模型现场判断） | 关键词/产物判定、条件分支 `when:`、带预算自动修复、断点续跑 |

一句话分工：

```
活着的会话里、分钟级、人在旁边  →  agent 自带的后台就够了（更轻）
跨会话 / 跨 agent / 过夜 / 人不在场  →  quest（账本 + 看护 + 通知）
```

换个说法：**agent 的后台是"内存里的待办"，quest 是"磁盘上的任务线"**——前者属于某一次对话，后者属于你的工作区。这也是它能被不同 agent 轮流驱动而状态连续的原因。

## 架构 / Architecture

```
┌ DSH（AI 对话服务，3080）────────────┐   ┌ quest 服务（独立进程，3110）──────────────┐
│ 主对话：quest_plan / dispatch /     │   │ plan.md（任务线定义，人可改）              │
│        status / log 四个工具        │──→│ ledger.jsonl（追加式事件账本）            │
│                                    │   │ 作业执行器（独立进程/超时护栏/预检）       │
│ worker / fixer 一次性会话 ←─────────┼───│ 判定器（ok/crashed/timeout/suspect）     │
│ （读交接+日志→总结/最小修复→归档）    │   │ auto_fix（预算+.bak备份+diff审计+重派）  │
└────────────────────────────────────┘   │ after 依赖链（DAG 自动流转/失败冻结）     │
                                          └───────┬─────────────────────────────────┘
                                                  ↓ QQ 直推（带 AI 总结）
                                              你的手机
```

核心设计原则：**状态进文件不进会话**（账本在磁盘，主对话只在被问时拉取一次）；**推送的东西永远不进会话，进会话的永远是你拉取的**。

## 功能 / Features

- **五级判定**：`ok`（完成关键词/产物新鲜度）、`crashed`、`startup-failed`、`timeout`、`suspect`——纯代码判定，零 token
- **DAG 依赖链**：节点声明 `after:` 上游，成功自动流转、失败自动冻结下游；重派上游自动解冻下游
- **预检**：派发前 `py_compile` 拦截语法错误（编译器报错原文直推 QQ）
- **worker 总结**：任务结束 → 独立一次性会话读[交接上下文+日志尾]写 ≤10 行总结 → 归档。主对话零增长。**后端可插拔（v0.5）**：DSH 会话 / OpenAI 兼容 API / headless CLI / 关闭（纯机械模式）
- **auto_fix 自动修复**（可选，节点级开关）：失败 → fixer 做**机械性最小修复**（显存调 batch / NaN 调 lr / 路径环境；**绝不碰实验逻辑**）→ `.bak` 备份 → 语法验证 → 自动重派。预算烧尽或判断需人工（FIX_GIVEUP）则停手告警。修复后服务端做**客观逐行 diff** 上报 QQ（不信任自述）。后端同样可插拔
- **跨 agent（MCP）**：8 个工具以标准 MCP 暴露，Claude Code / Codex / ZCode / Cursor 等可直接调用；quest 本体零模型依赖——执行、判定、指标、超时、重试、通知全程不需要 AI
- **中断恢复（v0.5）**：机器重启后开机自动检测被腰斩的任务——仅在**确实重启过**（系统开机时刻判定，OOM/自崩不算）且**有断点存档**且节点声明 `resume_on_boot` 时，推一条提示；回 `/q续跑` 从断点接着跑。检测自动、重派要人点头（重复跑会双写产物）
- **QQ 推送**：经 bridge console 直发（纯 HTTP，不经过任何对话）；任务线收尾自动推总览；推送带重试+落盘队列，失败不静默丢失
- **外部进程接入**：手动启动的 python 进程（≥5 分钟）退出后由检测端转交同一管线
- **崩溃韧性**：账本追加式 + 状态可重建；quest 自带守护循环重启脚本

## 快速上手 / Quick Start

要求：Node.js ≥ 20。**DSH 不是必需的**——quest 可独立运行（纯机械模式），DSH 只用于可选的任务总结与自动修复；Windows 与 Linux 都能跑（WSL 执行车道为 Windows 专属）。

```bash
# 1. 启动服务（一行；数据目录 ~/.dsh/quests/ 与令牌自动生成）
npx dsh-quest-service

#    不想用 npx？从源码起也一样：
#    git clone https://github.com/yunlong-wang11111/dsh-quest.git && cd dsh-quest && node server.mjs

#    服务起来后：仪表盘 http://127.0.0.1:3110/dashboard
#              MCP 服务器 npx dsh-quest-service mcp（接 Claude Code / Codex / ZCode）

# 2. 编辑 ~/.dsh/quests/quest-config.json（QQ 推送等），重启服务生效

# 3. 挂 DSH 插件：把 dsh-plugin/ 目录 link 或复制到你的 DSH profile，
#    package.json 的 dsh.profile.bundles 加 "dsh-quest"

# 4. 装 preset：presets/quest-worker 与 presets/quest-fixer 复制到 ~/.dsh/.agent-presets/

# 5. 在 DSH 对话里说："用 quest 建任务线跑 xxx，然后派发"
```

## 通知出口（可选，provider 无关） / Notification sink

**quest 不依赖任何 IM 桥**：它对外只有"发通知"这一个 HTTP 调用，**默认关闭**（`notify.kind` 缺省即 off），失败也绝不影响任务流转。

```jsonc
// quest-config.json
{
  "notify": {
    "kind": "off"            // 默认：不通知，查仪表盘或 API
    // "kind": "bridge"      // 任何实现了 POST /api/send/private 的通知端
    // "kind": "webhook"     // 任何 HTTP 端点（Telegram / 钉钉 / 飞书 / 企业微信 / 自建）
  }
}
```

<details><summary><b>webhook 模式：常见服务商模板</b></summary>

```jsonc
{
  "notify": {
    "kind": "webhook",
    "url": "https://api.telegram.org/bot<BOT_TOKEN>/sendMessage",
    "bodyTemplate": "{\"chat_id\":\"<CHAT_ID>\",\"text\":\"{{message}}\"}"
  }
}
```

| 服务 | url | bodyTemplate |
|---|---|---|
| Telegram | `https://api.telegram.org/bot<BOT_TOKEN>/sendMessage` | `{"chat_id":"<CHAT_ID>","text":"{{message}}"}` |
| 钉钉机器人 | `https://oapi.dingtalk.com/robot/send?access_token=<TOKEN>` | `{"msgtype":"text","text":{"content":"{{message}}"}}` |
| 飞书机器人 | `https://open.feishu.cn/open-apis/bot/v2/hook/<TOKEN>` | `{"msg_type":"text","content":{"text":"{{message}}"}}` |
| 企业微信 | `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=<KEY>` | `{"msgtype":"text","text":{"content":"{{message}}"}}` |

`{{message}}` 两种写法都支持：**带引号**（`"{{message}}"`，填 JSON 内层转义）或**裸放**（`{{message}}`，填完整 JSON 串）。照服务商文档抄哪种都对。消息里的引号、换行、反斜杠都会正确转义。

</details>

> **图片产物直推**目前只在 `bridge` 模式可用（webhook 模式会明确提示不支持，而不是静默丢弃）。
> **长度**：通知不消耗 token，默认上限 `notify.maxChars: 4000`（QQ 单条约 4000 字的安全值）。超过时**保留头+尾**（头部是任务线前缀与判定，尾部通常是总结结论），并在中间标「中段省略」。兼容的通知端应自行按 IM 硬上限拆条，而不是拒收——qq-bridge 已如此处理。

## 让它常驻（监督器） / Keep it running

**quest 是一个服务，而服务无法监督自己**——进程死了就没人再判定、通知、认领。任务侧的崩溃存活（句柄直挂 / systemd 认养 / 重启后按账本认领）是 quest 自己的机制，不需要外部帮忙；但 quest 进程本身必须由外部拉起来。

**Linux / macOS（推荐，用 systemd 而不是自己写守护）**：'guard/quest.service' 是现成的用户级单元（`Restart=always` + 重启风暴保护 + 日志落盘）。装法见文件头注释，四行命令。

**Windows（没有 systemd，用计划任务）**：`guard/quest-guard.ps1` 是 40 行的最小监督器——探活 `/api/status`（任何 HTTP 响应都算活着，含 401），000 才判定为死并拉起，全程记日志。注册成每 5 分钟一次：

```bat
schtasks /Create /TN "quest-guard" /SC MINUTE /MO 5 /RL HIGHEST ^
  /TR "powershell -NoProfile -ExecutionPolicy Bypass -File C:\path\to\quest-guard.ps1" /F
```

> 注意：监督器只管 **quest 进程**。它不负责"任务不要中断"——那是 quest 自己的事（见「崩溃韧性」与「中断恢复」）。二者互不替代。
## 任务线格式 / Plan Format

```markdown
# 任务线：<一句话说清在验证什么>
workspace: <实验目录绝对路径>

---node: train---
command: <python 绝对路径> train.py --lr 1e-4
cwd: <工作目录>
expect_minutes: 240          # 超时护栏 = 2 倍
after: gen-data              # 依赖：上游成功自动跑本节点、失败冻结下游
freeze_on: hard-fail-only    # 可选：只有真失败才冻结下游，上游"疑似"时放行（可写 plan 头）
auto_fix: true               # 失败后自动修复（可选）
fix_budget: 2                # 修复次数上限（默认 2）
handoff: |                   # 给 worker 的交接上下文（决定总结质量的上限）
  验证 X 方法在 Y 条件下的效果；
  看 val_loss，健康范围 < 1e-3；
  OOM 会先打印 batch retry……
```

完整字段说明与五段科研流水（生成→训练→后处理→评估→可视化）标准骨架见 [PLAN-TEMPLATE.md](PLAN-TEMPLATE.md)，设计取舍见 [DESIGN.md](DESIGN.md)。

## 跨 Agent 使用（MCP） / Agent-agnostic via MCP

quest 本体不绑定任何 AI 工具——它自己派进程、判定、重试、通知，全部零模型参与。因此**任何**能发 HTTP 的 agent（Claude Code、Codex、ZCode、Cursor、一段脚本）都能驱动它；仓库里的 `mcp-server.mjs` 进一步把这套能力做成标准 **MCP 工具**，模型不用再自己拼 curl。

```bash
# 依赖：node ≥ 20
npm install            # 安装 @modelcontextprotocol/sdk / zod / fzstd
node server.mjs        # 启动 quest 服务（3110）
node mcp-server.mjs    # MCP 服务器（stdio，由 agent 拉起，无需手动运行）
```

暴露 8 个工具：`quest_plan` `quest_dispatch` `quest_run` `quest_status` `quest_log` `quest_probe` `quest_files` `quest_cancel`。

**接入方式**（把路径换成你的实际路径）：

<details><summary>Claude Code（.mcp.json 或 ~/.claude.json）</summary>

```json
{
  "mcpServers": {
    "quest": {
      "command": "node",
      "args": ["/path/to/quest/mcp-server.mjs"],
      "env": { "QUEST_URL": "http://127.0.0.1:3110" }
    }
  }
}
```
</details>

<details><summary>Codex（~/.codex/config.toml）</summary>

```toml
[mcp_servers.quest]
command = "node"
args = ["/path/to/quest/mcp-server.mjs"]
env = { QUEST_URL = "http://127.0.0.1:3110" }
```
</details>

<details><summary>其它 MCP 客户端（ZCode / Cursor / …）</summary>

在客户端的 MCP 配置里新增一个 stdio server：命令 `node`，参数 `["/path/to/quest/mcp-server.mjs"]`，环境变量同上。
</details>

**环境变量**：`QUEST_URL`（默认 `http://127.0.0.1:3110`）、`QUEST_TOKEN`（缺省读 `<QUEST_HOME>/.token`）、`QUEST_HOME`（默认 `~/.dsh/quests`）。

> **绑定关系说明**：quest 的执行/判定/监控/通知**完全不依赖任何 agent**（零模型参与）。只有两件事需要模型——任务结束后的**总结**与失败后的**自动修复**——这两件事在 v0.5 起做成可插拔后端：

```jsonc
// quest-config.json
{
  "workerBackend": "dsh",       // dsh（默认）| openai | cli | off
  "fixerBackend": "dsh",        // dsh（默认）| cli | off
  "summarizer": { "baseUrl": "https://api.deepseek.com/v1", "apiKey": "", "model": "deepseek-chat" },
  "fixer": { "command": "claude -p" }
}
```

| 后端 | 总结（worker） | 修复（fixer） | 说明 |
|---|---|---|---|
| `dsh` | ✅ | ✅ | 开 DSH 子会话（默认，与 v0.4 行为一致） |
| `openai` | ✅ | — | 任意 OpenAI 兼容 chat completions（官方 API / 兼容服务） |
| `cli` | ✅ | ✅ | 调命令行 headless agent（`claude -p`、`codex exec -`…） |
| `off` | — | — | **纯机械模式**：判定、指标提取、超时、重试、通知照常，只是没有 AI 写的总结 |

实测（机械模式）：`python mech_test.py` → `completed | ok | finish-keyword`，loss 指标 `1.5 → 1.05` 自动提取——**全程零模型调用**。

## v0.5 新增

- **计划覆盖保护（`force`）**：`/api/plan` 整体替换 `plan.md` 时，若旧计划里有未完成（非 `completed`）的节点不会出现在新计划里，服务端返回 **409** 并列出将丢失的节点与它们的当前状态，要求显式 `force: true` 才提交（账本记 `forced: true`）。防的是"AI 顺手重写 plan 把待办/失败节点一起蒸发、人再也看不见"。MCP 与 DSH 插件的 `quest_plan` 都带 `force` 参数，工具的说明里写明"409 不是故障、不要盲目重试"
- **冻结策略 `freeze_on`（让 AI 在中间裁决，而不是脚本一刀切）**：上游失败默认冻结下游（`any-fail`，保守）。但判定器的 `suspect` 只代表"没找到完成证据"，不等于失败，整条链不该因此停摆——节点/plan 头声明 `freeze_on: hard-fail-only` 后，只有**真失败**（crashed/startup-failed/timeout/cancelled/预检失败）才冻结下游；上游只是 `suspect` 时放行，并推一条 IM：「上游 X 疑似但已放行，让 AI 用探针查证，确认没跑完就取消下游」。任一处声明即生效（下游/上游/plan 头），账本记 `node.soft-pass`，progress.md 在该行标「⚠️上游疑似放行」
- **判定器修复（假 ok）**：quest 自己的台账 `progress.md` / `research-state.md` / `plan.md` 就写在任务工作区里（= 节点 cwd），且 `.md` 属于判定器的"文本产物"——节点运行期间任何一次 `/api/status` 刷新都会重写 `progress.md`，于是一个**零产物**的节点也被判成 `ok/artifact-fresh`，把真失败盖过去。现在这三类台账文件被排除在产物扫描之外（沙箱实测复现 + 修复验证）
- **跨 Agent（MCP 工具面）**：8 个工具以标准 MCP 暴露（stdio），Claude Code / Codex / ZCode / Cursor 等可直接调用——模型不必再自己拼 curl。仓库自带 `mcp-server.mjs`，接法见上文「跨 Agent 使用」章节。实测 Claude Code `✓ Connected`、工具列表与真实调用往返正常
- **可插拔的总结/修复后端**：quest 的执行/判定/指标/超时/重试/通知全程零模型依赖，只有「任务总结」与「自动修复」需要模型——现在这两件事可换后端：`workerBackend: dsh | openai | cli | off`、`fixerBackend: dsh | cli | off`。`openai` 打任意 OpenAI 兼容 chat completions；`cli` 驱动 headless agent（`claude -p` / `codex exec`）；`off` 为纯机械模式。实测纯机械模式下 `dispatch → 判定 → loss 指标提取 → 通知` 全链路跑通且零模型调用
- **开机中断检测 + 一键续跑**：重启电脑会杀掉所有任务（Windows/WSL 皆然）。quest 启动对账发现「当时在跑、进程已消失、证据显示未正常完成、**且任务期间电脑确实重启过**（用系统开机时刻判定——这条把 OOM/自行崩溃排除掉，那种情况续跑只会再死一次）」的节点时，若该节点/任务线声明了 `resume_on_boot: true` **且能找到断点存档**，就登记为可续跑并推 IM 提示——回 `/q续跑` 即从断点接着跑（`QUEST_RESUME_FROM` 自动注入）。**检测自动、重派要人点头**：重复跑同一任务会双写产物，这个有副作用的决定留给人；另有每节点自动提示上限（`resumeCap`，默认 1）防崩溃循环
- **同步工具**：`sync-oss.mjs` 把生产版文件同步到公开仓库副本时强制清洗本机路径与账号信息，扫描不通过即拒绝提交（此前的两次人工 cp 曾把个人信息带进公开仓库）
- **工程改进**：`finishNode` 各步骤独立 try/catch（任一步失败不再阻断通知）；推送 3 次退避重试 + 失败落盘队列；启动对账覆盖「账本 ∪ plan」两类节点（快速单发此前会变幽灵 running）
## v0.4 新增

- **WSL(Ubuntu) 车道**：plan 头部写一行 `shell: wsl`，整条任务线跑进 WSL——bash 语法、Linux 路径、不经 cmd.exe（无引号剥离）、GPU 直通。负载由 systemd transient service 认养（会话清理与 VM 空闲关停都杀不死）+ 宿主侧 keepalive 保活会话——**quest 崩溃时 Linux 训练进程继续跑，quest 重启后按单元名自动接管**。日志写 WSL 内部、经 UNC 读取，判定/watch/产物全部适配
- **HTTP 仪表盘**：`/dashboard` 单页驾驶舱——任务线（10 秒自刷，按"完成时间正序/运行中/异常/待办"分组）、文件浏览（Windows 与 `\wsl$` UNC 通吃，图片直接预览、大文本截尾）、门禁队列（挂起命令 + 夜间额度）。**不依赖 DSH 存活**，浏览器直开；可经中继映射到局域网/组网远程访问；better-sidebar 薄壳注册为侧边栏标签页（DSH 挂了仪表盘照常可用）
- **`quest_probe` 诊断探针**：同步跑 ≤30 秒的白名单命令并取回尾部输出（解释器 + `-c` 内联放行）——fixer 的"改→试→知"闭环补齐，主对话查中间量也不用开终端；30 秒硬杀 + 账本留痕
- **`quest_files` 文件浏览工具**：AI 直接列目录/读文件，含 `\wsl$` 路径——查 Linux 产物不必再靠人转述
- **断点三层**：①派发前扫脚本（≥15 分钟任务无 `torch.save`/checkpoint 模式 → 提醒 + 收件箱）②运行中盯档案（20 分钟无新存档 → 告警）③**重派自动注入 `QUEST_RESUME_FROM`**（取 cwd 里最新 `.pt/.ckpt/.pth`）——崩溃/修复重跑从断点续，不再从零
- **翻页升级**：翻页时**先把旧会话导出为可搜索 markdown**（`archive/flip-*.md`，fzstd 解压 + 工具输出修剪，89MB → ~10MB）再归档——AI 有了"冷存储"，`grep` 即可查历史细节；仪表盘内也能一键翻页
- **通知可靠性**：推送 3 次退避重试 + 失败落盘队列（每 2 分钟自动补发）+ 每步独立 try/catch——通知不再静默丢失；配套通知端为 owner 通知开专用直发通道，不被长回复挤占
- **任务线排序**：progress.md 与 `/api/status` 统一按"已完成（完成时间正序）→ 运行中 → 异常终态 → 待办（plan 声明序 = 优先级）"分组；查询即刷新

## v0.3 新增

- **孤儿再认领（crash survival）**：子进程 stdout 改为文件句柄直挂（非管道）——quest 崩溃时训练进程**继续跑、继续写日志**；quest 重启后按账本 PID + 命令行指纹找回存活作业，重新接管（超时护栏按原起点续算、watch 照挂、人工终止可用）。拿不到退出码时走关键词/产物证据判定
- **quest_run 门禁**：解释器跑工作区内脚本的命令直通；删除/下载/系统类、工作区外路径、`-c` 内联代码 → 白天挂起推送 owner 等确认（30 分钟超时作废，`/q确认` `/q拒绝`）；夜间窗口（默认 23:00–08:00）AI 带 reason 可自批执行——每晚额度上限 + 每条 QQ 留痕 + 账本审计。`runGate.enabled=false` 可整体关闭
- **日志封顶**：节点 stdout 日志默认 256MB 上限（`max_log_mb` 可调），周期巡检超限截断——verbose 训练不再吃满磁盘；判定/总结/修复全部改尾部读取
- **产物图直推**：成功节点自动把 cwd 里运行窗口内新产出的 png/jpg（≤2 张，`push_images` 可调）经通知端 base64 直发 IM
- **翻篇（flip）**：`/api/flip` + `/q翻页`——归档卡死工作区的全部会话、开新会话并注入 research-state.md 恢复提示；前台失联时的远程逃生通道
- **通知前缀**：所有 IM 通知带 `[任务线标题]` 前缀，多实验并行可分辨来源
- **健壮性**：GBK（Windows cmd 默认编码）日志自动探测解码（中文"训练完成"关键词判定修复）；快任务产物时间戳自竞争修复；运行实例进程树（runs）与 progress.md 实时快照

## v0.2 新增

- **硬指标提取**：正则从日志抠逐轮 loss → 自动算斜率 / 平台检测 → 账本里的零幻觉数字层
- **`when:` 条件分支**：`when: train-a.metrics.loss_slope_10ep < -0.05` 趋势门控——a 好跑 b、不好跑 c（斜率/平台运算符支持"看变化程度"的分支）
- **watch 盯梢**：`watch_rules: if=NaN; confirm=2; action=kill`——运行中定时 tail（默认盯 quest 捕获的 stdout）；默认只警告，NaN/OOM 类可配 kill；连续 confirm 次命中才动手
- **quest_cancel 人工终止**：`/api/cancel` + `quest_cancel` 工具——cancelled 独立终态，不触发自动修复（绝不续杯）、不派 worker
- **research-state.md 自动追加**：任务线收尾自动写研究状态文件到工作区——下次开口时主对话已知道一切，零注入零膨胀
- **启动对账**：quest 重启后把孤儿作业标记 cancelled——不再有"幽灵 running"卡住调度

## 安全边界 / Safety

- fixer 只做机械性修复（prompt 级纪律 + 服务端 diff 审计 + 预算硬停三层约束），公式/模型结构级的改动永远留给人类
- 所有修复有 `.bak` 备份，可随时回滚
- 主对话上下文不受任何自动化流量污染（一晚 N 个任务 = 主对话固定 +2 轮）

## 已知限制 / Known Limitations

- quest 服务是任务的管理者但不再是存活依赖：quest 崩溃后子进程靠句柄直挂存活，但**趁 quest 死亡期间新起的任务**要等 quest 回来才能被派发
- worker 会话归档后仍出现在 DSH 会话列表（archived 语义：脱离工作区，不删除）
- 目前仅 Windows（taskkill 树杀、cmd /c 包装）；Linux/macOS 需替换进程管理部分
- 经 `cmd /c` 派发的命令若含双引号段（嵌套引号、`$var`）会被 Windows 引号规则剥掉——命令请写成朴素形式（`python 脚本.py 参数`），复杂逻辑放进脚本文件

## 上架 / Listing

本仓库可作为一个 DSH 插件收录到社区目录（awesome-dsh-plugin）：投稿材料、要求对照与已知限制见 [docs/market-submission.md](docs/market-submission.md)。

## QQ 命令（搭配 qq-bridge 类通知端）

> 这些命令由**通知端**实现（读 quest 的 HTTP API：零 token、不经过模型）；quest 本身只提供端点。下表是参考实现，通知端可自行增删。

```
/q帮助          — 命令速查
/q状态          — 任务线全景（最近活跃工作区，零 token，DSH 挂了也能用）
/q派发 <节点>   — 派发/重派
/q停 <节点> [原因] — 人工终止（cancelled 终态，不触发自动修复）
/q翻页 [工作区] — 归档卡死会话并开新会话（前台失联时的逃生通道）
/q确认 <id>     — 放行 quest_run 门禁挂起的命令
/q拒绝 <id>     — 作废挂起的命令（从未执行）
/q续跑 [节点]   — 机器重启后从断点续跑被中断的任务（无参数=全部）
/q令牌          — 取 quest 访问令牌（远程填 token 时用）
/q网址          — 当前远程访问地址（同屏 + 直通，含最新令牌）
```

## License

[MIT](LICENSE)
