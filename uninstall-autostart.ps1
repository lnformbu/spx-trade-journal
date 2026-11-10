# Stops the always-on journal server for this folder and removes it from startup.
# Your trades.json is not touched. You can still run run.bat by hand afterwards.

$dir  = $PSScriptRoot
$name = "SPX Journal - " + (Split-Path $dir -Leaf)

# stop the keep-running loop for this folder, then its node server
$loops = Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" |
  Where-Object { $_.CommandLine -like "*$dir\keep-running.cmd*" }
foreach ($l in $loops) {
  Get-CimInstance Win32_Process -Filter "ParentProcessId=$($l.ProcessId)" |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Stop-Process -Id $l.ProcessId -Force -ErrorAction SilentlyContinue
}

Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "Removed '$name' and stopped its server."
