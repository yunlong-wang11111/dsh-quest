// 用 quest 生产客户端实测 0.2.1 下 create+prompt 全链（spawn/worker 同款路径）
import { NodeApiClient } from './lib/dsh-client-v2.mjs';

const api = new NodeApiClient('http://127.0.0.1:3080', 30000, {
  tokenLog: 'C:/Users/Solanine/.dsh/dsh-run.log',
});
const sid = (await new Promise((res) => {
  api.sessions.create({ cwd: 'D:/temp' }).then((r) => {
    console.log('create:', JSON.stringify(r).slice(0, 220));
    res(r?.result?.value?.sessionId || '');
  }).catch((e) => { console.log('create EX:', e.message); res(''); });
}));
if (!sid) { console.log('HEALTH-FAIL create'); process.exit(1); }
console.log('sid:', sid.slice(0, 22));

let got = '';
try {
  api.followSession(sid);
} catch (e) { console.log('follow ex:', e.message); }
const r2 = await api.sessions.prompt({ sessionId: sid, mode: 'queue',
  content: [{ type: 'text', text: 'Reply with exactly: HEALTH-OK' }] });
console.log('prompt:', JSON.stringify(r2).slice(0, 220));

for (let i = 0; i < 16; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  try {
    const lst = await api.sessions.list({});
    const blob = JSON.stringify(lst);
    if (blob.includes('HEALTH-OK')) { got = 'yes'; break; }
  } catch (e) { /* list 失败继续等 */ }
  if (i === 3 || i === 7) console.log(`  ${(i + 1) * 5}s ...`);
}
console.log(got === 'yes' ? 'HEALTH-OK: 新会话回合正常 ✅' : 'HEALTH-FAIL: 80 秒无回合输出');
try { await api.workspace.archiveSession({ sessionId: sid }); } catch {}
process.exit(got === 'yes' ? 0 : 1);
