// tests/converge-notify.mjs —— 收敛汇报（第 1 级通知）+ 收敛判定的父会话归因
//
// 背景（2026-09-16 设计讨论）：用户要"全部任务收敛后，让 AI 过一遍手再通知"。
// 两件事：
//   ① dshActivity 父会话归因——DSH 子代理常带临时 cwd，只按 cwd 匹配会漏数 ⇒ 收敛误报。
//      归因：cwd 匹配，或沿 parentSessionId 上溯任一祖先的 cwd 匹配。
//   ② notify.converge——收敛时唤醒轻量收尾会话（session/create + session/prompt queue），
//      冷却去重、默认关。测试用假 DSH 记录 create/prompt 调用来断言。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { startSandbox, waitFor, suite, ledgerOf, sleep } from './lib.mjs';

const PORT = 3131;
const DSH = 3132;
const s = suite('converge-notify');

// ── 假 DSH：session/list + session/create + session/prompt 都记账 ──────────
let sessions = [];
const created = [];
const prompts = [];
const stub = http.createServer((req, res) => {
  if (req.method === 'GET') { res.writeHead(303, { 'set-cookie': 'sid=stub; Path=/', location: '/' }); res.end(); return; }
  let b = '';
  req.on('data', (d) => { b += d; });
  req.on('end', () => {
    let msg = {}; try { msg = JSON.parse(b || '{}'); } catch {}
    const method = String(msg.method || '');
    // 封包格式见 lib/dsh-client-v2.mjs：{type:'client-request', method, payload:{args:{request|_request}}}
    const p = msg.payload?.args?.request ?? msg.payload?.args?._request ?? {};
    let value = { items: sessions };
    if (method.includes('create')) {
      const sid = 'session-synth-' + (created.length + 1);
      created.push({ sid, cwd: p.cwd });
      sessions.push({ sessionId: sid, cwd: p.cwd, running: false, updatedAt: Date.now() });
      value = { sessionId: sid };
    } else if (method.includes('prompt')) {
      prompts.push({ sid: p.sessionId, text: JSON.stringify(p.content ?? '').slice(0, 2000) });
      value = {};
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ rpcId: msg.rpcId, result: { ok: true, value } }));
  });
});
await new Promise((r) => stub.listen(DSH, '127.0.0.1', r));

const sb = await startSandbox({
  name: 'converge-notify', port: PORT, wsDirs: ['ws'],
  extraConfig: {
    dshBaseUrl: `http://127.0.0.1:${DSH}`,
    dshToken: 'stub-token',
    runGate: { enabled: false },
    notify: { kind: 'off', converge: { enabled: true, cooldownMin: 5, presenceMin: 0, autoWindows: [['00:00','23:59']] } },   // 第一幕关在场守卫（假会话 updatedAt=刚刚，会被误判在场）
    quietMinutes: 0.05, sweepSeconds: 5,
  },
});
const WS = sb.ws.ws;
const line = async () => (await sb.api('GET', `/api/status?ws=${encodeURIComponent(WS)}`)).json.line;
const convEvents = () => ledgerOf(sb.home, WS).filter((e) => e.t === 'notify.converge');

try {
  // 前置：跑完一个节点 + 过静默窗口
  fs.writeFileSync(path.join(WS, 'job.js'), 'console.log(1);require("fs").writeFileSync("out.npz","x");\n');
  const r = await sb.api('POST', `/api/run?ws=${encodeURIComponent(WS)}`, { command: 'node job.js', cwd: WS, title: 'conv-1', expect_minutes: 1 });
  await waitFor(async () => (await sb.status(WS)).find((n) => n.id === r.json.nodeId)?.status === 'completed', 30000);

  // ① 父会话归因：工作区主会话空闲，但它派的子代理（cwd=临时目录）在跑 → 必须算"在跑"，不判收敛
  sessions = [
    { sessionId: 'sess-main', cwd: WS, running: false, updatedAt: Date.now() },
    { sessionId: 'sess-sub', cwd: '/tmp/somewhere-else', parentSessionId: 'sess-main', running: true, updatedAt: Date.now() },
  ];
  await waitFor(async () => (await line())?.dsh?.total === 2, 30000, 1000);
  const l1 = await line();
  s.check('① 子代理经父归因被计入（total=2, running=1）', l1?.dsh?.total === 2 && l1?.dsh?.running === 1, JSON.stringify(l1?.dsh));
  s.check('① 有活在跑 → 不判收敛、没唤醒收尾会话', l1?.quiet === false && prompts.length === 0, `quiet=${l1?.quiet} prompts=${prompts.length}`);

  // ② 子代理也停了 → 收敛 → 唤醒收尾会话（假 DSH 收到 create + prompt）
  sessions = [
    { sessionId: 'sess-main', cwd: WS, running: false, updatedAt: Date.now() },
    { sessionId: 'sess-sub', cwd: '/tmp/somewhere-else', parentSessionId: 'sess-main', running: false, updatedAt: Date.now() },
  ];
  const fired = await waitFor(() => convEvents().length >= 1, 60000, 1000);
  s.check('② 收敛后触发 notify.converge', fired, 'events=' + convEvents().length);
  await sleep(1500);
  s.check('② 唤醒的是新收尾会话（create 被调，cwd=工作区）', created.length === 1 && String(created[0].cwd || '').replace(/\\/g, '/').endsWith('/ws'), JSON.stringify(created));
  s.check('② 注入了收尾提示（含 line-summary 与"只读与写总结"闸）',
    prompts.length >= 1 && prompts[prompts.length - 1].text.includes('line-summary') && prompts[prompts.length - 1].text.includes('只读与写总结'),
    'prompts=' + prompts.length);
  const ev = convEvents()[0];
  s.check('② 事件记了目标会话且无错', ev && ev.sessionId && !ev.error, JSON.stringify(ev ?? {}).slice(0, 120));

  // ③ 冷却：5 分钟内再收敛（再跑一个快节点又静默）→ line.quiet 可以再响，但绝不二次唤醒
  const promptsBefore = prompts.length;
  const r2 = await sb.api('POST', `/api/run?ws=${encodeURIComponent(WS)}`, { command: 'node job.js', cwd: WS, title: 'conv-2', expect_minutes: 1 });
  await waitFor(async () => (await sb.status(WS)).find((n) => n.id === r2.json.nodeId)?.status === 'completed', 30000);
  await sleep(5000);
  s.check('③ 冷却内没有第二次唤醒', prompts.length === promptsBefore, `prompts ${promptsBefore}→${prompts.length}`);

  // ④ 无关会话（别的 cwd、无父子关系）不误计入：main+sub+收尾会话=3 个本工作区；
  //    sess-other（running:true）若被误算，total 会变 4、running 会变 1
  sessions.push({ sessionId: 'sess-other', cwd: 'C:/elsewhere', running: true, updatedAt: Date.now() });
  await sleep(6000);
  const l4 = await line();
  s.check('④ 无关 cwd 且无父缘的在跑会话不拦本工作区', l4?.dsh?.total === 3 && l4?.dsh?.running === 0, JSON.stringify(l4?.dsh));
} finally {
  sb.stop();
}

// ── 第二幕：老板在场守卫（防与手动汇报重复）────────────────────────────────
const sb2 = await startSandbox({
  name: 'converge-presence', port: 3135, wsDirs: ['ws'],
  extraConfig: {
    dshBaseUrl: `http://127.0.0.1:${DSH}`,
    dshToken: 'stub-token',
    runGate: { enabled: false },
    notify: { kind: 'off', converge: { enabled: true, cooldownMin: 5, presenceMin: 60, autoWindows: [['00:00','23:59']] } },
    quietMinutes: 0.05, sweepSeconds: 5,
  },
});
const WS2 = sb2.ws.ws;
const prompts2Before = prompts.length;
try {
  fs.writeFileSync(path.join(WS2, 'job.js'), 'console.log(1);require("fs").writeFileSync("out.npz","x");\n');
  const r = await sb2.api('POST', `/api/run?ws=${encodeURIComponent(WS2)}`, { command: 'node job.js', cwd: WS2, title: 'p-1', expect_minutes: 1 });
  await waitFor(async () => (await sb2.status(WS2)).find((n) => n.id === r.json.nodeId)?.status === 'completed', 30000);

  // ⑤ 场景：用户刚聊过（工作区会话 5 分钟前有动静）→ 收敛判定可以成立，但自动收尾必须退避
  sessions = [{ sessionId: 'sess-main2', cwd: WS2, running: false, updatedAt: Date.now() - 5 * 60000 }];
  await sleep(8000);   // 过静默窗 + 一轮巡检
  s.check('⑤ 老板在场（5 分钟前有动静）→ 不自动收尾（手动汇报优先）', prompts.length === prompts2Before,
    `prompts ${prompts2Before}→${prompts.length}`);

  // ⑥ 用户离开 90 分钟 → 无人值守 → 自动收尾接管。
  //    注意：静默只对**新的账本活动**触发（防自我续期），所以先再跑一个节点"上膛"，再让会话显得久无动静
  const r3 = await sb2.api('POST', `/api/run?ws=${encodeURIComponent(WS2)}`, { command: 'node job.js', cwd: WS2, title: 'p-2', expect_minutes: 1 });
  await waitFor(async () => (await sb2.status(WS2)).find((n) => n.id === r3.json.nodeId)?.status === 'completed', 30000);
  sessions = [{ sessionId: 'sess-main2', cwd: WS2, running: false, updatedAt: Date.now() - 90 * 60000 }];
  const fired2 = await waitFor(() => prompts.length > prompts2Before, 40000, 1000);
  s.check('⑥ 老板离场（90 分钟无动静）→ 自动收尾唤醒', fired2, `prompts ${prompts2Before}→${prompts.length}`);
} finally {
  sb2.stop();
}

// ── 第三幕：手动收尾（/api/summarize）——不受窗口/冷却限制，排给本工作区最新会话 ──
const sb3 = await startSandbox({
  name: 'converge-manual', port: 3136, wsDirs: ['ws'],
  extraConfig: {
    dshBaseUrl: `http://127.0.0.1:${DSH}`,
    dshToken: 'stub-token',
    runGate: { enabled: false },
    notify: { kind: 'off', converge: { enabled: true, autoWindows: [] } },   // 窗口为空=纯手动
    quietMinutes: 0.05, sweepSeconds: 5,
  },
});
const WS3 = sb3.ws.ws;
const prompts3Before = prompts.length;
try {
  fs.writeFileSync(path.join(WS3, 'job.js'), 'console.log(1);require("fs").writeFileSync("out.npz","x");' + String.fromCharCode(10));
  const r = await sb3.api('POST', `/api/run?ws=${encodeURIComponent(WS3)}`, { command: 'node job.js', cwd: WS3, title: 'm-1', expect_minutes: 1 });
  await waitFor(async () => (await sb3.status(WS3)).find((n) => n.id === r.json.nodeId)?.status === 'completed', 30000);
  // 工作区有一个"更新最新"的会话 sess-newest3（比 sess-old3 新）
  sessions = [
    { sessionId: 'sess-old3', cwd: WS3, running: false, updatedAt: Date.now() - 50 * 60000 },
    { sessionId: 'sess-newest3', cwd: WS3, running: false, updatedAt: Date.now() },
  ];
  const m = await sb3.api('POST', `/api/summarize?ws=${encodeURIComponent(WS3)}`, {});
  const createdBefore = created.length;
  s.check('⑦ 手动收尾：排给本工作区最新的会话（不新开）', m.json?.ok === true && m.json.sessionId === 'sess-newest3' && created.length === createdBefore,
    JSON.stringify(m.json).slice(0, 120));
  s.check('⑦ 提示含排队语义与总结去向', /排队|忙则等/.test(String(m.json?.note || '')) && /line-summary/.test(String(m.json?.note || '')), String(m.json?.note || '').slice(0, 100));
  const lastP = prompts[prompts.length - 1];
  s.check('⑦ 指令带手动标记与只读闸', lastP?.sid === 'sess-newest3' && /手动点名/.test(lastP?.text || '') && /只读与写总结/.test(lastP?.text || ''), (lastP?.text || '').slice(0, 60));
} finally {
  sb3.stop();
}
stub.close();
s.done();
