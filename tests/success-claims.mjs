// tests/success-claims.mjs —— 判据解析与校验的单元测试（不启服务，纯函数）
import { suite } from './lib.mjs';
import { parseSuccessClaims, checkClaims } from '../success.mjs';

const s = suite('success-claims');
const norm = (c) => ({ k: c.keywords.map((x) => x.what), a: c.artifacts.map((x) => x.glob), c: c.conditions.map((x) => `${x.metric}${x.op}${x.value}`) });

// ── 解析 ────────────────────────────────────────────────────────────────
{
  const c = parseSuccessClaims('日志尾含"训练完成"且 5 分钟内有 .pt 产出');
  const n = norm(c);
  s.check('引号关键词 → keyword', n.k.includes('训练完成'), JSON.stringify(n));
  s.check('空主干 .pt → 通配 *.pt', n.a.includes('*.pt'), JSON.stringify(n.a));
}
{
  const c = norm(parseSuccessClaims('输出 data/param_abh_spectra.npz，val_loss < 1e-3'));
  s.check('带路径的产物 → 取文件名', c.a.includes('param_abh_spectra.npz'), JSON.stringify(c.a));
  s.check('指标阈值 → condition', c.c.includes('val_loss<0.001'), JSON.stringify(c.c));
}
{
  const c = norm(parseSuccessClaims("产出 out/result.csv 且日志含 'ALL_OK'"));
  s.check("单引号关键词", c.k.includes('ALL_OK'), JSON.stringify(c.k));
  s.check('csv 也认作产物', c.a.includes('result.csv'), JSON.stringify(c.a));
}
{
  const c = parseSuccessClaims('跑完就行');
  s.check('纯白话 → 无可校验条件（退回通用路径，零回归）', c.total === 0, `total=${c.total}`);
}
{
  const c = parseSuccessClaims('');
  s.check('空串 → 无条件', c.total === 0);
}
{
  const c = norm(parseSuccessClaims('训练完成且有 *.npz 产出'));
  s.check('无引号的关键词不当条件（避免误抓）', c.k.length === 0 && c.a.includes('*.npz'), JSON.stringify(c));
}

// ── 校验 ────────────────────────────────────────────────────────────────
const ctx = (o = {}) => ({ tail: o.tail || '', artifacts: o.artifacts || [], metrics: o.metrics || {}, startMs: o.startMs ?? 1000 });
{
  const c = parseSuccessClaims('日志尾含"MY_DONE"且产出 out.npz');
  const pass = checkClaims(c, ctx({ tail: 'blah my_done blah', artifacts: [{ name: 'out.npz', mtimeMs: 2000 }] }));
  s.check('关键词命中 + 窗口内有产物 → 通过', pass.ok && pass.checked.length === 2, JSON.stringify(pass.failures));
  const noKey = checkClaims(c, ctx({ tail: 'nope', artifacts: [{ name: 'out.npz', mtimeMs: 2000 }] }));
  s.check('关键词缺失 → 失败（并说明原因）', !noKey.ok && noKey.failures[0].why.includes('MY_DONE'), noKey.failures[0]?.why);
  const noArt = checkClaims(c, ctx({ tail: 'my_done', artifacts: [] }));
  s.check('产物缺失 → 失败（指出没找到）', !noArt.ok && noArt.failures[0].what.startsWith('产物:'), noArt.failures[0]?.why);
  const stale = checkClaims(c, ctx({ tail: 'my_done', artifacts: [{ name: 'out.npz', mtimeMs: 500 }] }));
  s.check('产物是旧的（非本次窗口）→ 失败且措辞区分', !stale.ok && /不是本次运行窗口/.test(stale.failures[0].why), stale.failures[0]?.why);
}
{
  const c = parseSuccessClaims('val_loss < 1');
  const ok = checkClaims(c, ctx({ metrics: { loss_last: 0.5 } }));
  s.check('指标满足 → 通过（val_loss 映射到 loss_last）', ok.ok && ok.checked[0].why.includes('loss_last=0.5'), JSON.stringify(ok));
  const bad = checkClaims(c, ctx({ metrics: { loss_last: 2.5 } }));
  s.check('指标不满足 → 失败', !bad.ok && /loss_last=2.5/.test(bad.failures[0].why), bad.failures[0]?.why);
  const none = checkClaims(c, ctx({ metrics: {} }));
  s.check('指标提不到 → 记「未核实」而不是判失败（宁可漏判不误杀）', none.ok && none.unchecked.length === 1, JSON.stringify(none.unchecked));
}
{
  const c = parseSuccessClaims('产出 *.pt');
  const multi = checkClaims(c, ctx({ artifacts: [{ name: 'a.txt', mtimeMs: 3000 }, { name: 'b.pt', mtimeMs: 3000 }] }));
  s.check('通配匹配多个文件里的任一个', multi.ok, JSON.stringify(multi));
  // 回归：glob 必须带扩展名匹配（曾把 *.pt 写成"匹配一切"，a.txt 也能过）
  const wrong = checkClaims(c, ctx({ artifacts: [{ name: 'a.txt', mtimeMs: 3000 }] }));
  s.check('通配不会跨扩展名误匹配（a.txt ≠ *.pt）', !wrong.ok, JSON.stringify(wrong.failures));
  const named = checkClaims(parseSuccessClaims('产出 out.npz'), ctx({ artifacts: [{ name: 'other_out.npz', mtimeMs: 3000 }] }));
  s.check('精确文件名不靠后缀模糊匹配', !named.ok, JSON.stringify(named.failures));
}

s.done();
