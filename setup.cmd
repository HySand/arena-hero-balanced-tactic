@echo off
setlocal EnableExtensions
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    where py >nul 2>nul
    if not errorlevel 1 (
        py -3 -m venv .venv
    ) else (
        where python >nul 2>nul
        if not errorlevel 1 (
            python -m venv .venv
        ) else (
            echo Python 3.11 or newer was not found.
            echo Install Python from https://www.python.org/downloads/windows/
            echo Enable "Add python.exe to PATH" during installation, then run setup.cmd again.
            exit /b 1
        )
    )
)

if not exist ".venv\Scripts\python.exe" (
    echo The virtual environment could not be created.
    exit /b 1
)

".venv\Scripts\python.exe" -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>nul
if errorlevel 1 (
    echo Python 3.11 or newer is required.
    echo Remove .venv after installing a supported Python version, then run setup.cmd again.
    exit /b 1
)

set "NEEDS_INSTALL=0"
if not exist ".venv\.requirements.txt" set "NEEDS_INSTALL=1"
if exist ".venv\.requirements.txt" (
    fc /b "requirements.txt" ".venv\.requirements.txt" >nul 2>nul
    if errorlevel 1 set "NEEDS_INSTALL=1"
)
".venv\Scripts\python.exe" -c "from importlib.metadata import version; current=tuple(int(part) for part in version('arena-hero').split('.')[:3]); raise SystemExit(0 if (0, 2, 6) <= current < (0, 3, 0) else 1)" >nul 2>nul
if errorlevel 1 set "NEEDS_INSTALL=1"

if "%NEEDS_INSTALL%"=="1" (
    echo Installing Arena Hero dependencies...
    ".venv\Scripts\python.exe" -m pip install --disable-pip-version-check --upgrade pip
    if errorlevel 1 (
        echo Dependency setup failed while upgrading pip.
        exit /b 1
    )
    ".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -r requirements.txt
    if errorlevel 1 (
        echo Dependency setup failed. Check your network connection and try again.
        exit /b 1
    )
    copy /y "requirements.txt" ".venv\.requirements.txt" >nul
)

if not exist ".env" (
    copy /y ".env.example" ".env" >nul
    echo Created .env from .env.example.
) else (
    for %%A in (".env") do if %%~zA==0 (
        copy /y ".env.example" ".env" >nul
        echo Recreated empty .env from .env.example.
    )
)

echo Arena Hero environment is ready.
exit /b 0
