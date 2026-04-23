@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
title CainFlow Launcher

set "APP_DIR=%~dp0"
set "PYTHON_CMD="
set "CAINFLOW_PORT=8767"

cls
echo ==========================================
echo       CainFlow - Starting Environment
echo ==========================================
echo.

if exist "%APP_DIR%python_runtime\python.exe" (
    set "PYTHON_CMD=%APP_DIR%python_runtime\python.exe"
) else (
    where python >nul 2>nul
    if !ERRORLEVEL! EQU 0 (
        set "PYTHON_CMD=python"
    ) else (
        where py >nul 2>nul
        if !ERRORLEVEL! EQU 0 (
            set "PYTHON_CMD=py"
        )
    )
)

if not defined PYTHON_CMD goto python_missing

%PYTHON_CMD% --version >nul 2>nul
if !ERRORLEVEL! NEQ 0 goto python_missing

echo Detecting Python: Success.
echo Starting server...
echo ------------------------------------------

pushd "%APP_DIR%"
call :ensure_port_available
if !ERRORLEVEL! NEQ 0 (
    set "EXIT_CODE=!ERRORLEVEL!"
    popd
    exit /b !EXIT_CODE!
)
%PYTHON_CMD% "%APP_DIR%server.py"
set "EXIT_CODE=!ERRORLEVEL!"
popd

if !EXIT_CODE! NEQ 0 (
    echo.
    echo 服务器已退出，错误代码: !EXIT_CODE!
    echo 如果上方提示端口 8767 已被占用，
    echo 则 CainFlow 很可能已经运行在 http://127.0.0.1:8767
    pause
)

exit /b !EXIT_CODE!

:python_missing
echo 错误：未安装 Python，或 Python 不在 PATH 中。
echo 按回车键打开 Python 官方下载页面。
echo.
pause >nul
start "" "https://www.python.org/downloads/"
exit /b 1

:ensure_port_available
set "PORT_PID="
set "PORT_PROC="

for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":%CAINFLOW_PORT% .*LISTENING"') do (
    set "PORT_PID=%%P"
    goto port_found
)

exit /b 0

:port_found
for /f "tokens=1 delims=," %%A in ('tasklist /FI "PID eq !PORT_PID!" /FO CSV /NH') do (
    set "PORT_PROC=%%~A"
)

if not defined PORT_PROC set "PORT_PROC=Unknown"

echo.
echo 端口 %CAINFLOW_PORT% 已被占用。
echo 进程 ID: !PORT_PID!
echo 进程名称: !PORT_PROC!
choice /C YN /N /M "是否关闭该进程并继续启动 CainFlow？ [Y/N]: "
if ERRORLEVEL 2 exit /b 1

taskkill /PID !PORT_PID! /F >nul 2>nul
if ERRORLEVEL 1 (
    echo 无法结束进程 !PORT_PID!。
    pause
    exit /b 1
)

timeout /t 1 /nobreak >nul
exit /b 0
