# quest 任务线工具包 v0.1.0（2026-09-08 P1-P3 沙盒验证通过）

## 组件
- `server.mjs` — quest 服务（账本/作业执行/预检/判定器/worker 子会话/QQ 推送），端口 3110，token 在 `~/.dsh/quests/.token`
- `dsh-plugin/` — DSH 薄插件（4 工具：quest_plan / quest_dispatch / quest_status / quest_log）
- `lib/dsh-client-v2.mjs` — 0.1.2 @Remote 协议客户端（从 qq-bridge 复用）
- `start-quest.bat` — 守护式启动（崩溃 5 秒自动重启）

## 当前状态（沙盒）
- 配置 `~/.dsh/quests/quest-config.json` 指向沙盒 DSH（3090 / sandbox-run9.log）
- **切生产**：`dshBaseUrl` → `http://127.0.0.1:3080`，`dshTokenLog` → `C:/Users/Solanine/.dsh/dsh-run.log`，重启服务；生产 profile 挂 dsh-quest 插件（package.json + bundles 加 link 项）+ `.agent-presets/quest-worker/` 拷到 `~/.dsh/.agent-presets/`
- python-manager 的 QQ 通知已配置层退役（quest 接管，回滚=把 cordis.patch.yml 的 enabled 改回 true）

## 已验证（2026-09-08 深夜，全部沙盒实测）
- 判定五分类：ok(finish-keyword) / crashed(nonzero-exit 70s) / preflight-failed(py_compile 拦截) / timeout(5s 击杀) / startup-failed(秒退)
- worker 全链路：派发→3s 任务→判定→worker 子会话总结（10 行内）→账本→归档调用
- QQ 推送：node.failed 时刻 bridge 回执"成功 1/1 条"
- dispatch 派发即返回（0.2s），不再阻塞

## 已知待跟进
1. worker 会话 archiveSession 返回成功但仍出现在 session/list——归档语义需确认（会话极小，暂无碍）
2. 手动启动的 python 进程（不经 quest_dispatch）不再被监控——需要时给 python-manager 留精简版退出检测
3. quest-worker 无工具白名单（persona 约束）——生产化时按 qq-tool-restrict 模式加固
4. worker 归档后 GUI 分组按 cwd 显示（0.1.2 无 workspace 标题）

## 2026-09-08 深夜二批（生产化收尾）
- **外部进程监控接入**：python-manager 检测到的手动启动任务（≥5 分钟）改走 quest `/api/external-exit` → 同一条 worker+QQ 管线（旧 notifyAgent/notifyQQ 退役保留可回滚；MIN_RUN_SECONDS 60→300）
- **WMI 过滤器修复**：排除 bash/sh/wsl/git（命令行含 .py 字样的 shell 会误入监控）
- **自启**：Startup 文件夹 quest-autostart.vbs（隐藏窗口跑 start-quest.bat 守护循环）
- **杀前抓栈**：watch-dsh.ps1 判死分支先跑 capture-dsh-stack.mjs（15s 自限时）再杀；start-dsh.ps1 已带 --inspect=9229
- **worker 白名单**：quest-worker 关闭 tool-web（search/fetch）
- **待真实使用验证**：widget 轮询驱动的自然退出链路（各环节已单独验证：检测逻辑未动 + external-exit 管线实测过 QQ 回执）

## 2026-09-08 三批：流水线（after 链）
- plan.md 节点新增 `after: <id>[, <id>]`（上游 completed 自动派发本节点）与 `manual: true`（上游完成后标 ready 等人，不自动）
- 上游 failed/timeout → 下游自动冻结（node.frozen，dispatch 返回 409 说明原因）
- 全部节点终态 → `line.concluded` 事件 + QQ 收尾铃（N 段：x ok / y failed + 断点列表）
- 五段科研流水（生成→训练→后处理→评估→可视化）现在一句话派整条链


## 2026-09-09 通宵：WA 化第一步——auto_fix 自动修复（沙盒三场景验证后上产）
- plan.md 节点新增 `auto_fix: true` + `fix_budget`（默认 2）：失败后触发修复会话
  （quest-fixer preset：写权限 + 修复纪律：只做机械性修复/改前 .bak/py_compile 验证/FIX_OK|FIX_GIVEUP 收尾）
- FIX_OK → 自动解冻下游 + 重派；FIX_GIVEUP / 预算烧尽 → 停手 + QQ 告警
- 沙盒实测：OOM→改 BATCH→.bak→重派→完成 ✅；逻辑错误→GIVEUP 不动文件 ✅；无解→1 次即停无死循环 ✅
- 夜间修掉的关键 bug：dispatched 事件曾清零 fixCount（会造成无限修复循环），改为仅 plan 重写时重置预算
- 生产 train-v7 已挂 auto_fix: true / fix_budget: 2——早上的重派若再遇 OOM 会自愈
- 沙盒实例支持：node server.mjs --home <dir> --port <n> --dsh <url> --dsh-log <file>（今晚用 3111/3090 测试）
