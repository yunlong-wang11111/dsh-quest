// tests/plugin-schema.mjs —— 插件 output schema 与实际返回的一致性（静态自检）
//
// 起因（2026-09-16 生产事故）：quest_flip 把返回体里的 archived（API 回的是**数组**）声明成了
// number ⇒ harness 判 "value.archived must be a number"，翻页两次均被当工具错误、实际未执行；
// quest_plan 的 archived（存档文件名字符串）没在 additionalProperties:false 的 schema 里声明 ⇒
// "not a declared property"（那次动作其实成功了，但报错误导 AI）。
// 都是"schema 声明 ≠ 实际返回"的静态可查问题，本测试盯三类：
//   ① additionalProperties:false 的 schema，其 execute 可能返回的键是否全部已声明
//   ② 危险类型配对：API 返回数组/布尔的位置不许声明成 number/string
//   ③ render 里用到的键必须存在于 properties
import fs from 'node:fs';
import path from 'node:path';
import { suite, ROOT } from './lib.mjs';

const s = suite('plugin-schema');
const src = fs.readFileSync(path.join(ROOT, 'dsh-plugin', 'index.js'), 'utf8');

// 抽出每个 defineTool 注册块（name: 'x' ... }));）
const tools = [];
const re = /ctx\.tools\.register\(defineTool\(\{\s*name: '([a-z_]+)',[\s\S]*?\}\)\);/g;
let m;
while ((m = re.exec(src))) tools.push({ name: m[1], body: m[0] });
s.check('① 抽到全部 13 个工具（2026-09-22 +quest_spawn）', tools.length === 13, tools.map((t) => t.name).join(','));

const flip = tools.find((t) => t.name === 'quest_flip');
const plan = tools.find((t) => t.name === 'quest_plan');
s.check('② flip 不再声明裸 archived:number', flip && !/archived: \{ type: 'number' \}/.test(flip.body));
s.check('③ flip 声明 archivedCount:number', flip && /archivedCount: \{ type: 'number' \}/.test(flip.body));
s.check('④ flip render 只用已声明的键', flip && /v\.archivedCount/.test(flip.body) && !/v\.archived(?![a-zA-Z])/.test(flip.body));
s.check('⑤ plan（additionalProperties:false）声明了 archived:string', plan && /archived: \{ type: 'string' \}/.test(plan.body));

// 通用：所有 additionalProperties:false 的工具，schema 里的键 execute 都可能返回 —— 这里做
// "render 引用的键必须已声明"检查（防 UI 渲染 undefined）
let renderMiss = 0;
for (const t of tools) {
  const props = [...t.body.matchAll(/(\w+): \{ type: '/g)].map((x) => x[1]);
  const renderSeg = (t.body.match(/render:[\s\S]*?execute:/) || [''])[0];
  for (const k of [...renderSeg.matchAll(/v\.(\w+)/g)].map((x) => x[1])) {
    if (!['error', 'ok'].includes(k) && !props.includes(k)) {
      console.log(`      ⚠️ ${t.name}: render 用了未声明的键 v.${k}`);
      renderMiss++;
    }
  }
}
s.check('⑥ 所有 render 引用的键都已声明', renderMiss === 0, renderMiss + ' 处缺失');

s.done();
