# Makes the journal server start automatically (hidden) every time you log in to Windows,
# and starts it right now. Re-running this is safe. Undo with uninstall-autostart.ps1.
#
# Run:  right-click this file > "Run with PowerShell"
#   or: powershell -ExecutionPolicy Bypass -File install-autostart.ps1

$dir  = $PSScriptRoot
$name = "SPX Journal - " + (Split-Path $dir -Leaf)
$vbs  = Join-Path $dir "start-hidden.vbs"

$action   = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$vbs`"" -WorkingDirectory $dir
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
              -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings `
  -Description "Keeps the trade journal server in $dir running." -Force | Out-Null

# start it now unless this folder's server is already running
$running = Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" |
  Where-Object { $_.CommandLine -like "*$dir\keep-running.cmd*" }
if (-not $running) { Start-ScheduledTask -TaskName $name }

Write-Host "Installed '$name'. The server now starts automatically when you log in."
Write-Host "Logs: $dir\server.log"
