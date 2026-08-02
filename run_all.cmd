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
        echo API key was not saved. Run run_all.cmd again to retry.
        pause
        exit /b 1
    )
)

start "Arena Hero Dashboard" /D "%~dp0" cmd /k ".venv\Scripts\python.exe -u tactic_dashboard.py --open"
start "Arena Hero Tactic" /D "%~dp0" cmd /k ".venv\Scripts\python.exe -u balanced_tactic.py"
echo Dashboard and tactic windows have been started.
echo Keep both windows open while the game is running.
exit /b 0
