function Get-ParentProcessName {
  try {
    $current = Get-CimInstance Win32_Process -Filter "ProcessId = $PID" -ErrorAction SilentlyContinue
    if (!$current -or !$current.ParentProcessId) {
      return ""
    }

    $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($current.ParentProcessId)" -ErrorAction SilentlyContinue
    if (!$parent -or $null -eq $parent.Name) {
      return ""
    }
    return [string]$parent.Name
  } catch {
    return ""
  }
}

function Test-ShouldPauseForUser {
  param(
    [bool]$Succeeded,
    [switch]$PauseOnExit,
    [switch]$PauseOnFailure,
    [switch]$NoPause
  )

  if ($NoPause) {
    return $false
  }

  if ($env:CI -eq "true" -or $env:GITHUB_ACTIONS -eq "true") {
    return $false
  }

  if ($PauseOnExit) {
    return $true
  }

  if (!$Succeeded -and $PauseOnFailure) {
    return $true
  }

  $parentName = (Get-ParentProcessName).ToLowerInvariant()
  return $parentName -eq "explorer.exe"
}

function Show-ScriptResult {
  param(
    [string]$Title,
    [bool]$Succeeded,
    [string[]]$SummaryLines = @(),
    [switch]$PauseOnExit,
    [switch]$PauseOnFailure,
    [switch]$NoPause
  )

  $banner = if ($Succeeded) { "PASSED" } else { "FAILED" }
  $color = if ($Succeeded) { "Green" } else { "Red" }

  Write-Host ""
  Write-Host ("=" * 58) -ForegroundColor $color
  Write-Host ("{0}: {1}" -f $Title, $banner) -ForegroundColor $color
  Write-Host ("=" * 58) -ForegroundColor $color
  foreach ($line in $SummaryLines) {
    if (![string]::IsNullOrWhiteSpace($line)) {
      Write-Host $line
    }
  }

  if (Test-ShouldPauseForUser -Succeeded:$Succeeded -PauseOnExit:$PauseOnExit -PauseOnFailure:$PauseOnFailure -NoPause:$NoPause) {
    Write-Host ""
    Read-Host "Press Enter to close this window" | Out-Null
  }
}
