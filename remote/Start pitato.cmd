@echo off
pwsh -STA -NoProfile -File "%~dp0start-host.ps1" %*
if errorlevel 1 pause
