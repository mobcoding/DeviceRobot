@echo off
setlocal EnableExtensions

cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-devicerobot-background.ps1"
set "exitCode=%ERRORLEVEL%"

if not "%exitCode%"=="0" (
  echo.
  echo DeviceRobot startup failed. Read the output and runtime logs above.
  pause
  endlocal & exit /b %exitCode%
)

set "launchNonce=%RANDOM%%RANDOM%%RANDOM%"
start "" "http://127.0.0.1:43110/?reload=%launchNonce%"
endlocal & exit /b 0
