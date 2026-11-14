// 重连补发：分批、同 key 单在途、ack 超时清理、换连接按 socket 清理、写缓冲暂停。
import assert from 'node:assert/strict';
import { BridgeClient, MAX_BATCH, MAX_BUFFERED, snapshotBytes } from '../src/bridge-client.js';

let pass = 0;
async function T(name, fn) {
  await fn();
  pass++;
  console.log(`✓ 补发批次 ${name}`);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const conv = (id, capturedAt = 1, platform = 'chatgpt') => ({
  platform, externalId: id, title: `T${id}`, url: `https://chatgpt.com/c/${id}`,
  messages: [{ role: 'user', content: `问题 ${id}` }], capturedAt,
});
const qkey = (id, platform = 'chatgpt') => `q:${platform}:${id}`;
function memStorage(initial = {}) {
  const mem = structuredClone(initial);
  return {
    mem,
    get: async (keys) => structuredClone(Object.fromEntries([].concat(keys).map((k) => [k, mem[k]]))),
    set: async (o) => { Object.assign(mem, structuredClone(o)); },
    remove: async (keys) => { for (const k of [].concat(keys)) delete mem[k]; },
  };
}

class IdleWS { constructor() { this.readyState = 3; } close() {} send() {} }

// ---------- 500 条分批 ----------
await T('500 条队列每批最多 20 条，ack 后才发下一批', async () => {
  const initial = { token: null, qidx: {} };
  for (let i = 0; i < 500; i++) {
    const key = qkey('e' + i);
    initial[key] = conv('e' + i, i + 1);
    initial.qidx[key] = { capturedAt: i + 1, bytes: 10 };
  }
  const storage = memStorage(initial);
  const c = new BridgeClient({ WebSocket: IdleWS, storage });
  await c.ready;
  c.state = 'connected';
  const frames = [];
  let peak = 0;
  const ws = {
    readyState: 1, bufferedAmount: 0,
    send(d) {
      const f = JSON.parse(d);
      frames.push(f);
      peak = Math.max(peak, c.inflight.size);
      setTimeout(() => c.onMessage(ws, JSON.stringify({ type: 'ack', reqId: f.reqId, ok: true })), 1);
    },
    close() {},
  };
  c.ws = ws;
  await c.flush();
  assert.equal(frames.length, 500, `只发出了 ${frames.length} 条`);
  assert.ok(peak <= MAX_BATCH, `在途峰值 ${peak}，超过每批 ${MAX_BATCH}`);
  assert.equal(c.inflight.size, 0);
  assert.equal(Object.keys(storage.mem.qidx).length, 0, 'ack 后队列应清空');
  assert.equal(c.ws, ws);
});

// ---------- 写缓冲暂停 ----------
await T('bufferedAmount 超过 8 MiB 时暂停，降下来后继续发', async () => {
  const initial = { token: null, qidx: {} };
  for (let i = 0; i < 3; i++) {
    const key = qkey('b' + i);
    initial[key] = conv('b' + i, i + 1);
    initial.qidx[key] = { capturedAt: i + 1, bytes: 10 };
  }
  const storage = memStorage(initial);
  const c = new BridgeClient({ WebSocket: IdleWS, storage });
  await c.ready;
  c.state = 'connected';
  const frames = [];
  const ws = {
    readyState: 1, bufferedAmount: MAX_BUFFERED + 1,
    send(d) {
      const f = JSON.parse(d);
      frames.push(f);
      setTimeout(() => c.onMessage(ws, JSON.stringify({ type: 'ack', reqId: f.reqId, ok: true })), 1);
    },
    close() {},
  };
  c.ws = ws;
  const running = c.flush();
  await wait(120);
  assert.equal(frames.length, 0, '写缓冲未降下来时不应发送');
  ws.bufferedAmount = 0;
  await running;
  assert.equal(frames.length, 3);
});

// ---------- 同 key 单在途 ----------
await T('同 key 连发 100 次在途最多 1，ack 后只补发最新一份', async () => {
  const storage = memStorage({ token: 't' });
  const c = new BridgeClient({ WebSocket: IdleWS, storage });
  await c.ready;
  c.state = 'connected';
  const frames = [];
  let peak = 0;
  const ws = { readyState: 1, bufferedAmount: 0, send: (d) => frames.push(JSON.parse(d)), close() {} };
  c.ws = ws;
  for (let i = 1; i <= 100; i++) {
    await c.enqueue({ ...conv('same', i), title: `第 ${i} 版` });
    peak = Math.max(peak, c.inflight.size);
  }
  assert.equal(peak, 1, `在途峰值 ${peak}`);
  assert.equal(frames.length, 1, `发了 ${frames.length} 条，应只发首条`);
  assert.equal(frames[0].conversation.title, '第 1 版');
  assert.equal(c.latestPending.get(qkey('same')).conv.capturedAt, 100);

  await c.onMessage(ws, JSON.stringify({ type: 'ack', reqId: frames[0].reqId, ok: true }));
  assert.equal(frames.length, 2, 'ack 后应补发最新快照');
  assert.equal(frames[1].conversation.title, '第 100 版');
  assert.equal(c.inflight.size, 1);

  await c.onMessage(ws, JSON.stringify({ type: 'ack', reqId: frames[1].reqId, ok: true }));
  assert.equal(c.inflight.size, 0);
  assert.equal(storage.mem[qkey('same')], undefined, '最新一份 ack 后队列应清空');
  assert.deepEqual(storage.mem.qidx, {});
});

// ---------- ack 超时 ----------
await T('在途 30 秒无 ack 视为超时：清 inflight，快照留在队列等下次发送', async () => {
  const storage = memStorage({ token: 't' });
  const c = new BridgeClient({ WebSocket: IdleWS, storage });
  await c.ready;
  c.ackTimeout = 30;
  c.state = 'connected';
  const frames = [];
  const ws = { readyState: 1, bufferedAmount: 0, send: (d) => frames.push(JSON.parse(d)), close() {} };
  c.ws = ws;
  await c.enqueue(conv('slow', 1));
  assert.equal(c.inflight.size, 1);
  await wait(90);
  assert.equal(c.inflight.size, 0, '超时后应清除 inflight');
  assert.equal(c.inflightByKey.size, 0);
  assert.equal(storage.mem.qidx[qkey('slow')].capturedAt, 1);
  assert.ok(storage.mem[qkey('slow')], '快照不能因超时被删除');

  // 下次发送应重发这条
  await c.flush();
  assert.equal(frames.length, 2);
  assert.equal(frames[1].conversation.externalId, 'slow');
});

await T('超时的 key 之后仍能接收新快照并正常 ack 清理', async () => {
  const storage = memStorage({ token: 't' });
  const c = new BridgeClient({ WebSocket: IdleWS, storage });
  await c.ready;
  c.ackTimeout = 20;
  c.state = 'connected';
  const frames = [];
  const ws = { readyState: 1, bufferedAmount: 0, send: (d) => frames.push(JSON.parse(d)), close() {} };
  c.ws = ws;
  await c.enqueue(conv('again', 1));
  await wait(60);
  assert.equal(c.inflight.size, 0);
  await c.enqueue(conv('again', 2));
  assert.equal(frames.length, 2);
  await c.onMessage(ws, JSON.stringify({ type: 'ack', reqId: frames[1].reqId, ok: true }));
  assert.equal(c.inflight.size, 0);
  assert.equal(storage.mem[qkey('again')], undefined);
});

// ---------- 换连接清理 ----------
await T('连续替换连接：旧 socket 的 inflight 和 ping 定时器不累积', async () => {
  class FakeWS {
    constructor() { this.readyState = 1; this.bufferedAmount = 0; this.sent = []; }
    close() { this.readyState = 3; }
    send(d) { this.sent.push(JSON.parse(d)); }
  }
  const storage = memStorage({ token: 't' });
  const c = new BridgeClient({ WebSocket: FakeWS, storage });
  await c.ready;
  let previous = null;
  for (let round = 0; round < 5; round++) {
    await c.connect('123456');
    assert.equal(c.inflight.size, 0, `第 ${round + 1} 次连接后旧 inflight 仍有 ${c.inflight.size} 条`);
    assert.equal(c.inflightByKey.size, 0);
    if (previous) {
      assert.equal(c.pingTimers.has(previous), false, '旧 socket 的 ping 定时器应清理');
    }
    assert.equal(c.pingTimers.size, 0);
    await c.onMessage(c.ws, JSON.stringify({ type: 'welcome', desktopVersion: 'mock' }));
    assert.equal(c.pingTimers.size, 1, `第 ${round + 1} 次连接后应只有 1 个 ping 定时器`);
    const reqId = c.send(qkey('swap'), conv('swap', round + 1));
    assert.ok(reqId);
    assert.equal(c.inflight.size, 1);
    previous = c.ws;
  }
  assert.equal(c.inflight.size, 1, '只保留当前连接的在途请求');
  assert.equal(c.pingTimers.size, 1);
  c.cleanupSocket(c.ws);
  assert.equal(c.inflight.size, 0);
  assert.equal(c.pingTimers.size, 0);
  c.ws = null;
});

await T('替换连接只清理属于旧 socket 的条目，不误清其它 socket', async () => {
  class FakeWS {
    constructor() { this.readyState = 1; this.bufferedAmount = 0; }
    close() { this.readyState = 3; }
    send() {}
  }
  const storage = memStorage({ token: 't' });
  const c = new BridgeClient({ WebSocket: FakeWS, storage });
  await c.ready;
  const old = { readyState: 1, bufferedAmount: 0, send() {}, close() {} };
  const other = { readyState: 1, bufferedAmount: 0, send() {}, close() {} };
  c.ws = old;
  const oldId = c.send(qkey('old'), conv('old', 1));
  const otherId = c.send(qkey('other'), conv('other', 1));
  // 把第二条改成归属另一个 socket，模拟同 key 归属判定
  c.inflight.get(otherId).ws = other;
  c.inflightByKey.set(qkey('other'), otherId);
  await c.connect('654321');
  assert.ok(!c.inflight.has(oldId), '旧 socket 的条目应清理');
  assert.ok(c.inflight.has(otherId), '其它 socket 的条目不应被误清');
  c.cleanupSocket(c.ws);
  c.cleanupSocket(other);
  c.ws = null;
});

// 索引里的字节数应保持原值（超时不清队列、不改索引）
{
  const storage = memStorage({ token: 't' });
  const c = new BridgeClient({ WebSocket: IdleWS, storage });
  await c.ready;
  c.state = 'connected';
  c.ws = { readyState: 1, bufferedAmount: 0, send() {}, close() {} };
  await c.enqueue(conv('bytes', 7));
  assert.equal(storage.mem.qidx[qkey('bytes')].bytes, snapshotBytes(conv('bytes', 7)));
  c.ws = null;
}

console.log(`✓ 补发批次 ${pass}/${pass}`);
