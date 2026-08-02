@echo off
setlocal EnableExtensions
cd /d "%~dp0"

call "%~dp0setup.cmd"
if errorlevel 1 (
    pause
    exit /b 1
)

echo Starting local dashboard at http://127.0.0.1:8765/
echo Press Ctrl+C to stop the dashboard.
"%~dp0.venv\Scripts\python.exe" -u "%~dp0tactic_dashboard.py" --open
if errorlevel 1 (
    echo.
    echo The dashboard stopped with an error. Read the message above.
    pause
)
exit /b %errorlevel%
