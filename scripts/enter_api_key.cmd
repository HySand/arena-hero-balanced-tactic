@echo off
setlocal EnableExtensions
for %%I in ("%~dp0..") do set "ROOT=%%~fI"
cd /d "%ROOT%"
powershell.exe -NoLogo -NoProfile -STA -ExecutionPolicy Bypass -File "%ROOT%\scripts\enter_api_key.ps1"
exit /b %errorlevel%