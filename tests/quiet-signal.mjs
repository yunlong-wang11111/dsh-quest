// tests/quiet-signal.mjs —— "任务到底跑完了没"的收敛信号（line.quiet）
//
// 修的是这个真事故：收尾判定只看 plan 声明的节点，且只响一次——所以"只用 quest_run 快速单发"
// 的工作区永远收不到收尾信号（某工作区 4 个 plan 节点 9/8 全终态后，又跑了 29 个 quick 任务，
// 却再没有任何汇总）。这里用**完全不含 plan 节点**的沙箱工作区来验证它现在会响、可重复、且不刷屏。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { startSandbox, waitFor, suite, ledgerOf, sleep } from './lib.mjs';

const PORT = 3128;
const HOOK = 3129;
const s = suite('quiet-signal');

const got = [];
const hook = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => { b += d; });
  req.on('end', () => { got.push(b); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
});
await new Promise((r) => hook.listen(HOOK, '127.0.0.1', r));

const sb = await startSandbox({
  name: 'quiet-signal', port: PORT, wsDirs: ['ws'],
  extraConfig: {
    notify: { kind: 'webhook', url: `http://127.0.0.1:${HOOK}/hook` },
    runGate: { enabled: false },
    quietMinutes: 0.05,   // 3 秒就算静默（生产默认 10 分钟）
    sweepSeconds: 5,
  },
});
const WS = sb.ws.ws;
const quieCount = () => ledgerOf(sb.home, WS).filter((e) => e.t === 'line.quiet').length;
const lastQuiet = () => ledgerOf(sb.home, WS).filter((e) => e.t === 'line.quiet').pop();

try {
  // 前置：确认这个工作区**没有** plan 节点（这正是出问题的那种用法）
  // 脚本要产出真证据（写 out.npz），否则判定器正确地判 suspect——那是测试写错了，不是产品问题
  fs.writeFileSync(path.join(WS, 'ok.js'), 'console.log("hi"); require("fs").writeFileSync("out.npz","x");\n');
  const r = await sb.api('POST', `/api/run?ws=${encodeURIComponent(WS)}`, { command: 'node ok.js', cwd: WS, title: 'quiet-1', expect_minutes: 1 });
  s.check('前置：快速单发派发成功', r.json.ok === true, `nodeId=${r.json.nodeId}`);
  await waitFor(async () => (await sb.status(WS)).find((n) => n.id === r.json.nodeId)?.status === 'completed', 30000);
  const wsDir = fs.readdirSync(sb.home).find((d) => fs.existsSync(path.join(sb.home, d, 'plan.md')));
  const md = fs.readFileSync(path.join(sb.home, wsDir, 'plan.md'), 'utf8');
  s.check('前置：plan.md 里确实没有声明节点（只用快速单发）', !/^---node:/m.test(md), `plan.md 首行：${md.split('\n')[0].slice(0, 40)}`);

  // ① 静默信号出现（只用 quick 节点也能收到 —— 这就是修的 bug）
  const fired = await waitFor(() => quieCount() >= 1, 40000, 1000);
  s.check('① 只用快速单发的工作区也能收到收敛信号', fired, `line.quiet=${quieCount()}`);
  const q1 = lastQuiet();
  s.check('① 信号里写明节点数与完成数', (q1?.nodes ?? 0) >= 1 && (q1?.counts?.completed ?? 0) >= 1, JSON.stringify(q1?.counts));
  s.check('① 信号里写明"最近动作多久前"', Number.isFinite(q1?.idleMinutes), `idleMinutes=${q1?.idleMinutes}`);

  // ② 通知内容可读（含 静默 / 最近动作 / 节点数）
  await sleep(1500);
  const all = got.join('\n');
  s.check('② 推送里含"静默"与依据', /静默/.test(all) && /最近动作/.test(all) && /共 \d+ 个/.test(all), String(all.match(/\[🏁[^\n]*/)?.[0] || '').slice(0, 90));

  // ③ /api/status 也暴露收敛状态（AI 答"跑完了吗"用得上）
  const st = (await sb.api('GET', `/api/status?ws=${encodeURIComponent(WS)}`)).json;
  s.check('③ /api/status 暴露 line.quiet', st.line?.quiet === true && st.line?.active === 0, JSON.stringify(st.line));

  // ④ 不刷屏：继续静默一段时间，不应再重复推
  const before = quieCount();
  await sleep(12000);
  s.check('④ 静默期不重复推送', quieCount() === before, `${before} → ${quieCount()}`);

  // ⑤ 有新任务后重新进入活跃，再静默时再报一次（可重复）
  const r2 = await sb.api('POST', `/api/run?ws=${encodeURIComponent(WS)}`, { command: 'node ok.js', cwd: WS, title: 'quiet-2', expect_minutes: 1 });
  await waitFor(async () => (await sb.status(WS)).find((n) => n.id === r2.json.nodeId)?.status === 'completed', 30000);
  const again = await waitFor(() => quieCount() >= before + 1, 40000, 1000);
  s.check('⑤ 新一轮任务后再静默会再报一次', again, `line.quiet=${quieCount()}`);
  s.check('⑤ 第二次信号把两轮都算进去了', (lastQuiet()?.counts?.completed ?? 0) >= 2, JSON.stringify(lastQuiet()?.counts));
} finally {
  sb.stop();
  await new Promise((r) => hook.close(r));
}
s.done();
