; A reinstall can leave an older bundle beside the new one. Remove only bundled archives in
; target folders that already exist; installed daemons and the preuninstall hook are untouched.
!macro NSIS_HOOK_PREINSTALL
  IfFileExists "$INSTDIR\daemon\win-x64\*" 0 agent_tycoon_daemon_linux_x64
  Delete "$INSTDIR\daemon\win-x64\agent-tycoon-daemon-*.tar.gz"
agent_tycoon_daemon_linux_x64:
  IfFileExists "$INSTDIR\daemon\linux-x64\*" 0 agent_tycoon_daemon_preinstall_done
  Delete "$INSTDIR\daemon\linux-x64\agent-tycoon-daemon-*.tar.gz"
agent_tycoon_daemon_preinstall_done:

  ; The old Pixel Office (product "Pixel Office", identifier dev.cldgui.pixeloffice, no installer hooks)
  ; is a separate install: remove it silently so one app remains. Its silent uninstaller closes
  ; pixel-office.exe itself and keeps its app data (the delete-data box is never ticked when silent);
  ; the new app copies that data on its first launch. Run in place (_?=) like Tauri's own reinstall,
  ; so the uninstaller and the folder are deleted here afterwards.
  ReadRegStr $R8 HKCU "Software\cldgui\Pixel Office" ""
  StrCmp $R8 "" agent_tycoon_pixel_office_done
  IfFileExists "$R8\uninstall.exe" 0 agent_tycoon_pixel_office_done
  DetailPrint "Removing the old Pixel Office app"
  ClearErrors
  ExecWait '"$R8\uninstall.exe" /S _?=$R8' $0
  IfErrors agent_tycoon_pixel_office_done
  StrCmp $0 "0" 0 agent_tycoon_pixel_office_done
  Delete "$R8\uninstall.exe"
  RMDir "$R8"
  DeleteRegKey HKCU "Software\cldgui\Pixel Office"
agent_tycoon_pixel_office_done:
!macroend

; Remove only a daemon that this Windows app installed. The existence check keeps WSL-only offices out.
!macro NSIS_HOOK_PREUNINSTALL
  ; An update runs the old uninstaller too; it must retain the daemon.
  StrCmp $UpdateMode 1 agent_tycoon_daemon_uninstall_done
  IfFileExists "$LOCALAPPDATA\AgentTycoon\bin\agty.cmd" +2 0
  Goto agent_tycoon_daemon_uninstall_done

  ; Backticks delimit the command: NSIS has no doubled-quote escape, and the PowerShell inside needs both quote kinds.
  ; The manager removes bin\agty.cmd. Start its current private Node directly, so cmd.exe never holds
  ; that launcher open. `current` and the version directory come from install.json.
  StrCpy $R9 "--program"
  StrCmp $DeleteAppDataCheckboxState 1 0 +2
  StrCpy $R9 "--reset"
  DetailPrint "Removing the Agent Tycoon daemon ($R9)"
  DetailPrint "This may take a minute or two while Agent Tycoon stops agents and its service."
  nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$root = Join-Path $$env:LOCALAPPDATA 'AgentTycoon'; try { $$record = Get-Content -Raw -LiteralPath (Join-Path $$root 'install.json') | ConvertFrom-Json; $$version = $$record.current; $$base = Join-Path (Join-Path $$root 'versions') $$version; $$node = Join-Path $$base 'node\node.exe'; $$manager = Join-Path $$base 'cld\install\manager.mjs'; if ((Test-Path -LiteralPath $$node -PathType Leaf) -and (Test-Path -LiteralPath $$manager -PathType Leaf)) { & $$node $$manager uninstall --if-installed-by gui --yes --stop-agents $R9; exit $$LASTEXITCODE } } catch {} ; exit 0"`
  Pop $0
  DetailPrint "Agent Tycoon daemon cleanup exit code: $0"
  StrCmp $0 "0" agent_tycoon_daemon_uninstall_done
  MessageBox MB_ICONEXCLAMATION|MB_OK "Agent Tycoon was not fully removed (exit code $0). End node.exe in Task Manager, then delete %LOCALAPPDATA%\AgentTycoon and %USERPROFILE%\.config\agent-tycoon." /SD IDOK
agent_tycoon_daemon_uninstall_done:
!macroend

; Delete application data also removes the folders of the old identifier (until 11-01), which the
; first launch copied from and left in place.
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    RmDir /r "$APPDATA\dev.cldgui.pixeloffice"
    RmDir /r "$LOCALAPPDATA\dev.cldgui.pixeloffice"
  ${EndIf}
!macroend
