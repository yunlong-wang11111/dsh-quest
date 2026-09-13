#!/usr/bin/env node
// quest MCP 服务器（stdio）——把 quest 的 HTTP API 暴露成标准 MCP 工具，
// 让任何支持 MCP 的 agent（Claude Code / Codex / ZCode / Cursor / …）原生调用，
// 而不需要让模型自己拼 curl。
//
// 配置（环境变量，全部可选）：
//   QUEST_URL    quest 服务地址，默认 http://127.0.0.1:3110
//   QUEST_TOKEN  访问令牌；缺省从 <QUEST_HOME>/.token 读取
//   QUEST_HOME   quest 数据目录，默认 ~/.dsh/quests
//
// 说明：quest 本体不依赖任何 agent——它自己派进程、判定、重试、通知。
// 这个 MCP 层只负责"把工具递到模型手里"，因此对谁调用完全中立。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const QUEST_HOME = process.env.QUEST_HOME || path.join(os.homedir(), '.dsh', 'quests');
const BASE = (process.env.QUEST_URL || 'http://127.0.0.1:3110').replace(/\/+$/, '');

function token() {
  if (process.env.QUEST_TOKEN) return process.env.QUEST_TOKEN.trim();
  try { return fs.readFileSync(path.join(QUEST_HOME, '.token'), 'utf8').trim(); } catch { return ''; }
}

async function q(method, pathname, body, timeoutMs = 60000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch(`${BASE}${pathname}`, {
      method,
      headers: { 'x-quest-token': token(), 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await resp.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 2000) }; }
    if (!resp.ok) return { error: true, status: resp.status, ...json };
    return json;
  } catch (e) {
    return { error: true, message: `quest 服务不可达（${BASE}）：${String(e?.message || e)}` };
  } finally { clearTimeout(t); }
}

const ok = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }], isError: true });

const server = new McpServer({ name: 'quest', version: '0.5.0' });

server.tool(
  'quest_plan',
  '写入任务线 plan.md（多节点流水线：依赖链 after、条件分支 when、自动修复 auto_fix、盯梢 watch_rules、WSL 车道 shell、冻结策略 freeze_on）。整体替换当前工作区的计划。若新计划会丢掉旧计划里未完成（非 completed）的节点，服务端会返回 409 并列出是被丢的哪些节点——先确认这是你要的，再带 force:true 重提交；不要把 409 当故障盲目重试。',
  { markdown: z.string().describe('完整的 plan.md 内容'), ws: z.string().optional().describe('工作区绝对路径'), force: z.boolean().optional().describe('确认丢弃旧计划中未完成的节点（默认 false）') },
  async ({ markdown, ws, force }) => {
    const r = await q('POST', `/api/plan?ws=${encodeURIComponent(ws || '')}`, { markdown, ...(force === true ? { force: true } : {}) });
    return r.error ? fail(r) : ok(r);
  },
);

server.tool(
  'quest_dispatch',
  '派发/重派任务线里的某个节点（后台执行，不等待结束）。',
  { node: z.string().describe('节点 id'), ws: z.string().optional().describe('工作区绝对路径') },
  async ({ node, ws }) => {
    const r = await q('POST', `/api/dispatch?ws=${encodeURIComponent(ws || '')}`, { node });
    return r.error ? fail(r) : ok(r);
  },
);

server.tool(
  'quest_run',
  '快速单发：不写任务线，直接后台跑一个命令（含判定 + 总结 + 通知）。适合已定型的单个长任务。派发后不要再轮询，任务结束会通知。',
  {
    command: z.string().describe('完整命令（解释器用绝对路径）'),
    cwd: z.string().describe('工作目录'),
    title: z.string().optional().describe('任务短名'),
    reason: z.string().optional().describe('为什么跑这条命令（门禁挂起时作为审批理由）'),
    expect_minutes: z.number().optional().describe('预计时长（分钟）'),
    handoff: z.string().optional().describe('交接上下文：做什么、看什么指标、异常特征'),
    success: z.string().optional().describe('成功判据（白话即可）：引号关键词 / 文件名通配 / 指标阈值，会被判定器强制核对'),
    auto_fix: z.boolean().optional().describe('失败后是否自动修复'),
    shell: z.enum(['windows', 'wsl']).optional().describe('在 Windows 还是 WSL 里执行'),
    ws: z.string().optional().describe('工作区绝对路径（缺省用 cwd）'),
  },
  async (a) => {
    const r = await q('POST', `/api/run?ws=${encodeURIComponent(a.ws || a.cwd)}`, {
      command: a.command, cwd: a.cwd, title: a.title, reason: a.reason,
      expectMinutes: a.expect_minutes, handoff: a.handoff, success: a.success, autoFix: a.auto_fix, shell: a.shell,
    });
    return r.error ? fail(r) : ok(r);
  },
);

server.tool(
  'quest_status',
  '查任务线全景：各节点状态/判定/指标 + 自上次查看以来的完成事件（unread）。',
  { ws: z.string().optional().describe('工作区绝对路径（缺省=最近活跃工作区）') },
  async ({ ws }) => {
    const r = await q('GET', `/api/status?ws=${encodeURIComponent(ws || '')}`);
    return r.error ? fail(r) : ok(r);
  },
);

server.tool(
  'quest_log',
  '读某个节点正在跑或刚跑完的日志尾部（不执行任何命令）。',
  {
    node: z.string().describe('节点 id'),
    tail: z.number().optional().describe('读取字节数，默认 4096'),
    ws: z.string().optional().describe('工作区绝对路径'),
  },
  async ({ node, tail, ws }) => {
    const r = await q('GET', `/api/log?ws=${encodeURIComponent(ws || '')}&node=${encodeURIComponent(node)}&tail=${tail || 4096}`);
    return r.error ? fail(r) : ok(r);
  },
);

server.tool(
  'quest_probe',
  '诊断探针：同步跑一条 ≤30 秒的白名单命令并取回尾部输出（解释器跑工作区内脚本，或 -c 内联）。"现在就要看这个值"时用；超过 30 秒的任务用 quest_run。',
  {
    command: z.string().describe('诊断命令，如 python -c "print(x.shape)"'),
    cwd: z.string().describe('工作目录'),
    ws: z.string().optional().describe('工作区绝对路径'),
  },
  async ({ command, cwd, ws }) => {
    const r = await q('POST', `/api/probe?ws=${encodeURIComponent(ws || cwd)}`, { command, cwd }, 40000);
    return r.error ? fail(r) : ok(r);
  },
);

server.tool(
  'quest_files',
  '列目录/读文件（支持 Windows 绝对路径与 \\\\wsl$\\Ubuntu\\... UNC 路径，即 WSL 内部文件）。',
  {
    path: z.string().describe('绝对路径'),
    mode: z.enum(['list', 'read']).optional().describe('list 列目录（缺省）/ read 读内容'),
  },
  async ({ path: p, mode }) => {
    const r = await q('GET', `/api/files?mode=${encodeURIComponent(mode || 'list')}&path=${encodeURIComponent(p)}`, undefined, 30000);
    return r.error ? fail(r) : ok(r);
  },
);

server.tool(
  'quest_cancel',
  '人工终止一个正在运行的节点（杀整棵进程树；不触发自动修复）。',
  {
    node: z.string().describe('节点 id'),
    reason: z.string().optional().describe('终止原因（入账本+通知）'),
    ws: z.string().optional().describe('工作区绝对路径'),
  },
  async ({ node, reason, ws }) => {
    const r = await q('POST', `/api/cancel?ws=${encodeURIComponent(ws || '')}`, { node, reason: reason || '人工终止' });
    return r.error ? fail(r) : ok(r);
  },
);

await server.connect(new StdioServerTransport());
