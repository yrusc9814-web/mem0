; 覆盖安装前先结束旧版 mem0 进程，避免文件被占用导致安装失败。
; 只结束 mem0.exe（含子进程），忽略返回值（没在运行或权限不足都不影响安装）。
!macro customInit
  nsExec::Exec `taskkill /F /IM mem0.exe /T`
  Pop $0
!macroend

; 卸载时清掉开机自启动登记，避免残留（Electron 写入的 Run 值，appId / productName 两种键名）
!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.mem0"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "dev.mem0.desktop"
!macroend
