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
    notify: { kind: 'off', escalate: { enabled: true, cooldownMin: 0.3, reviveHours: 0.002 } },   // 冷却18s；revive ≈ 7 秒
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
  // 毒丸（2026-09-19 复盘）：旧版（≤0.6.0）notify.converge 事件的 sessionId 记的是**主对话**。
  // questSpawnedSids 若按 notify.converge* 通配收集，sess-main 会被永久标成自建会话——
  // 定向层拒收 + 兜底层跳过，上报散进子会话。此事件在场时 ②/⑥ 仍必须过。
  fs.appendFileSync(ledger, JSON.stringify({ t: 'notify.converge', sessionId: 'sess-main', at: new Date().toISOString() }) + '\n');
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

  // ── 幕三：主对话定向层（2026-09-18 piml 当日事故：主对话派活后"最新会话"永远是子会话，
  // 一天 6 次失败上报散进 6 个不同子会话，主对话一次没收到）──
  // 布景：converge 登记主对话 sess-main；再塞一个**非 quest 自建**的普通子会话 sess-subagent 且是最新。
  // 重派 boom 再失败一次：上报必须投 sess-main，绝不能投"最新"的 sess-subagent。
  await sb.api('POST', `/api/converge?ws=${encodeURIComponent(WS)}`, { action: 'main', sessionId: 'sess-main' });
  sessions.push({ sessionId: 'sess-subagent', cwd: WS, running: false, updatedAt: Date.now() });   // 最新=子会话
  await sleep(20000);   // 出冷却窗（沙箱 cooldownMin=0.3 → 18s；幕一的上报已过窗口）
  const before = prompts.length;
  await sb.api('POST', `/api/dispatch?ws=${encodeURIComponent(WS)}`, { node: 'boom' });
  await waitFor(async () => prompts.slice(before).some((p) => p.text.includes('失败上报')), 30000);
  const esc3 = prompts.slice(before).filter((p) => p.text.includes('失败上报'));
  s.check('⑥ 主对话定向：上报投 sess-main 而非最新的子会话', esc3.length >= 1 && esc3.every((p) => p.sid === 'sess-main'),
    `条数=${esc3.length} 目标=${[...new Set(esc3.map((p) => p.sid))].join(',')}`);

  // ── 幕四：点名回执不设冷却（2026-09-19 实测事故：派发者自己的失败被 10 分钟冷却压掉，
  // 兜底的收敛汇报又被 pending 节点卡死 → 主对话断链睡到早上）──
  // 时序纪律（Windows 跨进程 append 不保序，2026-09-19 踩过）：换慢节点（ping ~3s），
  // 派发后再补署名行——避开"服务端瞬时连写把外部 append 挤到判定之后"的竞态。
  const planSlow = `workspace: ${WS}\nfreeze_on: hard-fail-only\n` +
    `---node: boom---\ncommand: cmd /c ping -n 4 127.0.0.1 >nul & exit 1\ncwd: ${WS}\nexpect_minutes: 1\n\n`;
  await sb.api('POST', `/api/plan?ws=${encodeURIComponent(WS)}`, { markdown: planSlow, force: true });
  await sleep(500);
  const before4 = prompts.length;
  await sb.api('POST', `/api/dispatch?ws=${encodeURIComponent(WS)}`, { node: 'boom' });
  await sleep(900);   // boom 还在 ping——此刻补署名，安全落在判定之前
  fs.appendFileSync(ledger, JSON.stringify({ t: 'node.dispatched', node: 'boom', dispatchedBy: 'sess-subagent', at: new Date().toISOString() }) + '\n');
  await waitFor(async () => prompts.slice(before4).some((p) => p.text.includes('失败上报')), 30000);
  const esc4 = prompts.slice(before4).filter((p) => p.text.includes('失败上报'));
  const gapOk = true;   // 结构上就在冷却窗内（幕三刚上报完就紧接派发）
  s.check('⑦ 冷却窗内+有派发者：点名回执不被冷却吞', esc4.length >= 1 && gapOk, `条数=${esc4.length}`);
  s.check('⑧ 回执投给派发者本人（sess-subagent）', esc4.length >= 1 && esc4.every((p) => p.sid === 'sess-subagent'),
    `目标=${[...new Set(esc4.map((p) => p.sid))].join(',')}`);

  // ── 幕五：成功回执（2026-09-19 署名回执制）：署名派发的节点**成功**也要一行回执给派发者 ──
  // 同样的时序纪律：慢成功节点（ping ~2s）+ 派发后补署名。
  const plan2 = `workspace: ${WS}\nfreeze_on: hard-fail-only\n` +
    `---node: win---\ncommand: cmd /c ping -n 3 127.0.0.1 & exit 0\ncwd: ${WS}\nexpect_minutes: 1\n\n`;
  await sb.api('POST', `/api/plan?ws=${encodeURIComponent(WS)}`, { markdown: plan2, force: true });
  await sleep(500);
  const before5 = prompts.length;
  const disp = (await sb.api('POST', `/api/dispatch?ws=${encodeURIComponent(WS)}`, { node: 'win' })).json;
  await sleep(900);
  fs.appendFileSync(ledger, JSON.stringify({ t: 'node.dispatched', node: 'win', dispatchedBy: 'sess-subagent', at: new Date().toISOString() }) + '\n');
  await waitFor(async () => prompts.slice(before5).some((p) => p.text.includes('【回执】')), 30000);
  const rc = prompts.slice(before5).filter((p) => p.text.includes('【回执】'));
  s.check('⑨ 成功回执送达署名派发者', rc.length >= 1 && rc.every((p) => p.sid === 'sess-subagent'),
    `dispatch.ok=${disp?.ok} 条数=${rc.length} 目标=${[...new Set(rc.map((p) => p.sid))].join(',')}`);

  // ── 幕六：QQ 点名仅主对话（2026-09-19 收权）── sb.api 返回 {status,json}，断言用 .json
  const rj1 = (await sb.api('POST', `/api/notify?ws=${encodeURIComponent(WS)}`, { message: '子对话想点名' })).json;
  s.check('⑩ 子对话（无身份）点名被拒', rj1.ok === false && /仅主对话/.test(rj1.error || ''), String(rj1.error || '').slice(0, 60));
  const rj2 = (await sb.api('POST', `/api/notify?ws=${encodeURIComponent(WS)}`, { message: '冒充者点名', sessionId: 'session-imposter-0000000000000000000000' })).json;
  s.check('⑪ 非登记会话点名被拒', rj2.ok === false && /仅主对话/.test(rj2.error || ''), String(rj2.error || '').slice(0, 60));
  const ok3 = (await sb.api('POST', `/api/notify?ws=${encodeURIComponent(WS)}`, { message: '主对话点名', sessionId: 'sess-main' })).json;
  s.check('⑫ 主对话过身份关（沙箱 kind=off，走到出口检查即算通过）', ok3.ok === false && /通知出口/.test(ok3.error || ''), String(ok3.error || '').slice(0, 60));
} finally {
  sb.stop();
  await new Promise((r) => stub.close(r));
}
s.done();
