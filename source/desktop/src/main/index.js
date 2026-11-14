'use strict';
const path = require('node:path');
const electron = require('electron');
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, nativeTheme, shell, clipboard, dialog } = electron;
const { dataDir, dataDirSource, setPointerFile, getPointerFile, sourceRoots } = require('./paths');
const datamove = require('./datamove');
const { Store, LOCAL_SOURCES, WEB_SOURCES } = require('./db');
const { LocalIngestor } = require('./ingest');
// ./mcp（MCP SDK + zod，冷启动约 400ms）和 ./bridge（ws）在窗口出来后才 require，见 startServices()
const { TrayPopover } = require('./tray-window');
const { TrayStats } = require('./stats');
const register = require('./register');
const platform = require('./platform');
const { cleanupForQuit } = require('./quit');

const VERSION = app.getVersion();
// Windows 任务栏图标/分组需要与 build.appId 一致的 AppUserModelId
if (process.platform === 'win32') app.setAppUserModelId('dev.mem0.desktop');
const APP_ICON = path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');

// 单实例
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let win = null;
let tray = null;
let popover = null;
let store, ingestor, mcp, bridge, trayStats;
let quitting = false;
let quitCleanupStarted = false; // 退出清理只跑一次（防重入）
let quitConfirmed = false; // macOS 用户已确认退出
let quitDialogOpen = false; // 退出确认框是否正开着（再按 ⌘Q 不重复弹）
let systemShuttingDown = false; // 系统关机 / 注销 / 重启，不弹确认
// 主窗口当前页面/会话（renderer 通过 'nav' 上报，托盘跳转也会记下）；窗口销毁重建后按它恢复
let lastNav = null;
const PRELOAD = path.join(__dirname, '..', 'preload', 'index.js');
const RENDERER = path.join(__dirname, '..', 'renderer');

/** 彻底退出：标记后不再重建窗口、托盘小窗直接销毁 */
function quitApp() {
  quitting = true;
  app.isQuitting = true;
  if (popover) popover.destroy();
  app.quit();
}

/** 退出清理：各项并行，整体最多 3 秒（QUIT_CLEANUP_TIMEOUT_MS）；结束后（含超时）强制退出 */
const runQuitCleanup = () => cleanupForQuit({
  tasks: [
    // 数据库最后关：等扫描、MCP、桥接都收尾后再关，避免在途扫描写到已关闭的库
    async () => {
      await Promise.allSettled([ingestor?.stopAndWait(), mcp?.close(), bridge?.close()]);
      if (store && !storeClosed) { storeClosed = true; store.close(); }
    },
  ],
  exit: (code) => app.exit(code),
});

/** macOS 应用菜单（仅菜单栏）；Windows/Linux 无菜单 */
function setupAppMenu() {
  if (!platform.needsAppMenu()) return;
  Menu.setApplicationMenu(Menu.buildFromTemplate(platform.appMenuTemplate({ appName: 'mem0' })));
}
// starting=true：服务还没开始/正在启动（窗口先出来，服务随后并行启动），这期间不算异常
const services = { mcp: { ok: false, starting: true, error: null, url: null }, bridge: { ok: false, starting: true, error: null, url: null } };
/** 服务异常 = 启动结束了但没起来；启动中不算 */
const serviceDown = (s) => !s.ok && !s.starting;

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 820,
    minHeight: 520,
    title: 'mem0',
    icon: APP_ICON,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#262624' : '#FAF9F5',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  const w = win;
  w.removeMenu();
  w.loadFile(path.join(RENDERER, 'index.html'));
  // 先隐藏、加载好再显示（背景色与主题一致），避免白屏闪
  w.once('ready-to-show', () => { if (w.isDestroyed()) return; w.show(); w.focus(); });
  // 外链一律用系统浏览器打开
  w.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  // 重建的窗口：加载完按主进程记住的页面/会话恢复（首次创建时 lastNav 为空，不恢复）
  w.webContents.once('did-finish-load', () => { if (lastNav) push('navigate', lastNav); });
  // 点关闭 = 真正销毁窗口（省内存）；托盘常驻，后台备份不受影响，下次 openMain 重建
  w.on('closed', () => {
    if (win === w) win = null;
    // macOS：关掉主窗口后只留菜单栏图标，隐藏 Dock
    if (platform.shouldHideDock() && app.dock) app.dock.hide();
  });
}

/** 主窗口的 webContents：窗口不存在或已销毁时为 null（所有向主窗口 send 的地方都先经过它） */
const mainWc = () => (win && !win.isDestroyed() ? win.webContents : null);

/** 原生对话框：主窗口还在就用它做父窗口，已销毁时退回无父窗口调用 */
const showBox = (opts) => (win && !win.isDestroyed() ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts));
const showOpen = (opts) => (win && !win.isDestroyed() ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts));

/** 规整 renderer 上报的页面/会话，脏数据一律丢弃 */
function sanitizeNav(nav) {
  if (!nav || typeof nav !== 'object') return null;
  const view = typeof nav.view === 'string' ? nav.view.slice(0, 32) : '';
  if (!view) return null;
  return { view, conversationId: nav.conversationId == null ? '' : String(nav.conversationId).slice(0, 128) };
}

function createTray() {
  // macOS：模板图标 trayTemplate.png（16pt）+ 同目录 trayTemplate@2x.png 自动作为 2x 表示，
  // setTemplateImage(true) 让系统按深/浅色菜单栏自动反色。
  // Windows/Linux：沿用彩色 tray.png（同目录 tray@2x.png 为 2x 表示）。
  const mac = platform.isMac();
  const iconPath = platform.trayIconPath({ dirname: __dirname, rendererDir: RENDERER });
  const icon = nativeImage.createFromPath(iconPath);
  if (mac) {
    try { icon.setTemplateImage(true); } catch { /* ignore */ }
  }
  const TRAY = 16;
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty()
    : mac || icon.getSize().width === TRAY ? icon : icon.resize({ width: TRAY, height: TRAY, quality: 'best' }));
  tray.setToolTip('mem0 · 正在备份 AI 对话');
  // 右键：极简原生菜单兜底。不用 setContextMenu —— 那样在 macOS 上左键也会弹菜单，抢掉小窗
  const menu = Menu.buildFromTemplate([
    { label: '打开 mem0', click: () => openMain() },
    { type: 'separator' },
    { label: '退出', click: () => quitApp() },
  ]);
  popover = new TrayPopover({
    electron, tray, preload: PRELOAD, htmlPath: path.join(RENDERER, 'tray.html'),
    onShow: () => popover.send('tray-state', trayState()),
  });
  // 左键：只切换托盘小窗，不直接弹主窗口
  tray.on('click', () => popover.toggle());
  tray.on('right-click', () => { popover.hide(); tray.popUpContextMenu(menu); });
  // Linux（AppIndicator）多数桌面不发 click / right-click 事件，只能挂原生菜单
  if (process.platform === 'linux') tray.setContextMenu(menu);
}

/** 打开并聚焦完整主窗口；新建的窗口等 ready-to-show 再显示（show:false 防白屏闪） */
function openMain() {
  if (platform.shouldShowDock() && app.dock) app.dock.show();
  if (!win || win.isDestroyed()) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** 托盘小窗数据：今日备份 / 今日互通 / 最近 4 条 / 同步状态 */
function trayState() {
  const snap = trayStats ? trayStats.snapshot({ limit: 4 }) : { todayMessages: 0, mcpCallsToday: 0, recent: [] };
  const local = ingestor ? ingestor.getStatus() : [];
  const errors = local.filter((x) => x.enabled && x.error).length + (serviceDown(services.mcp) ? 1 : 0) + (serviceDown(services.bridge) ? 1 : 0);
  const lastScan = Math.max(0, ...local.map((x) => x.lastScanAt || 0));
  return { ...snap, errors, lastSyncAt: lastScan || Date.now(), scanning: !!(ingestor && ingestor.running) };
}
const pushTray = () => { if (popover) popover.send('tray-state', trayState()); };
const mcpCallsToday = () => (trayStats ? trayStats.mcpCallsToday() : 0);

const push = (channel, payload) => { const wc = mainWc(); if (wc) wc.send(channel, payload); };
const pushAll = (channel, payload) => { push(channel, payload); if (popover) popover.send(channel, payload); };

function fullState() {
  const mcpUrl = services.mcp.url;
  return {
    version: VERSION,
    dataDir: dataDir(),
    dataDirSource: dataDirSource(),
    stats: store.stats(),
    localSources: ingestor.getStatus(),
    webSources: WEB_SOURCES.map((p) => ({ id: `${p}-web`, platform: p, enabled: store.isSourceEnabled(`${p}-web`) })),
    services,
    bridge: bridge ? bridge.status() : { connected: 0, paired: 0 },
    clients: mcpUrl ? register.listClients(mcpUrl) : [],
    manualConfig: mcpUrl ? register.manualConfig(mcpUrl) : '',
    mcpCallsToday: mcpCallsToday(),
  };
}

function registerIpc() {
  // 所有 IPC 只接受来自本应用页面的调用
  const guard = (fn) => (event, ...args) => {
    if (!event.senderFrame || !event.senderFrame.url.startsWith('file://')) throw new Error('forbidden');
    return fn(...args);
  };
  ipcMain.handle('state', guard(() => fullState()));
  ipcMain.handle('list', guard((opts) => store.listConversations(opts || {})));
  ipcMain.handle('search', guard((q, opts) => store.search(q, opts || {})));
  // 详情页只读最近 N 条（tail），翻页/复制全文按 seq 区间读（fromSeq/limit）
  ipcMain.handle('read', guard((id, opts) => {
    const o = opts || {};
    if (o.tail > 0) {
      const n = Math.min(Math.floor(o.tail), 2000);
      const meta = store.getConversation(id, { limit: 0 }); // 只取会话元数据，不读正文
      if (!meta) return null;
      // 最近一页：fromSeq = max(0, message_count - n)
      const fromSeq = Math.max(0, (meta.message_count || 0) - n);
      return store.getConversation(id, { fromSeq, limit: n });
    }
    if (o.fromSeq !== undefined || o.limit !== undefined) {
      const fromSeq = Math.max(0, Math.floor(o.fromSeq) || 0);
      const limit = Math.min(Math.max(1, Math.floor(o.limit) || 200), 2000);
      return store.getConversation(id, { fromSeq, limit });
    }
    return store.getConversation(id, { limit: 2000 });
  }));
  ipcMain.handle('delete', guard(async (id) => {
    const { response } = await showBox({ type: 'warning', buttons: ['删除', '取消'], defaultId: 1, cancelId: 1, message: '从 mem0 删除这个会话？', detail: '只删除本地备份，不影响原平台。若原会话之后有新消息，会被重新备份。' });
    if (response !== 0) return false;
    store.deleteConversation(id);
    return true;
  }));
  ipcMain.handle('setSource', guard((source, enabled) => { store.setSourceEnabled(source, !!enabled); if (enabled && LOCAL_SOURCES.includes(source)) ingestor.scanOnce(); return fullState(); }));
  ipcMain.handle('rescan', guard(async () => { await ingestor.scanOnce(); return fullState(); }));
  ipcMain.handle('connectClient', guard((id) => { if (services.mcp.url) register.connectClient(id, services.mcp.url); return fullState(); }));
  ipcMain.handle('disconnectClient', guard((id) => { register.disconnectClient(id); return fullState(); }));
  ipcMain.handle('pairCode', guard(() => bridge ? bridge.newPairCode() : null));
  ipcMain.handle('revokeExtensions', guard(() => { bridge && bridge.revokeAll(); return fullState(); }));
  ipcMain.handle('setTheme', guard((pref) => {
    const p = ['light', 'dark'].includes(pref) ? pref : 'system';
    store.setKv('theme', p);
    nativeTheme.themeSource = p;
    if (win && !win.isDestroyed()) win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#262624' : '#FAF9F5');
    return p;
  }));
  ipcMain.handle('copy', guard((text) => { clipboard.writeText(String(text)); return true; }));
  ipcMain.handle('openDataDir', guard(() => shell.openPath(dataDir())));
  ipcMain.handle('changeDataDir', guard(() => changeDataDir()));
  ipcMain.handle('openUrl', guard((url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); }));
  // renderer 上报当前页面/会话：主窗口被销毁重建后按它恢复
  ipcMain.on('nav', (event, nav) => {
    if (!event.senderFrame || !event.senderFrame.url.startsWith('file://')) return;
    lastNav = sanitizeNav(nav);
  });

  // ---------- 托盘小窗 ----------
  // 需要知道调用方窗口的通道：只接受托盘小窗自己的 webContents
  const fromPopover = (fn) => (event, ...args) => {
    if (!event.senderFrame || !event.senderFrame.url.startsWith('file://')) throw new Error('forbidden');
    if (!popover || !popover.alive || event.sender !== popover.win.webContents) throw new Error('forbidden');
    return fn(...args);
  };
  ipcMain.handle('trayState', guard(() => trayState()));
  ipcMain.handle('trayRescan', guard(async () => { await ingestor.scanOnce(); push('changed', fullState()); return trayState(); }));
  ipcMain.handle('trayResize', fromPopover((h) => { popover.setPanelHeight(h); return true; }));
  ipcMain.handle('trayHide', fromPopover(() => { popover.hide(); return true; }));
  ipcMain.handle('trayOpenMain', fromPopover(() => { popover.hide(); openMain(); return true; }));
  ipcMain.handle('trayOpenConversation', fromPopover((id) => {
    popover.hide();
    openMain();
    const nav = { view: 'records', conversationId: String(id || '') };
    lastNav = nav;
    // 主窗口还在加载时不直接发：加载完由 createWindow 的 did-finish-load 按 lastNav 恢复
    const wc = mainWc();
    if (wc && !wc.isLoading()) push('navigate', nav);
    return true;
  }));
  ipcMain.handle('trayQuit', fromPopover(() => { quitApp(); return true; }));
}

/** 重启：免安装版 / AppImage 用外层可执行文件，其余照旧 app.relaunch() */
function relaunchApp() {
  const opts = datamove.relaunchOptions(process.env, process.execPath, process.argv);
  if (opts) app.relaunch(opts); else app.relaunch();
}

/** 设置 → 数据目录 → 更改：选文件夹 → 确认 → 停服务、关库 → 复制核对 → 写指针 → 重启。旧目录保留 */
let movingData = false;
let storeClosed = false;
async function changeDataDir() {
  if (movingData) return { ok: false, error: '正在搬迁中' };
  if (process.env.MEM0_DATA_DIR) {
    await showBox({ type: 'info', buttons: ['好'], message: '数据目录现在由环境变量 MEM0_DATA_DIR 指定', detail: '请先删除这个环境变量并重启 mem0，再在这里更改。' });
    return { ok: false, error: 'env' };
  }
  const current = dataDir();
  const pick = await showOpen({ title: '选择新的数据目录', buttonLabel: '选择', properties: ['openDirectory', 'createDirectory', 'promptToCreate'] });
  if (pick.canceled || !pick.filePaths || !pick.filePaths[0]) return { ok: false, error: 'canceled' };
  const plan = datamove.planTarget(current, pick.filePaths[0]);
  if (!plan.ok) {
    await showBox({ type: 'warning', buttons: ['好'], message: '不能用这个文件夹', detail: plan.error });
    return { ok: false, error: plan.error };
  }
  const reuse = plan.mode === 'use-existing';
  const { response } = await showBox(reuse ? {
    type: 'question', buttons: ['改用那里的数据', '取消'], defaultId: 0, cancelId: 1,
    message: '这个文件夹里已经有 mem0 数据',
    detail: `改用 ${plan.target} 里的数据？\n当前数据不会搬过去，也不会删除。mem0 会自动重启。`,
  } : {
    type: 'question', buttons: ['开始搬迁', '取消'], defaultId: 0, cancelId: 1,
    message: '把数据搬到新位置？',
    detail: `从 ${current}\n到 ${plan.target}\n\n搬迁时会暂停备份，完成后 mem0 自动重启。旧文件夹会保留，确认没问题后可以自己删掉。`,
  });
  if (response !== 0) return { ok: false, error: 'canceled' };

  movingData = true;
  ingestor && ingestor.stop();
  try { await mcp?.close(); } catch { /* ignore */ }
  try { await bridge?.close(); } catch { /* ignore */ }
  mcp = null; bridge = null;
  if (store && !storeClosed) { storeClosed = true; try { store.close(); } catch { /* ignore */ } }
  let detail;
  try {
    if (!reuse) {
      const r = datamove.copyData(current, plan.target);
      detail = `已复制 ${r.files} 个文件（${(r.bytes / 1048576).toFixed(1)} MB）到 ${plan.target}。\n旧文件夹 ${current} 已保留，确认没问题后可以自己删掉。`;
    } else {
      detail = `已改用 ${plan.target} 里的数据。`;
    }
    datamove.writePointer(getPointerFile(), plan.target);
  } catch (e) {
    await showBox({ type: 'error', buttons: ['重启 mem0'], message: '搬迁失败，数据仍在原位置', detail: String(e.message || e) });
    relaunchApp(); quitApp();
    return { ok: false, error: String(e.message || e) };
  }
  await showBox({ type: 'info', buttons: ['重启 mem0'], message: reuse ? '已切换数据目录' : '搬迁完成', detail });
  relaunchApp(); quitApp();
  return { ok: true };
}

/** 启动阶段计时：距进程启动的毫秒数 */
const bootLog = (phase) => console.log(`[boot] ${phase} +${Math.round(performance.now())}ms`);
const FIRST_SCAN_DELAY_MS = 1500;

/** MCP 与插件桥并行启动；不阻塞窗口。结束后推一次最新状态 */
async function startServices(saved, changed) {
  bootLog('services start');
  const mcpModule = require('./mcp');
  const { startBridge } = require('./bridge');
  bootLog('services modules loaded');
  // 今日互通：mcp.js 每次工具成功调用 emit('call', { today })。模块尚未提供 mcpEvents 时跳过（计数恒为 0）
  const ev = mcpModule.mcpEvents;
  if (ev && typeof ev.on === 'function') {
    ev.on('call', (p) => {
      const today = p && Number.isFinite(Number(p.today)) ? Number(p.today) : mcpCallsToday();
      pushAll('mcp-calls', { today });
    });
  }
  const startMcp = mcpModule.startMcpServer(store, { version: VERSION }).then((m) => {
    mcp = m;
    Object.assign(services.mcp, { ok: true, url: m.url });
  }, (e) => {
    services.mcp.error = e.code === 'EADDRINUSE' ? '端口 3790 被占用' : String(e.message);
  }).finally(() => { services.mcp.starting = false; bootLog(`mcp ${services.mcp.ok ? 'ready' : 'failed'}`); });
  const startBr = startBridge(store, { version: VERSION, onSaved: (e) => { saved(e); changed(); }, onStatus: changed }).then((b) => {
    bridge = b;
    Object.assign(services.bridge, { ok: true, url: b.url });
  }, (e) => {
    services.bridge.error = e.code === 'EADDRINUSE' ? '端口 3791 被占用' : String(e.message);
  }).finally(() => { services.bridge.starting = false; bootLog(`bridge ${services.bridge.ok ? 'ready' : 'failed'}`); });
  await Promise.all([startMcp, startBr]);
  // 退出过程中服务才起来：立即关掉，避免端口残留
  if (quitting) { try { await mcp?.close(); await bridge?.close(); } catch { /* ignore */ } return; }
  push('changed', fullState());
  pushTray();
}

async function boot() {
  bootLog('app ready');
  try { setPointerFile(path.join(app.getPath('userData'), 'data-location.json')); } catch (e) { console.error('[boot] userData', e.message); }
  store = Store.open(dataDir());
  bootLog('store opened');
  ingestor = new LocalIngestor(store, sourceRoots());
  trayStats = new TrayStats(store);
  let refresh = null;
  const changed = () => { clearTimeout(refresh); refresh = setTimeout(() => { push('changed', fullState()); pushTray(); }, 500); };
  // 每次备份的增量记到 ui_ingest_log，用于小窗「存入 X 条新消息」
  const saved = (e) => { if (e && e.conversationId) trayStats.recordIngest(e); };
  ingestor.on('saved', saved);
  ingestor.on('changed', changed);
  ingestor.on('error', (e) => console.error('[ingest]', e.file || '', e.message));

  const savedTheme = store.getKv('theme');
  if (savedTheme === 'light' || savedTheme === 'dark') nativeTheme.themeSource = savedTheme;

  registerIpc();
  setupAppMenu();
  createWindow();
  bootLog('window created');
  createTray();
  bootLog('tray created');

  // 主窗口页面加载完（首个 state 已可取）后再起服务和首轮扫描，不和窗口抢主线程
  let afterLoadDone = false;
  const afterLoad = () => {
    if (afterLoadDone) return;
    afterLoadDone = true;
    startServices(saved, changed).catch((e) => console.error('[boot] services', e));
    ingestor.once('scanned', (r) => bootLog(`first scan done (${r.changed} changed, ${r.ms}ms)`));
    setTimeout(() => { if (!quitting) { bootLog('first scan start'); ingestor.start(); } }, FIRST_SCAN_DELAY_MS);
  };
  const firstWin = win;
  firstWin.once('ready-to-show', () => bootLog('window ready-to-show'));
  firstWin.webContents.once('did-finish-load', () => { bootLog('renderer did-finish-load'); afterLoad(); });
  // 兜底：页面迟迟不加载（或加载失败）也要把服务和备份跑起来
  setTimeout(afterLoad, 5000);
}

// macOS：系统关机 / 注销 / 重启时不弹退出确认
try { electron.powerMonitor.on('shutdown', () => { systemShuttingDown = true; }); } catch { /* ignore */ }
app.on('second-instance', () => { if (popover) popover.hide(); openMain(); });
app.on('window-all-closed', (e) => e.preventDefault());
app.on('before-quit', async (e) => {
  // macOS 用户主动退出（⌘Q / 菜单）：先确认；托盘「退出」已明确点过，不再二次确认
  if (platform.shouldConfirmQuit({ shutdown: systemShuttingDown }) && !quitConfirmed && !quitting) {
    e.preventDefault();
    if (quitDialogOpen) return; // 确认框已开着：再按 ⌘Q 不重复弹，也不直接退出
    quitDialogOpen = true;
    try {
      const { response } = await showBox({
        type: 'question', buttons: ['退出', '取消'], defaultId: 1, cancelId: 1,
        message: '退出后将停止后台备份和 MCP 服务，确定退出？',
      });
      if (response === 0) { quitConfirmed = true; quitApp(); }
    } finally {
      quitDialogOpen = false;
    }
    return;
  }
  quitting = true;
  app.isQuitting = true;
  if (popover) popover.destroy();
  // 第一次进入：拦下本次退出，清理（最多 3 秒）结束后再真正退出
  if (!quitCleanupStarted) {
    quitCleanupStarted = true;
    e.preventDefault();
    runQuitCleanup();
  }
});
app.whenReady().then(boot).catch((e) => { dialog.showErrorBox('mem0 启动失败', String(e.stack || e)); app.quit(); });
