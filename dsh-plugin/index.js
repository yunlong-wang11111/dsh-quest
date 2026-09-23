// dsh-quest — quest 任务线的 DSH 侧薄插件（4 工具，HTTP → 本机 quest 服务）
// 设计：QUEST_DESIGN.md §4。所有请求 4 秒超时（8788 无超时挂死的前车之鉴），
// token 与 quest 服务共享 ~/.dsh/quests/.token。
import { readFileSync, appendFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { defineTool } from '@deepseek-ai/dsh-tools';

// 模板路径按仓库实际位置推导（2026-09-19：原来是硬编码 C:\Users\... ——开源给别人就指空气了）
const PLAN_TEMPLATE_PATH = fileURLToPath(new URL('../PLAN-TEMPLATE.md', import.meta.url));

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
    if (!resp.ok) return { error: json.error || `HTTP ${resp.status}`, ...(json.hint ? { hint: json.hint } : {}), ...(json.dropped ? { dropped: json.dropped } : {}) };
    return json;
  } catch (err) {
    // 区分「本工具等超时」与「服务真连不上」——以前一律说"服务不可达"，把人误导成 quest 挂了；
    // 实际多半是等待超时（服务那边可能还在跑，结果已落日志/账本），不该当故障重试。
    const msg = String((err && err.message) || err);
    if ((err && err.name === 'AbortError') || /abort/i.test(msg)) {
      return {
        error: `等待超时（${Math.round(timeoutMs / 1000)} 秒）：quest 可能还在跑这条命令，结果不一定丢——去 /api/log 或账本（probe.done / 节点日志）核实真实状态，别原样重试；长命令请改用 quest_run。`,
        hint: '超时 ≠ 失败：先核实再决定。',
      };
    }
    return { error: `quest 服务不可达（${msg}）——服务在跑吗？（可用 node tools/when-idle.mjs 查）` };
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

// 派发者身份（2026-09-16）：让 quest 知道是谁派的——失败上报才能点名回派发者，
// 而不是猜"最新会话"（派发者若是子对话，猜最新可能落到主对话 ⇒ 双重修改）。
// 2026-09-19：字段假设多次失配（生产里 dispatchedBy 全部"未记录"）——改为深扫描
// session-<uuid> 形状（对结构漂移鲁棒）；找不到时把 exec 结构 dump 到调试文件（一次性取证）。
function sessOf(exec) {
  const RE = /^session-[0-9a-f-]{30,}$/;
  const seen = new Set();
  const scan = (o, d) => {
    if (!o || typeof o !== 'object' || d > 6 || seen.has(o)) return '';
    seen.add(o);
    for (const v of Object.values(o)) {
      if (typeof v === 'string' && RE.test(v)) return v;
      if (v && typeof v === 'object') { const r = scan(v, d + 1); if (r) return r; }
    }
    return '';
  };
  let id = '';
  try { id = scan(exec, 0) || ''; } catch {}
  // 取证（有 bug 才看）：每次调用记一行——找到 id 就记 id；没找到就附带 exec 骨架，下次照着修。
  try {
    const dbg = join(homedir(), '.dsh', 'quests', 'plugin-exec-dump.json');
    let size = 0; try { size = statSync(dbg).size; } catch {}
    if (size < 200e3) {
      const skeleton = (o, d = 0) => (!o || typeof o !== 'object' || d > 4) ? typeof o
        : Object.fromEntries(Object.entries(o).slice(0, 30).map(([k, v]) => [k, typeof v === 'object' && v ? skeleton(v, d + 1) : (typeof v === 'string' && v.length > 80 ? v.slice(0, 80) + '…' : v)]));
      appendFileSync(dbg, JSON.stringify({ at: new Date().toISOString(), found: id || null, exec: id ? undefined : skeleton(exec) }).slice(0, 12000) + '\n');
    }
  } catch {}
  return id;
}

function apply(ctx, config = {}) {
  const cfg = () => questConfig(config);

  ctx.tools.register(defineTool({
    name: 'quest_plan',
    description: [
      '写入/替换当前工作区的任务线计划（quest 系统的源头定义，markdown 格式）。',
      `⚠️ 写之前必须先用 read 工具读模板：${PLAN_TEMPLATE_PATH}`,
      '（含五段科研流水标准骨架、handoff 写作指南与红线——handoff 质量决定 worker 总结质量）。',
      '要点速览：节点用 "---node: <id>---" 分节；command 必填（解释器绝对路径）；',
      'expect_minutes 写真实值（超时护栏=2倍）；after 声明依赖（上游成功自动派发、失败冻结下游；',
      '若某节点不该被"疑似"上游拦住，给上游或 plan 头加 freeze_on: hard-fail-only——只有真失败才冻结，疑似放行并推你复核）；',
      '写完 plan 后顺手用 task_summary_update 把各节点登记进任务总揽（标题=节点id，备注=做什么）；manual: true 停下等人工；auto_fix: true 失败后自动修复；when: <节点>.verdict==ok 或 <节点>.metrics.loss_slope_10ep < -0.05 等条件门控（趋势运算符 slope_N/plateau_epochs 支持"看变化程度"的分支：a好跑b、不好跑c）；watch_log+watch_rules 运行中监控（默认只警告，NaN/OOM 类可配 action=kill+confirm 连续命中）；只需派发链头节点。**派发后不要设 goal 轮询——任务完成会 QQ 通知+自动流转。** workspace 取当前会话 cwd。',
      '⚠️ 整体替换计划时会拦截"静默丢节点"：若旧计划里有未完成（非 completed）的节点不在新计划里，服务端返回 409 并列出节点，先确认这是有意的，再带 force:true 重提交——不要把 409 当故障重试。',
    ].join(' '),
    parameters: {
      markdown: { type: 'string', description: '完整 plan.md 内容' },
      ws: { type: 'string', description: '工作区绝对路径（缺省=当前会话 cwd，一般不用传）' },
      force: { type: 'boolean', description: '确认丢弃旧计划里未完成的节点（默认 false）。仅在收到 409 且确认要丢弃时传 true。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, nodes: { type: 'array', items: { type: 'string' } }, errors: { type: 'array', items: { type: 'string' } }, workspace: { type: 'string' }, error: { type: 'string' }, hint: { type: 'string' }, archived: { type: 'string' }, dropped: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { id: { type: 'string' }, status: { type: 'string' } } } } } },
      render: (_a, v) => [{ type: 'text', text: v.error ? `⚠️ 计划未替换：${v.error}${v.hint ? `\n${v.hint}` : ''}` : `任务线已保存，节点：${(v.nodes || []).join(', ')}` }],
    },
    execute: async (args, exec) => questCall(cfg(), `/api/plan?ws=${encodeURIComponent(wsOf(args, exec))}`, {
      method: 'POST', body: JSON.stringify({ markdown: String(args.markdown || ''), ...(args.force === true ? { force: true } : {}), ...(sessOf(exec) ? { dispatchedBy: sessOf(exec) } : {}) }),
    }, 8000),
  }));

  ctx.tools.register(defineTool({
    name: 'quest_dispatch',
    description: '派发任务线里的一个节点（预检→后台执行→自动判定→worker 总结→QQ 推送）。派发是同步等预检的：预检不过会当场返回原因（如命令用 Linux 路径但没声明 shell: wsl），不会"看起来派发成功其实没跑"。',
    parameters: {
      node: { type: 'string', description: '节点 id（plan.md 里 ---node: <id>--- 定义的那个）' },
      ws: { type: 'string', description: '工作区绝对路径（缺省=当前会话 cwd，一般不用传）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, jobId: { type: 'string' }, error: { type: 'string' }, hint: { type: 'string' } } },
      render: (_a, v) => [{ type: 'text', text: v.error ? `⚠️ 未派发：${v.error}${v.hint ? `\n${v.hint}` : ''}` : `已派发 ${v.jobId}（后台执行中，完成后自动通知）` }],
    },
    execute: async (args, exec) => questCall(cfg(), `/api/dispatch?ws=${encodeURIComponent(wsOf(args, exec))}`, {
      method: 'POST', body: JSON.stringify({ node: String(args.node || ''), ...(sessOf(exec) ? { dispatchedBy: sessOf(exec) } : {}) }),
    }, 25000),
  }));

  ctx.tools.register(defineTool({
    name: 'quest_run',
    description: [
      '快速单发：不写任务线，直接派一个临时长任务到后台（全套判定+worker 总结+QQ 推送）。',
      '适合脚本已定型、想立刻后台跑的单个命令。探索期的临时实验/训练/数据生成都用它。',
      '**长实验禁止用本地终端的 run_in_background + Start-Sleep/轮询 stdout 文件来跑**——那是反模式：每轮询一次烧一轮上下文、DSH 重启实验就死、没有判定没有通知。凡是预计超过 1 分钟的命令，一律走本工具；它不占你的终端槽、quest 崩了任务照跑（重启自动接管）。',
      '**跨平台**：节点字段 shell: wsl 可让该节点跑进 WSL(Ubuntu)——bash 语法、cwd 用 Linux 路径（/home/xxx/...）、不经 cmd.exe（无引号问题）、quest 崩溃照常跑。适合重训练和数据管线密集的任务；文件需在 WSL 内（ext4），别用 /mnt/c 跑训练。缺省 windows 照旧。',
      '**门禁规则**：解释器（python/node/Rscript/matlab/julia）跑工作区内脚本的命令直接执行；其它命令（删除/下载/系统类/工作区外路径）会被挂起推送 owner QQ 等人工确认，30 分钟不确认自动作废——这不是失败，返回的 note 会说明原因。夜间窗口（23:00-08:00）带 reason 可自批执行。所以：常规长任务请写成"python 工作区内脚本"形式，永远畅通；命令被挂起时不要反复原样重试，等确认或改写。',
      '任务结束自动通知（QQ 推送+worker 总结）——**派发后你的工作就完成了，不要设 goal/create_goal 来轮询进度，不要 Sleep 后再查。quest 有事件驱动通知，你等着被通知或被问就行。** 用户催进度时读工作区的 progress.md（quest 自动维护的实时快照）。',
      '**命令长度上限 8000 字符**：超了会被明确拒绝（不会截断你的命令）。多段流水请写进工作区脚本再一次派发——长链式命令既容易出错，判定器与修复器也处理不了。',
      '**auto_fix 只能改脚本**：它改的是工作区里的代码，然后原样重派同一条命令；所以命令本身写错（参数被截断/路径写错）时它帮不上——直接改正命令重派，别烧修复预算。',
      '**同步等预检**：本工具会等预检结果才返回。预检不过（脚本语法错、命令用了 Linux 路径却没声明 shell: wsl、解释器不存在、车道与路径不匹配）会当场回「未派发：<原因>」——不会"看起来派发成功其实没跑"。看到它就按原因改正后重试（最常见：Linux 解释器要配 shell: "wsl" + Linux 的 cwd），不要原样重发。',
    ].join(' '),
    parameters: {
      command: { type: 'string', description: '要后台执行的完整命令（解释器用绝对路径）' },
      cwd: { type: 'string', description: '工作目录' },
      title: { type: 'string', description: '任务短名（用于识别和通知）' },
      reason: { type: 'string', description: '为什么跑这条命令（一句话）。夜间自批必填；白天也给上——挂起推送时它就是给 owner 看的审批理由' },
      expect_minutes: { type: 'string', description: '预计时长（分钟，超时=2倍）' },
      handoff: { type: 'string', description: '交接上下文：这个任务做什么、看什么指标、异常特征' },
      success: { type: 'string', description: '成功判据（白话即可，能机器校验的部分会被判定器强制核对）：引号里的关键词必须出现在日志尾；文件名或通配（out.npz / *.pt）必须落在本次运行窗口内有产出；指标阈值如 val_loss < 1e-3 会用日志里提取到的指标核对。声明了却没满足 → 判 suspect（不是失败），交给你判断' },
      auto_fix: { type: 'string', description: '"true" = 失败后自动修复（默认关）' },
      shell: { type: 'string', description: '"wsl" = 在 WSL(Ubuntu) 里执行（bash 语法 + Linux 路径的 cwd）；缺省 windows' },
      ws: { type: 'string', description: '工作区绝对路径（缺省=当前会话 cwd）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, nodeId: { type: 'string' }, gate: { type: 'string' }, gateId: { type: 'string' }, note: { type: 'string' }, error: { type: 'string' }, hint: { type: 'string' } } },
      render: (_a, v) => [{ type: 'text', text: v.error ? `⚠️ 未派发：${v.error}${v.hint ? `\n${v.hint}` : ''}` : v.gate === 'pending-confirm' ? `⏳ 命令被门禁挂起（${v.gateId}）：${v.note || '已推送 owner QQ 等确认'}` : `✅ 已后台派发：${v.nodeId}${v.gate === 'night-self-approved' ? '（夜间自批，已留痕）' : ''}
进度自动写入工作区 progress.md，完成后 QQ 通知` }],
    },
    execute: async (args, exec) => questCall(cfg(), `/api/run?ws=${encodeURIComponent(wsOf(args, exec))}`, {
      method: 'POST',
      body: JSON.stringify({
        command: String(args.command || ''), cwd: String(args.cwd || wsOf(args, exec)),
        title: String(args.title || args.command || 'quick'), expectMinutes: Number(args.expect_minutes) || 30,
        reason: String(args.reason || ''),
        handoff: String(args.handoff || ''), success: String(args.success || ''), autoFix: args.auto_fix === 'true' || args.auto_fix === true,
        shell: args.shell === 'wsl' ? 'wsl' : 'windows',
        ...(sessOf(exec) ? { dispatchedBy: sessOf(exec) } : {}),   // 2026-09-20 补：署名漏传——深扫描一直正常（exec-dump 228/228 找到），但这处 body 从没带上
      }),
    }, 25000),
  }));

  ctx.tools.register(defineTool({
    name: 'quest_probe',
    description: [
      '诊断探针：同步跑一条命令，30 秒内拿回尾部输出（≤8KB）。跑 plan/run 任务的任何时候都能用，不影响它们。',
      '用途：打印中间量/张量形状/验证路径存在/跑一行检查——"我现在就要看这个值"的场景；改完代码先探一下再等重派也是好习惯。',
      '只接受解释器（python/node/Rscript/matlab/julia）跑工作区内脚本，或 -c 内联诊断；被拒绝说明命令超出探针范围。探针不走 shell（无管道/重定向），复杂逻辑写进 -c 代码里。',
      '**车道按命令首词自动判**（Linux 绝对路径如 /home/…/bin/python → 走 WSL；盘符/UNC → Windows），不用你说明。',
      '**硬上限 30 秒（WSL 车道 25 秒，留中继余量）**，到点杀整个进程组并返回超时前输出（会标 ⏱）；超时的任务不是探针的事，改用 quest_run。',
      '每次探针入账本留痕（probe.run + probe.done/probe.error）。看正在跑的任务的输出用 quest_log（读日志，不执行）。',
    ].join(' '),
    parameters: {
      command: { type: 'string', description: '诊断命令，如 python -c "print(arr.shape)" 或 python check_env.py' },
      cwd: { type: 'string', description: '工作目录' },
      ws: { type: 'string', description: '工作区绝对路径（缺省=当前会话 cwd）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, code: { type: 'number' }, killed: { type: 'boolean' }, secs: { type: 'number' }, ms: { type: 'number' }, log: { type: 'string' }, error: { type: 'string' } } },
      render: (_a, v) => [{ type: 'text', text: v.error ? `⚠️ 探针未执行：${v.error}` : `${v.killed ? `⏱ ${v.secs || 30}s 超时被杀（输出为超时前内容）` : `退出码 ${v.code}`} · ${(Math.round((v.ms || 0) / 100) / 10).toString()}s\n${String(v.log || '').slice(-2000)}` }],
    },
    execute: async (args, exec) => questCall(cfg(), `/api/probe?ws=${encodeURIComponent(wsOf(args, exec))}`, {
      method: 'POST',
      body: JSON.stringify({ command: String(args.command || ''), cwd: String(args.cwd || wsOf(args, exec)), ...(sessOf(exec) ? { dispatchedBy: sessOf(exec) } : {}) }),
    }, 35000),
  }));

  ctx.tools.register(defineTool({
    name: 'quest_notify',
    description: [
      '点名用户（QQ 推送）——**仅本工作区的主对话可调**（服务端按登记主对话校验身份）。',
      '**如果你是子对话**：不要调本工具。规矩是——把你的结果/总结交回主对话（用 DSH 的 send_message 发给它，或写进工作区文件并在收尾消息里说明），**由主对话筛选后统一通知用户**。你的任务结果本来就会通过署名回执自动送回你的派发者，绝大部分情况你不需要再额外汇报。',
      '**如果你是主对话**：只在"阶段任务完成需要汇总"或"需要用户拍板/确认方向"时调。判断值不值得打扰用户是你的职责（不要逐节点汇报）。',
      '**消息格式硬要求（2026-09-20 用户实测反馈：决策点埋在中间等于没发）**：',
      '第一行必须一句话说清"需要用户决定什么"+你的建议，例如：',
      '"❓需要你决定：X 换轨到 Y 吗？我的建议：先跑 A 对照（1 小时）再定。"',
      '背景、数据、证据、备选方案全部放后面（用户手机上首屏只看到开头）。',
      '若纯汇报无决策事项，首行写"📋 汇报：<一句话结论>"，需要用户知道的关键数字放紧随的 2-3 行内。',
      '工作区级冷却（默认 10 分钟一条）；被挡时不要重试，攒到下一次汇总一起发。',
    ].join(' '),
    parameters: {
      message: { type: 'string', description: '给用户的话（≤800 字）：要什么决策/确认什么/结果一句话' },
      ws: { type: 'string', description: '工作区绝对路径（缺省=当前会话 cwd）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, error: { type: 'string' } } },
      render: (_a, v) => [{ type: 'text', text: v.ok ? '🔔 已通知用户' : `⚠️ 未发出：${v.error || '未知原因'}` }],
    },
    execute: async (args, exec) => questCall(cfg(), `/api/notify?ws=${encodeURIComponent(wsOf(args, exec))}`, {
      method: 'POST',
      body: JSON.stringify({ message: String(args.message || ''), ...(sessOf(exec) ? { sessionId: sessOf(exec) } : {}) }),
    }, 15000),
  }));

  ctx.tools.register(defineTool({
    name: 'quest_lit',
    description: [
      '文献检索：一次调用拿 10-25 篇的 标题/作者/年份/venue/摘要（≤700字/篇）——替代 web_search+web_fetch 手爬（那是调研子代理贵的原因：一个子代理曾爬 376 次）。',
      '三个源：arxiv（预印本，最快）；crossref（SCI 主力：Elsevier/Springer/Wiley/IEEE/MDPI 等的 DOI 元数据）；openalex（全覆盖兜底，带引用数 cited_by）。',
      '找创新点/benchmark 表的正确打法：同一检索词 2-3 源各搜一次 → 圈定候选 → 只对最关键的 1-2 篇再 fetch 全文。',
      '只读外部 API，不入账本。返回紧凑 JSON，直接可用。',
    ].join(' '),
    parameters: {
      query: { type: 'string', description: '检索词（英文效果最好），如 "tactile sensor contact force reconstruction"' },
      source: { type: 'string', description: 'arxiv | crossref | openalex（缺省 arxiv）' },
      limit: { type: 'number', description: '条数 1-25（缺省 10）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, source: { type: 'string' }, count: { type: 'number' }, items: { type: 'array', items: { type: 'object', additionalProperties: true } }, error: { type: 'string' } } },
      render: (_a, v) => [{ type: 'text', text: v.error ? `⚠️ 检索失败：${v.error}` : `${v.source} 命中 ${v.count} 条：\n${(v.items || []).map((x, i) => `${i + 1}. [${x.year || '?'}] ${x.title} — ${x.authors || '?'}${x.venue ? ` (${x.venue})` : ''}${x.cited_by != null ? ` 被引${x.cited_by}` : ''}\n   ${x.id || ''}${x.abstract ? `\n   ${x.abstract.slice(0, 200)}` : ''}`).join('\n')}` }],
    },
    execute: async (args) => questCall(cfg(), `/api/lit?q=${encodeURIComponent(String(args.query || ''))}&source=${encodeURIComponent(String(args.source || 'arxiv'))}&limit=${Number(args.limit) || 10}`, undefined, 20000),
  }));

  ctx.tools.register(defineTool({
    name: 'quest_files',
    description: [
      '浏览/读取任意路径的文件（Windows 绝对路径或 \\\\wsl$\\Ubuntu\\... UNC 路径，即 WSL 内部文件）。',
      'mode=list 列目录（名称/大小/时间）；mode=read 读文本（大文件自动截尾）。',
      '典型用途：查 WSL 里的实验产物（\\\\wsl$\\Ubuntu\\home\\user\\...）、看 checkpoint 目录、翻日志文件。',
    ].join(' '),
    parameters: {
      path: { type: 'string', description: '绝对路径，如 \\\\wsl$\\Ubuntu\\home\\user\\exp 或 C:\\Users\\you\\Project' },
      mode: { type: 'string', description: 'list（列目录，缺省）或 read（读文件内容）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { path: { type: 'string' }, entries: { type: 'array', items: { type: 'object', additionalProperties: true } }, text: { type: 'string' }, truncated: { type: 'boolean' }, error: { type: 'string' } } },
      render: (_a, v) => [{ type: 'text', text: v.error ? `读取失败：${v.error}` : v.entries ? `📁 ${v.path}\n${v.entries.slice(0, 30).map((e) => `${e.dir ? '[D]' : '   '} ${e.name}${e.dir ? '' : ' · ' + Math.round((e.size || 0) / 1024) + 'KB'}`).join('\n')}${v.entries.length > 30 ? `\n…共 ${v.entries.length} 项` : ''}` : `📄 ${v.path}${v.truncated ? '（已截尾）' : ''}\n${String(v.text || '').slice(0, 3000)}` }],
    },
    execute: async (args) => questCall(cfg(), `/api/files?mode=${encodeURIComponent(String(args.mode || 'list'))}&path=${encodeURIComponent(String(args.path || ''))}`, undefined, 20000),
  }));

  ctx.tools.register(defineTool({
    name: 'quest_cancel',
    description: [
      '人工终止一个正在运行的节点（杀整棵进程树）。',
      '终止后记为 cancelled 独立终态：不触发自动修复（绝不续杯）、不做 worker 总结，下游保持冻结。',
      '用户说"停掉/别跑了/这个卡死了"时使用。务必带上原因（会进账本和 QQ 通知）。',
    ].join(' '),
    parameters: {
      node: { type: 'string', description: '节点 id（与 tag 二选一）' },
      tag: { type: 'string', description: '批量收线（2026-09-23）：节点 id 包含此片段的全部处理——在跑的杀树、pending/frozen/ready 的落 cancelled 终态；已终态的不动。适合清理一批被取代的 quick-* 节点' },
      reason: { type: 'string', description: '终止原因（一句话，入账本+QQ）' },
      ws: { type: 'string', description: '工作区绝对路径（缺省=最近活跃工作区）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, note: { type: 'string' }, error: { type: 'string' } } },
      render: (_a, v) => [{ type: 'text', text: v.error ? `终止失败：${v.error}` : `已终止：${v.note || '杀树指令已发'}` }],
    },
    execute: async (args, exec) => questCall(cfg(), `/api/cancel?ws=${encodeURIComponent(wsOf(args, exec))}`, {
      method: 'POST', body: JSON.stringify({
        ...(args.tag ? { tag: String(args.tag) } : { node: String(args.node || '') }),
        reason: String(args.reason || (args.tag ? `tag 批量收线 ${args.tag}` : '人工终止')),
      }),
    }, 30000),
  }));

  ctx.tools.register(defineTool({
    name: 'quest_flip',
    description: [
      '翻页：归档本工作区全部会话并开新会话（大上下文对话该翻篇时用——省 token 且恢复有保障）。',
      '标准流程：①你先自己把工作区的 research-state.md 按 9 节模板重写好（目标/已定决策/进度/产物清单/坑/在跑/待办/用户口径/下一步，写详细不写客气话）；',
      '②再以 handoff:false 调用本工具（交接已写好，跳过提示其它会话）。',
      '只在用户明确要求翻页时调用。它会归档包括你自己在内的全部会话（归档≠删除，archive/flip-*.md 留全文）。',
      '新会话会被注入恢复提示：读交接 → quest_status → 向用户复述确认后才动手。',
    ].join(' '),
    parameters: {
      ws: { type: 'string', description: '工作区绝对路径（一般=当前 cwd）' },
      handoff: { type: 'boolean', description: 'false=交接已由你写好（推荐流程）；缺省 true=让最活跃的老会话写（多等 1~2 分钟）' },
    },
    output: {
      // 2026-09-16 修：以前把 archived 声明成 number，但 /api/flip 返回的是**会话 id 数组** ⇒
      // harness 校验失败报 "value.archived must be a number"，翻页被当作工具错误（实测两次均未执行）。
      // 现在在 execute 里先整理成标量（archivedCount/matched），schema 与实际严格一致。
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, archivedCount: { type: 'number' }, matched: { type: 'number' }, created: { type: 'string' }, handoffNote: { type: 'string' }, error: { type: 'string' } } },
      render: (_a, v) => [{ type: 'text', text: v.error
        ? `翻页失败：${v.error}（旧会话未被归档、原样保留）`
        : `翻页完成：归档 ${v.archivedCount ?? '?'}/${v.matched ?? '?'} 个，新会话 ${String(v.created || '').slice(0, 18)}…${v.handoffNote ? '；' + v.handoffNote : ''}（已注入恢复提示）。提醒用户去 DSH 前台打开最新会话。` }],
    },
    execute: async (args, exec) => {
      const ws = args.ws || wsOf(args, exec) || '';
      const r = await questCall(cfg(), `/api/flip?ws=${encodeURIComponent(ws)}`, {
        method: 'POST', body: JSON.stringify({ ws, handoff: args.handoff !== false }),   // ws 同时放 body（服务端双通道）
      }, 240000);   // 含交接阶段（最长约 150s），别提前断
      if (r.error) return r;
      return {
        ok: r.ok,
        archivedCount: Array.isArray(r.archived) ? r.archived.length : r.archived,
        matched: typeof r.matched === 'number' ? r.matched : undefined,
        created: r.created || '',
        handoffNote: r.handoff && r.handoff.wrote ? '交接已写新鲜 ✓' : (r.handoff && r.handoff.note ? '交接：' + r.handoff.note : ''),
        error: (r.errors && r.errors.length) ? r.errors.join('；').slice(0, 200) : undefined,
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'quest_takeover',
    description: [
      '接管本工作区的**主对话**身份（"职位注册"，2026-09-21 用户提出：主对话只有一个，换人时应显式交接）。',
      '**只在用户明确要求时调用**（例如他对你说"你当主对话"、"接管一下"、"以后你来汇报"）——子对话不要自作主张抢位。',
      '接管后的变化：收尾通知/失败上报/回执的定向目标变成你；你有 quest_notify 权限（能点名用户）；老主对话自动退位（无需额外操作）。',
      '想确认当前谁在位：quest_status 返回的 role（你的身份）与 mainSessionId（在位者）。',
    ].join(' '),
    parameters: {
      ws: { type: 'string', description: '工作区绝对路径（缺省=当前会话 cwd，一般不用传）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, mainSessionId: { type: 'string' }, note: { type: 'string' }, error: { type: 'string' }, pending: { type: 'boolean' }, gateId: { type: 'string' } } },
      render: (_a, v) => [{ type: 'text', text: v.ok
        ? `✅ 已接管主对话：后续收尾/上报/回执都指向你（${String(v.mainSessionId || '').slice(8, 16)}…）。${v.note || ''}`
        : (v.pending
          ? `⏳ 接管请求已发出，等用户确认：已有主对话在位于 ${String(v.error || '').slice(0, 120)}…\n（用户 QQ 回复 /q确认 ${v.gateId || ''} 后你才接管；期间请保持子对话职责，不要用 quest_notify 打扰用户。）`
          : `接管失败：${v.error || '未知原因'}`) }],
    },
    execute: async (args, exec) => {
      const sid = sessOf(exec);
      if (!sid) return { ok: false, error: '拿不到本会话身份（插件未能从执行上下文提取 sessionId）——换用 /q 命令或让用户手动指定' };
      const r = await questCall(cfg(), `/api/converge?ws=${encodeURIComponent(wsOf(args, exec))}`, {
        method: 'POST', body: JSON.stringify({ action: 'main', sessionId: sid }),
      }, 15000);
      return { ok: !!r.ok, pending: r.pending === true, gateId: r.id || '', mainSessionId: r.mainSessionId || sid, note: r.note || '', error: r.error };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'quest_spawn',
    description: [
      '派一个**真子对话**（同工作区新建独立 DSH 会话，注入交接提示后独立推进）——"派子对话"从这里变成动作。',
      '什么时候用（分工决策树）：**跑命令**→quest_run/plan 节点（执行者是进程，不是会话）；**当前研究主线的写码/迭代**→主对话自己干；',
      '**一次性并行检索/分析**→会话内 subagent；**需要连续多轮独立推进的大阶段**（整块调研、独立模块开发、长程验证）→本工具。',
      'handoff 复用 plan 节点那套写法（角色/这次验证什么/指标与健康范围/产物在哪/已知的坑）——一套写作技能、两种执行形态。',
      '子对话会收到：身份+你的交接+运行纪律（超1分钟 quest_run/秒级 probe/不能再派子对话）+**简报契约**。',
      '可见性：它出现在 quest_status 的 spawned 区、progress.md「派出的子对话」、控制台——用户和你都看得见。',
      '有界返回：干完（或干不下去）它调 quest_notify 交结构化简报（做了什么/产物路径/读数/阻塞/建议），简报自动回到你这里；',
      '超 deadline_minutes（默认 240）未交简报会标超期并催你一次。',
      '**简报到了你的收件箱就是它的终态**——接力判断（要不要重派/追加/收线）由你做。',
    ].join(' '),
    parameters: {
      title: { type: 'string', description: '子对话用途短名（如"曲率方案文献调研"）——画布/简报里都显示它' },
      handoff: { type: 'string', description: '交接上下文（写法同 plan 节点的 handoff）：这个阶段在整个研究里的角色、具体验证什么、关键指标与健康范围、产物放哪、已知的坑。它看不到你的对话，语境全靠这份交接' },
      deadline_minutes: { type: 'string', description: '约定时限（分钟，默认 240）：超时未交简报标超期+催派发者' },
      ws: { type: 'string', description: '工作区绝对路径（缺省=当前会话 cwd，一般不用传）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, spawnId: { type: 'string' }, sessionId: { type: 'string' }, deadlineMinutes: { type: 'number' }, error: { type: 'string' } } },
      render: (_a, v) => [{ type: 'text', text: v.error ? `⚠️ 子对话未创建：${v.error}` : `✅ 子对话「${v.spawnId}」已上任（会话 ${String(v.sessionId || '').slice(8, 16)}…，时限 ${v.deadlineMinutes} 分钟）。\n它独立推进；简报完成时自动回到你这里。中途看它：quest_status 的 spawned 区 / progress.md。` }],
    },
    execute: async (args, exec) => {
      const sid = sessOf(exec);
      if (!sid) return { ok: false, error: '拿不到本会话身份（插件未能从执行上下文提取 sessionId）——quest_spawn 必须署名派发' };
      return questCall(cfg(), `/api/spawn?ws=${encodeURIComponent(wsOf(args, exec))}`, {
        method: 'POST', body: JSON.stringify({
          title: String(args.title || ''), handoff: String(args.handoff || ''),
          ...(args.deadline_minutes ? { deadlineMinutes: Number(args.deadline_minutes) || 240 } : {}),
          dispatchedBy: sid,
        }),
      }, 60000);
    },
  }));

  ctx.tools.register(defineTool({
    name: 'quest_tell',
    description: [
      '向 quest_spawn 派出的子对话发引导消息（补充指令/修正方向/追加要求）。',
      '为什么需要它：DSH 的 send_message 有父子会话限制（对 spawn 子对话报 "belongs to another parent session"），',
      '而服务端投递没有这个限制——引导消息经 quest 中转，queue 语义（它忙则排队，绝不打断）。',
      'spawnId 可传全称或片段（唯一前缀即可）；它交完简报后状态变 reported，此时投递会提示已收工。',
      '注意：这是"引导"不是"打断"——要中止用 quest_cancel（对它的任务）或直接不再理会。',
    ].join(' '),
    parameters: {
      spawnId: { type: 'string', description: '目标子对话的 spawnId（quest_status 的 spawned 区可查；片段即可）' },
      message: { type: 'string', description: '引导消息（它会以【派发者引导】前缀收到）' },
      ws: { type: 'string', description: '工作区绝对路径（缺省=当前会话 cwd，一般不用传）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, spawnId: { type: 'string' }, title: { type: 'string' }, note: { type: 'string' }, error: { type: 'string' } } },
      render: (_a, v) => [{ type: 'text', text: v.error ? `⚠️ 未投递：${v.error}` : `✅ 已投递给「${v.title || v.spawnId}」${v.note ? ' — ' + v.note : ''}` }],
    },
    execute: async (args, exec) => questCall(cfg(), `/api/tell?ws=${encodeURIComponent(wsOf(args, exec))}`, {
      method: 'POST', body: JSON.stringify({ spawnId: String(args.spawnId || ''), message: String(args.message || '') }),
    }, 20000),
  }));

  ctx.tools.register(defineTool({
    name: 'quest_status',
    description: [
      '查询当前工作区任务线的全部节点状态（pending/running/completed/failed/timeout + 判定依据 + worker 总结）。',
      '返回开头的 unread 是自上次查看以来的完成事件摘要。用户问"实验跑完了吗/怎么样了"时用这个。',
      '**输出硬上限 ~8KB**（2026-09-23，kl P5：此前全量渲染 670 节点能到 300+KB，撑爆上下文）：',
      '概览（含 asOf 快照时刻与 ok/suspect/crash/infra 四类计数）+ 异常/在跑节点 + 最近完成的节点明细；',
      '被截掉的全量明细自动落盘到工作区 `quest-status-full.txt`，需要翻旧账就 read 它。',
      '**返回的 role 字段告诉你自己的身份**（main=本工作区主对话 / subagent=子对话）——不确定"我该向谁汇报、能不能点名用户"时看它，不用凭感觉。主对话职责=汇总筛选后决定是否打扰用户；子对话职责=把结果交给主对话。',
      '返回的 line 字段回答"是不是真都完成了"：quiet=true 表示没有在跑节点、账本安静了 idleMinutes 分钟、且工作区也没有新文件改动；workspace.recent>0 说明有人正在改代码（可能马上又派任务）。dsh.running>0 表示本工作区的 DSH 会话正在跑（AI 在思考/写代码）。这是收敛推断不是完成保证，回答用户时把依据一起说。',
      'spawned 区=quest_spawn 派出的子对话（谁在替你干活、简报交了没）。',
    ].join(' '),
    parameters: {
      ws: { type: 'string', description: '工作区绝对路径（缺省=当前会话 cwd，一般不用传）' },
      verbose: { type: 'boolean', description: 'true=跳过截断，全量渲染（大工作区慎用，会很长）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: true,
        properties: {
          questVersion: { type: 'string' },
          role: { type: 'string', description: 'main=你是主对话；subagent=你是子对话；unknown=身份未传' },
          plan: { type: 'object', additionalProperties: true, properties: { workspace: { type: 'string' }, nodes: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {
            id: { type: 'string' }, status: { type: 'string' }, verdict: { type: 'string' }, via: { type: 'string' },
            // 注意：exitCode / file / metrics 可能为 null（例如重启后认领的节点拿不到退出码）。
            // 这里不声明它们——additionalProperties:true 会原样透传；一旦声明成 number，null 会毒死整个响应。
            summary: { type: 'string' }, jobId: { type: 'string' },
            detail: { type: 'string' },
          } } } } },
          unread: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { node: { type: 'string' }, verdict: { type: 'string' }, summary: { type: 'string' }, ts: { type: 'number' } } } },
          asOf: { type: 'string', description: '快照时刻（ISO）——判断新鲜度用' },
          line: { type: 'object', additionalProperties: true, description: '收敛状态（quiet/idleMinutes/verdictBuckets 四类计数等）' },
          spawned: { type: 'array', items: { type: 'object', additionalProperties: true, description: 'quest_spawn 派出的子对话（spawnId/title/status）' } },
          error: { type: 'string' },
        },
      },
      render: (args, v) => {
        if (v.error) return [{ type: 'text', text: `查询失败：${v.error}` }];
        const nodes = v.plan?.nodes || [];
        if (!nodes.length) return [{ type: 'text', text: '当前工作区没有任务线计划。先用 quest_plan 写一个。' }];
        const asOf = v.asOf ? `（快照 ${v.asOf.slice(11, 19)}Z）` : '';
        const vb = v.line?.verdictBuckets;
        const head = vb ? `四类计数：✅ok ${vb.ok}｜⚠️suspect(记账) ${vb.suspect}｜❌crash(脚本) ${vb.crash}｜🛠infra(超时/终止) ${vb.infra}` : '';
        const line = (n) => `- ${n.id}: ${n.status}${n.verdict ? `（${n.verdict}${n.via ? '/' + n.via : ''}）` : ''}${n.runSeconds != null ? ` 运行${n.runSeconds}s` : ''}${n.summary ? `\n  总结：${String(n.summary).slice(0, 300)}` : ''}`;
        const roleTag = v.role === 'main' ? '【身份：主对话】' : v.role === 'subagent' ? '【身份：子对话】' : '';
        const unread = (v.unread || []).map((u) => `${u.node}:${u.verdict}`).join('、');
        // 全量落盘（供翻旧账）：写进工作区固定文件名，渲染里只给指针
        try {
          const cwd = String(args?.ws || v.plan?.workspace || '');
          if (cwd) writeFileSync(join(cwd, 'quest-status-full.txt'),
            [`# quest_status 全量（落盘于 ${new Date().toLocaleString('zh-CN')}，共 ${nodes.length} 节点）`, ...nodes.map(line)].join('\n'), 'utf8');
        } catch {}
        if (args?.verbose === true) {
          return [{ type: 'text', text: `${roleTag ? roleTag + '\n' : ''}${unread ? `📣 自上次查看：${unread}\n` : ''}任务线 ${nodes.length} 个节点：\n${nodes.map(line).join('\n')}` }];
        }
        // 2026-09-23 硬上限 ~8KB：概览 + 异常/在跑全给 + 最近完成 12 条，其余去落盘文件
        const BAD = ['running', 'failed', 'timeout'];
        const hot = nodes.filter((n) => BAD.includes(n.status));
        const done = nodes.filter((n) => n.status === 'completed');
        const recentDone = done.slice(-12).reverse();
        const parts = [
          `${roleTag ? roleTag + '\n' : ''}${unread ? `📣 自上次查看：${unread}\n` : ''}任务线 ${nodes.length} 节点${asOf}${head ? '\n' + head : ''}`,
          ...(hot.length ? ['', `▸ 需关注（在跑/异常，全量 ${hot.length}）：`, ...hot.slice(0, 25).map(line)] : []),
          ...(recentDone.length ? ['', `▸ 最近完成（最新 ${recentDone.length}/${done.length}）：`, ...recentDone.map(line)] : []),
          ...(v.spawned?.length ? ['', `▸ 子对话：${v.spawned.map((s) => `${s.title}(${s.status})`).join('、')}`] : []),
          ...(hot.length > 25 || done.length > 12 ? [`…（其余 ${hot.length > 25 ? hot.length - 25 + ' 条异常/' : ''}${done.length - 12} 条完成已省略，全量在 <工作区>/quest-status-full.txt）`] : []),
        ];
        let text = parts.join('\n');
        if (text.length > 8192) text = text.slice(0, 7900) + `\n…（渲染超 8KB 截断；全量在 <工作区>/quest-status-full.txt）`;
        return [{ type: 'text', text }];
      },
    },
    execute: async (args, exec) => questCall(cfg(), `/api/status?ws=${encodeURIComponent(wsOf(args, exec))}${sessOf(exec) ? `&sessionId=${encodeURIComponent(sessOf(exec))}` : ''}`),
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
