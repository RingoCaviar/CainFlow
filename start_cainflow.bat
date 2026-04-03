@echo off
:: Set encoding to UTF-8 to prevent garbled text
chcp 65001 >nul
title CainFlow Launcher
setlocal enabledelayedexpansion

:: 1. Header and Clear Screen
cls
echo ==========================================
echo       CainFlow - Starting Environment
echo ==========================================
echo.

:: 2. Python Detection (Priority: 1. local folder, 2. system path)
set PYTHON_CMD=
if exist "%~dp0python_runtime\python.exe" (
    set PYTHON_CMD="%~dp0python_runtime\python.exe"
) else (
    where python >nul 2>nul
    if !ERRORLEVEL! equ 0 (
        set PYTHON_CMD=python
    ) else (
        where py >nul 2>nul
        if !ERRORLEVEL! equ 0 (
            set PYTHON_CMD=py
        )
    )
)

:: 3. Validation (Check if Python exists and is functional)
if "%PYTHON_CMD%"=="" goto :python_missing
%PYTHON_CMD% --version >nul 2>nul
if !ERRORLEVEL! neq 0 goto :python_missing

:: 4. Start Server
echo Detecting Python: Success.
echo Starting server...
echo ------------------------------------------
cd /d "%~dp0"
%PYTHON_CMD% server.py

:: Capture abnormal exit
if !ERRORLEVEL! neq 0 (
    echo.
    echo Server exited with error code: !ERRORLEVEL!
    echo 程序运行出错，请检查后重试。
    pause
)
exit /b

:: 5. Error Prompt and Browser Redirection
:python_missing
echo ERROR: Python is not installed or not in PATH.
echo 错误: 未能在本系统中探测到有效的 Python 环境。
echo.
echo Press ENTER to open the official Python download page.
echo 请直接按【回车键】打开 Python 官网下载页面...
echo.
pause >nul
start https://www.python.org/downloads/
exit /b 1
