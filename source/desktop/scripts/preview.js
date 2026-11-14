'use strict';
/**
 * 界面预览服务器（开发用）：不启动 Electron，把渲染进程页面放进普通浏览器里看。
 * 用真实的 Store / MCP / 插件桥 + 一批演示数据，IPC 改成 HTTP。
 *   node scripts/preview.js   → http://127.0.0.1:3799/
 * 只用于截图/调样式，不要用它来备份真实数据。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mem0-preview-'));
process.env.HOME = tmp;
process.env.USERPROFILE = tmp;
process.env.MEM0_DATA_DIR = path.join(tmp, 'data');
for (const d of ['.claude/projects', '.codex/sessions', '.dsh/sessions', '.zcode/cli/db']) fs.mkdirSync(path.join(tmp, d), { recursive: true });

const { Store, WEB_SOURCES } = require('../src/main/db');
const { LocalIngestor } = require('../src/main/ingest');
const { startMcpServer } = require('../src/main/mcp');
const { startBridge } = require('../src/main/bridge');
const { dataDir, sourceRoots } = require('../src/main/paths');
const register = require('../src/main/register');
const { TrayStats } = require('../src/main/stats');

const store = Store.open(dataDir());
const ingestor = new LocalIngestor(store, sourceRoots(), { intervalMs: 60_000 });
// 托盘小窗演示：今日互通次数。mcp.js / db.js 提供 store.getMcpCallsToday() 后自动用真实值
let demoMcpCalls = 12;
const trayStats = new TrayStats(store, { mcpCallsToday: () => (typeof store.getMcpCallsToday === 'function' ? store.getMcpCallsToday() : demoMcpCalls) });
ingestor.on('saved', (e) => trayStats.recordIngest(e));
// 演示数据：今天已被 AI 读取 12 次（临时库，不影响真实数据）
if (typeof store.bumpMcpCall === 'function') for (let i = 0; i < 12; i++) store.bumpMcpCall();

const H = 3600_000;
const now = Date.now();
// 一条很长的会话：8+ 个提问，AI 回复覆盖各种 Markdown 元素，带工作区路径
const LONG_MD = (n) => `## 第 ${n} 步：思路

先说结论：**可以做**，但要注意增量游标不能回退。下面分几点：

- 读取 \`session_catalog_entries\` 拿到会话列表
- 按 \`orderKey\` 排序消息
- **跳过** 子代理与 tool_result

1. 先建索引
2. 再写入 FTS
3. 最后更新游标

> 注意：不要修改原始 sqlite 文件，只读打开。

\`\`\`js
const db = new DatabaseSync(file, { readOnly: true });
const rows = db.prepare('SELECT id, role FROM messages WHERE session_id = ?').all(sid);
\`\`\`

### 小结

第 ${n} 步完成后，运行 \`npm test\` 验证。`;
const LONG_QS = [
  '帮我重构 mem0 的记录页，左侧列表要支持多选来源筛选',
  '筛选菜单点外面或者按 Esc 要能关掉',
  '首页总存储的图例超过 4 个来源时折叠成 +N',
  '详情页右侧加一个提问目录，每个提问一个刻度',
  '工作区路径用一个问号按钮，悬停显示，点击复制',
  'AI 回复用文楷衬线，用户提问用无衬线',
  '代码块右上角加复制按钮',
  '搜索关键词要高亮',
  '深色模式下浮层要用暖色毛玻璃',
  '最后检查一下 CSP 有没有被破坏',
];
const demo = [
  ['claude-code', 'local', 'mem0 界面 v2 重构（长会话）', '/Users/miemie/code/mem0-desktop', 0.1,
    LONG_QS.flatMap((q, i) => [['user', q], ['assistant', LONG_MD(i + 1)]])],
  ['chatgpt-web', 'browser-extension', 'XSS 渲染安全测试', null, 0.6, [
    ['user', '这段会不会被执行？<img src=x onerror=alert(1)> 还有 [x](javascript:alert(1))'],
    ['assistant', '不会执行：<img src=x onerror=alert(1)> 只当文字显示，[x](javascript:alert(1)) 也不会变成链接。正常链接如 [官网](https://example.com) 可以点。'],
  ]],
  ['claude-code', 'local', '给 mem0 加 DimCode 数据源', '/Users/miemie/code/mem0-desktop', 0.3, [
    ['user', '帮我给 mem0 加一个 DimCode 的数据源，数据在 ~/.dimcode/v2/dimcode.sqlite'],
    ['assistant', '好的。我先看一下表结构：sessions、messages、session_catalog_entries。\n\n```js\nconst rows = db.prepare(`SELECT id, role, parts FROM messages WHERE session_id = ? ORDER BY orderKey`).all(sid);\n```\n\ntopLevel = 0 的是子代理，跳过。'],
    ['user', '子代理的对话也跳过吧，只要主会话'],
    ['assistant', '已经跳过了，tool_result 和 reasoning 也不存，连续的助手消息会合并成一条。'],
  ]],
  ['chatgpt-web', 'browser-extension', 'Electron 打包 Windows 安装包', null, 1.2, [
    ['user', 'electron-builder 怎么打 Windows 的 nsis 安装包？'],
    ['assistant', '在 package.json 的 build 字段里配置 win.target = "nsis"，然后运行 `npx electron-builder --win`。'],
  ]],
  ['deepseek-web', 'browser-extension', 'SQLite FTS5 中文分词', null, 3, [
    ['user', 'SQLite FTS5 搜中文效果不好怎么办'],
    ['assistant', '用 trigram 分词器：`tokenize = "trigram"`。少于 3 个字的查询退回 LIKE。'],
  ]],
  ['codex', 'local', '重构 bridge 的配对逻辑', '/Users/miemie/code/mem0-desktop', 5, [
    ['user', '配对码输错 5 次就作废'],
    ['assistant', '已改：bridge.js 里记录失败次数，达到 5 次后清除当前配对码。'],
  ]],
  ['kimi-web', 'browser-extension', '东京红叶最佳观赏地', null, 20, [
    ['user', '11 月中旬东京哪里看红叶最好？'],
    ['assistant', '推荐六义园、昭和纪念公园和高尾山。六义园晚上有点灯活动。'],
  ]],
  ['doubao-web', 'browser-extension', '周末做饭清单', null, 30, [
    ['user', '帮我列一个两人份的周末做饭清单'],
    ['assistant', '周六：番茄牛腩、蒜蓉西兰花。周日：咖喱鸡、味噌汤。'],
  ]],
  ['zcode', 'local', '修复 MCP 413 断连', 'C:\\Users\\VIVI\\Documents\\Projects\\very-long-workspace-folder-name\\mem0-desktop', 48, [
    ['user', 'MCP 返回 413 之后下一个请求 ECONNRESET'],
    ['assistant', '返回 413 时加上 connection: close 并销毁请求即可。'],
  ]],
  ['gemini-web', 'browser-extension', '日语敬语区别', null, 72, [
    ['user', '「いらっしゃいませ」和「ようこそ」有什么区别'],
    ['assistant', '前者是店员迎客的固定用语，后者更正式，用于欢迎来访。'],
  ]],
  ['claude-web', 'browser-extension', '产品命名头脑风暴', null, 96, [
    ['user', 'mem0 和开源的 Mem0 重名了，帮我想几个新名字'],
    ['assistant', '可以考虑：Recall、对话匣、Echoes、Tidemark。'],
  ]],
];
demo.forEach(([source, ingestMethod, title, workspace, hoursAgo, msgs], i) => {
  const t0 = now - hoursAgo * H;
  const r = store.upsertConversation({
    source, ingestMethod, externalId: `demo-${i}`, title, workspace,
    url: ingestMethod === 'browser-extension' ? 'https://example.com/' : undefined,
    messages: msgs.map(([role, content], k) => ({ role, content, createdAt: t0 + k * 60_000 })),
  });
  // 演示「存入 X 条新消息」：最近 1 小时内的会话记一笔今天的备份增量（真实应用里由 ingest 'saved' 事件记录）
  if (hoursAgo < 1) trayStats.recordIngest({ conversationId: r.id, source, added: Math.min(r.added, 2 + i) });
});

(async () => {
  const services = { mcp: { ok: false, error: null, url: null }, bridge: { ok: false, error: null, url: null } };
  try { const m = await startMcpServer(store, { port: 3790 }); Object.assign(services.mcp, { ok: true, url: m.url }); } catch (e) { services.mcp.error = e.message; }
  let bridge = null;
  try { bridge = await startBridge(store, { port: 3791, version: require('../package.json').version }); Object.assign(services.bridge, { ok: true, url: 'ws://127.0.0.1:3791/browser/v1' }); } catch (e) { services.bridge.error = e.message; }
  await ingestor.scanOnce();

  const fullState = () => ({
    version: require('../package.json').version,
    dataDir: dataDir(),
    stats: store.stats(),
    localSources: ingestor.getStatus(),
    webSources: WEB_SOURCES.map((p) => ({ id: `${p}-web`, platform: p, enabled: store.isSourceEnabled(`${p}-web`) })),
    services,
    bridge: bridge ? bridge.status() : { connected: 0, paired: 0 },
    clients: services.mcp.url ? register.listClients(services.mcp.url) : [],
    manualConfig: services.mcp.url ? register.manualConfig(services.mcp.url) : '',
    mcpCallsToday: trayStats.mcpCallsToday(),
  });
  const trayState = () => {
    const local = ingestor.getStatus();
    const errors = local.filter((x) => x.enabled && x.error).length + (services.mcp.ok ? 0 : 1) + (services.bridge.ok ? 0 : 1);
    return { ...trayStats.snapshot({ limit: 4 }), errors, lastSyncAt: Math.max(0, ...local.map((x) => x.lastScanAt || 0)) || Date.now(), scanning: false };
  };
  // 托盘小窗动作只记录下来（无头预览里没有真实窗口），测试通过 GET /ipc-log 读取
  const ipcLog = [];
  const logged = (ch, fn = () => true) => (...args) => { ipcLog.push({ ch, args, at: Date.now() }); return fn(...args); };
  const ipc = {
    state: () => fullState(),
    list: (o) => store.listConversations(o || {}),
    search: (q, o) => store.search(q, o || {}),
    read: (id) => store.getConversation(id, { limit: 2000 }),
    remove: () => false,
    setSource: (s, en) => { store.setSourceEnabled(s, !!en); return fullState(); },
    rescan: async () => { await ingestor.scanOnce(); return fullState(); },
    connectClient: () => fullState(),
    disconnectClient: () => fullState(),
    pairCode: () => (bridge ? bridge.newPairCode() : null),
    revokeExtensions: () => fullState(),
    setTheme: (p) => p, copy: () => true, openDataDir: () => true, openUrl: () => true,
    'tray.state': () => trayState(),
    'tray.rescan': logged('tray.rescan', async () => { await new Promise((r) => setTimeout(r, 300)); await ingestor.scanOnce(); return trayState(); }),
    'tray.resize': logged('tray.resize'),
    'tray.hide': logged('tray.hide'),
    'tray.openMain': logged('tray.openMain'),
    'tray.openConversation': logged('tray.openConversation'),
    'tray.quit': logged('tray.quit'),
  };

  // IPC → HTTP。on* 订阅存进 window.__mem0Handlers，测试用 window.__emit(channel, payload) 模拟主进程推送
  const shim = `(() => {
    const handlers = window.__mem0Handlers = {};
    const sub = (ch) => (fn) => { (handlers[ch] ||= []).push(fn); return () => { handlers[ch] = handlers[ch].filter((f) => f !== fn); }; };
    window.__emit = (ch, p) => (handlers[ch] || []).forEach((f) => f(p));
    const SUBS = { onChanged: 'changed', onNavigate: 'navigate', onMcpCalls: 'mcp-calls', onState: 'tray-state' };
    const invoke = (ch) => (...args) => fetch('/ipc', { method: 'POST', body: JSON.stringify({ ch, args }) }).then(r => r.json()).then(r => { if (r.error) throw new Error(r.error); return r.result; });
    const make = (prefix) => new Proxy({}, { get: (_, k) => {
      if (k === 'tray' && !prefix) return make('tray.');
      if (SUBS[k]) return sub(SUBS[k]);
      return invoke(prefix + String(k));
    } });
    window.mem0 = make('');
  })();`;
  const dir = path.join(__dirname, '..', 'src', 'renderer');
  const types = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png',
    '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
  };
  http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/ipc') {
      let body = ''; for await (const c of req) body += c;
      const { ch, args } = JSON.parse(body);
      try { res.end(JSON.stringify({ result: await ipc[ch](...(args || [])) })); } catch (e) { res.end(JSON.stringify({ error: e.message })); }
      return;
    }
    if (req.url === '/shim.js') { res.setHeader('content-type', 'text/javascript'); return res.end(shim); }
    if (req.url === '/ipc-log') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(ipcLog)); }
    if (req.method === 'POST' && req.url === '/ipc-log/reset') { ipcLog.length = 0; return res.end('{}'); }
    if (req.method === 'POST' && req.url === '/demo/mcp-call') { if (typeof store.bumpMcpCall === 'function') store.bumpMcpCall(); else demoMcpCalls++; res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ today: trayStats.mcpCallsToday() })); }
    // 支持子目录（fonts/、brand/sources/ 等）；去掉查询串并解码，禁止越出 renderer 目录
    let rel;
    try { rel = decodeURIComponent(req.url.split(/[?#]/)[0]); } catch { res.statusCode = 400; return res.end(); }
    const f = path.join(dir, rel === '/' ? 'index.html' : path.normalize(rel).replace(/^[/\\]+/, ''));
    if ((f !== dir && !f.startsWith(dir + path.sep)) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.statusCode = 404; return res.end(); }
    let data = fs.readFileSync(f);
    if (f.endsWith('.html')) data = String(data).replace(/(content="default-src 'none';)/, "$1 connect-src 'self';").replace('<head>', '<head><script src="/shim.js"></script>');
    res.setHeader('content-type', types[path.extname(f)] || 'application/octet-stream');
    res.end(data);
  }).listen(3799, '127.0.0.1', () => console.log('preview: http://127.0.0.1:3799/'));
})();
