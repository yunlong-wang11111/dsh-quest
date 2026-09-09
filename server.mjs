#!/usr/bin/env node
// quest 服务 —— 任务线编排核心（P1：账本+作业执行+预检+判定器；P2：worker 子会话；P3：QQ 推送）
//
// 设计文档：DESIGN.md（本仓库根目录）
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
    dshTokenLog: '',   // DSH 启动日志路径（解析 token 用）,
    dshToken: '',
    workerPreset: 'quest-worker',
    fixerPreset: 'quest-fixer',
    qqNotify: {
      enabled: false,
      bridgeUrl: 'http://127.0.0.1:3100',
      tokenFile: '',     // bridge console token 文件路径,
      userId: 0,          // 你的 QQ 号
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
      cur = { id: m[1], command: '', cwd: '', expectMinutes: 30, timeoutSeconds: 0, success: '', quiet: false, needsExecution: false, handoff: '', after: [], manual: false, autoFix: false, fixBudget: 2 };
      handoffMode = false;
      continue;
    }
    if (!cur) {
      const kv = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
      if (kv && ['workspace', 'title'].includes(kv[1])) meta[kv[1]] = kv[2].trim();
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
      case 'handoff':
        if (v.trim() === '|' || v.trim() === '') handoffMode = true;
        else cur.handoff = v.trim() + '\n';
        break;
    }
  }
  if (cur) nodes.push(cur);
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
      if (e.t === 'node.completed') n.status = 'completed';
      if (e.t === 'node.failed') n.status = 'failed';
      if (e.t === 'node.timeout') { n.status = 'timeout'; n.verdict = 'timeout'; n.via = e.via || '超时被杀'; }
      if (e.t === 'node.frozen') { n.status = 'frozen'; n.detail = e.reason; }
      if (e.t === 'node.ready') { n.status = 'ready'; }
      if (e.t === 'node.unfrozen') { n.status = 'pending'; n.verdict = undefined; n.via = undefined; n.detail = undefined; }
    }
  } catch {}
  return state;
}

function appendEvent(wsKey, e) {
  const dir = dirOf(wsKey);
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
const eventWaiters = [];
const wakeEventWaiters = () => { for (const w of eventWaiters.splice(0)) w(); };

// ── 未读收件箱（主会话 quest_status 时消费）────────────────────────────
const inbox = [];
const pushInbox = (msg) => { inbox.push({ ts: Date.now(), ...msg }); if (inbox.length > 50) inbox.shift(); };

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
  const tail = (() => { try { return fs.readFileSync(logFile, 'utf8').slice(-4096).toLowerCase(); } catch { return ''; } })();
  if (FINISH_KEYWORDS.some((k) => tail.includes(k.toLowerCase()))) return { verdict: 'ok', via: 'finish-keyword' };
  const dirs = [node.cwd, path.join(node.cwd, 'out'), path.join(node.cwd, 'logs'), path.join(node.cwd, 'output'), path.join(node.cwd, 'results'), path.join(node.cwd, 'runs')];
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
  const startMs = Date.now() - runSec * 1000;
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
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 15000); // 预检自身卡住则放行（判定器兜底）
    execFile(exe, ['-m', 'py_compile', script], { cwd: node.cwd, windowsHide: true, timeout: 12000 }, (err, _so, se) => {
      clearTimeout(t);
      if (err) resolve({ error: String(se || err.message || 'py_compile 失败').slice(0, 600) });
      else resolve(null);
    });
  });
}

// ── 作业执行器 ──────────────────────────────────────────────────────────
let jobSeq = 0;
// quest 派发过的 pid：活跃 + 近 15 分钟内完结的。external-exit 检测到这些 pid 时跳过
// （quest 已经直接通知过了，python-manager 的外部检测再报就是重复）。
const questPids = new Map(); // pid -> expireAt
const isQuestPid = (pid) => {
  const now = Date.now();
  for (const [p, exp] of questPids) if (exp < now) questPids.delete(p);
  return pid && questPids.has(Number(pid));
};
function dispatchJob(wsKey, node) {
  return new Promise(async (resolve) => {
    // 预检
    const pf = await preflight(node);
    if (pf) {
      appendEvent(wsKey, { t: 'node.preflight-failed', node: node.id, error: pf.error });
      if (!node.quiet) qqPush(`[❌ 预检失败] ${node.id}\n${pf.error.slice(0, 300)}`).catch(() => {});
      pushInbox({ node: node.id, verdict: 'preflight-failed' });
      resolve({ ok: false, error: 'preflight-failed' });
      return;
    }
    const jobId = `j-${++jobSeq}-${Date.now().toString(36)}`;
    const logTs = new Date().toISOString().replace(/[:.]/g, '-');
    const logFile = path.join(dirOf(wsKey), 'logs', `${node.id}-${logTs}.log`);
    const out = fs.openSync(logFile, 'a');
    const startedAt = Date.now();
    const child = spawn('cmd.exe', ['/c', node.command], { cwd: node.cwd || undefined, windowsHide: true });
    appendEvent(wsKey, { t: 'node.dispatched', node: node.id, jobId, pid: child.pid, logTs });
    questPids.set(child.pid, Date.now() + 24 * 3600 * 1000); // 活跃期先按 24h 登记
    // 派发即返回：不等 job 结束（HTTP 客户端不该被 70 分钟的训练挂住；结果走账本/收件箱/推送）
    resolve({ ok: true, jobId });

    // 超时护栏：timeout_seconds 显式指定，否则 expect_minutes × 2
    const timeoutMs = (node.timeoutSeconds > 0 ? node.timeoutSeconds : node.expectMinutes * 2 * 60) * 1000;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => {}); } catch {}
    }, timeoutMs);

    child.stdout.on('data', (d) => { try { fs.writeSync(out, d); } catch {} });
    child.stderr.on('data', (d) => { try { fs.writeSync(out, d); } catch {} });
    child.on('error', (err) => {
      clearTimeout(timer); try { fs.closeSync(out); } catch {}
      appendEvent(wsKey, { t: 'node.preflight-failed', node: node.id, error: `spawn 失败: ${err.message}` });
      resolve({ ok: false, error: err.message });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      try { fs.closeSync(out); } catch {}
      const runSec = Math.round((Date.now() - startedAt) / 1000);
      // 完结后保留 15 分钟（覆盖外部检测的确认延迟窗口），之后过期放行
      questPids.set(child.pid, Date.now() + 15 * 60 * 1000);
      appendEvent(wsKey, { t: 'node.exited', node: node.id, code, runSec });
      if (timedOut) {
        appendEvent(wsKey, { t: 'node.timeout', node: node.id, runSec });
        finishNode(wsKey, node, { verdict: 'timeout', via: `超过 ${Math.round(timeoutMs / 1000)}s 被杀`, logFile }, null, runSec);
      } else {
        const j = judge(node, code, runSec, logFile);
        appendEvent(wsKey, { t: 'node.judged', node: node.id, verdict: j.verdict, via: j.via, file: j.file || undefined });
        finishNode(wsKey, node, { ...j, logFile }, code, runSec);
      }
    });
  });
}

/** 判定后的收尾：worker 总结（P2）→ 账本终结 → QQ（P3）→ 收件箱。 */
async function finishNode(wsKey, node, j, _code, runSec) {
  let summary = '';
  if (CFG.workersEnabled !== false) {
    try { summary = await runWorker(wsKey, node, j, runSec); } catch (e) { log('worker 失败:', e.message); }
  }
  const ok = j.verdict === 'ok';
  appendEvent(wsKey, { t: ok ? 'node.completed' : 'node.failed', node: node.id, verdict: j.verdict });
  pushInbox({ node: node.id, verdict: j.verdict, summary });
  if (!node.quiet && CFG.qqNotify?.enabled) {
    const icon = ok ? '✅' : (j.verdict === 'timeout' ? '⏹' : '❌');
    qqPush(`[${icon} ${j.verdict}] ${node.id} · ${formatDur(runSec)}\n${summary || (j.error || j.via || '')}`.slice(0, 600)).catch(() => {});
  }
  // 依赖编排：成功续链 / 失败冻结下游 / 全线落定推收尾铃
  orchestrate(wsKey).catch(() => {});
  // WA 触发器：失败 + 节点声明 auto_fix + 预算未烧完 → 修复会话（最小修复+备份+重派）
  if (!ok && node.autoFix) {
    runFixer(wsKey, node, j, summary).catch((e) => log('fixer 异常:', e?.message));
  }
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
    qqPush(`[🛑 自动修复停手] ${node.id}：${node.fixBudget ?? 2} 次尝试后仍失败，等人工。
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
      try { return fs.readFileSync(j.logFile, 'utf8').slice(-4096); } catch { return ''; }
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
3. 改完对主脚本跑 py_compile 验证。
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
      qqPush(`[🔧 自动修复 ${giveup ? '放弃' : okFix ? '完成' : '未知'}] ${node.id} 第${attempt}次
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
    const bad = n.after.find((d) => ['failed', 'timeout', 'frozen'].includes(stOf(d)));
    if (bad && !evOf(n.id).includes('node.frozen')) {
      appendEvent(wsKey, { t: 'node.frozen', node: n.id, reason: `上游 ${bad} ${stOf(bad)}` });
      state.nodes[n.id] = state.nodes[n.id] ?? { status: 'pending', events: [] };
      state.nodes[n.id].status = 'frozen';
      state.nodes[n.id].detail = `上游 ${bad} ${stOf(bad)}`;
    }
  }

  for (const n of plan.nodes) {
    if (stOf(n.id) !== 'pending' || !n.after?.length) continue;
    if (!n.after.every((d) => stOf(d) === 'completed')) continue;
    if (n.manual) {
      if (!evOf(n.id).includes('node.ready')) {
        appendEvent(wsKey, { t: 'node.ready', node: n.id });
        pushInbox({ node: n.id, verdict: 'ready（等人工派发）' });
      }
      continue;
    }
    log('auto-dispatch:', n.id, '(after', n.after.join(','), ')');
    dispatchJob(wsKey, n).catch(() => {});
    break;
  }

  const allStopped = plan.nodes.every((n) => ['completed', 'failed', 'timeout', 'frozen'].includes(stOf(n.id)));
  if (allStopped && !(state.lineEvents ?? []).some((e) => e.t === 'line.concluded')) {
    const counts = {};
    for (const n of plan.nodes) counts[stOf(n.id)] = (counts[stOf(n.id)] ?? 0) + 1;
    const bad = plan.nodes.filter((n) => ['failed', 'timeout', 'frozen'].includes(stOf(n.id)));
    const parts = bad.map((n) => `${stOf(n.id) === 'frozen' ? '⛔' : stOf(n.id) === 'timeout' ? '⏹' : '❌'} ${n.id}（${state.nodes[n.id]?.verdict ? state.nodes[n.id].verdict + '/' : ''}${stOf(n.id)}）`);
    appendEvent(wsKey, { t: 'line.concluded', counts });
    if (CFG.qqNotify?.enabled) {
      qqPush(`[🏁 任务线结束] ${plan.meta.title || wsKey}\n${plan.nodes.length} 段：${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' / ')}${parts.length ? '\n' + parts.join('\n') : '\n全绿 ✅'}`.slice(0, 500)).catch(() => {});
    }
    pushInbox({ node: '(line)', verdict: 'concluded', summary: JSON.stringify(counts) });
  }
}

const formatDur = (s) => (s < 60 ? `${s}秒` : s < 3600 ? `${Math.floor(s / 60)}分${s % 60}秒` : `${Math.floor(s / 3600)}小时${Math.floor((s % 3600) / 60)}分`);

// ── QQ 推送（P3：直打 bridge console，零 bridge 改动）──────────────────
async function qqPush(message) {
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
      body: JSON.stringify({ userId: q.userId, message }),
      signal: ac.signal,
    });
  } catch (e) {
    log('qqPush 失败:', String(e?.message || e).slice(0, 120)); // 2026-09-08：静默吞错导致 15:20 漏推无从查起
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
      try { return fs.readFileSync(j.logFile, 'utf8').slice(-4096); } catch { return ''; }
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
const server = http.createServer(async (req, res) => {
  const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
  try {
    const u = new URL(req.url, 'http://localhost');
    if (req.headers['x-quest-token'] !== QUEST_TOKEN) return json(401, { error: 'unauthorized' });
    const ws = u.searchParams.get('ws') || '';
    const wsKey = wsKeyOf(ws);

    if (req.method === 'GET' && u.pathname === '/api/status') {
      const state = buildState(wsKey);
      const plan = state.plan ? parsePlan(state.plan) : { nodes: [] };
      const nodes = plan.nodes.map((n) => ({ id: n.id, ...(state.nodes[n.id] || { status: 'pending' }), quiet: n.quiet, expectMinutes: n.expectMinutes }));
      const unread = inbox.splice(0); // 取走即清
      return json(200, { plan: { workspace: ws, nodes }, unread, questVersion: '0.1.0' });
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
      const r = await dispatchJob(wsKey, node);
      return json(200, r);
    }
    if (req.method === 'GET' && u.pathname === '/api/log') {
      const node = u.searchParams.get('node') || '';
      const state = buildState(wsKey);
      const n = state.nodes[node];
      if (!n?.logTs) return json(404, { error: '无日志' });
      const dir = dirOf(wsKey);
      const files = fs.readdirSync(path.join(dir, 'logs')).filter((f) => f.startsWith(`${node}-`)).sort();
      const file = path.join(dir, 'logs', files[files.length - 1]);
      const tail = Number(u.searchParams.get('tail')) || 4096;
      const size = fs.statSync(file).size;
      const buf = Buffer.alloc(Math.min(tail, size));
      const fh = fs.openSync(file, 'r');
      fs.readSync(fh, buf, 0, buf.length, Math.max(0, size - tail));
      fs.closeSync(fh);
      return json(200, { file, log: buf.toString('utf8') });
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
});
