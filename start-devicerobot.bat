@echo off
setlocal

cd /d "%~dp0"

where pnpm >nul 2>nul
if errorlevel 1 (
  echo pnpm was not found. Run the Corepack registration command and try again.
  pause
  exit /b 1
)

echo Starting DeviceRobot Agent and Web services...
call pnpm dev
set "exitCode=%ERRORLEVEL%"

if not "%exitCode%"=="0" (
  echo.
  echo DeviceRobot stopped with exit code %exitCode%.
  pause
)

endlocal & exit /b %exitCode%
