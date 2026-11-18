'use strict';
/**
 * T-mem0-ui-v2-patch 测试：托盘快捷小窗 + 连接页「未检测到」折叠（主进程 / 预加载 / 静态部分）。
 * 用法：node --no-warnings test/ui-patch.js
 * 不需要 Electron/GUI：用假的 electron 模块加载真实 src/main/index.js，驱动托盘点击、blur、Esc、IPC。
 * 渲染层交互（小窗布局、连接页折叠）的浏览器测试在 Playwright 脚本里（见 TRAY_REPORT.md）。
 * 全部数据写临时目录；HOME / MEM0_* 指向临时目录，绝不触碰真实 HOME。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

// ---------- 隔离环境（必须在 require 源码之前） ----------
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'mem0-uipatch-'));
const HOME = path.join(T, 'home');
fs.mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
const R = (n) => path.join(T, 'roots', n);
Object.assign(process.env, {
  MEM0_DATA_DIR: path.join(T, 'data'),
  MEM0_CLAUDE_ROOT: R('claude'), MEM0_CODEX_ROOT: R('codex'), MEM0_DSH_ROOT: R('dsh'),
  MEM0_ANTIGRAVITY_ROOT: R('gemini'), MEM0_ZCODE_ROOT: R('zcode'), MEM0_DIMCODE_ROOT: R('dimcode'),
  MEM0_WORKBUDDY_ROOT: R('workbuddy'),
});
fs.mkdirSync(R('claude'), { recursive: true }); // 只有 Claude Code 「检测到」

const ROOT = path.resolve(__dirname, '..');
const SRC = (p) => path.join(ROOT, 'src', p);
const { computePosition, shouldIgnoreClick, shouldDestroyIdle, popoverOptions, TrayPopover, PANEL_WIDTH, INSET, BLUR_CLICK_GUARD_MS, READY_TIMEOUT_MS, REVEAL_TIMEOUT_MS, IDLE_DESTROY_MS } = require(SRC('main/tray-window'));
const { TrayStats, startOfDay, TABLE } = require(SRC('main/stats'));
const { Store } = require(SRC('main/db'));

// ---------- 迷你测试框架 ----------
const results = [];
let group = '';
async function test(name, fn) {
  try { await fn(); results.push({ group, name, ok: true }); process.stdout.write(`  ✓ ${name}\n`); } catch (e) {
    results.push({ group, name, ok: false, err: e }); process.stdout.write(`  ✗ ${name}\n    ${String(e && e.stack || e).split('\n').slice(0, 4).join('\n    ')}\n`);
  }
}
const section = (g) => { group = g; process.stdout.write(`\n${g}\n`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 轮询等待条件成立（默认 2s 超时）；机器忙时比固定 sleep 可靠，超时直接失败
async function waitFor(cond, timeoutMs = 2000, intervalMs = 10) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return true;
    if (Date.now() >= deadline) throw new Error(`waitFor 超时（${timeoutMs}ms）：条件仍未满足`);
    await sleep(intervalMs);
  }
}
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ======================================================================
// 假 Electron
// ======================================================================
function makeFakeElectron({ trayBounds, cursor, display }) {
  const log = { quit: 0, popUp: [], contextMenu: null };
  class WC extends EventEmitter {
    constructor() { super(); this.sent = []; this.loading = false; this.win = null; }
    send(ch, p) {
      // 真实 Electron 向已销毁窗口 send 会抛错：不先判断 win 存在的代码在这里就会失败
      if (this.win && this.win.isDestroyed()) throw new Error('Object has been destroyed');
      this.sent.push([ch, p]);
      // 模拟渲染层显示握手：收到 tray-prepare 后在微任务里回 tray-ready（fake.autoReady=false 时不回，走超时兜底）
      if (ch === 'tray-prepare' && fake.autoReady) queueMicrotask(() => fake.emitIpc('tray-ready', this, { token: p && p.token, height: fake.readyHeight }));
    }
    setWindowOpenHandler(fn) { this.openHandler = fn; }
    isLoading() { return this.loading; }
  }
  class BrowserWindow extends EventEmitter {
    constructor(opts) {
      super(); this.opts = opts; this.visible = false; this.destroyed = false; this.focused = false;
      this.bounds = { x: 0, y: 0, width: opts.width, height: opts.height }; this.webContents = new WC();
      this.webContents.win = this;
      BrowserWindow.all.push(this);
    }
    loadFile(f) { this.file = f; }
    removeMenu() {}
    show() { this.visible = true; }
    hide() { this.visible = false; this.focused = false; }
    focus() { this.focused = true; }
    isVisible() { return this.visible; }
    isDestroyed() { return this.destroyed; }
    destroy() { if (!this.destroyed) { this.destroyed = true; this.visible = false; this.emit('closed'); } }
    isMinimized() { return false; }
    restore() {}
    setBounds(b) { this.bounds = { ...b }; }
    getSize() { return [this.bounds.width, this.bounds.height]; }
    setSize(w, h) { this.bounds.width = w; this.bounds.height = h; }
    setBackgroundColor() {}
    setOpacity(v) { this.opacity = v; (this.opacityLog = this.opacityLog || []).push(v); }
    setAlwaysOnTop(v, level) { this.aotLevel = level; }
    setVisibleOnAllWorkspaces(v, o) { this.visibleOnAllWorkspaces = { v, o }; }
    /** 模拟用户点关闭：返回是否真的关了 */
    tryClose() { const e = { prevented: false, preventDefault() { this.prevented = true; } }; this.emit('close', e); if (!e.prevented) this.destroy(); return !e.prevented; }
  }
  BrowserWindow.all = [];
  class Tray extends EventEmitter {
    constructor(img) { super(); this.img = img; Tray.last = this; }
    setToolTip(t) { this.tip = t; }
    setContextMenu(m) { log.contextMenu = m; }
    popUpContextMenu(m) { log.popUp.push(m); }
    getBounds() { return { ...fake.trayBounds }; }
  }
  const handlers = new Map();
  const ipcListeners = new Map();
  const appEv = new EventEmitter();
  let readyResolve;
  const ready = new Promise((r) => { readyResolve = r; });
  const fake = {
    trayBounds, cursor, display, log, handlers, BrowserWindow, Tray, readyResolve, ipcListeners,
    autoReady: true, readyHeight: undefined,
    emitIpc: (ch, senderWc, payload) => { for (const fn of ipcListeners.get(ch) || []) fn({ sender: senderWc }, payload); },
    app: Object.assign(appEv, {
      requestSingleInstanceLock: () => true, getVersion: () => '0.5.0', getPath: () => path.join(T, 'userData'),
      whenReady: () => ready, quit: () => { log.quit++; }, exit: (code) => { log.exit = (log.exit || 0) + 1; log.exitCode = code; }, isQuitting: false,
      dock: { visible: true, show() { this.visible = true; }, hide() { this.visible = false; } },
    }),
    powerMonitor: Object.assign(new EventEmitter(), {}),
    ipcMain: {
      handle: (ch, fn) => { if (handlers.has(ch)) throw new Error(`dup handler ${ch}`); handlers.set(ch, fn); },
      on: (ch, fn) => { if (!ipcListeners.has(ch)) ipcListeners.set(ch, []); ipcListeners.get(ch).push(fn); },
      removeListener: (ch, fn) => { const a = ipcListeners.get(ch) || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
    },
    Menu: { buildFromTemplate: (t) => ({ items: t }), setApplicationMenu: (m) => { log.appMenu = m; } },
    nativeImage: {
      createFromPath: (p) => {
        // 托盘模板图标真实存在（16x16），返回非空图像以便断言 setTemplateImage
        const icon = fs.readFileSync(p);
        log.iconPath = p;
        const png = { width: icon.readUInt32BE(16), height: icon.readUInt32BE(20) };
        const img = { isEmpty: () => false, getSize: () => ({ ...png }), resize: () => img };
        img.setTemplateImage = (v) => { log.templateImage = v; };
        return img;
      },
      createEmpty: () => ({ empty: true }),
    },
    nativeTheme: { shouldUseDarkColors: false, themeSource: 'system' },
    shell: { openExternal: () => {}, openPath: () => {} },
    clipboard: { writeText: () => {} },
    dialog: { showMessageBox: async () => ({ response: 1 }), showErrorBox: () => {} },
    screen: {
      getCursorScreenPoint: () => ({ ...fake.cursor }),
      getDisplayMatching: () => fake.display,
      getDisplayNearestPoint: () => fake.display,
    },
  };
  fake.dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  fake.app.relaunch = () => {};
  fake.app.setAppUserModelId = () => {}; // Windows 下 src/main/index.js:20 会调用
  return fake;
}

/** 用假 electron（以及可替换的 ./mcp、./bridge、记录 TrayPopover 实例）加载真实 index.js */
async function bootApp({ mcpMock, trayBounds, cursor, display }) {
  const fake = makeFakeElectron({ trayBounds, cursor, display });
  const origLoad = Module._load;
  const indexFile = SRC('main/index.js');
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return fake;
    if (parent && parent.filename === indexFile) {
      if (request === './mcp') return mcpMock;
      if (request === './bridge') return { startBridge: async () => ({ url: 'ws://127.0.0.1:0/browser/v1', status: () => ({ connected: 0, paired: 0 }), close: async () => {}, newPairCode: () => null, revokeAll: () => {} }) };
      if (request === './tray-window') {
        const tw = origLoad.apply(this, arguments);
        class TrackedPopover extends tw.TrayPopover {
          constructor(o) { super(o); fake.popover = this; }
        }
        return { ...tw, TrayPopover: TrackedPopover };
      }
    }
    return origLoad.apply(this, arguments);
  };
  // index.js 在窗口加载完后才懒加载 ./mcp、./bridge，所以钩子保持到 shutdown 再还原
  let hookRestored = false;
  const restoreHook = () => { if (!hookRestored) { hookRestored = true; if (Module._load !== origLoad) Module._load = origLoad; } };
  try {
    delete require.cache[indexFile];
    require(indexFile);
  } catch (e) { restoreHook(); throw e; }
  fake.readyResolve();
  for (let i = 0; i < 200 && !fake.handlers.has('trayState'); i++) await sleep(10);
  if (!fake.handlers.has('trayState')) throw new Error('boot did not register IPC');
  await sleep(50);
  const wins = fake.BrowserWindow.all;
  fake.main = wins.find((w) => !w.opts.transparent);
  // 托盘小窗构造时不建窗口：这里直接 ensureWindow() 建出来（不显示、不启动闲置定时器），供后续断言/调用
  assert.ok(fake.popover, 'index.js 应创建 TrayPopover');
  assert.equal(fake.popover.alive, false, '启动时托盘小窗不建窗口（首次点托盘才创建）');
  fake.popover.ensureWindow();
  fake.pop = fake.popover.win;
  assert.ok(fake.pop, '托盘小窗应已按需创建');
  fake.tray = fake.Tray.last;
  const ev = (sender) => ({ senderFrame: { url: 'file:///app/index.html' }, sender: sender.webContents });
  fake.invoke = (ch, from, ...args) => fake.handlers.get(ch)(ev(from), ...args);
  // 启动顺序：窗口先出来，MCP/插件桥在主窗口 did-finish-load 之后才并行启动（期间状态为「启动中」，不算异常）
  const snap = () => JSON.parse(JSON.stringify({ state: fake.invoke('state', fake.main), tray: fake.invoke('trayState', fake.main) }));
  fake.beforeLoad = snap();
  fake.main.webContents.emit('did-finish-load');
  for (let i = 0; i < 300 && (fake.invoke('state', fake.main).services.mcp.starting || fake.invoke('state', fake.main).services.bridge.starting); i++) await sleep(10);
  fake.afterLoad = snap();
  /** 左键托盘并等 show 握手完成（show 是异步的） */
  fake.click = async () => { fake.tray.emit('click'); await sleep(2); };
  fake.shutdown = async () => { for (const l of fake.app.listeners('before-quit')) await l({ preventDefault() {} }); restoreHook(); };
  return fake;
}

/** 在 vm 里用最小假 DOM 跑真实 src/renderer/tray.js，返回元素与 mem0 调用记录 */
function runTrayRenderer() {
  const vm = require('node:vm');
  class Node {}
  class El extends Node {
    constructor(tag, id) {
      super(); this.tag = tag; this.id = id; this.attrs = {}; this.children = []; this.listeners = {}; this.textContent = ''; this.disabled = false; this._cls = new Set();
      const self = this;
      this.classList = {
        add: (...c) => c.forEach((x) => self._cls.add(x)), remove: (...c) => c.forEach((x) => self._cls.delete(x)),
        contains: (c) => self._cls.has(c), toggle: (c, f) => { const on = f === undefined ? !self._cls.has(c) : !!f; if (on) self._cls.add(c); else self._cls.delete(c); return on; },
      };
    }
    set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
    get className() { return [...this._cls].join(' '); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    dispatch(t, e = {}) { for (const fn of this.listeners[t] || []) fn(e); }
    click() { if (!this.disabled) this.dispatch('click', { target: this }); }
    focus() { doc.activeElement = this; }
    append(...k) { this.children.push(...k); }
    replaceChildren(...k) { this.children = k; }
    getBoundingClientRect() { return { height: 411.4, width: 320 }; }
  }
  const els = new Map();
  const el = (id) => { if (!els.has(id)) els.set(id, new El('div', id)); return els.get(id); };
  const doc = new El('document');
  doc.querySelector = (sel) => (sel.startsWith('#') ? el(sel.slice(1)) : null);
  doc.createElement = (t) => new El(t);
  doc.createTextNode = (t) => { const n = new Node(); n.textContent = t; return n; };
  const calls = { quit: 0, hide: 0, ready: [], openMain: 0 };
  const cb = {};
  const mem0 = {
    tray: {
      state: async () => null, rescan: async () => null, resize: async () => true,
      hide: () => { calls.hide++; }, openMain: () => { calls.openMain++; }, openConversation: () => {},
      quit: () => { calls.quit++; return new Promise(() => {}); },
      onState: (fn) => { cb.state = fn; }, ready: (t, h) => { calls.ready.push([t, h]); },
      onPrepare: (fn) => { cb.prepare = fn; }, onReset: (fn) => { cb.reset = fn; },
    },
  };
  const ctx = {
    document: doc, mem0, Node, Intl, Date, Promise, setTimeout, clearTimeout, console, MEM0_SOURCES: {},
    icon: () => new El('svg'), sourceLogo: () => new El('img'),
    ResizeObserver: class { observe() {} },
    requestAnimationFrame: (f) => setTimeout(f, 5),
    addEventListener: () => {},
  };
  ctx.window = ctx;
  vm.runInNewContext(read('src/renderer/tray.js'), ctx, { filename: 'tray.js' });
  const key = (k) => doc.dispatch('keydown', { key: k });
  return { el, calls, cb, ctx, key };
}

/** 在 vm 里用最小假 DOM 跑真实 src/renderer/app.js，返回元素、调用记录与求值器 */
function runAppRenderer() {
  const vm = require('node:vm');
  class Node {}
  class El extends Node {
    constructor(tag) {
      super(); this.tag = tag || 'div'; this.id = ''; this.attrs = {}; this.children = []; this.listeners = {}; this.style = {}; this.dataset = {};
      this.textContent = ''; this.scrollTop = 0; this.disabled = false; this.title = ''; this._cls = new Set();
      const self = this;
      this.classList = {
        add: (...c) => c.forEach((x) => self._cls.add(x)), remove: (...c) => c.forEach((x) => self._cls.delete(x)),
        contains: (c) => self._cls.has(c), toggle: (c, f) => { const on = f === undefined ? !self._cls.has(c) : !!f; if (on) self._cls.add(c); else self._cls.delete(c); return on; },
      };
    }
    set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
    get className() { return [...this._cls].join(' '); }
    get firstChild() { return this.children[0]; }
    get lastChild() { return this.children[this.children.length - 1]; }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); if (k === 'disabled') this.disabled = true; if (k === 'checked') this.checked = true; }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    removeAttribute(k) { delete this.attrs[k]; if (k === 'disabled') this.disabled = false; if (k === 'checked') this.checked = false; }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    removeEventListener(t, fn) { const a = this.listeners[t] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
    dispatch(t, e = {}) { return Promise.all((this.listeners[t] || []).map((fn) => fn(e))); }
    click() { return this.dispatch('click', { target: this, stopPropagation() {} }); }
    append(...k) {
      // 与浏览器原生语义一致：null / undefined / false 不再被吞掉，而是变成文本节点 "null"/"undefined"/"false"，
      // 这样全文本节点扫描才能抓到任何绕过 fill() 的裸值。
      for (const x of k.flat()) {
        if (x instanceof El) {
          if (x.tag === '#fragment') { for (const c of x.children) { c.parent = this; this.children.push(c); } } else { x.parent = this; this.children.push(x); }
        } else this.children.push(doc.createTextNode(String(x)));
      }
    }
    insertBefore(n, ref) { n.parent = this; const i = this.children.indexOf(ref); if (i < 0) this.children.push(n); else this.children.splice(i, 0, n); }
    replaceChildren(...k) { this.children = []; this.append(...k); }
    remove() { const p = this.parent; if (p) { const i = p.children.indexOf(this); if (i >= 0) p.children.splice(i, 1); } }
    focus() {}
    matches() { return false; }
    closest() { return null; }
    contains() { return false; }
    scrollIntoView() {}
    getBoundingClientRect() { return { top: 0, bottom: 600, height: 600, left: 0, right: 680, width: 680 }; }
    get clientHeight() { return 600; }
    get clientWidth() { return 680; }
    get scrollHeight() {
      let n = 0;
      const walk = (e) => { n += 1; for (const c of e.children) if (c instanceof El) walk(c); };
      walk(this);
      return 400 + n * 60;
    }
  }
  const doc = new El('document');
  doc.documentElement = new El('html');
  doc.body = new El('body');
  const ids = new Map();
  const el = (id) => { if (!ids.has(id)) { const e = new El('div'); e.id = id; ids.set(id, e); doc.body.append(e); } return ids.get(id); };
  doc.querySelector = (sel) => (sel.startsWith('#') ? el(sel.slice(1)) : null);
  doc.querySelectorAll = () => [];
  doc.createElement = (t) => new El(t);
  doc.createTextNode = (t) => { const n = new El('#text'); n.textContent = String(t); return n; };
  doc.createDocumentFragment = () => new El('#fragment');
  doc.addEventListener = () => {};

  const calls = { read: [], copy: [], remove: [], reportNav: [], cancelled: [] };
  let stateImpl = () => new Promise(() => {}); // 默认不 resolve：模块加载时的 renderAll 不跑
  const mem0 = {
    state: () => stateImpl(), list: async () => [], search: async () => [], read: async () => null,
    remove: async (id) => { calls.remove.push(id); return true; }, copy: async (t) => { calls.copy.push(t); return true; },
    setSource: async () => stateImpl(), rescan: async () => stateImpl(), connectClient: async () => stateImpl(),
    disconnectClient: async () => stateImpl(), pairCode: async () => null, revokeExtensions: async () => stateImpl(),
    setTheme: () => {}, openDataDir: () => {}, changeDataDir: async () => null, openUrl: () => {}, reportNav: (n) => calls.reportNav.push(n),
    onChanged: () => {}, onNavigate: () => {}, onMcpCalls: () => {},
  };
  const storage = new Map();
  const localStorage = {
    getItem: (k) => (storage.has(String(k)) ? storage.get(String(k)) : null),
    setItem: (k, v) => storage.set(String(k), String(v)),
    removeItem: (k) => storage.delete(String(k)),
  };
  const ctx = {
    document: doc, mem0, localStorage, Node, El, Intl, Date, Promise, setTimeout, clearTimeout, console, CSS: { escape: (s) => s },
    icon: () => new El('svg'), sourceLogo: () => new El('img'), brandMark: () => new El('img'),
    MEM0_SOURCES: {}, innerHeight: 900,
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    addEventListener: () => {}, removeEventListener: () => {},
    mem0Theme: { get: () => 'light', set: () => {}, toggle: () => {} },
  };
  let rafId = 0;
  const rafs = new Map();
  ctx.requestAnimationFrame = (fn) => { const id = ++rafId; rafs.set(id, fn); return id; };
  ctx.cancelAnimationFrame = (id) => { calls.cancelled.push(id); rafs.delete(id); };
  ctx.window = ctx;
  vm.runInNewContext(read('src/renderer/app.js'), ctx, { filename: 'app.js' });
  // v4：同一上下文里先 app.js 后 memory.js，扩展通过 window.mem0Ext 挂载
  vm.runInContext(read('src/renderer/memory.js'), ctx, { filename: 'memory.js' });
  const ev = (code) => vm.runInContext(code, ctx);
  const setState = (s) => { stateImpl = async () => s; };
  const text = (n) => (n.tag === '#text' ? n.textContent : n.children.map(text).join(''));
  const all = (n, out = []) => { out.push(n); for (const c of n.children) if (c instanceof El) all(c, out); return out; };
  const byClass = (root, cls) => all(root).filter((n) => n._cls && n._cls.has(cls));
  const plain = (x) => JSON.parse(JSON.stringify(x)); // vm 里创建的对象原型不同，比较前转成普通对象
  return { el, calls, ctx, ev, setState, text, all, byClass, plain };
}


const WA = { x: 0, y: 0, width: 1920, height: 1040 }; // 1920×1080，任务栏在下 40px
const DISPLAY = { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: WA };
const W = PANEL_WIDTH + INSET * 2;

(async () => {
  // ======================================================================
  section('1 定位 computePosition');
  await test('Windows 任务栏在下：贴着工作区底边、水平居中于托盘图标', () => {
    const b = computePosition({ trayBounds: { x: 1700, y: 1048, width: 24, height: 24 }, workArea: WA, width: W, height: 400 });
    assert.equal(b.edge, 'bottom');
    assert.equal(b.y + b.height, WA.y + WA.height);
    assert.equal(b.x, Math.round(1712 - W / 2));
  });
  await test('macOS 菜单栏在上：贴着工作区顶边', () => {
    const b = computePosition({ trayBounds: { x: 1500, y: 0, width: 22, height: 24 }, workArea: { x: 0, y: 25, width: 1920, height: 1055 }, width: W, height: 400 });
    assert.equal(b.edge, 'top'); assert.equal(b.y, 25);
  });
  await test('任务栏在左 / 在右：贴边并垂直居中于图标', () => {
    const wa = { x: 60, y: 0, width: 1860, height: 1080 };
    const l = computePosition({ trayBounds: { x: 18, y: 900, width: 24, height: 24 }, workArea: wa, width: W, height: 300 });
    assert.equal(l.edge, 'left'); assert.equal(l.x, 60); assert.equal(l.y, Math.round(912 - 150));
    const wr = { x: 0, y: 0, width: 1860, height: 1080 };
    const r = computePosition({ trayBounds: { x: 1878, y: 900, width: 24, height: 24 }, workArea: wr, width: W, height: 300 });
    assert.equal(r.edge, 'right'); assert.equal(r.x + r.width, 1860);
  });
  await test('托盘靠近屏幕右缘：窗口被夹回工作区，不越界', () => {
    const b = computePosition({ trayBounds: { x: 1905, y: 1048, width: 14, height: 24 }, workArea: WA, width: W, height: 400 });
    assert.equal(b.x + b.width, WA.x + WA.width);
    assert.ok(b.x >= WA.x && b.y >= WA.y);
  });
  await test('tray.getBounds() 宽高为 0：退回鼠标位置；下半屏放在鼠标上方', () => {
    const b = computePosition({ trayBounds: { x: 0, y: 0, width: 0, height: 0 }, cursor: { x: 800, y: 1000 }, workArea: WA, width: W, height: 400 });
    assert.equal(b.edge, 'inside'); assert.equal(b.y, 600); assert.equal(b.x, Math.round(800 - W / 2));
    const t = computePosition({ trayBounds: null, cursor: { x: 800, y: 10 }, workArea: WA, width: W, height: 400 });
    assert.equal(t.y, 10);
  });
  await test('内容比工作区还高：高度截到工作区高度，位置在工作区内', () => {
    const b = computePosition({ trayBounds: { x: 1700, y: 1048, width: 24, height: 24 }, workArea: WA, width: W, height: 5000 });
    assert.equal(b.height, WA.height); assert.equal(b.y, 0);
  });
  await test('副屏（负坐标）也按所在屏的 workArea 夹紧', () => {
    const wa = { x: -1280, y: 0, width: 1280, height: 984 };
    const b = computePosition({ trayBounds: { x: -30, y: 990, width: 24, height: 24 }, workArea: wa, width: W, height: 300 });
    assert.ok(b.x >= wa.x && b.x + b.width <= wa.x + wa.width); assert.equal(b.y + b.height, 984);
  });

  section('2 blur → click 竞态 / 窗口参数');
  await test('shouldIgnoreClick：300ms 内忽略，之后不忽略，未 blur 过不忽略', () => {
    assert.equal(BLUR_CLICK_GUARD_MS, 300);
    assert.equal(shouldIgnoreClick(1000, 1000), true);
    assert.equal(shouldIgnoreClick(1000, 1299), true);
    assert.equal(shouldIgnoreClick(1000, 1300), false);
    assert.equal(shouldIgnoreClick(0, 1000), false);
    assert.equal(shouldIgnoreClick(2000, 1000), false); // 时钟回拨不误伤
  });
  await test('popoverOptions：无边框透明、无系统阴影、不可缩放/最小化/最大化/全屏、不进任务栏、置顶', () => {
    const o = popoverOptions({ preload: '/p.js', platform: 'darwin' });
    for (const [k, v] of Object.entries({ frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false, resizable: false, minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, show: false })) assert.equal(o[k], v, k);
    assert.equal(o.width, 320 + 2 * INSET);
    assert.equal('thickFrame' in o, false);
    assert.deepEqual(o.webPreferences, { preload: '/p.js', contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, backgroundThrottling: false });
  });
  await test('popoverOptions：关闭拼写检查（spellcheck:false，省内存）', () => {
    assert.equal(popoverOptions({ preload: '/p.js' }).webPreferences.spellcheck, false);
  });
  await test('shouldDestroyIdle：收起后满 60 秒才该销毁；没收起过 / 时钟回拨 / 提前都不销毁', () => {
    assert.equal(IDLE_DESTROY_MS, 60_000);
    const t0 = 1_700_000_000_000;
    assert.equal(shouldDestroyIdle(t0, t0 + IDLE_DESTROY_MS - 1), false);
    assert.equal(shouldDestroyIdle(t0, t0 + IDLE_DESTROY_MS), true);
    assert.equal(shouldDestroyIdle(t0, t0 + 10 * IDLE_DESTROY_MS), true);
    assert.equal(shouldDestroyIdle(0, t0), false);            // 没收起过
    assert.equal(shouldDestroyIdle(t0, t0 - 1), false);        // 时钟回拨
    assert.equal(shouldDestroyIdle(NaN, t0), false);
    assert.equal(shouldDestroyIdle(t0, t0 + 500, 300), true);  // 可用自定义阈值（单测/调试）
  });
  await test('Windows 平台 thickFrame:false', () => {
    assert.equal(popoverOptions({ preload: '/p.js', platform: 'win32' }).thickFrame, false);
  });

  // ======================================================================
  section('2b 托盘小窗闲置销毁 / 重建（TrayPopover，常驻内存）');
  const newPop = (opts = {}) => {
    const f = makeFakeElectron({ trayBounds: { x: 1700, y: 1048, width: 24, height: 24 }, cursor: { x: 1, y: 1 }, display: DISPLAY });
    const pop = new TrayPopover({ electron: f, tray: new f.Tray(null), preload: '/p.js', htmlPath: '/tray.html', ...opts });
    return { f, pop };
  };
  await test('构造时不建窗口；首次 show 才按需创建（IPC 监听只注册一次）', async () => {
    const { f, pop } = newPop();
    assert.equal(pop.alive, false, '构造后还没有窗口');
    assert.equal(pop.win, null);
    assert.equal(f.BrowserWindow.all.length, 0, '没有创建 BrowserWindow');
    assert.equal((f.ipcListeners.get('tray-ready') || []).length, 1, 'tray-ready 监听注册了一次');
    assert.equal(await pop.show(), true);
    assert.equal(pop.alive, true);
    assert.equal(f.BrowserWindow.all.length, 1, 'show 时创建了一个窗口');
    pop.hide();
    await pop.show();
    assert.equal(f.BrowserWindow.all.length, 1, '同一窗口复用，不重复创建');
    assert.equal((f.ipcListeners.get('tray-ready') || []).length, 1, '监听仍然只有一次');
    pop.destroy();
    assert.equal((f.ipcListeners.get('tray-ready') || []).length, 0, 'destroy() 移除监听');
  });
  await test('窗口不存在时 isVisible/hide/destroy/send/setPanelHeight 都安全，不抛错', () => {
    const { pop } = newPop();
    assert.equal(pop.isVisible(), false);
    assert.doesNotThrow(() => pop.hide());
    assert.equal(pop.isVisible(), false);
    assert.doesNotThrow(() => pop.reposition());
    assert.doesNotThrow(() => pop.send('tray-state', {}));
    assert.doesNotThrow(() => pop.setPanelHeight(300));
    assert.equal(pop.panelHeight, 300, '面板高度仍记在对象上，供下次创建使用');
    assert.doesNotThrow(() => pop.closeWindow());
    assert.doesNotThrow(() => pop.destroy());
    assert.doesNotThrow(() => pop.destroy(), '重复 destroy 也安全');
    assert.equal(pop.win, null);
    assert.equal(pop.isVisible(), false);
  });
  await test('收起后启动闲置定时器；再次显示清掉定时器并重置计时', async () => {
    const { pop } = newPop();
    assert.equal(await pop.show(), true);
    assert.equal(pop.isVisible(), true);
    assert.equal(pop.idleTimer, null, '显示时没有闲置定时器');
    pop.hide();
    assert.equal(pop.isVisible(), false);
    assert.ok(pop.idleTimer, '收起后启动定时器');
    assert.ok(pop.hiddenAt > 0);
    assert.equal(await pop.show(), true);
    assert.equal(pop.idleTimer, null, '再次显示清掉定时器');
    assert.equal(pop.hiddenAt, 0);
    pop.destroy();
    assert.equal(pop.alive, false);
  });
  await test('闲置到点销毁小窗；下次显示重新创建并沿用记住的面板高度', async () => {
    const { pop } = newPop({ idleMs: 20 });
    assert.equal(await pop.show(), true);
    pop.setPanelHeight(333);
    pop.hide();
    const first = pop.win;
    assert.equal(first.isDestroyed(), false);
    await sleep(60);
    assert.equal(pop.alive, false, '闲置到点已销毁');
    assert.equal(pop.win, null);
    assert.equal(first.isDestroyed(), true);
    assert.equal(pop.panelHeight, 333, '面板高度记在常驻对象上');
    assert.equal(await pop.show(), true);
    assert.ok(pop.win && pop.win !== first && !pop.win.isDestroyed(), '重新创建了窗口');
    assert.equal(pop.win.bounds.height, 333 + 2 * INSET, '按记住的高度定位');
    pop.destroy();
  });
  await test('闲置销毁后 toggle 重新创建；destroy() 之后（退出）不再重建', async () => {
    const { pop } = newPop({ idleMs: 20 });
    await pop.show();
    pop.hide();
    await waitFor(() => pop.win === null);
    assert.equal(pop.win, null);
    assert.equal(await pop.toggle(), true, 'toggle 会重建并显示');
    assert.equal(pop.isVisible(), true);
    pop.destroy();
    assert.equal(pop.win, null);
    assert.equal(await pop.show(), false, 'destroy() 之后不再重建');
    assert.equal(await pop.toggle(), false);
  });
  await test('Windows 防闪：新建 / 重建的窗口都先 opacity 0，画完（或 80ms 兜底）再设 1', async () => {
    const { pop } = newPop({ platform: 'win32', idleMs: 20 });
    assert.equal(await pop.show(), true);
    const first = pop.win;
    assert.equal(first.opacity, 0, '显示瞬间先不透明');
    await sleep(REVEAL_TIMEOUT_MS + 30);
    assert.deepEqual(first.opacityLog, [0, 1], 'renderer 画完后亮出来');
    pop.hide();
    await waitFor(() => pop.win === null);
    assert.equal(pop.win, null, '闲置销毁');
    assert.equal(await pop.show(), true);
    const second = pop.win;
    assert.notEqual(second, first);
    assert.equal(second.opacity, 0, '重建的窗口同样先透明');
    await sleep(REVEAL_TIMEOUT_MS + 30);
    assert.deepEqual(second.opacityLog, [0, 1]);
    pop.destroy();
  });
  await test('闲置定时器提前 1ms 触发：未到点会重排定时器，随后仍销毁（回归「永不销毁」）', async () => {
    const { pop } = newPop({ idleMs: 40 });
    assert.equal(await pop.show(), true);
    pop.hide();
    const first = pop.win;
    const hiddenAt = pop.hiddenAt;
    const realNow = Date.now;
    let signalFirstCheck;
    const firstCheckDone = new Promise((r) => { signalFirstCheck = r; });
    let dateCalls = 0;
    let earlyAt = 0;
    const keepAlive = setInterval(() => {}, 5); // 闲置定时器是 unref 的，等它时必须另保事件循环
    try {
      // 模拟 setTimeout 比到点时刻早约 1ms 触发：第一次闲置检查看到 idleMs-1（未到点）。
      // 修复前回调会直接 return 且不再重排，窗口永远不销毁 → 这里会 waitFor 超时失败。
      Date.now = () => {
        dateCalls += 1;
        if (dateCalls === 1) { earlyAt = realNow(); signalFirstCheck(); return hiddenAt + pop.idleMs - 1; }
        return realNow();
      };
      await firstCheckDone;   // 等定时器第一次「到点检查」发生
    } finally {
      Date.now = realNow;     // 恢复正常时钟（waitFor 的超时判断也依赖它）
      clearInterval(keepAlive);
    }
    assert.equal(dateCalls, 1, '第一次到点检查由闲置定时器触发');
    assert.ok(earlyAt - hiddenAt >= pop.idleMs - 2, '这次检查确实发生在接近到点时刻（模拟提前触发）');
    await waitFor(() => pop.win === null);
    assert.equal(pop.win, null, '未到点重排后仍会销毁');
    assert.equal(first.isDestroyed(), true);
    assert.equal(pop.alive, false);
    pop.destroy();
  });
  await test('blur 收起 → 紧接着 toggle：仍按守卫忽略（重建不改竞态逻辑）', async () => {
    const { pop } = newPop({ idleMs: 20 });
    await pop.show();
    pop.win.emit('blur'); // 模拟点托盘导致失焦收起
    assert.equal(pop.isVisible(), false);
    assert.equal(await pop.toggle(), false, '守卫窗口内的 toggle 不打开');
    assert.equal(pop.isVisible(), false);
    pop.destroy();
  });

  // ======================================================================
  section('3 TrayStats（只读统计 + 增量小表）');
  const sdir = fs.mkdtempSync(path.join(T, 'stats-'));
  const store = Store.open(sdir);
  let clock = new Date(2026, 10, 11, 15, 0, 0).getTime();
  const stats = new TrayStats(store, { now: () => clock });
  const mk = (ext, n, at, source = 'claude-code') => store.upsertConversation({
    source, ingestMethod: source.endsWith('-web') ? 'browser-extension' : 'local', externalId: ext, title: `会话 ${ext}`,
    messages: Array.from({ length: n }, (_, k) => ({ role: k % 2 ? 'assistant' : 'user', content: `m${ext}-${k}`, createdAt: at + k })),
  });
  const yesterday = clock - 30 * 3600_000;
  const c1 = mk('a', 3, yesterday);
  const c2 = mk('b', 4, clock - 3600_000);
  const c3 = mk('c', 2, clock - 1800_000, 'kimi-web');
  mk('d', 2, clock - 600_000); mk('e', 2, clock - 300_000);
  await test('独立小表 ui_ingest_log 已创建（不改 db.js 的表）', () => {
    const t = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(TABLE);
    assert.ok(t);
    assert.equal(stats.persist, true);
  });
  await test('todayMessages = 今天产生的消息数（昨天的不计）', () => {
    assert.equal(stats.todayMessages(), 4 + 2 + 2 + 2);
  });
  await test('recent 最多 4 条，按更新时间倒序', () => {
    const r = stats.recent(4);
    assert.equal(r.length, 4);
    assert.deepEqual(r.map((x) => x.title), ['会话 e', '会话 d', '会话 c', '会话 b']);
    assert.equal(r[2].source, 'kimi-web');
  });
  await test('recordIngest：同一天累加 → addedToday；没记录的为 0（显示「共 X 条」）', () => {
    stats.recordIngest({ conversationId: c2.id, source: 'claude-code', added: 3 });
    stats.recordIngest({ conversationId: c2.id, source: 'claude-code', added: 2 });
    stats.recordIngest({ conversationId: c3.id, source: 'kimi-web', added: 0 });
    assert.equal(stats.addedToday(c2.id), 5);
    assert.equal(stats.addedToday(c3.id), 0);
    assert.equal(stats.addedToday(c1.id), 0);
    const r = stats.recent(4).find((x) => x.id === c2.id);
    assert.equal(r.addedToday, 5); assert.equal(r.messageCount, 4);
  });
  await test('跨天：昨天的增量今天不再显示，今天重新从 0 累加', () => {
    stats.recordIngest({ conversationId: c1.id, source: 'claude-code', added: 9 });
    clock += 24 * 3600_000;
    assert.equal(stats.addedToday(c1.id), 0);
    stats.recordIngest({ conversationId: c1.id, source: 'claude-code', added: 1 });
    assert.equal(stats.addedToday(c1.id), 1);
    assert.ok(startOfDay(clock) <= clock);
  });
  await test('会话删除后增量记录跟着删（外键级联），不报错', () => {
    store.deleteConversation(c2.id);
    const n = store.db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE} WHERE conversation_id = ?`).get(c2.id).n;
    assert.equal(n, 0);
    stats.recordIngest({ conversationId: 'not-exist', source: 'x', added: 1 }); // 外键失败 → 降级内存，不抛
  });
  await test('退路 Map：持久化成功后删除对应内存项', () => {
    const fail = { on: true };
    const wrapper = { db: { exec: () => {}, prepare: (...a) => { if (fail.on) throw new Error('readonly'); return store.db.prepare(...a); } } };
    const s = new TrayStats(wrapper, { now: () => clock });
    assert.equal(s.persist, true);
    s.recordIngest({ conversationId: c3.id, source: 'kimi-web', added: 2 }); // 写库失败 → 落到内存
    assert.equal(s.mem.has(c3.id), true);
    fail.on = false;
    s.recordIngest({ conversationId: c3.id, source: 'kimi-web', added: 1 }); // 写库成功 → 清掉内存项
    assert.equal(s.mem.has(c3.id), false);
    assert.equal(s.addedToday(c3.id), 1, '写库成功：新的一天从 0 开始累加');
  });
  await test('退路 Map：跨天删除旧日期项，今天从 0 重新计', () => {
    const s = new TrayStats({ db: { exec: () => { throw new Error('readonly'); } } }, { now: () => clock });
    assert.equal(s.persist, false);
    s.recordIngest({ conversationId: 'old', source: 'x', added: 5 });
    assert.equal(s.addedToday('old'), 5);
    clock += 24 * 3600_000;
    s.recordIngest({ conversationId: 'new', source: 'x', added: 1 });
    assert.equal(s.mem.has('old'), false, '跨天的旧项已删');
    assert.equal(s.mem.size, 1);
    assert.equal(s.addedToday('old'), 0);
  });
  await test('退路 Map：上限 1000 项，超出删最旧', () => {
    const s = new TrayStats({ db: { exec: () => { throw new Error('readonly'); } } }, { now: () => clock });
    for (let i = 0; i < 1005; i++) {
      clock += 1000;
      s.recordIngest({ conversationId: `c${i}`, source: 'x', added: 1 });
    }
    assert.equal(s.mem.size, 1000);
    assert.equal(s.mem.has('c0'), false, '最旧的被删');
    assert.equal(s.mem.has('c4'), false);
    assert.equal(s.mem.has('c5'), true);
    assert.equal(s.mem.has('c1004'), true);
  });

  await test('今日互通：store.getMcpCallsToday 存在时取真实值；不存在 / 抛错时计 0', () => {
    const fakeStore = { db: store.db };
    assert.equal(new TrayStats(fakeStore).mcpCallsToday(), 0);
    fakeStore.getMcpCallsToday = () => 7;
    assert.equal(new TrayStats(fakeStore).mcpCallsToday(), 7);
    fakeStore.getMcpCallsToday = () => { throw new Error('boom'); };
    assert.equal(new TrayStats(fakeStore).mcpCallsToday(), 0);
    if (typeof store.getMcpCallsToday === 'function') assert.equal(typeof stats.mcpCallsToday(), 'number');
  });
  await test('snapshot 结构', () => {
    const s = stats.snapshot();
    assert.deepEqual(Object.keys(s).sort(), ['mcpCallsToday', 'recent', 'todayMessages']);
  });
  store.close();

  // ======================================================================
  section('4 主进程集成（假 Electron + 真实 index.js）');
  const mcpEvents = new EventEmitter();
  const mcpMock = { mcpEvents, startMcpServer: async () => ({ url: 'http://127.0.0.1:3790/mcp?token=uitest-token', close: async () => {} }) };
  const app = await bootApp({ mcpMock, trayBounds: { x: 1700, y: 1048, width: 24, height: 24 }, cursor: { x: 1, y: 1 }, display: DISPLAY });
  await test('创建主窗口 + 托盘小窗（加载 tray.html，安全配置与主窗口一致）', () => {
    assert.ok(app.main && app.pop);
    assert.ok(app.pop.file.endsWith(path.join('renderer', 'tray.html')));
    const { backgroundThrottling, ...popPrefs } = app.pop.opts.webPreferences;
    assert.equal(backgroundThrottling, false);
    assert.deepEqual(popPrefs, app.main.opts.webPreferences);
    assert.equal(app.pop.opts.frame, false); assert.equal(app.pop.opts.transparent, true);
    assert.equal(app.pop.opts.backgroundColor, '#00000000'); assert.equal(app.pop.opts.hasShadow, false);
  });
  await test('启动：窗口加载完之前服务为「启动中」且不计异常；加载完后 MCP/插件桥并行起来', () => {
    const pre = app.beforeLoad.state.services;
    assert.equal(pre.mcp.starting, true); assert.equal(pre.bridge.starting, true);
    assert.equal(pre.mcp.ok, false); assert.equal(pre.mcp.error, null);
    assert.equal(app.beforeLoad.tray.errors, 0);
    const post = app.afterLoad.state.services;
    assert.equal(post.mcp.starting, false); assert.equal(post.bridge.starting, false);
    assert.equal(post.mcp.ok, true); assert.equal(post.bridge.ok, true);
    assert.equal(app.afterLoad.tray.errors, 0);
  });
  await test('左键托盘：只弹出小窗并聚焦，不显示主窗口；位置在工作区内贴底', async () => {
    await app.click();
    assert.equal(app.pop.isVisible(), true); assert.equal(app.pop.focused, true);
    assert.equal(app.main.isVisible(), false);
    const b = app.pop.bounds;
    assert.ok(b.x >= 0 && b.x + b.width <= 1920 && b.y >= 0);
    assert.equal(b.y + b.height, 1040);
  });
  await test('小窗打开时收到 tray-state（含今日统计与最近活动）', () => {
    const st = app.pop.webContents.sent.filter(([c]) => c === 'tray-state').pop();
    assert.ok(st); assert.ok(Array.isArray(st[1].recent)); assert.equal(typeof st[1].mcpCallsToday, 'number');
  });
  await test('再次左键托盘（已展开）：收起', async () => {
    await app.click();
    assert.equal(app.pop.isVisible(), false);
  });
  await test('Windows 竞态：展开 → blur（收起）→ 紧接着 click：保持收起，不闪一下重开', async () => {
    await app.click(); assert.equal(app.pop.isVisible(), true);
    app.pop.emit('blur'); assert.equal(app.pop.isVisible(), false);
    await app.click(); assert.equal(app.pop.isVisible(), false);
  });
  await test('点击外部失焦后超过 300ms 再点托盘：正常弹出', async () => {
    await sleep(BLUR_CLICK_GUARD_MS + 20);
    await app.click(); assert.equal(app.pop.isVisible(), true);
  });
  await test('blur 守卫只吃掉一次：竞态 click 之后的下一次 click 正常打开', async () => {
    app.pop.emit('blur'); await app.click(); assert.equal(app.pop.isVisible(), false);
    await app.click(); assert.equal(app.pop.isVisible(), true);
  });
  await test('Esc（主进程 before-input-event）收起小窗', () => {
    let prevented = false;
    app.pop.webContents.emit('before-input-event', { preventDefault: () => { prevented = true; } }, { type: 'keyDown', key: 'Escape' });
    assert.equal(app.pop.isVisible(), false); assert.equal(prevented, true);
  });
  await test('trayHide IPC（renderer 侧 Esc）收起；非小窗来源调用被拒绝', async () => {
    await app.click();
    await app.invoke('trayHide', app.pop);
    assert.equal(app.pop.isVisible(), false);
    assert.throws(() => app.invoke('trayHide', app.main), /forbidden/);
    assert.throws(() => app.handlers.get('trayState')({ senderFrame: { url: 'https://evil.example/' }, sender: app.pop.webContents }), /forbidden/);
  });
  await test('右键托盘：弹出原生菜单「打开 mem0 / 退出」，并收起小窗', async () => {
    await app.click();
    app.tray.emit('right-click');
    assert.equal(app.pop.isVisible(), false);
    const m = app.log.popUp.pop();
    assert.deepEqual(m.items.map((x) => x.label || x.type), ['打开 mem0', 'separator', '退出']);
  });
  await test('trayResize：窗口高度 = 面板高度 + 2×INSET；展开时重新贴底定位', async () => {
    await app.invoke('trayResize', app.pop, 287.4);
    assert.equal(app.pop.bounds.height, 288 + 2 * INSET);
    await app.click();
    await app.invoke('trayResize', app.pop, 350);
    assert.equal(app.pop.bounds.height, 350 + 2 * INSET);
    assert.equal(app.pop.bounds.y + app.pop.bounds.height, 1040);
    assert.throws(() => app.invoke('trayResize', app.main, 100), /forbidden/);
    await app.invoke('trayHide', app.pop);
  });
  await test('托盘 getBounds 宽高为 0：用鼠标位置定位，仍在工作区内', async () => {
    app.trayBounds = { x: 0, y: 0, width: 0, height: 0 }; app.cursor = { x: 1900, y: 1030 };
    await app.click();
    const b = app.pop.bounds;
    assert.ok(b.x + b.width <= 1920 && b.y >= 0 && b.y + b.height <= 1040);
    app.trayBounds = { x: 1700, y: 1048, width: 24, height: 24 };
    app.pop.hide();
  });
  await test('trayState / trayRescan IPC 返回统计结构', async () => {
    const s = await app.invoke('trayState', app.pop);
    for (const k of ['todayMessages', 'mcpCallsToday', 'recent', 'errors', 'lastSyncAt', 'scanning']) assert.ok(k in s, k);
    assert.ok(s.recent.length <= 4);
    const r = await app.invoke('trayRescan', app.pop);
    assert.ok(Array.isArray(r.recent));
  });
  await test('「打开 mem0 ↗」：收起小窗，显示并聚焦主窗口', async () => {
    await app.click();
    await app.invoke('trayOpenMain', app.pop);
    assert.equal(app.pop.isVisible(), false);
    assert.equal(app.main.isVisible(), true); assert.equal(app.main.focused, true);
  });
  await test('点某条活动：收起 → 打开主窗口 → 发 navigate 到「记录」页对应会话', async () => {
    app.main.hide(); await app.click();
    app.main.webContents.sent.length = 0;
    await app.invoke('trayOpenConversation', app.pop, 'conv123');
    assert.equal(app.pop.isVisible(), false); assert.equal(app.main.isVisible(), true);
    assert.deepEqual(app.main.webContents.sent.find(([c]) => c === 'navigate'), ['navigate', { view: 'records', conversationId: 'conv123' }]);
  });
  await test('主窗口加载中不直接发 navigate：加载完成（did-finish-load）后按记住的页面补发', async () => {
    app.main.tryClose();                       // 关掉旧窗口（真销毁）
    app.app.emit('second-instance');           // 唤起 → 重建
    const m = app.BrowserWindow.all.filter((w) => !w.opts.transparent).pop();
    app.main = m;
    m.webContents.loading = true;              // 模拟新窗口还在加载
    await app.invoke('trayOpenConversation', app.pop, 'conv456');
    assert.equal(m.webContents.sent.length, 0, '加载中不发');
    m.webContents.loading = false; m.webContents.emit('did-finish-load');
    assert.deepEqual(m.webContents.sent.find(([c]) => c === 'navigate'), ['navigate', { view: 'records', conversationId: 'conv456' }]);
    m.emit('ready-to-show');
  });
  await test('今日互通实时：mcpEvents emit("call") → 主窗与小窗都收到 mcp-calls', () => {
    app.main.webContents.sent.length = 0; app.pop.webContents.sent.length = 0;
    mcpEvents.emit('call', { today: 7 });
    assert.deepEqual(app.main.webContents.sent.find(([c]) => c === 'mcp-calls'), ['mcp-calls', { today: 7 }]);
    assert.deepEqual(app.pop.webContents.sent.find(([c]) => c === 'mcp-calls'), ['mcp-calls', { today: 7 }]);
  });
  await test('state（主窗口）带 mcpCallsToday', async () => {
    const s = await app.invoke('state', app.main);
    assert.equal(typeof s.mcpCallsToday, 'number');
  });
  await test('空库 state 扩展 projects / memories / memoryGroups / ai：两个集合为空数组，ai 不含 apiKey', async () => {
    const s = await app.invoke('state', app.main);
    assert.ok(Array.isArray(s.projects), 'projects 为数组');
    assert.ok(Array.isArray(s.memories), 'memories 为数组');
    assert.deepEqual(s.projects, [], '空库 projects 为空数组（未混入演示数据）');
    assert.deepEqual(s.memories, [], '空库 memories 为空数组（未混入演示数据）');
    assert.equal(s.memoryGroups.length, 4, '4 个固定记忆分组');
    assert.deepEqual(s.memoryGroups.map((g) => g.id), ['个人与职业背景', '协作与沟通准则', '环境与工作流', '踩坑与经验库']);
    for (const g of s.memoryGroups) assert.equal(typeof g.icon, 'string');
    assert.ok(s.ai && typeof s.ai === 'object', 'ai 为对象');
    assert.equal(Object.prototype.hasOwnProperty.call(s.ai, 'apiKey'), false, 'ai 不含 apiKey 字段');
    assert.equal(JSON.stringify(s.ai).includes('apiKey'), false, 'ai 序列化后也不含 apiKey');
    assert.equal(typeof s.ai.hasKey, 'boolean');
    assert.equal(typeof s.ai.statusText, 'string');
  });
  await test('MCP 地址对外带 token：services.mcp.url 与手动配置用同一份完整地址', async () => {
    const s = await app.invoke('state', app.main);
    assert.equal(s.services.mcp.url, 'http://127.0.0.1:3790/mcp?token=uitest-token');
    assert.ok(s.manualConfig.includes('http://127.0.0.1:3790/mcp?token=uitest-token'), s.manualConfig);
    const cfg = JSON.parse(s.manualConfig);
    assert.equal(cfg.mcpServers.mem0.url, s.services.mcp.url);
  });
  await test('一键连接写入的也是带 token 的地址；旧地址（无 token）→ stale', async () => {
    const cj = path.join(HOME, '.claude.json');
    fs.writeFileSync(cj, JSON.stringify({ mcpServers: { mem0: { type: 'http', url: 'http://127.0.0.1:3790/mcp' } } }));
    let s = await app.invoke('state', app.main);
    assert.equal(s.clients.find((c) => c.id === 'claude-code').status, 'stale');
    s = await app.invoke('connectClient', app.main, 'claude-code');
    assert.equal(s.clients.find((c) => c.id === 'claude-code').status, 'connected');
    assert.equal(JSON.parse(fs.readFileSync(cj, 'utf8')).mcpServers.mem0.url, 'http://127.0.0.1:3790/mcp?token=uitest-token');
  });
  await test('二次启动 second-instance：唤起主窗口并收起小窗', async () => {
    app.main.hide(); await app.click();
    app.app.emit('second-instance');
    assert.equal(app.main.isVisible(), true); assert.equal(app.pop.isVisible(), false);
  });
  await test('主窗口点关闭：真正销毁（托盘常驻，后台继续备份）；小窗 close 仍只隐藏', () => {
    const m = app.main;
    assert.equal(m.tryClose(), true); assert.equal(m.isDestroyed(), true);
    assert.equal(app.pop.tryClose(), false); assert.equal(app.pop.isDestroyed(), false);
  });
  await test('主窗口销毁后推送不再发往它：统计广播只到小窗（发到销毁窗口会抛错）', () => {
    assert.equal(app.main.isDestroyed(), true);
    app.main.webContents.sent.length = 0; app.pop.webContents.sent.length = 0;
    assert.doesNotThrow(() => mcpEvents.emit('call', { today: 4 }));
    assert.equal(app.main.webContents.sent.length, 0);
    assert.deepEqual(app.pop.webContents.sent.find(([c]) => c === 'mcp-calls'), ['mcp-calls', { today: 4 }]);
  });
  await test('关掉主窗口不退出（window-all-closed 被拦）', () => {
    let prevented = false;
    app.app.emit('window-all-closed', { preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(app.log.quit, 0);
  });
  await test('再次唤起：重建窗口，show:false + 主题背景色 + spellcheck:false，ready-to-show 才显示', () => {
    const before = app.BrowserWindow.all.length;
    app.app.emit('second-instance');
    assert.equal(app.BrowserWindow.all.length, before + 1, '重建了一个窗口');
    const m = app.BrowserWindow.all.filter((w) => !w.opts.transparent).pop();
    assert.ok(m && !m.isDestroyed());
    assert.equal(m.opts.show, false);
    assert.ok(['#262624', '#FAF9F5'].includes(m.opts.backgroundColor), m.opts.backgroundColor);
    assert.equal(m.opts.webPreferences.spellcheck, false);
    assert.equal(m.isVisible(), false, 'ready-to-show 之前不显示');
    m.emit('ready-to-show');
    assert.equal(m.isVisible(), true);
    app.main = m;
  });
  await test('关闭 → 重建后恢复上次页面/会话（托盘点到哪个会话，重建后还停在哪）', async () => {
    app.main.webContents.sent.length = 0;
    await app.invoke('trayOpenConversation', app.pop, 'conv-restore');
    assert.deepEqual(app.main.webContents.sent.find(([c]) => c === 'navigate'), ['navigate', { view: 'records', conversationId: 'conv-restore' }]);
    const old = app.main;
    assert.equal(old.tryClose(), true);
    assert.equal(old.isDestroyed(), true);
    app.app.emit('second-instance');
    const m = app.BrowserWindow.all.filter((w) => !w.opts.transparent).pop();
    assert.equal(m.webContents.sent.length, 0, '加载完之前不发');
    m.webContents.emit('did-finish-load');
    assert.deepEqual(m.webContents.sent.find(([c]) => c === 'navigate'), ['navigate', { view: 'records', conversationId: 'conv-restore' }]);
    m.emit('ready-to-show');
    app.main = m;
  });
  await test("renderer 上报当前页面（'nav'）：主进程记住，重建后恢复；非 file:// 来源忽略", () => {
    const onNav = app.ipcListeners.get('nav') || [];
    assert.equal(onNav.length, 1);
    onNav[0]({ senderFrame: { url: 'file:///app/index.html' }, sender: app.main.webContents }, { view: 'settings', conversationId: 'c9' });
    onNav[0]({ senderFrame: { url: 'https://evil.example/' }, sender: app.main.webContents }, { view: 'home', conversationId: 'evil' }); // 非本应用页面：忽略
    app.main.tryClose();
    app.app.emit('second-instance');
    const m = app.BrowserWindow.all.filter((w) => !w.opts.transparent).pop();
    m.webContents.emit('did-finish-load');
    assert.deepEqual(m.webContents.sent.find(([c]) => c === 'navigate'), ['navigate', { view: 'settings', conversationId: 'c9' }]);
    m.emit('ready-to-show');
    app.main = m;
  });
  await test('显示握手：show 前依次发 tray-reset → tray-state → tray-prepare{token}，收到 tray-ready 后才 show+focus', async () => {
    app.pop.hide(); app.pop.webContents.sent.length = 0;
    app.autoReady = false;
    app.tray.emit('click');
    assert.equal(app.pop.isVisible(), false, '握手完成前不显示');
    const chs = app.pop.webContents.sent.map(([c]) => c);
    assert.deepEqual(chs.filter((c) => /^tray-(reset|state|prepare)$/.test(c)), ['tray-reset', 'tray-state', 'tray-prepare']);
    const { token } = app.pop.webContents.sent.find(([c]) => c === 'tray-prepare')[1];
    assert.ok(Number.isInteger(token));
    app.emitIpc('tray-ready', app.main.webContents, { token, height: 200 }); // 非小窗来源：忽略
    app.emitIpc('tray-ready', app.pop.webContents, { token: token + 99, height: 200 }); // 过期 token：忽略
    assert.equal(app.pop.isVisible(), false);
    app.emitIpc('tray-ready', app.pop.webContents, { token, height: 333 });
    assert.equal(app.pop.isVisible(), true); assert.equal(app.pop.focused, true);
    assert.equal(app.pop.bounds.height, 333 + 2 * INSET);
    assert.equal(app.pop.bounds.y + app.pop.bounds.height, 1040, '按回报高度贴底定位');
    app.autoReady = true;
    app.pop.webContents.sent.length = 0;
    await app.invoke('trayHide', app.pop);
    assert.ok(app.pop.webContents.sent.some(([c]) => c === 'tray-reset'), '收起时发 tray-reset');
  });
  await test(`握手超时兜底：renderer 不回 tray-ready，${READY_TIMEOUT_MS}ms 后仍按已知高度显示`, async () => {
    app.autoReady = false;
    app.tray.emit('click');
    await sleep(Math.floor(READY_TIMEOUT_MS / 3));
    assert.equal(app.pop.isVisible(), false);
    await sleep(READY_TIMEOUT_MS);
    assert.equal(app.pop.isVisible(), true);
    assert.equal(app.pop.bounds.y + app.pop.bounds.height, 1040);
    app.autoReady = true;
    await app.invoke('trayHide', app.pop);
  });
  await test('show 等待中再点托盘：取消这次显示，迟到的 tray-ready 也不再弹出', async () => {
    app.autoReady = false; app.pop.webContents.sent.length = 0;
    app.tray.emit('click');
    const { token } = app.pop.webContents.sent.find(([c]) => c === 'tray-prepare')[1];
    app.tray.emit('click');
    app.emitIpc('tray-ready', app.pop.webContents, { token, height: 300 });
    await sleep(READY_TIMEOUT_MS + 30);
    assert.equal(app.pop.isVisible(), false);
    app.autoReady = true;
    await app.click(); assert.equal(app.pop.isVisible(), true, '之后的点击正常打开');
    await app.invoke('trayHide', app.pop);
  });
  await test('⏻ 退出：app.isQuitting=true、app.quit()，之后主窗口 close 不再拦截', async () => {
    const q = app.log.quit;
    assert.throws(() => app.invoke('trayQuit', app.main), /forbidden/);
    await app.invoke('trayQuit', app.pop);
    assert.equal(app.app.isQuitting, true); assert.equal(app.log.quit, q + 1);
    assert.equal(app.pop.isDestroyed(), true);
    assert.equal(app.main.tryClose(), true);
  });

  // ======================================================================
  section('4b 会话详情分页（Store / IPC read 参数）');
  {
    // 直接写进正在运行的主进程所用的库（WAL，两个连接可见），IPC read 走真实 store
    const s = Store.open(process.env.MEM0_DATA_DIR);
    const mk = (ext, n) => s.upsertConversation({
      source: 'claude-code', ingestMethod: 'local', externalId: ext, title: `长会话 ${ext}`,
      messages: Array.from({ length: n }, (_, k) => ({ role: k % 2 ? 'assistant' : 'user', content: `m${k}`, createdAt: 1_700_000_000_000 + k })),
    });
    const long = mk('long', 450);
    mk('short', 12);
    const inv = (ch, ...args) => app.invoke(ch, app.main, ...args);
    await test('read 默认行为不变：仍返回全部消息（≤2000）', async () => {
      const c = await inv('read', long.id);
      assert.equal(c.messages.length, 450);
      assert.equal(c.messages[0].seq, 0);
      assert.equal(c.messages[449].seq, 449);
    });
    await test('read {tail:200}：只返回最后 200 条，fromSeq = message_count-200', async () => {
      const c = await inv('read', long.id, { tail: 200 });
      assert.equal(c.message_count, 450);
      assert.equal(c.messages.length, 200);
      assert.equal(c.messages[0].seq, 250);
      assert.equal(c.messages[199].seq, 449);
    });
    await test('read {tail:200}：少于 200 条的会话原样全返回', async () => {
      const id = s.db.prepare("SELECT id FROM conversations WHERE external_id='short'").get().id;
      const c = await inv('read', id, { tail: 200 });
      assert.equal(c.messages.length, 12);
      assert.equal(c.messages[0].seq, 0);
    });
    await test('read {fromSeq,limit}：按 seq 区间翻页，边界 clamp', async () => {
      const a = await inv('read', long.id, { fromSeq: 50, limit: 200 });
      assert.equal(a.messages.length, 200);
      assert.equal(a.messages[0].seq, 50);
      const b = await inv('read', long.id, { fromSeq: 250, limit: 200 });
      assert.equal(b.messages[0].seq, 250);
      const neg = await inv('read', long.id, { fromSeq: -5, limit: 3 });
      assert.equal(neg.messages[0].seq, 0);
      assert.equal(neg.messages.length, 3);
    });
    await test('read：不存在的会话仍返回 null', async () => {
      assert.equal(await inv('read', 'no-such-id'), null);
      assert.equal(await inv('read', 'no-such-id', { tail: 200 }), null);
    });
    await test('预加载 read 透传分页参数（不吞第二个参数）', () => {
      const pre = read('src/preload/index.js');
      assert.match(pre, /read: \(id, opts\) => ipcRenderer\.invoke\('read', id, opts\)/);
    });
    s.close();
  }
  await app.shutdown();

  section('5 mcp.js 未提供 mcpEvents 时的防护');
  const app2 = await bootApp({ mcpMock: { startMcpServer: async () => ({ url: 'http://127.0.0.1:3790/mcp?token=uitest-token', close: async () => {} }) }, trayBounds: { x: 0, y: 0, width: 0, height: 0 }, cursor: { x: 500, y: 500 }, display: DISPLAY });
  await test('无 mcpEvents 仍能启动；今日互通为数字（store 无计数方法时为 0）', async () => {
    const s = await app2.invoke('trayState', app2.pop);
    assert.equal(typeof s.mcpCallsToday, 'number');
    await app2.click(); assert.equal(app2.pop.isVisible(), true);
  });
  await test('设置 → 数据目录 → 更改：环境变量指定时只提示不搬', async () => {
    const r = await app2.invoke('changeDataDir', app2.main);
    assert.equal(r.ok, false); assert.equal(r.error, 'env');
  });
  await test('设置 → 数据目录 → 更改：复制核对 → 写指针 → 重启；旧目录保留', async () => {
    const oldDir = process.env.MEM0_DATA_DIR;
    const ptr = path.join(T, 'userData', 'data-location.json');
    const dm = require(SRC('main/datamove.js'));
    dm.writePointer(ptr, oldDir);           // 当前位置 = 测试数据目录（由指针给出）
    delete process.env.MEM0_DATA_DIR;
    const target = path.join(T, 'newdata');
    const msgs = [];
    app2.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    app2.dialog.showMessageBox = async (_w, o) => { msgs.push(o.message); return { response: 0 }; };
    let relaunched = 0; app2.app.relaunch = () => { relaunched++; };
    const st = await app2.invoke('state', app2.main);
    assert.equal(st.dataDirSource, 'custom'); assert.equal(st.dataDir, oldDir);
    const r = await app2.invoke('changeDataDir', app2.main);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(fs.existsSync(path.join(target, 'mem0.db')));
    assert.ok(fs.existsSync(path.join(oldDir, 'mem0.db')), '旧目录保留');
    assert.equal(dm.readPointer(ptr), path.resolve(target));
    assert.equal(relaunched, 1);
    assert.deepEqual(msgs, ['把数据搬到新位置？', '搬迁完成']);
    // 新位置的库能正常打开、数据完整
    const { Store } = require(SRC('main/db.js'));
    const a = Store.open(oldDir); const b = Store.open(target);
    assert.deepEqual(b.stats(), a.stats()); a.close(); b.close();
    process.env.MEM0_DATA_DIR = oldDir;
  });
  await app2.shutdown();

  // ======================================================================
  section('6 静态检查：CSP / 预加载 / 渲染层');
  const index = read('src/renderer/index.html');
  const tray = read('src/renderer/tray.html');
  const csp = (html) => (/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html) || [])[1];
  await test('tray.html 的 CSP 与 index.html 完全一致（禁内联 style、禁外链）', () => {
    assert.ok(csp(tray)); assert.equal(csp(tray), csp(index));
    assert.match(csp(tray), /style-src 'self'/); assert.doesNotMatch(csp(tray), /unsafe-inline|https?:/);
  });
  await test('tray.html / tray.js / tray.css 无内联 style、无内联脚本、无外链', () => {
    assert.doesNotMatch(tray, /\sstyle=/i);
    assert.doesNotMatch(tray, /<script(?![^>]*\ssrc=)[^>]*>/i);
    assert.doesNotMatch(tray, /\son[a-z]+=/i);
    for (const f of ['src/renderer/tray.html', 'src/renderer/tray.js', 'src/renderer/tray.css']) assert.doesNotMatch(read(f), /https?:\/\/(?!www\.w3\.org)/, f);
    const js = read('src/renderer/tray.js');
    assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|setAttribute\(\s*['"]style/);
  });
  await test('tray.html 只引用存在的本地资源', () => {
    for (const m of tray.matchAll(/(?:src|href)="([^"]+)"/g)) assert.ok(fs.existsSync(path.join(ROOT, 'src/renderer', m[1])), m[1]);
  });
  await test('小窗四段式结构：顶部栏 / 双卡 / 最近活动 / 底部栏', () => {
    for (const id of ['tp-refresh', 'tp-sync-text', 'tp-backup', 'tp-mcp', 'tp-list', 'tp-open', 'tp-quit']) assert.match(tray, new RegExp(`id="${id}"`), id);
    assert.match(tray, /今天备份/); assert.match(tray, /今天互通/); assert.match(tray, /最近活动/); assert.match(tray, /打开 mem0/);
    assert.match(tray, /data-brand/);
  });
  await test('tray.css：320px 面板、14px 圆角、10px 卡片圆角、26/30px 按钮、reduced-motion、INSET 与主进程一致', () => {
    const css = read('src/renderer/tray.css');
    assert.match(css, /\.panel\s*\{[^}]*width:\s*320px/);
    assert.match(css, /\.panel\s*\{[^}]*border-radius:\s*14px/);
    assert.match(css, /\.tp-card\s*\{[^}]*border-radius:\s*10px/);
    assert.match(css, /\.tp-icon\s*\{[^}]*width:\s*26px;\s*height:\s*26px/);
    assert.match(css, /\.tp-power\s*\{[^}]*width:\s*30px;\s*height:\s*30px/);
    assert.match(css, /prefers-reduced-motion:\s*reduce/);
    assert.match(css, new RegExp(`\\.tray-root\\s*\\{\\s*padding:\\s*${INSET}px`));
    assert.match(css, /tabular-nums/);
  });
  await test('预加载：暴露托盘 API 与 onNavigate / onMcpCalls', () => {
    const pre = read('src/preload/index.js');
    for (const k of ["'tray-ready'", "'tray-prepare'", "'tray-reset'", 'ready:', 'onPrepare:', 'onReset:', 'trayState', 'trayRescan', 'trayResize', 'trayHide', 'trayOpenMain', 'trayOpenConversation', 'trayQuit', "'navigate'", "'mcp-calls'", "'tray-state'"]) assert.ok(pre.includes(k), k);
  });
  await test('连接页逻辑：按 found 拆分、已打开 X / Y、未检测到 (N) 折叠、指定文案、未检测项无开关', () => {
    const js = read('src/renderer/app.js');
    assert.match(js, /filter\(\(x\) => x\.found\)/);
    assert.match(js, /已打开 \$\{on\} \/ \$\{found\.length\}/);
    assert.match(js, /未检测到 \(\$\{n\}\)/);
    assert.ok(js.includes("'未检测到本地对话目录，需要先安装或完成 1 次对话'"));
    const ur = /function undetectedRow[\s\S]*?\n\}/.exec(js)[0];
    assert.doesNotMatch(ur, /toggle\(/);
    assert.match(index, /id="local-count"/);
  });
  await test('连接页 MCP 地址：显示带 token 的完整地址，复制按钮复用现有组件类并复制完整地址', () => {
    assert.match(index, /id="mcp-url"/);
    assert.match(index, /id="btn-copy-mcp-url"[^>]*>复制</);
    const js = read('src/renderer/app.js');
    assert.match(js, /\$\('#mcp-url'\)\.textContent = mcpUrl/);
    assert.match(js, /const mcpUrl = s\.services\.mcp\.url/);
    assert.match(js, /\$\('#btn-copy-mcp-url'\)\.addEventListener\('click'[\s\S]*?mem0\.copy\(url\)/);
    assert.match(js, /\$\('#btn-copy-mcp-url'\)\.disabled = !mcpUrl/);
  });
  await test('「一键连接」后有「？」说明：结构、文案、沿用现有图标与配色、命令行可选中', () => {
    // 「？」紧跟「一键连接」，且在「一键连接」客户端列表之前
    const seg = /<h3>一键连接([\s\S]*?)<\/h3>/.exec(index);
    assert.ok(seg, '存在「一键连接」标题');
    assert.match(seg[1], /class="mcp-help"/);
    assert.match(seg[1], /id="mcp-help"[^>]*data-icon="help"/);
    assert.match(seg[1], /aria-describedby="mcp-help-pop"/);
    assert.match(index, /id="mcp-help-pop"[^>]*role="tooltip"/);
    // 浮层挂在悬停容器内：鼠标移进浮层不会触发 mouseleave
    const headBlock = /<div class="mcp-help-head"[\s\S]*?<div class="pop mcp-help-pop"[\s\S]*?<\/div>\s*<\/div>/.exec(index);
    assert.ok(headBlock, '浮层在 .mcp-help-head 内');
    // 带地址的命令行在浮层文案里
    const popBlock = /<div class="pop mcp-help-pop"[\s\S]*?<\/div>\s*<\/div>/.exec(index)[0];
    assert.match(popBlock, /id="mcp-help-cmd"/);
    for (const s of ['用 Magpie 代理？按这样手动添加：', '打开 Magpie → 资源库 → MCP 服务器 → 添加', '名称填 mem0，运行方式选「命令」',
      '命令填：', '勾选要用的 Agent（如 Claude Desktop、WorkBuddy），保存', '重启对应客户端', '需要电脑已安装 Node.js。密钥变更后，这里的地址也要同步更新。']) {
      assert.ok(index.includes(s), s);
    }
    const css = read('src/renderer/style.css');
    // 不引入新配色：只用现有变量
    const block = /\/\* 连接页「一键连接」旁[\s\S]*$/.exec(css)[0];
    assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    assert.match(block, /background:\s*var\(--surface2\)/);
    assert.match(block, /color:\s*var\(--muted\)/);
    assert.match(block, /\.mcp-help-head\.show \.mcp-help-pop\s*\{[^}]*display:\s*block/);
    assert.match(block, /user-select:\s*text/);
    assert.match(block, /max-width:\s*calc\(100vw - 48px\)/);
    // 悬停与键盘聚焦都通过 JS 切换 .show
    const js = read('src/renderer/app.js');
    assert.match(js, /head\.addEventListener\('mouseenter', \(\) => showMcpHelp\(true\)\)/);
    assert.match(js, /head\.addEventListener\('focusin', \(\) => showMcpHelp\(true\)\)/);
    assert.match(js, /head\.addEventListener\('mouseleave', \(\) => showMcpHelp\(false\)\)/);
  });
  await test('不改主界面配色 / Logo：style.css 主题变量与 Logo 路径不变', () => {
    const css = read('src/renderer/style.css');
    for (const v of ['--bg:#FAF9F5', '--surface:#F3F1EA', '--accent:#C96442', '--bg:#262624', '--accent:#D97757']) assert.ok(css.includes(v), v);
    assert.ok(read('src/renderer/icons.js').includes("mark: 'brand/mem0-mark.png'"));
    assert.ok(fs.existsSync(path.join(ROOT, 'src/renderer/brand/mem0-mark.png')));
  });
  await test('v4 顶栏 4 个导航项（含记忆页）、记录页排序切换、记忆页与设置页容器齐全', () => {
    const header = /<header class="top">([\s\S]*?)<\/header>/.exec(index);
    assert.ok(header, '存在顶栏');
    assert.equal((header[1].match(/class="nav"/g) || []).length, 4, '顶栏恰好 4 个 .nav');
    for (const v of ['home', 'records', 'memory', 'connect']) assert.match(header[1], new RegExp(`class="nav"[^>]*data-view="${v}"`), v);
    assert.match(header[1], /data-view="memory"/, '含记忆页导航');
    const seg = /<div class="mode-seg" id="rec-mode-seg"[\s\S]*?<\/div>/.exec(index);
    assert.ok(seg, '存在 #rec-mode-seg');
    assert.match(seg[0], /data-rmode="time"/); assert.match(seg[0], /data-rmode="project"/);
    for (const id of ['settings-ai', 'view-memory', 'mem-nav', 'mem-track', 'home-projects']) assert.match(index, new RegExp(`id="${id}"`), id);
  });
  await test('v4 加载 memory-clean.css 与 memory.js（app.js 之后），且无 demo-data 演示数据', () => {
    const cssAt = index.indexOf('href="memory-clean.css"');
    const appAt = index.indexOf('src="app.js"');
    const memAt = index.indexOf('src="memory.js"');
    assert.ok(cssAt >= 0, '加载 memory-clean.css');
    assert.ok(appAt >= 0 && memAt > appAt, 'memory.js 在 app.js 之后加载');
    const rendererDir = path.join(ROOT, 'src/renderer');
    const files = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(html|js)$/i.test(e.name)) files.push(p);
      }
    };
    walk(rendererDir);
    assert.equal(files.some((f) => path.basename(f) === 'demo-data.js'), false, 'src/renderer 下不得存在 demo-data.js');
    for (const f of files) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /demo-data/i, path.relative(ROOT, f));
  });
  await test('v4 CSP 仍与 tray.html 完全一致，且无内联 style / on* 事件 / insertAdjacentHTML', () => {
    assert.ok(csp(index)); assert.equal(csp(index), csp(tray));
    assert.match(csp(index), /style-src 'self'/); assert.doesNotMatch(csp(index), /unsafe-inline|https?:/);
    const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const f of ['src/renderer/app.js', 'src/renderer/memory.js']) {
      const js = strip(read(f));
      assert.doesNotMatch(js, /\bstyle\s*=\s*["']/, `${f} 含内联 style 属性串`);
      assert.doesNotMatch(js, /\bon[a-z]+\s*=\s*["']/i, `${f} 含内联事件`);
      assert.doesNotMatch(js, /insertAdjacentHTML/, `${f} 含 insertAdjacentHTML`);
      assert.doesNotMatch(js, /setAttribute\(\s*['"]style/, `${f} 用 setAttribute 设置 style`);
    }
  });

  // ======================================================================
  section('7 渲染层：退出确认条 + 显示握手（vm 里跑真实 tray.js，最小假 DOM）');
  const R7 = runTrayRenderer();
  const foot = R7.el('tp-foot');
  await test('确认条在 .tp-foot 内部，文案「退出 mem0？· 取消 · 退出」，退出用 var(--bad)，绝对定位不改底栏高度', () => {
    const m = /<footer class="tp-foot"[\s\S]*?<\/footer>/.exec(tray)[0];
    assert.match(m, /class="tp-confirm"/); assert.match(m, /退出 mem0？/); assert.match(m, />取消</); assert.match(m, /id="tp-quit-yes"[^>]*>退出</);
    const css = read('src/renderer/tray.css');
    assert.match(css, /\.tp-confirm\s*\{[^}]*position:\s*absolute;\s*inset:\s*0/);
    assert.match(css, /\.tp-foot\.confirming \.tp-confirm\s*\{[^}]*display:\s*flex/);
    assert.match(css, /\.tp-cbtn\.bad\s*\{[^}]*color:\s*var\(--bad\)/);
  });
  await test('初始未确认；点 ⏻ → .confirming（不直接退出）', () => {
    assert.equal(foot.classList.contains('confirming'), false);
    R7.el('tp-quit').click();
    assert.equal(foot.classList.contains('confirming'), true);
    assert.equal(R7.calls.quit, 0);
  });
  await test('取消 → 复位', () => {
    R7.el('tp-cancel').click();
    assert.equal(foot.classList.contains('confirming'), false);
  });
  await test('Esc：确认中只复位不收起；未确认时收起小窗', () => {
    R7.el('tp-quit').click();
    R7.key('Escape');
    assert.equal(foot.classList.contains('confirming'), false); assert.equal(R7.calls.hide, 0);
    R7.key('Escape');
    assert.equal(R7.calls.hide, 1);
  });
  await test('小窗收起（tray-reset）→ 复位', () => {
    R7.el('tp-quit').click();
    R7.cb.reset();
    assert.equal(foot.classList.contains('confirming'), false);
  });
  await test('点「退出」：按钮禁用、显示「退出中…」、调用 mem0.tray.quit()（重复点击只调一次）', () => {
    R7.el('tp-quit').click();
    R7.el('tp-quit-yes').click(); R7.el('tp-quit-yes').click();
    assert.equal(R7.calls.quit, 1);
    assert.equal(R7.el('tp-quit-yes').disabled, true); assert.equal(R7.el('tp-cancel').disabled, true);
    assert.equal(R7.el('tp-confirm-text').textContent, '退出中…');
    R7.cb.reset();
    assert.equal(R7.el('tp-quit-yes').disabled, false); assert.equal(R7.el('tp-confirm-text').textContent, '退出 mem0？');
  });
  await test('tray-prepare：等 2 帧后回 ready(token, 面板高度)，只回一次', async () => {
    R7.cb.prepare({ token: 7 });
    assert.equal(R7.calls.ready.length, 0);
    await sleep(80);
    assert.deepEqual(R7.calls.ready, [[7, 412]]);
  });
  await test('tray-prepare：rAF 不触发（隐藏窗口被节流）时 60ms 兜底回 ready', async () => {
    R7.ctx.requestAnimationFrame = () => {};
    R7.calls.ready.length = 0;
    R7.cb.prepare({ token: 8 });
    await sleep(30); assert.equal(R7.calls.ready.length, 0);
    await sleep(60); assert.deepEqual(R7.calls.ready, [[8, 412]]);
  });


  // ======================================================================
  section('8 macOS 适配（darwin 下真实 index.js + 假 Electron）');
  const plat = require(SRC('main/platform'));
  const ORIG_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform');
  /** 在 vm 里跑真实 index.js，把 process.platform 改成 darwin（Windows 分支不受影响） */
  async function bootMac() {
    // process.platform 不可写、但可配置：整段 macOS 测试期间切成 darwin
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const fake = makeFakeElectron({ trayBounds: { x: 1500, y: 0, width: 22, height: 24 }, cursor: { x: 1, y: 1 }, display: { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 25, width: 1920, height: 1055 } } });
    const code = read('src/main/index.js');
    const m = new Module(SRC('main/index.js'), module);
    m.filename = SRC('main/index.js');
    m.paths = Module._nodeModulePaths(path.dirname(SRC('main/index.js')));
    const origLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === 'electron') return fake;
      if (request === './mcp') return { mcpEvents: new EventEmitter(), startMcpServer: async () => ({ url: 'http://127.0.0.1:3790/mcp?token=mac', close: async () => {} }) };
      if (request === './bridge') return { startBridge: async () => ({ url: 'ws://127.0.0.1:3791/x', status: () => ({ connected: 0, paired: 0 }), close: async () => {}, newPairCode: () => null, revokeAll: () => {} }) };
      if (parent && parent.filename === SRC('main/index.js') && request === './tray-window') {
        const tw = origLoad.apply(this, arguments);
        class TrackedPopover extends tw.TrayPopover {
          constructor(o) { super(o); fake.popover = this; }
        }
        return { ...tw, TrayPopover: TrackedPopover };
      }
      return origLoad.apply(this, arguments);
    };
    m._compile(code, SRC('main/index.js'));
    fake.readyResolve();
    for (let i = 0; i < 200 && !fake.handlers.has('trayState'); i++) await sleep(10);
    const wins = fake.BrowserWindow.all;
    fake.main = wins.find((w) => !w.opts.transparent);
    // 托盘小窗构造时不建窗口：这里 ensureWindow() 建出来供断言
    fake.popover.ensureWindow();
    fake.pop = fake.popover.win;
    fake.tray = fake.Tray.last;
    fake.closeMain = () => { fake.main.destroy(); };
    fake.shutdown = async () => {
      for (const l of fake.app.listeners('before-quit')) await l({ preventDefault() {} });
      Module._load = origLoad;
    };
    return fake;
  }
  const mac = await bootMac();
  await test('platform 纯函数：isMac / 菜单 / Dock / 托盘图标路径', () => {
    assert.equal(plat.isMac('darwin'), true); assert.equal(plat.isMac('win32'), false);
    assert.equal(plat.needsAppMenu('darwin'), true); assert.equal(plat.needsAppMenu('win32'), false);
    assert.equal(plat.shouldHideDock('darwin'), true); assert.equal(plat.shouldHideDock('win32'), false);
    assert.equal(plat.shouldShowDock('darwin'), true); assert.equal(plat.shouldShowDock('win32'), false);
    assert.equal(plat.trayIconPath({ dirname: '/a/main', rendererDir: '/a/renderer', platform: 'darwin' }), path.join('/a/main', 'assets', 'trayTemplate.png'));
    assert.equal(plat.trayIconPath({ dirname: '/a/main', rendererDir: '/a/renderer', platform: 'win32' }), path.join('/a/renderer', 'tray.png'));
    assert.equal(plat.trayIconPath({ dirname: '/a/main', rendererDir: '/a/renderer', platform: 'linux' }), path.join('/a/renderer', 'tray.png'));
  });
  await test('托盘：macOS 用 trayTemplate.png 且 setTemplateImage(true)', () => {
    assert.ok(mac.log.iconPath.endsWith(path.join('assets', 'trayTemplate.png')), mac.log.iconPath);
    assert.equal(mac.log.templateImage, true);
    assert.equal(mac.tray.img.getSize().width, 16, '模板图 16x16 原样使用，不 resize');
  });
  await test('应用菜单：macOS 有中文菜单（mem0/编辑/窗口，退出 ⌘Q、关闭窗口 ⌘W）', () => {
    assert.ok(mac.log.appMenu, '应设置应用菜单');
    const [mem, edit, winMenu] = mac.log.appMenu.items;
    assert.equal(mem.label, 'mem0');
    assert.deepEqual(mem.submenu.map((i) => i.label || i.type), ['关于 mem0', 'separator', '隐藏 mem0', '隐藏其他', '全部显示', 'separator', '退出 mem0']);
    assert.equal(mem.submenu.pop().accelerator, 'CmdOrCtrl+Q');
    assert.deepEqual(edit.submenu.map((i) => i.label || i.type), ['撤销', '重做', 'separator', '剪切', '复制', '粘贴', '全选']);
    assert.deepEqual(winMenu.submenu.map((i) => i.label), ['最小化', '关闭窗口']);
    assert.equal(winMenu.submenu[1].accelerator, 'CmdOrCtrl+W');
  });
  await test('托盘小窗：macOS setVisibleOnAllWorkspaces(true, {visibleOnFullScreen:true})，菜单栏在顶部向下弹出', async () => {
    assert.deepEqual(mac.pop.visibleOnAllWorkspaces, { v: true, o: { visibleOnFullScreen: true } });
    // 触发一次显示：面板应弹在菜单栏下方（y = 工作区顶边）
    mac.tray.emit('click');
    await sleep(5);
    assert.equal(mac.pop.isVisible(), true);
    assert.equal(mac.pop.bounds.y, 25);
    mac.pop.emit('blur');
  });
  await test('Dock：关闭主窗口后 hide，托盘再次打开主窗口时 show', async () => {
    assert.equal(mac.app.dock.visible, true);
    mac.closeMain();
    assert.equal(mac.app.dock.visible, false);
    mac.tray.emit('right-click');
    const menu = mac.log.popUp[0];
    menu.items.find((i) => i.label === '打开 mem0').click();
    assert.equal(mac.app.dock.visible, true);
  });
  await test('shouldConfirmQuit：仅 macOS 用户主动退出需要确认；系统关机/注销不弹', () => {
    assert.equal(plat.shouldConfirmQuit({ platform: 'darwin' }), true);
    assert.equal(plat.shouldConfirmQuit({ platform: 'darwin', shutdown: true }), false);
    assert.equal(plat.shouldConfirmQuit({ platform: 'win32' }), false);
    assert.equal(plat.shouldConfirmQuit({ platform: 'linux' }), false);
  });
  await test('⌘Q（before-quit）：弹「退出后将停止后台备份和 MCP 服务，确定退出？」；取消则不退', async () => {
    const boxes = [];
    mac.dialog.showMessageBox = async (a, b) => { boxes.push(b || a); return { response: 1 }; };
    const q = mac.log.quit;
    for (const l of mac.app.listeners('before-quit')) await l({ preventDefault() {} });
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0].message, '退出后将停止后台备份和 MCP 服务，确定退出？');
    assert.deepEqual(boxes[0].buttons, ['退出', '取消']);
    assert.equal(mac.log.quit, q, '取消后不退出');
  });
  await test('⌘Q 确认「退出」：真正退出', async () => {
    mac.dialog.showMessageBox = async () => ({ response: 0 });
    const q = mac.log.quit;
    for (const l of mac.app.listeners('before-quit')) await l({ preventDefault() {} });
    assert.equal(mac.log.quit, q + 1);
  });
  await test('系统关机（powerMonitor shutdown）：before-quit 不弹窗阻挡', async () => {
    const app3 = await bootMac();
    let boxes = 0;
    app3.dialog.showMessageBox = async () => { boxes++; return { response: 1 }; };
    app3.powerMonitor.emit('shutdown');
    for (const l of app3.app.listeners('before-quit')) await l({ preventDefault() {} });
    assert.equal(boxes, 0);
    await app3.shutdown();
  });
  // 恢复真实 platform，再验证 Windows/Linux 行为未变
  Object.defineProperty(process, 'platform', ORIG_PLATFORM);
  await test('Windows 下仍无应用菜单、托盘仍用彩色 tray.png、不设模板图', async () => {
    const app4 = await bootApp({ mcpMock: { mcpEvents: new EventEmitter(), startMcpServer: async () => ({ url: 'http://127.0.0.1:3790/mcp?token=w', close: async () => {} }) }, trayBounds: { x: 1700, y: 1048, width: 24, height: 24 }, cursor: { x: 1, y: 1 }, display: DISPLAY });
    assert.equal(app4.log.appMenu, undefined);
    assert.ok(app4.log.iconPath.endsWith(path.join('renderer', 'tray.png')), app4.log.iconPath);
    assert.equal(app4.log.templateImage, undefined);
    await app4.shutdown();
  });
  await mac.shutdown();

  // ======================================================================
  section('9 会话详情分页 / 复制时才取全文 / 删除时清理大纲（vm 里跑真实 app.js）');
  const A = runAppRenderer();
  const detailActions = () => A.byClass(A.el('detail'), 'detail-actions')[0];
  const detailCopyBtn = () => A.byClass(detailActions(), 'head-copy-btn')[0];
  const convOf = (n, prefix = 'm') => ({
    id: 'conv-1', source: 'claude-code', title: '长会话', message_count: n, updated_at: 1_700_000_000_000,
    messages: Array.from({ length: Math.min(n, 200) }, (_, i) => ({ seq: n - Math.min(n, 200) + i, role: i % 2 ? 'assistant' : 'user', content: `${prefix}${n - Math.min(n, 200) + i}`, created_at: 1_700_000_000_000 + i })),
  });
  // read 返回最近 200 条（记录参数）；fromSeq/limit 按区间返回
  A.ctx.mem0.read = async (id, opts) => {
    A.calls.read.push([id, opts]);
    if (opts && opts.tail) return convOf(450);
    const all = Array.from({ length: 450 }, (_, i) => ({ seq: i, role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
    return { ...convOf(450), messages: all.slice(opts.fromSeq, opts.fromSeq + opts.limit) };
  };
  await A.setState({
    stats: { total: 1, messages: 450, today: 1, todayMessages: 1, bySource: { 'claude-code': 1 }, messagesBySource: { 'claude-code': 450 }, todayBySource: {} },
    localSources: [{ id: 'claude-code', label: 'Claude Code', found: true, enabled: true }],
    webSources: [], bridge: { connected: false, paired: false }, services: { mcp: { ok: true, starting: false, url: 'http://x' }, bridge: { ok: true, starting: false, url: 'ws://x' } },
    clients: [], mcpCallsToday: 0, dataDir: '/tmp', version: '0.5.3', manualConfig: '{}',
  });

  await test('分页参数：prevPageRange 取前 200 条，到顶返回 null', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(A.ev('prevPageRange(250)'))), { fromSeq: 50, limit: 200 });
    assert.deepEqual(JSON.parse(JSON.stringify(A.ev('prevPageRange(200)'))), { fromSeq: 0, limit: 200 });
    assert.deepEqual(JSON.parse(JSON.stringify(A.ev('prevPageRange(50)'))), { fromSeq: 0, limit: 50 });
    assert.equal(A.ev('prevPageRange(0)'), null);
  });
  await test('打开详情：只取最近 200 条（tail:200），不在打开时取全文', async () => {
    A.calls.read.length = 0; A.calls.copy.length = 0;
    await A.ctx.openConversation('conv-1', []);
    assert.deepEqual(A.plain(A.calls.read), [['conv-1', { tail: 200 }]]);
    assert.equal(A.calls.copy.length, 0, '打开详情不复制、不拼全文');
    const msgs = A.byClass(A.el('detail'), 'msg');
    assert.equal(msgs.length, 200);
  });
  await test('复制全文：点击时才分页读完再拼接（从 seq 0 起，每页 200）', async () => {
    A.calls.read.length = 0; A.calls.copy.length = 0;
    const btn = detailCopyBtn();
    await btn.click();
    const full = A.calls.read.filter(([, o]) => o && o.limit && !o.tail);
    assert.deepEqual(A.plain(full.map(([, o]) => [o.fromSeq, o.limit])), [[0, 200], [200, 200], [400, 200]]);
    assert.equal(A.calls.copy.length, 1);
    assert.equal(A.calls.copy[0], Array.from({ length: 450 }, (_, i) => `## ${i % 2 ? 'AI' : '我'}\n\nm${i}`).join('\n\n'));
  });
  await test('复制全文：与打开详情时取的消息无关，每次都重新按页读取', async () => {
    A.calls.read.length = 0;
    const btn = detailCopyBtn();
    await btn.click();
    assert.equal(A.calls.read.filter(([, o]) => o && o.limit && !o.tail).length, 3);
  });
  await test('删除当前会话：替换详情 DOM 之前调用 outlineCleanup()（并取消待执行的 rAF）', async () => {
    await A.ctx.openConversation('conv-1', []);
    assert.ok(A.ev('outlineCleanup'), '打开长会话后有大纲');
    // 包一层：记录 cleanup 被调用时详情里是否还有旧消息（有 = 在替换 DOM 之前调用）
    let msgsWhenCleaned = -1;
    A.ev(`__msgsWhenCleaned = -1; outlineCleanup = (() => { const orig = outlineCleanup; return () => { __msgsWhenCleaned = document.querySelector('#detail').children.filter((n) => n.classList.contains('scroller')).length; orig(); }; })()`);
    const cancelledBefore = A.calls.cancelled.length;
    const scroller = A.el('detail').children.find((n) => n._cls && n._cls.has('scroller'));
    const actions = A.byClass(scroller, 'detail-actions')[0];
    const trashBtn = actions.children[actions.children.length - 1];
    await trashBtn.click();
    assert.equal(A.calls.remove.pop(), 'conv-1');
    assert.equal(A.ev('outlineCleanup'), null, '删除后大纲已解绑');
    assert.equal(A.ev('__msgsWhenCleaned'), 1, 'cleanup 在替换详情 DOM 之前被调用');
    assert.ok(A.calls.cancelled.length > cancelledBefore, '同时取消了挂起的 requestAnimationFrame');
    assert.equal(A.byClass(A.el('detail'), 'msg').length, 0);
    assert.match(A.text(A.el('detail')), /已删除/);
  });
  await test('outlineCleanup 取消挂起的一帧（防删除后回调碰旧 DOM）', async () => {
    await A.ctx.openConversation('conv-1', []);
    A.calls.cancelled.length = 0;
    A.ev('outlineCleanup()');
    assert.equal(A.calls.cancelled.length, 1);
    A.ev('outlineCleanup = null');
  });
  await test('打开长会话停在最新处（往上滚才有得加载）；短会话仍从顶部开始', async () => {
    await A.ctx.openConversation('conv-1', []);
    const sc = A.el('detail').children.find((n) => n._cls && n._cls.has('scroller'));
    assert.ok(sc.scrollTop > 0, '长会话停在底部');
    A.ctx.mem0.read = async (id, opts) => { A.calls.read.push([id, opts]); return convOf(12); };
    await A.ctx.openConversation('conv-1', []);
    const sc2 = A.el('detail').children.find((n) => n._cls && n._cls.has('scroller'));
    assert.equal(sc2.scrollTop, 0, '短会话从顶部开始');
  });
  await test('滚到顶部附近：补上一页并插入到顶部，滚动位置保持不跳', async () => {
    A.ctx.mem0.read = async (id, opts) => {
      A.calls.read.push([id, opts]);
      if (opts.tail) return convOf(450);
      const all = Array.from({ length: 450 }, (_, i) => ({ seq: i, role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
      return { ...convOf(450), messages: all.slice(opts.fromSeq, opts.fromSeq + opts.limit) };
    };
    await A.ctx.openConversation('conv-1', []);
    const sc = A.el('detail').children.find((n) => n._cls && n._cls.has('scroller'));
    assert.equal(A.byClass(A.el('detail'), 'msg').length, 200);
    A.calls.read.length = 0;
    const before = sc.scrollHeight;
    sc.scrollTop = 10;
    await sc.dispatch('scroll');
    await new Promise((r) => setTimeout(r, 0)); // 等 loadOlder 的 await 完成
    assert.deepEqual(A.plain(A.calls.read.map(([, o]) => [o.fromSeq, o.limit])), [[50, 200]]);
    const msgs = A.byClass(A.el('detail'), 'msg');
    assert.equal(msgs.length, 400, '上一页插到前面');
    assert.equal(msgs[0].title || '', '', '首条为 assistant（无 title）');
    const text = msgs.map(A.text);
    assert.match(text[0], /m50/);
    assert.match(text[199], /m249/);
    assert.match(text[200], /m250/);
    assert.ok(sc.scrollTop > 10, '补进顶部高度后视觉位置不变');
    assert.equal(sc.scrollTop - 10, sc.scrollHeight - before);
    // 大纲按新加载的消息重建：刻度/条目与提问数一致（首屏 100 条提问 + 上一页 100 条）
    const outline = A.byClass(A.el('detail'), 'question-outline');
    assert.equal(outline.length, 1);
    assert.equal(A.byClass(outline[0], 'tick').length, 200);
    assert.equal(A.byClass(outline[0], 'qo-row').length, 200);
    assert.match(A.text(A.byClass(outline[0], 'qo-row')[0]), /m50/);
  });
  await test('从搜索打开：命中在更早页里时继续往前取并定位到命中', async () => {
    A.calls.read.length = 0;
    await A.ctx.openConversation('conv-1', ['m60']);
    await new Promise((r) => setTimeout(r, 0)); // 等回溯取页的 Promise 完成
    // 首屏最近 200 条（seq 250-449）不含 m60，需继续补页
    const pagesRead = A.calls.read.filter(([, o]) => o && o.limit && !o.tail).map(([, o]) => o.fromSeq);
    assert.deepEqual(A.plain(pagesRead), [50]);
    const hit = A.byClass(A.el('detail'), 'hit');
    assert.equal(hit.length, 1);
    assert.match(A.text(hit[0]), /m60/);
  });
  await test('少于 200 条：行为不变（全部消息都在 DOM 里，不追加分页读取）', async () => {
    A.ctx.mem0.read = async (id, opts) => { A.calls.read.push([id, opts]); return convOf(12); };
    A.calls.read.length = 0;
    await A.ctx.openConversation('conv-1', []);
    assert.deepEqual(A.plain(A.calls.read), [['conv-1', { tail: 200 }]]);
    assert.equal(A.byClass(A.el('detail'), 'msg').length, 12);
  });

  // ======================================================================
  section('10 连接页「一键连接」说明浮层（vm 里跑真实 app.js）');
  const mcpState = (url) => ({
    stats: { total: 0, messages: 0, today: 0, todayMessages: 0, bySource: {}, messagesBySource: {}, todayBySource: {} },
    localSources: [], webSources: [], bridge: { connected: false, paired: false },
    services: { mcp: { ok: true, starting: false, url }, bridge: { ok: true, starting: false, url: 'ws://x' } },
    clients: [], mcpCallsToday: 0, dataDir: '/tmp', version: '0.5.4', manualConfig: '{}',
  });
  // 直接写 vm 里的模块级 state（renderConnect 读的是它）
  const setMcpState = (url) => A.ev(`state = ${JSON.stringify(mcpState(url))}`);
  await test('说明浮层里的命令用与「复制地址」相同的带 token 地址', async () => {
    setMcpState('http://127.0.0.1:3790/mcp?token=abc');
    A.ev('renderConnect()');
    const url = 'http://127.0.0.1:3790/mcp?token=abc';
    // 悬停文案（浮层里的命令行）含地址，且与「复制」用的值一致
    assert.ok(A.el('mcp-help-cmd').textContent.includes(url), '浮层文案含地址');
    assert.equal(A.el('mcp-help-cmd').textContent, `npx -y mcp-remote ${url}`);
    assert.equal(A.el('mcp-url').textContent, url);
    // 复制按钮复制的也是同一个值
    await A.el('btn-copy-mcp-url').click();
    assert.equal(A.calls.copy.pop(), url);
  });
  await test('token 变化后说明里的地址同步更新（每次渲染都重算）', async () => {
    setMcpState('http://127.0.0.1:3790/mcp?token=xyz789');
    A.ev('renderConnect()');
    assert.equal(A.el('mcp-help-cmd').textContent, 'npx -y mcp-remote http://127.0.0.1:3790/mcp?token=xyz789');
    setMcpState('');
    A.ev('renderConnect()');
    assert.equal(A.el('mcp-help-cmd').textContent, 'npx -y mcp-remote', '地址未就绪时不拼出半截地址');
  });
  await test('fitPopover：默认在锚点下方，右边/下边越界时夹回窗口内', () => {
    const near = (v, want) => assert.ok(Math.abs(v - want) < 0.01, `${v} ≈ ${want}`);
    // 正常：紧贴锚点下方 8px
    let p = A.plain(A.ev('fitPopover({ left: 100, top: 200, bottom: 216 }, { width: 320, height: 180 }, { width: 1100, height: 720 })'));
    near(p.left, 100); near(p.top, 224);
    // 靠近右边：不超出右边界
    p = A.plain(A.ev('fitPopover({ left: 900, top: 200, bottom: 216 }, { width: 320, height: 180 }, { width: 1100, height: 720 })'));
    assert.ok(p.left + 320 <= 1100 - 12, `右边不越界：${p.left + 320}`);
    assert.ok(p.left >= 12, '左边不越界');
    // 靠近底部：翻到锚点上方，且上下都不越界
    p = A.plain(A.ev('fitPopover({ left: 100, top: 620, bottom: 636 }, { width: 320, height: 180 }, { width: 1100, height: 720 })'));
    assert.ok(p.top >= 12, `上边不越界：${p.top}`);
    assert.ok(p.top + 180 <= 720 - 12, `下边不越界：${p.top + 180}`);
    assert.ok(p.top + 180 <= 620, '翻到锚点上方');
  });
  await test('窗口很矮时浮层仍完整落在窗口内（不越界）', () => {
    const p = A.plain(A.ev('fitPopover({ left: 20, top: 500, bottom: 516 }, { width: 320, height: 400 }, { width: 820, height: 520 })'));
    assert.ok(p.left >= 12 && p.left + 320 <= 820 - 12, '水平在窗口内');
    assert.ok(p.top >= 12 && p.top + 400 <= 520 - 12, '垂直在窗口内');
  });
  await test('显示浮层时把夹好边界的定位写进 style（left/top 都是 px）', async () => {
    setMcpState('http://127.0.0.1:3790/mcp?token=abc');
    A.ev('renderConnect()');
    await A.el('mcp-help-head').dispatch('mouseenter', {});
    const pop = A.el('mcp-help-pop');
    assert.match(String(pop.style.left), /^-?\d+(\.\d+)?px$/);
    assert.match(String(pop.style.top), /^-?\d+(\.\d+)?px$/);
  });
  await test('悬停/键盘聚焦显示浮层，移开后延迟收起（给鼠标移到浮层留时间）', async () => {
    const head = A.el('mcp-help-head');
    A.ev('showMcpHelp(false)');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(head.classList.contains('show'), false, '初始不显示');
    await head.dispatch('mouseenter', {});
    assert.equal(head.classList.contains('show'), true, '悬停显示');
    await head.dispatch('mouseleave', {});
    assert.equal(head.classList.contains('show'), true, '立即不移除，留出移入浮层的过渡');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(head.classList.contains('show'), false, '延迟后收起');
    await head.dispatch('focusin', {});
    assert.equal(head.classList.contains('show'), true, '键盘聚焦显示');
    await head.dispatch('focusout', { relatedTarget: null });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(head.classList.contains('show'), false);
  });

  // ======================================================================
  section('10b v4 摘要卡 / 复制全文（vm 里真实 app.js + memory.js）');
  const v4conv = (extra) => ({
    id: 'conv-v4', source: 'claude-code', title: '带摘要的会话', message_count: 3, updated_at: 1_700_000_000_000,
    messages: [
      { seq: 0, role: 'user', content: 'u0' },
      { seq: 1, role: 'assistant', content: 'a1' },
      { seq: 2, role: 'user', content: 'u2' },
    ], ...extra,
  });
  const v4read = (conv) => async (id, opts) => {
    if (opts && opts.tail) return { ...conv, messages: conv.messages.slice(-opts.tail) };
    const from = opts.fromSeq || 0;
    return { ...conv, messages: conv.messages.slice(from, from + (opts.limit || conv.messages.length)) };
  };
  await test('无 summary / decisions / next_step 的会话不渲染 .sum-card 空框', async () => {
    const conv = v4conv({});
    A.ctx.mem0.read = v4read(conv);
    await A.ctx.openConversation(conv.id, []);
    assert.equal(A.byClass(A.el('detail'), 'sum-card').length, 0);
  });
  await test('有 summary 的会话渲染 .sum-card 并显示摘要', async () => {
    const conv = v4conv({ summary: '这次把导出流程修好了', decisions_json: '[]', next_step: '' });
    A.ctx.mem0.read = v4read(conv);
    await A.ctx.openConversation(conv.id, []);
    const cards = A.byClass(A.el('detail'), 'sum-card');
    assert.equal(cards.length, 1);
    assert.match(A.text(cards[0]), /这次把导出流程修好了/);
  });
  await test('无摘要会话「复制全文」输出仍是纯 ## 我 / ## AI', async () => {
    const conv = v4conv({});
    A.ctx.mem0.read = v4read(conv);
    await A.ctx.openConversation(conv.id, []);
    A.calls.copy.length = 0;
    const btn = detailCopyBtn();
    await btn.click();
    assert.equal(A.calls.copy[0], '## 我\n\nu0\n\n## AI\n\na1\n\n## 我\n\nu2');
  });
  await test('有摘要时「复制全文」顶部为 # 标题 / > 摘要：… 前缀', async () => {
    const conv = v4conv({ summary: '这是摘要' });
    A.ctx.mem0.read = v4read(conv);
    await A.ctx.openConversation(conv.id, []);
    A.calls.copy.length = 0;
    const btn = detailCopyBtn();
    await btn.click();
    assert.equal(A.calls.copy[0], '# 带摘要的会话\n\n> 摘要：这是摘要\n\n## 我\n\nu0\n\n## AI\n\na1\n\n## 我\n\nu2');
  });

  // ======================================================================
  section('10c v4 前端回归：裸文本扫描 / 详情操作区 / 关联会话折叠 / 设置页旧会话');
  const MEM_GROUPS = ['个人与职业背景', '协作与沟通准则', '环境与工作流', '踩坑与经验库']
    .map((id) => ({ id, icon: 'bulb', copyLabel: '复制本页' }));
  const baseState = (over = {}) => ({
    stats: { total: 3, messages: 30, today: 1, todayMessages: 2, bySource: { 'claude-code': 3 }, messagesBySource: { 'claude-code': 30 }, todayBySource: {} },
    localSources: [{ id: 'claude-code', label: 'Claude Code', found: true, enabled: true }],
    webSources: [], bridge: { connected: false, paired: false },
    services: { mcp: { ok: true, starting: false, url: 'http://127.0.0.1:3790/mcp?token=t' }, bridge: { ok: true, starting: false, url: 'ws://x' } },
    clients: [], mcpCallsToday: 0, dataDir: '/tmp', version: '0.6.0', manualConfig: '{}',
    memories: [], projects: [], memoryGroups: MEM_GROUPS,
    ai: { enabled: true, provider: 'deepseek', baseUrl: '', model: '', hasKey: false, keyHint: '', statusText: '已就绪', statusOk: true, unorganizedCount: 0, organizing: false },
    ...over,
  });
  const setFullState = (over = {}) => A.ev(`state = ${JSON.stringify(baseState(over))}`);
  const projectOf = (extra = {}) => ({
    id: 'p1', name: '推进事项甲', state: '推进中', archived: false, workspace: '/w/p1',
    progress: '进行中', decisions: ['结论一'], rejected: [], nextStep: '下一步',
    createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, ...extra,
  });
  const BAD_TEXT = new Set(['null', 'undefined', 'false', 'NaN']);
  const badTextNodes = (root = A.ctx.document.body) => A.all(root)
    .filter((n) => n.tag === '#text' && BAD_TEXT.has(String(n.textContent).trim()))
    .map((n) => String(n.textContent).trim());
  const assertNoBadText = (label) => {
    const bad = badTextNodes();
    assert.deepEqual(bad, [], `${label}：document.body 下出现裸文本节点 ${JSON.stringify(bad)}`);
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));

  await test('扫描工具灵敏度：直接 append(null) 产生的裸 "null" 文本节点能被抓到（假 DOM 原生语义）', () => {
    A.ev('window.__nullProbe = document.createElement("span"); window.__nullProbe.append(null); document.body.append(window.__nullProbe);');
    assert.deepEqual(badTextNodes(), ['null'], '假 DOM 应把 null 变成 "null" 文本节点并被扫描抓到');
    A.ev('window.__nullProbe.remove()');
    assert.deepEqual(badTextNodes(), []);
  });

  await test('首页渲染后 document.body 下无裸 null/undefined/false/NaN 文本节点', async () => {
    setFullState();
    A.ctx.mem0.list = async () => [{ id: 'c1', source: 'claude-code', title: '一条会话', message_count: 4, updated_at: 1_700_000_000_000 }];
    await A.ctx.renderHome();
    assertNoBadText('首页');
  });

  await test('记录页详情（无摘要）：无 .float、复制按钮为 .head-copy-btn「复制全文」、meta 内有胶囊、无锁/备注', async () => {
    const conv = v4conv({});
    A.ctx.mem0.read = v4read(conv);
    await A.ctx.openConversation(conv.id, []);
    const detail = A.el('detail');
    assert.equal(A.byClass(detail, 'float').length, 0, '旧的底部悬浮 .float 复制按钮应已删除');
    const actions = detailActions();
    assert.equal(actions.children[0], detailCopyBtn(), '.detail-actions 第一个按钮应是复制按钮');
    assert.ok(detailCopyBtn()._cls.has('head-copy-btn'));
    assert.equal(A.text(detailCopyBtn()).trim(), '复制全文');
    const meta = A.byClass(detail, 'meta')[0];
    assert.ok(meta, '详情应有 .meta 行');
    assert.ok(A.byClass(meta, 'meta-chip').length >= 1, '事项胶囊 .meta-chip 应在 .meta 行内');
    const dt = A.text(detail);
    assert.ok(!dt.includes('锁'), '详情区不应出现「锁」字');
    assert.ok(!dt.includes('备注'), '详情区不应出现「备注」字样');
    assert.equal(A.byClass(detail, 'lock-pill').length, 0);
    assert.ok(!dt.includes('已手动锁定'));
    assert.equal(A.byClass(detail, 'sum-card').length, 0, '无摘要不渲染 .sum-card');
    assertNoBadText('记录页详情（无摘要）');
  });

  await test('记录页详情（有摘要）：.sum-card 标题为「会话摘要」，复制按钮为「复制摘要与全文」', async () => {
    const conv = v4conv({ summary: '这次把导出流程修好了' });
    A.ctx.mem0.read = v4read(conv);
    await A.ctx.openConversation(conv.id, []);
    const detail = A.el('detail');
    assert.equal(A.byClass(detail, 'float').length, 0);
    assert.equal(A.text(detailCopyBtn()).trim(), '复制摘要与全文');
    const cards = A.byClass(detail, 'sum-card');
    assert.equal(cards.length, 1);
    const titles = A.byClass(cards[0], 'sum-hd-title');
    assert.equal(titles.length, 1);
    assert.equal(A.text(titles[0]).trim(), '会话摘要');
    assert.ok(A.text(detail).includes('这次把导出流程修好了'));
    assertNoBadText('记录页详情（有摘要）');
  });

  await test('记录页详情（编辑态）：点编辑图标进入表单，仍无裸文本/锁/备注', async () => {
    const conv = v4conv({ summary: '这是摘要' });
    A.ctx.mem0.read = v4read(conv);
    await A.ctx.openConversation(conv.id, []);
    const editBtn = detailActions().children.find((b) => b._cls && b._cls.has('icon-btn') && /标题/.test(String(b.attrs.title || b.title)));
    assert.ok(editBtn, '详情操作区应有编辑标题 / 摘要的图标按钮');
    await editBtn.click();
    await tick();
    const detail = A.el('detail');
    const titles = A.byClass(detail, 'sum-hd-title');
    assert.equal(titles.length, 1);
    assert.equal(A.text(titles[0]).trim(), '编辑会话标题与摘要');
    const dt = A.text(detail);
    assert.ok(!dt.includes('锁') && !dt.includes('备注'));
    assertNoBadText('记录页详情（编辑态）');
  });

  await test('记忆页分组视图：渲染卡片后无裸文本节点', async () => {
    setFullState({
      memories: [
        { id: 'm1', group: '个人与职业背景', title: '背景一', body: '正文一', tags: [], sourceIds: [], originLabel: '手动录入', superseded: '', updatedAt: 1_700_000_000_000 },
        { id: 'm2', group: '个人与职业背景', title: '背景二', body: '正文二', tags: ['标签'], sourceIds: ['conv-1'], originLabel: '手动录入', superseded: '', updatedAt: 1_700_000_001_000 },
      ],
    });
    A.ev('window.mem0Ext.openMemory({ type: "group", id: "个人与职业背景" })');
    assert.ok(A.byClass(A.el('mem-track'), 'topic-card').length >= 2, '分组视图应渲染卡片');
    assertNoBadText('记忆页分组视图');
  });

  await test('推进事项详情：收起态只有汇总条、无 mini-list；展开态行数等于 list 条数', async () => {
    const rows = [
      { id: 'c1', source: 'claude-code', title: '会话甲', updated_at: 1_700_000_000_000 },
      { id: 'c2', source: 'codex', title: '会话乙', updated_at: 1_700_000_001_000 },
      { id: 'c3', source: 'gemini-web', title: '会话丙', updated_at: 1_700_000_002_000 },
    ];
    setFullState({ projects: [projectOf()] });
    A.ctx.mem0.list = async () => rows;
    A.ev('window.mem0Ext.openMemory({ type: "project", id: "p1" })');
    await tick();
    let bars = A.byClass(A.el('mem-track'), 'psess-fold-bar');
    assert.equal(bars.length, 1, '应有一个 .psess-fold-bar');
    assert.equal(bars[0].children.filter((n) => n instanceof A.ctx.El).length, 1, '收起态只有一个子元素（汇总条）');
    assert.equal(A.byClass(bars[0], 'psess-mini-list').length, 0, '收起态不含 .psess-mini-list');
    assertNoBadText('推进事项关联会话（收起态）');
    const openBtn = A.byClass(bars[0], 'quiet-btn').find((b) => A.text(b).includes('展开'));
    assert.ok(openBtn, '应有展开按钮');
    await openBtn.click();
    await tick();
    bars = A.byClass(A.el('mem-track'), 'psess-fold-bar');
    assert.equal(bars.length, 1);
    const mini = A.byClass(bars[0], 'psess-mini-list');
    assert.equal(mini.length, 1, '展开态应出现 .psess-mini-list');
    assert.equal(A.byClass(mini[0], 'psess-mini-row').length, rows.length, '行数应等于 list 返回条数');
    assertNoBadText('推进事项关联会话（展开态）');
  });

  await test('推进事项详情：关联会话 0 条时折叠条仍只有一个子元素且无 mini-list', async () => {
    setFullState({ projects: [projectOf()] });
    A.ctx.mem0.list = async () => [];
    A.ev('window.mem0Ext.openMemory({ type: "project", id: "p1" })');
    await tick();
    const bars = A.byClass(A.el('mem-track'), 'psess-fold-bar');
    assert.equal(bars.length, 1);
    assert.equal(bars[0].children.filter((n) => n instanceof A.ctx.El).length, 1);
    assert.equal(A.byClass(bars[0], 'psess-mini-list').length, 0);
    assertNoBadText('推进事项关联会话（0 条）');
  });

  await test('设置页历史旧会话：count=0 与 37 两侧 data-unorganized 一致、文案/禁用符合规则、无裸文本', async () => {
    for (const n of [0, 37]) {
      setFullState({ ai: { ...baseState().ai, unorganizedCount: n } });
      A.ev('window.mem0Ext.renderAll()');
      const box = A.el('settings-ai');
      const ds = A.all(box).find((e) => e._cls && e._cls.has('ds') && e.attrs['data-unorganized'] !== undefined);
      const oldBtn = A.all(box).find((e) => e.tag === 'button' && e.attrs['data-unorganized'] !== undefined);
      assert.ok(ds, `count=${n} 应渲染左侧说明`);
      assert.ok(oldBtn, `count=${n} 应渲染整理按钮`);
      assert.equal(ds.attrs['data-unorganized'], oldBtn.attrs['data-unorganized'], '两侧 data-unorganized 必须相等');
      assert.equal(ds.attrs['data-unorganized'], String(n));
      const dsText = A.text(ds);
      const btnText = A.text(oldBtn);
      if (n === 0) {
        assert.ok(dsText.includes('没有待整理的历史会话'), dsText);
        assert.equal(btnText, '全部已整理');
        assert.equal(oldBtn.disabled, true, 'count=0 时按钮应禁用');
      } else {
        assert.ok(dsText.includes('37'), dsText);
        assert.equal(btnText, '整理旧对话 (20)');
        assert.equal(oldBtn.disabled, false, 'count>0 且已开启 AI 时按钮应可用');
      }
      const boxText = A.text(box);
      assert.ok(!(boxText.includes('没有待整理') && boxText.includes('整理旧对话 (')), `count=${n} 不应同时出现两种文案`);
      assertNoBadText(`设置页 AI 区（count=${n}）`);
    }
  });

  // ======================================================================
  section('11 主进程 / preload IPC 通道（SPEC 4.4 静态断言）');
  const indexSrc = read('src/main/index.js');
  const preloadSrc = read('src/preload/index.js');
  const ipcMethods = [
    ['state', 'state'], ['list', 'list'], ['search', 'search'], ['read', 'read'],
    ['updateConvMeta', 'updateConvMeta'], ['saveProject', 'saveProject'], ['deleteProject', 'deleteProject'],
    ['saveMemory', 'saveMemory'], ['moveMemory', 'moveMemory'], ['deleteMemory', 'deleteMemory'],
    ['batchImportMemories', 'batchImportMemories'], ['splitImportText', 'splitImportText'],
    ['saveAiConfig', 'saveAiConfig'], ['testAiConfig', 'testAiConfig'], ['organizeOld', 'organizeOld'],
    ['exportMemoryPack', 'exportMemoryPack'], ['importMemoryPack', 'importMemoryPack'],
  ];
  await test('preload 在 window.mem0 下暴露全部 v4 方法', () => {
    for (const [method] of ipcMethods) {
      assert.match(preloadSrc, new RegExp(`\\b${method}:`), `preload 缺 ${method}`);
    }
    for (const [, channel] of ipcMethods) assert.ok(preloadSrc.includes(`'${channel}'`), channel);
  });
  await test('index.js 注册全部 v4 IPC 通道，且每条都包在 guard(...) 里', () => {
    for (const [, channel] of ipcMethods) {
      assert.ok(indexSrc.includes(`ipcMain.handle('${channel}', guard(`), `通道 ${channel} 未经过 guard`);
    }
  });
  await test('fullState 扩展 projects / memories / memoryGroups / ai（ai 来自 getPublicState）', () => {
    assert.match(indexSrc, /projects:\s*store\.listProjects\(/);
    assert.match(indexSrc, /memories:\s*store\.listMemories\(/);
    assert.match(indexSrc, /memoryGroups:\s*memoryGroupMeta\(\)/);
    assert.match(indexSrc, /ai:\s*aiOrganizer\s*\?\s*aiOrganizer\.getPublicState\(\)/);
    // getPublicState 是唯一出口：index.js 不得自行拼出 apiKey 字段
    assert.doesNotMatch(indexSrc, /\bapiKey\s*:/);
  });
  await test('AiOrganizer 由主进程创建并 start / stop，MCP mutated 与整理完成都会推 changed', () => {
    assert.match(indexSrc, /new AiOrganizer\(\{\s*store,\s*electron\s*\}\)/);
    assert.match(indexSrc, /aiOrganizer\.start\(\)/);
    assert.match(indexSrc, /aiOrganizer\?\.stop\(\)/);
    assert.match(indexSrc, /ev\.on\('mutated',\s*\(\)\s*=>\s*push\('changed',\s*fullState\(\)\)\)/);
    assert.match(indexSrc, /organizer\.organizeConversation\s*=\s*async\s*\(id\)/);
    assert.match(indexSrc, /if \(result\) push\('changed', fullState\(\)\)/);
  });
  await test('记忆包导出 / 导入使用系统保存 / 打开对话框读写 JSON', () => {
    assert.match(indexSrc, /showSave\(\{/);
    assert.match(indexSrc, /showOpen\(\{/);
    assert.match(indexSrc, /fs\.writeFile\(picked\.filePath, JSON\.stringify\(pack, null, 2\), 'utf8'\)/);
    assert.match(indexSrc, /JSON\.parse\(await fs\.readFile\(picked\.filePaths\[0\], 'utf8'\)\)/);
  });

  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
  try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
