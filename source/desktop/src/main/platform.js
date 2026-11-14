'use strict';
/**
 * macOS 适配相关的纯函数（不依赖 Electron，供单测注入 platform）。
 * Windows / Linux 的行为保持不变。
 */
const path = require('node:path');

const isMac = (platform = process.platform) => platform === 'darwin';

/** macOS 用模板托盘图标（trayTemplate.png + @2x），其余平台沿用彩色 tray.png */
function trayIconPath({ dirname, rendererDir, platform = process.platform }) {
  return isMac(platform)
    ? path.join(dirname, 'assets', 'trayTemplate.png')
    : path.join(rendererDir, 'tray.png');
}

/** 只有 macOS 需要原生应用菜单；Windows / Linux 仍 removeMenu（无菜单） */
const needsAppMenu = (platform = process.platform) => isMac(platform);

/** macOS 应用菜单模板（关于 / 隐藏 / 退出等交给系统角色处理） */
function appMenuTemplate({ appName = 'mem0' } = {}) {
  return [
    {
      label: appName,
      submenu: [
        { role: 'about', label: `关于 ${appName}` },
        { type: 'separator' },
        { role: 'hide', label: `隐藏 ${appName}` },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: `退出 ${appName}`, accelerator: 'CmdOrCtrl+Q' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'close', label: '关闭窗口', accelerator: 'CmdOrCtrl+W' },
      ],
    },
  ];
}

/**
 * 用户主动退出（菜单退出 / ⌘Q / 托盘）时是否需要弹确认。
 * 系统关机 / 注销 / 重启（powerMonitor 'shutdown'）不弹窗阻挡。
 * @param {{ platform?: string, shutdown?: boolean }} p
 */
function shouldConfirmQuit({ platform = process.platform, shutdown = false } = {}) {
  if (!isMac(platform)) return false;
  if (shutdown) return false;
  return true;
}

/** 关掉主窗口后 macOS 隐藏 Dock 图标（只留菜单栏图标）；其余平台不动 Dock */
const shouldHideDock = (platform = process.platform) => isMac(platform);

/** 打开主窗口时 macOS 显示 Dock 图标；其余平台不处理 */
const shouldShowDock = (platform = process.platform) => isMac(platform);

module.exports = {
  isMac,
  trayIconPath,
  needsAppMenu,
  appMenuTemplate,
  shouldConfirmQuit,
  shouldHideDock,
  shouldShowDock,
};
