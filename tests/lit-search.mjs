// tests/lit-search.mjs —— quest_lit 三源解析器单元测试（离线 fixture）+ 可选 --live 冒烟
import { parseArxiv, parseCrossref, parseOpenalex, invertAbstract } from '../lib/lit.mjs';
import { suite } from './lib.mjs';

const s = suite('lit-search');

// ── arxiv Atom XML fixture ──
const arxivXml = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<entry>
  <id>http://arxiv.org/abs/2209.10122v1</id>
  <published>2022-09-21T00:00:00Z</published>
  <title>GelSight  tactile
   sensor  benchmark</title>
  <summary> We  propose  a  benchmark  for  vision-based  tactile  sensors.  ${'x'.repeat(900)}</summary>
  <author><name>Alice Zhang</name></author>
  <author><name>Bob Li</name></author>
</entry>
<entry>
  <id>http://arxiv.org/abs/2410.02048v2</id>
  <published>2024-10-03T00:00:00Z</published>
  <title>Feel force from sparse strain</title>
  <summary>Reconstruct contact force fields.</summary>
  <author><name>Carol Wu</name></author>
  <author><name>Dave Chen</name></author>
  <author><name>Eve Sun</name></author>
  <author><name>Frank Zhao</name></author>
  <author><name>Grace Qian</name></author>
</entry>
</feed>`;
{
  const r = parseArxiv(arxivXml);
  s.check('① arxiv：2 条', r.length === 2, JSON.stringify(r.length));
  s.check('② arxiv：标题压空白', r[0].title === 'GelSight tactile sensor benchmark', r[0].title);
  s.check('③ arxiv：年份/venue/id', r[1].year === 2024 && r[1].venue === 'arXiv' && /2410\.02048/.test(r[1].id), JSON.stringify(r[1]));
  s.check('④ arxiv：>3 作者折叠 et al.', r[1].authors === 'Carol Wu et al.', r[1].authors);
  s.check('⑤ arxiv：≤2 作者不折叠', r[0].authors === 'Alice Zhang, Bob Li', r[0].authors);
  s.check('⑥ arxiv：abstract 截 700 + 省略号', r[0].abstract.length === 701 && r[0].abstract.endsWith('…'), String(r[0].abstract.length));
}

// ── crossref fixture ──
const crJson = { message: { items: [
  { DOI: '10.1109/lsen.2023.10012440', title: ['Soft fingertip force estimation'],
    author: [{ family: 'Tan', given: 'H' }, { family: 'Ueda', given: 'J' }],
    'container-title': ['IEEE Sensors Letters'], issued: { 'date-parts': [[2023, 5]] },
    abstract: '<p>We estimate <italic>contact force</italic> from sparse sensors.</p>' },
  { DOI: '10.1111/xxx', title: [], author: [] },   // 无标题 → 过滤
] } };
{
  const r = parseCrossref(crJson);
  s.check('⑦ crossref：无标题条目被过滤', r.length === 1, JSON.stringify(r.length));
  s.check('⑧ crossref：字段齐（年/venue/doi/JATS去标签）', r[0].year === 2023 && r[0].venue === 'IEEE Sensors Letters' && r[0].id === 'doi:10.1109/lsen.2023.10012440' && !/[<>]/.test(r[0].abstract) && /contact force/.test(r[0].abstract), JSON.stringify(r[0]).slice(0, 120));
}

// ── openalex 倒排索引重建 ──
{
  const inv = { 'we': [0], 'reconstruct': [1], 'force': [3], 'fields': [4], 'from': [5], 'sparse': [6], 'strain.': [7], 'a': [2] };
  const txt = invertAbstract(inv);
  s.check('⑨ openalex：倒排索引重建顺序正确', txt === 'we reconstruct a force fields from sparse strain.', txt);
  const r = parseOpenalex({ results: [{ display_name: 'Tacile force from strain', publication_year: 2025,
    authorships: [{ author: { display_name: 'H Tan' } }, { author: { display_name: 'J Ueda' } }],
    primary_location: { source: { display_name: 'Sensors' } }, doi: 'https://doi.org/10.3390/x',
    cited_by_count: 12, abstract_inverted_index: inv }] });
  s.check('⑩ openalex：引用数与 venue', r[0].cited_by === 12 && r[0].venue === 'Sensors' && r[0].year === 2025, JSON.stringify(r[0]).slice(0, 120));
}

// ── 可选 live 冒烟（node tests/lit-search.mjs --live）──
if (process.argv.includes('--live')) {
  const { litSearch } = await import('../lib/lit.mjs');
  for (const src of ['arxiv', 'crossref', 'openalex']) {
    try {
      const items = await litSearch({ query: 'tactile sensor contact force estimation', source: src, limit: 3 });
      s.check(`⑪ live ${src}：命中且首条有标题`, items.length > 0 && !!items[0].title, `${items.length} 条，首条: ${items[0]?.title?.slice(0, 60)}`);
    } catch (e) {
      s.check(`⑪ live ${src}`, false, e.message);
    }
  }
}

s.done();
