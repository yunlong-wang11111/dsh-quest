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

const server = new McpServer({ name: 'quest', version: '0.6.1' });

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
  'quest_notify',
  [
    '点名用户（QQ）：由你决定何时打扰人——只在需要人拍板/确认/汇报重要结果时用。',
    '收尾汇报自动通知；中途节点成败用户已静音（nodeEvents:false）。60 秒冷却。',
  ].join(' '),
  {
    message: z.string().describe('给用户的话（≤800 字）：要什么决策/确认什么/结果一句话'),
    ws: z.string().optional().describe('工作区绝对路径（缺省=当前会话 cwd）'),
  },
  async (a) => {
    const r = await q('POST', `/api/notify?ws=${encodeURIComponent(a.ws || a.cwd || '')}`, { message: a.message });
    return r.error ? fail(r) : ok(r);
  },
);

server.tool(
  'quest_lit',
  [
    '文献检索：一次调用拿 10-25 篇的 标题/作者/年份/venue/摘要（≤700字/篇）——替代 web_search+web_fetch 手爬（一个调研子代理曾爬 376 次，¥1.4）。',
    '三源：arxiv（预印本）；crossref（SCI 主力：Elsevier/Springer/Wiley/IEEE/MDPI 等 DOI 元数据）；openalex（全覆盖，带被引数）。',
    '找创新点打法：同一检索词 2-3 源各搜一次 → 圈定候选 → 只对最关键 1-2 篇再 fetch 全文。只读外部 API，不入账本。',
  ].join(' '),
  {
    query: z.string().describe('检索词（英文效果最好）'),
    source: z.enum(['arxiv', 'crossref', 'openalex']).optional().describe('缺省 arxiv'),
    limit: z.number().optional().describe('1-25，缺省 10'),
  },
  async (a) => {
    const r = await q('GET', `/api/lit?q=${encodeURIComponent(a.query)}&source=${a.source || 'arxiv'}&limit=${a.limit || 10}`);
    return r.error ? fail(r) : ok(r);
  },
);

server.tool(
  'quest_status',
  [
    '查任务线全景。默认 brief（推荐）：只回 当前状态/计数/在跑节点/异常节点/最近完成 —— 几百字符。',
    '要看全部节点明细时才传 verbose:true（大工作区会到几十万字符，慎重）。',
  ].join(' '),
  {
    ws: z.string().optional().describe('工作区绝对路径（缺省=最近活跃工作区）'),
    verbose: z.boolean().optional().describe('true=返回全部节点明细（很大）；缺省=false 只回摘要'),
  },
  async ({ ws, verbose }) => {
    const r = await q('GET', `/api/status?ws=${encodeURIComponent(ws || '')}`);
    if (r.error) return fail(r);
    if (verbose) return ok(r);
    // brief：省 token 的默认视图（2026-09-15 实测全量 28.9 万字符 → 摘要几百字符）
    const nodes = r.plan?.nodes || [];
    const c = {};
    for (const n of nodes) c[n.status] = (c[n.status] || 0) + 1;
    const line = r.line || {};
    const running = nodes.filter((n) => n.status === 'running')
      .map((n) => ({ id: n.id, shell: n.shell, startedAt: n.startedAt, success: n.success || '' }));
    const bad = nodes.filter((n) => ['failed', 'timeout'].includes(n.status)).slice(0, 8)
      .map((n) => ({ id: n.id, verdict: n.verdict, via: n.via, detail: String(n.judgeDetail || n.detail || '').slice(0, 120) }));
    const planNodes = nodes.filter((n) => n.inPlan)
      .map((n) => ({ id: n.id, status: n.status, verdict: n.verdict || null }));
    return ok({
      workspace: r.plan?.workspace || ws || '', title: r.plan?.title || '',
      line: { active: line.active, counts: line.counts, idleMinutes: line.idleMinutes, quiet: line.quiet, dsh: line.dsh },
      running, bad,
      plan: { nodes: planNodes, closedAt: r.plan?.closedAt || null },
      unread: (r.unread || []).slice(0, 10),
      totals: { nodes: nodes.length, ...(c || {}) },
      hint: '这是摘要视图；要全部节点明细用 verbose:true，要某个节点日志用 quest_log',
    });
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
  '诊断探针：同步跑一条白名单命令并取回尾部输出（解释器跑工作区内脚本，或 -c 内联）。"现在就要看这个值"时用。'
    + '车道按命令首词自动判（Linux 绝对路径如 /home/…/bin/python → WSL；盘符 → Windows），不用说明。'
    + '硬上限 30 秒（WSL 车道 25 秒，留中继余量），到点杀整个进程组并返回超时前输出（会标 ⏱）。超时的任务不是探针的事，用 quest_run。',
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

server.tool(
  'quest_flip',
  [
    '翻页：归档本工作区全部会话并开新会话（大上下文对话该翻篇时用，省 token 且恢复有保障）。',
    '标准流程：①你先自己把工作区的 research-state.md 按 9 节模板重写好（目标/已定决策/进度/产物清单/坑/在跑/待办/用户口径/下一步）',
    '②再以 handoff:false 调用本工具（交接已写好，不用再提示别的会话写）。',
    '注意：只在用户明确要求翻页时调用；它会归档包括你自己在内的全部会话（归档≠删除，archive/flip-*.md 有全文）。若不先写交接就调用，服务端会尝试让最活跃的老会话写（约多等 1~2 分钟）。',
  ].join(' '),
  {
    ws: z.string().describe('工作区绝对路径（一般=你的 cwd）'),
    handoff: z.boolean().optional().describe('false=交接已由你写好，跳过提示老会话（推荐流程）；缺省 true'),
  },
  async ({ ws, handoff }) => {
    const r = await q('POST', `/api/flip?ws=${encodeURIComponent(ws || '')}`, { handoff: handoff !== false }, 240000);
    if (r.error) return fail(r);
    return ok({
      ok: r.ok, archived: (r.archived || []).length, matched: r.matched,
      created: r.created, handoff: r.handoff || null, errors: r.errors || [],
      note: '新会话已注入恢复提示（读交接→quest_status→向用户复述确认）。归档不删除：全文在 archive/flip-*.md。',
    });
  },
);

await server.connect(new StdioServerTransport());
