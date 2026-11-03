param(
  [string]$TagName = "",
  [string]$Python = "python",
  [string]$Node = "node",
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

function Get-AppVersionNumber {
  param([string]$RepoRoot)

  $constantsPath = Join-Path $RepoRoot "js\core\constants.js"
  if (!(Test-Path -LiteralPath $constantsPath -PathType Leaf)) {
    throw "App version source not found: $constantsPath"
  }

  $content = Get-Content -LiteralPath $constantsPath -Raw -Encoding UTF8
  $match = [regex]::Match($content, "export\s+const\s+APP_VERSION_NUMBER\s*=\s*['""]([^'""]+)['""]")
  if (!$match.Success) {
    throw "APP_VERSION_NUMBER was not found in $constantsPath"
  }

  $version = $match.Groups[1].Value.Trim()
  if ([string]::IsNullOrWhiteSpace($version)) {
    throw "APP_VERSION_NUMBER is empty."
  }

  return $version
}

function Assert-ReleaseTagMatchesVersion {
  param(
    [string]$ResolvedTagName,
    [string]$VersionNumber
  )

  if ([string]::IsNullOrWhiteSpace($ResolvedTagName)) {
    return
  }

  if ($ResolvedTagName -notmatch "^v") {
    Write-Host "Skipping version/tag strict match for non-release tag: $ResolvedTagName" -ForegroundColor DarkYellow
    return
  }

  $expectedTag = "v$VersionNumber"
  if ($ResolvedTagName -ne $expectedTag) {
    throw "Release tag mismatch. Expected $expectedTag from APP_VERSION_NUMBER, got $ResolvedTagName."
  }
}

function Assert-CommandAvailable {
  param([string]$CommandName)

  if (!(Get-Command $CommandName -ErrorAction SilentlyContinue)) {
    throw "Required command was not found in PATH: $CommandName"
  }
}

function Invoke-MediaAssetSafetyGate {
  param([string]$RepoRoot, [string]$PythonCommand)
  $reportPath = Join-Path $RepoRoot "artifacts\media-asset-safety-report.json"
  Push-Location $RepoRoot
  try {
    & $PythonCommand -m backend.services.media_safety_gate --output $reportPath
    if ($LASTEXITCODE -ne 0) { throw "Media asset safety gate failed." }
  } finally { Pop-Location }
}

function Invoke-WorkflowFixtureChecks {
  param([string]$RepoRoot)

  $fixtureRoot = Join-Path $RepoRoot "workflows\regression"
  if (!(Test-Path -LiteralPath $fixtureRoot -PathType Container)) {
    Write-Host "Regression workflow directory not found yet, skipping fixture validation." -ForegroundColor DarkYellow
    return
  }

  Get-ChildItem -LiteralPath $fixtureRoot -Filter *.json -File | ForEach-Object {
    Write-Host "Validating workflow fixture JSON: $($_.Name)"
    $raw = Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8
    $null = $raw | ConvertFrom-Json
  }
}

$repoRoot = $null
$appVersion = $null
$succeeded = $false
$failure = $null
$summaryLines = @()

try {
  $repoRoot = Resolve-RepoRoot
  $appVersion = Get-AppVersionNumber -RepoRoot $repoRoot

  Write-Step "Resolved repository root"
  Write-Host $repoRoot

  Write-Step "Resolved CainFlow app version"
  Write-Host "APP_VERSION_NUMBER = $appVersion"

  Assert-ReleaseTagMatchesVersion -ResolvedTagName $TagName -VersionNumber $appVersion

  $notesTag = if ([string]::IsNullOrWhiteSpace($TagName)) { "v$appVersion" } else { $TagName }
  Write-Step "Validating release notes"
  & (Join-Path $repoRoot "scripts\validate-release-notes.ps1") -TagName $notesTag

  Write-Step "Checking required toolchain"
  Assert-CommandAvailable -CommandName $Node
  Assert-CommandAvailable -CommandName $Python
  Write-Host "Node command: $Node"
  Write-Host "Python command: $Python"

  Write-Step "Running complete regression (all tiers)"
  & (Join-Path $repoRoot "scripts\check-full.ps1") -Python $Python -Node $Node
  if ($LASTEXITCODE -ne 0) { throw "Complete regression failed." }

  Write-Step "Validating regression workflow fixtures"
  Invoke-WorkflowFixtureChecks -RepoRoot $repoRoot

  Write-Step "Generating Media asset safety report"
  Invoke-MediaAssetSafetyGate -RepoRoot $repoRoot -PythonCommand $Python

  $succeeded = $true
  $summaryLines = @(
    "Repository root: $repoRoot",
    "APP_VERSION_NUMBER: $appVersion",
    "Frontend syntax checks: passed",
    "Complete Node test suite: passed",
    "Backend compile checks: passed",
    "Complete Python test suite: passed",
    "Desktop and SQLite initialization: passed",
    "Media asset safety gate: passed",
    "Regression workflow fixtures: passed"
  )
} catch {
  $failure = $_.Exception
  $summaryLines = @(
    "Repository root: $repoRoot",
    "APP_VERSION_NUMBER: $appVersion",
    "Error: $($failure.Message)"
  )
}

Show-ScriptResult `
  -Title "Release readiness validation" `
  -Succeeded:$succeeded `
  -SummaryLines $summaryLines `
  -PauseOnExit:$PauseOnExit `
  -PauseOnFailure:$PauseOnFailure `
  -NoPause:$NoPause

if (!$succeeded) {
  exit 1
}
