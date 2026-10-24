@echo off
title Competition Badge Generator
rem Starts the badge designer and opens it in the browser.
rem Close this window to stop it.
cd /d "%~dp0"

rem Checks for vite itself, not just the folder: an interrupted install
rem (e.g. "npm ci" while the app was running) can leave node_modules
rem half empty.
if not exist "node_modules\.bin\vite.cmd" (
  echo Installing dependencies, this only happens the first time...
  call npm install
)

echo Starting the badge designer... the browser will open by itself.
echo Close this window to stop it.
call npm run dev -- --open
pause
