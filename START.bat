@echo off
title Order Dashboard
color 0A
echo.
echo  ============================
echo    Order Dashboard
echo  ============================
echo.

cd /d "%~dp0"

where node >nul 2>&1
if %errorlevel% neq 0 (
  echo  ERROR: Node.js is not installed.
  echo  Download it from https://nodejs.org  then run this again.
  pause
  exit /b 1
)

echo  Installing dependencies...
npm install --silent

echo  Starting server...
echo.
echo  The dashboard will open in your browser automatically.
echo  On your phone, open Chrome and go to:
echo.
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
  set IP=%%a
  goto :show
)
:show
echo    http://%IP:~1%:3000
echo.
echo  (Press Ctrl+C to stop the server)
echo.

node server.js
pause
