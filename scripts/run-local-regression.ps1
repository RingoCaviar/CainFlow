param(
  [string]$Python = "python",
  [string]$Node = "node",
  [switch]$PauseOnExit,
  [switch]$PauseOnFailure,
  [switch]$NoPause
)

$ErrorActionPreference = "Stop"

. (Join-Path (Split-Path -Parent $PSCommandPath) "script-ui.ps1")

function Resolve-RepoRoot {
  $scriptDir = Split-Path -Parent $PSCommandPath
  return (Resolve-Path (Join-Path $scriptDir "..")).Path
}

$repoRoot = $null
$succeeded = $false
$failure = $null
$summaryLines = @()

try {
  $repoRoot = Resolve-RepoRoot
  $validateScript = Join-Path $repoRoot "scripts\validate-release-readiness.ps1"
  $smokeScript = Join-Path $repoRoot "scripts\smoke-test-cainflow.ps1"
  $checklistPath = Join-Path $repoRoot "docs\qa\browser-smoke-checklist.md"
  $workflowFixtureRoot = Join-Path $repoRoot "workflows\regression"

  & $validateScript -Python $Python -Node $Node -NoPause
  if ($LASTEXITCODE -ne 0) {
    throw "Release readiness validation failed."
  }

  & $smokeScript -Mode source -Python $Python -NoPause
  if ($LASTEXITCODE -ne 0) {
    throw "CainFlow source smoke test failed."
  }

  $succeeded = $true
  $summaryLines = @(
    "Python command: $Python",
    "Node command: $Node",
    "Release readiness validation: passed",
    "CainFlow source smoke test: passed",
    "Manual browser checklist: $checklistPath",
    "Regression workflow fixtures: $workflowFixtureRoot"
  )
} catch {
  $failure = $_.Exception
  $summaryLines = @(
    "Python command: $Python",
    "Node command: $Node",
    "Error: $($failure.Message)"
  )
}

Show-ScriptResult `
  -Title "Local regression gate" `
  -Succeeded:$succeeded `
  -SummaryLines $summaryLines `
  -PauseOnExit:$PauseOnExit `
  -PauseOnFailure:$PauseOnFailure `
  -NoPause:$NoPause

if (!$succeeded) {
  exit 1
}
