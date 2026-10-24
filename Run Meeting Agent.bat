@echo off
cd /d "%~dp0"
title Meeting Agent
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org, then double-click this file again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo First run: installing what the app needs. This takes a few minutes...
  call npm install
  if errorlevel 1 (
    echo Something went wrong. Copy the red text above and report it at https://github.com/amithkshinde/meeting-agent-windows/issues
    pause
    exit /b 1
  )
)
call npm start
if errorlevel 1 (
  echo Something went wrong. Copy the red text above and report it at https://github.com/amithkshinde/meeting-agent-windows/issues
)
pause
