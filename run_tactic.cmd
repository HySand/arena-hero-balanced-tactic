@echo off
setlocal EnableExtensions
cd /d "%~dp0"

call "%~dp0setup.cmd"
if errorlevel 1 (
    pause
    exit /b 1
)

findstr /b /r /c:"ARENA_HERO_API_KEY=." ".env" >nul 2>nul
if errorlevel 1 (
    call "%~dp0enter_api_key.cmd"
    if errorlevel 1 (
        echo API key was not saved. Run run_tactic.cmd again to retry.
        pause
        exit /b 1
    )
)

echo Starting Arena Hero tactic. Press Ctrl+C to stop.
"%~dp0.venv\Scripts\python.exe" -u "%~dp0balanced_tactic.py"
if errorlevel 1 (
    echo.
    echo The tactic stopped with an error. Read the message above.
    pause
)
exit /b %errorlevel%
