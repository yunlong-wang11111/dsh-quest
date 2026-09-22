#!/usr/bin/env node
// tools/when-idle.mjs —— 只读诊断：这个工作区现在到底"在干活"还是"真完了"？
//
//   node tools/when-idle.mjs "__HOME__/Desktop/V8/code_kl"
//   node tools/when-idle.mjs            # 不带参数 = 扫最近有活动的所有工作区
//
// 为什么独立成脚本：服务端的同一份逻辑（lineActivity/evaluateQuiet）要重启才生效，
// 而这个工具直接读账本 + 工作区文件 mtime，**现在就能用**，且完全只读、不动任何状态。
//
// 判据说两件事（缺一不可）：
//   1) 账本：没有非终态节点，且最近 quietMinutes 分钟没有任何事件（含 probe.run——那说明有人在跑东西）
//   2) 工作区：最近 quietMinutes 分钟内没有文件被改（agent 改代码必然写文件）
// 两个都静 → "静默（收敛）"；否则告诉你卡在哪一边。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = process.env.QUEST_HOME || path.join(os.homedir(), '.dsh', 'quests');
const QUIET_MIN = Number(process.env.QUIET_MINUTES || 10);
const TERMINAL = new Set(['completed', 'failed', 'timeout', 'cancelled', 'skipped', 'frozen', 'preflight-failed']);
const WS_SKIP_DIRS = new Set(['.git', 'node_modules', 'archive', '__pycache__', 'logs', 'out', 'runs', '.venv', '__pycache__']);
const WS_SKIP_FILES = new Set(['progress.md', 'research-state.md', 'plan.md']);

const dirs = process.argv[2]
  ? [relKey(process.argv[2])]
  : fs.readdirSync(HOME, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
      .filter((d) => {
        try { return Date.now() - fs.statSync(path.join(HOME, d, 'ledger.jsonl')).mtimeMs < 6 * 3600 * 1000; } catch { return false; }
      });

function relKey(ws) {
  // 与 quest 的 wsKeyOf 一致：C:/a/b → C-a-b（这样能直接定位账本目录）
  return String(ws).replace(/^[A-Za-z]:[\\/]/, (m) => m[0].toUpperCase() + '-').replace(/[\\/]+/g, '-').replace(/-+$/, '');
}

function scanWorkspace(dir, minutes) {
  if (!dir) return null;
  let st; try { st = fs.statSync(dir); } catch { return null; }
  if (!st.isDirectory()) return null;
  const found = [];
  const walk = (d, depth) => {
    let list; try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      if (found.length > 3000) return;
      if (e.isDirectory()) { if (depth > 0 && !WS_SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(d, e.name), depth - 1); continue; }
      if (!e.isFile() || WS_SKIP_FILES.has(e.name)) continue;
      try { found.push({ name: e.name, mtimeMs: fs.statSync(path.join(d, e.name)).mtimeMs }); } catch {}
    }
  };
  walk(dir, 2);
  if (!found.length) return { recent: 0, latest: null };
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const minute = 60000;
  return { recent: found.filter((f) => Date.now() - f.mtimeMs < minutes * minute).length, latest: found[0] };
}

function analyze(key) {
  const file = path.join(HOME, key, 'ledger.jsonl');
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  const nodes = {};
  let lastAct = 0, lastQuiet = 0, wsDir = '';
  for (const l of lines) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    const at = e.at ? Date.parse(e.at) || 0 : 0;
    if (!e.node) {
      if (e.t === 'line.quiet') { lastQuiet = Math.max(lastQuiet, at); continue; }  // 记账事件不算活动
      lastAct = Math.max(lastAct, at);
      continue;
    }
    // 只有"派发"事件才有资格新建节点。cancel.fallback 之类可能带一个不存在或短后缀的 id，
    // 建出来的幽灵节点永远不终结（时长显示成 2900 万分钟 = epoch 0），并且让"还在跑"永远为真。
    // 2026-09-14 实测：一句 `/q取消 mu0m8nck`（旧版没那么写全 id）就留下两个幽灵，重启门禁因此常关。
    const CREATES = e.t === 'node.dispatched' || e.t === 'quick.dispatched';
    const n = nodes[e.node] ?? (CREATES ? (nodes[e.node] = { status: 'pending' }) : null);
    if (!n) { lastAct = Math.max(lastAct, at); continue; }
    if (CREATES) { n.status = 'running'; n.at = at; }
    else if (e.t === 'node.completed') n.status = 'completed';
    else if (TERMINAL.has(e.t.replace('node.', ''))) n.status = e.t.replace('node.', '');
    lastAct = Math.max(lastAct, at);
  }
  // 工作区路径优先取 plan.md 里的声明
  try {
    const md = fs.readFileSync(path.join(HOME, key, 'plan.md'), 'utf8');
    wsDir = (md.match(/^workspace:\s*(.+)$/m) || [])[1]?.trim() || '';
  } catch {}
  const ids = Object.keys(nodes);
  const active = ids.filter((id) => !TERMINAL.has(nodes[id].status));
  const idleMs = lastAct ? Date.now() - lastAct : null;
  const ws = scanWorkspace(wsDir, QUIET_MIN);
  const wsIdleMs = ws?.latest ? Date.now() - ws.latest.mtimeMs : null;
  const ledgerQuiet = active.length === 0 && idleMs != null && idleMs >= QUIET_MIN * 60000 && lastAct > lastQuiet;
  const wsQuiet = wsIdleMs == null || wsIdleMs >= QUIET_MIN * 60000;
  return { key, ids, active, nodes, lastAct, idleMs, ws, wsIdleMs, ledgerQuiet, wsQuiet };
}

const fmt = (ms) => (ms == null ? '-' : ms < 60000 ? '不到 1 分钟' : `${Math.round(ms / 60000)} 分钟`);

for (const key of dirs) {
  const a = analyze(key);
  if (!a) continue;
  const quiet = a.ledgerQuiet && a.wsQuiet;
  console.log(`\n=== ${key} ===`);
  console.log(`  节点 ${a.ids.length} 个｜在跑 ${a.active.length} 个${a.active.length ? '：' + a.active.slice(0, 3).map((id) => id.slice(0, 34)).join('、') : ''}`);
  console.log(`  账本：最近动作 ${fmt(a.idleMs)}前 ${a.ledgerQuiet ? '✓ 已静' : a.active.length ? '✗ 任务在跑' : '✗ 还在静默窗口内'}`);
  console.log(`  工作区：${a.ws == null ? '（拿不到路径）' : a.ws.latest ? `最新改动 ${a.ws.latest.name}（${fmt(a.wsIdleMs)}前），近 ${QUIET_MIN} 分钟 ${a.ws.recent} 个文件被改 → ${a.wsQuiet ? '✓ 已静' : '✗ 有人正在改代码'}` : '无文件'}`);
  console.log(`  ⇒ ${quiet ? '静默（收敛）：没有在跑的任务，账本与工作区都安静了' : '仍在进行：上面 ✗ 的那一行就是它在干什么'}`);
  if (!quiet && a.active.length) {
    const worst = a.active.map((id) => `${id.slice(0, 30)}（${a.nodes[id].at ? fmt(Date.now() - a.nodes[id].at) : '起点不明'}）`).join('、');
    console.log(`     在跑：${worst}`);
  }
}
console.log(`\n（判据：账本安静 ≥${QUIET_MIN} 分钟且工作区 ≥${QUIET_MIN} 分钟无文件改动；可用 QUIET_MINUTES 环境变量调整）`);
