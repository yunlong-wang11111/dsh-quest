// tests/escalate-deadletter.mjs —— 失败上报的防死信两件套（2026-09-18 b551f7b4 事故复盘）
// ① 定向回退排除 quest 自建会话：没有 dispatchedBy 时"最新会话"若只是收尾 worker，绝不投它（投主对话）
// ② 死信复活：上报投出去 N 小时没人读且节点仍失败 → 转投主对话 + notify.escalate-revived 留痕，只复活一次
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { startSandbox, suite, waitFor, sleep } from './lib.mjs';

const DSH = 3141;
const s = suite('escalate-deadletter');

// 假 DSH：list/create/prompt 记账（同 converge-notify 的桩）
let sessions = [];
const prompts = [];
const stub = http.createServer((req, res) => {
  if (req.method === 'GET') { res.writeHead(303, { 'set-cookie': 'sid=stub; Path=/', location: '/' }); res.end(); return; }
  let b = ''; req.on('data', (d) => { b += d; });
  req.on('end', () => {
    let msg = {}; try { msg = JSON.parse(b || '{}'); } catch {}
    const method = String(msg.method || '');
    const p = msg.payload?.args?.request ?? msg.payload?.args?._request ?? {};
    let value = { items: sessions };
    if (method.includes('create')) {
      const sid = 'session-synth-' + (prompts.length + sessions.length + 1);
      sessions.push({ sessionId: sid, cwd: p.cwd, running: false, updatedAt: Date.now() });
      value = { sessionId: sid };
    } else if (method.includes('prompt')) {
      prompts.push({ sid: p.sessionId, text: JSON.stringify(p.content ?? '').slice(0, 1500) });
      value = {};
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ rpcId: msg.rpcId, result: { ok: true, value } }));
  });
});
await new Promise((r) => stub.listen(DSH, '127.0.0.1', r));

const sb = await startSandbox({
  name: 'escalate-dl', port: 3142, wsDirs: ['ws'],
  extraConfig: {
    dshBaseUrl: `http://127.0.0.1:${DSH}`, dshToken: 'stub-token',
    runGate: { enabled: false }, workersEnabled: false,
    notify: { kind: 'off', escalate: { enabled: true, cooldownMin: 0, reviveHours: 0.002 } },   // revive ≈ 7 秒
    sweepSeconds: 2,
  },
});
const WS = sb.ws.ws;

try {
  // 布景（2026-09-18 b551f7b4 事故复刻）：本工作区"最新会话"是 quest 收尾 worker（账本已登记），
  // 次新才是主对话 sess-main。失败上报的"最新会话"回退必须跳过 worker 投给 sess-main。
  sessions = [
    { sessionId: 'sess-main', cwd: WS, running: false, updatedAt: Date.now() - 120e3 },
    { sessionId: 'session-worker-deadbeef', cwd: WS, running: false, updatedAt: Date.now() },   // 最新=worker
  ];
  const wsKey = WS.replace(/\\/g, '/').replace(/[:/]/g, (c) => (c === ':' ? '' : '-')).replace(/\/+$/, '');
  const plan = `workspace: ${WS}\nfreeze_on: hard-fail-only\n` +
    `---node: boom---\ncommand: cmd /c exit 1\ncwd: ${WS}\nexpect_minutes: 1\n\n`;
  await sb.api('POST', `/api/plan?ws=${encodeURIComponent(WS)}`, { markdown: plan });
  await sleep(600);
  // plan 落地后账本才存在——此刻补登记 worker（生产代码在创建 worker 时同步写这条）
  const ledger = path.join(sb.home, wsKey, 'ledger.jsonl');
  fs.appendFileSync(ledger, JSON.stringify({ t: 'notify.converge.worker', sessionId: 'session-worker-deadbeef', at: new Date().toISOString() }) + '\n');
  await sb.api('POST', `/api/dispatch?ws=${encodeURIComponent(WS)}`, { node: 'boom' });
  await waitFor(async () => (await sb.status(WS)).find((n) => n.id === 'boom')?.status === 'failed', 30000);

  // 失败上报此刻应该已经发生：目标必须是 sess-main，绝不是"最新"的那个 worker（若 worker 存在）
  await sleep(1500);
  const esc = prompts.filter((p) => p.text.includes('失败上报'));
  s.check('① 失败上报送达', esc.length >= 1, `条数=${esc.length}`);
  s.check('② 投给了真人会话（sess-main），不是 quest 自建 worker', esc.every((p) => p.sid === 'sess-main'), esc.map((p) => p.sid).join(','));

  // ── 幕二：死信复活 ──
  // 构造"投出去没人读"：sess-main 是假会话（桩不会消费），boom 仍 failed；
  // reviveHours=0.002（≈7s）+ sweep 2s → 等 ~12s 应看到 死信复活 提示 + notify.escalate-revived 事件。
  await waitFor(() => prompts.some((p) => p.text.includes('死信复活')), 25000);
  const rev = prompts.filter((p) => p.text.includes('死信复活'));
  s.check('③ 死信复活：超时未读的上报转投了主对话', rev.length >= 1, `条数=${rev.length}`);
  s.check('④ 复活提示点名原目标与现状', rev[0]?.text.includes('未被读取') && rev[0]?.text.includes('boom'), (rev[0]?.text || '').slice(0, 80));
  await sleep(6000);   // 再跑两轮 sweep
  const rev2 = prompts.filter((p) => p.text.includes('死信复活'));
  s.check('⑤ 只复活一次（不重复轰炸）', rev2.length === rev.length, `复活条数 ${rev.length} → ${rev2.length}`);
} finally {
  sb.stop();
  await new Promise((r) => stub.close(r));
}
s.done();
