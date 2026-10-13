@echo off
rem Double-click to start Byway. The first time, it installs the parts the app needs (about a minute).
rem Keep the window open while you use the app; close it to stop the app.
cd /d "%~dp0"
title Byway

where node >nul 2>nul
if errorlevel 1 (
  echo Byway needs Node.js, a free program. Opening its download page...
  echo Install the LTS version, then double-click start.cmd again.
  start "" https://nodejs.org/en/download
  pause
  exit /b 1
)

if not exist node_modules\express (
  echo First start: installing the app's parts. This takes a minute...
  call npm install --omit=dev
  if errorlevel 1 (
    echo Installing failed. Check the internet connection and try again.
    pause
    exit /b 1
  )
)

echo Starting Byway at http://localhost:3000
echo Keep this window open while you use the app. Close it to stop the app.
node server.js --open
pause
