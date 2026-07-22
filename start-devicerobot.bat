@echo off
setlocal EnableExtensions

cd /d "%~dp0"

set "PNPM_COMMAND=pnpm"
where pnpm >nul 2>nul
if errorlevel 1 (
  where corepack >nul 2>nul
  if errorlevel 1 (
    echo pnpm and Corepack were not found. Install Node.js with Corepack enabled, then run this script again.
    pause
    exit /b 1
  )
  set "PNPM_COMMAND=corepack pnpm"
  echo pnpm was not found. Using Corepack instead.
)

call :stop_listener 43110
call :stop_listener 5173
timeout /t 1 /nobreak >nul

call :prepare_adb

echo Starting DeviceRobot Agent and Web services...
call %PNPM_COMMAND% dev
set "exitCode=%ERRORLEVEL%"

if not "%exitCode%"=="0" (
  echo.
  echo DeviceRobot stopped with exit code %exitCode%.
  pause
)

endlocal & exit /b %exitCode%

:prepare_adb
where adb >nul 2>nul
if errorlevel 1 (
  echo ADB was not found on PATH. DeviceRobot will report the Android SDK diagnostic in the web page.
  exit /b
)

echo Starting ADB server...
adb start-server >nul 2>nul
for /f "skip=1 tokens=1,2" %%A in ('adb devices 2^>nul') do (
  if "%%B"=="unauthorized" (
    echo Device %%A is waiting for USB debugging authorization. Unlock the phone and accept the RSA fingerprint prompt.
  ) else if "%%B"=="offline" (
    echo Device %%A is offline. Reconnect the USB cable, unlock the phone, and accept the USB debugging prompt.
  ) else if "%%B"=="device" (
    echo Device %%A is ready.
  )
)
exit /b

:stop_listener
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r /c:":%~1 .*LISTENING"') do (
  echo Stopping the existing DeviceRobot listener on port %~1...
  taskkill /pid %%P /t /f >nul 2>nul
)
exit /b
