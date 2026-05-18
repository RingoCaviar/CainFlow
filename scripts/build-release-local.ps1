param(
  [string]$TagName,
  [string]$Python = "python",
  [switch]$SkipDependencyInstall
)

$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Resolve-RepoRoot {
  $scriptDir = Split-Path -Parent $PSCommandPath
  return (Resolve-Path (Join-Path $scriptDir "..")).Path
}

function Get-GitValue {
  param([string[]]$Arguments)

  try {
    $value = & git @Arguments 2>$null
    if ($LASTEXITCODE -eq 0) {
      return ($value | Select-Object -First 1)
    }
  } catch {
    return $null
  }

  return $null
}

function Get-ReleaseName {
  if ($TagName) {
    return $TagName
  }

  $exactTag = Get-GitValue @("describe", "--tags", "--exact-match")
  if ($exactTag) {
    return $exactTag
  }

  $branch = Get-GitValue @("rev-parse", "--abbrev-ref", "HEAD")
  $sha = Get-GitValue @("rev-parse", "--short=7", "HEAD")
  if ($branch -and $sha -and $branch -ne "HEAD") {
    return "$branch-$sha"
  }

  if ($sha) {
    return "local-$sha"
  }

  return "local-$(Get-Date -Format 'yyyyMMddHHmmss')"
}

function Remove-PathIfExists {
  param([string]$Path)

  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Recurse -Force
  }
}

$repoRoot = Resolve-RepoRoot
Set-Location $repoRoot

Write-Step "Using repository root: $repoRoot"

if (!(Test-Path -LiteralPath "server.py")) {
  throw "server.py was not found. Run this script from the CainFlow repository checkout."
}

if (!$SkipDependencyInstall) {
  Write-Step "Installing build dependencies"
  & $Python -m pip install --upgrade pip
  & $Python -m pip install pyinstaller
  if (Test-Path -LiteralPath "requirements.txt") {
    & $Python -m pip install -r requirements.txt
  }
} else {
  Write-Step "Skipping dependency install"
}

Write-Step "Ensuring asset directories exist"
foreach ($directory in @("css", "js", "sounds")) {
  if (!(Test-Path -LiteralPath $directory)) {
    New-Item -ItemType Directory -Path $directory | Out-Null
  }
}

Write-Step "Cleaning previous local build outputs"
Remove-PathIfExists "build"
Remove-PathIfExists "dist"
Remove-PathIfExists "release_staging"
Remove-PathIfExists "CainFlow_Launcher.spec"

$releaseName = Get-ReleaseName
$zipName = "Cainflow_$releaseName.zip"
Remove-PathIfExists $zipName

Write-Step "Building CainFlow_Launcher.exe with PyInstaller"
& pyinstaller --onefile --name "CainFlow_Launcher" --icon "cainflow.ico" `
  --add-data "index.html;." `
  --add-data "index.js;." `
  --add-data "index.css;." `
  --add-data "cainflow.ico;." `
  --add-data "css;css" `
  --add-data "js;js" `
  --add-data "sounds;sounds" `
  server.py

if (!(Test-Path -LiteralPath "dist/CainFlow_Launcher.exe")) {
  throw "PyInstaller completed, but dist/CainFlow_Launcher.exe was not found."
}

Write-Step "Preparing release_staging"
New-Item -ItemType Directory -Path "release_staging" | Out-Null
Copy-Item -LiteralPath "dist/CainFlow_Launcher.exe" -Destination "release_staging/CainFlow.exe"

if (Test-Path -LiteralPath "workflows") {
  Copy-Item -LiteralPath "workflows" -Destination "release_staging" -Recurse
} else {
  New-Item -ItemType Directory -Path "release_staging/workflows" | Out-Null
}

Write-Step "Creating $zipName"
Compress-Archive -Path "release_staging/*" -DestinationPath $zipName -Force

Write-Step "Cleaning temporary build files"
Remove-PathIfExists "build"
Remove-PathIfExists "dist"
Remove-PathIfExists "release_staging"
Remove-PathIfExists "CainFlow_Launcher.spec"

$zipPath = (Resolve-Path $zipName).Path
Write-Host ""
Write-Host "Done: $zipPath" -ForegroundColor Green
