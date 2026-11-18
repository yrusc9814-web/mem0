'use strict';
/* global mem0, icon, h, $, $$, state, av, srcName, nf, shortTime, fullTime, highlight, renderBody, flashCopied,
   show, openConversation, renderAll, renderList, query, openPops, closePop */
/**
 * mem0 0.6.0：记忆页、推进事项、记录页事项/备注、首页「正在推进」、设置页 AI 自动整理。
 * 全部数据经 window.mem0.* 异步 IPC 读写 SQLite；不含任何演示数据（空库就是 0 卡 0 事项）。
 * CSP：不写内联样式属性、内联事件或拼接 HTML，动态样式只走 el.style 或 class。
 */
(function () {
  const PITFALL = '踩坑与经验库';
  const NEW_PROJECT = '__new_project__';
  const ui = {
    recMode: localStorage.getItem('mem0.recMode') === 'project' ? 'project' : 'time',
    collapsedGroups: new Set(),
    memSel: { type: 'group', id: null },
    memQuery: '',
    showArchived: false,
    tagFilter: '全部',
    editing: null, // 正在编辑的卡片 id / 'new' / 'project'
    pasteOpen: false,
    pasteDrafts: null,
    settling: false,
    showSuperseded: new Set(),
    sessOpen: false,
    sumOpen: new Set(),
    sumEdit: null, // 记录页正在编辑标题与摘要的会话 id（与记忆页 editing 分开，互不阻塞刷新）
  };

  // ---------- 小工具 ----------
  const groups = () => (state && state.memoryGroups) || [];
  const memories = () => (state && state.memories) || [];
  const projects = () => (state && state.projects) || [];
  const activeProjects = () => projects().filter((p) => !p.archived).sort((a, b) => b.updatedAt - a.updatedAt);
  const projectById = (id) => projects().find((p) => p.id === id) || null;
  const groupMeta = (id) => groups().find((g) => g.id === id) || { id, icon: 'bulb', copyLabel: '复制本页' };
  const parseList = (v) => { if (Array.isArray(v)) return v; try { const x = JSON.parse(v || '[]'); return Array.isArray(x) ? x : []; } catch { return []; } };
  const lines = (text) => String(text || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const setState = (s) => { if (s && typeof s === 'object' && s.stats) { state = s; renderAll(); } }; // eslint-disable-line no-global-assign
  const btn = (cls, label, onclick, ico) => h('button', { class: cls, type: 'button', onclick }, ico ? icon(ico) : null, label);
  const field = (label, input) => h('label', { class: 'field' }, h('span', {}, label), input);
  const input = (value, placeholder) => { const el = h('input', { type: 'text', placeholder: placeholder || '' }); el.value = value || ''; return el; };
  const textarea = (value, placeholder, rows) => { const el = h('textarea', { placeholder: placeholder || '', rows: String(rows || 3) }); el.value = value || ''; return el; };

  let toastTimer = null;
  function toast(msg, undoFn) {
    const old = document.querySelector('.toast');
    if (old) old.remove();
    clearTimeout(toastTimer);
    const el = h('div', { class: 'toast', role: 'status' }, h('span', {}, msg),
      undoFn ? h('button', { class: 'toast-undo', type: 'button', onclick: () => { clearTimeout(toastTimer); el.remove(); undoFn(); } }, '撤销') : null);
    document.body.append(el);
    toastTimer = setTimeout(() => el.remove(), undoFn ? 5000 : 2200);
  }

  /** 点外部 / Esc 关闭的小浮层（复用 app.js 的 openPops） */
  function popover(anchorWrap, pop) {
    const ctl = {
      root: anchorWrap,
      open() { pop.classList.remove('hidden'); anchorWrap.classList.add('pop-open'); openPops.add(ctl); },
      close() { pop.classList.add('hidden'); anchorWrap.classList.remove('pop-open'); openPops.delete(ctl); },
      toggle() { if (pop.classList.contains('hidden')) ctl.open(); else ctl.close(); },
    };
    pop.classList.add('hidden');
    return ctl;
  }
  const menuItem = (label, onclick, ico, on) => h('button', { class: `mi ${on ? 'on' : ''}`, type: 'button', onclick },
    h('span', { class: 'ck' }, on ? icon('check') : (ico ? icon(ico) : null)), h('span', { class: 'mi-main' }, label));

  async function guarded(fn, okMsg) {
    try { const r = await fn(); if (okMsg) toast(okMsg); return r; } catch (e) { toast(`操作失败：${(e && e.message) || e}`); return null; }
  }

  // ---------- 记录页：按时间 / 按事项 ----------
  function syncModeSeg() { $$('#rec-mode-seg button').forEach((b) => b.classList.toggle('on', b.dataset.rmode === ui.recMode)); }
  $$('#rec-mode-seg button').forEach((b) => b.addEventListener('click', () => {
    ui.recMode = b.dataset.rmode === 'project' ? 'project' : 'time';
    localStorage.setItem('mem0.recMode', ui.recMode);
    syncModeSeg(); renderList();
  }));
  syncModeSeg();

  function liSub(r) {
    const sum = String(r.summary || '').trim();
    const p = r.project_id && ui.recMode === 'time' ? projectById(r.project_id) : null;
    if (!sum && !p) return null;
    return h('div', { class: 'li-sub' },
      p ? h('span', { class: 'mini-pill' }, icon('folder'), p.name) : null,
      sum ? h('span', { class: 'li-sub-txt' }, sum) : null);
  }

  function projectGroups(rows, rowOf) {
    const by = new Map();
    for (const r of rows) {
      const k = r.project_id && projectById(r.project_id) ? r.project_id : '';
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(r);
    }
    const order = [...projects().filter((p) => by.has(p.id)).sort((a, b) => (a.archived - b.archived) || (b.updatedAt - a.updatedAt)).map((p) => p.id)];
    if (by.has('')) order.push('');
    return order.map((k) => {
      const p = k ? projectById(k) : null;
      const collapsed = ui.collapsedGroups.has(k);
      const hd = h('button', { class: `pgrp-hd ${k ? '' : 'unassigned'} ${collapsed ? 'collapsed' : ''}`, type: 'button',
        onclick: () => { if (ui.collapsedGroups.has(k)) ui.collapsedGroups.delete(k); else ui.collapsedGroups.add(k); renderList(); } },
      icon(k ? 'folder' : 'inbox', 'f-ico'), h('span', { class: 'pgrp-name' }, p ? p.name : '未归入事项'),
      h('span', { class: 'pgrp-cnt' }, String(by.get(k).length)), icon('down', 'pgrp-chev'));
      return h('div', { class: 'pgrp-wrap' }, hd, collapsed ? null : h('div', { class: 'pgrp-items' }, ...by.get(k).map(rowOf)));
    });
  }
  function listCount(n) { const el = $('#rec-count-hint'); if (el) el.textContent = n ? `${nf.format(n)} 个` : ''; }

  // ---------- 记录页详情：事项胶囊 / 改标题 / 摘要卡 / 降噪提示 ----------
  async function updateMeta(conv, patch, msg) {
    const r = await guarded(() => mem0.updateConvMeta(conv.id, patch), msg);
    if (!r) return;
    setState(r.state);
    renderList();
    openConversation(conv.id, []);
  }

  function projectChip(conv) {
    const p = conv.project_id ? projectById(conv.project_id) : null;
    const wrap = h('span', { class: 'chip-wrap' });
    const newIn = input('', '新事项名称');
    const pop = h('div', { class: 'pop menu chip-pop' },
      ...activeProjects().map((x) => menuItem(x.name, () => { ctl.close(); updateMeta(conv, { projectId: x.id }, `已归入「${x.name}」`); }, 'folder', p && p.id === x.id)),
      p ? menuItem('移出事项', () => { ctl.close(); updateMeta(conv, { projectId: null }, '已移出事项'); }, 'close') : null,
      h('div', { class: 'sep', role: 'separator' }),
      h('div', { class: 'pop-inline-input' }, newIn, h('button', { type: 'button', onclick: async () => {
        const name = newIn.value.trim(); if (!name) return;
        ctl.close();
        const r = await guarded(() => mem0.saveProject({ name, state: '推进中', workspace: conv.workspace || null }));
        if (r && r.project) updateMeta(conv, { projectId: r.project.id }, `已新建并归入「${name}」`);
      } }, '新建')));
    const ctl = popover(wrap, pop);
    wrap.append(h('button', { class: `meta-chip ${p ? '' : 'empty'}`, type: 'button', title: '归入推进事项', onclick: () => ctl.toggle() },
      icon('folder'), p ? p.name : '归入事项', icon('down', 'chev-d')), pop);
    return wrap;
  }

  function hasNote(conv) {
    return Boolean(String(conv.summary || '').trim() || parseList(conv.decisions_json).length || String(conv.next_step || '').trim());
  }
  const isEditing = (conv) => ui.sumEdit === conv.id;
  function toggleEdit(conv) { ui.sumEdit = isEditing(conv) ? null : conv.id; openConversation(conv.id, []); }

  // 会话摘要（对齐 v4 .sum-card）：无摘要整块不渲染；有摘要默认单行收起，点开可展开 / 编辑
  // 手动改标题 / 摘要 / 归属只在库里静默置 *_locked，界面不出现任何锁标或说明
  function summaryCard(conv) {
    const sum = String(conv.summary || '').trim();
    const decisions = parseList(conv.decisions_json);
    const next = String(conv.next_step || '').trim();
    if (isEditing(conv)) {
      const tIn = input(conv.title || '', '会话标题');
      const pSel = h('select', {}, h('option', { value: '' }, '不关联事项'),
        ...projects().filter((x) => !x.archived || x.id === conv.project_id).map((x) => h('option', { value: x.id }, x.name)));
      pSel.value = conv.project_id || '';
      const sIn = textarea(sum, '可选：一两句话说清这次对话做了什么；留空则不显示会话摘要', 3);
      const dIn = textarea(decisions.join('\n'), '可选，每行一条拍板结论', 3);
      const nIn = input(next, '可选，无待办可留空');
      const save = () => {
        const title = tIn.value.trim();
        if (!title) { toast('会话标题不能为空'); return; }
        const patch = { summary: sIn.value.trim(), decisions: lines(dIn.value), nextStep: nIn.value.trim() };
        if (title !== (conv.title || '')) patch.title = title;
        if ((pSel.value || null) !== (conv.project_id || null)) patch.projectId = pSel.value || null;
        ui.sumEdit = null;
        if (patch.summary || patch.decisions.length || patch.nextStep) ui.sumOpen.add(conv.id); else ui.sumOpen.delete(conv.id);
        updateMeta(conv, patch, '已保存会话信息');
      };
      return h('section', { class: 'sum-card', 'aria-label': '编辑标题与会话摘要' },
        h('div', { class: 'sum-hd' }, icon('spark', 'sum-hd-ico'), h('span', { class: 'sum-hd-title' }, '编辑会话标题与摘要')),
        h('div', { class: 'edit-form' },
          h('div', { class: 'edit-row2' }, field('会话标题', tIn), field('关联事项', pSel)),
          field('会话摘要（留空则不显示）', sIn), field('关键结论（每行一条，可选）', dIn), field('下一步待办（可选）', nIn),
          h('div', { class: 'edit-foot' },
            btn('btn', '取消', () => { ui.sumEdit = null; openConversation(conv.id, []); }),
            btn('btn pri', '保存', save))));
    }
    if (!sum && !decisions.length && !next) return null;
    const open = ui.sumOpen.has(conv.id);
    const toggleOpen = () => { if (open) ui.sumOpen.delete(conv.id); else ui.sumOpen.add(conv.id); openConversation(conv.id, []); };
    if (!open) {
      return h('section', { class: 'sum-card collapsed', 'aria-label': '会话摘要（默认收起，点击展开）', onclick: toggleOpen },
        h('div', { class: 'sum-hd' }, icon('spark', 'sum-hd-ico'), h('span', { class: 'sum-hd-title' }, '会话摘要'),
          h('span', { class: 'sum-collapse-preview' }, sum || decisions[0] || `待办：${next}`),
          h('div', { class: 'sum-actions' }, btn('quiet-btn', '展开', (e) => { e.stopPropagation(); toggleOpen(); }, 'down'))));
    }
    return h('section', { class: 'sum-card', 'aria-label': '会话摘要' },
      h('div', { class: 'sum-hd' }, icon('spark', 'sum-hd-ico'), h('span', { class: 'sum-hd-title' }, '会话摘要'),
        h('div', { class: 'sum-actions' },
          btn('quiet-btn', '编辑', (e) => { e.stopPropagation(); toggleEdit(conv); }, 'edit'),
          btn('quiet-btn', '收起', (e) => { e.stopPropagation(); toggleOpen(); }, 'up'))),
      sum ? h('p', { class: 'sum-body' }, sum) : null,
      decisions.length || next ? h('div', { class: 'sum-points' },
        ...decisions.map((d) => h('div', { class: 'sum-pt' }, icon('check'), h('span', {}, d))),
        next ? h('div', { class: 'sum-pt next' }, icon('arrowRight'), h('span', {}, `待办：${next}`)) : null) : null);
  }

  function denoiseBar(conv) {
    const stripped = Number(conv.stripped_blocks) || 0;
    return stripped > 0 ? h('div', { class: 'denoise-bar' }, icon('filter'), h('span', {}, `入库时已自动剥离 ${nf.format(stripped)} 处工具回显、思考过程与系统注入，完整保留下方问答正文`)) : null;
  }

  /** 记录页详情所需的 v4 部件，由 app.js 组装进头部 / meta 行 / 正文上方 */
  function detailParts(conv) {
    return {
      hasNote: hasNote(conv),
      editing: isEditing(conv),
      toggleEdit: () => toggleEdit(conv),
      projectChip: projectChip(conv),
      summaryCard: summaryCard(conv),
      denoiseBar: denoiseBar(conv),
    };
  }

  // ---------- 首页：正在推进 ----------
  function renderHomeProjects() {
    const list = $('#home-projects');
    const hd = $('#home-projects-hd');
    if (!list) return;
    const act = activeProjects().slice(0, 3);
    if (hd) hd.classList.toggle('hidden', !act.length);
    fill(list, ...act.map((p) => h('div', { class: 'card clickable work-card', onclick: () => openMemory({ type: 'project', id: p.id }) },
      h('div', { class: 'work-top' }, h('span', { class: 'work-title' }, p.name), p.state ? h('span', { class: 'state-pill accent' }, p.state) : null, icon('chevron', 'chev')),
      p.progress ? h('div', { class: 'work-prog' }, p.progress) : null,
      h('div', { class: 'work-foot' }, p.nextStep ? h('span', {}, `下一步：${p.nextStep}`) : h('span', {}, `更新于 ${fullTime(p.updatedAt)}`)))));
  }
  const allProjBtn = $('#btn-all-projects');
  if (allProjBtn) allProjBtn.addEventListener('click', () => { const p = activeProjects()[0]; openMemory(p ? { type: 'project', id: p.id } : { type: 'group', id: null }); });

  // ---------- 记忆页 ----------
  function openMemory(sel) {
    ui.memSel = sel; ui.memQuery = ''; ui.editing = null; ui.pasteOpen = false; ui.settling = false; ui.sessOpen = false;
    const q = $('#mem-q'); if (q) q.value = '';
    show('memory');
  }
  function selectNav(sel) { ui.memSel = sel; ui.editing = null; ui.pasteOpen = false; ui.pasteDrafts = null; ui.settling = false; ui.sessOpen = false; renderMemory(); }

  const memQ = $('#mem-q');
  let memDebounce = null;
  if (memQ) memQ.addEventListener('input', (e) => { clearTimeout(memDebounce); memDebounce = setTimeout(() => { ui.memQuery = e.target.value.trim(); renderMemory(); }, 150); });

  function renderMemory() {
    if (!state || !$('#mem-nav')) return;
    if (ui.memSel.type === 'project' && !projectById(ui.memSel.id)) ui.memSel = { type: 'group', id: null };
    if (ui.memSel.type === 'group' && !groups().some((g) => g.id === ui.memSel.id)) ui.memSel = { type: 'group', id: groups()[0] ? groups()[0].id : null };
    renderNav();
    renderDetail();
  }

  function renderNav() {
    const searching = !!ui.memQuery;
    const sel = ui.memSel;
    const out = [h('div', { class: 'mem-sec-hd' }, h('span', {}, '关于我与经验'))];
    for (const g of groups()) {
      const cnt = memories().filter((m) => m.group === g.id).length;
      out.push(h('button', { class: `mnav-btn ${!searching && sel.type === 'group' && sel.id === g.id ? 'on' : ''}`, type: 'button', onclick: () => selectNav({ type: 'group', id: g.id }) },
        icon(g.icon), h('span', { class: 'mnav-txt' }, g.id), h('span', { class: `mnav-cnt ${cnt ? '' : 'zero'}` }, String(cnt))));
    }
    out.push(h('div', { class: 'mem-sec-hd' }, h('span', {}, '推进事项'), btn('mem-sec-add', '新建', () => selectNav({ type: 'new-project' }), 'plus')));
    const act = activeProjects();
    const arch = projects().filter((p) => p.archived).sort((a, b) => b.updatedAt - a.updatedAt);
    if (!act.length && !arch.length) out.push(h('div', { class: 'sub mnav-empty' }, '还没有推进事项'));
    const projBtn = (p) => h('button', { class: `mnav-btn ${!searching && sel.type === 'project' && sel.id === p.id ? 'on' : ''}`, type: 'button', onclick: () => selectNav({ type: 'project', id: p.id }) },
      h('span', { class: `mnav-dot ${p.archived ? 'archived' : ''}` }), h('span', { class: 'mnav-txt' }, p.name));
    out.push(...act.map(projBtn));
    if (arch.length) {
      const open = ui.showArchived || (sel.type === 'project' && arch.some((p) => p.id === sel.id));
      out.push(h('button', { class: 'mnav-arch-toggle', type: 'button', onclick: () => { ui.showArchived = !open; renderNav(); } }, icon(open ? 'down' : 'chevron'), h('span', {}, `已结项归档 (${arch.length})`)));
      if (open) out.push(...arch.map(projBtn));
    }
    fill($('#mem-nav'), ...out);
  }

  function renderDetail() {
    const track = $('#mem-track');
    if (ui.memQuery) fill(track, ...searchView());
    else if (ui.memSel.type === 'new-project') fill(track, ...newProjectView());
    else if (ui.memSel.type === 'project') fill(track, ...projectView(projectById(ui.memSel.id)));
    else fill(track, ...groupView(ui.memSel.id || (groups()[0] && groups()[0].id)));
  }

  function flash(selector) {
    requestAnimationFrame(() => {
      const el = document.querySelector(selector);
      if (!el) return;
      el.scrollIntoView({ block: 'center' });
      el.classList.add('card-flash');
      setTimeout(() => el.classList.remove('card-flash'), 1400);
    });
  }

  // ----- 搜索 -----
  function searchView() {
    const terms = ui.memQuery.split(/\s+/).filter(Boolean);
    const low = terms.map((t) => t.toLowerCase());
    const hit = (hay) => { const s = String(hay || '').toLowerCase(); return low.every((t) => s.includes(t)); };
    const cards = memories().filter((m) => hit([m.group, m.title, m.body, ...(m.tags || []), m.superseded].join(' ')));
    const projs = projects().filter((p) => hit([p.name, p.state, p.progress, ...(p.decisions || []), ...(p.rejected || []), p.nextStep, p.workspace].join(' ')));
    const total = cards.length + projs.length;
    const out = [h('div', { class: 'mem-head' },
      h('div', { class: 'mem-head-left' }, h('h1', {}, '搜索结果'), h('span', { class: `state-pill ${total ? 'accent' : ''}` }, `命中 ${total} 项`)),
      h('div', { class: 'mem-head-acts' }, btn('btn sm', '清空返回', () => { ui.memQuery = ''; $('#mem-q').value = ''; renderMemory(); }, 'close')))];
    if (!total) { out.push(h('div', { class: 'empty' }, `没有包含「${ui.memQuery}」的记忆卡或推进事项`)); return out; }
    const card = (onclick, ...kids) => h('div', { class: 'search-hit-card', role: 'button', tabindex: '0', onclick,
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onclick(); } } }, ...kids);
    if (cards.length) {
      out.push(h('div', { class: 'search-sec-hd' }, h('span', {}, `关于我与经验 (${cards.length})`)));
      out.push(h('div', { class: 'search-hit-list' }, ...cards.map((m) => card(() => {
        ui.memQuery = ''; $('#mem-q').value = ''; ui.tagFilter = '全部';
        selectNav({ type: 'group', id: m.group }); flash(`.topic-card[data-mid="${CSS.escape(m.id)}"]`);
      },
      h('div', { class: 'search-hit-top' }, h('span', { class: 'mini-pill neutral' }, icon(groupMeta(m.group).icon), m.group),
        h('span', { class: 'search-hit-title' }, highlight(m.title, terms)), ...(m.tags || []).map((t) => h('span', { class: 'topic-tag' }, t)),
        h('span', { class: 'search-hit-jump' }, '直达模块 ›')),
      h('div', { class: 'topic-body' }, renderBody(m.body || '', terms, true))))));
    }
    if (projs.length) {
      out.push(h('div', { class: 'search-sec-hd' }, h('span', {}, `推进事项 (${projs.length})`)));
      out.push(h('div', { class: 'search-hit-list' }, ...projs.map((p) => card(() => {
        ui.memQuery = ''; $('#mem-q').value = ''; if (p.archived) ui.showArchived = true;
        selectNav({ type: 'project', id: p.id }); flash('.brief-card');
      },
      h('div', { class: 'search-hit-top' }, h('span', { class: 'search-hit-title' }, highlight(p.name, terms)),
        p.state ? h('span', { class: `state-pill ${p.archived ? '' : 'accent'}` }, p.archived ? `已结项 · ${p.state}` : p.state) : null,
        h('span', { class: 'search-hit-jump' }, '查看事项 ›')),
      p.workspace ? h('div', { class: 'search-hit-ws' }, p.workspace) : null,
      p.progress ? h('p', { class: 'brief-prog' }, highlight(p.progress, terms)) : null))));
    }
    return out;
  }

  // ----- 常驻分组 -----
  function groupMd(gid, list) {
    return [`# ${gid}`, ...list.map((m) => `\n## ${m.title}${(m.tags || []).length ? `\n\n标签：${m.tags.join('、')}` : ''}\n\n${m.body || ''}`)].join('\n');
  }

  function cardEditor(gid, m) {
    const tIn = input(m ? m.title : '', '卡片标题，例如：Windows 下 node:sqlite 读纳秒列报错');
    const bIn = textarea(m ? m.body : '', '正文，支持 Markdown', 5);
    const tags = new Set(m ? m.tags || [] : []);
    const isPitfall = gid === PITFALL;
    const tagRow = isPitfall ? tagPicker(tags) : null;
    const tagsIn = isPitfall ? null : input((m ? m.tags || [] : []).join('、'), '标签，用顿号或逗号分隔（可选）');
    const save = async () => {
      const title = tIn.value.trim();
      if (!title) { tIn.focus(); return; }
      const tagList = isPitfall ? [...tags] : tagsIn.value.split(/[、,，\s]+/).map((s) => s.trim()).filter(Boolean);
      const r = await guarded(() => mem0.saveMemory({ id: m ? m.id : undefined, group: gid, title, body: bIn.value, tags: tagList, sourceIds: m ? m.sourceIds : [], originLabel: m ? m.originLabel : '手动录入' }), m ? '已保存' : '已新增卡片');
      if (!r) return;
      ui.editing = null; setState(r.state); renderMemory();
      if (r.id) flash(`.topic-card[data-mid="${CSS.escape(r.id)}"]`);
    };
    return h('div', { class: m ? 'edit-form mt0' : 'prof-add-box' },
      m ? null : h('div', { class: 'paste-bar' }, h('span', { class: 'paste-bar-title' }, icon('plus'), `新增到「${gid}」`)),
      h('div', { class: 'edit-form mt0' }, field('标题', tIn), field('正文', bIn), isPitfall ? field('标签', tagRow) : field('标签', tagsIn),
        h('div', { class: 'edit-foot' }, btn('btn', '取消', () => { ui.editing = null; renderDetail(); }), btn('btn pri', '保存', save))));
  }

  function tagPicker(tags) {
    const meta = groupMeta(PITFALL);
    const all = [...new Set([...(meta.presetTags || []), ...memories().filter((x) => x.group === PITFALL).flatMap((x) => x.tags || []), ...tags])];
    const row = h('div', { class: 'tag-pick-row' });
    const custom = h('input', { class: 'tag-custom-in', type: 'text', placeholder: '自定义标签，回车添加' });
    const draw = () => fill(row, ...all.map((t) => h('button', { class: `tag-pick-chip ${tags.has(t) ? 'on' : ''}`, type: 'button',
      onclick: () => { if (tags.has(t)) tags.delete(t); else tags.add(t); draw(); } }, t)), custom);
    custom.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const t = custom.value.trim(); if (!t) return;
      if (!all.includes(t)) all.push(t);
      tags.add(t); custom.value = ''; draw(); custom.focus();
    });
    draw();
    return row;
  }

  async function removeCard(m) {
    const r = await guarded(() => mem0.deleteMemory(m.id));
    if (!r) return;
    setState(r.state); renderMemory();
    toast(`已删除「${m.title}」`, async () => {
      const back = await guarded(() => mem0.saveMemory({ id: m.id, group: m.group, title: m.title, body: m.body, tags: m.tags, sourceIds: m.sourceIds, originLabel: m.originLabel }), '已恢复');
      if (back) { setState(back.state); renderMemory(); }
    });
  }
  async function moveCard(m, patch, msg) {
    const r = await guarded(() => mem0.moveMemory(m.id, patch), msg);
    if (r) { setState(r.state); renderMemory(); flash(`.topic-card[data-mid="${CSS.escape(m.id)}"]`); }
  }

  function sourceJump(m) {
    const ids = (m.sourceIds || []).filter(Boolean);
    if (!ids.length) return null;
    if (ids.length === 1) return btn('src-jump', '查看来源会话', () => jumpToConversation(ids[0]), 'arrowRight');
    const wrap = h('span', { class: 'rel-inline' });
    const pop = h('div', { class: 'pop menu src-pop pop-up' }, ...ids.map((id, i) => menuItem(`来源会话 ${i + 1}`, () => { ctl.close(); jumpToConversation(id); }, 'chat')));
    const ctl = popover(wrap, pop);
    wrap.append(btn('src-jump', `${ids.length} 个来源会话`, () => ctl.toggle(), 'arrowRight'), pop);
    return wrap;
  }
  function jumpToConversation(id) { show('records'); openConversation(id, []); }

  function topicCard(m, scopeIds, idx) {
    if (ui.editing === m.id) return h('div', { class: 'topic-card', 'data-mid': m.id }, cardEditor(m.group, m));
    const moveWrap = h('span', { class: 'rel-inline' });
    const movePop = h('div', { class: 'pop menu src-pop pop-right' },
      ...groups().filter((g) => g.id !== m.group).map((g) => menuItem(`移到「${g.id}」`, () => { moveCtl.close(); moveCard(m, { targetGroup: g.id }, `已移到「${g.id}」`); }, g.icon)));
    const moveCtl = popover(moveWrap, movePop);
    moveWrap.append(h('button', { class: 'card-act-btn ico-only', type: 'button', title: '移到其它分组', onclick: () => moveCtl.toggle() }, icon('swap')), movePop);
    const supOpen = ui.showSuperseded.has(m.id);
    return h('div', { class: 'topic-card', 'data-mid': m.id },
      h('div', { class: 'topic-hd' },
        h('div', { class: 'topic-hd-left' }, h('span', { class: 'topic-title' }, m.title), ...(m.tags || []).map((t) => h('span', { class: 'topic-tag' }, t))),
        h('div', { class: 'topic-acts' },
          h('button', { class: 'card-act-btn ico-only', type: 'button', title: '上移', disabled: idx === 0, onclick: () => moveCard(m, { delta: -1, scopeIds }) }, icon('arrowUp')),
          h('button', { class: 'card-act-btn ico-only', type: 'button', title: '下移', disabled: idx === scopeIds.length - 1, onclick: () => moveCard(m, { delta: 1, scopeIds }) }, icon('down')),
          moveWrap,
          h('button', { class: 'card-act-btn ico-only', type: 'button', title: '编辑', onclick: () => { ui.editing = m.id; renderDetail(); } }, icon('edit')),
          h('button', { class: 'card-act-btn ico-only danger', type: 'button', title: '删除', onclick: () => removeCard(m) }, icon('trash')))),
      h('div', { class: 'topic-body' }, renderBody(m.body || '', [], true)),
      h('div', { class: 'topic-foot' },
        h('span', {}, m.originLabel || '手动录入'), h('span', { class: 'dotsep' }, '·'), h('span', {}, `更新于 ${fullTime(m.updatedAt)}`),
        sourceJump(m),
        m.superseded ? h('button', { class: 'superseded-toggle', type: 'button', onclick: () => { if (supOpen) ui.showSuperseded.delete(m.id); else ui.showSuperseded.add(m.id); renderDetail(); } }, icon('clock'), supOpen ? '收起旧版' : '查看旧版') : null),
      m.superseded && supOpen ? h('div', { class: 'topic-superseded-box' }, `旧版：${m.superseded}`) : null);
  }

  function groupView(gid) {
    if (!gid) return [h('div', { class: 'empty' }, '记忆分组未就绪')];
    const meta = groupMeta(gid);
    const all = memories().filter((m) => m.group === gid);
    const isPitfall = gid === PITFALL;
    const tagCounts = new Map();
    if (isPitfall) for (const m of all) for (const t of m.tags || []) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
    if (isPitfall && ui.tagFilter !== '全部' && !tagCounts.has(ui.tagFilter)) ui.tagFilter = '全部';
    const shown = isPitfall && ui.tagFilter !== '全部' ? all.filter((m) => (m.tags || []).includes(ui.tagFilter)) : all;
    const copyBtn = h('button', { class: 'head-copy-btn', type: 'button', disabled: !all.length }, icon('copy'), meta.copyLabel || '复制本页');
    copyBtn.addEventListener('click', async () => { await mem0.copy(groupMd(gid, all)); copyBtn.classList.add('done'); setTimeout(() => copyBtn.classList.remove('done'), 1400); });
    const out = [h('div', { class: 'mem-head' },
      h('div', { class: 'mem-head-left' }, h('h1', {}, gid), h('span', { class: 'state-pill' }, `${all.length} 张卡片`)),
      h('div', { class: 'mem-head-acts' },
        h('button', { class: `btn sm ${ui.pasteOpen ? 'active' : ''}`, type: 'button', onclick: () => { ui.pasteOpen = !ui.pasteOpen; ui.pasteDrafts = null; ui.editing = null; renderDetail(); } }, icon('import'), '粘贴导入'),
        h('button', { class: `btn sm ${ui.editing === 'new' ? 'active' : ''}`, type: 'button', onclick: () => { ui.editing = ui.editing === 'new' ? null : 'new'; ui.pasteOpen = false; renderDetail(); } }, icon('plus'), '新增卡片'),
        copyBtn))];
    if (isPitfall && tagCounts.size) {
      const pill = (t, n) => h('button', { class: `tag-pill ${ui.tagFilter === t ? 'on' : ''}`, type: 'button', onclick: () => { ui.tagFilter = t; renderDetail(); } }, t, h('span', { class: 'tag-pill-cnt' }, String(n)));
      out.push(h('div', { class: 'tag-filter-bar' }, pill('全部', all.length), ...[...tagCounts].sort((a, b) => b[1] - a[1]).map(([t, n]) => pill(t, n))));
    }
    if (ui.pasteOpen) out.push(pastePanel(gid));
    if (ui.editing === 'new') out.push(cardEditor(gid, null));
    if (!all.length && ui.editing !== 'new' && !ui.pasteOpen) {
      out.push(h('div', { class: 'empty' }, isPitfall
        ? '还没有经验卡。开启 AI 自动整理后，排障结论会自动沉淀到这里；也可以手动新增或粘贴导入。'
        : '还没有卡片。可以手动新增，或把已有的说明文档粘贴导入。'));
    }
    const scopeIds = shown.map((m) => m.id);
    if (shown.length) out.push(h('div', { class: 'topic-list' }, ...shown.map((m, i) => topicCard(m, scopeIds, i))));
    return out;
  }

  // ----- 粘贴导入（AI 拆卡，失败/未启用时本地确定性拆分） -----
  function pastePanel(gid) {
    const raw = h('textarea', { class: 'paste-raw-in', placeholder: '把一段说明、笔记或 Markdown 粘贴到这里，按空行、标题或列表项拆成多张卡片，确认后再写入。' });
    const splitBtn = h('button', { class: 'btn pri', type: 'button' }, '拆成卡片预览');
    const sample = () => { raw.value = '## 回复风格\n先给结论，再给理由；代码改动附上验证命令。\n\n## 开发环境\nWindows 11 + PowerShell，Node 24，包管理用 npm。\n\n## 排障习惯\n先复现再修，修完补一条回归测试。'; };
    splitBtn.addEventListener('click', async () => {
      const text = raw.value.trim(); if (!text) { raw.focus(); return; }
      splitBtn.disabled = true; splitBtn.textContent = state.ai && state.ai.enabled ? 'AI 拆卡中…' : '拆分中…';
      const drafts = await guarded(() => mem0.splitImportText(text, gid));
      splitBtn.disabled = false; splitBtn.textContent = '拆成卡片预览';
      ui.pasteDrafts = (Array.isArray(drafts) ? drafts : []).map((d) => ({ on: true, title: d.title || '', body: d.body || '', target: d.target || gid }));
      if (!ui.pasteDrafts.length) toast('没有拆出可用的卡片');
      renderDetail();
    });
    const box = h('div', { class: 'paste-import-box' },
      h('div', { class: 'paste-bar' }, h('span', { class: 'paste-bar-title' }, icon('import'), '粘贴导入'),
        h('span', { class: 'paste-bar-acts' }, btn('btn sm', '填入示例文本', sample), btn('btn sm', '关闭', () => { ui.pasteOpen = false; ui.pasteDrafts = null; renderDetail(); }, 'close'))));
    if (!ui.pasteDrafts) { box.append(raw, h('div', { class: 'paste-split-row' }, splitBtn)); return box; }
    const targets = [...groups().map((g) => [g.id, g.id]), [NEW_PROJECT, '新建推进事项']];
    const list = h('div', { class: 'import-pv-list' }, ...ui.pasteDrafts.map((d) => {
      const ck = h('input', { class: 'import-pv-ck', type: 'checkbox', checked: d.on });
      const tIn = h('input', { class: 'import-pv-title', type: 'text' }); tIn.value = d.title;
      const bIn = h('textarea', { class: 'import-pv-body', rows: '3' }); bIn.value = d.body;
      const sel = h('select', { class: 'inbox-sel' }, ...targets.map(([v, l]) => { const o = h('option', { value: v }, l); if (v === d.target) o.selected = true; return o; }));
      const card = h('div', { class: `import-pv-card ${d.on ? '' : 'off'}` }, h('div', { class: 'import-pv-top' }, ck, tIn, sel), bIn);
      ck.addEventListener('change', () => { d.on = ck.checked; card.classList.toggle('off', !d.on); });
      tIn.addEventListener('input', () => { d.title = tIn.value; });
      bIn.addEventListener('input', () => { d.body = bIn.value; });
      sel.addEventListener('change', () => { d.target = sel.value; });
      return card;
    }));
    const commit = async () => {
      const items = ui.pasteDrafts.filter((d) => d.on && (d.title.trim() || d.body.trim())).map((d) => ({ target: d.target, title: d.title.trim(), body: d.body }));
      if (!items.length) { toast('没有勾选要导入的卡片'); return; }
      const r = await guarded(() => mem0.batchImportMemories(items));
      if (!r) return;
      ui.pasteOpen = false; ui.pasteDrafts = null;
      setState(r.state); renderMemory();
      toast(`已导入 ${r.importedMemories || 0} 张卡片${r.importedProjects ? `、${r.importedProjects} 个事项` : ''}`);
    };
    box.append(list, h('div', { class: 'paste-split-row' }, btn('btn', '重新粘贴', () => { ui.pasteDrafts = null; renderDetail(); }), btn('btn pri', '确认导入', commit)));
    return box;
  }

  // ----- 推进事项 -----
  function projectForm(p, onDone) {
    const nIn = input(p ? p.name : '', '例如：个人主页改版');
    const sIn = input(p ? p.state : '推进中', '推进中 / 卡住 / 待验收');
    const wIn = input(p ? p.workspace || '' : '', '可选：本机工作区目录，匹配的会话会自动归入');
    const prIn = textarea(p ? p.progress : '', '目前做到哪了', 3);
    const dIn = textarea(p ? (p.decisions || []).join('\n') : '', '已拍板的结论，一行一条', 3);
    const rIn = textarea(p ? (p.rejected || []).join('\n') : '', '试过但否决的方案，一行一条', 2);
    const xIn = input(p ? p.nextStep : '', '下一步要做什么');
    const save = async () => {
      const name = nIn.value.trim(); if (!name) { nIn.focus(); return; }
      const r = await guarded(() => mem0.saveProject({ id: p ? p.id : undefined, name, state: sIn.value.trim() || '推进中', workspace: wIn.value.trim() || null,
        progress: prIn.value.trim(), decisions: lines(dIn.value), rejected: lines(rIn.value), nextStep: xIn.value.trim(), archived: p ? p.archived : false }), p ? '已保存' : '已新建事项');
      if (r && r.project) { setState(r.state); onDone(r.project); }
    };
    return h('div', { class: 'brief-card' }, h('div', { class: 'edit-form mt0' },
      h('div', { class: 'edit-row2 edit-row-asym' }, field('状态', sIn), field('名称', nIn)),
      field('工作区目录', wIn), field('当前进展', prIn), field('已拍板结论', dIn), field('已否决方案', rIn), field('下一步', xIn),
      h('div', { class: 'edit-foot' }, btn('btn', '取消', () => onDone(null)), btn('btn pri', '保存', save))));
  }

  function newProjectView() {
    return [h('div', { class: 'mem-head' }, h('div', { class: 'mem-head-left' }, h('h1', {}, '新建推进事项'))),
      projectForm(null, (proj) => { if (proj) selectNav({ type: 'project', id: proj.id }); else selectNav({ type: 'group', id: groups()[0] && groups()[0].id }); })];
  }

  function briefMd(p) {
    const out = [`# ${p.name}`, '', `状态：${p.state || ''}${p.archived ? '（已结项）' : ''}`];
    if (p.workspace) out.push(`工作区：${p.workspace}`);
    if (p.progress) out.push('', '## 当前进展', p.progress);
    if ((p.decisions || []).length) out.push('', '## 已拍板结论', ...p.decisions.map((d) => `- ${d}`));
    if ((p.rejected || []).length) out.push('', '## 已否决方案', ...p.rejected.map((d) => `- ${d}`));
    if (p.nextStep) out.push('', '## 下一步', p.nextStep);
    return out.join('\n');
  }

  async function setArchived(p, archived, settleCards) {
    const r = await guarded(() => mem0.saveProject({ id: p.id, name: p.name, state: p.state, workspace: p.workspace, progress: p.progress, decisions: p.decisions, rejected: p.rejected, nextStep: p.nextStep, archived, settleCards }),
      archived ? `「${p.name}」已结项${settleCards && settleCards.length ? `，沉淀 ${settleCards.length} 张卡片` : ''}` : '已恢复为推进中');
    if (r) { ui.settling = false; if (archived) ui.showArchived = true; setState(r.state); renderMemory(); }
  }

  function settleBox(p) {
    const picks = [...(p.decisions || []).map((t) => ({ t, on: true, group: PITFALL })), ...(p.rejected || []).map((t) => ({ t: `已否决：${t}`, on: false, group: PITFALL }))];
    const rows = picks.map((x) => {
      const ck = h('input', { class: 'import-pv-ck', type: 'checkbox', checked: x.on });
      const sel = h('select', { class: 'inbox-sel' }, ...groups().map((g) => { const o = h('option', { value: g.id }, g.id); if (g.id === x.group) o.selected = true; return o; }));
      ck.addEventListener('change', () => { x.on = ck.checked; });
      sel.addEventListener('change', () => { x.group = sel.value; });
      return h('div', { class: 'settle-row' }, h('div', { class: 'settle-row-main' }, ck, h('span', { class: 'settle-row-txt', onclick: () => { ck.checked = !ck.checked; x.on = ck.checked; } }, x.t)),
        h('div', { class: 'settle-row-extra' }, h('span', { class: 'sub' }, '存到'), sel));
    });
    const confirm = () => setArchived(p, true, picks.filter((x) => x.on).map((x) => ({ group: x.group, title: x.t.slice(0, 80), body: `${x.t}\n\n（来自推进事项「${p.name}」结项沉淀）`, originLabel: '结项沉淀' })));
    return h('div', { class: 'archive-settle-box' },
      h('div', { class: 'settle-hd' }, icon('archive'), '结项前，顺手把结论沉淀成长期卡片？'),
      picks.length ? h('div', { class: 'settle-list' }, ...rows) : h('div', { class: 'sub' }, '这个事项还没有拍板结论，直接结项即可。'),
      h('div', { class: 'edit-foot' }, btn('btn', '取消', () => { ui.settling = false; renderDetail(); }), btn('btn', '只结项不沉淀', () => setArchived(p, true, [])), btn('btn pri', '确认结项', confirm)));
  }

  function sessionsFold(p) {
    const bar = h('div', { class: 'psess-fold-bar' }, h('div', { class: 'psess-fold-hd' }, h('span', { class: 'psess-fold-summary' }, '正在读取关联会话…')));
    mem0.list({ projectId: p.id, limit: 300 }).then((rows) => {
      if (!bar.isConnected && rows === undefined) return;
      const srcs = [...new Set(rows.map((r) => r.source))].slice(0, 4);
      const hd = h('div', { class: 'psess-fold-hd' },
        h('div', { class: 'psess-fold-left' }, h('span', { class: 'av-stack' }, ...srcs.map((s) => av(s, 'xs'))),
          h('span', { class: 'psess-fold-summary' }, rows.length ? `${rows.length} 个关联会话 · ${srcs.map(srcName).join('、')}` : '还没有关联会话：在「记录」页把会话归入这个事项，或填写工作区目录自动归入')),
        rows.length ? h('div', { class: 'psess-fold-acts' },
          btn('quiet-btn', ui.sessOpen ? '收起' : '展开', () => { ui.sessOpen = !ui.sessOpen; renderDetail(); }, ui.sessOpen ? 'up' : 'down'),
          btn('quiet-btn', '在记录页查看', () => { localStorage.setItem('mem0.recMode', 'project'); ui.recMode = 'project'; syncModeSeg(); show('records'); }, 'chat')) : null);
      fill(bar, ...[hd, ui.sessOpen && rows.length ? h('div', { class: 'psess-mini-list' }, ...rows.map((r) => h('div', { class: 'psess-mini-row' }, av(r.source, 'xs'),
        h('button', { class: 'psess-mini-title', type: 'button', onclick: () => jumpToConversation(r.id) }, r.title || '(无标题)'),
        h('span', { class: 'psess-mini-meta' }, shortTime(r.updated_at))))) : null].filter(Boolean));
    }).catch(() => {});
    return bar;
  }

  function projectView(p) {
    if (!p) return [h('div', { class: 'empty' }, '这个事项已被删除')];
    if (ui.editing === 'project') return [h('div', { class: 'mem-head' }, h('div', { class: 'mem-head-left' }, h('h1', {}, `编辑「${p.name}」`))), projectForm(p, () => { ui.editing = null; renderMemory(); })];
    const copyBtn = h('button', { class: 'head-copy-btn', type: 'button' }, icon('copy'), '复制简报');
    copyBtn.addEventListener('click', async () => { await mem0.copy(briefMd(p)); copyBtn.classList.add('done'); setTimeout(() => copyBtn.classList.remove('done'), 1400); });
    const del = async () => {
      if (!window.confirm(`删除推进事项「${p.name}」？关联的会话会保留，只是不再归入任何事项。`)) return;
      const r = await guarded(() => mem0.deleteProject(p.id), '已删除事项');
      if (r) { setState(r.state); selectNav({ type: 'group', id: groups()[0] && groups()[0].id }); }
    };
    const wsBtn = p.workspace ? h('button', { class: 'ws-copy-btn', type: 'button', title: '复制路径' }, icon('copy'), '复制') : null;
    if (wsBtn) wsBtn.addEventListener('click', flashCopied(wsBtn, p.workspace));
    const out = [h('div', { class: 'mem-head tight-mb' },
      h('div', { class: 'mem-head-left' }, h('h1', {}, p.name), h('span', { class: `state-pill ${p.archived ? '' : 'accent'}` }, p.archived ? `已结项 · ${p.state || ''}` : (p.state || '推进中'))),
      h('div', { class: 'mem-head-acts' },
        btn('btn sm', '编辑', () => { ui.editing = 'project'; renderDetail(); }, 'edit'),
        p.archived ? btn('btn sm', '恢复推进', () => setArchived(p, false)) : btn(`btn sm ${ui.settling ? 'active' : ''}`, '结项', () => { ui.settling = !ui.settling; renderDetail(); }, 'archive'),
        btn('btn sm', '删除', del, 'trash'), copyBtn)),
    h('div', { class: 'proj-meta-line' }, h('span', {}, `更新于 ${fullTime(p.updatedAt)}`),
      p.workspace ? h('span', { class: 'dotsep' }, '·') : null, p.workspace ? h('code', { class: 'proj-ws-code', title: p.workspace }, p.workspace) : null, wsBtn)];
    if (ui.settling && !p.archived) out.push(settleBox(p));
    const empty = !p.progress && !(p.decisions || []).length && !(p.rejected || []).length && !p.nextStep;
    out.push(h('div', { class: 'brief-card' },
      h('div', { class: 'brief-sec-lbl' }, '当前进展'),
      h('p', { class: 'brief-prog' }, p.progress || (empty ? '还没有写进展。点「编辑」补上，或开启 AI 自动整理后由关联会话自动更新。' : '—')),
      (p.decisions || []).length ? h('div', { class: 'brief-sec' }, h('div', { class: 'brief-sec-lbl' }, '已拍板结论'), ...p.decisions.map((d) => h('div', { class: 'sum-pt' }, icon('check'), h('span', {}, d)))) : null,
      (p.rejected || []).length ? h('div', { class: 'brief-sec' }, h('div', { class: 'brief-sec-lbl' }, '已否决方案'), ...p.rejected.map((d) => h('div', { class: 'sum-pt rejected' }, icon('ban'), h('span', {}, d)))) : null,
      p.nextStep ? h('div', { class: 'brief-sec' }, h('div', { class: 'brief-sec-lbl' }, '下一步'), h('div', { class: 'sum-pt next' }, icon('arrowRight'), h('span', {}, p.nextStep))) : null));
    out.push(sessionsFold(p));
    return out;
  }

  // ---------- 设置页：AI 自动整理 ----------
  const aiDraft = { provider: null, baseUrl: '', model: '', apiKey: '', showKey: false, testing: false, testMsg: '' };
  const PRESETS = [
    { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', needKey: true },
    { id: 'gemini', label: 'Gemini Flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash', needKey: true },
    { id: 'openai', label: 'OpenAI 兼容 / 中转', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', needKey: true },
    { id: 'ollama', label: '本地 Ollama（免 Key）', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', needKey: false },
  ];
  function aiCfg() {
    const ai = (state && state.ai) || {};
    if (aiDraft.provider === null) { aiDraft.provider = ai.provider || 'deepseek'; aiDraft.baseUrl = ai.baseUrl || ''; aiDraft.model = ai.model || ''; }
    const preset = PRESETS.find((x) => x.id === aiDraft.provider) || PRESETS[0];
    return { ai, preset };
  }
  function draftPayload(extra) {
    const { preset } = aiCfg();
    const cfg = { provider: aiDraft.provider, baseUrl: aiDraft.baseUrl || preset.baseUrl, model: aiDraft.model || preset.model, ...extra };
    if (aiDraft.apiKey.trim()) cfg.apiKey = aiDraft.apiKey.trim();
    return cfg;
  }

  function renderSettingsAi() {
    const box = $('#settings-ai');
    if (!box || !state) return;
    if (box.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return; // 正在输入时不重绘，避免丢光标
    const { ai, preset } = aiCfg();
    const sw = h('label', { class: 'switch', title: '开启 AI 自动整理' }, h('input', { type: 'checkbox', checked: !!ai.enabled, 'aria-label': '开启 AI 自动整理' }), h('span'));
    sw.firstChild.addEventListener('change', async (e) => {
      const s = await guarded(() => mem0.saveAiConfig(draftPayload({ enabled: e.target.checked })), e.target.checked ? '已开启 AI 自动整理' : '已关闭 AI 自动整理');
      setState(s);
    });
    const head = h('div', { class: 'grow' },
      h('div', { class: 'grow-main' }, h('div', { class: 'nm' }, '后台静默整理新会话',
        h('span', { class: `badge ${ai.statusOk ? 'ok' : ai.enabled && !ai.statusOk ? 'warn' : ''}` }, ai.statusText || (ai.enabled ? '已开启' : '未开启'))),
      h('div', { class: 'ds' }, '会话停更 5 分钟后，用你配置的轻量模型补标题、摘要和事项进展，排障结论自动存进「踩坑与经验库」。不会改动你手动改过的标题与归属，也不会写入个人背景、协作准则与环境三个分组。')),
      h('div', { class: 'end' }, sw));
    const pill = (x) => h('button', { class: `tag-pill ${aiDraft.provider === x.id ? 'on' : ''}`, type: 'button',
      onclick: () => { aiDraft.provider = x.id; aiDraft.baseUrl = x.baseUrl; aiDraft.model = x.model; aiDraft.testMsg = ''; renderSettingsAi(); } }, x.label);
    const urlIn = input(aiDraft.baseUrl || preset.baseUrl, preset.baseUrl);
    const modelIn = input(aiDraft.model || preset.model, preset.model);
    const keyIn = h('input', { type: aiDraft.showKey ? 'text' : 'password', placeholder: !preset.needKey ? '本地模型无需 Key' : ai.hasKey ? `已保存 ${ai.keyHint || ''}，留空则沿用` : '粘贴 API Key（只加密保存在本机）', autocomplete: 'off', spellcheck: 'false' });
    keyIn.value = aiDraft.apiKey; keyIn.disabled = !preset.needKey;
    urlIn.addEventListener('input', () => { aiDraft.baseUrl = urlIn.value.trim(); });
    modelIn.addEventListener('input', () => { aiDraft.model = modelIn.value.trim(); });
    keyIn.addEventListener('input', () => { aiDraft.apiKey = keyIn.value; });
    const eye = h('button', { class: 'ai-eye-btn', type: 'button', onclick: () => { aiDraft.showKey = !aiDraft.showKey; keyIn.type = aiDraft.showKey ? 'text' : 'password'; eye.textContent = aiDraft.showKey ? '隐藏' : '显示'; } }, aiDraft.showKey ? '隐藏' : '显示');
    const testBtn = h('button', { class: 'btn ai-test-btn', type: 'button', disabled: aiDraft.testing }, aiDraft.testing ? '测试中…' : '测试并保存');
    testBtn.addEventListener('click', async () => {
      aiDraft.testing = true; aiDraft.testMsg = ''; renderSettingsAi();
      const r = await guarded(() => mem0.testAiConfig(draftPayload({})));
      aiDraft.testing = false;
      if (r) {
        aiDraft.testMsg = r.ok ? `连接正常 · ${r.latencyMs}ms` : `连接失败：${r.error || '未知错误'}`;
        if (r.ok) aiDraft.apiKey = '';
        setState(r.state);
      }
      renderSettingsAi();
    });
    const cfgBox = h('div', { class: 'ai-cfg-box' },
      h('div', { class: 'ai-preset-row' }, h('span', { class: 'ai-preset-lbl' }, '模型服务'), ...PRESETS.map(pill)),
      h('div', { class: 'edit-row2' }, field('接口地址', urlIn), field('模型', modelIn)),
      h('div', { class: 'ai-key-row' }, h('label', { class: 'field ai-key-field' }, h('span', {}, 'API Key'), h('div', { class: 'ai-key-wrap' }, keyIn, preset.needKey ? eye : null)), testBtn),
      aiDraft.testMsg ? h('div', { class: 'sub' }, aiDraft.testMsg) : null,
      ai.hasKey && preset.needKey ? h('div', { class: 'sub' }, btn('text-btn', '清除已保存的 Key', async () => { const s = await guarded(() => mem0.saveAiConfig(draftPayload({ clearKey: true })), '已清除 Key'); setState(s); })) : null);
    // 左侧文案与右侧按钮绑定同一个 unorganizedCount，杜绝「没有待整理」却显示「整理 20 个」
    const n = Math.max(0, Number(ai.unorganizedCount) || 0);
    const batch = Math.min(n, 20);
    const oldLabel = ai.organizing ? '整理中…' : (n ? `整理旧对话 (${nf.format(batch)})` : '全部已整理');
    const oldBtn = h('button', { class: 'btn', type: 'button', 'data-unorganized': String(n), disabled: !n || !ai.enabled || Boolean(ai.organizing) }, oldLabel);
    oldBtn.addEventListener('click', async () => {
      if (!n) return;
      oldBtn.disabled = true; oldBtn.textContent = '整理中…';
      const r = await guarded(() => mem0.organizeOld({ limit: batch }));
      if (r) { toast(`已整理 ${r.organized || 0} 个，剩余 ${r.remaining || 0} 个`); setState(r.state); }
      renderSettingsAi();
    });
    const oldDesc = n
      ? `还有 ${nf.format(n)} 个历史会话待整理${n > batch ? `，每次整理 ${nf.format(batch)} 个` : ''}。不会自动跑，需要时手动整理。${ai.enabled ? '' : '先开启 AI 自动整理。'}`
      : '没有待整理的历史会话';
    const old = h('div', { class: 'grow' },
      h('div', { class: 'grow-main' }, h('div', { class: 'nm' }, '历史旧会话'), h('div', { class: 'ds', 'data-unorganized': String(n) }, oldDesc)),
      h('div', { class: 'end' }, oldBtn));
    fill(box, head, cfgBox, old);
  }

  async function packAction(fn, okMsg) {
    const r = await guarded(fn);
    if (!r || r.canceled) return;
    if (r.state) setState(r.state);
    toast(okMsg(r));
  }
  const exp = $('#btn-export-mem');
  if (exp) exp.addEventListener('click', () => packAction(() => mem0.exportMemoryPack(), (r) => `已导出记忆包${r.counts ? `（${r.counts.memories || 0} 张卡片、${r.counts.projects || 0} 个事项）` : ''}`));
  const imp = $('#btn-import-mem');
  if (imp) imp.addEventListener('click', () => packAction(() => mem0.importMemoryPack(), (r) => `已导入 ${r.importedMemories || 0} 张卡片、${r.importedProjects || 0} 个事项`));

  // ---------- 汇总 ----------
  function renderExtAll() {
    renderHomeProjects();
    renderSettingsAi();
    if (!document.querySelector('#view-memory.on')) return;
    // 后台推送（新会话入库等）不打断正在填写的表单：编辑中只刷新左侧目录
    const a = document.activeElement;
    const typing = a && a.closest && a.closest('#mem-track') && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
    if (typing || ui.editing || ui.pasteOpen || ui.settling) renderNav(); else renderMemory();
  }

  window.mem0Ext = {
    recMode: () => ui.recMode,
    liSub,
    projectGroups,
    listCount,
    detailParts,
    renderMemory,
    renderAll: renderExtAll,
    openMemory,
  };
  if (state) renderExtAll();
})();
