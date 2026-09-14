// tests/wsl-mntc-artifact.mjs —— WSL 节点、cwd 在 /mnt/c 时，产物必须被扫到
//
// 2026-09-14 的真事故：cwd 为 /mnt/c/... 的 WSL 节点，判定器用 \\wsl$\<distro>\mnt\c\... 去扫产物，
// 而那条路对 drvfs 是 EPERM —— 于是产物扫描全空，节点被误判「未找到产物 / 无输出」（假失败），
// 断点续跑也找不到存档、图片不推送。修法是：/mnt/<盘> 用原生 <盘>:\ 路径读，真 Linux 路径才走 UNC。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { startSandbox, waitFor, suite, sleep } from './lib.mjs';

const PORT = 3137;
const s = suite('wsl-mntc-artifact');

// 没有 WSL 就跳过（这个用例是平台相关的）
try {
  execFileSync('wsl.exe', ['-d', 'Ubuntu', '--exec', 'true'], { timeout: 15000, stdio: 'ignore' });
} catch (e) {
  s.skip('本机没有可用的 WSL（wsl.exe -d Ubuntu 不可用）');
}

const toLinux = (win) => {
  const m = String(win).match(/^([A-Za-z]):[\\/](.*)$/);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : null;
};

const sb = await startSandbox({ name: 'wsl-mntc-artifact', port: PORT, extraConfig: { runGate: { enabled: false } } });
const WIN_WS = sb.ws.ws;
const LINUX_WS = toLinux(WIN_WS);

try {
  s.check('前置：能算出该工作区的 WSL 视图', !!LINUX_WS, `${WIN_WS} → ${LINUX_WS}`);

  // 用 WSL 里的 python3 在工作区写一个产物（npz），并声明它作为成功判据
  const cmd = `python3 -c "open('art_mntc.npz','wb').write(b'x'); print('WROTE_OK')"`;
  const r = await sb.api('POST', `/api/run?ws=${encodeURIComponent(WIN_WS)}`, {
    command: cmd, cwd: LINUX_WS, shell: 'wsl', title: 'wsl-mntc', expect_minutes: 1,
    success: '产出 art_mntc.npz',
  });
  s.check('① 派发 WSL 节点（cwd 在 /mnt/c）', r.json.ok === true, `nodeId=${r.json.nodeId || '-'} err=${String(r.json.error || '').slice(0, 60)}`);

  const done = await waitFor(async () => {
    const n = (await sb.status(WIN_WS)).find((x) => x.id === r.json.nodeId);
    return n && ['completed', 'failed', 'timeout', 'cancelled'].includes(n.status);
  }, 90000, 1000);
  const n = (await sb.status(WIN_WS)).find((x) => x.id === r.json.nodeId);
  s.check('② 节点跑到终态', done, `status=${n?.status} verdict=${n?.verdict} via=${n?.via}`);

  // 核心断言：产物确实被扫到（修好之前这里会是 success-claim-failed / no-output）
  s.check('③ 产物被扫到（不再误判"未找到"）', n?.verdict === 'ok', `verdict=${n?.verdict} via=${n?.via} detail=${String(n?.judgeDetail || '').slice(0, 60)}`);

  // 产物真的在 Windows 侧（说明 WSL 确实写进来了）
  s.check('④ 产物确实落在工作区里', fs.existsSync(path.join(WIN_WS, 'art_mntc.npz')), '');
} finally {
  sb.stop();
  await sleep(200);
  try { fs.rmSync(WIN_WS, { recursive: true, force: true }); } catch {}
}
s.done();
