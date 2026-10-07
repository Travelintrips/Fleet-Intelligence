@echo off
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js belum terinstall. Install Node.js 22 terlebih dahulu.
  pause
  exit /b 1
)
node install.mjs
pause
