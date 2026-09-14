// tests/dashboard-selfcheck.mjs —— 控制台页面的静态体检
//
// 为什么要有：这页出过两次"看着像坏了"的故障，根因都不是后端——
//   ① 合并面板时把某个元素删了，脚本里还有 `$('#x').textContent = …` ⇒ 顶层抛错，**整页白**；
//   ② 门禁区块留下了两份 id="gate"/"gateBody" ⇒ render 写进隐藏的那份，可见的永远是"加载中…"。
// 这三类（语法错、引用不存在的元素、重复 id）都能在 1 秒内静态查出来，不必等用户刷新。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { suite, ROOT } from './lib.mjs';

const s = suite('dashboard-selfcheck');
const file = path.join(ROOT, 'dashboard-v2.html');
s.check('① 页面文件存在', fs.existsSync(file), file);
const html = fs.readFileSync(file, 'utf8');

const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
const dup = [...new Set(ids.filter((x, i) => ids.indexOf(x) !== i))];
s.check('② 没有重复 id（重复会让渲染写进错误的那份）', dup.length === 0, dup.join(', '));

const idSet = new Set(ids);
// 两种引号都要认：页里有 $("#runList") 这种双引号写法（只认单引号会漏检）
const refs = [...new Set([...html.matchAll(/\$\('#([^']+)'\)|\$\("#([^"]+)"\)/g)].map((m) => m[1] || m[2]))];
const missing = refs.filter((r) => !idSet.has(r));
s.check('③ 每个 id 引用都指向存在的元素（不存在会在顶层抛错→整页白）', missing.length === 0, missing.join(', '));

// 脚本语法（用 vm.Script 解析，不执行）
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
s.check('④ 页内有脚本块', scripts.length > 0, `${scripts.length} 块`);
let synErr = '';
try { new vm.Script(scripts.join('\n;\n')); } catch (e) { synErr = String(e.message); }
s.check('⑤ 脚本语法能被解析', !synErr, synErr);

// 关键节点：这几块是页面骨架，删掉任何一个都等于坏功能（有测试盯着，改名时会立刻发现）
const KEY = ['rmCanvas', 'rmWhy', 'rmCount', 'gateBody', 'gateState', 'runList'];
const gone = KEY.filter((k) => !idSet.has(k));
s.check('⑥ 关键区块都在（画布/说明/门禁/追踪/在跑）', gone.length === 0, gone.join(', '));

s.done();
