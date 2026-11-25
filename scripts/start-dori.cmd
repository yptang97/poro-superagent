@echo off
rem double-click to start dori: herdr + feishu inbound + lead + startup message
set "PS=powershell"
where pwsh >nul 2>nul && set "PS=pwsh"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-dori.ps1" %*
if errorlevel 1 pause
