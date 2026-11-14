/*
 * 后台 Service Worker：收内容脚本的快照 → 交给 BridgeClient 发往桌面端。
 * MV3 的 Service Worker 会被回收；WebSocket 每 20 秒 ping 一次可保持存活（Chrome 116+），
 * 另外每分钟用 alarm 检查一次连接，桌面端晚开也能自动连上并补发。
 */
import { BridgeClient } from './bridge-client.js';

const storage = {
  get: (keys) => chrome.storage.local.get(keys),
  set: (obj) => chrome.storage.local.set(obj),
  remove: (keys) => chrome.storage.local.remove(keys),
};

const client = new BridgeClient({
  WebSocket,
  storage,
  extensionId: chrome.runtime.id,
  version: chrome.runtime.getManifest().version,
  onStatus: (s) => {
    chrome.storage.session.set({ bridge: s }).catch(() => {});
    const badge = s.state === 'connected' ? '' : s.state === 'need_pair' ? '!' : '×';
    chrome.action.setBadgeText({ text: badge });
    chrome.action.setBadgeBackgroundColor({ color: s.state === 'need_pair' ? '#f59e0b' : '#ef4444' });
  },
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || typeof msg !== 'object') return;
  // 只接受本扩展自己的页面和内容脚本
  if (sender.id !== chrome.runtime.id) return;
  if (msg.type === 'capture' && sender.tab) {
    client.enqueue(msg.conversation).then(() => reply({ ok: true }), (e) => reply({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'status') {
    Promise.all([storage.get(['stats', 'paused', 'disabledPlatforms']), client.queuedCount()]).then(([s, queued]) => reply({
      bridge: client.status(), queued, stats: s.stats || {}, paused: !!s.paused, disabledPlatforms: s.disabledPlatforms || [],
    }));
    return true;
  }
  // 配对、解除配对只允许扩展自己的页面（弹窗），不接受网页里的内容脚本
  const fromExtPage = (sender.url || '').startsWith(`chrome-extension://${chrome.runtime.id}/`);
  if (!fromExtPage && ['pair', 'unpair', 'reconnect'].includes(msg.type)) return;
  if (msg.type === 'pair') { client.pair(msg.code).then(reply); return true; }
  if (msg.type === 'unpair') { client.unpair().then(() => reply({ ok: true })); return true; }
  if (msg.type === 'reconnect') { client.connect().then(() => reply({ ok: true })); return true; }
});

chrome.alarms.create('mem0-keepalive', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'mem0-keepalive') client.connect(); });
chrome.runtime.onStartup.addListener(() => client.connect());
chrome.runtime.onInstalled.addListener(() => client.connect());
client.connect();
