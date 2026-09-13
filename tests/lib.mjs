// tests/lib.mjs —— 测试共用脚手架
//
// 铁律：每个测试都起**自己的沙箱实例**（独立 --home、独立端口、通知关闭、worker/fixer 关闭），
// 机器上正在跑的生产 quest（3110）与真实任务数据永不被触碰。临时目录落在 os.tmpdir()。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SERVER = path.join(ROOT, 'server.mjs');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 结束进程树（Windows 用 taskkill /T，其它平台退化到 kill）。只针对自己 spawn 的 PID。 */
export function killTree(pid) {
  if (!pid) return;
  try { execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' }); } catch { try { process.kill(pid); } catch {} }
}

/** 起隔离沙箱，返回 { home, ws, api, stop, log }。 */
export async function startSandbox({ name, port, wsDirs = ['ws'], extraConfig = {} }) {
  const home = path.join(os.tmpdir(), `quest-test-${name}`);
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  const ws = {};
  for (const d of wsDirs) {
    const p = path.join(home, d);
    fs.mkdirSync(p, { recursive: true });
    ws[d] = p.replace(/\\/g, '/');
  }
  fs.writeFileSync(path.join(home, 'quest-config.json'), JSON.stringify({
    port, workerBackend: 'off', fixerBackend: 'off', workersEnabled: false, notify: { kind: 'off' }, ...extraConfig,
  }, null, 2));
  const proc = spawn(process.execPath, [SERVER, '--home', home, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let logText = '';
  proc.stdout.on('data', (d) => { logText += d; });
  proc.stderr.on('data', (d) => { logText += d; });
  let token = '';
  for (let i = 0; i < 80 && !token; i++) {
    await sleep(200);
    try { token = fs.readFileSync(path.join(home, '.token'), 'utf8').trim(); } catch {}
  }
  if (!token) { killTree(proc.pid); throw new Error(`沙箱 ${name} 起不来：\n${logText.slice(0, 600)}`); }
  const api = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, {
      method, headers: { 'content-type': 'application/json', 'x-quest-token': token },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 400) }; }
    return { status: r.status, json };
  };
  const status = async (wsPath) => (await api('GET', `/api/status?ws=${encodeURIComponent(wsPath)}`)).json.plan?.nodes || [];
  return { home, ws, token, api, status, proc, stop: () => killTree(proc.pid), log: () => logText.slice(-1200) };
}

/** 轮询等待条件成立。 */
export async function waitFor(fn, ms = 45000, every = 500) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(every); }
  return false;
}

/** 结果收集 + 统一输出（退出码：0 全过 / 1 有失败 / 2 跳过）。 */
export function suite(name) {
  const results = [];
  return {
    check(label, ok, extra = '') {
      results.push({ label, ok: !!ok, extra });
      console.log(`${ok ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`);
    },
    /** 因环境缺失而跳过单条检查（不计入通过数，也不导致失败）。 */
    note(reason) { console.log(`⏭  跳过：${reason}`); },
    skip(reason) { console.log(`⏭  SKIP ${name}: ${reason}`); process.exit(2); },
    done() {
      const bad = results.filter((r) => !r.ok);
      console.log(`\n[${name}] ${results.length - bad.length}/${results.length} 通过`);
      if (bad.length) console.log('失败：' + bad.map((r) => r.label).join(' | '));
      process.exit(bad.length ? 1 : 0);
    },
  };
}

/** 读 quest 账本（沙箱内）。 */
export function ledgerOf(home, wsPath, marker) {
  for (const d of fs.readdirSync(home)) {
    const dir = path.join(home, d);
    let md = ''; try { md = fs.readFileSync(path.join(dir, 'plan.md'), 'utf8'); } catch { continue; }
    if (!md.includes(`workspace: ${wsPath}`)) continue;
    try {
      return fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    } catch { return []; }
  }
  return [];
}
