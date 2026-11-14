/*
 * 采集引擎：监听页面变化 → 用平台适配器读出当前会话 → 有变化就交给后台发往桌面端。
 * 防抖 1.5 秒，流式输出时会多次上报同一条回答，桌面端会原地更新。
 */
(function () {
  'use strict';
  const NS = (globalThis.__mem0 = globalThis.__mem0 || {});

  /** 取元素的可读文本，代码块保留换行并加上 ``` 包裹 */
  NS.readText = function readText(el) {
    if (!el) return '';
    const clone = el.cloneNode(true);
    // 去掉按钮、复制图标、隐藏元素等界面噪音
    clone.querySelectorAll('button, svg, style, script, [aria-hidden="true"], .sr-only, .cdk-visually-hidden').forEach((n) => n.remove());
    clone.querySelectorAll('pre').forEach((pre) => {
      const code = pre.querySelector('code') || pre;
      const lang = ((code.className || '').match(/language-([\w+-]+)/) || [])[1] || '';
      pre.replaceWith(el.ownerDocument.createTextNode(`\n\`\`\`${lang}\n${code.textContent.replace(/\n$/, '')}\n\`\`\`\n`));
    });
    clone.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
    clone.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, tr, blockquote, div').forEach((b) => b.append('\n'));
    clone.querySelectorAll('li').forEach((li) => li.prepend('- '));
    return clone.textContent.replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  };

  /**
   * 「暂时读不了」的标记：适配器的 turns() 返回它（例如显示的视图不属于当前网址、用户正在编辑、
   * 代码块还没挂载），snapshot 原样返回，capture 跳过这一次，不发半截内容。
   */
  NS.pending = (reason) => ({ pending: true, reason });
  NS.isPending = (x) => !!(x && x.pending === true);
  /** 适配器内部用：某条消息正文还没就绪 */
  NS.PENDING_TEXT = { pending: true, reason: 'text' };

  /** 读出当前页面的会话快照；不是会话页返回 null；暂时读不了返回 NS.pending(…) */
  NS.snapshot = function snapshot(platform, doc, url) {
    const id = platform.conversationId(url);
    if (!id) return null;
    const turns = platform.turns(doc, url);
    if (NS.isPending(turns)) return turns;
    const messages = [];
    for (const t of turns) {
      const raw = t.text !== undefined ? t.text : (platform.text ? platform.text(t.el, t.role) : NS.readText(t.el));
      if (NS.isPending(raw)) return NS.pending('text');
      const text = raw.trim();
      if (!text) continue;
      const last = messages[messages.length - 1];
      if (last && last.role === t.role && t.role === 'assistant') last.content += '\n\n' + text;
      else messages.push({ role: t.role, content: text });
    }
    if (!messages.some((m) => m.role === 'user')) return null;
    let title = null;
    try { title = platform.title ? platform.title(doc) : null; } catch { /* ignore */ }
    const u = new URL(url);
    return {
      platform: platform.id,
      externalId: id,
      title: title || undefined,
      url: u.origin + u.pathname + (platform.id === 'google-ai-mode' || platform.id === 'qianwen' ? u.search : ''),
      messages,
    };
  };

  function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36) + ':' + s.length;
  }

  // 测试环境（node）里只导出函数，不启动
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return;

  const platform = NS.platformFor(location.hostname);
  if (!platform) return;

  let lastHash = null;
  let lastSnapshot = null;
  let timer = null;
  let retry = null;
  let enabled = true;

  chrome.storage.local.get(['paused', 'disabledPlatforms']).then((s) => {
    enabled = !s.paused && !(s.disabledPlatforms || []).includes(platform.id);
  });
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.paused || changes.disabledPlatforms) {
      chrome.storage.local.get(['paused', 'disabledPlatforms']).then((s) => {
        enabled = !s.paused && !(s.disabledPlatforms || []).includes(platform.id);
        if (enabled) schedule();
      });
    }
  });

  /** 弹窗只需要状态摘要，不保留整份会话内容 */
  function summarize(snap) {
    return snap ? { messages: snap.messages.length, title: snap.title } : null;
  }

  function capture() {
    clearTimeout(timer);
    timer = null;
    if (!enabled || document.visibilityState === 'prerender') return;
    let snap;
    try { snap = NS.snapshot(platform, document, location.href); } catch (e) { console.debug('[mem0] capture failed', e); return; }
    if (NS.isPending(snap)) {
      // 暂时读不了：保留上一份快照，不上报；页面一般会再变动触发重读，这里再兜底重试一次（不叠加）
      if (!retry) retry = setTimeout(() => { retry = null; schedule(); }, 3000);
      return;
    }
    lastSnapshot = summarize(snap);
    if (!snap) return;
    const h = hash(JSON.stringify([snap.externalId, snap.title, snap.messages]));
    if (h === lastHash) return;
    lastHash = h;
    snap.capturedAt = Date.now();
    try {
      chrome.runtime.sendMessage({ type: 'capture', conversation: snap }).catch(() => { lastHash = null; });
    } catch {
      // 扩展被更新/重载后，旧页面里的脚本已失效：停止监听
      observer.disconnect();
    }
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(capture, 1500);
  }

  /** 输入框、菜单/提示/状态提示里的变动与对话内容无关，不触发采集 */
  function unrelated(n) {
    const el = n && (n.nodeType === 1 ? n : n.parentElement);
    if (!el || !el.closest) return false;
    return !!el.closest('textarea, input, [contenteditable]:not([contenteditable="false"]), [role="tooltip"], [role="menu"], [role="status"]');
  }
  function notConversation(r) {
    if (unrelated(r.target)) return true;
    // 插入/移除的节点本身就在无关区域里（例如挂载到 body 上的 tooltip）
    const changed = [...r.addedNodes, ...r.removedNodes];
    return changed.length > 0 && changed.every(unrelated);
  }

  const observer = new MutationObserver((records) => {
    if (records.every(notConversation)) return;
    schedule();
  });
  // 也听显隐变化：ChatGPT 切换会话时可能只是把旧视图 display:none、新视图显示出来
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['style', 'hidden'] });

  // 单页应用切换会话时 URL 会变
  let lastUrl = location.href;
  setInterval(() => { if (location.href !== lastUrl) { lastUrl = location.href; lastHash = null; schedule(); } }, 1000);
  // 关闭/切走标签页前补一次
  addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') capture(); });

  // 弹窗查询当前页状态
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg && msg.type === 'pageStatus') {
      if (!lastSnapshot) {
        try { const s = NS.snapshot(platform, document, location.href); if (!NS.isPending(s)) lastSnapshot = summarize(s); } catch { /* ignore */ }
      }
      reply({ platform: platform.id, enabled, conversation: !!lastSnapshot, messages: lastSnapshot ? lastSnapshot.messages : 0, title: lastSnapshot && lastSnapshot.title });
    }
  });

  schedule();
})();
