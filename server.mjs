#!/usr/bin/env node
// quest 服务 —— 任务线编排核心（P1：账本+作业执行+预检+判定器；P2：worker 子会话；P3：QQ 推送）
//
// 设计文档：__HOME__\dsh-plugins\QUEST_DESIGN.md
// 数据目录：~/.dsh/quests/<wsKey>/（plan.md + ledger.jsonl + logs/ + state.json）
// 端口：默认 3110，仅绑定 127.0.0.1；token 首启生成于 ~/.dsh/quests/.token
//
// 2026-09-08 P1-P3 实现。协议/会话能力复用今晚移植的 dsh-client-v2（0.1.2 @Remote 网关）。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';

const QUEST_HOME = path.join(os.homedir(), '.dsh', 'quests');

// ── 命令行/环境覆盖（沙盒实例隔离用）：--home --port --dsh --dsh-log --------
const argOf = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const HOMEOverride = argOf('--home', process.env.QUEST_HOME || QUEST_HOME);
const CONFIG_PATH = path.join(HOMEOverride, 'quest-config.json');
const TOKEN_PATH = path.join(HOMEOverride, '.token');

// ── 配置 ────────────────────────────────────────────────────────────────
fs.mkdirSync(HOMEOverride, { recursive: true });
if (!fs.existsSync(CONFIG_PATH)) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({
    port: 3110,
    // worker 会话目标：生产=http://127.0.0.1:3080（token 从 dsh-run.log 解析）
    // 沙盒=http://127.0.0.1:3090 + tokenLog 指向沙盒日志
    dshBaseUrl: 'http://127.0.0.1:3090',
    dshTokenLog: '__HOME__/.dsh-test/sandbox-run3.log',
    dshToken: '',
    workerPreset: 'quest-worker',
    fixerPreset: 'quest-fixer',
    qqNotify: {
      enabled: false,
      bridgeUrl: 'http://127.0.0.1:3100',
      tokenFile: '__HOME__/qq-bridge/state/console-token',
      userId: 0,
    },
  }, null, 2));
}
const CFG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
CFG.port = Number(argOf('--port', CFG.port));
CFG.dshBaseUrl = argOf('--dsh', CFG.dshBaseUrl);
CFG.dshTokenLog = argOf('--dsh-log', CFG.dshTokenLog);
if (!fs.existsSync(TOKEN_PATH)) fs.writeFileSync(TOKEN_PATH, crypto.randomBytes(24).toString('base64url'));
const QUEST_TOKEN = fs.readFileSync(TOKEN_PATH, 'utf8').trim();

const log = (...a) => console.log(`[quest ${new Date().toISOString().slice(11, 19)}]`, ...a);

// 2026-09-10 护栏：async executor 里的未捕获异常不会 reject Promise 而是变成 unhandledRejection，
// Node 默认直接杀进程——一次派发 bug 不该带走整个服务（今天就这样静默死了两小时）。
process.on('unhandledRejection', (e) => { log('unhandledRejection（已拦截，服务继续）:', String(e?.stack || e).slice(0, 300)); });
process.on('uncaughtException', (e) => { log('uncaughtException（已拦截，服务继续）:', String(e?.stack || e).slice(0, 300)); });


// ── 账本 ────────────────────────────────────────────────────────────────
const wsKeyOf = (ws) => String(ws || '').replace(/\\/g, '/').replace(/\/+$/, '').replace(/[:/]/g, (c) => (c === ':' ? '' : '-'));

function dirOf(wsKey) {
  const d = path.join(HOMEOverride, wsKey);
  fs.mkdirSync(path.join(d, 'logs'), { recursive: true });
  return d;
}

/** plan.md 解析：`---node: <id>---` 分节，字段 key: value，handoff: | 为多行块。 */
function parsePlan(markdown) {
  const errors = [];
  const meta = {};
  const nodes = [];
  const lines = String(markdown || '').split(/\r?\n/);
  let cur = null;
  let handoffMode = false;
  for (const line of lines) {
    const m = line.match(/^---node:\s*(\S+)---\s*$/);
    if (m) {
      if (cur) nodes.push(cur);
      cur = { id: m[1], command: '', cwd: '', expectMinutes: 30, timeoutSeconds: 0, success: '', quiet: false, needsExecution: false, handoff: '', after: [], manual: false, autoFix: false, fixBudget: 2, when: '', watchLog: '', watchIntervalMinutes: 10, watchRules: [], maxLogMB: 0, pushImages: 2, shell: '' };
      handoffMode = false;
      continue;
    }
    if (!cur) {
      const kv = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
      if (kv && ['workspace', 'title', 'shell'].includes(kv[1])) meta[kv[1]] = kv[2].trim();
      // 没写 title: 时，取第一个 Markdown 一级标题当标题（模板惯例是 "# 任务线：<名字>"）
      const h = line.match(/^#\s+(.+)$/);
      if (h && !meta.heading) meta.heading = h[1].replace(/^\s*任务线[：:]\s*/, '').trim().slice(0, 40);
      continue;
    }
    if (handoffMode) {
      if (/^[a-zA-Z_]+:\s/.test(line)) handoffMode = false;
      else { cur.handoff += line + '\n'; continue; }
    }
    const kv = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (!kv) continue;
    const [, k, v] = kv;
    switch (k) {
      case 'command': cur.command = v.trim(); break;
      case 'cwd': cur.cwd = v.trim(); break;
      case 'expect_minutes': cur.expectMinutes = Number(v) || 30; break;
      case 'timeout_seconds': cur.timeoutSeconds = Number(v) || 0; break;
      case 'success': cur.success = v.trim(); break;
      case 'quiet': cur.quiet = v.trim() === 'true'; break;
      case 'needs_execution': cur.needsExecution = v.trim() === 'true'; break;
      case 'after': cur.after = v.split(',').map((x) => x.trim()).filter(Boolean); break;
      case 'manual': cur.manual = v.trim() === 'true'; break;
      case 'auto_fix': cur.autoFix = v.trim() === 'true'; break;
      case 'fix_budget': cur.fixBudget = Number(v) || 2; break;
      case 'max_log_mb': cur.maxLogMB = Number(v) || 0; break; // 0 = 默认 256MB
      case 'push_images': cur.pushImages = Number(v) || 0; break; // 成功后直推 QQ 的图片数上限，0 = 关
      case 'shell': cur.shell = v.trim().toLowerCase() === 'wsl' ? 'wsl' : 'windows'; break; // wsl = 在 WSL(Ubuntu) 里跑（bash 语法，Linux 路径）
      case 'when': cur.when = v.trim(); break;
      case 'watch_log': cur.watchLog = v.trim(); break;
      case 'watch_interval_minutes': cur.watchIntervalMinutes = Number(v) || 10; break;
      case 'watch_rules':
        // 每行一条：if=正则 ; confirm=N ; action=notify|kill（分号分隔，if 必填）
        for (const rl of v.split(/;(?=\s*if=)/)) {
          const t = rl.trim();
          if (!t) continue;
          const ifM = t.match(/if=([^;]+)/);
          const confM = t.match(/confirm=(\d+)/);
          const actM = t.match(/action=(notify|kill)/);
          if (ifM) cur.watchRules.push({ if: ifM[1].trim(), confirm: Number(confM?.[1]) || 2, action: actM?.[1] || 'notify', hits: 0 });
        }
        break;
      case 'handoff':
        if (v.trim() === '|' || v.trim() === '') handoffMode = true;
        else cur.handoff = v.trim() + '\n';
        break;
    }
  }
  if (cur) nodes.push(cur);
  meta.title = meta.title || meta.heading || '';
  // shell 解析优先级：节点级 > plan 级（meta）> windows。plan 头写一次 shell: wsl = 整条任务线默认进 WSL。
  for (const n of nodes) n.shell = n.shell === 'wsl' ? 'wsl' : (meta.shell === 'wsl' ? 'wsl' : 'windows');
  for (const n of nodes) {
    if (!n.command) errors.push(`节点 ${n.id} 缺 command`);
    if (!n.cwd) n.cwd = meta.workspace || '';
  }
  return { meta, nodes, errors };
}

/** 状态推导：从 ledger 事件流重建各节点当前状态。 */
function buildState(wsKey) {
  const dir = dirOf(wsKey);
  const state = { nodes: {}, updated: new Date().toISOString() };
  try { state.plan = fs.readFileSync(path.join(dir, 'plan.md'), 'utf8'); } catch { state.plan = null; }
  try {
    const lines = fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean);
    state.lineEvents = [];
    for (const l of lines) {
      let e; try { e = JSON.parse(l); } catch { continue; }
      if (!e.node) {
        state.lineEvents.push(e);
        if (e.t === 'plan.created' || e.t === 'plan.reloaded') {
          for (const n2 of Object.values(state.nodes)) n2.fixCount = 0; // 新 plan = 新预算
        }
        continue;
      }
      const n = state.nodes[e.node] ?? (state.nodes[e.node] = { status: 'pending', events: [] });
      n.events.push(e.t);
      if (e.t === 'node.dispatched') { n.status = 'running'; n.jobId = e.jobId; n.pid = e.pid; n.logTs = e.logTs; n.startedAt = e.at; n.verdict = undefined; n.via = undefined; n.detail = undefined; n.summary = undefined; }
      if (e.t === 'fix.attempt') { n.fixCount = (n.fixCount ?? 0) + 1; n.fixing = true; }
      if (e.t === 'fix.reported') { n.lastFix = e.changes; n.fixing = false; }
      if (e.t === 'fix.stopped') { n.fixing = false; n.fixStopped = e.reason; }
      if (e.t === 'node.preflight-failed') { n.status = 'failed'; n.verdict = 'preflight-failed'; n.detail = e.error; }
      if (e.t === 'node.exited') { n.exitCode = e.code; n.runSeconds = e.runSec; }
      if (e.t === 'node.judged') { n.verdict = e.verdict; n.via = e.via; n.file = e.file || null; }
      if (e.t === 'worker.reported') { n.summary = e.summary; }
      if (e.t === 'node.completed') { n.status = 'completed'; n.completedAt = e.at; }
      if (e.t === 'node.failed') n.status = 'failed';
      if (e.t === 'node.timeout') { n.status = 'timeout'; n.verdict = 'timeout'; n.via = e.via || '超时被杀'; }
      if (e.t === 'node.frozen') { n.status = 'frozen'; n.detail = e.reason; }
      if (e.t === 'node.ready') { n.status = 'ready'; }
      if (e.t === 'node.unfrozen') { n.status = 'pending'; n.verdict = undefined; n.via = undefined; n.detail = undefined; }
      if (e.t === 'node.cancelled') { n.status = 'cancelled'; n.verdict = 'cancelled'; n.detail = e.reason; }
      if (e.t === 'node.skipped') { n.status = 'skipped'; n.detail = e.reason; }
      if (e.t === 'node.metrics') { n.metrics = e.metrics; }
      if (e.t === 'watch.warn') { n.watchWarns = (n.watchWarns ?? 0) + 1; }
      if (e.t === 'watch.kill') { n.watchKilled = e.rule; }
    }
  } catch {}
  return state;
}

function appendEvent(wsKey, e) {
  const dir = dirOf(wsKey);
  lastActiveWs = wsKey; // P3：任何活动都刷新"最近工作区"
  e.at = new Date().toISOString();
  fs.appendFileSync(path.join(dir, 'ledger.jsonl'), JSON.stringify(e) + '\n');
  events.push({ ...e });
  wakeEventWaiters();
  if (!['plan.created', 'plan.reloaded'].includes(e.t)) {
    const s = buildState(wsKey).nodes[e.node];
    log(e.t, e.node ?? '', s ? `→ ${s.status}` : '');
  }
}

const events = []; // 内存事件环形（供 /api/events 拉取）
let lastActiveWs = ''; // P3：QQ 命令免带 ws 参数用的"最近活跃工作区"
const eventWaiters = [];
const wakeEventWaiters = () => { for (const w of eventWaiters.splice(0)) w(); };

// ── 未读收件箱（主会话 quest_status 时消费）────────────────────────────
const inbox = [];
const pushInbox = (msg) => { inbox.push({ ts: Date.now(), ...msg }); if (inbox.length > 50) inbox.shift(); };

/** 尾部读取：日志可能被允许涨到几百 MB，绝不能整读进内存。
 *  cmd.exe 中文输出默认 GBK（chcp 936）：先按 UTF-8 解，出乱码替换符就换 GBK 重解——
 *  否则"训练完成"这类中文关键词判定在 Windows 上永远失灵。 */
function readTail(file, bytes = 4096) {
  try {
    const size = fs.statSync(file).size;
    const fh = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(bytes, size));
    fs.readSync(fh, buf, 0, buf.length, Math.max(0, size - buf.length));
    fs.closeSync(fh);
    let text = buf.toString('utf8');
    if (text.includes('\uFFFD')) {
      try {
        const gbk = new TextDecoder('gbk').decode(buf);
        if (!gbk.includes('\uFFFD')) text = gbk;
      } catch {} // 无 ICU 的精简版 node 退回 UTF-8 乱码（数字指标仍可提取）
    }
    return text;
  } catch { return ''; }
}

// ── 判定器（移植 python-manager checkTaskOutput，0 token）──────────────
const FINISH_KEYWORDS = ['训练完成', '训练结束', '训练成功', '训练完毕', '训练已完成',
  'training complete', 'training finished', 'training done', 'finished', 'completed',
  'success', 'successful', 'model saved', 'save model', 'saved model', 'saved successfully', 'all done', '100%', 'done!'];
const TEXT_EXTS = ['.log', '.txt', '.out', '.md', '.json', '.csv'];
const ARTIFACT_EXTS = ['.pt', '.npz', '.pth', '.ckpt', '.png', '.jpg', '.h5', '.npy', '.bin'];

function judge(node, exitCode, runSec, logFile) {
  // 超时由外层标记，这里只判退出路径
  if (exitCode !== 0) {
    if (runSec < 60) return { verdict: 'startup-failed', via: 'fast-exit' };
    return { verdict: 'crashed', via: 'nonzero-exit' };
  }
  // 查输出证据：cwd 常见目录 + 任务运行窗口内的文件
  const tail = readTail(logFile, 4096).toLowerCase();
  if (FINISH_KEYWORDS.some((k) => tail.includes(k.toLowerCase()))) return { verdict: 'ok', via: 'finish-keyword' };
  const dirs = node.shell === 'wsl'
    ? [node.cwd, `${node.cwd}/out`, `${node.cwd}/logs`, `${node.cwd}/output`, `${node.cwd}/results`, `${node.cwd}/runs`].filter(Boolean).map(wslUnc)
    : [node.cwd, path.join(node.cwd, 'out'), path.join(node.cwd, 'logs'), path.join(node.cwd, 'output'), path.join(node.cwd, 'results'), path.join(node.cwd, 'runs')];
  let latest = null;
  for (const d of dirs) {
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const en of entries) {
      if (!en.isFile()) continue;
      const lower = en.name.toLowerCase();
      if (![...TEXT_EXTS, ...ARTIFACT_EXTS].some((x) => lower.endsWith(x))) continue;
      try {
        const st = fs.statSync(path.join(d, en.name));
        if (!latest || st.mtimeMs > latest.mtimeMs) latest = { mtimeMs: st.mtimeMs, file: path.join(d, en.name) };
      } catch {}
    }
  }
  // 快任务 runSec 舍入到 0 时 startMs=now 会和自己的产物自竞争；+2s 容文件系统时间戳粒度
  const startMs = Date.now() - Math.max(runSec, 1) * 1000 - 2000;
  if (latest && latest.mtimeMs > Date.now() - 10 * 60 * 1000 && latest.mtimeMs > startMs) {
    return { verdict: ARTIFACT_EXTS.some((x) => latest.file.toLowerCase().endsWith(x)) ? 'ok' : 'ok', via: 'artifact-fresh', file: latest.file };
  }
  if (latest && latest.mtimeMs > startMs) return { verdict: 'suspect', via: 'no-keyword', file: latest.file };
  return { verdict: 'suspect', via: 'no-output' };
}

// ── 预检（语法错误拦截在运行前）────────────────────────────────────────
function preflight(node) {
  const cmd = node.command;
  const pyFile = cmd.match(/\b([\w./\\:-]+\.py)\b/);
  if (!pyFile) return null; // 非 python 命令不预检
  const exe = cmd.trim().split(/\s+/)[0].replace(/^"|"$/g, '');
  const script = pyFile[1];
  if (node.shell === 'wsl') {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 15000);
      execFile('wsl.exe', ['-d', WSL_DISTRO(), '--exec', 'bash', '-c', `cd ${shq(node.cwd || `/home/${WSL_USER()}`)} && python3 -m py_compile ${shq(script)}`], { windowsHide: true, timeout: 12000 }, (err, _so, se) => {
        clearTimeout(t);
        if (err) resolve({ error: String(se || err.message || 'py_compile 失败').slice(0, 600) });
        else resolve(null);
      });
    });
  }
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 15000); // 预检自身卡住则放行（判定器兜底）
    execFile(exe, ['-m', 'py_compile', script], { cwd: node.cwd, windowsHide: true, timeout: 12000 }, (err, _so, se) => {
      clearTimeout(t);
      if (err) resolve({ error: String(se || err.message || 'py_compile 失败').slice(0, 600) });
      else resolve(null);
    });
  });
}

// ── P4：运行实例（进程树）────────────────────────────────────────────────
// 每条流水线派发时创建 runs/<runId>.json；节点状态变化时同步更新。
// 与 ledger 的分工：ledger 是追加式历史（审计用），runs 是"当前活着的树"（查询用）。
// 翻篇（flip）时：跑着的 runs 继续跑（quest 进程不重启），完成的 run 归档。

function runsDirOf(wsKey) {
  const d = path.join(dirOf(wsKey), 'runs');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function newRun(wsKey, title, rootNodeId) {
  const runId = `run-${Date.now().toString(36)}`;
  const run = {
    runId, title: title || '', wsKey,
    startedAt: new Date().toISOString(),
    nodes: {
      [rootNodeId]: { status: 'running', attempts: 1, fixCount: 0, parent: null, children: [], jobId: null, metrics: null, summary: null },
    },
  };
  fs.writeFileSync(path.join(runsDirOf(wsKey), `${runId}.json`), JSON.stringify(run, null, 2));
  return { runId, run };
}

// 从 plan 的 after 关系构建树结构（children/parent），保留已有节点的运行时状态
function syncRunTree(run, planNodes) {
  for (const n of planNodes) {
    if (!run.nodes[n.id]) {
      run.nodes[n.id] = { status: 'pending', attempts: 0, fixCount: 0, parent: (n.after ?? [])[0] ?? null, children: [], jobId: null, metrics: null, summary: null };
    }
  }
  for (const n of planNodes) {
    for (const p of n.after ?? []) {
      if (run.nodes[p] && !run.nodes[p].children.includes(n.id)) run.nodes[p].children.push(n.id);
      if (run.nodes[n.id] && !n.after.includes(p)) run.nodes[n.id].parent = p;
    }
  }
}

function updateRun(wsKey, runId, nodeId, patch) {
  try {
    const f = path.join(runsDirOf(wsKey), `${runId}.json`);
    const run = JSON.parse(fs.readFileSync(f, 'utf8'));
    Object.assign(run.nodes[nodeId] ?? (run.nodes[nodeId] = {}), patch);
    fs.writeFileSync(f, JSON.stringify(run, null, 2));
  } catch {}
}

// 找 runId：节点派发时若未指定，取同 wsKey 下含该节点的最新 run
function findRunId(wsKey, nodeId) {
  const dir = runsDirOf(wsKey);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().reverse();
  for (const f of files) {
    try {
      const run = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (run.nodes[nodeId]) return run.runId;
    } catch {}
  }
  return null;
}


/**
 * P5：progress.md 实时更新——主对话的"被动快照"。
 * 节点派发/终态时重写；AI 被问到实验时读它即知最新状态（几行，零注入）。
 * 排序（2026-09-10）：已完成（按账本里的真实完成时间正序，早的在上）→ 运行中 →
 * 异常终态 → 待办（按 plan 声明顺序——声明顺序即作者的重要性排序）。
 * 时间取账本事件时刻（完成那一刻服务写入的），不是文件 mtime，无需 AI 参与排序。
 */

/** plan 节点 ∪ 账本独有节点：快速单发（quest_run）只进账本不写 plan.md 的 node 段，
 *  status/progress 若只看 plan.md 会漏掉它们——2026-09-10 修复。 */
function mergedPlanNodes(plan, state) {
  const ids = new Set(plan.nodes.map((n) => n.id));
  const extra = Object.keys(state.nodes || {})
    .filter((id) => !ids.has(id) && state.nodes[id] && state.nodes[id].status)
    .map((id) => ({ id, shell: 'windows', quiet: false, expectMinutes: 0 }));
  return { meta: plan.meta, nodes: [...plan.nodes, ...extra] };
}

function nodeDisplayOrder(plan, state) {
  const order = plan.nodes.map((n, i) => ({ n, i, st: state.nodes[n.id] ?? {} }));
  const bucket = (st) => {
    const s = st.status ?? 'pending';
    if (s === 'completed') return 0;
    if (s === 'running') return 1;
    if (['failed', 'timeout', 'cancelled'].includes(s)) return 2;
    return 3;
  };
  order.sort((a, b) => {
    const ba = bucket(a.st), bb = bucket(b.st);
    if (ba !== bb) return ba - bb;
    if (ba === 0) return Date.parse(a.st.completedAt || 0) - Date.parse(b.st.completedAt || 0); // 完成时间正序：早的在上、晚的在下
    return a.i - b.i;
  });
  return order;
}

function writeProgress(wsKey) {
  try {
    const state = buildState(wsKey);
    if (!state.plan) return;
    const plan = mergedPlanNodes(parsePlan(state.plan), state);
    const wsDir = plan.meta.workspace || '';
    if (!wsDir) return;
    const headers = { 0: '## ✅ 已完成', 1: '## ▶ 进行中', 2: '## ⚠️ 异常（失败/超时/终止）', 3: '## ⏳ 待办（按计划顺序）' };
    const lines = [`# 任务进度（自动更新：${new Date().toLocaleString('zh-CN')}）`];
    let curBucket = -1;
    for (const { n, st } of nodeDisplayOrder(plan, state)) {
      const b = ({ completed: 0, running: 1, failed: 2, timeout: 2, cancelled: 2 })[st.status ?? 'pending'] ?? 3;
      if (b !== curBucket) { curBucket = b; lines.push('', headers[b], ''); }
      const icon = { running: '▶', completed: '✅', failed: '❌', cancelled: '🛑', frozen: '⛔', skipped: '⏭', ready: '⏸' }[st.status ?? 'pending'] ?? '·';
      let l = `- ${icon} **${n.id}**: ${st.status ?? 'pending'}`;
      if (st.completedAt) l += ` · 完成于 ${String(st.completedAt).slice(11, 16)}`;
      if (st.verdict && st.status !== 'completed') l += `（${st.verdict}）`;
      if (st.runSeconds != null) l += ` 已跑 ${formatDur(st.runSeconds)}`;
      if (st.metrics?.loss_last != null) l += ` · loss ${st.metrics.loss_last}`;
      if (st.metrics?.loss_slope_10ep != null) l += ` · 10ep斜率 ${st.metrics.loss_slope_10ep}`;
      if (st.watchWarns) l += ` · ⚠️watch警告×${st.watchWarns}`;
      if (st.fixCount) l += ` · 修复${st.fixCount}次`;
      lines.push(l);
      if (st.lastFix) lines.push(`  - 最近修复: ${String(st.lastFix).split('\n')[0].slice(0, 120)}`);
      if (st.summary) lines.push(`  - 总结: ${String(st.summary).split('\n')[0].slice(0, 150)}`);
    }
    fs.writeFileSync(path.join(wsDir, 'progress.md'), lines.join('\n') + '\n', 'utf8');
  } catch {}
}


// ── 硬指标提取（P1-1）：正则从日志抠逐轮数值，零幻觉 ──────────────────────
/**
 * 从日志尾部提取 loss 序列并计算趋势指标：
 *   loss_first / loss_last / loss_min     —— 绝对值（少用，判断主要看趋势）
 *   loss_slope_N                          —— 近 N 个样本的相对变化（负=在降）
 *   loss_plateau_epochs                   —— 尾部连续"变化<1%"的样本数（平台检测）
 * 返回形如 { loss_first, loss_last, loss_min, loss_slope_10ep, loss_plateau_epochs }
 * 提取不到（无 loss 字样）返回 {}——when 表达式引用缺失指标 = 条件不成立。
 */
function extractMetrics(logFile) {
  try {
    const size = fs.statSync(logFile).size;
    const buf = Buffer.alloc(Math.min(64 * 1024, size));
    const fh = fs.openSync(logFile, 'r');
    fs.readSync(fh, buf, 0, buf.length, Math.max(0, size - buf.length));
    fs.closeSync(fh);
    const text = buf.toString('utf8');
    const samples = [];
    for (const m of text.matchAll(/\b(?:val_)?loss\D{0,4}(\d+(?:\.\d+)?(?:e[+-]?\d+)?)/gi)) {
      const v = Number(m[1]);
      if (Number.isFinite(v) && v >= 0) samples.push(v);
    }
    if (samples.length < 2) return {};
    const s = samples.slice(-100); // 防超长
    const last = s[s.length - 1];
    const min = Math.min(...s);
    const out = { loss_first: r4(s[0]), loss_last: r4(last), loss_min: r4(min) };
    // 斜率：last / N 个样本前 的相对变化（<0 = 下降）
    for (const n of [5, 10, 20]) {
      if (s.length > n) out[`loss_slope_${n}ep`] = r4(last / s[s.length - 1 - n] - 1);
    }
    // 平台：尾部连续相对变化 < 1% 的样本数
    let plateau = 0;
    for (let i = s.length - 1; i > 0; i--) {
      const rel = Math.abs(s[i] / (s[i - 1] || 1) - 1);
      if (rel < 0.01) plateau++;
      else break;
    }
    out.loss_plateau_epochs = plateau;
    return out;
  } catch { return {}; }
}
const r4 = (x) => Math.round(x * 10000) / 10000;

/**
 * when 表达式求值（P1-2）。语法：<nodeid>.verdict == ok|failed|timeout|cancelled
 *                              <nodeid>.metrics.<key> <op> <number>
 * 操作符：== != < <= > >=。引用缺失（节点不存在/指标没提到）→ false（保守）。
 */
function evalWhen(expr, state) {
  try {
    const m = String(expr).match(/^([\w.-]+)\s*(==|!=|<=|>=|<|>)\s*(.+)$/);
    if (!m) return false;
    const [, ref, op, rawVal] = m;
    const val = rawVal.trim().replace(/^['"]|['"]$/g, '');
    let actual;
    if (ref.endsWith('.verdict')) {
      actual = state.nodes[ref.slice(0, -8)]?.verdict;
    } else if (ref.includes('.metrics.')) {
      const ni = ref.indexOf('.metrics.');
      actual = state.nodes[ref.slice(0, ni)]?.metrics?.[ref.slice(ni + 9)];
    } else return false;
    if (actual === undefined || actual === null) return false;
    if (op === '==' || op === '!=') {
      const eq = String(actual) === val;
      return op === '==' ? eq : !eq;
    }
    const a = Number(actual); const b = Number(val);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    return op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
  } catch { return false; }
}


// ── 作业执行器 ──────────────────────────────────────────────────────────
let jobSeq = 0;
// ── WSL 支持（2026-09-10）：shell: wsl 的节点在 WSL(Ubuntu) 里跑 ──────────
// 设计：命令经 setsid 起独立进程组，输出重定向到 WSL 内部日志（Linux 原生写，不经
// Windows 管道）——quest/DSH 崩溃时 wsl.exe 中继死了，Linux 进程照常跑照常写；
// quest 侧通过 \\wsl$ UNC 路径读同一份日志做判定/watch/metrics。杀 = 先 taskkill
// 中继，再进 WSL 按进程组 kill（pidfile 记录组长 PID）。
const WSL_DISTRO = () => CFG.wslDistro || 'Ubuntu';
const WSL_USER = () => CFG.wslUser || 'solanine';
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const wslUnc = (linuxPath) => `//wsl$/${WSL_DISTRO()}${String(linuxPath).startsWith('/') ? '' : '/'}${linuxPath}`;
/** 统一杀树：Windows 侧杀 wsl.exe 中继 + WSL 侧按进程组杀真正的负载。 */
function killJobTree(job, winPid) {
  try { execFile('taskkill', ['/PID', String(winPid), '/T', '/F'], () => {}); } catch {}
  if (job?.wslUnit) {
    try {
      execFile('wsl.exe', ['-d', WSL_DISTRO(), '-u', 'root', '--exec', 'systemctl', 'kill', job.wslUnit, '--signal=SIGKILL', '--kill-whom=all'], { windowsHide: true }, () => {});
    } catch {}
  } else if (job?.wslPidFile) {
    try {
      execFile('wsl.exe', ['-d', WSL_DISTRO(), '--exec', 'bash', '-c', `kill -KILL -$(cat ${job.wslPidFile}) 2>/dev/null; rm -f ${job.wslPidFile}`], { windowsHide: true }, () => {});
    } catch {}
  }
}
// quest 派发过的 pid：活跃 + 近 15 分钟内完结的。external-exit 检测到这些 pid 时跳过
// （quest 已经直接通知过了，python-manager 的外部检测再报就是重复）。
const questPids = new Map(); // pid -> expireAt
const isQuestPid = (pid) => {
  const now = Date.now();
  for (const [p, exp] of questPids) if (exp < now) questPids.delete(p);
  return pid && questPids.has(Number(pid));
};
// 活跃作业注册表（P1-3/P1-4）：nodeKey -> { child, timers[], flags }
const activeJobs = new Map();
function dispatchJob(wsKey, node, body = {}) {
  return new Promise(async (resolve) => {
    // 预检
    const pf = await preflight(node);
    if (pf) {
      appendEvent(wsKey, { t: 'node.preflight-failed', node: node.id, error: pf.error });
      if (!node.quiet) qqPush(wsKey, `[❌ 预检失败] ${node.id}\n${pf.error.slice(0, 300)}`).catch(() => {});
      pushInbox({ node: node.id, verdict: 'preflight-failed' });
      resolve({ ok: false, error: 'preflight-failed' });
      return;
    }
    const jobId = `j-${++jobSeq}-${Date.now().toString(36)}`;
    const logTs = new Date().toISOString().replace(/[:.]/g, '-');
    const startedAt = Date.now();
    const job = { child: null, timers: [], cancelledByHuman: null, killedByWatch: null, wslPidFile: null, wslUnit: null };
    let child;
    let logFile;
    if (node.shell === 'wsl') {
      // WSL 模式：日志写在 WSL 内部（Linux 原生，quest 死了也照写），quest 经 \\wsl$ 读同一份。
      // setsid 起独立进程组 + pidfile 记组长 PID：杀=进程组 kill；quest 崩溃时负载成孤儿继续跑（再认领 WSL 版待做）。
      const safe = wsKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(-40);
      const linuxLog = `/home/${WSL_USER()}/quest-logs/${safe}/${node.id}-${logTs}.log`;
      job.wslPidFile = `/home/${WSL_USER()}/quest-logs/${safe}/${node.id}-${logTs}.pid`;
      const dir = `/home/${WSL_USER()}/quest-logs/${safe}`;
      // 2026-09-10 终版：systemd-run 的 SERVICE 模式（--scope 会随会话陪葬——cgroup 挂在调用会话下；
      // service 进 system.slice 由 PID1 养，wsl.exe 会话退出/quest 崩溃都不影响）。
      // 退出码：service 模式 systemd-run 立即返回，wsl 会话改为轮询单元状态 + 从日志尾解析 EXIT_CODE。
      job.wslUnit = `quest-${String(node.id).replace(/[^a-zA-Z0-9_.-]/g, '_')}-${logTs}`.slice(0, 90);
      job.wslPidFile = `${dir}/${node.id}-${logTs}.unit`; // 记单元名（供重启后重建）
      const svcCmd = `cd ${shq(node.cwd || `/home/${WSL_USER()}`)} 2>/dev/null || { echo 'cd 失败' >> ${shq(linuxLog)}; echo EXIT_CODE:111; exit 0; }; ${node.command}; ec=\$?; echo EXIT_CODE:\$ec`;
      const wrapped = [
        `mkdir -p ${shq(dir)}`,
        `printf '%s' ${shq(job.wslUnit)} > ${shq(job.wslPidFile)}`,
        `systemd-run --quiet --unit=${job.wslUnit} -p User=${WSL_USER()} bash -c ${shq(svcCmd)} >> ${shq(linuxLog)} 2>&1`,
        `while systemctl is-active --quiet ${job.wslUnit} 2>/dev/null; do sleep 2; done`,
        `exit $(tail -c 512 ${shq(linuxLog)} | grep -oE 'EXIT_CODE:[0-9]+' | tail -1 | cut -d: -f2 || echo 1)`,
      ].join('; ');
      logFile = wslUnc(linuxLog);
      try {
        fs.mkdirSync(wslUnc(dir), { recursive: true }); // UNC 建目录（经 9p 落到 WSL 内）
        job.outFd = fs.openSync(logFile, 'a'); // 捕获 wsl.exe 自身的报错（Linux 侧输出走它自己的重定向）
      } catch (e) { log('WSL 日志句柄降级为 ignore:', e?.message); }
      // -u root：systemd-run 创建系统单元需要 root（polkit）；负载本体经 -p User 降权为 solanine
      child = spawn('wsl.exe', ['-d', WSL_DISTRO(), '-u', 'root', '--exec', 'bash', '-c', wrapped], { windowsHide: true, stdio: job.outFd ? ['ignore', job.outFd, job.outFd] : 'ignore' });
    } else {
      logFile = path.join(dirOf(wsKey), 'logs', `${node.id}-${logTs}.log`);
      job.outFd = fs.openSync(logFile, 'a');
      // stdio 句柄直挂而非管道：quest 崩溃时管道会断裂、子进程 print 即 BrokenPipeError；
      // 直挂 append 句柄则子进程继续写日志，重启后可再认领（见 adoptOrphan）。
      child = spawn('cmd.exe', ['/c', node.command], { cwd: node.cwd || undefined, windowsHide: true, stdio: ['ignore', job.outFd, job.outFd] });
    }
    appendEvent(wsKey, { t: 'node.dispatched', node: node.id, jobId, pid: child.pid, logTs });
    // P4 进程树：同步 run 实例
    try {
      const runId = body?.runId || findRunId(wsKey, node.id);
      const state0 = buildState(wsKey);
      const plan0 = state0.plan ? parsePlan(state0.plan) : null;
      if (plan0 && plan0.nodes.length) {
        let rid = runId;
        let run;
        if (rid) {
          try { run = JSON.parse(fs.readFileSync(path.join(runsDirOf(wsKey), rid + '.json'), 'utf8')); } catch { run = null; }
        }
        if (!run) {
          const created = newRun(wsKey, plan0.meta.title || '', node.id);
          rid = created.runId; run = created.run;
        }
        syncRunTree(run, plan0.nodes);
        Object.assign(run.nodes[node.id] ?? (run.nodes[node.id] = {}), { status: 'running', attempts: (run.nodes[node.id]?.attempts ?? 0) + 1, jobId });
        fs.writeFileSync(path.join(runsDirOf(wsKey), rid + '.json'), JSON.stringify(run, null, 2));
      }
    } catch (e) { log('run sync 失败:', e?.message); }
    questPids.set(child.pid, Date.now() + 24 * 3600 * 1000); // 活跃期先按 24h 登记
    // 派发即返回：不等 job 结束（HTTP 客户端不该被 70 分钟的训练挂住；结果走账本/收件箱/推送）
    resolve({ ok: true, jobId });

    job.child = child;
    activeJobs.set(`${wsKey}|${node.id}`, job);
    writeProgress(wsKey); // 派发即刷新：运行中节点立刻上墙

    // 超时护栏：timeout_seconds 显式指定，否则 expect_minutes × 2
    const timeoutMs = (node.timeoutSeconds > 0 ? node.timeoutSeconds : node.expectMinutes * 2 * 60) * 1000;
    let timedOut = false;
    job.timers.push(setTimeout(() => {
      timedOut = true;
      killJobTree(job, child.pid);
    }, timeoutMs));

    // 日志封顶：句柄直挂后 quest 不在写入路径上，只做周期巡检——超 max_log_mb（默认 256MB）
    // 就截断（append 句柄会自动跟到新 EOF）。截断丢的是旧 stdout，账本/指标/总结都不依赖它。
    const capMB = node.maxLogMB > 0 ? node.maxLogMB : 256;
    job.timers.push(setInterval(() => {
      try {
        if (fs.statSync(logFile).size > capMB * 1024 * 1024) {
          fs.truncateSync(logFile, 0);
          fs.appendFileSync(logFile, `\n── quest：日志超 ${capMB}MB 已截断（${new Date().toISOString()}）──\n`);
        }
      } catch {}
    }, 60 * 1000));

    // P1-3 watch + 退出收尾见独立函数（quest 重启再认领的孤儿也复用同一套）
    setupWatch(wsKey, node, job, logFile, child.pid);

    child.on('error', (err) => {
      job.timers.forEach(clearTimeout); job.timers.forEach(clearInterval); activeJobs.delete(`${wsKey}|${node.id}`);
      if (job.outFd) { try { fs.closeSync(job.outFd); } catch {} }
      appendEvent(wsKey, { t: 'node.preflight-failed', node: node.id, error: `spawn 失败: ${err.message}` });
      resolve({ ok: false, error: err.message });
    });
    child.on('exit', (code) => handleNodeExit(wsKey, node, { code, timedOut, logFile, startedAt, timeoutMs, job, out: job.outFd, pid: child.pid }));
  });
}

/** P1-3 watch：定时 tail 节点日志；规则命中需连续 confirm 次才动作；notify 只推 QQ 不杀；kill 仅限机械致命模式。 */
function setupWatch(wsKey, node, job, logFile, pid) {
  if (!node.watchRules.length) return;
  // 默认 watch quest 捕获的 stdout 日志；watch_log 显式指定脚本自建的日志文件时才覆盖
  const watchFile = !node.watchLog ? logFile
    : path.isAbsolute(node.watchLog) ? node.watchLog : path.join(node.cwd || '.', node.watchLog);
  const ivMs = Math.max(1, node.watchIntervalMinutes) * 60 * 1000;
  job.timers.push(setInterval(async () => {
    const tail = readTail(watchFile, 4096);
    if (!tail) return; // 日志还没建 = 没东西可看
    for (const rule of node.watchRules) {
      let hit = false;
      try { hit = new RegExp(rule.if, 'i').test(tail); } catch { continue; }
      rule.hits = hit ? (rule.hits ?? 0) + 1 : 0;
      if (rule.hits >= rule.confirm) {
        rule.hits = 0;
        if (rule.action === 'kill') {
          appendEvent(wsKey, { t: 'watch.kill', node: node.id, rule: rule.if });
          if (!node.quiet) qqPush(wsKey, `[👁 watch 击杀] ${node.id}\n规则「${rule.if}」连续 ${rule.confirm} 次命中，已终止任务`).catch(() => {});
          job.killedByWatch = rule.if;
          try { execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => {}); } catch {}
        } else {
          appendEvent(wsKey, { t: 'watch.warn', node: node.id, rule: rule.if });
          if (!node.quiet) qqPush(wsKey, `[⚠️ watch 警告] ${node.id}\n规则「${rule.if}」命中（只警告不杀；要杀请在 plan 里配 action=kill 或人工 /q停）`).catch(() => {});
        }
      }
    }
  }, ivMs));
}

/**
 * 子进程退出统一收尾：真实 child 的 exit 事件与再认领孤儿的轮询发现共用。
 * code 为 null 表示拿不到退出码（quest 重启后再认领），按退出码 0 走证据判定（关键词/产物），via 里注明。
 */
function handleNodeExit(wsKey, node, ctx) {
  const { code, timedOut, logFile, startedAt, timeoutMs, job, pid } = ctx;
  job.timers.forEach(clearTimeout); job.timers.forEach(clearInterval); activeJobs.delete(`${wsKey}|${node.id}`);
  if (ctx.out) { try { fs.closeSync(ctx.out); } catch {} }
  const runSec = Math.round((Date.now() - startedAt) / 1000);
  // 完结后保留 15 分钟（覆盖外部检测的确认延迟窗口），之后过期放行
  questPids.set(pid, Date.now() + 15 * 60 * 1000);
  appendEvent(wsKey, { t: 'node.exited', node: node.id, code, runSec, reAdopted: ctx.reAdopted || undefined });
  // P1-4 人工终止：独立终态，worker/fixer 全部静默，绝不续杯
  if (job.cancelledByHuman) {
    appendEvent(wsKey, { t: 'node.cancelled', node: node.id, reason: job.cancelledByHuman });
    pushInbox({ node: node.id, verdict: 'cancelled' });
    if (!node.quiet && CFG.qqNotify?.enabled) qqPush(wsKey, `[🛑 人工终止] ${node.id} · 已跑 ${formatDur(runSec)}\n原因：${job.cancelledByHuman}\n（不触发自动修复）`.slice(0, 400)).catch(() => {});
    orchestrate(wsKey).catch(() => {});
    return;
  }
  // 硬指标提取（P1-1）：无论成败都抠一份进账本
  const metrics = extractMetrics(logFile);
  if (Object.keys(metrics).length) appendEvent(wsKey, { t: 'node.metrics', node: node.id, metrics });
  // P4：同步进程树终态
  try {
    const rid = findRunId(wsKey, node.id);
    if (rid) updateRun(wsKey, rid, node.id, { status: 'exited', exitCode: code, metrics });
  } catch {}
  if (timedOut || job.killedByWatch) {
    const via = timedOut ? `超过 ${Math.round(timeoutMs / 1000)}s 被杀` : `watch 击杀（${job.killedByWatch}）`;
    appendEvent(wsKey, { t: 'node.timeout', node: node.id, runSec });
    finishNode(wsKey, node, { verdict: 'timeout', via, logFile }, null, runSec, startedAt);
  } else {
    const j = judge(node, code == null ? 0 : code, runSec, logFile);
    if (code == null) j.via = `${j.via}（退出码未知：quest 重启后再认领）`;
    appendEvent(wsKey, { t: 'node.judged', node: node.id, verdict: j.verdict, via: j.via, file: j.file || undefined });
    finishNode(wsKey, node, { ...j, logFile }, code, runSec, startedAt);
  }
}

/** 判定后的收尾：worker 总结（P2）→ 账本终结 → QQ（P3）→ 收件箱。 */
async function finishNode(wsKey, node, j, _code, runSec, startedAt = Date.now() - runSec * 1000) {
  let summary = '';
  if (CFG.workersEnabled !== false) {
    try { summary = await runWorker(wsKey, node, j, runSec); } catch (e) { log('worker 失败:', e.message); }
  }
  const ok = j.verdict === 'ok';
  appendEvent(wsKey, { t: ok ? 'node.completed' : 'node.failed', node: node.id, verdict: j.verdict });
  pushInbox({ node: node.id, verdict: j.verdict, summary });
  if (!node.quiet && CFG.qqNotify?.enabled) {
    const icon = ok ? '✅' : (j.verdict === 'timeout' ? '⏹' : '❌');
    qqPush(wsKey, `[${icon} ${j.verdict}] ${node.id} · ${formatDur(runSec)}\n${summary || (j.error || j.via || '')}`.slice(0, 600)).catch(() => {});
  }
  writeProgress(wsKey);
  // 产物图直推（2026-09-09）：成功节点把运行窗口内新产出的 png/jpg（≤push_images 张，默认 2）发 owner QQ
  if (ok && (node.pushImages ?? 2) > 0 && !node.quiet) pushArtifactImages(wsKey, node, startedAt).catch(() => {});
  // 依赖编排：成功续链 / 失败冻结下游 / 全线落定推收尾铃
  orchestrate(wsKey).catch(() => {});
  // WA 触发器：失败 + 节点声明 auto_fix + 预算未烧完 → 修复会话（最小修复+备份+重派）
  if (!ok && node.autoFix) {
    runFixer(wsKey, node, j, summary).catch((e) => log('fixer 异常:', e?.message));
  }
}

/** 扫节点 cwd（不递归）里运行窗口内新产出的 png/jpg，按 mtime 取最新 N 张直推 QQ。
 *  时间窗用节点真实起点（worker 总结耗时几秒到几分钟，不能用 now-runSec 倒推，会把刚产出的图当旧货滤掉）。 */
async function pushArtifactImages(wsKey, node, startedAt) {
  const dir = node.shell === 'wsl' ? wslUnc(node.cwd) : node.cwd; // WSL 节点经 UNC 扫产物
  if (!dir) return;
  const sinceMs = startedAt - 2000;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  const cands = [];
  for (const e of entries) {
    if (!e.isFile() || !/\.(png|jpe?g)$/i.test(e.name)) continue;
    const f = path.join(dir, e.name);
    try {
      const st = fs.statSync(f);
      if (st.mtimeMs > sinceMs && st.size > 0 && st.size <= 15 * 1024 * 1024) cands.push({ f, mtimeMs: st.mtimeMs });
    } catch {}
  }
  cands.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const c of cands.slice(0, node.pushImages ?? 2)) {
    await qqPushImage(wsKey, c.f, `[🖼 ${node.id}] ${path.basename(c.f)}`);
  }
}

/**
 * PID 复用防御：进程命令行里应含节点命令的指纹片段（我们派的是 cmd /c <command>，命令行原样可见）。
 * 查询失败（权限/超时）时退回只信存活信号——再认领错杀的代价由超时护栏承担，概率极低。
 */
function pidMatches(pid, node) {
  return new Promise((resolve) => {
    const fingerprint = node.command.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 30);
    if (!fingerprint) return resolve(true);
    execFile('powershell', ['-NoProfile', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
    { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      const cl = String(stdout || '').trim();
      if (err || !cl) return resolve(true);
      resolve(cl.toLowerCase().includes(fingerprint));
    });
  });
}

/**
 * 工作进程定位：账本 pid 是 cmd.exe 包装层，quest 崩溃时包装层可能先死而真正的
 * python/训练进程还活着（被挂到别的父进程下）。按命令行指纹搜全进程表找回它。
 * 排除探针自身（powershell）与 quest 自身（node）；拿 CreationDate 靠近节点起点再过滤一层。
 */
function findWorkerPid(node, startedAt) {
  return new Promise((resolve) => {
    const needle = node.command.replace(/\s+/g, ' ').trim().toLowerCase().replace(/"/g, '').slice(0, 40);
    if (!needle) return resolve(null);
    const psNeedle = needle.replace(/'/g, "''");
    const ps = `Get-CimInstance Win32_Process | Where-Object { $_.Name -ne 'powershell.exe' -and $_.Name -ne 'node.exe' -and $_.CommandLine -and ($_.CommandLine.ToLower() -replace '\\s+',' ').Contains('${psNeedle}') } | ForEach-Object { if ($_.CreationDate -gt [DateTimeOffset]::FromUnixTimeSeconds(${Math.floor(startedAt / 1000) - 120}).LocalDateTime) { "$($_.ProcessId)" } }`;
    execFile('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true, timeout: 12000 }, (err, stdout) => {
      if (err || !String(stdout || '').trim()) return resolve(null);
      const pid = Number(String(stdout).trim().split(/\r?\n/)[0]);
      resolve(Number.isFinite(pid) && pid > 0 ? pid : null);
    });
  });
}

/** 引号感知分词（探针用）：python -c "print('x')" → ['python','-c',"print('x')"]。
 *  外层引号按 shell 语义消费，内层原样保留——探针不经过 cmd.exe，绕开其剥引号的老毛病。 */
function shellSplit(s) {
  const out = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; else cur += c; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (/\s/.test(c)) { if (cur) { out.push(cur); cur = ''; } continue; }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

/** WSL 单元存活探测（systemd service 模式）。探测本身会按需拉起 WSL VM。 */
function wslUnitActive(unit) {
  return new Promise((resolve) => {
    execFile('wsl.exe', ['-d', WSL_DISTRO(), '--exec', 'systemctl', 'is-active', '--quiet', unit],
    { windowsHide: true, timeout: 12000 }, (err) => {
      resolve(!err); // is-active --quiet：退出码 0 = 活着
    });
  });
}

/**
 * 孤儿再认领（2026-09-09）：quest 重启后接管仍存活的作业。
 * 句柄直挂（stdio fd）保证子进程在 quest 死亡期间继续跑、继续写日志；
 * 这里轮询 PID 等退出（拿不到退出码，判定走关键词/产物证据路线），
 * 超时护栏按原起点重算剩余时间，watch 规则照常挂，/q停 照常可用。
 */
async function adoptOrphan(wsKey, node, n) {
  const startedAt0 = Date.parse(n.startedAt) || Date.now();

  // ── WSL 节点的再认领（2026-09-10）：账本里的 pid 是 wsl.exe 中继（quest 重启后已死，无意义），
  // 真正的存活判据是 WSL 内的 pidfile（setsid 进程组长）。日志在 WSL 内部，UNC 路径持久有效。
  if (node.shell === 'wsl') {
    const safe = wsKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(-40);
    const base = `/home/${WSL_USER()}/quest-logs/${safe}/${node.id}-${n.logTs}`;
    const logFile = wslUnc(`${base}.log`);
    const startedAt = startedAt0;
    // 单元名持久化在 .unit 文件里（新）；没有则按派发时的规则重建（旧账本兼容）
    let unit = '';
    try { unit = fs.readFileSync(wslUnc(`${base}.unit`), 'utf8').trim(); } catch {}
    if (!unit) unit = `quest-${String(node.id).replace(/[^a-zA-Z0-9_.-]/g, '_')}-${n.logTs}`.slice(0, 90);
    n.wslUnit = unit;
    const alive = await wslUnitActive(unit);
    if (!alive) {
      appendEvent(wsKey, { t: 'node.readopted', node: node.id, result: 'gone-wsl' });
      const runSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      const metrics = extractMetrics(logFile);
      if (Object.keys(metrics).length) appendEvent(wsKey, { t: 'node.metrics', node: node.id, metrics });
      const j = judge(node, 0, runSec, logFile);
      j.via = `${j.via}（quest 重启期间 WSL 进程已消失，按产物/关键词判定）`;
      appendEvent(wsKey, { t: 'node.judged', node: node.id, verdict: j.verdict, via: j.via, file: j.file || undefined });
      await finishNode(wsKey, node, { ...j, logFile }, null, runSec, startedAt);
      return;
    }
    const timeoutMs = (node.timeoutSeconds > 0 ? node.timeoutSeconds : node.expectMinutes * 2 * 60) * 1000;
    let timedOut = false;
    const job = { child: { pid: 0 }, timers: [], cancelledByHuman: null, killedByWatch: null, wslUnit: unit };
    activeJobs.set(`${wsKey}|${node.id}`, job);
    appendEvent(wsKey, { t: 'node.readopted', node: node.id, result: 'adopted-wsl' });
    job.timers.push(setTimeout(() => { timedOut = true; killJobTree(job, 0); }, Math.max(0, startedAt + timeoutMs - Date.now())));
    setupWatch(wsKey, node, job, logFile, 0);
    const iv = setInterval(async () => {
      if (await wslUnitActive(unit)) return;
      clearInterval(iv);
      handleNodeExit(wsKey, node, { code: null, timedOut, logFile, startedAt, timeoutMs, job, pid: 0, reAdopted: true });
    }, 10000);
    job.timers.push(iv);
    log(`WSL 再认领: ${wsKey}/${node.id}`);
    return;
  }

  let pid = Number(n.pid);
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch {}
  if (alive && !(await pidMatches(pid, node))) alive = false;
  const logFile = path.join(dirOf(wsKey), 'logs', `${node.id}-${n.logTs}.log`);
  const startedAt = startedAt0;

  if (!alive) {
    // 包装层（cmd.exe）可能先死而工作进程还在：按命令指纹找回真正的负载
    const found = await findWorkerPid(node, startedAt);
    if (found) {
      pid = found;
      alive = true;
    }
  }

  if (!alive) {
    // 进程在 quest 停机期间已消失（跑完或崩了）：按证据判定落终态，账本留痕
    appendEvent(wsKey, { t: 'node.readopted', node: node.id, pid, result: 'gone' });
    const runSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    const metrics = extractMetrics(logFile);
    if (Object.keys(metrics).length) appendEvent(wsKey, { t: 'node.metrics', node: node.id, metrics });
    const j = judge(node, 0, runSec, logFile);
    j.via = `${j.via}（quest 重启期间进程已消失，按产物/关键词判定）`;
    appendEvent(wsKey, { t: 'node.judged', node: node.id, verdict: j.verdict, via: j.via, file: j.file || undefined });
    await finishNode(wsKey, node, { ...j, logFile }, null, runSec, startedAt);
    return;
  }

  const timeoutMs = (node.timeoutSeconds > 0 ? node.timeoutSeconds : node.expectMinutes * 2 * 60) * 1000;
  let timedOut = false;
  const job = { child: { pid }, timers: [], cancelledByHuman: null, killedByWatch: null };
  activeJobs.set(`${wsKey}|${node.id}`, job);
  questPids.set(pid, Date.now() + 24 * 3600 * 1000);
  appendEvent(wsKey, { t: 'node.readopted', node: node.id, pid, result: 'adopted' });
  // 超时护栏按原起点续算；已超时的立刻杀
  job.timers.push(setTimeout(() => {
    timedOut = true;
    killJobTree(job, pid);
  }, Math.max(0, startedAt + timeoutMs - Date.now())));
  setupWatch(wsKey, node, job, logFile, pid);
  const iv = setInterval(() => {
    let a = false;
    try { process.kill(pid, 0); a = true; } catch {}
    if (!a) handleNodeExit(wsKey, node, { code: null, timedOut, logFile, startedAt, timeoutMs, job, pid, reAdopted: true });
  }, 5000);
  job.timers.push(iv);
  log(`再认领孤儿: ${wsKey}/${node.id} pid=${pid}`);
}

/**
 * 修复会话（2026-09-09 WA 化第一步）：
 * 失败节点（判定非 ok）+ auto_fix:true + fix.attempt 次数 < fix_budget →
 * 建一个带写权限的一次性修复会话：输入崩溃日志尾+worker 诊断+修复纪律 →
 * 回复以 FIX_OK / FIX_GIVEUP 结尾 → FIX_OK 则解冻下游并重派本节点。
 * 纪律写死：只做机械性最小修复（显存/参数/路径/环境），改前先 .bak，不碰实验逻辑。
 */
async function runFixer(wsKey, node, j, diagnosis) {
  const state = buildState(wsKey);
  const st = state.nodes[node.id] ?? {};
  const attempt = (st.fixCount ?? 0) + 1;
  if (attempt > (node.fixBudget ?? 2)) {
    appendEvent(wsKey, { t: 'fix.stopped', node: node.id, reason: `预算耗尽（${node.fixBudget ?? 2} 次）` });
    qqPush(wsKey, `[🛑 自动修复停手] ${node.id}：${node.fixBudget ?? 2} 次尝试后仍失败，等人工。
最近一次修复：${String(st.lastFix || '').slice(0, 200)}`).catch(() => {});
    return;
  }
  appendEvent(wsKey, { t: 'fix.attempt', node: node.id, n: attempt });

  const api = await getClient();
  const { createTurnCollector } = await import('./lib/dsh-client-v2.mjs');
  let sessionId = null;
  try {
    const created = await api.sessions.create({ cwd: node.cwd || os.homedir(), agentPreset: CFG.fixerPreset || 'quest-fixer' });
    if (!created.result.ok) throw new Error(JSON.stringify(created.result.error).slice(0, 120));
    sessionId = created.result.value.sessionId;
    activeWorkers.add(sessionId);
    const collector = createTurnCollector();
    let done; const turnP = new Promise((r) => { done = r; });
    workerCollectors.set(sessionId, { collector, resolve: done });

    const logTail = (() => {
      if (!j.logFile) return '';
      if (/\.(pt|npz|pth|ckpt|png|jpg|h5|npy|bin)$/i.test(j.logFile)) return '';
      return readTail(j.logFile, 4096);
    })();
    const script = String(node.command || '').match(/([\w.\-]+\.py)/)?.[1] || '';

    await api.sessions.prompt({
      sessionId, mode: 'queue',
      content: [{ type: 'text', text: `【自动修复任务】节点 ${node.id} 第 ${attempt}/${node.fixBudget ?? 2} 次尝试失败，请你做最小修复。

命令：${node.command}
判定：${j.verdict}（${j.via}）
${diagnosis ? `前一位分析员的诊断：
${diagnosis}` : ''}

崩溃日志尾部：
${logTail}

修复纪律（违反即失败）：
1. 只做机械性修复：显存不足→调小 batch/梯度累积/相关参数；NaN→调小学习率/加 clip；路径/环境错→修路径；缺依赖→修 import。绝不修改实验逻辑、模型结构、数据处理方法。
2. 动任何文件之前先复制一份 .bak-<今天日期> 备份。
3. 改完对主脚本跑 py_compile 验证；需要看中间量（张量形状/变量值/路径是否存在）可调 quest_probe 跑 30 秒内的诊断命令（如 python -c），改前改后都可以探。
4. 你的回复：先一句话说明改了什么文件什么参数，然后以单独一行 "FIX_OK" 结尾；如果判断这问题不属于机械性修复（需要人决策），回复原因并以 "FIX_GIVEUP" 结尾。` }],
    });
    const ended = await Promise.race([turnP, new Promise((_, rej) => setTimeout(() => rej(new Error('修复会话超时（8min）')), 480000))]);
    const reply = (ended?.text || '').trim();
    // 客观 diff：修复后对 cwd 里的 .bak-* 与原文件做逐行对比（不信任自述）
    let diffLines = [];
    try {
      const files = fs.readdirSync(node.cwd || '.');
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      for (const f of files) {
        const m2 = f.match(/^(.+)\.bak-\d{8}$/);
        if (!m2 || !files.includes(m2[1])) continue;
        const orig = fs.readFileSync(path.join(node.cwd, m2[1]), 'utf8').split(/\r?\n/);
        const bak = fs.readFileSync(path.join(node.cwd, f), 'utf8').split(/\r?\n/);
        for (let li = 0; li < Math.max(orig.length, bak.length); li++) {
          if (orig[li] !== bak[li]) diffLines.push(`${m2[1]}:${li + 1}: ${String(bak[li] ?? '(删)').trim().slice(0, 80)} → ${String(orig[li] ?? '(删)').trim().slice(0, 80)}`);
        }
      }
    } catch {}
    const diff = diffLines.slice(0, 20).join('\n');
    const giveup = /FIX_GIVEUP/i.test(reply.slice(-200));
    const okFix = /FIX_OK/i.test(reply.slice(-200));
    appendEvent(wsKey, { t: 'fix.reported', node: node.id, changes: reply.slice(0, 600), diff: diff || '(无文件改动)' });
    if (!node.quiet && CFG.qqNotify?.enabled) {
      qqPush(wsKey, `[🔧 自动修复 ${giveup ? '放弃' : okFix ? '完成' : '未知'}] ${node.id} 第${attempt}次
${reply.slice(0, 250)}${diff ? `
── 实际改动 ──
${diff}` : ''}`.slice(0, 900)).catch(() => {});
    }
    if (okFix) {
      // 解冻下游 + 重派本节点
      const plan = parsePlan(state.plan || '');
      const reach = new Set([node.id]);
      for (;;) {
        const add = (plan.nodes || []).filter((n2) => (n2.after ?? []).some((a) => reach.has(a)) && !reach.has(n2.id)).map((n2) => n2.id);
        if (!add.length) break;
        for (const a of add) reach.add(a);
      }
      for (const id of reach) {
        if (['frozen', 'ready'].includes(state.nodes[id]?.status ?? '')) appendEvent(wsKey, { t: 'node.unfrozen', node: id });
      }
      log('fixer 重派:', node.id);
      dispatchJob(wsKey, node).catch(() => {});
    } else if (giveup) {
      appendEvent(wsKey, { t: 'fix.stopped', node: node.id, reason: '修复会话判断需人工' });
    }
  } finally {
    if (sessionId) {
      activeWorkers.delete(sessionId);
      workerCollectors.delete(sessionId);
      try { await api.workspace.archiveSession({ sessionId }); } catch {}
    }
  }
}

/**
 * 依赖编排（2026-09-08 流水线支持）：
 * - 节点 completed → after 指向它的 pending 节点自动派发（manual:true 只标 ready 等人）
 * - 节点 failed/timeout → 下游冻结；全部节点终态 → line.concluded + QQ 收尾铃
 * 每个终态事件后调用；同刻多就绪只推进一个（链式天然串行）。
 */
async function orchestrate(wsKey) {
  const state = buildState(wsKey);
  if (!state.plan) return;
  const plan = parsePlan(state.plan);
  if (!plan.nodes.length) return;
  const stOf = (id) => state.nodes[id]?.status ?? 'pending';
  const evOf = (id) => state.nodes[id]?.events ?? [];

  for (const n of plan.nodes) {
    if (stOf(n.id) !== 'pending' || !n.after?.length) continue;
    const bad = n.after.find((d) => ['failed', 'timeout', 'frozen', 'cancelled', 'skipped'].includes(stOf(d)));
    if (bad && !evOf(n.id).includes('node.frozen')) {
      appendEvent(wsKey, { t: 'node.frozen', node: n.id, reason: `上游 ${bad} ${stOf(bad)}` });
      state.nodes[n.id] = state.nodes[n.id] ?? { status: 'pending', events: [] };
      state.nodes[n.id].status = 'frozen';
      state.nodes[n.id].detail = `上游 ${bad} ${stOf(bad)}`;
    }
  }

  // P1-2：when 条件门控。上游全部到终态后：when 成立 → 派发；不成立 → skipped（终态，下游冻结）。
  // 注意逐个处理且每轮 orchestrate 只推进一个 dispatch（break），skipped 可一次标记多个。
  for (const n of plan.nodes) {
    if (stOf(n.id) !== 'pending' || !n.after?.length) continue;
    if (!n.after.every((d) => ['completed', 'failed', 'timeout', 'cancelled'].includes(stOf(d)))) continue;
    if (n.when) {
      const pass = evalWhen(n.when, state);
      if (!pass) {
        if (!evOf(n.id).includes('node.skipped')) {
          appendEvent(wsKey, { t: 'node.skipped', node: n.id, reason: `when 不成立：${n.when}` });
          state.nodes[n.id] = state.nodes[n.id] ?? { status: 'pending', events: [] };
          state.nodes[n.id].status = 'skipped';
        }
        continue;
      }
    }
    if (n.manual) {
      if (!evOf(n.id).includes('node.ready')) {
        appendEvent(wsKey, { t: 'node.ready', node: n.id });
        pushInbox({ node: n.id, verdict: 'ready（等人工派发）' });
      }
      continue;
    }
    log('auto-dispatch:', n.id, '(after', n.after.join(','), n.when ? `, when: ${n.when}` : '', ')');
    dispatchJob(wsKey, n).catch(() => {});
    break;
  }

  const allStopped = plan.nodes.every((n) => ['completed', 'failed', 'timeout', 'frozen', 'cancelled', 'skipped'].includes(stOf(n.id)));
  if (allStopped && !(state.lineEvents ?? []).some((e) => e.t === 'line.concluded')) {
    const counts = {};
    for (const n of plan.nodes) counts[stOf(n.id)] = (counts[stOf(n.id)] ?? 0) + 1;
    const bad = plan.nodes.filter((n) => ['failed', 'timeout', 'frozen'].includes(stOf(n.id)));
    const parts = bad.map((n) => `${stOf(n.id) === 'frozen' ? '⛔' : stOf(n.id) === 'timeout' ? '⏹' : '❌'} ${n.id}（${state.nodes[n.id]?.verdict ? state.nodes[n.id].verdict + '/' : ''}${stOf(n.id)}）`);
    appendEvent(wsKey, { t: 'line.concluded', counts });
    // P2：研究状态文件自动追加——主对话"下次开口时已知一切"的共享内存
    try {
      const wsDir = plan.meta.workspace || '';
      if (wsDir) {
        const stateFile = path.join(wsDir, 'research-state.md');
        const ts = new Date().toLocaleString('zh-CN');
        const lines = [``, `## ${ts} · ${plan.meta.title || wsKey}`, ``];
        for (const n of plan.nodes) {
          const st = state.nodes[n.id] ?? {};
          const m = st.metrics ? ` loss_last=${st.metrics.loss_last ?? '?'} slope10=${st.metrics.loss_slope_10ep ?? '?'} plateau=${st.metrics.loss_plateau_epochs ?? '?'}` : '';
          lines.push(`- **${n.id}**: ${stOf(n.id)}${st.verdict && stOf(n.id) !== 'completed' ? `（${st.verdict}）` : ''}${m}${st.detail ? ` — ${st.detail}` : ''}`);
          if (st.summary) lines.push(`  > ${String(st.summary).split('\n')[0].slice(0, 150)}`);
        }
        fs.appendFileSync(stateFile, lines.join('\n') + '\n', 'utf8');
        log('research-state.md 已追加:', stateFile);
      }
    } catch (e) { log('research-state 追加失败:', e?.message); }
    if (CFG.qqNotify?.enabled) {
      qqPush(wsKey, `[🏁 任务线结束] ${plan.nodes.length} 段：${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' / ')}${parts.length ? '\n' + parts.join('\n') : '\n全绿 ✅'}`.slice(0, 500)).catch(() => {});
    }
    pushInbox({ node: '(line)', verdict: 'concluded', summary: JSON.stringify(counts) });
  }
}

const formatDur = (s) => (s < 60 ? `${s}秒` : s < 3600 ? `${Math.floor(s / 60)}分${s % 60}秒` : `${Math.floor(s / 3600)}小时${Math.floor((s % 3600) / 60)}分`);

// ── QQ 推送（P3：直打 bridge console，零 bridge 改动）──────────────────
/** 通知前缀：[实验标题或工作区名]。多实验并行时用户能分辨是哪条任务线在说话。 */
function qqTag(wsKey) {
  try {
    const st = buildState(wsKey);
    const p = st.plan ? parsePlan(st.plan) : null;
    const label = p?.meta?.title || path.basename(String(p?.meta?.workspace || wsKey));
    return `[${String(label).split('\n')[0].slice(0, 24)}] `;
  } catch { return `[${wsKey}] `; }
}

async function qqPush(wsKey, message) {
  const q = CFG.qqNotify;
  if (!q?.enabled) return;
  let token = '';
  try { token = fs.readFileSync(q.tokenFile, 'utf8').trim(); } catch { return; }
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 5000);
  try {
    await fetch(`${q.bridgeUrl}/api/send/private`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': token },
      body: JSON.stringify({ userId: q.userId, message: `${qqTag(wsKey)}${message}` }),
      signal: ac.signal,
    });
  } catch (e) {
    log('qqPush 失败:', String(e?.message || e).slice(0, 120)); // 2026-09-08：静默吞错导致 15:20 漏推无从查起
  } finally { clearTimeout(t); }
}

/** 产物图直推：把节点刚产出的 png/jpg 发 owner QQ（bridge /api/send/private-image，base64 image 段）。 */
async function qqPushImage(wsKey, imagePath, caption) {
  const q = CFG.qqNotify;
  if (!q?.enabled) return false;
  let token = '';
  try { token = fs.readFileSync(q.tokenFile, 'utf8').trim(); } catch { return false; }
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 20000);
  try {
    const resp = await fetch(`${q.bridgeUrl}/api/send/private-image`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': token },
      body: JSON.stringify({ userId: q.userId, imagePath, caption: `${qqTag(wsKey)}${caption}` }),
      signal: ac.signal,
    });
    return resp.ok;
  } catch (e) {
    log('qqPushImage 失败:', String(e?.message || e).slice(0, 120));
    return false;
  } finally { clearTimeout(t); }
}

// ── worker 子会话（P2：复用 dsh-client-v2）──────────────────────────────
let workerClient = null;
let workerMuxTask = null;
const workerCollectors = new Map(); // sessionId -> {collector, resolve}
const activeWorkers = new Set();

async function getClient() {
  if (workerClient) return workerClient;
  const { NodeApiClient } = await import('./lib/dsh-client-v2.mjs');
  workerClient = new NodeApiClient(CFG.dshBaseUrl, 30000, {
    token: CFG.dshToken || undefined,
    tokenLog: CFG.dshTokenLog || undefined,
  });
  // 事件流常驻：按会话路由到各 worker 的 collector
  const { createTurnCollector } = await import('./lib/dsh-client-v2.mjs');
  workerMuxTask = (async () => {
    for (;;) {
      try {
        for await (const env of workerClient.events.mux({})) {
          const f = env.payload;
          if (f?.type !== 'session/event') continue;
          const w = workerCollectors.get(f.sessionId);
          if (!w) continue;
          const ended = w.collector.push(f.event);
          if (ended) { workerCollectors.delete(f.sessionId); w.resolve(ended); }
        }
      } catch { await new Promise((r) => setTimeout(r, 3000)); }
    }
  })();
  return workerClient;
}

/** 一次性 worker：建会话 → 开工交接 →（判定后）总结 → 归档。返回总结文本。 */
async function runWorker(wsKey, node, j, runSec) {
  const api = await getClient();
  const { createTurnCollector } = await import('./lib/dsh-client-v2.mjs');
  if (activeWorkers.size >= 2) return '（worker 并发上限，跳过总结）';
  let sessionId = null;
  try {
    const created = await api.sessions.create({ cwd: node.cwd || os.homedir(), agentPreset: CFG.workerPreset || 'quest-worker' });
    if (!created.result.ok) throw new Error(JSON.stringify(created.result.error).slice(0, 120));
    sessionId = created.result.value.sessionId;
    activeWorkers.add(sessionId);

    // 开工交接（第 1 prompt：让 worker 知道在监控什么；纯文本确认即可）
    const collector = createTurnCollector();
    let turnDone;
    const turnP = new Promise((r) => { turnDone = r; });
    workerCollectors.set(sessionId, { collector, resolve: turnDone });

    const handoff = (node.handoff || '（无交接上下文）').trim();
    await api.sessions.prompt({
      sessionId, mode: 'queue',
      content: [{ type: 'text', text: `【任务交接】${node.id}\n命令：${node.command}\n\n${handoff}\n\n请回复"已了解，待命"三个字以外的任何内容都不需要。` }],
    });
    await Promise.race([turnP, new Promise((r) => setTimeout(r, 60000))]); // 交接 ack 等 1 分钟

    // 判定结果 → 总结（第 2 prompt）
    const logTail = (() => {
      if (!j.logFile) return '';
      // 二进制产物（.pt/.npz 等）不当文本读
      if (/\.(pt|npz|pth|ckpt|png|jpg|h5|npy|bin)$/i.test(j.logFile)) return `（产物文件：${j.logFile}）`;
      return readTail(j.logFile, 4096);
    })();
    const verdictLine = j.verdict === 'ok' ? '✅ 判定：正常完成'
      : j.verdict === 'timeout' ? '⏹ 判定：超时被杀'
      : j.verdict === 'startup-failed' ? '❌ 判定：启动即失败（多半是环境/参数/语法问题）'
      : j.verdict === 'crashed' ? '❌ 判定：运行中崩溃'
      : '⚠️ 判定：疑似未正常结束';
    const collector2 = createTurnCollector();
    let done2;
    const turnP2 = new Promise((r) => { done2 = r; });
    workerCollectors.set(sessionId, { collector: collector2, resolve: done2 });
    await api.sessions.prompt({
      sessionId, mode: 'queue',
      content: [{ type: 'text', text: `${verdictLine}（${j.via}）。运行 ${formatDur(runSec)}。\n\n命令：${node.command}\n\n输出日志尾部：\n${logTail}\n\n请用不超过 10 行总结：做了什么、结果如何、若有异常指出最可能的原因和建议的下一步。不要客套。` }],
    });
    const ended2 = await Promise.race([turnP2, new Promise((_, rej) => setTimeout(() => rej(new Error('worker 总结超时（5min）')), 300000))]);
    const summary = (ended2?.text || '').trim().slice(0, 1500);
    appendEvent(wsKey, { t: 'worker.reported', node: node.id, summary });
    return summary;
  } finally {
    if (sessionId) {
      activeWorkers.delete(sessionId);
      workerCollectors.delete(sessionId);
      try { await api.workspace.archiveSession({ sessionId }); } catch {}
    }
  }
}

// ── HTTP API ────────────────────────────────────────────────────────────
// ── quest_run 门禁（v0.3）：白名单直通 / 白天 QQ 确认 / 夜间自批 ──────────
// 设计边界：门挡的是误操作和不可审计执行，不是恶意（恶意由 DSH 沙箱权限层管）。
// 白名单 = 常规解释器跑工作区内脚本；其余白天挂起等 QQ 确认（超时作废），
// 夜间窗口内 AI 可自批但必须给 reason、每条推送留痕、每晚额度上限。
// runGate.enabled=false 可整体关闭（回到 v0.2 行为）。

const RUN_GATE_FILE = path.join(HOMEOverride, 'run-gate.json');
const runGateCfg = Object.assign(
  { enabled: true, nightStartHour: 23, nightEndHour: 8, nightQuota: 3, dayTimeoutMinutes: 30 },
  CFG.runGate || {}
);
let runGate = { pending: [], day: { date: '', nightUsed: 0 } };
try { runGate = Object.assign(runGate, JSON.parse(fs.readFileSync(RUN_GATE_FILE, 'utf8'))); } catch {}
function saveRunGate() {
  if (runGate.pending.length > 50) runGate.pending = runGate.pending.slice(-50);
  try { fs.writeFileSync(RUN_GATE_FILE, JSON.stringify(runGate, null, 2)); } catch {}
}
function isNightNow() {
  const h = new Date().getHours();
  const { nightStartHour: s, nightEndHour: e } = runGateCfg;
  return s > e ? (h >= s || h < e) : (h >= s && h < e); // 跨零点（23-8）与同日窗口都支持
}
function nightQuotaLeft() {
  const today = new Date().toISOString().slice(0, 10);
  if (runGate.day.date !== today) { runGate.day = { date: today, nightUsed: 0 }; saveRunGate(); }
  return Math.max(0, Number(runGateCfg.nightQuota) - runGate.day.nightUsed);
}

const INTERPRETER_RE = /^(python|python3|pypy|py|node|deno|bun|rscript|matlab|julia)(\.exe|\.cmd|\.bat)?$/i;

/** 命令分级：ok=白名单直通；confirm=需人工确认或夜间自批。 */
function classifyRunCommand(command, cwd) {
  const cmd = String(command || '').trim();
  if (/\b(del|erase|rd|rmdir|rm|format|diskpart|reg|regedit|shutdown|taskkill|net\s+user|sc|mklink|icacls|takeown|cipher|vssadmin)\b/i.test(cmd))
    return { level: 'confirm', why: '含删除/系统类命令词' };
  if (/\b(curl|wget|invoke-webrequest|invoke-restmethod|iwr|certutil\s+-urlcache)\b/i.test(cmd))
    return { level: 'confirm', why: '含网络下载类命令' };
  const first = cmd.split(/\s+/)[0].replace(/^"|"$/g, '');
  const base = first.split(/[\\\/]/).pop();
  if (INTERPRETER_RE.test(base)) {
    if (/(^|\s)-c(\s|$)/.test(cmd)) return { level: 'confirm', why: '解释器 -c 内联代码不可静态审查' };
    // 引用了工作区外的绝对路径（解释器本体除外）→ 提级确认
    const norm = (p) => String(p).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
    const wsNorm = norm(cwd);
    const outside = (cmd.match(/[a-z]:[\\\/][^\s"]+/ig) || []).filter((p) => !INTERPRETER_RE.test(p.split(/[\\\/]/).pop()) && !norm(p).startsWith(wsNorm));
    if (outside.length) return { level: 'confirm', why: `引用工作区外路径：${outside[0]}` };
    return { level: 'ok' };
  }
  return { level: 'confirm', why: '非白名单解释器命令' };
}

/** 快速单发统一入口：写 plan 头 + 账本 + 派发（白名单/自批/人工放行共用）。 */
function launchQuickRun(wsKey, node, extra = {}) {
  try {
    const dir2 = dirOf(wsKey);
    if (!fs.existsSync(path.join(dir2, 'plan.md'))) {
      fs.writeFileSync(path.join(dir2, 'plan.md'), `# 任务线：快速单发-${String(extra.title || path.basename(String(node.cwd))).slice(0, 30)}\nworkspace: ${node.cwd}\n`, 'utf8');
    }
  } catch {}
  appendEvent(wsKey, { t: 'plan.created', nodes: [node.id] });
  dispatchJob(wsKey, node).catch(() => {});
}

function submitRunForConfirm(wsKey, node, b, cls) {
  const rec = {
    id: `rg-${Date.now().toString(36)}`, wsKey, command: node.command, cwd: node.cwd,
    title: b.title || '', reason: String(b.reason || '').slice(0, 300), why: cls.why,
    createdAt: Date.now(), status: 'pending', node,
  };
  runGate.pending.push(rec); saveRunGate();
  appendEvent(wsKey, { t: 'gate.pending', node: node.id, gateId: rec.id, why: cls.why });
  pushInbox({ node: node.id, verdict: 'gate-pending', gateId: rec.id });
  qqPush(wsKey, `[⏳ 等确认] ${node.id}\n命令：${node.command.slice(0, 200)}\nAI 理由：${rec.reason || '（未给）'}\n分级理由：${cls.why}\n回复 /q确认 ${rec.id} 执行；/q拒绝 ${rec.id} 作废；${runGateCfg.dayTimeoutMinutes} 分钟不回自动作废`.slice(0, 600)).catch(() => {});
  return rec;
}

/** 夜间自批：必须给 reason 且当晚额度未烧完。返回 {approved} 或 {blocked} 或 null（白天）。 */
function tryNightSelfApprove(wsKey, node, b) {
  if (!isNightNow()) return null;
  const reason = String(b.reason || '').trim();
  if (!reason) return { blocked: '夜间自批必须给 reason（quest_run 时带上为什么要跑这条命令），已改为挂起等人工确认' };
  if (nightQuotaLeft() <= 0) return { blocked: `今晚夜间自批额度已用完（${runGateCfg.nightQuota} 条），已挂起等人工确认` };
  runGate.day.nightUsed++; saveRunGate();
  appendEvent(wsKey, { t: 'gate.night-self-approved', node: node.id, reason: reason.slice(0, 200), used: `${runGate.day.nightUsed}/${runGateCfg.nightQuota}` });
  qqPush(wsKey, `[🌙 夜间自批 ${runGate.day.nightUsed}/${runGateCfg.nightQuota}] ${node.id}\n命令：${node.command.slice(0, 200)}\nAI 理由：${reason.slice(0, 200)}\n（已直接执行，早上可复盘，账本留痕）`.slice(0, 600)).catch(() => {});
  return { approved: true };
}

// 过期巡检：白天确认门超时作废（命令从头到尾没执行过，零副作用）
setInterval(() => {
  const now = Date.now();
  let dirty = false;
  for (const r of runGate.pending) {
    if (r.status === 'pending' && now - r.createdAt > runGateCfg.dayTimeoutMinutes * 60000) {
      r.status = 'expired'; r.decidedAt = now; dirty = true;
      appendEvent(r.wsKey, { t: 'gate.expired', node: r.node.id, gateId: r.id });
      pushInbox({ node: r.node.id, verdict: 'gate-expired', gateId: r.id });
      qqPush(r.wsKey, `[⌛ 过期作废] ${r.node.id}（${r.id}）\n${runGateCfg.dayTimeoutMinutes} 分钟未确认，命令未执行`.slice(0, 400)).catch(() => {});
    }
  }
  if (dirty) saveRunGate();
}, 60 * 1000);

const server = http.createServer(async (req, res) => {
  const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
  try {
    const u = new URL(req.url, 'http://localhost');
    // 仪表盘页面本体免头认证（页面自己管 token：URL 参数/localStorage/弹窗）——所有数据 API 仍需 token
    if (req.method === 'GET' && (u.pathname === '/dashboard' || u.pathname === '/dashboard/')) {
      const html = fs.readFileSync(path.join(import.meta.dirname, 'dashboard.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
      return;
    }
    if (req.headers['x-quest-token'] !== QUEST_TOKEN) return json(401, { error: 'unauthorized' });
    const ws = u.searchParams.get('ws') || lastActiveWs || '';
    const wsKey = wsKeyOf(ws);

    if (req.method === 'GET' && u.pathname === '/api/status') {
      const state = buildState(wsKey);
      const plan0 = state.plan ? parsePlan(state.plan) : { nodes: [] };
      const plan = mergedPlanNodes(plan0, state); // 并入账本独有节点（快速单发）
      // 展示排序与 progress.md 一致：已完成（时间正序）→运行中→异常→待办（声明序）
      const nodes = nodeDisplayOrder(plan, state).map(({ n }) => ({ id: n.id, ...(state.nodes[n.id] || { status: 'pending' }), quiet: n.quiet, expectMinutes: n.expectMinutes }));
      const unread = inbox.splice(0); // 取走即清
      writeProgress(wsKey); // 查询即刷新：progress.md 不再等下一个节点事件（排序/状态实时保鲜）
      // workspace 优先取 plan.md 里声明的绝对路径（权威），入参只做缺省——/q翻页 等下游要拿真路径去匹配 DSH 会话
      return json(200, { plan: { workspace: plan.meta?.workspace || ws, title: plan.meta?.title || '', nodes }, unread, questVersion: '0.2.0' });
    }
    if (req.method === 'POST' && u.pathname === '/api/plan') {
      const body = await readBody(req);
      const parsed = parsePlan(body.markdown || '');
      if (parsed.errors.length) return json(400, { ok: false, errors: parsed.errors });
      const dir = dirOf(wsKey);
      fs.writeFileSync(path.join(dir, 'plan.md'), body.markdown, 'utf8');
      appendEvent(wsKey, { t: fs.existsSync(path.join(dir, 'ledger.jsonl')) ? 'plan.reloaded' : 'plan.created', nodes: parsed.nodes.map((n) => n.id) });
      return json(200, { ok: true, nodes: parsed.nodes.map((n) => n.id), workspace: ws });
    }
    // P4：进程树查询
    if (req.method === 'GET' && u.pathname === '/api/runs') {
      const dir = runsDirOf(wsKey);
      const runs = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().reverse().slice(0, 10).map((f) => {
        try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; }
      }).filter(Boolean);
      return json(200, { runs });
    }
    // ② quest_run：快速单发——不写 plan 直接派一个临时节点（全套判定+worker+QQ）
    // v0.3 门禁：白名单直通 / 白天挂起 QQ 确认 / 夜间自批（reason+额度）
    if (req.method === 'POST' && u.pathname === '/api/run') {
      const b = await readBody(req);
      if (!b.command || !b.cwd) return json(400, { ok: false, error: '缺少 command/cwd' });
      const node = {
        id: `quick-${String(b.title || b.command).slice(0, 40).replace(/[^\w一-龥-]/g, '_')}-${Date.now().toString(36)}`,
        command: String(b.command).slice(0, 500), cwd: b.cwd,
        expectMinutes: Number(b.expectMinutes) || 30, quiet: b.quiet === true,
        autoFix: b.autoFix === true, fixBudget: 2,
        handoff: String(b.handoff || '快速单发任务').slice(0, 2000),
        after: [], when: '', watchRules: [],
        shell: b.shell === 'wsl' ? 'wsl' : 'windows',
      };
      const wsKey2 = wsKeyOf(b.cwd);
      const cls = runGateCfg.enabled === false ? { level: 'ok' } : classifyRunCommand(node.command, node.cwd);
      if (cls.level !== 'ok') {
        const night = tryNightSelfApprove(wsKey2, node, b);
        if (night?.approved) {
          launchQuickRun(wsKey2, node, b);
          return json(200, { ok: true, nodeId: node.id, gate: 'night-self-approved' });
        }
        const rec = submitRunForConfirm(wsKey2, node, b, cls);
        return json(200, {
          ok: true, nodeId: node.id, gate: 'pending-confirm', gateId: rec.id,
          note: night?.blocked || `命令不在白名单（${cls.why}），已推送 owner QQ 等确认，${runGateCfg.dayTimeoutMinutes} 分钟不确认自动作废。改写成白名单形式（解释器跑工作区内脚本）可直接跑。`,
        });
      }
      launchQuickRun(wsKey2, node, b);
      return json(200, { ok: true, nodeId: node.id, gate: 'whitelist' });
    }
    // v0.3 门禁裁决：/q确认 /q拒绝 的后端
    if (req.method === 'POST' && u.pathname === '/api/gate/decide') {
      const b = await readBody(req);
      const rec = runGate.pending.find((r) => r.id === String(b.id || '') && r.status === 'pending');
      if (!rec) return json(404, { ok: false, error: `没有待确认的 ${b.id}` });
      rec.decidedAt = Date.now();
      if (b.approve) {
        rec.status = 'approved'; saveRunGate();
        appendEvent(rec.wsKey, { t: 'gate.approved', node: rec.node.id, gateId: rec.id });
        pushInbox({ node: rec.node.id, verdict: 'gate-approved', gateId: rec.id });
        qqPush(rec.wsKey, `[✅ 已放行] ${rec.node.id}（${rec.id}）\n命令：${rec.command.slice(0, 200)}\n开始执行，照常走判定/总结/通知`.slice(0, 500)).catch(() => {});
        launchQuickRun(rec.wsKey, rec.node, { title: rec.title });
        return json(200, { ok: true, action: 'dispatched', nodeId: rec.node.id });
      }
      rec.status = 'rejected'; saveRunGate();
      appendEvent(rec.wsKey, { t: 'gate.rejected', node: rec.node.id, gateId: rec.id });
      pushInbox({ node: rec.node.id, verdict: 'gate-rejected', gateId: rec.id });
      qqPush(rec.wsKey, `[🚫 已作废] ${rec.node.id}（${rec.id}）\n命令从未执行`.slice(0, 400)).catch(() => {});
      return json(200, { ok: true, action: 'rejected' });
    }
    // ── v0.4 仪表盘配套：工作区列表 + 文件浏览（token 认证，本机/局域网）──────────
    if (req.method === 'GET' && u.pathname === '/api/workspaces') {
      const list = [];
      try {
        for (const d of fs.readdirSync(HOMEOverride, { withFileTypes: true })) {
          if (!d.isDirectory()) continue;
          let title = '';
          let running = 0;
          try {
            const st = buildState(d.name);
            if (st.plan) title = parsePlan(st.plan).meta?.title || '';
            running = Object.values(st.nodes).filter((n) => n.status === 'running').length;
          } catch {}
          list.push({ wsKey: d.name, title, running });
        }
      } catch {}
      list.sort((a, b) => b.running - a.running || a.wsKey.localeCompare(b.wsKey));
      return json(200, { workspaces: list });
    }
    if (req.method === 'GET' && u.pathname === '/api/files') {
      // mode=list 列目录（绝对路径，Windows 或 \\wsl$ UNC 均可）；mode=read 读文本（>512KB 截尾）；
      // mode=img 返回 base64 dataURL（图片预览，≤10MB）。token 认证的 owner 本机服务，路径不设白名单。
      const mode = u.searchParams.get('mode') || 'list';
      const p = u.searchParams.get('path') || '';
      if (!p) return json(400, { error: '缺少 path' });
      try {
        if (mode === 'list') {
          const entries = fs.readdirSync(p, { withFileTypes: true }).map((e) => {
            let st = null;
            try { st = fs.statSync(path.join(p, e.name)); } catch {}
            return { name: e.name, dir: e.isDirectory(), size: st?.size ?? 0, mtime: st?.mtimeMs ?? 0 };
          });
          entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
          return json(200, { path: p, entries });
        }
        if (mode === 'img') {
          const st = fs.statSync(p);
          if (st.size > 10 * 1024 * 1024) return json(413, { error: '图片超 10MB' });
          const b64 = fs.readFileSync(p).toString('base64');
          const ext = path.extname(p).toLowerCase();
          const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[ext] || 'image/png';
          return json(200, { dataUrl: `data:${mime};base64,${b64}` });
        }
        // mode=read：文本读，大文件截尾
        const st = fs.statSync(p);
        if (st.size > 512 * 1024) {
          return json(200, { truncated: true, size: st.size, text: readTail(p, 256 * 1024) });
        }
        return json(200, { truncated: false, size: st.size, text: fs.readFileSync(p, 'utf8') });
      } catch (e) {
        return json(404, { error: `读不到：${String(e?.message || e).slice(0, 120)}` });
      }
    }
    if (req.method === 'GET' && u.pathname === '/api/gate/list') {
      return json(200, {
        pending: runGate.pending.filter((r) => r.status === 'pending').map((r) => ({ id: r.id, command: r.command, cwd: r.cwd, reason: r.reason, why: r.why, createdAt: r.createdAt })),
        night: { active: isNightNow(), quotaLeft: nightQuotaLeft(), quota: runGateCfg.nightQuota },
      });
    }
    // P4：翻篇（flip）——归档当前会话 + 开新会话 + 种子消息（读 research-state.md 恢复上下文）
    // 流程：AI 先写好 research-state.md → 调本端点 → 本端点做会话切换
    if (req.method === 'POST' && u.pathname === '/api/flip') {
      const b = await readBody(req);
      const { NodeApiClient } = await import('./lib/dsh-client-v2.mjs');
      const api = new NodeApiClient(CFG.dshBaseUrl, 30000, { token: CFG.dshToken || undefined, tokenLog: CFG.dshTokenLog || undefined });
      const results = { archived: [], created: null, errors: [] };
      // 1) 归档旧会话（该工作区下所有会话）
      try {
        const lr = await api.sessions.list({});
        if (lr.result.ok) {
          for (const item of lr.result.value?.items ?? []) {
            if (String(item.cwd ?? '').replace(/\\/g, '/') === String(b.ws ?? '').replace(/\\/g, '/')) {
              try {
                await api.workspace.archiveSession({ sessionId: item.sessionId });
                results.archived.push(item.sessionId);
              } catch (e) { results.errors.push(`archive ${item.sessionId}: ${e.message}`); }
            }
          }
        }
      } catch (e) { results.errors.push(`list: ${e.message}`); }
      // 2) 开新会话
      try {
        const created = await api.sessions.create({ cwd: b.ws, agentPreset: b.preset || undefined });
        if (!created.result.ok) throw new Error(JSON.stringify(created.result.error).slice(0, 150));
        results.created = created.result.value.sessionId;
      } catch (e) { results.errors.push(`create: ${e.message}`); }
      // 3) 种子消息：让新会话读研究状态文件
      if (results.created && b.seed !== false) {
        try {
          await api.sessions.prompt({
            sessionId: results.created, mode: 'queue',
            content: [{ type: 'text', text: `【翻篇恢复】工作区刚完成一次翻篇归档。请先读取 ${path.join(b.ws, 'research-state.md')} 恢复研究上下文（历史结论、参数基线、待办），读完后回复"上下文已恢复"并简述当前状态（3 行以内）。之后等待用户指示。` }],
          });
        } catch (e) { results.errors.push(`seed: ${e.message}`); }
      }
      appendEvent(wsKey, { t: 'flip.done', archived: results.archived.length, created: results.created });
      return json(200, { ok: results.errors.length === 0, ...results });
    }
    // P1-4：人工终止。杀树 + cancelled 独立终态（fixer 无视，绝不续杯），worker/总结全部静默。
    if (req.method === 'POST' && u.pathname === '/api/cancel') {
      const body = await readBody(req);
      const job = activeJobs.get(`${wsKey}|${body.node}`);
      if (!job) return json(404, { ok: false, error: `节点 ${body.node} 不在运行` });
      job.cancelledByHuman = String(body.reason || '人工终止').slice(0, 200);
      killJobTree(job, job.child.pid);
      return json(200, { ok: true, node: body.node, note: '已杀树，等待退出事件落账（cancelled 终态，不触发自动修复）' });
    }
    if (req.method === 'POST' && u.pathname === '/api/dispatch') {
      const body = await readBody(req);
      const state = buildState(wsKey);
      const plan = state.plan ? parsePlan(state.plan) : null;
      const node = plan?.nodes.find((n) => n.id === body.node);
      if (!node) return json(404, { ok: false, error: `节点 ${body.node} 不在当前 plan.md 里` });
      const st = state.nodes[node.id]?.status;
      if (st === 'running') return json(409, { ok: false, error: '该节点已在运行' });
      // 2026-09-09：显式派发冻结节点 = 人工解冻（重派上游后下游自动复活）。
      // 解冻自身 + 沿 after 边可达的所有冻结后代。
      if (st === 'frozen' || st === 'ready' || st === 'failed' || st === 'timeout') {
        const reach = new Set([node.id]);
        for (;;) {
          const add = plan.nodes.filter((n2) => (n2.after ?? []).some((a) => reach.has(a)) && !reach.has(n2.id)).map((n2) => n2.id);
          if (!add.length) break;
          for (const a of add) reach.add(a);
        }
        for (const id of reach) {
          if (['frozen', 'ready'].includes(state.nodes[id]?.status ?? '')) appendEvent(wsKey, { t: 'node.unfrozen', node: id });
        }
      }
      const r = await dispatchJob(wsKey, node, { runId: body.runId });
      return json(200, r);
    }
    if (req.method === 'GET' && u.pathname === '/api/log') {
      const node = u.searchParams.get('node') || '';
      const state = buildState(wsKey);
      const n = state.nodes[node];
      if (!n?.logTs) return json(404, { error: '无日志' });
      const planN = state.plan ? parsePlan(state.plan).nodes.find((x) => x.id === node) : null;
      let files = [];
      let file = null;
      if (planN?.shell === 'wsl') {
        const safe = wsKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(-40);
        const wdir = wslUnc(`/home/${WSL_USER()}/quest-logs/${safe}`);
        try { files = fs.readdirSync(wdir).filter((f) => f.startsWith(`${node}-`)).sort(); } catch {}
        if (files.length) file = `${wdir}/${files[files.length - 1]}`;
      } else {
        const dir = dirOf(wsKey);
        try { files = fs.readdirSync(path.join(dir, 'logs')).filter((f) => f.startsWith(`${node}-`)).sort(); } catch {}
        if (files.length) file = path.join(dir, 'logs', files[files.length - 1]);
      }
      if (!file) return json(404, { error: '无日志' });
      const tail = Number(u.searchParams.get('tail')) || 4096;
      return json(200, { file, log: readTail(file, tail) });
    }
    // v0.3 探针：同步跑一条 ≤30s 的白名单诊断命令，尾部输出（≤8KB）直接返回。
    // 与 quest_run 的区别：run 是派发后走人（异步+判定+通知），探针是"现在就要答案"。
    // 安全四件套代替确认门（修复循环需要即时反馈，挂起等确认会把循环打断）：
    // 白名单分类器（探针额外放行 -c 内联——fixer 本就有工作区写权限，执行的边际风险由下面兜住）
    // + 30s 硬杀 + 危险词黑名单（分类器自带）+ 账本全量留痕。
    if (req.method === 'POST' && u.pathname === '/api/probe') {
      const b = await readBody(req);
      if (!b.command || !b.cwd) return json(400, { ok: false, error: '缺少 command/cwd' });
      const command = String(b.command).slice(0, 500);
      const cwd = String(b.cwd);
      const cls = classifyRunCommand(command, cwd);
      const allowC = cls.why === '解释器 -c 内联代码不可静态审查'; // 探针放行 -c（quest_run 依然要过门）
      if (cls.level !== 'ok' && !allowC) {
        return json(403, { ok: false, error: `探针拒绝（${cls.why}）：只接受解释器跑工作区内脚本或 -c 内联诊断；长任务请用 quest_run。` });
      }
      const logFile = path.join(dirOf(wsKey), 'logs', `probe-${Date.now().toString(36)}.log`);
      appendEvent(wsKey, { t: 'probe.run', command });
      const out = fs.openSync(logFile, 'a');
      // 直接 spawn 解释器（分词后），不经 cmd.exe：避开其嵌套双引号被剥的老毛病（python -c 是探针主场景）。
      // 代价：无 shell 特性（管道/重定向/&），需要时写进 -c 代码里——对诊断场景是合理限制。
      const argv = shellSplit(command);
      if (!argv.length) return json(400, { ok: false, error: '空命令' });
      const child = spawn(argv[0], argv.slice(1), { cwd, windowsHide: true, stdio: ['ignore', out, out] });
      questPids.set(child.pid, Date.now() + 5 * 60 * 1000);
      const startedAt = Date.now();
      let killed = false;
      const killer = setTimeout(() => {
        killed = true;
        try { execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => {}); } catch {}
      }, 30000);
      const code = await new Promise((resolve) => child.on('exit', resolve));
      clearTimeout(killer);
      try { fs.closeSync(out); } catch {}
      appendEvent(wsKey, { t: 'probe.done', code, ms: Date.now() - startedAt, killed: killed || undefined });
      return json(200, { ok: true, code, killed, ms: Date.now() - startedAt, log: readTail(logFile, 8192), logFile });
    }
    if (req.method === 'POST' && u.pathname === '/api/external-exit') {
      // 外部进程退出（python-manager 检测到的手动启动任务）：合成虚拟节点走同一条
      // finishNode 流水线（worker 总结 + QQ 推送 + 账本），不占用 plan.md
      const b = await readBody(req);
      if (isQuestPid(b.pid)) return json(200, { ok: true, skipped: 'quest-pid', node: null }); // 自己的作业已直接通知
      if (!b.cwd || !b.script) return json(400, { ok: false, error: '缺少 cwd/script' });
      const wsKey2 = wsKeyOf(b.cwd);
      const node = {
        id: `ext-${String(b.script).slice(0, 50)}`,
        cwd: b.cwd,
        command: String(b.cmd || b.script).slice(0, 300),
        quiet: false,
        handoff: '外部手动启动的任务（未经 quest 派发，无预写交接上下文）。结合日志尾部自行判断这是什么类型的任务。',
      };
      const verdictMap = { ok: 'ok', suspect: 'crashed', 'no-output': 'suspect' };
      const verdict = verdictMap[b.verdict] || 'suspect';
      appendEvent(wsKey2, { t: 'node.exited', node: node.id, code: b.exitCode ?? 0, runSec: b.runSeconds });
      appendEvent(wsKey2, { t: 'node.judged', node: node.id, verdict, via: `external/${b.via || b.verdict}`, file: b.file || undefined });
      finishNode(wsKey2, node, { verdict, via: `external/${b.via || b.verdict}`, logFile: b.file || '' }, b.exitCode ?? 0, b.runSeconds || 0).catch(() => {});
      return json(200, { ok: true, node: node.id });
    }
    if (req.method === 'GET' && u.pathname === '/api/events') {
      const since = u.searchParams.get('since');
      const wait = Math.min(30, Number(u.searchParams.get('wait')) || 0);
      const idx = since ? events.findIndex((e) => e.at > since) : 0;
      let out = idx >= 0 ? events.slice(idx) : [];
      if (!out.length && wait > 0) {
        await new Promise((r) => { eventWaiters.push(r); setTimeout(r, wait * 1000); });
        const idx2 = since ? events.findIndex((e) => e.at > since) : 0;
        out = idx2 >= 0 ? events.slice(idx2) : [];
      }
      return json(200, { events: out.slice(-100) });
    }
    json(404, { error: 'not found' });
  } catch (e) {
    json(500, { error: String(e?.message || e) });
  }
});

const readBody = (req) => new Promise((resolve, reject) => {
  let d = '';
  req.on('data', (c) => { d += c; if (d.length > 1024 * 1024) req.destroy(); });
  req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
  req.on('error', reject);
});

server.listen(CFG.port || 3110, '127.0.0.1', () => {
  log(`quest 服务就绪 http://127.0.0.1:${CFG.port || 3110}（token: ${QUEST_TOKEN.slice(0, 6)}…）`);
  log(`worker 目标: ${CFG.dshBaseUrl}${CFG.workersEnabled === false ? '（worker 已禁用）' : ''}`);
  // 启动对账（2026-09-09 改版）：running 节点 = quest 重启前的活作业。
  // 句柄直挂后子进程不再随 quest 死亡：PID 存活（且命令行指纹匹配）→ 再认领接管；
  // 已消失 → 按产物/关键词证据落终态。两者都比"一律标 cancelled"保数据。
  try {
    for (const dir of fs.readdirSync(HOMEOverride, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const wsKey = dir.name;
      let state;
      try { state = buildState(wsKey); } catch { continue; }
      if (!state.plan) continue;
      const plan = parsePlan(state.plan);
      for (const node of plan.nodes) {
        const n = state.nodes[node.id];
        if (n?.status !== 'running' || !n.pid) continue;
        adoptOrphan(wsKey, node, n).catch((e) => log('再认领失败:', wsKey, node.id, e?.message));
      }
    }
  } catch {}
});
