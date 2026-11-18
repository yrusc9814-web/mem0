'use strict';
/**
 * 本地 MCP 四工具（list_conversations + recall + get_memory_context + save_memory）验收测试：AC-MCP1 ~ AC-MCP3、J2 读写与「今天互通」计数。
 * 用法：node --no-warnings test/mcp-recall.js
 * 只在临时目录建库，经真实 Streamable HTTP（SDK 客户端）调用，不触碰真实 HOME / 端口 3790。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'mem0-mcp-recall-'));
// MCP 访问密钥写到临时数据目录，绝不触碰真实 HOME
process.env.MEM0_DATA_DIR = path.join(T, 'data');
const ROOT = path.resolve(__dirname, '..');
const { Store } = require(path.join(ROOT, 'src/main/db'));
const { startMcpServer, DEFAULT_PORT, mcpEvents, _internal } = require(path.join(ROOT, 'src/main/mcp'));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const results = [];
async function t(section, name, fn) {
  try { await fn(); results.push({ section, name, ok: true }); }
  catch (e) { results.push({ section, name, ok: false, err: (e && e.message ? e.message : String(e)).split('\n').slice(0, 6).join(' | ') }); }
}
const pad = (n) => String(n).padStart(2, '0');
const at = (y, m, d, h = 10, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();
const dayStr = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const said = (txt) => txt.split('\n').filter((l) => /^\[(用户|AI)\] /.test(l));
const blocks = (txt) => (txt.match(/^【\d+】.*$/gm) || []);
const strip = (l) => l.replace(/^\[(用户|AI)\] /, '').replace(/^…/, '').replace(/…$/, '');
const PID_RE = /process_id: ([0-9a-f-]{36})（当前对话窗口固定值；后续每次调用 recall 都必须原样传回，即使更换 query 也不得更换）$/;
const MORE = '仍有尚未交付的候选证据；可再次调用 recall 获取其他证据，已交付片段会自动跳过。';

// ---------- fixture ----------
const dir = path.join(T, 'db'); fs.mkdirSync(dir);
let store = Store.open(dir);
const ALL_CONTENT = [];
function up(c) { for (const m of c.messages) ALL_CONTENT.push(m.content); return store.upsertConversation(c); }

// 20 个会话都聊到「向量数据库」，用于翻页去重
for (let i = 1; i <= 20; i++) {
  up({
    source: i % 2 ? 'claude-code' : 'codex', externalId: `vec${i}`, ingestMethod: 'local', title: `检索方案第 ${i} 轮`, workspace: `/work/p${i}`,
    messages: [
      { role: 'user', content: `第 ${i} 次讨论：我决定先用向量数据库做语义检索，预算有限。`, createdAt: at(2026, 10, i) },
      { role: 'assistant', content: `建议 ${i}：向量数据库可以选 pgvector，部署简单。也可以考虑托管服务。`, createdAt: at(2026, 10, i, 10, 1) },
    ],
  });
}
// 只用英文变体 Milvus 说的会话：只有 alternatives 才能召回
up({ source: 'antigravity', externalId: 'milvus', ingestMethod: 'local', title: '技术选型杂谈',
  messages: [
    { role: 'user', content: '我们之前评估过 Milvus，觉得运维太重。', createdAt: at(2026, 9, 15) },
    { role: 'assistant', content: '理解，Milvus 集群需要 etcd 与对象存储。', createdAt: at(2026, 9, 15, 10, 2) },
  ] });
// 网页来源（无时间戳 → 采集时间）
up({ source: 'chatgpt-web', externalId: 'web1', ingestMethod: 'browser-extension', title: '网页上问的向量检索',
  messages: [
    { role: 'user', content: '网页里问：向量数据库和全文检索怎么取舍？' },
    { role: 'assistant', content: '网页回答：两者可以混合检索。' },
  ] });
// 长消息：命中只在中间一小段
const LONG = '开头背景介绍。'.repeat(120) + '这里是关键结论：我们最终放弃 Elasticsearch 改用 SQLite FTS5。理由是桌面端零依赖。' + '后续补充说明。'.repeat(150);
up({ source: 'dimcode', externalId: 'long', ingestMethod: 'local', title: '长讨论',
  messages: [{ role: 'user', content: '帮我总结一下搜索引擎选型', createdAt: at(2026, 8, 1) }, { role: 'assistant', content: LONG, createdAt: at(2026, 8, 1, 10, 5) }] });
// 同一会话多处命中（超过单会话每次 2 段上限）
up({ source: 'zcode', externalId: 'multi', ingestMethod: 'local', title: '缓存策略',
  messages: Array.from({ length: 10 }, (_, k) => ({ role: k % 2 ? 'assistant' : 'user', content: `第 ${k} 条：Redis 缓存过期策略讨论，要点 ${k}。`, createdAt: at(2026, 7, 1, 9, k) })) });

(async () => {
  const port = 39890;
  const mcp = await startMcpServer(store, { port, version: 'test' });
  const client = new Client({ name: 'mcp-recall-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url)));
  const call = async (name, args) => {
    try { return await client.callTool({ name, arguments: args }); } catch (e) { return { isError: true, thrown: e.message, content: [{ type: 'text', text: e.message }] }; }
  };
  const txt = (r) => r.content[0].text;

  // =================== AC-MCP1 ===================
  await t('AC-MCP1', 'tools/list 为 4 个工具；旧工具已移除', async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((x) => x.name).sort(), ['get_memory_context', 'list_conversations', 'recall', 'save_memory']);
    for (const old of ['search_conversations', 'read_conversation']) {
      const r = await call(old, { query: 'x', id: 'x' });
      assert.ok(r.isError, `${old} 应不存在`);
    }
    assert.equal(DEFAULT_PORT, 3790);
  });
  await t('AC-MCP1', 'instructions 与 description 符合规范（何时用哪个、区分 [用户]/[AI]、不编造）', async () => {
    const ins = client.getInstructions();
    assert.ok(ins.includes('list_conversations') && ins.includes('recall') && ins.includes('不必每次先列目录'), ins);
    const { tools } = await client.listTools();
    const rc = tools.find((x) => x.name === 'recall');
    assert.ok(rc.description.includes('[用户]') && rc.description.includes('[AI]') && rc.description.includes('不要把过往 AI 的建议当成用户已经接受的决定') && rc.description.includes('不要编造记忆'));
    const props = rc.inputSchema.properties;
    assert.deepEqual(Object.keys(props).sort(), ['alternatives', 'from', 'process_id', 'query', 'sources', 'to']);
    assert.deepEqual(rc.inputSchema.required, ['query']);
    assert.equal(props.alternatives.maxItems, 8);
    const lc = tools.find((x) => x.name === 'list_conversations');
    assert.deepEqual([...(lc.inputSchema.required || [])].sort(), [], 'project 模式可免日期，from/to 不再静态必填');
    assert.ok(lc.inputSchema.properties.project, '应提供可选 project 参数');
    assert.equal(lc.inputSchema.properties.project.maxLength, 120);
    assert.equal(lc.inputSchema.properties.project.minLength, 1);
    assert.ok(lc.description.includes('project'), lc.description);
    assert.ok(Array.isArray(lc.inputSchema.properties.sources.items.enum) && lc.inputSchema.properties.sources.items.enum.includes('chatgpt-web'));
    for (const s of ['grok-web', 'hark-web']) assert.ok(lc.inputSchema.properties.sources.items.enum.includes(s), s);
  });
  await t('AC-MCP1', 'list_conversations 非法日期全部拦截（格式/不存在的日期/缺参/to<from）', async () => {
    const bad = [
      {}, { from: '2026-10-01' }, { to: '2026-10-01' },
      { from: '2026-02-30', to: '2026-03-01' }, { from: '2026-13-01', to: '2026-13-02' }, { from: '2026-04-31', to: '2026-05-01' },
      { from: '2026-1-01', to: '2026-01-02' }, { from: '2026/10/01', to: '2026/10/02' }, { from: '上周', to: '本周' },
      { from: '2026-10-01T00:00:00Z', to: '2026-10-02' }, { from: '', to: '' },
      { from: '2026-10-10', to: '2026-10-01' }, { from: '2026-10-01', to: '2026-10-02', sources: ['evil-web'] },
    ];
    for (const a of bad) {
      const r = await call('list_conversations', a);
      assert.ok(r.isError, `应拦截 ${JSON.stringify(a)}`);
    }
    const r = await call('list_conversations', { from: '2026-10-10', to: '2026-10-01' });
    assert.ok(txt(r).includes('不能早于') && txt(r).includes('YYYY-MM-DD'), txt(r));
    const r2 = await call('list_conversations', { from: '2026-02-30', to: '2026-03-01' });
    assert.ok(txt(r2).includes('YYYY-MM-DD') && txt(r2).includes('换算'), txt(r2));
  });
  await t('AC-MCP1', 'list_conversations 跨度 >31 天拦截，31 天放行；闰年 2-29 合法', async () => {
    const r = await call('list_conversations', { from: '2026-10-01', to: '2026-11-01' }); // 32 天
    assert.ok(r.isError && txt(r).includes('31') && txt(r).includes('YYYY-MM-DD'), txt(r));
    const ok = await call('list_conversations', { from: '2026-10-01', to: '2026-10-31' }); // 31 天
    assert.ok(!ok.isError, txt(ok));
    assert.ok(!(await call('list_conversations', { from: '2024-02-29', to: '2024-02-29' })).isError);
    assert.ok((await call('list_conversations', { from: '2025-12-15', to: '2026-01-16' })).isError, '跨年 33 天');
  });
  await t('AC-MCP1', 'list_conversations 按本地日期出目录：来源名/标题/时间/消息数，不含正文；sources 过滤', async () => {
    const r = txt(await call('list_conversations', { from: '2026-10-03', to: '2026-10-05' }));
    assert.ok(r.includes('## 2026-10-05') && r.includes('## 2026-10-03') && !r.includes('## 2026-10-06'), r);
    assert.ok(r.indexOf('## 2026-10-05') < r.indexOf('## 2026-10-03'), '新的在前');
    assert.ok(r.includes('- [Claude Code] 检索方案第 3 轮 · 10:00–10:01 · 当日 2 条 / 共 2 条消息'), r);
    assert.ok(r.includes('[Codex] 检索方案第 4 轮'), r);
    assert.ok(!r.includes('向量数据库'), '目录不含正文');
    const s = txt(await call('list_conversations', { from: '2026-10-03', to: '2026-10-05', sources: ['codex'] }));
    assert.ok(s.includes('检索方案第 4 轮') && !s.includes('检索方案第 3 轮'), s);
    const all = txt(await call('list_conversations', { from: '2026-10-03', to: '2026-10-05', sources: [] }));
    assert.ok(all.includes('检索方案第 3 轮') && all.includes('检索方案第 4 轮'), '空数组 = 全部来源');
    const empty = txt(await call('list_conversations', { from: '2020-01-01', to: '2020-01-02' }));
    assert.ok(empty.includes('没有找到'), empty);
  });
  await t('AC-MCP1', 'list_conversations 网页来源注明「采集时间」', async () => {
    const today = dayStr(Date.now());
    const r = txt(await call('list_conversations', { from: today, to: today }));
    assert.ok(r.includes('[ChatGPT 网页] 网页上问的向量检索 · 采集于'), r);
    assert.ok(r.includes('插件采集时间'), r);
  });

  // =================== AC-MCP2 ===================
  await t('AC-MCP2', 'recall 返回纯文本证据块：【N】、来源、会话标题、时间、[用户]/[AI] 前缀，非 JSON', async () => {
    const r = txt(await call('recall', { query: '向量数据库' }));
    assert.ok(!/^\s*[[{]/.test(r) && !r.includes('"conversationId"'), '非 JSON');
    const bs = blocks(r);
    assert.ok(bs.length >= 5 && bs.length <= 8, `单次 5–8 段，实际 ${bs.length}`);
    bs.forEach((b, i) => assert.match(b, new RegExp(`^【${i + 1}】来源：\\S.* ｜ 会话：.+ ｜ 时间：(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2})`)));
    const lines = said(r);
    assert.ok(lines.length >= bs.length);
    assert.ok(lines.some((l) => l.startsWith('[用户] ')) && lines.some((l) => l.startsWith('[AI] ')));
    // 角色标签与原始角色一致
    for (const l of lines) {
      const body = strip(l);
      if (/^第 \d+ 次讨论/.test(body)) assert.ok(l.startsWith('[用户] '), l);
      if (/^建议 \d+/.test(body)) assert.ok(l.startsWith('[AI] '), l);
    }
    // 原文未改写：每段正文都是某条原始消息的子串
    for (const l of lines) assert.ok(ALL_CONTENT.some((c) => c.includes(strip(l))), `非原文：${l}`);
    assert.match(r, PID_RE);
  });
  await t('AC-MCP2', 'alternatives 参与合并检索（英文变体 Milvus 只有带上才召回）', async () => {
    const without = txt(await call('recall', { query: '向量数据库', sources: ['antigravity'] }));
    assert.ok(!without.includes('Milvus'), without);
    const withAlt = txt(await call('recall', { query: '向量数据库', alternatives: ['Milvus', 'vector db'], sources: ['antigravity'] }));
    assert.ok(withAlt.includes('[用户] 我们之前评估过 Milvus，觉得运维太重。'), withAlt);
    assert.ok(withAlt.includes('来源：Antigravity ｜ 会话：技术选型杂谈 ｜ 时间：2026-09-15 10:00'), withAlt);
  });
  await t('AC-MCP2', 'from/to/sources 联合过滤', async () => {
    const r = txt(await call('recall', { query: '向量数据库', alternatives: ['pgvector'], from: '2026-10-05', to: '2026-10-07', sources: ['claude-code'] }));
    const bs = blocks(r);
    assert.ok(bs.length >= 1, r);
    for (const b of bs) {
      assert.ok(b.includes('来源：Claude Code'), b);
      const d = b.match(/时间：(\d{4}-\d{2}-\d{2})/)[1];
      assert.ok(d >= '2026-10-05' && d <= '2026-10-07', b);
    }
    assert.ok(r.includes('检索方案第 5 轮') && r.includes('检索方案第 7 轮') && !r.includes('检索方案第 6 轮'), r);
    const onlyFrom = txt(await call('recall', { query: '向量数据库', from: '2026-10-19' }));
    for (const b of blocks(onlyFrom)) { const d = b.match(/时间：(\d{4}-\d{2}-\d{2})/)[1]; assert.ok(d >= '2026-10-19', b); }
    const onlyTo = txt(await call('recall', { query: '向量数据库', to: '2026-10-02' }));
    for (const b of blocks(onlyTo)) { const d = b.match(/时间：(\d{4}-\d{2}-\d{2})/)[1]; assert.ok(d <= '2026-10-02', b); }
    const bad = await call('recall', { query: '向量数据库', from: '2026-10-07', to: '2026-10-05' });
    assert.ok(bad.isError && txt(bad).includes('不能早于'));
    assert.ok((await call('recall', { query: '向量数据库', from: '2026-02-29' })).isError);
  });
  await t('AC-MCP2', '网页来源注明插件采集时间而非实际发送时间', async () => {
    const r = txt(await call('recall', { query: '全文检索怎么取舍', sources: ['chatgpt-web'] }));
    assert.ok(/来源：ChatGPT 网页 ｜ 会话：网页上问的向量检索 ｜ 时间：.+（插件采集时间，非实际发送时间）/.test(r), r);
    assert.ok(r.includes('[用户] 网页里问：向量数据库和全文检索怎么取舍？') && r.includes('[AI] 网页回答：两者可以混合检索。'), r);
  });
  await t('AC-MCP2', '长消息只切命中附近、句界截断、有长度上限，并注明局部截取', async () => {
    const r = txt(await call('recall', { query: 'SQLite FTS5', alternatives: ['Elasticsearch'] }));
    assert.ok(r.includes('来源：DimCode ｜ 会话：长讨论'), r);
    assert.ok(r.includes('说明：仅截取长消息局部'), r);
    const ai = said(r).find((l) => l.includes('Elasticsearch'));
    assert.ok(ai && ai.startsWith('[AI] …') && ai.endsWith('…'), ai);
    assert.ok(ai.length < 520, `单段长度 ${ai.length}`);
    assert.ok(ai.includes('这里是关键结论：我们最终放弃 Elasticsearch 改用 SQLite FTS5。理由是桌面端零依赖。'), '命中句与紧邻后一句完整');
    assert.ok(LONG.includes(strip(ai)), '截取的是原文');
    assert.ok(/^\[AI\] …(开头背景介绍。)*这里是关键结论/.test(ai) && strip(ai).startsWith('开头背景介绍。'), '在句界开始');
    assert.ok(r.includes('[用户] 帮我总结一下搜索引擎选型'), '附带紧邻的一问');
  });
  await t('AC-MCP2', '同会话命中多于单次上限时注明「同会话另有 N 处命中未展示」', async () => {
    const r = txt(await call('recall', { query: 'Redis 缓存', sources: ['zcode'] }));
    assert.ok(blocks(r).length <= 2, r);
    assert.match(r, /说明：.*同会话另有 \d+ 处命中未展示/);
  });
  await t('AC-MCP2', '无结果：明确说明只是当前范围未命中、不要编造', async () => {
    const r = await call('recall', { query: '完全不存在的词汇组合 zxqv' });
    assert.ok(!r.isError);
    assert.ok(txt(r).includes('未找到') && txt(r).includes('切勿编造记忆'), txt(r));
    assert.match(txt(r), PID_RE);
    assert.ok(!txt(r).includes(MORE));
  });
  await t('AC-MCP2', 'recall 坏参数 → isError', async () => {
    for (const a of [{}, { query: '' }, { query: '   ' }, { query: 'x'.repeat(201) }, { query: 'a', alternatives: Array(9).fill('b') },
      { query: 'a', sources: ['nope'] }, { query: 'a', from: '2026-10' }, { query: 'a', to: 'yesterday' }, { query: 'a', process_id: '' }]) {
      assert.ok((await call('recall', a)).isError, JSON.stringify(a));
    }
  });

  // =================== AC-MCP3 ===================
  let pid;
  await t('AC-MCP3', '首次调用签发 UUID process_id 并固定附在末尾；传入的 process_id 原样回显', async () => {
    const r = txt(await call('recall', { query: 'pgvector' }));
    const m = r.match(PID_RE);
    assert.ok(m, r);
    pid = m[1];
    assert.match(pid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const r2 = txt(await call('recall', { query: 'pgvector' }));
    assert.notEqual(r2.match(PID_RE)[1], pid, '未传则每次新签发');
    const own = txt(await call('recall', { query: 'pgvector', process_id: 'my-window-1' }));
    assert.ok(own.endsWith('process_id: my-window-1（当前对话窗口固定值；后续每次调用 recall 都必须原样传回，即使更换 query 也不得更换）'));
  });
  await t('AC-MCP3', '同 process_id 同词连续翻页：互不重复，有剩余时提示，取尽后提示消失', async () => {
    const P = 'page-' + Date.now();
    const seen = new Set();
    let pages = 0; let lastHad = true; let total = 0;
    for (let i = 0; i < 20; i++) {
      const r = txt(await call('recall', { query: '向量数据库', process_id: P }));
      const bs = blocks(r);
      const lines = said(r);
      for (const l of lines) { assert.ok(!seen.has(l), `重复交付：${l}`); seen.add(l); }
      total += bs.length;
      pages++;
      if (!bs.length) { assert.ok(!r.includes(MORE), '无剩余时不应提示'); assert.ok(r.includes('全部交付过'), r); break; }
      lastHad = r.includes(MORE);
      if (!lastHad) break;
    }
    assert.ok(pages >= 3, `20 个会话 + 网页应至少翻 3 页，实际 ${pages}`);
    assert.ok(total >= 21, `应交付全部 21 个会话的命中，实际 ${total}`);
    const again = txt(await call('recall', { query: '向量数据库', process_id: P }));
    assert.equal(blocks(again).length, 0, again);
    assert.ok(!again.includes(MORE));
  });
  await t('AC-MCP3', '第一页有剩余候选时输出剩余提示（位于 process_id 行之前）', async () => {
    const H = 'hint-' + Date.now();
    const r = txt(await call('recall', { query: '向量数据库', process_id: H }));
    const lines = r.split('\n');
    assert.equal(lines[lines.length - 2], MORE, r);
    assert.ok(lines[lines.length - 1].startsWith(`process_id: ${H}（当前对话窗口固定值`), lines[lines.length - 1]);
  });
  await t('AC-MCP3', '同 process_id 换词追查：跳过已交付片段，只给新片段', async () => {
    const P = 'switch-' + Date.now();
    const a = txt(await call('recall', { query: '向量数据库', alternatives: ['pgvector'], from: '2026-10-01', to: '2026-10-03', process_id: P }));
    const aLines = said(a);
    assert.ok(aLines.length >= 3, a);
    const b = txt(await call('recall', { query: 'pgvector', alternatives: ['语义检索'], from: '2026-10-01', to: '2026-10-04', process_id: P }));
    for (const l of said(b)) assert.ok(!aLines.includes(l), `换词后重复：${l}`);
    assert.ok(b.includes('检索方案第 4 轮'), '新片段顺延返回：' + b);
    assert.ok(!b.includes('检索方案第 1 轮'), b);
    // 另一个窗口（不同 process_id）不受影响
    const c = txt(await call('recall', { query: 'pgvector', alternatives: ['语义检索'], from: '2026-10-01', to: '2026-10-04', process_id: 'other-' + Date.now() }));
    assert.ok(c.includes('检索方案第 1 轮'), c);
  });
  await t('AC-MCP3', '去重记录写入 SQLite（mcp_recall_delivered），24h TTL 过期后可再次交付', async () => {
    const P = 'ttl-' + Date.now();
    const r1 = txt(await call('recall', { query: 'Milvus', process_id: P }));
    assert.ok(blocks(r1).length >= 1);
    const n = store.db.prepare('SELECT COUNT(*) n FROM mcp_recall_delivered WHERE process_id = ?').get(P).n;
    assert.ok(n >= 1);
    assert.equal(blocks(txt(await call('recall', { query: 'Milvus', process_id: P }))).length, 0);
    store.db.prepare('UPDATE mcp_recall_delivered SET delivered_at = ? WHERE process_id = ?').run(Date.now() - 25 * 3600_000, P);
    assert.ok(blocks(txt(await call('recall', { query: 'Milvus', process_id: P }))).length >= 1, 'TTL 过期后重新交付');
  });
  await t('AC-MCP3', '内部函数直调：runRecall 签发 / 去重 / remaining 计数一致', async () => {
    const a = _internal.runRecall(store, { query: '向量数据库' });
    assert.ok(a.delivered >= 5 && a.delivered <= 8 && a.remaining > 0);
    const b = _internal.runRecall(store, { query: '向量数据库', process_id: a.processId });
    assert.ok(b.delivered >= 1 && b.remaining < a.remaining);
  });

  // =================== D4 限量与聚合 ===================
  await t('D4 限量', 'recall 候选消息上限 2000：超出部分不进入打分，结果仍是原文片段', async () => {
    const bulk = Array.from({ length: 2100 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `批量候选 ${i} bulkmark`, createdAt: at(2026, 6, 1, 9, 0) + i }));
    store.upsertConversation({ source: 'workbuddy', externalId: 'bulk', ingestMethod: 'local', title: '批量候选会话', messages: bulk });
    const res = _internal.runRecall(store, { query: 'bulkmark', process_id: 'bulk-' + Date.now() });
    assert.ok(res.delivered >= 1 && res.remaining > 0, `单会话每次最多 2 段，仍有剩余：${JSON.stringify({ d: res.delivered, r: res.remaining })}`);
    for (const l of said(res.text)) assert.ok(bulk.some((c) => c.content.includes(strip(l))), `非原文：${l}`);

    // 假 store 精确计数：2000 条小消息（远低于 50 MiB）→ 候选恰为 2000 条
    const fakeRows = Array.from({ length: 2500 }, (_, i) => ({ id: `r${i}`, conversation_id: `c${i}`, seq: 0, role: 'user', content: 'z'.repeat(100), created_at: 1, source: 'codex', title: 't' }));
    const hitLimits = [];
    const fakeStore = {
      recallTermHits: (term, o) => { hitLimits.push(o.limit); return fakeRows; },
      recallTitleHits: () => [], firstMessage: () => null, pruneDelivered() {}, getDelivered: () => new Map(), addDelivered() {},
      getMessagesBySeq: () => [],
    };
    const r = _internal.runRecall(fakeStore, { query: 'abc', alternatives: ['def'] });
    assert.deepEqual([...new Set(hitLimits)], [300], '每词 limit 仍为 TERM_HIT_LIMIT');
    assert.equal(r.remaining, 2000 - r.delivered, `候选应截断到 2000 条，实际 remaining=${r.remaining} delivered=${r.delivered}`);
  });
  await t('D4 限量', 'recall 正文累计上限 50 MiB：按 content.length*2 先到先停，不抛错', async () => {
    const big = 'y'.repeat(3 * 1024 * 1024); // 每条 6 MiB 估算
    const fakeRows = Array.from({ length: 40 }, (_, i) => ({ id: `b${i}`, conversation_id: `c${i}`, seq: 0, role: 'user', content: big, created_at: 1, source: 'codex', title: 't' }));
    let termsCalled = 0;
    const fakeStore = {
      recallTermHits: () => { termsCalled++; return fakeRows; },
      recallTitleHits: () => [], firstMessage: () => null, pruneDelivered() {}, getDelivered: () => new Map(), addDelivered() {},
      getMessagesBySeq: () => [],
    };
    const r = _internal.runRecall(fakeStore, { query: 'abc', alternatives: ['def', 'ghi', 'jkl'] });
    assert.ok(termsCalled >= 1);
    assert.ok(r.remaining <= 8, `50 MiB / 6 MiB ≈ 8 条，实际剩余 ${r.remaining}`);
    assert.ok(r.text.length > 0);
  });
  await t('D4 聚合', 'list_conversations：activity 聚合输出与旧版逐条时间点整理完全一致', async () => {
    // 旧版实现（.all() 逐条时间点），仅用于对比
    const oldActivity = ({ since, until, sources }) => {
      const sf = sources && sources.length ? ` AND c.source IN (${sources.map(() => '?').join(',')})` : '';
      const sa = sources && sources.length ? sources : [];
      const msgs = store.db.prepare(`SELECT m.conversation_id AS cid, m.created_at AS at FROM messages m
        JOIN conversations c ON c.id = m.conversation_id WHERE m.created_at >= ? AND m.created_at <= ?${sf}`).all(since, until, ...sa);
      const untimed = store.db.prepare(`SELECT c.id AS cid, c.updated_at AS at FROM conversations c
        WHERE c.updated_at >= ? AND c.updated_at <= ?${sf}
          AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.created_at IS NOT NULL)`).all(since, until, ...sa);
      return msgs.concat(untimed.map((r) => ({ ...r, untimed: true })));
    };
    const fmtDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
    const group = (points) => {
      const byDay = new Map();
      for (const p of points) {
        const day = fmtDay(p.at);
        if (!byDay.has(day)) byDay.set(day, new Map());
        const m = byDay.get(day); let g = m.get(p.cid);
        if (!g) { g = { cid: p.cid, first: p.at, last: p.at, n: 0, untimed: !!p.untimed }; m.set(p.cid, g); }
        g.first = Math.min(g.first, p.at); g.last = Math.max(g.last, p.at);
        if (!p.untimed) g.n++;
      }
      return [...byDay.keys()].sort().reverse().map((d) => [d, [...byDay.get(d).values()].sort((a, b) => b.last - a.last || a.cid.localeCompare(b.cid))]);
    };
    const groupNew = (activity) => {
      const byDay = new Map();
      for (const [cid, list] of activity) {
        for (const p of list) {
          const day = fmtDay(p.at);
          if (!byDay.has(day)) byDay.set(day, new Map());
          const m = byDay.get(day); let g = m.get(cid);
          if (!g) { g = { cid, first: p.at, last: p.at, n: 0, untimed: !!p.untimed }; m.set(cid, g); }
          g.first = Math.min(g.first, p.at); g.last = Math.max(g.last, p.at);
          if (!p.untimed) g.n += p.n;
        }
      }
      return [...byDay.keys()].sort().reverse().map((d) => [d, [...byDay.get(d).values()].sort((a, b) => b.last - a.last || a.cid.localeCompare(b.cid))]);
    };
    const from = _internal.parseDay('2026-06-01'); const to = new Date(2026, 6, 31).getTime();
    const until = new Date(to).setHours(23, 59, 59, 999);
    for (const sources of [undefined, [], ['claude-code'], ['codex', 'zcode']]) {
      const { activity } = store.conversationActivity({ since: from, until, sources });
      assert.deepEqual(groupNew(activity), group(oldActivity({ since: from, until, sources })), `sources=${JSON.stringify(sources)}`);
    }
    // 本地日期分组 + 输出文本对比：同一批数据走 runList 与旧逻辑重建的文本
    const out = _internal.runList(store, { from: '2026-06-01', to: '2026-06-30' });
    assert.ok(out.total >= 1 && out.text.includes('## 2026-06-'), out.text);
  });
  await t('D4 聚合', 'conversationActivity 不再 .all() 取每条消息时间点', async () => {
    const orig = store.db.prepare.bind(store.db);
    let fullReads = 0;
    store.db.prepare = (sql) => {
      const st = orig(sql);
      if (/\bFROM messages\b/.test(sql)) {
        const all = st.all.bind(st);
        st.all = (...a) => { fullReads++; return all(...a); };
      }
      return st;
    };
    try {
      const { activity } = store.conversationActivity({ since: at(2026, 1, 1), until: at(2026, 12, 31), sources: undefined });
      assert.ok(activity.size >= 1);
      assert.equal(fullReads, 0);
    } finally { store.db.prepare = orig; }
  });

  // =================== 今天互通计数 ===================
  await t('互通计数', '成功调用累加 + mcpEvents emit；失败调用不计数；重开库后保留', async () => {
    const before = store.getMcpCallsToday();
    assert.ok(before > 0, '前面的成功调用已计数');
    const events = [];
    const on = (e) => events.push(e);
    mcpEvents.on('call', on);
    await call('recall', { query: 'Redis' });
    await call('list_conversations', { from: '2026-10-01', to: '2026-10-02' });
    await call('list_conversations', { from: '2026-10-01', to: '2026-12-02' }); // 失败
    await call('recall', { query: '' }); // 失败
    await call('no_such_tool', {}); // 失败
    mcpEvents.off('call', on);
    assert.equal(store.getMcpCallsToday(), before + 2);
    assert.deepEqual(events.map((e) => e.today), [before + 1, before + 2]);
    const day = dayStr(Date.now());
    assert.equal(store.db.prepare('SELECT count FROM mcp_calls_daily WHERE day = ?').get(day).count, before + 2);
    assert.equal(store.bumpMcpCall(at(2020, 1, 1)), 1, '按本地日期分桶');
    assert.equal(store.getMcpCallsToday(), before + 2);
  });
  await t('互通计数', '既有表结构与 SCHEMA_VERSION 不变；新表幂等创建', async () => {
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 2);
    const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((x) => x.name);
    for (const n of ['conversations', 'messages', 'file_cursors', 'source_settings', 'kv', 'deleted_conversations', 'mcp_recall_delivered', 'mcp_calls_daily', 'projects', 'memories']) assert.ok(tables.includes(n), n);
    store.ensureMcpTables(); store.ensureMcpTables();
  });

  // =================== J1：事项筛选与 recall 记忆卡/事项简报 ===================
  await t('J1 事项目录', 'list_conversations 按事项 ID/名称筛选，输出事项名与摘要', async () => {
    const proj = store.saveProject({ name: 'J1 事项筛选验证', state: '推进中', workspace: '/work/j1-mcp' });
    const a = store.upsertConversation({
      source: 'claude-code', externalId: 'j1-proj-a', ingestMethod: 'local', title: 'J1 事项会话甲',
      workspace: '/work/j1-mcp',
      messages: [
        { role: 'user', content: 'J1 事项甲：订单缓存重构的讨论。', createdAt: at(2026, 5, 10, 9, 0) },
        { role: 'assistant', content: 'J1 事项甲：建议分阶段迁移。', createdAt: at(2026, 5, 10, 9, 1) },
      ],
    }).id;
    const b = store.upsertConversation({
      source: 'codex', externalId: 'j1-proj-b', ingestMethod: 'local', title: 'J1 事项会话乙',
      workspace: '/work/j1-mcp/sub',
      messages: [
        { role: 'user', content: 'J1 事项乙：灰度发布方案。', createdAt: at(2026, 5, 11, 14, 0) },
        { role: 'assistant', content: 'J1 事项乙：先小流量验证。', createdAt: at(2026, 5, 11, 14, 1) },
      ],
    }).id;
    store.updateConversationMeta(a, { summary: 'J1 摘要甲：缓存架构已定稿。' });
    assert.equal(store.getConversation(a).project_id, proj.id, '工作区自动归属');
    assert.equal(store.getConversation(b).project_id, proj.id, '子目录自动归属');
    const byId = txt(await call('list_conversations', { project: proj.id }));
    assert.ok(!byId.includes('没有找到'), byId);
    assert.ok(byId.includes('J1 事项会话甲') && byId.includes('J1 事项会话乙'), byId);
    assert.ok(!byId.includes('检索方案第 1 轮'), '不应混入无关会话');
    assert.ok(byId.includes('· 事项：J1 事项筛选验证'), byId);
    assert.ok(byId.includes('\n  摘要：J1 摘要甲：缓存架构已定稿。'), byId);
    assert.ok(byId.includes('## 2026-05-10') && byId.includes('## 2026-05-11'), byId);
    const byName = txt(await call('list_conversations', { project: 'j1 事项筛选' }));
    assert.ok(byName.includes('J1 事项会话甲') && byName.includes('J1 事项会话乙'), byName);
    const none = txt(await call('list_conversations', { project: '完全不存在的事项 zxqv' }));
    assert.ok(none.includes('没有找到'), none);
  });
  await t('J1 事项目录', '传入 project 时 from/to 可选；无 project 的坏参数仍全部 isError', async () => {
    assert.ok(!(await call('list_conversations', { project: 'J1 事项筛选' })).isError);
    assert.ok(!(await call('list_conversations', { project: 'J1 事项筛选', from: '2026-05-01', to: '2026-05-31' })).isError);
    const bad = [
      {}, { from: '2026-10-01' }, { to: '2026-10-01' },
      { from: '2026-02-30', to: '2026-03-01' }, { from: '2026-13-01', to: '2026-13-02' },
      { from: '2026-1-01', to: '2026-01-02' }, { from: '上周', to: '本周' }, { from: '', to: '' },
      { from: '2026-10-10', to: '2026-10-01' }, { from: '2026-10-01', to: '2026-11-02' },
      { from: '2026-10-01', to: '2026-10-02', sources: ['evil-web'] },
    ];
    for (const a of bad) assert.ok((await call('list_conversations', a)).isError, JSON.stringify(a));
    assert.ok((await call('list_conversations', { project: 'J1 事项筛选', from: '2026-05-10', to: '2026-05-01' })).isError, 'project 模式 to<from 仍拦截');
    assert.ok((await call('list_conversations', { project: 'J1 事项筛选', from: '2026-02-30' })).isError, 'project 模式非法日期仍拦截');
  });
  await t('J1 recall 卡片', 'recall 同时召回记忆卡与推进事项，证据块前输出且同 process_id 不重复', async () => {
    const mem = store.saveMemory({
      group: '踩坑与经验库', title: 'J1 去重卡片 Alpha',
      body: 'ZXQJ1TOKEN 记忆卡正文：MCP 去重验证，第二次不应重复。', tags: ['J1', '去重'],
    });
    store.saveMemory({
      group: '环境与工作流', title: 'J1 环境卡片',
      body: 'ZXQJ1ENV 环境约定：Windows 下使用 PowerShell。', tags: [],
    });
    const proj = store.saveProject({
      name: 'J1 召回事项 Beta', state: '待验证',
      progress: 'ZXQJ1TOKEN 事项进展：卡片与简报同时召回。',
      decisions: ['拍板：使用 mcp_recall_delivered 去重'],
      rejected: ['否决：同 process_id 重复刷屏'], nextStep: '补充 MCP 单测',
    });
    const P = 'j1-cards-' + Date.now();
    const r = txt(await call('recall', { query: 'ZXQJ1TOKEN 向量数据库', process_id: P }));
    assert.ok(r.includes('【记忆卡 · 踩坑与经验库】J1 去重卡片 Alpha'), r);
    assert.ok(r.includes('ZXQJ1TOKEN 记忆卡正文'), r);
    assert.ok(r.includes('【推进事项 · J1 召回事项 Beta】'), r);
    assert.ok(r.includes('已否决：否决：同 process_id 重复刷屏'), r);
    assert.ok(r.includes('下一步：补充 MCP 单测'), r);
    assert.ok(blocks(r).length >= 1, '原文证据仍照常交付：' + r);
    assert.ok(r.indexOf('【记忆卡 · 踩坑与经验库】') < r.indexOf('【1】'), '卡片应在证据块之前');
    const rows = store.db.prepare('SELECT msg_id FROM mcp_recall_delivered WHERE process_id = ?').all(P).map((x) => x.msg_id);
    assert.ok(rows.includes('mem:' + mem.id), rows.join(','));
    assert.ok(rows.includes('proj:' + proj.id), rows.join(','));
    const again = txt(await call('recall', { query: 'ZXQJ1TOKEN 向量数据库', process_id: P }));
    assert.ok(!again.includes('【记忆卡 · 踩坑与经验库】'), again);
    assert.ok(!again.includes('【推进事项 · J1 召回事项 Beta】'), again);
    const envOut = txt(await call('recall', { query: 'ZXQJ1ENV', process_id: 'j1-env-' + Date.now() }));
    assert.ok(envOut.includes('【记忆卡 · 环境与工作流】J1 环境卡片'), envOut);
    const onlyPid = 'j1-cards-only-' + Date.now();
    const cardsOnly = txt(await call('recall', { query: 'ZXQJ1TOKEN', process_id: onlyPid }));
    assert.ok(cardsOnly.includes('【记忆卡 · 踩坑与经验库】') && cardsOnly.includes('【推进事项 · J1 召回事项 Beta】'), cardsOnly);
    assert.equal(blocks(cardsOnly).length, 0, '仅命中卡片/事项时没有原文证据块');
    assert.ok(cardsOnly.includes('本轮未找到新的对话原文片段'), cardsOnly);
    const cardsAgain = txt(await call('recall', { query: 'ZXQJ1TOKEN', process_id: onlyPid }));
    assert.ok(!cardsAgain.includes('【记忆卡') && !cardsAgain.includes('【推进事项'), cardsAgain);
    assert.ok(cardsAgain.includes('未找到'), cardsAgain);
  });

  // =================== J2：get_memory_context 与 save_memory ===================
  await t('J2 工具', '两个新工具入参 schema 与 SPEC 一致（enum/长度/describe 文案）', async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((x) => x.name).sort(), ['get_memory_context', 'list_conversations', 'recall', 'save_memory']);
    const gm = tools.find((x) => x.name === 'get_memory_context');
    assert.deepEqual(Object.keys(gm.inputSchema.properties).sort(), ['groups', 'include_archived', 'project', 'tag']);
    assert.deepEqual([...(gm.inputSchema.required || [])], [], '空参概览：四个参数全部可选');
    assert.deepEqual(gm.inputSchema.properties.groups.items.enum, ['个人与职业背景', '协作与沟通准则', '环境与工作流', '踩坑与经验库']);
    assert.equal(gm.inputSchema.properties.groups.maxItems, 4);
    assert.equal(gm.inputSchema.properties.project.description, '可选，推进事项的 ID 或名称关键字，拉取该事项的进展、拍板结论、已否决方案与关联会话列表');
    assert.equal(gm.inputSchema.properties.project.maxLength, 120);
    assert.equal(gm.inputSchema.properties.tag.description, '可选，配合「踩坑与经验库」按标签过滤卡片');
    assert.equal(gm.inputSchema.properties.tag.maxLength, 50);
    assert.equal(gm.inputSchema.properties.include_archived.description, '可选，未指定具体事项时列出事项索引是否包含已结项归档事项，默认 false');
    const sm = tools.find((x) => x.name === 'save_memory');
    assert.deepEqual(sm.inputSchema.required, ['target_type']);
    assert.deepEqual(Object.keys(sm.inputSchema.properties).sort(), ['archived', 'body', 'card_id', 'decisions', 'group', 'next_step', 'progress', 'project', 'rejected', 'state', 'tags', 'target_type', 'title', 'workspace']);
    assert.deepEqual(sm.inputSchema.properties.target_type.enum, ['card', 'project']);
    assert.deepEqual(sm.inputSchema.properties.group.enum, ['个人与职业背景', '协作与沟通准则', '环境与工作流', '踩坑与经验库']);
    assert.equal(sm.inputSchema.properties.card_id.description, '可选，更新已有卡片时传入卡片 id；未传但同模块存在同名 title 时自动更新原卡并保留旧版记录');
    assert.equal(sm.inputSchema.properties.title.maxLength, 120);
    assert.equal(sm.inputSchema.properties.body.maxLength, 8000);
    assert.equal(sm.inputSchema.properties.tags.maxItems, 10);
    assert.equal(sm.inputSchema.properties.decisions.description, '可选，追加到事项「已拍板结论」的条目（自动去重）');
    assert.equal(sm.inputSchema.properties.rejected.description, '可选，追加到事项「已否决方案」的条目（自动去重）');
    assert.equal(sm.inputSchema.properties.next_step.maxLength, 500);
    const ins = client.getInstructions();
    assert.ok(ins.includes('get_memory_context') && ins.includes('save_memory'), ins);
  });

  await t('J2 save_memory', 'card 新建 origin_label=MCP 写入；同名更新复用原卡并把旧正文存入 superseded', async () => {
    const r1 = await call('save_memory', { target_type: 'card', group: '踩坑与经验库', title: 'J2 MCP 经验卡', body: 'J2 旧版正文：首次写入。', tags: ['J2', 'MCP'] });
    assert.ok(!r1.isError, txt(r1));
    assert.ok(txt(r1).includes('已新建常驻卡片：J2 MCP 经验卡'), txt(r1));
    const card = store.listMemories({ group: '踩坑与经验库' }).find((m) => m.title === 'J2 MCP 经验卡');
    assert.ok(card, '应写入卡片');
    assert.equal(card.originLabel, 'MCP 写入');
    assert.deepEqual(card.tags, ['J2', 'MCP']);
    assert.equal(card.superseded, '');
    const r2 = await call('save_memory', { target_type: 'card', group: '踩坑与经验库', title: 'J2 MCP 经验卡', body: 'J2 新版正文：同名更新。' });
    assert.ok(!r2.isError, txt(r2));
    const updated = store.getMemory(card.id);
    assert.equal(updated.id, card.id, '同名卡应复用 id');
    assert.equal(updated.body, 'J2 新版正文：同名更新。');
    assert.equal(updated.superseded, 'J2 旧版正文：首次写入。');
    assert.equal(updated.originLabel, 'MCP 写入');
    assert.deepEqual(updated.tags, ['J2', 'MCP'], '未传 tags 时保留原标签');
    const r3 = await call('save_memory', { target_type: 'card', group: '环境与工作流', card_id: card.id, title: 'J2 MCP 经验卡（迁移）', body: 'J2 迁移后的正文。', tags: ['J2'] });
    assert.ok(!r3.isError, txt(r3));
    const moved = store.getMemory(card.id);
    assert.equal(moved.group, '环境与工作流');
    assert.equal(moved.title, 'J2 MCP 经验卡（迁移）');
    assert.equal(moved.superseded, 'J2 新版正文：同名更新。');
    assert.deepEqual(moved.tags, ['J2']);
  });

  await t('J2 save_memory', 'project 新建/增量更新：decisions 与 rejected 追加去重，未传字段保持原值', async () => {
    const r1 = await call('save_memory', { target_type: 'project', project: 'J2 MCP 联调事项', state: '推进中', workspace: '/work/j2-mcp', progress: 'J2 首次进展', decisions: ['J2 拍板甲', 'J2 拍板乙'], rejected: ['J2 否决甲'], next_step: 'J2 首次下一步' });
    assert.ok(!r1.isError, txt(r1));
    assert.ok(txt(r1).includes('已新建推进事项：J2 MCP 联调事项'), txt(r1));
    const p = store.listProjects({ includeArchived: true }).find((x) => x.name === 'J2 MCP 联调事项');
    assert.ok(p, '应新建事项');
    assert.equal(p.state, '推进中');
    assert.equal(p.workspace, '/work/j2-mcp');
    assert.deepEqual(p.decisions, ['J2 拍板甲', 'J2 拍板乙']);
    assert.deepEqual(p.rejected, ['J2 否决甲']);
    const conv = store.upsertConversation({
      source: 'claude-code', externalId: 'j2-mcp-conv', ingestMethod: 'local', title: 'J2 事项关联会话',
      workspace: '/work/j2-mcp',
      messages: [
        { role: 'user', content: 'J2 关联会话：联调事项上下文。', createdAt: at(2026, 4, 2, 10, 0) },
        { role: 'assistant', content: 'J2 关联会话：已写入联调事项。', createdAt: at(2026, 4, 2, 10, 1) },
      ],
    });
    assert.equal(store.getConversation(conv.id).project_id, p.id, '工作区自动归属');
    const r2 = await call('save_memory', { target_type: 'project', project: 'j2 mcp 联调', state: '待验证', progress: 'J2 第二次进展', decisions: ['J2 拍板乙', 'J2 拍板丙'], rejected: ['J2 否决甲', 'J2 否决乙'], next_step: 'J2 第二次下一步', archived: true });
    assert.ok(!r2.isError, txt(r2));
    assert.ok(txt(r2).includes('已更新推进事项：J2 MCP 联调事项'), txt(r2));
    const p2 = store.getProject(p.id);
    assert.equal(p2.state, '待验证');
    assert.equal(p2.progress, 'J2 第二次进展');
    assert.deepEqual(p2.decisions, ['J2 拍板甲', 'J2 拍板乙', 'J2 拍板丙'], '追加去重且保持顺序');
    assert.deepEqual(p2.rejected, ['J2 否决甲', 'J2 否决乙']);
    assert.equal(p2.nextStep, 'J2 第二次下一步');
    assert.equal(p2.archived, true);
    assert.equal(p2.workspace, '/work/j2-mcp', '未传 workspace 保持原值');
    assert.equal(store.listProjects({ includeArchived: true }).filter((x) => x.name === 'J2 MCP 联调事项').length, 1, '按名称匹配更新而非重复新建');
  });

  await t('J2 save_memory', '坏参数全部 isError：缺 target_type / card 缺 group/title/body / 非法分组 / 缺 project / 不存在的 card_id', async () => {
    const bad = [
      {},
      { target_type: 'nope' },
      { target_type: 'card' },
      { target_type: 'card', title: 't', body: 'b' },
      { target_type: 'card', group: '踩坑与经验库', body: 'b' },
      { target_type: 'card', group: '踩坑与经验库', title: 't' },
      { target_type: 'card', group: '不存在的分组', title: 't', body: 'b' },
      { target_type: 'card', group: '踩坑与经验库', title: 't', body: 'b', card_id: 'no-such-card' },
      { target_type: 'project' },
      { target_type: 'project', project: '' },
      { target_type: 'project', project: 'x', decisions: [''] },
      { target_type: 'card', group: '踩坑与经验库', title: 't', body: 'b', tags: Array(11).fill('x') },
    ];
    for (const a of bad) {
      const r = await call('save_memory', a);
      assert.ok(r.isError, `应拦截 ${JSON.stringify(a)}`);
    }
    const missing = await call('save_memory', { target_type: 'card', group: '踩坑与经验库', title: '缺正文' });
    assert.ok(txt(missing).includes('body 必填'), txt(missing));
  });

  await t('J2 get_memory_context', '空参概览：4 个模块卡片数量 + 活跃事项 id/名称/状态/进展，不含卡片正文', async () => {
    const r = txt(await call('get_memory_context', {}));
    for (const g of ['个人与职业背景', '协作与沟通准则', '环境与工作流', '踩坑与经验库']) assert.ok(r.includes(`- ${g}：`), r);
    assert.ok(r.includes('## 活跃推进事项'), r);
    assert.ok(r.includes('J1 事项筛选验证'), r);
    assert.ok(!r.includes('J2 MCP 联调事项'), '已归档事项默认不列出：' + r);
    assert.ok(r.includes('get_memory_context'), r);
    assert.ok(!r.includes('J1 摘要甲'), '概览不含卡片正文');
    const withArchived = txt(await call('get_memory_context', { include_archived: true }));
    assert.ok(withArchived.includes('J2 MCP 联调事项'), withArchived);
    assert.ok(withArchived.includes('## 推进事项（含已结项）'), withArchived);
  });

  await t('J2 get_memory_context', '按 groups 读取卡片 Markdown（标题/标签/正文），tag 过滤踩坑库', async () => {
    store.saveMemory({ group: '踩坑与经验库', title: 'J2 标签卡甲', body: 'J2TAGONE 正文甲。', tags: ['J2TAG', '甲'] });
    store.saveMemory({ group: '踩坑与经验库', title: 'J2 标签卡乙', body: 'J2TAGTWO 正文乙。', tags: ['其他'] });
    const all = txt(await call('get_memory_context', { groups: ['踩坑与经验库'] }));
    assert.ok(all.includes('# 踩坑与经验库（'), all);
    assert.ok(all.includes('## J2 标签卡甲') && all.includes('J2TAGONE 正文甲。'), all);
    assert.ok(all.includes('## J2 标签卡乙') && all.includes('J2TAGTWO 正文乙。'), all);
    assert.ok(all.includes('标签：J2TAG、甲'), all);
    const filtered = txt(await call('get_memory_context', { groups: ['踩坑与经验库'], tag: 'j2tag' }));
    assert.ok(filtered.includes('## J2 标签卡甲') && !filtered.includes('## J2 标签卡乙'), filtered);
    assert.ok(filtered.includes('标签过滤：j2tag'), filtered);
    const two = txt(await call('get_memory_context', { groups: ['个人与职业背景', '环境与工作流'] }));
    assert.ok(two.includes('# 个人与职业背景（0 张卡）') && two.includes('（本模块暂无卡片）'), two);
    assert.ok(two.includes('# 环境与工作流（') && two.includes('J2 MCP 经验卡（迁移）'), two);
    assert.ok((await call('get_memory_context', { groups: ['不存在的模块'] })).isError);
    assert.ok((await call('get_memory_context', { groups: Array(5).fill('踩坑与经验库') })).isError);
  });

  await t('J2 get_memory_context', '按 project 读取完整简报：状态/工作区/进展/拍板/否决/下一步/最近关联会话', async () => {
    const r = txt(await call('get_memory_context', { project: 'J2 MCP 联调' }));
    assert.ok(r.includes('# 推进事项：J2 MCP 联调事项'), r);
    assert.ok(r.includes('状态：待验证'), r);
    assert.ok(r.includes('归档：已结项'), r);
    assert.ok(r.includes('工作区：/work/j2-mcp'), r);
    assert.ok(r.includes('当前进展：J2 第二次进展'), r);
    assert.ok(r.includes('## 已拍板结论') && r.includes('- J2 拍板甲') && r.includes('- J2 拍板丙'), r);
    assert.ok(r.includes('## 已否决方案') && r.includes('- J2 否决乙'), r);
    assert.ok(r.includes('## 下一步待办') && r.includes('J2 第二次下一步'), r);
    assert.ok(r.includes('## 最近关联会话（1）') && r.includes('J2 事项关联会话'), r);
    const p = store.listProjects({ includeArchived: true }).find((x) => x.name === 'J2 MCP 联调事项');
    const byId = txt(await call('get_memory_context', { project: p.id }));
    assert.ok(byId.includes('# 推进事项：J2 MCP 联调事项'), byId);
    const none = txt(await call('get_memory_context', { project: '完全不存在的事项 zxqv' }));
    assert.ok(none.includes('没有找到'), none);
    const combo = txt(await call('get_memory_context', { groups: ['踩坑与经验库'], project: 'J2 MCP 联调' }));
    assert.ok(combo.includes('# 踩坑与经验库') && combo.includes('# 推进事项：J2 MCP 联调事项'), combo);
  });

  await t('J2 recall', 'recall 同时召回 save_memory 写入的卡片与事项简报，同 process_id 不重复', async () => {
    store.saveMemory({ group: '踩坑与经验库', title: 'J2 召回卡', body: 'ZXQJ2MCP 召回正文：卡片与简报同时命中。', tags: ['J2'] });
    store.saveProject({ name: 'J2 召回事项', state: '推进中', progress: 'ZXQJ2MCP 事项进展。', decisions: ['J2 召回拍板'], rejected: ['J2 召回否决'], nextStep: 'J2 召回下一步' });
    const P = 'j2-recall-' + Date.now();
    const r = txt(await call('recall', { query: 'ZXQJ2MCP', process_id: P }));
    assert.ok(r.includes('【记忆卡 · 踩坑与经验库】J2 召回卡'), r);
    assert.ok(r.includes('【推进事项 · J2 召回事项】'), r);
    assert.ok(r.includes('已否决：J2 召回否决'), r);
    const again = txt(await call('recall', { query: 'ZXQJ2MCP', process_id: P }));
    assert.ok(!again.includes('【记忆卡 · 踩坑与经验库】J2 召回卡'), again);
    assert.ok(!again.includes('【推进事项 · J2 召回事项】'), again);
  });

  await t('J2 事件', "save_memory 写入成功 emit('mutated')；失败调用不 emit", async () => {
    const events = [];
    const on = (e) => events.push(e);
    mcpEvents.on('mutated', on);
    try {
      const r = await call('save_memory', { target_type: 'card', group: '踩坑与经验库', title: 'J2 事件卡', body: 'J2 事件正文。' });
      assert.ok(!r.isError, txt(r));
      assert.equal(events.length, 1, JSON.stringify(events));
      assert.equal(events[0].target, 'card');
      assert.ok(events[0].id);
      const pj = await call('save_memory', { target_type: 'project', project: 'J2 事件事项', progress: 'J2 事件进展' });
      assert.ok(!pj.isError, txt(pj));
      assert.equal(events.length, 2, JSON.stringify(events));
      assert.equal(events[1].target, 'project');
      const bad = await call('save_memory', { target_type: 'card', group: '踩坑与经验库', title: '缺正文' });
      assert.ok(bad.isError);
      assert.equal(events.length, 2, '失败调用不应 emit mutated');
    } finally { mcpEvents.off('mutated', on); }
  });

  await client.close();
  await mcp.close();
  await t('互通计数', '关闭重开数据库后今日计数仍在', async () => {
    const n = store.getMcpCallsToday();
    store.close();
    store = Store.open(dir);
    assert.equal(store.getMcpCallsToday(), n);
  });
  store.close();

  // ---------- 输出 ----------
  let pass = 0; let fail = 0; let sec = '';
  for (const r of results) {
    if (r.section !== sec) { sec = r.section; console.log(`\n## ${sec}`); }
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      → ${r.err}`}`);
    r.ok ? pass++ : fail++;
  }
  console.log(`\n合计：${pass} 通过，${fail} 失败`);
  fs.rmSync(T, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
