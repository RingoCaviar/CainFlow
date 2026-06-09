@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
title CainFlow Script Menu

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "REPO_ROOT=%%~fI"
set "AUTO_CHOICE=%~1"
set "RUN_ONCE="
if defined AUTO_CHOICE set "RUN_ONCE=1"

:menu
call :resolve_python
call :resolve_node
cls
echo ==========================================
echo           CainFlow Script Menu
echo ==========================================
echo Repo   : !REPO_ROOT!
if defined PYTHON_CMD (
  echo Python : !PYTHON_CMD!
) else (
  echo Python : NOT FOUND
)
if defined NODE_CMD (
  echo Node   : !NODE_CMD!
) else (
  echo Node   : NOT FOUND
)
echo.
echo 1. Local regression test (validation + source smoke)
echo 2. Release readiness validation
echo 3. Source smoke test
echo 4. Release zip smoke test
echo 5. Build Windows release zip
echo 0. Exit
echo.

if defined AUTO_CHOICE (
  set "ACTION=!AUTO_CHOICE!"
  set "AUTO_CHOICE="
) else (
  set "ACTION="
  set /p ACTION=Enter option:
)

if "!ACTION!"=="1" goto local_regression
if "!ACTION!"=="2" goto release_validation
if "!ACTION!"=="3" goto source_smoke
if "!ACTION!"=="4" goto release_smoke
if "!ACTION!"=="5" goto build_release
if "!ACTION!"=="0" goto end

echo.
echo Invalid option: !ACTION!
if defined RUN_ONCE exit /b 1
call :maybe_pause
goto menu

:local_regression
call :require_python
if errorlevel 1 goto action_done
call :require_node
if errorlevel 1 goto action_done
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%run-local-regression.ps1" -Python "!PYTHON_CMD!" -Node "!NODE_CMD!" -NoPause
set "LAST_CODE=%ERRORLEVEL%"
call :finish_action "Local regression test" "!LAST_CODE!"
goto action_done

:release_validation
call :require_python
if errorlevel 1 goto action_done
call :require_node
if errorlevel 1 goto action_done
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%validate-release-readiness.ps1" -Python "!PYTHON_CMD!" -Node "!NODE_CMD!" -NoPause
set "LAST_CODE=%ERRORLEVEL%"
call :finish_action "Release readiness validation" "!LAST_CODE!"
goto action_done

:source_smoke
call :require_python
if errorlevel 1 goto action_done
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%smoke-test-cainflow.ps1" -Mode source -Python "!PYTHON_CMD!" -NoPause
set "LAST_CODE=%ERRORLEVEL%"
call :finish_action "Source smoke test" "!LAST_CODE!"
goto action_done

:release_smoke
call :require_python
if errorlevel 1 goto action_done
echo.
set "ZIP_PATH="
set /p ZIP_PATH=Enter release zip path:
set "ZIP_PATH=!ZIP_PATH:"=!"
if not defined ZIP_PATH (
  echo No zip path entered. Cancelled.
  set "LAST_CODE=1"
  call :maybe_pause
  goto action_done
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%smoke-test-cainflow.ps1" -Mode release -Python "!PYTHON_CMD!" -ZipPath "!ZIP_PATH!" -NoPause
set "LAST_CODE=%ERRORLEVEL%"
call :finish_action "Release zip smoke test" "!LAST_CODE!"
goto action_done

:build_release
call :require_python
if errorlevel 1 goto action_done
call :require_node
if errorlevel 1 goto action_done
echo.
set "TAG_NAME="
set /p TAG_NAME=Optional tag name (Enter to auto-generate):
if defined TAG_NAME (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%build-release-local.ps1" -Python "!PYTHON_CMD!" -TagName "!TAG_NAME!"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%build-release-local.ps1" -Python "!PYTHON_CMD!"
)
set "LAST_CODE=%ERRORLEVEL%"
call :finish_action "Windows release build" "!LAST_CODE!"
goto action_done

:resolve_python
set "PYTHON_CMD="
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
echo Error: Python was not found. Make sure python or py is available in PATH.
call :maybe_pause
exit /b 1

:require_node
if defined NODE_CMD exit /b 0
echo.
echo Error: Node.js was not found. Make sure node is available in PATH.
call :maybe_pause
exit /b 1

:finish_action
set "LAST_CODE=%~2"
echo.
echo ------------------------------------------
if "%LAST_CODE%"=="0" (
  echo %~1 completed. Check the result above.
) else (
  echo %~1 failed with exit code %LAST_CODE%.
)
echo ------------------------------------------
call :maybe_pause
exit /b %LAST_CODE%

:maybe_pause
if defined CAINFLOW_MENU_NO_PAUSE exit /b 0
pause
exit /b 0

:return_to_menu_or_exit
set "LAST_CODE=%~1"
if defined RUN_ONCE exit /b %LAST_CODE%
goto menu

:action_done
if not defined LAST_CODE set "LAST_CODE=%ERRORLEVEL%"
call :return_to_menu_or_exit "%LAST_CODE%"

:end
endlocal
exit /b 0
