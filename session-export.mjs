// session-export.mjs —— 翻页导出：旧会话解压 → 提取对话 → 修剪 → 写 markdown
// AI 可 grep 搜索的"冷存储"；工具输出修剪为头 2000 + 尾 500 字符。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function wsKeyOf(ws) {
  return String(ws || '').replace(/\\/g, '/').replace(/\/+$/, '').replace(/[:/]/g, (c) => (c === ':' ? '' : '-'));
}

export async function exportSessionArchive(workspacePath, items, wsKeyOfFn) {
  const fzstd = await import('fzstd');
  const sessRoot = path.join(os.homedir(), '.dsh', 'sessions');
  const wsDirName = '--' + (wsKeyOfFn || wsKeyOf)(workspacePath) + '--';
  const wsSessDir = path.join(sessRoot, wsDirName);
  const archiveDir = path.join(workspacePath, 'archive');
  try { fs.mkdirSync(archiveDir, { recursive: true }); } catch {}
  const stamp = new Date().toISOString().slice(0, 10);
  const outFile = path.join(archiveDir, `flip-${stamp}.md`);
  const lines = [
    `# 会话归档 ${new Date().toISOString()}`,
    `> 工作区: ${workspacePath}`,
    `> 本文件由 quest 翻页时自动导出，包含翻页前的全部对话原文（工具输出已修剪）。`,
    `> AI 可用 grep 搜索此文件查历史细节。`,
    ``,
  ];
  let totalMsgs = 0;
  for (const item of items) {
    const sessFile = path.join(wsSessDir, item.sessionId, 'session.jsonl.zstd');
    let raw;
    try { raw = fs.readFileSync(sessFile); } catch { continue; }
    let text;
    try { text = new TextDecoder().decode(fzstd.decompress(raw)); } catch { continue; }
    const events = text.split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
    lines.push(`\n---\n## 会话 ${item.sessionId.slice(0, 8)}…（${events.length} 事件）\n`);
    for (const ev of events) {
      if (ev.type === 'user/message') {
        const txt = (ev.data?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
        if (txt.trim()) { lines.push(`\n### 👤 用户\n\n${txt}\n`); totalMsgs++; }
      } else if (ev.type === 'assistant/message') {
        const content = ev.data?.message?.content || [];
        const reasoning = content.filter((c) => c.type === 'reasoning').map((c) => c.text).join('\n');
        const reply = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
        if (reasoning && reasoning.trim()) {
          lines.push(`\n<details><summary>思考过程</summary>\n\n${reasoning.slice(0, 500)}${reasoning.length > 500 ? '\n…（已截断）' : ''}\n\n</details>\n`);
        }
        if (reply.trim()) { lines.push(`\n### 🤖 AI\n\n${reply}\n`); totalMsgs++; }
      } else if (ev.type === 'tool/call') {
        const tc = ev.data;
        const name = tc?.name || tc?.toolName || 'tool';
        let args = '';
        try { args = JSON.stringify(tc?.arguments || tc?.input || {}).slice(0, 200); } catch { args = '(序列化失败)'; }
        lines.push(`\n**🔧 ${name}** ${args}`);
      } else if (ev.type === 'tool/result') {
        const parts = ev.data?.message?.content || [];
        for (const p of parts) {
          const texts = (p.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
          if (!texts || !texts.trim()) continue;
          if (texts.length <= 2500) {
            lines.push(`\n\`\`\`\n${texts}\n\`\`\``);
          } else {
            lines.push(`\n\`\`\`\n${texts.slice(0, 2000)}\n…（中间截断，原文 ${texts.length} 字符）\n${texts.slice(-500)}\n\`\`\``);
          }
        }
      }
    }
  }
  lines.push(`\n---\n> 导出完成：${totalMsgs} 条消息，${items.length} 个会话。\n`);
  fs.writeFileSync(outFile, lines.join('\n'), 'utf8');
  const size = fs.statSync(outFile).size;
  return { file: outFile, messages: totalMsgs, sizeMB: Math.round(size / 1048576 * 10) / 10 };
}
