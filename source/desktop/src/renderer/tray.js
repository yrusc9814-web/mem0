'use strict';
/* global mem0, icon, sourceLogo */
// 托盘快捷小窗。CSP：禁止 style="" 字符串，动态样式只用类名
(() => {
  const $ = (s) => document.querySelector(s);
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
    return el;
  };
  const SOURCES = window.MEM0_SOURCES || {};
  const srcName = (id) => (SOURCES[id] || [id])[0];
  const isWeb = (id) => /-web$/.test(id || '');
  const srcLabel = (id) => h('span', { class: `src-label ${isWeb(id) ? 'web' : 'local'}` }, h('span', { class: 'src-name' }, srcName(id)), isWeb(id) ? icon('globe', 'globe') : null);
  const av = (id) => h('span', { class: 'av md', title: srcName(id), 'data-source': id }, sourceLogo(id));
  const nf = new Intl.NumberFormat('zh-CN');
  const startOfDay = () => { const x = new Date(); x.setHours(0, 0, 0, 0); return x.getTime(); };
  const hm = (ms) => new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  function shortTime(ms) {
    if (!ms) return '';
    const t0 = startOfDay();
    if (ms >= t0) return hm(ms);
    if (ms >= t0 - 864e5) return '昨天';
    const d = new Date(ms);
    return d.getFullYear() === new Date().getFullYear() ? `${d.getMonth() + 1}/${d.getDate()}` : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  }

  function setMcp(n) { $('#tp-mcp').textContent = nf.format(Math.max(0, Number(n) || 0)); }

  function render(s) {
    if (!s) return;
    $('#tp-backup').textContent = nf.format(s.todayMessages || 0);
    setMcp(s.mcpCallsToday);
    const sync = $('#tp-sync');
    sync.classList.toggle('warn', s.errors > 0);
    sync.title = s.errors > 0 ? `${s.errors} 项异常，打开 mem0 查看详情` : '后台实时备份中';
    $('#tp-sync-text').textContent = `${hm(s.lastSyncAt || Date.now())} 更新`;
    const rows = (s.recent || []).slice(0, 4);
    $('#tp-list').replaceChildren(...(rows.length ? rows.map((r) => h('button', {
      class: 'tp-row', type: 'button', 'data-id': r.id, 'data-source': r.source, title: r.title || '(无标题)',
      onclick: () => mem0.tray.openConversation(r.id),
    },
    av(r.source),
    h('span', { class: 'tp-main' },
      h('span', { class: 'tp-t', 'data-role': 'title' }, r.title || '(无标题)'),
      h('span', { class: 'tp-sub' }, srcLabel(r.source), h('span', { class: 'dotsep' }, '·'),
        h('span', { class: 'cnt' }, r.addedToday > 0 ? `存入 ${nf.format(r.addedToday)} 条新消息` : `共 ${nf.format(r.messageCount || 0)} 条消息`))),
    h('span', { class: 'tp-time' }, shortTime(r.updatedAt)))) : [h('div', { class: 'tp-empty' }, '还没有备份的对话', h('br'), '用 AI 聊几句，这里就会出现')]));
  }

  // 面板高度 → 主进程调整窗口（面板内部永远不滚动）
  const panel = $('#panel');
  let lastH = 0;
  const report = () => {
    const hgt = Math.ceil(panel.getBoundingClientRect().height);
    if (hgt && hgt !== lastH) { lastH = hgt; Promise.resolve(mem0.tray.resize(hgt)).catch(() => {}); }
  };
  new ResizeObserver(report).observe(panel);

  // 刷新：立即扫描，扫描中图标旋转（至少转 600ms，避免一闪而过）
  const btn = $('#tp-refresh');
  btn.addEventListener('click', async () => {
    if (btn.classList.contains('spinning')) return;
    btn.classList.add('spinning');
    btn.setAttribute('aria-busy', 'true');
    const t0 = Date.now();
    try { render(await mem0.tray.rescan()); } catch { /* ignore */ } finally {
      setTimeout(() => { btn.classList.remove('spinning'); btn.removeAttribute('aria-busy'); }, Math.max(0, 600 - (Date.now() - t0)));
    }
  });

  $('#tp-open').addEventListener('click', () => mem0.tray.openMain());
  // 退出确认条：⏻ → .confirming；取消 / Esc / 小窗收起 → 复位；退出 → 禁用按钮、「退出中…」、真正退出
  const foot = $('#tp-foot');
  const confirmBox = $('#tp-confirm');
  const confirmText = $('#tp-confirm-text');
  const cancelBtn = $('#tp-cancel');
  const yesBtn = $('#tp-quit-yes');
  const confirming = () => foot.classList.contains('confirming');
  function resetConfirm() {
    foot.classList.remove('confirming');
    confirmBox.setAttribute('aria-hidden', 'true');
    confirmText.textContent = '退出 mem0？';
    cancelBtn.disabled = false; yesBtn.disabled = false;
  }
  $('#tp-quit').addEventListener('click', () => {
    foot.classList.add('confirming');
    confirmBox.setAttribute('aria-hidden', 'false');
    cancelBtn.focus();
  });
  cancelBtn.addEventListener('click', resetConfirm);
  yesBtn.addEventListener('click', () => {
    if (yesBtn.disabled) return;
    cancelBtn.disabled = true; yesBtn.disabled = true;
    confirmText.textContent = '退出中…';
    Promise.resolve(mem0.tray.quit()).catch(() => { resetConfirm(); });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (confirming()) resetConfirm(); else mem0.tray.hide();
  });
  if (mem0.tray.onReset) mem0.tray.onReset(resetConfirm);

  // 显示握手：等 2 帧（最多 60ms）让最新数据排版完成，量面板高度回给主进程
  if (mem0.tray.onPrepare) mem0.tray.onPrepare((p) => {
    const token = p && p.token;
    let done = false;
    const reply = () => {
      if (done) return; done = true;
      const hgt = Math.ceil(panel.getBoundingClientRect().height);
      if (hgt) lastH = hgt;
      mem0.tray.ready(token, hgt);
    };
    const raf = (f) => (typeof window.requestAnimationFrame === 'function' ? window.requestAnimationFrame(f) : setTimeout(f, 16));
    raf(() => raf(reply));
    setTimeout(reply, 60);
  });

  const refresh = () => Promise.resolve(mem0.tray.state()).then(render).catch(() => {});
  mem0.tray.onState(render);
  if (mem0.onMcpCalls) mem0.onMcpCalls((p) => setMcp(p && p.today));
  window.addEventListener('focus', refresh);
  refresh();
})();
