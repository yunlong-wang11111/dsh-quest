(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.__ModuleLoader__ || !window.__ModuleLoader__.load) return;

  // dsh-quest 浏览器端薄壳（2026-09-10）：把 quest 的 HTTP 仪表盘嵌进 better-sidebar。
  // 真正的 UI 全在 quest 服务（/dashboard）里——DSH 挂了仪表盘照常从浏览器开，这里只是便利层。
  const PACKAGE_ID = 'dsh-quest';
  const QUEST_BASE = 'http://127.0.0.1:3110';

  window.__ModuleLoader__.load({
    id: PACKAGE_ID,
    factory: function (require) {
      const module = { exports: {} };
      const React = require('react');
      const { useEffect, useState } = React;

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
        return React.createElement('div', { style: { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', minHeight: 0 } },
          dead
            ? React.createElement('div', { style: { padding: '8px 12px', fontSize: 12, opacity: 0.75, borderBottom: '1px solid rgba(128,128,128,.25)' } },
                'quest 服务无响应（它是独立进程，不随 DSH 生死）。浏览器直开 ' + QUEST_BASE + '/dashboard 可确认。')
            : null,
          React.createElement('iframe', {
            src: QUEST_BASE + '/dashboard',
            title: 'quest 仪表盘',
            style: { flex: 1, width: '100%', border: 'none', background: '#111418', minHeight: 0 },
          }));
      }

      function apply(ctx) {
        try {
          ctx.inject(['betterSidebar'], (scope) => {
            const svc = scope.betterSidebar;
            if (!svc || typeof svc.registerTab !== 'function') return;
            svc.registerTab({
              id: 'quest:dashboard',
              title: () => '任务仪表盘',
              icon: '📊',
              order: 95,
              single: true,
              component: () => React.createElement(QuestPanelView, {}),
            });
          });
        } catch (e) { console.error('[quest] registerTab failed:', e); }
      }

      module.exports = { name: 'quest-panel', inject: [], apply };
      return module.exports;
    },
  });
})();
