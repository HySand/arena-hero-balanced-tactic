@echo off
setlocal EnableExtensions
for %%I in ("%~dp0..") do set "ROOT=%%~fI"
cd /d "%ROOT%"

call "%ROOT%\scripts\setup.cmd"
if errorlevel 1 exit /b 1

set "PYTHON=%ROOT%\.venv\Scripts\python.exe"

echo Running privacy and secret scan...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\scripts\security_check.ps1"
if errorlevel 1 goto :failed

echo Running unit tests...
"%PYTHON%" -B -m unittest discover -s tests -v
if errorlevel 1 goto :failed

echo Checking Python syntax...
"%PYTHON%" -B -m compileall -q -x "[\\/]\.venv[\\/]" .
if errorlevel 1 goto :failed

echo Checking installed dependencies...
"%PYTHON%" -B -m pip check
if errorlevel 1 goto :failed

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js was not found; dashboard JavaScript syntax check skipped.
) else (
    echo Checking dashboard JavaScript syntax...
    node --check "%ROOT%\dashboard\app.js"
    if errorlevel 1 goto :failed
)

if exist "%ROOT%\.git\" (
    where git >nul 2>nul
    if not errorlevel 1 (
        echo Checking Git whitespace errors...
        git diff --check
        if errorlevel 1 goto :failed
        git diff --cached --check
        if errorlevel 1 goto :failed
    )
) else (
    echo Git metadata not present; whitespace check skipped.
)

echo All available checks passed.
exit /b 0

:failed
echo Verification failed.
exit /b 1