@echo off
setlocal EnableExtensions
for %%I in ("%~dp0..") do set "ROOT=%%~fI"
cd /d "%ROOT%"

call "%ROOT%\scripts\setup.cmd"
if errorlevel 1 (
    pause
    exit /b 1
)

findstr /b /r /c:"ARENA_HERO_API_KEY=." ".env" >nul 2>nul
if errorlevel 1 (
    call "%ROOT%\scripts\enter_api_key.cmd"
    if errorlevel 1 (
        echo API key was not saved. Run scripts\run_tactic.cmd again to retry.
        pause
        exit /b 1
    )
)

echo Starting Arena Hero tactic. Press Ctrl+C to stop.
"%ROOT%\.venv\Scripts\python.exe" -u -m arena_hero_tactic.tactic.engine
if errorlevel 1 (
    echo.
    echo The tactic stopped with an error. Read the message above.
    pause
)
exit /b %errorlevel%