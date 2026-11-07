#!/usr/bin/env node
// quest 生态安装向导（2026-11-07 v1.0 雏形）
// npx dsh-quest-service install → 起本地服务(3111)+开浏览器 → Abaqus 风格组件选择安装。
// 设计：GUI 只做"选择+执行+反馈"，每个组件的安装动作是纯命令序列（git/uv/npm），
// 逐行流式推送日志到页面（SSE）。手动型组件（QQ/SnowLuma）显示步骤卡不代劳。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';

const PORT = Number(process.env.QUEST_INSTALL_PORT || 3111);
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ECO_ROOT = path.join(os.homedir(), 'quest-eco');   // 姊妹件统一安装根目录

// ── 组件目录（GUI 渲染的数据源）────────────────────────────────────────────
const COMPONENTS = [
  {
    id: 'quest-core', name: 'quest 核心', required: true, lang: 'Node', size: '~170KB',
    desc: '任务执行治理层：plan 依赖链/判定回执/守护重试/画板。你正在跑的安装器就是它。',
    kind: 'register',  // 不重复安装，做客户端注册指引
  },
  {
    id: 'paper', name: '论文全文下载 paper-fetch-mcp', lang: 'Python', size: '~20MB',
    desc: 'Unpaywall OA 优先 + 订阅机构 IP 路由 + 出版社墙情报 + 全文 txt 提取。',
    repo: 'https://github.com/yunlong-wang11111/paper-fetch-mcp.git',
    deps: ['mcp', 'pymupdf'], kind: 'auto',
  },
  {
    id: 'cae', name: 'CAE 仿真辅助 cae-lanes', lang: 'Python', size: '~300MB',
    desc: '网格处理 / TikZ 学术流程图 / mermaid 渲染 / Abaqus-Comsol 接口 / 3D 结果查看。',
    repo: 'https://github.com/yunlong-wang11111/cae-lanes.git',
    deps: ['mcp', 'playwright', 'numpy', 'matplotlib'], kind: 'auto',
  },
  {
    id: 'libre', name: '文档转换 mcp-libre', lang: 'Python', size: '~50MB',
    desc: 'docx↔pdf 公式感知路由（Word COM 优先保真）。前置：LibreOffice 或 MS Word。',
    repo: 'https://github.com/yunlong-wang11111/mcp-libre.git',
    deps: ['mcp', 'pywin32'], kind: 'auto',
  },
  {
    id: 'qq', name: 'QQ 通知全家桶', lang: '混合', size: '-',
    desc: '群→工作区映射 / 审批推送 / 晨报。含人工步骤（QQ 小号扫码），装完见步骤卡。',
    kind: 'manual',
    steps: [
      '① SnowLuma（QQ 协议端）：github.com/SnowLuma/SnowLuma 的 Releases 下载解压，launcher.bat 启动',
      '② 桥：git clone https://github.com/yunlong-wang11111/qq-bridge-work && npm install',
      '③ quest 配置 notify.kind=bridge 指向桥（详见 quest README-MCP 通知通道节）',
    ],
  },
];

// ── 工具检测 ────────────────────────────────────────────────────────────
const has = (cmd) => { try { execSync(`${cmd} --version`, { stdio: 'ignore' }); return true; } catch { return false; } };

// ── 安装动作（每组件一个命令序列）────────────────────────────────────────
function planOf(comp) {
  const dir = path.join(ECO_ROOT, comp.id === 'paper' ? 'paper-fetch-mcp' : comp.id === 'cae' ? 'cae-lanes' : comp.id === 'libre' ? 'mcp-libre' : comp.id);
  const cmds = [];
  if (comp.kind === 'auto') {
    cmds.push({ title: `克隆 ${comp.name}`, cmd: 'git', args: ['clone', '--depth', '1', comp.repo, dir] });
    cmds.push({ title: '创建虚拟环境(uv)', cmd: 'uv', args: ['venv', path.join(dir, '.venv')] });
    const py = path.join(dir, '.venv', 'Scripts', 'python.exe');
    cmds.push({ title: '安装依赖（可能几分钟）', cmd: 'uv', args: ['pip', 'install', '--python', py, ...comp.deps] });
    cmds.push({ title: '完成', msg: `安装于 ${dir}。MCP 注册：command=${py}, args=[${path.join(dir, 'server.py 或 src/main.py')}]（具体入口见其仓库 README）` });
  }
  return { dir, cmds };
}

// ── HTTP + SSE ──────────────────────────────────────────────────────────
const indexHtml = () => fs.readFileSync(path.join(HERE, 'index.html'), 'utf8');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(indexHtml());
  }
  if (req.method === 'GET' && url.pathname === '/api/components') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ components: COMPONENTS, tools: { git: has('git'), uv: has('uv'), node: true } }));
  }
  if (req.method === 'POST' && url.pathname === '/api/install') {
    const body = await new Promise((r) => { let d = ''; req.on('data', (c) => d += c); req.on('end', () => r(JSON.parse(d || '{}'))); });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    send({ t: 'log', line: `安装根目录：${ECO_ROOT}` });
    for (const id of body.selected || []) {
      const comp = COMPONENTS.find((c) => c.id === id);
      if (!comp) continue;
      send({ t: 'comp-start', id, name: comp.name });
      if (comp.kind === 'manual') {
        for (const s of comp.steps || []) send({ t: 'log', line: s });
        send({ t: 'comp-done', id, note: '人工步骤——按上面指引完成' });
        continue;
      }
      if (comp.kind === 'register') {
        const home = os.homedir();
        const tips = [];
        if (fs.existsSync(path.join(home, '.claude.json'))) tips.push('检测到 Claude Code：终端跑 → claude mcp add quest -- npx -y dsh-quest-service');
        if (fs.existsSync(path.join(home, '.cursor'))) tips.push('检测到 Cursor：Settings→MCP→Add → {"command":"npx","args":["-y","dsh-quest-service"]}');
        tips.push('通用：任何 MCP 客户端的 mcpServers 里加 "quest": {"command":"npx","args":["-y","dsh-quest-service"]}');
        for (const s of tips) send({ t: 'log', line: s });
        send({ t: 'comp-done', id, note: '按上面指引完成客户端注册' });
        continue;
      }
      // 2026-11-07 网络韧性：直连→镜像三路 fallback，失败清半成品再试下一路
      let failed = false;
      for (let attempt = 0; attempt < MIRRORS.length; attempt++) {
        if (attempt > 0) send({ t: 'log', line: `↻ 网络不通，切换镜像重试（第${attempt}路）` });
        const plan = planOf(comp, attempt);
        let stepFailed = false;
        for (const step of plan.cmds) {
          if (step.msg) { send({ t: 'log', line: `✔ ${step.msg}` }); continue; }
          send({ t: 'step', title: step.title });
          const okRun = await new Promise((resolve) => {
            const p = spawn(step.cmd, step.args, { windowsHide: true });
            p.stdout.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach((l) => send({ t: 'log', line: '  ' + l.slice(0, 200) })));
            p.stderr.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach((l) => send({ t: 'log', line: '  ' + l.slice(0, 200) })));
            p.on('close', (code) => resolve(code === 0));
        });
        if (!okRun) { stepFailed = true; send({ t: 'log', line: `✘ 步骤失败：${step.title}（看上方日志定位）` }); break; }
      }
        if (!stepFailed) { failed = false; break; }
        failed = true;
        try { fs.rmSync(plan.dir, { recursive: true, force: true }); } catch {}
      }
      if (failed) send({ t: 'log', line: '⚠ 三路都失败——多为网络封锁 GitHub。建议：开代理/VPN 后重试，或稍后再来。' });
      send({ t: 'comp-done', id, ok: !failed });
    }
    send({ t: 'all-done' });
    return res.end();
  }
  res.writeHead(404); res.end();
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`quest 生态安装向导：${url}（Ctrl+C 退出）`);
  // 自动开浏览器（Windows）
  try { spawn('cmd', ['/c', 'start', url], { detached: true, stdio: 'ignore' }).unref(); } catch {}
});
