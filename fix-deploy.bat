@echo off
cd /d "%~dp0"
echo Starting fix-deploy > "%~dp0fix-deploy-log.txt" 2>&1
echo.

echo [fix] Stopping git maintenance...
git maintenance stop >> "%~dp0fix-deploy-log.txt" 2>&1

echo [fix] Killing any background git processes...
taskkill /F /IM git.exe /T >> "%~dp0fix-deploy-log.txt" 2>&1
timeout /t 2 /nobreak >nul

echo [fix] Removing stale lock files...
del /F /Q ".git\index.lock" >> "%~dp0fix-deploy-log.txt" 2>&1
del /F /Q ".git\HEAD.lock" >> "%~dp0fix-deploy-log.txt" 2>&1
del /F /Q ".git\objects\maintenance.lock" >> "%~dp0fix-deploy-log.txt" 2>&1

echo [fix] Checking for remaining lock files...
dir ".git\*.lock" /B >> "%~dp0fix-deploy-log.txt" 2>&1
dir ".git\objects\*.lock" /B >> "%~dp0fix-deploy-log.txt" 2>&1

echo [git] git status...
git status >> "%~dp0fix-deploy-log.txt" 2>&1

echo [git] Staging files...
git add netlify/functions/notion-proxy.js fix-deploy.bat commit-fix.bat >> "%~dp0fix-deploy-log.txt" 2>&1

echo [git] Committing...
git commit -m "fix: restore truncated notion-proxy.js" >> "%~dp0fix-deploy-log.txt" 2>&1
echo Commit exit code: %ERRORLEVEL% >> "%~dp0fix-deploy-log.txt" 2>&1

echo [git] Pushing...
git push origin main >> "%~dp0fix-deploy-log.txt" 2>&1
echo Push exit code: %ERRORLEVEL% >> "%~dp0fix-deploy-log.txt" 2>&1

echo Done >> "%~dp0fix-deploy-log.txt" 2>&1
echo Finished. Log written to fix-deploy-log.txt
timeout /t 3 /nobreak >nul
