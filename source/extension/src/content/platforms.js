/*
 * 各网页 AI 的 DOM 适配器。
 * 每个平台：
 *   id            与桌面端约定的 platform 名
 *   hosts         命中的域名
 *   conversationId(url)  从地址栏取会话 id；返回 null 表示当前不是会话页（例如首页、新对话还没发出去）
 *   turns(doc)    返回按页面顺序排列的 [{ role:'user'|'assistant', el }]
 *   text(el, role) 可选，自定义取文本
 *   title(doc)    可选
 *
 * 网站改版会让选择器失效，所以每处都给了多组候选，按顺序尝试。
 * 只读页面 DOM，不调用任何网站的私有接口。
 */
(function () {
  'use strict';
  const NS = (globalThis.__mem0 = globalThis.__mem0 || {});

  /** 依次尝试多个选择器，返回第一个有结果的 */
  function firstAll(root, selectors) {
    for (const s of selectors) {
      const list = root.querySelectorAll(s);
      if (list.length) return Array.from(list);
    }
    return [];
  }
  function first(root, selectors) {
    for (const s of selectors) {
      const el = root.querySelector(s);
      if (el) return el;
    }
    return null;
  }
  /** 把两组元素合并并按文档顺序排列 */
  function interleave(users, assistants) {
    const all = users.map((el) => ({ role: 'user', el })).concat(assistants.map((el) => ({ role: 'assistant', el })));
    all.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    // 去掉被另一个命中元素包含的重复节点
    return all.filter((t, i) => !all.some((o, j) => j !== i && o.el !== t.el && o.el.contains(t.el)));
  }
  function pathMatch(url, re) {
    const m = new URL(url).pathname.match(re);
    return m ? m[1] : null;
  }
  function cleanTitle(t, suffixes) {
    let s = (t || '').trim();
    for (const suf of suffixes) if (s.endsWith(suf)) s = s.slice(0, -suf.length).trim();
    return s;
  }

  /*
   * ChatGPT：2026-09-24 起分账号灰度的新版 DOM 不再有 data-message-author-role。
   * 新版每条消息是一个「消息单元」，data-content-search-unit-key 以 :user / :assistant 结尾声明身份；
   * 旧版结构保留兼容。data-markdown-text-style="assistant-message" 只是排版样式，不代表身份（Dot 里用户也用它）。
   */
  const CG_UNIT = '[data-content-search-unit-key]';
  const CG_LEGACY = 'div[data-message-author-role="user"], div[data-message-author-role="assistant"]';
  const CG_USER_BODY = '[data-user-message-bubble]';
  const CG_AI_BODY = '[data-markdown-text-style="assistant-message"]';
  const CG_TURN = '[data-testid^="conversation-turn-"], [data-turn-key]';
  const CG_VIEW = 'main, [role="main"]';
  const CG_DECLARED_ID = '[data-map-composer-conversation], [data-chatgpt-selection-conversation-id]';
  const CG_SERVER_ID = /^[0-9a-f]{8}-[0-9a-f-]{27}$/;
  const CG_CHROME = 'button, [aria-hidden="true"]';
  const CG_USER_SKIP = 'button, [aria-hidden="true"], textarea, input, select';
  // AI 正文只排除明确的界面控件；带 aria-label 的按钮其可见文字是内容（如文档卡片标题），照常读取
  const CG_AI_SKIP = '[data-markdown-copy="exclude"], a[data-testid="chatgpt-citation"], button:not([aria-label]), textarea, input, select';
  const CG_DOT_ROW = '.message-row[data-message-id]';
  const CG_DOT_BODY = '.message-body [data-markdown-text-style]';
  const CG_DOT_CHROME = '[data-markdown-copy="exclude"], [role="status"], time, button:not([aria-label])';

  function isDisplayed(el) {
    const view = el.ownerDocument.defaultView;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (view.getComputedStyle(n).display === 'none') return false;
    }
    return true;
  }

  /** 代码组件：null = 普通 pre；{pending} = 组件壳已在、代码正文还没挂载；{text, lang} = 就绪 */
  function codeComponent(pre) {
    const simple = pre.querySelector('pre[data-conv-search-result-highlight-render-pending]');
    const viewer = pre.querySelector('#code-block-viewer.cm-editor');
    const surface = pre.querySelector('[class*="--code-block-surface"]');
    if (!simple && !viewer && !surface) return null;
    const code = simple ? simple.querySelector(':scope > code') : (viewer || surface).querySelector('.cm-scroller > pre.cm-content > code');
    if (!code) return { pending: true };
    const lang = ((code.className || '').match(/language-([\w+-]+)/) || [])[1] || '';
    return { text: (code.textContent || '').replace(/\n$/, ''), lang };
  }

  /** 复制出可读部分：去掉跳过的控件、隐藏节点；代码组件换成干净的 pre>code。遇到未挂载的代码返回 null */
  function cleanClone(el, skip) {
    const doc = el.ownerDocument;
    const view = doc.defaultView;
    let pending = false;
    const visit = (node) => {
      if (node.nodeType === 3) return doc.createTextNode(node.textContent);
      if (node.nodeType !== 1) return null;
      if (skip && node.matches(skip)) return null;
      if (node.tagName === 'PRE') {
        const c = codeComponent(node);
        if (c && c.pending) { pending = true; return null; }
        if (c) {
          const pre = doc.createElement('pre'); const code = doc.createElement('code');
          if (c.lang) code.className = 'language-' + c.lang;
          code.textContent = c.text; pre.appendChild(code);
          return pre;
        }
      }
      const st = view.getComputedStyle(node);
      if (st.display === 'none' || st.visibility === 'hidden') {
        // 已挂载的代码正文不随组件显隐消失，其余隐藏 UI 不读
        const frag = doc.createDocumentFragment();
        for (const pre of node.querySelectorAll('pre')) {
          if (pre.parentElement.closest('pre')) continue;
          const c = codeComponent(pre);
          if (c && c.pending) pending = true;
          else if (c) { const x = visit(pre); if (x) frag.appendChild(x); }
        }
        return frag;
      }
      let copy;
      if (node.tagName === 'BUTTON') copy = doc.createElement('span'); // 只有带 aria-label 的按钮走到这里：保留其文字
      else copy = node.cloneNode(false);
      for (const ch of node.childNodes) { const x = visit(ch); if (x) copy.appendChild(x); }
      return copy;
    };
    const out = visit(el);
    return pending ? null : out;
  }

  /** AI/Dot 正文：没有代码组件和控件时直接读；否则先清理再读。未就绪返回 NS.PENDING_TEXT */
  function aiText(body) {
    const fast = !body.querySelector(CG_AI_SKIP) && !Array.from(body.querySelectorAll('pre')).some((p) => codeComponent(p));
    if (fast) return NS.readText(body);
    const c = cleanClone(body, CG_AI_SKIP);
    return c ? NS.readText(c) : NS.PENDING_TEXT;
  }

  /** 用户正文所在最深节点：沿唯一的正文子树下行，绕开「显示更多/收起」等控件 */
  function userRoot(el) {
    let root = el;
    while (root.querySelector(CG_CHROME)) {
      if (Array.from(root.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim())) break;
      const kids = Array.from(root.children).filter((c) => !c.matches(CG_CHROME) && c.textContent.trim());
      if (kids.length !== 1) break;
      root = kids[0];
    }
    return root;
  }

  /** 用户正文：最深正文节点，去掉控件与表单框（改写框里的草稿不算已发送的内容） */
  function userText(el) {
    const root = userRoot(el);
    return NS.readText(cleanClone(root, CG_USER_SKIP) || root);
  }

  const viewOwners = new WeakMap(); // 视图节点 → 首次读取时的网址 id（只用于 local-chatgpt: 临时 id）
  const CG = {
    /** 当前网址可读的会话视图；null = 显示的内容不属于当前网址（或没有可见视图），本次不读 */
    readableView(doc, url) {
      const views = Array.from(doc.querySelectorAll(CG_VIEW)).filter((v) => !v.querySelector(CG_VIEW));
      if (!views.length) return doc.body; // 页面没有 main 时整页读取（旧版/夹具）
      const view = views.find(isDisplayed);
      if (!view) return null;
      const d = view.querySelector(CG_DECLARED_ID);
      const declared = (d && (d.getAttribute('data-map-composer-conversation') || d.getAttribute('data-chatgpt-selection-conversation-id'))) || '';
      if (!declared) return view;
      const urlId = new URL(url).pathname.replace(/\/$/, '').split('/').pop();
      if (CG_SERVER_ID.test(declared)) return declared === urlId ? view : null;
      // 临时 id 无法与网址比对：视图首次在哪条会话下读取就属于哪条；声明变了说明节点被复用，重新认定
      const owner = viewOwners.get(view);
      if (owner && owner.declared === declared) return owner.urlId === urlId ? view : null;
      viewOwners.set(view, { urlId, declared });
      return view;
    },
    convTurns(view) {
      const turns = Array.from(view.querySelectorAll(`article, ${CG_TURN}`));
      if (turns.some((t) => t.querySelector('textarea:focus'))) return NS.pending('editing'); // 用户正在改写消息，本次不读
      const hits = Array.from(view.querySelectorAll(`${CG_UNIT}, ${CG_LEGACY}`));
      // 新旧标记同时出现时只认最外层，避免重复
      const els = hits.filter((el) => !hits.some((o) => o !== el && o.contains(el)));
      return els.flatMap((el) => {
        if (!el.matches(CG_UNIT)) {
          if (el.getAttribute('data-message-author-role') === 'user') {
            return [{ role: 'user', el, text: userText(first(el, ['.whitespace-pre-wrap']) || el) }];
          }
          const body = first(el, ['.markdown.prose', '.markdown', '[class*="markdown"]']);
          return [{ role: 'assistant', el, text: body ? aiText(body) : '' }];
        }
        const role = (el.getAttribute('data-content-search-unit-key').match(/:(user|assistant)$/) || [])[1];
        // 一个单元出现多个正文块时逐个成条，避免静默少存；思考区不在正文块内，不读
        if (role === 'user') return Array.from(el.querySelectorAll(CG_USER_BODY), (b) => ({ role: 'user', el: b, text: userText(b) }));
        if (role === 'assistant') return Array.from(el.querySelectorAll(CG_AI_BODY), (b) => ({ role: 'assistant', el: b, text: aiText(b) }));
        return [];
      });
    },
    dotTurns(view) {
      return Array.from(view.querySelectorAll(CG_DOT_ROW)).flatMap((row) => {
        const role = row.classList.contains('self') ? 'user' : 'assistant';
        const body = row.querySelector(CG_DOT_BODY);
        if (body) return [{ role, el: row, text: aiText(body) }];
        // 没有正文块的气泡（如通话记录）：取除时间、已读状态、无标签按钮外的文字
        const c = cleanClone(row, CG_DOT_CHROME);
        const text = c ? c.textContent.replace(/\s+/g, ' ').trim() : '';
        return text ? [{ role, el: row, text }] : [];
      });
    },
  };

  // Gemini：展开的「思考过程」块只用于展示，不属于正式回答
  const GEMINI_THOUGHTS = 'model-thoughts, [class*="model-thoughts"], .thoughts-container, [data-test-id*="thought"]';

  const platforms = [
    {
      id: 'chatgpt',
      hosts: ['chatgpt.com', 'chat.openai.com'],
      // /c/<id>、/g/<gpt>/c/<id>；Dot（/dots/<id>）是一条持续增长的会话，加 dots- 前缀避免与普通会话撞 id
      conversationId: (url) => {
        const p = new URL(url).pathname;
        const dot = p.match(/^\/dots\/([a-z0-9-]+)\/?$/i);
        if (dot) return 'dots-' + dot[1];
        const m = p.match(/^(?:\/g\/[^/]+)?\/c\/([0-9a-f-]{8,})\/?$/i);
        return m ? m[1] : null;
      },
      // 已读出正文（text 字段）；读不了时返回 NS.pending(原因)，本次不上报
      turns: (doc, url) => {
        const view = CG.readableView(doc, url || doc.location.href);
        if (!view) return NS.pending('view');
        const out = /^\/dots\//.test(new URL(url || doc.location.href).pathname) ? CG.dotTurns(view) : CG.convTurns(view);
        if (!Array.isArray(out)) return out;
        return out.some((t) => t.text === NS.PENDING_TEXT) ? NS.pending('code') : out;
      },
      title: (doc) => (/^\/dots\//.test(doc.location.pathname) ? (doc.title || '').trim() : cleanTitle(doc.title, ['- ChatGPT', '| ChatGPT'])) || null,
    },
    (() => {
      /*
       * Claude：每条消息一行 [data-testid="transcript-row"]（旧版 data-test-render-count）。
       * 不能只找 user-message：改写消息时它会被文本框替换，编辑态只能在行内判断。
       */
      const ROW = '[data-testid="transcript-row"], [data-test-render-count]';
      const USER = '[data-testid="user-message"]';
      const AI = '[data-testid="assistant-message"], .font-claude-response';
      // 不属于正文：data-find-omitted（页内搜索跳过区：思考、工具调用、卡片、读屏标题）；message-actions（复制、重试、时间）
      const NON_BODY = '[data-find-omitted], [data-testid="message-actions"]';
      const aiText = (el) => {
        if (!el.querySelector(NON_BODY)) return NS.readText(el);
        const c = el.cloneNode(true);
        c.querySelectorAll(NON_BODY).forEach((n) => n.remove());
        return NS.readText(c);
      };
      return {
      id: 'claude',
      hosts: ['claude.ai'],
      // /chat/<uuid>；Cowork /cowork/cse_<id> 与 Claude Code 云端 /code/session_<id> 用同一套 transcript 标记（列表页不是会话）
      conversationId: (url) => {
        const p = new URL(url).pathname;
        const chat = p.match(/^\/chat\/([0-9a-f-]{8,})\/?$/i);
        if (chat) return chat[1];
        const other = p.match(/^\/(cowork\/cse_[^/]+|code\/session_[^/]+)\/?$/);
        return other ? other[1].replace('/', '_') : null;
      },
      // 不等流式结束：回答长出来就照读，桌面端原地更新
      turns: (doc) => {
        const all = Array.from(doc.querySelectorAll(ROW));
        if (!all.length) {
          // 没有消息行的旧页面：按出现顺序配对
          return interleave(firstAll(doc, [USER]), firstAll(doc, ['.font-claude-response', '[data-testid="assistant-message"]', '.font-claude-message']))
            .map((t) => ({ ...t, text: t.role === 'user' ? NS.readText(t.el) : aiText(t.el) }));
        }
        // 新旧行标记嵌套时取最内层，一行一条
        const rows = all.filter((r) => !all.some((o) => o !== r && r.contains(o)));
        if (rows.some((r) => r.querySelector('textarea:focus'))) return NS.pending('editing');
        return rows.flatMap((row) => {
          const ai = row.querySelector(AI);
          if (ai) return [{ role: 'assistant', el: ai, text: aiText(ai) }];
          const user = row.querySelector(USER);
          return user ? [{ role: 'user', el: user, text: NS.readText(user) }] : [];
        });
      },
      title: (doc) => {
        const t = first(doc, ['[data-testid="chat-title-button"]', 'button[data-testid="chat-menu-trigger"]']);
        return (t && t.textContent.trim()) || cleanTitle(doc.title, ['- Claude']) || null;
      },
      };
    })(),
    {
      id: 'gemini',
      hosts: ['gemini.google.com'],
      // 普通会话 /app/<id>；Gem 里的会话 /gem/<gem>/<id>（原版也支持）；/u/<n>/ 前缀照样匹配
      conversationId: (url) => pathMatch(url, /\/(?:app|gem\/[^/]+)\/([0-9a-z_-]{6,})/i),
      turns: (doc) => interleave(
        firstAll(doc, ['user-query .query-text', 'user-query']),
        firstAll(doc, ['model-response message-content', 'model-response .model-response-text', 'model-response']),
      ),
      text: (el, role) => {
        // 助手回答先剔除展开的思考节点，再读正文；用户消息保持原样
        if (role !== 'assistant') return NS.readText(el);
        const thoughts = el.querySelectorAll(GEMINI_THOUGHTS);
        if (!thoughts.length) return NS.readText(el);
        const clone = el.cloneNode(true);
        clone.querySelectorAll(GEMINI_THOUGHTS).forEach((n) => n.remove());
        return NS.readText(clone);
      },
      title: (doc) => {
        const t = first(doc, ['.conversation.selected .conversation-title', '[data-test-id="conversation-title"]']);
        return (t && t.textContent.trim()) || null;
      },
    },
    {
      id: 'deepseek',
      hosts: ['chat.deepseek.com'],
      conversationId: (url) => pathMatch(url, /\/s\/([0-9a-z-]{8,})/i),
      turns: (doc) => {
        const msgs = firstAll(doc, ['.ds-message', '[class*="ds-message"]']);
        return msgs.map((el) => ({ role: el.querySelector('.ds-markdown') ? 'assistant' : 'user', el }));
      },
      text: (el, role) => {
        if (role === 'assistant') {
          // 只取最终回答，不取「深度思考」的推理过程
          const answers = Array.from(el.querySelectorAll('.ds-markdown')).filter((m) => !m.closest('[class*="think"]'));
          return answers.map((m) => NS.readText(m)).join('\n\n');
        }
        return NS.readText(el);
      },
      title: (doc) => cleanTitle(doc.title, ['- DeepSeek', 'DeepSeek']) || null,
    },
    (() => {
      /*
       * 豆包：消息行 [data-message-id]（已移除 send_message/receive_message testid）。
       * 身份看同一父级里的操作栏：send-message-action-bar = 用户，receive-message-action-bar = AI。
       */
      const ROW = '[data-message-id]';
      const BAR = '[data-foundation-type="send-message-action-bar"], [data-foundation-type="receive-message-action-bar"]';
      // 普通聊天单块、工作任务多块，两种渲染器共用
      const BODY = '.md-box-root, .flow-markdown-body';
      function role(row) {
        const bar = row.parentElement && Array.from(row.parentElement.children).find((c) => c.matches(BAR));
        const type = bar ? bar.getAttribute('data-foundation-type') : '';
        if (type === 'send-message-action-bar') return 'user';
        if (type === 'receive-message-action-bar') return 'assistant';
        // 操作栏可能晚到：用户气泡可凭气泡样式认出；其余没有身份证据的行不默认算 AI，本次跳过
        return !type && row.querySelector('.text-g-send-msg-bubble-text') ? 'user' : null;
      }
      /** 链接在页面上显示为标题，copy-text 里才是原网址：读原网址；隐藏节点不读 */
      function withLinks(el) {
        if (!el.querySelector('[copy-text]')) return el;
        const doc = el.ownerDocument;
        const visit = (node) => {
          if (node.nodeType === 3) return doc.createTextNode(node.textContent);
          if (node.nodeType !== 1) return null;
          const url = node.getAttribute('copy-text');
          if (url && /^https?:\/\//i.test(url)) return doc.createTextNode(url);
          if (doc.defaultView.getComputedStyle(node).display === 'none') return null;
          const copy = node.cloneNode(false);
          for (const ch of node.childNodes) { const x = visit(ch); if (x) copy.appendChild(x); }
          return copy;
        };
        return visit(el);
      }
      function bodyText(row) {
        return Array.from(row.querySelectorAll(BODY))
          .filter((b) => {
            // 只读属于本行、不在思考框里的正文；正文容器嵌套时只读外层
            if (b.closest(ROW) !== row || b.closest('[data-thinking-box-expanded]')) return false;
            const outer = b.parentElement && b.parentElement.closest(BODY);
            return !outer || !row.contains(outer);
          })
          .map((b) => NS.readText(withLinks(b)))
          .filter(Boolean)
          .join('\n\n');
      }
      function legacyTurns(doc) {
        return interleave(firstAll(doc, ['[data-testid="send_message"]']), firstAll(doc, ['[data-testid="receive_message"]'])).map((t) => {
          const parts = Array.from(t.el.querySelectorAll('[data-testid="message_text_content"]')).filter((p) => !p.parentElement.closest('[data-testid="message_text_content"]'));
          return { ...t, text: parts.length ? parts.map((p) => NS.readText(p)).join('\n\n') : NS.readText(t.el) };
        });
      }
      return {
      id: 'doubao',
      hosts: ['www.doubao.com'],
      conversationId: (url) => pathMatch(url, /^\/chat\/(\d{6,})\/?$/),
      // 不等 data-streaming 结束：身份一明确就读当时的正文，桌面端原地更新
      turns: (doc) => {
        const rows = Array.from(doc.querySelectorAll(ROW));
        if (rows.some((r) => r.querySelector('textarea:focus'))) return NS.pending('editing');
        const out = rows.flatMap((row) => {
          const r = role(row);
          if (!r) return [];
          let text = bodyText(row);
          // 旧用户气泡还没用 markdown 渲染器时
          if (!text && r === 'user') { const w = row.querySelector('.whitespace-pre-wrap'); text = w ? NS.readText(w) : ''; }
          return [{ role: r, el: row, text }];
        });
        return out.length ? out : legacyTurns(doc);
      },
      title: (doc) => cleanTitle(doc.title, ['- 豆包']) || null,
      };
    })(),
    (() => {
      /*
       * 元宝：新旧正文共用 data-conv-speaker（human / ai）声明身份，类名只作旧版兼容。
       * 新版消息行带 data-conv-id = <会话 id>_<序号>，用来确认显示的内容属于当前网址。
       */
      const ROW = '[data-conv-speaker="human"], [data-conv-speaker="ai"], .agent-chat__list__item--human, .agent-chat__list__item--ai';
      // 回答区里已确认的过程与界面子树；正文组件变了也默认保留，不按组件白名单取舍
      const EXCLUDE = '.hyc-component-reasoner__think-content, .hyc-component-deep-search-agent__think__header-container, '
        + '.hyc-card-box-process-list, .hyc-follow-up-form, .agent-chat__conv--ai__toolbar';
      const convId = (url) => pathMatch(url, /^\/chat\/[^/]+\/([0-9a-z-]{8,})\/?$/i);
      /** 隐藏缓存不算；屏外位置、content-visibility 不代表另一会话 */
      function shown(el) {
        const view = el.ownerDocument.defaultView;
        for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
          const s = view.getComputedStyle(n);
          if (n.hidden || s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse') return false;
        }
        return true;
      }
      function role(row) {
        const s = row.getAttribute('data-conv-speaker');
        if (s !== null) return s === 'human' ? 'user' : s === 'ai' ? 'assistant' : null;
        if (row.classList.contains('agent-chat__list__item--human')) return 'user';
        if (row.classList.contains('agent-chat__list__item--ai')) return 'assistant';
        return null;
      }
      /**
       * 可读的消息行；null = 暂时读不了。
       * 带 data-conv-id 时：只认全部行都属于当前会话的那一个可见列表，不把新网址和残留的旧 DOM 拼在一起；
       * 同时有多个可读副本就等页面自己消歧，不按 DOM 顺序猜。旧版行没有 data-conv-id，整页读取。
       */
      function readableRows(doc, id) {
        const all = Array.from(doc.querySelectorAll(ROW));
        if (!all.some((r) => r.hasAttribute('data-conv-id'))) {
          return all.filter((r) => !all.some((o) => o !== r && o.contains(r)) && shown(r));
        }
        const matches = [];
        for (const list of doc.querySelectorAll('.agent-chat__list__content')) {
          if (!shown(list)) continue;
          const rows = Array.from(list.querySelectorAll(ROW)).filter(shown);
          const own = (r) => {
            const cid = r.getAttribute('data-conv-id') || '';
            const i = cid.lastIndexOf('_');
            return role(r) && i > 0 && cid.slice(0, i) === id && /^\d+$/.test(cid.slice(i + 1));
          };
          if (rows.length && rows.every(own)) matches.push(rows);
        }
        return matches.length === 1 ? matches[0] : null;
      }
      /** 去掉过程/界面子树和隐藏节点 */
      function prune(el) {
        const doc = el.ownerDocument;
        const visit = (node) => {
          if (node.nodeType === 3) return doc.createTextNode(node.textContent);
          if (node.nodeType !== 1 || node.matches(EXCLUDE) || !shownSelf(node)) return null;
          const copy = node.cloneNode(false);
          for (const ch of node.childNodes) { const x = visit(ch); if (x) copy.appendChild(x); }
          return copy;
        };
        return visit(el) || doc.createElement('div');
      }
      function shownSelf(n) {
        const s = n.ownerDocument.defaultView.getComputedStyle(n);
        return !(n.hidden || s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse');
      }
      function aiText(row) {
        const areas = Array.from(row.querySelectorAll('.agent-chat__conv--ai__speech_show'));
        let body;
        if (areas.length) {
          // 新旧实页共用的当前回答区；同时显示多个（切换中）时本条不读
          const visible = areas.filter(shown);
          body = visible.length === 1 ? visible[0] : null;
        } else {
          // 旧版没有共同包装的载体；缺正文时不扩大到整行，免得思考和操作栏冒充回答
          body = first(row, ['.hyc-component-reasoner__text', '.agent-chat__speech-text', '.hyc-component-deep-search-agent > .hyc-content-md'])
            || Array.from(row.querySelectorAll('.hyc-content-md')).find((m) => !m.closest(EXCLUDE)) || null;
        }
        return body && shown(body) ? NS.readText(prune(body)) : '';
      }
      return {
      id: 'yuanbao',
      hosts: ['yuanbao.tencent.com'],
      conversationId: convId,
      turns: (doc, url) => {
        const rows = readableRows(doc, convId(url || doc.location.href));
        if (!rows) return NS.pending('view');
        if (rows.some((r) => r.querySelector('textarea:focus'))) return NS.pending('editing');
        return rows.map((row) => {
          const r = role(row);
          if (r === 'assistant') return { role: r, el: row, text: aiText(row) };
          const u = first(row, ['.hyc-content-text', '.agent-chat__bubble__content']) || (row.hasAttribute('data-conv-id') ? null : row);
          return { role: r, el: row, text: u ? NS.readText(u) : '' };
        });
      },
      title: (doc) => {
        const t = first(doc, ['.agent-dialogs__title', '.yb-common-nav__title']);
        return (t && t.textContent.trim()) || null;
      },
      };
    })(),
    {
      id: 'kimi',
      hosts: ['www.kimi.com', 'kimi.moonshot.cn'],
      conversationId: (url) => pathMatch(url, /\/chat\/([0-9a-z-]{8,})/i),
      turns: (doc) => interleave(
        firstAll(doc, ['.chat-content-item-user', '[class*="segment-user"]']),
        firstAll(doc, ['.chat-content-item-assistant', '[class*="segment-assistant"]']),
      ),
      text: (el, role) => {
        if (role === 'assistant') {
          // 思考摘要（旧 .think-stage / 新 .thinking-container）也用 .markdown-container，必须排除，只取最终回答
          const parts = Array.from(el.querySelectorAll('.markdown-container, .editor-content'))
            .filter((n) => !n.closest('.think-stage, .thinking-container'))
            .filter((n, i, all) => !all.some((o) => o !== n && o.contains(n)));
          if (parts.length) return parts.map((n) => NS.readText(n)).filter(Boolean).join('\n\n');
          return NS.readText(first(el, ['.markdown']) || el);
        }
        const users = Array.from(el.querySelectorAll('.user-content'));
        if (users.length) return users.map((n) => NS.readText(n)).filter(Boolean).join('\n\n');
        return NS.readText(first(el, ['.segment-content-box']) || el);
      },
      title: (doc) => cleanTitle(doc.title, ['- Kimi', '- Kimi AI']) || null,
    },
    (() => {
      // 千问（按原版 chatmemo 千问适配器重写）
      // 新版：正文根 #qw-chat-content，问 = [data-chat-question-wrap]，答 = [data-chat-answers-wrap]。
      //   新版答案外包装的属性「值」也以 -question 结尾，所以角色只看属性名。
      //   页面上有重复 id 的 message-list-scroller，只在正文根里找；新旧标记并存时只走新版，避免同一条读两遍。
      //   用户正文 = .question-text-card；回答正文 = .markdown-pc-special-class（可能有多块，卡片回答也用它），
      //   深度思考也复用这个 markdown 标记，按所在区域 [class*="deepThinkContent-"] 排除，不看展开/折叠。
      // 旧版：正文根 #qwen-message-list-area，[data-msgid$="-question"] / [data-msgid$="-answer"]。
      // 两个根都没有时退回更早的 class 结构（questionItem / answerItem）。
      const AI_BODY = '.markdown-pc-special-class';
      /** 一条消息里的正文块：跳过 skip 区域，嵌套命中只取最外层 */
      const blocks = (el, sel, skip) => Array.from(el.querySelectorAll(sel)).filter((n) => {
        if (skip && n.closest(skip)) return false;
        const outer = n.parentElement && n.parentElement.closest(sel);
        return !outer || !el.contains(outer);
      });
      const legacy = (doc) => interleave(
        firstAll(doc, ['[class*="questionItem"]', '.chat-user-message', '[data-role="user"]']),
        firstAll(doc, ['[class*="answerItem"]', '.chat-response-message', '[data-role="assistant"]']),
      ).map((t) => {
        const body = t.role === 'assistant'
          ? blocks(t.el, AI_BODY, '[class*="deepThinkContent-"]')[0] || first(t.el, ['.markdown-body', '[class*="markdown"]'])
          : first(t.el, ['[class*="bubble"]']);
        return { role: t.role, el: t.el, text: NS.readText(body || t.el) };
      });
      return {
        id: 'qianwen',
        hosts: ['www.qianwen.com', 'tongyi.aliyun.com', 'chat.qwen.ai'],
        conversationId: (url) => {
          const u = new URL(url);
          return u.searchParams.get('sessionId') || pathMatch(url, /\/(?:chat|c)\/([0-9a-z-]{8,})/i);
        },
        turns: (doc) => {
          const modern = doc.querySelector('#qw-chat-content');
          const root = modern || doc.querySelector('#qwen-message-list-area');
          if (!root) return legacy(doc);
          const items = Array.from(root.querySelectorAll(modern
            ? '[data-chat-question-wrap], [data-chat-answers-wrap]'
            : '[data-msgid$="-question"], [data-msgid$="-answer"]'));
          // 用户正在改写某条提问（消息里的 textarea 有焦点）：这次不读
          if (items.some((el) => el.querySelector('textarea:focus'))) return NS.pending('editing');
          return items.map((el) => {
            const user = modern ? el.hasAttribute('data-chat-question-wrap') : el.getAttribute('data-msgid').endsWith('-question');
            let text;
            if (modern) {
              const nodes = user ? blocks(el, '.question-text-card') : blocks(el, AI_BODY, '[class*="deepThinkContent-"]');
              text = nodes.map((n) => NS.readText(n)).filter(Boolean).join('\n\n');
            } else {
              const n = el.querySelector(user ? '[class*="bubble"]' : AI_BODY);
              text = n ? NS.readText(n) : '';
            }
            return { role: user ? 'user' : 'assistant', el, text };
          });
        },
        title: (doc) => cleanTitle(doc.title, ['- 千问', '- 通义', '- Qwen']) || null,
      };
    })(),
    (() => {
      // Google AI Mode（按原版 chatmemo 的 Google AI Mode 适配器重写）
      // 一轮问答 = [data-scope-id="turn"]。只读可见的 turn（自身和祖先都没有 hidden / aria-hidden / display:none /
      // visibility:hidden），并且它们必须都在同一个 main 里；否则这次什么都不读（隐藏的历史不算）。
      // 提问：可见标题 h2.iMqumd（去掉「您说：/You said:」前缀）；回答区 [data-subtree="aimc"] 里、main-col 之外的
      //   h3 无障碍标题里引号中的原问题。Google 恢复历史时会把可见提问的全角「：？」改成半角，
      //   这时以无障碍标题里的原文为准；两者实质不同时用可见提问。
      // 回答：[data-subtree="aimc"] [data-container-id="main-col"]，按 DOM 角色排除按钮、隐藏弹层、对话框、状态提示等，
      //   只看 CSS 可见性，不看尺寸（屏外或延迟渲染的正文照样读）。
      // 页面上没有 turn 标记时退回旧结构（[data-subtree="aimc"] 块 + 标题 / .mZJni）。
      const BLOCK = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DIV', 'DL', 'FIELDSET', 'FIGCAPTION',
        'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR',
        'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL']);
      const SKIP = 'button, [role="button"], script, style, noscript, template, svg, input, select, textarea, ' +
        '[hidden], [aria-hidden="true"], [role="dialog"], [role="status"]';
      const cssHidden = (el) => {
        const cs = el.ownerDocument.defaultView.getComputedStyle(el);
        return cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse';
      };
      const shown = (el) => {
        for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
          if (n.matches('[hidden], [aria-hidden="true"]') || cssHidden(n)) return false;
        }
        return true;
      };
      const ROOT = 'main, [role="main"]';
      function liveTurns(doc) {
        const turns = Array.from(doc.querySelectorAll('[data-scope-id="turn"]')).filter(shown);
        const root = turns[0] && turns[0].closest(ROOT);
        if (!root || !turns.every((t) => t.closest(ROOT) === root)) return [];
        return turns;
      }
      function answerText(root) {
        if (!root) return '';
        const out = [];
        const nl = () => { if (out.length && out[out.length - 1] !== '\n') out.push('\n'); };
        const visit = (node) => {
          if (node.nodeType === 3) { out.push(node.nodeValue || ''); return; }
          if (node.nodeType !== 1) return;
          if (node.matches(SKIP) || cssHidden(node)) return;
          if (node.tagName === 'BR') { nl(); return; }
          const block = BLOCK.has(node.tagName);
          if (block) nl();
          for (const c of node.childNodes) visit(c);
          if (block) nl();
        };
        visit(root);
        return out.join('').replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n')
          .replace(/\n{3,}/g, '\n\n').trim();
      }
      function userText(turn) {
        let visible = '';
        const h2 = turn.querySelector('h2.iMqumd');
        if (h2) {
          const raw = (h2.innerText || h2.textContent || '').trim();
          const stripped = raw.replace(/^(?:您说|You said)[：:]\s*/i, '').trim();
          if (stripped && stripped !== raw) visible = stripped;
        }
        // 回答区里、正文 main-col 之外的 h3 标题，引号里是原问题（正文里带引号的小标题不算）
        const h3 = Array.from(turn.querySelectorAll('[data-subtree="aimc"] h3, h3.MheKwc'))
          .find((h) => !h.closest('[data-container-id="main-col"]'));
        const label = (h3 && h3.textContent.trim()) || '';
        const open = Math.min(...['“', '"'].map((c) => { const i = label.indexOf(c); return i < 0 ? Infinity : i; }));
        const close = Math.max(label.lastIndexOf('”'), label.lastIndexOf('"'));
        const original = Number.isFinite(open) && close > open ? label.slice(open + 1, close).trim() : '';
        if (!visible) return original;
        if (!original) return visible;
        const halfWidth = original.replace(/[：？]/g, (c) => (c === '：' ? ':' : '?'));
        return visible === original || visible === halfWidth ? original : visible;
      }
      function legacy(doc) {
        const out = [];
        for (const b of firstAll(doc, ['[data-subtree="aimc"]', '[data-container-id="main-col"]'])) {
          const q = first(b, ['[role="heading"][aria-level="2"]', '.VndcI']);
          if (q) out.push({ role: 'user', el: q, text: NS.readText(q) });
          // 不能取 b 的第一个子 div：问题标题就在里面；取不到回答容器就用整块，并去掉标题
          const a = first(b, ['.mZJni']) || b;
          const clone = a.cloneNode(true);
          clone.querySelectorAll('[role="heading"][aria-level="2"], button, [aria-hidden="true"]').forEach((n) => n.remove());
          out.push({ role: 'assistant', el: a, text: NS.readText(clone) });
        }
        return out;
      }
      return {
        id: 'google-ai-mode',
        hosts: ['www.google.com'],
        // AI Mode 的地址是 /search?udm=50&q=…，同一段对话会带同一个 mtid/mstk 参数
        conversationId: (url) => {
          const u = new URL(url);
          if (u.pathname !== '/search' || u.searchParams.get('udm') !== '50') return null;
          return u.searchParams.get('mtid') || u.searchParams.get('mstk') || null;
        },
        turns: (doc) => {
          if (!doc.querySelector('[data-scope-id="turn"]')) return legacy(doc);
          const turns = liveTurns(doc);
          if (turns.some((t) => t.querySelector('textarea:focus'))) return NS.pending('editing');
          const out = [];
          for (const turn of turns) {
            out.push({ role: 'user', el: turn, text: userText(turn) });
            const a = turn.querySelector('[data-subtree="aimc"] [data-container-id="main-col"]');
            out.push({ role: 'assistant', el: a || turn, text: answerText(a) });
          }
          return out;
        },
        title: (doc) => {
          const q = new URL(doc.location ? doc.location.href : location.href).searchParams.get('q');
          if (q) return q;
          const t = liveTurns(doc)[0];
          const s = t ? userText(t) : '';
          return s ? (s.length > 50 ? `${s.slice(0, 50)}...` : s) : null;
        },
      };
    })(),
    // Grok：只适配 grok.com（不含 x.com/i/grok）。
    // 已核实（OpenCLI #1392，2026-05 现网）：会话地址 /c/<uuid>；消息 [data-testid="user-message"] / [data-testid="assistant-message"]；
    // 每轮外层 div#response-<uuid>（用户轮带 items-end），气泡 .message-bubble，正文 .response-content-markdown。
    // 猜测（未在现网核实）：思考区/引用/通知的排除选择器、/chat/<id> 旧地址、/project/<pid>/c/<id>。
    (() => {
      const USER = '[data-testid="user-message"]';
      const AI = '[data-testid="assistant-message"]';
      const BODY = '.response-content-markdown';
      const THINK = '[class*="thinking" i], [class*="reasoning" i], [data-testid*="thinking" i], [data-testid*="reasoning" i], [data-testid*="thought" i]';
      const SKIP = `${THINK}, .action-buttons, section.auto-notification, [data-testid*="citation" i], [role="button"][aria-expanded], textarea, input, select, [contenteditable="true"]`;
      const outermost = (els) => els.filter((e) => !els.some((o) => o !== e && o.contains(e)));
      const strip = (el) => { const c = el.cloneNode(true); c.querySelectorAll(SKIP).forEach((n) => n.remove()); return c; };
      const inThink = (n, root) => { for (let p = n.parentElement; p && p !== root; p = p.parentElement) if (p.matches(THINK)) return true; return false; };
      const isUserWrap = (w) => w.classList.contains('items-end') || !!w.querySelector('.message-bubble.user, [class*="user-message"]');
      return {
        id: 'grok',
        hosts: ['grok.com'],
        conversationId: (url) => pathMatch(url, /^(?:\/project\/[^/]+)?\/(?:c|chat)\/([0-9a-z-]{8,})\/?$/i),
        turns: (doc) => {
          let out = interleave(Array.from(doc.querySelectorAll(USER)), Array.from(doc.querySelectorAll(AI)));
          if (!out.length) {
            // 兜底 1：每轮外层 div#response-<uuid>，用 items-end 判断用户
            const wraps = outermost(Array.from(doc.querySelectorAll('div[id^="response-"]')).filter((w) => w.querySelector('.message-bubble')));
            out = wraps.map((w) => ({ role: isUserWrap(w) ? 'user' : 'assistant', el: w.querySelector('.message-bubble') }));
          }
          if (!out.length) {
            // 兜底 2：只有 .message-bubble，用 .user 类或最近的 items-end 祖先判断
            out = outermost(Array.from(doc.querySelectorAll('.message-bubble')))
              .map((el) => ({ role: el.classList.contains('user') || (el.parentElement && el.parentElement.closest('.items-end') && !el.parentElement.closest('.items-start')) ? 'user' : 'assistant', el }));
          }
          // 正在改写某条消息（气泡里出现输入框）：本次不读，免得把这条读成空
          if (out.some((t) => t.el.querySelector('textarea, [contenteditable="true"]'))) return NS.pending('editing');
          return out;
        },
        text: (el) => {
          const bodies = outermost(Array.from(el.querySelectorAll(BODY)).filter((b) => !inThink(b, el)));
          const parts = (bodies.length ? bodies : [el]).map((b) => NS.readText(strip(b))).filter(Boolean);
          return parts.join('\n\n');
        },
        title: (doc) => {
          const t = cleanTitle(doc.title, ['- Grok', '| Grok', '— Grok']);
          return t && t !== 'Grok' ? t : null;
        },
      };
    })(),
    // Hark：hark.com/chat（主会话）与 /project/<id>（项目会话）。
    // 已核实（hark.com 前端打包代码，2026-11-12）：路由 /chat、/chat/:messageId、/project/:projectId、/project/:projectId/:messageId；
    // 消息节点带 [data-bubble-id]；独立卡片 data-testid = summary-card / summary-reader / text-template-card / code-card；
    // 代理执行过程窗口 [data-agent-activity-window]；气泡底色变量 --bubble-user-bg / --bubble-agent-bg。
    // 猜测（未登录无法看到聊天页 DOM）：用户/Hark 的区分方式。按顺序尝试：显式角色属性 → 气泡 id 前缀 → aria-label/类名 →
    // 计算后底色与 --bubble-user-bg 比较 → 气泡在所在列里靠右（用户）/靠左（Hark）。都判断不出时当作 Hark。
    (() => {
      const BUBBLE = '[data-bubble-id]';
      const CARD = '[data-testid="summary-card"], [data-testid="summary-reader"], [data-testid="text-template-card"], [data-testid="code-card"]';
      const ACTIVITY = '[data-agent-activity-window]';
      const SKIP = `${ACTIVITY}, [role="menu"], [role="menuitem"], [role="toolbar"], [role="status"], [role="tooltip"], textarea, input, select, time`;
      const ATTRS = ['data-role', 'data-author', 'data-author-role', 'data-message-role', 'data-message-author-role', 'data-sender', 'data-from', 'data-side', 'data-bubble-role', 'data-bubble-kind', 'data-variant', 'data-kind', 'data-origin', 'data-direction'];
      const USER_V = /^(user|me|self|human|mine|outgoing|outbound|sent|right|you)$/i;
      const AI_V = /^(assistant|agent|hark|ai|bot|model|incoming|inbound|received|left)$/i;
      function color(s) {
        s = (s || '').trim();
        let m = s.match(/^#([0-9a-f]{3,8})$/i);
        if (m) {
          let h = m[1];
          if (h.length <= 4) h = h.split('').map((c) => c + c).join('');
          const n = (i) => parseInt(h.slice(i, i + 2), 16);
          return [n(0), n(2), n(4), h.length === 8 ? Math.round((n(6) / 255) * 100) / 100 : 1];
        }
        m = s.match(/^rgba?\(([^)]+)\)$/i);
        if (!m) return null;
        const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
        return p.length >= 3 && p.every(Number.isFinite) ? [p[0], p[1], p[2], p.length > 3 ? p[3] : 1] : null;
      }
      const same = (a, b) => a && b && a.every((v, i) => Math.abs(v - b[i]) <= (i === 3 ? 0.02 : 1));
      function roleOf(el) {
        const win = el.ownerDocument.defaultView;
        // 0 新版气泡排版：用户气泡的第一个子元素带 data-align="end"，Hark 回复不带（或 start）。
        // 自身/祖先也看，但不越过另一个气泡。其余判断保留作后备。
        const aligned = el.querySelector(':scope > [data-align="end"], :scope > [data-align="start"]');
        if (aligned) return aligned.getAttribute('data-align') === 'end' ? 'user' : 'assistant';
        for (let n = el, d = 0; n && n.nodeType === 1 && d < 7; n = n.parentElement, d++) {
          if (n !== el && n.matches(BUBBLE)) break;
          const a = n.getAttribute('data-align');
          if (a === 'end') return 'user';
          if (a === 'start') return 'assistant';
        }
        // 1 显式角色属性（自身及向上 6 层，遇到另一个气泡停止）
        for (let n = el, d = 0; n && n.nodeType === 1 && d < 7; n = n.parentElement, d++) {
          if (n !== el && n.matches(BUBBLE)) break;
          for (const a of ATTRS) {
            const v = n.getAttribute(a);
            if (!v) continue;
            if (USER_V.test(v)) return 'user';
            if (AI_V.test(v)) return 'assistant';
          }
          const lab = n.getAttribute('aria-label') || '';
          if (/^(you|your message|you said|me|我|我的消息)\b/i.test(lab)) return 'user';
          if (/^(hark|hark said|assistant|agent)\b/i.test(lab)) return 'assistant';
        }
        // 2 气泡 id 前缀
        const id = el.getAttribute('data-bubble-id') || '';
        if (/^(user|me|out|outgoing|human)[-_:.]/i.test(id)) return 'user';
        if (/^(agent|assistant|hark|bot|ai|in|incoming)[-_:.]/i.test(id)) return 'assistant';
        // 3 类名里带角色（开发构建或带调试名的样式）
        for (let n = el, d = 0; n && n.nodeType === 1 && d < 3; n = n.parentElement, d++) {
          const c = typeof n.className === 'string' ? n.className : '';
          if (/(^|[\s_-])(user|outgoing|mine)([\s_-]|$)|bubbleUser|bubble-user/i.test(c)) return 'user';
          if (/(^|[\s_-])(agent|assistant|incoming)([\s_-]|$)|bubbleAgent|bubble-agent/i.test(c)) return 'assistant';
        }
        if (!win || !win.getComputedStyle) return null;
        // 4 计算后的底色 = --bubble-user-bg / --bubble-agent-bg（只读样式，不改 DOM）
        const cs = win.getComputedStyle(el);
        const ub = color(cs.getPropertyValue('--bubble-user-bg'));
        const ab = color(cs.getPropertyValue('--bubble-agent-bg'));
        if (ub || ab) {
          for (let n = el, d = 0; n && d < 3; n = n.firstElementChild, d++) {
            const bg = color(win.getComputedStyle(n).backgroundColor);
            if (!bg || bg[3] === 0) continue;
            if (same(bg, ub) && !same(bg, ab)) return 'user';
            if (same(bg, ab) && !same(bg, ub)) return 'assistant';
            break;
          }
        }
        // 5 位置：气泡在所在列中靠右是用户、靠左是 Hark（需要真实排版；无排版环境下跳过）
        const r = el.getBoundingClientRect();
        if (r.width > 0) {
          for (let p = el.parentElement; p && p !== el.ownerDocument.documentElement; p = p.parentElement) {
            const L = p.getBoundingClientRect();
            if (L.width < r.width + 40) continue;
            const left = r.left - L.left, right = L.right - r.right;
            if (right + 24 < left) return 'user';
            if (left + 24 < right) return 'assistant';
            break;
          }
        }
        return null;
      }
      const hidden = (el) => !!el.closest('[aria-hidden="true"], [inert], [hidden]');
      return {
        id: 'hark',
        hosts: ['hark.com'],
        conversationId: (url) => {
          const p = new URL(url).pathname;
          if (/^\/chat(?:\/[^/]+)?\/?$/.test(p)) return 'main';
          const m = p.match(/^\/project\/([^/]+)(?:\/[^/]+)?\/?$/);
          return m && !/^(artifact|new)$/i.test(m[1]) ? `project-${m[1]}` : null;
        },
        turns: (doc) => {
          const all = Array.from(doc.querySelectorAll(`${BUBBLE}, ${CARD}`)).filter((e) => !e.closest(ACTIVITY) && !hidden(e));
          const top = all.filter((e) => !all.some((o) => o !== e && o.contains(e)));
          if (top.some((e) => e.querySelector('textarea:focus, [contenteditable="true"]:focus'))) return NS.pending('editing');
          return top.map((el) => ({ role: (el.matches(BUBBLE) ? roleOf(el) : null) || 'assistant', el }));
        },
        text: (el, role) => {
          const c = el.cloneNode(true);
          c.querySelectorAll(SKIP).forEach((n) => n.remove());
          const t = NS.readText(c);
          // 纯图片的用户消息（data-bubble-kind="empty" 内含 img）没有文字，记成「[图片]」保留这一轮
          if (!t && role === 'user' && el.querySelector('img')) return '[图片]';
          return t;
        },
        title: (doc) => {
          const t = cleanTitle(doc.title, ['— Hark', '- Hark', '| Hark', '· Hark']);
          return t && !/^hark\b/i.test(t) ? t : null;
        },
      };
    })(),
  ];

  NS.platforms = platforms;
  NS.platformFor = (hostname) => platforms.find((p) => p.hosts.includes(hostname)) || null;
})();
