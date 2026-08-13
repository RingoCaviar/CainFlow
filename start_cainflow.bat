@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
title CainFlow Launcher

set "APP_DIR=%~dp0"
set "PYTHON_CMD="

cls
echo ==========================================
echo       CainFlow - Starting Environment
echo ==========================================
echo.

if exist "%APP_DIR%.venv\Scripts\python.exe" (
    set "PYTHON_CMD=%APP_DIR%.venv\Scripts\python.exe"
) else if exist "%APP_DIR%python_runtime\python.exe" (
    set "PYTHON_CMD=%APP_DIR%python_runtime\python.exe"
) else (
    where python >nul 2>nul
    if !ERRORLEVEL! EQU 0 (
        set "PYTHON_CMD=python"
    ) else (
        where py >nul 2>nul
        if !ERRORLEVEL! EQU 0 set "PYTHON_CMD=py"
    )
)

if not defined PYTHON_CMD goto python_missing

%PYTHON_CMD% --version >nul 2>nul
if !ERRORLEVEL! NEQ 0 goto python_missing

echo Detecting Python: Success.
%PYTHON_CMD% -c "import webview" >nul 2>nul
if !ERRORLEVEL! NEQ 0 goto dependencies_missing

echo Starting CainFlow desktop...
echo ------------------------------------------

pushd "%APP_DIR%"
set "CAINFLOW_LAUNCHED_FROM_BAT=1"
%PYTHON_CMD% "%APP_DIR%server.py" %*
set "EXIT_CODE=!ERRORLEVEL!"
popd

if !EXIT_CODE! NEQ 0 (
    echo.
    echo Startup failed with exit code !EXIT_CODE!.
    echo See the message above, fix the issue, then start CainFlow again.
    echo.
    echo Close this window or press any key to exit.
    pause >nul
)

exit /b !EXIT_CODE!

:python_missing
echo Error: Python is not installed or is not available on PATH.
echo Press Enter to open the official Python download page.
echo.
pause >nul
start "" "https://www.python.org/downloads/"
exit /b 1

:dependencies_missing
echo Error: CainFlow desktop dependencies are missing.
echo Run this command in the project directory:
echo   %PYTHON_CMD% -m pip install -r requirements.txt
echo.
pause
exit /b 1
