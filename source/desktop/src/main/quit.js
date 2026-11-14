'use strict';
/**
 * 退出清理（不依赖 Electron，供单测）：各项清理并行执行，整体限时；
 * 无论是否超时都调用 exit(0)，保证进程不会卡在退出流程里。
 */
const QUIT_CLEANUP_TIMEOUT_MS = 3000;

async function cleanupForQuit({ tasks, timeoutMs = QUIT_CLEANUP_TIMEOUT_MS, exit }) {
  const jobs = (tasks || []).filter((f) => typeof f === 'function')
    .map((f) => Promise.resolve().then(f).catch(() => { /* 单项失败不阻塞退出 */ }));
  let timer = null;
  try {
    await Promise.race([
      Promise.all(jobs),
      new Promise((r) => { timer = setTimeout(r, timeoutMs); if (timer.unref) timer.unref(); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (typeof exit === 'function') exit(0);
}

module.exports = { cleanupForQuit, QUIT_CLEANUP_TIMEOUT_MS };
