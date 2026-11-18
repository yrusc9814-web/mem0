// 真机联调辅助：在默认端口 3791 起桌面端 bridge（临时库），打印配对码，之后每 300ms 打印库里的会话
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
// 桌面端目录解析：MEM0_DESKTOP_DIR → ../mem0-desktop → ../desktop，取第一个 package.json.name === 'mem0-desktop' 的目录。
function resolveDesktopDir(base) {
  const candidates = [];
  if (process.env.MEM0_DESKTOP_DIR) candidates.push(path.resolve(process.env.MEM0_DESKTOP_DIR));
  candidates.push(path.resolve(base, '..', 'mem0-desktop'), path.resolve(base, '..', 'desktop'));
  for (const dir of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (pkg && pkg.name === 'mem0-desktop') return dir;
    } catch { /* 继续尝试下一个候选目录 */ }
  }
  return null;
}
const desktop = resolveDesktopDir(path.resolve(__dirname, '..'));
if (!desktop) {
  console.error('错误：未找到 mem0 桌面端目录（已尝试 MEM0_DESKTOP_DIR、../mem0-desktop、../desktop）。');
  process.exit(1);
}
const { Store } = require(path.join(desktop, 'src/main/db.js'));
const { startBridge } = require(path.join(desktop, 'src/main/bridge.js'));
(async () => {
  const store = Store.open(fs.mkdtempSync(path.join(os.tmpdir(), 'mem0-cr-')));
  const bridge = await startBridge(store, { version: 'e2e' });
  console.log(JSON.stringify({ code: bridge.newPairCode().code }));
  let last = '';
  setInterval(() => {
    const list = store.listConversations({ limit: 100 }).map((c) => ({ source: c.source, title: c.title, n: (store.getConversation(c.id).messages || []).length, first: (store.getConversation(c.id).messages || [])[0]?.content }));
    const s = JSON.stringify({ convs: list, status: bridge.status() });
    if (s !== last) { last = s; console.log(s); }
  }, 300);
  setTimeout(() => process.exit(0), 90_000);
})();
