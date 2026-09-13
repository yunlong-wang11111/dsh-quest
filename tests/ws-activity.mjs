// tests/ws-activity.mjs —— 工作区活跃度：回答"子对话是不是在改代码"
//
// 关键语义：**账本安静 ≠ 没人干活**。agent 可能正在改代码还没派发任务，所以"静默/收敛"必须
// 两个条件都满足：账本安静 + 工作区也没有新文件改动。这个测试用文件 mtime 模拟"有人正在改代码"。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { startSandbox, waitFor, suite, ledgerOf, sleep } from './lib.mjs';

const PORT = 3131;
const HOOK = 3132;
const s = suite('ws-activity');

const got = [];
const hook = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => { b += d; });
  req.on('end', () => { got.push(b); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
});
await new Promise((r) => hook.listen(HOOK, '127.0.0.1', r));

const sb = await startSandbox({
  name: 'ws-activity', port: PORT, wsDirs: ['ws'],
  extraConfig: {
    notify: { kind: 'webhook', url: `http://127.0.0.1:${HOOK}/hook` },
    runGate: { enabled: false },
    quietMinutes: 0.05, sweepSeconds: 5, wsActivityMinutes: 15,
  },
});
const WS = sb.ws.ws;
const quietCount = () => ledgerOf(sb.home, WS).filter((e) => e.t === 'line.quiet').length;
const line = async () => (await sb.api('GET', `/api/status?ws=${encodeURIComponent(WS)}`)).json.line;

try {
  // ① 派发一个任务并跑完（它会写 out.npz → 工作区有新文件）
  fs.writeFileSync(path.join(WS, 'job.js'), 'console.log(1);require("fs").writeFileSync("out.npz","x");\n');
  const r = await sb.api('POST', `/api/run?ws=${encodeURIComponent(WS)}`, { command: 'node job.js', cwd: WS, title: 'ws-a', expect_minutes: 1 });
  await waitFor(async () => (await sb.status(WS)).find((n) => n.id === r.json.nodeId)?.status === 'completed', 30000);

  // ② 刚跑完时工作区一定是"活跃"的（产物刚落地）→ 不该判静默
  const l1 = await line();
  s.check('② 产物刚落地的瞬间：工作区算活跃', (l1.workspace?.recent ?? 0) >= 1, JSON.stringify(l1.workspace));
  s.check('② 工作区活跃时不当成收敛（账本静≠没人干活）', l1.quiet === false && l1.wsQuiet === false, `quiet=${l1.quiet} wsQuiet=${l1.wsQuiet}`);

  // ③ 等静默窗口过去（quietMinutes=3 秒）→ 收敛信号出现，且通知里写明工作区状态
  const fired = await waitFor(() => quietCount() >= 1, 40000, 1000);
  s.check('③ 账本与工作区都安静后才判收敛', fired, `line.quiet=${quietCount()}`);
  await sleep(1200);
  const all = got.join('\n');
  s.check('③ 通知里含工作区那一行', /工作区：(最近 \d+ 分钟无改动|最近 \d+ 分钟有)/.test(all), String(all.match(/工作区：[^\n"]{0,60}/)?.[0] || ''));

  // ④ quest 自己的台账不算"有人在改代码"（progress.md 每次状态查询都会被重写）
  await sb.api('GET', `/api/status?ws=${encodeURIComponent(WS)}`);
  await sleep(300);
  const l2 = await line();
  const names = [l2.workspace?.latest?.name || ''];
  s.check('④ progress.md/plan.md 不算工作区改动', !names.some((n) => ['progress.md', 'plan.md', 'research-state.md'].includes(n)), `最新文件=${names[0]}`);

  // ⑤ 模拟"agent 正在改代码"：改一个文件 → 立刻又变回活跃（不该再说收敛）
  fs.writeFileSync(path.join(WS, 'train.py'), '# 正在改\n');
  await sleep(400);
  const l3 = await line();
  s.check('⑤ 有人在改文件 → 立刻回到活跃（不收敛）', l3.quiet === false && (l3.workspace?.recent ?? 0) >= 1, `quiet=${l3.quiet} recent=${l3.workspace?.recent} 最新=${l3.workspace?.latest?.name}`);
  s.check('⑤ 状态里能看到"最新改的是哪个文件"', l3.workspace?.latest?.name === 'train.py', JSON.stringify(l3.workspace?.latest));
} finally {
  sb.stop();
  await new Promise((r) => hook.close(r));
}
s.done();
