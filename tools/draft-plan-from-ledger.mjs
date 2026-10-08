#!/usr/bin/env node
// tools/draft-plan-from-ledger.mjs —— 按账本里**真跑过**的节点起草一份 plan.md
//
// 用途（2026-09-14 用户问"后补 plan 可以吗"）：能先写 plan 就先写（跑的时候画布能看进度、能自动续链/冻结）；
// 但事后补一张图也可以——前提是**节点 id 必须和账本里跑过的一致**，否则画布上那些节点会显示成"待办"、
// 状态接不上。本工具把最近 N 个真派发过的节点按原 id 抄出来（带 command/cwd/shell 与账本里的最终状态），
// 你/AI 只要补上 `after:` 依赖与 `success:` 判据再提交即可。
//
// 用法：
//   node tools/draft-plan-from-ledger.mjs "__HOME__/Desktop/V8/code_kl"            # 打到屏幕
//   node tools/draft-plan-from-ledger.mjs <ws> --last 12 --out draft.md                      # 写文件
//   node tools/draft-plan-from-ledger.mjs <ws> --title "R3+R4 复盘" --last 6
// 只读账本，不碰 plan.md、不调服务；起草结果要不要用由你决定。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = process.env.QUEST_HOME || path.join(os.homedir(), '.dsh', 'quests');
const args = process.argv.slice(2);
const ws = args.find((a) => !a.startsWith('--'));
const valOf = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const LAST = Math.max(1, Number(valOf('--last', '10')) || 10);
const OUT = valOf('--out', '');
const TITLE = valOf('--title', '');

if (!ws) {
  console.log('用法：node tools/draft-plan-from-ledger.mjs <工作区路径> [--last 10] [--out draft.md] [--title "…"]');
  process.exit(2);
}

// 与 quest 的 wsKeyOf 一致：/mnt/c/… 与 C:\… 归一，再换成 C-… 形状
const wsKeyOf = (p) => {
  let s = String(p || '').trim();
  const m = s.match(/^\/mnt\/([a-zA-Z])(\/.*)?$/);
  if (m) s = m[1].toUpperCase() + ':' + (m[2] || '/');
  return s.replace(/\\/g, '/').replace(/\/+$/, '').replace(/[:/]/g, (c) => (c === ':' ? '' : '-'));
};
const key = wsKeyOf(ws);
const ledger = path.join(HOME, key, 'ledger.jsonl');
if (!fs.existsSync(ledger)) {
  const cands = fs.existsSync(HOME) ? fs.readdirSync(HOME).filter((d) => d.toLowerCase().includes(key.toLowerCase())) : [];
  console.log(`✗ 找不到账本：${ledger}`);
  if (cands.length) console.log('  是不是这个？ ' + cands.join('、'));
  process.exit(1);
}

const TERMINAL = new Set(['completed', 'failed', 'timeout', 'cancelled', 'skipped', 'frozen']);
const nodes = new Map();     // id → {command, cwd, shell, success, status, verdict, at}
for (const line of fs.readFileSync(ledger, 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue;
  let e; try { e = JSON.parse(line); } catch { continue; }
  if (!e.node) continue;
  if (e.t === 'quick.dispatched') {
    nodes.set(e.node, { ...(nodes.get(e.node) || {}), command: e.command || '', cwd: e.cwd || '', shell: e.shell || 'windows', success: e.success || '', at: e.at });
  } else if (e.t === 'node.dispatched') {
    if (!nodes.has(e.node)) nodes.set(e.node, { command: '', cwd: '', shell: 'windows', success: '', at: e.at });
  } else if (e.t === 'node.judged') {
    const n = nodes.get(e.node) || {}; nodes.set(e.node, { ...n, verdict: e.verdict || '', via: e.via || '' });
  } else if (TERMINAL.has(String(e.t).replace('node.', ''))) {
    const n = nodes.get(e.node) || {}; nodes.set(e.node, { ...n, status: String(e.t).replace('node.', '') });
  }
}
const all = [...nodes.entries()];
if (!all.length) { console.log('✗ 这个工作区的账本里还没有节点'); process.exit(1); }
const picked = all.slice(-LAST);
const shells = picked.map(([, v]) => v.shell).filter(Boolean);
const shell = shells.filter((s) => s === 'wsl').length > shells.length / 2 ? 'wsl' : 'windows';

const L = [];
L.push(`# 任务线：${TITLE || '（给这条线起一句话：这批实验在验证什么）'}`);
L.push(`workspace: ${ws}`);
L.push(`shell: ${shell}`);
L.push('# 由 tools/draft-plan-from-ledger.mjs 按账本里真跑过的节点起草：**id 原样保留**，状态才能接上。');
L.push('# 待补：① 每个节点写清 after（真实依赖；不写就是并列链头）② 有价值的话补 success: 判据（真实会写出的产物/关键词）');
L.push('');
for (const [id, v] of picked) {
  L.push(`---node: ${id}---`);
  L.push(`command: ${v.command || '（账本只记了派发没记命令——请补上真实命令）'}`);
  L.push(`cwd: ${v.cwd || ws}`);
  if (v.shell === 'wsl') L.push('shell: wsl');
  if (v.success) L.push(`success: ${v.success}`);
  L.push(`# 账本状态：${v.status || '未终结'}${v.verdict ? ` / ${v.verdict}` : ''}${v.via ? `（${v.via}）` : ''}${v.at ? ` · ${v.at}` : ''}`);
  L.push('');
}

const text = L.join('\n');
if (OUT) { fs.writeFileSync(OUT, text, 'utf8'); console.log(`已写出 ${OUT}（${picked.length} 个节点）——检查 after/success 后再用 quest_plan 提交`); }
else console.log(text);
