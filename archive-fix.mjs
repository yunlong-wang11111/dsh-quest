// archive-fix.mjs — 手动归档指定工作区的所有会话（翻页补丁：flip 内的 list 在 0.1.5 下偶发 fetch failed）
import { NodeApiClient } from './lib/dsh-client-v2.mjs';

const api = new NodeApiClient('http://127.0.0.1:3080', 30000, { tokenLog: '__HOME__/.dsh/dsh-run.log' });

const targets = [
  'C:\\Users\\USER\\Desktop\\V8',
  'C:\\Users\\USER\\Desktop\\piml_fingertip',
  'C:\\Users\\USER\\dsh-plugins',
];

const lr = await api.sessions.list({});
if (!lr.result.ok) { console.log('list failed'); process.exit(1); }
const all = lr.result.value?.items ?? [];
console.log('总会话:', all.length);

for (const ws of targets) {
  const wsNorm = ws.replace(/\\/g, '/').toLowerCase();
  const toArchive = all.filter(it => String(it.cwd ?? '').replace(/\\/g, '/').toLowerCase() === wsNorm);
  const name = ws.split('\\').pop();
  console.log(`${name}: ${toArchive.length} 个待归档`);
  let ok = 0, fail = 0;
  for (const it of toArchive) {
    try {
      await api.workspace.archiveSession({ sessionId: it.sessionId });
      ok++;
    } catch { fail++; }
  }
  console.log(`  归档 ${ok} 成功, ${fail} 失败`);
}
console.log('=== 归档完成 ===');
