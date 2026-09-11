import os from 'node:os';
// resume.mjs —— 开机中断检测 + 一键续跑（v0.5）
//
// 背景：重启电脑会杀掉所有任务（Windows 与 WSL 都死）。此前 quest 启动只做"按产物判定结案"，
// 不会重派——于是一次停电就让过夜训练白跑。但"全自动重派"很危险：判定误报会导致同一任务
// 跑两遍、两个进程写同一份 checkpoint。因此设计为**检测自动、重派要人点头**：
//
//   1. 启动对账发现"该节点当时在跑、进程已消失、证据显示未正常完成" →
//   2. **且任务期间电脑真的重启过**（用系统开机时刻判断——这条把 OOM/自崩排除掉：
//      电脑没重启说明任务是"自己死的"，续跑只会再死一次，那是 fixer 和人工的事）→
//   3. 且该节点/任务线声明了 resume_on_boot（默认关闭，爆炸半径可控）→
//   4. 且能找到断点存档（没有存档就不提示，从零重跑不划算）→
//   5. 且该节点提示次数未达上限（默认 1 次，防崩溃循环）
//   → 记录 node.interrupted + 推 QQ 一条：「回 /q续跑 接着跑」
//   6. 人回复后 /api/resume 重派，QUEST_RESUME_FROM 自动带上最新存档
//
// 边界：断电前无法通知（系统正在关机，没有任何程序有机会说话）——通知只能发生在开机后扫盘时。

const DEFAULT_CAP = 1;

/** 找该节点的可用存档（Windows 路径或 UNC），返回 {file, mtimeMs} 或 null。 */
function checkpointOf(node, deps) {
  const dir = node.shell === 'wsl' ? deps.wslUnc(node.cwd || '') : (node.cwd || '');
  if (!dir) return null;
  return deps.findLatestCheckpoint(dir, 30); // 30 天窗口：过夜/周末中断也覆盖
}

/**
 * 是否值得提示续跑（纯函数，便于单测）。
 *
 * 核心判据：**任务期间电脑是否真的重启过**。用系统开机时刻与任务开始时刻比较：
 *   开机时刻 > 任务开始时刻 → 重启过 → 续跑有意义
 *   否则                    → 电脑一直开着，任务是"自己死的"（OOM/崩溃/被杀）
 *                             → 续跑只会再死一次，交给 fixer / 人工，不提示
 */
export function shouldOfferResume({ nodeStartedAt, bootAt, resumeOnBoot, resumeCount, cap, hasCheckpoint, alreadyOffered }) {
  if (!resumeOnBoot) return { offer: false, reason: '节点未声明 resume_on_boot' };
  if (alreadyOffered) return { offer: false, reason: '本次中断已提示过' };
  if (!hasCheckpoint) return { offer: false, reason: '无断点存档（续跑等于从零重来）' };
  if ((resumeCount ?? 0) >= cap) return { offer: false, reason: '已达提示上限（' + cap + ' 次）' };
  if (!(bootAt > nodeStartedAt)) return { offer: false, reason: '机器未重启（任务自行结束，续跑无意义）' };
  return { offer: true, reason: '机器重启导致中断' };
}

/**
 * 在 adoptOrphan 的"进程已消失"分支里调用。
 * 返回 true 表示已推送过消息——调用方据此抑制随后那条重复的失败推送。
 * deps: { cfg, appendEvent, qqPush, pushInbox, findLatestCheckpoint, wslUnc, log, bootAt }
 */
export async function offerResume(wsKey, node, j, resumeCount, alreadyOffered, deps) {
  // 只有"关键词/声明判据确认完成"才算真完成；artifact-fresh / suspect 都可能是
  // "被杀前刚写了存档"——那正是断电中断的典型样子（实测：被杀任务因刚写过 .ckpt 被判 ok）。
  const via = String(j.via || '');
  if (j.verdict === 'ok' && (via.includes('finish-keyword') || via.includes('declared'))) return false;

  const cap = Number(deps.cfg?.resumeCap ?? DEFAULT_CAP) || DEFAULT_CAP;
  const ck = checkpointOf(node, deps);
  const bootAt = deps.bootAt ?? (Date.now() - os.uptime() * 1000);
  const nodeStartedAt = Date.parse(node.__startedAt || '') || 0;

  const v = shouldOfferResume({
    nodeStartedAt,
    bootAt,
    resumeOnBoot: !!node.resumeOnBoot,
    resumeCount,
    cap,
    hasCheckpoint: !!ck,
    alreadyOffered: !!alreadyOffered,
  });

  if (!v.offer) {
    deps.log('续跑未提示（' + node.id + '）：' + v.reason);
    // 只有"声明了要续跑却没存档"值得打扰用户；其余（未声明/未重启/超限）静默
    if (node.resumeOnBoot && v.reason.startsWith('无断点存档') && !node.quiet) {
      deps.appendEvent(wsKey, { t: 'resume.skipped', node: node.id, reason: v.reason });
      deps.pushInbox({ node: node.id, verdict: 'interrupted-no-checkpoint', detail: '任务被中断且无存档，请人工决定重跑或放弃' });
      deps.qqPush(wsKey, '[⏸ 中断·无存档] ' + node.id + '\n' + v.reason + '——请你决定：重派 /q派发 ' + node.id + '，或忽略').catch(() => {});
      return true;
    }
    return false;
  }

  deps.appendEvent(wsKey, { t: 'node.interrupted', node: node.id, verdict: j.verdict, checkpoint: ck.file });
  deps.pushInbox({ node: node.id, verdict: 'interrupted-resumable', detail: '有存档 ' + ck.file + '，可用 /q续跑 继续' });
  deps.qqPush(wsKey, '[⏸ 电脑重启·可续跑] ' + node.id + '\n判定 ' + j.verdict + '（' + via + '）\n断点：' + String(ck.file).split(/[\\/]/).pop() + '\n回 /q续跑 ' + node.id + ' 从断点接着跑（或 /q续跑 全部）').catch(() => {});
  return true;
}

/** 记录一次人工续跑（用于上限判定）。 */
export function markResumed(wsKey, nodeId, appendEvent) {
  appendEvent(wsKey, { t: 'node.resumed', node: nodeId });
}
