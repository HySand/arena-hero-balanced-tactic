@echo off
setlocal EnableExtensions
cd /d "%~dp0"

call "%~dp0setup.cmd"
if errorlevel 1 exit /b 1

set "PYTHON=%~dp0.venv\Scripts\python.exe"

echo Running privacy and secret scan...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0security_check.ps1"
if errorlevel 1 goto :failed

echo Running unit tests...
"%PYTHON%" -B -m unittest -v
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
    node --check "%~dp0dashboard\app.js"
    if errorlevel 1 goto :failed
)

where git >nul 2>nul
if not errorlevel 1 (
    echo Checking Git whitespace errors...
    git diff --check
    if errorlevel 1 goto :failed
    git diff --cached --check
    if errorlevel 1 goto :failed
)

echo All available checks passed.
exit /b 0

:failed
echo Verification failed.
exit /b 1
