// tests/escalate-failure.mjs —— 第2级·失败上报：失败要报告给派发它的主对话（指针式+冷却）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { startSandbox, waitFor, suite, sleep } from './lib.mjs';

const PORT = 3129;
const DSH = 3130;
const s = suite('escalate-failure');
let sessions = [];
const prompts = [];
const stub = http.createServer((req, res) => {
  if (req.method === 'GET') { res.writeHead(303, { 'set-cookie': 'sid=stub; Path=/', location: '/' }); res.end(); return; }
  let b = '';
  req.on('data', (d) => { b += d; });
  req.on('end', () => {
    let msg = {}; try { msg = JSON.parse(b || '{}'); } catch {}
    const p = msg.payload?.args?.request ?? msg.payload?.args?._request ?? {};
    if (String(msg.method).includes('prompt')) prompts.push({ sid: p.sessionId, text: JSON.stringify(p.content ?? '') });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ rpcId: msg.rpcId, result: { ok: true, value: { items: sessions } } }));
  });
});
await new Promise((r) => stub.listen(DSH, '127.0.0.1', r));

const sb = await startSandbox({
  name: 'escalate-failure', port: PORT, wsDirs: ['ws'],
  extraConfig: {
    dshBaseUrl: `http://127.0.0.1:${DSH}`, dshToken: 'stub',
    runGate: { enabled: false }, notify: { kind: 'off', escalate: { cooldownMin: 1 } },
    workersEnabled: false,
  },
});
const WS = sb.ws.ws;
try {
  sessions = [{ sessionId: 'sess-main', cwd: WS, running: false, updatedAt: Date.now() }];
  fs.writeFileSync(path.join(WS, 'bad.js'), 'process.exit(1);\n');
  fs.writeFileSync(path.join(WS, 'good.js'), 'console.log("DONE");require("fs").writeFileSync("ok.txt","x");\n');

  // ① 失败节点 → 上报给最新会话（指针式）
  const r1 = await sb.api('POST', `/api/run?ws=${encodeURIComponent(WS)}`, { command: 'node bad.js', cwd: WS, title: 'fail-1', expect_minutes: 1 });
  const fired = await waitFor(() => prompts.some((p) => p.text.includes('fail-1') || p.text.includes('失败上报')), 30000, 1000);
  s.check('① 失败 → 上报排给最新会话', fired && prompts[prompts.length - 1].sid === 'sess-main', 'prompts=' + prompts.length);
  s.check('① 消息是指针式（含 quest_log/quest_dispatch 指引、不含长日志）', (() => { const t = prompts[prompts.length - 1]?.text || ''; return t.includes('quest_log') && t.includes('quest_dispatch') && t.length < 900; })());

  // ② 冷却内的第二次失败 → 不重复上报（QQ/收敛兜底）
  const n1 = prompts.length;
  await sleep(1000);
  const r2 = await sb.api('POST', `/api/run?ws=${encodeURIComponent(WS)}`, { command: 'node bad.js', cwd: WS, title: 'fail-2', expect_minutes: 1 });
  await waitFor(async () => (await sb.status(WS)).find((n) => n.id === r2.json.nodeId)?.status === 'failed', 30000);
  await sleep(3000);
  s.check('② 冷却内不重复上报', prompts.length === n1, `${n1}→${prompts.length}`);

  // ④ 派发者点名：带 dispatchedBy 的失败 → 回派发者本人，即使存在更新的会话（防双重修改）
  await sleep(61 * 1000);   // 等冷却过（本沙箱配了 1 分钟）
  sessions = [
    { sessionId: 'session-sess-newest-x', cwd: WS, running: false, updatedAt: Date.now() },       // 更新，但不是派发者
    { sessionId: 'session-sess-old-dispatcher', cwd: WS, running: false, updatedAt: Date.now() - 90 * 60000 }, // 派发者，旧
  ];
  const r4 = await sb.api('POST', `/api/run?ws=${encodeURIComponent(WS)}`, { command: 'node bad.js', cwd: WS, title: 'fail-3', expect_minutes: 1, dispatchedBy: 'session-sess-old-dispatcher' });
  await waitFor(async () => (await sb.status(WS)).find((n) => n.id === r4.json.nodeId)?.status === 'failed', 30000);
  const fired4 = await waitFor(() => prompts.some((x) => x.sid === 'session-sess-old-dispatcher' && x.text.includes('fail-3')), 30000, 1000);
  s.check('④ 点名回派发者（不猜最新会话）', fired4, '最后目标: ' + (prompts[prompts.length - 1]?.sid || '无'));

  // ③ 成功节点 → 绝不上报
  const n2 = prompts.length;
  const r3 = await sb.api('POST', `/api/run?ws=${encodeURIComponent(WS)}`, { command: 'node good.js', cwd: WS, title: 'ok-1', expect_minutes: 1, success: '日志尾含 "DONE" 且产出 ok.txt' });
  await waitFor(async () => (await sb.status(WS)).find((n) => n.id === r3.json.nodeId)?.status === 'completed', 30000);
  await sleep(2500);
  s.check('③ 成功不打扰主对话', prompts.length === n2, `${n2}→${prompts.length}`);
} finally {
  sb.stop();
}
stub.close();
s.done();
