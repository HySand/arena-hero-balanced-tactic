@echo off
setlocal EnableExtensions
cd /d "%~dp0"

call "%~dp0setup.cmd"
if errorlevel 1 exit /b 1

"%~dp0.venv\Scripts\python.exe" "%~dp0peace_economy_experiment.py" start
if errorlevel 1 exit /b 1

echo Peace economy experiment is active. Raw telemetry stays local.
echo Press Ctrl+C to stop the tactic; run this file again to resume.
"%~dp0.venv\Scripts\python.exe" -u "%~dp0balanced_tactic.py"
exit /b %errorlevel%
