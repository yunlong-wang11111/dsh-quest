// notify.mjs —— 通知出口（provider 无关，v0.5）
//
// quest 对外的 HTTP 调用只有"发通知"这一件事，且默认关闭。为了让一行启动的用户
// 不依赖某个特定的 IM 桥，这里把出口做成可配置的：
//
//   notify: {
//     kind: 'bridge' | 'webhook' | 'off',        // 缺省按 qqNotify 判定
//     maxChars: 480,                             // 单条上限（超出截断）——通知端往往有硬限制
//
//     // kind='bridge'：任何实现了 POST /api/send/private 的通知端（例如 qq-bridge）
//     bridgeUrl: 'http://127.0.0.1:3100',
//     tokenFile: '…/state/console-token',
//     userId: 10001,
//
//     // kind='webhook'：任何 HTTP 端点。{{message}} 的两种写法都支持（见 renderBody）：
//     //   {"text":"{{message}}"}  占位符带引号
//     //   {"text":{{message}}}    占位符裸放
//     url: 'https://api.telegram.org/bot<TOKEN>/sendMessage',
//     bodyTemplate: '{"chat_id":"123","text":"{{message}}"}',
//     headers: { 'content-type': 'application/json' }
//   }
//
// 常见服务商的模板：
//   Telegram   POST https://api.telegram.org/bot<BOT_TOKEN>/sendMessage
//              {"chat_id":"<CHAT_ID>","text":"{{message}}"}
//   钉钉机器人  POST https://oapi.dingtalk.com/robot/send?access_token=<TOKEN>
//              {"msgtype":"text","text":{"content":"{{message}}"}}
//   飞书机器人  POST https://open.feishu.cn/open-apis/bot/v2/hook/<TOKEN>
//              {"msg_type":"text","content":{"text":"{{message}}"}}
//   企业微信     POST https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=<KEY>
//              {"msgtype":"text","text":{"content":"{{message}}"}}

/** 单条上限：通知端通常有硬限制（qq-bridge 默认 500 字，超了直接 400 拒绝）。 */
export function maxCharsOf(cfg) {
  const n = Number(cfg?.notify?.maxChars ?? cfg?.qqNotify?.maxChars);
  // 默认给足：通知不花 token，通知端（如 qq-bridge）自身会按 IM 的硬上限拆条。
  // 这里的截断只是防离谱超长（比如误把整份日志推进来）的兜底。
  return Number.isFinite(n) && n > 0 ? n : 4000;
}

/** 超限截断（保留尾部信息量最大的说明不如保留头部：头部是任务线前缀+判定）。 */
export function clampMessage(cfg, message) {
  const max = maxCharsOf(cfg);
  const s = String(message ?? '');
  if (s.length <= max) return s;
  // 头尾都留：头部是任务线前缀+判定，尾部往往是 worker 的结论（最该看到的部分）
  const head = Math.floor((max - 14) * 0.6);
  const tail = Math.max(1, max - 14 - head);
  return s.slice(0, head) + '…（中段省略）…' + s.slice(-tail);
}

/**
 * 把消息填进模板。两种写法都接受：
 *   {"text":"{{message}}"}   占位符已带引号 → 填 JSON 内层转义（去外层引号）
 *   {"text":{{message}}}     占位符裸放     → 填完整 JSON 串（自带引号）
 * 这样用户照着服务商文档抄哪种都对，不会因为多写/少写一对引号就发出坏 JSON。
 */
export function renderBody(template, message) {
  const escaped = JSON.stringify(String(message ?? ''));      // "…"
  const inner = escaped.slice(1, -1);                          // 去外层引号
  const tpl = String(template);
  return tpl.split('{{message}}').map((chunk, i, arr) => {
    if (i === arr.length - 1) return chunk;
    const before = chunk.replace(/\s+$/, '');
    const quoted = before.endsWith('"');
    return chunk + (quoted ? inner : escaped);
  }).join('');
}

/** 当前生效的通知方式。 */
export function notifyKind(cfg) {
  const n = cfg?.notify;
  if (n?.kind === 'off') return 'off';
  if (n?.kind === 'webhook') return n.url ? 'webhook' : 'off';
  if (n?.kind === 'bridge') return 'bridge';
  // 兼容 v0.4 配置：qqNotify.enabled=true 即视为 bridge
  return cfg?.qqNotify?.enabled ? 'bridge' : 'off';
}

/** 4xx（被拒）通常重试无益；网络错误与 5xx 才值得重试。 */
export function isRetryable(result) {
  if (result?.ok) return false;
  if (result?.status == null) return true;          // 网络层错误
  return result.status >= 500;                      // 5xx 可重试，4xx 不可
}

/**
 * 发一条文本通知。deps: { fs, timeoutMs }
 * @returns {Promise<{ok: boolean, status?: number, error?: string}>}
 */
export async function sendText(cfg, message, deps) {
  const fsMod = deps.fs;
  const kind = notifyKind(cfg);
  if (kind === 'off') return { ok: false, error: 'off' };

  const body = clampMessage(cfg, message);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Number(deps.timeoutMs) || 8000);
  try {
    if (kind === 'webhook') {
      const n = cfg.notify;
      const resp = await fetch(n.url, {
        method: n.method || 'POST',
        headers: n.headers || { 'content-type': 'application/json' },
        body: renderBody(n.bodyTemplate || '{"text":{{message}}}', body),
        signal: ac.signal,
      });
      return resp.ok ? { ok: true, status: resp.status } : { ok: false, status: resp.status, error: `HTTP ${resp.status}` };
    }
    // bridge 模式
    const q = cfg.qqNotify || {};
    const b = cfg.notify || {};
    const url = b.bridgeUrl || q.bridgeUrl;
    const tokenFile = b.tokenFile || q.tokenFile;
    const userId = b.userId ?? q.userId;
    if (!url) return { ok: false, error: '未配置 bridgeUrl' };
    let token = '';
    try { token = fsMod.readFileSync(tokenFile, 'utf8').trim(); } catch { return { ok: false, error: '读不到通知端令牌' }; }
    const resp = await fetch(url.replace(/\/+$/, '') + '/api/send/private', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': token },
      body: JSON.stringify({ userId, message: body }),
      signal: ac.signal,
    });
    return resp.ok ? { ok: true, status: resp.status } : { ok: false, status: resp.status, error: `HTTP ${resp.status}` };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 120) };
  } finally { clearTimeout(timer); }
}

/** 发一张本地图片（仅 bridge 模式支持；webhook 模式返回不支持，避免静默丢弃）。 */
export async function sendImage(cfg, imagePath, caption, deps) {
  const kind = notifyKind(cfg);
  if (kind !== 'bridge') return { ok: false, error: kind === 'off' ? 'off' : 'webhook 模式暂不支持图片直推' };
  const fsMod = deps.fs;
  const q = cfg.qqNotify || {};
  const b = cfg.notify || {};
  const url = b.bridgeUrl || q.bridgeUrl;
  const tokenFile = b.tokenFile || q.tokenFile;
  const userId = b.userId ?? q.userId;
  if (!url) return { ok: false, error: '未配置 bridgeUrl' };
  let token = '';
  try { token = fsMod.readFileSync(tokenFile, 'utf8').trim(); } catch { return { ok: false, error: '读不到通知端令牌' }; }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20000);
  try {
    const resp = await fetch(url.replace(/\/+$/, '') + '/api/send/private-image', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': token },
      body: JSON.stringify({ userId, imagePath, caption }),
      signal: ac.signal,
    });
    return resp.ok ? { ok: true, status: resp.status } : { ok: false, status: resp.status, error: `HTTP ${resp.status}` };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 120) };
  } finally { clearTimeout(timer); }
}
