// 离线队列：分会话存储、索引、预算淘汰、迁移、同 key 合并。
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  BridgeClient, MAX_QUEUE, MAX_QUEUE_BYTES, MAX_ITEM_BYTES, snapshotBytes,
} from '../src/bridge-client.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
async function T(name, fn) {
  await fn();
  pass++;
  console.log(`✓ 离线队列 ${name}`);
}

class NoWS { constructor() { this.readyState = 3; queueMicrotask(() => this.onclose && this.onclose()); } close() {} send() {} }
const conv = (id, capturedAt = 1, platform = 'chatgpt') => ({
  platform, externalId: id, title: `T${id}`, url: `https://chatgpt.com/c/${id}`,
  messages: [{ role: 'user', content: `问题 ${id}` }], capturedAt,
});
function memStorage(initial = {}) {
  const mem = structuredClone(initial);
  const gets = [];
  return {
    mem, gets,
    get: async (keys) => {
      const list = [].concat(keys);
      gets.push(list);
      return structuredClone(Object.fromEntries(list.map((k) => [k, mem[k]])));
    },
    set: async (o) => { Object.assign(mem, structuredClone(o)); },
    remove: async (keys) => { for (const k of [].concat(keys)) delete mem[k]; },
  };
}

// ---------- 迁移 ----------
await T('迁移旧 queue：拆成 q:<platform>:<id> 快照 + qidx，并删除旧键', async () => {
  const a = conv('a', 10);
  const b = conv('b', 20, 'kimi');
  const storage = memStorage({ queue: { 'chatgpt:a': a, 'kimi:b': b }, token: null });
  const c = new BridgeClient({ WebSocket: NoWS, storage });
  await c.ready;
  assert.equal(storage.mem.queue, undefined, '旧 queue 键应删除');
  assert.deepEqual(storage.mem['q:chatgpt:a'], a);
  assert.deepEqual(storage.mem['q:kimi:b'], b);
  assert.deepEqual(storage.mem.qidx, {
    'q:chatgpt:a': { capturedAt: 10, bytes: snapshotBytes(a) },
    'q:kimi:b': { capturedAt: 20, bytes: snapshotBytes(b) },
  });
  assert.equal(await c.queuedCount(), 2);
});

await T('迁移可重入：重复启动不重复写，崩溃后残留的旧键按新索引保留较新快照', async () => {
  const storage = memStorage({ queue: { 'chatgpt:a': conv('a', 10) }, token: null });
  await new BridgeClient({ WebSocket: NoWS, storage }).ready;
  const oldSnapshot = storage.mem['q:chatgpt:a'];
  await new BridgeClient({ WebSocket: NoWS, storage }).ready;
  assert.equal(storage.mem.queue, undefined);
  assert.deepEqual(storage.mem['q:chatgpt:a'], oldSnapshot);
  assert.equal(Object.keys(storage.mem.qidx).length, 1);

  // 模拟迁移写到一半崩溃：新结构已有更新快照，旧 queue 键还在
  const newer = conv('a', 99);
  storage.mem['q:chatgpt:a'] = newer;
  storage.mem.qidx['q:chatgpt:a'] = { capturedAt: 99, bytes: snapshotBytes(newer) };
  storage.mem.queue = { 'chatgpt:a': conv('a', 10) };
  await new BridgeClient({ WebSocket: NoWS, storage }).ready;
  assert.deepEqual(storage.mem['q:chatgpt:a'], newer);
  assert.equal(storage.mem.qidx['q:chatgpt:a'].capturedAt, 99);
  assert.equal(storage.mem.queue, undefined);
});

// ---------- 预算淘汰 ----------
await T('数量预算：第 501 个会话入队时按 capturedAt 淘汰最旧的', async () => {
  const initial = { token: null, qidx: {} };
  for (let i = 0; i < MAX_QUEUE; i++) {
    const key = `q:chatgpt:e${i}`;
    initial[key] = conv('e' + i, i + 1);
    initial.qidx[key] = { capturedAt: i + 1, bytes: snapshotBytes(initial[key]) };
  }
  const storage = memStorage(initial);
  const c = new BridgeClient({ WebSocket: NoWS, storage });
  await c.enqueue(conv('new', MAX_QUEUE + 1));
  const keys = Object.keys(storage.mem.qidx);
  assert.equal(keys.length, MAX_QUEUE);
  assert.ok(keys.includes('q:chatgpt:new'));
  assert.ok(!keys.includes('q:chatgpt:e0'), '最旧的一条应被淘汰');
  assert.equal(storage.mem['q:chatgpt:e0'], undefined, '被淘汰会话的快照也应删除');
});

await T('字节预算：总量超过 100 MiB 时从旧到新淘汰', async () => {
  const old1 = conv('old1', 1);
  const old2 = conv('old2', 2);
  const storage = memStorage({
    token: null,
    'q:chatgpt:old1': old1,
    'q:chatgpt:old2': old2,
    qidx: {
      'q:chatgpt:old1': { capturedAt: 1, bytes: 60 * 1024 * 1024 },
      'q:chatgpt:old2': { capturedAt: 2, bytes: 60 * 1024 * 1024 },
    },
  });
  const c = new BridgeClient({ WebSocket: NoWS, storage });
  await c.enqueue(conv('new', 3));
  const qidx = storage.mem.qidx;
  assert.ok(qidx['q:chatgpt:old2'], '较新的旧会话应保留');
  assert.ok(qidx['q:chatgpt:new']);
  assert.ok(!qidx['q:chatgpt:old1'], '最旧的应淘汰到总量不超过 100 MiB');
  const total = Object.values(qidx).reduce((n, x) => n + x.bytes, 0);
  assert.ok(total <= MAX_QUEUE_BYTES, `总量 ${total}`);
  assert.equal(storage.mem['q:chatgpt:old1'], undefined);
});

// ---------- 超大单条 ----------
await T('单个快照超过 5 MiB 不进离线队列', async () => {
  const big = { ...conv('big', 1), messages: [{ role: 'user', content: 'x'.repeat(2_800_000) }] };
  assert.ok(snapshotBytes(big) > MAX_ITEM_BYTES);
  const storage = memStorage({ token: null });
  const c = new BridgeClient({ WebSocket: NoWS, storage });
  await c.enqueue(big);
  assert.deepEqual(storage.mem.qidx || {}, {});
  assert.equal(storage.mem['q:chatgpt:big'], undefined);
  assert.equal(await c.queuedCount(), 0);
});

await T('超大单条在线时照常直接发送', async () => {
  const big = { ...conv('big', 1), messages: [{ role: 'user', content: 'x'.repeat(2_800_000) }] };
  const storage = memStorage({ token: 't' });
  const c = new BridgeClient({ WebSocket: NoWS, storage });
  await c.ready;
  const frames = [];
  c.state = 'connected';
  c.ws = { readyState: 1, send: (d) => frames.push(JSON.parse(d)) };
  await c.enqueue(big);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, 'upsert');
  assert.equal(frames[0].conversation.externalId, 'big');
  assert.equal(storage.mem['q:chatgpt:big'], undefined);
  assert.deepEqual(storage.mem.qidx || {}, {});
  c.ws = null;
});

// ---------- 数量只读索引 ----------
await T('queuedCount 只请求 qidx，不读取任何快照全文', async () => {
  const storage = memStorage({ token: null });
  const c = new BridgeClient({ WebSocket: NoWS, storage });
  await c.ready;
  await c.enqueue(conv('a', 1));
  await c.enqueue(conv('b', 2));
  storage.gets.length = 0;
  assert.equal(await c.queuedCount(), 2);
  assert.deepEqual(storage.gets, [['qidx']]);
});

// ---------- 同 key 合并 ----------
await T('锁前合并同 key：连续 enqueue 只落盘最新快照一份', async () => {
  const storage = memStorage({ token: null });
  const c = new BridgeClient({ WebSocket: NoWS, storage });
  await c.ready;
  const writes = [];
  const rawSet = storage.set;
  storage.set = async (o) => { writes.push(structuredClone(o)); return rawSet(o); };
  await Promise.all(Array.from({ length: 6 }, (_, i) => c.enqueue({ ...conv('same', i + 1), title: `第 ${i + 1} 版` })));
  assert.equal(storage.mem['q:chatgpt:same'].title, '第 6 版');
  assert.equal(storage.mem.qidx['q:chatgpt:same'].capturedAt, 6);
  const snapshotWrites = writes.filter((o) => o['q:chatgpt:same']);
  assert.equal(snapshotWrites.length, 1, `同 key 被写入了 ${snapshotWrites.length} 次`);
  assert.equal(snapshotWrites[0]['q:chatgpt:same'].capturedAt, 6);
});

// ---------- ack 后清理 ----------
await T('ack ok 后同时删除快照和索引条目', async () => {
  const storage = memStorage({ token: 't' });
  const c = new BridgeClient({ WebSocket: NoWS, storage });
  await c.ready;
  const frames = [];
  c.state = 'connected';
  c.ws = { readyState: 1, send: (d) => frames.push(JSON.parse(d)) };
  await c.enqueue(conv('ack', 1));
  assert.ok(storage.mem['q:chatgpt:ack']);
  await c.onMessage(c.ws, JSON.stringify({ type: 'ack', reqId: frames[0].reqId, ok: true, changed: true, added: 1 }));
  assert.equal(storage.mem['q:chatgpt:ack'], undefined);
  assert.deepEqual(storage.mem.qidx, {});
  c.ws = null;
});

// ---------- background 的 queued 数量 ----------
await T('background status 的 queued 读 qidx 键数', async () => {
  const local = {};
  const bg = {};
  globalThis.chrome = {
    runtime: { id: 'selfid', getManifest: () => ({ version: '0.0.0' }), onMessage: { addListener: (f) => { bg.onMsg = f; } }, onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
    storage: {
      local: {
        get: async (keys) => structuredClone(Object.fromEntries([].concat(keys).map((k) => [k, local[k]]))),
        set: async (o) => { Object.assign(local, structuredClone(o)); },
        remove: async (keys) => { for (const k of [].concat(keys)) delete local[k]; },
      },
      session: { set: async () => {} },
    },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    alarms: { create() {}, onAlarm: { addListener() {} } },
  };
  const realWS = globalThis.WebSocket;
  globalThis.WebSocket = class { constructor() { this.readyState = 0; } close() {} send() {} };
  try {
    await import(pathToFileURL(path.join(root, 'src/background.js')).href + '?qidx-test');
    const call = (msg, sender) => new Promise((resolve) => bg.onMsg(msg, sender, resolve));
    const tab = { id: 'selfid', tab: { id: 1 }, url: 'https://chatgpt.com/c/x' };
    assert.deepEqual(await call({ type: 'capture', conversation: conv('a', 1) }, tab), { ok: true });
    assert.deepEqual(await call({ type: 'capture', conversation: conv('b', 2) }, tab), { ok: true });
    assert.ok(!local.queue, '不应再写旧 queue 键');
    assert.equal(Object.keys(local.qidx).length, 2);
    const r = await call({ type: 'status' }, { id: 'selfid', url: 'chrome-extension://selfid/src/popup/popup.html' });
    assert.equal(r.queued, 2);
    // 等背景里未 await 的 connect() 走完，避免它之后才碰到已清理的 chrome 桩
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    globalThis.WebSocket = realWS;
    delete globalThis.chrome;
  }
});

console.log(`✓ 离线队列 ${pass}/${pass}`);
