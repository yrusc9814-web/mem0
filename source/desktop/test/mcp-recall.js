'use strict';
/**
 * 本地 MCP 双工具（list_conversations + recall）验收测试：AC-MCP1 ~ AC-MCP3 与「今天互通」计数。
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
  await t('AC-MCP1', 'tools/list 仅 list_conversations 与 recall；旧工具已移除', async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((x) => x.name).sort(), ['list_conversations', 'recall']);
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
    assert.deepEqual([...lc.inputSchema.required].sort(), ['from', 'to']);
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
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 1);
    const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((x) => x.name);
    for (const n of ['conversations', 'messages', 'file_cursors', 'source_settings', 'kv', 'deleted_conversations', 'mcp_recall_delivered', 'mcp_calls_daily']) assert.ok(tables.includes(n), n);
    store.ensureMcpTables(); store.ensureMcpTables();
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
