// dsh-quest — quest 任务线的 DSH 侧薄插件（4 工具，HTTP → 本机 quest 服务）
// 设计：QUEST_DESIGN.md §4。所有请求 4 秒超时（8788 无超时挂死的前车之鉴），
// token 与 quest 服务共享 ~/.dsh/quests/.token。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { defineTool } from '@deepseek-ai/dsh-tools';

const name = 'dsh-quest';
const inject = ['tools'];

function questConfig(config = {}) {
  const baseUrl = String(config.baseUrl || 'http://127.0.0.1:3110').replace(/\/+$/, '');
  let token = String(config.token || '');
  if (!token) {
    try { token = readFileSync(join(homedir(), '.dsh', 'quests', '.token'), 'utf8').trim(); } catch {}
  }
  return { baseUrl, token };
}

async function questCall(cfg, path, init = {}, timeoutMs = 4000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch(`${cfg.baseUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-quest-token': cfg.token, ...(init.headers || {}) },
      signal: ac.signal,
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) return { error: json.error || `HTTP ${resp.status}` };
    return json;
  } catch (err) {
    return { error: `quest 服务不可达（${String(err && err.message || err)}）——服务在跑吗？` };
  } finally {
    clearTimeout(timer);
  }
}

/** 工作区解析：显式参数 > 执行会话的 cwd > DSH 进程 cwd（兜底）。 */
function wsOf(args, exec) {
  if (args && typeof args.ws === 'string' && args.ws.trim()) return args.ws.trim();
  const cwd = exec?.agent?.session?.cwd || exec?.agent?.session?.header?.cwd;
  return cwd || process.cwd();
}

function apply(ctx, config = {}) {
  const cfg = () => questConfig(config);

  ctx.tools.register(defineTool({
    name: 'quest_plan',
    description: [
      '写入/替换当前工作区的任务线计划（quest 系统的源头定义，markdown 格式）。',
      '⚠️ 写之前必须先用 read 工具读模板：<quest-dir>\\PLAN-TEMPLATE.md',
      '（含五段科研流水标准骨架、handoff 写作指南与红线——handoff 质量决定 worker 总结质量）。',
      '要点速览：节点用 "---node: <id>---" 分节；command 必填（解释器绝对路径）；',
      'expect_minutes 写真实值（超时护栏=2倍）；after 声明依赖（上游成功自动派发、失败冻结下游）；',
      '写完 plan 后顺手用 task_summary_update 把各节点登记进任务总揽（标题=节点id，备注=做什么）；manual: true 停下等人工；auto_fix: true 失败后自动修复；when: <节点>.verdict==ok 或 <节点>.metrics.loss_slope_10ep < -0.05 等条件门控（趋势运算符 slope_N/plateau_epochs 支持"看变化程度"的分支：a好跑b、不好跑c）；watch_log+watch_rules 运行中监控（默认只警告，NaN/OOM 类可配 action=kill+confirm 连续命中）；只需派发链头节点。workspace 取当前会话 cwd。',
    ].join(' '),
    parameters: {
      markdown: { type: 'string', description: '完整 plan.md 内容' },
      ws: { type: 'string', description: '工作区绝对路径（缺省=当前会话 cwd，一般不用传）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, nodes: { type: 'array', items: { type: 'string' } }, errors: { type: 'array', items: { type: 'string' } }, workspace: { type: 'string' }, error: { type: 'string' } } },
      render: (_a, v) => [{ type: 'text', text: v.error ? `写入失败：${v.error}` : `任务线已保存，节点：${(v.nodes || []).join(', ')}` }],
    },
    execute: async (args, exec) => questCall(cfg(), `/api/plan?ws=${encodeURIComponent(wsOf(args, exec))}`, {
      method: 'POST', body: JSON.stringify({ markdown: String(args.markdown || '') }),
    }, 8000),
  }));

  ctx.tools.register(defineTool({
    name: 'quest_dispatch',
    description: '派发任务线里的一个节点（预检→后台执行→自动判定→worker 总结→QQ 推送）。派发立即返回，用 quest_status 查进展。',
    parameters: {
      node: { type: 'string', description: '节点 id（plan.md 里 ---node: <id>--- 定义的那个）' },
      ws: { type: 'string', description: '工作区绝对路径（缺省=当前会话 cwd，一般不用传）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, jobId: { type: 'string' }, error: { type: 'string' } } },
      render: (_a, v) => [{ type: 'text', text: v.error ? `派发失败：${v.error}` : `已派发 ${v.jobId}（后台执行中，完成后自动通知）` }],
    },
    execute: async (args, exec) => questCall(cfg(), `/api/dispatch?ws=${encodeURIComponent(wsOf(args, exec))}`, {
      method: 'POST', body: JSON.stringify({ node: String(args.node || '') }),
    }),
  }));

  ctx.tools.register(defineTool({
    name: 'quest_cancel',
    description: [
      '人工终止一个正在运行的节点（杀整棵进程树）。',
      '终止后记为 cancelled 独立终态：不触发自动修复（绝不续杯）、不做 worker 总结，下游保持冻结。',
      '用户说"停掉/别跑了/这个卡死了"时使用。务必带上原因（会进账本和 QQ 通知）。',
    ].join(' '),
    parameters: {
      node: { type: 'string', description: '节点 id' },
      reason: { type: 'string', description: '终止原因（一句话，入账本+QQ）' },
      ws: { type: 'string', description: '工作区绝对路径（缺省=最近活跃工作区）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, note: { type: 'string' }, error: { type: 'string' } } },
      render: (_a, v) => [{ type: 'text', text: v.error ? `终止失败：${v.error}` : `已终止：${v.note || '杀树指令已发'}` }],
    },
    execute: async (args, exec) => questCall(cfg(), `/api/cancel?ws=${encodeURIComponent(wsOf(args, exec))}`, {
      method: 'POST', body: JSON.stringify({ node: String(args.node || ''), reason: String(args.reason || '人工终止') }),
    }, 8000),
  }));

  ctx.tools.register(defineTool({
    name: 'quest_status',
    description: [
      '查询当前工作区任务线的全部节点状态（pending/running/completed/failed/timeout + 判定依据 + worker 总结）。',
      '返回开头的 unread 是自上次查看以来的完成事件摘要。用户问"实验跑完了吗/怎么样了"时用这个。',
    ].join(' '),
    parameters: {
      ws: { type: 'string', description: '工作区绝对路径（缺省=当前会话 cwd，一般不用传）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: true,
        properties: {
          questVersion: { type: 'string' },
          plan: { type: 'object', additionalProperties: true, properties: { workspace: { type: 'string' }, nodes: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {
            id: { type: 'string' }, status: { type: 'string' }, verdict: { type: 'string' }, via: { type: 'string' },
            runSeconds: { type: 'number' }, exitCode: { type: 'number' }, summary: { type: 'string' }, jobId: { type: 'string' },
            detail: { type: 'string' },
          } } } } },
          unread: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { node: { type: 'string' }, verdict: { type: 'string' }, summary: { type: 'string' }, ts: { type: 'number' } } } },
          error: { type: 'string' },
        },
      },
      render: (_a, v) => {
        if (v.error) return [{ type: 'text', text: `查询失败：${v.error}` }];
        const nodes = v.plan?.nodes || [];
        if (!nodes.length) return [{ type: 'text', text: '当前工作区没有任务线计划。先用 quest_plan 写一个。' }];
        const unread = (v.unread || []).map((u) => `${u.node}:${u.verdict}`).join('、');
        const lines = nodes.map((n) => `- ${n.id}: ${n.status}${n.verdict ? `（${n.verdict}${n.via ? '/' + n.via : ''}）` : ''}${n.runSeconds != null ? ` 运行${n.runSeconds}s` : ''}${n.summary ? `\n  总结：${String(n.summary).slice(0, 300)}` : ''}`);
        return [{ type: 'text', text: `${unread ? `📣 自上次查看：${unread}\n` : ''}任务线 ${nodes.length} 个节点：\n${lines.join('\n')}` }];
      },
    },
    execute: async (args, exec) => questCall(cfg(), `/api/status?ws=${encodeURIComponent(wsOf(args, exec))}`),
  }));

  ctx.tools.register(defineTool({
    name: 'quest_log',
    description: '读取某节点最近一次执行的输出日志尾部（排障用，默认 4KB）。',
    parameters: {
      node: { type: 'string', description: '节点 id' },
      tail: { type: 'number', description: '读取字节数（默认 4096）' },
      ws: { type: 'string', description: '工作区绝对路径（缺省=当前会话 cwd，一般不用传）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { log: { type: 'string' }, file: { type: 'string' }, error: { type: 'string' } } },
      render: (_a, v) => [{ type: 'text', text: v.error ? `读取失败：${v.error}` : `日志尾部（${v.file}）：\n${String(v.log || '').slice(-2000)}` }],
    },
    execute: async (args, exec) => questCall(cfg(), `/api/log?ws=${encodeURIComponent(wsOf(args, exec))}&node=${encodeURIComponent(String(args.node || ''))}&tail=${Number(args.tail) || 4096}`),
  }));
}

export { apply, inject, name };
