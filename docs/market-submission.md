# 上架材料 / Market submission

目标索引站：[awesome-dsh-plugin.com](https://awesome-dsh-plugin.com/)（社区插件目录，README 由 `data/plugins/*.yml` 生成）。

## 投稿内容（一个文件）

文件名：`data/plugins/yunlong-wang11111__dsh-quest--dsh-plugin.yml`
（monorepo 子包形式的命名规则：`<owner>__<repo>--<子包路径用横线连>`）

```yaml
url: https://github.com/yunlong-wang11111/dsh-quest/tree/main/dsh-plugin
name: yunlong-wang11111/dsh-quest#dsh-plugin
category: workflow
description:
  en: 'Research pipeline orchestration: plan, dispatch, judge, auto-fix and notify long-running experiments, with WSL/Windows execution lanes, an HTTP dashboard and MCP tools.'
  zh: '科研流水线编排：计划、派发、判定、自动修复、通知长任务；支持 WSL/Windows 双执行车道、HTTP 仪表盘与 MCP 工具面。'
```

> 描述里那句"含 MCP 工具面"要属实——`mcp-server.mjs` 确实暴露 8 个工具；"双执行车道"对应 plan 里的 `shell: wsl`。"持续维护"由仓库活跃度体现。

## 收录要求对照

| 要求 | 我们的状态 |
|---|---|
| `package.json` 声明 `dsh.bundle.patch`（**最常见的被拒原因**是只声明 `dsh.client`） | ✅ `dsh-plugin/package.json` 里 `dsh.bundle.patch: ./cordis.patch.yml` 已声明，且该文件存在 |
| 仓库含真实可用代码 | ✅ 29 个提交，服务 + 插件 + MCP + 守护脚本 |
| **仓库创建满 1 天**（CI 自动检查） | ⚠️ 仓库刚建，**需要等一天**再投 |
| 加 `dsh-plugin` topic | ⚠️ 待做（GitHub 仓库页 → About 齿轮 → Topics，需网页访问） |
| 描述属实、无营销词 | ✅ 见上，逐项可核对 |
| 分类贴合实际 | ✅ `workflow`（同类参照：`fuhefei/dsh-sentinel`） |

## 投稿步骤

1. **等仓库满 1 天**（CI 硬性检查，早投会被自动拒）
2. 给 `yunlong-wang11111/dsh-quest` 加 `dsh-plugin` topic（网页：仓库首页 → About 右侧齿轮 → Topics）
3. Fork `awesome-dsh-plugin/awesome-dsh-plugin`，把上面那个 YAML 文件加到 `data/plugins/`，提 PR（一个文件即可，README 由维护者脚本重新生成，**不要手工改 README**）
4. 描述含 `: ` 时必须给整行加引号（YAML 会把冒号读成嵌套键）——上面的 YAML 已加

## 已知限制（投稿前想清楚）

- **插件需要配套服务**：`dsh-plugin/` 只是客户端，工具调用 `http://127.0.0.1:3110`；服务没跑时工具会明确报"quest 服务不可达"。README 的快速上手有完整两步（起服务 + 装插件）。索引站只校验"能否用 `dsh plugin add` 安装"，这一点没问题，但用户装完只得到会报错的工具——**README 的第一屏必须把"先起服务"说清楚**。
- **npm 名字 `dsh-quest` 已被占用**（v0.0.1，他人预留）。若要发布到 npm（客户端市场需要），得用别的名字，例如 `@yunlong-wang11111/dsh-quest` 或 `dsh-quest-runner`；同时要改 `cordis.patch.yml` 里的 `name` 字段与 `dsh.bundle` 指向。索引站不要求 npm，先上索引站更划算。
