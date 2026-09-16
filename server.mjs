#!/usr/bin/env node
// quest 服务 —— 任务线编排核心（P1：账本+作业执行+预检+判定器；P2：worker 子会话；P3：QQ 推送）
//
// 字段说明与任务线格式：见 PLAN-TEMPLATE.md；通知出口与监督器：见 README.md
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
import { exportSessionArchive } from './session-export.mjs';
import { completeText, workerViaBackend, fixerViaBackend, describeBackends } from './backends.mjs';
import { sendText, sendImage, notifyKind, isRetryable } from './notify.mjs';
import { offerResume, markResumed } from './resume.mjs';
import { parseSuccessClaims, checkClaims } from './success.mjs';

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
  // 默认配置必须"开箱可用"：只留真正需要的键，且都指向通用默认值。
  // 通知出口默认关闭（provider 无关，配法见 README「通知出口」）——不预置任何 IM 桥路径。
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({
    port: 3110,
    // worker 总结会话要连的 DSH 地址（DSH 默认端口 3080）；token 见下
    dshBaseUrl: 'http://127.0.0.1:3080',
    dshToken: '',
    workerPreset: 'quest-worker',
    fixerPreset: 'quest-fixer',
    // 通知出口：off（默认）| bridge（任意 POST /api/send/private 的通知端）| webhook（任意 HTTP 端点）
    notify: { kind: 'off' },
    // 静默判定：账本安静这么多分钟且没有在跑的节点 → 推一条收敛通知（回答是不是真都完成了）
    quietMinutes: 10,
    // 工作区活跃度窗口（分钟）：最近这么多分钟内有文件被改 → 说明"有人正在改代码"
    wsActivityMinutes: 15,
  }, null, 2));
  console.log(`[quest] 已生成默认配置 ${CONFIG_PATH}（通知出口默认关闭，配法见 README「通知出口」）`);
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
// /mnt/c/Users/x（WSL 视角）与 C:\\Users\\x（Windows 视角）是同一个目录——
// 若不归一，同一条任务线会分裂成两个工作区（曾表现为"任务被吞"：quick 任务落在 /mnt/c 的 wsKey 下，
// 而主对话查的是 Windows 路径的 wsKey，看不见）。
const normalizeWs = (ws) => {
  let s = String(ws || '').trim();
  const m = s.match(/^\/mnt\/([a-zA-Z])(\/.*)?$/);
  if (m) s = m[1].toUpperCase() + ':' + (m[2] || '/');
  return s;
};
const wsKeyOf = (ws) => normalizeWs(ws).replace(/\\/g, '/').replace(/\/+$/, '').replace(/[:/]/g, (c) => (c === ':' ? '' : '-'));

function dirOf(wsKey) {
  const d = path.join(HOMEOverride, wsKey);
  fs.mkdirSync(path.join(d, 'logs'), { recursive: true });
  return d;
}

/** plan.md 解析：`---node: <id>---` 分节，字段 key: value，handoff: | 为多行块。 */
/**
 * 把用户/AI 写的节点 id 解析成真 id：支持唯一后缀或唯一片段（像 git 的短哈希）。
 * 返回 { id } 或 { error, matches }。2026-09-14：有人用短后缀取消，原样写进账本 → 冒出幽灵节点。
 */
function resolveNodeId(ids, wanted) {
  const w = String(wanted || '').trim();
  if (!w) return { error: '缺少 node' };
  if (ids.includes(w)) return { id: w };
  const hits = ids.filter((id) => id.endsWith(w) || id.includes(w));
  if (hits.length === 1) return { id: hits[0], resolvedFrom: w };
  if (hits.length > 1) return { error: `节点片段「${w}」不唯一，候选：${hits.slice(0, 5).join('、')}`, matches: hits.slice(0, 5) };
  return { error: `没有节点匹配「${w}」`, matches: [] };
}

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
      cur = { id: m[1], command: '', cwd: '', expectMinutes: 30, timeoutSeconds: 0, success: '', quiet: false, needsExecution: false, handoff: '', after: [], manual: false, autoFix: false, fixBudget: 2, when: '', watchLog: '', watchIntervalMinutes: 10, watchRules: [], maxLogMB: 0, pushImages: 2, shell: '', resumeOnBoot: undefined, freezeOn: '' };
      handoffMode = false;
      continue;
    }
    if (!cur) {
      const kv = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
      if (kv && ['workspace', 'title', 'shell', 'resume_on_boot', 'freeze_on'].includes(kv[1])) meta[kv[1]] = kv[2].trim();
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
      case 'shell': cur.shell = v.trim().toLowerCase() === 'wsl' ? 'wsl' : 'windows'; break;
      case 'resume_on_boot': cur.resumeOnBoot = v.trim() === 'true'; break; // 开机中断后允许一键续跑（默认关）
      case 'no_checkpoint': cur.noCheckpoint = v.trim() === 'true'; break; // 显式声明不需要断点（屏蔽第一二层提醒） // wsl = 在 WSL(Ubuntu) 里跑（bash 语法，Linux 路径）
      case 'freeze_on': cur.freezeOn = v.trim().toLowerCase() === 'hard-fail-only' ? 'hard-fail-only' : 'any-fail'; break; // ②c：只有真失败（崩溃/超时/取消）才冻结下游，suspect 放行
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
  for (const n of nodes) if (n.resumeOnBoot === undefined) n.resumeOnBoot = meta.resume_on_boot === 'true';
  // ②c freeze 策略继承：节点级 > plan 级 > any-fail（默认行为与旧版一致，老 plan 不受影响）
  for (const n of nodes) if (!n.freezeOn) n.freezeOn = meta.freeze_on === 'hard-fail-only' ? 'hard-fail-only' : 'any-fail';
  for (const n of nodes) {
    if (!n.command) errors.push(`节点 ${n.id} 缺 command`);
    if (!n.cwd) n.cwd = meta.workspace || '';
  }
  return { meta, nodes, errors };
}

/**
 * 覆盖前把旧 plan.md 存档到 <wsDir>/plans/（2026-09-14 用户需求：一次科研里会有很多个短流程 plan
 * ——生成数据/训练/后处理/评估/可视化——每次一份，做完就该能回看；而一个工作区只有一份 plan.md，
 * 不存档 = 覆盖即永久丢失依赖关系（箭头）与 handoff）。
 * 只存"有条目节点"的 plan：快速单发自动补的空壳不值一存。绝不覆盖已有存档（同一毫秒也加后缀）。
 */
function archivePlanIfNeeded(wsKey) {
  try {
    const dir = dirOf(wsKey);
    const f = path.join(dir, 'plan.md');
    if (!fs.existsSync(f)) return null;
    const md = fs.readFileSync(f, 'utf8');
    const parsed = parsePlan(md);
    if (!parsed.nodes.length) return null;
    const pd = path.join(dir, 'plans');
    fs.mkdirSync(pd, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const title = String(parsed.meta?.title || 'plan').replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'plan';
    let out = path.join(pd, `${ts}__${title}__${parsed.nodes.length}n.md`);
    for (let i = 2; fs.existsSync(out) && i < 50; i++) out = path.join(pd, `${ts}__${title}__${parsed.nodes.length}n-${i}.md`);
    fs.writeFileSync(out, md, 'utf8');
    return out;
  } catch (e) { log('存档 plan 失败:', e?.message); return null; }
}

/** 状态推导：从 ledger 事件流重建各节点当前状态。 */
function buildState(wsKey) {
  const dir = dirOf(wsKey);
  const state = { nodes: {}, updated: new Date().toISOString() };
  try { state.plan = fs.readFileSync(path.join(dir, 'plan.md'), 'utf8'); } catch { state.plan = null; }
  try {
    const lines = fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean);
    state.lineEvents = [];
    const declaredIds = new Set();
    if (state.plan) { try { for (const n0 of parsePlan(state.plan).nodes) declaredIds.add(n0.id); } catch {} }
    for (const l of lines) {
      let e; try { e = JSON.parse(l); } catch { continue; }
      if (!e.node) {
        state.lineEvents.push(e);
        // quest 自己的记账事件（line.quiet/line.concluded）不算"工作区活动"——否则静默通知
        // 一推、活动时钟立刻被自己刷新，状态又变回"不静默"（实测踩到过）。
        if (e.at && !['line.quiet', 'line.concluded', 'notify.converge'].includes(e.t)) state.lastLineEventAt = e.at;
        if (e.t === 'plan.created' || e.t === 'plan.reloaded') {
          for (const n2 of Object.values(state.nodes)) n2.fixCount = 0; // 新 plan = 新预算
        }
        // 收线留痕（/api/close-line）：控制台据此显示"这条线已收"，不必靠人去记
        if (e.t === 'plan.closed') { state.closedAt = e.at; state.closedReason = e.reason || ''; }
        continue;
      }
      // 只有"派发"事件才有资格新建节点。别的带 node 的事件（cancel.fallback、旧版写入的短后缀 id、
      // 任何异常/手写行）只能更新**已存在**的节点——否则会凭空长出 pending 幽灵节点：它永不终结，
      // 于是 line.active 永远非 0 ⇒ 收敛信号永不触发、控制台明细多出重复条目。
      // 2026-09-14 实测：两条旧版短 id cancel.fallback 让真实在跑 1 个虚报成 active=3。
      // 例外：**plan.md 里声明过的节点**天然"已知"——冻结/等待派发的节点（node.frozen/node.ready…）
      // 没有派发记录，靠这些事件更新状态，不能当幽灵丢掉。
      const CREATES_NODE = e.t === 'node.dispatched' || e.t === 'quick.dispatched' || declaredIds.has(e.node);
      const n = state.nodes[e.node] ?? (CREATES_NODE ? (state.nodes[e.node] = { status: 'pending', events: [] }) : null);
      if (!n) { if (e.at) state.lastLineEventAt = e.at; continue; }   // 认不出所属节点的历史事件：只当活动，不建节点
      n.events.push(e.t);
      n.lastEventAt = e.at;
      // 终态时间只认**第一次**（原始跑完的时刻）。重判会补一条 node.completed，若让它覆盖终点时间，
      // 控制台就会把"重判时刻"当"完成时刻"显示（2026-09-14：4 个昨夜跑完的节点显示成今早 10:35）。
      if (!n.endedAt && ['node.completed', 'node.failed', 'node.timeout', 'node.frozen', 'node.cancelled', 'node.skipped'].includes(e.t)) n.endedAt = e.at;
      if (e.t === 'node.rejudged') n.rejudgedAt = e.at;
      if (e.t === 'node.dispatched') { n.status = 'running'; n.jobId = e.jobId; n.pid = e.pid; n.logTs = e.logTs; n.startedAt = e.at; n.verdict = undefined; n.via = undefined; n.detail = undefined; n.summary = undefined; }
      if (e.t === 'fix.attempt') { n.fixCount = (n.fixCount ?? 0) + 1; n.fixing = true; }
      if (e.t === 'fix.reported') { n.lastFix = e.changes; n.fixing = false; }
      if (e.t === 'fix.stopped') { n.fixing = false; n.fixStopped = e.reason; }
      if (e.t === 'node.preflight-failed') { n.status = 'failed'; n.verdict = 'preflight-failed'; n.detail = e.error; }
      if (e.t === 'node.exited') { n.exitCode = e.code; n.runSeconds = e.runSec; }
      if (e.t === 'node.judged') { n.verdict = e.verdict; n.via = e.via; n.file = e.file || null; if (e.detail) n.judgeDetail = e.detail; }
      if (e.t === 'worker.reported') { n.summary = e.summary; }
      if (e.t === 'node.completed') { n.status = 'completed'; n.completedAt = e.at; }
      if (e.t === 'node.failed') n.status = 'failed';
      if (e.t === 'node.timeout') { n.status = 'timeout'; n.verdict = 'timeout'; n.via = e.via || '超时被杀'; }
      if (e.t === 'node.frozen') { n.status = 'frozen'; n.detail = e.reason; }
      if (e.t === 'node.ready') { n.status = 'ready'; }
      if (e.t === 'node.unfrozen') { n.status = 'pending'; n.verdict = undefined; n.via = undefined; n.detail = undefined; }
      if (e.t === 'node.resumed') { n.resumeCount = (n.resumeCount ?? 0) + 1; }
      if (e.t === 'node.interrupted') n.interrupted = true;        // 幂等：已提示过就不再提示
      if (e.t === 'node.dispatched') n.interrupted = false;         // 重派后重新允许提示
      if (e.t === 'node.cancelled') { n.status = 'cancelled'; n.verdict = 'cancelled'; n.detail = e.reason; }
      if (e.t === 'node.skipped') { n.status = 'skipped'; n.detail = e.reason; }
      if (e.t === 'node.metrics') { n.metrics = e.metrics; }
      if (e.t === 'watch.warn') { n.watchWarns = (n.watchWarns ?? 0) + 1; }
      if (e.t === 'watch.kill') { n.watchKilled = e.rule; }
      // ②c：上游只是"疑似"被放行——不阻塞，但要在 progress.md 里留痕，AI 扫一眼就知道该查谁
      if (e.t === 'node.soft-pass') { n.softPass = e.upstream || []; }
      // quick 单发的车道/命令要从账本恢复：重启对账时若不知道它是 WSL 车道，会按 Windows 去找 pid
      // → 明明还在跑的 WSL 任务被判"进程已消失"（2026-09-14 实测踩到，两个假失败）
      if (e.t === 'quick.dispatched') {
        n.shell = e.shell || 'windows';
        if (e.cwd) n.cwd = e.cwd;
        if (e.command) n.command = e.command;
        if (e.expectMinutes != null) n.expectMinutes = e.expectMinutes;
        if (e.success) n.success = e.success;
      }
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
// quest 自己的台账就写在任务工作区里（progress.md / research-state.md / plan.md）——它们不是任务产出。
// 不排除的后果实测过：节点运行期间任何一次 /api/status 刷新都会重写 progress.md，
// 于是一个零产物的节点也被判成 ok/artifact-fresh（假 ok，会掩盖真失败）。
const QUEST_OWN_FILES = new Set(['progress.md', 'research-state.md', 'plan.md']);

/** 从日志尾恢复真实退出码（WSL 包装器写的 EXIT_CODE:<n>）；拿不到返回 null。 */
function recoverExitCode(logFile) {
  try {
    const m = readTail(logFile, 2048).match(/EXIT_CODE:\s*(\d+)/);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

function judge(node, exitCode, runSec, logFile, startedAtMs = null, endedAtMs = null) {
  // 超时由外层标记，这里只判退出路径
  if (exitCode !== 0) {
    if (runSec < 60) return { verdict: 'startup-failed', via: 'fast-exit' };
    return { verdict: 'crashed', via: 'nonzero-exit' };
  }
  // 产物扫描：一次收集，声明判据与通用兜底共用（原来只有"取最新一个"的用法）
  const dirs = node.shell === 'wsl'
    ? [node.cwd, `${node.cwd}/out`, `${node.cwd}/logs`, `${node.cwd}/output`, `${node.cwd}/results`, `${node.cwd}/runs`].filter(Boolean).map(hostPathFor)
    : [node.cwd, path.join(node.cwd, 'out'), path.join(node.cwd, 'logs'), path.join(node.cwd, 'output'), path.join(node.cwd, 'results'), path.join(node.cwd, 'runs')];
  const artifacts = [];
  for (const d of dirs) {
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const en of entries) {
      if (!en.isFile()) continue;
      const lower = en.name.toLowerCase();
      if (QUEST_OWN_FILES.has(lower)) continue; // quest 台账不算产物
      if (![...TEXT_EXTS, ...ARTIFACT_EXTS].some((x) => lower.endsWith(x))) continue;
      try { const f = path.join(d, en.name); artifacts.push({ name: en.name, file: f, mtimeMs: fs.statSync(f).mtimeMs }); } catch {}
    }
  }
  // startMs = 本次运行的起点。+2s 容文件系统时间戳粒度（快任务 runSec 舍入到 0 时避免自竞争）。
  // 重算历史判定时必须传 startedAtMs 锚到**当时**——否则用今天算窗口，旧产物会被判成不新鲜（踩过）。
  const startMs = startedAtMs != null ? startedAtMs - 2000 : Date.now() - Math.max(runSec, 1) * 1000 - 2000;
  // endedAtMs 只在"重算历史判定"时给：把产物新鲜度限制在该节点**自己的运行窗口**内。
  // 不设上界的话，后来别的运行产出的同名文件会满足老节点的判据 → 把被杀掉的任务也翻成成功（假阳性）。
  const endMs = endedAtMs != null ? endedAtMs + 120000 : Infinity;
  const tailLc = (logFile ? readTail(logFile, 4096) : '').toLowerCase();

  // ① 节点自己声明的成功判据优先（plan 的 success: 字段）——AI 写下的硬约定压过通用关键词表。
  //    声明了判据却没满足 → suspect（不是 failed）：可能只是没达到预期，交给人/AI 判。
  //    解析不出任何可校验条件（纯白话）时 total=0，自动退回下面的通用路径，零回归。
  const claims = parseSuccessClaims(node.success);
  if (claims.total > 0) {
    const r = checkClaims(claims, { tail: tailLc, artifacts: artifacts.filter((f) => f.mtimeMs <= endMs), metrics: logFile ? extractMetrics(logFile) : {}, startMs });
    if (r.failures.length) {
      return { verdict: 'suspect', via: 'success-claim-failed', detail: r.failures.map((f) => f.why).join('；').slice(0, 300), claims: r };
    }
    return {
      verdict: 'ok',
      via: r.unchecked.length ? `success-declared（未核实:${r.unchecked.map((u) => u.what).join(',')}）` : `success-declared（${r.checked.length} 项）`,
      claims: r,
    };
  }

  // ② 未声明判据：与旧版完全一致的通用兜底
  if (FINISH_KEYWORDS.some((k) => tailLc.includes(k.toLowerCase()))) return { verdict: 'ok', via: 'finish-keyword' };
  // WSL 节点的包装器会在日志尾写 EXIT_CODE:<n>——那是真实退出码，比「产物新鲜」更硬
  const ec = tailLc.match(/exit_code:\s*(\d+)/);
  if (ec) {
    if (ec[1] === '0') return { verdict: 'ok', via: 'exit-code-0' };
    return { verdict: 'crashed', via: `exit-code-${ec[1]}` };
  }
  const latest = artifacts.filter((f) => f.mtimeMs <= endMs).reduce((best, f) => (!best || f.mtimeMs > best.mtimeMs ? f : best), null);
  if (latest && latest.mtimeMs > Date.now() - 10 * 60 * 1000 && latest.mtimeMs > startMs) {
    return { verdict: 'ok', via: 'artifact-fresh', file: latest.file };
  }
  if (latest && latest.mtimeMs > startMs) return { verdict: 'suspect', via: 'no-keyword', file: latest.file };
  return { verdict: 'suspect', via: 'no-output' };
}

// ── 预检（语法错误拦截在运行前）────────────────────────────────────────
/** 命令与 shell 车道不匹配时给出可操作的报错（替代含糊的 spawn ENOENT）。 */
function shellMismatchHint(node) {
  const first = String(node.command || '').trim().split(/\s+/)[0] || '';
  const looksLikeLinuxPath = first.startsWith('/') && !first.startsWith('//');
  const isWsl = node.shell === 'wsl';
  if (looksLikeLinuxPath && !isWsl) {
    return `命令用的是 Linux 路径（${first}），但该节点没有声明 WSL 车道。` +
      '请二选一：① 加 shell: "wsl"（并在 plan/quest_run 里把 cwd 也写成 Linux 路径）；' +
      '② 改用 Windows 路径的解释器（如 E:\\python_env\\pinn\\Scripts\\python.exe）。';
  }
  if (!looksLikeLinuxPath && isWsl && /^[A-Za-z]:[\\/]/.test(first)) {
    return `节点声明了 WSL 车道，但解释器是 Windows 路径（${first}）。WSL 内应使用 Linux 路径（如 /home/<user>/envs/ml/bin/python）。`;
  }
  // cwd 的车道不匹配（2026-09-12 补）：只查命令首 token 会漏掉"声明了 wsl 但 cwd 忘改"，
  // 那种情况 WSL 里 cd 失败，报出来的是 bash 原文而不是该怎么做。
  const cwdStr = String(node.cwd || '');
  if (isWsl && (/^[A-Za-z]:[\\/]/.test(cwdStr) || cwdStr.startsWith('\\\\'))) {
    const drive = cwdStr.slice(0, 1).toLowerCase();
    const rest = cwdStr.slice(2).replace(/^[\\/]+/, '').replace(/\\/g, '/');
    return `节点声明了 WSL 车道，但 cwd 是 Windows 路径（${cwdStr}）。WSL 里要用 Linux 路径——Windows 盘上的目录在 WSL 下是 /mnt/<盘符小写>/...，本例应写 /mnt/${drive}/${rest}。`;
  }
  if (!isWsl && /^\/(?!\/)/.test(cwdStr)) {
    return `节点没有声明 WSL 车道，但 cwd 是 Linux 路径（${cwdStr}）。Windows 车道要用 Windows 路径（C:\\...），或给该节点加 shell: "wsl"（命令也用 Linux 解释器）。`;
  }
  return null;
}

/**
 * 车道绕行检测：Windows 车道的命令手工包了 wsl（`wsl -d Ubuntu -- ...`）。
 * 能跑，但失去了 shell: wsl 的全部保障——崩溃存活（systemd 认养 + keepalive）、
 * 重启后按单元名认领、不经 cmd.exe 的引号安全。所以给一次明确提醒，但不阻断。
 */
function laneBypassWarning(node) {
  if (node.shell === 'wsl') return null;
  const first = String(node.command || '').trim().split(/\s+/)[0].replace(/^"|"$/g, '');
  const base = first.split(/[\\/]/).pop().toLowerCase();
  if (base !== 'wsl' && base !== 'wsl.exe') return null;
  return `手工包装了 wsl（${first}）：命令能跑，但**失去 shell: wsl 车道的保障**——` +
    'quest 崩溃时该负载会随会话被清理（不会被 systemd 认养）、重启后无法按单元认领、且引号要过 cmd.exe。' +
    '建议改用 shell: "wsl"（命令直接写 bash 语句、cwd 用 Linux 路径）。';
}

function preflight(node) {
  const mism = shellMismatchHint(node);
  if (mism) return Promise.resolve({ error: mism });
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
    // 车道从账本状态恢复（buildState 从 quick.dispatched 记了 shell）——原来硬编码 windows，
    // 会把 WSL 车道的快速单发在控制台/进度里显示成 Windows（与对账那个 bug 同源，这里只是展示）
    .map((id) => ({ id, shell: state.nodes[id]?.shell || 'windows', quiet: false, expectMinutes: state.nodes[id]?.expectMinutes ?? 0 }));
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
    {
      const act = lineActivity(state);
      lines.push('', act.active.length
        ? `> 状态：**进行中**（${act.active.length} 个在跑｜最近动作 ${act.idleMinutes ?? '-'} 分钟前）`
        : `> 状态：**静默**（没有在跑的节点｜最近动作 ${act.idleMinutes ?? '-'} 分钟前｜共 ${act.nodes.length} 个）`);
      if (act.ws) lines.push(act.ws.recent
        ? `> 工作区：最近 ${act.ws.windowMinutes} 分钟有 **${act.ws.recent} 个文件**被改（最新 ${act.ws.latest?.name}，${act.ws.latest?.minutes} 分钟前）——有人正在改代码`
        : `> 工作区：最近 ${act.ws.windowMinutes} 分钟无文件改动`);
      if (act.dsh) lines.push(act.dsh.running
        ? `> 子对话：**${act.dsh.running} 个会话在跑**（本工作区共 ${act.dsh.total} 个）——AI 正在干活`
        : `> 子对话：没有会话在跑（本工作区共 ${act.dsh.total} 个）`);
    }
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
      if (st.softPass?.length) l += ` · ⚠️上游疑似放行（${st.softPass.join(',')}）——建议用探针查证`;
      if (st.judgeDetail && st.status !== 'completed') l += ` · 判据未满足：${String(st.judgeDetail).slice(0, 100)}`;
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
    if (!samples.length) return {};
    const s = samples.slice(-100); // 防超长
    const last = s[s.length - 1];
    const out = { loss_first: r4(s[0]), loss_last: r4(last), loss_min: r4(Math.min(...s)) };
    // 单样本也能给绝对值（阈值判据/短评估日志常见）；斜率与平台才需要更多样本
    if (s.length < 2) return out;
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

// ── 断点三层（2026-09-10）：防忘（派发前静态扫描）/ 防假（运行中盯档案）/ 防重跑（重派自动带存档指针）──
const CK_EXTS = /\.(pt|ckpt|pth)$/i;
const CK_PAT = /torch\.save|save_checkpoint|state_dict|checkpoint|resume_from|QUEST_RESUME_FROM/i;
const uncToLinux = (p) => {
  const s = String(p);
  // 原生盘路径（我们为了让 Windows 侧能读，把 /mnt/c/… 换成了 C:\…）要能换回 Linux 视图
  const m = s.match(/^([A-Za-z]):[\\/]?(.*)$/);
  if (m) return `/mnt/${m[1].toLowerCase()}/${(m[2] || '').replace(/\\/g, '/')}`;
  return s.replace(/^\/\/wsl\$\/[^/]+/i, '');
};

/**
 * WSL 的 Linux 路径 → Windows 侧**真的能读**的路径。
 * 2026-09-14 修复：\wsl$\<distro>\mnt\c\… 对 drvfs 是 EPERM（drvfs 不经 9p 共享暴露），
 * 而 /mnt/<盘> 在 Windows 侧本来就是原生 <盘>:\ —— 原生路径快且可靠；真 Linux 路径（/home/…）
 * 才走 UNC。踩坑后果：cwd 为 /mnt/c/… 的 WSL 节点，产物扫描全空 → 误判"未找到产物/无输出"，
 * 断点续跑找不到存档、图片不推送、静态检查读不到脚本。
 */
const hostPathFor = (linuxPath) => {
  const s = String(linuxPath || '');
  const m = s.match(/^\/mnt\/([a-zA-Z])(\/.*)?$/);
  if (m) return `${m[1].toUpperCase()}:${(m[2] || '/').replace(/\//g, '\\')}`;
  return wslUnc(s);
};

/** 找 dir 里最近 N 天内最新的存档文件（dir 为 Windows 路径或 UNC），返回 {file, mtimeMs} 或 null */
function findLatestCheckpoint(dir, withinDays = 7) {
  try {
    const cutoff = Date.now() - withinDays * 86400000;
    let best = null;
    for (const d of [dir, path.join(dir, 'out'), path.join(dir, 'checkpoints'), path.join(dir, 'runs')]) {
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (!e.isFile() || !CK_EXTS.test(e.name)) continue;
        try {
          const st = fs.statSync(path.join(d, e.name));
          if (st.mtimeMs > cutoff && st.size > 0 && (!best || st.mtimeMs > best.mtimeMs)) best = { file: path.join(d, e.name), mtimeMs: st.mtimeMs };
        } catch {}
      }
    }
    return best;
  } catch { return null; }
}

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
// 单条命令的长度上限：超过就明确拒绝，绝不静默截断。
// 2026-09-14 事故：一条 5 段流水命令被 .slice(0,500) 悄悄截断，尾部只剩 "; /"，
// bash 退出 126 → 判定 crashed → 12 分钟的有效结果被判失败，且事后无法从账本看出命令被动过。
const CMD_MAX_CHARS = 8000;
const activeJobs = new Map();
function dispatchJob(wsKey, node, body = {}) {
  return new Promise(async (resolve) => {
    // 预检
    const pf = await preflight(node);
    if (pf) {
      appendEvent(wsKey, { t: 'node.preflight-failed', node: node.id, error: pf.error });
      if (!node.quiet) qqPush(wsKey, `[❌ 预检失败] ${node.id}\n${pf.error.slice(0, 300)}`).catch(() => {});
      pushInbox({ node: node.id, verdict: 'preflight-failed' });
      resolve({ ok: false, kind: 'preflight-failed', error: pf.error });
      return;
    }
    // 断点第一层（防忘）：长任务脚本无存档模式 → 警告不拦截（拦截会冻结无人值守任务线）
    if ((node.expectMinutes >= 15) && !node.noCheckpoint) {
      const pyFile = String(node.command || '').match(/\b([\w./\:-]+\.py)\b/)?.[1];
      if (pyFile) {
        const scriptPath = node.shell === 'wsl'
          ? hostPathFor((node.cwd || `/home/${WSL_USER()}`) + '/' + pyFile.replace(/^\/+/, ''))
          : path.isAbsolute(pyFile) ? pyFile : path.join(node.cwd || '.', pyFile);
        try {
          if (!CK_PAT.test(readTail(scriptPath, 262144))) {
            appendEvent(wsKey, { t: 'checkpoint.warn', node: node.id, why: '脚本未见存档模式' });
            pushInbox({ node: node.id, verdict: 'no-checkpoint', detail: '脚本无存档模式：请按约定补断点（启动读 QUEST_RESUME_FROM、固定路径 torch.save），或确认无需断点' });
            if (!node.quiet) qqPush(wsKey, `[⚠️ 无断点提醒] ${node.id} 预计 ${node.expectMinutes} 分钟，但脚本没扫到 torch.save/checkpoint 模式——中途崩了要从零跑。确认无碍请在节点加 no_checkpoint: true`).catch(() => {});
          }
        } catch {}
      }
    }
    // 车道绕行提醒（不阻断）：能跑，但保障没了——让人和 AI 都知道
    try {
      const bypass = laneBypassWarning(node);
      if (bypass) {
        appendEvent(wsKey, { t: 'node.lane-bypass', node: node.id, why: bypass.slice(0, 200) });
        pushInbox({ node: node.id, verdict: 'lane-bypass', detail: bypass });
        if (!node.quiet) qqPush(wsKey, `[⚠️ 车道绕行] ${node.id}` + String.fromCharCode(10) + bypass).catch(() => {});
      }
    } catch (e) { log('车道检测失败:', e?.message); }
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
      const ckL = findLatestCheckpoint(hostPathFor(node.cwd || `/home/${WSL_USER()}`));
      const resumeExport = ckL ? `export QUEST_RESUME_FROM=${shq(uncToLinux(ckL.file))}; ` : '';
      const svcCmd = `${resumeExport}exec >> ${shq(linuxLog)} 2>&1; cd ${shq(node.cwd || `/home/${WSL_USER()}`)} 2>/dev/null || { echo 'cd 失败' >> ${shq(linuxLog)}; echo EXIT_CODE:111; exit 0; }; ${node.command}; ec=\$?; echo EXIT_CODE:\$ec`;
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
      // 断点第三层（防重跑）：自动找最近存档塞进 QUEST_RESUME_FROM（脚本按约定读它续跑）
      const ckW = findLatestCheckpoint(node.cwd || '.');
      child = spawn('cmd.exe', ['/c', node.command], { cwd: node.cwd || undefined, windowsHide: true, stdio: ['ignore', job.outFd, job.outFd], env: ckW ? { ...process.env, QUEST_RESUME_FROM: ckW.file } : process.env });
    }
    appendEvent(wsKey, { t: 'node.dispatched', node: node.id, jobId, pid: child.pid, logTs, dispatchedBy: body.dispatchedBy || undefined });   // 派发者会话（失败上报点名回它）
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
      // 断点第二层（防假）：长任务 20 分钟内无新存档 → 提醒一次（存档路径写错/未生效）
      if (!job.ckWarned && node.expectMinutes >= 20 && !node.noCheckpoint && Date.now() - startedAt > 20 * 60000) {
        const latest = findLatestCheckpoint(node.shell === 'wsl' ? hostPathFor(node.cwd || '') : node.cwd || '');
        if (!latest || latest.mtimeMs < startedAt) {
          job.ckWarned = true;
          appendEvent(wsKey, { t: 'checkpoint.stale', node: node.id });
          pushInbox({ node: node.id, verdict: 'stale-checkpoint', detail: '运行期间无新存档文件：检查存档路径是否写错或条件未触发' });
          if (!node.quiet) qqPush(wsKey, `[⚠️ 存档可疑] ${node.id} 已跑 ${Math.round((Date.now() - startedAt) / 60000)} 分钟，运行期间没有任何新 checkpoint 文件——存档可能写错路径或没触发`).catch(() => {});
        }
      }
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
    if (!node.quiet && notifyKind(CFG) !== 'off') qqPush(wsKey, `[🛑 人工终止] ${node.id} · 已跑 ${formatDur(runSec)}\n原因：${job.cancelledByHuman}\n（不触发自动修复）`.slice(0, 400)).catch(() => {});
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
    // 认领的作业拿不到 waitpid 的退出码——但 WSL 包装器把真实码写进了日志（EXIT_CODE:<n>）。
    // 先试着恢复：拿得到就用它，别一律标"退出码未知"（那行字会让人以为判定不可信）。
    let codeEff = code;
    if (codeEff == null && logFile) { try { const rc = recoverExitCode(logFile); if (rc != null) codeEff = rc; } catch {} }
    let j;
    try { j = judge(node, codeEff == null ? 0 : codeEff, runSec, logFile); }
    catch (e) { j = { verdict: 'suspect', via: 'judge-error', detail: String(e && e.message || e).slice(0, 200) }; log('判定器异常:', e && e.message); }
    if (codeEff == null) j.via = `${j.via}（退出码未知：quest 重启后再认领，日志里也没写 EXIT_CODE）`;
    appendEvent(wsKey, { t: 'node.judged', node: node.id, verdict: j.verdict, via: j.via, file: j.file || undefined, ...(j.detail ? { detail: j.detail } : {}) });
    finishNode(wsKey, node, { ...j, logFile }, codeEff, runSec, startedAt);
  }
}

/**
 * 第 2 级·失败上报（2026-09-16）：节点失败（且没有 auto_fix 修复会话接手）时，
 * 给本工作区**最新的会话**（通常是派发任务的主对话）排一条指针式短讯。
 * 为什么需要：QQ 通知只到用户手机；派发任务的 AI 若收不到失败，就永远蒙在鼓里（除非主动拉）。
 * 防轰炸：逐工作区冷却（默认 10 分钟，config notify.escalate.cooldownMin）；消息只带指针不带日志。
 * queue 语义：目标忙则排队，不打断当前回合。默认开（notify.escalate.enabled=false 可关）。
 */
async function maybeNotifyFailure(wsKey, node, j, summary) {
  const ne = CFG.notify?.escalate;
  if (ne && ne.enabled === false) return;
  const cooldownMs = Math.max(1, Number(ne?.cooldownMin) || 10) * 60000;
  // 冷却判据直接读账本原文：notify.escalate 带着 node 字段，buildState 会把它归进节点事件
  // （lineEvents 查不到——测试②正是抓出这个），扫原文最稳。
  let lastEscAt = 0;
  try {
    const raw = fs.readFileSync(path.join(dirOf(wsKey), 'ledger.jsonl'), 'utf8').trim().split('\n');
    for (let i = raw.length - 1; i >= 0; i--) {
      let ev; try { ev = JSON.parse(raw[i]); } catch { continue; }
      if (ev.t === 'notify.escalate') { lastEscAt = tsOf(ev.at); break; }
    }
  } catch {}
  if (lastEscAt && Date.now() - lastEscAt < cooldownMs) return;   // 冷却内：这批失败靠 QQ/收敛汇报兜底
  const st = buildState(wsKey);
  const wsPath = (() => { try { return parsePlan(st.plan || '').meta?.workspace || ''; } catch { return ''; } })();
  try {
    const { NodeApiClient } = await import('./lib/dsh-client-v2.mjs');
    const api = new NodeApiClient(CFG.dshBaseUrl, 30000, { token: CFG.dshToken || undefined, tokenLog: CFG.dshTokenLog || undefined });
    // 目标：本工作区最新会话（queue；没有则放弃——不值得为一条失败上报新开会话）
    const lr = await api.sessions.list({});
    if (!lr.result.ok) return;
    let key; try { key = wsKeyOf(wsPath); } catch { key = ''; }
    const mine = (lr.result.value?.items ?? []).filter((x) => { try { return wsKeyOf(String(x.cwd ?? '')) === key; } catch { return false; } });
    if (!mine.length) return;
    // 定向优先级（2026-09-16 防双重修改）：①账本里记录的派发者会话（点名回它——派发者若是子对话，
    // 也只回它，绝不扩散到主对话）；②没有记录（旧节点/插件未升级）才退回"最新会话"启发式。
    let by = '';
    try {
      const raw = fs.readFileSync(path.join(dirOf(wsKey), 'ledger.jsonl'), 'utf8').trim().split('\n');
      for (let i = raw.length - 1; i >= 0; i--) {
        let ev; try { ev = JSON.parse(raw[i]); } catch { continue; }
        if (ev.node === node.id && (ev.t === 'node.dispatched' || ev.t === 'quick.dispatched') && ev.dispatchedBy) { by = String(ev.dispatchedBy); break; }
      }
    } catch {}
    let sid = by;
    if (!sid || !mine.some((x) => String(x.sessionId) === sid)) {
      sid = String(mine.reduce((a, c) => (Number(c.updatedAt || 0) >= Number(a.updatedAt || 0) ? c : a), mine[0]).sessionId);
    }
    await api.sessions.prompt({
      sessionId: sid, mode: 'queue',
      content: [{ type: 'text', text: [
        `❌【失败上报】节点 ${node.id} 判定 ${j.verdict}（${j.via || '无判定路径'}）${runSecText(j)}`,
        String(summary || j.detail || '').slice(0, 200) || '（无摘要）',
        '详情：quest_log 读该节点日志尾；判据/产物情况见 quest_status。',
        by ? '你是本节点的派发者：定位修复后 quest_dispatch 重派。' : '如果你是派发者：定位修复后 quest_dispatch 重派；与本线无关请忽略本消息。',
      ].join('\n') }],
    });
    appendEvent(wsKey, { t: 'notify.escalate', node: node.id, verdict: j.verdict, sessionId: sid, dispatchedBy: by || undefined });
    log(`notify.escalate ${wsKey}: ${node.id} → ${sid}`);
  } catch (e) {
    appendEvent(wsKey, { t: 'notify.escalate', node: node.id, error: String(e?.message || e).slice(0, 140) });
    log('notify.escalate 失败:', e?.message);
  }
}
const runSecText = (j) => (j.runSec != null ? ` · 跑了 ${Math.round(j.runSec)}s` : '');

/** 判定后的收尾：worker 总结（P2）→ 账本终结 → QQ（P3）→ 收件箱。 */
async function finishNode(wsKey, node, j, _code, runSec, startedAt = Date.now() - runSec * 1000) {
  let summary = '';
  if (CFG.workersEnabled !== false) {
    try { summary = await runWorker(wsKey, node, j, runSec); } catch (e) { log('worker 失败:', e.message); }
  }
  const ok = j.verdict === 'ok';
  try { appendEvent(wsKey, { t: ok ? 'node.completed' : 'node.failed', node: node.id, verdict: j.verdict }); } catch (e) { log('落账本失败:', e?.message); }
  // 第 2 级·失败上报（2026-09-16 用户定稿）：失败要报告给派发它的主对话——否则派发者永远蒙在鼓里。
  // 指针式短讯（不带日志）+ 冷却防轰炸；目标=本工作区最新会话（queue 语义，忙则等）。auto_fix 已接手的跳过（修复者自己知道）。
  if (!ok && !node.quiet && !node.autoFix) maybeNotifyFailure(wsKey, node, j, summary).catch((e) => log('失败上报异常:', e?.message));
  try { pushInbox({ node: node.id, verdict: j.verdict, summary }); } catch {}
  if (!node.quiet && !node.__suppressFinishPush && notifyKind(CFG) !== 'off') {
    const icon = ok ? '✅' : (j.verdict === 'timeout' ? '⏹' : '❌');
    qqPush(wsKey, `[${icon} ${j.verdict}] ${node.id} · ${formatDur(runSec)}\n${summary || [j.via, j.detail].filter(Boolean).join(' · ') || j.error || ''}`.slice(0, 600)).catch((e) => log('qqPush 异常:', e?.message));
  }
  try { writeProgress(wsKey); } catch (e) { log('writeProgress 失败:', e?.message); }
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
  const dir = node.shell === 'wsl' ? hostPathFor(node.cwd) : node.cwd; // WSL 节点：/mnt/<盘> 用原生盘路径，其余走 UNC
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
    // 判"WSL 作业是否结束"要用两个独立信号，任一表示"还在跑"就不结案：
    //   ① 日志尾没有 EXIT_CODE:<n>（包装器最后写它，是"跑完了"的权威信号）
    //   ② systemd 单元仍 active
    // 2026-09-14 事故：重启对账在进程起来约 9 秒后就问一次 is-active，而单元可能还没被
    // systemd-run 建出来（或 VM 刚醒）→"问不到"被当成"死了"→ 明明还在跑的任务被判 suspect
    // （实测：75 秒后日志写着"训练完成 / EXIT_CODE:0"、产物也落盘，却已经判了 failed）。
    // 教训与 DSH 看门狗那次一样：**必须把"问不到"和"确实不活"分开**。
    const finishedByLog = () => /EXIT_CODE:\s*\d+/.test(readTail(logFile, 2048));
    const finished0 = finishedByLog();
    let alive = finished0 ? false : await wslUnitActive(unit);
    if (!finished0 && !alive) {
      for (let i = 0; i < 3 && !alive; i++) { // 宽限期：单元/VM 可能还在起
        await new Promise((r) => setTimeout(r, 5000));
        if (finishedByLog()) break;
        alive = await wslUnitActive(unit);
      }
    }
    const finished = finished0 || finishedByLog();
    if (finished || !alive) {
      appendEvent(wsKey, { t: 'node.readopted', node: node.id, result: 'gone-wsl' });
      const runSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      const metrics = extractMetrics(logFile);
      if (Object.keys(metrics).length) appendEvent(wsKey, { t: 'node.metrics', node: node.id, metrics });
      const recovered = recoverExitCode(logFile);
    const j = judge(node, recovered == null ? 0 : recovered, runSec, logFile);
      j.via = `${j.via}（quest 重启期间${finished ? '作业已结束，按日志退出码/产物判定' : 'WSL 进程已消失，按产物/关键词判定'}）`;
      try {
              node.__startedAt = n.startedAt;
              if (await offerResume(wsKey, node, j, n.resumeCount, n.interrupted, { cfg: CFG, appendEvent, qqPush, pushInbox, findLatestCheckpoint, wslUnc, log })) node.__suppressFinishPush = true;
            } catch (e) { log('续跑检测失败:', e?.message); }
      appendEvent(wsKey, { t: 'node.judged', node: node.id, verdict: j.verdict, via: j.via, file: j.file || undefined, ...(j.detail ? { detail: j.detail } : {}) });
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
      // 盯梢判"还在跑"同样要两个信号：日志没有终标记 **且** 单元活着 → 继续等；
      // 否则（日志写了 EXIT_CODE，或单元确实不在了）才结案。
      if (!finishedByLog() && (await wslUnitActive(unit))) return;
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
    const recovered = recoverExitCode(logFile);
    const j = judge(node, recovered == null ? 0 : recovered, runSec, logFile);
    j.via = `${j.via}（quest 重启期间进程已消失，按产物/关键词判定）`;
    try {
              node.__startedAt = n.startedAt;
              if (await offerResume(wsKey, node, j, n.resumeCount, n.interrupted, { cfg: CFG, appendEvent, qqPush, pushInbox, findLatestCheckpoint, wslUnc, log })) node.__suppressFinishPush = true;
            } catch (e) { log('续跑检测失败:', e?.message); }
    appendEvent(wsKey, { t: 'node.judged', node: node.id, verdict: j.verdict, via: j.via, file: j.file || undefined, ...(j.detail ? { detail: j.detail } : {}) });
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
  // 可插拔后端（v0.5）：非 dsh 时由 backends.mjs 处理（cli / off）
  const _fAlt = await fixerViaBackend(wsKey, node, j, diagnosis, { cfg: CFG, completeText, readTail, log, qqPush, appendEvent, buildState, parsePlan, dispatchJob });
  if (_fAlt) return;
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
    const created = await api2.sessions.create({ cwd: node.cwd || os.homedir(), agentPreset: CFG.fixerPreset || 'quest-fixer' });
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
    const script = String(node.command || '').match(/\b([\w.\-]+\.py)\b/)?.[1] || '';

    await api2.sessions.prompt({
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
    if (!node.quiet && notifyKind(CFG) !== 'off') {
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
      try { await api2.workspace.archiveSession({ sessionId }); } catch {}
    }
  }
}

/**
 * 依赖编排（2026-09-08 流水线支持）：
 * - 节点 completed → after 指向它的 pending 节点自动派发（manual:true 只标 ready 等人）
 * - 节点 failed/timeout → 下游冻结；全部节点终态 → line.concluded + QQ 收尾铃
 * 每个终态事件后调用；同刻多就绪只推进一个（链式天然串行）。
 */
// ── 静默判定（2026-09-13）：回答"任务是不是真的都完成了" ─────────────────────
// 为什么需要它：quest 原来只在"plan 声明的节点全部终态"时推一次"任务线结束"，而且只推一次。
// 真实事故：某工作区 4 个 plan 节点 9/8 就全终态，之后又跑了 29 个 quest_run 快速单发任务，
// 用户却再也收不到任何"都完成了"的信号——因为 (a) 判定只看 plan.nodes，quick 节点不在里面；
// (b) 有个"只响一次"的守卫。用户侧的感受就是"我根本不知道子对话是在改代码、在重派，还是真完了"。
//
// 判据：没有非终态节点 + 最近 quietMinutes 分钟账本里没有任何动作（含 probe.run——那说明
// AI/人在工作区里干活）+ 上次静默之后又有过新动作（所以可重复，不是一次性）。
// 诚实边界：这是"收敛推断"不是"完成保证"——agent 会不会再派任务事前不可观测，
// 所以通知里必须写清依据（最近动作多久前、共几个节点）。
const TERMINAL_STATUS = ['completed', 'failed', 'timeout', 'frozen', 'cancelled', 'skipped'];
const tsOf = (x) => (x ? Date.parse(x) || 0 : 0);

/** 工作区活跃度快照（/api/status 与 progress.md 共用，不触发通知）。 */
// C：DSH 会话活跃度——直接回答"子对话现在在不在干活"
//
// DSH 的 session/list 返回 SessionSummary { sessionId, updatedAt, running, cwd, parentSessionId, origin }，
// 其中 running 是布尔、cwd 能跟工作区对上。所以"子对话忙不忙"是可读的事实，而不是推断。
//
// 三条设计约束：
//   1) /api/status 会被 dashboard 频繁轮询 → 绝不能在请求路径上打 DSH。只由巡检（每 sweepSeconds）刷新，
//      状态查询读缓存。探测失败 = 当作"不知道"，不门控（宁可不拦，也不能因为 DSH 抽风把信号憋死）。
//   2) 会话按 cwd 匹配工作区（复用 wsKeyOf 的归一化），匹配不到就退化为不门控。
//   3) 这是 DSH 的内部 RPC 形状，不是稳定公开 API：所有异常都必须被吞掉并降级。
let dshSessCache = { at: 0, items: null };

/** 刷新会话列表缓存（只由巡检与非请求路径调用）。 */
async function refreshDshSessions() {
  try {
    // dsh-client 与 worker 会话处一致用动态 import（只在真要连 DSH 时才加载）
    const { NodeApiClient } = await import('./lib/dsh-client-v2.mjs');
    const api = new NodeApiClient(CFG.dshBaseUrl, 8000, { token: CFG.dshToken || undefined, tokenLog: CFG.dshTokenLog || undefined });
    const resp = await api.sessions.list({});
    const items = resp?.result?.value?.items ?? [];
    dshSessCache = { at: Date.now(), items: Array.isArray(items) ? items : [] };
  } catch (e) {
    dshSessCache = { at: Date.now(), items: null }; // 失败也记时间，避免每个巡检周期都重试轰炸
    log('会话探测失败（按"不知道"处理）:', e?.message);
  }
  return dshSessCache.items;
}

/** 读缓存并折算成某工作区的会话活跃度（同步、零 IO）。 */
function dshActivity(wsDir) {
  const items = dshSessCache.items;
  if (!items || !wsDir) return null;
  let key;
  try { key = wsKeyOf(wsDir); } catch { return null; }
  // 2026-09-16 父会话归因：DSH 子代理常带临时 cwd（不在工作区目录）——只按 cwd 匹配会漏数，
  // 导致收敛误报。归因规则：cwd 匹配，或**任一祖先**（沿 parentSessionId 上溯）的 cwd 匹配。
  const byId = new Map(items.map((s) => [s.sessionId, s]));
  const rootedHere = (s) => {
    let cur = s, hops = 0;
    while (cur && hops < 10) {
      if (cur.cwd) { try { if (wsKeyOf(String(cur.cwd)) === key) return true; } catch { return false; } }
      cur = cur.parentSessionId ? byId.get(cur.parentSessionId) : null;
      hops++;
    }
    return false;
  };
  const mine = items.filter((s) => s?.sessionId && rootedHere(s));
  if (!mine.length) return { total: 0, running: 0, idleMinutes: null, ageSeconds: Math.round((Date.now() - dshSessCache.at) / 1000) };
  const running = mine.filter((s) => s.running === true);
  const newest = mine.reduce((a, b) => (Number(b.updatedAt || 0) > Number(a.updatedAt || 0) ? b : a), mine[0]);
  const idleMs = newest?.updatedAt ? Math.max(0, Date.now() - Number(newest.updatedAt)) : null;
  return {
    total: mine.length,
    running: running.length,
    idleMinutes: idleMs == null ? null : Math.round((idleMs / 60000) * 100) / 100,
    ageSeconds: Math.round((Date.now() - dshSessCache.at) / 1000),
  };
}
const WS_SKIP_DIRS = new Set(['.git', 'node_modules', 'archive', '__pycache__', 'logs', 'out', 'runs']);
const WS_SKIP_FILES = new Set(['progress.md', 'research-state.md', 'plan.md']);

/**
 * 工作区活跃度：最近有没有文件被改动（回答"子对话是不是在改代码"）。
 * 被动观测——agent、人、别的工具改代码都会写文件，不需要任何配合。
 * 排除 quest 自己的台账（progress.md/research-state.md/plan.md）与常见产物目录，只看"源码/脚本"类改动。
 */
function workspaceActivity(wsDir, minutes) {
  if (!wsDir) return null;
  try { if (!fs.statSync(wsDir).isDirectory()) return null; } catch { return null; }
  const win = Number(minutes ?? CFG.wsActivityMinutes ?? 15) || 15;
  const found = [];
  const walk = (dir, depth) => {
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      if (found.length > 3000) return;
      if (e.isDirectory()) {
        if (depth > 0 && !WS_SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), depth - 1);
        continue;
      }
      if (!e.isFile() || WS_SKIP_FILES.has(e.name)) continue;
      try { found.push({ name: e.name, mtimeMs: fs.statSync(path.join(dir, e.name)).mtimeMs }); } catch {}
    }
  };
  walk(wsDir, 2);
  if (!found.length) return { dir: wsDir, windowMinutes: win, recent: 0, lastMs: 0, latest: null };
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const cutoff = Date.now() - win * 60000;
  const recent = found.filter((f) => f.mtimeMs > cutoff);
  return {
    dir: wsDir, windowMinutes: win, recent: recent.length, lastMs: found[0].mtimeMs,
    latest: { name: found[0].name, minutes: Math.round((Date.now() - found[0].mtimeMs) / 60000) },
  };
}

function lineActivity(state) {
  const plan0 = state.plan ? parsePlan(state.plan) : { nodes: [], meta: {} };
  const nodes = mergedPlanNodes(plan0, state).nodes;
  const stOf = (id) => state.nodes[id]?.status ?? 'pending';
  const active = nodes.filter((n) => !TERMINAL_STATUS.includes(stOf(n.id)));
  const lastAct = Math.max(
    tsOf(state.lastLineEventAt),
    ...Object.values(state.nodes || {}).map((n) => tsOf(n.lastEventAt)),
    0,
  );
  const idleMs = lastAct ? Math.max(0, Date.now() - lastAct) : null;
  const idleMinutes = idleMs == null ? null : Math.round((idleMs / 60000) * 100) / 100;
  const counts = {};
  for (const n of nodes) counts[stOf(n.id)] = (counts[stOf(n.id)] ?? 0) + 1;
  const quietMinutes = Number(CFG.quietMinutes ?? 10) || 10;
  // 工作区活跃度：账本安静 ≠ 没人干活（agent 可能正在改代码还没派发）。两个都静才算"真静默"。
  // 门控只看静默窗口（quietMinutes）；ws.recent 是给人/AI 看的显示窗口（wsActivityMinutes）。
  // 两个窗口用途不同——拿显示窗口当门控会比静默窗口还宽，永远不收敛（实测踩到过）。
  const ws = workspaceActivity(plan0.meta?.workspace || '');
  const wsIdleMs = ws && ws.lastMs ? Date.now() - ws.lastMs : null;
  const wsQuiet = ws ? (wsIdleMs == null || wsIdleMs >= quietMinutes * 60000) : true;
  // 会话活跃度：agent 正在这个工作区里跑会话（在思考/写代码/读文件）→ 不算收敛。
  // 探测不可用时 dsh=null → 不门控（宁可不拦，也不能因为 DSH 抽风把信号憋死）。
  const dsh = dshActivity(plan0.meta?.workspace || '');
  const dshQuiet = !dsh || dsh.running === 0;
  return {
    nodes, active, lastAct, idleMs, idleMinutes, counts, quietMinutes, ws, wsQuiet, dsh, dshQuiet,
    // 静默判定只在这里算一次，别处直接用（用原始毫秒比，别用取整的分钟——亚分钟配置会算错）
    quiet: active.length === 0 && !!idleMs && idleMs >= quietMinutes * 60000 && wsQuiet && dshQuiet,
  };
}

/**
 * 巡检一个工作区：满足静默条件就推一条可解释的收敛信号（并记 line.quiet 供下次比对）。
 * 返回 null 表示"无需处理/不适用"，{quiet:false} 表示还在活跃期。
 */
/**
 * 收敛汇报（第 1 级通知，2026-09-16，默认关）：任务线收敛时唤醒一个**轻量收尾会话**做全局 AI 审
 * （机械验收 judge 与各 worker 自述之上加一道"看全景的人"），写收尾总结后停下——绝不自动开新实验。
 * 防炸三件套：逐工作区冷却（默认 30 分钟）+ 只唤醒轻量目标（新会话或指定 sessionId，绝不碰大上下文主对话）
 * + 提示词末尾带"复述+停"闸。
 * 配置（quest-config.json）：
 *   "notify": { "kind": "...", "converge": { "enabled": true, "cooldownMin": 30, "targetSessionId": "" } }
 * targetSessionId 缺省=新开一个 cwd=工作区的收尾会话。
 */
/**
 * 收尾自动开关（2026-09-16 用户定稿的"buff 式"语义）：
 *   · 自动收尾**默认开**；按钮/QQ 命令是开关（on/off），不是一次性触发；
 *   · 每天 reopenTimes（如 ["12:00","23:00"]）各重开一次——手动关了忘记开也没关系；
 *   · 在场守卫已删（2026-09-16 定稿：开关是唯一闸门，不再猜在不在场）；
 *   · 冷却（cooldownMin）防刷屏。状态按工作区持久化到 converge-state.json。
 */
const CONVERGE_STATE_FILE = () => path.join(HOMEOverride, 'converge-state.json');
function loadConvergeState() {
  try { return JSON.parse(fs.readFileSync(CONVERGE_STATE_FILE(), 'utf8')); } catch { return {}; }
}
function saveConvergeState(st) {
  try { fs.writeFileSync(CONVERGE_STATE_FILE(), JSON.stringify(st, null, 2)); } catch (e) { log('converge-state 写失败:', e?.message); }
}
function convergeAutoOn(wsKey) {
  const st = loadConvergeState()[wsKey] || {};
  return st.auto !== false;   // 缺省=开（buff 默认生效；只有显式 off 才关）
}
/** 每日定时重开：过了任一 reopenTime 且今天还没重开过 → 开（2 小时内巡检到都算，防错过）。 */
function checkReopenConverge(wsKey, nc) {
  const times = Array.isArray(nc?.reopenTimes) ? nc.reopenTimes : [];
  if (!times.length) return false;
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  for (const t of times) {
    const [h, m] = String(t).split(':').map(Number);
    if (!Number.isFinite(h)) continue;
    const tm = h * 60 + (m || 0);
    const dayKey = now.toISOString().slice(0, 10) + 'T' + t;
    if (cur >= tm && cur < tm + 120) {
      const all = loadConvergeState();
      const cur2 = all[wsKey] || (all[wsKey] = {});
      if (cur2.lastReopen === dayKey) return false;
      const wasOff = cur2.auto === false;
      cur2.lastReopen = dayKey;
      cur2.auto = true;
      saveConvergeState(all);
      if (wasOff) log(`converge ${wsKey}: 定时(${t})重开自动收尾（之前被手动关过）`);
      return true;
    }
  }
  return false;
}

/** 发送收尾汇报提示到目标会话（自动/手动共用；queue 语义：目标忙则排队，绝不打断）。 */
async function sendConvergePrompt(wsKey, wsPath, info, sid, { manual = false } = {}) {
  const { NodeApiClient } = await import('./lib/dsh-client-v2.mjs');
  const api = new NodeApiClient(CFG.dshBaseUrl, 30000, { token: CFG.dshToken || undefined, tokenLog: CFG.dshTokenLog || undefined });
  const stamp = new Date().toISOString().slice(0, 10);
  await api.sessions.prompt({
    sessionId: sid, mode: 'queue',
    content: [{ type: 'text', text: [
      `【收尾汇报${manual ? '·用户手动点名' : '·定时自动'}】对当前工作区的任务线做一次全局总结。只做四件事，然后停下等用户：`,
      '1. 调 quest_status（brief）拿任务线全景。',
      '2. 若存在 research-state.md / progress.md，读它们对照既定目标。',
      '3. 写 ' + (wsPath ? wsPath + '/' : '') + `line-summary-${stamp}.md：各节点成败与关键数字、与目标的差距、明显异常（数字互相矛盾/缺产物）、建议下一步（≤40 行）。`,
      '4. 用 ≤8 行向我复述总结要点（会转给用户）。**不要开新实验、不要改任何脚本、不要派任务——只读与写总结。**',
      `背景：共 ${info.nodes.length} 个节点，${Object.entries(info.counts).map(([k, v]) => v + ' ' + k).join(' / ') || '无终态'}。`,
    ].join('\n') }],
  });
  return stamp;
}

/**
 * 两阶段收尾（2026-09-16 终版，用户定稿："子对话总结，通知主对话——而不是主对话总结"）：
 *   阶段1：轻量收尾会话干总结的活（读 quest_status → 写 line-summary-日期.md）——小上下文，便宜
 *   阶段2：总结写完后，主对话只收一条**短通知**（要点 + 文件指针），不做任何工具调用——大上下文只花一次重发
 * 防炸：阶段1 超时（默认 4 分钟）不阻塞——超时也发通知（仅文件指针，无要点）。
 */
async function runConvergeAndNotify(wsKey, wsPath, info, { manual = false } = {}) {
  const { NodeApiClient } = await import('./lib/dsh-client-v2.mjs');
  const api = new NodeApiClient(CFG.dshBaseUrl, 30000, { token: CFG.dshToken || undefined, tokenLog: CFG.dshTokenLog || undefined });
  const stamp = new Date().toISOString().slice(0, 10);

  // ── 阶段1：开轻量收尾会话干总结 ──
  const sr = await api.sessions.create({ cwd: wsPath || undefined });
  if (!sr.result.ok) throw new Error('create 收尾会话失败: ' + JSON.stringify(sr.result.error ?? {}).slice(0, 100));
  const workerSid = sr.result.value.sessionId;
  log(`converge ${wsKey}: 收尾会话 ${String(workerSid).slice(8, 16)} 开始总结`);
  await sendConvergePrompt(wsKey, wsPath, info, workerSid, { manual });

  // ── 等总结写完（轮询文件 mtime，超时 4 分钟）──
  const summaryFile = path.join(hostPathFor(wsPath) || wsPath || '', `line-summary-${stamp}.md`);
  const before = fs.existsSync(summaryFile) ? fs.statSync(summaryFile).mtimeMs : 0;
  const t0 = Date.now();
  let wrote = false;
  while (Date.now() - t0 < 240000) {
    await new Promise((r) => setTimeout(r, 10000));
    try { if (fs.existsSync(summaryFile) && fs.statSync(summaryFile).mtimeMs > before) { wrote = true; break; } } catch {}
  }

  // ── 阶段2：通知主对话（只收通知，不干活）──
  // 主对话定向链：指定 > 翻页接班 > 最新（排除收敛自建）——同 maybeNotifyConverge 的定向
  const mainSid = (() => {
    const st = loadConvergeState()[wsKey] || {};
    if (st.mainSessionId) return st.mainSessionId;
    return null;   // 没指定就由 maybeNotifyConverge 的兜底逻辑处理（此函数只在有主对话定向时用）
  })();
  if (!mainSid) {
    log(`converge ${wsKey}: 无主对话指定，总结已写入 ${summaryFile}；QQ 已通知用户`);
    return { workerSid, wrote, mainNotified: false };
  }

  // 读总结前几行作为要点
  let headline = '';
  if (wrote) {
    try {
      const lines = fs.readFileSync(summaryFile, 'utf8').split('\n')
        .filter((l) => l.trim() && !l.startsWith('#')).slice(0, 5).join('\n');
      headline = lines.slice(0, 400);
    } catch {}
  }

  await api.sessions.prompt({
    sessionId: mainSid, mode: 'queue',
    content: [{ type: 'text', text: [
      `【全线收敛·总结已完成${manual ? '·手动' : ''}】任务线全部结束（${info.nodes.length} 节点：${Object.entries(info.counts).map(([k, v]) => v + ' ' + k).join(' / ')}）。`,
      wrote ? `全局总结已由收尾会话写入 line-summary-${stamp}.md。要点：\n${headline}` : `收尾会话可能超时，总结文件在 line-summary-${stamp}.md（自己去读）。`,
      '请向用户复述要点并建议下一步（≤8 行），然后**停下等用户决定**——不要自行开新实验或派任务。',
    ].join('\n') }],
  });
  log(`converge ${wsKey}: 已通知主对话 ${String(mainSid).slice(8, 16)}（总结${wrote ? '✓' : '超时'}）`);
  return { workerSid, wrote, mainNotified: true, mainSid };
}

async function maybeNotifyConverge(wsKey, st, info) {
  const nc = CFG.notify?.converge;
  if (nc && nc.enabled === false) return;   // 配置级总闸（缺省开）
  checkReopenConverge(wsKey, nc);           // 每日定时重开（12:00/23:00 这类；手动关了忘记开也没关系）
  if (!convergeAutoOn(wsKey)) return;       // 唯一闸门=开关（buff 式：默认开，手动关才关——2026-09-16 用户定稿）
  const cooldownMs = Math.max(5, Number(nc?.cooldownMin) || 30) * 60000;
  const lastConv = (st.lineEvents ?? []).filter((e) => e.t === 'notify.converge' && !e.error).pop();
  if (lastConv && Date.now() - tsOf(lastConv.at) < cooldownMs) return;   // 冷却内不重复唤醒（防重复靠冷却+手动关，不再猜在不在场）
  const wsPath = (() => { try { return parsePlan(st.plan).meta?.workspace || ''; } catch { return ''; } })();
  // 事件立即写入（不等两阶段走完——阶段 2 含最长 4 分钟等总结文件，等它事件永远迟到）
  appendEvent(wsKey, { t: 'notify.converge', counts: info.counts, phase: 'started' });
  runConvergeAndNotify(wsKey, wsPath, info).then((result) => {
    appendEvent(wsKey, { t: 'notify.converge', sessionId: result.workerSid, mainSid: result.mainSid || undefined, mainNotified: result.mainNotified, wrote: result.wrote || undefined, counts: info.counts, phase: 'done' });
    if (notifyKind(CFG) !== 'off') {
      qqPush(wsKey, `[🏁 收尾汇报] 任务线收敛（${info.nodes.length} 节点）。${result.wrote ? '总结已写入 line-summary-*.md' : '总结文件超时'}${result.mainNotified ? '，已通知主对话' : ''}。`.slice(0, 300)).catch(() => {});
    }
    log(`notify.converge ${wsKey}: worker=${String(result.workerSid).slice(8, 16)} main=${result.mainNotified ? String(result.mainSid).slice(8, 16) : '未通知'} wrote=${result.wrote}`);
  }).catch((e) => {
    appendEvent(wsKey, { t: 'notify.converge', error: String(e?.message || e).slice(0, 160), phase: 'error' });
    log('notify.converge 失败:', e?.message);
  });
}

function evaluateQuiet(wsKey) {
  try {
    const st = buildState(wsKey);
    if (!st.plan) return null;
    if (!parsePlan(st.plan).nodes.length && !Object.keys(st.nodes || {}).length) return null;
    const info = lineActivity(st);
    const lastQuiet = tsOf((st.lineEvents ?? []).filter((e) => e.t === 'line.quiet').pop()?.at);
    if (info.lastAct === 0 || info.lastAct <= lastQuiet) {
      return { quiet: false, active: info.active.length, idleMinutes: info.idleMinutes };
    }
    // 注意：任务在跑、或还在静默窗口内、或工作区刚被改过 → 都不算收敛
    if (!info.quiet) {
      return { quiet: false, active: info.active.length, idleMinutes: info.idleMinutes, waiting: true, wsRecent: info.ws?.recent ?? null };
    }
    const need = info.nodes.filter((n) => ['failed', 'timeout', 'frozen'].includes(st.nodes[n.id]?.status))
      .slice(0, 4).map((n) => `${n.id.slice(0, 26)}（${st.nodes[n.id]?.verdict || st.nodes[n.id]?.status}）`);
    appendEvent(wsKey, { t: 'line.quiet', counts: info.counts, idleMinutes: info.idleMinutes, nodes: info.nodes.length });
    maybeNotifyConverge(wsKey, st, info).catch((e) => log('收敛汇报失败:', e?.message));   // 第1级：唤醒收尾会话（默认关）
    if (notifyKind(CFG) !== 'off') {
      const summary = Object.entries(info.counts).map(([k, v]) => `${v} ${k}`).join(' / ');
      const idleTxt = info.idleMinutes >= 1 ? Math.round(info.idleMinutes) + " 分钟前" : '不到 1 分钟前';
      const wsLine = info.ws ? (info.ws.recent ? `工作区：最近 ${info.ws.windowMinutes} 分钟有 ${info.ws.recent} 个文件被改（最新 ${info.ws.latest?.name}）` : `工作区：最近 ${info.ws.windowMinutes} 分钟无改动`) : '';
      const dshLine = info.dsh ? `子对话：无会话在跑（本工作区 ${info.dsh.total} 个）` : '';
      qqPush(wsKey, `[🏁 静默] 没有在跑的节点 · 最近动作 ${idleTxt} · 共 ${info.nodes.length} 个：${summary}${wsLine ? '\n' + wsLine : ''}${dshLine ? '\n' + dshLine : ''}${need.length ? '\n需留意：' + need.join('、') : ''}`.slice(0, 500)).catch(() => {});
    }
    pushInbox({ node: '(line)', verdict: 'quiet', detail: `无在跑节点，最近动作 ${info.idleMinutes} 分钟前；共 ${info.nodes.length} 个节点` });
    writeProgress(wsKey);
    log(`line.quiet ${wsKey}: idle=${info.idleMinutes}min nodes=${info.nodes.length}`);
    return { quiet: true, idleMinutes: info.idleMinutes, counts: info.counts };
  } catch (e) {
    log('静默判定失败:', e?.message);
    return null;
  }
}

/** 巡检：只扫"最近有活动"的工作区（账本 6 小时内动过），避免无谓 IO。 */
function sweepQuiet() {
  // 会话缓存每轮刷新一次（一次 RPC），失败自动降级；随后各工作区同步读缓存
  refreshDshSessions().then(() => sweepQuietDirs()).catch(() => sweepQuietDirs());
}

function sweepQuietDirs() {
  let dirs = [];
  try {
    dirs = fs.readdirSync(HOMEOverride, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { return; }
  const cutoff = Date.now() - 6 * 3600 * 1000;
  for (const d of dirs) {
    try {
      const f = path.join(HOMEOverride, d, 'ledger.jsonl');
      if (fs.statSync(f).mtimeMs < cutoff) continue;
      evaluateQuiet(d);
    } catch { /* 单个工作区出错不影响其它 */ }
  }
}

async function orchestrate(wsKey) {
  const state = buildState(wsKey);
  if (!state.plan) return;
  const plan = parsePlan(state.plan);
  if (!plan.nodes.length) return;
  const stOf = (id) => state.nodes[id]?.status ?? 'pending';
  const evOf = (id) => state.nodes[id]?.events ?? [];

  // ②c 冻结策略：默认 any-fail（上游任意异常都冻结下游，保守，与旧版一致）。
  // 声明 freeze_on: hard-fail-only 的节点只认"真失败"（崩溃/启动失败/超时/取消/预检失败）；
  // suspect 只是"判定器没找到完成证据"，可能是坏、也可能是没写关键词——交给探针查证，
  // 脚本不替 AI 做这个判断：不冻结、放行下游，同时推一条带探针指令的提醒。
  const SOFT_VERDICTS = new Set(['suspect']);
  const freezePolicy = new Map(plan.nodes.map((x) => [x.id, x.freezeOn || 'any-fail']));
  for (const n of plan.nodes) {
    if (stOf(n.id) !== 'pending' || !n.after?.length) continue;
    const badAll = n.after.filter((d) => ['failed', 'timeout', 'frozen', 'cancelled', 'skipped'].includes(stOf(d)));
    if (!badAll.length) continue;
    // 声明归属是双向的：写在下游（"别因为疑似上游冻我"）或写在上游（"我的疑似别拖累全链"）
    // 都生效；plan 头写一次则整条线兜底。任一处声明即按宽松口径处理，避免"字面写了却不生效"。
    const lenient = n.freezeOn === 'hard-fail-only' || badAll.some((d) => freezePolicy.get(d) === 'hard-fail-only');
    const soft = lenient
      ? badAll.filter((d) => SOFT_VERDICTS.has(String(state.nodes[d]?.verdict || '')))
      : [];
    const bad = badAll.find((d) => !soft.includes(d));
    if (!bad && soft.length && !evOf(n.id).includes('node.soft-pass')) {
      const desc = soft.map((d) => `${d}(${state.nodes[d]?.verdict || '?'}/${state.nodes[d]?.via || '?'})`).join('、');
      appendEvent(wsKey, { t: 'node.soft-pass', node: n.id, upstream: soft, verdicts: soft.map((d) => state.nodes[d]?.verdict), reason: `freeze_on=hard-fail-only：上游 ${desc} 仅疑似，不冻结` });
      pushInbox({ node: n.id, verdict: '上游疑似但已放行', detail: `${desc}；如需复核用 quest_probe 看上游日志与产物，确认是坏的则 /q取消 ${n.id}` });
      if (!n.quiet) {
        qqPush(wsKey, `[⚠️ 疑似但放行] ${n.id}\n上游 ${desc} 判定为"疑似"（没找到完成证据，不等于失败）——本节点按 freeze_on: hard-fail-only 直接开跑。\n让 AI 用 quest_probe 查证上游；确认确实没跑完就 /q取消 ${n.id}`).catch(() => {});
      }
    }
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

  // 2026-09-13 修：收尾判定用 plan ∪ 账本（mergedPlanNodes）。只看 plan.nodes 会让只用
  // quest_run 快速单发的工作区永远等不到收尾信号（真实事故：某工作区 4 个 plan 节点 9/8
  // 就全终态，之后 29 个 quick 任务跑完都没有任何汇总）。用户侧的可重复信号由 sweepQuiet 推。
  const lineNodes = mergedPlanNodes(plan, state).nodes;
  const allStopped = lineNodes.every((n) => TERMINAL_STATUS.includes(stOf(n.id)));
  if (allStopped && !(state.lineEvents ?? []).some((e) => e.t === 'line.concluded')) {
    const counts = {};
    for (const n of lineNodes) counts[stOf(n.id)] = (counts[stOf(n.id)] ?? 0) + 1;
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
    // 用户侧的收尾铃交给 line.quiet（可重复、含 quick 节点、带最近动作时间的依据）；
    // 这里保留 line.concluded 作为内部事件 + research-state.md 落盘（翻篇种子，一次即可）。
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

// QQ 推送（2026-09-11 加重试）：bridge 重启窗口内的推送会失败，之前静默丢弃。
// 现在：3 次指数退避重试 + 失败落盘队列（bridge 恢复后由 flushQQQueue 补发）。
const QQ_QUEUE_FILE = path.join(HOMEOverride, 'qq-pending.json');
async function qqPushDirect(message) {
  // provider 无关：bridge / webhook / off（见 notify.mjs）；超长会按 notify.maxChars 截断
  const r = await sendText(CFG, message, { fs, timeoutMs: 8000 });
  if (!r.ok && r.error !== 'off') log('通知发送失败:', r.error, r.status ?? '');
  return r;
}
function queueQQ(message) {
  try {
    const arr = fs.existsSync(QQ_QUEUE_FILE) ? JSON.parse(fs.readFileSync(QQ_QUEUE_FILE, 'utf8')) : [];
    arr.push({ ts: Date.now(), message });
    fs.writeFileSync(QQ_QUEUE_FILE, JSON.stringify(arr.slice(-60), null, 1));
  } catch {}
}
async function qqPush(wsKey, message) {
  if (notifyKind(CFG) === 'off') return;
  const full = `${qqTag(wsKey)}${message}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await qqPushDirect(full);
    if (r.ok) return;
    // 4xx = 通知端明确拒绝（超长/未授权/策略拦截）：重试无益，记一笔就放弃
    if (!isRetryable(r)) {
      try { appendEvent(lastActiveWs, { t: 'qq.push-rejected', msg: String(r.error || '').slice(0, 80) }); } catch {}
      log('通知被拒且不重试:', r.error);
      return;
    }
    if (attempt < 3) await new Promise((res) => setTimeout(res, attempt * 2000));
  }
  queueQQ(full); // 三次网络类失败：落盘，等通知端恢复后补发
  log('qqPush 失败已入队（bridge 恢复后补发）');
  try { appendEvent(lastActiveWs, { t: 'qq.push-failed', msg: full.slice(0, 150) }); } catch {}
}
// 补发队列：每 2 分钟试一次，成功即清空
setInterval(async () => {
  let arr;
  try { arr = JSON.parse(fs.readFileSync(QQ_QUEUE_FILE, 'utf8')); } catch { return; }
  if (!Array.isArray(arr) || !arr.length) return;
  const remain = [];
  let dropped = 0;
  for (const item of arr) {
    const r = await qqPushDirect(item.message);
    if (r.ok) continue;
    if (!isRetryable(r)) { dropped++; continue; } // 4xx：丢弃，别无限重试
    remain.push(item);
  }
  try { fs.writeFileSync(QQ_QUEUE_FILE, JSON.stringify(remain, null, 1)); } catch {}
  if (remain.length < arr.length) log(`QQ 补发成功 ${arr.length - remain.length} 条，剩余 ${remain.length}`);
}, 2 * 60 * 1000);

// 静默巡检（quietMinutes/sweepSeconds 可配；测试用小值）
setInterval(() => { try { sweepQuiet(); } catch (e) { log('sweepQuiet 异常:', e?.message); } }, Math.max(5, Number(CFG.sweepSeconds ?? 60)) * 1000);

/** 产物图直推：把节点刚产出的 png/jpg 发 owner QQ（bridge /api/send/private-image，base64 image 段）。 */
async function qqPushImage(wsKey, imagePath, caption) {
  const r = await sendImage(CFG, imagePath, `${qqTag(wsKey)}${caption}`, { fs, timeoutMs: 20000 });
  if (!r.ok && r.error !== 'off') log('图片直推失败:', r.error);
  return r.ok;
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
  // 可插拔后端（v0.5）：非 dsh 时由 backends.mjs 处理（openai / cli / off）
  const _wAlt = await workerViaBackend(wsKey, node, j, runSec, { cfg: CFG, completeText, readTail, formatDur, log });
  if (_wAlt !== null) return _wAlt;
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
async function launchQuickRun(wsKey, node, extra = {}) {
  try {
    const dir2 = dirOf(wsKey);
    if (!fs.existsSync(path.join(dir2, 'plan.md'))) {
      fs.writeFileSync(path.join(dir2, 'plan.md'), `# 任务线：快速单发-${String(extra.title || path.basename(String(node.cwd))).slice(0, 30)}\nworkspace: ${node.cwd}\n`, 'utf8');
    }
  } catch {}
  appendEvent(wsKey, { t: 'plan.created', nodes: [node.id] });
  // 记下真正执行的命令：quick 节点不在 plan.md 里，账本若只留 id，事后无法审计或复现
  // （2026-09-14「假崩溃」事故里，第一件想确认的就是"我们到底把什么命令发出去了"）
  appendEvent(wsKey, {
    t: 'quick.dispatched', node: node.id,
    command: String(node.command || '').slice(0, 4000), cwd: node.cwd, shell: node.shell || 'windows',
    success: String(node.success || ''), expectMinutes: node.expectMinutes ?? null,
    dispatchedBy: extra.dispatchedBy || undefined,   // 派发者会话（失败上报点名回它，不猜"最新"）
  });
  return dispatchJob(wsKey, node);
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
  const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(obj)); };
  try {
    const u = new URL(req.url, 'http://localhost');
    // 仪表盘页面本体免头认证（页面自己管 token：URL 参数/localStorage/弹窗）——所有数据 API 仍需 token
    // v2 控制台（并列试验页，/dashboard 不动）：写操作按钮 + 事件驱动实时 + 日志/loss 曲线
    if (req.method === 'GET' && (u.pathname === '/dashboard-v2' || u.pathname === '/dashboard-v2/')) {
      const html2 = fs.readFileSync(path.join(import.meta.dirname, 'dashboard-v2.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html2);
      return;
    }
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
      // 带上 plan 侧的元数据（after/manual/success/shell）——控制台要靠 after 画任务链路线图；
      // inPlan 区分"plan.md 声明的节点"与"账本里的快速单发节点"（后者没有 after）。
      const nodes = nodeDisplayOrder(plan, state).map(({ n }) => ({
        id: n.id, ...(state.nodes[n.id] || { status: 'pending' }),
        quiet: n.quiet, expectMinutes: n.expectMinutes,
        inPlan: Array.isArray(n.after),
        after: Array.isArray(n.after) ? n.after : [],
        manual: !!n.manual, shell: n.shell || 'windows', success: n.success || '',
      }));
      const unread = inbox.splice(0); // 取走即清
      writeProgress(wsKey); // 查询即刷新：progress.md 不再等下一个节点事件（排序/状态实时保鲜）
      // workspace 优先取 plan.md 里声明的绝对路径（权威），入参只做缺省——/q翻页 等下游要拿真路径去匹配 DSH 会话
      const act = lineActivity(state);
      return json(200, {
        plan: { workspace: plan.meta?.workspace || ws, title: plan.meta?.title || '', nodes, closedAt: state.closedAt || null, closedReason: state.closedReason || '' },
        line: {
          active: act.active.length, nodes: act.nodes.length, counts: act.counts,
          idleMinutes: act.idleMinutes, quietMinutes: act.quietMinutes,
          quiet: act.quiet, wsQuiet: act.wsQuiet, dshQuiet: act.dshQuiet, dsh: act.dsh,
          workspace: act.ws ? { recent: act.ws.recent, windowMinutes: act.ws.windowMinutes, latest: act.ws.latest } : null,
        },
        unread, questVersion: '0.2.0',
      });
    }
    // 历史计划列表（2026-09-14）：控制台用下拉栏调出以前那些短流程 plan。
    // 每条都带自己的节点与依赖（after），状态从账本取（节点 id 跨 plan 稳定）。
    // current 那条就是现在的 plan.md，live 表示它还有没终结的节点 = "当下正在走的短流程"。
    if (req.method === 'GET' && u.pathname === '/api/plans') {
      const state = buildState(wsKey);
      const dir = dirOf(wsKey);
      const nodesOfPlan = (parsed) => parsed.nodes.map((n) => {
        const st = state.nodes[n.id] || {};
        return {
          id: n.id, after: Array.isArray(n.after) ? n.after : [], status: st.status || 'pending',
          verdict: st.verdict || null, shell: n.shell || 'windows', command: n.command || '',
          success: n.success || '', manual: !!n.manual, expectMinutes: n.expectMinutes ?? 0,
          startedAt: st.startedAt || null, endedAt: st.endedAt || null, runSeconds: st.runSeconds ?? null,
          rejudgedAt: st.rejudgedAt || null, metrics: st.metrics || null, inPlan: true,
        };
      });
      const count = (nodes) => nodes.reduce((a, n) => { a[n.status] = (a[n.status] || 0) + 1; return a; }, {});
      const live = (nodes) => nodes.some((n) => !TERMINAL_STATUS.includes(n.status));
      const plans = [];
      const curFile = path.join(dir, 'plan.md');
      if (fs.existsSync(curFile)) {
        const parsed = parsePlan(fs.readFileSync(curFile, 'utf8'));
        if (parsed.nodes.length) {
          const nodes = nodesOfPlan(parsed);
          plans.push({
            file: '(当前)', current: true, live: live(nodes),
            at: fs.statSync(curFile).mtime.toISOString(),
            title: parsed.meta?.title || '', workspace: parsed.meta?.workspace || ws,
            nodes, counts: count(nodes),
          });
        }
      }
      const pd = path.join(dir, 'plans');
      if (fs.existsSync(pd)) {
        for (const f of fs.readdirSync(pd).filter((x) => x.endsWith('.md')).sort().reverse()) {
          try {
            const full = path.join(pd, f);
            const parsed = parsePlan(fs.readFileSync(full, 'utf8'));
            const nodes = nodesOfPlan(parsed);
            plans.push({
              file: f, current: false, live: live(nodes),
              at: fs.statSync(full).mtime.toISOString(),
              title: parsed.meta?.title || '', workspace: parsed.meta?.workspace || ws,
              nodes, counts: count(nodes),
            });
          } catch (e) { log('读存档 plan 失败:', f, e?.message); }
        }
      }
      return json(200, { ok: true, plans });
    }
    if (req.method === 'POST' && u.pathname === '/api/plan') {
      const body = await readBody(req);
      const parsed = parsePlan(body.markdown || '');
      if (parsed.errors.length) return json(400, { ok: false, errors: parsed.errors });
      const dir = dirOf(wsKey);
      // ⑦ 覆盖保护：plan.md 是"任务线的唯一真相"，被整体替换时旧 plan 里还没干净收尾的节点
      // 会连状态一起蒸发（历史上发生过：AI 重写 plan 顺手删掉待办/失败节点，人再看不见）。
      // 只认 completed 为"可以静默丢弃"；其余（含 skipped/cancelled）都要求显式 force 确认。
      const planFile = path.join(dir, 'plan.md');
      if (fs.existsSync(planFile) && body.force !== true) {
        let oldNodes = [];
        try { oldNodes = parsePlan(fs.readFileSync(planFile, 'utf8')).nodes; } catch { oldNodes = []; }
        const keep = new Set(parsed.nodes.map((n) => n.id));
        const st = buildState(wsKey);
        const dropped = oldNodes
          .filter((n) => !keep.has(n.id))
          .map((n) => ({ id: n.id, status: st.nodes[n.id]?.status || 'pending', verdict: st.nodes[n.id]?.verdict || null }))
          .filter((d) => d.status !== 'completed');
        if (dropped.length) {
          const desc = dropped.map((d) => `${d.id}(${d.status}${d.verdict ? '/' + d.verdict : ''})`).join('、');
          return json(409, {
            ok: false,
            error: `新 plan 会丢掉 ${dropped.length} 个未完成节点：${desc}`,
            dropped,
            hint: '确认要丢弃就把这些节点写回新 plan，或重新提交时带 force:true（quest_plan 的 force 参数 / POST body {"force":true}）。已完成的节点不会拦。',
          });
        }
      }
      const archived = archivePlanIfNeeded(wsKey);   // 覆盖前先存档旧 plan（历史计划要能回看）
      fs.writeFileSync(planFile, body.markdown, 'utf8');
      if (archived) appendEvent(wsKey, { t: 'plan.archived', file: path.basename(archived) });
      appendEvent(wsKey, { t: fs.existsSync(path.join(dir, 'ledger.jsonl')) ? 'plan.reloaded' : 'plan.created', nodes: parsed.nodes.map((n) => n.id), ...(body.force === true ? { forced: true } : {}) });
      return json(200, { ok: true, nodes: parsed.nodes.map((n) => n.id), workspace: ws, ...(archived ? { archived: path.basename(archived) } : {}) });
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
      if (String(b.command).length > CMD_MAX_CHARS) {
        return json(200, {
          ok: false,
          error: `命令 ${String(b.command).length} 字符超过上限 ${CMD_MAX_CHARS}：请把多段流水写进工作区脚本（python / bash）再一次派发，或拆成多次 quest_run。长链式命令既容易出错，判定器/修复器也处理不了。`,
        });
      }
      const node = {
        id: `quick-${String(b.title || b.command).slice(0, 40).replace(/[^\w一-龥-]/g, '_')}-${Date.now().toString(36)}`,
        command: String(b.command), cwd: b.cwd,
        expectMinutes: Number(b.expectMinutes) || 30, quiet: b.quiet === true,
        autoFix: b.autoFix === true, fixBudget: 2,
        handoff: String(b.handoff || '快速单发任务').slice(0, 2000),
        success: String(b.success || '').slice(0, 300),
        after: [], when: '', watchRules: [],
        shell: b.shell === 'wsl' ? 'wsl' : 'windows',
      };
      const wsKey2 = wsKeyOf(b.cwd);
      const cls = runGateCfg.enabled === false ? { level: 'ok' } : classifyRunCommand(node.command, node.cwd);
      if (cls.level !== 'ok') {
        const night = tryNightSelfApprove(wsKey2, node, b);
        if (night?.approved) {
          const rN = await launchQuickRun(wsKey2, node, b);
          if (rN && rN.ok === false) return json(200, { ok: false, error: rN.error });
          return json(200, { ok: true, nodeId: node.id, gate: 'night-self-approved' });
        }
        const rec = submitRunForConfirm(wsKey2, node, b, cls);
        return json(200, {
          ok: true, nodeId: node.id, gate: 'pending-confirm', gateId: rec.id,
          note: night?.blocked || `命令不在白名单（${cls.why}），已推送 owner QQ 等确认，${runGateCfg.dayTimeoutMinutes} 分钟不确认自动作废。改写成白名单形式（解释器跑工作区内脚本）可直接跑。`,
        });
      }
      const rW = await launchQuickRun(wsKey2, node, b);
      if (rW && rW.ok === false) return json(200, { ok: false, error: rW.error });
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
        const rA = await launchQuickRun(rec.wsKey, rec.node, { title: rec.title });
        if (rA && rA.ok === false) return json(200, { ok: false, action: 'preflight-failed', error: rA.error });
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
          let wsPath = '';
          let running = 0;
          let nodes = 0;
          try {
            const st = buildState(d.name);
            if (st.plan) {
              const meta = parsePlan(st.plan).meta || {};
              title = meta.title || '';
              wsPath = meta.workspace || '';   // 下拉栏按"工作区路径"显示（像 DSH 的工作区切换器）
            }
            running = Object.values(st.nodes).filter((n) => n.status === 'running').length;
            nodes = Object.keys(st.nodes).length;
          } catch {}
          // 残留工作区（孤立键 / 老版 /mnt 键残留 / logs 目录）排到最后：
          // 页面在地址没带 ?ws= 时会落在这个列表的第一项 —— 2026-09-14 用户刷新后
          // "全部节点明细只剩 2 个节点"，就是因为第一项是 _orphaned-… 那个残留键。
          const junk = /^_orphaned/.test(d.name) || /^-mnt-/.test(d.name) || d.name === 'logs';
          list.push({ wsKey: d.name, title, workspace: wsPath, running, nodes, junk });
        }
      } catch {}
      list.sort((a, b) => b.running - a.running || Number(a.junk) - Number(b.junk) || b.nodes - a.nodes || a.wsKey.localeCompare(b.wsKey));
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
        if (mode === 'stat') {
          const st = fs.statSync(p);
          return json(200, { stat: { size: st.size, mtimeMs: st.mtimeMs, dir: st.isDirectory(), file: st.isFile() } });
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
      // ws 双通道兜底（2026-09-16 事故）：桥放 body.ws，插件放 URL query —— 以前只读 body，
      // 插件不显式传 ws 且 wsOf(exec) 取不到 cwd 时 b.ws=undefined ⇒ matched=0、create 进默认目录
      // （AI 两次翻页各建出一个游离会话、一个会话都没归档，就是它）。现在 query/body 谁有听谁的。
      b.ws = b.ws || u.searchParams.get('ws') || '';
      const { NodeApiClient } = await import('./lib/dsh-client-v2.mjs');
      const api = new NodeApiClient(CFG.dshBaseUrl, 30000, { token: CFG.dshToken || undefined, tokenLog: CFG.dshTokenLog || undefined });
      const results = { archived: [], created: null, errors: [], exported: null, handoff: null };

      // ── 0) 交接（2026-09-15）：归档前让老会话把 research-state.md 写新鲜 ──────────
      // 模板模仿 Claude Code /compact 的 9 节与 Codex 的 checkpoint 4 节，融合并适配科研流：
      // 目标/决策/进度/产物/坑/在跑/待办/用户口径/下一步。种子提示让新会话读的正是这份文件，
      // 以前从没人负责写它 ⇒ 恢复质量全凭运气。
      const HANDOFF_TMPL = [
        '# 研究状态交接（research-state）',
        '（翻页前由老会话写入；新会话靠它恢复上下文，写详细不写客气话）',
        '',
        '## 1. 目标与意图',
        '这条线在验证什么假设；用户明确要的产出（论文表/图/结论句）。',
        '',
        '## 2. 已定决策（别再讨论）',
        '每个决策一行：定了什么 + 一句理由。含参数基线、方法选型、命名约定。',
        '',
        '## 3. 当前进度',
        '进行到哪一步；刚完成什么（带关键数字）；与目标的差距。',
        '',
        '## 4. 产物与文件清单',
        '路径 → 干嘛的 → 关键数字/结论。只列这条线的核心产物，注明可信度（已验/待验）。',
        '',
        '## 5. 错误与坑（别再踩）',
        '试过不行的路、踩过的坑、临时绕过。写"什么不行、为什么"，防止新会话重蹈。',
        '',
        '## 6. 正在跑 / 等待中',
        'quest 节点 id、外部任务、等用户拍板的事项。',
        '',
        '## 7. 待办',
        '按优先级列，带验收标准（怎样算完成）。',
        '',
        '## 8. 用户口径与红线',
        '用户明确说过的偏好、口径、禁做的事（尽量原话）。',
        '',
        '## 9. 建议下一步',
        '一两句：接着干什么、先查什么。',
      ].join('\n');
      // 匹配一律用 wsKeyOf 归一（2026-09-15 事故教训）：裸字符串比对吃不下 /mnt/c 与 C:\ 两种
      // 形态、正反斜杠、以及**尾斜杠**（实测见过 "C:\...\piml_fingertip\" 这种 cwd）——
      // 历史上 4 次翻页 archived 全是 0（9-11 三次 code_kl + 今晚 piml），根子就在这里。
      const sameWs = (cwd) => { try { return wsKeyOf(String(cwd ?? '')) === wsKeyOf(String(b.ws ?? '')); } catch { return false; } };
      if (b.handoff !== false) {
        try {
          const lh = await api.sessions.list({});
          if (!lh.result.ok) throw new Error('session/list 不可用: ' + JSON.stringify(lh.result.error ?? {}).slice(0, 120));
          const items = lh.result.value?.items ?? [];
          const mine = items
            .filter((it) => sameWs(it.cwd))
            .sort((x, y) => String(y.updatedAt ?? '').localeCompare(String(x.updatedAt ?? '')));
          if (!mine.length) {
            results.handoff = { prompted: 0, matched: 0, note: '该工作区 0 个会话匹配（列表共 ' + items.length + ' 个）——翻错工作区了？回执会标明目标' };
          } else {
            const rsFile = path.join(hostPathFor(String(b.ws ?? '')) || String(b.ws ?? ''), 'research-state.md');
            const before = fs.existsSync(rsFile) ? fs.statSync(rsFile).mtimeMs : 0;
            await api.sessions.prompt({
              sessionId: mine[0].sessionId, mode: 'queue',
              content: [{ type: 'text', text: [
                '【翻页前交接】本会话即将被归档翻篇。请把工作区的 research-state.md **整个重写**为一份交接文档（覆盖旧内容，中文），严格按下面的模板逐节填写；没有的节写"无"；第 4/5 节要具体到文件路径和数字。除写这一个文件外不要做任何别的事，写完只回复"交接已写入"。',
                '',
                HANDOFF_TMPL,
              ].join('\n') }],
            });
            // 等它写完（轮询 mtime；超时则如实记录并继续翻页——翻页本身不能被卡死的会话绑架）
            const tmo = Math.min(600, Math.max(30, Number(b.handoffTimeoutSec) || 150)) * 1000;
            const t0 = Date.now();
            let wrote = false;
            while (Date.now() - t0 < tmo) {
              await new Promise((r) => setTimeout(r, 5000));
              try { if (fs.existsSync(rsFile) && fs.statSync(rsFile).mtimeMs > before) { wrote = true; break; } } catch {}
            }
            results.handoff = { prompted: 1, sessionId: mine[0].sessionId, wrote, waitedSec: Math.round((Date.now() - t0) / 1000), note: wrote ? '老会话已把 research-state.md 写新鲜' : '等待超时（老会话可能卡死/繁忙），新会话将读旧版 research-state.md；旧对话全文在 archive/ 里可 grep' };
          }
        } catch (e) { results.handoff = { prompted: 0, note: '交接步骤出错：' + e.message }; }
      }

      // 1) 导出旧会话为可搜索的 markdown（AI 的冷存储——翻页后仍可 grep 查旧细节）
      try {
        const lr0 = await api.sessions.list({});
        const wsItems = lr0.result.ok
          ? (lr0.result.value?.items ?? []).filter((it) => String(it.cwd ?? '').replace(/\\/g, '/') === String(b.ws ?? '').replace(/\\/g, '/'))
          : [];
        if (wsItems.length) {
          results.exported = await exportSessionArchive(b.ws, wsItems, wsKeyOf);
        }
      } catch (e) { results.errors.push('export: ' + e.message); }
      // 1.5) 重建 API 连接（导出大文件耗时，旧连接可能已断——0.1.5 实测踩过）
      const api2 = new NodeApiClient(CFG.dshBaseUrl, 30000, { token: CFG.dshToken || undefined, tokenLog: CFG.dshTokenLog || undefined });
      // 2) 归档旧会话（该工作区下所有会话）——sameWs 归一匹配 + 假成功防线
      results.matched = 0;
      try {
        const lr = await api2.sessions.list({});
        if (!lr.result.ok) throw new Error('session/list 不可用: ' + JSON.stringify(lr.result.error ?? {}).slice(0, 120));
        const items = lr.result.value?.items ?? [];
        results.matched = items.filter((it) => sameWs(it.cwd)).length;
        for (const item of items) {
          if (sameWs(item.cwd)) {
            try {
              await api.workspace.archiveSession({ sessionId: item.sessionId });
              results.archived.push(item.sessionId);
            } catch (e) { results.errors.push(`archive ${item.sessionId}: ${e.message}`); }
          }
        }
        // 匹配到了却一个都没归档成 ⇒ 如实报错（历史教训：4 次翻页全是"归档 0 个"的假成功）
        if (results.matched > 0 && results.archived.length === 0) {
          results.errors.push(`匹配到 ${results.matched} 个会话但归档全部失败`);
        }
        if (results.matched === 0) {
          results.errors.push('该工作区 0 个会话匹配（要翻的可能不是这个目录）');
        }
      } catch (e) { results.errors.push(`list: ${e.message}`); }
      // 3) 开新会话（cwd 用 Windows 原生形态——/mnt/c 形态在 Windows 侧是无效路径）
      try {
        const created = await api.sessions.create({ cwd: hostPathFor(String(b.ws ?? '')) || b.ws, agentPreset: b.preset || undefined });
        if (!created.result.ok) throw new Error(JSON.stringify(created.result.error).slice(0, 150));
        results.created = created.result.value.sessionId;
        if (!results.created) throw new Error('create 返回 ok 但没有 sessionId');
      } catch (e) { results.errors.push(`create: ${e.message}`); }
      // 4) 种子消息：装载交接文档 + 任务线全景，先复述确认再动手（防"上下文缺了变傻"——
      //    复述逼它把情报装载到位，用户当场能看出丢了什么）
      const wsHost = hostPathFor(String(b.ws ?? '')) || String(b.ws ?? '');   // research-state.md 的真实路径（/mnt 形态转原生盘符）
      if (results.created && b.seed !== false) {
        try {
          const rsOk = fs.existsSync(path.join(wsHost, 'research-state.md'));
          await api.sessions.prompt({
            sessionId: results.created, mode: 'queue',
            content: [{ type: 'text', text: [
              '【翻篇恢复】工作区刚完成一次翻篇归档。按顺序做三件事，然后停下等用户：',
              `1. 读取 ${path.join(wsHost, 'research-state.md')} —— 这是老会话归档前写的交接文档${results.handoff?.wrote ? '（刚写新鲜的 ✓）' : rsOk ? '（注意：本次翻页老会话没来得及重写，内容可能是旧的，缺的部分去 archive/ 里 grep）' : '（文件不存在！先看第 3 步的任务线全景，并提醒用户补交接）'}。`,
              '2. 调用 quest_status（brief 模式）拿任务线全景：在跑的、最近失败的、计划状态。',
              '3. 用 5~8 行向用户复述你理解的现状：目标、已完成（带关键数字）、正在跑、坑（别再踩的）、建议下一步。**复述完就停，等用户确认后再动手**——宁可问，不要猜。',
              '历史对话全文在 archive/flip-*.md（工具输出已修剪），要查旧细节用 grep 搜这个文件，不要整读。',
            ].join('\n') }],
          });
        } catch (e) { results.errors.push(`seed: ${e.message}`); }
      }
      // 记账要记到**被翻的工作区**（2026-09-15 教训）：wsKey 来自 URL query（不带参=默认工作区），
      // 而 flip 操作的是 body.ws —— 9-11 翻 piml 的三次事件全记进了 code_kl 的账本，
      // 导致"piml 从没被翻过"的误判（实际 piml/archive/flip-2026-09-11.md 5.36MB 真实存在）。
      // 翻页成功 ⇒ 接班会话即新主对话（总结/收尾的定向目标自动跟着换，无需手动重新指定）
      if (results.created) {
        try {
          const fk = wsKeyOf(String(b.ws ?? '')) || wsKey;
          const all = loadConvergeState();
          all[fk] = { ...(all[fk] || {}), mainSessionId: results.created };
          saveConvergeState(all);
        } catch {}
      }
      appendEvent(wsKeyOf(String(b.ws ?? '')) || wsKey, { t: 'flip.done', ws: b.ws, archived: results.archived.length, matched: results.matched ?? null, created: results.created });
      return json(200, { ok: results.errors.length === 0, ...results });
    }
    // v0.5 一键续跑：重派被中断的节点（dispatchJob 会自动注入 QUEST_RESUME_FROM 断点）
    if (req.method === 'POST' && u.pathname === '/api/resume') {
      const b = await readBody(req);
      const state = buildState(wsKey);
      const plan = state.plan ? parsePlan(state.plan) : null;
      if (!plan) return json(404, { ok: false, error: '该工作区没有 plan.md' });
      const targets = b.node
        ? plan.nodes.filter((x) => x.id === b.node)
        : plan.nodes.filter((x) => state.nodes[x.id]?.status === 'failed' && plan.nodes.find((y) => y.id === x.id)?.resumeOnBoot);
      if (!targets.length) return json(404, { ok: false, error: '没有可续跑的节点（需 resume_on_boot: true 且当前为失败态）' });
      const done = [];
      const failed = [];
      for (const node of targets) {
        try {
          markResumed(wsKey, node.id, appendEvent);
          appendEvent(wsKey, { t: 'node.unfrozen', node: node.id });
          const rr = await dispatchJob(wsKey, node);
          if (rr && rr.ok === false) { failed.push({ node: node.id, error: rr.error }); continue; }
          done.push(node.id);
        } catch (e) { log('续跑失败:', node.id, e?.message); }
      }
      appendEvent(wsKey, { t: 'resume.dispatched', nodes: done, failed });
      return json(200, { ok: failed.length === 0, resumed: done, ...(failed.length ? { failed } : {}) });
    }
    // 收线（2026-09-14）：把本线所有非终态节点冻结，让"被放弃的老线"彻底失去扳机。
    // 为什么需要：orchestrate 只由事件触发（写 plan / 节点退出 / 派发），所以遗留的 pending 节点
    // 是"休眠但挂着扳机"的——同一工作区里下一次任何动作都会顺带把它派出去：老线节点会和新的
    // quick 任务抢机器，而人/子对话早已不记得它为什么在那跑。
    // 可逆：重派某个节点 = 解冻该节点（见 /api/dispatch）；/api/resume 祖先会解冻它整条下游。
    if (req.method === 'POST' && u.pathname === '/api/close-line') {
      const b = await readBody(req);
      const state = buildState(wsKey);
      const plan = state.plan ? parsePlan(state.plan) : { nodes: [] };
      const inPlan = new Set(plan.nodes.map((n) => n.id));
      const ids = [...new Set([...Object.keys(state.nodes), ...plan.nodes.map((n) => n.id)])];
      const st = (id) => state.nodes[id]?.status ?? 'pending';
      // 只冻"还没开跑"的（pending/ready）：这些才是挂着扳机的。正在跑的**不动**——它跑完照常判定，
      // 否则会出现"状态写着 frozen、进程还在烧 CPU"的谎报；想连它一起停请用 /api/cancel。
      const freezable = ids.filter((id) => ['pending', 'ready'].includes(st(id))).map((id) => ({ id, status: st(id), inPlan: inPlan.has(id) }));
      const running = ids.filter((id) => st(id) === 'running').map((id) => ({ id, inPlan: inPlan.has(id) }));
      const reason = String(b.reason || '').slice(0, 200) || '收线：宣布本线结束，未派发的节点不再执行';
      if (b.apply !== true) {
        return json(200, {
          ok: true, dryRun: true, open: freezable, running,
          note: freezable.length
            ? `将冻结 ${freezable.length} 个未开跑的节点（${freezable.map((o) => o.id).join('、')}）；带 apply:true 生效`
            : (running.length ? `没有未开跑的节点可冻；${running.length} 个还在跑（收线不动它们，跑完照常判定）` : '本线已全部终结：收线是空操作，什么都不用做'),
        });
      }
      for (const o of freezable) appendEvent(wsKey, { t: 'node.frozen', node: o.id, reason });
      appendEvent(wsKey, { t: 'plan.closed', reason, nodes: freezable.map((o) => o.id), running: running.map((o) => o.id) });
      qqPush(wsKey, `[🔒 收线] ${freezable.length ? `已冻结 ${freezable.length} 个未开跑节点：${freezable.map((o) => o.id).join('、')}` : '没有未开跑的节点可冻'}${running.length ? `\n仍在跑（未动）：${running.map((o) => o.id).join('、')}` : ''}\n原因：${reason}\n复活办法：重派某个节点即可（或 resume 它的上游）。`).catch(() => {});
      return json(200, {
        ok: true, closed: freezable, running,
        note: freezable.length
          ? `已冻结 ${freezable.length} 个未开跑节点，这条线的扳机卸了；重派其中任何一个即可解冻`
          : '没有未开跑的节点可冻',
      });
    }
    // 收尾开关（2026-09-16 定稿"buff 式"）：默认开；按钮/QQ 是 on/off 开关而非一次性触发；
    // 每日 reopenTimes 定时重开（关了忘了开也没关系）。GET=status，POST={action:'on'|'off'|'toggle'}。
    if (u.pathname === '/api/converge') {
      const stateAll = loadConvergeState();
      const cur = stateAll[wsKey] || {};
      if (req.method === 'GET') {
        return json(200, { ok: true, auto: cur.auto !== false, mainSessionId: cur.mainSessionId || null, reopenTimes: CFG.notify?.converge?.reopenTimes ?? [] });
      }
      if (req.method === 'POST') {
        const b = await readBody(req);
        const action = String(b.action || 'toggle');
        if (action === 'main') {
          // 指定主对话（2026-09-16）：总结/收尾的定向目标。session/list 无 archived 标记，
          // 启发式必翻车（老主对话 2985M 还躺在列表里）⇒ 允许显式指定；翻页成功时自动更新为接班。
          const sid = String(b.sessionId || '');
          if (!sid) return json(200, { ok: false, error: '缺 sessionId' });
          stateAll[wsKey] = { ...cur, mainSessionId: sid };
          saveConvergeState(stateAll);
          appendEvent(wsKey, { t: 'converge.main', sessionId: sid });
          return json(200, { ok: true, mainSessionId: sid, note: '主对话已指定：后续总结/收尾都发给它（直到下次翻页自动换新接班）' });
        }
        const auto = action === 'on' ? true : action === 'off' ? false : !(cur.auto !== false);
        stateAll[wsKey] = { ...cur, auto };
        saveConvergeState(stateAll);
        appendEvent(wsKey, { t: 'converge.toggle', auto });
        return json(200, {
          ok: true, auto, mainSessionId: cur.mainSessionId || null,
          note: auto
            ? '自动收尾已开：全部节点终态 + 冷却后自动做全局总结（开关是唯一闸门，冷却内不重复；每日 ' + ((CFG.notify?.converge?.reopenTimes ?? []).join('/') || '—') + ' 定时重开）'
            : '自动收尾已关（一次性总结仍可用控制台收尾或 /q收尾 立即；' + ((CFG.notify?.converge?.reopenTimes ?? []).join('/') || '—') + ' 会自动帮你重开）',
        });
      }
    }
    // 手动收尾（一次性，不受开关影响）：给目标会话（缺省=本工作区最新的会话）排一条全局总结指令。
    // 给目标会话（缺省=本工作区最新的会话，通常是你正在用的那条；没有则新开）排一条全局总结指令。
    if (req.method === 'POST' && u.pathname === '/api/summarize') {
      const b = await readBody(req);
      const state = buildState(wsKey);
      const info = lineActivity(state);
      const wsPath = (() => { try { return parsePlan(state.plan || '').meta?.workspace || ws; } catch { return ws; } })();
      try {
        // 两阶段（与自动收尾同架构）：轻量会话干总结 → 主对话收通知。事件立即写，后续异步。
        appendEvent(wsKey, { t: 'notify.converge', manual: true, counts: info.counts, phase: 'started' });
        const result = await runConvergeAndNotify(wsKey, wsPath, info, { manual: true });
        appendEvent(wsKey, { t: 'notify.converge', manual: true, sessionId: result.workerSid, mainSid: result.mainSid || undefined, mainNotified: result.mainNotified, counts: info.counts, phase: 'done' });
        return json(200, {
          ok: true, sessionId: result.workerSid, mainSessionId: result.mainSid || null,
          note: `收尾会话 ${String(result.workerSid).slice(0, 16)}… 已完成总结${result.mainNotified ? `并通知了主对话 ${String(result.mainSid).slice(8, 16)}…` : '（未指定主对话）'}`,
        });
      } catch (e) {
        appendEvent(wsKey, { t: 'notify.converge', manual: true, error: String(e?.message || e).slice(0, 160) });
        return json(200, { ok: false, error: String(e?.message || e).slice(0, 200) });
      }
    }
    // P1-4：人工终止。杀树 + cancelled 独立终态（fixer 无视，绝不续杯），worker/总结全部静默。
    if (req.method === 'POST' && u.pathname === '/api/cancel') {
      const body = await readBody(req);
      {
        // 先解析 id：短后缀/片段唯一就当成它；解析不到直接 404，不写账本（防幽灵节点）
        const st0 = buildState(wsKey);
        const plan0 = st0.plan ? parsePlan(st0.plan) : { nodes: [] };
        const known = [...new Set([...Object.keys(st0.nodes), ...plan0.nodes.map((n) => n.id)])];
        const r = resolveNodeId(known, body.node);
        if (r.error) return json(404, { ok: false, error: r.error, matches: r.matches });
        if (r.resolvedFrom) log(`cancel: 「${r.resolvedFrom}」→ ${r.id}`);
        body.node = r.id;
      }
      const job = activeJobs.get(`${wsKey}|${body.node}`);
      if (!job) {
        // 账本说它已终结，但进程可能还活着——例如重启后认领之前的窗口，
        // 或外层 wsl.exe 被杀而 systemd 单元仍在跑（判 timeout 后负载继续）。
        // 按账本记录的 logTs/pid 兜底杀一次，并如实说明是哪种情况。
        const st0 = buildState(wsKey);
        const rec = st0.nodes[body.node] || {};
        let killed = false;
        const unitGuess = rec.logTs
          ? `quest-${String(body.node).replace(/[^a-zA-Z0-9_.-]/g, '_')}-${rec.logTs}`.slice(0, 90)
          : null;
        if (unitGuess) {
          try {
            await new Promise((r) => execFile("wsl.exe",
              ["-d", WSL_DISTRO(), "-u", "root", "--exec", "systemctl", "kill", unitGuess, "--signal=SIGKILL", "--kill-whom=all"], () => r()));
            killed = true;
          } catch {}
        }
        if (rec.pid) { try { execFile("taskkill", ["/PID", String(rec.pid), "/T", "/F"], () => {}); killed = true; } catch {} }
        appendEvent(wsKey, { t: 'cancel.fallback', node: body.node, unit: unitGuess || undefined, pid: rec.pid });
        return json(200, {
          ok: true,
          node: body.node,
          note: killed
            ? '账本里该节点已终结（不在活动作业表），已按其单元名/PID 兜底发出杀树指令'
            : '账本里该节点已终结，且没有可用的 pid/单元名兜底；若仍见进程存活请手动清理',
        });
      }
      job.cancelledByHuman = String(body.reason || '人工终止').slice(0, 200);
      killJobTree(job, job.child.pid);
      return json(200, { ok: true, node: body.node, note: '已杀树，等待退出事件落账（cancelled 终态，不触发自动修复）' });
    }
    if (req.method === 'POST' && u.pathname === '/api/dispatch') {
      const body = await readBody(req);
      const state = buildState(wsKey);
      const plan = state.plan ? parsePlan(state.plan) : null;
      {
        const r = resolveNodeId((plan?.nodes || []).map((n) => n.id), body.node);
        if (r.error) return json(404, { ok: false, error: r.error, matches: r.matches });
        if (r.resolvedFrom) log(`dispatch: 「${r.resolvedFrom}」→ ${r.id}`);
        body.node = r.id;
      }
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
      let node = u.searchParams.get('node') || '';
      const state = buildState(wsKey);
      // 与 cancel/dispatch 一致：支持唯一短后缀（AI 常用短 id 查日志）；解析不到 404，不猜
      {
        const plan0 = state.plan ? parsePlan(state.plan) : { nodes: [] };
        const known = [...new Set([...Object.keys(state.nodes), ...plan0.nodes.map((n) => n.id)])];
        const r = resolveNodeId(known, node);
        if (r.error) return json(404, { ok: false, error: r.error, matches: r.matches });
        node = r.id;
      }
      const n = state.nodes[node];
      if (!n?.logTs) return json(404, { error: '无日志' });
      const planN = state.plan ? parsePlan(state.plan).nodes.find((x) => x.id === node) : null;
      // 车道判定（2026-09-15 修）：以前只看 planN?.shell —— **快速单发不在 plan 里**，planN 恒为 null
      // ⇒ WSL 车道的 quick 节点会被当成 Windows 车道去 quests/<ws>/logs 找 ⇒ 永远 404"无日志"，
      // 而日志其实好好躺在 /home/<user>/quest-logs/ 里（实测：三方对拍节点的日志读不到，就是它）。
      // 正确来源：账本恢复的 n.shell（quick.dispatched 写入）优先，plan 声明兜底。
      const lane = n.shell || planN?.shell || 'windows';
      let files = [];
      let file = null;
      // 注意：同目录还有同前缀的 .unit（单元名）/ .pid，只认 .log——否则排序后
      // 会把 .unit 当成"最新文件"，读日志读到单元名（曾误导排查，以为 WSL 没抓到 stdout）
      if (lane === 'wsl') {
        const safe = wsKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(-40);
        const wdir = wslUnc(`/home/${WSL_USER()}/quest-logs/${safe}`);
        try { files = fs.readdirSync(wdir).filter((f) => f.startsWith(`${node}-`) && f.endsWith('.log')).sort(); } catch {}
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
      if (String(b.command).length > CMD_MAX_CHARS) {
        return json(200, { ok: false, error: `探测命令 ${String(b.command).length} 字符超过上限 ${CMD_MAX_CHARS}` });
      }
      const command = String(b.command);
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
      // 车道判定（2026-09-14 修）：探针以前只有 Windows 一条路。WSL 工作区的探针命令首词是 Linux
      // 绝对路径（/home/…/bin/python），在 Windows 上 spawn 必然 ENOENT；而 'error' 事件没人监听
      // ⇒ await child.on('exit') 永不返回 ⇒ 这个 HTTP 请求永远悬着，客户端 35s 后 AbortError，
      // 看着像"quest 服务不可达"。账本证据：5 条 probe.run 没有配对的 probe.done，其中 4 条是 Linux 路径命令。
      // 修法照抄 run：经 wsl.exe 中继，硬上限交给 Linux 侧 timeout（默认连整个进程组一起杀）。
      const wslLane = argv[0].startsWith('/') || String(cwd).startsWith('/');
      const secs = wslLane ? 25 : 30;   // WSL 留出中继启动与 kill 的余量，保证早于插件侧 35s
      let spawnErr = null;
      let child;
      if (wslLane) {
        const linuxCwd = String(cwd).startsWith('/') ? String(cwd) : uncToLinux(cwd);
        const wrapped = `cd ${shq(linuxCwd)} 2>/dev/null || { echo 'cd 失败: ${linuxCwd}'; exit 111; }; exec timeout -k 5 ${secs} bash -c ${shq(command)}`;
        child = spawn('wsl.exe', ['-d', WSL_DISTRO(), '--exec', 'bash', '-c', wrapped],
          { cwd: hostPathFor(linuxCwd), windowsHide: true, stdio: ['ignore', out, out] });
      } else {
        child = spawn(argv[0], argv.slice(1), { cwd: String(cwd).startsWith('/') ? hostPathFor(cwd) : cwd, windowsHide: true, stdio: ['ignore', out, out] });
      }
      questPids.set(child.pid, Date.now() + 5 * 60 * 1000);
      const startedAt = Date.now();
      let killed = false;
      const killer = setTimeout(() => {   // Windows 侧兜底：WSL 车道留给 Linux 侧 timeout 先动手
        killed = true;
        try { execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => {}); } catch {}
      }, (secs + 15) * 1000);
      const code = await new Promise((resolve) => {
        child.on('exit', resolve);
        child.on('error', (e) => { spawnErr = e; resolve(null); });
      });
      clearTimeout(killer);
      try { fs.closeSync(out); } catch {}
      if (spawnErr) {
        const why = `探测命令没能启动（${spawnErr.code || spawnErr.message}）：${wslLane ? 'WSL' : 'Windows'} 车道的解释器「${argv[0]}」、cwd「${cwd}」——检查它们是否属于该车道（Linux 绝对路径 ↔ Windows 盘符/UNC）。`;
        appendEvent(wsKey, { t: 'probe.error', error: why });
        return json(200, { ok: false, secs, error: why });
      }
      const timedOut = wslLane ? (code === 124 || code === 137) : killed;
      appendEvent(wsKey, { t: 'probe.done', code, ms: Date.now() - startedAt, killed: timedOut || undefined });
      return json(200, { ok: true, code, killed: timedOut, secs, ms: Date.now() - startedAt, log: readTail(logFile, 8192), logFile });
    }
    // 重新判定：用当前判定器重算历史节点（修完判定器/扫描路径后用来纠正旧账）
    if (req.method === 'POST' && u.pathname === '/api/rejudge') {
      const b = await readBody(req);
      const state = buildState(wsKey);
      const plan = state.plan ? parsePlan(state.plan) : { nodes: [] };
      const planById = new Map(plan.nodes.map((n) => [n.id, n]));
      const only = b.node ? [String(b.node)] : null;
      const targets = Object.keys(state.nodes).filter((id) => (!only || only.includes(id)));
      const changed = [];
      const skipped = [];
      const downgrades = [];
      for (const id of targets) {
        const n = state.nodes[id];
        if (['running'].includes(n.status)) { skipped.push({ node: id, why: '在跑' }); continue; }
        if (!n.logTs && !n.verdict) { skipped.push({ node: id, why: '无日志/无判定' }); continue; }
        const pn = planById.get(id) ?? {};
        // 车道按「日志到底在哪」反推：老账本没记 shell（quick.dispatched 是 2026-09-14 才加的），
        // 只看账本车道会把 WSL 快速单发当成 Windows → 找不到日志 → 全部跳过，而那批正是 /mnt/c 盲区
        // 的受害者，永远纠正不了（预演实测：134 个跳过里全是它们）。
        const logsDir = path.join(dirOf(wsKey), 'logs');
        const winLog = path.join(logsDir, `${id}-${n.logTs}.log`);
        const wslLog = wslUnc(`/home/${WSL_USER()}/quest-logs/${wsKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(-40)}/${id}-${n.logTs}.log`);
        let logFile = null; let lane = n.shell === 'wsl' ? 'wsl' : 'windows';
        if (fs.existsSync(winLog)) logFile = winLog;
        else if (fs.existsSync(wslLog)) { logFile = wslLog; lane = 'wsl'; }
        if (!logFile) { skipped.push({ node: id, why: '日志文件不存在（Windows 与 WSL 两侧都找了）' }); continue; }
        // 原始 cwd 若是"猜"的（plan 已被替换、账本也没记），重算就会扫错目录 → 把本来 ok 的判成
        // 无产物（预演实测 23 个这样的误降级）。宁可不重算，也不能制造新的假失败。
        const cwdKnown = pn.cwd || n.cwd;
        if (!cwdKnown) { skipped.push({ node: id, why: '原始工作目录未知（plan 已替换/账本未记），不重算以免误判' }); continue; }
        const node = { ...pn, id, cwd: cwdKnown, shell: lane, success: pn.success || n.success || '', expectMinutes: pn.expectMinutes ?? n.expectMinutes ?? 30 };
        // 退出码优先用账本里记的真实值（node.exited），其次才是日志里的 EXIT_CODE；
        // 都没有才当 0——否则 Windows 车道真实 exit 126 的崩溃会被误判成成功。
        const recovered = n.exitCode != null ? Number(n.exitCode) : recoverExitCode(logFile);
        const runSec = Math.round(Number(n.runSeconds || 0)) || 1;
        const startedAt = n.startedAt ? Date.parse(n.startedAt) : Date.now() - runSec * 1000;
        let j;
        try { j = judge(node, recovered == null ? 0 : recovered, runSec, logFile, startedAt, startedAt + runSec * 1000); }
        catch (e) { skipped.push({ node: id, why: '判定抛错 ' + (e?.message || e) }); continue; }
        const before = { verdict: n.verdict || null, via: n.via || null };
        // 比较时抹掉 "重新判定：" 前缀，否则重复运行会把同一次改判反复当成"又变了"（幂等问题）
        const strip = (s) => String(s || '').replace(/^重新判定：/, '');
        if (before.verdict === j.verdict && strip(before.via).startsWith(strip(j.via).slice(0, 12))) {
          skipped.push({ node: id, why: '判定未变（' + j.verdict + '）' });
          continue;
        }
        // 铁律：重算只用来**纠正假失败**（非 ok → ok）。反方向（ok → 非 ok）一律不写，
        // 只列进 downgrades 供人看——历史退出/产物可能已被清理，降级判断不可靠。
        if (before.verdict === 'ok' && j.verdict !== 'ok') { downgrades.push({ node: id, to: j.verdict, via: j.via, why: '重算比原判定更差，未写入' }); continue; }
        if (b.apply !== true) { changed.push({ node: id, from: before.verdict, to: j.verdict, via: j.via }); continue; }
        appendEvent(wsKey, { t: 'node.rejudged', node: id, from: before.verdict, fromVia: before.via, to: j.verdict, toVia: j.via });
        appendEvent(wsKey, { t: 'node.judged', node: id, verdict: j.verdict, via: `重新判定：${j.via}`, ...(j.detail ? { detail: j.detail } : {}) });
        appendEvent(wsKey, { t: j.verdict === 'ok' ? 'node.completed' : 'node.failed', node: id, verdict: j.verdict });
        changed.push({ node: id, from: before.verdict, to: j.verdict, via: j.via });
      }
      if (b.apply === true && changed.length) { try { writeProgress(wsKey); } catch {} }
      return json(200, {
        ok: true, applied: b.apply === true, changed: changed.length, unchanged: skipped.length,
        detail: changed, skipped: skipped.slice(0, 20), downgrades: downgrades.slice(0, 20), downgradeCount: downgrades.length,
        note: b.apply === true ? '已按新判定追加事件（历史事件保留，可审计）' : '这是预演（未写入）；确认后带 {"apply": true} 再调',
      });
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
  try { log('通知出口:', notifyKind(CFG)); } catch {}
  try { const _b = describeBackends(CFG); log(`后端: worker=${_b.workerBackend} fixer=${_b.fixerBackend}${_b.notes.length ? ' · ' + _b.notes.join('；') : ''}`); } catch {}
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
      // 2026-09-10 修复：对账要覆盖「账本节点 ∪ plan 节点」——快速单发（quest_run）只进账本
      // 不写 plan.md 的 node 段，只遍历 plan.nodes 会漏掉它们 → quest 重启即成幽灵 running。
      const planById = new Map(plan.nodes.map((n) => [n.id, n]));
      const ids = new Set([...Object.keys(state.nodes), ...planById.keys()]);
      for (const id of ids) {
        const n = state.nodes[id];
        if (n?.status !== 'running' || !n.pid) continue;
        const node = planById.get(id) ?? {
          // 账本独有的快速单发节点：**车道/命令/预期时长从账本恢复**（buildState 读 quick.dispatched）。
          // 以前这里硬编码 shell:'windows' —— WSL 车道的快速单发在重启后会被当 Windows 处理，
          // 去 Windows 侧找 pid 必然找不到 → 明明还在跑的 WSL 任务判成"进程已消失"（假失败）。
          id, command: n?.command || '', cwd: n?.cwd || plan.meta?.workspace || '',
          expectMinutes: n?.expectMinutes ?? 30, timeoutSeconds: 0,
          shell: n?.shell === 'wsl' ? 'wsl' : 'windows',
          quiet: true, autoFix: false, fixBudget: 0, when: '', after: [],
          watchRules: [], maxLogMB: 0, pushImages: 0, noCheckpoint: true, handoff: '',
          success: n?.success || '',
        };
        adoptOrphan(wsKey, node, n).catch((e) => log('再认领失败:', wsKey, id, e?.message));
      }
    }
  } catch {}
});
