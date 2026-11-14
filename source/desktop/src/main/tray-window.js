'use strict';
/**
 * 托盘快捷小窗（Tray Popover）。
 *
 * - 面板内容净宽 320px，窗口四周留 INSET 透明边距给 CSS 画圆角与柔和投影（hasShadow:false，不用系统阴影）。
 * - 高度由 renderer 用 ResizeObserver 量出面板高度后经 IPC 报告，这里 setBounds，面板内部不出现滚动条。
 * - 定位：tray.getBounds()（Linux 等可能宽高为 0 → 退回 screen.getCursorScreenPoint()），
 *   结合所在屏幕 display.workArea 判断任务栏在哪一边，贴近托盘并夹在工作区内。
 * - Windows 竞态：小窗展开时点托盘图标，系统先让小窗 blur（我们在 blur 里收起），随后才触发 tray 'click'；
 *   若 click 再走「未显示 → 显示」就会闪一下重新弹开。所以 blur 时记时间戳，BLUR_CLICK_GUARD_MS 内的 click 视为「收起」。
 * - 常驻内存：构造时不建窗口，首次 show/toggle 才按需创建；收起后 IDLE_DESTROY_MS 内没再打开就销毁窗口
 *   （面板高度等状态留在本对象上），下次 toggle/show 时按需重建；应该销毁与否由纯函数 shouldDestroyIdle 判断。
 *
 * 纯函数 computePosition / shouldIgnoreClick / shouldDestroyIdle 不依赖 Electron，供 test/ui-patch.js 单测。
 */
const PANEL_WIDTH = 320;
const INSET = 18;
const BLUR_CLICK_GUARD_MS = 300;
const DEFAULT_PANEL_HEIGHT = 420;
/** show() 等 renderer 回 tray-ready 的最长时间，超时直接按已知高度显示 */
const READY_TIMEOUT_MS = 150;
/** Windows：以透明度 0 显示后，等 renderer 画完两帧再亮出来的最长时间 */
const REVEAL_TIMEOUT_MS = 80;
/** 收起后多久没再打开就销毁小窗（省内存）；下次点托盘时重建 */
const IDLE_DESTROY_MS = 60_000;

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** blur 刚收起过（threshold 内）的 click 不再打开 */
function shouldIgnoreClick(lastBlurAt, now, threshold = BLUR_CLICK_GUARD_MS) {
  return Number.isFinite(lastBlurAt) && lastBlurAt > 0 && now - lastBlurAt >= 0 && now - lastBlurAt < threshold;
}

/** 收起后闲置到点（默认 60 秒）就该销毁：没收起过（hiddenAt<=0）、时钟回拨、还没到点都不销毁 */
function shouldDestroyIdle(hiddenAt, now, idleMs = IDLE_DESTROY_MS) {
  if (!Number.isFinite(hiddenAt) || hiddenAt <= 0 || !Number.isFinite(now)) return false;
  const idle = now - hiddenAt;
  return idle >= 0 && idle >= idleMs;
}

/**
 * 计算小窗窗口位置。
 * @param {{ trayBounds?: {x,y,width,height}, cursor?: {x,y}, workArea: {x,y,width,height}, width: number, height: number }} p
 * @returns {{ x: number, y: number, width: number, height: number, edge: string }}
 */
function computePosition({ trayBounds, cursor, workArea: wa, width, height }) {
  const validTray = trayBounds && trayBounds.width > 0 && trayBounds.height > 0;
  const a = validTray ? trayBounds : { x: (cursor && cursor.x) || 0, y: (cursor && cursor.y) || 0, width: 0, height: 0 };
  const h = Math.min(height, wa.height); // 再高也不超出工作区
  const w = Math.min(width, wa.width);
  const cx = a.x + a.width / 2;
  const cy = a.y + a.height / 2;
  let x; let y; let edge;
  if (cy >= wa.y + wa.height) { edge = 'bottom'; y = wa.y + wa.height - h; x = cx - w / 2; }          // 任务栏在下（Windows 默认）
  else if (cy <= wa.y) { edge = 'top'; y = wa.y; x = cx - w / 2; }                                    // 菜单栏 / 任务栏在上（macOS 向下弹出）
  else if (cx <= wa.x) { edge = 'left'; x = wa.x; y = cy - h / 2; }
  else if (cx >= wa.x + wa.width) { edge = 'right'; x = wa.x + wa.width - w; y = cy - h / 2; }
  else {
    // 锚点在工作区内（自动隐藏任务栏、托盘溢出区、或只拿到鼠标位置）：下半屏放上方，上半屏放下方
    edge = 'inside';
    x = cx - w / 2;
    y = cy > wa.y + wa.height / 2 ? a.y - h : a.y + a.height;
  }
  x = clamp(Math.round(x), wa.x, wa.x + wa.width - w);
  y = clamp(Math.round(y), wa.y, wa.y + wa.height - h);
  return { x, y, width: Math.round(w), height: Math.round(h), edge };
}

/** 与主窗口一致的安全配置 + 规范要求的无边框透明参数 */
function popoverOptions({ preload, platform = process.platform }) {
  const opts = {
    width: PANEL_WIDTH + INSET * 2,
    height: DEFAULT_PANEL_HEIGHT + INSET * 2,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    movable: false,
    title: 'mem0',
    // backgroundThrottling:false：隐藏状态下 renderer 也照常渲染，show 前的 tray-prepare 能立即量好高度
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, backgroundThrottling: false },
  };
  if (platform === 'win32') opts.thickFrame = false; // 避免系统画原生硬边框
  return opts;
}

class TrayPopover {
  /**
   * @param {{ electron: object, tray: object, preload: string, htmlPath: string, onShow?: Function, idleMs?: number }} o
   */
  constructor({ electron, tray, preload, htmlPath, onShow, platform = process.platform, idleMs = IDLE_DESTROY_MS }) {
    this.electron = electron;
    this.platform = platform;
    this.preload = preload;
    this.htmlPath = htmlPath;
    this.revealToken = 0;
    this.tray = tray;
    this.onShow = onShow || (() => {});
    this.lastBlurAt = 0;
    this.panelHeight = DEFAULT_PANEL_HEIGHT;
    this.allowClose = false;
    this.showToken = 0;
    this.pending = null; // { token, timer, resolve }：show 等待 renderer 就绪中
    this.hiddenAt = 0; // 上次收起的时刻（0 = 当前没收起过）
    this.idleMs = idleMs;
    this.idleTimer = null;
    this.disposed = false; // destroy() 之后不再重建
    this.win = null;
    const { ipcMain } = electron;
    // 显示握手：只接受来自本小窗自身的 tray-ready，且 token 必须是当前这次 show 的。
    // 小窗会被闲置销毁后重建，所以监听只注册一次，用 this.win 动态判断来源。
    this.ipcMain = ipcMain;
    this.onReady = (event, p) => {
      if (!this.alive || !event || event.sender !== this.win.webContents) return;
      if (!this.pending || !p || p.token !== this.pending.token) return;
      this.finishShow(p.height);
    };
    if (ipcMain && typeof ipcMain.on === 'function') ipcMain.on('tray-ready', this.onReady);
    // 不在构造时建窗口：首次 show/toggle 由 ensureWindow() 按需创建（省内存）
  }

  /** 创建（或闲置销毁后重建）小窗；所有与窗口绑定的监听都挂在这里 */
  createWindow() {
    const { BrowserWindow, shell } = this.electron;
    this.allowClose = false;
    this.lastBlurAt = 0;
    const win = new BrowserWindow(popoverOptions({ preload: this.preload, platform: this.platform }));
    this.win = win;
    win.removeMenu && win.removeMenu();
    if (this.platform === 'darwin') { try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { /* ignore */ } }
    try { win.setAlwaysOnTop(true, 'pop-up-menu'); } catch { /* ignore */ }
    win.loadFile(this.htmlPath);
    win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.on('blur', () => { if (win.isVisible()) { this.lastBlurAt = Date.now(); this.hide(); } });
    // Esc 在主进程兜底（renderer 也会处理），保证焦点在任何控件上都能收起
    win.webContents.on('before-input-event', (e, input) => { if (input.type === 'keyDown' && input.key === 'Escape') { e.preventDefault(); this.hide(); } });
    win.on('close', (e) => { if (!this.allowClose) { e.preventDefault(); this.hide(); } });
    // 刚建好的窗口：renderer 就绪前发的 tray-prepare 会丢，加载完补一次握手（若还在等）
    win.webContents.once('did-finish-load', () => { if (this.win === win && this.pending) this.handshake(); });
    return win;
  }

  get alive() { return !!this.win && !this.win.isDestroyed(); }
  isVisible() { return this.alive && this.win.isVisible(); }

  /** 小窗被闲置销毁后按需重建；destroy() 之后的常驻对象不再重建 */
  ensureWindow() {
    if (this.disposed) return false;
    if (!this.alive) this.createWindow();
    return this.alive;
  }

  /** 左键托盘：切换。窗口不存在/已被闲置销毁时先重建；处理 blur→click 竞态；show 等待中再点 = 取消这次显示 */
  toggle() {
    if (this.disposed) return Promise.resolve(false);
    if (this.pending) { this.cancelShow(); return Promise.resolve(false); }
    if (!this.ensureWindow()) return Promise.resolve(false);
    if (this.win.isVisible()) { this.hide(); return Promise.resolve(false); }
    if (shouldIgnoreClick(this.lastBlurAt, Date.now())) { this.lastBlurAt = 0; return Promise.resolve(false); }
    return this.show();
  }

  bounds() {
    const { screen } = this.electron;
    let trayBounds = null;
    try { trayBounds = this.tray.getBounds(); } catch { trayBounds = null; }
    const valid = trayBounds && trayBounds.width > 0 && trayBounds.height > 0;
    const cursor = screen.getCursorScreenPoint();
    const display = valid ? screen.getDisplayMatching(trayBounds) : screen.getDisplayNearestPoint(cursor);
    return computePosition({
      trayBounds: valid ? trayBounds : null, cursor, workArea: display.workArea,
      width: PANEL_WIDTH + INSET * 2, height: Math.ceil(this.panelHeight) + INSET * 2,
    });
  }

  reposition() {
    if (!this.alive) return;
    const b = this.bounds();
    this.win.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height }, false);
  }

  /** show 前让 renderer 复位并渲染最新数据（tray-reset → tray-state → tray-prepare{token}），等它回 tray-ready */
  handshake() {
    const p = this.pending;
    if (!p || !this.alive) return;
    this.send('tray-reset');
    try { this.onShow(); } catch { /* ignore */ }
    if (this.pending && this.pending.token === p.token) this.send('tray-prepare', { token: p.token });
  }

  /**
   * 无闪烁显示：先让 renderer 复位并渲染好最新数据，等它回 tray-ready {token, height}（最多 READY_TIMEOUT_MS），
   * 按真实高度定位后再 show+focus。窗口被闲置销毁时按需重建（面板高度仍沿用本对象记住的值）。
   * @returns {Promise<boolean>} 是否真的显示了
   */
  show() {
    if (this.disposed) return Promise.resolve(false);
    if (!this.ensureWindow()) return Promise.resolve(false);
    this.cancelIdleDestroy(); // 又要打开了：清掉闲置销毁定时器
    if (this.win.isVisible()) return Promise.resolve(true);
    if (this.pending) this.cancelShow();
    const token = ++this.showToken;
    return new Promise((resolve) => {
      this.pending = { token, resolve, timer: setTimeout(() => this.finishShow(null), READY_TIMEOUT_MS) };
      this.handshake();
    });
  }

  finishShow(height) {
    const p = this.pending;
    if (!p) return;
    clearTimeout(p.timer);
    this.pending = null;
    if (!this.alive) { p.resolve(false); return; }
    const n = Number(height);
    if (Number.isFinite(n) && n > 0) this.panelHeight = Math.min(Math.ceil(n), 2000);
    this.reposition();
    if (this.platform === 'win32') {
      // Windows 会给新显示的窗口播放系统弹出动画，并可能先贴出上次隐藏时缓存的画面，
      // 看起来就是「整个卡片弹一下」。先以透明度 0 显示，等 renderer 在可见状态下画完两帧再亮出来。
      // 新建的窗口同样走这里，防闪逻辑一致。
      const reveal = ++this.revealToken;
      try { this.win.setOpacity(0); } catch { /* ignore */ }
      this.win.show();
      this.win.focus();
      const done = () => {
        if (reveal !== this.revealToken || !this.isVisible()) return;
        this.revealToken += 1;
        try { this.win.setOpacity(1); } catch { /* ignore */ }
      };
      setTimeout(done, REVEAL_TIMEOUT_MS);
      try {
        Promise.resolve(this.win.webContents.executeJavaScript(
          'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))', true,
        )).then(done, done);
      } catch { /* 超时兜底 */ }
    } else {
      this.win.show();
      this.win.focus();
    }
    p.resolve(true);
  }

  cancelShow() {
    const p = this.pending;
    if (!p) return;
    clearTimeout(p.timer);
    this.pending = null;
    p.resolve(false);
  }

  hide() {
    this.cancelShow();
    if (this.isVisible()) {
      this.revealToken += 1; // 作废还没亮出来的 reveal
      if (this.platform === 'win32') { try { this.win.setOpacity(0); } catch { /* ignore */ } }
      this.win.hide();
      this.send('tray-reset');
    }
    // 收起后开始计时：期间没再打开就销毁小窗
    if (this.alive) this.scheduleIdleDestroy();
    else this.clearIdleDestroy();
  }

  /** 收起后启动闲置销毁定时器（到点仍未再打开 → 销毁窗口，本对象保留供下次重建） */
  scheduleIdleDestroy() {
    this.hiddenAt = Date.now();
    this.clearIdleTimer();
    const tick = () => {
      this.idleTimer = null;
      if (this.disposed || this.isVisible() || this.pending) return;
      const now = Date.now();
      if (!shouldDestroyIdle(this.hiddenAt, now, this.idleMs)) {
        // setTimeout 偶尔会比 Date.now() 早约 1ms 触发：还没到点就按剩余时间重排（至少 1ms），
        // 否则这一次检查后直接 return，窗口就再也不会被销毁了。
        this.armIdleTimer(Math.max(1, this.idleMs - (now - this.hiddenAt)), tick);
        return;
      }
      this.closeWindow();
    };
    this.armIdleTimer(this.idleMs, tick);
  }

  /** 排一次闲置检查定时器；unref，不阻塞退出 */
  armIdleTimer(ms, tick) {
    this.idleTimer = setTimeout(tick, ms);
    if (this.idleTimer && typeof this.idleTimer.unref === 'function') this.idleTimer.unref();
  }

  clearIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** 清掉闲置销毁定时器（又要打开 / 销毁窗口时调用），并记成「当前没收起过」 */
  clearIdleDestroy() {
    this.clearIdleTimer();
    this.hiddenAt = 0;
  }

  /** 语义同上：显示前取消这次闲置销毁 */
  cancelIdleDestroy() {
    this.clearIdleDestroy();
  }

  /** 只销毁小窗（对象保留，下次 toggle/show 重建）；退出时用 destroy() */
  closeWindow() {
    this.cancelShow();
    this.clearIdleDestroy();
    this.allowClose = true;
    const w = this.win;
    this.win = null;
    if (w && !w.isDestroyed()) w.destroy();
  }

  /** renderer 报告面板高度（CSS px，不含 INSET） */
  setPanelHeight(h) {
    const n = Number(h);
    if (!Number.isFinite(n) || n <= 0) return;
    const next = Math.min(Math.ceil(n), 2000);
    if (next === Math.ceil(this.panelHeight)) return;
    this.panelHeight = next;
    if (this.isVisible()) this.reposition();
    else if (this.alive) {
      const [w] = this.win.getSize();
      this.win.setSize(w, next + INSET * 2);
    }
  }

  send(channel, payload) { if (this.alive) this.win.webContents.send(channel, payload); }

  destroy() {
    this.disposed = true;
    this.cancelShow();
    this.clearIdleDestroy();
    if (this.ipcMain && typeof this.ipcMain.removeListener === 'function') this.ipcMain.removeListener('tray-ready', this.onReady);
    this.allowClose = true;
    const w = this.win;
    this.win = null;
    if (w && !w.isDestroyed()) w.destroy();
  }
}

module.exports = { TrayPopover, computePosition, shouldIgnoreClick, shouldDestroyIdle, popoverOptions, PANEL_WIDTH, INSET, BLUR_CLICK_GUARD_MS, READY_TIMEOUT_MS, REVEAL_TIMEOUT_MS, IDLE_DESTROY_MS };
