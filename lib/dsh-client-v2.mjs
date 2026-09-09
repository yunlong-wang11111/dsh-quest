// dsh-client-v2.mjs — DSH 0.1.2+（@Remote 网关）的 Node 客户端
//
// 协议要点（2026-09-08 对 0.1.2-rc.1 沙盒逐项实测）：
// - 认证：GET /?token=<启动token> → 303 + HttpOnly cookie（30 天有效）；/api 与 WS 都要带。
//   token 是进程级的，DSH 每次启动打印 "dsh web: http://host:port/?token=..." 到 stdout
//   （watchdog 重定向到 ~/.dsh/dsh-run.log），客户端默认从该日志解析，也可构造参数直传。
// - 单发 RPC：POST /api/<ns>/<method>，body：
//     { type:'client-request', rpcId:<uuid>, method:'<ns>/<method>', payload:{ args:{ request|_request } } }
//   命令类（create/prompt/selectModel/archiveSession…）用 args.request 包参数；
//   查询类（session/list、agentPresets/list…）用 args._request；settings/describe 空 args。
//   响应 { type:'server-response', rpcId, result:{ ok, value | error:{code,message} } }。
//   旧 dot 形路径（/api/host.describe）已全部移除，无兼容层。
// - 事件流：WS /api/remote.mux（帧 {type:'open'|'cancel'|'item'|'end'|'error', streamId,…}）。
//   按会话订阅：流式方法 session/follow，args.request.address={kind:'session',sessionId}，
//   item 为 {type:'snapshot'}（历史，跳过）或 {type:'event', event}（实时）。
//   本客户端把各会话的 follow 聚合成旧 events.mux 的兼容形状
//   （{ payload:{ type:'session/event', sessionId, event } }），bridge 主循环零改动。
// - host/describe 已不存在：健康检查用 session/list 等价替代。
// - workspace.create / workspace.rename 已不存在：0.1.2 会话按 cwd 自动归组，
//   这里做透传 shim（workspaceId→cwd），rename 为 no-op（GUI 显示目录名，纯外观损失）。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const DEFAULT_TOKEN_LOG = path.join(os.homedir(), '.dsh', 'dsh-run.log');

/** 从 dsh-run.log 解析最近一次启动的 token（"dsh web: http://…?token=…" 行）。 */
export function parseBootToken(logPath = DEFAULT_TOKEN_LOG) {
  try {
    const text = fs.readFileSync(logPath, 'utf8');
    const matches = [...text.matchAll(/dsh web: https?:\/\/\S+\?token=([A-Za-z0-9_-]+)/g)];
    return matches.length ? matches[matches.length - 1][1] : null;
  } catch {
    return null;
  }
}

export class NodeApiClient {
  /**
   * @param {string} baseUrl DSH Web 根地址（如 http://127.0.0.1:3080）
   * @param {number} [timeoutMs=30000] 单发 RPC 超时
   * @param {{token?: string, tokenLog?: string}} [opts] token 直传 / token 日志路径
   */
  constructor(baseUrl, timeoutMs = 30000, opts = {}) {
    this.baseUrl = String(baseUrl ?? 'http://127.0.0.1:3080').replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.tokenOpt = opts.token || null;
    this.tokenLog = opts.tokenLog || DEFAULT_TOKEN_LOG;
    this.cookie = null;
    this.cookieAt = 0;
    this.followed = new Set();      // 已订阅事件的 sessionId
    this.followAcks = new Map();    // sessionId -> 订阅确认 Promise
    this.followFirstFrame = new Map(); // sessionId -> 首帧回调（订阅确认）
    this.ws = null;                 // 活跃的 remote.mux 连接（单个消费循环复用）
    this.wsWaiters = [];
  }

  // ── 认证 ────────────────────────────────────────────────────────────────

  /**
   * 带硬超时的 fetch：AbortSignal.timeout 在个别场景（服务端 chunked 响应挂起时）
   * 不会触发中止，promise 永久 pending（2026-09-08 生产踩过）。这里用 Promise.race
   * 再兜一层：到时强制 reject，让调用方走失败重试，把"吊死"变成"自愈"。
   */
  async #fetchWithDeadline(url, init, ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    if (init?.signal) {
      // 合并调用方传入的信号（如有）
      init.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    const deadline = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`dsh-client: fetch 硬超时（${ms}ms）：${String(url).slice(0, 80)}`)), ms + 2000);
    });
    try {
      return await Promise.race([
        fetch(url, { ...init, signal: controller.signal }),
        deadline,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async #ensureCookie(force = false) {
    if (!force && this.cookie && Date.now() - this.cookieAt < 24 * 3600 * 1000) return this.cookie;
    const token = this.tokenOpt || parseBootToken(this.tokenLog);
    if (!token) throw new Error('dsh-client: 无法获得 DSH token（构造参数缺失且 ' + this.tokenLog + ' 无 "dsh web:" 行）');
    const resp = await this.#fetchWithDeadline(`${this.baseUrl}/?token=${token}`, { redirect: 'manual' }, 10000);
    const setCookie = resp.headers.get('set-cookie') || '';
    // 关键：303 的 chunked 响应体必须消费/取消掉，否则 undici 把这条 keep-alive 连接
    // 留在未终结状态，后续请求复用时会永久挂起（2026-09-08 生产定位）
    try { await resp.body?.cancel(); } catch {}
    const cookie = setCookie.split(';')[0];
    if (!cookie || !cookie.includes('=')) throw new Error(`dsh-client: token 换 cookie 失败（HTTP ${resp.status}）`);
    this.cookie = cookie;
    this.cookieAt = Date.now();
    return cookie;
  }

  // ── 单发 RPC ───────────────────────────────────────────────────────────

  async #post(method, params, wrapper) {
    const args = {};
    if (wrapper === 'request') args.request = params ?? {};
    else if (wrapper === '_request') args._request = params ?? {};
    const rpcId = crypto.randomUUID();
    const message = { type: 'client-request', rpcId, method, payload: { args } };

    let resp;
    for (let attempt = 0; ; attempt++) {
      const cookie = await this.#ensureCookie(attempt > 0);
      resp = await this.#fetchWithDeadline(`${this.baseUrl}/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify(message),
      }, this.timeoutMs);
      if (resp.status !== 401 || attempt >= 1) break;
      this.cookie = null; // cookie 过期/换进程：强制重换一次再试
    }
    if (!resp.ok) throw new Error(`transport failure for ${method}: HTTP ${resp.status}`);
    const full = await resp.json();
    if (full.rpcId !== rpcId) throw new Error(`rpcId mismatch for ${method}`);
    return full;
  }

  // ── 方法面（对齐 bridge 的调用形状）────────────────────────────────────

  host = {
    /** 0.1.2 已无 host/describe；健康检查用 session/list。 */
    describe: async () => this.#post('session/list', {}, '_request'),
  };

  sessions = {
    create: async (p = {}) => {
      const req = { ...p };
      // 0.1.2 无 workspace.create：workspaceId（shim 里是路径）转成 cwd，会话按 cwd 归组
      if (req.workspaceId && !req.cwd) req.cwd = req.workspaceId;
      delete req.workspaceId;
      const resp = await this.#post('session/create', req, 'request');
      // 先确认事件订阅建立再返回，杜绝 prompt 抢在订阅前的竞态
      if (resp.result.ok && resp.result.value?.sessionId) await this.followSession(resp.result.value.sessionId);
      return resp;
    },
    prompt: async (p = {}) =>
      this.#post('session/prompt', { requestId: crypto.randomUUID(), ...p }, 'request'),
    selectModel: async (p = {}) => this.#post('session/selectModel', p, 'request'),
    list: async (p = {}) => this.#post('session/list', p, '_request'),
  };

  workspace = {
    /** 0.1.2 无此 RPC。返回路径作为 workspaceId，sessions.create 会把它翻译成 cwd。 */
    create: async (p = {}) => ({ result: { ok: true, value: { workspace: { workspaceId: String(p.path ?? '') }, created: true } } }),
    /** 0.1.2 无工作区标题；no-op（GUI 按目录名分组，纯外观差异）。 */
    rename: async () => ({ result: { ok: true, value: {} } }),
    /** 0.1.2 无工作区删除；隐式工作区随会话清空而消失。no-op。 */
    delete: async () => ({ result: { ok: true, value: {} } }),
    archiveSession: async (p = {}) => {
      const resp = await this.#post('workspace/archiveSession', p, 'request');
      if (resp.result.ok) this.unfollowSession(String(p.sessionId ?? ''));
      return resp;
    },
    /** 0.1.2 无 workspace/list RPC：用 session/list 按 cwd 分组拼出等价视图（title=cwd）。 */
    list: async () => {
      const resp = await this.#post('session/list', {}, '_request');
      if (!resp.result.ok) return resp;
      const byCwd = new Map();
      for (const item of resp.result.value?.items ?? []) {
        const cwd = String(item.cwd ?? '');
        if (!cwd) continue;
        if (!byCwd.has(cwd)) byCwd.set(cwd, { title: cwd, workspaceId: cwd, sessionIds: [] });
        byCwd.get(cwd).sessionIds.push(item.sessionId);
      }
      return { result: { ok: true, value: { items: [...byCwd.values()] } } };
    },
  };

  agentPresets = { list: async (p = {}) => this.#post('agentPresets/list', {}, 'none') };
  settings = { describe: async () => this.#post('settings/describe', {}, 'none') };

  // ── 事件流（聚合 session/follow → 旧 events.mux 兼容形状）──────────────

  /**
   * 订阅某会话的事件。返回一个 Promise：收到该流第一帧（snapshot）即 resolve——
   * sessions.create 会 await 它，确保订阅建立后才返回，杜绝"prompt 抢在订阅前、
   * turn 事件全进了 snapshot 历史"的竞态。
   */
  followSession(sessionId) {
    if (!sessionId) return Promise.resolve();
    if (this.followed.has(sessionId)) {
      return this.followAcks.get(sessionId) ?? Promise.resolve();
    }
    this.followed.add(sessionId);
    const p = this.#sendOpenFollow(sessionId).catch(() => {});
    this.followAcks.set(sessionId, p);
    p.finally(() => { if (this.followAcks.get(sessionId) === p) this.followAcks.delete(sessionId); });
    return p;
  }

  unfollowSession(sessionId) {
    this.followed.delete(sessionId);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify({ type: 'cancel', streamId: sessionId })); } catch {}
    }
  }

  async #sendOpenFollow(sessionId) {
    const ws = await this.#waitForWs();
    // 等该流的第一帧（snapshot）作为订阅确认，5 秒兜底
    const firstFrame = new Promise((resolve) => {
      this.followFirstFrame.set(sessionId, resolve);
      setTimeout(resolve, 5000);
    });
    ws.send(JSON.stringify({
      type: 'open',
      streamId: sessionId,
      endpoint: 'session/follow',
      payload: { args: { request: { address: { kind: 'session', sessionId } } } },
    }));
    await firstFrame;
  }

  #waitForWs() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve(this.ws);
    return new Promise((resolve, reject) => {
      this.wsWaiters.push({ resolve, reject });
      // 惰性：没有活跃迭代循环时不开连接（bridge 的 pumpMux 是唯一消费者）
      if (!this.ws && !this.#muxActive) reject(new Error('dsh-client: 无活跃事件流连接'));
    });
  }

  #muxActive = false;

  /** 旧客户端兼容入口：返回聚合事件流的异步迭代器（bridge.pumpMux 消费）。 */
  events = {
    mux: async function* () {
      if (this.#muxActive) throw new Error('dsh-client: events.mux 已有一个活跃迭代器');
      this.#muxActive = true;
      const inbox = [];
      let wake = null;
      const enqueue = (item) => { inbox.push(item); wake?.(); wake = null; };

      try {
        const cookie = await this.#ensureCookie();
        const ws = new WebSocket(this.baseUrl.replace('http', 'ws') + '/api/remote.mux', { headers: { cookie } });
        this.ws = ws;
        const ended = new Promise((resolve) => {
          ws.addEventListener('close', () => resolve(), { once: true });
          ws.addEventListener('error', () => resolve(), { once: true });
        });
        ws.addEventListener('message', (ev) => {
          let frame;
          try { frame = JSON.parse(ev.data); } catch { return; }
          if (!frame || !frame.streamId) return;
          // 首帧 = 订阅确认（snapshot），唤醒等待中的 followSession
          const ack = this.followFirstFrame.get(frame.streamId);
          if (ack) { this.followFirstFrame.delete(frame.streamId); ack(); }
          if (frame.type !== 'item') {
            if (frame.type === 'error') console.error('[dsh-client] follow error:', JSON.stringify(frame.error).slice(0, 200));
            return;
          }
          const value = frame.value;
          if (value?.type === 'event') {
            enqueue({ payload: { type: 'session/event', sessionId: frame.streamId, event: value.event } });
          }
          // snapshot（历史）不外发
        });
        // WS 握手加 15 秒超时：DSH 冷启动阻塞期 TCP 可能接通但握手不响应，
        // 此时既无 open 也无 error——没有超时会永久吊死整个事件流（2026-09-08 生产踩过）
        await new Promise((resolve, reject) => {
          const t = setTimeout(() => {
            try { ws.close(); } catch {}
            reject(new Error('dsh-client: remote.mux 握手超时（15s）'));
          }, 15000);
          ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
          ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('dsh-client: remote.mux 连接失败')); }, { once: true });
        });
        for (const w of this.wsWaiters.splice(0)) w.resolve(ws);

        // 恢复订阅：已知会话 + 全量列表对账（发现其他工具建的会话，如插件 followup 的 worker）
        for (const id of this.followed) {
          ws.send(JSON.stringify({ type: 'open', streamId: id, endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId: id } } } } }));
        }
        try {
          const resp = await this.sessions.list({});
          if (resp.result.ok && Array.isArray(resp.result.value?.items)) {
            for (const item of resp.result.value.items) {
              const id = item.sessionId || item.session?.id || item.id;
              if (id) this.followSession(id);
            }
          }
        } catch {}

        // 事件泵：连接断开时结束迭代器，bridge 外层 for(;;) 会重连
        while (true) {
          while (inbox.length > 0) yield inbox.shift();
          const racer = await Promise.race([ended.then(() => 'ended'), new Promise((r) => { wake = r; }).then(() => 'woken')]);
          if (racer === 'ended') return;
        }
      } finally {
        this.#muxActive = false;
        if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
        for (const w of this.wsWaiters.splice(0)) w.reject(new Error('dsh-client: 事件流已关闭'));
      }
    }.bind(this),
  };
}

/** 把 RpcResponse 的结果槽解出来；业务错误直接抛出。 */
export function unwrap(response, label) {
  if (response.result.ok) return response.result.value;
  const { code, message } = response.result.error;
  throw new Error(`${label} failed: ${code}: ${message}`);
}

/** 在会话事件流里收集一次 turn 的 assistant 文本（按 turn 分组）。 */
export function createTurnCollector() {
  const turns = new Map(); // turn -> { text }
  return {
    /** 处理一条 session/event，返回该事件是否终结了一个 turn（此时可取最终文本）。 */
    push(event) {
      if (event.type === 'turn/start') {
        turns.set(event.data.turn, { text: '' });
        return null;
      }
      if (event.type === 'assistant/chunk') {
        // 忽略流式分块：assistant/message 携带同一内容的完整组装文本，
        // 两者都累加会导致回复文本翻倍（曾因此把「收到」发成「收到收到」）。
        return null;
      }
      if (event.type === 'assistant/message') {
        const t = turns.get(event.data.turn);
        if (!t) return null;
        for (const block of event.data.message?.content ?? []) {
          if (block?.type === 'text' && typeof block.text === 'string') t.text += block.text;
        }
        return null;
      }
      if (event.type === 'turn/end') {
        const t = turns.get(event.data.turn);
        turns.delete(event.data.turn);
        if (!t) return null;
        return { turn: event.data.turn, reason: event.data.reason, text: t.text };
      }
      return null;
    },
    has(turn) {
      return turns.has(turn);
    },
  };
}

/** 从 assistant 消息的 ContentBlock[] 中提取纯文本。 */
export function blocksToText(content) {
  return (content ?? [])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}
