// notify.mjs —— 通知出口（provider 无关，v0.5）
//
// quest 对外的 HTTP 调用只有"发通知"这一件事，且默认关闭。为了让一行启动的用户
// 不依赖某个特定的 IM 桥，这里把出口做成可配置的：
//
//   notify: {
//     kind: 'bridge' | 'webhook' | 'off',        // 缺省按 qqNotify 判定
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
    // 看占位符前一个非空字符是不是引号 → 决定用内层还是完整形式
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

/**
 * 发一条文本通知。deps: { cfg, fs, signalMs }
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function sendText(cfg, message, deps) {
  const fsMod = deps.fs;
  const kind = notifyKind(cfg);
  if (kind === 'off') return { ok: false, error: 'off' };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Number(deps.timeoutMs) || 8000);
  try {
    if (kind === 'webhook') {
      const n = cfg.notify;
      const resp = await fetch(n.url, {
        method: n.method || 'POST',
        headers: n.headers || { 'content-type': 'application/json' },
        body: renderBody(n.bodyTemplate || '{"text":{{message}}}', message),
        signal: ac.signal,
      });
      return resp.ok ? { ok: true } : { ok: false, error: `HTTP ${resp.status}` };
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
      body: JSON.stringify({ userId, message }),
      signal: ac.signal,
    });
    return resp.ok ? { ok: true } : { ok: false, error: `HTTP ${resp.status}` };
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
    return resp.ok ? { ok: true } : { ok: false, error: `HTTP ${resp.status}` };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 120) };
  } finally { clearTimeout(timer); }
}
