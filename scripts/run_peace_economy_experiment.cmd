@echo off
setlocal EnableExtensions
for %%I in ("%~dp0..") do set "ROOT=%%~fI"
cd /d "%ROOT%"

call "%ROOT%\scripts\setup.cmd"
if errorlevel 1 exit /b 1

"%ROOT%\.venv\Scripts\python.exe" -m arena_hero_tactic.training.experiment start
if errorlevel 1 exit /b 1

echo Peace economy experiment is active. Raw telemetry stays local.
echo Press Ctrl+C to stop the tactic; run this file again to resume.
"%ROOT%\.venv\Scripts\python.exe" -u -m arena_hero_tactic.tactic.engine
exit /b %errorlevel%