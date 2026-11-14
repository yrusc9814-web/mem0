'use strict';
/**
 * 浏览器插件桥：ws://127.0.0.1:3791/browser/v1
 *
 * 配对：桌面端生成 6 位配对码（2 分钟有效），用户在插件里输入；
 *       验证通过后桌面端下发长期 token，插件保存，以后连接用 token 认证。
 *
 * 协议（JSON 文本帧）：
 *   插件 → 桌面  { type:'hello', protocol:1, token?, pairCode?, extensionId, extensionVersion }
 *   桌面 → 插件  { type:'welcome', token?, desktopVersion } | { type:'error', code }
 *   插件 → 桌面  { type:'upsert', reqId, conversation:{ platform, externalId, title, url, messages:[{role,content,createdAt}], authoritative } }
 *   桌面 → 插件  { type:'ack', reqId, ok, changed, added, error? }
 *   插件 → 桌面  { type:'ping' }  桌面 → 插件 { type:'pong' }
 */
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const { WEB_SOURCES } = require('./db');

const PROTOCOL = 1;
const DEFAULT_PORT = 3791;
const PATH = '/browser/v1';
const PAIR_TTL_MS = 120_000;

function startBridge(store, { port = DEFAULT_PORT, version = '0.1.0', onSaved, onStatus } = {}) {
  let pair = null; // { code, expiresAt }
  const clients = new Set();

  const tokens = () => JSON.parse(store.getKv('bridge_tokens') || '[]');
  const saveTokens = (t) => store.setKv('bridge_tokens', JSON.stringify(t));
  const tokenOk = (tok) => typeof tok === 'string' && tokens().some((t) => safeEq(t.hash, sha(tok)));

  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port,
    path: PATH,
    maxPayload: 16 * 1024 * 1024,
    // 只接受浏览器扩展发起的连接（普通网页的 Origin 是 http(s)://…，直接拒绝）
    verifyClient: ({ origin, req }) => {
      const hostOk = /^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host || '');
      const originOk = !origin || /^(chrome|moz|safari-web)-extension:\/\//.test(origin) || /^extension:\/\//.test(origin);
      return hostOk && originOk;
    },
  });

  const notify = () => onStatus && onStatus({ connected: clients.size, paired: tokens().length });

  wss.on('connection', (ws, req) => {
    let authed = false;
    const timer = setTimeout(() => { if (!authed) ws.close(4001, 'auth timeout'); }, 10_000);
    const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return send({ type: 'error', code: 'bad_json' }); }
      if (!msg || typeof msg !== 'object') return send({ type: 'error', code: 'bad_json' });

      if (!authed) {
        if (msg.type !== 'hello' || msg.protocol !== PROTOCOL) { send({ type: 'error', code: 'protocol' }); return ws.close(4002); }
        if (tokenOk(msg.token)) {
          authed = true;
        } else if (pair && Date.now() < pair.expiresAt && typeof msg.pairCode === 'string' && safeEq(msg.pairCode, pair.code)) {
          const token = crypto.randomBytes(32).toString('base64url');
          const list = tokens();
          list.push({ hash: sha(token), extensionId: String(msg.extensionId || '').slice(0, 64), createdAt: Date.now() });
          saveTokens(list.slice(-10));
          pair = null;
          authed = true;
          clearTimeout(timer);
          clients.add(ws); notify();
          return send({ type: 'welcome', token, desktopVersion: version });
        } else {
          // 防暴力枚举：配对码连续输错 5 次即作废，需重新生成
          if (pair && typeof msg.pairCode === 'string' && ++pair.failures >= 5) pair = null;
          send({ type: 'error', code: msg.token ? 'token_invalid' : 'pair_required' });
          return ws.close(4003);
        }
        clearTimeout(timer);
        clients.add(ws); notify();
        return send({ type: 'welcome', desktopVersion: version });
      }

      if (msg.type === 'ping') return send({ type: 'pong' });
      if (msg.type === 'upsert') {
        const c = msg.conversation || {};
        try {
          if (!WEB_SOURCES.includes(c.platform)) throw new Error('unsupported_platform');
          const source = `${c.platform}-web`;
          if (!store.isSourceEnabled(source)) return send({ type: 'ack', reqId: msg.reqId, ok: true, changed: false, skipped: 'disabled' });
          const r = store.upsertConversation({
            source,
            externalId: String(c.externalId || '').slice(0, 300),
            title: typeof c.title === 'string' ? c.title : undefined,
            url: typeof c.url === 'string' && /^https:\/\//.test(c.url) ? c.url : undefined,
            authoritative: !!c.authoritative,
            align: true,
            ingestMethod: 'browser-extension',
            messages: (Array.isArray(c.messages) ? c.messages : []).slice(0, 5000).map((m) => ({
              role: m.role === 'assistant' ? 'assistant' : 'user',
              content: String(m.content ?? '').slice(0, 500_000),
              createdAt: Number.isFinite(m.createdAt) ? m.createdAt : undefined,
            })),
          });
          if (r.changed && onSaved) onSaved({ source, conversationId: r.id, added: r.added });
          return send({ type: 'ack', reqId: msg.reqId, ok: true, changed: r.changed, added: r.added });
        } catch (e) {
          return send({ type: 'ack', reqId: msg.reqId, ok: false, error: String(e.message || e) });
        }
      }
      send({ type: 'error', code: 'unknown_type' });
    });

    ws.on('close', () => { clearTimeout(timer); clients.delete(ws); notify(); });
    ws.on('error', () => {});
  });

  return new Promise((resolve, reject) => {
    wss.once('error', reject);
    wss.once('listening', () => resolve({
      url: `ws://127.0.0.1:${port}${PATH}`,
      /** 生成新的配对码 */
      newPairCode() {
        pair = { code: String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'), expiresAt: Date.now() + PAIR_TTL_MS, failures: 0 };
        return { code: pair.code, expiresAt: pair.expiresAt };
      },
      revokeAll() { saveTokens([]); for (const c of clients) c.close(4004, 'revoked'); },
      status: () => ({ connected: clients.size, paired: tokens().length }),
      close: () => new Promise((r) => {
        // 未认证的连接不在 clients 里，也一并断开，避免 wss.close 一直等它们
        for (const c of wss.clients) c.terminate();
        wss.close(() => r());
      }),
    }));
  });
}

function sha(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function safeEq(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = { startBridge, PROTOCOL, DEFAULT_PORT, PATH };
