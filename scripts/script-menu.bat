@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 936 >nul
title CainFlow 脚本菜单

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "REPO_ROOT=%%~fI"
set "AUTO_CHOICE=%~1"
set "RUN_ONCE="
if defined AUTO_CHOICE set "RUN_ONCE=1"

:menu
call :resolve_build_python
call :resolve_python
call :resolve_node
cls
echo ==========================================
echo             CainFlow 脚本菜单
echo ==========================================
echo 仓库目录 : !REPO_ROOT!
if defined PYTHON_CMD (
  echo Python : !PYTHON_CMD!
) else (
  echo Python : 未找到
)
if defined BUILD_PYTHON_CMD (
  echo 构建环境 : !BUILD_PYTHON_CMD!
) else (
  echo 构建环境 : 未找到项目虚拟环境
)
if defined NODE_CMD (
  echo Node   : !NODE_CMD!
) else (
  echo Node   : 未找到
)
echo.
echo 1. 本地回归测试（发布校验 + 源码冒烟）
echo 2. 发布准备校验
echo 3. 源码冒烟测试
echo 4. 发布包冒烟测试
echo 5. 构建 Windows 发布包
echo 6. 一键部署虚拟环境
echo 7. 删除虚拟环境
echo 0. 退出
echo.

if defined AUTO_CHOICE (
  set "ACTION=!AUTO_CHOICE!"
  set "AUTO_CHOICE="
) else (
  set "ACTION="
  set /p ACTION=请输入选项:
)

if "!ACTION!"=="1" goto local_regression
if "!ACTION!"=="2" goto release_validation
if "!ACTION!"=="3" goto source_smoke
if "!ACTION!"=="4" goto release_smoke
if "!ACTION!"=="5" goto build_release
if "!ACTION!"=="6" goto setup_venv
if "!ACTION!"=="7" goto delete_venv
if "!ACTION!"=="0" goto end

echo.
echo 无效选项: !ACTION!
if defined RUN_ONCE exit /b 1
call :maybe_pause
goto menu

:local_regression
call :require_python
set "LAST_CODE=%ERRORLEVEL%"
if errorlevel 1 goto action_done
call :require_node
set "LAST_CODE=%ERRORLEVEL%"
if errorlevel 1 goto action_done
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%run-local-regression.ps1" -Python "!PYTHON_CMD!" -Node "!NODE_CMD!" -NoPause
set "LAST_CODE=%ERRORLEVEL%"
call :finish_action "本地回归测试" "!LAST_CODE!"
goto action_done

:release_validation
call :require_python
set "LAST_CODE=%ERRORLEVEL%"
if errorlevel 1 goto action_done
call :require_node
set "LAST_CODE=%ERRORLEVEL%"
if errorlevel 1 goto action_done
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%validate-release-readiness.ps1" -Python "!PYTHON_CMD!" -Node "!NODE_CMD!" -NoPause
set "LAST_CODE=%ERRORLEVEL%"
call :finish_action "发布准备校验" "!LAST_CODE!"
goto action_done

:source_smoke
call :require_python
set "LAST_CODE=%ERRORLEVEL%"
if errorlevel 1 goto action_done
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%smoke-test-cainflow.ps1" -Mode source -Python "!PYTHON_CMD!" -NoPause
set "LAST_CODE=%ERRORLEVEL%"
call :finish_action "源码冒烟测试" "!LAST_CODE!"
goto action_done

:release_smoke
call :require_python
set "LAST_CODE=%ERRORLEVEL%"
if errorlevel 1 goto action_done
echo.
set "ZIP_PATH="
set /p ZIP_PATH=请输入发布包 zip 路径:
set "ZIP_PATH=!ZIP_PATH:"=!"
if not defined ZIP_PATH (
  echo 未输入 zip 路径，已取消。
  set "LAST_CODE=1"
  call :maybe_pause
  goto action_done
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%smoke-test-cainflow.ps1" -Mode release -Python "!PYTHON_CMD!" -ZipPath "!ZIP_PATH!" -NoPause
set "LAST_CODE=%ERRORLEVEL%"
call :finish_action "发布包冒烟测试" "!LAST_CODE!"
goto action_done

:build_release
call :require_build_python
set "LAST_CODE=%ERRORLEVEL%"
if errorlevel 1 goto action_done
call :require_node
set "LAST_CODE=%ERRORLEVEL%"
if errorlevel 1 goto action_done
echo.
set "TAG_NAME="
set /p TAG_NAME=可选标签名（直接回车则自动生成）:
if defined TAG_NAME (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%build-release-local.ps1" -Python "!BUILD_PYTHON_CMD!" -TagName "!TAG_NAME!"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%build-release-local.ps1" -Python "!BUILD_PYTHON_CMD!"
)
set "LAST_CODE=%ERRORLEVEL%"
call :finish_action "Windows 发布包构建" "!LAST_CODE!"
goto action_done

:setup_venv
call :require_python
set "LAST_CODE=%ERRORLEVEL%"
if errorlevel 1 goto action_done

echo.
echo 将在以下位置部署项目虚拟环境:
echo   %REPO_ROOT%\.venv
echo.

if not exist "%REPO_ROOT%\.venv\Scripts\python.exe" (
  "%PYTHON_CMD%" -m venv "%REPO_ROOT%\.venv"
  set "LAST_CODE=%ERRORLEVEL%"
  if errorlevel 1 (
    call :finish_action "虚拟环境创建" "!LAST_CODE!"
    goto action_done
  )
) else (
  echo 已检测到 .venv，将直接更新 pip 和依赖。
)

set "VENV_PYTHON=%REPO_ROOT%\.venv\Scripts\python.exe"
"!VENV_PYTHON!" -m pip install --upgrade pip
set "LAST_CODE=%ERRORLEVEL%"
if errorlevel 1 (
  call :finish_action "pip 更新" "!LAST_CODE!"
  goto action_done
)

if exist "%REPO_ROOT%\requirements.txt" (
  "!VENV_PYTHON!" -m pip install -r "%REPO_ROOT%\requirements.txt"
  set "LAST_CODE=%ERRORLEVEL%"
  if errorlevel 1 (
    call :finish_action "项目依赖安装" "!LAST_CODE!"
    goto action_done
  )
) else (
  echo 未找到 requirements.txt，已跳过依赖安装。
)

set "BUILD_PYTHON_CMD=!VENV_PYTHON!"
set "PYTHON_CMD=!VENV_PYTHON!"
set "LAST_CODE=0"
call :finish_action "虚拟环境部署" "!LAST_CODE!"
goto action_done

:delete_venv
echo.
if not exist "%REPO_ROOT%\.venv\" if not exist "%REPO_ROOT%\venv\" (
  echo 未找到可删除的项目虚拟环境。
  set "LAST_CODE=0"
  call :maybe_pause
  goto action_done
)

echo 将删除以下项目虚拟环境目录（如果存在）:
if exist "%REPO_ROOT%\.venv\" echo   %REPO_ROOT%\.venv
if exist "%REPO_ROOT%\venv\" echo   %REPO_ROOT%\venv
echo.
echo 请输入 DELETE 确认删除，其他输入将取消。
set "CONFIRM_DELETE="
set /p CONFIRM_DELETE=确认:
if /I not "!CONFIRM_DELETE!"=="DELETE" (
  echo 已取消删除虚拟环境。
  set "LAST_CODE=1"
  call :maybe_pause
  goto action_done
)

set "LAST_CODE=0"
if exist "%REPO_ROOT%\.venv\" (
  rmdir /s /q "%REPO_ROOT%\.venv"
  if errorlevel 1 set "LAST_CODE=1"
)
if exist "%REPO_ROOT%\venv\" (
  rmdir /s /q "%REPO_ROOT%\venv"
  if errorlevel 1 set "LAST_CODE=1"
)

set "BUILD_PYTHON_CMD="
set "PYTHON_CMD="
call :finish_action "虚拟环境删除" "!LAST_CODE!"
goto action_done

:resolve_build_python
set "BUILD_PYTHON_CMD="
if exist "%REPO_ROOT%\.venv\Scripts\python.exe" (
  set "BUILD_PYTHON_CMD=%REPO_ROOT%\.venv\Scripts\python.exe"
  exit /b 0
)
if exist "%REPO_ROOT%\venv\Scripts\python.exe" (
  set "BUILD_PYTHON_CMD=%REPO_ROOT%\venv\Scripts\python.exe"
  exit /b 0
)
exit /b 0

:resolve_python
set "PYTHON_CMD="
if defined BUILD_PYTHON_CMD (
  set "PYTHON_CMD=!BUILD_PYTHON_CMD!"
  exit /b 0
)
if exist "%REPO_ROOT%\python_runtime\python.exe" (
  set "PYTHON_CMD=%REPO_ROOT%\python_runtime\python.exe"
  exit /b 0
)

where python >nul 2>nul
if !ERRORLEVEL! EQU 0 (
  set "PYTHON_CMD=python"
  exit /b 0
)

where py >nul 2>nul
if !ERRORLEVEL! EQU 0 (
  set "PYTHON_CMD=py"
)
exit /b 0

:resolve_node
set "NODE_CMD="
where node >nul 2>nul
if !ERRORLEVEL! EQU 0 (
  set "NODE_CMD=node"
)
exit /b 0

:require_python
if defined PYTHON_CMD exit /b 0
echo.
echo 错误: 未找到 Python。请确认 python 或 py 已加入 PATH。
call :maybe_pause
exit /b 1

:require_build_python
if defined BUILD_PYTHON_CMD exit /b 0
echo.
echo 错误: 构建发布包必须使用项目虚拟环境。
echo 未找到以下任一文件:
echo   %REPO_ROOT%\.venv\Scripts\python.exe
echo   %REPO_ROOT%\venv\Scripts\python.exe
echo.
echo 请在仓库根目录创建虚拟环境后再构建，例如:
echo   scripts\script-menu.bat
echo   选择 6. 一键部署虚拟环境
echo.
echo 然后重新运行本菜单并选择 5。
call :maybe_pause
exit /b 1

:require_node
if defined NODE_CMD exit /b 0
echo.
echo 错误: 未找到 Node.js。请确认 node 已加入 PATH。
call :maybe_pause
exit /b 1

:finish_action
set "LAST_CODE=%~2"
echo.
echo ------------------------------------------
if "%LAST_CODE%"=="0" (
  echo %~1已完成，请查看上方结果。
) else (
  echo %~1失败，退出码为 %LAST_CODE%。
)
echo ------------------------------------------
call :maybe_pause
exit /b %LAST_CODE%

:maybe_pause
if defined CAINFLOW_MENU_NO_PAUSE goto :eof
pause
goto :eof


:action_done
if not defined LAST_CODE set "LAST_CODE=%ERRORLEVEL%"
if defined RUN_ONCE exit /b %LAST_CODE%
goto menu

:end
endlocal
exit /b 0
