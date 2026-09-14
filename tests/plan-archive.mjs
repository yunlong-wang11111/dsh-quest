// tests/plan-archive.mjs —— 历史计划：覆盖前存档 + /api/plans 能列出来
//
// 为什么重要（用户口径）：一次科研里会有很多个**短流程 plan**（生成数据→训练→后处理→评估→可视化），
// 每次一份、做完就该能回看。而一个工作区只有一份 plan.md，覆盖即永久丢失依赖关系（箭头）与 handoff。
// 本测试盯四件事：① 覆盖时旧 plan 被存档；② 存档里的 after 依赖仍在（这是最容易丢的东西）；
// ③ 存档节点的状态从账本取（不是 pending）；④ 空壳 plan（快速单发自动补的）不存档（别把历史刷满噪音）。
import fs from 'node:fs';
import path from 'node:path';
import { startSandbox, suite, waitFor } from './lib.mjs';

const PORT = 3192;
const s = suite('plan-archive');
const sb = await startSandbox({ name: 'plan-archive', port: PORT, wsDirs: ['ws'] });
const ws = sb.ws.ws;
const plan = (nodes) => ['# 任务线：存档测试', `workspace: ${ws}`, 'shell: windows', '',
  ...nodes.flatMap((n) => [`---node: ${n.id}---`, `command: ${n.command}`, `cwd: ${ws}`, ...(n.after ? [`after: ${n.after}`] : [])])].join('\n');
const plans = async () => (await sb.api('GET', `/api/plans?ws=${encodeURIComponent(ws)}`)).json.plans || [];

try {
  // ① 写第一条线并跑掉它的头节点（这样存档里能看到真实状态）
  const A = await sb.api('POST', `/api/plan?ws=${encodeURIComponent(ws)}`, { markdown: plan([{ id: 'gen', command: 'node -e "console.log(1)"' }, { id: 'train', command: 'node -e "console.log(2)"', after: 'gen' }]), force: true });
  s.check('① 写入第一条线（gen → train）', A.json?.ok !== false, JSON.stringify(A.json).slice(0, 70));
  await sb.api('POST', `/api/dispatch?ws=${encodeURIComponent(ws)}`, { node: 'gen' });
  const settled = await waitFor(async () => (await plans())[0]?.counts?.running == null, 45000);
  s.check('② gen 跑完（存档要能反映真实状态）', settled);

  // ② 覆盖成第二条线 → 第一条应被存档
  const B = await sb.api('POST', `/api/plan?ws=${encodeURIComponent(ws)}`, { markdown: plan([{ id: 'eval1', command: 'node -e "console.log(3)"' }]), force: true });
  s.check('③ 覆盖成功并回报存档文件名', B.json?.ok !== false && !!B.json?.archived, String(B.json?.archived || '(无 archived)'));
  const list = await plans();
  s.check('④ /api/plans 列出 2 条（当下 + 历史）', list.length === 2, list.map((p) => p.file).join(' | '));
  const cur = list.find((p) => p.current);
  const old = list.find((p) => !p.current);
  s.check('⑤ 当下那条就是新 plan', !!cur && cur.nodes.map((n) => n.id).join(',') === 'eval1', JSON.stringify(cur?.nodes?.map((n) => n.id)));
  s.check('⑥ 历史那条的节点齐（gen、train）', !!old && old.nodes.map((n) => n.id).sort().join(',') === 'gen,train', JSON.stringify(old?.nodes?.map((n) => n.id)));

  // ③ 最关键：依赖关系（after）必须还在，否则回看等于看一堆散点
  const train = (old?.nodes || []).find((n) => n.id === 'train');
  s.check('⑦ 历史里的 after 依赖没丢', JSON.stringify(train?.after) === '["gen"]', JSON.stringify(train?.after));

  // ④ 状态从账本取（不是一律 pending；具体 completed/suspect 由判定器决定，这里只验"取自账本"）
  const gen = (old?.nodes || []).find((n) => n.id === 'gen');
  s.check('⑧ 历史节点状态来自账本（不是 pending）', gen && gen.status !== 'pending', `status=${gen?.status} verdict=${gen?.verdict}`);

  // ⑤ 空壳 plan 不存档（快速单发自动补的那种，没有节点块）
  const before = (await plans()).filter((p) => !p.current).length;
  await sb.api('POST', `/api/plan?ws=${encodeURIComponent(ws)}`, { markdown: `# 任务线：空壳\nworkspace: ${ws}\n`, force: true });
  await sb.api('POST', `/api/run?ws=${encodeURIComponent(ws)}`, { command: 'node -e "console.log(4)"', cwd: ws });
  await waitFor(async () => (await plans()).length > 0, 20000);
  const after = (await plans()).filter((p) => !p.current).length;
  s.check('⑨ 空 plan 不留存档（不刷噪音）', after <= before + 1, `存档数 ${before} → ${after}`);
  // ⑥ 工作区列表排序：残留键（_orphaned/-mnt-/logs）必须排最后——
  //    页面在没有 ?ws= 时会落到列表第一项，2026-09-14 用户刷新后"明细只剩 2 个节点"就是落到了残留键上
  fs.mkdirSync(path.join(sb.home, '_orphaned-fake-20260101'), { recursive: true });
  fs.writeFileSync(path.join(sb.home, '_orphaned-fake-20260101', 'ledger.jsonl'), '');
  const wsList = (await sb.api('GET', '/api/workspaces')).json.workspaces || [];
  const last3 = wsList.slice(-3).map((w) => w.wsKey);
  s.check('⑩ 残留工作区排在最后（页面默认不会落到它）', !/^_orphaned/.test(wsList[0]?.wsKey || ''), JSON.stringify(wsList.slice(0, 2).map((w) => w.wsKey)));
  s.check('⑪ 每个工作区带 nodes/junk 字段（页面据此标注）', typeof wsList[0]?.nodes === 'number' && typeof wsList[0]?.junk === 'boolean', JSON.stringify(wsList[0]));
  s.check('⑫ 工作区条目带 workspace 路径（下拉栏显示路径而不是 plan 标题）', typeof wsList[0]?.workspace === 'string' && wsList[0].workspace.length > 0, String(wsList[0]?.workspace));
} finally {
  sb.stop();
}
s.done();
