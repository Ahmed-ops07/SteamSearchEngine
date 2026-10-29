@echo off
setlocal
set PORT=8790
echo Looking for StreamFinder on port %PORT%...
set FOUND=
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT%" ^| findstr "LISTENING"') do (
  taskkill /PID %%p /F >nul 2>nul
  set FOUND=1
)
if defined FOUND (
  echo StreamFinder stopped.
) else (
  echo Nothing was listening on port %PORT%.
)
timeout /t 2 >nul
