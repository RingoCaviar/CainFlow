@echo off
title CainFlow - Local Server
echo ------------------------------------------
echo Starting CainFlow Local Server...
echo ------------------------------------------
cd /d "%~dp0"
start "" "http://127.0.0.1:8767"
echo.
echo Server started successfully! Browser opened at http://127.0.0.1:8767
echo Please DO NOT close this window, otherwise the server will be disconnected.
echo ------------------------------------------
python server.py
pause
