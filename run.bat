@echo off
REM 90-Day Pattern Desk launcher (Windows) - double-click this file
cd /d "%~dp0"
set PORT=4949
REM if the always-on server is already running, just open the app
netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul
if %errorlevel%==0 (
  start "" http://localhost:%PORT%
  exit /b
)
echo Starting server on http://localhost:%PORT% ...
start "" http://localhost:%PORT%
node server.js
pause
