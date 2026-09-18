// tests/reopen-sweep.mjs —— 定时重开挂到巡检（2026-09-18 修复）
// 病：checkReopenConverge 原挂在 maybeNotifyConverge 里——自动收尾关着且线安静时
//     收敛检查不会跑，12:00 的重开永远轮不到（用户实测上午关、中午没开回来）。
// 药：巡检（sweepQuietDirs）每轮都查一次 reopenTimes。本测试：关掉自动收尾 →
//     reopenTimes 设为"现在" → 等一轮巡检 → 状态必须翻回 true，且 /api/status 带上 convergeAuto。
import { startSandbox, suite, waitFor, sleep } from './lib.mjs';

const s = suite('reopen-sweep');
const now = new Date();
const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

const sb = await startSandbox({
  name: 'reopen-sweep', port: 3171, wsDirs: ['ws'],
  extraConfig: {
    notify: { kind: 'off', converge: { enabled: true, cooldownMin: 5, reopenTimes: [hhmm] } },
    runGate: { enabled: false }, quietMinutes: 0.05, sweepSeconds: 2,
  },
});
const WS = sb.ws.ws;
const Q = `/api/converge?ws=${encodeURIComponent(WS)}`;
try {
  // 造一条线（有节点才进巡检视野：账本存在即可）
  await sb.api('POST', `/api/plan?ws=${encodeURIComponent(WS)}`, { markdown: `workspace: ${WS}\n---node: a---\ncommand: cmd /c echo hi> a.txt\ncwd: ${WS}\nexpect_minutes: 1\nsuccess: 产出 a.txt\n\n` });
  await sleep(400);
  // 手动关（写入 lastReopen 是昨天，防止今天窗口内已被记过）
  const off = await sb.api('POST', Q, { action: 'off' });
  s.check('① 手动关成功', off.json?.ok === true && off.json.auto === false, JSON.stringify(off.json).slice(0, 60));
  await sleep(300);
  const st1 = await sb.api('GET', Q + '&action=status');
  s.check('② 关后 status 确实是 false', st1.json?.auto === false, JSON.stringify(st1.json).slice(0, 60));

  // 等巡检（2s 一轮，重开窗口 120 分钟宽——hhmm 必在窗内）翻回 true
  await waitFor(async () => (await sb.api('GET', Q + '&action=status')).json?.auto === true, 30000, 1000);
  s.check('③ 巡检在重开时刻把自动收尾翻回开', true);

  const stt = await sb.api('GET', `/api/status?ws=${encodeURIComponent(WS)}`);
  s.check('④ /api/status 暴露 convergeAuto（状态灯的数据源）', stt.json?.convergeAuto === true, String(stt.json?.convergeAuto));
} finally { sb.stop(); }
s.done();
