@echo off
title Timesheet Tracker — Dev Server
cd /d "%~dp0"

echo.
echo  ╔══════════════════════════════════════╗
echo  ║   Axiom DL — Timesheet Tracker       ║
echo  ║   Dev Server                         ║
echo  ╚══════════════════════════════════════╝
echo.

:: Install dependencies if node_modules is missing
if not exist "node_modules\" (
  echo  [setup] node_modules not found — running npm install...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo  [error] npm install failed. Check Node.js is installed.
    pause
    exit /b 1
  )
  echo.
)

echo  [start] Starting Vite dev server...
echo  [start] App will open at http://localhost:5173
echo.
echo  Press Ctrl+C to stop the server.
echo.

:: Open browser after a short delay (runs in background)
start "" cmd /c "timeout /t 2 >nul && start http://localhost:5173"

call npm run dev
