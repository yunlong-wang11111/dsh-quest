// tests/daily-report.mjs —— 晨报定时推送（2026-09-20 用户需求：工作日 08:05，零 token 直读账本→QQ）
// 验证三件事：①到点触发（把 times 设成"1 分钟后"）②报告内容含工作区/节点统计/收尾开关 ③当日去重不重发
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { startSandbox, suite, sleep } from './lib.mjs';

const QQ = 3191;                       // 假通知端（webhook 收发，免 token 文件）
const pushes = [];
const stub = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => { b += d; });
  req.on('end', () => {
    pushes.push(b); res.writeHead(200); res.end('{"ok":true}');
  });
});
await new Promise((r) => stub.listen(QQ, '127.0.0.1', r));
const s = suite('daily-report');

// times：90 秒后（跨分钟边界留余量）；workingDaysOnly 关掉以免撞周末
const soon = new Date(Date.now() + 90e3);
const hhmm = `${String(soon.getHours()).padStart(2, '0')}:${String(soon.getMinutes()).padStart(2, '0')}`;
const sb = await startSandbox({
  name: 'daily-report', port: 3192, wsDirs: ['exp'],
  extraConfig: {
    notify: { kind: 'webhook', url: `http://127.0.0.1:${QQ}/hook`, dailyReport: { times: [hhmm], workingDaysOnly: false, enabled: true } },
    sweepSeconds: 5,
  },
});
const WS = sb.ws.exp.replace(/\//g, '\\');
try {
  // 布景：交一份 plan + 跑一个成功节点（账本里有 node.completed 可统计）
  const plan = `# 任务线：晨报测试\nworkspace: ${WS}\n---node: ok1---\ncommand: cmd /c exit 0\ncwd: ${WS}\nexpect_minutes: 1\n\n`;
  await sb.api('POST', `/api/plan?ws=${encodeURIComponent(WS)}`, { markdown: plan });
  await sleep(800);
  await sb.api('POST', `/api/dispatch?ws=${encodeURIComponent(WS)}`, { node: 'ok1' });
  await sleep(3000);
  const before = pushes.length;
  // 等到时间窗开启（最多 ~2.5 分钟；窗口= HH:MM 起两小时，sweep 5s 一查）
  const deadline = Date.now() + 150e3;
  while (pushes.length === before && Date.now() < deadline) await sleep(2000);
  s.check('① 晨报到点触发并推送', pushes.length > before, `推送数 ${before}→${pushes.length}`);
  const body = pushes[pushes.length - 1] || '';
  s.check('② 内容含晨报头与工作区统计', body.includes('晨报') && body.includes('晨报测试'), body.slice(0, 160).replace(/\n/g, ' | '));
  s.check('③ 含收尾开关状态', body.includes('收尾'), '');
  // 去重：再等 8 秒（多轮 sweep）不应有第二条
  await sleep(8000);
  s.check('④ 当日去重（不重发）', pushes.length === before + 1, `推送数=${pushes.length}`);
} finally {
  sb.stop();
  await new Promise((r) => stub.close(r));
}
s.done();
