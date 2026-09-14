#!/usr/bin/env node
// tools/restart-when-idle.mjs —— 重启 quest 前的门禁：**区分车道**
//
// 为什么要分车道（2026-09-14 实测）：
//   - Windows 车道的子进程被 libuv 放进 job object（KILL_ON_JOB_CLOSE）→ **杀 quest = 连带杀死任务**，不可自愈。
//   - WSL 车道（shell: wsl）的负载由 WSL 内的 systemd 单元持有 → quest 死活与它无关；重启后启动对账
//     会按单元名重新认领并继续盯梢（判定用日志里的 EXIT_CODE / 声明的 success 判据）。
//     注：这条曾经**不成立**——对账给账本独有的快速单发节点硬编码了 shell:'windows'，于是 WSL 快速单发
//     会被当 Windows 找 pid → 判成"进程已消失"（假失败）。2026-09-14 已修（从账本恢复车道），并有
//     端到端测试（沙箱里杀 quest 再起来，断言 adopted-wsl + 最终 ok）。
//
// 用法：
//   node tools/restart-when-idle.mjs            # 只有在跑的都是 WSL 车道（或没有在跑的）才重启
//   node tools/restart-when-idle.mjs --force    # 明知会杀掉 Windows 车道任务，仍要重启
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

const HOME = process.env.QUEST_HOME || path.join(os.homedir(), '.dsh', 'quests');
const TERMINAL = new Set(['completed', 'failed', 'timeout', 'cancelled', 'skipped', 'frozen', 'preflight-failed', 'ready']);
const force = process.argv.includes('--force');

/** plan.md 里每个节点的 shell（节点级 > plan 级 > windows）。 */
function planShells(mdText) {
  const out = new Map();
  const metaShell = (mdText.match(/^shell:\s*(\S+)/m) || [])[1] || 'windows';
  for (const blk of String(mdText || '').split(/^---node:\s*/m).slice(1)) {
    const id = blk.split(/---/)[0].trim();
    const sh = (blk.match(/^shell:\s*(\S+)/m) || [])[1] || metaShell;
    out.set(id, sh === 'wsl' ? 'wsl' : 'windows');
  }
  return out;
}

function scan() {
  const rows = [];
  let dirs = [];
  try { dirs = fs.readdirSync(HOME, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return rows; }
  for (const d of dirs) {
    const f = path.join(HOME, d, 'ledger.jsonl');
    if (!fs.existsSync(f)) continue;
    try { if (Date.now() - fs.statSync(f).mtimeMs > 3 * 86400000) continue; } catch { continue; }
    let planShell = new Map();
    try { planShell = planShells(fs.readFileSync(path.join(HOME, d, 'plan.md'), 'utf8')); } catch {}
    const last = {};
    const lane = {};
    let probePendingAt = 0;
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      // 探针（probe.run / probe.done）不是节点，但杀掉正在跑的探针 = 打断别人的诊断（2026-09-14 发生过）。
      // 只认"最近 3 分钟内还没配对结束"的探针（探针上限 30s，更老的一定是服务被打断留下的残迹）。
      if (e.t === 'probe.run') { probePendingAt = Date.parse(e.at) || 0; continue; }
      if (e.t === 'probe.done') { probePendingAt = 0; continue; }
      if (!e.node) continue;
      // 只有**真正派发过**的节点才可能"在跑"：cancel.fallback 之类会带一个不存在的 id（幽灵节点），
      // 不能因此把重启挡住。
      if (e.t === 'quick.dispatched') { lane[e.node] = e.shell === 'wsl' ? 'wsl' : 'windows'; last[e.node] = { at: e.at, dispatched: true }; }
      else if (e.t === 'node.dispatched') last[e.node] = { at: e.at, dispatched: true };
      else if (TERMINAL.has(e.t.replace('node.', ''))) delete last[e.node];
      else if (e.node && !last[e.node]?.dispatched) delete last[e.node];
    }
    if (probePendingAt && Date.now() - probePendingAt < 3 * 60000) rows.push({ id: '(正在跑的探针)', wsKey: d, at: new Date(probePendingAt).toISOString(), lane: 'probe' });
    for (const [id, v] of Object.entries(last)) {
      rows.push({ id, wsKey: d, at: v.at, lane: lane[id] || planShell.get(id) || 'windows' });
    }
  }
  return rows;
}

const running = scan();
const hard = running.filter((r) => r.lane !== 'wsl');   // 含 probe（探针会被一起杀掉）
const soft = running.filter((r) => r.lane === 'wsl');

if (running.length) {
  const show = (r) => `${r.id.slice(0, 56)}  已跑 ${r.at ? Math.round((Date.now() - Date.parse(r.at)) / 60000) : '?'} 分钟  [${r.lane}]  ${r.wsKey.slice(0, 34)}`;
  if (soft.length) {
    console.log(`✓ WSL 车道在跑 ${soft.length} 个 —— 重启不影响（systemd 持有 + 启动对账按单元名认领）：`);
    for (const r of soft) console.log('   ' + show(r));
  }
  if (hard.length) {
    console.log(`⛔ Windows 车道在跑 ${hard.length} 个 —— 重启会连带杀死它们（job object，且不可自愈）：`);
    for (const r of hard) console.log('   ' + show(r));
  }
  if (hard.length && !force) {
    console.log('\n等它们跑完再重启（`node tools/when-idle.mjs` 看整体状态）；确认要打断就加 --force。');
    console.log('提示：不能白跑的长任务请写成 shell: wsl（PLAN-TEMPLATE 里有说明）；探针（probe）等 30 秒也就结束了。');
    process.exit(2);
  }
  if (hard.length) console.log('\n⚠️ --force：明知会杀掉上面 Windows 车道的任务');
} else {
  console.log('✓ 没有节点在跑，可以安全重启');
}

// 走受监督入口重启：先杀当前链，再用计划任务拉起。临时 .ps1 + -File（内联 -Command 的多行脚本会被引号吃掉）
const PS = `$ErrorActionPreference = 'SilentlyContinue'
foreach ($nm in 'wscript.exe','cmd.exe','node.exe') {
  @(Get-CimInstance Win32_Process -Filter "Name='$nm'") |
    Where-Object { $_.CommandLine -like '*quest-autostart*' -or $_.CommandLine -like '*start-quest*' -or ($_.CommandLine -like '*server.mjs*' -and $_.CommandLine -notlike '*--port*') } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
}
Start-Sleep 2
schtasks /run /tn quest-service | Out-Null
`;
const psFile = path.join(os.tmpdir(), `quest-restart-${Date.now()}.ps1`);
fs.writeFileSync(psFile, PS, 'utf8');
console.log('→ 重启中（杀旧链 + 计划任务拉起）…');
try { execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psFile}"`, { stdio: 'inherit' }); }
finally { try { fs.rmSync(psFile, { force: true }); } catch {} }

await new Promise((r) => setTimeout(r, 10000));
try {
  const tok = fs.readFileSync(path.join(HOME, '.token'), 'utf8').trim();
  const r = await fetch(`http://127.0.0.1:3110/api/status?ws=${encodeURIComponent(process.cwd())}`, { headers: { 'x-quest-token': tok } });
  console.log(`→ 重启后健康检查：HTTP ${r.status}`);
} catch (e) {
  console.log('→ 健康检查失败（可能还在启动）：' + (e.message || e));
}
console.log('→ 提醒：被重启打断的 **Windows 车道**任务需要重派；**WSL 车道**的会被启动对账认领并继续。');
