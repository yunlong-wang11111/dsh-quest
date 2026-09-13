// tests/two-strike.mjs —— DSH 看门狗的"两振判死"逻辑（同一轮内失败 → 等 60s 复探 → 仍失败才判死）
//
// 被测对象是机器上的看门狗脚本（不在本仓库内），所以：
//   - 找不到就跳过（exit 2，runner 记为 SKIP）
//   - 路径可用 QUEST_WATCHDOG_PATH 覆盖，默认找 %USERPROFILE%\Desktop\watch-dsh.ps1
// 做法：把脚本里"探测 + 两振"那段**原样抽出来**（只换端口与等待时长），用独立进程的假监听器
//       验证三种场景。抽原文而不是复写一份，保证测的就是上线的那段。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { suite, sleep, killTree } from './lib.mjs';

const PORT = 3199;
const WD = process.env.QUEST_WATCHDOG_PATH || path.join(os.homedir(), 'Desktop', 'watch-dsh.ps1');
const s = suite('two-strike');
if (!fs.existsSync(WD)) s.skip(`找不到看门狗脚本 ${WD}（用 QUEST_WATCHDOG_PATH 指定）`);

const T = path.join(os.tmpdir(), 'quest-test-two-strike');
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(T, { recursive: true });
const PROBE = `& 'C:\\Windows\\System32\\curl.exe' -sS -m 4 -o NUL -w '%{http_code}' 'http://127.0.0.1:${PORT}' 2>$null`;

const startListener = () => spawn(process.execPath, ['-e', `require('http').createServer((q,s)=>{s.writeHead(401);s.end('no')}).listen(${PORT},'127.0.0.1')`], { stdio: 'ignore' });
const preflight = () => {
  try { return execSync(`powershell -NoProfile -Command "$c = ${PROBE}; Write-Output $c; exit 0"`, { encoding: 'utf8', timeout: 30000 }).trim().split(/\r?\n/).pop().trim(); }
  catch (e) { return String((e && e.stdout) || '').trim().split(/\r?\n/).pop().trim(); }
};

// 抽出真实脚本里的两振段
const src = fs.readFileSync(WD, 'utf8');
const from = src.indexOf('$webAlive = & $curl');
const to = src.indexOf('$webAlive = $webRetry', from);
const endBrace = src.indexOf('\r\n}', to);
if (from < 0 || to < 0 || endBrace < 0) s.skip('看门狗脚本里找不到预期的两振区块（可能已改结构）');
const whole = src.slice(from, endBrace + 3).split('3080').join(String(PORT)).replace(/Start-Sleep \d+/, 'Start-Sleep 4');
const probeLine = whole.split('\r\n')[0];
const ifBlock = whole.slice(probeLine.length + 2).replace('    Log "MISS#1', '    $retried = $true; Write-Output "M1"; Log "MISS#1');
const gen = (gate) => [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$curl = 'C:\\Windows\\System32\\curl.exe'",
  '$retried = $false',
  probeLine,
  'Write-Output "P1=$webAlive"',
  ...(gate ? [`while (-not (Test-Path '${T}\\go.txt')) { Start-Sleep -Milliseconds 200 }`] : []),
  ifBlock,
  'Write-Output "RETRIED=$retried"',
  'Write-Output "VERDICT=$webAlive"',
].join('\r\n');
const parse = (o) => ({ p1: /P1=(\S*)/.exec(o)?.[1], v: /VERDICT=(\S*)/.exec(o)?.[1], r: /RETRIED=(\S*)/.exec(o)?.[1] });
const run = (f) => parse(execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${f}"`, { encoding: 'utf8', timeout: 90000 }));

let lis;
try {
  fs.writeFileSync(`${T}/a.ps1`, gen(false), 'utf8');

  // ① 一直死 → 复探后判死
  s.check('预检：端口无人监听', preflight() === '000');
  let t0 = Date.now();
  let d = run(`${T}/a.ps1`);
  s.check('① 两次都失败 → 判死', d.v === '000' && d.r === 'True', `retried=${d.r} 用时${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // ② 一直活 → 首探即活、不重探（快路径）
  lis = startListener();
  for (let i = 0; i < 20 && preflight() !== '401'; i++) await sleep(300);
  s.check('预检：端口已在监听', preflight() === '401');
  t0 = Date.now();
  d = run(`${T}/a.ps1`);
  s.check('② 首探即活 → 不重探（无额外延迟）', d.v === '401' && d.r === 'False', `用时${((Date.now() - t0) / 1000).toFixed(1)}s`);
  lis.kill();
  for (let i = 0; i < 20 && preflight() !== '000'; i++) await sleep(300);

  // ③ 首探失败后恢复 → 抖动被吸收，不判死
  fs.rmSync(`${T}/go.txt`, { force: true });
  fs.writeFileSync(`${T}/b.ps1`, gen(true), 'utf8');
  s.check('预检：端口又回到无人监听', preflight() === '000');
  const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', `${T}/b.ps1`]);
  let buf = '';
  p.stdout.on('data', (x) => { buf += x; });
  p.stderr.on('data', (x) => { buf += x; });
  for (let i = 0; i < 60 && !buf.includes('P1='); i++) await sleep(200);
  const p1 = /P1=(\S*)/.exec(buf)?.[1];
  lis = startListener();
  for (let i = 0; i < 20 && preflight() !== '401'; i++) await sleep(200);
  fs.writeFileSync(`${T}/go.txt`, 'go'); // 放行复探
  await new Promise((r) => p.on('exit', r));
  d = parse(buf);
  s.check('③ 首探失败、复探成功 → 抖动被吸收（不判死）', p1 === '000' && d.v === '401' && d.r === 'True', `p1=${p1} retried=${d.r} verdict=${d.v}`);
} finally {
  if (lis) killTree(lis.pid);
  fs.rmSync(T, { recursive: true, force: true });
}
s.done();
