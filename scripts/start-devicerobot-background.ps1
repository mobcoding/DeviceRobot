[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$localAppData = if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
  [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
} else {
  $env:LOCALAPPDATA
}
$runtimeDirectory = Join-Path $localAppData "AIMobileTester\runtime"
$logDirectory = Join-Path $localAppData "AIMobileTester\logs"
$statePath = Join-Path $runtimeDirectory "background-agent.json"
$agentOutputLog = Join-Path $logDirectory "agent-output.log"
$agentErrorLog = Join-Path $logDirectory "agent-error.log"

function Invoke-Pnpm {
  param([Parameter(Mandatory = $true)][string[]]$PnpmArguments)

  if ($null -ne $script:pnpmCommand) {
    & $script:pnpmCommand.Source @PnpmArguments
  } else {
    & $script:corepackCommand.Source pnpm @PnpmArguments
  }

  if ($LASTEXITCODE -ne 0) {
    throw "pnpm command failed: pnpm $($PnpmArguments -join ' ')"
  }
}

function Stop-DeviceRobotListeners {
  param([Parameter(Mandatory = $true)][int]$Port)

  & (Join-Path $PSScriptRoot "stop-devicerobot-listeners.ps1") -Port $Port
  if (-not $?) {
    throw "Unable to release DeviceRobot port $Port."
  }
}

try {
  $script:nodeCommand = Get-Command node -ErrorAction Stop
  $script:pnpmCommand = Get-Command pnpm -ErrorAction SilentlyContinue
  $script:corepackCommand = if ($null -eq $script:pnpmCommand) {
    Get-Command corepack -ErrorAction Stop
  } else {
    $null
  }

  New-Item -ItemType Directory -Force -Path $runtimeDirectory, $logDirectory | Out-Null

  Write-Host "正在停止已有的 DeviceRobot 服务..."
  Stop-DeviceRobotListeners -Port 43110
  Stop-DeviceRobotListeners -Port 5173

  $adbCommand = Get-Command adb -ErrorAction SilentlyContinue
  if ($null -eq $adbCommand) {
    Write-Warning "未在 PATH 中找到 ADB。Agent 启动后会在页面显示 Android SDK 诊断信息。"
  } else {
    $adbOutputLog = Join-Path $runtimeDirectory "adb-start-output.log"
    $adbErrorLog = Join-Path $runtimeDirectory "adb-start-error.log"
    Write-Host "正在启动 ADB 服务..."
    Remove-Item -LiteralPath $adbOutputLog, $adbErrorLog -Force -ErrorAction SilentlyContinue
    $adbProcess = Start-Process `
      -FilePath $adbCommand.Source `
      -ArgumentList @("start-server") `
      -WindowStyle Hidden `
      -Wait `
      -PassThru `
      -RedirectStandardOutput $adbOutputLog `
      -RedirectStandardError $adbErrorLog
    if ($adbProcess.ExitCode -ne 0) {
      $adbError = if (Test-Path -LiteralPath $adbErrorLog) {
        (Get-Content -LiteralPath $adbErrorLog -Raw).Trim()
      } else {
        ""
      }
      throw "Unable to start ADB (exit code $($adbProcess.ExitCode)). $adbError"
    }
    Remove-Item -LiteralPath $adbOutputLog, $adbErrorLog -Force -ErrorAction SilentlyContinue
  }

  Write-Host "正在构建 DeviceRobot 依赖包..."
  Invoke-Pnpm -PnpmArguments @("run", "build:packages")
  Write-Host "正在构建 Web 页面..."
  Invoke-Pnpm -PnpmArguments @("--filter", "@device-robot/web", "run", "build")
  Write-Host "正在构建本地 Agent..."
  Invoke-Pnpm -PnpmArguments @("--filter", "@device-robot/agent", "run", "build")

  Stop-DeviceRobotListeners -Port 43110
  Remove-Item -LiteralPath $agentOutputLog, $agentErrorLog -Force -ErrorAction SilentlyContinue

  Write-Host "正在后台启动 DeviceRobot Agent..."
  $previousNodeEnvironment = $env:NODE_ENV
  $env:NODE_ENV = "production"
  try {
    $agentProcess = Start-Process `
      -FilePath $script:nodeCommand.Source `
      -ArgumentList @("apps/agent/dist/server.js") `
      -WorkingDirectory $repositoryRoot `
      -WindowStyle Hidden `
      -RedirectStandardOutput $agentOutputLog `
      -RedirectStandardError $agentErrorLog `
      -PassThru
  } finally {
    $env:NODE_ENV = $previousNodeEnvironment
  }

  $agentReady = $false
  for ($attempt = 1; $attempt -le 15; $attempt += 1) {
    Start-Sleep -Seconds 1
    try {
      $health = Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 `
        "http://127.0.0.1:43110/api/v1/system/health"
      if ($health.StatusCode -eq 200) {
        $agentReady = $true
        break
      }
    } catch {
      # The agent is still starting. The final failure includes the log location.
    }
  }

  if (-not $agentReady) {
    if (-not $agentProcess.HasExited) {
      Stop-Process -Id $agentProcess.Id -Force -ErrorAction SilentlyContinue
    }
    throw "Agent did not become ready within 15 seconds. Read $agentOutputLog and $agentErrorLog."
  }

  [pscustomobject]@{
    processId = $agentProcess.Id
    startedAt = (Get-Date).ToUniversalTime().ToString("o")
    url = "http://127.0.0.1:43110"
    outputLog = $agentOutputLog
    errorLog = $agentErrorLog
  } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8

  Write-Host ""
  Write-Host "DeviceRobot 已在后台启动。"
  Write-Host "访问地址：http://127.0.0.1:43110"
  Write-Host "现在可以关闭此命令行窗口。"
  Write-Host "停止服务：双击 stop-devicerobot.bat"
} catch {
  Write-Error $_
  exit 1
}


