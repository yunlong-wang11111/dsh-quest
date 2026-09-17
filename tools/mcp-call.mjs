#!/usr/bin/env node
// tools/mcp-call.mjs —— quest MCP 的命令行客户端：以标准 MCP（stdio）身份调一个工具并打印结果。
//
// 用途（2026-09-15）：MCP 层做好后的"自测门"——不依赖 DSH/ZCode 注册，
// 任何脚本/人/agent 一行就能验证 quest 的 MCP 是不是好的：
//   node tools/mcp-call.mjs quest_status '{"ws":"C:/Users/Solanine/Desktop/V8/code_kl"}'
//   node tools/mcp-call.mjs quest_log '{"node":"quick-xxx","ws":"C:/...","tail":2000}'
//   node tools/mcp-call.mjs quest_status '{}'          # 缺省=最近活跃工作区（brief）
// 参数是 JSON 字符串（可空 {}）。退出码：0 成功 / 1 工具报错 / 2 用法错。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [tool, argsJson] = process.argv.slice(2);
if (!tool) {
  console.log('用法：node tools/mcp-call.mjs <工具名> [\'{"参数":"值"}\']');
  console.log('  工具：quest_plan quest_dispatch quest_run quest_status quest_log quest_probe quest_files quest_cancel');
  process.exit(2);
}
let args = {};
try { args = argsJson ? JSON.parse(argsJson) : {}; } catch (e) {
  console.error('✗ 第二个参数必须是 JSON：' + e.message); process.exit(2);
}

const proc = spawn(process.execPath, [path.join(ROOT, 'mcp-server.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
const pending = new Map();
let id = 0;
proc.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    } catch {}
  }
});
proc.on('exit', () => { for (const r of pending.values()) r({ error: { message: 'MCP 进程提前退出' } }); });
const call = (method, params) => new Promise((res) => {
  const mid = ++id;
  pending.set(mid, res);
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params }) + '\n');
});

await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mcp-call-cli', version: '0.1.0' } });
await call('notifications/initialized', {});
const resp = await call('tools/call', { name: tool, arguments: args });
proc.kill();

if (resp.error) { console.error('✗ ' + (resp.error.message || JSON.stringify(resp.error))); process.exit(1); }
if (resp.result?.isError) { console.error('✗ 工具返回错误：'); }
const text = (resp.result?.content || []).map((c) => c.text || '').join('');
try {
  // 结果是 JSON 就美化打印（quest 的工具都回 JSON）
  console.log(JSON.stringify(JSON.parse(text), null, 2));
} catch { console.log(text); }
process.exit(resp.result?.isError ? 1 : 0);
