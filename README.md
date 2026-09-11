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

## QQ 命令（搭配 qq-bridge 类通知端）

```
/q帮助          — 命令速查
/q状态          — 任务线全景（最近活跃工作区，零 token，DSH 挂了也能用）
/q派发 <节点>   — 派发/重派
/q停 <节点> [原因] — 人工终止（cancelled 终态，不触发自动修复）
/q翻页 [工作区] — 归档卡死会话并开新会话（前台失联时的逃生通道）
/q确认 <id>     — 放行 quest_run 门禁挂起的命令
/q拒绝 <id>     — 作废挂起的命令（从未执行）
```

## License

[MIT](LICENSE)
