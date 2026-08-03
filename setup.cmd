@echo off
setlocal EnableExtensions
cd /d "%~dp0"

if exist ".venv\Scripts\python.exe" (
    ".venv\Scripts\python.exe" -c "import sys, venv, ensurepip; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>nul
    if errorlevel 1 (
        echo The existing .venv is incomplete, broken, or uses Python older than 3.11.
        echo Rebuilding the managed virtual environment...
        rmdir /s /q ".venv"
        if exist ".venv\" (
            echo Could not remove .venv. Close any running tactic or dashboard windows and try again.
            exit /b 1
        )
    )
)

if not exist ".venv\Scripts\python.exe" (
    if exist ".venv\" (
        echo Removing an incomplete .venv left by an earlier setup attempt...
        rmdir /s /q ".venv"
        if exist ".venv\" (
            echo Could not remove .venv. Close programs using this folder and try again.
            exit /b 1
        )
    )

    call :find_python
    if errorlevel 1 exit /b 1

    call :create_virtual_environment
    if errorlevel 1 exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
    echo Virtual environment creation finished without producing .venv\Scripts\python.exe.
    echo Repair or reinstall the full Python distribution, then run setup.cmd again.
    exit /b 1
)

".venv\Scripts\python.exe" -c "import sys, venv, ensurepip; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>nul
if errorlevel 1 (
    echo The new virtual environment is not usable with Python 3.11 or newer.
    echo Delete .venv after repairing Python, then run setup.cmd again.
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

:find_python
set "PYTHON_CMD="

py -3 -c "import sys, venv, ensurepip; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>nul
if not errorlevel 1 (
    set "PYTHON_CMD=py -3"
    exit /b 0
)

python -c "import sys, venv, ensurepip; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>nul
if not errorlevel 1 (
    set "PYTHON_CMD=python"
    exit /b 0
)

python3 -c "import sys, venv, ensurepip; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>nul
if not errorlevel 1 (
    set "PYTHON_CMD=python3"
    exit /b 0
)

echo A complete Python 3.11 or newer installation was not found.
echo The Microsoft Store app execution alias or a Python launcher without Python installed is not sufficient.
echo Install Python from https://www.python.org/downloads/windows/
echo Enable "Add python.exe to PATH" during installation, reopen this folder, and run setup.cmd again.
where py >nul 2>nul
if not errorlevel 1 (
    echo.
    echo Python Launcher installations detected:
    py -0p 2>nul
)
exit /b 1

:create_virtual_environment
echo Creating .venv with %PYTHON_CMD%...
%PYTHON_CMD% -m venv ".venv"
if errorlevel 1 (
    echo.
    echo Virtual environment creation failed using: %PYTHON_CMD% -m venv ".venv"
    echo Review the Python error above. Also check folder write permission and security software blocks.
    exit /b 1
)
exit /b 0
