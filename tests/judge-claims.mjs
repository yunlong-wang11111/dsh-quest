// tests/judge-claims.mjs —— 端到端：plan/quest_run 里声明的 success 判据是否真的驱动判定
//
// 用 node 脚本当被测命令（node 在白名单解释器里、且不依赖机器上的 python 路径），
// 全程跑在自己的沙箱里（runGate 关闭，避免测试被门禁挂起）。
import fs from 'node:fs';
import path from 'node:path';
import { startSandbox, waitFor, suite } from './lib.mjs';

const PORT = 3122;
const s = suite('judge-claims');
const sb = await startSandbox({ name: 'judge-claims', port: PORT, extraConfig: { runGate: { enabled: false } } });
const WS = sb.ws.ws;
const write = (name, code) => { fs.writeFileSync(path.join(WS, name), code, 'utf8'); return `node ${name}`; };
const TERMINAL = ['completed', 'failed', 'timeout', 'cancelled', 'frozen', 'skipped'];

async function runCase(title, command, success) {
  const r = await sb.api('POST', `/api/run?ws=${encodeURIComponent(WS)}`, {
    command, cwd: WS, title, success, expect_minutes: 1,
  });
  if (r.json.ok !== true) return { error: r.json.error || JSON.stringify(r.json) };
  const id = r.json.nodeId;
  const ok = await waitFor(async () => {
    const n = (await sb.status(WS)).find((x) => x.id === id);
    return n && TERMINAL.includes(n.status);
  }, 30000, 400);
  const n = (await sb.status(WS)).find((x) => x.id === id);
  return { id, ok, status: n?.status, verdict: n?.verdict, via: n?.via, detail: n?.judgeDetail };
}

try {
  // ① 声明两项且都满足 → ok / success-declared
  {
    const cmd = write('c1.js', "console.log('MY_DONE'); require('fs').writeFileSync('out1.npz','x');\n");
    const r = await runCase('jc-1', cmd, '日志含"MY_DONE"且产出 out1.npz');
    s.check('① 判据全满足 → ok/success-declared', r.status === 'completed' && r.verdict === 'ok' && String(r.via).startsWith('success-declared'), `status=${r.status} via=${r.via}`);
  }
  // ② 关键词满足但没产物 → suspect（假 ok 的典型）
  {
    const cmd = write('c2.js', "console.log('MY_DONE');\n");
    const r = await runCase('jc-2', cmd, '日志含"MY_DONE"且产出 out2.npz');
    s.check('② 缺产物 → suspect/success-claim-failed', r.verdict === 'suspect' && r.via === 'success-claim-failed', `verdict=${r.verdict} via=${r.via} detail=${String(r.detail || '').slice(0, 40)}`);
    s.check('② 原因写清了缺什么', /out2\.npz/.test(String(r.detail || '')), String(r.detail || '').slice(0, 60));
  }
  // ③ 有产物但没关键词 → suspect
  {
    const cmd = write('c3.js', "require('fs').writeFileSync('out3.npz','x');\n");
    const r = await runCase('jc-3', cmd, '日志含"DONE_MARK"且产出 out3.npz');
    s.check('③ 缺关键词 → suspect', r.verdict === 'suspect' && r.via === 'success-claim-failed', `via=${r.via}`);
  }
  // ④ 纯白话判据（无可校验条件）→ 退回通用路径（"done!" 命中内置关键词表）
  {
    const cmd = write('c4.js', "console.log('done!');\n");
    const r = await runCase('jc-4', cmd, '跑完就行');
    s.check('④ 无可校验判据 → 通用路径不变（零回归）', r.verdict === 'ok' && r.via === 'finish-keyword', `verdict=${r.verdict} via=${r.via}`);
  }
  // ⑤ 指标阈值满足 → ok
  {
    const cmd = write('c5.js', "console.log('loss: 2.5');\n");
    const r = await runCase('jc-5', cmd, 'val_loss < 5');
    s.check('⑤ 指标满足 → ok', r.verdict === 'ok' && String(r.via).startsWith('success-declared'), `via=${r.via}`);
  }
  // ⑥ 指标阈值不满足 → suspect（"跑完了但没达标"这种最有价值的判定）
  {
    const cmd = write('c6.js', "console.log('loss: 2.5');\n");
    const r = await runCase('jc-6', cmd, 'val_loss < 1');
    s.check('⑥ 指标不满足 → suspect 并说明实际值', r.verdict === 'suspect' && /2\.5/.test(String(r.detail || '')), `detail=${String(r.detail || '').slice(0, 60)}`);
  }
  // ⑦ 账本留痕（含 detail）
  {
    const { ledgerOf } = await import('./lib.mjs');
    const led = ledgerOf(sb.home, WS);
    const judged = led.filter((e) => e.t === 'node.judged');
    s.check('⑦ 判定结果与原因落账本', judged.length >= 6 && judged.some((e) => e.detail), `node.judged=${judged.length}`);
  }
} finally {
  sb.stop();
}
s.done();
