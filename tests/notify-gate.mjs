// tests/notify-gate.mjs —— 通知闸门三件套（2026-09-18 用户定稿："只有收尾需要我决策时才通知"）
// ① nodeEvents 缺省（未配置）→ Tier-0 照常（回归护栏）
// ② nodeEvents:false → 节点成败/失败聚合全部静音，但收敛（收尾）通知照响
// ③ /api/notify（AI 点名）→ 送达且带 [🔔 前缀；冷却内第二次被拒
import http from 'node:http';
import { startSandbox, suite, waitFor, sleep } from './lib.mjs';

const HOOK = 3151;
const s = suite('notify-gate');
const got = [];
const hook = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => { b += d; });
  req.on('end', () => { got.push(b); res.writeHead(200); res.end('{"ok":true}'); });
});
await new Promise((r) => hook.listen(HOOK, '127.0.0.1', r));

// ── 幕一：缺省 = Tier-0 照常 ──
const sb1 = await startSandbox({
  name: 'ng-on', port: 3152, wsDirs: ['ws'],
  extraConfig: { notify: { kind: 'webhook', url: `http://127.0.0.1:${HOOK}/h1`, failureBatchSec: 1 }, runGate: { enabled: false }, workersEnabled: false },
});
try {
  const WS = sb1.ws.ws;
  await sb1.api('POST', `/api/plan?ws=${encodeURIComponent(WS)}`, { markdown: `workspace: ${WS}\n---node: f---\ncommand: cmd /c exit 1\ncwd: ${WS}\nexpect_minutes: 1\n\n` });
  await sleep(600);
  await sb1.api('POST', `/api/dispatch?ws=${encodeURIComponent(WS)}`, { node: 'f' });
  await waitFor(async () => (await sb1.status(WS)).find((n) => n.id === 'f')?.status === 'failed', 30000);
  await sleep(3000);   // 单失败不聚合，直发
  s.check('① 缺省时失败照常推送', got.some((g) => g.includes('❌')), `got=${got.length}`);
} finally { sb1.stop(); }

// ── 幕二：nodeEvents:false → 静音但收尾照响（带 DSH 桩：收敛要建收尾会话）──
got.length = 0;
const DSTUB = 3155;
const stub2 = http.createServer((req, res) => {
  if (req.method === 'GET') { res.writeHead(303, { 'set-cookie': 'sid=stub; Path=/', location: '/' }); res.end(); return; }
  let b = ''; req.on('data', (d) => { b += d; });
  req.on('end', () => {
    let msg = {}; try { msg = JSON.parse(b || '{}'); } catch {}
    const method = String(msg.method || '');
    let value = { items: [] };
    if (method.includes('create')) value = { sessionId: 'sess-worker-x' };
    else if (method.includes('prompt')) value = {};
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ rpcId: msg.rpcId, result: { ok: true, value } }));
  });
});
await new Promise((r) => stub2.listen(DSTUB, '127.0.0.1', r));
const sb2 = await startSandbox({
  name: 'ng-off', port: 3153, wsDirs: ['ws'],
  extraConfig: {
    dshBaseUrl: `http://127.0.0.1:${DSTUB}`, dshToken: 'stub-token',
    notify: { kind: 'webhook', url: `http://127.0.0.1:${HOOK}/h2`, nodeEvents: false, converge: { enabled: true, cooldownMin: 5, presenceMin: 0, reopenTimes: [] } },
    runGate: { enabled: false }, workersEnabled: false, quietMinutes: 0.05, sweepSeconds: 3,
  },
});
try {
  const WS = sb2.ws.ws;
  await sb2.api('POST', `/api/plan?ws=${encodeURIComponent(WS)}`, { markdown: `workspace: ${WS}\nfreeze_on: hard-fail-only\n---node: f---\ncommand: cmd /c exit 1\ncwd: ${WS}\nexpect_minutes: 1\n\n---node: g---\ncommand: cmd /c echo DONE> ok.txt\ncwd: ${WS}\nexpect_minutes: 1\nsuccess: 产出 ok.txt\n\n` });
  await sleep(600);
  await sb2.api('POST', `/api/dispatch?ws=${encodeURIComponent(WS)}`, { node: 'f' });
  await sb2.api('POST', `/api/dispatch?ws=${encodeURIComponent(WS)}`, { node: 'g' });
  await waitFor(async () => (await sb2.status(WS)).every((n) => ['completed', 'failed'].includes(n.status)), 30000);
  await sleep(16000);   // 等收敛链（quiet 3s×2 + worker 即回 + 收尾推送）
  const all = got.map((g) => decodeURIComponent(g)).join('\n');
  s.check('② 静音：成功/失败节点推送都没有', !/\[✅ ok\]|\[❌/.test(all), got.map((g) => decodeURIComponent(g).slice(0, 40)).join(' | ').slice(0, 80));
  s.check('③ 收尾（收敛）通知照响', /收尾|静默|总结/.test(all), all.slice(0, 80) || '(空)');
} finally { sb2.stop(); await new Promise((r) => stub2.close(r)); }

// ── 幕三：AI 点名 ──
got.length = 0;
const sb3 = await startSandbox({
  name: 'ng-ping', port: 3154, wsDirs: ['ws'],
  extraConfig: { notify: { kind: 'webhook', url: `http://127.0.0.1:${HOOK}/h3`, userPingCooldownSec: 5 }, runGate: { enabled: false } },
});
try {
  const WS = sb3.ws.ws;
  const r1 = await sb3.api('POST', `/api/notify?ws=${encodeURIComponent(WS)}`, { message: '需要拍板：A 还是 B？我建议 A。' });
  await sleep(500);
  const r2 = await sb3.api('POST', `/api/notify?ws=${encodeURIComponent(WS)}`, { message: '第二条应该被冷却挡住' });
  const txt = got.map((g) => decodeURIComponent(g)).join('\n');
  s.check('④ 点名送达且带前缀', r1.json?.ok === true && txt.includes('AI 点名'), JSON.stringify(r1.json) + ' | ' + txt.slice(0, 50));
  s.check('⑤ 冷却挡住连发', r2.json?.ok === false, JSON.stringify(r2.json));
  const r3 = await sb3.api('POST', `/api/notify?ws=${encodeURIComponent(WS)}`, { message: '' });
  s.check('⑥ 空消息 400', r3.json?.ok === false, JSON.stringify(r3.json));
} finally { sb3.stop(); }

await new Promise((r) => hook.close(r));
s.done();
