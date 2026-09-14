// tests/wsl-restart-adopt.mjs —— quest 重启后，正在跑的 WSL 任务必须被"认领"而不是被判死
//
// 2026-09-14 真事故（两个假失败）：对账给"账本独有的快速单发节点"硬编码了 shell:'windows'，
// 于是 WSL 车道的快速单发在重启后按 Windows 去找 pid → 必然找不到 → 判成"进程已消失"（suspect）。
// 实际那个任务活得好好的、70 秒后还在日志里写了"训练完成 / EXIT_CODE:0"、产物也落盘了。
// 修法：① 账本记 quick.dispatched(shell/cwd/command/success)，对账从账本恢复车道；
//      ② 判"WSL 作业是否结束"用两个独立信号（日志里有没有 EXIT_CODE 终标记 + systemd 单元是否 active），
//         并把"问不到"与"确实不活"分开（宽限重试），绝不把不确定当死。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { suite, sleep, killTree, ROOT } from './lib.mjs';

const HOME = path.join(os.tmpdir(), 'quest-test-wsl-restart');
const PORT = 3141;
const s = suite('wsl-restart-adopt');

try { execFileSync('wsl.exe', ['-d', 'Ubuntu', '--exec', 'true'], { timeout: 15000, stdio: 'ignore' }); }
catch { s.skip('本机没有可用的 WSL'); }

const WS = path.join(HOME, 'ws').replace(/\\/g, '/');
const LINUX_WS = '/mnt/' + WS[0].toLowerCase() + '/' + WS.slice(3);
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(path.join(HOME, 'ws'), { recursive: true });
fs.writeFileSync(path.join(HOME, 'quest-config.json'), JSON.stringify({
  port: PORT, workerBackend: 'off', fixerBackend: 'off', workersEnabled: false,
  notify: { kind: 'off' }, runGate: { enabled: false },
}, null, 2));
// 干 40 秒再产出：足够我们在中途"重启" quest
fs.writeFileSync(path.join(HOME, 'ws', 'slow.py'), [
  'import time, pathlib',
  'print("开始", flush=True)',
  'time.sleep(40)',
  'pathlib.Path("wsl_survived.npz").write_bytes(b"x")',
  'print("训练完成", flush=True)',
  '',
].join('\n'));

const startServer = () => spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--home', HOME, '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
let srv = startServer();
let token = '';
for (let i = 0; i < 80 && !token; i++) { await sleep(200); try { token = fs.readFileSync(path.join(HOME, '.token'), 'utf8').trim(); } catch {} }
if (!token) { killTree(srv.pid); s.skip('沙箱起不来'); }
const api = async (m, p, b) => {
  const r = await fetch('http://127.0.0.1:' + PORT + p, { method: m, headers: { 'content-type': 'application/json', 'x-quest-token': token }, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text(); try { return JSON.parse(t); } catch { return { raw: t.slice(0, 200) }; }
};
const nodeOf = async (id) => (await api('GET', '/api/status?ws=' + encodeURIComponent(LINUX_WS))).plan?.nodes?.find((x) => x.id === id);
const ledger = () => {
  const d = fs.readdirSync(HOME).find((x) => fs.existsSync(path.join(HOME, x, 'ledger.jsonl')));
  return fs.readFileSync(path.join(HOME, d, 'ledger.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
};

try {
  const r = await api('POST', '/api/run?ws=' + encodeURIComponent(LINUX_WS), {
    command: 'python3 slow.py', cwd: LINUX_WS, shell: 'wsl', title: 'wsl-adopt', expect_minutes: 5,
    success: '日志含"训练完成"且产出 wsl_survived.npz',
  });
  s.check('① 派发 WSL 快速单发', r.ok === true, `nodeId=${r.nodeId || '-'}`);
  await sleep(8000);
  s.check('② 8 秒后在跑', (await nodeOf(r.nodeId))?.status === 'running');

  // 模拟 quest 重启（只杀 quest 进程，不动 WSL）
  killTree(srv.pid);
  await sleep(2000);
  srv = startServer();
  await sleep(14000);

  const adopted = ledger().filter((e) => e.t === 'node.readopted' && e.node === r.nodeId).pop();
  s.check('③ 新实例按 WSL 车道认领（不是 gone）', adopted?.result === 'adopted-wsl', `result=${adopted?.result}`);
  s.check('④ 认领后仍是在跑，没被误判失败', (await nodeOf(r.nodeId))?.status === 'running', `status=${(await nodeOf(r.nodeId))?.status}`);

  // 等它自己跑完
  let final = null;
  for (let i = 0; i < 30; i++) { await sleep(4000); const n = await nodeOf(r.nodeId); if (n && ['completed', 'failed', 'timeout'].includes(n.status)) { final = n; break; } }
  s.check('⑤ 最终判定为 ok（不是 suspect 假失败）', final?.verdict === 'ok', `status=${final?.status} verdict=${final?.verdict} via=${String(final?.via || '').slice(0, 60)}`);
  s.check('⑥ 产物确实产出', fs.existsSync(path.join(HOME, 'ws', 'wsl_survived.npz')));
} finally {
  killTree(srv.pid);
  await sleep(200);
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
}
s.done();
