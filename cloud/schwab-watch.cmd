@echo off
REM Keeps the Schwab Downloads watcher running; restarts it if it stops.
REM Started hidden at login by install-schwab-watcher.ps1. Log: schwab-watch.log in this folder.
cd /d "%~dp0"
set "NODE=node"
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
:loop
for %%A in (schwab-watch.log) do if %%~zA GTR 1000000 move /y schwab-watch.log schwab-watch.old.log >nul
"%NODE%" scripts\schwab-watch.js watch >> schwab-watch.log 2>&1
echo [%date% %time%] watcher stopped (exit %errorlevel%), restarting in 30 seconds >> schwab-watch.log
timeout /t 30 /nobreak >nul
goto loop
