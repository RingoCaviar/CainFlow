@echo off
title CainFlow - Local Server
setlocal enabledelayedexpansion

echo ------------------------------------------
echo Checking Environment...
echo ------------------------------------------

:: Robust Python command detection
set PYTHON_CMD=python
where python >nul 2>nul
if %ERRORLEVEL% neq 0 (
    where py >nul 2>nul
    if !ERRORLEVEL! equ 0 (
        set PYTHON_CMD=py
    ) else (
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
%PYTHON_CMD% server.py
if %ERRORLEVEL% neq 0 (
    echo.
    echo [!] Server exited with error code %ERRORLEVEL%.
    if %ERRORLEVEL% equ 9009 (
        echo [!] ERROR: The command '%PYTHON_CMD%' was not found. 
        echo [!] Please make sure Python is installed and 'Add Python to PATH' was checked during installation.
    )
)
pause
