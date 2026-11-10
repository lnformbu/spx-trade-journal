# Stops the Schwab Downloads watcher and removes it from startup. Your journal is not touched.
$dir  = $PSScriptRoot
$name = "SPX Journal - Schwab watcher"
$loops = Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -like "*$dir\schwab-watch.cmd*" }
foreach ($l in $loops) {
  Get-CimInstance Win32_Process -Filter "ParentProcessId=$($l.ProcessId)" |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Stop-Process -Id $l.ProcessId -Force -ErrorAction SilentlyContinue
}
Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "Schwab watcher stopped and removed."
