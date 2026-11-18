'use strict';
/**
 * 独立测试（不依赖 scripts/selftest.js，不需要 Electron/GUI）。
 * 用法：node --no-warnings test/independent.js
 * 全部 fixture 写在临时目录；HOME 与所有 MEM0_* 环境变量都指向临时目录，绝不触碰真实 HOME。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

// ---------- 隔离环境（必须在 require 源码之前） ----------
const REAL_HOME = os.homedir();
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'mem0-indep-'));
const HOME = path.join(T, 'home');
fs.mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
const R = (n) => path.join(T, 'roots', n);
Object.assign(process.env, {
  MEM0_DATA_DIR: path.join(T, 'data'),
  MEM0_CLAUDE_ROOT: R('claude'),
  MEM0_CODEX_ROOT: R('codex'),
  MEM0_DSH_ROOT: R('dsh'),
  MEM0_ANTIGRAVITY_ROOT: R('gemini'),
  MEM0_ZCODE_ROOT: R('zcode'),
  MEM0_DIMCODE_ROOT: R('dimcode'),
  MEM0_WORKBUDDY_ROOT: R('workbuddy'),
});

const ROOT = path.resolve(__dirname, '..');
const { dataDir, sourceRoots, mcpToken } = require(path.join(ROOT, 'src/main/paths'));
const { Store, MEMORY_GROUPS, ALL_SOURCES } = require(path.join(ROOT, 'src/main/db'));
const { LocalIngestor, ADAPTERS } = require(path.join(ROOT, 'src/main/ingest'));
const { startMcpServer } = require(path.join(ROOT, 'src/main/mcp'));
const { startBridge } = require(path.join(ROOT, 'src/main/bridge'));
const register = require(path.join(ROOT, 'src/main/register'));
const WebSocket = require('ws');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

// ---------- 迷你测试框架 ----------
const results = [];
async function t(section, name, fn) {
  try { await fn(); results.push({ section, name, ok: true }); }
  catch (e) { results.push({ section, name, ok: false, err: (e && e.message ? e.message : String(e)).split('\n').slice(0, 4).join(' | ') }); }
}
const j = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let clock = Date.now() - 3600_000;
/** 把文件 mtime 设为"过去且每次都不同"，绕过 2 秒写入防抖 */
function age(f) { clock += 1000; fs.utimesSync(f, clock / 1000, clock / 1000); }
function write(f, s) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); age(f); }
function append(f, s) { fs.appendFileSync(f, s); age(f); }
const ts = (i) => new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString();

/** 动态空闲端口：先 listen(0) 探一个空闲端口再释放，避免测试固定占用 3790/3791 与其它进程冲突 */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

// 任何未捕获异常/拒绝都必须非 0 退出，绝不允许无输出静默 exit 0
process.on('unhandledRejection', (e) => { console.error('FATAL unhandledRejection:', e); process.exit(2); });
process.on('uncaughtException', (e) => { console.error('FATAL uncaughtException:', e); process.exit(2); });
// 事件循环在测试跑完前耗尽（例如只剩 unref 定时器、某个 Promise 未被 await）时，也必须非 0 退出
let finished = false;
process.on('beforeExit', () => {
  if (finished) return;
  console.error('FATAL: 测试尚未跑完事件循环就耗尽了（可能有未 await 的 Promise 或仅剩 unref 定时器），拒绝静默 exit 0');
  process.exit(1);
});

let storeN = 0;
function freshStore() { const d = path.join(T, `db${storeN++}`); fs.mkdirSync(d); return Store.open(d); }
function convs(store, source) { return store.listConversations({ sources: [source], limit: 500 }); }
function msgs(store, id) { return store.getConversation(id, { limit: 2000 }).messages; }

(async () => {
  // =====================================================================
  // 0. 环境覆盖
  // =====================================================================
  await t('0 env', 'paths.js 尊重全部 MEM0_* 覆盖，且未指向真实 HOME', () => {
    const r = sourceRoots();
    assert.equal(r['claude-code'], R('claude'));
    assert.equal(r.codex, R('codex'));
    assert.equal(r['deepseek-harness'], R('dsh'));
    assert.equal(r.antigravity, R('gemini'));
    assert.equal(r.zcode, R('zcode'));
    assert.equal(r.dimcode, R('dimcode'));
    assert.equal(r.workbuddy, R('workbuddy'));
    assert.equal(path.resolve(dataDir()), path.resolve(path.join(T, 'data')));
    // Windows 的 os.tmpdir() 位于 %USERPROFILE% 下，天然以 REAL_HOME 开头，因此只校验不指向真实 .mem0
    const realMem0 = path.resolve(path.join(REAL_HOME, '.mem0'));
    const dd = path.resolve(dataDir());
    assert.ok(dd !== realMem0 && !dd.startsWith(realMem0 + path.sep), 'dataDir 不得指向真实 .mem0');
    assert.equal(os.homedir(), HOME);
  });

  const roots = sourceRoots();

  // =====================================================================
  // 1. 本机来源解析器
  // =====================================================================
  // ---------- Claude Code ----------
  {
    const store = freshStore();
    const ing = new LocalIngestor(store, roots);
    const dir = path.join(roots['claude-code'], '-home-me-proj');
    const huge = 'H'.repeat(5 * 1024 * 1024) + '尾巴';
    const ev = (type, content, extra = {}) => j({ type, sessionId: 'cc-1', cwd: '/home/me/proj', timestamp: extra.ts || ts(1), message: { role: type, content }, ...extra });
    write(path.join(dir, 'empty.jsonl'), '');
    write(path.join(dir, 'garbage.jsonl'), '{bad\n\u0000\u0001\nnot json at all\n[1,2]\nnull\n42\n');
    write(path.join(dir, 'cc-1.jsonl'), [
      j({ type: 'summary', summary: '摘要标题' }),
      ev('user', '你好 👋🏽 emoji 测试 مرحبا 𠜎𠜱'),
      '{"type":"user", broken',
      ev('assistant', [{ type: 'text', text: '第一块' }, { type: 'thinking', thinking: 'secret' }]),
      ev('assistant', [{ type: 'text', text: '第二块' }, { type: 'tool_use', name: 'Bash', input: { cmd: 'ls' } }]),
      ev('user', [{ type: 'tool_result', content: 'X'.repeat(10000) }]),
      j({ type: 'user', isSidechain: true, message: { role: 'user', content: '子任务' } }),
      j({ type: 'user', isMeta: true, message: { role: 'user', content: 'meta' } }),
      j({ type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } }),
      j({ type: 'user' }), // 缺 message
      j({ type: 'user', message: {} }), // 缺 content
      j({ type: 'assistant', message: { role: 'assistant', content: 123 } }),
      ev('user', huge),
    ].join('\n') + '\n');
    // 无 sessionId/timestamp 的会话，回退到文件名
    write(path.join(dir, 'no-sid.jsonl'), j({ type: 'user', message: { role: 'user', content: '没有 sessionId' } }) + '\n');
    // 文件里有一行合法 JSON 的 null，不应让整个文件作废
    write(path.join(dir, 'nullline.jsonl'), 'null\n' + j({ type: 'user', sessionId: 'nl', message: { role: 'user', content: 'null 行之后的消息' } }) + '\n');
    const ccErrs = []; ing.on('error', (e) => ccErrs.push(e));

    await t('1 claude-code', '首次扫描：空文件/坏文件不产生会话，坏行跳过', async () => {
      await ing.scanOnce();
      const cs = convs(store, 'claude-code');
      assert.equal(cs.length, 3, `got ${cs.length}`);
    });
    await t('1 claude-code', 'JSON 行为 null 不会导致读文件抛错（claude-code.js:56）', () => {
      assert.deepEqual(ccErrs.map((e) => path.basename(e.file) + ': ' + e.message), []);
      assert.ok(store.db.prepare("SELECT 1 FROM conversations WHERE external_id='nl'").get());
    });
    const cc = convs(store, 'claude-code').find((c) => c.title === '摘要标题');
    await t('1 claude-code', '解析：标题/工作区/过滤 sidechain、meta、命令包装/assistant 分块合并', () => {
      assert.ok(cc, 'conv with summary title');
      const full = store.getConversation(cc.id);
      assert.equal(full.workspace, '/home/me/proj');
      const m = msgs(store, cc.id);
      assert.deepEqual(m.map((x) => x.role), ['user', 'assistant', 'user']);
      assert.equal(m[1].content, '第一块\n第二块');
      assert.ok(!m.some((x) => /子任务|meta|command-name|secret|\[调用工具|\[工具结果\]/.test(x.content)));
    });
    await t('1 claude-code', 'unicode/emoji 原样保存并可搜索', () => {
      const m = msgs(store, cc.id);
      assert.equal(m[0].content, '你好 👋🏽 emoji 测试 مرحبا 𠜎𠜱');
      assert.equal(store.search('مرحبا').length, 1);
      assert.equal(store.search('𠜎𠜱').length, 1); // 2 个码点 → LIKE 兜底
    });
    await t('1 claude-code', '5MB 超大消息完整保存', () => {
      const m = msgs(store, cc.id);
      assert.equal(m[2].content.length, huge.length);
      assert.equal(store.search('HHH尾巴').length, 1);
    });
    await t('1 claude-code', '缺 sessionId → 用文件名作 externalId', () => {
      const r = store.db.prepare("SELECT external_id FROM conversations WHERE source='claude-code' AND external_id='no-sid'").get();
      assert.ok(r);
    });
    await t('1 claude-code', '仅改 mtime 重扫不重复、不变化', async () => {
      const before = store.stats();
      age(path.join(dir, 'cc-1.jsonl'));
      const r = await ing.scanOnce();
      assert.equal(r.changed, 0);
      assert.deepEqual(store.stats(), before);
    });
    await t('1 claude-code', '增量追加：只新增 1 条，无重复', async () => {
      append(path.join(dir, 'cc-1.jsonl'), ev('assistant', '新的回复') + '\n');
      await ing.scanOnce();
      const m = msgs(store, cc.id);
      assert.equal(m.length, 4);
      assert.equal(m[3].content, '新的回复');
    });
    await t('1 claude-code', '写入中半行：先跳过，补全后正确入库且不重复', async () => {
      const f = path.join(dir, 'cc-1.jsonl');
      const line = ev('user', '半行写入的消息');
      append(f, line.slice(0, 20));
      await ing.scanOnce();
      assert.equal(msgs(store, cc.id).length, 4);
      append(f, line.slice(20) + '\n');
      await ing.scanOnce();
      const m = msgs(store, cc.id);
      assert.equal(m.length, 5);
      assert.equal(m[4].content, '半行写入的消息');
      age(f); await ing.scanOnce();
      assert.equal(msgs(store, cc.id).length, 5);
    });
    await t('1 claude-code', '2 秒内有改动且已有游标 → 本轮跳过，下轮再读', async () => {
      const f = path.join(dir, 'cc-1.jsonl');
      fs.appendFileSync(f, ev('user', '刚刚写入') + '\n'); // mtime=now
      await ing.scanOnce();
      assert.equal(msgs(store, cc.id).length, 5);
      age(f); await ing.scanOnce();
      assert.equal(msgs(store, cc.id).length, 6);
    });
    await t('1 claude-code', '来源关闭后不采集', async () => {
      store.setSourceEnabled('claude-code', false);
      write(path.join(dir, 'off.jsonl'), ev('user', '关闭时写入', { sessionId: 'off' }) + '\n');
      await ing.scanOnce();
      assert.ok(!convs(store, 'claude-code').some((c) => c.title === '关闭时写入'));
      store.setSourceEnabled('claude-code', true);
    });
    store.close();
  }

  // ---------- Claude Code：只保留用户和 AI 正文（0.5.5 F1） ----------
  {
    const dir = path.join(T, 'claude-text-only');
    const f = path.join(dir, 'text-only.jsonl');
    const line = (ev) => j({ sessionId: 'cc-text', cwd: '/w/cc', timestamp: ts(1), ...ev });
    const msg = (type, content, extra = {}) => line({ type, message: { role: type, content }, ...extra });
    const rows = [
      line({ type: 'summary', summary: '正文过滤标题' }),
      // 正常用户正文
      msg('user', '你好，帮我看看这个 bug'),
      // 工具调用块丢弃，文本保留
      msg('assistant', [{ type: 'text', text: '我先看看。' }, { type: 'tool_use', name: 'Bash', input: { cmd: 'ls' } }]),
      // 只含 tool_result 的 user 事件整条丢弃
      msg('user', [{ type: 'tool_result', tool_use_id: 't1', content: 'X'.repeat(1000) }]),
      // 工具块拆开的多条 assistant 文本仍合并为一条
      msg('assistant', [{ type: 'text', text: '找到了原因。' }, { type: 'tool_use', name: 'Read', input: { file: 'a.js' } }]),
      msg('user', [{ type: 'tool_result', tool_use_id: 't2', content: '文件内容' }]),
      msg('assistant', [{ type: 'text', text: '原因是缓存没清。' }]),
      // 带 tool_result 但仍有正文的 user 事件：保留正文
      msg('user', [{ type: 'tool_result', content: '输出' }, { type: 'text', text: '谢谢' }]),
      // 中断提示
      msg('user', '[Request interrupted by user]'),
      msg('user', '[Request interrupted by user for tool use]'),
      // 压缩上下文续接摘要
      msg('user', 'This session is being continued from a previous conversation that ran out of context. 摘要内容'),
      msg('user', 'This session is being continued from a previous conversation', { isCompactSummary: true }),
      // 正文夹带多段、跨行 system-reminder：整段删除，其余保留
      msg('user', '继续干活<system-reminder>\n多行注入\n第二行\n</system-reminder>中间<system-reminder>再一段</system-reminder>收尾'),
      // 只剩 system-reminder → 整条丢弃
      msg('user', '<system-reminder>只有注入</system-reminder>'),
      // 各类注入标签开头 → 整条丢弃
      ...['command-name', 'command-message', 'command-args', 'local-command-stdout', 'local-command-stderr', 'bash-input', 'bash-stdout', 'bash-stderr', 'task-notification', 'user-memory-input']
        .map((tag) => msg('user', `<${tag}>注入内容</${tag}>`)),
      // 压缩摘要事件标记
      msg('user', '压缩摘要正文', { isCompactSummary: true }),
      // 照旧跳过 meta / sidechain
      msg('user', 'meta 正文', { isMeta: true }),
      msg('user', '旁支正文', { isSidechain: true }),
      // 只有图片 → [图片]；图片 + 文字 → 只留文字
      msg('user', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } }]),
      msg('user', [{ type: 'image', source: { data: 'x' } }, { type: 'text', text: '看图' }]),
      // 只有 thinking/redacted_thinking 的 assistant 整条丢弃
      msg('assistant', [{ type: 'thinking', thinking: '思考' }, { type: 'redacted_thinking', data: 'x' }]),
      // thinking 与正文混排时只留正文
      msg('assistant', [{ type: 'redacted_thinking', data: 'x' }, { type: 'text', text: '最后回答' }, { type: 'thinking', thinking: '思考' }]),
    ];
    write(f, rows.join('\n') + '\n');

    await t('1 claude-code', 'F1 只保留正文：工具/思考/系统注入/中断/压缩摘要全部丢弃，assistant 分块仍合并', async () => {
      const r = await ADAPTERS['claude-code'].read(f);
      assert.ok(r);
      assert.equal(r.externalId, 'cc-text');
      assert.equal(r.workspace, '/w/cc');
      assert.equal(r.title, '正文过滤标题');
      assert.deepEqual(r.messages.map((m) => m.role), ['user', 'assistant', 'user', 'user', 'user', 'user', 'assistant']);
      assert.deepEqual(r.messages.map((m) => m.content), [
        '你好，帮我看看这个 bug',
        '我先看看。\n找到了原因。\n原因是缓存没清。',
        '谢谢',
        '继续干活中间收尾',
        '[图片]',
        '看图',
        '最后回答',
      ]);
    });
    await t('1 claude-code', 'F1 结果不含工具占位、system-reminder、bash 包装、中断提示', async () => {
      const r = await ADAPTERS['claude-code'].read(f);
      const all = r.messages.map((m) => m.content).join('\n');
      for (const bad of ['[调用工具', '[工具结果]', '<system-reminder', '<bash-', 'Request interrupted', 'This session is being continued', '只有注入', '注入内容', '压缩摘要正文', 'meta 正文', '旁支正文', '思考']) {
        assert.ok(!all.includes(bad), `不应包含 ${bad}`);
      }
    });
    await t('1 claude-code', 'F1 只剩注入/工具内容时 read() 返回 null（不入库）', async () => {
      const only = path.join(dir, 'only-injected.jsonl');
      write(only, [
        msg('user', [{ type: 'tool_result', content: '只有结果' }]),
        msg('user', '<system-reminder>注入</system-reminder>'),
        msg('assistant', [{ type: 'thinking', thinking: '只有思考' }]),
      ].join('\n') + '\n');
      assert.equal(await ADAPTERS['claude-code'].read(only), null);
    });
    await t('1 claude-code', 'F1 strippedBlocks 精确统计：工具/思考块 + system-reminder + 注入 + meta/sidechain/compact', async () => {
      const r = await ADAPTERS['claude-code'].read(f);
      // 5 个 tool_use/tool_result 块 + 3 个注入/中断/续接行 + 2 个 isCompactSummary
      // + 3 个 system-reminder 块 + 10 个命令包装注入 + isMeta/isSidechain 各 1 + 4 个 thinking/redacted_thinking 块
      assert.equal(r.strippedBlocks, 29);
    });
  }

  // ---------- Claude Code：已入库旧会话按新规则重读（0.5.5 F2） ----------
  {
    const store = freshStore();
    const ing = new LocalIngestor(store, roots);
    const dir = path.join(roots['claude-code'], '-home-me-f2');
    const f = path.join(dir, 'f2.jsonl');
    const ev = (type, content, extra = {}) => j({ type, sessionId: 'cc-f2', cwd: '/w/f2', timestamp: ts(1), message: { role: type, content }, ...extra });
    // 文件里是工具块；旧解析器会把它们变成「[调用工具」「[工具结果]」文本入库
    write(f, [
      ev('user', '旧问题：怎么修缓存？'),
      ev('assistant', [{ type: 'text', text: '旧回答：先看日志。' }, { type: 'tool_use', name: 'Bash', input: { cmd: 'ls' } }]),
      ev('user', [{ type: 'tool_result', content: 'total 0' }, { type: 'text', text: '日志在这里' }]),
      ev('assistant', '旧回答：清掉缓存就好。'),
    ].join('\n') + '\n');

    await t('1 claude-code F2', '迁移：旧格式入库 + 游标存在；执行迁移后 claude-code 游标被清、kv 标记写入、只执行一次', async () => {
      // 直接按旧格式写库（含工具占位），并写游标模拟已入库的旧会话
      store.upsertConversation({
        source: 'claude-code', externalId: 'cc-f2', ingestMethod: 'local',
        messages: [
          { role: 'user', content: '旧问题：怎么修缓存？' },
          { role: 'assistant', content: '旧回答：先看日志。\n[调用工具] Bash({"cmd":"ls"})' },
          { role: 'user', content: '日志在这里\n[工具结果] total 0' },
          { role: 'assistant', content: '旧回答：清掉缓存就好。' },
        ],
      });
      const id = store.db.prepare("SELECT id FROM conversations WHERE source='claude-code' AND external_id='cc-f2'").get().id;
      const sig = fs.statSync(f);
      store.setCursor(f, 'claude-code', sig.size, sig.mtimeMs);
      const before = msgs(store, id);
      assert.deepEqual(before.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
      assert.ok(before.some((m) => m.content.includes('[调用工具')), '旧格式应含工具占位');
      assert.equal(store.search('调用工具').length, 1, '旧内容应能被搜到');
      assert.ok(store.getCursor(f), '应有游标');
      assert.equal(store.getKv('claude_clean_v1'), null);
      // 其它来源的游标不受影响
      store.setCursor('/tmp/other-codex.jsonl', 'codex', 1, 1);

      // 新版启动：未标记 → 清游标并重读
      await ing.scanOnce();
      assert.equal(store.getKv('claude_clean_v1'), '1');
      const other = store.getCursor('/tmp/other-codex.jsonl');
      assert.ok(other && other.size === 1 && other.mtime_ms === 1, '其它来源游标不应被清');
      // 重读成功后游标按新文件签名写回
      const cur = store.getCursor(f);
      assert.ok(cur && cur.size === sig.size && cur.mtime_ms === Math.floor(sig.mtimeMs), '重读后应写回新游标');

      // 迁移只在未标记时执行一次：再写一个游标，第二次启动不应清掉
      const sig2 = fs.statSync(f);
      store.setCursor(f, 'claude-code', sig2.size, sig2.mtimeMs);
      const again = new LocalIngestor(store, roots);
      await again.scanOnce();
      assert.ok(store.getCursor(f), '第二次启动不应再清游标');
      assert.equal(store.getKv('claude_clean_v1'), '1');
    });

    await t('1 claude-code F2', '重读后旧工具内容被删除：只剩正文、条数正确、搜索不再命中', async () => {
      const id = store.db.prepare("SELECT id FROM conversations WHERE source='claude-code' AND external_id='cc-f2'").get().id;
      const after = msgs(store, id);
      assert.deepEqual(after.map((m) => m.content), [
        '旧问题：怎么修缓存？',
        '旧回答：先看日志。',
        '日志在这里',
        '旧回答：清掉缓存就好。',
      ]);
      assert.equal(after.length, 4);
      assert.equal(store.db.prepare('SELECT message_count FROM conversations WHERE id = ?').get(id).message_count, 4);
      assert.equal(store.search('调用工具').length, 0, '旧工具内容应搜不到');
      assert.equal(store.search('工具结果').length, 0, '旧工具结果应搜不到');
      assert.equal(store.search('缓存').length, 1, '正文仍可搜到');
      store.db.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES ('integrity-check', 1)");
    });

    await t('1 claude-code F2', '用户删除过的会话不被迁移重读复活（墓碑保持）', async () => {
      const g = path.join(dir, 'f2-deleted.jsonl');
      write(g, ev('user', '要删掉的会话', { sessionId: 'cc-f2-del' }) + '\n');
      await ing.scanOnce();
      const id = store.db.prepare("SELECT id FROM conversations WHERE source='claude-code' AND external_id='cc-f2-del'").get().id;
      store.deleteConversation(id);
      // 重置标记，模拟迁移再次发生（清游标后重读）
      store.db.prepare('DELETE FROM kv WHERE k = ?').run('claude_clean_v1');
      await new LocalIngestor(store, roots).scanOnce();
      assert.equal(store.db.prepare('SELECT COUNT(*) n FROM conversations WHERE id = ?').get(id).n, 0, '删除的会话不应复活');
      assert.ok(store.db.prepare('SELECT 1 FROM deleted_conversations WHERE id = ?').get(id), '墓碑仍在');
    });
    store.close();
  }

  // ---------- Codex ----------
  {
    const store = freshStore();
    const ing = new LocalIngestor(store, roots);
    const sid = '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001';
    const day = path.join(roots.codex, 'sessions', '2026', '11', '01');
    const f = path.join(day, `rollout-2026-11-01T00-00-00-${sid}.jsonl`);
    const ri = (role, text) => j({ timestamp: ts(2), type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
    write(f, [
      j({ timestamp: ts(1), type: 'session_meta', payload: { id: sid, cwd: '/w/site' } }),
      ri('user', '<environment_context>cwd</environment_context>'),
      ri('user', '# AGENTS.md instructions for /w'),
      ri('developer', 'dev msg'),
      j({ type: 'event_msg', payload: { type: 'user_message', message: '重复的 event_msg' } }),
      'garbage{{',
      ri('user', 'Codex 问题 🚀'),
      j({ type: 'response_item', payload: { type: 'function_call', name: 'shell' } }),
      ri('assistant', 'Codex 回答'),
      j({ type: 'response_item' }), // 缺 payload
    ].join('\n') + '\n');
    write(path.join(roots.codex, 'session_index.jsonl'), 'bad\n' + j({ id: sid, thread_name: 'Codex 标题' }) + '\n');
    write(path.join(roots.codex, 'archived_sessions', 'empty.jsonl'), '');
    // 旧格式：首行 {id, timestamp, instructions}（无 type），id 与文件名不同
    write(path.join(roots.codex, 'archived_sessions', 'rollout-old-11111111-2222-3333-4444-555555555555.jsonl'), [
      j({ id: 'legacy-header-id', timestamp: ts(0), instructions: '' }),
      j({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '旧格式问题' }] }),
      j({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '旧格式回答' }] }),
    ].join('\n') + '\n');
    await ing.scanOnce();
    await t('1 codex', '新格式：注入/developer/event_msg/坏行被过滤，标题来自 session_index', () => {
      const c = convs(store, 'codex').find((x) => x.title === 'Codex 标题');
      assert.ok(c);
      assert.equal(c.workspace, '/w/site');
      assert.deepEqual(msgs(store, c.id).map((m) => m.content), ['Codex 问题 🚀', 'Codex 回答']);
    });
    await t('1 codex', '旧格式：externalId 应取首行 header.id（codex.js:78）', () => {
      const r = store.db.prepare("SELECT external_id FROM conversations WHERE source='codex' AND title LIKE '旧格式%'").get();
      assert.ok(r, 'legacy conv ingested');
      assert.equal(r.external_id, 'legacy-header-id', `实际 externalId=${r.external_id}（header 分支不可达，回退到文件名 UUID）`);
    });
    await t('1 codex', '回归：旧格式 header 无 id 时回退文件名 UUID；header 之后的 message 行照常解析；重扫不重复', async () => {
      write(path.join(roots.codex, 'archived_sessions', 'rollout-old-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl'), [
        j({ timestamp: ts(0), instructions: '' }),
        j({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '旧格式无ID问题' }] }),
        j({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '好的' }] }),
      ].join('\n') + '\n');
      await ing.scanOnce();
      const r = store.db.prepare("SELECT id, external_id FROM conversations WHERE source='codex' AND title LIKE '旧格式无ID%'").get();
      assert.ok(r, 'legacy conv without header id ingested');
      assert.equal(r.external_id, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      assert.deepEqual(msgs(store, r.id).map((m) => m.content), ['旧格式无ID问题', '好的']);
      const legacy = store.db.prepare("SELECT id FROM conversations WHERE source='codex' AND external_id='legacy-header-id'").get();
      assert.deepEqual(msgs(store, legacy.id).map((m) => m.content), ['旧格式问题', '旧格式回答']);
      await ing.scanOnce();
      assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE source='codex' AND title LIKE '旧格式%'").get().n, 2);
    });
    await t('1 codex', '增量 + 重扫不重复', async () => {
      append(f, ri('user', '第二个问题') + '\n');
      await ing.scanOnce(); age(f); await ing.scanOnce();
      const c = convs(store, 'codex').find((x) => x.title === 'Codex 标题');
      assert.equal(msgs(store, c.id).length, 3);
    });
    store.close();
  }

  // ---------- DeepSeek Harness ----------
  {
    const store = freshStore();
    const ing = new LocalIngestor(store, roots);
    const base = path.join(roots['deepseek-harness'], 'proj');
    const hdr = (id, extra = {}) => j({ type: 'session', id, version: 1, createdAt: 1700000000000, cwd: '/w/dsh', ...extra });
    const um = (seq, text, kind = 'user') => j({ type: 'user/message', seq, time: 1700000000000 + seq, surfaceOp: 'append', data: { role: 'user', source: { kind }, content: [{ type: 'text', text }] } });
    const am = (seq, text, op = 'append') => j({ type: 'assistant/message', seq, time: 1700000000000 + seq, surfaceOp: op, data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } });
    write(path.join(base, 's1', 'session.jsonl'), hdr('old-gen') + '\n' + um(1, '旧代') + '\n');
    write(path.join(base, 's1', 'session.v3.jsonl'), [hdr('dsh-1'), um(1, 'DSH 问题'), um(2, '系统注入', 'system'), am(3, '回答一'), am(4, '回答二'), am(5, '替换', { op: 'replace' }), 'bad', j({ type: 'session/title', data: { title: 'DSH 标题' } }), j({ type: 'user/message' })].join('\n') + '\n');
    write(path.join(base, 's2', 'session.jsonl'), '');
    write(path.join(base, 's3', 'session.jsonl'), '{"type":"sess');
    write(path.join(base, 's4', 'session.jsonl'), hdr('sub', { origin: 'subagent' }) + '\n' + um(1, '子代理') + '\n');
    write(path.join(base, 's5', 'session.jsonl'), hdr('only-assistant') + '\n' + am(1, '只有回答') + '\n');
    const hasZstd = typeof zlib.zstdCompressSync === 'function';
    if (hasZstd) {
      const p = path.join(base, 's6', 'session.v2.jsonl.zstd');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, zlib.zstdCompressSync(Buffer.from([hdr('dsh-z'), um(1, 'zstd 问题'), am(2, 'zstd 回答')].join('\n') + '\n')));
      age(p);
      const bad = path.join(base, 's7', 'session.jsonl.zstd');
      fs.mkdirSync(path.dirname(bad), { recursive: true });
      fs.writeFileSync(bad, 'not zstd'); age(bad);
    }
    const errs = [];
    ing.on('error', (e) => errs.push(e));
    await ing.scanOnce();
    await t('1 deepseek-harness', '取最高版本、过滤系统注入/replace、合并 assistant、标题', () => {
      const c = convs(store, 'deepseek-harness').find((x) => x.title === 'DSH 标题');
      assert.ok(c);
      assert.deepEqual(msgs(store, c.id).map((m) => m.content), ['DSH 问题', '回答一\n回答二']);
      assert.ok(!store.db.prepare("SELECT 1 FROM conversations WHERE external_id='old-gen'").get());
    });
    await t('1 deepseek-harness', '空/半行 header/子代理/无用户消息 → 不入库', () => {
      for (const id of ['sub', 'only-assistant']) assert.ok(!store.db.prepare('SELECT 1 FROM conversations WHERE external_id=?').get(id));
    });
    await t('1 deepseek-harness', `zstd 压缩会话可读，损坏的 zstd 只报错不崩${hasZstd ? '' : '（跳过：无 zstd）'}`, () => {
      if (!hasZstd) return;
      assert.ok(store.db.prepare("SELECT 1 FROM conversations WHERE external_id='dsh-z'").get());
      assert.ok(errs.some((e) => /s7/.test(e.file || '')));
    });
    await t('1 deepseek-harness', '增量 + 重扫不重复', async () => {
      const f = path.join(base, 's1', 'session.v3.jsonl');
      append(f, um(9, '追问') + '\n');
      await ing.scanOnce(); age(f); await ing.scanOnce();
      const c = convs(store, 'deepseek-harness').find((x) => x.title === 'DSH 标题');
      assert.equal(msgs(store, c.id).length, 3);
    });
    store.close();
  }

  // ---------- DeepSeekRuntime 多帧 Zstd 夹具（SPEC 1.1） ----------
  {
    const { pathToFileURL } = require('node:url');
    const fixtureScript = path.join(__dirname, 'fixtures', 'build-fixtures.mjs');
    const fixture = await import(pathToFileURL(fixtureScript).href);
    const built = fixture.buildFixtures(path.join(T, 'fixtures-dsh'));
    const dsh = ADAPTERS['deepseek-harness'];

    await t('1 deepseek-harness', '多帧 Zstd：4 帧拼接完整读出 3 行问答（不止第 1 帧）且 strippedBlocks > 0', async () => {
      const c = await dsh.read(built.files.dshNormalFile);
      assert.ok(c);
      assert.equal(c.externalId, 'dsh-mf-normal-01');
      assert.deepEqual(c.messages.map((m) => m.role), ['user', 'assistant', 'user']);
      assert.match(c.messages[0].content, /第一轮提问/);
      assert.match(c.messages[1].content, /第一轮回答/);
      assert.doesNotMatch(c.messages[1].content, /分析 Node zlib/); // reasoning 块被剥离
      assert.match(c.messages[2].content, /第二轮追问/);
      assert.ok(c.strippedBlocks > 0, `strippedBlocks 应大于 0，实际为 ${c.strippedBlocks}`);
    });

    await t('1 deepseek-harness', '多帧大容量 subagent：首行提前退出返回 null，无 unhandledRejection/uncaughtException', async () => {
      const errors = [];
      const onRejection = (e) => errors.push(e);
      const onException = (e) => errors.push(e);
      process.on('unhandledRejection', onRejection);
      process.on('uncaughtException', onException);
      try {
        assert.equal(await dsh.read(built.files.dshSubagentFile), null);
        await sleep(200); // 给潜在的流销毁错误留出冒泡窗口
        assert.deepEqual(errors, []);
      } finally {
        process.off('unhandledRejection', onRejection);
        process.off('uncaughtException', onException);
      }
    });

    await t('1 deepseek-harness', '普通 jsonl 读取行为不变（非 .zstd 不走多帧解压）', async () => {
      const f = path.join(T, 'dsh-plain', 'session.jsonl');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const hdr = j({ type: 'session', id: 'dsh-plain-01', version: 1, createdAt: 1700000000000, cwd: '/w/dsh' });
      const um = j({ type: 'user/message', seq: 1, time: 1700000000001, surfaceOp: 'append', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '普通问题' }] } });
      const am = j({ type: 'assistant/message', seq: 2, time: 1700000000002, surfaceOp: 'append', data: { message: { role: 'assistant', content: [{ type: 'text', text: '普通回答' }] } } });
      fs.writeFileSync(f, [hdr, um, am].join('\n') + '\n');
      const c = await dsh.read(f);
      assert.deepEqual(c.messages.map((m) => m.content), ['普通问题', '普通回答']);
      assert.equal(c.strippedBlocks, 0);
    });
  }

  // ---------- Antigravity ----------
  {
    const store = freshStore();
    const ing = new LocalIngestor(store, roots);
    const tr = (variant, id) => path.join(roots.antigravity, variant, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
    const row = (i, source, type, content, at = ts(i)) => j({ step_index: i, source, type, created_at: at, content });
    write(tr('antigravity-ide', 'ag-1'), [
      row(3, 'MODEL', 'PLANNER_RESPONSE', '回答B'),
      row(0, 'USER_EXPLICIT', 'USER_INPUT', '<USER_REQUEST>\n  AG 问题 ✨\n</USER_REQUEST><ADDITIONAL_METADATA>大段上下文</ADDITIONAL_METADATA>'),
      row(1, 'MODEL', 'PLANNER_RESPONSE', '回答A'),
      row(2, 'SYSTEM', 'TOOL_RUN_COMMAND', 'ls'),
      'oops',
      j({ step_index: 4, type: 'USER_INPUT', content: { not: 'string' } }),
    ].join('\n') + '\n');
    write(path.join(roots.antigravity, 'antigravity-ide', 'brain', 'ag-1', 'implementation_plan.md'), 'no heading\n# AG 标题\n');
    write(tr('antigravity-cli', 'ag-2'), row(0, 'MODEL', 'PLANNER_RESPONSE', '只有模型') + '\n');
    write(tr('antigravity', 'ag-3'), '');
    write(tr('antigravity', 'ag-4'), j({ type: 'USER_INPUT', content: '缺 created_at 和 source' }) + '\n');
    await ing.scanOnce();
    await t('1 antigravity', '按时间排序、剥 USER_REQUEST、合并模型回复、标题取 md 一级标题', () => {
      const c = convs(store, 'antigravity').find((x) => x.title === 'AG 标题');
      assert.ok(c);
      assert.deepEqual(msgs(store, c.id).map((m) => m.content), ['AG 问题 ✨', '回答A\n\n回答B']);
    });
    await t('1 antigravity', '只有模型/空文件不入库；缺字段仍可入库', () => {
      const ids = store.db.prepare("SELECT external_id FROM conversations WHERE source='antigravity'").all().map((r) => r.external_id).sort();
      assert.deepEqual(ids, ['ag-1', 'ag-4']);
    });
    await t('1 antigravity', '增量 + 重扫不重复', async () => {
      append(tr('antigravity-ide', 'ag-1'), row(9, 'USER_EXPLICIT', 'USER_INPUT', '追问') + '\n');
      await ing.scanOnce(); age(tr('antigravity-ide', 'ag-1')); await ing.scanOnce();
      const c = convs(store, 'antigravity').find((x) => x.title === 'AG 标题');
      assert.equal(msgs(store, c.id).length, 3);
    });
    store.close();
  }

  // ---------- Antigravity / Codex 合成夹具（SPEC 1.2 / 1.3） ----------
  {
    const { pathToFileURL } = require('node:url');
    const fixtureScript = path.join(__dirname, 'fixtures', 'build-fixtures.mjs');
    const fixture = await import(pathToFileURL(fixtureScript).href);
    const built = fixture.buildFixtures(path.join(T, 'fixtures-g2'));

    await t('1 antigravity', 'conversation_summaries.db 显式列读取：原生 title 优先、Windows workspace 解码、不触发 ERR_OUT_OF_RANGE', async () => {
      let r;
      await assert.doesNotReject(async () => { r = await ADAPTERS.antigravity.read(built.files.agMainTranscript); });
      assert.ok(r);
      assert.equal(r.externalId, 'ag-main-0001');
      // 数据库原生标题优先于同目录 task.md 的「旧脑目录回退标题」
      assert.equal(r.title, '订单服务缓存架构重构');
      assert.equal(r.workspace, 'd:\\demo-workspace\\order-service');
      assert.deepEqual(r.messages.map((m) => m.role), ['user', 'assistant']);
      assert.match(r.messages[0].content, /Redis 缓存雪崩/);
      assert.match(r.messages[1].content, /随机抖动 TTL/);
      assert.match(r.messages[1].content, /已完成互斥锁/);
      // thinking 1 + tool_calls 1 + TOOL_RUN_COMMAND 1
      assert.equal(r.strippedBlocks, 3);
    });

    await t('1 antigravity', 'parent_conversation_id 非空 / nesting_depth > 0 的子代理会话返回 null', async () => {
      assert.equal(await ADAPTERS.antigravity.read(built.files.agSubTranscript), null);
    });

    await t('1 antigravity', '数据库不存在时静默回退旧逻辑（titleFromBrain，且不填 workspace）', async () => {
      const brain = path.join(T, 'ag-no-db', 'antigravity', 'brain', 'ag-fallback');
      const f = path.join(brain, '.system_generated', 'logs', 'transcript.jsonl');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.copyFileSync(built.files.agMainTranscript, f);
      fs.writeFileSync(path.join(brain, 'task.md'), '# 回退标题\n');
      const r = await ADAPTERS.antigravity.read(f);
      assert.ok(r);
      assert.equal(r.title, '回退标题');
      assert.equal(r.workspace, undefined);
      assert.deepEqual(r.messages.map((m) => m.role), ['user', 'assistant']);
    });

    const codexDay = path.join(built.roots.codex, 'sessions', '2026', '11', '15');
    const codexMain = path.join(codexDay, 'rollout-2026-11-15T10-00-00-019a1111-2222-7333-8444-555555550001.jsonl');
    const codexSub = path.join(codexDay, 'rollout-2026-11-15T10-05-00-019a1111-2222-7333-8444-555555550002.jsonl');

    await t('1 codex', 'session_meta.payload.source.subagent 为对象 → 子代理会话返回 null', async () => {
      assert.equal(await ADAPTERS.codex.read(codexSub, built.roots.codex), null);
    });

    await t('1 codex', 'session_meta.payload.source.subagent 为非空字符串 → 同样返回 null', async () => {
      const dir = path.join(T, 'codex-str-sub');
      const f = path.join(dir, 'rollout-str-sub.jsonl');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(f, [
        j({ type: 'session_meta', payload: { id: 'codex-str-sub', cwd: '/w/sub', source: { subagent: 'review' } } }),
        j({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '子代理问题' }] } }),
      ].join('\n') + '\n');
      assert.equal(await ADAPTERS.codex.read(f, dir), null);
    });

    await t('1 codex', '主会话正常入库且 strippedBlocks > 0（注入 / function_call / function_call_output）', async () => {
      const r = await ADAPTERS.codex.read(codexMain, built.roots.codex);
      assert.ok(r);
      assert.equal(r.title, 'Postgres 索引在线创建检查');
      assert.deepEqual(r.messages.map((m) => m.content), [
        '大表加复合索引怎样避免锁表阻塞线上写入？',
        '使用 CREATE INDEX CONCURRENTLY，并确保该语句不在显式事务块内执行。',
      ]);
      assert.equal(r.strippedBlocks, 3);
    });
  }

  // ---------- ZCode ----------
  {
    const store = freshStore();
    const ing = new LocalIngestor(store, roots);
    const p = path.join(roots.zcode, 'cli', 'db', 'db.sqlite');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const w = new DatabaseSync(p); // 保持打开，模拟 ZCode 正在运行（WAL）
    w.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE session(id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);`);
    let n = 0;
    const addMsg = (sid, role, texts, raw) => {
      const id = `m${n++}`;
      w.prepare('INSERT INTO message VALUES (?,?,?,?)').run(id, sid, 1700000000000 + n, raw ?? j({ role }));
      for (const tx of texts) w.prepare('INSERT INTO part VALUES (?,?,?,?)').run(`p${n++}`, id, sid, typeof tx === 'string' ? j({ type: 'text', text: tx }) : j(tx));
    };
    w.prepare('INSERT INTO session VALUES (?,?,?,?,?,?)').run('z1', null, '/w/zproj', null, 1700000000000, 1700000009000);
    w.prepare('INSERT INTO session VALUES (?,?,?,?,?,?)').run('z2', null, null, 'Z 第二个', 1700000000000, 1700000009000);
    w.prepare('INSERT INTO session VALUES (?,?,?,?,?,?)').run('zsub', 'z1', null, 'sub', 1700000000000, 1700000009000);
    addMsg('z1', 'user', ['Z 问题 🐉', { type: 'text', text: '合成', synthetic: true }]);
    addMsg('z1', 'assistant', ['Z 回答', { type: 'tool', tool: 'bash' }]);
    addMsg('z1', 'user', ['坏 data'], '{not json');
    addMsg('z1', 'system', ['系统']);
    addMsg('z2', 'user', ['Z2 问题']);
    addMsg('zsub', 'user', ['子会话']);
    await ing.scanOnce();
    await t('1 zcode', 'WAL 打开中只读读取；过滤子会话/合成/坏 JSON；标题回退目录名', () => {
      const cs = convs(store, 'zcode');
      assert.deepEqual(cs.map((c) => c.title).sort(), ['Z 第二个', 'zproj']);
      const c = cs.find((x) => x.title === 'zproj');
      assert.deepEqual(msgs(store, c.id).map((m) => m.content), ['Z 问题 🐉', 'Z 回答']);
    });
    await t('1 zcode', '增量（WAL 签名变化）+ 重扫不重复', async () => {
      addMsg('z1', 'user', ['Z 追问']);
      age(p); if (fs.existsSync(p + '-wal')) age(p + '-wal');
      await ing.scanOnce(); await ing.scanOnce();
      const c = convs(store, 'zcode').find((x) => x.title === 'zproj');
      assert.equal(msgs(store, c.id).length, 3);
      assert.equal(store.db.prepare("SELECT COUNT(*) n FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.source='zcode'").get().n, 4);
    });
    await t('1 zcode', '删除会话后，库里其它会话变化不应让已删会话复活（ingest.js:59-65 + 单库多会话）', async () => {
      const c2 = convs(store, 'zcode').find((x) => x.title === 'Z 第二个');
      store.deleteConversation(c2.id);
      addMsg('z1', 'assistant', ['只有 z1 有新消息']);
      age(p); if (fs.existsSync(p + '-wal')) age(p + '-wal');
      await ing.scanOnce();
      const back = convs(store, 'zcode').some((x) => x.title === 'Z 第二个');
      assert.ok(!back, '已删除且无新消息的 z2 被重新备份（删除确认框承诺“有新消息才会重新备份”）');
    });
    w.close();
    store.close();
  }

  // ---------- DimCode ----------
  {
    const store = freshStore();
    const ing = new LocalIngestor(store, roots);
    const p = path.join(roots.dimcode, 'v2', 'dimcode.sqlite');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const w = new DatabaseSync(p);
    w.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE sessions (sessionId TEXT PRIMARY KEY, cwd TEXT NOT NULL DEFAULT '', title TEXT, status TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
      CREATE TABLE messages (messageId TEXT PRIMARY KEY, sessionId TEXT NOT NULL, role TEXT NOT NULL, parts TEXT NOT NULL, orderKey TEXT NOT NULL, createdAt TEXT NOT NULL);
      CREATE TABLE session_catalog_entries (sessionId TEXT PRIMARY KEY, topLevel INTEGER NOT NULL);`);
    const S = (id, title) => w.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?)').run(id, '/w/dim', title, 'active', ts(0), ts(9));
    let k = 0;
    const M = (sid, role, parts, order) => w.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?)').run(`dm${k++}`, sid, role, typeof parts === 'string' ? parts : j(parts), order, 'not-a-date');
    S('d1', 'Dim 标题'); S('dsub', 'sub'); S('d2', null);
    w.prepare('INSERT INTO session_catalog_entries VALUES (?,?)').run('dsub', 0);
    M('d1', 'assistant', [{ type: 'text', text: '回答2' }], 'b2');
    M('d1', 'user', [{ type: 'text', text: 'Dim 问题 🦊' }], 'a1');
    M('d1', 'assistant', [{ type: 'reasoning', text: '思考' }, { type: 'text', text: '回答1' }], 'b1');
    M('d1', 'tool_result', [{ type: 'text', text: '工具输出' }], 'b15');
    M('d1', 'user', '{bad json', 'c1');
    M('dsub', 'user', [{ type: 'text', text: '子代理' }], 'a');
    M('d2', 'assistant', [{ type: 'text', text: '只有回答' }], 'a');
    await ing.scanOnce();
    await t('1 dimcode', 'orderKey 排序、合并 assistant（跨 tool_result）、过滤子代理/reasoning/无用户会话', () => {
      const cs = convs(store, 'dimcode');
      assert.deepEqual(cs.map((c) => c.title), ['Dim 标题']);
      const m = msgs(store, cs[0].id).map((x) => x.content);
      assert.equal(m[0], 'Dim 问题 🦊');
      assert.equal(m[1], '回答1\n回答2');
      // parts 坏 JSON 时退回原字符串 → 作为文本入库（记录行为）
      assert.equal(m[2], '{bad json');
    });
    await t('1 dimcode', '增量 + 重扫不重复', async () => {
      M('d1', 'user', [{ type: 'text', text: '追问' }], 'd1');
      age(p); if (fs.existsSync(p + '-wal')) age(p + '-wal');
      await ing.scanOnce(); await ing.scanOnce();
      assert.equal(msgs(store, convs(store, 'dimcode')[0].id).length, 4);
    });
    w.close();
    store.close();
  }

  // ---------- ZCode / DimCode：read() 逐会话产出（async generator） ----------
  {
    const dir = path.join(T, 'gen-read');
    fs.mkdirSync(dir, { recursive: true });
    const zp = path.join(dir, 'z.sqlite');
    const zw = new DatabaseSync(zp);
    zw.exec(`CREATE TABLE session(id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);`);
    zw.prepare('INSERT INTO session VALUES (?,?,?,?,?,?)').run('g1', null, '/w/g1', 'G 一', 1, 100);
    zw.prepare('INSERT INTO session VALUES (?,?,?,?,?,?)').run('g2', null, null, 'G 二', 1, 200);
    zw.prepare('INSERT INTO session VALUES (?,?,?,?,?,?)').run('gsub', 'g1', null, '子', 1, 300);
    const zmsg = (id, sid, role, text) => {
      zw.prepare('INSERT INTO message VALUES (?,?,?,?)').run(id, sid, 1, j({ role }));
      zw.prepare('INSERT INTO part VALUES (?,?,?,?)').run(`p-${id}`, id, sid, j({ type: 'text', text }));
    };
    zmsg('m1', 'g1', 'user', 'G1 问题');
    zmsg('m2', 'g2', 'user', 'G2 问题');
    zmsg('m3', 'gsub', 'user', '子会话');
    zw.close();

    await t('1 zcode', 'read() 是 async generator：逐会话产出，顺序/过滤与整数组一致', async () => {
      const it = ADAPTERS.zcode.read(zp);
      assert.equal(typeof it[Symbol.asyncIterator], 'function');
      assert.equal(typeof it.then, 'undefined', 'read() 不应再返回 Promise');
      const out = [];
      for await (const c of it) out.push(c);
      assert.deepEqual(out.map((c) => c.externalId), ['g2', 'g1']);
      assert.deepEqual(out.map((c) => c.title), ['G 二', 'G 一']);
      assert.deepEqual(out[1].messages.map((m) => m.content), ['G1 问题']);
    });
    await t('1 zcode', 'read() 逐次产出：取第一条后可直接停止（不读完整库）', async () => {
      const it = ADAPTERS.zcode.read(zp);
      const a = await it.next();
      assert.equal(a.done, false);
      assert.equal(a.value.externalId, 'g2');
      assert.equal((await it.return()).done, true);
    });
    await t('1 zcode', 'read() 打开失败时迭代器 reject', async () => {
      await assert.rejects(async () => { for await (const _ of ADAPTERS.zcode.read(path.join(dir, 'nope.sqlite'))) { /* 不会执行 */ } });
    });

    const dp = path.join(dir, 'd.sqlite');
    const dw = new DatabaseSync(dp);
    dw.exec(`CREATE TABLE sessions (sessionId TEXT PRIMARY KEY, cwd TEXT NOT NULL DEFAULT '', title TEXT, status TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
      CREATE TABLE messages (messageId TEXT PRIMARY KEY, sessionId TEXT NOT NULL, role TEXT NOT NULL, parts TEXT NOT NULL, orderKey TEXT NOT NULL, createdAt TEXT NOT NULL);
      CREATE TABLE session_catalog_entries (sessionId TEXT PRIMARY KEY, topLevel INTEGER NOT NULL);`);
    const dS = (id, title, upd) => dw.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?)').run(id, '/w/d', title, 'active', ts(0), upd);
    let dk = 0;
    const dM = (sid, role, text, order) => dw.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?)').run(`gm${dk++}`, sid, role, j([{ type: 'text', text }]), order, 'not-a-date');
    dS('gd1', 'D 一', ts(1)); dS('gd2', null, ts(2)); dS('gdsub', '子', ts(3)); dS('gd3', '无用户', ts(4));
    dw.prepare('INSERT INTO session_catalog_entries VALUES (?,?)').run('gdsub', 0);
    dM('gd1', 'user', 'D1 问题', 'a');
    dM('gd2', 'user', 'D2 问题', 'a');
    dM('gdsub', 'user', '子会话', 'a');
    dM('gd3', 'assistant', '只有回答', 'a');
    dw.close();

    await t('1 dimcode', 'read() 是 async generator：逐会话产出，过滤子代理/无用户会话', async () => {
      const it = ADAPTERS.dimcode.read(dp);
      assert.equal(typeof it[Symbol.asyncIterator], 'function');
      assert.equal(typeof it.then, 'undefined', 'read() 不应再返回 Promise');
      const out = [];
      for await (const c of it) out.push(c);
      assert.deepEqual(out.map((c) => c.externalId), ['gd2', 'gd1']);
      assert.deepEqual(out.map((c) => c.title), [undefined, 'D 一']);
      assert.deepEqual(out[1].messages.map((m) => m.content), ['D1 问题']);
    });
    await t('1 dimcode', 'read() 逐次产出：取第一条后可直接停止（不读完整库）', async () => {
      const it = ADAPTERS.dimcode.read(dp);
      const a = await it.next();
      assert.equal(a.done, false);
      assert.equal(a.value.externalId, 'gd2');
      assert.equal((await it.return()).done, true);
    });
  }

  // ---------- ingest：read() 的三种返回形态（对象 / 数组 / async iterable） ----------
  {
    const real = ADAPTERS['claude-code'];
    const fakeRoot = path.join(T, 'fake-src');
    const fakeFile = path.join(fakeRoot, 'a.jsonl');
    fs.mkdirSync(fakeRoot, { recursive: true });
    fs.writeFileSync(fakeFile, 'x');
    const conv = (id) => ({ source: 'claude-code', externalId: id, ingestMethod: 'local', messages: [{ role: 'user', content: id }] });
    const makeStore = () => {
      const log = []; const cursors = [];
      return {
        log, cursors,
        isSourceEnabled: () => true,
        getCursor: () => null,
        upsertConversation: (c) => { log.push(`upsert:${c.externalId}`); return { changed: true, id: c.externalId, added: 1 }; },
        setCursor: (...a) => { log.push('cursor'); cursors.push(a); },
      };
    };
    // 其它来源指向不存在的目录，避免真实 root 干扰
    const onlyRoots = Object.fromEntries(Object.keys(ADAPTERS).map((id) => [id, path.join(T, 'nope', id)]));
    onlyRoots['claude-code'] = fakeRoot;
    const withRead = async (read, fn) => {
      ADAPTERS['claude-code'] = {
        ...real, exists: () => true, discover: async () => [fakeFile],
        signature: () => ({ size: 1, mtimeMs: Date.now() - 60_000 }), read,
      };
      try { return await fn(); } finally { ADAPTERS['claude-code'] = real; }
    };

    await t('1 ingest', 'async generator：写一条放一条（yield→upsert 交替），成功后写游标', async () => {
      const store = makeStore();
      const ing = new LocalIngestor(store, onlyRoots);
      const read = async function* () {
        for (const id of ['a', 'b', 'c']) { store.log.push(`yield:${id}`); yield conv(id); }
      };
      const r = await withRead(read, () => ing.scanOnce());
      assert.deepEqual(store.log, ['yield:a', 'upsert:a', 'yield:b', 'upsert:b', 'yield:c', 'upsert:c', 'cursor']);
      assert.equal(r.changed, 3);
      assert.equal(store.cursors.length, 1);
      assert.deepEqual(store.cursors[0].slice(0, 3), [fakeFile, 'claude-code', 1]);
    });
    await t('1 ingest', 'async generator 中途出错：已写入的保留，不写游标，报错；下一轮重读成功', async () => {
      const store = makeStore();
      const ing = new LocalIngestor(store, onlyRoots);
      const errs = []; ing.on('error', (e) => errs.push(e));
      let round = 0;
      const read = async function* () {
        store.log.push('yield:a'); yield conv('a');
        store.log.push('yield:b'); yield conv('b');
        if (round++ === 0) throw new Error('boom');
        store.log.push('yield:c'); yield conv('c');
      };
      await withRead(read, () => ing.scanOnce());
      assert.deepEqual(store.log, ['yield:a', 'upsert:a', 'yield:b', 'upsert:b']);
      assert.equal(store.cursors.length, 0);
      assert.equal(errs.length, 1);
      assert.equal(errs[0].file, fakeFile);
      assert.match(errs[0].message, /boom/);
      await withRead(read, () => ing.scanOnce());
      assert.equal(store.cursors.length, 1);
      assert.ok(store.log.includes('upsert:c'));
    });
    await t('1 ingest', '数组 / 单个对象 / null 返回照旧', async () => {
      const s1 = makeStore();
      await withRead(async () => [conv('a'), conv('b')], () => new LocalIngestor(s1, onlyRoots).scanOnce());
      assert.deepEqual(s1.log, ['upsert:a', 'upsert:b', 'cursor']);
      const s2 = makeStore();
      await withRead(async () => conv('solo'), () => new LocalIngestor(s2, onlyRoots).scanOnce());
      assert.deepEqual(s2.log, ['upsert:solo', 'cursor']);
      const s3 = makeStore();
      await withRead(async () => null, () => new LocalIngestor(s3, onlyRoots).scanOnce());
      assert.deepEqual(s3.log, ['cursor']);
    });
    await t('1 ingest', 'stop 后不再安排下一轮扫描（在途扫描结束后也停）', async () => {
      const store = makeStore();
      const ing = new LocalIngestor(store, onlyRoots, { intervalMs: 5 });
      let scans = 0;
      const origScan = ing.scanOnce.bind(ing);
      ing.scanOnce = async () => { scans++; return origScan(); };
      await withRead(async () => conv('a'), async () => {
        ing.start();
        await sleep(30);
        assert.ok(scans >= 1);
        ing.stop();
        const n = scans;
        await sleep(60);
        assert.equal(scans, n, 'stop 后不应再有新一轮');
        assert.equal(ing.timer, null);
        assert.equal(ing.stopped, true);
      });
    });
    await t('1 ingest', 'stopAndWait 等在途扫描结束后才返回', async () => {
      const store = makeStore();
      const ing = new LocalIngestor(store, onlyRoots);
      let release;
      const gate = new Promise((r) => { release = r; });
      let done = false;
      const read = async () => { await gate; done = true; return conv('slow'); };
      const p = withRead(read, async () => {
        const scanning = ing.scanOnce().then(() => 'scan');
        await sleep(10);
        assert.equal(ing.running, true);
        const stopped = ing.stopAndWait().then(() => 'stopped');
        const first = await Promise.race([stopped, sleep(30).then(() => 'timeout')]);
        assert.equal(first, 'timeout', '在途扫描未结束前 stopAndWait 不应返回');
        release();
        assert.equal(await scanning, 'scan');
        assert.equal(await stopped, 'stopped');
      });
      await p;
      assert.equal(done, true);
      // 已经停止后再调用：立即返回，不卡住
      await ing.stopAndWait();
      assert.equal(ing.stopped, true);
    });
    await t('1 ingest', 'stopAndWait：没有在途扫描时立即返回', async () => {
      const ing = new LocalIngestor(makeStore(), onlyRoots);
      assert.equal(ing.running, false);
      await ing.stopAndWait();
      assert.equal(ing.stopped, true);
    });
  }

  // ---------- WorkBuddy ----------
  {
    const store = freshStore();
    const ing = new LocalIngestor(store, roots);
    const wbErrs = []; ing.on('error', (e) => wbErrs.push(e));
    const wb = roots.workbuddy;
    const row = (sid, role, content, extra = {}) => j({ type: 'message', sessionId: sid, role, content, ...extra });
    // 字符串内容 + user_query 包装 + system-reminder + sidechain + meta + ISO/数字时间戳
    write(path.join(wb, 'p1', 'a1.jsonl'), [
      j({ type: 'ai-title', aiTitle: 'AI 标题', sessionId: 's-str' }),
      row('s-str', 'user', '<system-reminder>注入</system-reminder>', { cwd: '/w/projA', timestamp: '2026-11-01T00:00:00Z' }),
      row('s-str', 'user', '前缀 <user_query>\n  真正的问题 🦊 \n</user_query> 尾巴', { timestamp: 1762000000000 }),
      row('s-str', 'assistant', '  回答一  ', { timestamp: '1762000001000' }),
      row('s-str', 'user', '旁支', { isSidechain: true }),
      row('s-str', 'user', 'meta 消息', { isMeta: true }),
      row('s-str', 'tool', '工具'),
      j({ type: 'event', sessionId: 's-str', role: 'user', content: '非 message 行' }),
      '{broken',
      'null',
    ].join('\n') + '\n');
    // blocks 内容 + custom-title(title 字段) 优先于 ai-title
    write(path.join(wb, 'p1', 'nested', 'b1.jsonl'), [
      j({ type: 'ai-title', aiTitle: 'AI 标题', sessionId: 's-blk' }),
      j({ type: 'custom-title', title: '  自定义\n  标题  ', sessionId: 's-blk' }),
      row('s-blk', 'user', [{ type: 'input_text', text: '块问题' }, { type: 'image', url: 'x' }]),
      row('s-blk', 'assistant', [{ type: 'output_text', text: '块一' }, { type: 'reasoning', text: '思考' }, { type: 'output_text', text: '块二' }]),
    ].join('\n') + '\n');
    // 标题回退：首条用户消息（长文本截断 80）
    write(path.join(wb, 'p2', 'c1.jsonl'), row('s-first', 'user', '长'.repeat(200), { cwd: '/w/projB' }) + '\n');
    // 标题回退：cwd basename（只有 assistant）
    write(path.join(wb, 'p2', 'c2.jsonl'), row('s-cwd', 'assistant', '只有回答', { cwd: '/w/projC' }) + '\n');
    // 标题回退：文件名
    write(path.join(wb, 'p2', 'c3.jsonl'), row('s-file', 'assistant', '只有回答2') + '\n');
    // 应跳过：subagents 目录、agent- 文件、非 jsonl、sessionId 不一致、无 sessionId
    write(path.join(wb, 'p1', 'subagents', 'x.jsonl'), row('s-sub', 'user', '子代理') + '\n');
    write(path.join(wb, 'p1', 'agent-123.jsonl'), row('s-agent', 'user', '代理文件') + '\n');
    write(path.join(wb, 'p1', 'notes.json'), row('s-json', 'user', '不是 jsonl') + '\n');
    write(path.join(wb, 'p3', 'bad.jsonl'), [row('s-bad', 'user', '一'), row('s-other', 'user', '二')].join('\n') + '\n');
    write(path.join(wb, 'p3', 'nosid.jsonl'), j({ type: 'message', role: 'user', content: '没有 sessionId' }) + '\n');
    await ing.scanOnce();
    const wbAdapter = ADAPTERS.workbuddy;
    await t('1 workbuddy', 'discover：递归、排序、跳过 subagents/ 与 agent-*、只要 .jsonl', async () => {
      const files = (await wbAdapter.discover(wb)).map((f) => path.relative(wb, f));
      assert.deepEqual(files, ['p1/a1.jsonl', 'p1/nested/b1.jsonl', 'p2/c1.jsonl', 'p2/c2.jsonl', 'p2/c3.jsonl', 'p3/bad.jsonl', 'p3/nosid.jsonl'].map((p) => p.split('/').join(path.sep)));
      assert.deepEqual(await wbAdapter.discover(path.join(T, 'nope')), []);
    });
    await t('1 workbuddy', '字符串内容：user_query 取内层、丢 system-reminder、跳过 sidechain/meta/非 message、时间戳转毫秒', async () => {
      const r = await wbAdapter.read(path.join(wb, 'p1', 'a1.jsonl'));
      assert.equal(r.source, 'workbuddy'); assert.equal(r.externalId, 's-str'); assert.equal(r.ingestMethod, 'local');
      assert.equal(r.workspace, '/w/projA');
      assert.equal(r.title, 'AI 标题');
      assert.deepEqual(r.messages.map((m) => [m.role, m.content]), [['user', '真正的问题 🦊'], ['assistant', '回答一']]);
      assert.equal(r.messages[0].createdAt, 1762000000000);
      assert.equal(r.messages[1].createdAt, 1762000001000);
    });
    await t('1 workbuddy', 'ISO 时间戳 → 毫秒', async () => {
      const f = path.join(T, 'wb-iso.jsonl');
      fs.writeFileSync(f, row('s-iso', 'user', 'iso', { timestamp: '2026-11-01T00:00:00Z' }) + '\n');
      assert.equal((await wbAdapter.read(f)).messages[0].createdAt, Date.parse('2026-11-01T00:00:00Z'));
    });
    await t('1 workbuddy', 'blocks 内容：只取 input_text/output_text；custom-title(title) 优先于 ai-title 且压缩空白', async () => {
      const r = await wbAdapter.read(path.join(wb, 'p1', 'nested', 'b1.jsonl'));
      assert.equal(r.title, '自定义 标题');
      assert.deepEqual(r.messages.map((m) => m.content), ['块问题', '块一\n块二']);
    });
    await t('1 workbuddy', '标题回退：首条用户消息（截断 80）> cwd basename > 文件名', async () => {
      const a = await wbAdapter.read(path.join(wb, 'p2', 'c1.jsonl'));
      assert.equal(a.title.length, 80); assert.ok(a.title.startsWith('长长'));
      assert.equal((await wbAdapter.read(path.join(wb, 'p2', 'c2.jsonl'))).title, 'projC');
      assert.equal((await wbAdapter.read(path.join(wb, 'p2', 'c3.jsonl'))).title, 'c3.jsonl');
    });
    await t('1 workbuddy', 'sessionId 不一致 → 抛错（不入库）；无 sessionId → 不入库', async () => {
      await assert.rejects(() => wbAdapter.read(path.join(wb, 'p3', 'bad.jsonl')));
      assert.equal(await wbAdapter.read(path.join(wb, 'p3', 'nosid.jsonl')), null);
      assert.ok(wbErrs.some((e) => e.file && e.file.endsWith('bad.jsonl')));
    });
    await t('1 workbuddy', '扫描入库：5 个会话，子代理/agent-/坏文件不入库', () => {
      const cs = convs(store, 'workbuddy');
      assert.equal(cs.length, 5, `got ${cs.length}`);
      const titles = cs.map((c) => c.title).sort();
      assert.ok(titles.includes('AI 标题') && titles.includes('自定义 标题') && titles.includes('projC') && titles.includes('c3.jsonl'));
      assert.ok(!titles.some((x) => /子代理|代理文件/.test(x)));
    });
    await t('1 workbuddy', '增量 + 重扫不重复', async () => {
      const f = path.join(wb, 'p1', 'a1.jsonl');
      fs.appendFileSync(f, row('s-str', 'user', '追问') + '\n');
      age(f);
      await ing.scanOnce(); await ing.scanOnce();
      const c = convs(store, 'workbuddy').find((x) => x.title === 'AI 标题');
      assert.equal(msgs(store, c.id).length, 3);
      assert.equal(convs(store, 'workbuddy').length, 5);
    });
    store.close();
  }

  // ---------- 逐行流式解析：与旧的整文件 readFile + split('\n') 实现对照 ----------
  {
    const dir = path.join(T, 'stream-compare');
    const put = (name, content) => {
      const f = path.join(dir, name);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, content);
      return f;
    };
    /** 新旧结果必须完全一致（字段、值、顺序） */
    const same = (a, b) => {
      assert.deepEqual(a, b);
      assert.equal(JSON.stringify(a), JSON.stringify(b));
    };
    /** 0.6.0：deepseek-harness 返回对象新增 strippedBlocks，与旧实现对照时先剔除该统计字段 */
    const withoutStripped = (r) => {
      if (!r) return r;
      const { strippedBlocks, ...rest } = r;
      return rest;
    };

    // 参考实现：claude-code（整文件读取版，语义与逐行版一致）
    const oldClaude = async (file) => {
      const raw = await fs.promises.readFile(file, 'utf8');
      const messages = [];
      let sessionId = path.basename(file, '.jsonl');
      let cwd = null;
      let summary = null;
      let customTitle = null;
      let aiTitle = null;
      const textOf = (content) => {
        if (typeof content === 'string') return content;
        if (!Array.isArray(content)) return '';
        const parts = [];
        let hasImage = false;
        for (const b of content) {
          if (!b || typeof b !== 'object') continue;
          if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
          else if (b.type === 'image') hasImage = true;
        }
        const text = parts.join('\n').trim();
        return text || (hasImage ? '[图片]' : '');
      };
      const INJECTED = /^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|bash-input|bash-stdout|bash-stderr|task-notification|user-memory-input)>/;
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (!ev || typeof ev !== 'object') continue;
        if (ev.type === 'summary' && typeof ev.summary === 'string') { summary = ev.summary; continue; }
        if (ev.type === 'custom-title' && typeof ev.customTitle === 'string') { customTitle = ev.customTitle; continue; }
        if (ev.type === 'ai-title' && typeof ev.aiTitle === 'string') { aiTitle = ev.aiTitle; continue; }
        if (ev.type !== 'user' && ev.type !== 'assistant') continue;
        if (ev.isSidechain || ev.isMeta) continue;
        if (ev.isCompactSummary === true) continue;
        const msg = ev.message;
        if (!msg) continue;
        const role = msg.role === 'assistant' ? 'assistant' : 'user';
        let text = textOf(msg.content);
        if (!text) continue;
        if (role === 'user') {
          text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
          if (!text) continue;
          if (INJECTED.test(text) || text.startsWith('This session is being continued from a previous conversation') || text.startsWith('[Request interrupted by user')) continue;
        }
        if (ev.sessionId) sessionId = ev.sessionId;
        if (ev.cwd) cwd = ev.cwd;
        const t = Date.parse(ev.timestamp);
        const last = messages[messages.length - 1];
        if (last && last.role === role && role === 'assistant') {
          last.content += '\n' + text;
          if (Number.isFinite(t)) last.createdAt = t;
        } else {
          messages.push({ role, content: text, createdAt: Number.isFinite(t) ? t : undefined });
        }
      }
      if (!messages.length) return null;
      return { source: 'claude-code', externalId: sessionId, title: customTitle || aiTitle || summary || undefined, workspace: cwd, messages, ingestMethod: 'local' };
    };

    // 旧实现：codex（含标题索引）
    const oldCodex = (() => {
      const cache = { mtime: 0, map: new Map() };
      async function titles(root) {
        const file = path.join(root, 'session_index.jsonl');
        try {
          const st = await fs.promises.stat(file);
          if (st.mtimeMs === cache.mtime) return cache.map;
          const map = new Map();
          for (const line of (await fs.promises.readFile(file, 'utf8')).split('\n')) {
            try {
              const r = JSON.parse(line);
              const id = r.id || r.session_id;
              const t = r.title || r.thread_name || r.name;
              if (id && t) map.set(id, t);
            } catch { /* 忽略坏行 */ }
          }
          cache.mtime = st.mtimeMs; cache.map = map;
          return map;
        } catch { return new Map(); }
      }
      const textOf = (content) => {
        if (typeof content === 'string') return content;
        if (!Array.isArray(content)) return '';
        return content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).filter(Boolean).join('\n').trim();
      };
      const INJECTED = /^\s*<(environment_context|user_instructions|permissions|INSTRUCTIONS)>|^# AGENTS\.md instructions/;
      async function read(file, root) {
        const raw = await fs.promises.readFile(file, 'utf8');
        const messages = [];
        let sessionId = null;
        let cwd = null;
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue;
          let ev;
          try { ev = JSON.parse(line); } catch { continue; }
          if (!ev || typeof ev !== 'object') continue;
          let item = ev;
          const t = Date.parse(ev.timestamp);
          if (!ev.type && typeof ev.id === 'string' && ev.id && 'instructions' in ev) {
            if (!sessionId) sessionId = ev.id;
            continue;
          }
          if (ev.type === 'session_meta' && ev.payload) {
            sessionId = ev.payload.id || sessionId;
            cwd = ev.payload.cwd || cwd;
            continue;
          }
          if (ev.type === 'response_item') item = ev.payload;
          else if (ev.type && ev.type !== 'message') continue;
          if (!item || item.type !== 'message') continue;
          if (item.role !== 'user' && item.role !== 'assistant') continue;
          const text = textOf(item.content);
          if (!text || (item.role === 'user' && INJECTED.test(text))) continue;
          messages.push({ role: item.role, content: text, createdAt: Number.isFinite(t) ? t : undefined });
        }
        if (!messages.length) return null;
        if (!sessionId) {
          const m = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
          sessionId = m ? m[1] : path.basename(file, '.jsonl');
        }
        const title = (await titles(root)).get(sessionId);
        return { source: 'codex', externalId: sessionId, title, workspace: cwd, messages, ingestMethod: 'local' };
      }
      return { read };
    })();

    await t('1 stream', 'codex：新/旧格式、空行/坏行/末行无换行，新旧结果一致', async () => {
      const root = path.join(dir, 'codex-root');
      const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      put('codex-root/session_index.jsonl', 'bad\n' + j({ id: sid, thread_name: '流式 Codex' }) + '\n');
      const nf = put(`codex-root/sessions/2026/01/01/rollout-${sid}.jsonl`, [
        j({ timestamp: '2026-11-01T00:00:00Z', type: 'session_meta', payload: { id: sid, cwd: '/w/codex' } }),
        j({ timestamp: '2026-11-01T00:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '流式问题' }] } }),
        '',
        'not json',
        j({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '流式回答' }] } }),
        j({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>注入</environment_context>' }] } }),
        j({ type: 'event_msg', payload: { type: 'agent_message', message: '事件' } }),
        j({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '最后一行无换行' }] } }),
      ].join('\n'));
      const now = await ADAPTERS.codex.read(nf, root);
      same(withoutStripped(now), await oldCodex.read(nf, root));
      assert.equal(now.strippedBlocks, 2); // 环境注入 1 + event_msg 1
      assert.equal(now.title, '流式 Codex');

      const of = put('codex-root/archived_sessions/rollout-old.jsonl', [
        j({ id: 'legacy-stream', timestamp: '2026-11-01T00:00:00Z', instructions: 'x' }),
        j({ type: 'message', role: 'user', content: '旧格式问题' }),
        '',
        'broken',
        j({ type: 'message', role: 'assistant', content: '旧格式回答' }),
      ].join('\n'));
      same(withoutStripped(await ADAPTERS.codex.read(of, root)), await oldCodex.read(of, root));
    });

    // 旧实现：antigravity
    const oldAntigravity = async (file) => {
      const brainDir = path.resolve(file, '..', '..', '..');
      const cascadeId = path.basename(brainDir);
      const raw = await fs.promises.readFile(file, 'utf8');
      const rows = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try { const r = JSON.parse(line); if (r && typeof r === 'object') rows.push(r); } catch { /* 半行 */ }
      }
      rows.sort((a, b) => (Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0) || (a.step_index ?? 0) - (b.step_index ?? 0));
      const cleanUser = (text) => {
        const m = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
        return (m ? m[1] : text).trim();
      };
      let title;
      for (const name of ['task.md', 'implementation_plan.md', 'walkthrough.md']) {
        try {
          const t = await fs.promises.readFile(path.join(brainDir, name), 'utf8');
          const h = t.match(/^#\s+(.+)$/m);
          if (h) { title = h[1].trim(); break; }
        } catch { /* 没有就算了 */ }
      }
      const messages = [];
      for (const r of rows) {
        let role;
        if (r.type === 'USER_INPUT' && (r.source === 'USER_EXPLICIT' || r.source === undefined)) role = 'user';
        else if (r.type === 'PLANNER_RESPONSE' && (r.source === 'MODEL' || r.source === undefined)) role = 'assistant';
        else continue;
        let text = typeof r.content === 'string' ? r.content : '';
        if (role === 'user') text = cleanUser(text);
        text = text.trim();
        if (!text) continue;
        const t = Date.parse(r.created_at);
        const last = messages[messages.length - 1];
        if (last && last.role === role && role === 'assistant') { last.content += '\n\n' + text; if (Number.isFinite(t)) last.createdAt = t; }
        else messages.push({ role, content: text, createdAt: Number.isFinite(t) ? t : undefined });
      }
      if (!messages.some((m) => m.role === 'user')) return null;
      return { source: 'antigravity', externalId: cascadeId, title, messages, ingestMethod: 'local' };
    };

    await t('1 stream', 'antigravity：空行/坏行/末行无换行，新旧结果一致', async () => {
      const base = 'gemini/antigravity/brain/ag-stream';
      put(`${base}/task.md`, 'no heading\n# 流式 AG\n');
      const f = put(`${base}/.system_generated/logs/transcript.jsonl`, [
        j({ step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-01T00:00:02Z', content: '回答B' }),
        '',
        j({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-11-01T00:00:00Z', content: '<USER_REQUEST>\n  流式问题\n</USER_REQUEST> 尾巴' }),
        'oops',
        j({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-01T00:00:01Z', content: '回答A' }),
        j({ step_index: 3, source: 'SYSTEM', type: 'TOOL_RUN_COMMAND', content: 'ls' }),
        j({ step_index: 4, type: 'USER_INPUT', content: { not: 'string' } }),
        j({ step_index: 5, type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '最后一行无换行' }),
      ].join('\n'));
      const now = await ADAPTERS.antigravity.read(f);
      same(withoutStripped(now), await oldAntigravity(f));
      assert.equal(now.strippedBlocks, 1); // TOOL_RUN_COMMAND 1
      assert.equal(now.title, '流式 AG');
    });

    await t('1 stream', 'antigravity：含 thinking/tool_calls 的样例，新旧结果一致', async () => {
      const base = 'gemini/antigravity/brain/ag-heavy';
      put(`${base}/task.md`, '# 重字段 AG\n');
      const heavy = (extra) => 'x'.repeat(2048) + j(extra);
      const f = put(`${base}/.system_generated/logs/transcript.jsonl`, [
        j({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-01T00:00:01Z', content: '先回答', thinking: heavy({ t: 1 }), tool_calls: [{ name: 'bash', args: heavy({ a: 1 }) }] }),
        j({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-11-01T00:00:00Z', content: '<USER_REQUEST>重字段问题</USER_REQUEST>', thinking: heavy({ t: 2 }), tool_calls: [] }),
        j({ step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-01T00:00:02Z', content: '再回答', thinking: heavy({ t: 3 }), tool_calls: [{ name: 'grep', args: heavy({ a: 2 }) }] }),
        j({ step_index: 3, source: 'MODEL', type: 'TOOL_CALL', created_at: '2026-11-01T00:00:03Z', content: '工具行', tool_calls: [{ name: 'bash' }] }),
      ].join('\n'));
      const now = await ADAPTERS.antigravity.read(f);
      same(withoutStripped(now), await oldAntigravity(f));
      assert.equal(now.strippedBlocks, 5); // 两轮 thinking + tool_calls 各 2，加 TOOL_CALL 1
      assert.deepEqual(now.messages.map((m) => m.content), ['重字段问题', '先回答\n\n再回答']);
    });

    await t('1 stream', 'antigravity：标题在首行/中间/不存在', async () => {
      const mk = (id, md) => {
        const base = `gemini/antigravity/brain/${id}`;
        put(`${base}/task.md`, md);
        return put(`${base}/.system_generated/logs/transcript.jsonl`,
          j({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-11-01T00:00:00Z', content: '问题' }) + '\n');
      };
      const first = await ADAPTERS.antigravity.read(mk('ag-title-1', '# 首行标题\n正文\n'));
      assert.equal(first.title, '首行标题');
      const mid = await ADAPTERS.antigravity.read(mk('ag-title-2', '前言\n\n# 中间标题\n\n更多\n'));
      assert.equal(mid.title, '中间标题');
      const none = await ADAPTERS.antigravity.read(mk('ag-title-3', '没有标题\n## 二级\n'));
      assert.equal(none.title, undefined);
      same(withoutStripped(none), await oldAntigravity(path.join(dir, 'gemini/antigravity/brain/ag-title-3/.system_generated/logs/transcript.jsonl')));
      assert.equal(none.strippedBlocks, 0);
    });

    // 旧实现：workbuddy
    const oldWorkbuddy = async (file) => {
      const raw = await fs.promises.readFile(file, 'utf8');
      const blocksText = (content) => {
        if (typeof content === 'string') return content.trim();
        if (!Array.isArray(content)) return '';
        const parts = [];
        for (const b of content) {
          if (b && typeof b === 'object' && (b.type === 'input_text' || b.type === 'output_text') && typeof b.text === 'string') parts.push(b.text);
        }
        return parts.join('\n').trim();
      };
      const realUserText = (text) => {
        const m = text.match(/<user_query>([\s\S]*?)<\/user_query>/);
        if (m) return m[1].trim();
        if (text.startsWith('<system-reminder')) return '';
        return text.trim();
      };
      const toMs = (v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))) {
          const n = Number(v);
          return Number.isFinite(n) && Number.isFinite(new Date(n).getTime()) ? n : undefined;
        }
        if (typeof v === 'string') { const n = Date.parse(v); return Number.isFinite(n) ? n : undefined; }
        return undefined;
      };
      const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
      let sessionId = null;
      let cwd = null;
      let aiTitle = null;
      let customTitle = null;
      let firstUser = null;
      const messages = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (!ev || typeof ev !== 'object' || Array.isArray(ev)) continue;
        if (ev.sessionId !== undefined && ev.sessionId !== null) {
          if (typeof ev.sessionId !== 'string' || !ev.sessionId || (sessionId !== null && ev.sessionId !== sessionId)) {
            throw new Error(`WorkBuddy 会话文件 sessionId 不一致或无效：${file}`);
          }
          sessionId = ev.sessionId;
        }
        if (!cwd && typeof ev.cwd === 'string') cwd = ev.cwd;
        if (ev.type === 'ai-title' && typeof ev.aiTitle === 'string') aiTitle = ev.aiTitle;
        if (ev.type === 'custom-title') {
          const t = ev.customTitle ?? ev.title;
          if (typeof t === 'string') customTitle = t;
        }
        if (ev.type !== 'message') continue;
        if (ev.isSidechain === true || ev.isMeta === true) continue;
        const role = ev.role;
        if (role !== 'user' && role !== 'assistant') continue;
        const rawText = blocksText(ev.content);
        const text = role === 'user' ? realUserText(rawText) : rawText;
        if (!text) continue;
        if (role === 'user' && !firstUser) firstUser = text;
        messages.push({ role, content: text, createdAt: toMs(ev.timestamp) });
      }
      if (!sessionId || !messages.length) return null;
      const norm = (s) => (typeof s === 'string' ? s.trim().replace(/\s+/g, ' ') : '');
      const pick = [customTitle, aiTitle, firstUser, cwd ? path.basename(cwd) : null, path.basename(file)].map(norm).find(Boolean);
      return { source: 'workbuddy', externalId: sessionId, title: truncate(pick, 80), workspace: cwd, messages, ingestMethod: 'local' };
    };

    await t('1 stream', 'workbuddy：空行/坏行/末行无换行，新旧结果一致', async () => {
      const row = (role, content, extra = {}) => j({ type: 'message', sessionId: 'wb-stream', role, content, ...extra });
      const f = put('workbuddy/p/s.jsonl', [
        j({ type: 'ai-title', aiTitle: 'AI 流式标题', sessionId: 'wb-stream' }),
        j({ type: 'custom-title', title: '  自定义\n  流式标题  ', sessionId: 'wb-stream' }),
        row('user', '前缀 <user_query>流式问题</user_query> 尾巴', { cwd: '/w/wb', timestamp: '2026-11-01T00:00:00Z' }),
        '',
        'broken',
        row('assistant', [{ type: 'output_text', text: '回答一' }, { type: 'reasoning', text: '思考' }, { type: 'output_text', text: '回答二' }]),
        row('user', '<system-reminder>注入</system-reminder>'),
        row('user', '旁支', { isSidechain: true }),
        row('assistant', '最后一行无换行', { timestamp: 1762000000000 }),
      ].join('\n'));
      const now = await ADAPTERS.workbuddy.read(f);
      same(now, await oldWorkbuddy(f));
      assert.equal(now.title, '自定义 流式标题');
    });

    // 旧实现：deepseek-harness
    const oldDeepseek = async (file) => {
      const load = async (f) => {
        const buf = await fs.promises.readFile(f);
        if (!f.endsWith('.zstd')) return buf.toString('utf8');
        return zlib.zstdDecompressSync(buf).toString('utf8');
      };
      const textOf = (content) => {
        if (!Array.isArray(content)) return typeof content === 'string' ? content : '';
        const parts = [];
        for (const b of content) {
          if (!b || typeof b !== 'object') continue;
          if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
          else if (b.type === 'file') parts.push(`[文件] ${b.name || b.path || ''}`.trim());
          else if (b.type === 'image') parts.push('[图片]');
        }
        return parts.join('\n').trim();
      };
      const lines = (await load(file)).split('\n');
      let header;
      try { header = JSON.parse(lines[0]); } catch { return null; }
      if (!header || header.type !== 'session' || !header.id) return null;
      if (header.origin === 'subagent') return null;
      const messages = [];
      let title;
      for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        let row;
        try { row = JSON.parse(lines[i]); } catch { continue; }
        const data = row && row.data;
        if (!data || typeof data !== 'object') continue;
        if (row.type === 'session/title' && typeof data.title === 'string') { title = data.title; continue; }
        if (row.type !== 'user/message' && row.type !== 'assistant/message') continue;
        if (row.surfaceOp !== 'append') continue;
        const role = row.type === 'user/message' ? 'user' : 'assistant';
        const msg = role === 'user' ? data : (data.message || data);
        if (role === 'user' && msg.source && msg.source.kind !== 'user') continue;
        const text = textOf(msg.content);
        if (!text) continue;
        const t = Number.isFinite(row.time) ? row.time : undefined;
        const last = messages[messages.length - 1];
        if (last && last.role === 'assistant' && role === 'assistant') { last.content += '\n' + text; last.createdAt = t ?? last.createdAt; }
        else messages.push({ role, content: text, createdAt: t });
      }
      if (!messages.some((m) => m.role === 'user')) return null;
      return {
        source: 'deepseek-harness', externalId: header.id, title, workspace: header.cwd || null,
        createdAt: Number.isFinite(header.createdAt) ? header.createdAt : undefined,
        messages, ingestMethod: 'local',
      };
    };

    await t('1 stream', 'deepseek-harness：空行/坏行/末行无换行，新旧结果一致（含 zstd）', async () => {
      const hdr = j({ type: 'session', id: 'dsh-stream', version: 1, createdAt: 1700000000000, cwd: '/w/dsh' });
      const um = (seq, text, kind = 'user') => j({ type: 'user/message', seq, time: 1700000000000 + seq, surfaceOp: 'append', data: { role: 'user', source: { kind }, content: [{ type: 'text', text }] } });
      const am = (seq, text) => j({ type: 'assistant/message', seq, time: 1700000000000 + seq, surfaceOp: 'append', data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } });
      const lines = [
        hdr,
        um(1, '流式问题'),
        '',
        'bad',
        um(2, '系统注入', 'system'),
        am(3, '回答一'),
        am(4, '回答二'),
        j({ type: 'session/title', data: { title: 'DSH 流式标题' } }),
        um(5, '最后一行无换行'),
      ].join('\n');
      const plain = put('dsh/p/s1/session.jsonl', lines);
      same(withoutStripped(await ADAPTERS['deepseek-harness'].read(plain)), await oldDeepseek(plain));
      assert.equal((await ADAPTERS['deepseek-harness'].read(plain)).title, 'DSH 流式标题');
      assert.equal((await ADAPTERS['deepseek-harness'].read(plain)).strippedBlocks, 1);

      const zf = put('dsh/p/s2/session.v2.jsonl.zstd', 'placeholder');
      fs.writeFileSync(zf, zlib.zstdCompressSync(Buffer.from(lines)));
      same(withoutStripped(await ADAPTERS['deepseek-harness'].read(zf)), await oldDeepseek(zf));

      // 空文件 / 坏 header 都返回 null，与旧实现一致
      const empty = put('dsh/p/s3/session.jsonl', '');
      same(withoutStripped(await ADAPTERS['deepseek-harness'].read(empty)), await oldDeepseek(empty));
      const badHeader = put('dsh/p/s4/session.jsonl', '{"type":"sess');
      same(withoutStripped(await ADAPTERS['deepseek-harness'].read(badHeader)), await oldDeepseek(badHeader));
    });
  }

  await t('1 all', 'ADAPTERS 覆盖全部 7 个本机来源', () => {
    assert.deepEqual(Object.keys(ADAPTERS).sort(), ['antigravity', 'claude-code', 'codex', 'deepseek-harness', 'dimcode', 'workbuddy', 'zcode']);
  });

  // =====================================================================
  // 2. DB / 搜索
  // =====================================================================
  {
    const store = freshStore();
    const up = (externalId, messages, extra = {}) => store.upsertConversation({ source: 'claude-code', externalId, ingestMethod: 'local', messages, ...extra });
    const day = 86400_000;
    up('a', [{ role: 'user', content: 'PostgreSQL migration for orders', createdAt: 1 * day }, { role: 'assistant', content: 'use CREATE INDEX "idx" (a*b) -x NEAR y', createdAt: 2 * day }]);
    up('b', [{ role: 'user', content: '中文分词测试：数据库索引', createdAt: 10 * day }]);
    store.upsertConversation({ source: 'chatgpt-web', externalId: 'w', ingestMethod: 'browser-extension', messages: [{ role: 'user', content: 'orders on the web, js ok' }] });
    const S = (q, o) => store.search(q, o);
    await t('2 db', 'FTS5 trigram：英文子串/中文/大小写不敏感', () => {
      assert.equal(S('greSQL').length, 1);
      assert.equal(S('数据库').length, 1);
      assert.equal(S('ORDERS').length, 2);
      assert.equal(S('orders migration').length, 1);
    });
    await t('2 db', '<3 字符走 LIKE 兜底（含混合长度、%、_ 转义）', () => {
      assert.equal(S('js').length, 1);
      assert.equal(S('索引').length, 1);
      assert.equal(S('js orders').length, 1);
      assert.equal(S('%').length, 0);
      assert.equal(S('_').length, 0);
      assert.equal(S('\\').length, 0);
    });
    await t('2 db', '特殊字符不抛 SQL/FTS 语法错误', () => {
      const qs = ['"', '""', '"""', "'", "''';DROP TABLE messages;--", '*', 'abc*', '***', '-', '-abc', 'NOT', 'AND', 'OR', 'NEAR', 'NEAR(a b)', 'NEAR/3', '(', ')', '((( )))', '"idx"', '(a*b)', 'a:b', 'content:abc', '^abc', '{x}', '[x]', '\u0000ab\u0000', '😀😀😀', '  \t  ', 'x'.repeat(5000)];
      for (const q of qs) assert.doesNotThrow(() => S(q), `query=${j(q)}`);
      assert.equal(S('"idx"').length, 1);
      assert.equal(S('(a*b)').length, 1);
      assert.equal(S('NEAR').length, 1);
      assert.equal(S('-x').length, 1);
      assert.ok(store.db.prepare('SELECT COUNT(*) n FROM messages').get().n > 0);
    });
    await t('2 db', '过滤：sources / since / until / limit', () => {
      assert.equal(S('orders', { sources: ['chatgpt-web'] }).length, 1);
      assert.equal(S('orders', { sources: ['codex'] }).length, 0);
      assert.equal(S('orders', { since: 3 * day, until: 5 * day }).length, 0);
      assert.equal(S('orders', { until: 3 * day }).length, 1);
      assert.equal(S('orders', { limit: 1 }).length, 1);
      assert.equal(store.listConversations({ sources: ['claude-code'] }).length, 2);
      assert.equal(store.listConversations({ since: 5 * day, sources: ['claude-code'] }).length, 1);
    });
    await t('2 db', '未知来源 / 缺 externalId 拒绝', () => {
      assert.throws(() => store.upsertConversation({ source: 'evil', externalId: 'x', ingestMethod: 'local', messages: [] }));
      assert.throws(() => store.upsertConversation({ source: 'codex', externalId: '', ingestMethod: 'local', messages: [] }));
    });
    await t('2 db', '更新消息后 FTS 同步（旧词搜不到、新词能搜到）', () => {
      up('b', [{ role: 'user', content: '换成了全新的内容' }]);
      assert.equal(S('数据库').length, 0);
      assert.equal(S('全新的').length, 1);
    });
    await t('2 db', '删除会话：级联删消息并同步 FTS', () => {
      const id = store.search('greSQL')[0].conversationId;
      store.deleteConversation(id);
      assert.equal(S('greSQL').length, 0);
      assert.equal(store.db.prepare('SELECT COUNT(*) n FROM messages WHERE conversation_id=?').get(id).n, 0);
      assert.equal(store.db.prepare("SELECT COUNT(*) n FROM messages_fts WHERE messages_fts MATCH '\"greSQL\"'").get().n, 0);
      store.db.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES ('integrity-check', 1)");
    });
    store.close();
  }

  // =====================================================================
  // 2b. upsertConversation 增量写入（旧正文用 iterate 逐行比较）
  // =====================================================================
  {
    const store = freshStore();
    const up = (externalId, messages, extra = {}) => store.upsertConversation({ source: 'claude-code', externalId, ingestMethod: 'local', messages, ...extra });
    const rows = (externalId) => msgs(store, store.db.prepare("SELECT id FROM conversations WHERE source='claude-code' AND external_id=?").get(externalId).id)
      .map((m) => `${m.seq}:${m.role}:${m.content}`);
    // 统计 upsert 期间有没有把 messages 表整份读进数组（.all()）：只应出现 COUNT/LIMIT 之类的小查询
    const spyFullReads = (fn) => {
      const orig = store.db.prepare.bind(store.db);
      const reads = [];
      store.db.prepare = (sql) => {
        const st = orig(sql);
        if (/^\s*SELECT[\s\S]*\bFROM messages\b/i.test(sql) && !/\bCOUNT\s*\(/i.test(sql) && !/\bLIMIT\b/i.test(sql)) {
          const all = st.all.bind(st);
          st.all = (...a) => { reads.push(sql); return all(...a); };
        }
        return st;
      };
      try { return { ret: fn(), reads }; } finally { store.db.prepare = orig; }
    };
    const L = (n, tag = 'm') => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${tag}${i}` }));

    await t('2b upsert', '新增：changed/added 计数正确，message_count 同步', () => {
      const r1 = up('u1', L(3));
      assert.deepEqual([r1.changed, r1.added], [true, 3]);
      const r2 = up('u1', L(3));
      assert.deepEqual([r2.changed, r2.added], [false, 0]);
      assert.deepEqual(rows('u1'), ['0:user:m0', '1:assistant:m1', '2:user:m2']);
      const row = store.db.prepare("SELECT message_count FROM conversations WHERE source='claude-code' AND external_id='u1'").get();
      assert.equal(row.message_count, 3);
    });
    await t('2b upsert', '尾部追加：只新增差额，旧消息原样保留', () => {
      const r = up('u1', L(5));
      assert.deepEqual([r.changed, r.added], [true, 2]);
      assert.deepEqual(rows('u1'), ['0:user:m0', '1:assistant:m1', '2:user:m2', '3:assistant:m3', '4:user:m4']);
    });
    await t('2b upsert', '修改中间一条：原位更新，不增删，added 为 0', () => {
      const list = L(5);
      list[2] = { role: 'assistant', content: '改过的中间一条' };
      const r = up('u1', list);
      assert.deepEqual([r.changed, r.added], [true, 0]);
      assert.deepEqual(rows('u1'), ['0:user:m0', '1:assistant:m1', '2:assistant:改过的中间一条', '3:assistant:m3', '4:user:m4']);
      assert.equal(store.search('改过的中间一条').length, 1, 'FTS 应同步');
      assert.equal(store.search('m2').length, 0, '旧内容应搜不到');
    });
    await t('2b upsert', 'authoritative 截断：删掉多余尾部，message_count 变准', () => {
      const r = up('u1', L(2), { authoritative: true });
      assert.deepEqual([r.changed, r.added], [true, 0]);
      assert.deepEqual(rows('u1'), ['0:user:m0', '1:assistant:m1']);
      assert.equal(store.db.prepare("SELECT message_count FROM conversations WHERE source='claude-code' AND external_id='u1'").get().message_count, 2);
      const count = store.db.prepare("SELECT COUNT(*) n FROM messages WHERE conversation_id=(SELECT id FROM conversations WHERE external_id='u1')").get().n;
      assert.equal(count, 2);
    });
    await t('2b upsert', 'Claude Code 非 authoritative 也按完整快照截断；其它本地来源与网页非 align 不截断；同内容重复写不产生变更', () => {
      const r = up('u1', L(2).slice(0, 1));
      assert.deepEqual([r.changed, r.added], [true, 0]);
      assert.deepEqual(rows('u1'), ['0:user:m0']);
      assert.equal(store.db.prepare("SELECT message_count FROM conversations WHERE source='claude-code' AND external_id='u1'").get().message_count, 1);
      const r2 = up('u1', L(2).slice(0, 1));
      assert.deepEqual([r2.changed, r2.added], [false, 0]);
      // 网页来源未声明 authoritative 时维持旧行为，不截断
      const W = (ext, n) => store.upsertConversation({
        source: 'gemini-web', externalId: ext, ingestMethod: 'browser-extension',
        messages: Array.from({ length: n }, (_, i) => ({ role: 'user', content: `${ext}-${i}` })),
      });
      const C = (ext, n) => store.upsertConversation({
        source: 'codex', externalId: ext, ingestMethod: 'local',
        messages: Array.from({ length: n }, (_, i) => ({ role: 'user', content: `${ext}-${i}` })),
      });
      C('codex-keep', 3);
      C('codex-keep', 1);
      const cid = store.db.prepare("SELECT id FROM conversations WHERE external_id='codex-keep'").get().id;
      assert.equal(msgs(store, cid).length, 3);
      W('no-trunc', 3);
      W('no-trunc', 1);
      const id = store.db.prepare("SELECT id FROM conversations WHERE external_id='no-trunc'").get().id;
      assert.equal(msgs(store, id).length, 3);
    });
    await t('2b upsert', 'upsert 不把旧正文整份读进数组（无全表 .all()）', () => {
      const list = L(50);
      const { ret, reads } = spyFullReads(() => up('u2', list));
      assert.deepEqual([ret.changed, ret.added], [true, 50]);
      assert.deepEqual(reads, [], `仍有一次全量读取：${reads[0]}`);
      list[25] = { role: 'user', content: 'z' + '25' };
      list.push({ role: 'assistant', content: 'm50' });
      list.splice(48, 2); // 变短，触发尾部删除
      const r2 = spyFullReads(() => up('u2', list, { authoritative: true }));
      assert.deepEqual([r2.ret.changed, r2.ret.added], [true, 0]);
      assert.deepEqual(r2.reads, [], `仍有一次全量读取：${r2.reads[0]}`);
      assert.equal(store.db.prepare("SELECT message_count FROM conversations WHERE external_id='u2'").get().message_count, 49);
    });
    await t('2b upsert', '网页对齐：长会话部分快照只读必要前缀，结果与逐条比对一致', () => {
      const W = (ext, list, extra = {}) => store.upsertConversation({
        source: 'gemini-web', externalId: ext, ingestMethod: 'browser-extension', align: true,
        messages: list.map(([role, content]) => ({ role, content })), ...extra,
      });
      const base = Array.from({ length: 200 }, (_, i) => [i % 2 ? 'assistant' : 'user', i % 17 === 3 ? '继续' : `c${i}`]);
      W('al1', base);
      const id = store.db.prepare("SELECT id FROM conversations WHERE external_id='al1'").get().id;
      const { ret, reads } = spyFullReads(() => W('al1',
        base.slice(100).concat([['user', '新问题'], ['assistant', '新回答']]), { authoritative: true }));
      assert.deepEqual([ret.changed, ret.added], [true, 2]);
      assert.deepEqual(reads, [], `align 分支仍有全量读取：${reads[0]}`);
      const got = msgs(store, id);
      assert.equal(got.length, 202);
      assert.equal(got[100].content, 'c100');
      assert.equal(got[200].content, '新问题');
      assert.equal(got[201].content, '新回答');
    });
    await t('2b upsert', '详情分页：getConversation 按 seq 区间读最近 200 条，取回顺序/总数不变', () => {
      const W = (ext, n) => store.upsertConversation({
        source: 'gemini-web', externalId: ext, ingestMethod: 'browser-extension',
        messages: Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${ext}-${i}` })),
      });
      W('page-long', 450);
      const id = store.db.prepare("SELECT id FROM conversations WHERE external_id='page-long'").get().id;
      const meta = store.getConversation(id, { limit: 0 });
      assert.equal(meta.message_count, 450);
      assert.equal(meta.messages.length, 0, 'limit:0 只取元数据，不读正文');
      const fromSeq = Math.max(0, meta.message_count - 200);
      assert.equal(fromSeq, 250);
      const tail = store.getConversation(id, { fromSeq, limit: 200 }).messages;
      assert.equal(tail.length, 200);
      assert.equal(tail[0].seq, 250);
      assert.equal(tail[0].content, 'page-long-250');
      assert.equal(tail[199].seq, 449);
      // 上一页区间
      const prev = tail[0].seq > 0 ? Math.max(0, tail[0].seq - 200) : null;
      const older = store.getConversation(id, { fromSeq: prev, limit: tail[0].seq - prev }).messages;
      assert.equal(older.length, 200);
      assert.equal(older[0].seq, 50);
      assert.equal(older[199].seq, 249);
      // 首页区间（不足 200 条）
      const head = store.getConversation(id, { fromSeq: 0, limit: 50 }).messages;
      assert.equal(head.length, 50);
      assert.equal(head[49].seq, 49);
    });
    await t('2b upsert', '详情分页：短会话 fromSeq=0 全量返回，与旧行为一致', () => {
      store.upsertConversation({
        source: 'gemini-web', externalId: 'page-short', ingestMethod: 'browser-extension',
        messages: Array.from({ length: 12 }, (_, i) => ({ role: 'user', content: `s${i}` })),
      });
      const id = store.db.prepare("SELECT id FROM conversations WHERE external_id='page-short'").get().id;
      const meta = store.getConversation(id, { limit: 0 });
      assert.equal(Math.max(0, meta.message_count - 200), 0);
      const all = store.getConversation(id, { fromSeq: 0, limit: 200 }).messages;
      assert.equal(all.length, 12);
      assert.deepEqual(all.map((m) => m.seq), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    });
    store.close();
  }

  // =====================================================================
  // 2c. search / conversationActivity：迭代读取不改变结果
  // =====================================================================
  {
    const store = freshStore();
    const up = (source, externalId, messages, extra = {}) => store.upsertConversation({ source, externalId, ingestMethod: source.endsWith('-web') ? 'browser-extension' : 'local', messages, ...extra });
    const D = 86400_000;
    const base = Date.UTC(2026, 9, 1, 2, 0, 0); // 本地时区下 10-01 前后
    // 同一会话多条命中（用于截断到每会话 3 条）、跨天、无时间戳会话、网页来源
    up('claude-code', 's1', Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `索引方案 orders ${i}`, createdAt: base + i * 60000 })), { title: '搜索会话一' });
    up('codex', 's2', [
      { role: 'user', content: 'orders 与索引方案', createdAt: base + 5 * 60000 },
      { role: 'assistant', content: '另一天继续 orders 讨论', createdAt: base + D },
    ], { title: '搜索会话二' });
    up('claude-code', 's3', [{ role: 'user', content: '无关内容', createdAt: base + 2 * D }]);
    up('gemini-web', 's4', [{ role: 'user', content: '网页 orders 记录' }], { title: '网页会话' });
    up('dimcode', 's5', [{ role: 'user', content: '没有时间戳的 orders 会话' }], { title: '无时间戳' });

    // 旧版 search：先 .all() 取 limit×5 条，再逐条生成摘要；用于对比
    const searchOld = (query, { sources, limit = 20, since, until } = {}) => {
      const terms = query.replace(/\u0000/g, ' ').trim().split(/\s+/).filter(Boolean);
      const filters = []; const fargs = [];
      if (sources && sources.length) { filters.push(`c.source IN (${sources.map(() => '?').join(',')})`); fargs.push(...sources); }
      if (since) { filters.push('c.updated_at >= ?'); fargs.push(since); }
      if (until) { filters.push('c.updated_at <= ?'); fargs.push(until); }
      const extra = filters.length ? ' AND ' + filters.join(' AND ') : '';
      const snip = (text, ts, radius = 80) => {
        const lower = text.toLowerCase(); let at = -1;
        for (const t of ts) { at = lower.indexOf(t.toLowerCase()); if (at >= 0) break; }
        if (at < 0) return text.slice(0, radius * 2);
        const start = Math.max(0, at - radius); const end = Math.min(text.length, at + radius);
        return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ') + (end < text.length ? '…' : '');
      };
      let rows;
      if (terms.every((t) => [...t].length >= 3)) {
        const match = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND ');
        rows = store.db.prepare(`SELECT m.conversation_id, m.seq, m.role, m.content, m.created_at, c.source, c.title, c.url, c.updated_at,
          bm25(messages_fts) AS score FROM messages_fts f JOIN messages m ON m.rowid = f.rowid JOIN conversations c ON c.id = m.conversation_id
          WHERE messages_fts MATCH ?${extra} ORDER BY score LIMIT ?`).all(match, ...fargs, limit * 5);
      } else {
        const likes = terms.map(() => 'm.content LIKE ? ESCAPE \'\\\'').join(' AND ');
        const largs = terms.map((t) => `%${t.replace(/[\\%_]/g, (c) => '\\' + c)}%`);
        rows = store.db.prepare(`SELECT m.conversation_id, m.seq, m.role, m.content, m.created_at, c.source, c.title, c.url, c.updated_at, 0 AS score
          FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE ${likes}${extra} ORDER BY c.updated_at DESC LIMIT ?`).all(...largs, ...fargs, limit * 5);
      }
      const byConv = new Map();
      for (const r of rows) {
        let g = byConv.get(r.conversation_id);
        if (!g) {
          if (byConv.size >= limit) continue;
          g = { conversationId: r.conversation_id, source: r.source, title: r.title, url: r.url, updatedAt: r.updated_at, hits: [] };
          byConv.set(r.conversation_id, g);
        }
        if (g.hits.length < 3) g.hits.push({ seq: r.seq, role: r.role, createdAt: r.created_at, snippet: snip(r.content, terms) });
      }
      return [...byConv.values()];
    };
    const opts = [{}, { limit: 1 }, { limit: 2 }, { limit: 50 }, { sources: ['codex'] }, { since: base + 2 * D }, { until: base + D }];

    await t('2c search', '逐条迭代生成摘要：结果与旧版（limit×5 后聚合）完全一致', () => {
      for (const q of ['orders', '索引方案', 'orders 索引方案', '网页', 'jd']) {
        for (const o of opts) assert.deepEqual(store.search(q, o), searchOld(q, o), `query=${q} opts=${j(o)}`);
      }
    });
    await t('2c search', 'search 不再对 limit×5 条正文调用 .all()，且凑够即停', () => {
      up('codex', 'many', Array.from({ length: 40 }, (_, i) => ({ role: 'user', content: `uniquealpha 第 ${i} 条`, createdAt: base + i * 1000 })), { title: '多条命中' });
      const orig = store.db.prepare.bind(store.db);
      let fullReads = 0; let rowsRead = 0; let iterCalls = 0;
      store.db.prepare = (sql) => {
        const st = orig(sql);
        if (/\bFROM messages(_fts)?\b/.test(sql) || /FROM messages_fts f/.test(sql)) {
          const all = st.all.bind(st);
          st.all = (...a) => { fullReads++; return all(...a); };
          const iter = st.iterate.bind(st);
          st.iterate = (...a) => { iterCalls++; const it = iter(...a); return { [Symbol.iterator]() { return this; }, next() { const r = it.next(); if (!r.done) rowsRead++; return r; } }; };
        }
        return st;
      };
      try {
        const r = store.search('uniquealpha', { limit: 1 });
        assert.equal(r.length, 1);
        assert.equal(r[0].hits.length, 3);
        assert.equal(fullReads, 0, '不应再有 .all() 全量读取');
        assert.equal(iterCalls, 1);
        assert.ok(rowsRead <= 3, `凑够 3 条即停，实际读取 ${rowsRead} 行（limit×5 = 5）`);
      } finally { store.db.prepare = orig; }
    });

    // 旧版 conversationActivity：.all() 取出每一条消息时间点
    const activityOld = (since, until, sources) => {
      const sf = sources && sources.length ? ` AND c.source IN (${sources.map(() => '?').join(',')})` : '';
      const sa = sources && sources.length ? sources : [];
      const msgs = store.db.prepare(`SELECT m.conversation_id AS cid, m.created_at AS at FROM messages m
        JOIN conversations c ON c.id = m.conversation_id WHERE m.created_at >= ? AND m.created_at <= ?${sf}`).all(since, until, ...sa);
      const untimed = store.db.prepare(`SELECT c.id AS cid, c.updated_at AS at FROM conversations c
        WHERE c.updated_at >= ? AND c.updated_at <= ?${sf}
          AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.created_at IS NOT NULL)`).all(since, until, ...sa);
      return msgs.concat(untimed.map((r) => ({ ...r, untimed: true })));
    };
    const fmtDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    const groupOld = (points) => {
      const byDay = new Map();
      for (const p of points) {
        const day = fmtDay(p.at);
        if (!byDay.has(day)) byDay.set(day, new Map());
        const m = byDay.get(day); let g = m.get(p.cid);
        if (!g) { g = { cid: p.cid, first: p.at, last: p.at, n: 0, untimed: !!p.untimed }; m.set(p.cid, g); }
        g.first = Math.min(g.first, p.at); g.last = Math.max(g.last, p.at);
        if (!p.untimed) g.n++;
      }
      return byDay;
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
      return byDay;
    };
    const dump = (byDay) => [...byDay.keys()].sort().reverse().map((d) => [d, [...byDay.get(d).values()].sort((a, b) => b.last - a.last || a.cid.localeCompare(b.cid))]);
    const now = Date.now();
    const ranges = [
      [base - D, base + 3 * D, undefined],
      [base, base + 3 * D, ['claude-code']],
      [base + D, base + D, ['codex']],
      [now - 3600_000, now + 3600_000, undefined],
      [base, base + 3 * D, []],
    ];
    await t('2c activity', 'SQL 聚合 + 迭代结果与旧版逐条时间点完全一致（日期/首末时间/当日条数）', () => {
      for (const [since, until, sources] of ranges) {
        const oldPts = activityOld(since, until, sources);
        const { activity } = store.conversationActivity({ since, until, sources });
        assert.deepEqual(dump(groupNew(activity)), dump(groupOld(oldPts)), `range=${since}-${until} sources=${j(sources)}`);
        assert.deepEqual([...activity.keys()].sort(), [...new Set(oldPts.map((p) => p.cid))].sort());
      }
    });
    await t('2c activity', 'conversationActivity 不再 .all() 读消息时间点；meta 仍按批取会话信息', () => {
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
        const { activity, meta } = store.conversationActivity({ since: base - D, until: base + 3 * D });
        assert.ok(activity.size >= 3);
        assert.ok(meta.size >= 3);
        assert.equal(fullReads, 0, '不应再 .all() 消息时间点');
      } finally { store.db.prepare = orig; }
    });
    store.close();
  }
  {
    const store = freshStore();
    store.upsertConversation({ source: 'codex', externalId: 'm1', ingestMethod: 'local', title: 'MCP 会话', messages: Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `message number ${i} kubernetes`, createdAt: 1700000000000 + i })) });
    const port = await freePort();
    let mcp;
    await t('3 mcp', `在 127.0.0.1:${port} 启动，对外地址带 token`, async () => {
      mcp = await startMcpServer(store, { port });
      assert.equal(mcp.token, mcpToken(dataDir()));
      assert.equal(mcp.url, `http://127.0.0.1:${port}/mcp?token=${encodeURIComponent(mcp.token)}`);
      assert.ok(!mcp.url.endsWith('/mcp'));
    });
    await t('3 mcp', '密钥文件：首次生成后复用（再次启动/再次读取都是同一个 token）', async () => {
      const file = path.join(dataDir(), 'mcp-token');
      assert.equal(fs.readFileSync(file, 'utf8').trim(), mcp.token);
      assert.equal(mcpToken(dataDir()), mcp.token);
      if (process.platform !== 'win32') assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
      const again = await startMcpServer(store, { port: 0 });
      assert.equal(again.token, mcp.token);
      assert.equal(again.url, `http://127.0.0.1:0/mcp?token=${encodeURIComponent(mcp.token)}`);
      await again.close();
    });
    // 默认带 Bearer；noAuth 时不带任何密钥，path 可覆盖（如换成查询参数）
    const raw = (opts = {}, body) => new Promise((resolve, reject) => {
      const { noAuth, ...o } = opts;
      const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', host: `127.0.0.1:${port}`, ...(noAuth ? {} : { authorization: `Bearer ${mcp.token}` }), ...(o.headers || {}) };
      const req = http.request({ agent: false, host: '127.0.0.1', port, path: '/mcp', method: 'POST', ...o, headers }, (res) => {
        let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
      });
      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
    const init = j({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    if (mcp) {
      const client = new Client({ name: 'indep', version: '1' });
      await t('3 mcp', 'SDK 客户端连接，列出 4 个工具（get_memory_context / list_conversations / recall / save_memory）', async () => {
        await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url)));
        const { tools } = await client.listTools();
        assert.deepEqual(tools.map((x) => x.name).sort(), ['get_memory_context', 'list_conversations', 'recall', 'save_memory']);
        assert.ok(client.getInstructions() && client.getInstructions().includes('recall'));
      });
      const day0 = (() => { const d = new Date(1700000000000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
      await t('3 mcp', 'list / recall 正常返回纯文本（目录不含正文；片段带角色标签与 process_id）', async () => {
        const l = (await client.callTool({ name: 'list_conversations', arguments: { from: day0, to: day0, sources: ['codex'] } })).content[0].text;
        assert.ok(l.includes(`## ${day0}`) && l.includes('[Codex] MCP 会话') && l.includes('共 30 条消息'), l);
        assert.ok(!l.includes('message number'), '目录不应含正文');
        const r = (await client.callTool({ name: 'recall', arguments: { query: 'kubernetes' } })).content[0].text;
        assert.ok(r.includes('【1】来源：Codex') && r.includes('会话：MCP 会话'), r);
        assert.ok(/\[用户\] message number \d+ kubernetes/.test(r) && /\[AI\] message number \d+ kubernetes/.test(r), r);
        assert.match(r, /process_id: [0-9a-f-]{36}（当前对话窗口固定值；后续每次调用 recall 都必须原样传回，即使更换 query 也不得更换）$/);
        assert.ok(!r.trim().startsWith('{') && !r.trim().startsWith('['), '应为纯文本而非 JSON');
      });
      await t('3 mcp', '坏参数 → isError，不崩', async () => {
        const bad = [
          ['recall', { query: '' }], ['recall', { query: 'x'.repeat(201) }], ['recall', {}],
          ['recall', { query: 'abc', sources: ['evil'] }], ['recall', { query: 123 }],
          ['recall', { query: 'abc', alternatives: Array(9).fill('a') }], ['recall', { query: 'abc', from: 'garbage' }],
          ['recall', { query: 'abc', from: '2026-02-30' }], ['recall', { query: 'abc', from: '2026-11-05', to: '2026-11-01' }],
          ['list_conversations', {}], ['list_conversations', { from: '2026-11-01' }], ['list_conversations', { from: '2026/11/01', to: '2026/11/02' }],
          ['list_conversations', { from: '2026-11-01', to: '2026-12-15' }], ['list_conversations', { from: '2026-11-01', to: '2026-10-01' }],
          ['search_conversations', { query: 'abc' }], ['read_conversation', { id: 'x' }], ['no_such_tool', {}],
        ];
        for (const [name, args] of bad) {
          let r; try { r = await client.callTool({ name, arguments: args }); } catch (e) { r = { isError: true, thrown: e.message }; }
          assert.ok(r.isError, `${name} ${j(args)} 应报错`);
        }
        const ok = await client.callTool({ name: 'recall', arguments: { query: '"(NEAR*' } });
        assert.ok(!ok.isError);
      });
      await client.close();

      // ---------- 访问密钥 ----------
      const initBody = j({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
      await t('3 mcp', '无 token → 401 JSON-RPC 错误体，且不泄露正确密钥', async () => {
        const r = await raw({ noAuth: true }, initBody);
        assert.equal(r.status, 401);
        const b = JSON.parse(r.body);
        assert.equal(b.jsonrpc, '2.0');
        assert.equal(b.id, null);
        assert.equal(b.error.code, -32001);
        assert.match(b.error.message, /未授权/);
        assert.ok(!r.body.includes(mcp.token), '响应里不能出现正确密钥');
        assert.equal((await raw({ noAuth: true, headers: { authorization: '' } }, initBody)).status, 401);
        assert.equal((await raw({ noAuth: true, headers: { authorization: 'Basic xyz' } }, initBody)).status, 401);
        assert.equal((await raw({ noAuth: true, headers: { authorization: 'Bearer' } }, initBody)).status, 401);
      });
      await t('3 mcp', '错 token（头或查询参数，含前缀/长度不同的近似值）→ 401', async () => {
        for (const t2 of [mcp.token.slice(0, -1), mcp.token + 'x', mcp.token.slice(1), 'x', '']) {
          assert.equal((await raw({ noAuth: true, headers: { authorization: `Bearer ${t2}` } }, initBody)).status, 401, `header ${j(t2)}`);
          assert.equal((await raw({ noAuth: true, path: `/mcp?token=${encodeURIComponent(t2)}` }, initBody)).status, 401, `query ${j(t2)}`);
        }
        assert.equal((await raw({ noAuth: true, path: '/mcp?token=' }, initBody)).status, 401);
      });
      await t('3 mcp', 'header / 查询参数两种方式都能通过；二者混用取其一正确即可', async () => {
        assert.equal((await raw({ path: `/mcp?token=${encodeURIComponent(mcp.token)}` }, initBody)).status, 200);
        assert.equal((await raw({ headers: { authorization: `Bearer ${mcp.token}` } }, initBody)).status, 200);
        assert.equal((await raw({ headers: { authorization: `bearer ${mcp.token}` } }, initBody)).status, 200, 'Bearer 大小写不敏感');
        assert.equal((await raw({ headers: { authorization: `Bearer   ${mcp.token}  ` } }, initBody)).status, 200, '允许多余空白');
        assert.equal((await raw({ path: `/mcp?token=${encodeURIComponent(mcp.token)}`, headers: { authorization: 'Bearer wrong' } }, initBody)).status, 200, '查询参数正确即可，不因错误头被拒');
        assert.equal((await raw({ path: '/mcp?token=wrong', headers: { authorization: `Bearer ${mcp.token}` } }, initBody)).status, 200, '头正确即可，不因错误查询参数被拒');
        assert.equal((await raw({ path: `/mcp?x=1&token=${encodeURIComponent(mcp.token)}` }, initBody)).status, 200);
        // 密钥不会被当成 JSON 正文的一部分，初始化仍正常返回
        assert.ok(JSON.parse((await raw({ path: `/mcp?token=${encodeURIComponent(mcp.token)}` }, initBody)).body).result);
      });
      await t('3 mcp', 'Host / Origin 校验仍在密钥之前（外站 Host + 正确密钥 → 403，不是 401）', async () => {
        assert.equal((await raw({ noAuth: true, headers: { host: `evil.com:${port}` } }, initBody)).status, 403);
        assert.equal((await raw({ headers: { host: `evil.com:${port}` } }, initBody)).status, 403);
        assert.equal((await raw({ headers: { origin: 'https://evil.com' } }, initBody)).status, 403);
      });
      await t('3 mcp', 'SDK 客户端：查询参数地址与 Bearer 头两种接法都能调工具', async () => {
        const viaQuery = new Client({ name: 'q', version: '1' });
        await viaQuery.connect(new StreamableHTTPClientTransport(new URL(mcp.url)));
        assert.ok((await viaQuery.callTool({ name: 'recall', arguments: { query: 'kubernetes' } })).content[0].text.includes('【1】'));
        await viaQuery.close();
        const viaHeader = new Client({ name: 'h', version: '1' });
        await viaHeader.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${mcp.token}` } } }));
        assert.ok((await viaHeader.callTool({ name: 'recall', arguments: { query: 'kubernetes' } })).content[0].text.includes('【1】'));
        await viaHeader.close();
        const unauthed = new Client({ name: 'n', version: '1' });
        await assert.rejects(() => unauthed.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))));
        await unauthed.close().catch(() => {});
      });
      await t('3 mcp', 'HTTP 层坏输入：坏 JSON 400、GET 405、未知路径 404、>1MB 413、JSON null/数组/非 JSON-RPC 不崩', async () => {
        assert.equal((await raw({}, '{bad')).status, 400);
        assert.equal((await raw({ method: 'GET' })).status, 405);
        assert.equal((await raw({ path: '/x' }, '{}')).status, 404);
        const big = await raw({}, j({ pad: 'x'.repeat(1_100_000) })).catch((e) => ({ status: 'reset:' + e.code }));
        assert.ok(big.status === 413 || String(big.status).startsWith('reset'), `got ${big.status}`);
        for (const b of ['null', '[]', '{}', '"str"', '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":null}']) {
          const r = await raw({}, b);
          assert.ok(r.status >= 200 && r.status < 500, `${b} -> ${r.status}`);
        }
        assert.equal((await raw({ path: '/health', method: 'GET' })).status, 200);
        assert.equal((await raw({ path: '/health', method: 'GET', noAuth: true })).status, 200, '健康检查不含数据，无需密钥');
      });
      await t('3 mcp', 'Host 校验：DNS rebinding 风格 Host 全部 403', async () => {
        for (const h of ['evil.com', `evil.com:${port}`, `127.0.0.1.evil.com:${port}`, `localhost.evil.com:${port}`, '127.0.0.1', '127.0.0.1:80', `[::1]:${port}`, `0.0.0.0:${port}`, `LOCALHOST:${port}x`]) {
          const r = await raw({ headers: { host: h } }, init);
          assert.equal(r.status, 403, `Host ${j(h)} -> ${r.status}`);
        }
        assert.equal((await raw({ headers: { host: `localhost:${port}` } }, init)).status, 200);
      });
      await t('3 mcp', 'Origin 校验：外站/null/伪装前缀 403', async () => {
        for (const o of ['https://evil.com', 'http://evil.com', 'null', 'http://127.0.0.1.evil.com', `http://localhost.evil.com:${port}`, 'http://localhost@evil.com', 'file://', 'chrome-extension://abc']) {
          const r = await raw({ headers: { origin: o } }, init);
          assert.equal(r.status, 403, `Origin ${o} -> ${r.status}`);
        }
        assert.equal((await raw({ headers: { origin: `http://localhost:${port}` } }, init)).status, 200);
      });
      await t('3 mcp', '[信息] 任意本机端口的网页 Origin（如 http://localhost:5173）被放行', async () => {
        const r = await raw({ headers: { origin: 'http://localhost:5173' } }, init);
        assert.equal(r.status, 200);
      });
      await t('3 mcp', 'close()：在途请求收尾后关闭，之后端口不再接受连接', async () => {
        // 发起一个请求但先不读完响应，close() 应等在途请求结束（最多 1 秒）
        const pending = raw({}, init);
        const t0 = Date.now();
        await mcp.close();
        await pending.catch(() => {});
        assert.ok(Date.now() - t0 < 3000, 'close 不应无限等待');
        const err = await raw({}, init).catch((e) => e);
        assert.ok(err && (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET'), `关闭后仍能连接：${err && err.code}`);
      });
      await t('3 mcp', 'close()：有卡住的在途请求时最多等 1 秒即强制关闭', async () => {
        // 先占一个空闲端口（port:0 时返回对象里的 port 是请求值 0，不能直接用来连接）
        const m2Port = await freePort();
        const m2 = await startMcpServer(store, { port: m2Port });
        const stuck = http.request({ agent: false, host: '127.0.0.1', port: m2Port, path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json', host: `127.0.0.1:${m2Port}`, authorization: `Bearer ${m2.token}` } }, () => {});
        stuck.on('error', () => {});
        stuck.write('{"jsonrpc":"2.0","id":9,"method":"initialize","params":{}'); // 不结束请求体 → 在途
        await sleep(50);
        const t0 = Date.now();
        await m2.close();
        const ms = Date.now() - t0;
        assert.ok(ms >= 900 && ms < 2500, `应在约 1 秒后强制关闭，实际 ${ms}ms`);
        stuck.destroy();
        // 重复 close 幂等
        await m2.close();
      });
      await mcp.close();
      assert.ok(true);
    }
    store.close();
  }

  // =====================================================================
  // 2d. SQLite v2 迁移与记忆/事项基础读写（SPEC 2.1 / 2.3）
  // =====================================================================
  {
    // 0.5.5 的 v1 建表语句（逐字复制旧 migrate()），用于手工造一个存量旧库
    const V1_DDL = `
      CREATE TABLE IF NOT EXISTS conversations (
        id            TEXT PRIMARY KEY,
        source        TEXT NOT NULL,
        external_id   TEXT NOT NULL,
        title         TEXT,
        url           TEXT,
        workspace     TEXT,
        created_at    INTEGER,
        updated_at    INTEGER,
        message_count INTEGER NOT NULL DEFAULT 0,
        ingest_method TEXT NOT NULL CHECK (ingest_method IN ('local','browser-extension')),
        UNIQUE(source, external_id)
      );
      CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_conv_source ON conversations(source, updated_at DESC);

      CREATE TABLE IF NOT EXISTS messages (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        seq             INTEGER NOT NULL,
        role            TEXT NOT NULL,
        content         TEXT NOT NULL,
        created_at      INTEGER,
        UNIQUE(conversation_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, seq);

      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content, content='messages', content_rowid='rowid', tokenize='trigram'
      );
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

      CREATE TABLE IF NOT EXISTS file_cursors (
        path      TEXT PRIMARY KEY,
        source    TEXT NOT NULL,
        size      INTEGER NOT NULL,
        mtime_ms  INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS source_settings (
        source  TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);

      CREATE TABLE IF NOT EXISTS deleted_conversations (
        id          TEXT PRIMARY KEY,
        msg_count   INTEGER NOT NULL,
        deleted_at  INTEGER NOT NULL
      );
    `;
    const v1dir = path.join(T, 'db-v1');
    fs.mkdirSync(v1dir);
    {
      const old = new DatabaseSync(path.join(v1dir, 'mem0.db'));
      old.exec('PRAGMA journal_mode = WAL;');
      old.exec(V1_DDL);
      old.prepare(`INSERT INTO conversations(id, source, external_id, title, url, workspace, created_at, updated_at, message_count, ingest_method)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('conv-old', 'claude-code', 'old-1', '旧库会话标题', 'https://example.com/old', '/home/me/proj', 1700000000000, 1700000005000, 2, 'local');
      const ins = old.prepare('INSERT INTO messages(id, conversation_id, seq, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)');
      ins.run('msg-old-0', 'conv-old', 0, 'user', '旧库检索关键词：迁移前的问题', 1700000000000);
      ins.run('msg-old-1', 'conv-old', 1, 'assistant', '旧库回答：保留全部历史正文', 1700000005000);
      old.prepare('INSERT INTO file_cursors(path, source, size, mtime_ms) VALUES (?, ?, ?, ?)')
        .run('/home/me/.claude/old.jsonl', 'claude-code', 4096, 1700000005000);
      old.exec('PRAGMA user_version = 1');
      old.close();
    }

    let store = Store.open(v1dir);

    await t('2d v2 迁移', 'v1 旧库无损升到 v2：旧行逐列一致、游标保留、FTS 照常', () => {
      assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 2);
      const conv = store.db.prepare(`SELECT id, source, external_id, title, url, workspace, created_at, updated_at, message_count, ingest_method
        FROM conversations WHERE id = ?`).get('conv-old');
      assert.deepEqual({ ...conv }, {
        id: 'conv-old', source: 'claude-code', external_id: 'old-1', title: '旧库会话标题',
        url: 'https://example.com/old', workspace: '/home/me/proj', created_at: 1700000000000,
        updated_at: 1700000005000, message_count: 2, ingest_method: 'local',
      });
      const rows = store.db.prepare('SELECT id, conversation_id, seq, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY seq').all('conv-old');
      assert.deepEqual(rows.map((r) => ({ ...r })), [
        { id: 'msg-old-0', conversation_id: 'conv-old', seq: 0, role: 'user', content: '旧库检索关键词：迁移前的问题', created_at: 1700000000000 },
        { id: 'msg-old-1', conversation_id: 'conv-old', seq: 1, role: 'assistant', content: '旧库回答：保留全部历史正文', created_at: 1700000005000 },
      ]);
      assert.deepEqual(store.db.prepare('SELECT path, source, size, mtime_ms FROM file_cursors').all().map((r) => ({ ...r })), [
        { path: '/home/me/.claude/old.jsonl', source: 'claude-code', size: 4096, mtime_ms: 1700000005000 },
      ]);
      const hits = store.search('旧库检索关键词');
      assert.equal(hits.length, 1);
      assert.equal(hits[0].conversationId, 'conv-old');
    });

    await t('2d v2 迁移', '新增 10 列默认值正确，idx_conv_project 已建', () => {
      const c = store.db.prepare(`SELECT project_id, summary, decisions_json, next_step, original_title,
        title_locked, project_locked, stripped_blocks, ai_organized_at, ai_msg_watermark
        FROM conversations WHERE id = 'conv-old'`).get();
      assert.deepEqual({ ...c }, {
        project_id: null, summary: '', decisions_json: '[]', next_step: '', original_title: null,
        title_locked: 0, project_locked: 0, stripped_blocks: 0, ai_organized_at: null, ai_msg_watermark: 0,
      });
      assert.equal(store.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type = 'index' AND name = 'idx_conv_project'").get().n, 1);
      assert.equal(store.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type = 'table' AND name IN ('projects', 'memories', 'memories_fts')").get().n, 3);
    });

    await t('2d v2 迁移', '重复打开幂等：不重复加列、不丢数据、版本仍为 2', () => {
      store.close();
      store = Store.open(v1dir);
      store.close();
      store = Store.open(v1dir);
      assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 2);
      const cols = store.db.prepare('PRAGMA table_info(conversations)').all().map((c) => c.name);
      assert.equal(cols.length, 21, `v1 的 10 列 + v2 的 11 列（含 summary_locked），实际 ${cols.length}`);
      assert.equal(cols.filter((c) => c === 'summary_locked').length, 1);
      assert.equal(cols.filter((c) => c === 'project_id').length, 1);
      assert.equal(store.db.prepare('SELECT COUNT(*) n FROM messages').get().n, 2);
      assert.equal(store.getConversation('conv-old', { limit: 10 }).messages.length, 2);
      assert.equal(store.search('旧库检索关键词').length, 1);
    });

    await t('2d v2 迁移', '半迁移状态重入：已存在的列不重复 ADD，缺的列补齐', () => {
      const pdir = path.join(T, 'db-partial');
      fs.mkdirSync(pdir);
      const raw = new DatabaseSync(path.join(pdir, 'mem0.db'));
      raw.exec(V1_DDL);
      raw.exec("ALTER TABLE conversations ADD COLUMN summary TEXT NOT NULL DEFAULT ''");
      raw.exec('PRAGMA user_version = 1');
      raw.close();
      const ps = Store.open(pdir);
      const cols = ps.db.prepare('PRAGMA table_info(conversations)').all().map((c) => c.name);
      assert.equal(cols.filter((c) => c === 'summary').length, 1);
      assert.equal(cols.length, 21);
      assert.equal(cols.filter((c) => c === 'summary_locked').length, 1);
      assert.equal(ps.db.prepare('PRAGMA user_version').get().user_version, 2);
      ps.close();
    });

    await t('2d v2 迁移', '空库：0 卡 0 事项，无演示数据；MEMORY_GROUPS 固定 4 组', () => {
      const empty = freshStore();
      assert.equal(empty.db.prepare('PRAGMA user_version').get().user_version, 2);
      assert.equal(empty.db.prepare('SELECT COUNT(*) n FROM memories').get().n, 0);
      assert.equal(empty.db.prepare('SELECT COUNT(*) n FROM projects').get().n, 0);
      assert.deepEqual(empty.listMemories(), []);
      assert.deepEqual(empty.listProjects({ includeArchived: true }), []);
      assert.deepEqual(MEMORY_GROUPS, ['个人与职业背景', '协作与沟通准则', '环境与工作流', '踩坑与经验库']);
      for (const g of MEMORY_GROUPS) assert.deepEqual(empty.listMemories({ group: g }), [], g);
      empty.close();
    });

    await t('2d 记忆卡', '新建/读取/更新/删除：JSON 列解析成数组，新卡追加到分组末尾', () => {
      const s = freshStore();
      const a = s.saveMemory({ group: '踩坑与经验库', title: 'FTS5 trigram 坑', body: '中文两字搜不到', tags: ['SQLite', '检索'], sourceIds: ['conv-old'] });
      assert.ok(a.id);
      assert.equal(a.originLabel, '手动录入');
      assert.deepEqual(a.tags, ['SQLite', '检索']);
      assert.deepEqual(a.sourceIds, ['conv-old']);
      assert.equal(a.sortOrder, 0);
      const b = s.saveMemory({ group: '踩坑与经验库', title: '第二张', body: '正文', tags: [], sourceIds: [] });
      assert.equal(b.sortOrder, 1);
      const c = s.saveMemory({ group: '个人与职业背景', title: '画像卡', body: '十年后端', originLabel: '手动录入' });
      assert.equal(c.sortOrder, 0, '各分组独立从 0 开始');
      assert.deepEqual(s.listMemories().map((x) => x.title), ['画像卡', 'FTS5 trigram 坑', '第二张']);
      assert.deepEqual(s.listMemories({ group: '踩坑与经验库' }).map((x) => x.title), ['FTS5 trigram 坑', '第二张']);
      assert.equal(s.getMemory(a.id).title, 'FTS5 trigram 坑');
      assert.equal(s.getMemory('nope'), null);
      const upd = s.saveMemory({ id: a.id, group: '踩坑与经验库', title: 'FTS5 trigram 坑（改）', body: '新正文', tags: ['SQLite'], sourceIds: ['c2'], superseded: '旧正文' });
      assert.equal(upd.createdAt, a.createdAt);
      assert.equal(upd.sortOrder, 0);
      assert.deepEqual(upd.tags, ['SQLite']);
      assert.deepEqual(upd.sourceIds, ['c2']);
      assert.equal(upd.superseded, '旧正文');
      const del = s.deleteMemory(a.id);
      assert.equal(del.title, 'FTS5 trigram 坑（改）');
      assert.deepEqual(del.tags, ['SQLite']);
      assert.equal(s.getMemory(a.id), null);
      assert.equal(s.deleteMemory(a.id), null);
      assert.throws(() => s.saveMemory({ group: '不存在的分组', title: 'x', body: 'y' }), /unknown memory group/);
      assert.throws(() => s.saveMemory({ group: '踩坑与经验库', title: '  ', body: 'y' }), /title required/);
      s.close();
    });

    await t('2d 记忆卡', 'memories_fts 触发器：插入可命中，更新后旧词失效、新词命中，删除后清空', () => {
      const s = freshStore();
      const card = s.saveMemory({ group: '踩坑与经验库', title: 'Electron 打包签名', body: 'Windows 代码签名证书过期', tags: ['Electron'] });
      const fts = (q) => s.db.prepare('SELECT m.id FROM memories_fts f JOIN memories m ON m.rowid = f.rowid WHERE memories_fts MATCH ?').all(`"${q}"`).map((r) => r.id);
      assert.deepEqual(fts('代码签名'), [card.id]);
      assert.deepEqual(fts('打包签名'), [card.id]);
      s.saveMemory({ id: card.id, group: '踩坑与经验库', title: card.title, body: '改成 notarize 公证问题', tags: ['Electron'] });
      assert.deepEqual(fts('代码签名'), []);
      assert.deepEqual(fts('notarize'), [card.id]);
      s.deleteMemory(card.id);
      assert.deepEqual(fts('notarize'), []);
      s.db.exec("INSERT INTO memories_fts(memories_fts, rank) VALUES ('integrity-check', 1)");
      s.close();
    });

    await t('2d 记忆卡', 'moveMemory：delta 在 scopeIds 可见顺序内上下移动并重排 sort_order', () => {
      const s = freshStore();
      const g = '协作与沟通准则';
      const a = s.saveMemory({ group: g, title: 'A', body: 'a' });
      const b = s.saveMemory({ group: g, title: 'B', body: 'b' });
      const c = s.saveMemory({ group: g, title: 'C', body: 'c' });
      const order = () => s.listMemories({ group: g }).map((x) => x.title);
      assert.deepEqual(order(), ['A', 'B', 'C']);
      s.moveMemory(b.id, { delta: -1, scopeIds: [a.id, b.id, c.id] });
      assert.deepEqual(order(), ['B', 'A', 'C']);
      s.moveMemory(b.id, { delta: 5, scopeIds: [b.id, a.id, c.id] });
      assert.deepEqual(order(), ['A', 'C', 'B'], '越界 delta 收敛到末尾');
      s.moveMemory(b.id, { delta: -5, scopeIds: [a.id, c.id, b.id] });
      assert.deepEqual(order(), ['B', 'A', 'C'], '越界 delta 收敛到开头');
      assert.deepEqual(s.listMemories({ group: g }).map((x) => x.sortOrder), [0, 1, 2]);
      assert.equal(s.moveMemory('nope', { delta: 1 }), null);
      s.close();
    });

    await t('2d 记忆卡', 'moveMemory：targetGroup 跨组移到目标组末尾', () => {
      const s = freshStore();
      const a = s.saveMemory({ group: '个人与职业背景', title: 'A', body: 'a' });
      const b = s.saveMemory({ group: '环境与工作流', title: 'B', body: 'b' });
      const moved = s.moveMemory(a.id, { targetGroup: '环境与工作流' });
      assert.equal(moved.group, '环境与工作流');
      assert.equal(moved.sortOrder, 1);
      assert.deepEqual(s.listMemories({ group: '环境与工作流' }).map((x) => x.title), ['B', 'A']);
      assert.deepEqual(s.listMemories({ group: '个人与职业背景' }), []);
      assert.throws(() => s.moveMemory(b.id, { targetGroup: '非法分组' }), /unknown memory group/);
      s.close();
    });

    await t('2d 推进事项', '新建/读取/更新/归档过滤/删除：JSON 列解析成数组', () => {
      const s = freshStore();
      const p = s.saveProject({ name: 'v0.6.0 升级', state: '推进中', workspace: 'D:\\work\\mem0', progress: '写迁移', decisions: ['用 FTS5', '零新依赖'], rejected: ['Elasticsearch'], nextStep: '补测试' });
      assert.ok(p.id);
      assert.equal(p.archived, false);
      assert.deepEqual(p.decisions, ['用 FTS5', '零新依赖']);
      assert.deepEqual(p.rejected, ['Elasticsearch']);
      const q = s.saveProject({ name: '已结项事项', archived: true });
      assert.equal(q.state, '推进中', 'state 默认推进中');
      assert.equal(q.workspace, null);
      assert.deepEqual(q.decisions, []);
      assert.deepEqual(s.listProjects().map((x) => x.name), ['v0.6.0 升级']);
      assert.deepEqual(s.listProjects({ includeArchived: true }).map((x) => x.name).sort(), ['v0.6.0 升级', '已结项事项'].sort());
      assert.equal(s.getProject(p.id).progress, '写迁移');
      assert.equal(s.getProject('nope'), null);
      const upd = s.saveProject({ id: p.id, name: 'v0.6.0 升级', state: '待验证', progress: '迁移完成', decisions: ['用 FTS5', '零新依赖', 'JSON 数组化'], nextStep: '跑门禁' });
      assert.equal(upd.state, '待验证');
      assert.deepEqual(upd.decisions, ['用 FTS5', '零新依赖', 'JSON 数组化']);
      assert.deepEqual(upd.rejected, ['Elasticsearch'], '未传字段保持原值');
      assert.equal(upd.workspace, 'D:\\work\\mem0');
      assert.equal(upd.createdAt, p.createdAt);
      assert.throws(() => s.saveProject({ name: '  ' }), /project name required/);
      const del = s.deleteProject(q.id);
      assert.equal(del.name, '已结项事项');
      assert.equal(s.getProject(q.id), null);
      assert.equal(s.deleteProject(q.id), null);
      s.close();
    });

    await t('2d 推进事项', 'deleteProject 解除关联会话 project_id（会话本身保留）', () => {
      const s = freshStore();
      const up = s.upsertConversation({ source: 'claude-code', externalId: 'p1', ingestMethod: 'local', messages: [{ role: 'user', content: '事项关联会话' }] });
      const other = s.upsertConversation({ source: 'codex', externalId: 'p2', ingestMethod: 'local', messages: [{ role: 'user', content: '无关会话' }] });
      const p = s.saveProject({ name: '关联事项' });
      s.db.prepare('UPDATE conversations SET project_id = ? WHERE id = ?').run(p.id, up.id);
      assert.equal(s.db.prepare('SELECT project_id FROM conversations WHERE id = ?').get(up.id).project_id, p.id);
      s.deleteProject(p.id);
      assert.equal(s.db.prepare('SELECT project_id FROM conversations WHERE id = ?').get(up.id).project_id, null);
      assert.equal(s.db.prepare('SELECT project_id FROM conversations WHERE id = ?').get(other.id).project_id, null);
      assert.equal(s.getProject(p.id), null);
      assert.equal(s.getConversation(up.id, { limit: 10 }).messages.length, 1);
      s.close();
    });

    store.close();
  }

  // =====================================================================
  // 2e. H2：工作区自动归属、静默加锁、列表/统计/搜索扩展（SPEC 2.2 第 1-3 点）
  // =====================================================================
  {
    const store = freshStore();
    const up = (externalId, messages, extra = {}) => store.upsertConversation({ source: 'claude-code', externalId, ingestMethod: 'local', messages, ...extra });
    const rowOf = (externalId) => store.db.prepare("SELECT * FROM conversations WHERE source='claude-code' AND external_id=?").get(externalId);
    const msg = (text) => [{ role: 'user', content: text }];

    const winProj = store.saveProject({ name: 'Windows 事项', workspace: 'D:\\Work\\Mem0\\' });

    await t('2e 工作区归属', 'matchProjectByWorkspace：Windows 盘符大小写/反斜杠/尾部斜杠归一化，POSIX 路径相等与子目录命中', () => {
      assert.equal(store.matchProjectByWorkspace('d:/work/mem0').id, winProj.id);
      assert.equal(store.matchProjectByWorkspace('D:\\Work\\Mem0\\source\\desktop').id, winProj.id);
      assert.equal(store.matchProjectByWorkspace('d:/work/mem0-other'), null, '前缀近似但不是子目录');
      const posixProj = store.saveProject({ name: 'POSIX 事项', workspace: '/home/me/app/' });
      assert.equal(store.matchProjectByWorkspace('/home/me/app').id, posixProj.id);
      assert.equal(store.matchProjectByWorkspace('/home/me/app/src/').id, posixProj.id);
      assert.equal(store.matchProjectByWorkspace('/home/me/application'), null);
      assert.equal(store.matchProjectByWorkspace(''), null);
      assert.equal(store.matchProjectByWorkspace(null), null);
    });

    await t('2e 工作区归属', '多个命中取归一化路径最长（最具体）的事项；已归档事项不参与', () => {
      const parent = store.saveProject({ name: '父事项', workspace: '/w/app' });
      const child = store.saveProject({ name: '子事项', workspace: '/w/app/api' });
      assert.equal(store.matchProjectByWorkspace('/w/app/api/handler.js').id, child.id);
      assert.equal(store.matchProjectByWorkspace('/w/app/web').id, parent.id);
      assert.equal(store.matchProjectByWorkspace('/w/app').id, parent.id);
      up('h2-arch', msg('归档工作区里的会话'), { workspace: '/w/old/x' });
      store.saveProject({ name: '已结项事项', workspace: '/w/old', archived: true });
      assert.equal(store.matchProjectByWorkspace('/w/old/x'), null, '归档事项不参与匹配');
      assert.equal(rowOf('h2-arch').project_id, null, '归档事项不自动收编存量会话');
    });

    await t('2e 工作区归属', '入库带 workspace 自动关联；事项后建/改 workspace 时扫描存量未锁定未关联会话', () => {
      up('h2-a', msg('子目录里的会话'), { workspace: 'd:/work/mem0/source/desktop' });
      assert.equal(rowOf('h2-a').project_id, winProj.id);
      up('h2-b', msg('先入库的会话'), { workspace: '/w/late/pkg' });
      assert.equal(rowOf('h2-b').project_id, null);
      const late = store.saveProject({ name: '后建事项', workspace: '/w/late' });
      assert.equal(rowOf('h2-b').project_id, late.id, 'saveProject 应扫描存量会话');
      up('h2-move', msg('待收编会话'), { workspace: '/w/moved/pkg' });
      const movedProj = store.saveProject({ name: '搬迁事项' });
      assert.equal(rowOf('h2-move').project_id, null);
      store.saveProject({ id: movedProj.id, name: '搬迁事项', workspace: '/w/moved' });
      assert.equal(rowOf('h2-move').project_id, movedProj.id, '修改事项 workspace 也应扫描存量会话');
    });

    await t('2e 静默加锁', '改标题置 title_locked，重新 upsert 不覆盖库内标题', () => {
      const conv = up('h2-lock', msg('原始问题'), { workspace: 'd:/work/mem0/x', title: '采集标题' });
      assert.equal(rowOf('h2-lock').project_id, winProj.id);
      store.updateConversationMeta(conv.id, { title: '手动标题' });
      assert.equal(rowOf('h2-lock').title_locked, 1);
      up('h2-lock', [...msg('原始问题'), { role: 'assistant', content: 'AI 回答' }], { workspace: 'd:/work/mem0/x', title: '采集器重新推算的标题' });
      assert.equal(rowOf('h2-lock').title, '手动标题');
    });

    await t('2e 静默加锁', '改事项（含置 null）置 project_locked，重新 upsert 不被工作区自动覆盖', () => {
      const conv = rowOf('h2-lock');
      store.updateConversationMeta(conv.id, { projectId: null });
      assert.equal(rowOf('h2-lock').project_locked, 1);
      assert.equal(rowOf('h2-lock').project_id, null);
      up('h2-lock', [...msg('原始问题'), { role: 'assistant', content: 'AI 回答' }, { role: 'user', content: '继续追问' }], { workspace: 'd:/work/mem0/x' });
      assert.equal(rowOf('h2-lock').project_id, null, '锁定后不得被工作区自动覆盖');
      // 锁定的项目不被其它路径影响；未锁定会话仍可正常归属
      assert.equal(store.matchProjectByWorkspace('d:/work/mem0/x').id, winProj.id);
    });

    await t('2e original_title', '首次插入记录 deriveTitle，后续改标题/重新 upsert 均不变；显式传入截断 300', () => {
      const conv = up('h2-orig', msg('首条用户提问用来做原始标题'), { title: '采集标题' });
      assert.equal(rowOf('h2-orig').original_title, '首条用户提问用来做原始标题');
      up('h2-orig', [...msg('首条用户提问用来做原始标题'), { role: 'assistant', content: 'AI 回答' }], { title: '第二次标题' });
      assert.equal(rowOf('h2-orig').original_title, '首条用户提问用来做原始标题');
      store.updateConversationMeta(conv.id, { title: '第三次手动标题' });
      assert.equal(rowOf('h2-orig').title, '第三次手动标题');
      assert.equal(rowOf('h2-orig').original_title, '首条用户提问用来做原始标题');
      up('h2-orig-long', msg('问题'), { originalTitle: '长'.repeat(400) });
      assert.equal(rowOf('h2-orig-long').original_title.length, 300);
    });

    await t('2e stripped_blocks', '取 max：重新采集到更小统计不覆盖已有更大值', () => {
      up('h2-strip', msg('剥离统计'), { strippedBlocks: 7 });
      assert.equal(rowOf('h2-strip').stripped_blocks, 7);
      up('h2-strip', [...msg('剥离统计'), { role: 'assistant', content: '答' }], { strippedBlocks: 3 });
      assert.equal(rowOf('h2-strip').stripped_blocks, 7);
      up('h2-strip', [...msg('剥离统计'), { role: 'assistant', content: '答' }], { strippedBlocks: 9 });
      assert.equal(rowOf('h2-strip').stripped_blocks, 9);
    });

    const listProj = store.saveProject({ name: '列表事项', workspace: '/w/list' });
    const c1 = up('h2-list-1', [{ role: 'user', content: '列表问题一\n第二行' }, { role: 'assistant', content: '回答' }], { workspace: '/w/list/a' });
    const c2 = up('h2-list-2', msg('列表问题二'), { workspace: '/w/list/b' });
    up('h2-list-3', msg('无关会话'), { workspace: '/w/other' });

    await t('2e list', 'projectId 过滤 + 返回全部字段（含 first_prompt 单行预览）', () => {
      const rows = store.listConversations({ projectId: listProj.id, limit: 100 });
      assert.deepEqual(rows.map((r) => r.id).sort(), [c1.id, c2.id].sort());
      const fields = ['id', 'source', 'title', 'original_title', 'url', 'workspace', 'created_at', 'updated_at', 'message_count',
        'ingest_method', 'project_id', 'summary', 'decisions_json', 'next_step', 'stripped_blocks', 'first_prompt'];
      for (const k of fields) assert.ok(k in rows[0], `缺少字段 ${k}`);
      const r1 = rows.find((r) => r.id === c1.id);
      assert.equal(r1.project_id, listProj.id);
      assert.equal(r1.first_prompt, '列表问题一 第二行');
      assert.ok(!r1.first_prompt.includes('\n'), 'first_prompt 应为单行预览');
      assert.equal(rows.find((r) => r.id === c2.id).first_prompt, '列表问题二');
    });

    await t('2e meta', 'updateConversationMeta 支持 summary/decisions/nextStep 并返回最新行；关联事项时刷新 updated_at', () => {
      const before = store.getProject(listProj.id).updatedAt;
      const meta = store.updateConversationMeta(c1.id, { projectId: listProj.id, summary: '一句话摘要', decisions: ['结论一', '结论二'], nextStep: '下一步做缓存压测' });
      assert.equal(meta.id, c1.id);
      assert.equal(meta.summary, '一句话摘要');
      assert.deepEqual(meta.decisions, ['结论一', '结论二']);
      assert.equal(meta.next_step, '下一步做缓存压测');
      assert.ok(store.getProject(listProj.id).updatedAt >= before);
      assert.equal(store.updateConversationMeta('nope', { title: 'x' }), null);
    });

    await t('2e stats', '原字段保留，新增 strippedBlocksTotal / strippedBlocksWeek', () => {
      const st = store.stats();
      for (const k of ['total', 'messages', 'today', 'todayMessages', 'bySource', 'messagesBySource', 'todayBySource']) assert.ok(k in st, `缺少原字段 ${k}`);
      const sumAll = store.db.prepare('SELECT COALESCE(SUM(stripped_blocks), 0) AS n FROM conversations').get().n;
      const sumWeek = store.db.prepare('SELECT COALESCE(SUM(stripped_blocks), 0) AS n FROM conversations WHERE updated_at >= ?')
        .get(Date.now() - 7 * 86400_000).n;
      assert.equal(st.strippedBlocksTotal, sumAll);
      assert.equal(st.strippedBlocksWeek, sumWeek);
      assert.ok(st.strippedBlocksTotal >= 9);
      assert.ok(st.strippedBlocksWeek > 0);
      assert.equal(st.total, store.db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n);
    });

    await t('2e search', '标题/摘要/拍板/下一步/事项名命中（正文不命中）也返回，hits 为空且结构不变', () => {
      const sp = store.saveProject({ name: '缓存雪崩专项', workspace: '/w/cache' });
      const s1 = up('h2-search-1', msg('完全无关的正文内容'), { title: '缓存雪崩复盘' });
      const s2 = up('h2-search-2', msg('另一段无关正文'));
      store.updateConversationMeta(s2.id, { summary: '缓存雪崩与限流摘要' });
      const s3 = up('h2-search-3', msg('第三段无关正文'));
      store.db.prepare('UPDATE conversations SET project_id = ? WHERE id = ?').run(sp.id, s3.id);
      const s4 = up('h2-search-4', msg('第四段无关正文'));
      store.updateConversationMeta(s4.id, { decisions: ['决定采用本地缓存'], nextStep: '补齐缓存压测' });

      const res = store.search('缓存雪崩');
      const ids = res.map((r) => r.conversationId);
      for (const id of [s1.id, s2.id, s3.id]) assert.ok(ids.includes(id), `应命中 ${id}`);
      for (const r of res) {
        assert.deepEqual(Object.keys(r).sort(), ['conversationId', 'hits', 'source', 'title', 'updatedAt', 'url']);
        if ([s1.id, s2.id, s3.id].includes(r.conversationId)) assert.deepEqual(r.hits, []);
      }
      assert.ok(store.search('本地缓存').some((r) => r.conversationId === s4.id), '拍板结论命中');
      assert.ok(store.search('缓存压测').some((r) => r.conversationId === s4.id), '下一步命中');
      assert.equal(store.search('缓存雪崩', { limit: 1 }).length, 1);

      // 正文命中时结构、hits 行为保持不变
      const body = store.search('无关的正文');
      assert.ok(body.length >= 1);
      assert.deepEqual(Object.keys(body[0]).sort(), ['conversationId', 'hits', 'source', 'title', 'updatedAt', 'url']);
      assert.ok(body[0].hits.length > 0);
    });

    store.close();
  }

  // =====================================================================
  // 2f. H3：记忆包导出/导入（SPEC 2.2 第 4 点）
  // =====================================================================
  {
    const PACK_VERSION = 'mem0-memory-pack-v1';
    const buildSource = () => {
      const s = freshStore();
      const m1 = s.saveMemory({ group: '个人与职业背景', title: '背景卡', body: '十年后端', tags: ['画像'], sourceIds: ['c1'] });
      const m2 = s.saveMemory({ group: '踩坑与经验库', title: 'Zstd 多帧坑', body: '只读到第一帧', tags: ['采集', 'Zstd'] });
      const p1 = s.saveProject({ name: 'v0.6.0 升级', state: '推进中', workspace: 'D:\\work\\mem0', progress: '写迁移', decisions: ['用 FTS5'], rejected: ['Elasticsearch'], nextStep: '补测试' });
      const p2 = s.saveProject({ name: '已结项事项', state: '已完成', archived: true, progress: 'done' });
      return { s, m1, m2, p1, p2 };
    };

    await t('2f 记忆包', 'exportMemoryPack：版本/ISO 时间，memories 与 projects 均为 JS 数组', () => {
      const { s } = buildSource();
      const pack = s.exportMemoryPack();
      assert.equal(pack.version, PACK_VERSION);
      assert.ok(typeof pack.exportedAt === 'string' && !Number.isNaN(Date.parse(pack.exportedAt)), 'exportedAt 应为 ISO 时间');
      assert.ok(Array.isArray(pack.memories));
      assert.ok(Array.isArray(pack.projects));
      assert.deepEqual(pack.memories, s.listMemories());
      assert.deepEqual(pack.projects, s.listProjects({ includeArchived: true }));
      const round = JSON.parse(JSON.stringify(pack));
      assert.ok(Array.isArray(round.memories) && Array.isArray(round.projects), 'JSON 往返后仍为数组');
      s.close();
    });

    await t('2f 记忆包', '导出→新库导入一致：卡片 / 事项（含归档）/ 时间戳全部保留', () => {
      const { s: src } = buildSource();
      const pack = src.exportMemoryPack();
      const dst = freshStore();
      const res = dst.importMemoryPack(pack);
      assert.deepEqual(dst.listMemories(), src.listMemories());
      assert.deepEqual(dst.listProjects({ includeArchived: true }), src.listProjects({ includeArchived: true }));
      assert.equal(res.importedMemories, pack.memories.length);
      assert.equal(res.importedProjects, pack.projects.length);
      src.close(); dst.close();
    });

    await t('2f 记忆包', '重复导入幂等：行数不增加、内容不变、计数为 0', () => {
      const { s: src } = buildSource();
      const pack = src.exportMemoryPack();
      const dst = freshStore();
      const first = dst.importMemoryPack(pack);
      assert.ok(first.importedMemories > 0 && first.importedProjects > 0);
      const memRows = dst.db.prepare('SELECT COUNT(*) n FROM memories').get().n;
      const projRows = dst.db.prepare('SELECT COUNT(*) n FROM projects').get().n;
      const memSnap = dst.listMemories();
      const projSnap = dst.listProjects({ includeArchived: true });
      const second = dst.importMemoryPack(pack);
      assert.deepEqual(second, { importedMemories: 0, importedProjects: 0 });
      assert.equal(dst.db.prepare('SELECT COUNT(*) n FROM memories').get().n, memRows);
      assert.equal(dst.db.prepare('SELECT COUNT(*) n FROM projects').get().n, projRows);
      assert.deepEqual(dst.listMemories(), memSnap);
      assert.deepEqual(dst.listProjects({ includeArchived: true }), projSnap);
      src.close(); dst.close();
    });

    await t('2f 记忆包', '项目合并：按 id 再按同名匹配，decisions/rejected 去重，非更新不覆盖字段', () => {
      const dst = freshStore();
      const local = dst.saveProject({
        id: 'p-merge', name: '订单服务改造', state: '推进中', workspace: '/old', progress: '旧进展',
        decisions: ['a', 'b'], rejected: ['x'], nextStep: '旧下一步',
      });
      const older = local.updatedAt - 10000;
      const res = dst.importMemoryPack({
        version: PACK_VERSION,
        projects: [
          { id: 'p-merge', name: '订单服务改造', state: '待验证', workspace: '/new', progress: '新进展', nextStep: '新下一步', decisions: ['b', 'c'], rejected: ['x', 'y'], archived: false, updatedAt: older },
          { id: 'p-different', name: '订单服务改造', state: '已完成', progress: '同名匹配不新建', decisions: ['z'], rejected: [], archived: true, updatedAt: older },
          { id: 'p-different-2', name: '订单服务改造', state: '已完成', progress: '同名匹配不新建', decisions: ['z'], rejected: [], archived: true, updatedAt: older },
        ],
        memories: [],
      });
      assert.equal(dst.db.prepare('SELECT COUNT(*) n FROM projects').get().n, 1, '同名事项应合并而非新建');
      const merged = dst.getProject('p-merge');
      assert.deepEqual(merged.decisions, ['a', 'b', 'c', 'z']);
      assert.deepEqual(merged.rejected, ['x', 'y']);
      assert.equal(merged.state, '推进中', '导入项更旧时非空字段不覆盖');
      assert.equal(merged.workspace, '/old');
      assert.equal(merged.progress, '旧进展');
      assert.equal(merged.nextStep, '旧下一步');
      assert.equal(merged.archived, false);
      assert.equal(res.importedProjects, 2, '仅前两条产生合并写库');
      dst.close();
    });

    await t('2f 记忆包', '项目更新：导入项 updatedAt 更新时覆盖非空 state/progress/next/workspace/archived', () => {
      const dst = freshStore();
      const local = dst.saveProject({
        id: 'p-up', name: '升级事项', state: '推进中', workspace: '/old', progress: '旧进展',
        decisions: ['keep'], rejected: ['rkeep'], nextStep: '旧下一步',
      });
      const newer = local.updatedAt + 5000;
      const first = dst.importMemoryPack({
        version: PACK_VERSION,
        projects: [{ id: 'p-up', name: '升级事项（改名）', state: '待验证', workspace: '/new', progress: '新进展', nextStep: '新下一步', decisions: ['keep', 'add'], rejected: ['rkeep', 'radd'], archived: true, updatedAt: newer }],
        memories: [],
      });
      const p = dst.getProject('p-up');
      assert.equal(p.name, '升级事项（改名）');
      assert.equal(p.state, '待验证');
      assert.equal(p.workspace, '/new');
      assert.equal(p.progress, '新进展');
      assert.equal(p.nextStep, '新下一步');
      assert.equal(p.archived, true);
      assert.deepEqual(p.decisions, ['keep', 'add']);
      assert.deepEqual(p.rejected, ['rkeep', 'radd']);
      assert.equal(first.importedProjects, 1);
      // 再次导入更新但字段留空：非空字段不被空值清掉，archived 按布尔覆盖
      dst.importMemoryPack({
        version: PACK_VERSION,
        projects: [{ id: 'p-up', name: '升级事项（改名）', state: '', workspace: '', progress: '', nextStep: '', decisions: [], rejected: [], archived: false, updatedAt: newer + 5000 }],
        memories: [],
      });
      const p2 = dst.getProject('p-up');
      assert.equal(p2.state, '待验证', '空 state 不清空');
      assert.equal(p2.workspace, '/new', '空 workspace 不清空');
      assert.equal(p2.progress, '新进展');
      assert.equal(p2.nextStep, '新下一步');
      assert.equal(p2.archived, false, 'archived 为布尔，更新时覆盖');
      dst.close();
    });

    await t('2f 记忆包', '记忆卡：id / group+title 匹配，新卡插分组末尾，更新时原 body 记入 superseded', () => {
      const dst = freshStore();
      const byId = dst.saveMemory({ id: 'mem-id', group: '踩坑与经验库', title: '旧卡', body: '旧正文', tags: ['t1'] });
      dst.saveMemory({ group: '踩坑与经验库', title: '同名卡', body: '同名旧正文', tags: ['t2'] });
      dst.saveMemory({ group: '个人与职业背景', title: '背景卡', body: '背景正文' });
      const base = Date.now() + 100000;
      const res = dst.importMemoryPack({
        version: PACK_VERSION,
        memories: [
          { id: 'mem-id', group: '踩坑与经验库', title: '旧卡', body: '新正文', tags: ['t1', 't9'], updatedAt: base },
          { id: 'other-id', group: '踩坑与经验库', title: '同名卡', body: '同名新正文', tags: ['t3'], updatedAt: base },
          { group: '踩坑与经验库', title: '新卡A', body: 'A', tags: [], updatedAt: base },
          { group: '踩坑与经验库', title: '新卡B', body: 'B', tags: [], updatedAt: base },
        ],
        projects: [],
      });
      const byTitle = (x) => dst.listMemories().find((m) => m.title === x);
      assert.equal(byTitle('旧卡').id, byId.id, '按 id 命中应更新原卡而非新建');
      assert.equal(byTitle('旧卡').body, '新正文');
      assert.equal(byTitle('旧卡').superseded, '旧正文');
      assert.deepEqual(byTitle('旧卡').tags, ['t1', 't9']);
      assert.equal(byTitle('同名卡').body, '同名新正文');
      assert.equal(byTitle('同名卡').superseded, '同名旧正文');
      assert.deepEqual(dst.listMemories({ group: '踩坑与经验库' }).map((m) => m.title), ['旧卡', '同名卡', '新卡A', '新卡B'], '新卡插分组末尾');
      assert.deepEqual(dst.listMemories({ group: '个人与职业背景' }).map((m) => m.title), ['背景卡'], '未导入分组保持原样');
      assert.equal(res.importedMemories, 4);
      // 导入项更旧：不覆盖
      dst.importMemoryPack({ version: PACK_VERSION, memories: [{ id: 'mem-id', group: '踩坑与经验库', title: '旧卡', body: '过期正文', tags: ['stale'], updatedAt: 1 }], projects: [] });
      assert.equal(byTitle('旧卡').body, '新正文');
      assert.equal(byTitle('旧卡').superseded, '旧正文');
      // 导入项更新但 body 相同：不更新、不重写 superseded
      const same = dst.importMemoryPack({ version: PACK_VERSION, memories: [{ id: 'mem-id', group: '踩坑与经验库', title: '旧卡', body: '新正文', tags: ['changed'], updatedAt: base + 5000 }], projects: [] });
      assert.equal(same.importedMemories, 0, 'body 相同不更新');
      assert.deepEqual(byTitle('旧卡').tags, ['t1', 't9']);
      assert.equal(byTitle('旧卡').superseded, '旧正文');
      dst.close();
    });

    await t('2f 记忆包', '非法版本/结构抛明确错误；非法分组与非法条目一律跳过', () => {
      const dst = freshStore();
      for (const bad of [null, undefined, {}, { version: 'mem0-memory-pack-v2' }, { version: 'x' }]) {
        assert.throws(() => dst.importMemoryPack(bad), /mem0-memory-pack-v1/);
      }
      const existing = dst.saveMemory({ group: '协作与沟通准则', title: '已存在卡', body: '原正文' });
      const res = dst.importMemoryPack({
        version: PACK_VERSION,
        memories: [
          { id: existing.id, group: '非法分组', title: '已存在卡', body: '非法分组不应更新', updatedAt: existing.updatedAt + 99999 },
          { group: '非法分组', title: '不应入库', body: 'x' },
          { group: '个人与职业背景', title: '应入库', body: 'y' },
          { group: '踩坑与经验库', title: '   ', body: '空标题跳过' },
          null, 'x',
        ],
        projects: [null, { name: '  ' }],
      });
      assert.equal(dst.getMemory(existing.id).body, '原正文', '非法分组即使 id 命中也不更新');
      assert.deepEqual(dst.listMemories().map((m) => m.title).sort(), ['已存在卡', '应入库'].sort());
      assert.deepEqual(dst.listProjects({ includeArchived: true }), []);
      assert.equal(res.importedMemories, 1);
      assert.equal(res.importedProjects, 0);
      dst.close();
    });
  }

  // =====================================================================
  // 2g. I1 AI organizer 基础：预设 / URL / 网络 / 密钥 / 脱敏 / 截断（SPEC 3.1-3.4）
  // =====================================================================
  {
    const {
      AI_PRESETS, AI_KEY_KV, resolveChatCompletionsUrl, redactSecretsForLLM,
      prepareTranscriptForLLM, AiOrganizer,
    } = require(path.join(ROOT, 'src/main/ai-organizer'));

    await t('2g AI 预设', '4 个内置预设与 SPEC 3.1 完全一致', () => {
      assert.deepEqual(AI_PRESETS, [
        { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', needKey: true },
        { id: 'gemini', label: 'Gemini Flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash', needKey: true },
        { id: 'openai', label: 'OpenAI 兼容 / 中转', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', needKey: true },
        { id: 'ollama', label: '本地 Ollama（免 Key）', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', needKey: false },
      ]);
    });

    await t('2g URL', 'resolveChatCompletionsUrl：裸 origin 补 /v1，已有路径补 /chat/completions，已完整不重复', () => {
      const cases = [
        ['https://api.deepseek.com', 'https://api.deepseek.com/v1/chat/completions'],
        [' https://api.deepseek.com/ ', 'https://api.deepseek.com/v1/chat/completions'],
        ['https://api.deepseek.com/v1/', 'https://api.deepseek.com/v1/chat/completions'],
        ['https://generativelanguage.googleapis.com/v1beta/openai', 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'],
        ['https://api.openai.com/v1/chat/completions', 'https://api.openai.com/v1/chat/completions'],
        ['https://api.openai.com/v1/chat/completions/', 'https://api.openai.com/v1/chat/completions'],
        ['http://127.0.0.1:11434', 'http://127.0.0.1:11434/v1/chat/completions'],
        ['http://127.0.0.1:11434/v1', 'http://127.0.0.1:11434/v1/chat/completions'],
        ['', ''],
      ];
      for (const [input, expected] of cases) assert.equal(resolveChatCompletionsUrl(input), expected, input);
    });

    await t('2g 脱敏', 'redactSecretsForLLM 覆盖 sk-/AIza/ghp_/github_pat_/AKIA/xox/Bearer/私钥块且幂等', () => {
      const privateKey = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0123456789\n-----END RSA PRIVATE KEY-----';
      const raw = [
        'key sk-abcdefghijklmnop1234 end',
        'google AIzaSyA1234567890abcdefghijklmnopqrstu end',
        'github ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 end',
        'fine github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 end',
        'aws AKIAIOSFODNN7EXAMPLE end',
        // 运行时拼接，避免假令牌字面量触发 GitHub 推送保护
        `slack ${['xoxb', '123456789012', 'abcdefghijklmnop'].join('-')} end`,
        'auth Bearer abcdefghijklmnopqrstuvwxyz.0123456789 end',
        privateKey,
        '普通正文保持不变',
      ].join('\n');
      const out = redactSecretsForLLM(raw);
      assert.match(out, /\[REDACTED_KEY\]/);
      assert.match(out, /\[REDACTED_TOKEN\]/);
      assert.match(out, /\[REDACTED_PRIVATE_KEY\]/);
      for (const secret of ['sk-abcdefghijklmnop1234', 'AIzaSyA1234567890abcdefghijklmnopqrstu', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 'github_pat_11ABCDEFG0123456789_', 'AKIAIOSFODNN7EXAMPLE', 'xoxb-123456789012', 'Bearer abcdefghijklmnopqrstuvwxyz']) {
        assert.ok(!out.includes(secret), `未脱敏: ${secret}`);
      }
      assert.match(out, /普通正文保持不变/);
      assert.equal(redactSecretsForLLM(out), out, '脱敏应幂等');
    });

    await t('2g 脱敏', '本地 messages 原文不因脱敏/截断而改变', () => {
      const store = freshStore();
      const raw = '我的 Key 是 sk-abcdefghijklmnop1234，请勿外传。';
      const { id } = store.upsertConversation({
        source: 'claude-code',
        externalId: 'ai-redact-1',
        ingestMethod: 'local',
        messages: [
          { role: 'user', content: raw },
          { role: 'assistant', content: '收到，已记录。' },
        ],
      });
      const rows = () => msgs(store, id).map((m) => `${m.role}:${m.content}`);
      const before = rows();
      const out = prepareTranscriptForLLM(msgs(store, id).map((m) => ({ role: m.role, content: m.content })));
      assert.match(out, /\[REDACTED_KEY\]/);
      assert.ok(!out.includes('sk-abcdefghijklmnop1234'));
      assert.deepEqual(rows(), before);
      assert.equal(store.db.prepare('SELECT content FROM messages WHERE conversation_id = ? ORDER BY seq LIMIT 1').get(id).content, raw);
      store.close();
    });

    await t('2g 截断', 'prepareTranscriptForLLM：12000 边界原样/截断，4500 头 + 提示 + 7000 尾且严格 <= maxChars', () => {
      const prefix = '[用户] ';
      const exactContent = 'x'.repeat(12000 - prefix.length);
      const exact = prepareTranscriptForLLM([{ role: 'user', content: exactContent }]);
      assert.equal(exact.length, 12000);
      assert.doesNotMatch(exact, /中间省略/);

      const longContent = '头'.repeat(4500) + '中'.repeat(20000) + '尾'.repeat(7000);
      const out = prepareTranscriptForLLM([{ role: 'user', content: longContent }]);
      assert.ok(out.length <= 12000, `实际 ${out.length}`);
      const fullText = prefix + longContent;
      assert.ok(out.startsWith(fullText.slice(0, 4500)));
      assert.ok(out.endsWith('尾'.repeat(7000)));
      assert.match(out, /中间省略 \d+ 字/);
      assert.ok(out.length < exact.length);

      const overContent = 'x'.repeat(12000 - prefix.length + 1);
      const over = prepareTranscriptForLLM([{ role: 'user', content: overContent }]);
      assert.ok(over.length <= 12000);
      assert.match(over, /中间省略 501 字/);

      const tiny = prepareTranscriptForLLM([{ role: 'user', content: 'y'.repeat(5000) }], 1000);
      assert.ok(tiny.length <= 1000);
      assert.ok(tiny.startsWith(prefix));
    });

    await t('2g 密钥', 'apiKey 落盘不是明文（纯 Node 用 b64:），getPublicState 无 apiKey 且 keyHint 掩码', () => {
      const store = freshStore();
      const key = 'sk-1234567890abcdef';
      const org = new AiOrganizer({ store });
      const state = org.saveConfig({ provider: 'deepseek', enabled: true, apiKey: key });
      for (const row of store.db.prepare('SELECT k, v FROM kv').all()) {
        assert.ok(!String(row.v).includes(key), `${row.k} 不得明文保存 Key`);
      }
      assert.match(store.getKv(AI_KEY_KV), /^b64:/);
      assert.ok(!('apiKey' in state));
      assert.ok(!JSON.stringify(state).includes(key));
      assert.equal(state.hasKey, true);
      assert.match(state.keyHint, /••••/);
      assert.ok(!state.keyHint.includes(key));
      assert.ok(state.keyHint.endsWith('cdef'));

      const org2 = new AiOrganizer({ store });
      assert.equal(org2.getPublicState().hasKey, true);
      assert.equal(org2.getApiKey(), key);
      store.close();
    });

    await t('2g 密钥', 'safeStorage 可用时以 enc: 加密落盘，读取解密且公开状态不含明文', () => {
      const store = freshStore();
      const electron = {
        safeStorage: {
          isEncryptionAvailable: () => true,
          encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'),
          decryptString: (b) => Buffer.from(b).toString('utf8').replace(/^enc:/, ''),
        },
      };
      const key = 'sk-encrypted-987654';
      const org = new AiOrganizer({ store, electron });
      org.saveConfig({ apiKey: key, enabled: true });
      assert.match(store.getKv(AI_KEY_KV), /^enc:/);
      assert.equal(org.getApiKey(), key);
      assert.equal(org.getPublicState().hasKey, true);
      assert.ok(!JSON.stringify(org.getPublicState()).includes(key));
      store.close();
    });

    await t('2g 状态', 'getPublicState 字段与 SPEC 3.3 一致，默认 deepseek/未配置，配置可跨实例恢复', () => {
      const store = freshStore();
      const org = new AiOrganizer({ store });
      const s = org.getPublicState();
      assert.deepEqual(Object.keys(s), [
        'enabled', 'provider', 'baseUrl', 'model', 'hasKey', 'keyHint',
        'statusText', 'statusOk', 'unorganizedCount', 'organizing',
      ]);
      assert.equal(s.enabled, false);
      assert.equal(s.provider, 'deepseek');
      assert.equal(s.baseUrl, 'https://api.deepseek.com/v1');
      assert.equal(s.model, 'deepseek-chat');
      assert.equal(s.hasKey, false);
      assert.equal(s.keyHint, '');
      assert.equal(s.statusText, '未配置');
      assert.equal(s.statusOk, false);
      assert.equal(s.unorganizedCount, 0);
      assert.equal(s.organizing, false);

      const key = 'AIzaSyA1234567890abcdefghijklmnopqrstu';
      org.saveConfig({ enabled: true, provider: 'gemini', apiKey: key });
      assert.equal(org.getPublicState().provider, 'gemini');
      assert.equal(org.getPublicState().baseUrl, 'https://generativelanguage.googleapis.com/v1beta/openai');
      assert.equal(org.getPublicState().model, 'gemini-2.5-flash');
      assert.equal(org.getPublicState().statusText, '已就绪');

      const org2 = new AiOrganizer({ store });
      assert.equal(org2.getPublicState().provider, 'gemini');
      assert.equal(org2.getPublicState().hasKey, true);
      assert.equal(org2.getApiKey(), key);
      store.close();
    });

    const seen = [];
    const mock = await new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(body); } catch { parsed = null; }
          seen.push({ method: req.method, url: req.url, headers: req.headers, body: parsed });
          const headers = { 'Content-Type': 'application/json', Connection: 'close' };
          if (req.headers.authorization === 'Bearer bad-key-123456') {
            res.writeHead(401, headers);
            res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
            return;
          }
          res.writeHead(200, headers);
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] }));
        });
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
    const mockBase = `http://127.0.0.1:${mock.port}/v1`;

    await t('2g 网络', 'testConfig 本地 Mock 成功：ok/latencyMs、Bearer 头、Content-Type 与 POST 路径正确', async () => {
      const store = freshStore();
      const org = new AiOrganizer({ store });
      const r = await org.testConfig({ provider: 'openai', baseUrl: mockBase, model: 'mock-model', apiKey: 'good-key-123456', enabled: true });
      assert.equal(r.ok, true);
      assert.equal(r.error, undefined);
      assert.ok(Number.isFinite(r.latencyMs) && r.latencyMs >= 0);
      const req = seen[seen.length - 1];
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/v1/chat/completions');
      assert.equal(req.headers.authorization, 'Bearer good-key-123456');
      assert.match(req.headers['content-type'], /^application\/json/);
      assert.equal(req.body.model, 'mock-model');
      assert.ok(Array.isArray(req.body.messages) && req.body.messages.length === 1);
      assert.equal(org.getPublicState().statusOk, true);
      assert.match(org.getPublicState().statusText, /^连接正常 · \d+ms$/);
      store.close();
    });

    await t('2g 网络', 'testConfig 对 Mock 401 返回 ok=false、error 含 401，状态置错', async () => {
      const store = freshStore();
      const org = new AiOrganizer({ store });
      const r = await org.testConfig({ provider: 'openai', baseUrl: mockBase, model: 'm', apiKey: 'bad-key-123456', enabled: true });
      assert.equal(r.ok, false);
      assert.match(r.error, /401/);
      assert.ok(Number.isFinite(r.latencyMs) && r.latencyMs >= 0);
      assert.equal(org.getPublicState().statusOk, false);
      assert.match(org.getPublicState().statusText, /401/);
      assert.equal(org.getPublicState().hasKey, true);
      store.close();
    });

    await t('2g 密钥', '掩码/空 Key 自动复用旧 Key，clearKey 清空且请求不再带 Authorization', async () => {
      const store = freshStore();
      const org = new AiOrganizer({ store });
      org.saveConfig({ provider: 'openai', baseUrl: mockBase, model: 'm', apiKey: 'reuse-key-123456', enabled: true });
      await org.testConfig({ apiKey: 'sk-••••3456' });
      assert.equal(seen[seen.length - 1].headers.authorization, 'Bearer reuse-key-123456');
      await org.testConfig({ apiKey: '' });
      assert.equal(seen[seen.length - 1].headers.authorization, 'Bearer reuse-key-123456');
      await org.testConfig({});
      assert.equal(seen[seen.length - 1].headers.authorization, 'Bearer reuse-key-123456');

      const cleared = org.saveConfig({ clearKey: true });
      assert.equal(cleared.hasKey, false);
      assert.equal(cleared.keyHint, '');
      await org.testConfig({});
      assert.equal(seen[seen.length - 1].headers.authorization, undefined);
      store.close();
    });

    await t('2g 网络', '回环走 globalThis.fetch（忽略 electron.net.fetch）；公网优先 electron.net.fetch；fetchImpl 最高优先', async () => {
      const store1 = freshStore();
      const throwingElectron = { net: { fetch: async () => { throw new Error('不应使用 electron.net.fetch'); } } };
      const org = new AiOrganizer({ store: store1, electron: throwingElectron });
      org.saveConfig({ provider: 'openai', baseUrl: mockBase, model: 'm', apiKey: 'loop-key-123456' });
      assert.equal(await org.callChat([{ role: 'user', content: 'ping' }]), 'OK');

      const store2 = freshStore();
      let netUrl = '';
      const electron = {
        net: {
          fetch: async (url) => {
            netUrl = url;
            return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'NET' } }] }) };
          },
        },
      };
      const publicOrg = new AiOrganizer({ store: store2, electron });
      publicOrg.saveConfig({ provider: 'openai', baseUrl: 'https://example.com/v1', model: 'm' });
      assert.equal(await publicOrg.callChat([{ role: 'user', content: 'ping' }]), 'NET');
      assert.equal(netUrl, 'https://example.com/v1/chat/completions');

      const store3 = freshStore();
      let injected = 0;
      const injectedOrg = new AiOrganizer({
        store: store3,
        electron,
        fetchImpl: async () => {
          injected++;
          return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'STUB' } }] }) };
        },
      });
      injectedOrg.saveConfig({ provider: 'openai', baseUrl: mockBase, model: 'm' });
      assert.equal(await injectedOrg.callChat([{ role: 'user', content: 'ping' }]), 'STUB');
      assert.equal(injected, 1);

      store1.close();
      store2.close();
      store3.close();
    });

    await new Promise((resolve) => {
      mock.server.close(resolve);
      if (typeof mock.server.closeAllConnections === 'function') mock.server.closeAllConnections();
    });
  }

  // =====================================================================
  // 2h. I2 AI 自动整理：双水位线 / 空闲防抖 / 写入红线 / 粘贴拆卡（SPEC 3.5-3.6）
  // =====================================================================
  {
    const {
      AiOrganizer, AI_ENABLE_WATERMARK_KV, NEW_PROJECT_TARGET,
      parseOrganizerJson, splitPastedTextToDrafts,
    } = require(path.join(ROOT, 'src/main/ai-organizer'));

    const aiReply = (over = {}) => ({
      shortTitle: '自动标题',
      summary: '自动摘要',
      decisions: ['自动结论'],
      nextStep: '自动下一步',
      projectMatch: { action: 'none' },
      pitfallCard: null,
      ...over,
    });

    const requests = [];
    let responder = () => aiReply();
    const mockServer = await new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(body); } catch { parsed = null; }
          const item = { method: req.method, url: req.url, headers: req.headers, body: parsed, raw: body };
          requests.push(item);
          let out;
          try { out = responder(parsed, item); } catch (e) { out = { __status: 500, __error: e.message }; }
          const headers = { 'Content-Type': 'application/json', Connection: 'close' };
          if (out && out.__status) {
            res.writeHead(out.__status, headers);
            res.end(JSON.stringify({ error: { message: out.__error || 'mock error' } }));
            return;
          }
          const content = typeof out === 'string' ? out : JSON.stringify(out);
          res.writeHead(200, headers);
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
        });
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => resolve(server));
    });
    const mockBase = `http://127.0.0.1:${mockServer.address().port}/v1`;
    const makeOrg = (store, opts = {}) => new AiOrganizer({ store, idleMs: 100, checkIntervalMs: 10, ...opts });
    const enable = (org) => org.saveConfig({
      enabled: true, provider: 'openai', baseUrl: mockBase, model: 'mock-model', apiKey: 'test-key-1234567890',
    });
    const addConv = (store, externalId, contents, updatedAt) => store.upsertConversation({
      source: 'claude-code',
      externalId,
      ingestMethod: 'local',
      createdAt: updatedAt - 1000,
      updatedAt,
      messages: contents.map((content, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content })),
    });
    const waitFor = async (fn, timeout = 2000) => {
      const started = Date.now();
      while (!fn()) {
        if (Date.now() - started > timeout) throw new Error('等待超时');
        await sleep(10);
      }
    };

    await t('2h 拆卡', 'splitPastedTextToDrafts：空行/标题/列表项确定性切分，target 只允许合法值', () => {
      const paragraphs = splitPastedTextToDrafts('第一段内容。\n\n第二段内容。', '协作与沟通准则');
      assert.equal(paragraphs.length, 2);
      assert.deepEqual(paragraphs.map((x) => x.title), ['第一段内容', '第二段内容']);
      assert.deepEqual(paragraphs.map((x) => x.body), ['第一段内容。', '第二段内容。']);

      const headings = splitPastedTextToDrafts('## 标题一\n正文一\n\n## 标题二\n正文二', '环境与工作流');
      assert.deepEqual(headings.map((x) => x.title), ['标题一', '标题二']);
      assert.deepEqual(headings.map((x) => x.body), ['正文一', '正文二']);

      const list = splitPastedTextToDrafts('- 要点一：内容一\n- 要点二：内容二', '踩坑与经验库');
      assert.deepEqual(list.map((x) => x.title), ['要点一', '要点二']);
      assert.deepEqual(list.map((x) => x.body), ['内容一', '内容二']);

      const project = splitPastedTextToDrafts('一段笔记', '__new_project__');
      assert.equal(project[0].target, NEW_PROJECT_TARGET);
      for (const d of [...paragraphs, ...headings, ...list, ...project]) {
        assert.ok(MEMORY_GROUPS.includes(d.target) || d.target === NEW_PROJECT_TARGET, d.target);
      }
      assert.deepEqual(splitPastedTextToDrafts('   \n\n  ', '环境与工作流'), []);
    });

    await t('2h 拆卡', 'splitImportWithAI：未启用/无 Key/报错/非数组回退本地，合法数组归一化 target', async () => {
      const store = freshStore();
      const raw = '## 标题\n正文内容';
      const local = splitPastedTextToDrafts(raw, '环境与工作流');
      const org = makeOrg(store);
      const n0 = requests.length;
      assert.deepEqual(await org.splitImportWithAI(raw, '环境与工作流'), local);
      assert.equal(requests.length, n0, '未启用不应请求');

      org.saveConfig({ enabled: true, provider: 'openai', baseUrl: mockBase, model: 'm' });
      assert.deepEqual(await org.splitImportWithAI(raw, '环境与工作流'), local, '无 Key 应回退');
      assert.equal(requests.length, n0, '无 Key 不应请求');

      org.saveConfig({ apiKey: 'test-key-1234567890' });
      responder = () => ({ __status: 500, __error: 'boom' });
      assert.deepEqual(await org.splitImportWithAI(raw, '环境与工作流'), local, '网络报错应回退');

      responder = () => ({ ok: true, notArray: [] });
      assert.deepEqual(await org.splitImportWithAI(raw, '环境与工作流'), local, '非数组应回退');

      responder = () => '```json\n' + JSON.stringify([
        { title: 'A', body: 'a', target: '非法分组' },
        { title: 'B', body: 'b', target: NEW_PROJECT_TARGET },
        { title: '', body: '', target: '环境与工作流' },
      ]) + '\n```';
      const out = await org.splitImportWithAI(raw, '踩坑与经验库');
      assert.deepEqual(out.map((x) => x.title), ['A', 'B']);
      assert.equal(out[0].target, '踩坑与经验库');
      assert.equal(out[1].target, NEW_PROJECT_TARGET);
      store.close();
    });

    await t('2h 围栏', 'parseOrganizerJson 兼容 ```json 围栏与前后说明文字，非法文本返回 null', () => {
      assert.deepEqual(parseOrganizerJson('```json\n{"a":1}\n```'), { a: 1 });
      assert.deepEqual(parseOrganizerJson('说明\n```JSON\n[1,2]\n```\n结尾'), [1, 2]);
      assert.deepEqual(parseOrganizerJson('前言 {"a":2} 后记'), { a: 2 });
      assert.equal(parseOrganizerJson('这不是 JSON'), null);
      assert.equal(parseOrganizerJson(''), null);
    });

    await t('2h 水位线', '旧会话只计入 unorganizedCount；organizeOldConversations 按 limit 串行且更新水位', async () => {
      const store = freshStore();
      const base = 1_700_000_000_000;
      const ids = [];
      for (let i = 0; i < 3; i++) ids.push(addConv(store, `old-${i}`, [`旧问题${i}`, `旧回答${i}`], base + i * 1000).id);
      const now = base + 100_000;
      const org = makeOrg(store, { now: () => now });
      enable(org);
      assert.equal(org.getPublicState().unorganizedCount, 3);
      assert.equal(store.getKv(AI_ENABLE_WATERMARK_KV), String(now));

      responder = () => aiReply({ shortTitle: '旧会话整理标题' });
      const n0 = requests.length;
      await org.checkNow();
      assert.equal(requests.length, n0, '旧会话不能被定时器自动整理');
      assert.equal(org.getPublicState().unorganizedCount, 3);

      const first = await org.organizeOldConversations({ limit: 2 });
      assert.deepEqual(first, { organized: 2, remaining: 1 });
      assert.equal(requests.length, n0 + 2);
      assert.equal(org.getPublicState().unorganizedCount, 1);

      const second = await org.organizeOldConversations({ limit: 2 });
      assert.deepEqual(second, { organized: 1, remaining: 0 });
      for (const id of ids) {
        const row = store.getConversation(id, { limit: 1 });
        assert.equal(row.ai_msg_watermark, 2);
        assert.equal(row.ai_organized_at, now);
        assert.equal(row.summary, '自动摘要');
      }
      store.close();
    });

    await t('2h 水位线', 'organizeOldConversations 中途 enabled 关闭立即停止', async () => {
      const store = freshStore();
      const base = 1_700_000_050_000;
      for (let i = 0; i < 3; i++) addConv(store, `stop-${i}`, [`问题${i}`, `回答${i}`], base + i * 1000);
      const org = makeOrg(store, { now: () => base + 100_000 });
      enable(org);
      responder = () => {
        org.saveConfig({ enabled: false });
        return aiReply();
      };
      const n0 = requests.length;
      const r = await org.organizeOldConversations({ limit: 3 });
      assert.deepEqual(r, { organized: 1, remaining: 2 });
      assert.equal(requests.length, n0 + 1);
      assert.equal(org.getPublicState().enabled, false);
      responder = () => aiReply();
      store.close();
    });

    await t('2h 空闲防抖', '新会话空闲后仅请求 1 次；无新增不再请求；新增后再请求 1 次', async () => {
      const store = freshStore();
      let now = 1_700_000_100_000;
      const org = makeOrg(store, { now: () => now, idleMs: 100, checkIntervalMs: 10 });
      enable(org);
      const conv = addConv(store, 'idle-new', ['新问题', '新回答'], now + 10);
      responder = () => aiReply({ shortTitle: '空闲标题' });
      const n0 = requests.length;

      now += 50;
      await org.checkNow();
      assert.equal(requests.length, n0, '未满空闲阈值不应请求');

      now += 100;
      org.start();
      try {
        await waitFor(() => requests.length >= n0 + 1);
      } finally {
        org.stop();
      }
      assert.equal(requests.length, n0 + 1, '空闲后只请求 1 次');
      let row = store.getConversation(conv.id, { limit: 1 });
      assert.equal(row.title, '空闲标题');
      assert.equal(row.ai_msg_watermark, 2);
      assert.equal(row.ai_organized_at, now);

      await org.checkNow();
      assert.equal(requests.length, n0 + 1, '无新增消息不再请求');

      const updatedAt = now - 10;
      store.upsertConversation({
        source: 'claude-code',
        externalId: 'idle-new',
        ingestMethod: 'local',
        createdAt: updatedAt - 1000,
        updatedAt,
        messages: [
          { role: 'user', content: '新问题' },
          { role: 'assistant', content: '新回答' },
          { role: 'user', content: '继续追问' },
        ],
      });
      now += 100;
      await org.checkNow();
      assert.equal(requests.length, n0 + 2, '新增消息并再次空闲后只再请求 1 次');
      row = store.getConversation(conv.id, { limit: 1 });
      assert.equal(row.ai_msg_watermark, 3);
      assert.equal(row.ai_organized_at, now);
      store.close();
    });

    await t('2h 围栏/脱敏', 'organizeConversation 解析围栏 JSON；请求体脱敏而库内 messages 原文不变', async () => {
      const store = freshStore();
      const secret = 'sk-abcdefghijklmnop1234';
      const raw = `我的密钥是 ${secret}，请勿外传。`;
      const base = 1_700_000_200_000;
      const conv = addConv(store, 'redact-conv', [raw, '收到，已记录。'], base);
      const org = makeOrg(store, { now: () => base + 1000 });
      enable(org);
      responder = () => '```json\n' + JSON.stringify(aiReply({ shortTitle: '围栏标题', summary: '围栏摘要' })) + '\n```';
      const n0 = requests.length;
      const r = await org.organizeConversation(conv.id);
      assert.ok(r);
      const req = requests[n0];
      assert.ok(req && req.raw);
      assert.ok(!req.raw.includes(secret), '请求体不得包含明文密钥');
      assert.match(req.raw, /\[REDACTED_KEY\]/);
      const row = store.getConversation(conv.id, { limit: 5 });
      assert.equal(row.title, '围栏标题');
      assert.equal(row.summary, '围栏摘要');
      assert.equal(row.ai_msg_watermark, 2);
      assert.equal(store.db.prepare('SELECT content FROM messages WHERE conversation_id = ? ORDER BY seq LIMIT 1').get(conv.id).content, raw);
      store.close();
    });

    await t('2h 解析失败', 'LLM 返回非 JSON 时不写任何字段、不推进水位、不改 messages', async () => {
      const store = freshStore();
      const base = 1_700_000_300_000;
      const conv = addConv(store, 'bad-json', ['问题', '回答'], base);
      const org = makeOrg(store, { now: () => base + 1000 });
      enable(org);
      const before = store.getConversation(conv.id, { limit: 5 });
      const beforeMsgs = msgs(store, conv.id);
      responder = () => '这不是 JSON，只是普通文本';
      const r = await org.organizeConversation(conv.id);
      assert.equal(r, null);
      const after = store.getConversation(conv.id, { limit: 5 });
      assert.equal(after.title, before.title);
      assert.equal(after.summary, '');
      assert.equal(after.decisions_json, '[]');
      assert.equal(after.next_step, '');
      assert.equal(after.project_id, before.project_id);
      assert.equal(after.ai_organized_at, null);
      assert.equal(after.ai_msg_watermark, 0);
      assert.deepEqual(msgs(store, conv.id), beforeMsgs);
      store.close();
    });

    await t('2h 红线', '锁定会话：标题/事项与事项字段均不变，其它分组卡片被硬拦截', async () => {
      const store = freshStore();
      const base = 1_700_000_400_000;
      const proj = store.saveProject({ name: '锁定事项', state: '推进中', progress: '原进展', decisions: ['原结论'], rejected: ['原否决'], nextStep: '原下一步' });
      const conv = addConv(store, 'locked-conv', ['锁定问题', '锁定回答'], base);
      store.updateConversationMeta(conv.id, { title: '锁定标题', projectId: proj.id });
      const beforeConv = store.getConversation(conv.id, { limit: 5 });
      const beforeProj = store.getProject(proj.id);
      const beforeMsgs = msgs(store, conv.id);
      const org = makeOrg(store, { now: () => base + 1000 });
      enable(org);
      responder = () => aiReply({
        shortTitle: '不应覆盖标题',
        summary: '允许更新摘要',
        decisions: ['允许更新结论'],
        nextStep: '允许更新下一步',
        projectMatch: { action: 'new', newProjectName: '不应新建事项', state: '已完成', progress: '不应改', addedDecisions: ['不应加'], addedRejected: ['不应加'], nextStep: '不应改' },
        pitfallCard: { group: '个人与职业背景', title: '锁定会话踩坑', body: '根因与修复', tags: ['SQLite'] },
        cards: [{ group: '协作与沟通准则', title: '非法卡', body: '不应写入' }],
        memories: [{ group: '环境与工作流', title: '非法卡2', body: '不应写入' }],
      });
      const r = await org.organizeConversation(conv.id);
      assert.ok(r);
      const afterConv = store.getConversation(conv.id, { limit: 5 });
      assert.equal(afterConv.title, '锁定标题');
      assert.equal(afterConv.original_title, beforeConv.original_title);
      assert.equal(afterConv.project_id, proj.id);
      assert.equal(afterConv.title_locked, 1);
      assert.equal(afterConv.project_locked, 1);
      assert.equal(afterConv.summary, '允许更新摘要');
      assert.equal(afterConv.ai_msg_watermark, 2);
      assert.deepEqual(store.getProject(proj.id), beforeProj, '锁定事项字段不应被修改');
      assert.equal(store.listProjects({ includeArchived: true }).length, 1, '不应新建事项');
      assert.deepEqual(msgs(store, conv.id), beforeMsgs, 'messages 原文不得修改');
      for (const group of ['个人与职业背景', '协作与沟通准则', '环境与工作流']) {
        assert.equal(store.listMemories({ group }).length, 0, `${group} 必须 0 写入`);
      }
      const pits = store.listMemories({ group: '踩坑与经验库' });
      assert.equal(pits.length, 1);
      assert.equal(pits[0].title, '锁定会话踩坑');
      assert.equal(pits[0].originLabel, 'AI 自动沉淀');
      assert.deepEqual(pits[0].sourceIds, [conv.id]);
      store.close();
    });

    await t('2h 红线', '未锁定会话：existing 事项合并去重、非法 id 忽略；踩坑卡同名合并且三画像分组 0 写入', async () => {
      const store = freshStore();
      const base = 1_700_000_500_000;
      const proj = store.saveProject({ name: '合并事项', state: '推进中', progress: '旧进展', decisions: ['已拍板A'], rejected: ['已否决A'], nextStep: '旧下一步' });
      const conv = addConv(store, 'merge-conv', ['排查 SQLite 报错', '根因是锁等待，已修复'], base);
      const org = makeOrg(store, { now: () => base + 1000 });
      enable(org);
      responder = () => aiReply({
        shortTitle: 'SQLite 锁等待',
        summary: '锁等待导致报错',
        projectMatch: {
          action: 'existing', projectId: proj.id, state: '待验证', progress: '新进展',
          addedDecisions: ['已拍板A', '已拍板B'], addedRejected: ['已否决A', '已否决B'], nextStep: '新下一步',
        },
        pitfallCard: { group: '个人与职业背景', title: 'SQLite 锁等待', body: '现象：报错；根因：长事务；修复：缩短事务。', tags: ['SQLite'] },
        cards: [{ group: '协作与沟通准则', title: '非法卡', body: 'x' }],
      });
      const n0 = requests.length;
      const r = await org.organizeConversation(conv.id);
      assert.ok(r);
      const after = store.getConversation(conv.id, { limit: 5 });
      assert.equal(after.title, 'SQLite 锁等待');
      assert.equal(after.original_title, '排查 SQLite 报错', 'AI 改标题前应保留 original_title');
      assert.equal(after.title_locked, 0);
      assert.equal(after.project_id, proj.id);
      assert.equal(after.project_locked, 0);
      const merged = store.getProject(proj.id);
      assert.equal(merged.state, '待验证');
      assert.equal(merged.progress, '新进展');
      assert.equal(merged.nextStep, '新下一步');
      assert.deepEqual(merged.decisions, ['已拍板A', '已拍板B']);
      assert.deepEqual(merged.rejected, ['已否决A', '已否决B']);
      assert.equal(store.listProjects({ includeArchived: true }).length, 1);

      responder = () => aiReply({
        shortTitle: 'SQLite 锁等待',
        summary: '锁等待导致报错',
        pitfallCard: { group: '环境与工作流', title: 'SQLite 锁等待', body: '现象：报错；根因：长事务；修复：缩短事务并重试。', tags: ['重试'] },
      });
      const conv2 = addConv(store, 'merge-conv-2', ['另一个 SQLite 报错', '同样根因'], base + 100);
      const r2 = await org.organizeConversation(conv2.id);
      assert.ok(r2);
      const pits = store.listMemories({ group: '踩坑与经验库' });
      assert.equal(pits.length, 1);
      assert.match(pits[0].body, /重试/);
      assert.match(pits[0].superseded, /缩短事务。/);
      assert.deepEqual(pits[0].tags, ['SQLite', '重试']);
      assert.deepEqual(pits[0].sourceIds, [conv.id, conv2.id]);
      for (const group of ['个人与职业背景', '协作与沟通准则', '环境与工作流']) {
        assert.equal(store.listMemories({ group }).length, 0, `${group} 必须 0 写入`);
      }
      assert.equal(requests.length, n0 + 2);

      responder = () => aiReply({ projectMatch: { action: 'existing', projectId: 'missing-project-id' } });
      const conv3 = addConv(store, 'bad-project-id', ['独立问答', '普通回答'], base + 200);
      await org.organizeConversation(conv3.id);
      assert.equal(store.getConversation(conv3.id, { limit: 1 }).project_id, null, '不存在的事项 id 不得写入');

      responder = () => aiReply({ projectMatch: { action: 'new', newProjectName: '新事项', state: '推进中', addedDecisions: ['新结论'] } });
      const conv4 = addConv(store, 'new-project', ['新项目讨论', '形成结论'], base + 300);
      await org.organizeConversation(conv4.id);
      const created = store.listProjects().find((x) => x.name === '新事项');
      assert.ok(created, 'action=new 应创建事项');
      assert.equal(store.getConversation(conv4.id, { limit: 1 }).project_id, created.id);
      store.close();
    });

    await t('2i 摘要静默锁', '手动改摘要/决策/下一步后 summary_locked=1，AI 整理不覆写；标题等其它字段照常', async () => {
      const store = freshStore();
      const base = 1_700_000_500_000;
      const conv = addConv(store, 'sum-locked', ['问题甲', '回答甲'], base);
      assert.equal(Number(store.getConversation(conv.id, { limit: 1 }).summary_locked), 0, '新会话默认未锁');
      const meta = store.updateConversationMeta(conv.id, { summary: '手动摘要', decisions: ['手动结论'], nextStep: '手动下一步' });
      assert.equal(Number(meta.summary_locked), 1, '手动改摘要静默置锁');
      const org = makeOrg(store, { now: () => base + 1000 });
      enable(org);
      responder = () => aiReply({ shortTitle: 'AI 标题', summary: 'AI 摘要', decisions: ['AI 结论'], nextStep: 'AI 下一步' });
      const r = await org.organizeConversation(conv.id);
      assert.ok(r);
      const row = store.getConversation(conv.id, { limit: 1 });
      assert.equal(row.summary, '手动摘要');
      assert.equal(row.decisions_json, JSON.stringify(['手动结论']));
      assert.equal(row.next_step, '手动下一步');
      assert.equal(row.title, 'AI 标题', '摘要锁不影响未锁定的标题');
      assert.equal(row.ai_msg_watermark, 2);
      // db 层二次拦截：绕过 organizer 直接写也不得覆写
      store.applyAiOrganization(conv.id, { summary: '直写摘要', decisions: ['直写'], nextStep: '直写下一步' });
      const row2 = store.getConversation(conv.id, { limit: 1 });
      assert.equal(row2.summary, '手动摘要');
      assert.equal(row2.decisions_json, JSON.stringify(['手动结论']));
      assert.equal(row2.next_step, '手动下一步');
      // 只改标题/归属不置摘要锁
      const conv2 = addConv(store, 'title-only', ['问题乙', '回答乙'], base + 10);
      assert.equal(Number(store.updateConversationMeta(conv2.id, { title: '只改标题' }).summary_locked), 0);
      store.close();
    });

    await t('2i 摘要续聊刷新', '未手动改摘要：续聊后再次整理正常刷新；模型给空摘要不清空已有摘要', async () => {
      const store = freshStore();
      const base = 1_700_000_600_000;
      const conv = addConv(store, 'sum-refresh', ['问题丙', '回答丙'], base);
      const org = makeOrg(store, { now: () => base + 1000 });
      enable(org);
      responder = () => aiReply({ summary: '第一版摘要' });
      await org.organizeConversation(conv.id);
      assert.equal(store.getConversation(conv.id, { limit: 1 }).summary, '第一版摘要');
      addConv(store, 'sum-refresh', ['问题丙', '回答丙', '追问丙', '再答丙'], base + 50);
      responder = () => aiReply({ summary: '第二版摘要', decisions: ['新结论'] });
      await org.organizeConversation(conv.id);
      let row = store.getConversation(conv.id, { limit: 1 });
      assert.equal(row.summary, '第二版摘要');
      assert.equal(row.decisions_json, JSON.stringify(['新结论']));
      assert.equal(Number(row.summary_locked), 0);
      assert.equal(row.ai_msg_watermark, 4);
      responder = () => aiReply({ summary: '' });
      await org.organizeConversation(conv.id);
      row = store.getConversation(conv.id, { limit: 1 });
      assert.equal(row.summary, '第二版摘要', '空摘要不得清空已有非空摘要');
      store.applyAiOrganization(conv.id, { summary: '   ' });
      assert.equal(store.getConversation(conv.id, { limit: 1 }).summary, '第二版摘要', 'db 层同样防清空');
      const keptDecisions = store.getConversation(conv.id, { limit: 1 }).decisions_json;
      assert.notEqual(keptDecisions, '[]');
      responder = () => aiReply({ summary: '第三版摘要', decisions: [], nextStep: '' });
      await org.organizeConversation(conv.id);
      row = store.getConversation(conv.id, { limit: 1 });
      assert.equal(row.decisions_json, keptDecisions, '空结论数组不得清空已有非空结论');
      assert.equal(row.next_step, '', 'nextStep 允许置空（待办完成）');
      store.applyAiOrganization(conv.id, { decisions: [] });
      assert.equal(store.getConversation(conv.id, { limit: 1 }).decisions_json, keptDecisions, 'db 层同样防清空结论');
      store.close();
    });

    await t('2i 水位竞态', '请求飞行期间新入库的消息不被提前计入 ai_msg_watermark', async () => {
      const store = freshStore();
      const base = 1_700_000_700_000;
      const conv = addConv(store, 'wm-race', ['问题丁', '回答丁'], base);
      const org = makeOrg(store, { now: () => base + 1000 });
      enable(org);
      let injected = false;
      responder = () => {
        if (!injected) {
          injected = true;
          addConv(store, 'wm-race', ['问题丁', '回答丁', '飞行中追问', '飞行中回答'], base + 500);
        }
        return aiReply({ summary: '竞态摘要' });
      };
      const r = await org.organizeConversation(conv.id);
      assert.ok(r && injected);
      const row = store.getConversation(conv.id, { limit: 1 });
      assert.equal(row.message_count, 4, '飞行期间消息已入库');
      assert.equal(row.ai_msg_watermark, 2, '水位只计送审的 2 条');
      const pending = store.listAiIdleCandidates({ watermark: 0, idleBefore: base + 10_000 }).map((c) => c.id);
      assert.ok(pending.includes(conv.id), '新消息仍待下一轮整理');
      store.close();
    });

    await t('2i 旧 v2 库补列', '已是 user_version=2 但缺 summary_locked 的库重开后幂等补列、数据无损', async () => {
      const d = path.join(T, `db${storeN++}`); fs.mkdirSync(d);
      let store = Store.open(d);
      const conv = addConv(store, 'old-v2', ['旧问题', '旧回答'], 1_700_000_800_000);
      store.updateConversationMeta(conv.id, { title: '旧标题' });
      store.close();
      const raw = new DatabaseSync(path.join(d, 'mem0.db'));
      raw.exec('ALTER TABLE conversations DROP COLUMN summary_locked');
      assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 2);
      assert.ok(!raw.prepare('PRAGMA table_info(conversations)').all().some((c) => c.name === 'summary_locked'));
      raw.close();
      store = Store.open(d);
      const cols = store.db.prepare('PRAGMA table_info(conversations)').all().map((c) => c.name);
      assert.ok(cols.includes('summary_locked'));
      const row = store.getConversation(conv.id, { limit: 5 });
      assert.equal(Number(row.summary_locked), 0);
      assert.equal(row.title, '旧标题');
      assert.equal(row.messages.length, 2);
      store.close();
      store = Store.open(d); // 再开一次仍幂等
      assert.equal(store.db.prepare('PRAGMA table_info(conversations)').all().filter((c) => c.name === 'summary_locked').length, 1);
      store.close();
    });

    await new Promise((resolve) => {
      mockServer.close(resolve);
      if (typeof mockServer.closeAllConnections === 'function') mockServer.closeAllConnections();
    });
  }

  // =====================================================================
  // 4. 浏览器插件桥
  // =====================================================================
  {
    const store = freshStore();
    const port = await freePort();
    const URLWS = `ws://127.0.0.1:${port}/browser/v1`;
    let bridge;
    await t('4 bridge', `在 127.0.0.1:${port}/browser/v1 启动`, async () => { bridge = await startBridge(store, { port }); assert.equal(bridge.url, URLWS); });
    const uncaught = [];
    const onUnc = (e) => uncaught.push(e);
    process.on('uncaughtException', onUnc);

    /** 打开连接；返回 {ws, next(), closed} */
    const open = (opts = {}) => new Promise((resolve) => {
      const ws = new WebSocket(URLWS, { origin: opts.origin, headers: opts.headers, maxPayload: 64 * 1024 * 1024 });
      const q = []; const waiters = [];
      let closeInfo = null; const closeWaiters = [];
      ws.on('message', (d) => { const m = JSON.parse(String(d)); waiters.length ? waiters.shift()(m) : q.push(m); });
      ws.on('close', (code) => { closeInfo = { code }; closeWaiters.splice(0).forEach((f) => f(closeInfo)); waiters.splice(0).forEach((f) => f(null)); });
      ws.on('error', () => {});
      ws.on('unexpected-response', (_req, res) => resolve({ rejected: res.statusCode }));
      const api = {
        ws,
        next: (ms = 2000) => q.length ? Promise.resolve(q.shift()) : new Promise((r) => { waiters.push(r); setTimeout(() => r(null), ms); }),
        closed: (ms = 2000) => closeInfo ? Promise.resolve(closeInfo) : new Promise((r) => { closeWaiters.push(r); setTimeout(() => r(null), ms); }),
        send: (o) => ws.send(typeof o === 'string' ? o : j(o)),
      };
      ws.on('open', () => resolve(api));
    });
    const hello = (extra) => ({ type: 'hello', protocol: 1, extensionId: 'ext', ...extra });

    if (bridge) {
      await t('4 bridge', '非扩展 Origin（http/https/null/伪装）握手被拒', async () => {
        for (const o of ['https://chatgpt.com', 'http://localhost:3000', 'null', 'https://chrome-extension.evil.com', 'file://']) {
          const r = await open({ origin: o });
          assert.ok(r.rejected, `Origin ${o} 未被拒`);
        }
        const ok = await open({ origin: 'chrome-extension://abcdef' });
        assert.ok(ok.ws); ok.ws.close();
      });
      await t('4 bridge', 'DNS rebinding Host 被拒', async () => {
        for (const h of [`evil.com:${port}`, `127.0.0.1.evil.com:${port}`, 'localhost']) {
          const r = await open({ origin: 'chrome-extension://x', headers: { Host: h } });
          assert.ok(r.rejected, `Host ${h} 未被拒`);
        }
      });
      await t('4 bridge', '未认证：坏 JSON → bad_json；非 hello → protocol 并关闭；无配对码 → pair_required', async () => {
        let c = await open();
        c.send('{oops'); assert.equal((await c.next()).code, 'bad_json');
        c.send({ type: 'upsert', conversation: {} }); assert.equal((await c.next()).code, 'protocol'); assert.equal((await c.closed()).code, 4002);
        c = await open(); c.send(hello()); assert.equal((await c.next()).code, 'pair_required'); assert.equal((await c.closed()).code, 4003);
      });
      await t('4 bridge', '未认证发送 JSON null/数字/字符串：不应抛未捕获异常（bridge.js:57）', async () => {
        const before = uncaught.length;
        for (const payload of ['null', '0', '"x"', 'true']) {
          const c = await open(); c.send(payload); await c.next(500); c.ws.close();
        }
        await sleep(100);
        assert.equal(uncaught.length, before, `未捕获异常：${uncaught.slice(before).map((e) => e.message).join('; ')}`);
      });
      await t('4 bridge', '配对码过期后拒绝', async () => {
        const { code } = bridge.newPairCode();
        const realNow = Date.now; Date.now = () => realNow() + 121_000;
        try {
          const c = await open(); c.send(hello({ pairCode: code }));
          assert.equal((await c.next()).code, 'pair_required');
        } finally { Date.now = realNow; }
      });
      let token;
      await t('4 bridge', '正确配对码 → token；同一配对码不能复用', async () => {
        const { code } = bridge.newPairCode();
        let c = await open({ origin: 'chrome-extension://abc' }); c.send(hello({ pairCode: code }));
        const w = await c.next(); assert.equal(w.type, 'welcome'); token = w.token; assert.ok(token.length >= 40);
        c.ws.close();
        c = await open(); c.send(hello({ pairCode: code })); assert.equal((await c.next()).code, 'pair_required');
        const raw = store.getKv('bridge_tokens'); assert.ok(!raw.includes(token), 'token 明文落库');
      });
      await t('4 bridge', '输错 4 次后正确配对码仍可用（不误伤手误）', async () => {
        const { code } = bridge.newPairCode();
        for (let i = 1; i <= 4; i++) { const c = await open(); c.send(hello({ pairCode: String((Number(code) + i) % 1_000_000).padStart(6, '0') })); await c.next(); c.ws.terminate(); }
        const c = await open(); c.send(hello({ pairCode: code })); const w = await c.next();
        assert.equal(w && w.type, 'welcome'); c.ws.close();
      });
      await t('4 bridge', '配对暴力破解：多次错误尝试后配对码应失效', async () => {
        const { code } = bridge.newPairCode();
        const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
        const t0 = Date.now(); const N = 200;
        for (let i = 0; i < N; i++) {
          const c = await open(); c.send(hello({ pairCode: String((Number(code) + 1 + i) % 1_000_000).padStart(6, '0') })); await c.next(); c.ws.terminate();
        }
        const rate = Math.round(N / ((Date.now() - t0) / 1000));
        results.push({ section: '4 bridge', name: `[信息] 单线程暴力尝试速率 ≈ ${rate} 次/秒（120 秒窗口约 ${Math.min(100, Math.round(rate * 120 / 1e4))}% 码空间）`, ok: true });
        void wrong;
        const c = await open(); c.send(hello({ pairCode: code }));
        const m = await c.next();
        assert.notEqual(m && m.type, 'welcome', `${N} 次错误尝试后正确配对码仍然有效`);
      });
      await t('4 bridge', 'token 认证 → upsert/ping；吊销后旧连接被关、token 不能复用', async () => {
        const c = await open(); c.send(hello({ token }));
        assert.equal((await c.next()).type, 'welcome');
        c.send({ type: 'ping' }); assert.equal((await c.next()).type, 'pong');
        c.send({ type: 'upsert', reqId: 1, conversation: { platform: 'chatgpt', externalId: 'c1', url: 'javascript:alert(1)', messages: [{ role: 'user', content: 'hi there' }] } });
        const a = await c.next(); assert.equal(a.ok, true); assert.equal(a.added, 1);
        assert.equal(store.listConversations({ sources: ['chatgpt-web'] })[0].url, null);
        c.send({ type: 'upsert', reqId: 2, conversation: { platform: 'evil', externalId: 'x' } }); assert.equal((await c.next()).ok, false);
        c.send({ type: 'upsert', reqId: 3, conversation: { platform: 'claude' } }); assert.equal((await c.next()).ok, false);
        c.send({ type: 'upsert', reqId: 4, conversation: { platform: 'claude', externalId: 'x', messages: 'notarray' } }); assert.equal((await c.next()).ok, true);
        for (const [i, p] of [['grok', 'grok'], ['hark', 'hark']].map(([p], k) => [10 + k, p])) {
          c.send({ type: 'upsert', reqId: i, conversation: { platform: p, externalId: `${p}-1`, url: `https://${p}.com/c/1`, messages: [{ role: 'user', content: `${p} web question` }, { role: 'assistant', content: 'ok' }] } });
          const r = await c.next(); assert.equal(r.ok, true, `${p}: ${JSON.stringify(r)}`); assert.equal(r.added, 2);
          assert.equal(store.listConversations({ sources: [`${p}-web`] }).length, 1, `${p}-web 未入库`);
        }
        c.send({ type: 'whatever' }); assert.equal((await c.next()).code, 'unknown_type');
        c.send('{bad'); assert.equal((await c.next()).code, 'bad_json');
        bridge.revokeAll();
        assert.equal((await c.closed()).code, 4004);
        const d = await open(); d.send(hello({ token })); assert.equal((await d.next()).code, 'token_invalid');
      });
      await t('4 bridge', '已认证发送 JSON null：不应抛未捕获异常', async () => {
        const { code } = bridge.newPairCode();
        const c = await open(); c.send(hello({ pairCode: code })); const w = await c.next(); assert.equal(w.type, 'welcome');
        const before = uncaught.length;
        c.send('null'); await c.next(500); await sleep(100);
        token = w.token; c.ws.close();
        assert.equal(uncaught.length, before, `未捕获异常：${uncaught.slice(before).map((e) => e.message).join('; ')}`);
      });
      await t('4 bridge', '超大帧 (>16MB) 断开连接，服务仍可用', async () => {
        const c = await open(); c.send(hello({ token })); await c.next();
        c.send('x'.repeat(17 * 1024 * 1024));
        const cl = await c.closed(5000); assert.equal(cl && cl.code, 1009);
        const d = await open(); d.send(hello({ token })); assert.equal((await d.next()).type, 'welcome'); d.ws.close();
      });
      await t('4 bridge', '10 秒未认证自动断开', async () => {
        const c = await open();
        const cl = await c.closed(11_500); assert.equal(cl && cl.code, 4001);
      });
      await t('4 bridge', 'close()：未认证连接也 terminate，不阻塞关闭', async () => {
        const c1 = await open(); // 未认证、保持连接
        const c2 = await open(); c2.send(hello({ token })); assert.equal((await c2.next()).type, 'welcome');
        const t0 = Date.now();
        await bridge.close();
        assert.ok(Date.now() - t0 < 2000, 'close 不应等未认证连接自然断开');
        const cl1 = await c1.closed(2000);
        assert.ok(cl1, '未认证连接应被断开');
        const cl2 = await c2.closed(2000);
        assert.ok(cl2, '已认证连接应被断开');
      });
    }
    process.off('uncaughtException', onUnc);
    // close() 幂等：已在上面关闭时直接返回
    if (bridge) await bridge.close();

    // ---------- align 逻辑（直接调 store，与 bridge 写入参数一致） ----------
    const W = (externalId, list, extra = {}) => store.upsertConversation({ source: 'gemini-web', externalId, ingestMethod: 'browser-extension', align: true, messages: list.map(([role, content]) => ({ role, content })), ...extra });
    const get = (externalId) => store.getConversation(store.db.prepare("SELECT id FROM conversations WHERE source='gemini-web' AND external_id=?").get(externalId).id, { limit: 2000 }).messages.map((m) => `${m.role[0]}:${m.content}`);
    const base = [['user', 'u1'], ['assistant', 'a1'], ['user', 'u2'], ['assistant', 'a2'], ['user', 'u3'], ['assistant', 'a3']];
    await t('4 align', '部分快照（后缀+新消息）：前缀保留', () => {
      W('p', base, { authoritative: true });
      W('p', [['user', 'u2'], ['assistant', 'a2'], ['user', 'u3'], ['assistant', 'a3'], ['user', 'u4'], ['assistant', 'a4']], { authoritative: true });
      assert.deepEqual(get('p'), ['u:u1', 'a:a1', 'u:u2', 'a:a2', 'u:u3', 'a:a3', 'u:u4', 'a:a4']);
    });
    await t('4 align', '无重叠：只追加新消息', () => {
      W('n', base.slice(0, 2));
      W('n', [['user', 'u9'], ['assistant', 'a9']], { authoritative: true });
      assert.deepEqual(get('n'), ['u:u1', 'a:a1', 'u:u9', 'a:a9']);
    });
    await t('4 align', '部分快照中编辑最后一轮：更新而不丢前缀/不截断', () => {
      W('e', base);
      W('e', [['user', 'u3'], ['assistant', 'a3-edited']], { authoritative: true });
      assert.deepEqual(get('e'), ['u:u1', 'a:a1', 'u:u2', 'a:a2', 'u:u3', 'a:a3-edited']);
    });
    await t('4 align', '完整快照 authoritative 截断尾部（编辑重发）', () => {
      W('tr', base);
      W('tr', [['user', 'u1'], ['assistant', 'a1-new']], { authoritative: true });
      assert.deepEqual(get('tr'), ['u:u1', 'a:a1-new']);
    });
    await t('4 align', '流式回答内容变长：原位更新', () => {
      W('s', [['user', 'q'], ['assistant', 'par']]);
      W('s', [['user', 'q'], ['assistant', 'partial answer']]);
      assert.deepEqual(get('s'), ['u:q', 'a:partial answer']);
    });
    await t('4 align', '重复内容：部分快照首条与 stored[0] 相同（如都是“继续”）不应覆盖前文（db.js:150-163）', () => {
      W('d1', [['user', '继续'], ['assistant', 'A1'], ['user', '继续'], ['assistant', 'A2']]);
      W('d1', [['user', '继续'], ['assistant', 'A2'], ['user', '继续'], ['assistant', 'A3']], { authoritative: true });
      assert.deepEqual(get('d1'), ['u:继续', 'a:A1', 'u:继续', 'a:A2', 'u:继续', 'a:A3']);
    });
    await t('4 align', '重复内容：首条在前文多次出现时应对齐到正确位置（db.js:154 findIndex 取第一个）', () => {
      W('d2', [['user', '写个函数'], ['assistant', 'F'], ['user', '继续'], ['assistant', 'A1'], ['user', '继续'], ['assistant', 'A2']]);
      W('d2', [['user', '继续'], ['assistant', 'A2'], ['user', '继续'], ['assistant', 'A3']], { authoritative: true });
      assert.deepEqual(get('d2'), ['u:写个函数', 'a:F', 'u:继续', 'a:A1', 'u:继续', 'a:A2', 'u:继续', 'a:A3']);
    });
    await t('4 align', '无重叠追加时，与旧消息同文的新消息不应被丢弃（db.js:159-160）', () => {
      W('d3', [['user', 'q1'], ['assistant', '好的']]);
      W('d3', [['user', 'q2'], ['assistant', '好的']]);
      assert.deepEqual(get('d3'), ['u:q1', 'a:好的', 'u:q2', 'a:好的']);
    });
    await t('4 align', '回归：同一快照内重复“好的”全部保留；重发同一快照不重复追加', () => {
      W('d4', [['user', 'q1'], ['assistant', '好的']]);
      W('d4', [['user', 'q2'], ['assistant', '好的'], ['user', 'q3'], ['assistant', '好的']]);
      assert.deepEqual(get('d4'), ['u:q1', 'a:好的', 'u:q2', 'a:好的', 'u:q3', 'a:好的']);
      W('d4', [['user', 'q2'], ['assistant', '好的'], ['user', 'q3'], ['assistant', '好的']]);
      W('d4', [['user', 'q3'], ['assistant', '好的']], { authoritative: true });
      assert.deepEqual(get('d4'), ['u:q1', 'a:好的', 'u:q2', 'a:好的', 'u:q3', 'a:好的']);
      const row = store.db.prepare("SELECT message_count FROM conversations WHERE source='gemini-web' AND external_id='d4'").get();
      assert.equal(row.message_count, 6);
    });
    await t('4 align', '回归：删除后墓碑仍生效（消息数不增不恢复；有新的同文消息才恢复）', () => {
      W('d5', [['user', 'q1'], ['assistant', '好的']]);
      W('d5', [['user', 'q2'], ['assistant', '好的']]);
      const id = store.db.prepare("SELECT id FROM conversations WHERE source='gemini-web' AND external_id='d5'").get().id;
      store.deleteConversation(id);
      const r1 = W('d5', [['user', 'q1'], ['assistant', '好的'], ['user', 'q2'], ['assistant', '好的']]);
      assert.equal(r1.skipped, 'deleted');
      assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE id = ?').get(id).n, 0);
      W('d5', [['user', 'q1'], ['assistant', '好的'], ['user', 'q2'], ['assistant', '好的'], ['user', 'q3'], ['assistant', '好的']]);
      assert.deepEqual(get('d5'), ['u:q1', 'a:好的', 'u:q2', 'a:好的', 'u:q3', 'a:好的']);
      assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM deleted_conversations WHERE id = ?').get(id).n, 0);
    });
    store.close();
  }

  // =====================================================================
  // 5. 一键接入（临时 HOME）
  // =====================================================================
  {
    const H = path.join(T, 'reghome');
    fs.mkdirSync(H);
    const TOK = 'test-token-abc123';
    const URL1 = `http://127.0.0.1:3790/mcp?token=${TOK}`;
    const URL2 = `http://127.0.0.1:4790/mcp?token=${TOK}`;
    const URL_NO_TOKEN = 'http://127.0.0.1:3790/mcp';
    const URL_OLD_TOKEN = 'http://127.0.0.1:3790/mcp?token=old-token';
    const backups = (dir, base) => fs.readdirSync(dir).filter((f) => f.startsWith(base + '.mem0-backup-'));
    const cj = path.join(H, '.claude.json');
    await t('5 register', '真实 HOME 不受影响（所有调用显式传临时 home）', () => {
      assert.notEqual(H, REAL_HOME);
      assert.equal(register.listClients(URL1, H).find((c) => c.id === 'claude-code').status, 'not_installed');
    });
    await t('5 register', 'Claude：保留原有字段/其它 server，写备份，状态 connected', () => {
      fs.writeFileSync(cj, j({ numStartups: 3, mcpServers: { other: { type: 'stdio', command: 'x' } }, projects: { '/a': { mcpServers: {} } } }), { mode: 0o600 });
      assert.equal(register.connectClient('claude-code', URL1, H), 'connected');
      const d = JSON.parse(fs.readFileSync(cj, 'utf8'));
      assert.equal(d.numStartups, 3); assert.ok(d.mcpServers.other); assert.deepEqual(d.mcpServers.mem0, { type: 'http', url: URL1 }); assert.ok(d.projects);
      assert.equal(backups(H, '.claude.json').length, 1);
    });
    await t('5 register', 'Claude：保留 .claude.json 的 0600 权限（register.js:15-19）', () => {
      const mode = fs.statSync(cj).mode & 0o777;
      if (process.platform !== 'win32') assert.equal(mode.toString(8), '600');
    });
    await t('5 register', 'Claude：重复 connect 幂等（内容不变）；URL 变化 → stale → 更新', async () => {
      const before = fs.readFileSync(cj, 'utf8');
      await sleep(2);
      register.connectClient('claude-code', URL1, H);
      assert.equal(fs.readFileSync(cj, 'utf8'), before);
      assert.equal(register.listClients(URL2, H).find((c) => c.id === 'claude-code').status, 'stale');
      assert.equal(register.connectClient('claude-code', URL2, H), 'connected');
    });
    await t('5 register', 'Claude：disconnect 只删 mem0；二次 disconnect 不再写备份', async () => {
      register.disconnectClient('claude-code', H);
      const d = JSON.parse(fs.readFileSync(cj, 'utf8'));
      assert.ok(!d.mcpServers.mem0); assert.ok(d.mcpServers.other);
      const n = backups(H, '.claude.json').length;
      await sleep(2);
      register.disconnectClient('claude-code', H);
      assert.equal(backups(H, '.claude.json').length, n);
    });
    await t('5 register', 'Claude：坏 JSON → 抛错且原文件不被覆盖', () => {
      fs.writeFileSync(cj, '{ broken');
      assert.throws(() => register.connectClient('claude-code', URL1, H));
      assert.equal(fs.readFileSync(cj, 'utf8'), '{ broken');
    });
    await t('5 register', 'Claude：已写入地址不带当前 token（无 token / 旧 token）→ stale；更新后写入带 token 地址', () => {
      const st = (u) => register.listClients(u, H).find((c) => c.id === 'claude-code').status;
      for (const old of [URL_NO_TOKEN, URL_OLD_TOKEN]) {
        fs.writeFileSync(cj, j({ mcpServers: { mem0: { type: 'http', url: old } } }));
        assert.equal(st(URL1), 'stale', old);
      }
      assert.equal(register.connectClient('claude-code', URL1, H), 'connected');
      assert.equal(JSON.parse(fs.readFileSync(cj, 'utf8')).mcpServers.mem0.url, URL1);
      assert.ok(URL1.includes(`token=${TOK}`));
    });
    await t('5 register', '手动配置（其它客户端）同样带 token', () => {
      const cfg = JSON.parse(register.manualConfig(URL1));
      assert.equal(cfg.mcpServers.mem0.url, URL1);
      assert.match(cfg.mcpServers.mem0.url, /\?token=test-token-abc123$/);
    });
    await t('5 register', 'Claude：文件不存在时创建，不产生备份', () => {
      const H2 = path.join(T, 'reghome2'); fs.mkdirSync(H2);
      register.connectClient('claude-code', URL1, H2);
      assert.equal(JSON.parse(fs.readFileSync(path.join(H2, '.claude.json'), 'utf8')).mcpServers.mem0.url, URL1);
      assert.equal(backups(H2, '.claude.json').length, 0);
    });
    const wbf = path.join(H, '.workbuddy', 'mcp.json');
    const wbc = (u) => register.listClients(u, H).find((c) => c.id === 'workbuddy');
    await t('5 register', 'WorkBuddy：未安装 → not_installed；列表带 label/file/重启提示', () => {
      const c = wbc(URL1);
      assert.equal(c.status, 'not_installed'); assert.equal(c.label, 'WorkBuddy'); assert.equal(c.file, wbf);
      assert.equal(c.note, '重启 WorkBuddy 后生效');
    });
    await t('5 register', 'WorkBuddy：目录存在无 mcp.json → not_connected；connect 创建文件、无备份', () => {
      fs.mkdirSync(path.dirname(wbf), { recursive: true });
      assert.equal(wbc(URL1).status, 'not_connected');
      assert.equal(register.connectClient('workbuddy', URL1, H), 'connected');
      assert.deepEqual(JSON.parse(fs.readFileSync(wbf, 'utf8')).mcpServers.mem0, { type: 'http', url: URL1 });
      assert.equal(backups(path.dirname(wbf), 'mcp.json').length, 0);
    });
    await t('5 register', 'WorkBuddy：保留其它 server/字段，写备份；重复 connect 幂等；URL 变化 → stale', async () => {
      fs.writeFileSync(wbf, j({ theme: 'dark', mcpServers: { other: { command: 'x' }, mem0: { type: 'http', url: 'http://old/mcp' } } })); fs.chmodSync(wbf, 0o600);
      assert.equal(wbc(URL1).status, 'stale');
      assert.equal(register.connectClient('workbuddy', URL1, H), 'connected');
      const d = JSON.parse(fs.readFileSync(wbf, 'utf8'));
      assert.equal(d.theme, 'dark'); assert.deepEqual(d.mcpServers.other, { command: 'x' }); assert.deepEqual(d.mcpServers.mem0, { type: 'http', url: URL1 });
      assert.equal(backups(path.dirname(wbf), 'mcp.json').length, 1);
      if (process.platform !== 'win32') assert.equal((fs.statSync(wbf).mode & 0o777).toString(8), '600');
      const before = fs.readFileSync(wbf, 'utf8');
      await sleep(2);
      register.connectClient('workbuddy', URL1, H);
      assert.equal(fs.readFileSync(wbf, 'utf8'), before);
      assert.equal(backups(path.dirname(wbf), 'mcp.json').length, 1);
      assert.equal(wbc(URL2).status, 'stale');
      const keep = { theme: 'dark', mcpServers: { other: { command: 'x' } } };
      fs.writeFileSync(wbf, j({ ...keep, mcpServers: { ...keep.mcpServers, mem0: { type: 'http', url: URL_NO_TOKEN } } }));
      assert.equal(wbc(URL1).status, 'stale', '无 token 视为需更新');
      fs.writeFileSync(wbf, j({ ...keep, mcpServers: { ...keep.mcpServers, mem0: { type: 'http', url: URL_OLD_TOKEN } } }));
      assert.equal(wbc(URL1).status, 'stale', '旧 token 视为需更新');
      assert.equal(register.connectClient('workbuddy', URL1, H), 'connected');
      assert.equal(JSON.parse(fs.readFileSync(wbf, 'utf8')).mcpServers.mem0.url, URL1);
    });
    await t('5 register', 'WorkBuddy：disconnect 只删 mem0；二次 disconnect 不再写备份', async () => {
      register.disconnectClient('workbuddy', H);
      const d = JSON.parse(fs.readFileSync(wbf, 'utf8'));
      assert.ok(!d.mcpServers.mem0); assert.ok(d.mcpServers.other); assert.equal(d.theme, 'dark');
      assert.equal(wbc(URL1).status, 'not_connected');
      const n = backups(path.dirname(wbf), 'mcp.json').length;
      await sleep(2);
      register.disconnectClient('workbuddy', H);
      assert.equal(backups(path.dirname(wbf), 'mcp.json').length, n);
    });
    await t('5 register', 'WorkBuddy：坏 JSON → 抛错且原文件不被覆盖', () => {
      fs.writeFileSync(wbf, '{ broken');
      assert.throws(() => register.connectClient('workbuddy', URL1, H));
      assert.equal(fs.readFileSync(wbf, 'utf8'), '{ broken');
    });
    const cfg = path.join(H, '.codex', 'config.toml');
    await t('5 register', 'Codex：未安装 → not_installed；替换旧 mem0 段、保留其它段、写备份', async () => {
      assert.equal(register.listClients(URL1, H).find((c) => c.id === 'codex').status, 'not_installed');
      fs.mkdirSync(path.dirname(cfg), { recursive: true });
      fs.writeFileSync(cfg, 'model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n\n[mcp_servers.mem0]\nurl = "http://old/mcp"\n\n[profiles.fast]\nmodel = "mini"\n', { mode: 0o600 });
      assert.equal(register.listClients(URL1, H).find((c) => c.id === 'codex').status, 'stale');
      assert.equal(register.connectClient('codex', URL1, H), 'connected');
      const s = fs.readFileSync(cfg, 'utf8');
      assert.equal((s.match(/\[mcp_servers\.mem0\]/g) || []).length, 1);
      assert.ok(!s.includes('http://old/mcp')); assert.ok(s.includes('[mcp_servers.other]')); assert.ok(s.includes('[profiles.fast]\nmodel = "mini"'));
      assert.equal(backups(path.dirname(cfg), 'config.toml').length, 1);
    });
    await t('5 register', 'Codex：重复 connect 幂等', () => {
      const a = fs.readFileSync(cfg, 'utf8');
      register.connectClient('codex', URL1, H); register.connectClient('codex', URL1, H);
      assert.equal(fs.readFileSync(cfg, 'utf8'), a);
    });
    await t('5 register', 'Codex：disconnect 删除 mem0 段，其它不动；再次 disconnect 无操作', async () => {
      register.disconnectClient('codex', H);
      const s = fs.readFileSync(cfg, 'utf8');
      assert.ok(!s.includes('mcp_servers.mem0')); assert.ok(s.includes('[mcp_servers.other]')); assert.ok(s.includes('[profiles.fast]'));
      const n = backups(path.dirname(cfg), 'config.toml').length;
      register.disconnectClient('codex', H);
      assert.equal(backups(path.dirname(cfg), 'config.toml').length, n);
      assert.equal(register.listClients(URL1, H).find((c) => c.id === 'codex').status, 'not_connected');
    });
    await t('5 register', 'Codex：保留 config.toml 的 0600 权限', () => {
      if (process.platform !== 'win32') assert.equal((fs.statSync(cfg).mode & 0o777).toString(8), '600');
    });
    await t('5 register', 'Codex：带行尾注释的表头 [mcp_servers.mem0] # x 也应被替换（register.js:87）', () => {
      fs.writeFileSync(cfg, '[mcp_servers.mem0] # added by hand\nurl = "http://old/mcp"\n');
      register.connectClient('codex', URL1, H);
      const s = fs.readFileSync(cfg, 'utf8');
      assert.equal((s.match(/^\s*\[mcp_servers\.mem0\]/gm) || []).length, 1, '出现重复表 → 无效 TOML:\n' + s);
    });
    await t('5 register', 'Codex：disconnect 也应删掉 [mcp_servers.mem0.env] 子表', () => {
      fs.writeFileSync(cfg, '[mcp_servers.mem0]\nurl = "x"\n\n[mcp_servers.mem0.env]\nA = "1"\n');
      register.disconnectClient('codex', H);
      const s = fs.readFileSync(cfg, 'utf8');
      assert.ok(!s.includes('mcp_servers.mem0'), '残留子表会隐式定义一个没有 url 的 mem0 server:\n' + s);
    });
    const codexStatus = (u) => register.listClients(u, H).find((c) => c.id === 'codex').status;
    await t('5 register', 'Codex：文件末尾无换行也能识别为 connected，connect 后仍是单个段且以换行结尾', () => {
      fs.writeFileSync(cfg, `[mcp_servers.mem0]\nurl = "${URL1}"`);
      assert.equal(codexStatus(URL1), 'connected');
      assert.equal(register.connectClient('codex', URL1, H), 'connected');
      const s = fs.readFileSync(cfg, 'utf8');
      assert.equal((s.match(/\[mcp_servers\.mem0\]/g) || []).length, 1);
      assert.ok(s.endsWith('\n'));
    });
    await t('5 register', 'Codex：mem0 段后紧跟其它 [section] / [[array]]，不能误删后面的段', () => {
      const tail = '[mcp_servers.other]\ncommand = "x"\n\n[[profiles.list]]\nname = "a"\n\n[profiles.fast]\nmodel = "mini"\n';
      fs.writeFileSync(cfg, `model = "o3"\n\n[mcp_servers.mem0]\nurl = "http://old/mcp"\n${tail}`);
      assert.equal(register.connectClient('codex', URL1, H), 'connected');
      const s = fs.readFileSync(cfg, 'utf8');
      assert.ok(!s.includes('http://old/mcp'));
      assert.ok(s.includes(tail.trim()), '后面的段被误删：\n' + s);
      assert.equal((s.match(/^\s*\[mcp_servers\.mem0\]/gm) || []).length, 1);
      assert.equal((s.match(/\[\[profiles\.list\]\]/g) || []).length, 1);
      register.disconnectClient('codex', H);
      const d = fs.readFileSync(cfg, 'utf8');
      assert.ok(!d.includes('mcp_servers.mem0'));
      assert.ok(d.includes(tail.trim()), 'disconnect 误删后面的段：\n' + d);
    });
    await t('5 register', 'Codex：mem0 段里的子表 [mcp_servers.mem0.env] / [[...tools]] 一并删除', () => {
      fs.writeFileSync(cfg, `[mcp_servers.mem0]\nurl = "http://old/mcp"\n\n[mcp_servers.mem0.env]\nA = "1"\n\n[[mcp_servers.mem0.tools]]\nname = "t"\n\n[profiles.fast]\nmodel = "mini"\n`);
      assert.equal(register.connectClient('codex', URL1, H), 'connected');
      const s = fs.readFileSync(cfg, 'utf8');
      assert.ok(!s.includes('mcp_servers.mem0.env'), '残留子表：\n' + s);
      assert.ok(!s.includes('mcp_servers.mem0.tools'), '残留数组子表：\n' + s);
      assert.ok(s.includes('[profiles.fast]'));
      assert.equal((s.match(/\[mcp_servers\.mem0\]/g) || []).length, 1);
    });
    await t('5 register', 'Codex：值/注释里的 "[" 不能被误判为段边界', () => {
      fs.writeFileSync(cfg, '[mcp_servers.mem0]\nurl = "http://127.0.0.1:1/mcp/[a]?token=old" # 注释里的 [b]\n\n[profiles.fast]\nmodel = "mini"\n');
      assert.equal(codexStatus(URL1), 'stale');
      assert.equal(register.connectClient('codex', URL1, H), 'connected');
      const s = fs.readFileSync(cfg, 'utf8');
      assert.ok(s.includes('[profiles.fast]\nmodel = "mini"'), '注释里的 [ 导致后面段被误删：\n' + s);
      assert.ok(!s.includes('/[a]'), '旧值未删除：\n' + s);
      // url 本身带 [ ] 也能正确判为 connected
      const u = 'http://127.0.0.1:3790/mcp/[a]?token=test-token-abc123';
      assert.equal(register.connectClient('codex', u, H), 'connected');
      assert.equal(codexStatus(u), 'connected');
    });
    await t('5 register', 'Codex：点号写法 mcp_servers.mem0.url 能识别；connect 先删再追加，不产生重复定义', () => {
      fs.writeFileSync(cfg, '[mcp_servers]\nmem0.url = "http://old/mcp"\n\n[profiles.fast]\nmodel = "mini"\n');
      assert.equal(codexStatus(URL1), 'stale');
      assert.equal(register.connectClient('codex', URL1, H), 'connected');
      const s = fs.readFileSync(cfg, 'utf8');
      assert.ok(!s.includes('mem0.url'), '点号写法未删除：\n' + s);
      assert.equal((s.match(/mem0/g) || []).length, 1, 'mem0 重复定义：\n' + s);
      assert.ok(s.includes('[profiles.fast]'));
      // 已是标准段但地址不同 → stale；地址相同 → connected
      assert.equal(codexStatus(URL2), 'stale');
      assert.equal(codexStatus(URL1), 'connected');
      // 内联点号写法 mem0 = { url = "..." } 同样识别并清除
      fs.writeFileSync(cfg, '[mcp_servers]\nmem0 = { url = "http://old/mcp" }\n');
      assert.equal(codexStatus(URL1), 'stale');
      assert.equal(register.connectClient('codex', URL1, H), 'connected');
      const t2 = fs.readFileSync(cfg, 'utf8');
      assert.ok(!t2.includes('{ url'), '内联点号写法未删除：\n' + t2);
      assert.equal((t2.match(/mem0/g) || []).length, 1);
      // 文件顶层的 mcp_servers.mem0.url = "..." 同样识别；disconnect 一并清除
      fs.writeFileSync(cfg, `mcp_servers.mem0.url = "http://old/mcp"\nmodel = "o3"\n`);
      assert.equal(codexStatus(URL1), 'stale');
      register.disconnectClient('codex', H);
      assert.equal(fs.readFileSync(cfg, 'utf8'), 'model = "o3"\n');
      assert.equal(codexStatus(URL1), 'not_connected');
    });
    await t('5 register', 'Codex：CRLF 文件保留 CRLF 风格（connect 追加段、disconnect 删除段）', () => {
      fs.writeFileSync(cfg, '[mcp_servers.mem0]\r\nurl = "http://old/mcp"\r\n\r\n[profiles.fast]\r\nmodel = "mini"\r\n');
      assert.equal(register.connectClient('codex', URL1, H), 'connected');
      const s = fs.readFileSync(cfg, 'utf8');
      assert.ok(s.includes(`[mcp_servers.mem0]\r\nurl = "${URL1}"\r\n`), '追加段没用 CRLF：\n' + JSON.stringify(s));
      assert.equal(s.replace(/\r\n/g, '').includes('\n'), false, '混入了裸 LF：\n' + JSON.stringify(s));
      register.disconnectClient('codex', H);
      const d = fs.readFileSync(cfg, 'utf8');
      assert.equal(d, '[profiles.fast]\r\nmodel = "mini"\r\n');
    });
    await t('5 register', 'Codex：内联表 [mcp_servers] mem0 = { url = "..." } 也能识别地址', () => {
      fs.writeFileSync(cfg, `[mcp_servers]\nmem0 = { url = "${URL1}", args = [] }\n`);
      assert.equal(codexStatus(URL1), 'connected');
      assert.equal(codexStatus(URL2), 'stale');
    });
    await t('5 register', 'Codex：空文件/仅空白的 connect 不产生开头空行', () => {
      for (const init of ['', '\n', '\r\n']) {
        fs.writeFileSync(cfg, init);
        register.connectClient('codex', URL1, H);
        const s = fs.readFileSync(cfg, 'utf8');
        assert.ok(s.startsWith('[mcp_servers.mem0]'), `开头多了空行：${JSON.stringify(s)}`);
      }
    });
    await t('5 register', 'stripTomlTable：不匹配的表原样返回（含 CRLF 与无末尾换行）', () => {
      for (const s of ['a = 1', 'a = 1\r\n[b]\r\nc = 2\r\n', '']) {
        assert.equal(register.stripTomlTable(s, 'mcp_servers.mem0'), s);
      }
    });
    await t('5 register', '未知客户端抛错', () => { assert.throws(() => register.connectClient('cursor', URL1, H)); });
    await t('5 register', '真实 HOME 下没有新产生的 mem0 备份', () => {
      if (REAL_HOME === H) return;
      for (const f of [path.join(REAL_HOME, '.claude.json'), path.join(REAL_HOME, '.codex', 'config.toml')]) {
        const dir = path.dirname(f);
        if (!fs.existsSync(dir)) continue;
        const recent = fs.readdirSync(dir).filter((x) => x.startsWith(path.basename(f) + '.mem0-backup-') && Number(x.split('-').pop()) > Date.now() - 600_000);
        assert.equal(recent.length, 0);
      }
    });
  }

  // =====================================================================
  // 5.5 重启参数（免安装版 / AppImage 不能直接 relaunch 临时解压目录）
  // =====================================================================
  {
    const dm = require(path.join(ROOT, 'src/main/datamove'));
    await t('5.5 relaunch', 'portable：用 PORTABLE_EXECUTABLE_FILE，参数去掉 argv[0]', () => {
      const o = dm.relaunchOptions({ PORTABLE_EXECUTABLE_FILE: 'C:\\Users\\u\\mem0.exe' }, 'C:\\Temp\\2f3a\\mem0.exe', ['C:\\Temp\\2f3a\\mem0.exe', '--no-sandbox']);
      assert.deepEqual(o, { execPath: 'C:\\Users\\u\\mem0.exe', args: ['--no-sandbox'] });
    });
    await t('5.5 relaunch', 'AppImage：用 APPIMAGE，参数去掉 argv[0]', () => {
      const o = dm.relaunchOptions({ APPIMAGE: '/home/u/mem0.AppImage' }, '/tmp/.mount_mem0/mem0', ['/tmp/.mount_mem0/mem0', '--x']);
      assert.deepEqual(o, { execPath: '/home/u/mem0.AppImage', args: ['--x'] });
    });
    await t('5.5 relaunch', '两个变量都有时优先免安装版；参数为空也不崩', () => {
      assert.deepEqual(dm.relaunchOptions({ PORTABLE_EXECUTABLE_FILE: 'p.exe', APPIMAGE: 'a.AppImage' }, 'x', ['x']),
        { execPath: 'p.exe', args: [] });
      assert.deepEqual(dm.relaunchOptions({ APPIMAGE: 'a.AppImage' }, 'x', []), { execPath: 'a.AppImage', args: [] });
      assert.deepEqual(dm.relaunchOptions({ APPIMAGE: 'a.AppImage' }, 'x'), { execPath: 'a.AppImage', args: [] });
    });
    await t('5.5 relaunch', '普通安装 / 开发运行：返回 undefined（照旧 app.relaunch()）', () => {
      assert.equal(dm.relaunchOptions({}, '/opt/mem0/mem0', ['/opt/mem0/mem0']), undefined);
      assert.equal(dm.relaunchOptions(undefined, '/opt/mem0/mem0', []), undefined);
      assert.equal(dm.relaunchOptions({ PORTABLE_EXECUTABLE_FILE: '' }, 'x', ['x']), undefined);
    });
    await t('5.5 relaunch', 'index.js 两处重启都走 relaunchOptions', () => {
      const main = fs.readFileSync(path.join(ROOT, 'src/main/index.js'), 'utf8');
      assert.equal((main.match(/app\.relaunch\(\);/g) || []).length, 1, '只应剩 relaunchApp 里的兜底调用');
      assert.match(main, /function relaunchApp\(\)[^}]*datamove\.relaunchOptions\(process\.env, process\.execPath, process\.argv\)/);
      assert.equal((main.match(/relaunchApp\(\); quitApp\(\);/g) || []).length, 2);
    });
  }


  // =====================================================================
  // 5.6 macOS 适配（平台判断 / 菜单 / 退出确认 / 托盘位置）
  // =====================================================================
  {
    const plat = require(path.join(ROOT, 'src/main/platform'));
    const tw = require(path.join(ROOT, 'src/main/tray-window'));
    await t('5.6 mac', '平台纯函数：isMac / 菜单 / Dock / 托盘图标路径', () => {
      assert.equal(plat.isMac('darwin'), true);
      assert.equal(plat.isMac('win32'), false);
      assert.equal(plat.isMac('linux'), false);
      assert.equal(plat.needsAppMenu('darwin'), true);
      assert.equal(plat.needsAppMenu('win32'), false);
      assert.equal(plat.shouldHideDock('darwin'), true);
      assert.equal(plat.shouldHideDock('win32'), false);
      assert.equal(plat.shouldShowDock('darwin'), true);
      assert.equal(plat.shouldShowDock('win32'), false);
      assert.equal(plat.trayIconPath({ dirname: '/a/main', rendererDir: '/a/renderer', platform: 'darwin' }), path.join('/a/main', 'assets', 'trayTemplate.png'));
      for (const p of ['win32', 'linux']) {
        assert.equal(plat.trayIconPath({ dirname: '/a/main', rendererDir: '/a/renderer', platform: p }), path.join('/a/renderer', 'tray.png'));
      }
    });
    await t('5.6 mac', '应用菜单：中文 mem0 / 编辑 / 窗口，退出 ⌘Q、关闭窗口 ⌘W', () => {
      const [mem, edit, winMenu] = plat.appMenuTemplate({ appName: 'mem0' });
      assert.equal(mem.label, 'mem0');
      assert.deepEqual(mem.submenu.map((i) => i.label || i.type), ['关于 mem0', 'separator', '隐藏 mem0', '隐藏其他', '全部显示', 'separator', '退出 mem0']);
      assert.equal(mem.submenu[mem.submenu.length - 1].accelerator, 'CmdOrCtrl+Q');
      assert.equal(mem.submenu.find((i) => i.label === '隐藏其他').role, 'hideOthers');
      assert.deepEqual(edit.submenu.map((i) => i.label || i.type), ['撤销', '重做', 'separator', '剪切', '复制', '粘贴', '全选']);
      assert.deepEqual(winMenu.submenu.map((i) => i.label), ['最小化', '关闭窗口']);
      assert.equal(winMenu.submenu[1].accelerator, 'CmdOrCtrl+W');
      assert.equal(winMenu.submenu[1].role, 'close');
    });
    await t('5.6 mac', 'shouldConfirmQuit：仅 macOS 用户主动退出确认；系统关机/注销不弹', () => {
      assert.equal(plat.shouldConfirmQuit({ platform: 'darwin' }), true);
      assert.equal(plat.shouldConfirmQuit({ platform: 'darwin', shutdown: true }), false);
      assert.equal(plat.shouldConfirmQuit({ platform: 'win32' }), false);
      assert.equal(plat.shouldConfirmQuit({ platform: 'linux' }), false);
      assert.equal(plat.shouldConfirmQuit(), process.platform === 'darwin');
    });
    await t('5.6 mac', 'computePosition：macOS 菜单栏在顶部，向下弹出且不越界', () => {
      const W = tw.PANEL_WIDTH + tw.INSET * 2;
      const wa = { x: 0, y: 25, width: 1920, height: 1055 }; // 顶部菜单栏 25px
      const b = tw.computePosition({ trayBounds: { x: 1500, y: 0, width: 22, height: 24 }, workArea: wa, width: W, height: 400 });
      assert.equal(b.edge, 'top');
      assert.equal(b.y, 25, '贴着菜单栏下沿向下弹出');
      assert.ok(b.x >= wa.x && b.x + b.width <= wa.x + wa.width);
      // 副屏（workArea 从 0 开始，无菜单栏）：仍在图标下方弹出且不越界
      const sub = tw.computePosition({ trayBounds: { x: 1500, y: 0, width: 22, height: 24 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 }, width: W, height: 400 });
      assert.equal(sub.y, 24); // 图标下沿向下弹出
      assert.ok(sub.y + sub.height <= 1080);
      // Windows 行为不变：任务栏在下 → 贴底
      const win = tw.computePosition({ trayBounds: { x: 1700, y: 1048, width: 24, height: 24 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, width: W, height: 400 });
      assert.equal(win.edge, 'bottom'); assert.equal(win.y + win.height, 1040);
    });
    await t('5.6 mac', '托盘模板图：16x16 / @2x 32x32 且被打包（src/**/*）', () => {
      const png = (f) => {
        const b = fs.readFileSync(f);
        assert.equal(b.toString('ascii', 1, 4), 'PNG', f);
        return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
      };
      assert.deepEqual(png(path.join(ROOT, 'src/main/assets/trayTemplate.png')), { w: 16, h: 16 });
      assert.deepEqual(png(path.join(ROOT, 'src/main/assets/trayTemplate@2x.png')), { w: 32, h: 32 });
      const pkg = require(path.join(ROOT, 'package.json'));
      assert.equal(pkg.scripts['dist:mac'], 'electron-builder --mac zip --arm64');
      assert.deepEqual(pkg.build.mac.target, [{ target: 'zip', arch: ['arm64'] }]);
      assert.equal(pkg.build.mac.icon, 'build/icon.png');
      assert.equal(pkg.build.mac.identity, null);
      assert.ok(pkg.build.files.includes('src/**/*'), 'src/**/* 覆盖 src/main/assets');
    });
    await t('5.6 mac', 'index.js 接线：模板图 / 菜单 / Dock / 系统关机豁免；Windows 不设菜单', () => {
      const main = fs.readFileSync(path.join(ROOT, 'src/main/index.js'), 'utf8');
      assert.match(main, /setTemplateImage\(true\)/);
      assert.match(main, /platform\.trayIconPath\(\{ dirname: __dirname, rendererDir: RENDERER \}\)/);
      assert.match(main, /Menu\.setApplicationMenu\(Menu\.buildFromTemplate\(platform\.appMenuTemplate/);
      assert.match(main, /w\.removeMenu\(\)/);
      assert.match(main, /app\.dock\.hide\(\)/);
      assert.match(main, /app\.dock\.show\(\)/);
      assert.match(main, /powerMonitor\.on\('shutdown'/);
      assert.match(main, /退出后将停止后台备份和 MCP 服务，确定退出？/);
      assert.match(main, /buttons: \['退出', '取消'\]/);
    });
    await t('5.6 mac', '托盘小窗：darwin 全工作区可见（含全屏），win32 不变', () => {
      const calls = [];
      class Win {
        constructor(opts) { this.opts = opts; this.webContents = { setWindowOpenHandler() {}, on() {}, once() {} }; }
        removeMenu() {}
        setVisibleOnAllWorkspaces(...a) { calls.push(['workspaces', ...a]); }
        setAlwaysOnTop(...a) { calls.push(['aot', ...a]); }
        loadFile() {}
        on() {}
        isDestroyed() { return false; }
      }
      const electron = {
        ipcMain: { on() {}, removeListener() {} }, BrowserWindow: Win,
        shell: { openExternal() {} }, screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
      };
      const pop = new tw.TrayPopover({ electron, tray: { getBounds: () => ({ x: 0, y: 0, width: 16, height: 16 }) }, preload: '/p.js', htmlPath: '/t.html', platform: 'darwin' });
      pop.ensureWindow(); // 构造时不建窗口，按需创建后再验证平台相关调用
      assert.deepEqual(calls.find((c) => c[0] === 'workspaces'), ['workspaces', true, { visibleOnFullScreen: true }]);
      assert.deepEqual(calls.find((c) => c[0] === 'aot'), ['aot', true, 'pop-up-menu']);
      assert.equal(pop.bounds().y, 16); // workArea 从 0 开始：贴着托盘图标下沿向下弹出
      calls.length = 0;
      const pop2 = new tw.TrayPopover({ electron, tray: { getBounds: () => ({ x: 0, y: 0, width: 16, height: 16 }) }, preload: '/p.js', htmlPath: '/t.html', platform: 'win32' });
      pop2.ensureWindow();
      assert.equal(calls.some((c) => c[0] === 'workspaces'), false, 'Windows 不调用 setVisibleOnAllWorkspaces');
      assert.equal(pop2.win.opts.thickFrame, false);
    });
  }

  // =====================================================================
  // 6. 窗口生命周期纯函数（关闭即销毁 / 托盘小窗闲置销毁）
  // =====================================================================
  {
    const tw = require(path.join(ROOT, 'src/main/tray-window'));
    await t('6 window', 'shouldDestroyIdle：收起满 60 秒才销毁；未收起 / 提前 / 时钟回拨都不销毁', () => {
      assert.equal(tw.IDLE_DESTROY_MS, 60_000);
      const t0 = 1_700_000_000_000;
      assert.equal(tw.shouldDestroyIdle(t0, t0 + tw.IDLE_DESTROY_MS - 1), false);
      assert.equal(tw.shouldDestroyIdle(t0, t0 + tw.IDLE_DESTROY_MS), true);
      assert.equal(tw.shouldDestroyIdle(0, t0), false);
      assert.equal(tw.shouldDestroyIdle(t0, t0 - 1), false);
      assert.equal(tw.shouldDestroyIdle(NaN, t0), false);
    });
    await t('6 window', 'popoverOptions：主窗口/托盘小窗都关闭 spellcheck，安全配置一致', () => {
      const pop = tw.popoverOptions({ preload: '/p.js' }).webPreferences;
      assert.equal(pop.spellcheck, false);
      const main = fs.readFileSync(path.join(ROOT, 'src/main/index.js'), 'utf8');
      assert.match(main, /webPreferences:\s*\{[^}]*spellcheck:\s*false/);
      assert.match(main, /backgroundColor:\s*nativeTheme\.shouldUseDarkColors \? '#262624' : '#FAF9F5'/);
      assert.match(main, /w\.once\('ready-to-show'/);
      assert.match(main, /w\.on\('closed',\s*\(\)\s*=>\s*\{[^}]*win = null/);
    });
    await t('6 window', 'shouldIgnoreClick 保持原语义（blur→click 300ms 守卫）', () => {
      assert.equal(tw.shouldIgnoreClick(1000, 1000), true);
      assert.equal(tw.shouldIgnoreClick(1000, 1300), false);
      assert.equal(tw.shouldIgnoreClick(0, 1000), false);
    });
    await t('6 window', 'TrayPopover 构造时不建窗口；show 按需创建，窗口不存在时方法安全', async () => {
      const { EventEmitter } = require('node:events');
      const created = [];
      class Win extends EventEmitter {
        constructor(opts) { super(); this.opts = opts; this.visible = false; this.destroyed = false; this.webContents = new EventEmitter(); this.webContents.send = () => {}; this.webContents.setWindowOpenHandler = () => {}; created.push(this); }
        loadFile() {} removeMenu() {} show() { this.visible = true; } hide() { this.visible = false; } focus() {}
        isVisible() { return this.visible; } isDestroyed() { return this.destroyed; } destroy() { this.destroyed = true; }
        setBounds() {} getSize() { return [356, 456]; } setSize() {} setOpacity() {}
        setAlwaysOnTop() {} setVisibleOnAllWorkspaces() {}
      }
      const listeners = [];
      const electron = {
        ipcMain: { on: (ch, fn) => listeners.push([ch, fn]), removeListener: (ch, fn) => { const i = listeners.findIndex((x) => x[0] === ch && x[1] === fn); if (i >= 0) listeners.splice(i, 1); } },
        BrowserWindow: Win, shell: { openExternal() {} },
        screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
      };
      const pop = new tw.TrayPopover({ electron, tray: { getBounds: () => ({ x: 0, y: 0, width: 16, height: 16 }) }, preload: '/p.js', htmlPath: '/t.html' });
      assert.equal(created.length, 0, '构造时不创建 BrowserWindow');
      assert.equal(pop.alive, false);
      assert.equal(listeners.filter((x) => x[0] === 'tray-ready').length, 1, 'IPC 监听只注册一次');
      assert.equal(pop.isVisible(), false);
      assert.doesNotThrow(() => pop.hide());
      assert.doesNotThrow(() => pop.destroy());
      assert.equal(created.length, 0);
      // 新的实例：show 才创建，且只创建一次
      const pop2 = new tw.TrayPopover({ electron, tray: { getBounds: () => ({ x: 0, y: 0, width: 16, height: 16 }) }, preload: '/p.js', htmlPath: '/t.html' });
      const p = pop2.show();
      assert.equal(created.length, 1, 'show 时创建窗口');
      await p; // 握手超时兜底（renderer 不回 ready）后结束
      assert.equal(pop2.alive, true);
      pop2.destroy();
      assert.equal(listeners.length, 0, 'destroy() 移除监听');
    });
  }

  // =====================================================================
  // 6. TrayStats 退路 Map（不依赖真实库）
  // =====================================================================
  {
    const { TrayStats, MAX_MEM_ENTRIES } = require(path.join(ROOT, 'src/main/stats'));
    const brokenStore = { db: { exec: () => { throw new Error('readonly'); } } };
    await t('6 stats', '退路 Map：上限 1000，超出删最旧；跨天删旧日期项', () => {
      let now = new Date(2026, 10, 11, 15, 0, 0).getTime();
      const s = new TrayStats(brokenStore, { now: () => now });
      assert.equal(s.persist, false);
      for (let i = 0; i < MAX_MEM_ENTRIES + 5; i++) { now += 1000; s.recordIngest({ conversationId: `c${i}`, source: 'x', added: 1 }); }
      assert.equal(s.mem.size, MAX_MEM_ENTRIES);
      assert.equal(s.mem.has('c0'), false, '最旧的被删');
      assert.equal(s.mem.has(`c${MAX_MEM_ENTRIES + 4}`), true);
      now += 24 * 3600_000;
      s.recordIngest({ conversationId: 'next', source: 'x', added: 1 });
      assert.deepEqual([...s.mem.keys()], ['next'], '跨天后只剩今天的项');
    });
    await t('6 stats', '退路 Map：写库成功后删除对应内存项', () => {
      const { Store: S } = require(path.join(ROOT, 'src/main/db'));
      const d = fs.mkdtempSync(path.join(T, 'stats-mem-'));
      const real = S.open(d);
      const conv = real.upsertConversation({
        source: 'claude-code', ingestMethod: 'local', externalId: 'm1', title: 'm',
        messages: [{ role: 'user', content: 'hi', createdAt: Date.now() }],
      });
      let fail = true;
      const wrapper = { db: { exec: (...a) => real.db.exec(...a), prepare: (...a) => { if (fail) throw new Error('readonly'); return real.db.prepare(...a); } } };
      const s = new TrayStats(wrapper);
      s.recordIngest({ conversationId: conv.id, source: 'claude-code', added: 2 });
      assert.equal(s.mem.has(conv.id), true, '写库失败时落到内存');
      fail = false;
      s.recordIngest({ conversationId: conv.id, source: 'claude-code', added: 1 });
      assert.equal(s.mem.has(conv.id), false, '写库成功后清掉内存项');
      assert.equal(s.addedToday(conv.id), 1);
      real.close();
    });
  }

  // =====================================================================
  // 6. 字体缺字检查（MiSans 子集 vs 界面用到的中文/全角标点）
  // =====================================================================
  {
    const cov = require(path.join(ROOT, 'scripts/check-font-coverage'));
    const css = fs.readFileSync(path.join(ROOT, 'src/renderer/fonts/fonts.css'), 'utf8');
    await t('6 font', 'parseUnicodeRange：单码点/区间/大小写/非法项', () => {
      assert.deepEqual(cov.parseUnicodeRange('U+3001-3002,U+FF1F'), [[0x3001, 0x3002], [0xff1f, 0xff1f]]);
      assert.deepEqual(cov.parseUnicodeRange(' u+4e00 '), [[0x4e00, 0x4e00]]);
      assert.deepEqual(cov.parseUnicodeRange('U+FF00-FFEF'), [[0xff00, 0xffef]]);
      assert.deepEqual(cov.parseUnicodeRange('U+3000,U+zz,U+4e00-'), [[0x3000, 0x3000]]);
      assert.deepEqual(cov.parseUnicodeRange(''), []);
    });
    await t('6 font', 'mergeRanges：重叠与相邻区间合并，端点判断正确', () => {
      const m = cov.mergeRanges([[0x3002, 0x3003], [0x3000, 0x3001], [0x3005, 0x3005]]);
      assert.deepEqual(m, [[0x3000, 0x3003], [0x3005, 0x3005]]);
      assert.equal(cov.isCovered(m, 0x3000), true);
      assert.equal(cov.isCovered(m, 0x3003), true);
      assert.equal(cov.isCovered(m, 0x3004), false);
      assert.equal(cov.isCovered([], 0x3000), false);
    });
    await t('6 font', 'misansRanges：只取 MiSans，忽略其它字体族与无 range 的 face', () => {
      const sample = [
        "@font-face { font-family: 'MiSans'; unicode-range: U+3001; }",
        "@font-face { font-family: 'DM Sans'; unicode-range: U+4e00; }",
        "@font-face { font-family: 'MiSans'; unicode-range: U+FF1F; }",
        "@font-face { font-family: 'MiSans'; src: url('x.woff2'); }",
      ].join('\n');
      assert.deepEqual(cov.misansRanges(sample), [[0x3001, 0x3001], [0xff1f, 0xff1f]]);
      // 真实 fonts.css 至少含 MiSans 的多个分片
      assert.ok(cov.misansRanges(css).length > 10);
    });
    await t('6 font', 'collectChars：只收集 3000-303F / FF00-FFEF / 4E00-9FFF', () => {
      const dir = fs.mkdtempSync(path.join(T, 'font-'));
      fs.mkdirSync(path.join(dir, 'sub'));
      fs.writeFileSync(path.join(dir, 'a.html'), '<p>中文？</p>abc');
      fs.writeFileSync(path.join(dir, 'sub/b.js'), "'，'; 'é'; '　'");
      const used = cov.collectChars(dir);
      assert.deepEqual([...used.keys()].sort((a, b) => a - b), [0x3000, 0x4e2d, 0x6587, 0xff0c, 0xff1f]);
      assert.deepEqual([...used.get(0x4e2d)], ['a.html']);
      assert.deepEqual([...used.get(0xff0c)], ['sub/b.js']);
    });
    await t('6 font', 'checkFontCoverage：缺字会出现在 missing 里，并带上所在文件', () => {
      const dir = fs.mkdtempSync(path.join(T, 'font2-'));
      fs.mkdirSync(path.join(dir, 'fonts'));
      fs.writeFileSync(path.join(dir, 'index.html'), '中文？');
      fs.writeFileSync(path.join(dir, 'fonts/fonts.css'),
        "@font-face { font-family: 'MiSans'; unicode-range: U+4E2D,U+6587; }");
      const r = cov.checkFontCoverage({ rendererDir: dir });
      assert.equal(r.used, 3);
      assert.equal(r.covered, 2);
      assert.deepEqual(r.missing.map((m) => m.char), ['？']);
      assert.deepEqual(r.missing[0].files, ['index.html']);
    });
    await t('6 font', 'checkFontCoverage：完整覆盖时 missing 为空', () => {
      const dir = fs.mkdtempSync(path.join(T, 'font3-'));
      fs.mkdirSync(path.join(dir, 'fonts'));
      fs.writeFileSync(path.join(dir, 'index.html'), '中文？');
      fs.writeFileSync(path.join(dir, 'fonts/fonts.css'),
        "@font-face { font-family: 'MiSans'; unicode-range: U+4E00-9FFF,U+FF00-FFEF; }");
      const r = cov.checkFontCoverage({ rendererDir: dir });
      assert.deepEqual(r.missing, []);
    });
    await t('6 font', '真实字体表能被解析出足够多的 MiSans 覆盖区间', () => {
      const merged = cov.misansRanges(css);
      assert.ok(merged.length > 100, `MiSans 合并区间过少：${merged.length}`);
      assert.ok(cov.isCovered(merged, 0x4e2d), '应覆盖常见汉字「中」');
    });
    await t('6 font', 'style.css 的 --font-ui / --font-mono 在 MiSans 之后有系统中文字体兜底', () => {
      const style = fs.readFileSync(path.join(ROOT, 'src/renderer/style.css'), 'utf8');
      for (const name of ['--font-ui', '--font-mono']) {
        const decl = new RegExp(`${name}:([^;]+);`).exec(style);
        assert.ok(decl, `缺少 ${name}`);
        const stack = decl[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''));
        const mi = stack.indexOf('MiSans');
        assert.ok(mi >= 0, `${name} 应包含 MiSans`);
        const tail = stack.slice(mi + 1);
        for (const f of ['PingFang SC', 'Microsoft YaHei UI', 'Microsoft YaHei']) {
          assert.ok(tail.includes(f), `${name} 的 MiSans 之后应包含 ${f}`);
        }
      }
    });
  }

  // =====================================================================
  // 6. 退出清理（不依赖 Electron 的纯函数）
  // =====================================================================
  {
    const quit = require(path.join(ROOT, 'src/main/quit'));
    await t('6 quit', 'cleanupForQuit：各项清理都执行，结束后 exit(0)', async () => {
      const done = [];
      let exitCode = null;
      await quit.cleanupForQuit({
        tasks: [() => done.push('ingest'), async () => { await sleep(5); done.push('mcp'); }, () => done.push('store')],
        exit: (c) => { exitCode = c; },
      });
      assert.deepEqual(done.sort(), ['ingest', 'mcp', 'store']);
      assert.equal(exitCode, 0);
    });
    await t('6 quit', 'cleanupForQuit：单项抛错/非函数不阻塞，仍 exit(0)', async () => {
      let exitCode = null;
      const done = [];
      await quit.cleanupForQuit({
        tasks: [() => { throw new Error('boom'); }, null, async () => { throw new Error('async boom'); }, () => done.push('ok')],
        exit: (c) => { exitCode = c; },
      });
      assert.deepEqual(done, ['ok']);
      assert.equal(exitCode, 0);
    });
    await t('6 quit', 'cleanupForQuit：清理超时也会 exit(0)（不等卡住的清理）', async () => {
      const t0 = Date.now();
      let exitCode = null;
      await quit.cleanupForQuit({
        tasks: [() => new Promise(() => {})], // 永不结束
        timeoutMs: 30,
        exit: (c) => { exitCode = c; },
      });
      assert.equal(exitCode, 0);
      assert.ok(Date.now() - t0 < 2000, '不应一直等下去');
    });
    await t('6 quit', '默认超时为 3 秒；index.js 退出分支：preventDefault + 防重入 + app.exit', () => {
      assert.equal(quit.QUIT_CLEANUP_TIMEOUT_MS, 3000);
      const main = fs.readFileSync(path.join(ROOT, 'src/main/index.js'), 'utf8');
      assert.match(main, /const \{ cleanupForQuit \} = require\('\.\/quit'\)/);
      assert.match(main, /if \(!quitCleanupStarted\) \{\s*quitCleanupStarted = true;\s*e\.preventDefault\(\);\s*runQuitCleanup\(\);/);
      assert.match(main, /runQuitCleanup = \(\) => cleanupForQuit\(\{[\s\S]*?exit: \(code\) => app\.exit\(code\)/);
      assert.match(main, /stopAndWait\(\)/);
      assert.match(main, /mcp\?\.close\(\)/);
      assert.match(main, /bridge\?\.close\(\)/);
      assert.match(main, /store\.close\(\)/);
    });
  }

  // =====================================================================
  // 6. 覆盖安装（NSIS：先结束旧版进程）
  // =====================================================================
  {
    const pkg = require(path.join(ROOT, 'package.json'));
    const nsh = path.join(ROOT, 'build/installer.nsh');
    await t('6 installer', 'nsis.include 指向 build/installer.nsh，其它安装配置不变', () => {
      assert.equal(pkg.build.nsis.include, 'build/installer.nsh');
      assert.equal(pkg.build.appId, 'dev.mem0.desktop');
      assert.equal(pkg.build.productName, 'mem0');
      assert.equal(pkg.build.nsis.oneClick, true);
      assert.equal(pkg.build.nsis.perMachine, false);
      assert.equal(pkg.build.nsis.createDesktopShortcut, true);
      assert.equal(pkg.build.nsis.shortcutName, 'mem0');
      assert.equal(pkg.build.nsis.installerIcon, 'build/icon.ico');
      assert.equal(pkg.build.nsis.uninstallerIcon, 'build/icon.ico');
      assert.ok(fs.existsSync(nsh), 'build/installer.nsh 应存在');
    });
    await t('6 installer', 'customInit 用 nsExec::Exec 执行 taskkill 并忽略返回值', () => {
      const s = fs.readFileSync(nsh, 'utf8');
      assert.match(s, /!macro customInit/);
      assert.match(s, /!macroend/);
      assert.match(s, /nsExec::Exec `taskkill \/F \/IM mem0\.exe \/T`/);
      assert.match(s, /Pop \$0/, '必须 Pop 掉 nsExec 的返回值，避免栈失衡');
      assert.doesNotMatch(s, /MessageBox|Abort|Quit/, '结束失败也不能中断安装');
    });
  }

  // =====================================================================
  // 6. 语法检查
  // =====================================================================
  await t('6 build', 'node --check 全部 .js', () => {
    const files = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.js')) files.push(p); } };
    for (const d of ['src', 'scripts', 'test']) walk(path.join(ROOT, d));
    const bad = [];
    for (const f of files) { try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (e) { bad.push(`${f}: ${e.stderr}`); } }
    assert.deepEqual(bad, []);
    results.push({ section: '6 build', name: `[信息] 已检查 ${files.length} 个文件`, ok: true });
  });

  // ---------- 输出 ----------
  finished = true; // 已跑到输出阶段，beforeExit 兜底不再触发
  let pass = 0; let fail = 0;
  let sec = '';
  for (const r of results) {
    if (r.section !== sec) { sec = r.section; console.log(`\n## ${sec}`); }
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      → ${r.err}`}`);
    r.ok ? pass++ : fail++;
  }
  console.log(`\n合计：${pass} 通过，${fail} 失败`);
  fs.rmSync(T, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
