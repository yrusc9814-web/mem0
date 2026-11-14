'use strict';
/**
 * 不依赖 Electron 的核心自测：采集 → 存储/搜索 → MCP → 插件桥 → 一键接入配置。
 * 用法：npm run selftest
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { Store } = require('../src/main/db');
const { LocalIngestor } = require('../src/main/ingest');
const { startMcpServer } = require('../src/main/mcp');
const { startBridge } = require('../src/main/bridge');
const register = require('../src/main/register');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mem0-test-'));
const j = (o) => JSON.stringify(o);
const old = Date.now() - 60_000;

// ---- 伪造 Claude Code 会话 ----
const ccDir = path.join(home, '.claude', 'projects', '-Users-me-proj');
fs.mkdirSync(ccDir, { recursive: true });
const ccFile = path.join(ccDir, 'aaaa-1111.jsonl');
fs.writeFileSync(ccFile, [
  j({ type: 'summary', summary: '修复登录接口的 JWT 过期问题' }),
  j({ type: 'user', sessionId: 'aaaa-1111', cwd: '/Users/me/proj', timestamp: '2026-11-01T10:00:00Z', message: { role: 'user', content: '登录接口返回 401，帮我看看 JWT 过期时间' } }),
  j({ type: 'assistant', sessionId: 'aaaa-1111', timestamp: '2026-11-01T10:00:05Z', message: { role: 'assistant', content: [{ type: 'text', text: '问题在 refreshToken 没有续期。' }, { type: 'tool_use', name: 'Edit', input: { file: 'auth.ts' } }] } }),
  j({ type: 'user', sessionId: 'aaaa-1111', timestamp: '2026-11-01T10:00:06Z', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }),
  j({ type: 'user', isSidechain: true, message: { role: 'user', content: '子任务不该被保存' } }),
].join('\n') + '\n');
fs.utimesSync(ccFile, old / 1000, old / 1000);

// ---- 伪造 Codex 会话 ----
const cxDir = path.join(home, '.codex', 'sessions', '2026', '11', '02');
fs.mkdirSync(cxDir, { recursive: true });
const cxFile = path.join(cxDir, 'rollout-2026-11-02T09-00-00-0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000.jsonl');
fs.writeFileSync(cxFile, [
  j({ timestamp: '2026-11-02T09:00:00Z', type: 'session_meta', payload: { id: '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000', cwd: '/Users/me/site' } }),
  j({ timestamp: '2026-11-02T09:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } }),
  j({ timestamp: '2026-11-02T09:00:02Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Write a Postgres migration for the orders table' }] } }),
  j({ timestamp: '2026-11-02T09:00:09Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Here is the migration adding an index on orders.created_at.' }] } }),
].join('\n') + '\n');
fs.utimesSync(cxFile, old / 1000, old / 1000);
fs.writeFileSync(path.join(home, '.codex', 'session_index.jsonl'), j({ id: '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000', thread_name: 'orders 表迁移' }) + '\n');

// ---- 伪造 DeepSeek Harness 会话（两代文件，取 v2；zstd 压缩） ----
const zlib = require('node:zlib');
const dshDir = path.join(home, '.dsh', 'sessions', 'proj-x', 'sess-1');
fs.mkdirSync(dshDir, { recursive: true });
fs.writeFileSync(path.join(dshDir, 'session.jsonl'), j({ type: 'session', id: 'dsh-old', version: 0, createdAt: old }) + '\n');
const dshLines = [
  j({ type: 'session', id: 'dsh-1', version: 2, createdAt: old, cwd: '/Users/me/dsh', isSeeded: false }),
  j({ type: 'user/message', seq: 0, time: old, surfaceOp: 'append', data: { id: 'u1', role: 'user', source: { kind: 'system' }, content: [{ type: 'text', text: '系统注入不保存' }] } }),
  j({ type: 'user/message', seq: 1, time: old + 1, surfaceOp: 'append', data: { id: 'u2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '用 Rust 实现一个 LRU 缓存' }] } }),
  j({ type: 'assistant/message', seq: 2, time: old + 2, surfaceOp: 'append', data: { message: { id: 'a1', role: 'assistant', content: [{ type: 'reasoning', text: 'x' }, { type: 'text', text: '使用 HashMap 加双向链表实现 LinkedHashMap 语义。' }] } } }),
  j({ type: 'session/title', seq: 3, time: old + 3, data: { title: 'Rust LRU 缓存' } }),
].join('\n') + '\n';
fs.writeFileSync(path.join(dshDir, 'session.v2.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(dshLines)));
for (const f of fs.readdirSync(dshDir)) fs.utimesSync(path.join(dshDir, f), old / 1000, old / 1000);

// ---- 伪造 Antigravity 会话 ----
const agBrain = path.join(home, '.gemini', 'antigravity-ide', 'brain', 'cascade-123');
fs.mkdirSync(path.join(agBrain, '.system_generated', 'logs'), { recursive: true });
fs.writeFileSync(path.join(agBrain, 'task.md'), '# 搭建 Next.js 博客\n- [ ] init\n');
const agFile = path.join(agBrain, '.system_generated', 'logs', 'transcript.jsonl');
fs.writeFileSync(agFile, [
  j({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-11-03T08:00:00Z', content: '<USER_REQUEST>帮我搭一个 Next.js 博客，支持 MDX</USER_REQUEST>\n<ADDITIONAL_METADATA>…</ADDITIONAL_METADATA>' }),
  j({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-03T08:00:03Z', content: '先创建项目结构。', thinking: 'internal' }),
  j({ step_index: 2, source: 'SYSTEM', type: 'TOOL_RUN_COMMAND', created_at: '2026-11-03T08:00:04Z', content: 'npx create-next-app' }),
  j({ step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-03T08:00:09Z', content: '已配置 @next/mdx 插件。' }),
].join('\n') + '\n');
fs.utimesSync(agFile, old / 1000, old / 1000);

// ---- 伪造 ZCode 数据库 ----
const { DatabaseSync } = require('node:sqlite');
const zDb = path.join(home, '.zcode', 'cli', 'db', 'db.sqlite');
fs.mkdirSync(path.dirname(zDb), { recursive: true });
{
  const d = new DatabaseSync(zDb);
  d.exec(`CREATE TABLE session(id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);`);
  d.prepare('INSERT INTO session VALUES (?,?,?,?,?,?)').run('z1', null, '/Users/me/zz', 'Vue 组件重构', old, old + 10);
  d.prepare('INSERT INTO session VALUES (?,?,?,?,?,?)').run('z1-sub', 'z1', '/Users/me/zz', 'sub', old, old);
  d.prepare('INSERT INTO message VALUES (?,?,?,?)').run('m1', 'z1', old, j({ role: 'user' }));
  d.prepare('INSERT INTO message VALUES (?,?,?,?)').run('m2', 'z1', old + 5, j({ role: 'assistant' }));
  d.prepare('INSERT INTO part VALUES (?,?,?,?)').run('p1', 'm1', 'z1', j({ type: 'text', text: '把 Options API 改成 Composition API' }));
  d.prepare('INSERT INTO part VALUES (?,?,?,?)').run('p2', 'm2', 'z1', j({ type: 'text', text: '已改用 setup() 与 ref()。' }));
  d.prepare('INSERT INTO part VALUES (?,?,?,?)').run('p3', 'm2', 'z1', j({ type: 'text', text: '合成内容', synthetic: true }));
  d.close();
}
fs.utimesSync(zDb, old / 1000, old / 1000);

// ---- 伪造 DimCode 数据库 ----
const dDb = path.join(home, '.dimcode', 'v2', 'dimcode.sqlite');
fs.mkdirSync(path.dirname(dDb), { recursive: true });
{
  const d = new DatabaseSync(dDb);
  d.exec(`CREATE TABLE sessions (sessionId TEXT PRIMARY KEY, cwd TEXT NOT NULL DEFAULT '', title TEXT, status TEXT NOT NULL, tags TEXT, heldBy TEXT, heldAt TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, version INTEGER NOT NULL);
    CREATE TABLE messages (messageId TEXT PRIMARY KEY, sessionId TEXT NOT NULL, role TEXT NOT NULL, parts TEXT NOT NULL, attachments TEXT, toolMetadata TEXT, metadata TEXT, orderKey TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
    CREATE TABLE session_catalog_entries (sessionId TEXT PRIMARY KEY, cwd TEXT NOT NULL, status TEXT NOT NULL, topLevel INTEGER NOT NULL, source TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);`);
  const S = d.prepare('INSERT INTO sessions VALUES (?,?,?,?,NULL,NULL,NULL,?,?,1)');
  S.run('d1', '/Users/me/dim', 'Go 服务限流', 'active', '2026-11-04T01:00:00Z', '2026-11-04T01:05:00Z');
  S.run('d2', '/Users/me/dim', 'sub', 'active', '2026-11-04T01:01:00Z', '2026-11-04T01:02:00Z');
  const C = d.prepare('INSERT INTO session_catalog_entries VALUES (?,?,?,?,?,?,?)');
  C.run('d1', '/Users/me/dim', 'active', 1, null, 'x', 'x'); C.run('d2', '/Users/me/dim', 'active', 0, null, 'x', 'x');
  const M = d.prepare('INSERT INTO messages VALUES (?,?,?,?,NULL,NULL,NULL,?,?,?)');
  M.run('a', 'd1', 'user', j([{ type: 'text', text: '给 Go 服务加令牌桶限流' }]), '0001', '2026-11-04T01:00:00Z', 'x');
  M.run('b', 'd1', 'assistant', j([{ type: 'reasoning', text: 'think' }, { type: 'text', text: '用 golang.org/x/time/rate。' }, { type: 'tool-call', toolName: 'edit' }]), '0002', '2026-11-04T01:00:05Z', 'x');
  M.run('c', 'd1', 'tool_result', j([{ type: 'text', text: '工具输出' }]), '0003', '2026-11-04T01:00:06Z', 'x');
  M.run('e', 'd1', 'assistant', j([{ type: 'text', text: '已加中间件。' }]), '0004', '2026-11-04T01:00:09Z', 'x');
  M.run('f', 'd2', 'user', j([{ type: 'text', text: '子代理任务' }]), '0001', '2026-11-04T01:01:00Z', 'x');
  d.close();
}
fs.utimesSync(dDb, old / 1000, old / 1000);

(async () => {
  const store = Store.open(fs.mkdtempSync(path.join(os.tmpdir(), 'mem0-data-')));
  const { sourceRoots } = require('../src/main/paths');
  const ing = new LocalIngestor(store, sourceRoots(home));

  // 1. 采集
  const r1 = await ing.scanOnce();
  assert.equal(r1.changed, 6, '应采集 6 个会话');
  const r2 = await ing.scanOnce();
  assert.equal(r2.changed, 0, '未变化的文件不应重复处理');
  const list = store.listConversations();
  const cc = list.find((c) => c.source === 'claude-code');
  const cx = list.find((c) => c.source === 'codex');
  assert.equal(cc.title, '修复登录接口的 JWT 过期问题');
  assert.equal(cc.workspace, '/Users/me/proj');
  assert.equal(cx.title, 'orders 表迁移');
  const ccFull = store.getConversation(cc.id);
  assert.ok(!ccFull.messages.some((m) => m.content.includes('子任务')), 'sidechain 应被过滤');
  assert.equal(store.getConversation(cx.id).messages.length, 2, 'Codex 注入的环境消息应被过滤');
  const dsh = list.find((c) => c.source === 'deepseek-harness');
  assert.equal(dsh.title, 'Rust LRU 缓存'); assert.equal(dsh.message_count, 2, 'dsh 取最新一代、跳过系统注入');
  const ag = list.find((c) => c.source === 'antigravity');
  assert.equal(ag.title, '搭建 Next.js 博客');
  const agFull = store.getConversation(ag.id);
  assert.equal(agFull.messages[0].content, '帮我搭一个 Next.js 博客，支持 MDX');
  assert.equal(agFull.messages.length, 2, 'Antigravity 工具步骤跳过，连续回复合并');
  const zc = list.filter((c) => c.source === 'zcode');
  assert.equal(zc.length, 1, 'ZCode 子会话不单独保存'); assert.equal(zc[0].title, 'Vue 组件重构');
  assert.ok(!store.getConversation(zc[0].id).messages.some((m) => m.content.includes('合成')), 'synthetic 部分过滤');
  const dm = list.filter((c) => c.source === 'dimcode');
  assert.equal(dm.length, 1, 'DimCode 子代理会话不单独保存'); assert.equal(dm[0].title, 'Go 服务限流');
  const dmFull = store.getConversation(dm[0].id);
  assert.equal(dmFull.messages.length, 2, 'tool_result 跳过、assistant 合并');
  assert.ok(dmFull.messages[1].content.includes('已加中间件') && !dmFull.messages[1].content.includes('think'));
  console.log('✓ 本机采集（Claude Code / Codex / DeepSeek Harness / Antigravity / ZCode / DimCode）');

  // 增量追加
  fs.appendFileSync(ccFile, j({ type: 'user', sessionId: 'aaaa-1111', timestamp: '2026-11-01T10:01:00Z', message: { role: 'user', content: '再加一个单元测试' } }) + '\n');
  fs.utimesSync(ccFile, (old + 1000) / 1000, (old + 1000) / 1000);
  assert.equal((await ing.scanOnce()).changed, 1);
  console.log('✓ 增量更新');

  // 2. 搜索
  assert.equal(store.search('refreshToken')[0].conversationId, cc.id);
  assert.equal(store.search('过期时间')[0].conversationId, cc.id, '中文 trigram');
  assert.equal(store.search('登录')[0].conversationId, cc.id, '2 字中文走 LIKE 兜底');
  assert.equal(store.search('migration orders')[0].conversationId, cx.id, '多关键词 AND');
  assert.equal(store.search('migration', { sources: ['claude-code'] }).length, 0, '来源过滤');
  console.log('✓ 全文搜索（中文/英文/多词/过滤）');

  // 3. MCP
  const port = 39790;
  const mcp = await startMcpServer(store, { port });
  const client = new Client({ name: 'selftest', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url)));
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ['list_conversations', 'recall']);
  const rc = (await client.callTool({ name: 'recall', arguments: { query: 'JWT', alternatives: ['refreshToken', '登录'] } })).content[0].text;
  assert.ok(rc.includes('【1】来源：Claude Code'), rc);
  assert.ok(/\[用户\] |\[AI\] /.test(rc), '片段带角色标签');
  const pid = rc.match(/process_id: ([0-9a-f-]{36})/)[1];
  const rc2 = (await client.callTool({ name: 'recall', arguments: { query: 'JWT', alternatives: ['refreshToken', '登录'], process_id: pid } })).content[0].text;
  const said = (x) => x.split('\n').filter((l) => /^\[(用户|AI)\] /.test(l));
  assert.ok(rc2.includes(`process_id: ${pid}`), 'process_id 原样回显');
  assert.ok(said(rc2).every((l) => !said(rc).includes(l)), '同 process_id 不重复交付');
  const ld = (await client.callTool({ name: 'list_conversations', arguments: { from: '2026-02-30', to: '2026-03-01' } }));
  assert.ok(ld.isError, '非法日期应报错');
  await client.close();
  const bad = await fetch(mcp.url, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(bad.status, 403, '跨站 Origin 应被拒绝');
  console.log('✓ MCP 服务（list_conversations + recall 两个工具、去重、日期校验 + Origin 防护）');

  // 4. 插件桥
  const bport = 39791;
  const bridge = await startBridge(store, { port: bport });
  const connect = (origin) => new WebSocket(`ws://127.0.0.1:${bport}/browser/v1`, { origin });
  const once = (ws, ev) => new Promise((res, rej) => { ws.once(ev, res); ws.once('error', rej); });
  const next = (ws) => new Promise((res) => ws.once('message', (d) => res(JSON.parse(String(d)))));

  // 普通网页 Origin 被拒
  await assert.rejects(once(connect('https://evil.example'), 'open'));
  // 配对
  const { code } = bridge.newPairCode();
  let ws = connect('chrome-extension://abcdefghijklmnopabcdefghijklmnop');
  await once(ws, 'open');
  ws.send(j({ type: 'hello', protocol: 1, pairCode: code, extensionId: 'test' }));
  const welcome = await next(ws);
  assert.equal(welcome.type, 'welcome');
  assert.ok(welcome.token);
  ws.close();
  // token 重连 + 上报
  ws = connect('chrome-extension://abcdefghijklmnopabcdefghijklmnop');
  await once(ws, 'open');
  ws.send(j({ type: 'hello', protocol: 1, token: welcome.token }));
  assert.equal((await next(ws)).type, 'welcome');
  ws.send(j({ type: 'upsert', reqId: 1, conversation: { platform: 'deepseek', externalId: 'ds-1', title: 'DeepSeek 写诗', url: 'https://chat.deepseek.com/a/chat/s/ds-1', messages: [{ role: 'user', content: '写一首关于秋天的诗' }, { role: 'assistant', content: '秋风起兮白云飞' }] } }));
  const ack = await next(ws);
  assert.equal(ack.ok, true);
  assert.equal(ack.added, 2);
  // 流式更新同一条回答
  ws.send(j({ type: 'upsert', reqId: 2, conversation: { platform: 'deepseek', externalId: 'ds-1', messages: [{ role: 'user', content: '写一首关于秋天的诗' }, { role: 'assistant', content: '秋风起兮白云飞，草木黄落兮雁南归。' }] } }));
  const ack2 = await next(ws);
  assert.equal(ack2.changed, true); assert.equal(ack2.added, 0);
  assert.equal(store.search('雁南归')[0].source, 'deepseek-web');
  // 页面只渲染了后半段（懒加载）：不能覆盖已存的前半段
  ws.send(j({ type: 'upsert', reqId: 3, conversation: { platform: 'deepseek', externalId: 'ds-1', messages: [{ role: 'assistant', content: '秋风起兮白云飞，草木黄落兮雁南归。' }, { role: 'user', content: '再来一首冬天的' }] } }));
  await next(ws);
  const dsConv = store.getConversation(store.search('雁南归')[0].conversationId);
  assert.deepEqual(dsConv.messages.map((m) => m.content), ['写一首关于秋天的诗', '秋风起兮白云飞，草木黄落兮雁南归。', '再来一首冬天的'], '部分快照应对齐追加');
  ws.close();
  // 错误配对码
  ws = connect('chrome-extension://abcdefghijklmnopabcdefghijklmnop');
  await once(ws, 'open');
  ws.send(j({ type: 'hello', protocol: 1, pairCode: '000000' }));
  assert.equal((await next(ws)).type, 'error');
  console.log('✓ 插件桥（配对、token、上报、流式更新、Origin 防护）');

  // 5. 一键接入
  fs.writeFileSync(path.join(home, '.claude.json'), j({ numStartups: 3, mcpServers: { other: { command: 'x' } } }));
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n');
  register.connectClient('claude-code', mcp.url, home);
  register.connectClient('codex', mcp.url, home);
  register.connectClient('codex', mcp.url, home); // 幂等
  const cj = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
  assert.equal(cj.mcpServers.mem0.url, mcp.url); assert.ok(cj.mcpServers.other); assert.equal(cj.numStartups, 3);
  const toml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
  assert.equal(toml.match(/\[mcp_servers\.mem0\]/g).length, 1); assert.ok(toml.includes('[mcp_servers.other]'));
  assert.deepEqual(register.listClients(mcp.url, home).map((c) => c.status), ['connected', 'connected', 'not_installed']); // 第三个是 WorkBuddy（临时 HOME 下无 ~/.workbuddy）
  register.disconnectClient('codex', home);
  assert.ok(!fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8').includes('mem0'));
  assert.ok(fs.readdirSync(path.join(home, '.codex')).some((f) => f.includes('.mem0-backup-')), '应有备份');
  console.log('✓ 一键接入 Claude Code / Codex（含备份、幂等、断开）');

  await bridge.close(); await mcp.close(); store.close();
  console.log('\n全部通过');
  process.exit(0);
})().catch((e) => { console.error('✗', e); process.exit(1); });
