@echo off
REM Keeps the journal server running: if it ever stops, it is restarted automatically.
REM Started hidden at logon by the scheduled task that install-autostart.ps1 creates.
REM Output goes to server.log in this folder (rolled over to server.old.log at ~1 MB).
cd /d "%~dp0"
set "NODE=node"
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"

:loop
for %%A in (server.log) do if %%~zA GTR 1000000 move /y server.log server.old.log >nul
"%NODE%" server.js >> server.log 2>&1
set "CODE=%errorlevel%"
if "%CODE%"=="2" (
  REM port already taken (another copy is running) - check again in a minute
  timeout /t 60 /nobreak >nul
) else (
  echo [%date% %time%] server exited with code %CODE%, restarting in 5 seconds >> server.log
  timeout /t 5 /nobreak >nul
)
goto loop
