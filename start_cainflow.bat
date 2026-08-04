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
    echo 启动失败，错误代码: !EXIT_CODE!
    echo 上方已显示具体原因，请按提示处理后再重新启动 CainFlow。
    echo.
    echo 请手动关闭此窗口，或按任意键退出。
    pause >nul
)

exit /b !EXIT_CODE!

:python_missing
echo 错误：未安装 Python，或 Python 不在 PATH 中。
echo 按回车键打开 Python 官方下载页面。
echo.
pause >nul
start "" "https://www.python.org/downloads/"
exit /b 1

:dependencies_missing
echo 错误：缺少 CainFlow 桌面运行依赖。
echo 请在项目目录运行: %PYTHON_CMD% -m pip install -r requirements.txt
echo.
pause
exit /b 1
