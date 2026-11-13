@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 24 LTS first.
  pause
  exit /b 1
)
if not exist node_modules\vite\bin\vite.js (
  echo Dependencies are missing. Run npm ci in this folder first.
  pause
  exit /b 1
)
call npm.cmd run dev -- --open
if errorlevel 1 pause
