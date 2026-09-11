// resume.mjs —— 开机中断检测 + 一键续跑（v0.5）
//
// 背景：重启电脑会杀掉所有任务（Windows 与 WSL 都死）。此前 quest 启动只做"按产物判定结案"，
// 不会重派——于是一次停电就让过夜训练白跑。但"全自动重派"很危险：判定误报会导致同一任务
// 跑两遍、两个进程写同一份 checkpoint。因此设计为**检测自动、重派要人点头**：
//
//   1. 启动对账发现"该节点当时在跑、进程已消失、证据显示未正常完成" →
//   2. 只有该节点/任务线声明了 resume_on_boot 才参与（默认关闭，爆炸半径可控）
//   3. 且必须能找到断点存档（没有存档就不提示，从零重跑不划算）
//   4. 且该节点自动续跑次数未达上限（默认 1 次，防崩溃循环烧 GPU）
//   → 记录 node.interrupted + 推 QQ：「回 /q续跑 接着跑」
//   5. 人回复后 /api/resume 重派，QUEST_RESUME_FROM 自动带上最新存档
//
// 这样：自动化负责发现与准备，人负责那个有副作用的决定。

const DEFAULT_CAP = 1;

/** 找该节点的可用存档（Windows 路径或 UNC），返回 {file, mtimeMs} 或 null。 */
function checkpointOf(node, deps) {
  const dir = node.shell === 'wsl' ? deps.wslUnc(node.cwd || '') : (node.cwd || '');
  if (!dir) return null;
  return deps.findLatestCheckpoint(dir, 30); // 30 天窗口：过夜/周末中断也覆盖
}

/**
 * 在 adoptOrphan 的"进程已消失"分支里调用。
 * 返回 true 表示"已登记为可续跑并推送了提示"。
 * deps: { cfg, appendEvent, qqPush, pushInbox, findLatestCheckpoint, wslUnc, log }
 */
export async function offerResume(wsKey, node, j, resumeCount, alreadyOffered, deps) {
  if (!node?.resumeOnBoot) return false;
  if (alreadyOffered) return false; // 幂等：本次中断已经提示过（防止每次重启都轰炸）
  // 只有"关键词/声明判据确认完成"才算真完成；artifact-fresh / suspect 都可能是
  // "被杀前刚写了存档"——那正是断电中断的典型样子（实测：杀掉的任务因刚写过 .ckpt 被判 ok）。
  const strongOk = String(j.via || '').includes('finish-keyword') || String(j.via || '').includes('declared');
  if (j.verdict === 'ok' && strongOk) return false;

  const cap = Number(deps.cfg?.resumeCap ?? DEFAULT_CAP) || DEFAULT_CAP;
  if ((resumeCount ?? 0) >= cap) {
    deps.appendEvent(wsKey, { t: 'resume.skipped', node: node.id, reason: `已达自动续跑上限（${cap} 次）` });
    return false;
  }

  const ck = checkpointOf(node, deps);
  if (!ck) {
    deps.appendEvent(wsKey, { t: 'resume.skipped', node: node.id, reason: '未找到断点存档' });
    deps.pushInbox({ node: node.id, verdict: 'interrupted-no-checkpoint', detail: '任务被中断且无存档，请人工决定重跑或放弃' });
    if (!node.quiet) {
      deps.qqPush(wsKey, `[⏸ 中断·无存档] ${node.id}\n判定 ${j.verdict}（${j.via || ''}）\n找不到断点存档，续跑等于从零重来——请你决定：重派 /q派发 ${node.id}，或忽略`).catch(() => {});
    }
    return false;
  }

  deps.appendEvent(wsKey, { t: 'node.interrupted', node: node.id, verdict: j.verdict, checkpoint: ck.file });
  deps.pushInbox({ node: node.id, verdict: 'interrupted-resumable', detail: `有存档 ${ck.file}，可用 /q续跑 继续` });
  if (!node.quiet) {
    deps.qqPush(wsKey, `[⏸ 中断可续跑] ${node.id}\n判定 ${j.verdict}（${j.via || ''}）\n断点：${String(ck.file).split(/[\\/]/).pop()}\n回 /q续跑 ${node.id} 从断点接着跑（或 /q续跑 全部）`).catch(() => {});
  }
  return true;
}

/** 记录一次人工续跑（用于上限判定）。 */
export function markResumed(wsKey, nodeId, appendEvent) {
  appendEvent(wsKey, { t: 'node.resumed', node: nodeId });
}
