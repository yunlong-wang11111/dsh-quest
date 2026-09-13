// tests/run-all.mjs —— 依次跑全部测试，汇总结果
//
//   node tests/run-all.mjs            # 全部
//   node tests/run-all.mjs judge      # 只跑名字含 judge 的
//
// 退出码：0 全过 / 1 有失败 / 2 只有跳过（SKIP）
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2] || '';
const files = fs.readdirSync(HERE)
  .filter((f) => f.endsWith('.mjs') && !['lib.mjs', 'run-all.mjs'].includes(f))
  .filter((f) => !filter || f.includes(filter))
  .sort();

if (!files.length) { console.log('没有匹配的测试文件'); process.exit(1); }

const rows = [];
for (const f of files) {
  console.log(`\n──────── ${f} ────────`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(HERE, f)], { stdio: 'inherit' });
  const code = r.status === null ? 1 : r.status;
  rows.push({ f, code, sec: ((Date.now() - t0) / 1000).toFixed(1) });
}

console.log('\n════════ 汇总 ════════');
for (const r of rows) {
  console.log(`${r.code === 0 ? '✅ PASS' : r.code === 2 ? '⏭  SKIP' : '❌ FAIL'}  ${r.f.padEnd(24)} ${r.sec}s`);
}
const failed = rows.filter((r) => r.code === 1).length;
const skipped = rows.filter((r) => r.code === 2).length;
console.log(`\n${rows.length - failed - skipped} 通过 / ${failed} 失败 / ${skipped} 跳过`);
process.exit(failed ? 1 : skipped === rows.length ? 2 : 0);
