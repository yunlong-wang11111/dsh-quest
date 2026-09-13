// tests/dsh-session-activity.mjs —— "子对话在不在干活"（DSH session/list 的 running 字段）
//
// 这是最直接回答用户那个问题的信号：不是推断"工作区有没有变"，而是直接问 DSH
// "这个工作区的会话在跑吗"。测试用一个**假 DSH** 提供 session/list，并可在测试中翻转 running。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { startSandbox, waitFor, suite, ledgerOf, sleep } from './lib.mjs';

const PORT = 3133;
const DSH = 3134;
const s = suite('dsh-session-activity');

// ── 假 DSH：只实现 quest 用到的两件事 ────────────────────────────────────
let sessions = [];
const stub = http.createServer((req, res) => {
  if (req.method === 'GET') {                       // #ensureCookie: GET /?token=… → 303 + cookie
    res.writeHead(303, { 'set-cookie': 'sid=stub; Path=/', location: '/' });
    res.end();
    return;
  }
  let b = '';
  req.on('data', (d) => { b += d; });
  req.on('end', () => {
    let msg = {};
    try { msg = JSON.parse(b || '{}'); } catch {}
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ rpcId: msg.rpcId, result: { ok: true, value: { items: sessions } } }));
  });
});
await new Promise((r) => stub.listen(DSH, '127.0.0.1', r));

const sb = await startSandbox({
  name: 'dsh-session-activity', port: PORT, wsDirs: ['ws'],
  extraConfig: {
    dshBaseUrl: `http://127.0.0.1:${DSH}`,
    dshToken: 'stub-token',
    runGate: { enabled: false },
    notify: { kind: 'off' },
    quietMinutes: 0.05, sweepSeconds: 5,
  },
});
const WS = sb.ws.ws;
const quietCount = () => ledgerOf(sb.home, WS).filter((e) => e.t === 'line.quiet').length;
const line = async () => (await sb.api('GET', `/api/status?ws=${encodeURIComponent(WS)}`)).json.line;

try {
  // 前置：一个已完成的任务 + 工作区文件（让"账本与工作区"都满足静默条件）
  fs.writeFileSync(path.join(WS, 'job.js'), 'console.log(1);require("fs").writeFileSync("out.npz","x");\n');
  const r = await sb.api('POST', `/api/run?ws=${encodeURIComponent(WS)}`, { command: 'node job.js', cwd: WS, title: 'dsh-1', expect_minutes: 1 });
  await waitFor(async () => (await sb.status(WS)).find((n) => n.id === r.json.nodeId)?.status === 'completed', 30000);
  await sleep(4000); // 超过静默窗口（3 秒）

  // ① 假 DSH 报"这个工作区有会话在跑" → 不该判收敛
  sessions = [{ sessionId: 'sess-1', cwd: WS, running: true, updatedAt: Date.now() }];
  await waitFor(async () => (await line())?.dsh?.running === 1, 25000, 1000);
  const l1 = await line();
  s.check('① 读到会话 running=1（真的问了 DSH）', l1?.dsh?.running === 1 && l1?.dsh?.total === 1, JSON.stringify(l1?.dsh));
  s.check('① 会话在跑 → 不判收敛', l1?.quiet === false && l1?.dshQuiet === false, `quiet=${l1?.quiet} dshQuiet=${l1?.dshQuiet}`);
  s.check('① 此时也没推出静默通知（信号没被误报）', quietCount() === 0, `line.quiet=${quietCount()}`);

  // ② 会话结束 → 三个条件都满足 → 收敛信号出现
  sessions = [{ sessionId: 'sess-1', cwd: WS, running: false, updatedAt: Date.now() }];
  const fired = await waitFor(() => quietCount() >= 1, 40000, 1000);
  s.check('② 会话结束后才判收敛', fired, `line.quiet=${quietCount()}`);
  const l2 = await line();
  s.check('② 状态里如实写"没有会话在跑"', l2?.dsh?.running === 0 && l2?.quiet === true, JSON.stringify({ dsh: l2?.dsh, quiet: l2?.quiet }));

  // ③ 别的 cwd 的会话不算这个工作区（不能误拦）
  sessions = [
    { sessionId: 'sess-1', cwd: WS, running: false, updatedAt: Date.now() },
    { sessionId: 'sess-2', cwd: 'C:/somewhere/else', running: true, updatedAt: Date.now() },
  ];
  await sleep(6000);
  const l3 = await line();
  s.check('③ 只统计本工作区的会话（别的 cwd 的 running 不拦）', l3?.dsh?.total === 1 && l3?.dsh?.running === 0, JSON.stringify(l3?.dsh));

  // ④ 探测失败要安全降级：不门控、不报错、任务流转不受影响
  await new Promise((r) => stub.close(r));
  await sleep(6500);
  const l4 = await line();
  s.check('④ DSH 探测失败 → 降级为"不门控"而非卡死', l4?.dsh === null || l4?.dshQuiet === true, JSON.stringify({ dsh: l4?.dsh, dshQuiet: l4?.dshQuiet }));
  const st = (await sb.api('GET', `/api/status?ws=${encodeURIComponent(WS)}`)).json;
  s.check('④ 探测失败也不影响状态查询本身', st.status !== 500 && Array.isArray(st.plan?.nodes), `nodes=${st.plan?.nodes?.length}`);
} finally {
  sb.stop();
  try { stub.close(); } catch {}
}
s.done();
