# mem0

保存 AI 客户端的会话数据和归纳记忆。

## 下载

| 平台 | 版本 | 文件 |
|---|---|---|
| Windows 安装版 | 0.6.1 | `windows/mem0 Setup 0.6.1.exe` |
| macOS（Apple 芯片） | 0.6.1 | `mac/mem0-0.6.1-arm64-mac.zip` |
| 浏览器插件（Chrome/Edge） | 0.1.5 | `extension/mem0-extension-0.1.5.zip` |

## 安装说明

- Windows：运行安装程序。覆盖安装前请在托盘菜单点「退出」，并确认任务管理器里没有残留的 mem0 进程。
- macOS：解压后拖入「应用程序」。此版本未经 Apple 公证，首次打开需右键选「打开」，或在终端执行 `xattr -cr /Applications/mem0.app`。
- 插件：解压后在 `chrome://extensions` 打开「开发者模式」，选「加载已解压的扩展程序」，选择解压出的文件夹。需桌面端在运行。

## 更新

- 桌面端 0.6.1：修复 AI 自动整理不产出踩坑经验卡的问题（整理提示写全推进事项与踩坑卡的字段结构，并兼容模型返回的常见别名字段）；首次启动会把已保存的 DeepSeek Harness 会话按新解析规则重读一次，清掉残留的思考过程和工具调用，已删除的会话不会恢复。
- 桌面端 0.6.0：记忆与推进事项改为 v4 双栏；多源会话剔除工具调用等噪音并剥离子代理；4 个 MCP 工具按需读写；后台静默 AI 自动整理，支持 OpenAI 双协议（Chat Completions / Responses）与按模型动态识别推理档位；Windows 开机静默自启动（设置里开关，默认关闭）。
- 浏览器插件 0.1.5：剔除 Gemini 的思考过程节点。
- 桌面端 0.5.5：Claude 会话只保存用户和 AI 的正文，不再保存工具调用、工具结果、思考过程、系统提醒、命令输出、中断提示和压缩摘要；首次启动会把已保存的 Claude 会话按新规则重读一次。

## 源码

- `source/desktop/`：桌面端（Electron）。`npm install` 后 `npm start` 运行，`npm test` 跑测试；`npm run dist:win` / `npm run dist:mac` 打包。
- `source/extension/`：浏览器插件。`npm install` 后 `npm test` 跑测试，`node scripts/zip.mjs` 生成 zip。
