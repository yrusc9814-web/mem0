'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);
/** 订阅主进程推送，返回取消函数 */
const on = (ch) => (fn) => {
  const h = (_e, s) => fn(s);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld('mem0', {
  state: call('state'),
  list: call('list'),
  search: call('search'),
  /** 详情分页：{ tail } 取最近 N 条，或 { fromSeq, limit } 取指定区间（复制全文时分页取完） */
  read: (id, opts) => ipcRenderer.invoke('read', id, opts),
  remove: call('delete'),
  setSource: call('setSource'),
  rescan: call('rescan'),
  connectClient: call('connectClient'),
  disconnectClient: call('disconnectClient'),
  pairCode: call('pairCode'),
  revokeExtensions: call('revokeExtensions'),
  copy: call('copy'),
  setTheme: call('setTheme'),
  openDataDir: call('openDataDir'),
  changeDataDir: call('changeDataDir'),
  openUrl: call('openUrl'),
  onChanged: on('changed'),
  /** 主窗口：上报当前页面/会话，窗口被销毁重建后主进程按它恢复 */
  reportNav: (nav) => ipcRenderer.send('nav', nav),
  /** 主窗口：托盘小窗点某条活动后跳到「记录」页对应会话 { view, conversationId } */
  onNavigate: on('navigate'),
  /** 今日 MCP 被读取次数实时推送 { today } */
  onMcpCalls: on('mcp-calls'),
  /** 托盘小窗专用（主进程只接受来自小窗自身的 resize / hide / open / quit） */
  tray: {
    state: call('trayState'),
    rescan: call('trayRescan'),
    resize: call('trayResize'),
    hide: call('trayHide'),
    openMain: call('trayOpenMain'),
    openConversation: call('trayOpenConversation'),
    quit: call('trayQuit'),
    onState: on('tray-state'),
    /** 显示握手：主进程 show 前发 tray-prepare {token}，renderer 渲染好后回 ready(token, 面板高度) */
    ready: (token, height) => ipcRenderer.send('tray-ready', { token, height }),
    onPrepare: on('tray-prepare'),
    /** 小窗收起 / 将要显示：复位临时状态（如退出确认条） */
    onReset: on('tray-reset'),
  },
});
