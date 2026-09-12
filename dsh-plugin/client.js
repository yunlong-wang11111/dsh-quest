(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.__ModuleLoader__ || !window.__ModuleLoader__.load) return;

  // dsh-quest 浏览器端（v0.5）
  //  1) 侧边栏标签页：内嵌 quest 的 HTTP 仪表盘（DSH 挂了仪表盘照常从浏览器开，这里只是便利层）
  //  2) 文件预览器：读 Windows 与 \\wsl$ UNC 路径。DSH 自己的 fs 是沙箱化的（限工作区），
  //     读不到 WSL 里的文件；quest 服务用 Node fs 读，UNC 无障碍。
  //  UI 教训（v0.4 事故）：容器一律普通流式布局，绝不用 position:absolute 撑满——
  //  在无定位祖先的容器里会盖住整个侧边栏（含标签栏），用户切不回去。
  const PACKAGE_ID = 'dsh-quest';
  const QUEST_BASE = (location.hostname === '127.0.0.1' || location.hostname === 'localhost')
    ? 'http://127.0.0.1:3110'
    : ('http://' + location.hostname + ':3083');
  const STYLE_ID = 'quest-panel-style';

  // 预览器接管的扩展名：以"只读查看"为主，且 DSH 内置预览器在越界路径上会失败的那些。
  // 不接管 .md / .py / .js 等——内置预览器有 markdown 渲染与语法高亮，不该被顶掉。
  const VIEW_EXTS = [
    'log', 'out', 'txt', 'csv', 'tsv', 'json', 'yml', 'yaml',
    'png', 'jpg', 'jpeg', 'gif', 'webp',
    'pt', 'pth', 'ckpt', 'npz', 'npy', 'h5', 'bin',
  ];
  const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
  const BINARY_EXTS = ['pt', 'pth', 'ckpt', 'npz', 'npy', 'h5', 'bin'];

  window.__ModuleLoader__.load({
    id: PACKAGE_ID,
    factory: function (require) {
      const module = { exports: {} };
      const React = require('react');
      const { useEffect, useState } = React;

      function ensureStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = [
          '.qst-root{width:100%;height:100%;min-height:320px;display:flex;flex-direction:column;overflow:hidden;font:12px/1.5 ui-monospace,Consolas,monospace}',
          '.qst-note{padding:8px 12px;opacity:.75;font-family:system-ui,sans-serif;border-bottom:1px solid rgba(128,128,128,.25)}',
          '.qst-pre{flex:1;min-height:0;overflow:auto;margin:0;padding:10px;white-space:pre-wrap;word-break:break-all;background:#111418;color:#d7dde5}',
          '.qst-img{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;overflow:auto;background:#0d1014}',
          '.qst-img img{max-width:100%;max-height:100%;object-fit:contain}',
          '.qst-meta{padding:10px 12px;font-family:system-ui,sans-serif;line-height:1.9}',
          '.qst-meta b{font-weight:600}',
        ].join('\n');
        document.head.appendChild(style);
      }

      function questToken() {
        try { return localStorage.getItem('questTok') || ''; } catch { return ''; }
      }

      async function questFetch(pathname, signal) {
        const r = await fetch(QUEST_BASE + pathname, { headers: { 'x-quest-token': questToken() }, signal });
        const textBody = await r.text();
        let json;
        try { json = JSON.parse(textBody); } catch { json = { error: textBody.slice(0, 200) }; }
        if (!r.ok) throw new Error(json.error || ('HTTP ' + r.status));
        return json;
      }

      const extOf = (p) => String(p || '').split('.').pop().toLowerCase();

      // ── 仪表盘标签页 ────────────────────────────────────────────────
      function QuestPanelView() {
        const [dead, setDead] = useState(false);
        useEffect(() => {
          const probe = async () => {
            try { await fetch(QUEST_BASE + '/dashboard', { mode: 'no-cors', cache: 'no-store' }); setDead(false); }
            catch { setDead(true); }
          };
          probe();
          const t = setInterval(probe, 15000);
          return () => clearInterval(t);
        }, []);
        return React.createElement('div', { className: 'qst-root' },
          dead
            ? React.createElement('div', { className: 'qst-note' },
                'quest 服务无响应（它是独立进程，不随 DSH 生死）。浏览器直开 ' + QUEST_BASE + '/dashboard 可确认。')
            : null,
          React.createElement('iframe', {
            src: QUEST_BASE + '/dashboard',
            title: 'quest 仪表盘',
            style: { flex: 1, width: '100%', minHeight: 0, border: 'none', background: '#111418' },
          }));
      }

      // ── 文件预览器 ──────────────────────────────────────────────────
      function QuestFileView(props) {
        const data = props.customData || {};
        if (data.error) {
          return React.createElement('div', { className: 'qst-root' },
            React.createElement('div', { className: 'qst-note' }, String(data.error)),
            React.createElement('div', { className: 'qst-meta' },
              React.createElement('div', null, React.createElement('b', null, '路径：'), props.path),
              React.createElement('div', null, '提示：需要 quest 服务在运行（3110）；若提示未授权，先在「任务仪表盘」标签里填一次 token。')));
        }
        if (data.kind === 'image') {
          return React.createElement('div', { className: 'qst-root' },
            React.createElement('div', { className: 'qst-note' }, props.title + (data.size ? ' · ' + fmtSize(data.size) : '')),
            React.createElement('div', { className: 'qst-img' }, React.createElement('img', { src: data.dataUrl, alt: props.title })));
        }
        if (data.kind === 'binary') {
          return React.createElement('div', { className: 'qst-root' },
            React.createElement('div', { className: 'qst-note' }, '二进制产物（不在浏览器里渲染）'),
            React.createElement('div', { className: 'qst-meta' },
              React.createElement('div', null, React.createElement('b', null, '文件：'), props.title),
              React.createElement('div', null, React.createElement('b', null, '大小：'), fmtSize(data.size)),
              React.createElement('div', null, React.createElement('b', null, '修改：'), data.mtimeMs ? new Date(data.mtimeMs).toLocaleString('zh-CN', { hour12: false }) : '—'),
              React.createElement('div', null, React.createElement('b', null, '完整路径：'), props.path)));
        }
        return React.createElement('div', { className: 'qst-root' },
          React.createElement('div', { className: 'qst-note' },
            props.title + (data.size ? ' · ' + fmtSize(data.size) : '') + (data.truncated ? '（大文件，只显示尾部 256KB）' : '')),
          React.createElement('pre', { className: 'qst-pre' }, String(data.text || '')));
      }

      function fmtSize(n) {
        const v = Number(n) || 0;
        if (v >= 1073741824) return (v / 1073741824).toFixed(2) + ' GB';
        if (v >= 1048576) return (v / 1048576).toFixed(1) + ' MB';
        if (v >= 1024) return (v / 1024).toFixed(0) + ' KB';
        return v + ' B';
      }

      function apply(ctx) {
        ensureStyle();
        try {
          ctx.inject(['betterSidebar'], (scope) => {
            const svc = scope.betterSidebar;
            if (!svc) return;

            if (typeof svc.registerTab === 'function') {
              svc.registerTab({
                id: 'quest:dashboard',
                title: () => '任务仪表盘',
                icon: '📊',
                order: 95,
                single: true,
                component: () => React.createElement(QuestPanelView, {}),
              });
            }

            if (typeof svc.registerFileViewer === 'function') {
              svc.registerFileViewer({
                id: 'quest:files',
                title: () => 'quest 文件（含 WSL）',
                icon: '📂',
                exts: VIEW_EXTS,
                priority: 5, // 高于内置（内置为 0）：这些扩展名走 quest 读取，UNC 路径才可用
                fetchStrategy: 'custom',
                load: async (path, _scope, signal) => {
                  const ext = extOf(path);
                  try {
                    if (IMAGE_EXTS.includes(ext)) {
                      const d = await questFetch('/api/files?mode=img&path=' + encodeURIComponent(path), signal);
                      return { kind: 'image', dataUrl: d.dataUrl };
                    }
                    if (BINARY_EXTS.includes(ext)) {
                      const d = await questFetch('/api/files?mode=stat&path=' + encodeURIComponent(path), signal);
                      const st = d.stat || {};
                      return { kind: 'binary', size: st.size, mtimeMs: st.mtimeMs };
                    }
                    const d = await questFetch('/api/files?mode=read&path=' + encodeURIComponent(path), signal);
                    return { kind: 'text', text: d.text, truncated: d.truncated, size: d.size };
                  } catch (e) {
                    return { error: 'quest 读取失败：' + String(e && e.message ? e.message : e) };
                  }
                },
                component: (props) => React.createElement(QuestFileView, props),
              });
            }
          });
        } catch (e) { console.error('[quest] register failed:', e); }
      }

      module.exports = { name: 'quest-panel', inject: [], apply };
      return module.exports;
    },
  });
})();
