// tests/notify-content.mjs —— 通知内容真的送出去了，且可读（用本地 webhook 收报文）
//
// 覆盖：上游"疑似但放行"(soft-pass) 的提示是否包含节点 id、探针指令、取消指令；
//       以及普通失败通知与任务线收尾通知是否送达。
import http from 'node:http';
import { startSandbox, suite, waitFor, sleep } from './lib.mjs';

const PORT = 3126;
const HOOK = 3127;
const s = suite('notify-content');

const got = [];
const hook = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => { b += d; });
  req.on('end', () => { got.push(b); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
});
await new Promise((r) => hook.listen(HOOK, '127.0.0.1', r));

const sb = await startSandbox({
  name: 'notify-content', port: PORT, wsDirs: ['ws'],
  extraConfig: { notify: { kind: 'webhook', url: `http://127.0.0.1:${HOOK}/hook` }, runGate: { enabled: false } },
});
const WS = sb.ws.ws;

try {
  const plan = `workspace: ${WS}\nfreeze_on: hard-fail-only\n` +
    `---node: up---\ncommand: cmd /c echo hello-up\ncwd: ${WS}\nexpect_minutes: 1\n\n` +
    `---node: down---\ncommand: cmd /c echo hello-down\ncwd: ${WS}\nexpect_minutes: 1\nafter: up\n`;
  await sb.api('POST', `/api/plan?ws=${encodeURIComponent(WS)}`, { markdown: plan });
  await sleep(1200);
  await sb.api('POST', `/api/dispatch?ws=${encodeURIComponent(WS)}`, { node: 'up' });
  await waitFor(async () => ['running', 'completed', 'failed'].includes((await sb.status(WS)).find((n) => n.id === 'down')?.status), 30000);
  await sleep(2500); // 等推送落地

  const all = got.join('\n');
  s.check('收到多条通知（判定 + soft-pass + 收尾）', got.length >= 3, `条数=${got.length}`);
  s.check('soft-pass 通知送达', /疑似但放行/.test(all));
  s.check('soft-pass 通知点名了上游节点', /up\(suspect/.test(all), all.match(/上游 [^\n]{0,40}/)?.[0] || '');
  s.check('soft-pass 通知给出探针指令（AI 该怎么查）', /quest_probe/.test(all));
  s.check('soft-pass 通知给出取消指令', /\/q取消\s+down/.test(all));
  s.check('上游失败通知也送达', /\[❌ suspect\]/.test(all));
  s.check('带工作区分支前缀（能分辨是哪条线）', /\[ws\]/.test(all) || /^\[[^\]]+\]/.test(got[0] || ''));
} finally {
  sb.stop();
  await new Promise((r) => hook.close(r));
}
s.done();
