// tests/probe-lane.mjs —— quest_probe 两个致命性质的回归测试
//
// 背景（2026-09-14 真实事故）：WSL 工作区的探针命令首词是 Linux 绝对路径（/home/…/bin/python），
// 在 Windows 上 spawn 必然 ENOENT；而 /api/probe 只监听 child 的 'exit'，没人听 'error'
// ⇒ await 永不返回 ⇒ HTTP 请求永远悬着（客户端 35s 后 AbortError，看起来像"quest 服务不可达"）。
// 账本特征：probe.run 没有配对的 probe.done（当时的 5 条里有 4 条是 Linux 路径命令）。
//
// 本测试盯三条：
//   A. Windows 车道正常路径：有输出、有配对 probe.done；
//   B. 起不来时必须**快速报错**（回归主线：以前会挂住不返回）；
//   C. WSL 车道真的能跑（他们真正在用的车道；环境没有 WSL 就跳过）。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startSandbox, suite, sleep } from './lib.mjs';

const PORT = 3195;
const s = suite('probe-lane');
const sb = await startSandbox({ name: 'probe-lane', port: PORT, wsDirs: ['ws'] });
const ws = sb.ws.ws;

/** 沙箱里唯一那份账本（探针会先建目录，即使还没有 plan） */
const ledger = () => {
  for (const d of fs.readdirSync(sb.home)) {
    const f = path.join(sb.home, d, 'ledger.jsonl');
    if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }
  return [];
};
const probe = async (command, cwd, ms = 40000) => {
  const t0 = Date.now();
  const r = await Promise.race([
    sb.api('POST', `/api/probe?ws=${encodeURIComponent(ws)}`, { command, cwd }),
    sleep(ms).then(() => ({ timedOut: true })),
  ]);
  return { ...r, ms: Date.now() - t0 };
};
/** 每条 probe.run 都必须有收尾（成功/probe.done、起不来/probe.error）——悬着就是事故 */
const pairing = () => {
  const l = ledger();
  const c = (t) => l.filter((e) => e.t === t).length;
  return { run: c('probe.run'), close: c('probe.done') + c('probe.error') };
};

try {
  // ── A. Windows 车道：解释器跑工作区内脚本 ──────────────────────────────
  const a = await probe('node -e "console.log(\'WINPROBE-OK\')"', ws);
  s.check('A1 Windows 车道探针有响应且成功', !a.timedOut && a.json?.ok === true, `${a.ms}ms code=${a.json?.code}`);
  s.check('A2 Windows 车道回传了输出', String(a.json?.log || '').includes('WINPROBE-OK'), JSON.stringify(String(a.json?.log || '').slice(0, 60)));
  const p1 = pairing();
  s.check('A3 账本每条 probe.run 都有收尾（事故特征就是缺 done）', p1.run === p1.close, `run=${p1.run} 收尾=${p1.close}`);

  // ── B. 起不来：必须快速报错，不许挂住（回归主线）───────────────────────
  const b = await probe('node -e "console.log(1)"', path.join(sb.home, 'definitely-missing-dir'), 15000);
  s.check('B1 spawn 失败时端点仍然返回（不悬着）', !b.timedOut, b.timedOut ? '>15s 没回应 = 又挂住了' : `${b.ms}ms`);
  s.check('B2 错误信息指出是 ENOENT/起不来', b.json?.ok === false && /ENOENT|没能启动/.test(String(b.json?.error || '')), String(b.json?.error || '').slice(0, 120));
  s.check('B3 失败也留痕（probe.error）', ledger().some((e) => e.t === 'probe.error'));

  // ── C. WSL 车道：他们真正在用的那条 ───────────────────────────────────
  let wslOk = false;
  try { execFileSync('wsl.exe', ['-d', 'Ubuntu', '--exec', 'bash', '-c', 'exit 0'], { stdio: 'ignore', timeout: 20000 }); wslOk = true; } catch {}
  if (!wslOk) {
    s.note('环境里没有可用的 WSL（Ubuntu）——C 组跳过（Windows 侧逻辑已由 A/B 覆盖）');
  } else {
    const c = await probe('/usr/bin/python3 -c "print(\'WSLPROBE-OK\')"', '/tmp');
    s.check('C1 WSL 车道探针有响应（修复前这里必挂）', !c.timedOut, c.timedOut ? '>40s 没回应' : `${c.ms}ms code=${c.json?.code}`);
    s.check('C2 WSL 车道回传了 Linux 侧 stdout', String(c.json?.log || '').includes('WSLPROBE-OK'), JSON.stringify(String(c.json?.log || '').slice(0, 80)));
    const p3 = pairing();
    s.check('C3 WSL 探针也有收尾', p3.run === p3.close, `run=${p3.run} 收尾=${p3.close}`);

    // ── D. 长命令到点被杀：WSL 车道由 Linux 侧 timeout 收口 ─────────────
    const d = await probe('/usr/bin/python3 -c "import time; time.sleep(600)"', '/tmp', 60000);
    s.check('D1 超长 WSL 探针被按时杀掉并返回', !d.timedOut && d.json?.ok === true && d.json?.killed === true,
      `${d.ms}ms killed=${d.json?.killed} code=${d.json?.code}`);
    s.check('D2 在插件侧 35s 超时之前就返回（省得再被误读成服务不可达）', d.ms < 35000, `${d.ms}ms`);
  }
} finally {
  sb.stop();
}
s.done();
