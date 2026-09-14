// tests/phantom-node.mjs —— 幽灵节点：谁有资格"新建"一个节点
//
// 背景（2026-09-14 实测）：一句 `/q取消 mu0m8nck`（短后缀 id，写进了 cancel.fallback 事件）
// 在账本里留下"只有事件、没有派发"的条目。两个消费者都按"见到 node 就建节点"处理 ⇒
//   · line.active 从真实 1 个虚报成 3 个 ⇒ **收敛信号永不触发**
//   · 重启门禁常关（幽灵永不终结）⇒ 修复永远装不上
//   · when-idle 显示"已跑 29000000 分钟"（起点取到 epoch 0）
// 不变量：只有 node.dispatched / quick.dispatched 能新建节点；其它事件只能更新已有节点。
// （重启门禁重启工具本来就有这条规则，所以这次只有 when-idle 与服务端要修。）
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startSandbox, suite, waitFor, ROOT } from './lib.mjs';

const PORT = 3194;
const s = suite('phantom-node');
const sb = await startSandbox({ name: 'phantom-node', port: PORT, wsDirs: ['ws'] });
const ws = sb.ws.ws;
const statusOf = async () => (await sb.api('GET', `/api/status?ws=${encodeURIComponent(ws)}`)).json;

const ledgerPath = () => {
  for (const d of fs.readdirSync(sb.home)) {
    const f = path.join(sb.home, d, 'ledger.jsonl');
    if (fs.existsSync(f)) return f;
  }
  return null;
};

try {
  // 先真的派一个能秒完的快速单发：给账本一个"名副其实"的节点
  const r = await sb.api('POST', `/api/run?ws=${encodeURIComponent(ws)}`, { command: 'node -e "console.log(1)"', cwd: ws });
  s.check('① 派发成功', r.json?.ok !== false, JSON.stringify(r.json).slice(0, 100));
  const settled = await waitFor(async () => {
    const ns = (await statusOf()).plan?.nodes || [];
    return ns.length >= 1 && ns.every((n) => n.status !== 'running');
  }, 60000);
  s.check('② 快速单发跑完', settled);
  const lf = ledgerPath();
  s.check('③ 账本已建立', !!lf, String(lf));
  const base = await statusOf();
  s.check('④ 基线：没有在跑的节点（line.active=0）', base.line?.active === 0, `active=${base.line?.active}`);

  // 注入幽灵：短后缀 cancel.fallback + 未知 id 的判定事件，都没有派发记录
  const now = new Date().toISOString();
  fs.appendFileSync(lf, [
    JSON.stringify({ t: 'cancel.fallback', node: 'mu0m8nck', pid: 12345, at: now }),
    JSON.stringify({ t: 'node.judged', node: 'ghost-未知节点', verdict: 'ok', at: now }),
    JSON.stringify({ t: 'node.failed', node: 'ghost-未知节点', at: now }),
  ].join('\n') + '\n');

  const after = await statusOf();
  s.check('⑤ 幽灵不被当成在跑（回归：修复前 active=2）', after.line?.active === 0, `active=${after.line?.active}`);
  s.check('⑥ 幽灵不出现在明细里', !(after.plan?.nodes || []).some((n) => String(n.id).includes('mu0m8nck') || String(n.id).includes('ghost')),
    (after.plan?.nodes || []).map((n) => n.id).join(','));
  s.check('⑦ counts 里没有凭空多出的 pending', (after.line?.counts?.pending ?? 0) === 0, JSON.stringify(after.line?.counts));

  // 人读的那个工具（when-idle）也要一致
  const out = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'when-idle.mjs')], {
    encoding: 'utf8', timeout: 60000,
    env: { ...process.env, QUEST_HOME: sb.home, QUIET_MINUTES: '0' },
  });
  s.check('⑧ when-idle 报"在跑 0 个"', /在跑 0 个/.test(out), (out.match(/节点 \d+ 个｜在跑 \d+ 个.*/) || ['(没匹配到)'])[0]);
  s.check('⑨ when-idle 不显示幽灵名', !out.includes('mu0m8nck'), (out.match(/在跑：[^\n]*/) || ['(无在跑行)'])[0]);
  s.check('⑩ 幽灵也不会让 when-idle 说"仍在进行"', !/仍在进行/.test(out), /仍在进行/.test(out) ? '误报仍在进行' : '已静默');
} finally {
  sb.stop();
}
s.done();
