// 插件自测：各平台 DOM 解析 + 与桌面端插件桥的端到端联调。
// 桌面端联调需要 ../mem0-desktop 已 npm install；找不到就跳过。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import WebSocket from 'ws';
import { BridgeClient } from '../src/bridge-client.js';
import './queue.mjs';
import './bridge-flush.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const code = ['src/content/platforms.js', 'src/content/engine.js'].map((f) => fs.readFileSync(path.join(root, f), 'utf8'));

function load(url, html) {
  const dom = new JSDOM(`<!doctype html><html><head><title>${html.title || ''}</title></head><body>${html.body}</body></html>`, { url, runScripts: 'outside-only' });
  for (const c of code) dom.window.eval(c);
  const NS = dom.window.__mem0;
  const p = NS.platformFor(dom.window.location.hostname);
  return NS.snapshot(p, dom.window.document, url);
}

const cases = [
  {
    name: 'ChatGPT', url: 'https://chatgpt.com/c/6731a2b4-0000-8000-9000-abcdefabcdef',
    title: '排序算法比较 - ChatGPT',
    body: `<main>
      <div data-message-author-role="user"><div class="whitespace-pre-wrap">快排和归并哪个快？</div></div>
      <div data-message-author-role="assistant"><div class="markdown"><p>平均都是 O(n log n)。</p><pre><code class="language-python">sorted(a)</code></pre><button>复制</button></div></div>
      <div data-message-author-role="system">隐藏</div></main>`,
    expect: { id: '6731a2b4-0000-8000-9000-abcdefabcdef', title: '排序算法比较', n: 2, has: ['```python\nsorted(a)\n```'], not: ['复制', '隐藏'] },
  },
  {
    name: 'Claude', url: 'https://claude.ai/chat/0f0e0d0c-1111-2222-3333-444455556666',
    body: `<button data-testid="chat-title-button">写周报</button>
      <div><div data-testid="user-message"><p>帮我写周报</p></div></div>
      <div data-is-streaming="false"><div class="font-claude-response"><p>本周完成了：</p><ul><li>接口联调</li></ul></div></div>`,
    expect: { title: '写周报', n: 2, has: ['- 接口联调'] },
  },
  {
    name: 'Gemini', url: 'https://gemini.google.com/app/a1b2c3d4e5f6',
    body: `<user-query><div class="query-text">东京今天天气</div></user-query>
      <model-response><message-content><p>晴，18 度。</p></message-content></model-response>
      <user-query><div class="query-text">明天呢</div></user-query>
      <model-response><message-content><p>多云。</p></message-content></model-response>`,
    expect: { n: 4, roles: 'user,assistant,user,assistant' },
  },
  {
    name: 'DeepSeek', url: 'https://chat.deepseek.com/a/chat/s/8d1c6f0e-aaaa-bbbb-cccc-111122223333',
    title: '质数判断 - DeepSeek',
    body: `<div class="ds-message"><div class="fbb737a4">判断质数的最快方法？</div></div>
      <div class="ds-message"><div class="ds-think-content"><div class="ds-markdown">推理过程不要</div></div><div class="ds-markdown"><p>用 Miller-Rabin。</p></div></div>`,
    expect: { title: '质数判断', n: 2, has: ['Miller-Rabin'], not: ['推理过程'] },
  },
  {
    name: '豆包', url: 'https://www.doubao.com/chat/1234567890123',
    body: `<div data-testid="send_message"><div data-testid="message_text_content">翻译 hello</div></div>
      <div data-testid="receive_message"><div data-testid="message_text_content">你好</div><button>重新生成</button></div>`,
    expect: { n: 2, has: ['你好'], not: ['重新生成'] },
  },
  {
    name: '元宝', url: 'https://yuanbao.tencent.com/chat/naQivTmsDa/5b1d2c3e-aaaa-bbbb-cccc-0123456789ab',
    body: `<div class="agent-chat__list__item--human"><div class="hyc-content-text">讲个笑话</div></div>
      <div class="agent-chat__list__item--ai"><div class="hyc-content-md"><p>程序员的笑话……</p></div></div>`,
    expect: { n: 2 },
  },
  {
    name: 'Kimi', url: 'https://www.kimi.com/chat/d2abc123-0000-1111-2222-333344445555',
    body: `<div class="chat-content-item chat-content-item-user"><div class="user-content">总结这篇文章</div></div>
      <div class="chat-content-item chat-content-item-assistant"><div class="markdown-container"><p>主要讲了三点。</p></div></div>`,
    expect: { n: 2 },
  },
  {
    name: '千问', url: 'https://www.qianwen.com/chat/abcdef0123456789',
    body: `<div class="questionItem--x1"><p>写首诗</p></div><div class="answerItem--y2"><div class="markdown-body"><p>床前明月光</p></div></div>`,
    expect: { n: 2 },
  },
  {
    name: 'Grok', url: 'https://grok.com/c/0b3f6c2e-1a2b-4c3d-8e9f-0123456789ab',
    body: `<div data-testid="user-message"><div class="response-content-markdown"><p>你好 Grok</p></div></div>
      <div data-testid="assistant-message"><div class="response-content-markdown"><p>你好！</p></div><div class="action-buttons"><button>复制</button></div></div>`,
    expect: { n: 2, id: '0b3f6c2e-1a2b-4c3d-8e9f-0123456789ab', has: ['你好！'], not: ['复制'] },
  },
  {
    name: 'Hark', url: 'https://hark.com/chat',
    body: `<div data-role="user"><div data-bubble-id="b1">提醒我明天交房租</div></div>
      <div data-role="agent"><div data-agent-activity-window>正在设置提醒</div><div data-bubble-id="b2">好的，明早 9 点提醒你。</div></div>`,
    expect: { n: 2, id: 'main', has: ['好的，明早 9 点提醒你。'], not: ['正在设置提醒'] },
  },
  {
    name: 'Hark 新版', url: 'https://hark.com/chat',
    body: `<main>
      <div data-rich-entry><div data-bubble-id="u1" data-bubble-kind="text"><div data-align="end"><div class="content">帮我整理今天的待办</div></div></div></div>
      <div data-rich-entry><div data-bubble-id="a1"><div class="content"><p>好的，待办已整理。</p></div></div></div>
      <div data-rich-entry><div data-bubble-id="u2" data-bubble-kind="empty"><div data-align="end"><img src="todo.png" alt=""></div></div></div>
    </main>`,
    expect: { n: 3, roles: 'user,assistant,user', has: ['好的，待办已整理。', '[图片]'], not: ['todo.png'] },
  },
  {
    name: '非会话页', url: 'https://chatgpt.com/',
    body: `<div data-message-author-role="user">x</div>`,
    expect: null,
  },
];

let pass = 0;
for (const c of cases) {
  const snap = load(c.url, c);
  if (c.expect === null) { assert.equal(snap, null, c.name); pass++; continue; }
  assert.ok(snap, `${c.name}: 应识别出会话`);
  const all = snap.messages.map((m) => m.content).join('\n');
  if (c.expect.id) assert.equal(snap.externalId, c.expect.id, c.name);
  if (c.expect.title) assert.equal(snap.title, c.expect.title, `${c.name} 标题`);
  assert.equal(snap.messages.length, c.expect.n, `${c.name} 条数：${JSON.stringify(snap.messages)}`);
  assert.equal(snap.messages[0].role, 'user', c.name);
  if (c.expect.roles) assert.equal(snap.messages.map((m) => m.role).join(','), c.expect.roles, c.name);
  for (const h of c.expect.has || []) assert.ok(all.includes(h), `${c.name} 应包含 ${h}：${all}`);
  for (const h of c.expect.not || []) assert.ok(!all.includes(h), `${c.name} 不应包含 ${h}`);
  pass++;
}
console.log(`✓ 平台解析 ${pass}/${cases.length}`);

// ---------- 内容脚本运行时（jsdom + chrome 桩） ----------
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await wait(20); } };

let vis = 'visible';
function contentRun(url, html) {
  const dom = new JSDOM(`<!doctype html><html><head><title>${html.title || ''}</title></head><body>${html.body}</body></html>`, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  Object.defineProperty(w.document, 'visibilityState', { configurable: true, get: () => vis });
  const chrome = {
    sent: [], listeners: [], local: {},
    runtime: {
      id: 'extid',
      sendMessage: (m) => { chrome.sent.push(JSON.parse(JSON.stringify(m))); return Promise.resolve({ ok: true }); },
      onMessage: { addListener: (f) => chrome.listeners.push(f) },
    },
    storage: { local: { get: async () => ({}) }, onChanged: { addListener: () => {} } },
  };
  w.chrome = chrome;
  const timers = { scheduled: [], cleared: [] };
  const st = w.setTimeout, ct = w.clearTimeout;
  w.setTimeout = function (fn, ms, ...a) { const id = st.call(w, fn, ms, ...a); timers.scheduled.push({ id, ms }); return id; };
  w.clearTimeout = function (id) { timers.cleared.push(id); return ct.call(w, id); };
  for (const c of code) w.eval(c);
  return { w, chrome, timers };
}
{
  const hark = {
    title: '今日待办',
    body: `<main>
      <div data-rich-entry><div data-bubble-id="u1"><div data-align="end"><div class="content">帮我整理今天的待办</div></div></div></div>
      <div data-rich-entry><div data-bubble-id="a1"><div class="content"><p>好的，待办已整理。</p></div></div></div>
      <div data-rich-entry><div data-bubble-id="u2" data-bubble-kind="empty"><div data-align="end"><img src="todo.png" alt=""></div></div></div>
    </main>`,
  };
  const { w, chrome, timers } = contentRun('https://hark.com/chat', hark);
  let r;
  await until(() => chrome.sent.length >= 1);
  assert.equal(chrome.sent[0].type, 'capture');
  assert.equal(chrome.sent[0].conversation.messages.length, 3);
  chrome.listeners[0]({ type: 'pageStatus' }, {}, (x) => { r = x; });
  assert.deepEqual(Object.keys(r).sort(), ['conversation', 'enabled', 'messages', 'platform', 'title']);
  assert.deepEqual(JSON.parse(JSON.stringify(r)), { platform: 'hark', enabled: true, conversation: true, messages: 3, title: '今日待办' });
  console.log('✓ pageStatus 用摘要回复');

  // 与对话无关的节点变动不调度采集
  const before = timers.scheduled.length;
  const tip = w.document.createElement('div');
  tip.setAttribute('role', 'tooltip');
  tip.textContent = '提示';
  w.document.body.appendChild(tip);
  await wait(200);
  assert.equal(timers.scheduled.length, before, 'role=tooltip 变动不应调度采集');

  // 新消息正常调度；隐藏前 capture 会清掉待执行的 timer
  const bubble = w.document.createElement('div');
  bubble.innerHTML = '<div data-rich-entry><div data-bubble-id="u3"><div data-align="end"><div class="content">再加一条</div></div></div></div>';
  w.document.querySelector('main').appendChild(bubble.firstElementChild);
  await wait(50);
  assert.equal(timers.scheduled.length, before + 1, '新消息应调度一次采集');
  const pending = timers.scheduled[before];
  assert.equal(pending.ms, 1500);
  vis = 'hidden';
  const n = chrome.sent.length;
  w.dispatchEvent(new w.Event('visibilitychange'));
  assert.ok(timers.cleared.includes(pending.id), 'capture() 开头应 clearTimeout(timer)');
  assert.equal(chrome.sent.length, n + 1, '隐藏标签页时立即补采一次');
  assert.equal(chrome.sent.at(-1).conversation.messages.length, 4);
  await wait(1700);
  assert.equal(chrome.sent.length, n + 1, '已清除的 timer 不应再采集');
  console.log('✓ capture 清 timer / 无关变动不调度采集');
  w.close();
}

// ---------- 弹窗首帧尺寸（避免打开时先闪小黑块） ----------
{
  const html = fs.readFileSync(path.join(root, 'src/popup/popup.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'src/popup/popup.css'), 'utf8');
  const dom = new JSDOM(html.replace('<link rel="stylesheet" href="popup.css" />', `<style>${css}</style>`), {
    url: 'chrome-extension://selfid/src/popup/popup.html',
  });
  const { window } = dom;
  const htmlStyle = window.getComputedStyle(window.document.documentElement);
  const bodyStyle = window.getComputedStyle(window.document.body);
  assert.equal(htmlStyle.width, '320px', 'html 宽度');
  assert.equal(htmlStyle.minHeight, '420px', 'html 最小高度');
  assert.equal(bodyStyle.width, '320px', 'body 宽度');
  assert.equal(bodyStyle.minHeight, '420px', 'body 最小高度');
  // html 自身要有背景色，首帧才不会露出黑底
  const bgRule = [...window.document.styleSheets[0].cssRules].find((r) => r.selectorText
    && r.selectorText.split(',').map((s) => s.trim()).includes('html')
    && /background/.test(r.style.cssText));
  assert.ok(bgRule, 'html 需要设置背景色');
  assert.match(bgRule.style.background, /var\(--bg\)|#|rgb/);
  console.log('✓ 弹窗首帧尺寸固定');
  window.close();
}

// ---------- 与桌面端联调 ----------
const desktop = path.resolve(root, '..', 'mem0-desktop');
if (!fs.existsSync(path.join(desktop, 'node_modules'))) {
  console.log('- 跳过桌面端联调（未找到 ../mem0-desktop/node_modules）');
  process.exit(0);
}
const require = createRequire(path.join(desktop, 'package.json'));
const { Store } = require('./src/main/db.js');
const { startBridge } = require('./src/main/bridge.js');

const store = Store.open(fs.mkdtempSync(path.join(os.tmpdir(), 'mem0-ext-')));
const port = 39891;
const url = `ws://127.0.0.1:${port}/browser/v1`;
// 浏览器扩展发起的连接 Origin 是 chrome-extension://…
class ExtWS extends WebSocket { constructor(u) { super(u, { origin: 'chrome-extension://testextensionidtestextensionid' }); } }
const mem = {};
const storage = { get: async (keys) => Object.fromEntries(keys.map((k) => [k, mem[k]])), set: async (o) => { Object.assign(mem, structuredClone(o)); }, remove: async (keys) => { for (const k of keys) delete mem[k]; } };
const statuses = [];
const client = new BridgeClient({ WebSocket: ExtWS, storage, url, onStatus: (s) => statuses.push(s.state) });

// 1) 桌面端还没开：先排队
const conv = { platform: 'chatgpt', externalId: 'c-1', title: 'T', url: 'https://chatgpt.com/c/c-1', messages: [{ role: 'user', content: '离线时问的问题' }, { role: 'assistant', content: '回答' }], capturedAt: Date.now() };
await client.enqueue(conv);
assert.equal(Object.keys(mem.qidx).length, 1);
assert.equal(client.state, 'need_pair');
console.log('✓ 未配对时先本地排队');

// 2) 开桌面端，错误配对码
const bridge = await startBridge(store, { port });
let r = await client.pair('000000');
assert.equal(r.ok, false);
assert.equal(r.error, '配对码错误或已过期');

// 3) 正确配对 → 自动补发队列
const { code: pc } = bridge.newPairCode();
r = await client.pair(pc);
assert.equal(r.ok, true, JSON.stringify(r));
assert.ok(mem.token);
await until(() => Object.keys(mem.qidx).length === 0);
assert.equal(store.search('离线时问的问题')[0].source, 'chatgpt-web');
console.log('✓ 配对 + 补发离线队列');

// 4) 在线实时上报 + 流式更新
await client.enqueue({ ...conv, messages: [...conv.messages, { role: 'user', content: '追问一句' }, { role: 'assistant', content: '流式回答第一段' }], capturedAt: Date.now() });
await client.enqueue({ ...conv, messages: [...conv.messages, { role: 'user', content: '追问一句' }, { role: 'assistant', content: '流式回答第一段，第二段' }], capturedAt: Date.now() + 1 });
await until(() => store.search('第二段').length === 1 && Object.keys(mem.qidx).length === 0);
assert.equal(store.getConversation(store.search('第二段')[0].conversationId).messages.length, 4);
console.log('✓ 实时上报与流式更新');

// 5) 桌面端重启 → token 自动重连
await bridge.close();
await until(() => client.state === 'disconnected');
await client.enqueue({ platform: 'kimi', externalId: 'k-1', messages: [{ role: 'user', content: '桌面端关着时的 Kimi 对话' }], capturedAt: Date.now() });
const bridge2 = await startBridge(store, { port });
await until(() => client.state === 'connected' && Object.keys(mem.qidx).length === 0, 10000);
assert.equal(store.search('Kimi 对话')[0].source, 'kimi-web');
console.log('✓ 桌面端重启后用 token 自动重连并补发');

// 6) 桌面端撤销 → 插件回到未配对
bridge2.revokeAll();
await until(() => client.state === 'need_pair', 10000);
console.log('✓ 撤销后需要重新配对');

await bridge2.close();
store.close();
console.log('\n全部通过');
process.exit(0);
