@echo off
setlocal

cd /d "%~dp0"

where pnpm >nul 2>nul
if not errorlevel 1 goto start_with_pnpm

where corepack >nul 2>nul
if errorlevel 1 (
  echo Neither pnpm nor Corepack was found. Install Node.js with Corepack enabled and try again.
  pause
  exit /b 1
)

echo pnpm was not found. Using Corepack instead.
set "COREPACK_PNPM_SHIM=%TEMP%\DeviceRobot\pnpm-shim"
if not exist "%COREPACK_PNPM_SHIM%" mkdir "%COREPACK_PNPM_SHIM%"
if not exist "%COREPACK_PNPM_SHIM%" (
  echo Could not create the temporary pnpm compatibility folder.
  pause
  exit /b 1
)

> "%COREPACK_PNPM_SHIM%\pnpm.cmd" echo @echo off
>> "%COREPACK_PNPM_SHIM%\pnpm.cmd" echo call corepack pnpm %%*
set "PATH=%COREPACK_PNPM_SHIM%;%PATH%"

echo Starting DeviceRobot Agent and Web services...
call corepack pnpm dev
set "exitCode=%ERRORLEVEL%"
goto report_result

:start_with_pnpm
echo Starting DeviceRobot Agent and Web services...
call pnpm dev
set "exitCode=%ERRORLEVEL%"

:report_result

if not "%exitCode%"=="0" (
  echo.
  echo DeviceRobot stopped with exit code %exitCode%.
  pause
)

endlocal & exit /b %exitCode%
