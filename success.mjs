// success.mjs —— 把 plan 里 `success:` 的白话判据解析成可机器校验的条件（零 token、纯正则）
//
// 背景：PLAN-TEMPLATE 一直要求 AI 写「成功判据」（如 `日志尾含"训练完成"且 5 分钟内有 .pt 产出`），
// 但 2026-09-13 之前判定器根本不读它 —— 字段只是被解析进 node.success 就没人用，成了装饰品。
// 现在它压过通用关键词表：AI 写下的是硬约定，声明了就按它判。
//
// 能识别的三类（都能在不调用模型的前提下确定性校验）：
//   1. 引号/反引号里的关键短语  → 必须出现在日志尾（不区分大小写）
//   2. 文件名或通配（out.npz / *.npz / .pt）→ 必须落在运行窗口内有新鲜产物
//   3. 指标阈值（val_loss < 1e-3）→ 从日志尾提取的指标必须满足；提不到则记「未核实」而不是判失败
//
// 设计原则：**宁可报"未核实"，也不要凭猜判失败**。判定器的假阳/假阴都会浪费一整晚的算力
// （我们的冻结策略会让"疑似"停下游），所以只有"读到了明确证据且不满足"才算失败。

/** 视为"产物"的扩展名（与 server.mjs 的扫描一致）。 */
export const CLAIM_EXTS = ['pt', 'pth', 'ckpt', 'npz', 'npy', 'h5', 'bin', 'json', 'csv', 'log', 'txt', 'md', 'out', 'png', 'jpg', 'jpeg'];

const QUOTE_CHARS = '"\'`\u201c\u201d\u2018\u2019';
const QUOTE_RE = new RegExp(`[${QUOTE_CHARS}]([^${QUOTE_CHARS}]{1,60})[${QUOTE_CHARS}]`, 'g');
const CMP_RE = /([A-Za-z_][\w.]{0,30})\s*(<=|>=|<|>)\s*(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/g;

/** 该 token 是否像一个文件/通配（支持空主干的 `.pt`，等价 `*.pt`；也支持 data/xxx.npz 这类带路径写法）。 */
function asArtifact(token) {
  const raw = token.trim().replace(/^[-*]+/, (m) => (m.includes('*') ? '*' : ''));
  const base = raw.split(/[\\/]/).pop() || raw;          // 只看文件名部分
  const m = base.match(/^(\*?[\w.\u4e00-\u9fa5-]*)\.([A-Za-z0-9]{1,6})$/);
  if (!m) return null;
  const ext = m[2].toLowerCase();
  if (!CLAIM_EXTS.includes(ext)) return null;
  const stem = m[1] || '*';
  return { kind: 'artifact', what: raw, glob: `${stem}.${ext}` };
}

/**
 * 解析 success 文本 → { keywords, artifacts, conditions, total }
 * 解析不出任何条件时 total = 0，判定器就退回原来的通用路径（零回归）。
 */
export function parseSuccessClaims(text) {
  const src = String(text || '');
  const claims = { keywords: [], artifacts: [], conditions: [], total: 0 };
  if (!src.trim()) return claims;

  // 1) 引号/反引号里的短语（太长的不当关键词，像句子）
  for (const m of src.matchAll(QUOTE_RE)) {
    const t = m[1].trim();
    if (!t || t.length > 40) continue;
    const art = asArtifact(t);
    if (art) claims.artifacts.push(art);
    else claims.keywords.push({ kind: 'keyword', what: t, text: t });
  }

  // 2) 无引号的文件名/通配（`.pt 产出`、`输出 data/xxx.npz`、`*.csv`）
  //    跳过已由引号处理过的部分，避免重复
  for (const raw of src.split(/[\s,，、;；:：()（）\[\]【】]+/)) {
    if (!raw) continue;
    const art = asArtifact(raw);
    if (art && !claims.artifacts.some((a) => a.glob === art.glob)) claims.artifacts.push(art);
  }

  // 3) 指标阈值
  for (const m of src.matchAll(CMP_RE)) {
    const [, metric, op, val] = m;
    claims.conditions.push({ kind: 'metric', what: `${metric}${op}${val}`, metric, op, value: Number(val) });
  }

  claims.total = claims.keywords.length + claims.artifacts.length + claims.conditions.length;
  return claims;
}

/** 指标名映射到 extractMetrics 的键：val_loss / train_loss → loss_last。 */
function lookupMetric(metrics, name) {
  const stripped = String(name).replace(/^(val|train|test|eval)_/i, '').toLowerCase();
  for (const key of [`${stripped}_last`, `${stripped}_min`, stripped]) {
    if (metrics && typeof metrics[key] === 'number') return { key, value: metrics[key] };
  }
  return null;
}

function cmp(value, op, threshold) {
  if (op === '<') return value < threshold;
  if (op === '<=') return value <= threshold;
  if (op === '>') return value > threshold;
  return value >= threshold;
}

const escRe = (s) => String(s).replace(/[.+?^${}()|[\]\\]/g, '\\$&');
/** glob（*.pt / out.npz）→ 匹配文件名的正则。注意必须带上扩展名匹配，否则 *.pt 会匹配一切。 */
const globToRe = (g) => new RegExp('^' + String(g).toLowerCase().split('*').map(escRe).join('.*') + '$');

/**
 * 校验判据。
 * @param {{keywords:any[],artifacts:any[],conditions:any[]}} claims parseSuccessClaims 的输出
 * @param {{tail:string, artifacts:{name:string,mtimeMs:number}[], metrics:object, startMs:number}} ctx
 * @returns {{ok:boolean, failures:any[], checked:any[], unchecked:any[]}}
 */
export function checkClaims(claims, ctx) {
  const failures = [];
  const checked = [];
  const unchecked = [];
  const tail = String(ctx.tail || '').toLowerCase();
  const arts = Array.isArray(ctx.artifacts) ? ctx.artifacts : [];

  for (const k of claims.keywords) {
    const hit = tail.includes(k.text.toLowerCase());
    if (hit) checked.push({ what: k.what, why: '日志尾命中' });
    else failures.push({ what: `关键词:${k.what}`, why: `日志尾没有出现「${k.what}」` });
  }

  for (const a of claims.artifacts) {
    const rx = globToRe(a.glob);
    const hit = arts.find((f) => rx.test(String(f.name || '').toLowerCase()) && Number(f.mtimeMs || 0) > ctx.startMs);
    if (hit) checked.push({ what: a.what, why: `运行窗口内有 ${hit.name}` });
    else {
      const exists = arts.find((f) => rx.test(String(f.name || '').toLowerCase()));
      failures.push({ what: `产物:${a.what}`, why: exists ? `找到 ${exists.name} 但不是本次运行窗口内产出的` : `未找到 ${a.what}` });
    }
  }

  for (const c of claims.conditions) {
    const got = lookupMetric(ctx.metrics, c.metric);
    if (!got) { unchecked.push({ what: c.what, why: `日志里没提取到指标 ${c.metric}` }); continue; }
    if (cmp(got.value, c.op, c.value)) checked.push({ what: c.what, why: `${got.key}=${got.value} 满足` });
    else failures.push({ what: `指标:${c.what}`, why: `${got.key}=${got.value} 不满足 ${c.metric}${c.op}${c.value}` });
  }

  return { ok: failures.length === 0, failures, checked, unchecked };
}
