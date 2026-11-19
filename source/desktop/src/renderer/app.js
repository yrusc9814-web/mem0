'use strict';
/* global mem0, mem0Theme, icon, sourceLogo, brandMark */
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
// 注意 CSP：style-src 'self' 禁止 style="" 属性字符串；动态样式一律通过 el.style（CSSOM）或类名设置
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'style') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return el;
};
/** 安全替换子节点：跳过 null / undefined / false，避免原生 replaceChildren 把它们渲染成裸文字 "null" */
const fill = (el, ...kids) => {
  el.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false).map((k) => (k instanceof Node ? k : String(k))));
  return el;
};

// ---------- 来源 ----------
// [显示名, 图例色]。色板偏暖，避免冷蓝灰把纸感弄脏
const SOURCES = window.MEM0_SOURCES; // 定义在 common.js（与托盘小窗共用）
const srcName = (id) => (SOURCES[id] || [id])[0];
const srcColor = (id) => (SOURCES[id] || [0, '#A29E92'])[1];
const isWeb = (id) => /-web$/.test(id || '');

/** 来源标签组件：插件来源（*-web）名字后内联一枚线性地球；本机来源纯文字 */
function srcLabel(id, cls = '') {
  return h('span', { class: `src-label ${isWeb(id) ? 'web' : 'local'} ${cls}`.trim() }, h('span', { class: 'src-name' }, srcName(id)), isWeb(id) ? icon('globe', 'globe') : null);
}
/** 白底圆角品牌图标框。size: lg 36 / (默认) 30 / md 28 / sm 24 / xs 18 */
const av = (id, size = '') => h('span', { class: `av ${size}`.trim(), title: srcName(id), 'data-source': id }, sourceLogo(id));

const CLIENT_STATUS = { connected: ['已连接', 'ok'], stale: ['配置过期', 'warn'], not_connected: ['未连接', ''], not_installed: ['未检测到', ''] };
const nf = new Intl.NumberFormat('zh-CN');

// ---------- 时间 ----------
const startOfDay = (d = new Date()) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
const hm = (ms) => new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
function dayLabel(ms) {
  const t0 = startOfDay();
  if (ms >= t0) return '今天';
  if (ms >= t0 - 864e5) return '昨天';
  const d = new Date(ms);
  return d.getFullYear() === new Date().getFullYear() ? `${d.getMonth() + 1}月${d.getDate()}日` : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}
function shortTime(ms) {
  if (!ms) return '';
  const t0 = startOfDay();
  if (ms >= t0) return hm(ms);
  if (ms >= t0 - 864e5) return `昨天 ${hm(ms)}`;
  const d = new Date(ms);
  return d.getFullYear() === new Date().getFullYear() ? `${d.getMonth() + 1}/${d.getDate()}` : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}
const fullTime = (ms) => (ms ? `${dayLabel(ms)} ${hm(ms)}` : '');

// ---------- 复制反馈 ----------
function flashCopied(btn, text) {
  return async (e) => {
    if (e) e.stopPropagation();
    await mem0.copy(typeof text === 'function' ? text() : text);
    btn.classList.add('done');
    clearTimeout(btn._t);
    btn._t = setTimeout(() => btn.classList.remove('done'), 1400);
  };
}
/** 图标复制按钮：copy ↔ check 两枚图标由 CSS 根据 .done 切换 */
function copyIconBtn(cls, title, text) {
  const b = h('button', { class: `copy-ico ${cls}`, type: 'button', title, 'aria-label': title }, icon('copy', 'i-copy'), icon('check', 'i-check'));
  b.addEventListener('click', flashCopied(b, text));
  return b;
}

// ---------- 文本 / 轻量安全 Markdown ----------
// 全程只用 createElement / 文本节点构造 DOM，从不把消息内容当作 HTML 解析 → 杜绝注入
function highlight(text, terms) {
  const frag = document.createDocumentFragment();
  if (!terms || !terms.length) { frag.append(text); return frag; }
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  text.split(re).forEach((part, i) => { if (part) frag.append(i % 2 ? h('mark', {}, part) : part); });
  return frag;
}
/** 行内：`code`、**加粗**、[文字](https://链接)；其余原样（含搜索高亮） */
function inline(text, terms) {
  const frag = document.createDocumentFragment();
  const re = /(`+)([^`\n]+?)\1|\*\*(?=\S)([^*\n]+?)\*\*|\[([^\]\n]+)\]\(([^)\s]+)\)/g;
  let last = 0; let m;
  while ((m = re.exec(text))) {
    if (m.index > last) frag.append(highlight(text.slice(last, m.index), terms));
    if (m[2] !== undefined) frag.append(h('code', {}, highlight(m[2], terms)));
    else if (m[3] !== undefined) frag.append(h('strong', {}, inline(m[3], terms)));
    else {
      const url = m[5];
      if (/^https:\/\//i.test(url)) {
        frag.append(h('a', { class: 'md-link', href: url, title: url, rel: 'noreferrer', onclick: (e) => { e.preventDefault(); mem0.openUrl(url); } }, highlight(m[4], terms)));
      } else {
        frag.append(highlight(m[0], terms)); // 非 https 链接（javascript:、file: 等）只当普通文字，惰性不可点
      }
    }
    last = re.lastIndex;
  }
  if (last < text.length) frag.append(highlight(text.slice(last), terms));
  return frag;
}
function codeBlock(code, lang, terms) {
  const pre = h('pre', { class: 'code' }, highlight(code, terms));
  if (lang) pre.dataset.lang = lang;
  const wrap = h('div', { class: 'codeblock' }, pre, copyIconBtn('code-copy', '复制代码', code));
  return wrap;
}
/** Markdown 块级：标题 h1–h4、无序/有序列表、引用、分割线、段落 */
function mdBlocks(text, terms) {
  const frag = document.createDocumentFragment();
  const lines = text.split('\n');
  let para = [];
  const flush = () => { if (para.length) { frag.append(h('p', {}, inline(para.join('\n'), terms))); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    let m;
    if (!ln.trim()) { flush(); continue; }
    if ((m = /^(#{1,4})\s+(.*)$/.exec(ln))) { flush(); frag.append(h(`h${m[1].length}`, { class: 'md-h' }, inline(m[2].replace(/\s+#+\s*$/, ''), terms))); continue; }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(ln)) { flush(); frag.append(h('hr')); continue; }
    if (/^\s{0,3}>/.test(ln)) {
      flush(); const buf = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) { buf.push(lines[i].replace(/^\s{0,3}>\s?/, '')); i++; }
      i--; frag.append(h('blockquote', {}, mdBlocks(buf.join('\n'), terms))); continue;
    }
    const ul = /^(\s*)[-*+]\s+(.*)$/; const ol = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
    if (ul.test(ln) || ol.test(ln)) {
      flush();
      const ordered = !ul.test(ln);
      const list = h(ordered ? 'ol' : 'ul');
      if (ordered) { const start = Number(ol.exec(ln)[2]); if (start !== 1) list.setAttribute('start', String(start)); }
      let li = null;
      while (i < lines.length) {
        const cur = lines[i];
        const mm = ordered ? ol.exec(cur) : ul.exec(cur);
        if (mm) { li = h('li', {}, inline(ordered ? mm[3] : mm[2], terms)); list.append(li); i++; continue; }
        if (li && /^\s{2,}\S/.test(cur)) { li.append('\n', inline(cur.trim(), terms)); i++; continue; } // 续行
        break;
      }
      i--; frag.append(list); continue;
    }
    para.push(ln);
  }
  flush();
  return frag;
}
/** 正文：``` 代码块单独排版；markdown=true 时其余按轻量 Markdown 排版（AI 回复），否则保持原文（用户提问） */
function renderBody(text, terms, markdown = true) {
  const frag = document.createDocumentFragment();
  const re = /```([\w+#.-]*)[^\n]*\n([\s\S]*?)\n?```/g;
  let last = 0; let m;
  const prose = (t) => (markdown ? mdBlocks(t, terms) : h('p', {}, highlight(t.replace(/^\n+|\n+$/g, ''), terms)));
  while ((m = re.exec(text))) {
    if (m.index > last) frag.append(prose(text.slice(last, m.index)));
    frag.append(codeBlock(m[2], m[1], terms));
    last = re.lastIndex;
  }
  if (last < text.length) frag.append(prose(text.slice(last)));
  return frag;
}

// ---------- 状态 ----------
let state = null;
let lastSync = 0;
let current = null;
let query = '';
let view = 'home';
const selected = new Set(); // 来源筛选：空集合 = 全部来源
// 记忆页 / 事项 / AI 整理等 0.6.0 新能力由 memory.js 挂到 window.mem0Ext（单测只跑本文件时为空，全部可选）
const ext = () => window.mem0Ext || null;

// ---------- 浮层通用：点击外部 / Esc 关闭 ----------
const openPops = new Set();
function closePop(p) { if (p && p.close) p.close(); }
document.addEventListener('mousedown', (e) => { for (const p of [...openPops]) if (!p.root.contains(e.target)) closePop(p); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') for (const p of [...openPops]) { closePop(p); if (p.focusBack) p.focusBack.focus(); } });

// ---------- 导航 ----------
function show(v) {
  view = v;
  $$('.view').forEach((e) => e.classList.toggle('on', e.id === `view-${v}`));
  $$('.nav').forEach((e) => e.classList.toggle('on', e.dataset.view === v));
  $('#btn-settings').classList.toggle('on', v === 'settings');
  if (v === 'records') renderList();
  if (v === 'memory' && ext()) ext().renderMemory();
  reportNav();
}
// 上报当前页面/会话给主进程：主窗口被销毁重建后按它恢复（主进程只记这一个变量）
function reportNav() { if (mem0.reportNav) mem0.reportNav({ view, conversationId: current || '' }); }
$$('.nav').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));
$('#btn-settings').addEventListener('click', () => show(view === 'settings' ? 'home' : 'settings'));
function showTab(t) {
  $$('.tab').forEach((e) => e.classList.toggle('on', e.dataset.tab === t));
  $$('.tabpane').forEach((e) => e.classList.toggle('on', e.id === `tab-${t}`));
}
$$('.tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
$('#card-backup').addEventListener('click', () => { show('connect'); showTab('sources'); });
$('#card-mcp').addEventListener('click', () => { show('connect'); showTab('mcp'); });
$('#btn-all').addEventListener('click', () => show('records'));

// ---------- 主题 ----------
function renderTheme() {
  const dark = document.documentElement.dataset.theme === 'dark';
  const b = $('#btn-theme');
  fill(b, icon(dark ? 'sun' : 'moon'));
  b.title = dark ? '切换到浅色' : '切换到深色';
  $$('#theme-seg button').forEach((x) => x.classList.toggle('on', x.dataset.themeOpt === mem0Theme.get()));
}
$('#btn-theme').addEventListener('click', () => { mem0Theme.toggle(); renderTheme(); });
$$('#theme-seg button').forEach((x) => x.addEventListener('click', () => { mem0Theme.set(x.dataset.themeOpt); renderTheme(); }));
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => setTimeout(renderTheme));

// ---------- 首页 ----------
/** 百分比（最大余数法，合计恰为 100；非零项至少 1%） */
function percents(nums) {
  const sum = nums.reduce((a, b) => a + b, 0) || 1;
  const raw = nums.map((n) => (n / sum) * 100);
  const out = raw.map((x, i) => (nums[i] ? Math.max(1, Math.floor(x)) : 0));
  let left = 100 - out.reduce((a, b) => a + b, 0);
  const order = raw.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; left > 0 && k < order.length; k++, left--) out[order[k][1]]++;
  for (let k = order.length - 1; left < 0 && k >= 0; k--) { const i = order[k][1]; if (out[i] > 1) { out[i]--; left++; } }
  return out;
}
function legendItem(id, pct) {
  return h('span', { class: 'lg', 'data-source': id }, h('i', { class: 'sw', style: { background: srcColor(id) } }), srcLabel(id), h('span', { class: 'pct' }, `${pct}%`));
}
function renderLegend(entries) {
  const legend = $('#storage-legend');
  if (!entries.length) { fill(legend, h('span', { class: 'sub' }, '还没有备份的对话')); return; }
  const pcts = percents(entries.map((e) => e[1]));
  const items = entries.map(([id], i) => [id, pcts[i]]);
  const top = items.slice(0, 4).map(([id, p]) => legendItem(id, p));
  const rest = items.slice(4);
  if (!rest.length) { fill(legend, ...top); return; }
  const pop = h('div', { class: 'pop legend-pop', role: 'tooltip', id: 'legend-more-pop' },
    ...rest.map(([id, p]) => h('div', { class: 'lp-row', 'data-source': id }, h('i', { class: 'sw', style: { background: srcColor(id) } }), srcLabel(id), h('span', { class: 'pct' }, `${p}%`))));
  const more = h('span', { class: 'lg-more-wrap' },
    h('button', { class: 'lg-more', type: 'button', 'aria-describedby': 'legend-more-pop', title: `另外 ${rest.length} 个来源` }, `+${rest.length}`), pop);
  fill(legend, ...top, more);
}

/** 今日 MCP 被读取次数（主进程实时推送 + 每次 state 刷新） */
function renderMcpToday(n) {
  const el = $('#mcp-today-n');
  if (el) el.textContent = nf.format(Math.max(0, Number(n) || 0));
}
async function renderHome() {
  const s = state; const st = s.stats;
  $('#today-convs').textContent = nf.format(st.today);
  $('#today-msgs').textContent = st.todayMessages ? `个对话更新，新增 ${nf.format(st.todayMessages)} 条消息` : '个对话有更新';
  const localOn = s.localSources.filter((x) => x.enabled && x.found).length;
  const plugin = s.bridge.connected ? '插件在线' : s.bridge.paired ? '插件离线' : '插件未配对';
  $('#backup-sub').textContent = `${localOn} 个本机来源在备份 · ${plugin}`;

  const connected = s.clients.filter((c) => c.status === 'connected');
  const flow = $('#mcp-flow');
  const sideA = connected[0] ? connected[0].id : s.clients[0] && s.clients[0].id;
  const sideB = connected[1] ? connected[1].id : s.clients[1] && s.clients[1].id;
  const ln = (dir) => h('span', { class: `ln ${dir}` }, h('i', { class: 'flow-dot' }));
  fill(flow, 
    sideA ? av(sideA, 'sm') : '', ln('l'), h('span', { class: 'hub' }, brandMark()), ln('r'), sideB ? av(sideB, 'sm') : '',
    h('span', { class: 'go' }, connected.length ? '管理 ›' : '一键连接 ›'));
  renderMcpToday(s.mcpCallsToday);
  $('#mcp-sub').textContent = s.services.mcp.starting ? '本地 MCP 启动中…' : !s.services.mcp.ok ? `本地 MCP 未启动：${s.services.mcp.error || '未知原因'}`
    : connected.length ? `本地 MCP 运行中，${connected.map((c) => c.label).join('、')} 可按需读写你的记忆与历史对话`
      : '本地 MCP 运行中，连接后 Claude Code、Codex 等可按需读写你的记忆与历史对话';

  $('#total-msgs').textContent = nf.format(st.messages);
  $('#total-convs').textContent = `条消息 · ${nf.format(st.total)} 个对话`;
  const entries = Object.entries(st.messagesBySource || {}).filter((e) => e[1] > 0).sort((a, b) => b[1] - a[1]);
  fill($('#storage-bar'), ...entries.map(([id, n]) => h('i', { title: `${srcName(id)} ${nf.format(n)}`, 'data-source': id, style: { flex: String(n), background: srcColor(id) } })));
  renderLegend(entries);

  const rows = await mem0.list({ limit: 6 });
  const tl = $('#timeline');
  fill(tl, ...(rows.length ? rows.map((r) => h('div', { class: 'row', onclick: () => { show('records'); openConversation(r.id, []); } },
    av(r.source),
    h('div', { class: 'main' }, h('div', { class: 't' }, r.title || '(无标题)'), h('div', { class: 'sub' }, srcLabel(r.source), h('span', { class: 'dotsep' }, '·'), h('span', {}, `共 ${nf.format(r.message_count)} 条消息`))),
    h('div', { class: 'time' }, shortTime(r.updated_at)))) : [h('div', { class: 'empty' }, '还没有备份的对话。打开「连接」看看哪些来源已检测到。')]));
}
$('#home-q').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target.value.trim()) return;
  $('#q').value = e.target.value.trim(); query = $('#q').value; e.target.value = '';
  show('records');
});

// ---------- 来源筛选菜单 ----------
const filterPop = {
  root: $('#srcfilter'), focusBack: $('#filter-btn'),
  open() { $('#filter-menu').classList.remove('hidden'); $('#filter-btn').setAttribute('aria-expanded', 'true'); $('#filter-btn').classList.add('open'); openPops.add(this); },
  close() { $('#filter-menu').classList.add('hidden'); $('#filter-btn').setAttribute('aria-expanded', 'false'); $('#filter-btn').classList.remove('open'); openPops.delete(this); },
  get isOpen() { return !$('#filter-menu').classList.contains('hidden'); },
};
$('#filter-btn').addEventListener('click', () => { if (filterPop.isOpen) filterPop.close(); else { renderFilter(); filterPop.open(); const f = $('#filter-menu .mi'); if (f) f.focus({ preventScroll: true }); } });
$('#filter-menu').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const items = [...$$('#filter-menu .mi')]; const i = items.indexOf(document.activeElement);
  const n = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]; if (n) n.focus();
});
function filterLabel() {
  if (!selected.size) return '全部来源';
  const ids = [...selected];
  return ids.length === 1 ? srcName(ids[0]) : `${srcName(ids[0])} 等 ${ids.length} 个来源`;
}
function renderFilter() {
  const by = state.stats.bySource || {};
  const have = Object.keys(by).filter((id) => by[id] > 0);
  for (const id of [...selected]) if (!have.includes(id)) selected.delete(id); // 来源被删空时自动移出筛选
  const localIds = state.localSources.map((x) => x.id);
  const local = have.filter((id) => !isWeb(id)).sort((a, b) => (localIds.indexOf(a) + 1 || 99) - (localIds.indexOf(b) + 1 || 99) || by[b] - by[a]);
  const web = have.filter(isWeb).sort((a, b) => by[b] - by[a]);
  const row = (id, label, logo, count, on, fn) => h('button', { class: `mi ${on ? 'on' : ''}`, type: 'button', role: 'option', 'aria-selected': on ? 'true' : 'false', 'data-source': id || '', onclick: fn },
    h('span', { class: 'ck' }, on ? icon('check') : null), h('span', { class: 'lg-ico' }, logo), h('span', { class: 'mi-main' }, label, count !== null ? h('span', { class: 'ct' }, nf.format(count)) : null));
  const toggleSrc = (id) => () => { if (selected.has(id)) selected.delete(id); else selected.add(id); applyFilter(); };
  const out = [row('', h('span', { class: 'src-name' }, '全部来源'), icon('layers', 'all-ico'), Object.values(by).reduce((a, b) => a + b, 0), !selected.size, () => { selected.clear(); applyFilter(); })];
  if (local.length) out.push(h('div', { class: 'sep', role: 'separator' }), h('div', { class: 'gh' }, '本机'), ...local.map((id) => row(id, srcLabel(id), sourceLogo(id), by[id], selected.has(id), toggleSrc(id))));
  if (web.length) out.push(h('div', { class: 'sep', role: 'separator' }), h('div', { class: 'gh' }, '浏览器插件'), ...web.map((id) => row(id, srcLabel(id), sourceLogo(id), by[id], selected.has(id), toggleSrc(id))));
  const focusedId = document.activeElement && document.activeElement.closest && document.activeElement.closest('#filter-menu') ? document.activeElement.dataset.source : null;
  fill($('#filter-menu'), ...out);
  if (focusedId !== null) { const f = $(`#filter-menu .mi[data-source="${CSS.escape(focusedId)}"]`); if (f) f.focus({ preventScroll: true }); }
  $('#filter-label').textContent = filterLabel();
  $('#filter-btn').classList.toggle('active', selected.size > 0);
}
function applyFilter() { renderFilter(); renderList(); }

// ---------- 记录 ----------
let listSeq = 0;
const liRow = (id, source, title, time, onclick, snip) => h('div', { class: `li ${current === id ? 'on' : ''}`, 'data-id': id, 'data-source': source, onclick },
  h('div', { class: 'r1' }, av(source, 'sm'), h('div', { class: 'tt' }, title || '(无标题)'),
    isWeb(source) ? h('span', { class: 'web-mark', title: '浏览器插件' }, icon('globe', 'globe')) : null,
    h('div', { class: 'tm' }, shortTime(time))),
  snip || null);
async function renderList() {
  const seq = ++listSeq;
  const sources = selected.size ? [...selected] : undefined;
  const terms = query.split(/\s+/).filter(Boolean);
  const list = $('#list');
  const out = [];
  if (query) {
    const results = await mem0.search(query, { sources, limit: 50 });
    if (seq !== listSeq) return;
    if (!results.length) out.push(h('div', { class: 'empty' }, '没有找到相关对话'));
    else out.push(h('div', { class: 'grp' }, `找到 ${results.length} 个对话`));
    for (const r of results) {
      out.push(liRow(r.conversationId, r.source, r.title, r.updatedAt, () => openConversation(r.conversationId, terms),
        r.hits[0] ? h('div', { class: 'snip' }, highlight(r.hits[0].snippet, terms)) : null));
    }
  } else {
    const rows = await mem0.list({ sources, limit: 300 });
    if (seq !== listSeq) return;
    if (!rows.length) out.push(h('div', { class: 'empty' }, '还没有备份的对话'));
    const x = ext();
    const rowOf = (r) => liRow(r.id, r.source, r.title, r.updated_at, () => openConversation(r.id, []), x ? x.liSub(r) : null);
    if (x && rows.length && x.recMode() === 'project') out.push(...x.projectGroups(rows, rowOf));
    else {
      let g = '';
      for (const r of rows) {
        const d = dayLabel(r.updated_at || 0);
        if (d !== g) { g = d; out.push(h('div', { class: 'grp' }, d)); }
        out.push(rowOf(r));
      }
    }
    if (x) x.listCount(rows.length);
  }
  fill(list, ...out);
}

// ---------- 会话详情分页 ----------
// 打开详情只读最近一页；往上滚再补前一页，避免长会话一次性把全文读进内存
const DETAIL_PAGE = 200;
const DETAIL_NEAR_TOP = 80;
/** 已加载首条 seq 之前的上一页区间；已到顶返回 null */
function prevPageRange(firstSeq, page = DETAIL_PAGE) {
  if (!(firstSeq > 0)) return null;
  const fromSeq = Math.max(0, firstSeq - page);
  return { fromSeq, limit: firstSeq - fromSeq };
}
/** 一条消息的纯文本（与详情页排版一致：## 我 / ## AI） */
const messageText = (m) => `## ${m.role === 'user' ? '我' : 'AI'}\n\n${m.content}`;
/** 复制全文：点击时才分页取完再拼接，不在打开详情时预先拼好 */
async function readFullText(id) {
  const parts = [];
  let fromSeq = 0;
  let total = Infinity;
  while (fromSeq < total) {
    const page = await mem0.read(id, { fromSeq, limit: DETAIL_PAGE });
    if (!page || !page.messages || !page.messages.length) break;
    parts.push(...page.messages);
    const last = page.messages[page.messages.length - 1];
    const next = last.seq === undefined ? fromSeq + page.messages.length : last.seq + 1;
    if (next <= fromSeq) break; // 防御：seq 不前进就不再来回读
    fromSeq = next;
    total = Number(page.message_count) || Infinity;
  }
  return parts.map(messageText).join('\n\n');
}

// ---------- 会话详情 ----------
let outlineCleanup = null;
function workspaceTip(path) {
  const btnCopy = h('button', { class: 'ws-path', type: 'button', title: '点击复制路径' }, h('span', { class: 'mono' }, path), icon('copy', 'i-copy'), icon('check', 'i-check'));
  btnCopy.addEventListener('click', flashCopied(btnCopy, path));
  return h('span', { class: 'ws-tip' },
    h('button', { class: 'ws-btn', type: 'button', 'aria-label': '工作区路径', 'aria-describedby': 'ws-pop' }, icon('help')),
    h('span', { class: 'pop ws-pop', id: 'ws-pop', role: 'tooltip' }, btnCopy));
}
function pluginPill() {
  return h('span', { class: 'plugin-pill' }, '由', h('span', { class: 'pp-in' }, brandMark('pp-mark'), '浏览器插件'), '存下');
}
function buildOutline(scroller, qs) {
  const ticks = h('div', { class: 'qo-ticks' });
  const listEl = h('div', { class: 'qo-list' });
  const panel = h('div', { class: 'pop qo-panel', role: 'navigation', 'aria-label': '提问目录' }, h('div', { class: 'qo-title' }, '提问目录'), listEl);
  const outline = h('div', { class: 'question-outline' }, ticks, panel);
  const go = (el) => el.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  const rows = qs.map(({ el, text }, i) => {
    ticks.append(h('i', { class: 'tick' }));
    const preview = text.replace(/\s+/g, ' ').trim() || '(空)';
    const r = h('button', { class: 'qo-row', type: 'button', title: preview.slice(0, 200), onclick: () => go(el) }, h('span', { class: 'n' }, String(i + 1)), h('span', { class: 't' }, preview));
    listEl.append(r);
    return r;
  });
  // 刻度过多时压缩间距，保证整条刻度栏不超过视口的 60%
  const gap = Math.max(2, Math.min(8, Math.floor((window.innerHeight * 0.6) / qs.length) - 2));
  ticks.style.gap = `${gap}px`;
  let active = -1;
  const setActive = (i) => {
    if (i === active) return;
    if (active >= 0) { ticks.children[active].classList.remove('on'); rows[active].classList.remove('on'); }
    active = i;
    if (i >= 0) { ticks.children[i].classList.add('on'); rows[i].classList.add('on'); if (!outline.matches(':hover')) rows[i].scrollIntoView({ block: 'nearest' }); }
  };
  const spy = () => {
    const line = scroller.getBoundingClientRect().top + scroller.clientHeight * 0.33;
    let idx = 0;
    for (let i = 0; i < qs.length; i++) if (qs[i].el.getBoundingClientRect().top <= line) idx = i;
    if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) {
      // 滚到底部：最后一个已进入视口的提问
      for (let i = qs.length - 1; i >= 0; i--) if (qs[i].el.getBoundingClientRect().top < scroller.getBoundingClientRect().bottom) { idx = Math.max(idx, i); break; }
    }
    setActive(idx);
  };
  let raf = 0;
  const onScroll = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; spy(); }); };
  scroller.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  raf = requestAnimationFrame(() => { raf = 0; spy(); });
  // 清理时同时取消待执行的一帧，避免删除会话后回调还碰旧 DOM
  outlineCleanup = () => {
    scroller.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onScroll);
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
  };
  return outline;
}

async function openConversation(id, terms) {
  current = id;
  reportNav();
  $$('.li').forEach((x) => x.classList.toggle('on', x.dataset.id === id));
  // 先取最近 200 条；更早的在滚动到顶部附近时按页补
  const conv = await mem0.read(id, { tail: DETAIL_PAGE });
  const pane = $('#detail');
  if (outlineCleanup) { outlineCleanup(); outlineCleanup = null; }
  const scroller = h('div', { class: 'scroller', id: 'scroller' });
  if (!conv) { scroller.append(h('div', { class: 'empty' }, '会话已被删除')); fill(pane, scroller); return; }
  const web = isWeb(conv.source);
  const actBtn = (name, title, fn) => h('button', { class: 'icon-btn', title, 'aria-label': title, onclick: fn }, icon(name));
  const sep = () => h('span', { class: 'dotsep' }, '·');
  // v4 部件（memory.js）：事项胶囊内联在 meta 行；会话摘要无内容时不渲染；手动修改只在库里静默锁定，界面无锁标
  const parts = ext() ? ext().detailParts(conv) : null;
  const hasNote = Boolean(parts && parts.hasNote);
  const copyLabel = hasNote ? '复制摘要与全文' : '复制全文';
  const copyBtn = h('button', { class: 'head-copy-btn', type: 'button', title: copyLabel }, icon('copy'), h('span', {}, copyLabel));
  let copying = false;
  copyBtn.addEventListener('click', async () => {
    if (copying) return;
    copying = true;
    try {
      // 点击时才分页取全文拼接，不在打开详情时预先拼好
      const full = await readFullText(id);
      // 有会话摘要时在顶部附标题与摘要；无摘要保持原有纯 ## 我 / ## AI 格式
      const sum = String(conv.summary || '').trim();
      await mem0.copy(sum ? `# ${conv.title || '(无标题)'}\n\n> 摘要：${sum}\n\n${full}` : full);
      copyBtn.classList.add('done'); copyBtn.lastChild.textContent = '已复制';
      setTimeout(() => { copyBtn.classList.remove('done'); copyBtn.lastChild.textContent = copyLabel; }, 1500);
    } finally { copying = false; }
  });
  const origTitle = conv.original_title && conv.original_title !== conv.title ? conv.original_title : '';
  const track = h('div', { class: 'track thread' },
    h('div', { class: 'detail-head' },
      h('div', { class: 'detail-title-col' },
        h('h1', {}, conv.title || '(无标题)'),
        origTitle ? h('div', { class: 'orig-prompt', title: `原始首句：${origTitle}` }, `原首句：${origTitle}`) : null),
      h('div', { class: 'detail-actions' },
        copyBtn,
        parts ? actBtn('edit', hasNote ? '编辑标题与会话摘要' : '修改标题 / 添加会话摘要', parts.toggleEdit) : null,
        conv.url ? actBtn('external', '打开原网页', () => mem0.openUrl(conv.url)) : null,
        actBtn('trash', '删除这条备份', async () => {
          // 确认框由主进程（dialog.showMessageBox）弹出，这里不再重复 confirm
          if (await mem0.remove(id)) {
            current = null; reportNav();
            // 替换详情 DOM 之前先解绑大纲（含待执行的一帧）
            if (outlineCleanup) { outlineCleanup(); outlineCleanup = null; }
            fill(pane, h('div', { class: 'scroller' }, h('div', { class: 'empty' }, '已删除'))); state = await mem0.state(); renderAll(); renderList();
          }
        }))),
    h('div', { class: 'meta' }, av(conv.source, 'xs'), srcLabel(conv.source), sep(),
      h('span', {}, `${web ? '上次抓取' : '上次活动'} ${fullTime(conv.updated_at)}`), sep(),
      h('span', {}, `${nf.format(conv.message_count)} 条消息`),
      parts ? parts.projectChip : null,
      web ? pluginPill() : null,
      conv.workspace ? workspaceTip(conv.workspace) : null),
    parts ? parts.summaryCard : null,
    parts ? parts.denoiseBar : null);
  let firstHit = null;
  const qs = [];
  const msgNode = (m) => {
    const role = m.role === 'user' ? 'user' : 'assistant';
    const body = h('div', { class: 'body' }, renderBody(m.content, terms, role !== 'user'));
    const el = h('div', { class: `msg ${role}` }, body);
    if (role === 'user') el.append(h('div', { class: 'msg-foot' }, m.created_at ? h('span', { class: 'tm' }, fullTime(m.created_at)) : null, copyIconBtn('msg-copy', '复制这条提问', m.content)));
    else if (m.created_at) el.title = fullTime(m.created_at);
    if (!firstHit && terms.length && terms.some((t) => m.content.toLowerCase().includes(t.toLowerCase()))) { firstHit = el; el.classList.add('hit'); }
    return el;
  };
  let firstEl = null;
  for (const m of conv.messages) {
    const el = msgNode(m);
    if (m.role === 'user') qs.push({ el, text: m.content });
    track.append(el);
    if (!firstEl) firstEl = el;
  }
  // 大纲按已加载的消息建立；翻页补进更早的提问后重建，条目/刻度始终对齐
  let outlineEl = null;
  const refreshOutline = () => {
    if (outlineCleanup) { outlineCleanup(); outlineCleanup = null; }
    if (outlineEl) outlineEl.remove();
    outlineEl = qs.length >= 2 ? buildOutline(scroller, qs) : null;
    if (outlineEl) pane.append(outlineEl);
  };
  scroller.append(track);
  fill(pane, scroller);
  refreshOutline();
  // 长会话首屏只有最近一页：停在最新处，往上滚才够得着更早的消息；短会话仍从顶部开始
  let firstSeq = conv.messages.length ? conv.messages[0].seq : 0;
  if (firstHit) firstHit.scrollIntoView({ block: 'center' });
  else scroller.scrollTop = firstSeq > 0 ? scroller.scrollHeight : 0;

  // 分页：滚到顶部附近时补上一页，插入到顶部并保持当前滚动位置
  let loadingMore = false;
  const loadOlder = async () => {
    const range = prevPageRange(firstSeq, DETAIL_PAGE);
    if (!range || loadingMore) return false;
    loadingMore = true;
    try {
      const page = await mem0.read(id, range);
      if (current !== id || !page || !page.messages.length) return false;
      const before = scroller.scrollHeight;
      const anchor = firstEl; // 每条都插到原首条之前，升序页插入后仍是升序
      const olderUsers = [];
      let added = null;
      for (const m of page.messages) {
        const el = msgNode(m);
        track.insertBefore(el, anchor);
        if (!added) added = el;
        if (m.role === 'user') olderUsers.push({ el, text: m.content });
      }
      qs.unshift(...olderUsers); // 更早的提问排到大纲前面
      firstEl = added || anchor;
      firstSeq = page.messages[0].seq;
      // 顶部新增内容的高度补进 scrollTop：视觉上停在原处，不跳
      scroller.scrollTop += scroller.scrollHeight - before;
      refreshOutline();
      return true;
    } finally { loadingMore = false; }
  };
  scroller.addEventListener('scroll', () => {
    if (scroller.scrollTop <= DETAIL_NEAR_TOP && firstSeq > 0) loadOlder();
  }, { passive: true });
  // 从搜索结果打开：命中可能落在更早的页里，继续往前取直到找到（最多补到 2000 条，与分页前一致）
  if (terms.length) {
    (async () => {
      let loaded = conv.messages.length;
      while (!firstHit && firstSeq > 0 && loaded < 2000 && current === id) {
        if (!(await loadOlder())) break;
        loaded += DETAIL_PAGE;
      }
      if (firstHit && current === id) firstHit.scrollIntoView({ block: 'center' });
    })();
  }
}

let debounce = null;
$('#q').addEventListener('input', (e) => { clearTimeout(debounce); debounce = setTimeout(() => { query = e.target.value.trim(); renderList(); }, 200); });

// ---------- 连接 ----------
function toggle(on, fn, label) { return h('label', { class: 'switch', title: label }, h('input', { type: 'checkbox', checked: on, 'aria-label': label, onchange: (e) => fn(e.target.checked) }), h('span')); }
async function setSource(id, v) { state = await mem0.setSource(id, v); renderAll(); }

const UNDETECTED_DESC = '未检测到本地对话目录，需要先安装或完成 1 次对话';
let localFoldOpen = false; // 「未检测到」折叠区是否展开（重绘时保持）
function localRow(x, st, tb) {
  const t = tb[x.id];
  let desc; let cls = 'ds';
  if (x.error) { desc = x.error; cls = 'ds bad'; } else if (!x.enabled) desc = '已暂停备份';
  else if (t && (t.conversations || t.messages)) desc = `今天更新了 ${t.conversations} 个会话${t.messages ? `，存了 ${t.messages} 条消息` : ''}`;
  else desc = `今天还没有新消息 · 共 ${nf.format(st.bySource[x.id] || 0)} 个会话`;
  return h('div', { class: 'grow', title: x.root, 'data-source': x.id },
    av(x.id, 'md'), h('div', { class: 'grow-main' }, h('div', { class: 'nm' }, x.label), h('div', { class: cls }, desc)),
    h('div', { class: 'end' }, toggle(x.enabled, (v) => setSource(x.id, v), `备份 ${x.label}`)));
}
function undetectedRow(x) {
  // 弱化灰态：图标置灰 + 固定提示文案，右侧不渲染开关
  return h('div', { class: 'grow undetected', title: x.root, 'data-source': x.id },
    av(x.id, 'md'), h('div', { class: 'grow-main' }, h('div', { class: 'nm' }, x.label), h('div', { class: 'ds' }, UNDETECTED_DESC)));
}
function foldBtn(open, n) {
  const label = open ? '收起' : `未检测到 (${n})`;
  return h('button', { class: `grow fold-row ${open ? 'open' : ''}`, type: 'button', id: 'local-fold', 'aria-expanded': open ? 'true' : 'false', 'aria-controls': 'local-sources',
    onclick: () => { localFoldOpen = !localFoldOpen; renderLocalSources(); const f = $('#local-fold'); if (f) f.focus({ preventScroll: true }); } },
  h('span', { class: 'fold-text' }, label), icon(open ? 'up' : 'down', 'fold-chev'));
}
function renderLocalSources() {
  const s = state; const st = s.stats; const tb = st.todayBySource || {};
  const found = s.localSources.filter((x) => x.found);
  const missing = s.localSources.filter((x) => !x.found);
  const on = found.filter((x) => x.enabled).length;
  const cnt = $('#local-count');
  cnt.textContent = found.length ? `已打开 ${on} / ${found.length}` : '';
  const rows = found.map((x) => localRow(x, st, tb));
  if (missing.length) {
    if (localFoldOpen) rows.push(...missing.map(undetectedRow), foldBtn(true, missing.length));
    else rows.push(foldBtn(false, missing.length));
  }
  if (!rows.length) rows.push(h('div', { class: 'grow' }, h('div', { class: 'ds' }, '没有可用的本机来源')));
  fill($('#local-sources'), ...rows);
}

/** 帮助浮层定位：返回视口坐标，水平与垂直都夹在窗口内，下方放不下时翻到上方 */
function fitPopover(anchor, size, viewport, margin = 12) {
  const w = size.width || 0; const h = size.height || 0;
  let left = Math.min(anchor.left, viewport.width - margin - w);
  left = Math.max(margin, left);
  let top = anchor.bottom + 8;
  if (h && top + h > viewport.height - margin) top = anchor.top - h - 8;
  top = Math.max(margin, Math.min(top, viewport.height - margin - h));
  return { left, top };
}
/** 显示「一键连接」说明前重新定位（fixed 定位，不受滚动容器裁剪） */
function placeMcpHelp() {
  const wrap = $('#mcp-help-wrap'); const pop = $('#mcp-help-pop');
  if (!wrap || !pop || !wrap.getBoundingClientRect) return;
  const a = wrap.getBoundingClientRect();
  const vw = window.innerWidth || document.documentElement.clientWidth || 0;
  const vh = window.innerHeight || document.documentElement.clientHeight || 0;
  // 浮层隐藏时量不到尺寸：用 CSS 里的固定宽度与保守高度兜底
  const size = { width: pop.offsetWidth || 320, height: pop.offsetHeight || 200 };
  const pos = fitPopover({ left: a.left, top: a.top, bottom: a.bottom }, size, { width: vw, height: vh });
  pop.style.left = `${pos.left}px`;
  pop.style.top = `${pos.top}px`;
}
/** 显示 / 隐藏说明浮层（悬停、键盘聚焦都走这里；隐藏有延迟，鼠标从「？」移到浮层不会闪退） */
let mcpHelpTimer = null;
function showMcpHelp(on) {
  const head = $('#mcp-help-head');
  if (!head) return;
  clearTimeout(mcpHelpTimer);
  if (on) { head.classList.add('show'); placeMcpHelp(); return; } // 先显示再量尺寸，定位才准
  mcpHelpTimer = setTimeout(() => head.classList.remove('show'), 120);
}

function renderConnect() {
  const s = state; const st = s.stats; const tb = st.todayBySource || {};
  renderLocalSources();

  const b = s.bridge;
  const badge = $('#plugin-badge');
  badge.className = `badge ${b.connected ? 'ok' : b.paired ? 'warn' : ''}`;
  badge.textContent = b.connected ? '在线' : b.paired ? '离线' : '未配对';
  const webOn = s.webSources.filter((w) => w.enabled).length;
  const webToday = s.webSources.reduce((a, w) => a + ((tb[w.id] && tb[w.id].conversations) || 0), 0);
  $('#plugin-desc').textContent = s.services.bridge.starting ? '插件桥启动中…' : !s.services.bridge.ok ? `插件桥未启动：${s.services.bridge.error || '未知原因'}`
    : `${webOn} 个网站开启备份${b.paired ? ` · 今天存了 ${webToday} 个对话` : ' · 在浏览器插件里输入配对码即可连接'}`;
  $('#btn-pair').textContent = b.paired ? '配对新浏览器' : '配对';
  $('#btn-pair').classList.toggle('pri', !b.paired);
  $('#btn-pair').disabled = !s.services.bridge.ok;
  fill($('#web-sources'), ...s.webSources.map((w) => {
    const n = st.bySource[w.id] || 0; const t = tb[w.id];
    const desc = !w.enabled ? '已暂停备份' : t && t.conversations ? `今天存了 ${t.conversations} 个会话 · 共 ${nf.format(n)} 个` : n ? `共 ${nf.format(n)} 个会话` : '还没有备份的会话';
    return h('div', { class: `grow indent ${w.enabled ? '' : 'off'}`, 'data-source': w.id },
      av(w.id, 'md'), h('div', { class: 'grow-main' }, h('div', { class: 'nm' }, srcLabel(w.id)), h('div', { class: 'ds' }, desc)),
      h('div', { class: 'end' }, toggle(w.enabled, (v) => setSource(w.id, v), `备份 ${srcName(w.id)}`)));
  }));

  const mcpUrl = s.services.mcp.url || '';
  $('#mcp-url').textContent = mcpUrl || s.services.mcp.error || (s.services.mcp.starting ? '启动中' : '–');
  $('#btn-copy-mcp-url').disabled = !mcpUrl;
  // 说明浮层里的命令用与「复制」相同的带 token 地址；地址未就绪时只显示命令前缀
  const helpCmd = $('#mcp-help-cmd');
  if (helpCmd) helpCmd.textContent = mcpUrl ? `npx -y mcp-remote ${mcpUrl}` : 'npx -y mcp-remote';
  const helpHead = $('#mcp-help-head');
  if (helpHead && helpHead.classList.contains('show')) placeMcpHelp(); // 打开着就跟着重排，没打开不白算
  const mb = $('#mcp-badge');
  mb.className = `badge ${s.services.mcp.ok ? 'ok' : s.services.mcp.starting ? '' : 'bad'}`;
  mb.textContent = s.services.mcp.ok ? '运行中' : s.services.mcp.starting ? '启动中' : '未启动';
  fill($('#clients'), ...(s.clients.length ? s.clients.map((c) => {
    const [txt, cls] = CLIENT_STATUS[c.status] || [c.status, ''];
    const connected = c.status === 'connected';
    return h('div', { class: 'grow' },
      av(c.id, 'md'), h('div', { class: 'grow-main' }, h('div', { class: 'nm' }, c.label, h('span', { class: `badge ${cls}` }, txt)), h('div', { class: 'ds mono' }, c.file), c.note ? h('div', { class: 'ds' }, c.note) : ''),
      h('div', { class: 'end' }, connected
        ? h('button', { class: 'btn', onclick: async () => { state = await mem0.disconnectClient(c.id); renderAll(); } }, '断开')
        : h('button', { class: 'btn pri', onclick: async () => { state = await mem0.connectClient(c.id); renderAll(); } }, c.status === 'stale' ? '更新配置' : '一键连接')));
  }) : [h('div', { class: 'grow' }, h('div', { class: 'ds' }, 'MCP 服务未启动，暂时无法连接'))]));
  $('#manual-config').textContent = s.manualConfig || '–';
  $('#btn-copy-config').disabled = !s.manualConfig;
}

let pairTimer = null;
$('#btn-pair').addEventListener('click', async () => {
  const p = await mem0.pairCode();
  if (!p) return;
  const box = $('#pair');
  box.classList.remove('hidden');
  clearInterval(pairTimer);
  const tick = () => {
    const left = Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000));
    fill(box, h('div', { class: 'sub' }, '在 mem0 浏览器插件中输入配对码'), h('div', { class: 'code' }, p.code), h('div', { class: 'sub' }, left ? `${left} 秒后失效` : '已失效，请重新生成'));
    if (!left) clearInterval(pairTimer);
  };
  tick();
  pairTimer = setInterval(tick, 1000);
});
$('#btn-copy-config').addEventListener('click', async (e) => { await mem0.copy(state.manualConfig); e.target.textContent = '已复制'; setTimeout(() => { e.target.textContent = '复制配置'; }, 1500); });
// 复制带访问密钥的完整 MCP 地址（?token=…）
$('#btn-copy-mcp-url').addEventListener('click', async (e) => {
  const url = state.services.mcp.url;
  if (!url) return;
  await mem0.copy(url);
  e.target.textContent = '已复制';
  setTimeout(() => { e.target.textContent = '复制'; }, 1500);
});
// 「一键连接」旁的「？」：悬停或键盘聚焦显示说明，鼠标移入浮层/按钮时不收起
(() => {
  const head = $('#mcp-help-head');
  if (!head) return;
  head.addEventListener('mouseenter', () => showMcpHelp(true));
  head.addEventListener('mouseleave', () => showMcpHelp(false));
  head.addEventListener('focusin', () => showMcpHelp(true));
  head.addEventListener('focusout', (e) => { if (!head.contains(e.relatedTarget)) showMcpHelp(false); });
  const reflow = () => { if (head.classList.contains('show')) placeMcpHelp(); };
  window.addEventListener('resize', reflow);
  window.addEventListener('scroll', reflow, true); // 连接页滚动时浮层跟着「？」走
})();

// ---------- 设置 ----------
/** 轻提示：沿用记忆页 .toast 样式（设置页在 memory.js 闭包之外，这里单独实现一份） */
let toastTimer = null;
function toast(msg) {
  const old = document.querySelector('.toast');
  if (old) old.remove();
  clearTimeout(toastTimer);
  const el = h('div', { class: 'toast', role: 'status' }, h('span', {}, msg));
  document.body.append(el);
  toastTimer = setTimeout(() => el.remove(), 2200);
}

// 开机自动启动（AC1.4）：仅 Windows（state.autoLaunch.supported === true）渲染，非 Windows 完全不渲染该行
const AUTOLAUNCH_DESC = '开机后静默驻留托盘，自动备份对话并运行本地 MCP 服务';
let autoLaunchRow = null;
let autoLaunchInput = null;
function renderAutoLaunch() {
  const al = (state && state.autoLaunch) || {};
  const supported = al.supported === true;
  const hd = $('#settings-appearance-hd');
  if (hd) hd.textContent = supported ? '常规与外观' : '外观';
  const box = $('#settings-appearance');
  if (!box) return;
  if (!supported) {
    if (autoLaunchRow) { autoLaunchRow.remove(); autoLaunchRow = null; autoLaunchInput = null; }
    return;
  }
  if (!autoLaunchRow) {
    const sw = toggle(!!al.enabled, setAutoLaunch, '开机自动启动'); // 复用连接页的 .switch 开关
    autoLaunchInput = sw.children[0]; // toggle() 内的 <input type="checkbox">
    autoLaunchRow = h('div', { class: 'grow', id: 'autolaunch-row' },
      h('div', { class: 'grow-main' }, h('div', { class: 'nm' }, '开机自动启动'), h('div', { class: 'ds' }, AUTOLAUNCH_DESC)),
      h('div', { class: 'end' }, sw));
    box.insertBefore(autoLaunchRow, box.firstChild); // 同卡片内「主题」上方
  }
  autoLaunchInput.checked = !!al.enabled; // 只改勾选状态不重建节点：后台状态推送时不打断点击
}
/** 切换开机自启动：失败时开关回弹到后端最终状态，并 toast 后端返回的原因 */
async function setAutoLaunch(on) {
  let r = null;
  try { r = await mem0.setAutoLaunch(!!on); } catch (e) { toast(`设置失败：${(e && e.message) || e}`); }
  if (r && typeof r === 'object') {
    state = { ...state, autoLaunch: { supported: r.supported === true, enabled: r.enabled === true } };
    if (!r.ok) toast(r.reason || '设置失败，请稍后重试');
  }
  renderAutoLaunch();
}

function renderSettings() {
  $('#datadir').textContent = state.dataDir;
  $('#bridge-url').textContent = state.services.bridge.url || state.services.bridge.error || (state.services.bridge.starting ? '启动中' : '未启动');
  $('#version').textContent = `mem0 ${state.version} · 所有数据只保存在本机`;
  renderAutoLaunch();
}
$('#btn-datadir').addEventListener('click', () => mem0.openDataDir());
$('#btn-datadir-change').addEventListener('click', async (e) => {
  const b = e.currentTarget;
  if (b.disabled) return;
  b.disabled = true; b.textContent = '搬迁中…';
  try { await mem0.changeDataDir(); } catch { /* 主进程已弹窗说明 */ }
  // 成功会自动重启；取消或失败时恢复按钮
  b.disabled = false; b.textContent = '更改';
});
$('#btn-revoke').addEventListener('click', async () => {
  if (!window.confirm('断开所有已配对的浏览器插件？之后需要重新配对。')) return;
  state = await mem0.revokeExtensions(); renderAll();
});
async function rescan() {
  const btns = [$('#btn-rescan'), $('#btn-rescan2')];
  btns.forEach((b) => { b.disabled = true; });
  try { state = await mem0.rescan(); lastSync = Date.now(); renderAll(); if (view === 'records') renderList(); } finally { btns.forEach((b) => { b.disabled = false; }); }
}
$('#btn-rescan').addEventListener('click', rescan);
$('#btn-rescan2').addEventListener('click', rescan);

// ---------- 汇总 ----------
function renderSync() {
  const errs = state.localSources.filter((x) => x.enabled && x.error).length + (state.services.mcp.ok || state.services.mcp.starting ? 0 : 1) + (state.services.bridge.ok || state.services.bridge.starting ? 0 : 1);
  $('#sync-status').classList.toggle('warn', errs > 0);
  $('#sync-text').textContent = errs ? `${errs} 项异常` : `${hm(lastSync)} 已同步`;
  $('#sync-status').title = errs ? '打开「连接」或「设置」查看详情' : '后台实时备份中';
}
function renderAll() {
  renderSync(); renderFilter(); renderHome(); renderConnect(); renderSettings(); renderTheme();
  if (ext()) ext().renderAll();
}

mem0.onChanged((s) => {
  state = s; lastSync = Date.now(); renderAll();
  if (view === 'records') renderList();
  if (s.bridge.connected) { $('#pair').classList.add('hidden'); clearInterval(pairTimer); }
});

if (mem0.onMcpCalls) mem0.onMcpCalls((p) => { const n = p && p.today; if (state) state.mcpCallsToday = n; renderMcpToday(n); });
// 主题在托盘小窗 / 另一窗口里改了：theme.js 已重新套用，这里只刷新按钮图标
window.addEventListener('storage', () => setTimeout(renderTheme));

const ready = (async () => { state = await mem0.state(); lastSync = Date.now(); renderAll(); show('home'); })();

// 托盘小窗点某条最近活动 → 跳到「记录」页并打开该会话
async function navigateTo(nav) {
  await ready;
  if (!nav || nav.view !== 'records') { if (nav && nav.view) show(nav.view); return; }
  for (const p of [...openPops]) closePop(p);
  // 清掉搜索词，保证该会话出现在左侧列表里
  if (query) { query = ''; $('#q').value = ''; }
  show('records');
  if (nav.conversationId) await openConversation(nav.conversationId, []);
}
if (mem0.onNavigate) mem0.onNavigate((nav) => { navigateTo(nav); });
