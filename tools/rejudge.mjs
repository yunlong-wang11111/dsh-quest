// 用 /api/rejudge 预演 → 报告 → （apply 时）写入
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = process.argv[2] || '__HOME__/Desktop/V8/code_kl';
const APPLY = process.argv.includes('--apply');
const HOME = path.join(os.homedir(), '.dsh', 'quests');
const token = fs.readFileSync(path.join(HOME, '.token'), 'utf8').trim();

const call = async (p, body) => {
  const r = await fetch('http://127.0.0.1:3110' + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-quest-token': token }, body: JSON.stringify(body) });
  const t = await r.text();
  try { return { status: r.status, json: JSON.parse(t) }; } catch { return { status: r.status, json: { raw: t.slice(0, 300) } }; }
};

const url = '/api/rejudge?ws=' + encodeURIComponent(WS);
const dry = await call(url, { apply: false });
if (!dry.json.ok) { console.log('❌ 预演失败：', JSON.stringify(dry.json).slice(0, 300)); process.exit(1); }
console.log('=== 预演（未写入）：' + WS + ' ===');
console.log(`  判定会变：${dry.json.changed} 个    判定不变/跳过：${dry.json.unchanged} 个`);
const flip = (dry.json.detail || []).filter((d) => d.from !== d.to);
const toOk = flip.filter((d) => d.to === 'ok');
const toBad = flip.filter((d) => d.to !== 'ok');
console.log(`\n  ⇒ 会从失败翻成 ok：${toOk.length} 个`);
for (const d of toOk.slice(0, 14)) console.log(`     ${String(d.from).padEnd(9)} → ok   ${String(d.node).slice(0, 52)}   [${String(d.via || '').slice(0, 40)}]`);
if (toOk.length > 14) console.log(`     … 还有 ${toOk.length - 14} 个`);
if (toBad.length) {
  console.log(`\n  ⇒ 会从 ok 变成非 ok：${toBad.length} 个（要警惕，说明现在判得更严）`);
  for (const d of toBad.slice(0, 8)) console.log(`     ${String(d.from).padEnd(9)} → ${d.to}   ${String(d.node).slice(0, 52)}   [${String(d.via || '').slice(0, 40)}]`);
}
if (APPLY) {
  const ap = await call(url, { apply: true });
  console.log(`\n=== 已写入：改判 ${ap.json.changed} 个（追加 node.rejudged + 新 judged/completed|failed，历史事件保留） ===`);
  const after = await call('/api/rejudge?ws=' + encodeURIComponent(WS), { apply: false });
  console.log(`  再预演一次应为 0 变化：${after.json.changed} 个  ${after.json.changed === 0 ? '✓' : '✗（有幂等问题，需要看）'}`);
} else {
  console.log('\n（这是预演。要写入就加 --apply）');
}
