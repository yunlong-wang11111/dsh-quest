// lib/lit.mjs —— quest_lit 的三源文献检索（2026-09-17）
// 目的：文献调研"一次 API 调用"替代几十轮 web_search/web_fetch 手爬（那是调研子代理贵的原因）。
// 三源统一输出：{ source, title, year, authors, venue, id, cited_by?, abstract }，abstract 截 700 字符。
// arxiv：预印本，Atom XML，无限制。
// crossref：SCI 主力（Elsevier/Springer/Wiley/IEEE/MDPI…的 DOI 元数据），JSON，免 key。
// openalex：全覆盖兜底（含引用数），JSON，abstract 是倒排索引要重建。

const ABSTRACT_MAX = 700;
const UA = 'dsh-quest-lit/0.1 (https://local; research tooling)';

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const clip = (s, n = ABSTRACT_MAX) => (s.length > n ? s.slice(0, n) + '…' : s);

/** arxiv Atom XML → 统一条目 */
export function parseArxiv(xml) {
  const out = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const title = clean((e.match(/<title>([\s\S]*?)<\/title>/) || [])[1]);
    if (!title) continue;
    const summary = clean((e.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1]);
    const pub = (e.match(/<published>(\d{4})/) || [])[1] || '';
    const names = [...e.matchAll(/<name>([^<]+)<\/name>/g)].map((x) => x[1]);
    const link = clean((e.match(/<id>([^<]+)<\/id>/) || [])[1]);
    out.push({
      source: 'arxiv', title, year: pub ? Number(pub) : null,
      authors: names.length > 3 ? `${names[0]} et al.` : names.join(', '),
      venue: 'arXiv', id: link, abstract: clip(summary),
    });
  }
  return out;
}

/** crossref works API JSON → 统一条目（abstract 是 JATS XML，去标签） */
export function parseCrossref(json) {
  const items = json?.message?.items ?? [];
  return items.map((it) => {
    const title = clean((it.title || [])[0]);
    const a0 = (it.author || [])[0] || {};
    const year = it.issued?.['date-parts']?.[0]?.[0] ?? it.created?.['date-parts']?.[0]?.[0] ?? null;
    return {
      source: 'crossref', title: title || '(untitled)', year: year ?? null,
      authors: (it.author || []).length > 3 ? `${a0.family || a0.name || ''} et al.` : (it.author || []).map((x) => x.family || x.name || '').join(', '),
      venue: clean((it['container-title'] || [])[0]),
      id: it.DOI ? `doi:${it.DOI}` : '',
      abstract: it.abstract ? clip(clean(it.abstract.replace(/<[^>]+>/g, ' '))) : '',
    };
  }).filter((x) => x.title !== '(untitled)');
}

/** openalex abstract_inverted_index → 正常文本 */
export function invertAbstract(inv) {
  if (!inv) return '';
  const pos = [];
  for (const [word, idxs] of Object.entries(inv)) for (const i of idxs) pos[i] = word;
  return clean(pos.join(' '));
}

/** openalex works API JSON → 统一条目 */
export function parseOpenalex(json) {
  return (json?.results ?? []).map((w) => ({
    source: 'openalex', title: clean(w.display_name), year: w.publication_year ?? null,
    authors: (w.authorships || []).length > 3 ? `${w.authorships?.[0]?.author?.display_name || ''} et al.` : (w.authorships || []).map((x) => x.author?.display_name || '').join(', '),
    venue: clean(w.primary_location?.source?.display_name),
    id: w.doi || w.id || '',
    cited_by: w.cited_by_count ?? null,
    abstract: clip(invertAbstract(w.abstract_inverted_index)),
  })).filter((x) => x.title);
}

/** 三源检索。query 必填；source: arxiv|crossref|openalex；limit ≤25。出错抛 Error（带源名）。 */
export async function litSearch({ query, source = 'arxiv', limit = 10 }) {
  const q = String(query || '').trim();
  if (!q) throw new Error('query 为空');
  const n = Math.max(1, Math.min(25, Number(limit) || 10));
  const opt = { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(12000) };
  if (source === 'arxiv') {
    const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(q)}&start=0&max_results=${n}&sortBy=relevance`;
    const r = await fetch(url, opt);
    if (!r.ok) throw new Error(`arxiv HTTP ${r.status}`);
    return parseArxiv(await r.text());
  }
  if (source === 'crossref') {
    const url = `https://api.crossref.org/works?query=${encodeURIComponent(q)}&rows=${n}&select=DOI,title,author,container-title,issued,abstract`;
    const r = await fetch(url, opt);
    if (!r.ok) throw new Error(`crossref HTTP ${r.status}`);
    return parseCrossref(await r.json());
  }
  if (source === 'openalex') {
    const url = `https://api.openalex.org/works?search=${encodeURIComponent(q)}&per-page=${n}&select=display_name,publication_year,doi,authorships,cited_by_count,primary_location,abstract_inverted_index`;
    const r = await fetch(url, opt);
    if (!r.ok) throw new Error(`openalex HTTP ${r.status}`);
    return parseOpenalex(await r.json());
  }
  throw new Error(`未知 source: ${source}（支持 arxiv / crossref / openalex）`);
}
