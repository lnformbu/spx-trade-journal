# Starts the Schwab Downloads watcher now and every time you log in (hidden).
# Run once:  powershell -ExecutionPolicy Bypass -File install-schwab-watcher.ps1
# Undo:      powershell -ExecutionPolicy Bypass -File uninstall-schwab-watcher.ps1

$dir  = $PSScriptRoot
$name = "SPX Journal - Schwab watcher"
$cfg  = Join-Path $env:APPDATA "spx-journal\watcher.json"
if (-not (Test-Path $cfg)) { Write-Host "First run:  npm run schwab:setup   (saves your journal password on this PC)"; exit 1 }

$action   = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$dir\schwab-watch-hidden.vbs`"" -WorkingDirectory $dir
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
              -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings `
  -Description "Sends Schwab History exports from Downloads to the online trade journal." -Force | Out-Null

$running = Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -like "*$dir\schwab-watch.cmd*" }
if (-not $running) { Start-ScheduledTask -TaskName $name }
Write-Host "Installed. Export from Schwab into Downloads and the trades show up in your journal."
Write-Host "Log: $dir\schwab-watch.log"
