# quest_plan 模板与写法指南（AI 写任务线前先读本文件）

> 位置固定：`C:<quest-dir>\PLAN-TEMPLATE.md`
> `quest_plan` 工具的 markdown 参数按本模板写。写作原则：**handoff 是 worker 总结质量的上限**——
> worker 只能看到 handoff + 日志尾部，看不到你们的研究语境，所以要在这里替它把语境补齐。

## 模板

```markdown
# 任务线：<一句话说清这批实验在验证什么>
workspace: <绝对路径>

---node: <id-短横线小写>---
command: <完整命令，解释器用绝对路径，如 E:\python_env\pinn\Scripts\python.exe>
cwd: <工作目录>
expect_minutes: <预计分钟数；超时护栏=2倍，长训练务必写真实值>
success: <成功判据的白话描述，如 "日志尾含'训练完成'且 5 分钟内有 .pt 产出">
after: <上游节点 id，逗号分隔；链头节点不写此行>
manual: <true=上游完成后停下等人工确认；缺省=false 全自动>
auto_fix: <true=失败后触发自动修复会话：机械性问题（显存/参数/路径）自动改+.bak备份+重派>
fix_budget: <自动修复次数上限，默认 2；烧完停手 QQ 告警>
quiet: <true=不发 QQ；缺省=false>
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

## 写作红线
1. command 里的脚本必须**已存在且语法正确**（派发前有 py_compile 预检，语法错会被拦截并原文上报）
2. expect_minutes 别拍脑袋：写小了会被超时杀掉（护栏=2 倍），写大了失败暴露慢
3. after 链必须是 DAG（不能环）；断点存档的脚本失败后直接重派即续跑
4. handoff 里不要放 token/密钥/无关本机的信息（会进 worker 上下文）
