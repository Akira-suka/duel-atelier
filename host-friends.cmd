@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 24 LTS first.
  pause
  exit /b 1
)
echo 1. Public invite - no account or domain, portable cloudflared downloaded on first run
echo 2. LAN only - friends on the same network
choice /c 12 /n /m "Choose 1 or 2: "
if errorlevel 2 (set "DUEL_HOST_MODE=host:lan") else (set "DUEL_HOST_MODE=host:public")
if not exist node_modules\tsx\dist\cli.mjs (
  call npm.cmd ci
  if errorlevel 1 goto failed
)
call npm.cmd run build
if errorlevel 1 goto failed
call npm.cmd run %DUEL_HOST_MODE%
:failed
pause
