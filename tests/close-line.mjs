// tests/close-line.mjs —— 收线：把"挂着扳机"的遗留节点冻掉，且不谎报正在跑的
//
// 为什么测：orchestrate 只在事件上跑（写 plan / 节点退出 / 派发），所以一条被放弃的线里
// 遗留的 pending 节点会在同一工作区下一次动作时被顺带派出去（老线抢机器）。
// 收线 = 冻结 pending/ready 节点；正在跑的**不动**（否则会出现"状态 frozen、进程还在烧 CPU"的谎报）。
import { startSandbox, suite, waitFor } from './lib.mjs';

const PORT = 3193;
const s = suite('close-line');
const sb = await startSandbox({ name: 'close-line', port: PORT, wsDirs: ['ws'] });
const ws = sb.ws.ws;
const nodes = async () => (await sb.api('GET', `/api/status?ws=${encodeURIComponent(ws)}`)).json.plan?.nodes || [];
const stOf = async (id) => (await nodes()).find((n) => n.id === id)?.status;

try {
  // 一条 a → b 的线：a 要跑 8 秒（测试期间一直在跑），b 因此停在 pending = 扳机挂着
  const planMd = [
    '# 任务线：收线用',
    `workspace: ${ws}`,
    'shell: windows',
    '',
    '---node: a---',
    'command: node -e "setTimeout(()=>console.log(\'DONE\'),8000)"',
    `cwd: ${ws}`,
    '---node: b---',
    'command: node -e "console.log(\'DONE\')"',
    `cwd: ${ws}`,
    'after: a',
  ].join('\n');
  const w = await sb.api('POST', `/api/plan?ws=${encodeURIComponent(ws)}`, { markdown: planMd, force: true });
  s.check('① 写入 a→b 的 plan', w.json?.ok !== false, JSON.stringify(w.json).slice(0, 80));
  // 写 plan 不会自动启动（orchestrate 只在"节点退出"时跑），第一条要显式派发 —— 与生产一致
  await sb.api('POST', `/api/dispatch?ws=${encodeURIComponent(ws)}`, { node: 'a' });
  const aRunning = await waitFor(async () => (await stOf('a')) === 'running', 40000);
  s.check('② a 在跑、b 挂着（扳机状态）', aRunning && (await stOf('b')) === 'pending', `a=${await stOf('a')} b=${await stOf('b')}`);

  const dry = await sb.api('POST', `/api/close-line?ws=${encodeURIComponent(ws)}`, {});
  s.check('③ dry-run 只列未开跑的节点，不动账本', dry.json?.dryRun === true && (dry.json.open || []).some((o) => o.id === 'b'), JSON.stringify(dry.json).slice(0, 140));
  s.check('④ dry-run 报告"正在跑"的 a（收线不碰它）', (dry.json.running || []).some((o) => o.id === 'a'), JSON.stringify(dry.json.running));
  s.check('⑤ dry-run 不改状态（b 仍 pending）', (await stOf('b')) === 'pending', String(await stOf('b')));

  const ap = await sb.api('POST', `/api/close-line?ws=${encodeURIComponent(ws)}`, { apply: true, reason: '测试收线' });
  s.check('⑥ apply 冻结 b', ap.json?.ok === true && (await stOf('b')) === 'frozen', `b=${await stOf('b')}`);
  s.check('⑦ 正在跑的 a 没被冻（不谎报）', (await stOf('a')) === 'running', `a=${await stOf('a')}`);
  const line = (await sb.api('GET', `/api/status?ws=${encodeURIComponent(ws)}`)).json.line;
  s.check('⑧ 冻结后 active 不含 b（线静下来了）', line?.active === 1, `active=${line?.active}`);
  s.check('⑨ 账本留下 plan.closed（可审计）', (await sb.api('GET', `/api/status?ws=${encodeURIComponent(ws)}`)).json.plan?.closedAt != null);

  // 收线可逆：重派 b = 人工解冻
  const dp = await sb.api('POST', `/api/dispatch?ws=${encodeURIComponent(ws)}`, { node: 'b' });
  s.check('⑩ 重派 b 即可解冻（收线不是死锁）', dp.json?.ok !== false && (await stOf('b')) !== 'frozen', `b=${await stOf('b')}`);
} finally {
  sb.stop();
}
s.done();
