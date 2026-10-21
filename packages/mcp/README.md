# dsh-quest-mcp

quest 任务线的 **MCP 工具面**（17 个工具）。给任何支持 stdio MCP 的 AI 会话（DSH / Claude / 任意 MCP 客户端）装上"会派发任务、会记账、会读日志"的手。

> quest 本体 = 独立服务（账本/判定器/守护/子对话体系）。本包只是它的 MCP 薄客户端，
> **需要本机 quest 服务（默认 127.0.0.1:3110）在跑**——服务端装法见仓库根 README。

## 接入 DSH（三步）

1. **quest 服务在跑**（`node server.mjs`，见根 README；token 在 `~/.dsh/quests/.token`）

2. profile 的 `cordis.patch.yml` 加一条 MCP 注册：

```yaml
- insert:
    - id: mcp-quest
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        transport: stdio
        serverName: quest
        command: "node"            # 你的 node 绝对路径更稳
        args:
          - "C:/path/to/dsh-quest/packages/mcp/mcp-server.mjs"
        toolCallTimeoutMs: 60000
        failOnStartupError: false  # quest 没起也不拦 DSH 启动
```

3. 重启 DSH → 会话里就能调 `quest_run` / `quest_status` / `quest_spawn` ……

## 接入其他 MCP 客户端

任何标准 stdio MCP 配置都行：command=`node`，args=`[本目录/mcp-server.mjs]`。
环境变量 `QUEST_URL` 可改服务地址（默认 `http://127.0.0.1:3110`）。

## 工具清单（17）

| 类 | 工具 |
|---|---|
| 派发/执行 | quest_run（快速单发） · quest_plan（多节点计划） · quest_dispatch · quest_specify（意图节点回填） |
| 状态/账本 | quest_status · quest_log · quest_track（外部任务登记） |
| 会话体系 | quest_spawn（派子对话） · quest_tell · quest_register_main · quest_register_role · quest_flip（翻页·仅人工） |
| 诊断 | quest_probe（秒级探针） · quest_files · quest_cancel |
| 通知 | quest_notify（点名用户·仅登记主对话） |
| 文献 | quest_lit（arxiv/crossref/openalex 三源检索） |

## 推荐人设（可选，让会话"会用"这套工具）

见同目录 `presets.example.yml`——六个角色（主对话经理/工人/总结员/修复员/子代理/QQ聊天），贴进你的 profile 即可。
工具本身无人格：谁调都是同一套账本，人格跟会话走。

## 已知边界

- 判定器偶发 "no-output" suspect 误报（判定口径偏严，重派即消）；
- 若你用 SnowLuma 等 OneBot 网关，建议事件通道用 3000 端口（3001 正向 WS 有推送故障记录）。
