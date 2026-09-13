# quest_plan 模板与写法指南（AI 写任务线前先读本文件）

> 位置固定：`__HOME__\dsh-plugins\quest\PLAN-TEMPLATE.md`
> `quest_plan` 工具的 markdown 参数按本模板写。写作原则：**handoff 是 worker 总结质量的上限**——
> worker 只能看到 handoff + 日志尾部，看不到你们的研究语境，所以要在这里替它把语境补齐。

## 模板

```markdown
# 任务线：<一句话说清这批实验在验证什么>
workspace: <绝对路径>
# 任务线头部可写 shell: wsl —— 整条任务线默认进 WSL（节点级可单独覆盖为 windows），AI 无需逐节点决定
# 任务线头部可写 freeze_on: hard-fail-only —— 整条线"只有真失败才冻结下游"，疑似上游放行（详见下方冻结策略）

---node: <id-短横线小写>---
command: <完整命令，解释器用绝对路径，如 E:\python_env\pinn\Scripts\python.exe>
cwd: <工作目录>
expect_minutes: <预计分钟数；超时护栏=2倍，长训练务必写真实值>
success: <成功判据 —— **判定器会强制核对**，见下方「成功判据 success:」一节。写法：引号里的关键词、文件名/通配、指标阈值>
after: <上游节点 id，逗号分隔；链头节点不写此行>
manual: <true=上游完成后停下等人工确认；缺省=false 全自动>
auto_fix: <true=失败后触发自动修复会话：机械性问题（显存/参数/路径）自动改+.bak备份+重派>
fix_budget: <自动修复次数上限，默认 2；烧完停手 QQ 告警>
quiet: <true=不发 QQ；缺省=false>
max_log_mb: <stdout 日志封顶 MB，默认 256；超限截断（保留尾部新内容），防 verbose 训练吃满磁盘>
push_images: <成功后把 cwd 里新产出的 png/jpg 直推 QQ 的张数上限，默认 2；0=关。可视化节点建议保持默认>
shell: <windows 缺省；wsl = 该节点在 WSL(Ubuntu) 里跑
freeze_on: <any-fail（缺省）= 上游任何异常都冻结下游；hard-fail-only = 上游只是"疑似"时放行下游>
no_checkpoint: <true = 显式声明不需要断点（屏蔽「无存档提醒」）>
断点约定：quest 派发/重派时自动把 cwd 里最新的 .pt/.ckpt/.pth 路径放进环境变量 QUEST_RESUME_FROM——脚本开头按约定读它（有则加载续跑），存档写固定文件名。长任务（>=15 分钟）脚本里没有 torch.save/checkpoint 模式会被提醒。
——bash 语法、cwd 用 Linux 路径（如 /home/xxx/exp），命令不经 cmd.exe（无引号剥离问题），且负载由 WSL 虚拟机养着、quest/DSH 崩溃照常跑>
handoff: |
  <3~8 行交接上下文，给一个看不到你们对话的 worker 读。覆盖：>
  1. 这个脚本在整个研究里的角色（"生成 XX 消融实验的训练数据"）
  2. 这次具体在验证什么假设/对比什么条件
  3. 关键指标叫什么、健康范围（"val_loss 应低于 1e-3，早停应在 200 轮内"）
  4. 产物是什么、在哪（"输出 data/xxx.npz，约 200MB"）
  5. 已知的坑/异常特征（"OOM 会先打印 batch retry；NaN 通常在第 3 epoch 出现"）

---node: <下一段>---
after: <上一段 id>
...
```

## 五段科研流水的标准骨架（数据生成→训练→后处理→评估→可视化）

```markdown
# 任务线：<实验名：验证 X 方法在 Y 条件下的效果>
workspace: <实验目录>

---node: gen-data---
command: <python> gen_data.py <参数>
cwd: <目录>
expect_minutes: <n>
handoff: |
  <数据段：生成什么数据、规模、分布假设、已知坑>

---node: train---
command: <python> train.py <参数>
after: gen-data
expect_minutes: <真实时长，训练段最重要>
handoff: |
  <训练段：模型/损失/关键超参、看什么指标、健康范围、崩溃特征、checkpoint 断点文件名>

---node: postproc---
command: <python> postproc.py <参数>
after: train
handoff: |
  <后处理段：把什么转成什么、中间产物在哪>

---node: eval---
command: <python> eval.py <参数>
after: postproc
handoff: |
  <评估段：对比基线是谁、指标定义、结果文件格式>

---node: viz---
command: <python> viz.py <参数>
after: eval
manual: true        ← 出图前停一下等确认（想全自动就删这行）
handoff: |
  <可视化段：出什么图、每张图要说明什么>
```

## 成功判据 success:（2026-09-13 起会被强制核对）

以前这个字段只是写给 worker/人看的白话描述，判定器不读它；现在**判定器会把它解析成可机器校验的条件并硬核对**，
三项里任一项不满足 → 判 `suspect`（不是 failed：跑完了但没达标，交给人/AI 判），并写明缺什么。

| 写法 | 含义 | 例 |
|---|---|---|
| 引号里的短语（`"…"` / `'…'` / `` `…` ``） | 必须出现在日志尾（不区分大小写） | `日志尾含"训练完成"` |
| 文件名或通配（含空主干 `.pt`＝`*.pt`，支持 `data/xxx.npz`） | 必须在**本次运行窗口内**产出该文件 | `且产出 param_abh_spectra.npz` |
| 指标阈值 | 用日志里提取到的指标核对（`val_loss`/`train_loss` 映射到 `loss_last`） | `loss < 1e-3` |

规则与边界：

- **写得越具体越有价值**：三样都写 = 判定器三样都查。若写不出可核对的项（纯白话），则自动退回原来的通用判定（关键词表 / 退出码 / 产物新鲜度），行为与旧版一致。
- **提不到指标 → 记「未核实」而不是判失败**（宁可漏判不误杀：假阳会浪费一整晚算力）。`via` 里会显示 `success-declared（未核实:…）`。
- 声明了判据就**压过**通用关键词表：即使日志里出现了"完成"，只要声明项没满足就是 `suspect`。
- 与冻结策略的配合：`suspect` 默认冻结下游；若希望"疑似"放行，给节点/plan 头加 `freeze_on: hard-fail-only`（见上节）。

## 冻结策略 freeze_on（②c，2026-09-12）

上游失败默认冻结下游（`any-fail`）——保守，但整条链会因为一次"疑似"停摆。判定器的 `suspect`
只代表**没找到完成证据**（没打印完成关键词、没产出文件），不等于失败：可能是脚本没写日志，
也可能真的没跑完。既然有探针可以事后查证，这个判断就不该由脚本一刀切：

- `freeze_on: hard-fail-only`：只有**真失败**（crashed / startup-failed / timeout / cancelled /
  预检失败）才冻结下游；上游是 `suspect` 时**放行**下游，同时推一条 QQ：
  「上游 X 疑似但已放行，让 AI 用 quest_probe 查证；确认没跑完就 /q取消 下游」。
- 写哪都行，任一处声明即生效：**下游节点**（"别因为疑似上游冻我"）、**上游节点**（"我的疑似别
  拖累全链"）、或 **plan 头**（整条线兜底）。建议写 plan 头。
- 放行不等于失明：progress.md 会在下游那行标「⚠️上游疑似放行（X）」，账本记 `node.soft-pass`。

**AI 的中间裁决流程**（默认动作）：收到"疑似但放行"通知 →`quest_probe` 查上游日志尾/产物
mtime → 确认正常：什么都不做，让它继续跑；确认没跑完：`quest_cancel` 下游 + `quest_dispatch`
上游（断点存档会自动带上，等于续跑）。

## 写作红线
1. command 里的脚本必须**已存在且语法正确**（派发前有 py_compile 预检，语法错会被拦截并原文上报）
2. expect_minutes 别拍脑袋：写小了会被超时杀掉（护栏=2 倍），写大了失败暴露慢
3. after 链必须是 DAG（不能环）；断点存档的脚本失败后直接重派即续跑
4. handoff 里不要放 token/密钥/无关本机的信息（会进 worker 上下文）
