@echo off
title Axiom DL - Push to GitHub
cd /d "%~dp0"

echo.
echo  =========================================
echo   Axiom DL -- Timesheet Tracker
echo   Push to GitHub
echo  =========================================
echo.

:: Check git is available
where git >nul 2>&1
if errorlevel 1 (
  echo  [error] Git not found. Install from https://git-scm.com
  pause
  exit /b 1
)

:: Auto-init repo if .git folder missing
if not exist ".git" (
  echo  [setup] No git repo found - initialising now...
  echo.
  git init
  git remote add origin https://github.com/greigorius/timesheet-tracker.git
  git branch -M main
  echo.
  echo  [setup] Done. Make sure the GitHub repo exists before pushing.
  echo          Create it at: https://github.com/new  ^(name: timesheet-tracker^)
  echo.
)

:: Remove stale git lock file if present (prevents commit failures after Claude edits)
if exist ".git\index.lock" (
  echo  [git] Removing stale index.lock...
  del ".git\index.lock"
)

:: Show current status
echo  [git] Current status:
echo.
git status --short
echo.

:: Build default commit message from date and time
for /f "tokens=1-3 delims=/" %%a in ("%DATE%") do (
  set DD=%%a
  set MM=%%b
  set YY=%%c
)
for /f "tokens=1-2 delims=:." %%a in ("%TIME: =0%") do (
  set HH=%%a
  set MIN=%%b
)
set DEFAULT_MSG=update - %DD%/%MM%/%YY% %HH%:%MIN%

set COMMIT_MSG=
set /p COMMIT_MSG=Commit message (press Enter for default): 
if "%COMMIT_MSG%"=="" set COMMIT_MSG=%DEFAULT_MSG%

echo.
echo  [git] Staging all changes...
git add -A

echo  [git] Committing: "%COMMIT_MSG%"
git commit -m "%COMMIT_MSG%"
if errorlevel 1 (
  echo.
  echo  [info] Nothing new to commit.
  pause
  exit /b 0
)

echo.
echo  [git] Pushing to GitHub...
git push -u origin main
if errorlevel 1 (
  echo.
  echo  [error] Push failed. Check:
  echo    1. GitHub repo exists at https://github.com/greigorius/timesheet-tracker
  echo    2. You are signed in to GitHub ^(run: git credential-manager^)
  echo.
  pause
  exit /b 1
)

echo.
echo  [done] Pushed to GitHub successfully.
echo  [done] Netlify will auto-deploy in ~90 seconds.
echo.
pause
