; The Windows scheduled task is registered outside the app, so the app has to
; take it away again when it is uninstalled. A task that is not there is
; not an error, so the exit code is ignored.
!macro customUnInstall
  nsExec::Exec 'schtasks /Delete /TN "Drive Mirror Sync" /F'
!macroend