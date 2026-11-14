# mem0

保存 AI 客户端的会话数据和归纳记忆。

## 下载

| 平台 | 版本 | 文件 |
|---|---|---|
| Windows 安装版 | 0.5.5 | `windows/mem0 Setup 0.5.5.exe` |
| macOS（Apple 芯片） | 0.5.5 | `mac/mem0-0.5.5-arm64-mac.zip` |
| 浏览器插件（Chrome/Edge） | 0.1.4 | `extension/mem0-extension-0.1.4.zip` |

## 安装说明

- Windows：运行安装程序。覆盖安装前请在托盘菜单点「退出」，并确认任务管理器里没有残留的 mem0 进程。
- macOS：解压后拖入「应用程序」。此版本未经 Apple 公证，首次打开需右键选「打开」，或在终端执行 `xattr -cr /Applications/mem0.app`。
- 插件：解压后在 `chrome://extensions` 打开「开发者模式」，选「加载已解压的扩展程序」，选择解压出的文件夹。需桌面端在运行。

## 更新

- 桌面端 0.5.5：Claude 会话只保存用户和 AI 的正文，不再保存工具调用、工具结果、思考过程、系统提醒、命令输出、中断提示和压缩摘要；首次启动会把已保存的 Claude 会话按新规则重读一次。

## 源码

- `source/desktop/`：桌面端（Electron）。`npm install` 后 `npm start` 运行，`npm test` 跑测试；`npm run dist:win` / `npm run dist:mac` 打包。
- `source/extension/`：浏览器插件。`npm install` 后 `npm test` 跑测试，`node scripts/zip.mjs` 生成 zip。
