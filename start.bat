@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required but was not found.
  echo Install it from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)

echo Starting StreamFinder...
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Milliseconds 900; Start-Process 'http://localhost:8790'"
node server.js

echo.
echo StreamFinder stopped.
pause
