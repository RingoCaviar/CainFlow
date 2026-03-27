@echo off
title CainFlow - Local Server
setlocal enabledelayedexpansion

echo ------------------------------------------
echo Checking Environment...
echo ------------------------------------------

:: Check if python is installed
where python >nul 2>nul
if %ERRORLEVEL% neq 0 (
    where py >nul 2>nul
    if !ERRORLEVEL! neq 0 (
        echo [!] ERROR: Python is not installed or not added to PATH.
        echo [!] ERROR: Please install Python 3.x to run CainFlow.
        echo.
        echo Opening Python download page...
        start https://www.python.org/downloads/
        echo.
        echo ------------------------------------------
        pause
        exit /b 1
    )
)

echo Starting CainFlow Local Server...
echo ------------------------------------------
cd /d "%~dp0"
echo.
python server.py
if %ERRORLEVEL% neq 0 (
    echo.
    echo [!] Server exited with error code %ERRORLEVEL%.
)
pause
