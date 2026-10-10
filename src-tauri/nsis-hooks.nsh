; FlowZ NSIS installer hooks
; 安装/卸载前清理残留进程，避免文件被占用导致安装卡住。
; 注意：sing-box.exe 是应用手工 spawn 的子进程，Tauri 默认的
; CheckIfAppIsRunning 只处理主程序 flowz.exe，这里需一并处理。

!macro KILL_FLOWZ_PROCESSES
  ; 先杀主程序（连子进程树一起杀），避免它重新拉起 sing-box
  nsExec::ExecToLog 'taskkill /F /T /IM flowz.exe'
  Pop $0
  ; 再杀 sing-box（含 TUN 模式下由特权 supervisor 拉起的实例；
  ; 安装器本身以管理员运行，具备权限）
  nsExec::ExecToLog 'taskkill /F /T /IM sing-box.exe'
  Pop $0
  ; 等待句柄释放，避免删除文件时仍报占用
  Sleep 500
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro KILL_FLOWZ_PROCESSES
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro KILL_FLOWZ_PROCESSES
!macroend
