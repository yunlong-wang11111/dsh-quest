# dsh-quest

> 科研实验的任务线调度台 —— 让 AI 对话只负责"立项与验收"，长任务交给独立后台服务，结果自动推送 QQ。
> A pipeline orchestrator for research experiments on DeepSeek Harness (DSH): dispatch long-running tasks to an independent background service, get judged results and AI-written summaries pushed to QQ — while your main conversation stays clean.

## 为什么做这个 / Why

在 DSH（或任何 AI 对话客户端）里跑长实验有三个老毛病：

1. **通知污染**：任务完成通知直接注入主对话（followup 模式），主对话越喂越大——一个 1049 轮的会话每轮要吃 44 万 token 上下文；
2. **轮询风暴**：插件轮询进程表/会话文件做检测，拖垮宿主（我们在生产环境实测过 63% CPU 被 GC 吃掉的案例）；
3. **单终端排队**：多个实验挤一个共享终端，互相阻塞。

dsh-quest 用一套**事件驱动**架构解决：进程退出由操作系统事件感知（零轮询），AI 总结由**一次性 worker 会话**完成（用完归档，主对话零增长），失败由**带预算的 fixer 会话**自动修复（改前 .bak 备份 + 客观 diff 上报）。

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
- **worker 一次性会话**：任务结束 → 独立小会话读[交接上下文+日志尾]写 ≤10 行总结 → 归档。主对话零增长
- **auto_fix 自动修复**（可选，节点级开关）：失败 → fixer 会话做**机械性最小修复**（显存调 batch / NaN 调 lr / 路径环境；**绝不碰实验逻辑**）→ `.bak` 备份 → py_compile 验证 → 自动重派。预算烧尽或判断需人工（FIX_GIVEUP）则停手告警。修复后服务端做**客观逐行 diff** 上报 QQ（不信任自述）
- **QQ 推送**：经 bridge console 直发（纯 HTTP，不经过任何对话）；任务线收尾自动推总览
- **外部进程接入**：手动启动的 python 进程（≥5 分钟）退出后由检测端转交同一管线
- **崩溃韧性**：账本追加式 + 状态可重建；quest 自带守护循环重启脚本

## 快速上手 / Quick Start

要求：Windows + Node.js ≥ 20 + [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) 0.1.2+

```bash
# 1. 启动服务（数据目录 ~/.dsh/quests/ 自动创建）
git clone https://github.com/yunlong-wang11111/dsh-quest.git
cd dsh-quest
node server.mjs          # 端口 3110；token 自动生成于 ~/.dsh/quests/.token

# 2. 编辑 ~/.dsh/quests/quest-config.json（QQ 推送等），重启服务生效

# 3. 挂 DSH 插件：把 dsh-plugin/ 目录 link 或复制到你的 DSH profile，
#    package.json 的 dsh.profile.bundles 加 "dsh-quest"

# 4. 装 preset：presets/quest-worker 与 presets/quest-fixer 复制到 ~/.dsh/.agent-presets/

# 5. 在 DSH 对话里说："用 quest 建任务线跑 xxx，然后派发"
```

## 任务线格式 / Plan Format

```markdown
# 任务线：<一句话说清在验证什么>
workspace: <实验目录绝对路径>

---node: train---
command: <python 绝对路径> train.py --lr 1e-4
cwd: <工作目录>
expect_minutes: 240          # 超时护栏 = 2 倍
after: gen-data              # 依赖：上游成功自动跑本节点
auto_fix: true               # 失败后自动修复（可选）
fix_budget: 2                # 修复次数上限（默认 2）
handoff: |                   # 给 worker 的交接上下文（决定总结质量的上限）
  验证 X 方法在 Y 条件下的效果；
  看 val_loss，健康范围 < 1e-3；
  OOM 会先打印 batch retry……
```

完整字段说明与五段科研流水（生成→训练→后处理→评估→可视化）标准骨架见 [PLAN-TEMPLATE.md](PLAN-TEMPLATE.md)，设计取舍见 [DESIGN.md](DESIGN.md)。

## 安全边界 / Safety

- fixer 只做机械性修复（prompt 级纪律 + 服务端 diff 审计 + 预算硬停三层约束），公式/模型结构级的改动永远留给人类
- 所有修复有 `.bak` 备份，可随时回滚
- 主对话上下文不受任何自动化流量污染（一晚 N 个任务 = 主对话固定 +2 轮）

## 已知限制 / Known Limitations

- quest 服务是任务的父进程：quest 重启会杀掉跑着的任务（守卫循环只救 quest 自己）——重启前先确认无 running 节点
- worker 会话归档后仍出现在 DSH 会话列表（archived 语义：脱离工作区，不删除）
- 目前仅 Windows（taskkill 树杀、cmd /c 包装）；Linux/macOS 需替换进程管理部分

## License

[MIT](LICENSE)
