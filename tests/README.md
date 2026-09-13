# tests —— 回归防线

这些测试是**改代码时唯一能告诉你"没把老功能改坏"的东西**。此前它们散在临时目录里，改完代码就没人跑；
2026-09-13 固化进仓库。

## 跑法

```bash
node tests/run-all.mjs          # 全部（约 2 分钟）
node tests/run-all.mjs judge    # 只跑名字里含 judge 的
```

退出码：`0` 全过 / `1` 有失败 / `2` 全部跳过（或只有跳过）。

## 隔离保证（铁律）

- 每个测试起**自己的 quest 实例**：独立 `--home`、独立端口、`notify.kind=off`（或指向本地假 webhook）、`workerBackend/fixerBackend=off`。
- **绝不触碰机器上正在跑的生产服务（3110）与其真实任务数据**；临时目录全部落在 `os.tmpdir()`。
- 结束时按自己 spawn 的 PID 收尾（`taskkill /T`），不做任何按名字通配的进程清理。

## 覆盖清单

| 文件 | 覆盖什么 |
|---|---|
| `success-claims.mjs` | `success:` 判据的解析与校验（纯函数，含"glob 不许跨扩展名误匹配"的回归） |
| `judge-claims.mjs` | 端到端：声明判据后判定器是否真按它判（缺产物/缺关键词/指标不达标 → suspect；纯白话 → 走通用路径） |
| `freeze-policy.mjs` | plan 覆盖保护（409 + force + 已完成不拦 + 账本留痕）；`freeze_on: hard-fail-only` 三种声明位置；真崩溃仍冻结 |
| `preflight-sync.mjs` | 预检失败必须**同步**回原因（不能伪装成"已派发"）：车道不匹配、WSL 配 Windows cwd、语法错、dispatch 路径 |
| `two-strike.mjs` | DSH 看门狗的"两振判死"（同轮内复探吸收抖动；一直活走快路径）。被测脚本在仓库外，找不到则 SKIP（可用 `QUEST_WATCHDOG_PATH` 指定） |
| `quiet-signal.mjs` | 收敛信号：只用 quest_run 的工作区也能收到、可重复、不刷屏 |
| `dsh-session-activity.mjs` | 会话活跃度：会话在跑时不判收敛；别的 cwd 的会话不误拦；探测失败安全降级（用假 DSH） |
| `ws-activity.mjs` | 工作区活跃度：账本安静≠没人干活；有人改代码时不判收敛 |
| `notify-content.mjs` | 通知内容真的送达且可读（soft-pass 提示含节点/探针指令/取消指令） |

## 加新测试

1. 复制任一文件的结构：`import { startSandbox, suite, waitFor } from './lib.mjs'`。
2. 用 `suite('<名字>')` 收集断言，最后 `s.done()`。
3. **端口要挑没被占用的**（现有：3122–3127、3199）。
4. 别引入本机专有路径（如某个 python 的绝对路径）——需要就允许缺省跳过（见 `preflight-sync.mjs` 里 python 的处理）。

## 两个已知的环境依赖

- `preflight-sync.mjs` 的"语法错预检"需要本机有 `python`/`python3`（或用 `QUEST_TEST_PYTHON` 指定），没有会跳过单条。
- `two-strike.mjs` 需要 Windows + PowerShell + 那台机器上的看门狗脚本；在别的机器上会 SKIP。
