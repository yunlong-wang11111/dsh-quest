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
- **跨 agent（MCP）**：12 个工具以标准 MCP 暴露，Claude Code / Codex / ZCode / Cursor 等可直接调用；quest 本体零模型依赖——执行、判定、指标、超时、重试、通知全程不需要 AI
- **中断恢复（v0.5）**：机器重启后开机自动检测被腰斩的任务——仅在**确实重启过**（系统开机时刻判定，OOM/自崩不算）且**有断点存档**且节点声明 `resume_on_boot` 时，推一条提示；回 `/q续跑` 从断点接着跑。检测自动、重派要人点头（重复跑会双写产物）
- **QQ 推送**：经 bridge console 直发（纯 HTTP，不经过任何对话）；任务线收尾自动推总览；推送带重试+落盘队列，失败不静默丢失
- **外部进程接入**：手动启动的 python 进程（≥5 分钟）退出后由检测端转交同一管线
- **崩溃韧性**：账本追加式 + 状态可重建；quest 自带守护循环重启脚本

## 快速上手 / Quick Start

要求：Node.js ≥ 20。**DSH 不是必需的**——quest 可独立运行（纯机械模式），DSH 只用于可选的任务总结与自动修复；Windows 与 Linux 都能跑（WSL 执行车道为 Windows 专属）。

```bash
# 1. 启动服务（数据目录 ~/.dsh/quests/ 与令牌自动生成）
git clone https://github.com/yunlong-wang11111/dsh-quest.git && cd dsh-quest
node server.mjs

#    服务起来后：仪表盘 http://127.0.0.1:3110/dashboard
#              MCP 服务器 node mcp-server.mjs（本仓库内；接 Claude Code / Codex / ZCode 等 MCP 宿主）

# 2. 编辑 ~/.dsh/quests/quest-config.json（通知出口等；默认关闭，配法见下文「通知出口」），重启服务生效

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
| ntfy（自建/公共实例，手机 App 真推送） | `https://ntfy.sh/<topic>` | `{{message}}` |
| Apprise API（一个端点转发到 100+ 服务） | `http://<host>:8000/notify/<key>` | `{"title":"quest","body":"{{message}}"}` |

ntfy 这类"把请求体本身当消息"的服务用**裸** `{{message}}`；Telegram/钉钉这类要求 JSON 信封的用"带引号"写法。

`{{message}}` 两种写法都支持：**带引号**（`"{{message}}"`，填 JSON 内层转义）或**裸放**（`{{message}}`，填完整 JSON 串）。照服务商文档抄哪种都对。消息里的引号、换行、反斜杠都会正确转义。

</details>

> **图片产物直推**目前只在 `bridge` 模式可用（webhook 模式会明确提示不支持，而不是静默丢弃）。
> **长度**：通知不消耗 token，默认上限 `notify.maxChars: 4000`（QQ 单条约 4000 字的安全值）。超过时**保留头+尾**（头部是任务线前缀与判定，尾部通常是总结结论），并在中间标「中段省略」。兼容的通知端应自行按 IM 硬上限拆条，而不是拒收——qq-bridge 已如此处理。

## 让它常驻（监督器） / Keep it running

**quest 是一个服务，而服务无法监督自己**——进程死了就没人再判定、通知、认领。任务侧的崩溃存活（句柄直挂 / systemd 认养 / 重启后按账本认领）是 quest 自己的机制，不需要外部帮忙；但 quest 进程本身必须由外部拉起来。

**Linux / macOS（推荐，用 systemd 而不是自己写守护）**：'guard/quest.service' 是现成的用户级单元（`Restart=always` + 重启风暴保护 + 日志落盘）。装法见文件头注释，四行命令。

**Windows（没有 systemd：计划任务 + 一个自愈批处理）**：`start-quest.bat` 是最小监督器——崩了 5 秒重起、按端口做单实例守卫（避免两个实例互抢端口刷屏）、日志超 32MB 自动归档。`quest-autostart.vbs` 负责以**隐藏窗口**把批处理拉起来。

```bat
rem 计划任务：登录时启动（每小时的复查见下面的 XML 说明）
schtasks /Create /TN "quest-service" /SC ONLOGON ^
  /TR "wscript.exe \"C:\path\to\quest\quest-autostart.vbs\"" /F
```

想要"每小时复查一次、但不重复起实例、也不因任务超时被杀"，用 XML 定义三个设置更精确：`MultipleInstancesPolicy=IgnoreNew`、`ExecutionTimeLimit=PT0S`、`LogonType=InteractiveToken`（触发器给"登录"加一个"每小时重复"）。这样**监督链断了会在下一次复查时自己回来**，而正在跑的链不会被重复拉起。

> ⚠️ **不要**把 quest 做成 Windows 服务（NSSM）或用"不管用户是否登录都运行"的计划任务：这两种都跑在 session 0，而 Store 版 WSL 在 session 0 里不可用（`wsl.exe` 会失败）——quest 的 WSL 车道正是靠 `wsl.exe` 派发的，会被打断。用"仅在用户登录时运行"就能两全。代价是：注销后 quest 停止（WSL 虚拟机本来也会随会话消失）。

**更轻的替代**：`guard/quest-guard.ps1` 是一个探活 `/api/status` 的极简监督器（任何 HTTP 响应都算活着，含 401），适合"只要能死而复活"的场景——每 5 分钟轮询一次，注册方式见文件头注释。它和上面的批处理**二选一**，别同时上（两个拉起者会互相抢端口）。

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
success: 日志尾含"训练完成"且产出 model.pt   # 成功判据：判定器会强制核对（见 PLAN-TEMPLATE）
freeze_on: hard-fail-only    # 可选：只有真失败才冻结下游，上游"疑似"时放行（可写 plan 头）
auto_fix: true               # 失败后自动修复（可选）
fix_budget: 2                # 修复次数上限（默认 2）
handoff: |                   # 给 worker 的交接上下文（决定总结质量的上限）
  验证 X 方法在 Y 条件下的效果；
  看 val_loss，健康范围 < 1e-3；
  OOM 会先打印 batch retry……
```

完整字段说明与五段科研流水（生成→训练→后处理→评估→可视化）标准骨架见 [PLAN-TEMPLATE.md](PLAN-TEMPLATE.md)；设计取舍（为什么不用现成工作流引擎、判定器与冻结策略怎么定的）见 [docs/DESIGN.md](docs/DESIGN.md)。

## 重启服务前必读（2026-09-14 实测） / Before restarting

**杀掉 quest 会连带杀死 Windows 车道的任务。** quest 用 fd 持有 stdio 派发的 Windows 子进程被放在 job object 里（libuv 的 KILL_ON_JOB_CLOSE 语义），父进程一死子进程立刻消失——实测确认（父进程被杀后 1.5 秒，子进程已不存在）。

| 车道 | 重启 quest 的后果 |
|---|---|
| **Windows 车道**（缺省） | 任务被打断，**不会自愈**，只能重派 |
| **WSL 车道**（`shell: wsl`） | 不受影响：负载由 systemd 单元持有，重启后启动对账按单元名认领并继续判定 |

所以：

- 重启前先跑 `node tools/restart-when-idle.mjs` —— 有任何节点在跑就**拒绝**并列出它们（已跑多久、在哪个工作区）；确认要打断才加 `--force`。
- **不能白跑的长任务（训练、长扫描）请用 `shell: wsl`**；Windows 车道留给几分钟内能跑完的活。
- 判定侧是诚实的：被重启打断的节点会标成 `suspect`，`via` 里写明"quest 重启期间进程已消失，按产物/关键词判定"，不会假装成功。

## 跨 Agent 使用（MCP） / Agent-agnostic via MCP

quest 本体不绑定任何 AI 工具——它自己派进程、判定、重试、通知，全部零模型参与。因此**任何**能发 HTTP 的 agent（Claude Code、Codex、ZCode、Cursor、一段脚本）都能驱动它；仓库里的 `mcp-server.mjs` 进一步把这套能力做成标准 **MCP 工具**，模型不用再自己拼 curl。

```bash
# 依赖：node ≥ 20
npm install            # 安装 @modelcontextprotocol/sdk / zod / fzstd
node server.mjs        # 启动 quest 服务（3110）
node mcp-server.mjs    # MCP 服务器（stdio，由 agent 拉起，无需手动运行）
```

暴露 12 个工具：`quest_plan` `quest_dispatch` `quest_run` `quest_spawn` `quest_status` `quest_log` `quest_probe` `quest_files` `quest_cancel` `quest_flip` `quest_notify` `quest_lit`。

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

## v0.7.1 新增（2026-09-23，内测 P2–P8 批次）

- **`quest_tell`（P4）**：向 spawn 出的子对话发引导消息——绕开 DSH send_message 的父子会话限制（"能停不能引导"的对称性修复）；queue 语义，spawnId 支持片段
- **status 渲染硬上限 ~8KB（P5）**：原生插件此前全量渲染大工作区可达 300+KB；现在概览（asOf 快照时刻 + 四类计数）+ 异常/在跑 + 最近完成 12 条，全量明细落盘 `<工作区>/quest-status-full.txt`，`verbose:true` 可跳过截断
- **四类计数（P3）**：`line.verdictBuckets` = ok / suspect(记账) / crash(脚本) / infra(超时·终止)——"failed 38%"不再一锅端；`asOf`（P2）快照时刻随 status 返回
- **探针拒顶层 shell 元字符（P6）**：引号**外**的 |、&、;、换行 直接拒绝（此前第二段命令被静默丢弃）；引号内（-c 的 Python 分号）放行——引号感知扫描
- **tag 批量收线（P7）**：`quest_cancel {tag}`——节点 id 含片段的在跑杀树、pending/frozen/ready 落 cancelled
- **更正类绕过冷却（P8）**：首行 `retract:`/`更正：`/`撤回：`/`作废：` 的 notify 不受 10 分钟冷却限制
- **WMI 探测诚实化（python-manager 配套）**：`python_resources` 在 WMI 被拒/损坏时显式报"探测不可信"并给替代验证路径，不再静默返 0（当日 AI 据此误判三件活全死）；退出检测同样跳过不可信快照

## v0.7.0 新增（2026-09-22）

- **`quest_spawn` 派真子对话（L3，用户内测定稿）**：给 AI "派子对话"的动词——建同工作区独立 DSH 会话 + 种子提示（身份/运行纪律/简报契约）。handoff 复用 plan 节点写法（"一套写作技能、两种执行形态：节点里跑脚本、子对话里跑判断/写码"）。**可见性**（用户硬约束①）：spawned 进 `/api/status` 的 spawned 区、progress.md「派出的子对话」、控制台卡片；**有界返回**（硬约束②）：子对话干完调 quest_notify 交结构化简报（做了什么/产物路径/读数/阻塞/建议）定向回派发者，`spawn.reported` 记终态，超期 sweep 标 overdue + 催派发者一次。子对话不能再派子对话（一层为限）；spawned 会话计入 quest 自建名单（不进兜底上报目标）
- **分工文档（L1）**：PLAN-TEMPLATE 新增「谁干什么：分工决策树 + 责任表」（含"一个阶段=一个节点，不是一个会话"）与「suspect 的 30 秒分诊」（四个 via 原因码对照 + 快判口诀；澄清**没有**独立的"脚本自检 FAIL"路径——它表现为 success-claim-failed）；补 expect_minutes 估法规则（单件实测×件数）；定义"本次运行窗口"（job 启动前 2 秒起，实时判定无上界）；补 quick 可见性说明、409 默认动作、非 torch 断点语义；模板补全 timeout_seconds/when/watch_rules/resume_on_boot 四个字段并修复 shell: 行格式断裂
- **plan 写入时预检（用户提议）**：command 里的 .py 存在性 + py_compile，**警告不拦**（派发预检照旧硬拦）——"plan 三个脚本都不存在，建好了却派不了"这类问题提前到写入时暴露

## v0.6.4–0.6.6 新增（2026-09-18/19）

- **失败上报的定向链补全（生产事故复盘）**：主对话把活派给子会话后，"最新会话"兜底几乎永远命中子会话——一天 6 次失败上报散进 6 个不同子会话，主对话一次收不到。修复分三层：①`questSpawnedSids` 只认 `notify.converge.worker`/`fix.*` 的出生证明（旧版 ≤0.6.0 的 `notify.converge` 事件把 sessionId 记成**主对话**，通配收集会把主对话永久拉黑——9/16 起就在发生）；②上报定向链对齐收敛/死信复活：**派发者 → 主对话（converge 登记/翻页接班）→ 最新非自建**；③毒丸回归测试进套件
- **署名回执制（v0.6.6 核心）**：派任务署名（插件层 `sessOf` 深扫描 `session-<uuid>`，对 DSH exec 结构漂移鲁棒；找不到时自动 dump exec 骨架取证）+ **成败都回执**——署名派发的节点完成后发一行 `✅【回执】` 给派发者，"派活→等结果→接下一步"的接力不再断链（自动链节点无署名不回执，不轰炸）；**点名回执不设冷却**（冷却只防兜底轰炸；实测事故：派发者自己的失败被 10 分钟冷却吞掉、兜底收敛又被 pending 幽灵节点卡死，主对话断链睡到天亮）
- **QQ 通知权收归主对话**：`quest_notify` 服务端鉴权，非登记主对话调用直接被拒（提示回执给主对话）；quest 自动 QQ 可全关（`converge.qq:false`、`failureBatchSec:0`、`escalate.cooldownMin:0`）——阶段汇总与决策点名由主对话统一发声
- **`escalate.cooldownMin: 0` 语义修正**：原先 `Number(0)||10` 把 0 悄悄变 10 分钟（与 failureBatchSec/reviveHours 的"0=关"约定相悖）
- **测试**：escalate-deadletter 扩到 12 用例（毒丸防拉黑/冷却绕过/成功回执/QQ 收权三连）；notify-gate 6/6；另踩坑记录：Windows 跨进程 append 不保序，测试里外部账本注入必须留时间窗（慢节点+派发后补署名）
- **可移植性**：插件里硬编码的个人路径清零（PLAN-TEMPLATE 从仓库位置推导，示例路径泛化）

## v0.6.1 新增（2026-09-17）

- **收尾"假超时"根修（hostPathFor 死路径）**：收尾等待轮询的路径转换函数把 Windows 盘符路径也当 Linux 路径拼 UNC，`C:\...` 变成 `\wsl$\Ubuntu\C:\...` 这种**永远不存在的死路径**——收尾会话 53 秒写完总结、quest 却等满 15 分钟报超时（生产 23/23 全假超时，连此前"6 分钟太紧"的调参也是这个 bug 的误诊）。现在 Windows 盘符/UNC 原样返回，全调用点（产物扫描/断点/图片/收尾）一起修正。**教训进了注释**：修"慢"之前先证明确实慢
- **`/api/summarize` 异步化**：原来同步等两阶段走完，HTTP 挂 15 分钟（浏览器/QQ/测试全断）。现在回执只等"派发"（建会话+发提示词，秒级），等待+通知转后台，`notify.converge` 的 done 事件异步补写
- **`quest_lit` 文献检索（三源）**：arxiv（Atom）/ crossref（SCI 主力：Elsevier/Springer/Wiley/IEEE/MDPI 的 DOI 元数据）/ openalex（全覆盖带被引数），一次调用拿 10-25 篇标题/作者/年份/venue/摘要（≤700 字/篇）。动机是实测：一个调研子代理手爬 131 次 web_search + 245 次 web_fetch = ¥1.4，全是检索翻搅
- **失败风暴聚合**：Tier 0 的失败推送在风暴日（65 个失败节点）打爆通知桥的小时限额（60/小时，实测 429 丢信）。现在失败进 45 秒窗口（`notify.failureBatchSec`，0=关回逐条），窗口内合并成一条汇总（逐节点首行点名）；成功仍即时推（有产物图跟随）；单个失败不套汇总头。账本记 `notify.fail-batch`
- **空 `ws` 防护**：`/api/summarize` 缺 ws 参数直接 400——此前会退化成无主收敛，账本写进 quests 根目录
- **测试**：新增 fail-batch（6/6）、lit-search（13/13，含三源 live 冒烟）；converge-notify 回到 13/13；全套 17 通过/2 跳过（WSL 环境依赖）

## v0.6 新增（2026-09-16）

- **两阶段收尾（用户定稿："子对话总结、通知主对话——而不是主对话总结"）**：此前收敛后要么让主对话自己读全部状态干总结（753k 上下文每唤醒一次重发一遍），要么总结会话写完没人转达。现在拆成两段：**轻量收尾会话**（新建、小上下文）读 quest_status brief → 写 `line-summary-日期.md`；写完后**主对话只收一条短通知**（要点 + 文件指针 + 自动推进指令），大上下文只花一次重发。总结等待上限默认 15 分钟（`summaryTimeoutSec` 可调），**超时不截断流程**——照样通知主对话（文件指针模式）并推 QQ 超时警报；收尾会话实测 53 秒～7 分钟完成
- **三级通知定型**：Tier 0 QQ 逐节点（成功即时）；Tier 1 收尾总结（上述）；Tier 2 **失败上报**——失败节点定向上报给**派发它的会话**（`dispatchedBy` 归因，quest_plan/dispatch/run 都带），指针式短讯不塞日志，auto_fix 已接手的跳过
- **`quest_status` brief 默认**：大工作区全量 28.9 万字符 → 摘要 ~1700（166 倍压缩）：当前状态/计数/在跑/异常/最近完成。verbose:true 才给全量
- **翻页 `quest_flip`**：上下文交接（9 段模板：目标/结论/数据/在跑/冻结/待办/环境/纪律/联系人）+ 旧会话导出归档 + 主对话定向（converge-state.json 的 mainSessionId，翻页自动更新）。控制台按钮 / QQ `/q翻页` / AI 工具三个入口
- **计划存档**：写新 plan 覆盖前旧 plan 自动存 `plans/`；`/api/plans` 列当前+历史；控制台下拉切换——"AI 顺手重写把历史蒸发"不再发生
- **控制台 v2**：单页合并任务线/日志/文件；**DAG 路线图**（依赖箭头、完成绿勾、冻结红锁、人工门金星）；正在跑跟踪器；门禁队列；15s 超时兜底不再"读取中"假死
- **PLAN-TEMPLATE 增补**：术语表（主对话/子对话/子代理/worker子会话/收尾会话——此前 AI 分不清会混用）、"每步都进 plan"、"一次科研 = 很多份短流程 plan"、"先写 plan 还是后补"（`draft-plan-from-ledger` 从账本原样抄节点）、收线纪律
- **工程**：幽灵节点修复（只有 dispatched/plan 声明事件才建节点——probe.error 之类不再造出空节点）；`endedAt` 取首终态不被重判覆盖；probe 车道按 `n.shell` 判（修 WSL 快速节点 404）

## v0.5 新增

- **收敛信号（回答「任务是不是真的都完成了」）**：此前收尾判定只看 plan 声明的节点、而且只响一次——于是"只用 `quest_run` 快速单发"的工作区永远收不到"都完成了"的信号（真实事故：某工作区 4 个 plan 节点早已全终态，之后又跑了 29 个 quick 任务，却再没有任何汇总；用户侧的感受就是"我不知道子对话是在改代码、在重派，还是真完了"）。现在改成**可重复的静默判定**：没有在跑节点 + 账本安静 `quietMinutes`（默认 10）分钟 + **工作区也没有新文件改动**（`wsActivityMinutes`，默认 15）→ 推一条 `[🏁 静默] 没有在跑的节点 · 最近动作 X 分钟前 · 共 N 个：…` 并附一句工作区状态（`最近 15 分钟无改动` / `有 3 个文件被改（最新 train.py）`）。只在"活跃→静默"跃迁时响一次，有新动作自动重新进入活跃（不刷屏）。`/api/status` 的 `line` 字段把同一份状态交给 AI（`quiet`/`active`/`idleMinutes`/`workspace`），progress.md 顶部也有状态行
  - **子对话在不在干活（C）**：还直接问 DSH 一次 `session/list`（返回 `running`/`cwd`/`updatedAt`），把**本工作区的会话有没有在跑**也作为收敛条件——这是最直接的信号（不只是"文件变了没"的推断）。状态行会写 `子对话：没有会话在跑（本工作区共 N 个）` 或 `N 个会话在跑——AI 正在干活`。探测失败一律降级为"不门控"（绝不影响任务流转），且只在巡检时刷新一次缓存（不在 /api/status 请求路径上打 DSH）
  - **为什么需要"工作区也静"**：账本安静 ≠ 没人干活。agent 可能正在改代码、还没派发任务——只看账本就会把这种情况误报成"收敛"。所以两个条件都满足才算
  - 诚实边界：这是**收敛推断，不是完成保证**——agent 会不会再派任务在事前不可观测，所以通知与状态里都写明依据（最近动作多久前、工作区有无改动），由人判断可信度
- **回归防线进了仓库（`tests/`）**：六组测试每条都起自己的沙箱实例（独立 `--home`/端口、通知关闭、worker/fixer 关闭），绝不碰机器上正在跑的生产服务与真实数据。`npm test` 约 46 秒跑完：`success:` 判据的解析/校验、判定器端到端、plan 覆盖保护与冻结策略、预检必须同步报错、看门狗两振、通知内容。写它们的过程中确实抓出了真 bug（`*.pt` 曾误匹配 `a.txt`、判定器抛异常会让节点永久卡在 running、`extractMetrics` 要求 ≥2 样本导致短日志的阈值判据形同虚设）
- **`success:` 判据变成硬约束**：这个字段以前只是写给 worker/人看的白话，判定器根本不读（成了装饰品）。现在它会被解析成可机器校验的条件并强制核对——引号里的关键词必须出现在日志尾、文件名/通配必须落在本次运行窗口内有产出、指标阈值（`val_loss < 1e-3`）用日志里提取到的指标核对；任一项不满足 → `suspect` 并写明缺什么。**提不到指标记"未核实"而不是判失败**（宁可漏判不误杀：一次假阳就是一晚算力）。解析不出可校验条件时自动退回原来的通用判定，旧 plan 行为不变。判定器抛异常也不再让节点永久卡在 `running`（落 `suspect/judge-error`）
- **预检失败不再伪装成"派发成功"**：`/api/run`、门禁放行、`/api/resume` 原先都不 await 派发结果，处理器先回 `{ok:true}`——于是脚本语法错、解释器不存在、车道不匹配全都表现为"✅ 已后台派发"，而失败只落在账本与 unread 收件箱里（插件还明确告诉 AI 别轮询）。现在请求路径同步等预检并原样返回原因（实测：Linux 路径未声明车道之类当场回 `ok:false` + 可操作提示）。顺带补上 `cwd` 方向的车道检查（声明了 `shell: wsl` 却给 Windows 路径时，直接告诉你该写 `/mnt/c/...`）

- **开箱可用的默认配置 + 监督器配方**：此前首启生成的 `quest-config.json` 里带着开发期的沙盒端口（3090）与本机路径（清洗后成了不存在的 `__HOME__` 占位），新用户拿到的是一份废配置；现在默认值只有真正需要的键，通知出口默认 `off`，DSH 指向默认端口 3080。Windows 侧的常驻配方也改写为实测过的"计划任务 + 自愈批处理"（`start-quest.bat` 崩了 5 秒重起、按端口做单实例守卫、日志超 32MB 自动归档），并写明**为什么不能做成 Windows 服务或"不登录也运行"的任务**（session 0 里 Store 版 WSL 不可用，会打断 WSL 车道）。设计取舍总览见 [docs/DESIGN.md](docs/DESIGN.md)
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
- **`quest_probe` 诊断探针**：同步跑 ≤30 秒的白名单命令并取回尾部输出（解释器 + `-c` 内联放行）——fixer 的"改→试→知"闭环补齐，主对话查中间量也不用开终端；**车道按命令首词自动判**（Linux 绝对路径 → WSL 中继，盘符/UNC → Windows；WSL 车道 25 秒硬上限，留中继余量），到点杀整个进程组 + 账本留痕（`probe.run` 必有 `probe.done`/`probe.error`——悬着不返回是 bug）
- **收线 `tools/close-line.mjs`（2026-09-14）**：宣布一条任务线结束，把还没开跑的节点冻结掉。为什么需要：`orchestrate` 只在**节点退出**时触发，所以被放弃的老线里遗留的 `pending` 节点是「休眠但挂着扳机」——同一工作区里任何一个节点跑完都会把它顺带派出去（老线抢机器、没人记得它为什么在跑）。收线只冻 pending/ready，**正在跑的不动**（跑完照常判定，不谎报「冻结但还在烧 CPU」）；**可逆**：重派该节点即解冻它，`/api/resume` 上游即解冻整条下游。用法：`node tools/close-line.mjs <工作区路径>` 预演、`--apply` 生效，或 `POST /api/close-line {apply:true, reason}`。一条线全部节点已是终态时：什么都不用做（冻结是空操作）。
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

## 远程控制命令（示例实现：QQ 桥） / Remote control

> **这是可选的外挂，不是本仓库的组件。** quest 自身不依赖任何 IM：它只提供 HTTP 端点，命令由**通知端**实现（零 token、不经过模型）。下表是一个通知端的参考实现——用来在手机上用聊天命令操作 quest。任何通知端都能实现同一套命令。
>
> 下表对应的实现来自 **qq-bridge（第三方项目，不在本仓库内、不随本包分发，本仓库也不包含它的代码或配置）**。README 只描述"要实现哪些命令、调用了 quest 的哪些端点"，你需要自己准备一个通知端；不想弄就配 `notify.kind: webhook` 用只读通知，控制改走仪表盘。

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
