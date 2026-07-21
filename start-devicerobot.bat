@echo off
setlocal

cd /d "%~dp0"

where pnpm >nul 2>nul
if errorlevel 1 (
  echo pnpm was not found. Run the Corepack registration command and try again.
  pause
  exit /b 1
)

call :stop_listener 43110
call :stop_listener 5173
timeout /t 1 /nobreak >nul

echo Starting DeviceRobot Agent and Web services...
call pnpm dev
set "exitCode=%ERRORLEVEL%"

if not "%exitCode%"=="0" (
  echo.
  echo DeviceRobot stopped with exit code %exitCode%.
  pause
)

endlocal & exit /b %exitCode%

:stop_listener
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r /c:":%~1 .*LISTENING"') do (
  echo Stopping the existing DeviceRobot listener on port %~1...
  taskkill /pid %%P /t /f >nul 2>nul
)
exit /b
