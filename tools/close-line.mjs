#!/usr/bin/env node
// tools/close-line.mjs —— 收线：宣布一条任务线结束，把还没派发的节点冻结掉
//
// 为什么需要（2026-09-14 起因）：orchestrate 只在"写 plan / 节点退出 / 派发"这些事件上跑，
// 所以被放弃的老线里遗留的 pending 节点是**休眠但挂着扳机**——同一工作区里下一次任何动作
// （哪怕只是派一个新 quick）都会顺带把它派出去：老线节点和新任务抢机器，而人早已不记得它为什么在跑。
// 全终结的线不需要收：冻结是空操作（它已经没有扳机可卸）。
//
// 用法：
//   node tools/close-line.mjs "C:/Users/Solanine/Desktop/V8/code_kl"           # 只看（dry-run）
//   node tools/close-line.mjs "C:/Users/Solanine/Desktop/V8/code_kl" --apply   # 真收线
//   node tools/close-line.mjs <ws> --apply --reason "V13 门槛线已出结论，收线"
//
// 可逆：重派某个节点 = 解冻该节点；/api/resume 它的上游 = 解冻它整条下游。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = process.env.QUEST_HOME || path.join(os.homedir(), '.dsh', 'quests');
const PORT = Number(process.env.QUEST_PORT || 3110);
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const ws = args.find((a) => !a.startsWith('--'));
const ri = args.indexOf('--reason');
const reason = ri >= 0 ? String(args[ri + 1] || '') : '';

if (!ws) {
  console.log('用法：node tools/close-line.mjs <工作区路径> [--apply] [--reason "为什么收线"]');
  console.log('  不带 --apply 只列出将冻结的节点，不动账本。');
  process.exit(2);
}

let token = '';
for (const f of [path.join(HOME, '.token'), path.join(os.homedir(), '.dsh', 'quests', '.token'), '.token']) {
  try { token = fs.readFileSync(f, 'utf8').trim(); if (token) break; } catch {}
}
if (!token) { console.log('✗ 找不到 quest token（试过 QUEST_HOME/.token）——quest 在跑吗？'); process.exit(1); }

const call = async (p, body) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-quest-token': token },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  try { return { status: r.status, json: JSON.parse(text) }; } catch { return { status: r.status, json: { raw: text.slice(0, 300) } }; }
};

const p = `/api/close-line?ws=${encodeURIComponent(ws)}`;
const body = { reason: reason || undefined, apply };
let res;
try {
  res = await call(p, body);
} catch (e) {
  console.log(`✗ 连不上 quest（127.0.0.1:${PORT}）：${e?.message || e}`);
  process.exit(1);
}
const j = res.json || {};
if (j.error || (res.status !== 200)) {
  console.log(`✗ 收线失败（HTTP ${res.status}）：${j.error || JSON.stringify(j).slice(0, 200)}`);
  process.exit(1);
}

if (j.dryRun) {
  const open = j.open || [];
  console.log(`\n=== 收线预演：${ws} ===`);
  if (!open.length) {
    console.log('  本线已全部终结 —— 不需要收线（冻结是空操作，老线也不会自己再跑起来）');
  } else {
    console.log(`  将冻结 ${open.length} 个非终态节点（它们现在还"挂着扳机"）：`);
    for (const o of open) console.log(`     ${String(o.status).padEnd(9)} ${o.id}${o.inPlan ? '' : '   (不在当前 plan 里)'}`);
    console.log(`\n  ${j.note}`);
    console.log('  确认无误：加 --apply 真收线（可逆：重派某个节点即解冻它）。');
  }
} else {
  const c = j.closed || [];
  console.log(`\n🔒 已收线：${ws}`);
  console.log(c.length ? `   冻结了 ${c.length} 个节点：${c.map((o) => o.id).join('、')}` : '   本线已全部终结（没有可冻结的节点）');
  console.log(`   ${j.note}`);
  console.log('   复活办法：重派其中一个节点（=人工解冻），或 resume 它的上游（解冻整条下游）。');
}
