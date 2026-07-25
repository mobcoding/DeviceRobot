[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [int]$Port
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($Port -notin 43110, 5173) {
  throw "Only the DeviceRobot Agent port 43110 and Web port 5173 can be stopped."
}

function Get-ListenerProcessIds {
  param([int]$Port)

  return @(
    Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess
  )
}

function Get-DeviceRobotLauncherProcessId {
  param(
    [int]$ProcessId,
    [int]$Port
  )

  $currentProcessId = $ProcessId
  for ($depth = 0; $depth -lt 12; $depth += 1) {
    $processInfo = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $currentProcessId"
    if ($null -eq $processInfo) {
      break
    }

    $role = if ($Port -eq 43110) { "agent" } else { "web" }
    if ($processInfo.CommandLine -match "@device-robot/$role run (dev|start)") {
      return [int]$processInfo.ProcessId
    }

    if ($processInfo.ParentProcessId -eq $processInfo.ProcessId) {
      break
    }
    $currentProcessId = [int]$processInfo.ParentProcessId
  }

  return $ProcessId
}

function Stop-ProcessTree {
  param([int]$ProcessId)

  $children = @(
    Get-CimInstance -ClassName Win32_Process -Filter "ParentProcessId = $ProcessId" -ErrorAction SilentlyContinue
  )
  foreach ($child in $children) {
    Stop-ProcessTree -ProcessId ([int]$child.ProcessId)
  }
  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

try {
  $role = if ($Port -eq 43110) { "agent" } else { "web" }
  $launchers = @(
    Get-CimInstance -ClassName Win32_Process |
      Where-Object { $_.CommandLine -match "@device-robot/$role run (dev|start)" }
  )
  foreach ($launcher in $launchers) {
    Write-Host "Stopping the existing DeviceRobot $role process..."
    Stop-ProcessTree -ProcessId ([int]$launcher.ProcessId)
  }

  $listenerIds = @(Get-ListenerProcessIds -Port $Port)
  foreach ($listenerId in $listenerIds) {
    $launcherId = Get-DeviceRobotLauncherProcessId -ProcessId $listenerId -Port $Port
    Write-Host "Stopping the existing DeviceRobot listener on port $Port..."
    Stop-ProcessTree -ProcessId $launcherId
  }

  for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
    if (@(Get-ListenerProcessIds -Port $Port).Count -eq 0) {
      break
    }
    Start-Sleep -Milliseconds 250
  }

  if (@(Get-ListenerProcessIds -Port $Port).Count -gt 0) {
    throw "Port $Port is still in use after stopping DeviceRobot."
  }
} catch {
  Write-Error $_
  exit 1
}
