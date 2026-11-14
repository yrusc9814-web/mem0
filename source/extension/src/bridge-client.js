/*
 * 与 mem0 桌面端的连接（ws://127.0.0.1:3791/browser/v1）。
 * 不依赖 chrome.*，存储和 WebSocket 由外部注入，方便在 node 里测试。
 *
 * 发送队列：每个会话只保留最新快照（存储 key = q:<platform>:<externalId>），
 * 另用一个小索引 qidx 记录每个会话的 capturedAt 和字节数；数量、预算、淘汰只看索引，
 * 不整份读写队列。桌面端没开时先存着，连上后补发；收到 ack ok 才从队列删除。
 * 补发分批进行：每批最多 20 条，等本批 ack（或 30 秒超时）后再发下一批；
 * 同一会话同时最多 1 个在途，在途期间的新快照只记最新一份，等 ack 后再发。
 */
export const PROTOCOL = 1;
export const DEFAULT_URL = 'ws://127.0.0.1:3791/browser/v1';
export const MAX_QUEUE = 500;
export const MAX_QUEUE_BYTES = 100 * 1024 * 1024;
export const MAX_ITEM_BYTES = 5 * 1024 * 1024;
export const MAX_BATCH = 20;
export const ACK_TIMEOUT = 30_000;
export const MAX_BUFFERED = 8 * 1024 * 1024;
const BUFFER_POLL_MS = 50;
const QUEUE_INDEX = 'qidx';
const LEGACY_QUEUE = 'queue';

const queueKey = (conv) => `q:${conv.platform}:${conv.externalId}`;
export const snapshotBytes = (conv) => JSON.stringify(conv).length * 2;
const platformOf = (key) => (key.startsWith('q:') ? key.slice(2, key.indexOf(':', 2)) : key.split(':')[0]);

/** 按 capturedAt 从旧到新淘汰，只改索引；返回被淘汰的存储 key */
export function enforceBudget(qidx, maxCount = MAX_QUEUE, maxBytes = MAX_QUEUE_BYTES) {
  const keys = Object.keys(qidx);
  let total = keys.reduce((n, k) => n + (qidx[k].bytes || 0), 0);
  const evicted = [];
  keys.sort((a, b) => (qidx[a].capturedAt || 0) - (qidx[b].capturedAt || 0));
  for (const k of keys) {
    if (keys.length - evicted.length <= maxCount && total <= maxBytes) break;
    evicted.push(k);
    total -= qidx[k].bytes || 0;
    delete qidx[k];
  }
  return evicted;
}

export class BridgeClient {
  /**
   * @param {object} o
   * @param {typeof WebSocket} o.WebSocket
   * @param {{get(keys:string[]):Promise<object>, set(obj:object):Promise<void>, remove(keys:string[]):Promise<void>}} o.storage Chrome storage.local 结构
   * @param {string} [o.url]
   * @param {string} [o.extensionId]
   * @param {string} [o.version]
   * @param {(s:object)=>void} [o.onStatus]
   */
  constructor(o) {
    this.WS = o.WebSocket;
    this.storage = o.storage;
    this.url = o.url || DEFAULT_URL;
    this.extensionId = o.extensionId || '';
    this.version = o.version || '0.0.0';
    this.onStatus = o.onStatus || (() => {});
    this.ws = null;
    this.state = 'disconnected'; // disconnected | connecting | connected | need_pair
    this.lastError = null;
    this.desktopVersion = null;
    this.reqId = 0;
    this.inflight = new Map(); // reqId -> { key, capturedAt, ws, timer, waiters }
    this.inflightByKey = new Map(); // 队列 key -> 在途 reqId，同一 key 同时最多 1 个
    this.latestPending = new Map(); // 队列 key -> 在途期间收到的最新快照
    this.pingTimer = null; // 当前连接的 ping 定时器（兼容旧引用）
    this.pingTimers = new Map(); // socket -> ping 定时器，替换连接时按归属清理
    this.pendingPair = null; // { code, resolve }
    this.retryTimer = null;
    this.retryDelay = 2000; // 断线后自动重连：2s 起，翻倍到 60s
    this.lock = Promise.resolve();
    this.pending = new Map(); // 锁前合并：队列 key -> 最新快照
    this.pendingRun = null;
    this.flushRun = null;
    this.flushGen = -1;
    this.connGen = 0;
    this.bufferTimer = null;
    this.ackTimeout = ACK_TIMEOUT;
    this.batchSize = MAX_BATCH;
    this.maxBuffered = MAX_BUFFERED;
    this.ready = this.migrateQueue().catch((e) => { this.lastError = String((e && e.message) || e); });
  }

  status() {
    return { state: this.state, lastError: this.lastError, desktopVersion: this.desktopVersion };
  }

  setState(state, err) {
    this.state = state;
    if (err !== undefined) this.lastError = err;
    this.onStatus(this.status());
  }

  /** 串行化存储的读改写：并发的 enqueue / ack 各自 get→改→set 会互相覆盖 */
  locked(fn) {
    const run = this.lock.then(fn);
    this.lock = run.catch(() => {});
    return run;
  }

  /** 给弹窗用的排队数量：只读索引，不读快照全文 */
  async queuedCount() {
    await this.ready;
    return Object.keys((await this.storage.get([QUEUE_INDEX]))[QUEUE_INDEX] || {}).length;
  }

  /** 旧版单对象 queue 迁移到 q:<...> + qidx；写完新结构才删旧键，可重入 */
  async migrateQueue() {
    await this.locked(async () => {
      const old = await this.storage.get([LEGACY_QUEUE, QUEUE_INDEX]);
      const legacy = old[LEGACY_QUEUE];
      if (!legacy || typeof legacy !== 'object') return;
      const qidx = old[QUEUE_INDEX] && typeof old[QUEUE_INDEX] === 'object' ? old[QUEUE_INDEX] : {};
      const snapshots = {};
      for (const [oldKey, conv] of Object.entries(legacy)) {
        if (!conv || typeof conv !== 'object') continue;
        const key = oldKey.startsWith('q:') ? oldKey : `q:${oldKey}`;
        // 迁移中途崩溃后重入：索引里已有同样或更新的快照时保留新的
        if (qidx[key] && (qidx[key].capturedAt || 0) >= (conv.capturedAt || 0)) continue;
        const bytes = snapshotBytes(conv);
        if (bytes > MAX_ITEM_BYTES) continue; // 超大快照不进离线队列
        snapshots[key] = conv;
        qidx[key] = { capturedAt: conv.capturedAt || 0, bytes };
      }
      // 先按预算定下要保留的条目，再写；重入时结果一致，不会把淘汰项写回来
      const evicted = enforceBudget(qidx);
      const writes = {};
      for (const [key, conv] of Object.entries(snapshots)) if (qidx[key]) writes[key] = conv;
      await this.storage.set({ ...writes, [QUEUE_INDEX]: qidx });
      if (evicted.length) await this.storage.remove(evicted);
      await this.storage.remove([LEGACY_QUEUE]);
    });
  }

  /** 把 pending 里的快照合并写入；同一会话在一次锁里只写最新一份 */
  async drainPending() {
    try {
      await this.ready;
      while (this.pending.size) {
        const batch = this.pending;
        this.pending = new Map();
        await this.locked(() => this.persist(batch));
      }
    } finally {
      this.pendingRun = null;
    }
  }

  async persist(batch) {
    const qidx = (await this.storage.get([QUEUE_INDEX]))[QUEUE_INDEX] || {};
    const writes = {};
    for (const [key, conv] of batch) {
      const bytes = snapshotBytes(conv);
      // 超大快照不进离线队列；已经排着的旧快照保持不动
      if (bytes > MAX_ITEM_BYTES) continue;
      writes[key] = conv;
      qidx[key] = { capturedAt: conv.capturedAt || 0, bytes };
    }
    const evicted = enforceBudget(qidx);
    const kept = {};
    for (const [key, conv] of Object.entries(writes)) if (qidx[key]) kept[key] = conv;
    await this.storage.set({ ...kept, [QUEUE_INDEX]: qidx });
    if (evicted.length) await this.storage.remove(evicted);
  }

  async enqueue(conv) {
    const key = queueKey(conv);
    // 锁前合并：同一会话的连续 enqueue 只把最新快照交给锁，避免锁链堆积多份全文
    this.pending.set(key, conv);
    const run = this.pendingRun || (this.pendingRun = this.drainPending());
    await run;
    if (this.state === 'connected') this.queueSend(key, conv);
    else this.connect();
  }

  liveSocket() {
    return this.ws && this.ws.readyState === 1;
  }

  /** 连接；已连上或正在连接则什么都不做 */
  async connect(pairCode) {
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1) && !pairCode) return;
    const { token } = await this.storage.get(['token']);
    // await 期间可能已有并发的 connect() 建好了连接，这里再查一次，避免建出多条连接
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1) && !pairCode) return;
    if (this.ws) {
      const old = this.ws;
      this.cleanupSocket(old); // 旧连接的在途请求和 ping 定时器按 socket 归属清理
      try { old.close(); } catch { /* ignore */ }
    }
    if (!token && !pairCode) { this.setState('need_pair', null); return; }
    this.setState('connecting');
    let ws;
    try { ws = new this.WS(this.url); } catch (e) { this.setState('disconnected', String(e.message || e)); return; }
    this.ws = ws;
    this.connGen++;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'hello', protocol: PROTOCOL, token: pairCode ? undefined : token, pairCode, extensionId: this.extensionId, extensionVersion: this.version }));
    };
    ws.onmessage = (ev) => this.onMessage(ws, ev.data);
    ws.onclose = () => {
      this.cleanupSocket(ws);
      if (this.ws !== ws) return;
      if (this.state !== 'need_pair') {
        this.setState('disconnected', this.state === 'connecting' ? '桌面端未运行' : this.lastError);
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.connect(), this.retryDelay);
        this.retryDelay = Math.min(this.retryDelay * 2, 60_000);
      }
    };
    ws.onerror = () => {};
  }

  /** 清理某条 socket 的 ping 定时器、在途记录和待发最新，避免旧连接条目残留 */
  cleanupSocket(ws) {
    const timer = this.pingTimers.get(ws);
    if (timer) {
      clearInterval(timer);
      this.pingTimers.delete(ws);
      if (this.pingTimer === timer) this.pingTimer = null;
    }
    for (const [reqId, entry] of this.inflight) {
      if (entry.ws !== ws) continue;
      this.takeInflight(reqId);
      this.settle(entry);
    }
    for (const [key, item] of this.latestPending) {
      if (item.ws !== ws) continue;
      this.latestPending.delete(key);
    }
  }

  /** 用配对码配对，返回 { ok, error } */
  pair(code) {
    return new Promise((resolve) => {
      this.pendingPair = { resolve };
      this.connect(String(code).trim());
      setTimeout(() => { if (this.pendingPair) { this.pendingPair = null; resolve({ ok: false, error: '连接超时：请确认 mem0 桌面端已打开' }); } }, 8000);
    });
  }

  async onMessage(ws, data) {
    let msg;
    try { msg = JSON.parse(typeof data === 'string' ? data : String(data)); } catch { return; }
    if (msg.type === 'welcome') {
      if (msg.token) await this.storage.set({ token: msg.token });
      this.desktopVersion = msg.desktopVersion || null;
      this.setState('connected', null);
      this.retryDelay = 2000;
      clearTimeout(this.retryTimer);
      if (this.pendingPair) { this.pendingPair.resolve({ ok: true }); this.pendingPair = null; }
      const oldPing = this.pingTimers.get(ws);
      if (oldPing) clearInterval(oldPing);
      const pingTimer = setInterval(() => { if (ws.readyState === 1) ws.send('{"type":"ping"}'); }, 20_000);
      this.pingTimers.set(ws, pingTimer);
      this.pingTimer = pingTimer;
      await this.flush();
    } else if (msg.type === 'error') {
      const map = { pair_required: '需要配对', token_invalid: '配对已失效，请重新配对', protocol: '桌面端版本不兼容' };
      if (msg.code === 'token_invalid' || msg.code === 'pair_required') {
        if (!this.pendingPair) await this.storage.set({ token: null });
        this.setState('need_pair', map[msg.code]);
      } else this.lastError = map[msg.code] || msg.code;
      if (this.pendingPair) { this.pendingPair.resolve({ ok: false, error: msg.code === 'protocol' ? map.protocol : '配对码错误或已过期' }); this.pendingPair = null; }
    } else if (msg.type === 'ack') {
      const sent = this.takeInflight(msg.reqId);
      if (!sent) return;
      const { key, capturedAt } = sent;
      try {
        if (msg.ok) {
          await this.ready;
          await this.locked(async () => {
            const qidx = (await this.storage.get([QUEUE_INDEX]))[QUEUE_INDEX] || {};
            // 发送期间又有更新的快照就保留，它已经在路上或等下一次发送
            if (qidx[key] && (qidx[key].capturedAt || 0) <= capturedAt) {
              delete qidx[key];
              await this.storage.set({ [QUEUE_INDEX]: qidx });
              await this.storage.remove([key]);
            }
            const stats = (await this.storage.get(['stats'])).stats || {};
            if (msg.changed) {
              const p = platformOf(key);
              stats[p] = (stats[p] || 0) + (msg.added || 0);
              stats.lastSavedAt = Date.now();
              await this.storage.set({ stats });
            }
          });
        } else {
          this.latestPending.delete(key);
          this.lastError = msg.error;
        }
      } finally {
        this.settle(sent);
        // 该 key 在途期间又有新快照：ack 后立刻补发最新那份
        if (msg.ok) this.sendLatest(key);
      }
    }
  }

  takeInflight(reqId) {
    const entry = this.inflight.get(reqId);
    if (!entry) return null;
    this.inflight.delete(reqId);
    clearTimeout(entry.timer);
    if (this.inflightByKey.get(entry.key) === reqId) this.inflightByKey.delete(entry.key);
    return entry;
  }

  settle(entry) {
    for (const resolve of entry.waiters) resolve();
    entry.waiters.length = 0;
  }

  onAckTimeout(reqId) {
    const entry = this.takeInflight(reqId);
    if (!entry) return;
    // 不清队列：快照留在存储里，等下次发送（重连或下次 flush）
    this.latestPending.delete(entry.key);
    this.settle(entry);
  }

  /** 当前连接写缓冲超过上限时暂停，等 bufferedAmount 降下来 */
  async waitWhileBuffered(gen = this.connGen) {
    while (this.liveSocket() && this.connGen === gen && (this.ws.bufferedAmount || 0) > this.maxBuffered) {
      await new Promise((r) => setTimeout(r, BUFFER_POLL_MS));
    }
  }

  async flush() {
    const gen = this.connGen;
    if (this.flushRun && this.flushGen === gen) return this.flushRun;
    const run = this.runFlush(gen).finally(() => { if (this.flushRun === run) this.flushRun = null; });
    this.flushRun = run;
    this.flushGen = gen;
    return run;
  }

  async runFlush(gen) {
    await this.ready;
    if (this.pendingRun) await this.pendingRun;
    const qidx = (await this.storage.get([QUEUE_INDEX]))[QUEUE_INDEX] || {};
    const keys = Object.keys(qidx);
    if (!keys.length) return;
    const snapshots = await this.storage.get(keys);
    const items = [];
    for (const key of keys) {
      const conv = snapshots[key];
      if (!conv) continue;
      if (this.inflightByKey.has(key)) continue; // 在途的等 ack 后再发最新
      items.push({ key, conv });
    }
    for (let i = 0; i < items.length; i += this.batchSize) {
      await this.waitWhileBuffered(gen);
      if (!this.liveSocket() || this.connGen !== gen) return;
      const batch = items.slice(i, i + this.batchSize);
      const reqIds = [];
      for (const { key, conv } of batch) {
        // 本批内/等待期间同 key 已排上就跳过，保证同一 key 同时最多 1 个在途
        if (this.inflightByKey.has(key)) continue;
        const reqId = this.send(key, conv);
        if (reqId) reqIds.push(reqId);
      }
      if (!reqIds.length) continue; // 本批全在途：直接看下一批，不提前结束补发
      await this.waitBatch(reqIds); // 收到本批 ack 或超时后再发下一批
    }
  }

  waitBatch(reqIds) {
    const waits = [];
    for (const reqId of reqIds) {
      const entry = this.inflight.get(reqId);
      if (!entry) continue;
      waits.push(new Promise((resolve) => entry.waiters.push(resolve)));
    }
    return Promise.all(waits);
  }

  /** 在线时发送一条快照；同一 key 已有在途请求就先记成待发最新 */
  queueSend(key, conv) {
    if (!this.liveSocket()) return false;
    if (this.inflightByKey.has(key)) {
      this.recordPending(key, conv);
      return false;
    }
    if ((this.ws.bufferedAmount || 0) > this.maxBuffered) {
      this.recordPending(key, conv);
      this.schedulePump();
      return false;
    }
    return this.send(key, conv) !== null;
  }

  /** 记为「待发最新」：只留 capturedAt 更大的一份，比在途旧的不重复记 */
  recordPending(key, conv) {
    const reqId = this.inflightByKey.get(key);
    if (reqId) {
      const current = this.inflight.get(reqId);
      if (current && (conv.capturedAt || 0) <= current.capturedAt) return;
    }
    const old = this.latestPending.get(key);
    if (old && (old.conv.capturedAt || 0) >= (conv.capturedAt || 0)) return;
    this.latestPending.set(key, { conv, ws: this.ws });
  }

  sendLatest(key) {
    const item = this.latestPending.get(key);
    if (!item) return;
    this.latestPending.delete(key);
    if (item.ws !== this.ws || !this.liveSocket()) return;
    this.queueSend(key, item.conv);
  }

  /** 写缓冲降下来后补发待发最新 */
  schedulePump() {
    if (this.bufferTimer) return;
    this.bufferTimer = setTimeout(() => {
      this.bufferTimer = null;
      if (!this.liveSocket() || (this.ws.bufferedAmount || 0) > this.maxBuffered) {
        if (this.liveSocket()) this.schedulePump();
        return;
      }
      for (const key of [...this.latestPending.keys()]) this.sendLatest(key);
    }, BUFFER_POLL_MS);
  }

  send(key, conv) {
    if (!this.ws || this.ws.readyState !== 1) return null;
    const ws = this.ws;
    const reqId = ++this.reqId;
    const entry = { key, capturedAt: conv.capturedAt || 0, ws, timer: null, waiters: [] };
    entry.timer = setTimeout(() => this.onAckTimeout(reqId), this.ackTimeout);
    this.inflight.set(reqId, entry);
    this.inflightByKey.set(key, reqId);
    const { capturedAt, ...payload } = conv;
    try {
      ws.send(JSON.stringify({ type: 'upsert', reqId, conversation: payload }));
    } catch {
      this.takeInflight(reqId);
      return null;
    }
    return reqId;
  }

  async unpair() {
    clearTimeout(this.retryTimer);
    clearTimeout(this.bufferTimer);
    await this.storage.set({ token: null });
    if (this.ws) {
      this.cleanupSocket(this.ws);
      try { this.ws.close(); } catch { /* ignore */ }
    }
    this.setState('need_pair', null);
  }
}
