'use strict';
/**
 * Windows 开机静默自启动（AC1.1）：只负责系统登录项读写，平台 / 打包态 / 便携版判断都在这里，
 * app / platform / env / execPath 可注入，方便单测。
 *
 * 注意：getLoginItemSettings 必须与 setLoginItemSettings 传完全同构的 { path, args }，
 * 不传 args 查询恒为 false。
 */
const HIDDEN_ARG = '--hidden';
const UNSUPPORTED_REASON = '仅在 Windows 安装版中生效';

/** 启动参数（process.argv / second-instance 的 argv）里是否含 --hidden */
function hasHiddenFlag(argv) {
  return Array.isArray(argv) && argv.includes(HIDDEN_ARG);
}

function createAutoLaunch({ app, platform = process.platform, env = process.env, execPath = process.execPath } = {}) {
  const supported = platform === 'win32';
  const params = { path: execPath, args: [HIDDEN_ARG] };
  // 未打包开发态与便携版执行文件位置不稳定，不写注册表
  const installable = () => supported && !!(app && app.isPackaged) && !(env && env.PORTABLE_EXECUTABLE_FILE);

  /** 读当前登录项；不可安装 / 不可读时一律视为关闭（默认关闭） */
  function enabled() {
    if (!installable()) return false;
    try {
      const res = app.getLoginItemSettings(params) || {};
      return Boolean(res.openAtLogin && res.executableWillLaunchAtLogin !== false);
    } catch { return false; }
  }

  function get() {
    return { supported, enabled: enabled() };
  }

  /** 切换：写后回读校验，返回最终状态与失败原因（前端开关回弹 + toast） */
  function set(next) {
    const on = !!next;
    if (!installable()) {
      // 关闭在不可安装环境里本就是既成事实；开启则明确拒绝
      return { supported, enabled: false, ok: !on, reason: on ? UNSUPPORTED_REASON : '' };
    }
    try {
      app.setLoginItemSettings({ openAtLogin: on, ...params });
    } catch (e) {
      return { supported: true, enabled: enabled(), ok: false, reason: `写入系统登录项失败：${String((e && e.message) || e)}` };
    }
    const saved = enabled();
    return { supported: true, enabled: saved, ok: saved === on, reason: saved === on ? '' : '系统未确认自启动设置，请稍后重试' };
  }

  return { supported, get, set };
}

module.exports = { createAutoLaunch, hasHiddenFlag, UNSUPPORTED_REASON, HIDDEN_ARG };