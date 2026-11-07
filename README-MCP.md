# quest-mcp —— AI 任务执行与治理层

**English:** An MCP server that gives any AI agent (Claude Code / Codex / Cursor / ZCode / …) a real task-execution lane: dependency-chained plans, success-criteria judging, receipts, crash-takeover, and a live dashboard. Long commands run as supervised processes — the agent delegates and gets receipts, instead of babysitting a terminal. The quest service auto-starts on first use; zero config, zero daemon to manage.

给任何 MCP 客户端的 AI 一个**任务执行与治理层**：模型只管派单和收回执，命令在带判定/守护/重试的进程车道里跑。

## 为什么需要它

裸 agent 跑长命令的三大死法：回合被挂死命令冻住；进程随会话退出而死；干没干成全凭模型自述。quest 治这三个：**后台执行+成功判据强制核对+崩溃自动接管**，账本留痕、画板可视。

## 安装

**方式一（推荐）：GUI 安装向导** —— 终端跑：

```
npx dsh-quest-service install
```

浏览器自动打开组件选择页：勾选 quest 核心 + 按需勾选生态模块（论文下载/CAE 工具/文档转换/QQ 全家桶），点安装——GitHub 走三路镜像加速，Python 依赖走清华源，实时日志可看。装完按完成页话术发给你的 AI 收尾注册。

**方式二：手动 MCP 客户端注册**（Claude Code 等任意 `mcpServers` 形态）：

```json
{
  "mcpServers": {
    "quest": {
      "command": "npx",
      "args": ["-y", "dsh-quest-service"]
    }
  }
}
```

首次调用时 quest 服务自动拉起并常驻（`~/.dsh/quests/`），无需手工建服务或守护。数据目录可用环境变量 `QUEST_HOME` 自定义。

## ★ 采用纪律（重要——贴到你的 AGENTS.md / CLAUDE.md）

工具装上 ≠ 会被用。把下面这段粘进你的项目规则文件，模型才会自觉走车道：

```markdown
## 任务执行纪律（quest）
1. 预计超过 1 分钟的命令，一律用 quest_run（带 success 判据），禁止直接跑 shell 长命令。
2. 多步骤/有依赖的活写成 quest_plan 节点（---node: id--- 格式），用 after 串依赖链。
3. 秒级诊断才允许直接 shell；查询任务进度用 quest_status / quest_log，不轮询。
4. 派出的任务只认 quest 回执，不重复盯梢。
```

## 工具速览

| 工具 | 用途 |
|---|---|
| `quest_run` | 单发后台任务（命令+判据+超时+回执） |
| `quest_plan` / `quest_dispatch` | 多节点计划（依赖链/条件分支/意图节点）与派发 |
| `quest_status` / `quest_log` | 全景状态 / 节点日志尾（不轮询） |
| `quest_probe` | 30 秒白名单诊断探针 |
| `quest_notify` / `quest_track` | 点名用户 / 外部任务登记 |
| `quest_lit` | 文献检索（crossref/arxiv/openalex，一次 10-25 篇元数据） |

完整节点格式与判据语法见 `PLAN-TEMPLATE.md`（quest_plan 工具描述内亦有精简版）。

## 通知通道（可选，把回执/点名推到你的 IM）

`quest-config.json` 的 `notify` 段三选一（默认 off）：

```jsonc
// A. webhook（推荐，任何 IM 机器人）：Telegram/钉钉/飞书/企微模板见 notify.mjs 注释
"notify": { "kind": "webhook", "url": "https://open.feishu.cn/open-webhook/bot/v2/hook/<TOKEN>",
            "bodyTemplate": "{\"msg_type\":\"text\",\"content\":{\"text\":\"{{message}}\"}}" }

// B. bridge（qq-bridge 用户）：POST /api/send/private 形态的任何通知端
"notify": { "kind": "bridge", "bridgeUrl": "http://127.0.0.1:3100", "userId": <你的QQ号> }

// C. off：不推送，回执只留账本/画板
```

### QQ 全套（和 DSH 用户同款体验，可选）

想要 QQ 群交互（群→工作区映射、/q 命令、审批推送、晨报）需两件：

1. **SnowLuma**（QQ 协议端，OneBot v11）：`github.com/SnowLuma/SnowLuma` 的 Releases 下载解压，`launcher.bat` 启动；
2. **qq-bridge-work**（工作版桥）：`git clone https://github.com/yunlong-wang11111/qq-bridge-work && npm install`（fork 自 Derpyu520/qq-bridge，含自动换届/看护/防循环等工作版增强）。

把本段交给你的 AI，它可自行完成安装与配置；人工安装同样适用。装好后在 quest 配置里设 `notify.kind=bridge` 指向桥（默认 `http://127.0.0.1:3100`）。

## 生态工具（同系列，按需另装）

| 工具 | 干什么 | 获取 |
|---|---|---|
| paper-fetch-mcp | 论文全文 PDF（Unpaywall OA+订阅机构 IP 路由+出版社墙情报+全文 txt 提取） | `github.com/yunlong-wang11111/paper-fetch-mcp` |
| cae-lanes | CAE 仿真工具集（TikZ 学术流程图/mermaid 渲染/网格 refine/Abaqus-Comsol 接口） | `github.com/yunlong-wang11111/cae-lanes` |
| mcp-libre / office | 文档转换矩阵（docx↔pdf↔xlsx，公式感知路由保真） | 见各仓库 README |

文献**检索**已内置（quest_lit：crossref/arxiv/openalex 一次 10-25 篇元数据）；上表是**全文获取**和领域工具。

## 与 DSH 的关系

本包同时是 DSH（DeepSeek Harness）的插件形态仓库。DSH 用户按插件方式安装可获得额外能力（`quest_spawn` 派真子对话、自动换届等，依赖 DSH 会话 API）；MCP 形态对客户端中立，无 DSH 时这些 DSH 特有工具会给出明确指引。

## License

MIT
