# mem0 桌面端

实时备份你所有的 AI 对话，本地全文搜索，并通过 MCP 让任意 AI 读取你的历史对话，换个 AI 也能接着聊。

- **电脑端 Agent**（自动读取本机会话，只读）：
  - Claude Code：`~/.claude/projects`
  - Codex：`~/.codex/sessions`、`archived_sessions`
  - DeepSeek Harness：`~/.dsh/sessions`（支持 zstd 压缩的会话文件）
  - Google Antigravity（IDE / App / CLI）：`~/.gemini/antigravity*/brain/*/.system_generated/logs/transcript.jsonl`。`.pb` 文件是加密的，所以读这份明文记录。Antigravity 只保留约 200 个会话，越早备份越好
  - ZCode：`~/.zcode/cli/db/db.sqlite`（只读打开）
  - DimCode / DimAgent（CLI 与桌面版）：`~/.dimcode/v2/dimcode.sqlite`（只读打开，子代理会话不单独保存）
- **网页端 AI**：ChatGPT、Claude、Gemini、DeepSeek、豆包、元宝、Kimi、千问、Google AI Mode（需配合 mem0 浏览器插件）
- **数据 100% 本地**：`~/.mem0/mem0.db`（SQLite + FTS5），无账号、无遥测、无云端中转

## 运行

需要 Node.js 22+。

```bash
npm install
npm start            # 开发运行
npm run selftest     # 核心功能自测（不需要 Electron）
```

## 打包

```bash
npm run dist:win     # Windows 安装包（NSIS，x64）
npm run dist:mac     # macOS dmg（需在 Mac 上执行）
npm run dist:linux   # AppImage
```

产物在 `dist/`。macOS 未签名包首次打开需右键 → 打开。

## 让 AI 读取你的记录

应用内「连接 → 让 AI 读取（MCP）」可一键接入 Claude Code、Codex（修改前自动备份原配置，需用户点击，不会自动改）。
其它支持 MCP 的客户端手动添加：

```json
{ "mcpServers": { "mem0": { "type": "http", "url": "http://127.0.0.1:3790/mcp?token=<你的访问密钥>" } } }
```

访问密钥首次启动时生成在数据目录的 `mcp-token` 文件里；应用内「连接 → 让 AI 读取（MCP）」的服务地址已带密钥，可直接复制。

提供 2 个工具（纯本地检索，不调用任何大模型）：

| 工具 | 作用 |
| --- | --- |
| `list_conversations` | 按日期范围（`from`/`to`，最多 31 天）列出会话目录：日期、来源、标题、时间、消息数，不含正文 |
| `recall` | 按 `query`（可加 `alternatives` 同义词）跨来源检索，返回带 `[用户]`/`[AI]` 标签和出处的原文片段；传回 `process_id` 时自动跳过已交付片段 |

## 浏览器插件协议

插件连接 `ws://127.0.0.1:3791/browser/v1`。首次在桌面端「连接」点「配对」生成 6 位配对码（2 分钟有效），插件输入后获得长期 token。

```text
插件 → 桌面  { type:'hello', protocol:1, token? , pairCode?, extensionId, extensionVersion }
桌面 → 插件  { type:'welcome', token?, desktopVersion } | { type:'error', code }
插件 → 桌面  { type:'upsert', reqId, conversation:{ platform, externalId, title, url, messages:[{role,content,createdAt}], authoritative } }
桌面 → 插件  { type:'ack', reqId, ok, changed, added, error? }
插件 → 桌面  { type:'ping' }   桌面 → 插件 { type:'pong' }
```

`platform` 取值：chatgpt、claude、gemini、deepseek、doubao、yuanbao、kimi、qianwen、google-ai-mode。
同一 `externalId` 反复上报是幂等的：新消息追加，流式变化的回答原地更新；`authoritative: true` 时会删掉多余尾部（用于编辑重发）。
网页只渲染了后半段消息（懒加载）时，桌面端会按内容和已存消息对齐，不会覆盖前面的内容。

## 安全

- MCP 与插件桥只监听 `127.0.0.1`，校验 Host 与 Origin，普通网页无法连接（防 DNS rebinding）
- MCP 还要求访问密钥（`Authorization: Bearer <token>` 或 `?token=<token>`），缺失或错误返回 401
- 插件桥只接受 `chrome-extension://` 等扩展来源，并要求配对 token（只存哈希）
- 渲染进程开启 sandbox + contextIsolation + 严格 CSP，IPC 校验来源页面

## 目录结构

```
src/main/
  index.js          Electron 主进程：窗口、托盘、IPC、服务启动
  db.js             SQLite 存储与全文检索
  ingest.js         本机会话增量采集（轮询 size+mtime）
  sources/          各 Agent 的会话解析器（claude-code、codex、deepseek-harness、antigravity、zcode、dimcode）
  mcp.js            本地 MCP 服务
  bridge.js         浏览器插件 WebSocket 桥
  register.js       一键写入 Claude Code / Codex 的 MCP 配置
src/preload/        安全 IPC 暴露
src/renderer/       界面（原生 JS，无框架）
scripts/selftest.js 核心自测
```

## 新增一个本机 Agent

在 `src/main/sources/` 加一个文件，导出 `{ id, label, discover(root), read(file, root) }`，`read` 返回
`{ source, externalId, title?, workspace?, messages:[{role, content, createdAt}], ingestMethod:'local' }`，
可选导出 `exists(root)`、`signature(file)`（多文件数据库用）；`read` 也可以返回数组。然后在 `ingest.js` 的 `ADAPTERS`、`paths.js` 的 `sourceRoots`、`db.js` 的 `LOCAL_SOURCES` 里登记。
