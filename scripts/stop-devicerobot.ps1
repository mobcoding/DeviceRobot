[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$localAppData = if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
  [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
} else {
  $env:LOCALAPPDATA
}
$statePath = Join-Path $localAppData "AIMobileTester\runtime\background-agent.json"

try {
  Write-Host "正在停止 DeviceRobot Agent..."
  & (Join-Path $PSScriptRoot "stop-devicerobot-listeners.ps1") -Port 43110
  if (-not $?) {
    throw "Unable to stop the DeviceRobot Agent."
  }

  Write-Host "正在停止 DeviceRobot Web 开发服务..."
  & (Join-Path $PSScriptRoot "stop-devicerobot-listeners.ps1") -Port 5173
  if (-not $?) {
    throw "Unable to stop the DeviceRobot Web development service."
  }

  Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
  Write-Host "DeviceRobot 已停止。"
} catch {
  Write-Error $_
  exit 1
}


