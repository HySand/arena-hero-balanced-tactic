@echo off
setlocal EnableExtensions
for %%I in ("%~dp0..") do set "ROOT=%%~fI"
cd /d "%ROOT%"

call "%ROOT%\scripts\setup.cmd"
if errorlevel 1 (
    pause
    exit /b 1
)

echo Starting local dashboard at http://127.0.0.1:8765/
echo Press Ctrl+C to stop the dashboard.
"%ROOT%\.venv\Scripts\python.exe" -u -m arena_hero_tactic.dashboard.server --open
if errorlevel 1 (
    echo.
    echo The dashboard stopped with an error. Read the message above.
    pause
)
exit /b %errorlevel%