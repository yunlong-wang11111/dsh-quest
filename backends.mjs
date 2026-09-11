// backends.mjs —— 可插拔的"大脑"后端（v0.5）
//
// quest 的执行/判定/监控/通知从不依赖任何 agent；只有两件事需要模型：
//   1) worker  —— 任务结束后写十行总结（纯文本进、纯文本出）
//   2) fixer   —— 失败后做最小修复（需要写文件 + 用工具）
// 这个模块把这两件事抽象成可替换后端，于是 quest 不再绑死 DSH：
//
//   workerBackend:  'dsh'（默认）| 'openai' | 'cli' | 'off'
//   fixerBackend:   'dsh'（默认）| 'cli' | 'off'
//
// 配置写在 quest-config.json：
//   {
//     "workerBackend": "openai",
//     "summarizer": { "baseUrl": "https://api.deepseek.com/v1", "apiKey": "...", "model": "deepseek-chat" },
//     "fixerBackend": "cli",
//     "fixer": { "command": "claude -p", "timeoutMs": 600000 }
//   }

/** 纯文本补全：把 prompt 交给模型，拿回文本。 */
export async function completeText(cfg, prompt) {
  const backend = cfg?.backend || 'dsh';
  if (backend === 'off') return '';

  if (backend === 'openai') {
    const base = String(cfg.baseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
    const key = cfg.apiKey || process.env.QUEST_LLM_KEY || process.env.OPENAI_API_KEY || '';
    if (!key) throw new Error('openai 后端缺少 apiKey（quest-config.json 的 summarizer.apiKey 或环境变量 QUEST_LLM_KEY）');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), Number(cfg.timeoutMs) || 120000);
    try {
      const resp = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
        body: JSON.stringify({
          model: cfg.model || 'deepseek-chat',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2,
        }),
        signal: ac.signal,
      });
      if (!resp.ok) throw new Error('LLM HTTP ' + resp.status + ': ' + (await resp.text()).slice(0, 200));
      const data = await resp.json();
      return String(data?.choices?.[0]?.message?.content ?? '').trim();
    } finally { clearTimeout(timer); }
  }

  if (backend === 'cli') {
    const command = String(cfg.command || '').trim();
    if (!command) throw new Error('cli 后端缺少 command（例如 "claude -p" 或 "codex exec -"）');
    const parts = command.match(/"[^"]*"|\S+/g).map((s) => s.replace(/^"|"$/g, ''));
    const exe = parts[0];
    const args = parts.slice(1);
    const { spawn } = await import('node:child_process');
    return await new Promise((resolve, reject) => {
      const child = spawn(exe, args, { windowsHide: true, shell: process.platform === 'win32' });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        reject(new Error('cli 后端超时'));
      }, Number(cfg.timeoutMs) || 180000);
      child.stdout.on('data', (d) => { out += d.toString(); });
      child.stderr.on('data', (d) => { err += d.toString(); });
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0 && !out.trim()) reject(new Error('cli 退出码 ' + code + ': ' + err.slice(0, 200)));
        else resolve(out.trim());
      });
      child.stdin.write(prompt);
      child.stdin.end();
    });
  }

  throw new Error('未知 backend: ' + backend);
}

function verdictLineOf(verdict, via) {
  if (verdict === 'ok') return '✅ 判定：正常完成';
  if (verdict === 'timeout') return '⏹ 判定：超时被杀';
  if (verdict === 'startup-failed') return '❌ 判定：启动即失败（多半是环境/参数/语法问题）';
  if (verdict === 'crashed') return '❌ 判定：运行中崩溃';
  return '⚠️ 判定：' + verdict + '（' + (via || '') + '）';
}

function tailOf(deps, logFile) {
  if (!logFile) return '';
  if (/\.(pt|npz|pth|ckpt|png|jpg|h5|npy|bin)$/i.test(logFile)) return '（产物文件：' + logFile + '）';
  return deps.readTail(logFile, 4096);
}

/**
 * worker 的替代后端。返回 null 表示"用默认 dsh 路径"，返回字符串表示"这就是总结"。
 * deps: { cfg, completeText, readTail, formatDur, log }
 */
export async function workerViaBackend(wsKey, node, j, runSec, deps) {
  const backend = deps.cfg?.workerBackend || 'dsh';
  if (backend === 'dsh') return null;

  if (backend === 'off') return '（纯机械模式：未启用总结）';

  const NL = String.fromCharCode(10);
  const prompt = [
    '你在看一个后台科研任务的执行结果，用不超过 10 行中文总结：做了什么、结果如何、若有异常指出最可能的原因和建议的下一步。不要客套。',
    '',
    '命令：' + node.command,
    verdictLineOf(j.verdict, j.via) + '。运行 ' + deps.formatDur(runSec) + '。',
    '任务交接上下文：',
    String(node.handoff || '（无）').slice(0, 1500),
    '',
    '输出日志尾部：',
    tailOf(deps, j.logFile),
  ].join(NL);

  try {
    const text = await completeText({ backend, ...(deps.cfg?.summarizer || {}) }, prompt);
    return String(text || '').slice(0, 2000);
  } catch (e) {
    deps.log('worker 后端(' + backend + ')失败:', e?.message);
    return '';
  }
}

/**
 * fixer 的替代后端。返回 true 表示"已接管（无论成败）"，false/null 表示走默认 dsh 路径。
 * deps: { cfg, completeText, readTail, log, qqPush, appendEvent, buildState, parsePlan, dispatchJob }
 */
export async function fixerViaBackend(wsKey, node, j, diagnosis, deps) {
  const backend = deps.cfg?.fixerBackend || 'dsh';
  if (backend === 'dsh') return false;

  const NL = String.fromCharCode(10);

  if (backend === 'off') {
    deps.appendEvent(wsKey, { t: 'fix.stopped', node: node.id, reason: '自动修复已关闭（fixerBackend=off）' });
    if (!node.quiet) {
      deps.qqPush(wsKey, '[❌ 失败·未自动修复] ' + node.id + NL + j.verdict + '（' + (j.via || '') + '）——fixerBackend=off，等人处理').catch(() => {});
    }
    return true;
  }

  const attemptN = (deps.buildState(wsKey).nodes[node.id]?.fixCount ?? 0) + 1;
  const prompt = [
    '【自动修复任务】节点 ' + node.id + ' 第 ' + attemptN + ' 次尝试失败，请做最小修复。',
    '',
    '命令：' + node.command,
    '工作目录：' + node.cwd,
    '判定：' + j.verdict + '（' + (j.via || '') + '）',
    diagnosis ? '前一位分析员的诊断：' + NL + diagnosis : '',
    '',
    '崩溃日志尾部：',
    tailOf(deps, j.logFile),
    '',
    '修复纪律（违反即失败）：',
    '1. 只做机械性修复：显存不足→调小 batch/梯度累积；NaN→调小学习率/加 clip；路径/环境错→修路径；缺依赖→修 import。绝不修改实验逻辑、模型结构、数据处理方法。',
    '2. 动任何文件之前先复制一份 .bak-<今天日期> 备份。',
    '3. 改完对主脚本跑语法检查。',
    '4. 回复：一句话说明改了什么，然后单独一行 "FIX_OK"；若判断不属于机械性修复，说明原因并以 "FIX_GIVEUP" 结尾。',
  ].join(NL);

  deps.appendEvent(wsKey, { t: 'fix.attempt', node: node.id, n: attemptN });
  try {
    const reply = await completeText({ backend, ...(deps.cfg?.fixer || deps.cfg?.summarizer || {}) }, prompt);
    const giveup = /FIX_GIVEUP/i.test(reply);
    const okFix = /FIX_OK/i.test(reply);
    deps.appendEvent(wsKey, { t: 'fix.reported', node: node.id, changes: reply.slice(0, 600), backend });
    if (!node.quiet) {
      deps.qqPush(wsKey, '[🔧 自动修复 ' + (giveup ? '放弃' : okFix ? '完成' : '未知') + '] ' + node.id + '（后端 ' + backend + '）' + NL + reply.slice(0, 300)).catch(() => {});
    }
    if (okFix && !giveup) {
      const plan = deps.buildState(wsKey).plan;
      const pn = plan ? deps.parsePlan(plan).nodes.find((x) => x.id === node.id) : null;
      if (pn) deps.dispatchJob(wsKey, pn).catch(() => {});
    }
  } catch (e) {
    deps.log('fixer 后端(' + backend + ')失败:', e?.message);
    if (!node.quiet) deps.qqPush(wsKey, '[⚠️ 自动修复失败] ' + node.id + '：' + String(e?.message || e).slice(0, 200)).catch(() => {});
  }
  return true;
}

/** 后端能力自检：启动日志与 /api/status 用。 */
export function describeBackends(cfg) {
  const w = cfg?.workerBackend || 'dsh';
  const f = cfg?.fixerBackend || 'dsh';
  const notes = [];
  if (w === 'off') notes.push('worker 关闭（纯机械模式）');
  if (f === 'off') notes.push('fixer 关闭（失败不自动修复）');
  if (w === 'openai' && !(cfg?.summarizer?.apiKey || process.env.QUEST_LLM_KEY || process.env.OPENAI_API_KEY)) {
    notes.push('openai 后端未配置 apiKey');
  }
  return { workerBackend: w, fixerBackend: f, notes };
}
