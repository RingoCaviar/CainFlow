param(
  [ValidateSet("source", "release")]
  [string]$Mode = "source",
  [string]$Python = "python",
  [string]$ZipPath = "",
  [int]$StartupTimeoutSeconds = 45,
  [switch]$PauseOnExit,
  [switch]$PauseOnFailure,
  [switch]$NoPause
)

$ErrorActionPreference = "Stop"

. (Join-Path (Split-Path -Parent $PSCommandPath) "script-ui.ps1")

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Resolve-RepoRoot {
  $scriptDir = Split-Path -Parent $PSCommandPath
  return (Resolve-Path (Join-Path $scriptDir "..")).Path
}

function Remove-PathIfExists {
  param([string]$Path)
  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Recurse -Force
  }
}

function Stop-CainFlowProcessTree {
  param([System.Diagnostics.Process]$Process)

  if ($Process -and !$Process.HasExited) {
    try {
      Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
    } catch {}
  }

  try {
    $listeners = Get-NetTCPConnection -LocalPort 8767 -State Listen -ErrorAction SilentlyContinue
    foreach ($listener in $listeners) {
      if ($listener.OwningProcess) {
        Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
      }
    }
  } catch {}
}

function Start-BackgroundProcess {
  param(
    [string]$WorkingDirectory,
    [string]$CommandPath,
    [string[]]$CommandArguments,
    [string]$StdoutPath,
    [string]$StderrPath
  )

  $commandLiteral = "'" + $CommandPath.Replace("'", "''") + "'"
  $argumentLiteral = if ($CommandArguments.Count -gt 0) {
    ($CommandArguments | ForEach-Object { "'" + $_.Replace("'", "''") + "'" }) -join ", "
  } else {
    ""
  }

  $bootstrap = @"
$env:CAINFLOW_SKIP_BROWSER_AUTO_OPEN = '1'
$env:CAINFLOW_SKIP_FATAL_PAUSE = '1'
Set-Location -LiteralPath '$WorkingDirectory'
`$argsList = @($argumentLiteral)
& $commandLiteral @argsList
"@

  $encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($bootstrap))

  return Start-Process `
    -FilePath "powershell" `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", $encoded) `
    -WorkingDirectory $WorkingDirectory `
    -RedirectStandardOutput $StdoutPath `
    -RedirectStandardError $StderrPath `
    -WindowStyle Hidden `
    -PassThru
}

function Wait-ForCainFlowHealthy {
  param(
    [string]$BaseUrl,
    [int]$TimeoutSeconds
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $lastError = $null

  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -Uri $BaseUrl -UseBasicParsing -TimeoutSec 3
      $content = [string]$response.Content
      if (
        $response.StatusCode -eq 200 `
        -and $content.Contains("CainFlow") `
        -and $content.Contains('id="toolbar"') `
        -and $content.Contains('id="canvas-container"') `
        -and $content.Contains('id="workflow-sidebar"')
      ) {
        return $response
      }
      $lastError = "Received HTTP $($response.StatusCode), but required CainFlow markers were not found."
    } catch {
      $lastError = $_.Exception.Message
    }

    Start-Sleep -Seconds 1
  }

  throw "CainFlow did not become healthy within $TimeoutSeconds seconds. Last error: $lastError"
}

function Invoke-ReleaseMode {
  param(
    [string]$ResolvedZipPath,
    [int]$TimeoutSeconds
  )

  if (!(Test-Path -LiteralPath $ResolvedZipPath -PathType Leaf)) {
    throw "Release zip not found: $ResolvedZipPath"
  }

  $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("cainflow-smoke-" + [guid]::NewGuid().ToString("N"))
  $stdoutPath = Join-Path $tempRoot "stdout.log"
  $stderrPath = Join-Path $tempRoot "stderr.log"
  $extractDir = Join-Path $tempRoot "package"
  $process = $null

  New-Item -ItemType Directory -Path $extractDir -Force | Out-Null

  try {
    Expand-Archive -LiteralPath $ResolvedZipPath -DestinationPath $extractDir -Force
    $programPath = Join-Path $extractDir "CainFlow.exe"
    if (!(Test-Path -LiteralPath $programPath -PathType Leaf)) {
      throw "CainFlow.exe was not found after extracting the release package."
    }

    $process = Start-BackgroundProcess `
      -WorkingDirectory $extractDir `
      -CommandPath $programPath `
      -CommandArguments @() `
      -StdoutPath $stdoutPath `
      -StderrPath $stderrPath

    $null = Wait-ForCainFlowHealthy -BaseUrl "http://127.0.0.1:8767/" -TimeoutSeconds $TimeoutSeconds
  } finally {
    Stop-CainFlowProcessTree -Process $process
    Remove-PathIfExists -Path $tempRoot
  }
}

function Invoke-SourceMode {
  param(
    [string]$RepoRoot,
    [string]$PythonCommand,
    [int]$TimeoutSeconds
  )

  $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("cainflow-source-smoke-" + [guid]::NewGuid().ToString("N"))
  $stdoutPath = Join-Path $tempRoot "stdout.log"
  $stderrPath = Join-Path $tempRoot "stderr.log"
  $process = $null

  New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

  try {
    $process = Start-BackgroundProcess `
      -WorkingDirectory $RepoRoot `
      -CommandPath $PythonCommand `
      -CommandArguments @("server.py") `
      -StdoutPath $stdoutPath `
      -StderrPath $stderrPath

    $null = Wait-ForCainFlowHealthy -BaseUrl "http://127.0.0.1:8767/" -TimeoutSeconds $TimeoutSeconds
  } finally {
    Stop-CainFlowProcessTree -Process $process
    Remove-PathIfExists -Path $tempRoot
  }
}

$repoRoot = $null
$succeeded = $false
$failure = $null
$summaryLines = @()

try {
  $repoRoot = Resolve-RepoRoot

  Write-Step "Running CainFlow smoke test"
  Write-Host "Mode: $Mode"

  if ($Mode -eq "source") {
    Invoke-SourceMode -RepoRoot $repoRoot -PythonCommand $Python -TimeoutSeconds $StartupTimeoutSeconds
    $summaryLines = @(
      "Mode: source",
      "Python command: $Python",
      "Startup timeout: $StartupTimeoutSeconds seconds",
      "CainFlow source smoke test passed"
    )
  } else {
    Invoke-ReleaseMode -ResolvedZipPath $ZipPath -TimeoutSeconds $StartupTimeoutSeconds
    $summaryLines = @(
      "Mode: release",
      "Release zip: $ZipPath",
      "Startup timeout: $StartupTimeoutSeconds seconds",
      "CainFlow release smoke test passed"
    )
  }

  $succeeded = $true
} catch {
  $failure = $_.Exception
  $summaryLines = @(
    "Mode: $Mode",
    "Startup timeout: $StartupTimeoutSeconds seconds",
    "Error: $($failure.Message)"
  )
  if ($Mode -eq "release" -and $ZipPath) {
    $summaryLines += "Release zip: $ZipPath"
  }
}

Show-ScriptResult `
  -Title "CainFlow smoke test" `
  -Succeeded:$succeeded `
  -SummaryLines $summaryLines `
  -PauseOnExit:$PauseOnExit `
  -PauseOnFailure:$PauseOnFailure `
  -NoPause:$NoPause

if (!$succeeded) {
  exit 1
}
