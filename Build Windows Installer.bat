@echo off
cd /d "%~dp0"
title Build Meeting Agent installer
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org, then double-click this file again.
  pause
  exit /b 1
)
echo Building the Windows installer. This takes about five minutes the first time...
call npm install
if errorlevel 1 goto fail
call npm run dist
if errorlevel 1 goto fail
echo.
echo Done. Opening the folder with your installer.
explorer dist-installer
pause
exit /b 0
:fail
echo Something went wrong. Copy the red text above and report it at https://github.com/amithkshinde/meeting-agent-windows/issues
pause
exit /b 1
