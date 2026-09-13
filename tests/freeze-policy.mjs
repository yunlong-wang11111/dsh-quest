// tests/freeze-policy.mjs —— plan 覆盖保护(409/force) 与 freeze_on: hard-fail-only
import { startSandbox, waitFor, suite, ledgerOf, sleep } from './lib.mjs';

const PORT = 3124;
const s = suite('freeze-policy');
const sb = await startSandbox({ name: 'freeze-policy', port: PORT, wsDirs: ['ws-a', 'ws-b', 'ws-c', 'ws-d'], extraConfig: { runGate: { enabled: false } } });
const st = async (ws, id) => (await sb.status(ws)).find((n) => n.id === id);
const TERMINAL = ['completed', 'failed', 'timeout', 'cancelled', 'frozen', 'skipped'];
const node = (id, command, extra = '') => `---node: ${id}---\ncommand: ${command}\ncwd: {{WS}}\nexpect_minutes: 1\n${extra}\n`;

try {
  // ── ⑦ plan 覆盖保护 ────────────────────────────────────────────────────
  const C = sb.ws['ws-c'];
  const plan = (nodes) => `workspace: ${C}\n` + nodes.map((n) => node(n.id, n.command, n.extra || '').replace('{{WS}}', C)).join('\n');
  let r = await sb.api('POST', `/api/plan?ws=${encodeURIComponent(C)}`, { markdown: plan([{ id: 'a', command: 'cmd /c echo done!' }, { id: 'b', command: 'cmd /c echo b-run' }, { id: 'c', command: 'cmd /c echo done!' }]) });
  s.check('⑦ 首次写 plan 通过', r.json.ok === true, `status=${r.status}`);

  await sb.api('POST', `/api/dispatch?ws=${encodeURIComponent(C)}`, { node: 'a' });
  await sb.api('POST', `/api/dispatch?ws=${encodeURIComponent(C)}`, { node: 'c' });
  const done = await waitFor(async () => {
    for (const id of ['a', 'c']) if ((await st(C, id))?.status !== 'completed') return false;
    return true;
  }, 40000);
  s.check('⑦ 前置：a/c 跑成 completed', done, `a=${(await st(C, 'a'))?.status} c=${(await st(C, 'c'))?.status}`);

  r = await sb.api('POST', `/api/plan?ws=${encodeURIComponent(C)}`, { markdown: plan([{ id: 'a', command: 'cmd /c echo done!' }, { id: 'c', command: 'cmd /c echo done!' }]) });
  s.check('⑦ 丢未完成节点 → 409 拦截', r.status === 409 && (r.json.dropped || []).some((d) => d.id === 'b'), `status=${r.status} dropped=${JSON.stringify(r.json.dropped)}`);
  s.check('⑦ 已完成的节点不拦', !(r.json.dropped || []).some((d) => d.id === 'a'), `dropped=${JSON.stringify(r.json.dropped)}`);
  s.check('⑦ 409 带可操作 hint', typeof r.json.hint === 'string' && r.json.hint.includes('force'), String(r.json.hint).slice(0, 40));

  r = await sb.api('POST', `/api/plan?ws=${encodeURIComponent(C)}`, { markdown: plan([{ id: 'a', command: 'cmd /c echo done!' }, { id: 'c', command: 'cmd /c echo done!' }]), force: true });
  s.check('⑦ force:true 放行', r.json.ok === true, `status=${r.status}`);
  r = await sb.api('POST', `/api/plan?ws=${encodeURIComponent(C)}`, { markdown: plan([{ id: 'a', command: 'cmd /c echo done!' }]) });
  s.check('⑦ 只丢已完成节点 → 不拦', r.json.ok === true, `status=${r.status}`);
  s.check('⑦ 账本记录强制替换', ledgerOf(sb.home, C).some((e) => e.t === 'plan.reloaded' && e.forced === true));

  // ── ②c 冻结策略 ────────────────────────────────────────────────────────
  const chain = (ws, extra) => `workspace: ${ws}\n` +
    `---node: up---\ncommand: cmd /c echo hello-up\ncwd: ${ws}\nexpect_minutes: 1\n${extra}\n\n` +
    `---node: down---\ncommand: cmd /c echo hello-down\ncwd: ${ws}\nexpect_minutes: 1\nafter: up\n${extra.replace('freeze_on', 'freeze_on')}\n`;
  const upSuspect = async (ws) => { await waitFor(async () => TERMINAL.includes((await st(ws, 'up'))?.status), 40000); return (await st(ws, 'up'))?.verdict; };

  // A：声明在下游（soft-pass 放行）
  const A = sb.ws['ws-a'];
  await sb.api('POST', `/api/plan?ws=${encodeURIComponent(A)}`, { markdown: chain(A, 'freeze_on: hard-fail-only') });
  await sleep(1200); // 让 plan.md 离开"运行窗口"（判定器已排除台账，但保持真实时序）
  await sb.api('POST', `/api/dispatch?ws=${encodeURIComponent(A)}`, { node: 'up' });
  s.check('②c A 上游判为 suspect', (await upSuspect(A)) === 'suspect', `up=${(await st(A, 'up'))?.via}`);
  const downRan = await waitFor(async () => ['running', 'completed', 'failed'].includes((await st(A, 'down'))?.status), 25000);
  const ledA = ledgerOf(sb.home, A);
  s.check('②c A 疑似上游放行下游（soft-pass）', downRan && ledA.some((e) => e.t === 'node.soft-pass'), `down=${(await st(A, 'down'))?.status}`);

  // B：默认 any-fail（仍冻结）
  const B = sb.ws['ws-b'];
  await sb.api('POST', `/api/plan?ws=${encodeURIComponent(B)}`, { markdown: chain(B, '') });
  await sleep(1200);
  await sb.api('POST', `/api/dispatch?ws=${encodeURIComponent(B)}`, { node: 'up' });
  s.check('②c B 上游同样 suspect', (await upSuspect(B)) === 'suspect');
  await waitFor(async () => (await st(B, 'down'))?.status === 'frozen', 20000, 400);
  const ledB = ledgerOf(sb.home, B);
  s.check('②c B 默认冻结下游（旧行为不变）', (await st(B, 'down'))?.status === 'frozen' && ledB.some((e) => e.t === 'node.frozen'));
  s.check('②c B 未派发下游', !ledB.some((e) => e.t === 'node.dispatched' && e.node === 'down'));

  // D：真崩溃仍冻结（hard-fail-only 不放过硬失败）
  const D = sb.ws['ws-d'];
  await sb.api('POST', `/api/plan?ws=${encodeURIComponent(D)}`, {
    markdown: `workspace: ${D}\n---node: boom---\ncommand: cmd /c exit 7\ncwd: ${D}\nexpect_minutes: 1\nfreeze_on: hard-fail-only\n\n---node: next---\ncommand: cmd /c echo next\ncwd: ${D}\nexpect_minutes: 1\nafter: boom\nfreeze_on: hard-fail-only\n`,
  });
  await sleep(1200);
  await sb.api('POST', `/api/dispatch?ws=${encodeURIComponent(D)}`, { node: 'boom' });
  await waitFor(async () => TERMINAL.includes((await st(D, 'boom'))?.status), 40000);
  s.check('②c D 崩溃判为硬失败', ['crashed', 'startup-failed'].includes((await st(D, 'boom'))?.verdict), `verdict=${(await st(D, 'boom'))?.verdict}`);
  await waitFor(async () => (await st(D, 'next'))?.status === 'frozen', 20000, 400);
  const ledD = ledgerOf(sb.home, D);
  s.check('②c D 硬失败照样冻结（没被宽松策略放走）', (await st(D, 'next'))?.status === 'frozen' && !ledD.some((e) => e.t === 'node.soft-pass'));
} finally {
  sb.stop();
}
s.done();
