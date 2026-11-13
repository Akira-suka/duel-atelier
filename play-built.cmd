@echo off
cd /d "%~dp0"
node scripts\serve-built.mjs
if errorlevel 1 pause
