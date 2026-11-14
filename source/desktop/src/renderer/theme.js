'use strict';
// 在页面渲染前设置主题，避免闪烁。偏好存在 localStorage：system / light / dark
(function () {
  const KEY = 'mem0.theme';
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const pref = () => localStorage.getItem(KEY) || 'system';
  const apply = () => {
    const p = pref();
    document.documentElement.dataset.theme = p === 'system' ? (mq.matches ? 'dark' : 'light') : p;
    document.documentElement.dataset.themePref = p;
  };
  apply();
  // 让主进程知道主题（窗口背景色、下次启动不闪）
  const tell = () => { try { window.mem0 && window.mem0.setTheme && Promise.resolve(window.mem0.setTheme(pref())).catch(() => {}); } catch (e) { /* ignore */ } };
  tell();
  mq.addEventListener('change', apply);
  // 多窗口同步（主窗口 ↔ 托盘小窗同为 file:// 源，共享 localStorage；storage 事件只在其它窗口触发）
  window.addEventListener('storage', (e) => { if (e.key === KEY || e.key === null) apply(); });
  window.mem0Theme = {
    get: pref,
    set(p) { if (p === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, p); apply(); tell(); },
    toggle() { this.set(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); },
  };
})();
