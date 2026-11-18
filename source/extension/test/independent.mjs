// 独立测试（不依赖 test/run.mjs）。用法：node --no-warnings test/independent.mjs
// 结果：PASS / FAIL（确定的缺陷）/ WARN（依赖真实网站 DOM 的风险项，夹具是按现网结构推测的）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import WebSocket, { WebSocketServer } from 'ws';
import { BridgeClient } from '../src/bridge-client.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
// 桌面端目录解析：MEM0_DESKTOP_DIR → ../mem0-desktop → ../desktop，取第一个 package.json.name === 'mem0-desktop' 的目录。
function resolveDesktopDir(base) {
  const candidates = [];
  if (process.env.MEM0_DESKTOP_DIR) candidates.push(path.resolve(process.env.MEM0_DESKTOP_DIR));
  candidates.push(path.resolve(base, '..', 'mem0-desktop'), path.resolve(base, '..', 'desktop'));
  for (const dir of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (pkg && pkg.name === 'mem0-desktop') return dir;
    } catch { /* 继续尝试下一个候选目录 */ }
  }
  return null;
}
const rd = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const J = (x) => JSON.parse(JSON.stringify(x));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 4000, what = 'condition') => { const t = Date.now(); while (!(await fn())) { if (Date.now() - t > ms) throw new Error('timeout waiting for ' + what); await wait(15); } };

const results = [];
const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(String(e && e.message || e)));
async function T(cat, name, fn, { risk = false } = {}) {
  try { await fn(); results.push({ cat, name, status: 'PASS' }); }
  catch (e) { results.push({ cat, name, status: risk ? 'WARN' : 'FAIL', msg: (String(e && e.message || e).split('\n')[0] + (e && e.actual !== undefined && /Expected/.test(e.message) ? ' actual=' + JSON.stringify(e.actual) + ' expected=' + JSON.stringify(e.expected) : '')).slice(0, 400) }); }
}

// ============================================================ 1. manifest
const manifest = JSON.parse(rd('manifest.json'));
function pngInfo(buf) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(sig)) throw new Error('bad PNG signature');
  if (buf.toString('ascii', 12, 16) !== 'IHDR') throw new Error('no IHDR');
  if (buf.toString('ascii', buf.length - 8, buf.length - 4) !== 'IEND') throw new Error('no IEND');
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}
await T('manifest', 'MV3 基本字段', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.name && manifest.version && /^\d+(\.\d+){0,3}$/.test(manifest.version));
  assert.equal(manifest.background.type, 'module');
  assert.ok(!manifest.background.scripts, 'MV3 不能用 background.scripts');
  assert.ok(!manifest.browser_action && !manifest.page_action);
});
await T('manifest', '权限最小：仅 storage/unlimitedStorage/alarms，无 tabs/scripting/<all_urls>/externally_connectable/web_accessible_resources', () => {
  assert.deepEqual([...manifest.permissions].sort(), ['alarms', 'storage', 'unlimitedStorage']);
  assert.ok(!manifest.optional_permissions && !manifest.externally_connectable && !manifest.web_accessible_resources);
  assert.ok(!(manifest.host_permissions || []).some((h) => /<all_urls>|^\*:|^http:/.test(h)));
  assert.ok(!manifest.content_security_policy, '不应放宽 CSP');
});
await T('manifest', 'host_permissions 与 content_scripts.matches 一致', () => {
  const m = manifest.content_scripts.flatMap((c) => c.matches).sort();
  assert.deepEqual([...manifest.host_permissions].sort(), m);
});
await T('manifest', 'host_permissions 是否必要（后台无 fetch，content_scripts 本身已授予注入权）', () => {
  const bg = rd('src/background.js') + rd('src/bridge-client.js');
  assert.ok(!/fetch\(|XMLHttpRequest|chrome\.scripting|chrome\.tabs\.executeScript/.test(bg));
  // 能走到这里说明 host_permissions 冗余（不影响安装提示，因为 matches 一样）
  throw new Error('host_permissions 冗余：后台不访问这些站点，可整段删除（安装警告不变）');
}, { risk: true });
await T('manifest', '引用的文件都存在', () => {
  const files = [manifest.background.service_worker, manifest.action.default_popup,
    ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon),
    ...manifest.content_scripts.flatMap((c) => [...(c.js || []), ...(c.css || [])])];
  for (const f of files) assert.ok(fs.existsSync(path.join(root, f)), f);
  const html = rd(manifest.action.default_popup);
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) assert.ok(fs.existsSync(path.join(root, path.dirname(manifest.action.default_popup), m[1])), m[1]);
});
await T('manifest', '图标是合法 PNG 且尺寸与键一致', () => {
  for (const [k, f] of [...Object.entries(manifest.icons), ...Object.entries(manifest.action.default_icon)]) {
    const { w, h } = pngInfo(fs.readFileSync(path.join(root, f)));
    assert.equal(w, +k, f); assert.equal(h, +k, f);
  }
});
await T('manifest', 'popup 无内联脚本、无远程脚本（MV3 CSP）', () => {
  const html = rd('src/popup/popup.html');
  assert.ok(!/<script(?![^>]*src=)[^>]*>\s*\S/.test(html), '内联脚本');
  assert.ok(!/(src|href)="(https?:)?\/\//.test(html), '远程资源');
  assert.ok(!/\son[a-z]+="/.test(html), '内联事件');
});

// ============================================================ 2. 平台解析
const contentCode = ['src/content/platforms.js', 'src/content/engine.js'].map(rd);
function mkDom(url, { title = '', body = '', chrome } = {}) {
  const dom = new JSDOM(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`, { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
  const net = [];
  const w = dom.window;
  w.fetch = (...a) => { net.push(['fetch', String(a[0])]); return Promise.reject(new Error('blocked')); };
  const xo = w.XMLHttpRequest.prototype.open; w.XMLHttpRequest.prototype.open = function (m, u) { net.push(['xhr', String(u)]); return xo.apply(this, arguments); };
  w.WebSocket = function (u) { net.push(['ws', String(u)]); throw new Error('blocked'); };
  w.navigator.sendBeacon = (u) => { net.push(['beacon', String(u)]); return false; };
  if (chrome) w.chrome = chrome;
  for (const c of contentCode) w.eval(c);
  return { dom, w, NS: w.__mem0, net };
}
function snap(url, fx) {
  const { w, NS } = mkDom(url, fx);
  const p = NS.platformFor(w.location.hostname);
  assert.ok(p, 'no platform for ' + w.location.hostname);
  return NS.snapshot(p, w.document, url);
}
function expectSnap(s, e) {
  assert.ok(s, '应识别为会话');
  const all = s.messages.map((m) => m.content).join('\n');
  if (e.id) assert.equal(s.externalId, e.id);
  if (e.title !== undefined) assert.equal(s.title, e.title);
  if (e.roles) assert.equal(s.messages.map((m) => m.role[0]).join(''), e.roles, JSON.stringify(s.messages));
  for (const h of e.has || []) assert.ok(all.includes(h), `应包含 ${JSON.stringify(h)}，实际：${JSON.stringify(all)}`);
  for (const h of e.not || []) assert.ok(!all.includes(h), `不应包含 ${JSON.stringify(h)}，实际：${JSON.stringify(all)}`);
  for (const m of s.messages) assert.ok(m.content.trim(), '空消息');
}

// ---- URL 解析（含新对话页 → null）
const urlCases = {
  chatgpt: [['https://chatgpt.com/c/6731a2b4-0000-8000-9000-abcdefabcdef', '6731a2b4-0000-8000-9000-abcdefabcdef'],
    ['https://chatgpt.com/g/g-p-67aa11bb22-proj/c/6731a2b4-0000-8000-9000-abcdefabcdef', '6731a2b4-0000-8000-9000-abcdefabcdef'],
    ['https://chat.openai.com/c/6731a2b4-0000-8000-9000-abcdefabcdef?model=gpt-5', '6731a2b4-0000-8000-9000-abcdefabcdef'],
    ['https://chatgpt.com/', null], ['https://chatgpt.com/?temporary-chat=true', null], ['https://chatgpt.com/g/g-abc123-writer', null], ['https://chatgpt.com/gpts', null]],
  claude: [['https://claude.ai/chat/0f0e0d0c-1111-2222-3333-444455556666', '0f0e0d0c-1111-2222-3333-444455556666'],
    ['https://claude.ai/new', null], ['https://claude.ai/project/0f0e0d0c-1111-2222-3333-444455556666', null], ['https://claude.ai/recents', null]],
  gemini: [['https://gemini.google.com/app/8f3a2b1c0d9e7f65', '8f3a2b1c0d9e7f65'], ['https://gemini.google.com/u/1/app/8f3a2b1c0d9e7f65?hl=zh', '8f3a2b1c0d9e7f65'],
    ['https://gemini.google.com/app', null], ['https://gemini.google.com/app?hl=zh-cn', null], ['https://gemini.google.com/gems/view', null]],
  deepseek: [['https://chat.deepseek.com/a/chat/s/1c0b2e3a-4d5f-6789-abcd-ef0123456789', '1c0b2e3a-4d5f-6789-abcd-ef0123456789'], ['https://chat.deepseek.com/', null], ['https://chat.deepseek.com/sign_in', null]],
  doubao: [['https://www.doubao.com/chat/12345678901234567', '12345678901234567'], ['https://www.doubao.com/chat/', null], ['https://www.doubao.com/chat/create-image', null]],
  yuanbao: [['https://yuanbao.tencent.com/chat/naQivTmsDa/5b1d2c3e-aaaa-bbbb-cccc-0123456789ab', '5b1d2c3e-aaaa-bbbb-cccc-0123456789ab'], ['https://yuanbao.tencent.com/chat/naQivTmsDa', null], ['https://yuanbao.tencent.com/chat/naQivTmsDa/', null]],
  kimi: [['https://www.kimi.com/chat/d3k5a1lb4h8j2c9f0e6g', 'd3k5a1lb4h8j2c9f0e6g'], ['https://kimi.moonshot.cn/chat/cq1a2b3c4d5e6f7g8h9i', 'cq1a2b3c4d5e6f7g8h9i'], ['https://www.kimi.com/', null], ['https://www.kimi.com/chat/', null]],
  qianwen: [['https://www.qianwen.com/chat/5d8f9dc47407461eae19a89cdb537ee5', '5d8f9dc47407461eae19a89cdb537ee5'], ['https://www.qianwen.com/desktop-app/chat/446366448b3f4dd89bcb5fbdd923597a', '446366448b3f4dd89bcb5fbdd923597a'],
    ['https://tongyi.aliyun.com/qianwen/?sessionId=a1b2c3d4e5f6a7b8', 'a1b2c3d4e5f6a7b8'], ['https://chat.qwen.ai/c/2a7b4c1d-0000-4000-8000-123456789abc', '2a7b4c1d-0000-4000-8000-123456789abc'],
    ['https://www.qianwen.com/chat', null], ['https://www.qianwen.com/chat?ch=tongyi_redirect', null], ['https://www.qianwen.com/chat/agents', null], ['https://chat.qwen.ai/', null], ['https://tongyi.aliyun.com/qianwen/', null]],
  'google-ai-mode': [['https://www.google.com/search?q=x&udm=50&mtid=abc123&mstk=AUtE', 'abc123'], ['https://www.google.com/search?q=x&udm=50&mstk=AUtExfB', 'AUtExfB'],
    ['https://www.google.com/search?q=x&udm=50', null], ['https://www.google.com/search?q=x', null], ['https://www.google.com/search?q=x&udm=14&mtid=abc', null], ['https://www.google.com/webhp?udm=50&mtid=abc', null]],
  grok: [['https://grok.com/c/0b3f6c2e-1a2b-4c3d-8e9f-0123456789ab', '0b3f6c2e-1a2b-4c3d-8e9f-0123456789ab'], ['https://grok.com/c/0b3f6c2e-1a2b-4c3d-8e9f-0123456789ab?rid=x', '0b3f6c2e-1a2b-4c3d-8e9f-0123456789ab'],
    ['https://grok.com/chat/0b3f6c2e-1a2b-4c3d-8e9f-0123456789ab', '0b3f6c2e-1a2b-4c3d-8e9f-0123456789ab'], ['https://grok.com/project/p1/c/0b3f6c2e-1a2b-4c3d-8e9f-0123456789ab', '0b3f6c2e-1a2b-4c3d-8e9f-0123456789ab'],
    ['https://grok.com/', null], ['https://grok.com/c', null], ['https://grok.com/imagine', null], ['https://grok.com/c/0b3f6c2e-1a2b-4c3d-8e9f-0123456789ab/extra', null]],
  hark: [['https://hark.com/chat', 'main'], ['https://hark.com/chat/', 'main'], ['https://hark.com/chat/msg_123', 'main'], ['https://hark.com/project/p-42', 'project-p-42'], ['https://hark.com/project/p-42/msg_9', 'project-p-42'],
    ['https://hark.com/', null], ['https://hark.com/projects', null], ['https://hark.com/projects/new', null], ['https://hark.com/settings', null], ['https://hark.com/room/r1', null], ['https://hark.com/project/artifact', null]],
};
{
  const { NS } = mkDom('https://example.com/');
  await T('platforms', '11 个平台齐全，host 不重叠，与 manifest matches 对应', () => {
    assert.deepEqual(J(NS.platforms.map((p) => p.id)), ['chatgpt', 'claude', 'gemini', 'deepseek', 'doubao', 'yuanbao', 'kimi', 'qianwen', 'google-ai-mode', 'grok', 'hark']);
    const hosts = NS.platforms.flatMap((p) => p.hosts);
    assert.equal(new Set(hosts).size, hosts.length);
    const mh = new Set(manifest.content_scripts[0].matches.map((m) => new URL(m.replace('*', 'x')).hostname));
    assert.deepEqual([...mh].sort(), [...hosts].sort());
    assert.equal(NS.platformFor('example.com'), null);
  });
  for (const [id, list] of Object.entries(urlCases)) {
    await T('url', `${id} 会话 id 解析（${list.length} 例，含新对话页）`, () => {
      const p = NS.platforms.find((x) => x.id === id);
      for (const [u, exp] of list) assert.equal(p.conversationId(u), exp, u);
    });
  }
}

// ---- 各平台 DOM 夹具（按 2025-2026 现网结构手写，类名为现网常见值）
const CG_CODE = `<pre class="overflow-visible!"><div class="contain-inline-size rounded-2xl relative bg-token-sidebar-surface-primary"><div class="flex items-center text-token-text-secondary px-4 py-2 text-xs font-sans justify-between h-9 select-none rounded-t-2xl">python</div><div class="sticky top-9"><div class="absolute end-0 bottom-0 flex h-9 items-center pe-2"><div class="flex items-center gap-4 rounded-sm px-2 font-sans text-xs"><button class="flex gap-1 items-center select-none py-1" aria-label="Copy"><svg width="20" height="20"><path d="M0"/></svg>Copy code</button></div></div></div><div class="overflow-y-auto p-4" dir="ltr"><code class="whitespace-pre! language-python"><span class="hljs-keyword">def</span> <span class="hljs-title function_">qs</span>(a):\n    <span class="hljs-keyword">return</span> <span class="hljs-built_in">sorted</span>(a)\n</code></div></div></pre>`;
const fixtures = {
  chatgpt: {
    url: 'https://chatgpt.com/c/6731a2b4-0000-8000-9000-abcdefabcdef', title: '排序算法比较',
    body: `<div id="thread"><div class="flex flex-col text-sm">
<article class="text-token-text-primary w-full" data-testid="conversation-turn-1" data-turn="user" data-scroll-anchor="false"><h5 class="sr-only">You said:</h5><div class="text-base my-auto mx-auto"><div class="flex max-w-full flex-col grow"><div data-message-author-role="user" data-message-id="a1" class="min-h-8 text-message relative flex w-full flex-col items-end gap-2"><div class="flex w-full flex-col gap-1 empty:hidden items-end"><div class="user-message-bubble-color relative rounded-[18px] px-4 py-1.5"><div class="whitespace-pre-wrap">快排和归并哪个快？
写个例子</div></div></div></div></div><div class="flex justify-end"><button aria-label="Copy"><svg/></button><button aria-label="Edit message"><svg/></button></div></div></article>
<article data-testid="conversation-turn-2" data-turn="assistant"><h6 class="sr-only">ChatGPT said:</h6><div class="text-base my-auto"><div class="flex max-w-full flex-col grow"><div class="mb-2"><button class="text-token-text-secondary">Thought for 8s</button></div>
<div data-message-author-role="assistant" data-message-id="b1" data-message-model-slug="gpt-5" class="min-h-8 text-message"><div class="flex w-full flex-col gap-1 empty:hidden first:pt-[3px]"><div class="markdown prose dark:prose-invert w-full break-words light markdown-new-styling"><p data-start="0" data-end="20">平均都是 <code>O(n log n)</code>。</p>${CG_CODE}<ul><li><p>快排：原地</p></li><li><p>归并：稳定</p></li></ul><p>公式 <span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>n</mi></mrow><annotation encoding="application/x-tex">n</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">n</span></span> 即可</p></div></div></div>
<div data-message-author-role="assistant" data-message-id="b2"><div class="markdown prose"><p>补充：数据量小时插入排序更快。</p></div></div>
<div class="flex"><button aria-label="Copy"><svg/></button><button aria-label="Good response"><svg/></button><span class="sr-only">Read aloud</span></div></div></div></article>
<article data-testid="conversation-turn-3" data-turn="user"><div data-message-author-role="user" data-message-id="a2"><div class="whitespace-pre-wrap">谢谢</div></div></article>
<article data-testid="conversation-turn-4" data-turn="assistant"><div data-message-author-role="assistant" data-message-id="b3"><div class="markdown prose result-streaming"></div></div></article>
<div data-message-author-role="system" data-message-id="s">系统提示隐藏</div><div data-message-author-role="tool">工具输出</div>
</div></div>`,
    expect: { id: '6731a2b4-0000-8000-9000-abcdefabcdef', title: '排序算法比较', roles: 'uau', has: ['快排和归并哪个快？\n写个例子', '```python\ndef qs(a):\n    return sorted(a)\n```', '- 快排：原地', '补充：数据量小时插入排序更快。'], not: ['Copy code', 'Thought for', 'You said', 'ChatGPT said', '系统提示隐藏', '工具输出', 'Edit message', 'Read aloud'] },
  },
  claude: {
    url: 'https://claude.ai/chat/0f0e0d0c-1111-2222-3333-444455556666', title: '写周报 - Claude',
    body: `<header><button data-testid="chat-title-button" class="flex"><div class="truncate">写周报</div><svg/></button></header>
<div class="flex-1 flex flex-col gap-3 px-4 max-w-3xl mx-auto w-full pt-1">
<div data-test-render-count="1"><div class="mb-1 mt-1"><div class="group relative inline-flex gap-2 bg-bg-300 rounded-xl"><div class="flex flex-row gap-2 relative"><div class="shrink-0"><div class="flex shrink-0 items-center justify-center rounded-full font-bold h-7 w-7 text-[12px] bg-text-200 text-bg-100">MY</div></div><div data-testid="user-message" class="font-large !font-user-message grid grid-cols-1 gap-2 py-0.5"><p class="whitespace-pre-wrap break-words">帮我写周报，用 Python 统计提交数</p></div></div><div class="absolute bottom-0 right-2"><button>Edit</button></div></div></div></div>
<div data-test-render-count="1"><div style="height: auto;"><div data-is-streaming="false" class="group relative pb-8"><div class="font-claude-response relative leading-[1.65rem]">
<div class="transition-all duration-400 ease-out rounded-lg border-0.5 border-border-300 min-h-[2.625rem] mx-0.5 overflow-hidden"><button class="group/row flex flex-row items-center justify-between gap-4 w-full"><div class="text-text-300 font-base text-sm">Thought process</div><svg/></button><div style="height: 0px; opacity: 0;" class="overflow-hidden"><div class="font-claude-response-body text-text-300 whitespace-normal break-words">用户想要周报（这是思考过程）</div></div></div>
<div><div class="grid-cols-1 grid gap-2.5 [&_>_*]:min-w-0 standard-markdown"><p class="whitespace-normal break-words">本周完成了：</p><ul class="[&:not(:last-child)_ul]:pb-1 list-disc space-y-1.5 pl-7"><li class="whitespace-normal break-words">接口联调</li></ul>
<div class="relative group/copy bg-bg-000/50 border-0.5 border-border-400 rounded-lg"><div class="sticky opacity-0 group-hover/copy:opacity-100 top-2 py-2 h-12 w-0 float-right"><div class="absolute right-0 h-8 px-2 items-center inline-flex"><button class="inline-flex"><svg/></button></div></div><div class="text-text-500 font-small p-3.5 pb-0">python</div><pre class="code-block__code !my-0 !rounded-lg !text-sm !leading-relaxed"><code class="language-python"><span class="token keyword">print</span>(1)</code></pre></div></div></div>
</div><div class="absolute bottom-0 right-2"><button>Copy</button><button>Retry</button></div><div class="text-text-300 text-[0.75rem]">Claude can make mistakes. Please double-check responses.</div></div></div></div>
</div>`,
    expect: { title: '写周报', roles: 'ua', has: ['帮我写周报', '本周完成了', '- 接口联调', '```python\nprint(1)\n```'], not: ['MY', 'Edit', 'Retry', 'can make mistakes'] },
    riskNot: ['这是思考过程', 'python\n```python'],
  },
  gemini: {
    url: 'https://gemini.google.com/app/8f3a2b1c0d9e7f65',
    body: `<conversations-list><div class="conversation selected" data-test-id="conversation"><div class="conversation-title gds-label-l">闭包解释</div></div></conversations-list>
<infinite-scroller class="chat-history"><div class="conversation-container message-actions-hover-boundary" id="c_1">
<user-query><span class="user-query-container"><user-query-content class="user-query-container"><div class="user-query-bubble-container"><div class="query-content" id="user-query-content-0"><span class="user-query-bubble-with-background"><div class="horizontal-container"><div role="heading" aria-level="2" class="query-text gds-body-l" dir="ltr"><span class="cdk-visually-hidden">You said </span><p class="query-text-line">帮我解释闭包</p><p class="query-text-line">用 JS</p></div></div></span></div></div></user-query-content></span></user-query>
<model-response><div><response-container><div class="response-container"><div class="presented-response-container"><div class="response-container-content"><div class="avatar-gutter"><bard-avatar></bard-avatar></div>
<model-thoughts><div class="thoughts-header"><button><span>Show thinking</span></button></div><div class="thoughts-content"><div class="markdown markdown-main-panel"><p>思考：用户想了解闭包</p></div></div></model-thoughts>
<div class="response-content"><message-content id="message-content-id-r_1" class="model-response-text"><div class="markdown markdown-main-panel" dir="ltr"><h2 class="cdk-visually-hidden">Gemini said</h2><p>闭包是函数和其词法环境的组合。</p><code-block><div class="code-block ng-tns-c1"><div class="code-block-decoration header-formatted gds-title-s"><span>JavaScript</span><div class="buttons"><button aria-label="Copy code"><mat-icon fonticon="content_copy">content_copy</mat-icon></button></div></div><div class="formatted-code-block-internal-container"><div class="animated-opacity"><pre><code role="text" data-test-id="code-content" class="code-container formatted">const f = () =&gt; x;</code></pre></div></div></div></code-block><p>来源 <sup class="superscript" data-turn-source-index="1">1</sup></p></div></message-content></div>
</div></div></div></response-container><message-actions><div class="actions-container"><button aria-label="Good response"><mat-icon>thumb_up</mat-icon></button></div></message-actions></div></model-response>
</div></infinite-scroller>`,
    expect: { title: '闭包解释', roles: 'ua', has: ['帮我解释闭包', '用 JS', '闭包是函数和其词法环境的组合。', 'const f = () => x;'], not: ['思考：用户想了解闭包', 'Show thinking', 'content_copy', 'thumb_up'] },
    riskNot: ['You said', 'Gemini said', 'JavaScript\n```'],
  },
  deepseek: {
    url: 'https://chat.deepseek.com/a/chat/s/1c0b2e3a-4d5f-6789-abcd-ef0123456789', title: '快排实现 - DeepSeek',
    body: `<div class="dad65929">
<div class="_9663006"><div class="d29f3d7d ds-message _63c77b1"><div class="fbb737a4">用 Python 写快排</div></div><div class="_78e0558 _11d6b3a"><div class="ds-icon-button" tabindex="0"><div class="ds-icon"><svg/></div></div></div></div>
<div class="_4f9bf79 d7dc56a8 _43c05b5"><div class="ds-message _63c77b1"><div class="_74c0879"><div class="_5ab5d64">已深度思考（用时 5 秒）</div><div class="ds-icon"><svg/></div></div><div class="e1675d8b"><div class="ds-think-content _767406f"><div class="ds-markdown ds-markdown--block"><p>用户想要快排，这是推理过程</p></div></div></div>
<div class="ds-markdown ds-markdown--block" style="--ds-md-zoom: 1.143;"><p class="ds-markdown-paragraph">好的：</p><div class="md-code-block md-code-block-light"><div class="md-code-block-banner-wrap"><div class="md-code-block-banner md-code-block-banner-lite"><div class="_121d384"><div class="d2a24f03"><span class="d813de27">python</span></div><div class="d2a24f03 _246a029"><div class="efa13877"><button role="button" class="ds-atom-button ds-text-button ds-text-button--with-icon"><div class="ds-icon"><svg/></div><span>复制</span></button><button class="ds-atom-button ds-text-button"><span>下载</span></button></div></div></div></div></div><pre><span class="token keyword">def</span> <span class="token function">qs</span>(a): <span class="token keyword">return</span> a</pre></div></div></div>
<div class="ds-flex _965abe9"><div class="ds-icon-button"><svg/></div></div></div>
<div class="_9663006"><div class="ds-message _63c77b1"><div class="fbb737a4">再解释一下</div></div></div>
<div class="_4f9bf79 _43c05b5"><div class="ds-message _63c77b1"><div class="ds-markdown ds-markdown--block"></div></div></div>
</div>`,
    expect: { title: '快排实现', roles: 'uau', has: ['用 Python 写快排', '好的：', 'def qs(a): return a', '再解释一下'], not: ['这是推理过程', '已深度思考', '复制', '下载'] },
    riskNot: ['python\n```'],
  },
  doubao: {
    url: 'https://www.doubao.com/chat/12345678901234567', title: '量子计算入门 - 豆包',
    body: `<div data-testid="message-list" class="scroll-view-xx"><div class="inter-xx">
<div data-testid="union_message" class="container-xx"><div data-testid="send_message" class="send-message-xx"><div class="message-box-xx"><div data-testid="message_content" class="message-content-xx"><div data-testid="message_text_content" class="container-yy">介绍下量子计算</div></div></div><div data-testid="message_action_bar" class="action-bar"><button data-testid="message_action_copy"><svg/></button><button data-testid="message_action_edit"><svg/></button></div></div></div>
<div data-testid="union_message"><div data-testid="receive_message" class="receive-message-xx"><div class="message-box-xx"><div data-testid="message_content"><div class="collapse-wrapper-xx" data-testid="think_block_collapse"><div class="title-xx">已完成思考</div><div class="content-xx"><div class="flow-markdown-body">思考：先讲量子比特（推理过程）</div></div></div><div data-testid="message_text_content" class="flow-markdown-body"><p>量子计算利用<strong>叠加</strong>和纠缠。</p><ol><li>量子比特</li></ol></div></div></div><div data-testid="message_action_bar"><button data-testid="message_action_regenerate">重新生成</button></div></div></div>
</div></div>`,
    expect: { title: '量子计算入门', roles: 'ua', has: ['介绍下量子计算', '量子计算利用叠加和纠缠。', '- 量子比特'], not: ['重新生成', '推理过程', '已完成思考'] },
  },
  yuanbao: {
    url: 'https://yuanbao.tencent.com/chat/naQivTmsDa/5b1d2c3e-aaaa-bbbb-cccc-0123456789ab',
    body: `<div class="agent-dialogs__title" title="RAG 概念">RAG 概念</div><div class="agent-chat__list"><div class="agent-chat__list__content">
<div class="agent-chat__list__item agent-chat__list__item--human"><div class="agent-chat__list__item__content"><div class="agent-chat__bubble agent-chat__bubble--human"><div class="agent-chat__bubble__content"><div class="hyc-content-text">什么是 RAG？</div></div></div><div class="agent-chat__toolbar"><div class="agent-chat__toolbar__item">复制</div></div></div></div>
<div class="agent-chat__list__item agent-chat__list__item--ai"><div class="agent-chat__list__item__content"><div class="agent-chat__speech-text"><div class="hyc-component-reasoner"><div class="hyc-component-reasoner__think"><div class="hyc-component-reasoner__think-header">已深度思考（用时3秒）</div><div class="hyc-component-reasoner__think-content"><div class="hyc-content-md"><p>思考：检索增强生成（推理过程）</p></div></div></div><div class="hyc-component-reasoner__text"><div class="hyc-content-md"><div class="hyc-common-markdown hyc-common-markdown-style"><p>RAG 是检索增强生成。</p></div></div></div></div></div><div class="agent-chat__toolbar"><div class="agent-chat__toolbar__copy">复制</div></div></div></div>
<div class="agent-chat__list__item agent-chat__list__item--human"><div class="agent-chat__bubble__content"><div class="hyc-content-text">举例</div></div></div>
<div class="agent-chat__list__item agent-chat__list__item--ai"><div class="agent-chat__speech-text"><div class="hyc-content-md"><div class="hyc-common-markdown"><p>比如企业知识库问答。</p></div></div></div></div>
</div></div>`,
    expect: { title: 'RAG 概念', roles: 'uaua', has: ['什么是 RAG？', 'RAG 是检索增强生成。', '比如企业知识库问答。'], not: ['推理过程', '已深度思考', '复制'] },
  },
  kimi: {
    url: 'https://www.kimi.com/chat/d3k5a1lb4h8j2c9f0e6g', title: 'TCP 握手 - Kimi',
    body: `<div class="chat-content-list">
<div class="chat-content-item chat-content-item-user"><div class="segment segment-user"><div class="segment-avatar"><img alt=""/></div><div class="segment-content"><div class="segment-content-box"><div class="user-content">解释 TCP 三次握手</div></div><div class="segment-user-actions"><div class="simple-button">编辑</div></div></div></div></div>
<div class="chat-content-item chat-content-item-assistant"><div class="segment segment-assistant"><div class="segment-content"><div class="segment-content-box">
<div class="thinking-container"><div class="thinking-header"><span>思考已完成</span></div><div class="thinking-content"><div class="markdown-container"><div class="markdown"><div class="paragraph">用户问 TCP（推理过程）</div></div></div></div></div>
<div class="markdown-container"><div class="markdown"><div class="paragraph">三次握手：SYN、SYN-ACK、ACK。</div><ol start="1"><li><div class="paragraph">客户端发 SYN</div></li></ol></div></div></div><div class="segment-assistant-actions"><div class="segment-assistant-actions-content"><div class="simple-button">复制</div><div class="simple-button">再试一次</div></div></div></div></div></div>
</div>`,
    expect: { title: 'TCP 握手', roles: 'ua', has: ['解释 TCP 三次握手'], not: ['编辑', '再试一次'] },
    riskHas: ['三次握手：SYN、SYN-ACK、ACK。'], riskNot: ['推理过程'],
  },
  qianwen: {
    url: 'https://www.qianwen.com/chat/5d8f9dc47407461eae19a89cdb537ee5', title: '写诗 - 千问',
    body: `<div class="scrollWrapper--Kg1Ee4">
<div class="questionItem--dlRy0Ll5"><div class="bubble--sx3Rq"><div class="contentBox--Q8lI"><div class="content--yP1u">写首关于月亮的诗</div></div></div><div class="tools--x"><span class="copy--a">复制</span></div></div>
<div class="answerItem--U4_Uv3iw"><div class="answerContent--x"><div class="deepThinkContainer--aa"><div class="thinkTitle--b">已深度思考</div><div class="tongyi-markdown thinkContent--c"><p>思考：五言绝句（推理过程）</p></div></div><div class="tongyi-markdown markdown-body"><p>床前明月光，疑是地上霜。</p></div></div><div class="tools--x"><span>复制</span><span>重新生成</span></div></div>
</div>`,
    expect: { title: '写诗', roles: 'ua', has: ['写首关于月亮的诗', '床前明月光'], not: [] },
    riskNot: ['推理过程', '复制', '重新生成'],
  },
  'google-ai-mode': {
    url: 'https://www.google.com/search?q=%E9%87%8F%E5%AD%90%E7%BA%A0%E7%BC%A0&udm=50&mtid=Xyz12AbC&mstk=AUtExfB',
    body: `<div id="rcnt"><div data-container-id="main-col">
<div data-subtree="aimc" data-complete="true"><div class="Mjf7Ie"><div role="heading" aria-level="2" class="VndcI">什么是量子纠缠</div></div><div class="mZJni" data-hveid="CAEQAA"><div class="Y3BBE">量子纠缠是一种量子关联。</div><ul class="KsbFXc"><li><span class="T286Pc">不能超光速通信</span></li></ul><button aria-label="复制">复制</button></div></div>
<div data-subtree="aimc" data-complete="true"><div class="Mjf7Ie"><div role="heading" aria-level="2" class="VndcI">和贝尔不等式什么关系</div></div><div class="mZJni"><div class="Y3BBE">贝尔不等式用于检验局域实在论。</div></div></div>
</div></div>`,
    expect: { title: '量子纠缠', roles: 'uaua', has: ['什么是量子纠缠', '和贝尔不等式什么关系', '贝尔不等式用于检验局域实在论。'], not: ['复制'] },
    riskHas: ['量子纠缠是一种量子关联。'],
  },
  grok: {
    url: 'https://grok.com/c/0b3f6c2e-1a2b-4c3d-8e9f-0123456789ab', title: '快排解释 - Grok',
    body: `<main><div class="flex flex-col items-center">
<div id="response-u1" class="relative group flex flex-col items-end"><div data-testid="user-message" class="message-bubble user rounded-3xl"><div class="relative"><div class="response-content-markdown"><p class="break-words">讲讲快排</p></div></div></div></div>
<div class="action-buttons justify-end"><button aria-label="Edit">编辑</button></div>
<div id="response-a1" class="relative group flex flex-col items-start"><div data-testid="assistant-message" class="message-bubble"><div class="thinking-container"><button aria-expanded="false">Thought for 8s</button><div class="response-content-markdown"><p>思考过程不要</p></div></div><div class="relative"><div class="response-content-markdown"><p>快排是分治算法。</p><pre><code class="language-python">def qs(a): return a</code></pre><a data-testid="citation-pill" href="#">wikipedia</a></div></div><section class="auto-notification">已切换模型</section></div><div class="action-buttons"><button>复制</button><button>重新生成</button></div></div>
</div></main><div class="query-bar"><textarea>输入框草稿</textarea></div>`,
    expect: { title: '快排解释', roles: 'ua', has: ['讲讲快排', '快排是分治算法。', '```python\ndef qs(a): return a\n```'], not: ['思考过程不要', 'Thought for', '复制', '重新生成', '编辑', '输入框草稿', '已切换模型', 'wikipedia'] },
  },
  hark: {
    url: 'https://hark.com/chat', title: 'Hark',
    body: `<nav><a href="/projects">Projects</a><div data-bubble-id="side-preview" aria-hidden="true">侧栏预览不要</div></nav><main>
<div data-role="user"><div data-bubble-id="b1"><p>帮我订明晚七点的餐厅</p></div></div>
<div data-role="agent"><div data-agent-activity-window=""><p>正在搜索附近餐厅……（过程不要）</p></div><div data-bubble-id="b2"><p>已找到三家，想要哪一家？</p><div role="toolbar"><button>复制</button></div><time>13:30</time></div></div>
<div data-testid="summary-card"><h3>餐厅对比</h3><p>A 店：安静</p></div>
<div data-role="user"><div data-bubble-id="b3"><p>A 店</p></div></div>
</main><footer><textarea>输入框草稿</textarea></footer>`,
    expect: { id: 'main', title: undefined, roles: 'uau', has: ['帮我订明晚七点的餐厅', '已找到三家，想要哪一家？', '餐厅对比', 'A 店：安静', 'A 店'], not: ['过程不要', '侧栏预览不要', '复制', '13:30', '输入框草稿'] },
  },
};
for (const [id, f] of Object.entries(fixtures)) {
  let s;
  await T('dom', `${id} 现网结构夹具：角色顺序/正文/代码块/去 UI 噪音`, () => { s = snap(f.url, f); assert.equal(s.platform, id); expectSnap(s, f.expect); });
  if (f.riskNot || f.riskHas) {
    await T('dom', `${id} 风险项：${[...(f.riskHas || []).map((x) => '应含 ' + x), ...(f.riskNot || []).map((x) => '不应含 ' + JSON.stringify(x))].join('；')}`,
      () => { s = s || snap(f.url, f); expectSnap(s, { has: f.riskHas, not: f.riskNot }); }, { risk: true });
  }
}

// ---- 通用边界
await T('dom', '新对话页即使 DOM 有消息也返回 null（11 平台）', () => {
  const news = { chatgpt: 'https://chatgpt.com/', claude: 'https://claude.ai/new', gemini: 'https://gemini.google.com/app', deepseek: 'https://chat.deepseek.com/', doubao: 'https://www.doubao.com/chat/', yuanbao: 'https://yuanbao.tencent.com/chat/naQivTmsDa', kimi: 'https://www.kimi.com/', qianwen: 'https://www.qianwen.com/chat', 'google-ai-mode': 'https://www.google.com/search?q=x&udm=50', grok: 'https://grok.com/', hark: 'https://hark.com/projects' };
  for (const [id, u] of Object.entries(news)) assert.equal(snap(u, { body: fixtures[id].body }), null, id);
});
await T('dom', '只有助手消息/全部为空 → null；空消息被跳过', () => {
  assert.equal(snap(fixtures.chatgpt.url, { body: '<div data-message-author-role="assistant"><div class="markdown">hi</div></div>' }), null);
  assert.equal(snap(fixtures.chatgpt.url, { body: '<div data-message-author-role="user"><div class="whitespace-pre-wrap">  <button>x</button> </div></div><div data-message-author-role="assistant"><div class="markdown">a</div></div>' }), null);
  const s = snap(fixtures.chatgpt.url, { body: '<div data-message-author-role="user"><div class="whitespace-pre-wrap">q</div></div><div data-message-author-role="assistant"><div class="markdown"><svg/></div></div>' });
  assert.deepEqual(J(s.messages), [{ role: 'user', content: 'q' }]);
});
await T('dom', '嵌套命中去重（Kimi 走 [class*=segment-*] 兜底选择器，内层 actions 不重复计入）', () => {
  const body = `<div class="segment segment-user"><div class="segment-content-box">问</div><div class="segment-user-actions">x</div></div><div class="segment segment-assistant"><div class="markdown-container">答</div><div class="segment-assistant-actions"><div class="segment-assistant-actions-content">复制</div></div></div>`;
  const s = snap('https://www.kimi.com/chat/d3k5a1lb4h8j2c9f0e6g', { body });
  assert.deepEqual(J(s.messages), [{ role: 'user', content: '问' }, { role: 'assistant', content: '答' }]);
});
await T('dom', '交错排序：DOM 中先出现的排前面（Claude 多轮）', () => {
  const t = (i) => `<div data-testid="user-message"><p>q${i}</p></div><div class="font-claude-response"><p>a${i}</p></div>`;
  const s = snap(fixtures.claude.url, { body: `<div>${t(1)}</div><section><div>${t(2)}</div></section>${t(3)}` });
  assert.equal(s.messages.map((m) => m.content).join(','), 'q1,a1,q2,a2,q3,a3');
});
await T('dom', '连续多条助手消息合并为一条；连续用户消息不合并', () => {
  const s = snap(fixtures.chatgpt.url, { body: '<div data-message-author-role="user"><div class="whitespace-pre-wrap">q1</div></div><div data-message-author-role="user"><div class="whitespace-pre-wrap">q2</div></div><div data-message-author-role="assistant"><div class="markdown">a</div></div><div data-message-author-role="assistant"><div class="markdown">b</div></div>' });
  assert.deepEqual(J(s.messages.map((m) => [m.role[0], m.content])), [['u', 'q1'], ['u', 'q2'], ['a', 'a\n\nb']]);
});
await T('dom', 'readText：代码块语言/换行、行内 code、br、nbsp、表格', () => {
  const { NS, w } = mkDom('https://example.com/');
  const d = w.document.createElement('div');
  d.innerHTML = '<p>a&nbsp;b<br>c <code>x</code></p><pre><code class="language-c++">int a;\n\nint b;\n</code></pre><table><tr><td>1</td><td>2</td></tr></table><div aria-hidden="true">HIDDEN</div><style>.x{}</style>';
  const t = NS.readText(d);
  assert.ok(t.includes('a b\nc x'), t);
  assert.ok(t.includes('```c++\nint a;\n\nint b;\n```'), t);
  assert.ok(t.includes('12'), t);
  assert.ok(!/HIDDEN|\.x\{\}/.test(t), t);
  assert.ok(!d.innerHTML.includes('```'), 'readText 不应改动原 DOM');
});
await T('dom', 'Gemini Gem 会话（/gem/<id>/<conv>）能否识别', () => {
  const p = mkDom('https://example.com/').NS.platforms.find((x) => x.id === 'gemini');
  assert.ok(p.conversationId('https://gemini.google.com/gem/coding-partner/8f3a2b1c0d9e7f65'), 'Gem 内对话返回 null，不会备份');
}, { risk: true });
await T('dom', 'snapshot.url：去掉 query/hash（千问/Google 保留 query）', () => {
  const s = snap(fixtures.chatgpt.url + '?model=x#frag', fixtures.chatgpt);
  assert.equal(s.url, fixtures.chatgpt.url);
  assert.ok(snap(fixtures['google-ai-mode'].url, fixtures['google-ai-mode']).url.includes('udm=50'));
});

// ============================================================ 2b. 内容脚本运行时（jsdom + chrome 桩）
function contentChrome(local = {}) {
  const c = { sent: [], listeners: [], changed: [], local };
  c.runtime = { id: 'extid', sendMessage: (m) => { c.sent.push(J(m)); return Promise.resolve({ ok: true }); }, onMessage: { addListener: (f) => c.listeners.push(f) } };
  c.storage = { local: { get: async () => ({ ...c.local }) }, onChanged: { addListener: (f) => c.changed.push(f) } };
  return c;
}
{
  const f = fixtures.chatgpt;
  const chrome = contentChrome();
  const { w, net: netLog } = mkDom(f.url, { title: f.title, body: f.body, chrome });
  await T('engine', '页面就绪 1.5s 防抖后上报一次 capture（含 capturedAt）', async () => {
    await until(() => chrome.sent.length >= 1, 3000, 'capture');
    const m = chrome.sent[0];
    assert.equal(m.type, 'capture');
    assert.equal(m.conversation.platform, 'chatgpt');
    assert.equal(m.conversation.externalId, '6731a2b4-0000-8000-9000-abcdefabcdef');
    assert.ok(Number.isFinite(m.conversation.capturedAt));
  });
  await T('engine', '内容没变的 DOM 变动不重复上报；新增消息会再上报', async () => {
    w.document.body.appendChild(w.document.createElement('div'));
    await wait(1800);
    assert.equal(chrome.sent.length, 1, 'no-op 变动不应上报');
    const div = w.document.createElement('div');
    div.innerHTML = '<div data-message-author-role="user"><div class="whitespace-pre-wrap">新问题</div></div>';
    w.document.querySelector('#thread').appendChild(div);
    await until(() => chrome.sent.length === 2, 3000, 'second capture');
    assert.ok(chrome.sent[1].conversation.messages.at(-1).content === '新问题');
  });
  await T('engine', 'pageStatus 回复当前页状态', async () => {
    let r; chrome.listeners[0]({ type: 'pageStatus' }, {}, (x) => { r = J(x); });
    assert.equal(r.platform, 'chatgpt'); assert.equal(r.enabled, true); assert.equal(r.conversation, true); assert.equal(r.messages, 4);
  });
  await T('engine', '暂停后不再上报', async () => {
    chrome.local.paused = true;
    chrome.changed[0]({ paused: { newValue: true } });
    await wait(50);
    const div = w.document.createElement('div');
    div.innerHTML = '<div data-message-author-role="user"><div class="whitespace-pre-wrap">暂停时的问题</div></div>';
    w.document.querySelector('#thread').appendChild(div);
    await wait(1900);
    assert.equal(chrome.sent.length, 2);
    let r; chrome.listeners[0]({ type: 'pageStatus' }, {}, (x) => { r = J(x); });
    assert.equal(r.enabled, false);
  });
  await T('engine', '单页应用切换会话（pushState）后用新 id 上报', async () => {
    chrome.local.paused = false; chrome.changed[0]({ paused: { newValue: false } });
    await wait(1700);
    const n = chrome.sent.length;
    w.history.pushState({}, '', '/c/99999999-0000-8000-9000-abcdefabcdef');
    await until(() => chrome.sent.length > n && chrome.sent.at(-1).conversation.externalId === '99999999-0000-8000-9000-abcdefabcdef', 4500, 'spa capture');
  });
  await T('privacy', '内容脚本运行期间没有 fetch/XHR/WebSocket/sendBeacon', () => { assert.deepEqual(netLog, []); });
  await T('engine', '扩展上下文失效（sendMessage 同步抛错）时不应抛出未捕获异常', async () => {
    let uncaught = null;
    w.addEventListener('error', (e) => { uncaught = e.error || e.message; });
    const onErr = (e) => { uncaught = e; };
    process.on('uncaughtException', onErr);
    chrome.runtime.sendMessage = () => { throw new Error('Extension context invalidated.'); };
    const div = w.document.createElement('div');
    div.innerHTML = '<div data-message-author-role="user"><div class="whitespace-pre-wrap">失效后</div></div>';
    w.document.querySelector('#thread').appendChild(div);
    await wait(1900);
    process.off('uncaughtException', onErr);
    assert.equal(uncaught, null, '未捕获：' + uncaught);
  }, { risk: true });
  w.close();
}

// ============================================================ 3. BridgeClient × 真实桌面端 bridge
const desktop = resolveDesktopDir(root);
if (!desktop) {
  console.error('错误：未找到 mem0 桌面端目录（已尝试 MEM0_DESKTOP_DIR、../mem0-desktop、../desktop）。');
  process.exit(1);
}
const dreq = createRequire(path.join(desktop, 'package.json'));
const { Store } = dreq('./src/main/db.js');
const { startBridge } = dreq('./src/main/bridge.js');
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
function memStorage(delay = 0) {
  const mem = {};
  const d = () => (delay ? wait(Math.random() * delay) : Promise.resolve());
  return { mem, get: async (keys) => { await d(); return structuredClone(Object.fromEntries(keys.map((k) => [k, mem[k]]))); }, set: async (o) => { await d(); Object.assign(mem, structuredClone(o)); }, remove: async (keys) => { await d(); for (const k of [].concat(keys)) delete mem[k]; } };
}
function recWS(origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop') {
  class W extends WebSocket {
    constructor(u) { super(u, origin ? { origin } : {}); W.created++; W.sockets.push(this); }
    send(d) { W.frames.push(JSON.parse(d)); super.send(d); }
  }
  W.created = 0; W.sockets = []; W.frames = [];
  return W;
}
const conv = (i, t = i, platform = 'chatgpt') => ({ platform, externalId: 'e' + i, title: 'T' + i, url: `https://chatgpt.com/c/e${i}`, messages: [{ role: 'user', content: `问题 ${i}` }, { role: 'assistant', content: `回答 ${i}` }], capturedAt: t });
const hellos = (W) => W.frames.filter((f) => f.type === 'hello');

const store = Store.open(fs.mkdtempSync(path.join(os.tmpdir(), 'mem0-ind-')));
const port = await freePort();
const url = `ws://127.0.0.1:${port}/browser/v1`;
const bridge = await startBridge(store, { port });
const clients = [];
const mkClient = (o) => { const c = new BridgeClient({ url, version: '9.9.9', extensionId: 'abcdefghijklmnopabcdefghijklmnop', ...o }); clients.push(c); return c; };
const countConvs = () => store.listConversations({ limit: 5000 }).length;

const S1 = memStorage();
const W1 = recWS();
const c1 = mkClient({ WebSocket: W1, storage: S1 });
await T('bridge', '未配对：enqueue 只入队，不建连接，状态 need_pair', async () => {
  await c1.enqueue(conv(0));
  await until(() => c1.state === 'need_pair', 1000, 'need_pair'); assert.equal(W1.created, 0);
  assert.equal(Object.keys(S1.mem.qidx).length, 1);
});
await T('bridge', '离线队列上限 500：超出时丢弃 capturedAt 最旧的；同一会话只留最新快照', async () => {
  for (let i = 1; i < 505; i++) await c1.enqueue(conv(i));
  const keys = Object.keys(S1.mem.qidx);
  assert.equal(keys.length, 500);
  for (let i = 0; i < 5; i++) assert.ok(!keys.includes('q:chatgpt:e' + i), 'e' + i + ' 应被淘汰');
  await c1.enqueue({ ...conv(504, 9999), title: '更新' });
  assert.equal(Object.keys(S1.mem.qidx).length, 500);
  assert.equal(S1.mem['q:chatgpt:e504'].title, '更新');
});
await T('bridge', '错误配对码：返回「配对码错误或已过期」，不保存 token，hello 只带 pairCode', async () => {
  const { code } = bridge.newPairCode();
  const bad = code === '000000' ? '000001' : '000000';
  const r = await c1.pair(bad);
  assert.deepEqual(r, { ok: false, error: '配对码错误或已过期' });
  assert.ok(!S1.mem.token);
  const h = hellos(W1).at(-1);
  assert.equal(h.pairCode, bad); assert.ok(!('token' in h));
  assert.equal(c1.state, 'need_pair');
});
await T('bridge', '正确配对：拿到 token，补发离线队列 500 条，ack 后清空队列', async () => {
  const { code } = bridge.newPairCode();
  const r = await c1.pair(code);
  assert.deepEqual(r, { ok: true });
  assert.ok(typeof S1.mem.token === 'string' && S1.mem.token.length > 20);
  assert.equal(c1.state, 'connected'); assert.equal(c1.desktopVersion, '0.1.0');
  const h = hellos(W1).at(-1); assert.equal(h.pairCode, code); assert.ok(!('token' in h)); assert.equal(h.protocol, 1);
  await until(() => countConvs() === 500, 8000, '500 convs in store');
  try { await until(async () => Object.keys(S1.mem.qidx).length === 0, 4000, 'queue drained'); }
  catch { throw new Error(`全部 500 条已入库，但 ack 后队列仍残留 ${Object.keys(S1.mem.qidx).length} 条（并发读改写，见下方两项）`); }
  assert.ok(S1.mem.stats.chatgpt >= 1000, JSON.stringify(S1.mem.stats));
});
await T('bridge', '配对码一次性：用过后再用同一个码失败', async () => {
  const W = recWS(); const c = mkClient({ WebSocket: W, storage: memStorage() });
  const { code } = bridge.newPairCode();
  assert.equal((await c1.pair(code)).ok, true); // 已有 token 的客户端重配对
  assert.equal((await c.pair(code)).ok, false);
});
await T('bridge', '已有 token 时重新配对，hello 里也不带 token', async () => {
  assert.ok(S1.mem.token);
  const h = hellos(W1).at(-1);
  assert.ok(h.pairCode && !('token' in h));
  for (const f of W1.frames) assert.ok(!(f.token && f.pairCode), '同一帧同时有 token 和 pairCode');
});
await T('bridge', '用 token 重连：hello 只带 token，不带 pairCode', async () => {
  const W = recWS(); const c = mkClient({ WebSocket: W, storage: S1 });
  await c.connect();
  await until(() => c.state === 'connected', 3000, 'connected');
  const h = hellos(W)[0]; assert.equal(h.token, S1.mem.token); assert.ok(!('pairCode' in h));
  c.ws.close(); c.unpair = c.unpair; clearTimeout(c.retryTimer); c.ws = null; c.state = 'need_pair'; clearTimeout(c.retryTimer);
});
await T('bridge', '并发 connect()（SW 启动时 top-level + onInstalled/onStartup + enqueue）只应建 1 条连接', async () => {
  const S = memStorage(10); S.mem.token = S1.mem.token;
  const W = recWS(); const c = mkClient({ WebSocket: W, storage: S });
  const before = bridge.status().connected;
  await Promise.all([c.connect(), c.connect(), c.connect()]);
  await wait(400);
  const extra = bridge.status().connected - before;
  for (const s of W.sockets) if (s !== c.ws) s.close();
  assert.equal(W.created, 1, `创建了 ${W.created} 条 WebSocket，桌面端多了 ${extra} 个已认证连接（泄漏）`);
});
await T('bridge', '队列读改写并发：快速连续 enqueue + 并发 ack 后队列应清空且不丢快照', async () => {
  const S = memStorage(6); S.mem.token = S1.mem.token;
  const W = recWS(); const c = mkClient({ WebSocket: W, storage: S });
  await c.connect(); await until(() => c.state === 'connected', 3000, 'connected');
  await Promise.all(Array.from({ length: 40 }, (_, i) => c.enqueue(conv(1000 + i, Date.now() + i))));
  await until(() => W.frames.filter((f) => f.type === 'upsert').length >= 40, 3000, 'upserts sent');
  await wait(800);
  const left = Object.keys(S.mem.qidx || {});
  assert.equal(left.length, 0, `ack 后队列仍残留 ${left.length} 条（并发读改写把已删除的写回）`);
});
await T('bridge', '队列读改写并发：ack 处理期间新入队的快照不能被覆盖丢失', async () => {
  const S = memStorage(8); S.mem.token = S1.mem.token;
  const W = recWS(); const c = mkClient({ WebSocket: W, storage: S });
  await c.connect(); await until(() => c.state === 'connected', 3000, 'connected');
  // 断开发送，模拟新快照只能留在离线队列里
  let lost = 0;
  for (let round = 0; round < 10; round++) {
    const k = 2000 + round;
    await c.enqueue(conv(k, Date.now()));
    // 让 ack 正在处理时再入队另一个会话，并让它发不出去
    const origSend = c.send.bind(c);
    await wait(2);
    c.send = () => {};
    await c.enqueue(conv(k + 100, Date.now()));
    c.send = origSend;
    await wait(80);
    if (!(S.mem.qidx || {})['q:chatgpt:e' + (k + 100)]) lost++;
  }
  assert.equal(lost, 0, `${lost}/10 次新快照从离线队列里丢失`);
});
await T('bridge', '平台不被桌面端支持 → ack ok:false，保留在队列、记录 lastError', async () => {
  const S = memStorage(); S.mem.token = S1.mem.token;
  const W = recWS(); const c = mkClient({ WebSocket: W, storage: S });
  await c.connect(); await until(() => c.state === 'connected', 3000, 'connected');
  await c.enqueue(conv(1, 1, 'foo'));
  await until(() => c.lastError === 'unsupported_platform', 2000, 'lastError');
  assert.ok(S.mem['q:foo:e1']);
});
await T('bridge', '不被支持的快照会永远留在队列里、每次重连都重发（毒丸）', async () => {
  throw new Error('ok:false 的条目从不删除，也不计入上限前的淘汰优先级；建议对非临时错误（unsupported_platform）直接丢弃');
}, { risk: true });

// ---- 自建可控服务端：ack 竞态
{
  const p2 = await freePort();
  const wss = new WebSocketServer({ host: '127.0.0.1', port: p2 });
  const got = []; let sock;
  wss.on('connection', (ws) => { sock = ws; ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.type === 'hello') ws.send(JSON.stringify({ type: 'welcome', desktopVersion: 'mock' })); else got.push(m); }); });
  const S = memStorage(); S.mem.token = 'tok';
  const c = new BridgeClient({ WebSocket: recWS(), storage: S, url: `ws://127.0.0.1:${p2}/` });
  await c.connect(); await until(() => c.state === 'connected', 3000, 'mock connected');
  const ack = (reqId, ok = true, extra = {}) => sock.send(JSON.stringify({ type: 'ack', reqId, ok, changed: true, added: 1, ...extra }));
  await T('bridge', 'ack 竞态：旧快照的 ack 晚到，不删除更新的快照', async () => {
    await c.enqueue(conv(7, 100)); await c.enqueue(conv(7, 200));
    // 同一 key 同时最多 1 个在途，第二份等第一份 ack 后再发
    await until(() => got.length === 1, 2000, '1 upsert');
    assert.ok(!('capturedAt' in got[0].conversation), 'capturedAt 不应发给桌面端');
    ack(got[0].reqId);
    await until(() => got.length === 2, 2000, '2nd upsert after ack');
    assert.equal(S.mem['q:chatgpt:e7'].capturedAt, 200);
    ack(got[1].reqId); await wait(60);
    assert.ok(!S.mem['q:chatgpt:e7']);
  });
  await T('bridge', 'ack 乱序：旧请求超时后晚到的 ack，不会把队列写回', async () => {
    got.length = 0;
    c.ackTimeout = 30;
    await c.enqueue(conv(8, 100)); await until(() => got.length === 1, 2000, 'upsert');
    await wait(80); // 等旧请求超时清出 inflight
    c.ackTimeout = 30_000;
    await c.enqueue(conv(8, 200)); await until(() => got.length === 2, 2000, '2nd upsert');
    ack(got[0].reqId); await wait(60); // 旧 ack 晚到，reqId 已不在在途表
    assert.equal(S.mem['q:chatgpt:e8'].capturedAt, 200, '旧 ack 不应删除更新的快照');
    ack(got[1].reqId); await wait(60);
    assert.ok(!S.mem['q:chatgpt:e8']);
  });
  await T('bridge', 'ack ok:false 保留；未知 reqId / 非 JSON 帧被忽略', async () => {
    got.length = 0;
    await c.enqueue(conv(9, 1)); await until(() => got.length === 1, 2000, 'upsert');
    ack(got[0].reqId, false, { error: 'db_busy' }); await wait(60);
    assert.ok(S.mem['q:chatgpt:e9']); assert.equal(c.lastError, 'db_busy');
    ack(99999); sock.send('not json'); sock.send('{"type":"weird"}'); await wait(60);
    assert.equal(c.state, 'connected');
  });
  await T('bridge', '断线后 inflight 清空，重连后补发仍在队列的快照', async () => {
    got.length = 0;
    sock.terminate();
    await until(() => c.state === 'connected' && got.some((m) => m.conversation.externalId === 'e9'), 5000, 'resend after reconnect');
    assert.equal(c.inflight.size, got.length);
  });
  clearTimeout(c.retryTimer); clearInterval(c.pingTimer); c.ws.onclose = null; c.ws.close();
  await new Promise((r) => wss.close(r));
}

await T('bridge', '桌面端撤销所有配对（revokeAll）→ 客户端重连得到 token_invalid → 清 token，need_pair，不再重试', async () => {
  const S = memStorage(); S.mem.token = S1.mem.token;
  const W = recWS(); const c = mkClient({ WebSocket: W, storage: S });
  await c.connect(); await until(() => c.state === 'connected', 3000, 'connected');
  bridge.revokeAll();
  await until(() => c.state === 'need_pair', 5000, 'need_pair after revoke');
  assert.equal(S.mem.token, null); assert.equal(c.lastError, '配对已失效，请重新配对');
  assert.equal(bridge.status().paired, 0);
  const n = W.created; await wait(2500); assert.equal(W.created, n, 'need_pair 后不应继续自动重连');
});
await T('bridge', '假 token → token_invalid → need_pair 并清掉 token', async () => {
  const S = memStorage(); S.mem.token = 'forged';
  const c = mkClient({ WebSocket: recWS(), storage: S });
  await c.connect(); await until(() => c.state === 'need_pair', 3000, 'need_pair');
  assert.equal(S.mem.token, null);
});
await T('bridge', '桌面端没开：状态 disconnected「桌面端未运行」', async () => {
  const dead = await freePort();
  const S = memStorage(); S.mem.token = 't';
  const c = new BridgeClient({ WebSocket: recWS(), storage: S, url: `ws://127.0.0.1:${dead}/browser/v1` });
  await c.connect(); await until(() => c.state === 'disconnected', 3000, 'disconnected');
  assert.equal(c.lastError, '桌面端未运行');
  clearTimeout(c.retryTimer);
});
await T('bridge', '配对超时（端口能连上但不回应）：8 秒后返回超时错误', async () => {
  const hole = net.createServer((s) => { s.on('data', () => {}); });
  await new Promise((r) => hole.listen(0, '127.0.0.1', r));
  const c = new BridgeClient({ WebSocket: recWS(), storage: memStorage(), url: `ws://127.0.0.1:${hole.address().port}/browser/v1` });
  const t0 = Date.now(); const r = await c.pair('123456');
  assert.equal(r.ok, false); assert.match(r.error, /连接超时/);
  assert.ok(Date.now() - t0 >= 7900 && Date.now() - t0 < 9500);
  assert.equal(c.pendingPair, null);
  try { c.ws.onclose = null; c.ws.terminate(); } catch {} clearTimeout(c.retryTimer);
  for (const s of [hole]) s.close();
});
await T('bridge', '重连退避：2s 起翻倍、封顶 60s；连上后重置为 2s', async () => {
  const delays = [];
  const realST = globalThis.setTimeout;
  class Dead { constructor() { this.readyState = 0; queueMicrotask(() => { this.readyState = 3; this.onclose && this.onclose(); }); } close() {} send() {} }
  const S = memStorage(); S.mem.token = 't';
  const c = new BridgeClient({ WebSocket: Dead, storage: S, url: 'ws://127.0.0.1:1/x' });
  globalThis.setTimeout = (fn, ms, ...a) => { if (ms >= 2000 && delays.length < 9) { delays.push(ms); return realST(fn, 0, ...a); } if (ms >= 2000) return 0; return realST(fn, ms, ...a); };
  try { await c.connect(); await until(() => delays.length >= 9, 3000, 'retries'); } finally { globalThis.setTimeout = realST; }
  assert.deepEqual(delays, [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000, 60000]);
  await c.onMessage({ readyState: 3, send() {} }, JSON.stringify({ type: 'welcome' }));
  assert.equal(c.retryDelay, 2000);
  clearInterval(c.pingTimer); c.ws = null;
});
await T('bridge', '桌面端拒绝网页 Origin 与伪造 Host（DNS rebinding）', async () => {
  const tryConn = (opts) => new Promise((r) => { const ws = new WebSocket(url, opts); ws.on('open', () => { ws.close(); r('open'); }); ws.on('error', () => r('rejected')); });
  assert.equal(await tryConn({ origin: 'https://evil.example' }), 'rejected');
  assert.equal(await tryConn({ origin: 'chrome-extension://abc', headers: { Host: 'evil.example:' + port } }), 'rejected');
  assert.equal(await tryConn({ origin: 'chrome-extension://abc' }), 'open');
});
await T('bridge', '配对码可被暴力尝试：错误尝试不作废配对码、无次数限制', async () => {
  const { code } = bridge.newPairCode();
  for (let i = 0; i < 3; i++) { const c = new BridgeClient({ WebSocket: recWS(), storage: memStorage(), url }); await c.pair(String((+code + 1 + i) % 1e6).padStart(6, '0')); }
  const c = new BridgeClient({ WebSocket: recWS(), storage: memStorage(), url });
  const r = await c.pair(code);
  try { c.ws.close(); } catch {}
  assert.equal(r.ok, false, '3 次错误后正确码仍可用（本机进程可在 2 分钟内穷举 10^6）');
}, { risk: true });

for (const c of clients) { clearTimeout(c.retryTimer); clearInterval(c.pingTimer); if (c.ws) { c.ws.onclose = null; try { c.ws.close(); } catch {} } }
await bridge.close();
store.close();

// ============================================================ 4. 后台消息处理
{
  const local = {}; const badge = []; const alarms = []; const bg = {};
  globalThis.chrome = {
    runtime: { id: 'selfid', getManifest: () => ({ version: '0.1.0' }), onMessage: { addListener: (f) => { bg.onMsg = f; } }, onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
    storage: { local: { get: async (k) => structuredClone(Object.fromEntries([].concat(k).map((x) => [x, local[x]]))), set: async (o) => { Object.assign(local, structuredClone(o)); } }, session: { set: async () => {} } },
    action: { setBadgeText: async (o) => { badge.push(o.text); }, setBadgeBackgroundColor: async () => {} },
    alarms: { create: (n, o) => alarms.push([n, o]), onAlarm: { addListener() {} } },
  };
  const wsMade = [];
  Object.defineProperty(globalThis, 'WebSocket', { value: class { constructor(u) { wsMade.push(u); this.readyState = 0; } close() {} send() {} }, configurable: true, writable: true });
  const tmp = path.join(os.tmpdir(), `bg-${process.pid}.mjs`);
  fs.writeFileSync(tmp, rd('src/background.js').replace("'./bridge-client.js'", JSON.stringify(pathToFileURL(path.join(root, 'src/bridge-client.js')).href)));
  await import(pathToFileURL(tmp).href);
  const call = (msg, sender) => new Promise((resolve) => {
    let done = false;
    const ret = bg.onMsg(msg, sender, (r) => { done = true; resolve({ ret, r }); });
    setTimeout(() => { if (!done) resolve({ ret, r: undefined, ignored: ret !== true }); }, 80);
  });
  const self = { id: 'selfid', tab: { id: 3 }, url: 'https://chatgpt.com/c/x' };
  const popup = { id: 'selfid', url: 'chrome-extension://selfid/src/popup/popup.html' };
  await T('background', '启动：need_pair，徽标「!」，建 1 分钟 alarm，无 token 不建 WebSocket', async () => {
    await wait(50);
    assert.equal(badge.at(-1), '!'); assert.deepEqual(alarms, [['mem0-keepalive', { periodInMinutes: 1 }]]); assert.equal(wsMade.length, 0);
  });
  await T('background', '其他扩展（sender.id 不同）的消息全部忽略', async () => {
    for (const type of ['capture', 'status', 'pair', 'unpair', 'reconnect']) {
      const x = await call({ type, conversation: conv(1), code: '123456' }, { id: 'evil', tab: { id: 1 } });
      assert.ok(x.ignored && x.r === undefined, type);
    }
    assert.ok(!local.queue && !local.qidx);
  });
  await T('background', 'capture 必须来自标签页（内容脚本）；来自弹窗的 capture 被忽略', async () => {
    const x = await call({ type: 'capture', conversation: conv(1) }, popup);
    assert.ok(x.ignored); assert.ok(!local.queue && !local.qidx);
  });
  await T('background', '内容脚本 capture → 入队并回复 ok', async () => {
    const x = await call({ type: 'capture', conversation: conv(1) }, self);
    assert.equal(x.ret, true); assert.deepEqual(x.r, { ok: true }); assert.ok(local['q:chatgpt:e1']);
  });
  await T('background', 'status 回复结构完整', async () => {
    local.disabledPlatforms = ['kimi'];
    const { r } = await call({ type: 'status' }, popup);
    assert.equal(r.bridge.state, 'need_pair'); assert.equal(r.queued, 1); assert.deepEqual(r.disabledPlatforms, ['kimi']); assert.equal(r.paused, false);
  });
  await T('background', '畸形消息（null/字符串/未知 type/缺 conversation）不抛异常', async () => {
    for (const m of [null, 'x', 42, {}, { type: 'nope' }]) assert.equal(bg.onMsg(m, self, () => {}), undefined);
    const x = await call({ type: 'capture' }, self);
    assert.equal(x.ret, true); assert.equal(x.r.ok, false);
  });
  await T('background', 'pair/unpair 也接受来自内容脚本（sender.tab）的消息（加固建议：仅限扩展页面）', async () => {
    const x = await call({ type: 'unpair' }, self);
    assert.ok(x.ignored, '内容脚本可以触发解除配对');
  }, { risk: true });
  delete globalThis.chrome;
  fs.rmSync(tmp, { force: true });
}

// ============================================================ 4b. 弹窗逻辑
async function popupRun({ status, tabs = [{ id: 7 }], page, pageErr, pairReply = { ok: false, error: '配对码错误或已过期' }, local = {} }) {
  const html = rd('src/popup/popup.html').replace(/<script[^>]*><\/script>/, '');
  const dom = new JSDOM(html, { url: 'chrome-extension://selfid/src/popup/popup.html', runScripts: 'outside-only' });
  const w = dom.window; const sent = [];
  w.chrome = {
    runtime: { sendMessage: async (m) => { sent.push(J(m)); if (m.type === 'status') return status; if (m.type === 'pair') return pairReply; return { ok: true }; } },
    tabs: { query: async () => tabs, sendMessage: async () => { if (pageErr) throw new Error(pageErr); return page; } },
    storage: { local: { get: async (k) => ({ [k]: local[k] }), set: async (o) => { Object.assign(local, o); } } },
  };
  const errors = [];
  w.addEventListener('error', (e) => errors.push(String(e.message)));
  w.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
  w.eval(rd('src/popup/popup.js'));
  await wait(100);
  const $ = (s) => w.document.querySelector(s);
  return { w, $, sent, local, errors, text: (s) => $(s).textContent };
}
const ST = (state, extra = {}) => ({ bridge: { state, lastError: null, desktopVersion: '0.3.1' }, queued: 0, stats: {}, paused: false, disabledPlatforms: [], ...extra });
await T('popup', '不支持的页面（tabs.sendMessage 报 Receiving end does not exist）显示「不支持」且不报错', async () => {
  const p = await popupRun({ status: ST('connected'), pageErr: 'Could not establish connection. Receiving end does not exist.' });
  assert.equal(p.text('#page-state'), '不支持'); assert.deepEqual(p.errors, []);
  assert.equal(p.text('#conn-state'), '已连接'); assert.ok(p.$('#pair-form').classList.contains('hidden')); assert.ok(!p.$('#unpair').classList.contains('hidden'));
  assert.ok(p.sent.some((m) => m.type === 'reconnect'));
});
await T('popup', '没有活动标签页（tabs.query 为空）也显示「不支持」', async () => {
  const p = await popupRun({ status: ST('disconnected'), tabs: [] });
  assert.equal(p.text('#page-state'), '不支持'); assert.equal(p.text('#conn-state'), '未连接'); assert.deepEqual(p.errors, []);
});
await T('popup', '页面状态：已暂停 / 等待对话 / 正在备份', async () => {
  assert.equal((await popupRun({ status: ST('connected'), page: { platform: 'kimi', enabled: false } })).text('#page-state'), '已暂停');
  assert.equal((await popupRun({ status: ST('connected'), page: { platform: 'kimi', enabled: true, conversation: false } })).text('#page-state'), '等待对话');
  const p = await popupRun({ status: ST('connected', { queued: 3 }), page: { platform: 'deepseek', enabled: true, conversation: true, messages: 4, title: 'T' } });
  assert.equal(p.text('#page-state'), '正在备份'); assert.equal(p.text('#page-detail'), 'DeepSeek · 4 条消息 · T'); assert.equal(p.text('#queued'), '3 个对话等待同步');
});
await T('popup', '配对表单：非 6 位数字本地拦截；6 位数字发 pair 并显示错误；平台开关写入 disabledPlatforms', async () => {
  const p = await popupRun({ status: ST('need_pair', { disabledPlatforms: ['gemini'] }), local: { disabledPlatforms: ['gemini'] } });
  assert.ok(!p.$('#pair-form').classList.contains('hidden'));
  p.$('#code').value = '12a45'; p.$('#pair-form').dispatchEvent(new p.w.Event('submit', { cancelable: true })); await wait(30);
  assert.equal(p.text('#pair-msg'), '请输入 6 位数字'); assert.ok(!p.sent.some((m) => m.type === 'pair'));
  p.$('#code').value = ' 123456 '; p.$('#pair-form').dispatchEvent(new p.w.Event('submit', { cancelable: true })); await wait(50);
  assert.deepEqual(p.sent.find((m) => m.type === 'pair'), { type: 'pair', code: '123456' });
  assert.equal(p.text('#pair-msg'), '配对码错误或已过期');
  const boxes = [...p.w.document.querySelectorAll('#platforms input')];
  assert.equal(boxes.length, 11); assert.equal(boxes[2].checked, false);
  boxes[0].checked = false; boxes[0].dispatchEvent(new p.w.Event('change')); await wait(30);
  assert.deepEqual([...p.local.disabledPlatforms].sort(), ['chatgpt', 'gemini']);
});
await T('popup', '后台没回 status（SW 刚被回收/异常）时弹窗不应崩溃', async () => {
  const before = unhandled.length;
  const p = await popupRun({ status: undefined });
  const errs = [...p.errors, ...unhandled.slice(before)];
  assert.deepEqual(errs, [], errs.join('; ') + '（弹窗停在「…」）');
}, { risk: true });

// ============================================================ 5. 隐私 / 安全（静态）
const srcFiles = ['src/background.js', 'src/bridge-client.js', 'src/content/engine.js', 'src/content/platforms.js', 'src/popup/popup.js', 'src/popup/popup.html'];
await T('privacy', '无 eval / new Function / 字符串 setTimeout / 远程脚本 / importScripts', () => {
  for (const f of srcFiles) {
    const s = rd(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    for (const re of [/\beval\s*\(/, /new\s+Function\b/, /\bFunction\s*\(/, /set(Timeout|Interval)\s*\(\s*['"`]/, /importScripts/, /\bimport\s*\(/, /chrome\.scripting/, /executeScript/, /<script[^>]+src=["']https?:/])
      assert.ok(!re.test(s), `${f}: ${re}`);
  }
});
await T('privacy', '无 fetch/XHR/sendBeacon/Image 外发；唯一网络地址是 ws://127.0.0.1', () => {
  for (const f of srcFiles) {
    const s = rd(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.ok(!/\bfetch\s*\(|XMLHttpRequest|sendBeacon|new\s+Image\b|EventSource|navigator\.connect/.test(s), f);
    for (const m of s.matchAll(/\b(wss?|https?):\/\/[^\s'"`)]+/g)) assert.ok(/^ws:\/\/127\.0\.0\.1:3791\//.test(m[0]), `${f}: ${m[0]}`);
  }
  assert.ok(!/new WebSocket|new this\.WS/.test(rd('src/content/engine.js') + rd('src/content/platforms.js')), '内容脚本不应自己连网');
});
await T('privacy', '不往页面写 HTML（无 innerHTML/outerHTML/insertAdjacentHTML/document.write）', () => {
  for (const f of srcFiles) assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(rd(f)), f);
});
await T('privacy', '不读站点私有接口、cookie、localStorage', () => {
  for (const f of ['src/content/engine.js', 'src/content/platforms.js']) assert.ok(!/document\.cookie|localStorage|sessionStorage|indexedDB/.test(rd(f)), f);
});

// ============================================================ 汇总
const icon = { PASS: '✓', FAIL: '✗', WARN: '!' };
for (const r of results) console.log(`${icon[r.status]} [${r.cat}] ${r.name}${r.msg ? '\n    → ' + r.msg : ''}`);
const n = (s) => results.filter((r) => r.status === s).length;
console.log(`\nPASS ${n('PASS')}  FAIL ${n('FAIL')}  WARN ${n('WARN')}  / ${results.length}`);
process.exit(n('FAIL') ? 1 : 0);
