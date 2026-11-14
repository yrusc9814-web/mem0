# mem0 浏览器插件

把网页 AI 对话实时备份到本机的 mem0 桌面端。Chrome / Edge（Manifest V3，Chrome 116+）。

支持：ChatGPT、Claude、Gemini、DeepSeek、豆包、元宝、Kimi、千问（qianwen.com / 通义 / chat.qwen.ai）、Google AI Mode（实验性）、Grok（grok.com）、Hark（hark.com/chat 与项目会话）。

## 安装（开发版）

1. 打开 `chrome://extensions`（Edge：`edge://extensions`），打开右上角「开发者模式」
2. 点「加载已解压的扩展程序」，选择本目录
3. 打开 mem0 桌面端 →「连接」→「配对」
4. 点浏览器工具栏的 mem0 图标，输入 6 位配对码

之后在支持的网站正常聊天，对话会自动出现在桌面端。图标上的角标：`!` 未配对，`×` 桌面端没开。

## 工作方式

- **只读页面**：内容脚本用 DOM 读出已经显示在页面上的对话，不调用任何网站的接口，不会代你发消息
- **只在这 9 个网站运行**：权限只申请了这些域名，不读取其它网页
- **数据只发往本机**：只连 `ws://127.0.0.1:3791`，没有遥测、没有云端
- **离线排队**：桌面端没开时，对话快照先存在插件里（每个会话只留最新一份，最多 500 个），桌面端打开后自动补发
- **流式回答**：回答生成过程中会多次上报，桌面端原地更新同一条消息
- **长对话懒加载**：页面只渲染了后半段时，桌面端会和已存内容对齐，不会覆盖掉前面的消息
- 弹窗里可以暂停全部备份，或单独关掉某个平台

## 目录

```
manifest.json
src/background.js        Service Worker：收快照、维护与桌面端的连接
src/bridge-client.js     连接、配对、离线队列、断线重连（不依赖 chrome.*，可单测）
src/content/platforms.js 各平台 DOM 适配器
src/content/engine.js    页面监听、文本提取、去重上报
src/popup/               弹窗：连接状态、配对、当前页状态、开关
test/run.mjs             自测（平台解析 + 与桌面端联调）
```

## 测试与打包

```bash
npm install
npm test        # 需要同级目录有 mem0-desktop 且已 npm install，才会跑联调部分
npm run zip     # 生成 dist/mem0-extension-<版本>.zip
```

## 网站改版了怎么办

各网站会不定期改 DOM，选择器失效时弹窗会显示「等待对话」或消息数为 0。
在 `src/content/platforms.js` 找到对应平台，按 F12 看新的结构，补一组选择器到候选列表最前面即可。
每个平台都是独立的一段配置：`conversationId(url)`、`turns(doc)`、`text(el, role)`、`title(doc)`。
