// tests/fail-batch.mjs —— 失败风暴聚合：同一窗口内的多个失败节点只发一条汇总
// 背景（2026-09-17）：风暴日 65 个失败节点逐条推 QQ，把桥的 60/小时限额顶满（429 丢信）。
// 覆盖：① 窗口内 N 个失败 → 1 条汇总（含每个节点首行）；② ok 不聚合仍即时；
//       ③ 窗口外的新失败重新开窗；④ 显式 failureBatchSec:0 关闭聚合回到逐条。
import http from 'node:http';
import { startSandbox, suite, waitFor, sleep } from './lib.mjs';

const HOOK = 3129;
const s = suite('fail-batch');
const got = [];
const hook = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => { b += d; });
  req.on('end', () => { got.push(b); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
});
await new Promise((r) => hook.listen(HOOK, '127.0.0.1', r));

// ── 幕一：聚合开（窗口 2 秒）──
const sb = await startSandbox({
  name: 'fail-batch', port: 3131, wsDirs: ['ws'],
  extraConfig: { notify: { kind: 'webhook', url: `http://127.0.0.1:${HOOK}/h1`, failureBatchSec: 2 }, runGate: { enabled: false }, workersEnabled: false },
});
const WS = sb.ws.ws;
try {
  const plan = `workspace: ${WS}\nfreeze_on: hard-fail-only\n` +
    `---node: f1---\ncommand: cmd /c exit 1\ncwd: ${WS}\nexpect_minutes: 1\n\n` +
    `---node: f2---\ncommand: cmd /c exit 2\ncwd: ${WS}\nexpect_minutes: 1\n\n` +
    `---node: f3---\ncommand: cmd /c exit 3\ncwd: ${WS}\nexpect_minutes: 1\n\n` +
    `---node: good---\ncommand: cmd /c echo DONE> ok.txt\ncwd: ${WS}\nexpect_minutes: 1\nsuccess: 产出 ok.txt\n\n`;
  await sb.api('POST', `/api/plan?ws=${encodeURIComponent(WS)}`, { markdown: plan });
  await sleep(800);
  for (const n of ['f1', 'f2', 'good', 'f3']) await sb.api('POST', `/api/dispatch?ws=${encodeURIComponent(WS)}`, { node: n });
  await waitFor(async () => ['failed', 'completed'].includes((await sb.status(WS)).find((n) => n.id === 'f3')?.status), 30000);
  await sleep(4500);   // 窗口 2s + 推送落地

  const msgs1 = got.slice();
  const joined = msgs1.join('\n');
  s.check('① 4 个节点（3 失败 + 1 成功）没有 4 条推送', msgs1.length <= 3, `条数=${msgs1.length}`);
  s.check('② 失败聚成一条汇总', /失败汇总·3 个节点/.test(joined), joined.match(/失败汇总[^\n]{0,30}/)?.[0] || '没找到汇总');
  s.check('③ 汇总里逐个点名（f1/f2/f3 首行）', /1\..*f1/.test(joined) && /2\..*f2/.test(joined) && /3\..*f3/.test(joined));
  s.check('④ ok 的即时推送未被聚合', /\[✅ ok\] good/.test(joined));

  // 窗口外的独立失败 → 自己开窗、单条直发（不硬凑汇总）
  got.length = 0;
  await sb.api('POST', `/api/dispatch?ws=${encodeURIComponent(WS)}`, { node: 'f1' });
  await waitFor(async () => (await sb.status(WS)).find((n) => n.id === 'f1')?.status === 'failed', 30000);
  await sleep(4500);
  const solo = got.join('\n');
  s.check('⑤ 窗口外单个失败 = 原样单条（不带汇总头）', /\[❌ /.test(solo) && !/失败汇总/.test(solo), solo.slice(0, 80));
} finally { sb.stop(); }

// ── 幕二：显式 0 关闭聚合（原逐条行为）──
const sb2 = await startSandbox({
  name: 'fail-batch-off', port: 3132, wsDirs: ['ws'],
  extraConfig: { notify: { kind: 'webhook', url: `http://127.0.0.1:${HOOK}/h2`, failureBatchSec: 0 }, runGate: { enabled: false }, workersEnabled: false },
});
const WS2 = sb2.ws.ws;
try {
  const plan2 = `workspace: ${WS2}\n` +
    `---node: a---\ncommand: cmd /c exit 1\ncwd: ${WS2}\nexpect_minutes: 1\n\n` +
    `---node: b---\ncommand: cmd /c exit 1\ncwd: ${WS2}\nexpect_minutes: 1\n\n`;
  await sb2.api('POST', `/api/plan?ws=${encodeURIComponent(WS2)}`, { markdown: plan2 });
  await sleep(800);
  for (const n of ['a', 'b']) await sb2.api('POST', `/api/dispatch?ws=${encodeURIComponent(WS2)}`, { node: n });
  await waitFor(async () => (await sb2.status(WS2)).find((n) => n.id === 'b')?.status === 'failed', 30000);
  await sleep(2500);
  const joined2 = got.join('\n');
  s.check('⑥ failureBatchSec:0 → 逐条直发不聚合', /\[❌ [^\]]*\] a/.test(joined2) && /\[❌ [^\]]*\] b/.test(joined2) && !/失败汇总/.test(joined2));
} finally { sb2.stop(); }

await new Promise((r) => hook.close(r));
s.done();
