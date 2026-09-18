// tests/preflight-sync.mjs —— 预检必须**同步**返回原因（不能伪装成"已派发"）
//
// 真实事故（2026-09-12）：DSH 侧派发 Linux 解释器命令却没声明 WSL 车道，quest_run 回了
// "✅ 已后台派发"，但那批实验从没跑起来——预检是在 HTTP 响应之后异步跑的。
import fs from 'node:fs';
import path from 'node:path';
import { startSandbox, suite, ledgerOf } from './lib.mjs';

const PORT = 3125;
const s = suite('preflight-sync');
const sb = await startSandbox({ name: 'preflight-sync', port: PORT, extraConfig: { runGate: { enabled: false } } });
const WS = sb.ws.ws;
const run = (body) => sb.api('POST', `/api/run?ws=${encodeURIComponent(WS)}`, body);

try {
  // ① Linux 解释器 + 未声明车道（正是那次事故）
  let r = await run({ command: '/home/someone/envs/ml/bin/python x.py --mode gen', cwd: WS, title: 'pf-lane' });
  s.check('① Linux 路径/未声明车道 → 当场回原因', r.json.ok === false && /Linux 路径/.test(r.json.error || ''), `ok=${r.json.ok} err=${String(r.json.error || '').slice(0, 50)}`);

  // ② WSL 车道 + Windows cwd
  r = await run({ command: 'python3 x.py', cwd: WS, shell: 'wsl', title: 'pf-cwd' });
  s.check('② WSL 车道配 Windows cwd → 当场回原因', r.json.ok === false && /cwd 是 Windows 路径/.test(r.json.error || ''), String(r.json.error || '').slice(0, 60));

  // ③ 正常路径（node 脚本，node 在白名单解释器里）→ 仍然派发成功
  fs.writeFileSync(path.join(WS, 'ok.js'), 'console.log("ok");\n');
  r = await run({ command: 'node ok.js', cwd: WS, title: 'pf-happy', expect_minutes: 1 });
  s.check('③ 正常路径 → 派发成功', r.json.ok === true && !!r.json.nodeId, `nodeId=${r.json.nodeId}`);

  // ④ 脚本语法错：py_compile 预检当场拦下（需本机有 python，否则记跳过）
  // 2026-09-18 加 5s 超时：本机 D:\python\python.exe 高负载下会 0xc0000142 挂死（无超时会拖死整个套件）
  const py = process.env.QUEST_TEST_PYTHON || (() => {
    for (const c of ['python', 'python3', 'py', 'py -3']) {
      try { require('node:child_process').execSync(`${c} -c "pass"`, { stdio: 'ignore', timeout: 5000 }); return c; } catch {}
    }
    return null;
  })();
  if (!py) s.note('④ 语法错预检：本机没有 python，跳过');
  else {
    fs.writeFileSync(path.join(WS, 'bad.py'), 'def broken(:\n    pass\n');
    r = await run({ command: `${py} bad.py`, cwd: WS, title: 'pf-syntax', expect_minutes: 1 });
    s.check('④ 语法错 → 预检当场拦下并回编译器原文', r.json.ok === false && /SyntaxError|invalid/i.test(r.json.error || ''), String(r.json.error || '').replace(/\s+/g, ' ').slice(0, 60));
  }

  // ⑤ plan 节点 + /api/dispatch 也同步回原因
  await sb.api('POST', `/api/plan?ws=${encodeURIComponent(WS)}`, {
    markdown: `workspace: ${WS}\n---node: n1---\ncommand: /home/someone/envs/ml/bin/python x.py\ncwd: ${WS}\nexpect_minutes: 1\n`,
  });
  r = await sb.api('POST', `/api/dispatch?ws=${encodeURIComponent(WS)}`, { node: 'n1' });
  s.check('⑤ /api/dispatch 同步回原因', r.json.ok === false && /Linux 路径/.test(r.json.error || ''), String(r.json.error || '').slice(0, 50));

  // ⑥ 账本仍留痕（审计不丢）
  const failed = ledgerOf(sb.home, WS).filter((e) => e.t === 'node.preflight-failed');
  s.check('⑥ 账本仍记录 preflight-failed', failed.length >= 3, `条数=${failed.length}`);

  // ⑦ 失败的节点没有真的起进程
  const nodes = await sb.status(WS);
  const ran = nodes.filter((n) => ['running', 'completed'].includes(n.status));
  s.check('⑦ 失败节点确实没跑（只有 ③ 那条在跑/完成）', ran.length <= 1, ran.map((n) => `${n.id}:${n.status}`).join(',') || '无');

  // ⑧ 超长命令：明确拒绝，绝不静默截断（2026-09-14 事故：被截到 500 字符，尾部只剩 "; /"，
  //    bash 退出 126 → 判定 crashed → 12 分钟的有效结果被判失败，且谁也看不出命令被动过）
  const longCmd = `node ok.js ${'#'.repeat(8200)}`;
  r = await run({ command: longCmd, cwd: WS, title: 'pf-toolong' });
  s.check('⑧ 超长命令 → 明确拒绝并给做法', r.json.ok === false && /超过上限/.test(r.json.error || ''), String(r.json.error || '').slice(0, 56));
  // ⑨ 派发的命令原样落账（否则事后无法审计/复现）
  const qs = ledgerOf(sb.home, WS).filter((e) => e.t === 'quick.dispatched');
  s.check('⑨ 派发的命令原样记进账本', qs.some((e) => String(e.command || '').includes('node ok.js')), `quick.dispatched=${qs.length}`);
} finally {
  sb.stop();
}
s.done();
