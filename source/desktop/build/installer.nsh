; 覆盖安装前先结束旧版 mem0 进程，避免文件被占用导致安装失败。
; 只结束 mem0.exe（含子进程），忽略返回值（没在运行或权限不足都不影响安装）。
!macro customInit
  nsExec::Exec `taskkill /F /IM mem0.exe /T`
  Pop $0
!macroend
