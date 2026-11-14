// 真机联调辅助：在默认端口 3791 起桌面端 bridge（临时库），打印配对码，之后每 300ms 打印库里的会话
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const desktop = path.resolve(__dirname, '..', '..', 'mem0-desktop');
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
