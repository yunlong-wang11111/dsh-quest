// tests/exp-registry.mjs —— 实验登记簿（#1）+ 环境指纹（#2）
//
// 设计契约：机器记骨架（命令/车道/环境指纹/判定，终态自动落账），agent 补灵魂
// （假设/metrics/结论，quest_exp_log 以 note 追加）。文件 append-only 永不改写。
import fs from 'node:fs';
import path from 'node:path';
import { startSandbox, suite, sleep } from './lib.mjs';

const PORT = 3127;
const s = suite('exp-registry');
const sb = await startSandbox({ name: 'exp-registry', port: PORT });
const WS = sb.ws.ws;
const run = (body) => sb.api('POST', `/api/run?ws=${encodeURIComponent(WS)}`, body);

try {
  // ① 派发一个真实跑完的节点 → 终态自动登记骨架（含环境指纹）
  fs.writeFileSync(path.join(WS, 'ok.js'), 'console.log("exp-ok");\n');
  const r = await run({ command: 'node ok.js', cwd: WS, title: 'exp-demo', expect_minutes: 1, success: ['日志尾含 "exp-ok"'] });
  s.check('① 派发成功', r.json.ok === true && !!r.json.nodeId, `nodeId=${r.json.nodeId}`);
  const nodeId = r.json.nodeId;

  let done = false;
  for (let i = 0; i < 100 && !done; i++) {
    await sleep(300);
    const nodes = await sb.status(WS);
    done = nodes.some((n) => n.id === nodeId && ['completed', 'failed'].includes(n.status));
  }
  s.check('① 节点跑完', done, nodeId);
  await sleep(800); // 登记是 fire-and-forget，留一点落盘时间

  // 沙箱不暴露 wsKey：按 experiments.jsonl 特征发现工作区目录（沙箱只有一个 ws）
  const wsDir = fs.readdirSync(sb.home).map((d) => path.join(sb.home, d)).find((p) => fs.existsSync(path.join(p, 'experiments.jsonl')));
  s.check('② experiments.jsonl 已生成', !!wsDir, wsDir ? path.basename(wsDir) : '没找到');
  const expFile = wsDir ? path.join(wsDir, 'experiments.jsonl') : '';
  let raw = '';
  try { raw = fs.readFileSync(expFile, 'utf8'); } catch {}
  const records = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const auto = records.filter((x) => x.kind === 'auto');
  s.check('② 自动骨架已落账', auto.length === 1, `auto=${auto.length}`);
  const a0 = auto[0] || {};
  s.check('② 骨架含命令/车道/判定', a0.command === 'node ok.js' && (a0.shell || 'windows') && a0.verdict === 'ok', `${a0.command} | ${a0.verdict}`);
  s.check('② 环境指纹含 node 版本', /node/i.test(a0.env?.interpreter || '') && /^v?\d/.test(a0.env?.version || ''), JSON.stringify(a0.env));

  // ③ agent 补记：假设/metrics/结论挂到节点骨架上
  const log = await sb.api('POST', `/api/exp/log?ws=${encodeURIComponent(WS)}`, {
    node: nodeId,
    hypothesis: '跑通即验证登记簿链路',
    metrics: { acc: 0.91, val_loss: 0.123 },
    conclusion: '链路通，登记簿可用',
    direction: 'infra-test',
    dispatchedBy: 'session-test',
  });
  s.check('③ exp_log 挂节点成功', log.json.ok === true && !!log.json.exp, JSON.stringify(log.json).slice(0, 80));

  // ④ append-only：原始 auto 行仍在（没被改写/覆盖）
  const raw2 = fs.readFileSync(expFile, 'utf8');
  s.check('④ append-only（auto 原行仍在）', raw2.split('\n').some((l) => l.includes('"kind":"auto"') && l.includes('node ok.js')), 'auto 行被改写了？');

  // ⑤ 查询：折叠视图 + 过滤 + 指标可见
  const q = await sb.api('GET', `/api/exp/query?ws=${encodeURIComponent(WS)}&q=登记簿&direction=infra-test`);
  const hit = (q.json.experiments || [])[0];
  s.check('⑤ 查询命中且折叠完整', q.json.ok && q.json.total === 1 && hit?.hypothesis?.includes('登记簿') && hit?.metrics?.acc === 0.91 && hit?.conclusion?.includes('可用'), JSON.stringify(q.json).slice(0, 120));
  s.check('⑤ 折叠保留骨架字段', hit?.command === 'node ok.js' && hit?.verdict === 'ok' && hit?.env?.version, '骨架字段丢了');

  // ⑥ 独立实验（无节点）+ 参数校验
  const bad = await sb.api('POST', `/api/exp/log?ws=${encodeURIComponent(WS)}`, {});
  s.check('⑥ 空登记被拒并给用法', bad.json.ok === false && /假设/.test(bad.json.error || ''), String(bad.json.error || '').slice(0, 50));
  const manual = await sb.api('POST', `/api/exp/log?ws=${encodeURIComponent(WS)}`, { title: '纯手记实验', conclusion: '无节点的登记也行', direction: 'infra-test' });
  const q2 = await sb.api('GET', `/api/exp/query?ws=${encodeURIComponent(WS)}&direction=infra-test&limit=5`);
  s.check('⑥ 独立条目可查', manual.json.ok && (q2.json.total || 0) >= 2, `total=${q2.json.total}`);

  // ⑦ 指向不存在节点的挂载要明确报错（不能静默丢）
  const miss = await sb.api('POST', `/api/exp/log?ws=${encodeURIComponent(WS)}`, { node: 'ghost-node', conclusion: 'x' });
  s.check('⑦ 幽灵节点挂载被拒', miss.json.ok === false && /ghost-node/.test(miss.json.error || ''), String(miss.json.error || '').slice(0, 60));

  // ⑧ 登记簿异常不影响主流程：账本照常、节点判定照常（本次跑通即为证）
  const ledgerEvents = (() => { try { return fs.readFileSync(path.join(wsDir, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } })();
  s.check('⑧ 账本不受影响', ledgerEvents.some((e) => e.t === 'quick.dispatched'), `events=${ledgerEvents.length}`);
} finally {
  sb.stop();
}
s.done();
