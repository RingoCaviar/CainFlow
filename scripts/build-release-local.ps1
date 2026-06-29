param(
  [string]$TagName,
  [string]$Python = "python",
  [switch]$SkipDependencyInstall,
  [switch]$SkipReadinessValidation,
  [ValidateSet("auto", "windows", "macos")]
  [string]$TargetPlatform = "auto"
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

function Get-SafeFileNamePart {
  param([string]$Value)

  $source = if ($null -eq $Value) { '' } else { $Value }
  $safe = [regex]::Replace($source, '[<>:"/\\|?*]', '-')
  $safe = $safe.Trim().TrimEnd('.')
  if ([string]::IsNullOrWhiteSpace($safe)) {
    return 'local'
  }
  return $safe
}

function Remove-PathIfExists {
  param([string]$Path)

  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Recurse -Force
  }
}

function Get-HostPlatform {
  if ($env:OS -eq "Windows_NT") {
    return "windows"
  }

  $uname = ""
  try {
    $uname = (& uname -s 2>$null | Select-Object -First 1)
  } catch {
    $uname = ""
  }

  $uname = "$uname".Trim().ToLowerInvariant()
  if ($uname -eq "darwin") {
    return "macos"
  }
  if ($uname -eq "linux") {
    return "linux"
  }

  return "unknown"
}

function Resolve-TargetPlatform {
  param(
    [string]$RequestedPlatform,
    [string]$HostPlatform
  )

  $resolvedPlatform = if ($RequestedPlatform -eq "auto") { $HostPlatform } else { $RequestedPlatform }
  if ($resolvedPlatform -notin @("windows", "macos")) {
    throw "Unsupported release target platform: $resolvedPlatform. Supported targets are windows and macos."
  }
  if ($HostPlatform -ne $resolvedPlatform) {
    throw "PyInstaller cannot cross-package CainFlow from $HostPlatform to $resolvedPlatform. Run this script on a $resolvedPlatform host or runner."
  }

  return $resolvedPlatform
}

function Join-PyInstallerDataSpec {
  param(
    [string]$Source,
    [string]$Destination,
    [string]$Separator
  )

  return "$Source$Separator$Destination"
}

function Invoke-NativeCommand {
  param(
    [string]$Command,
    [string[]]$Arguments
  )

  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code ${LASTEXITCODE}: $Command $($Arguments -join ' ')"
  }
}

function New-ReleaseZip {
  param(
    [string]$StagingDirectory,
    [string]$ZipName,
    [string]$Platform
  )

  if ($Platform -eq "macos") {
    $zipCommand = Get-Command zip -ErrorAction SilentlyContinue
    if (!$zipCommand) {
      throw "The zip command is required for macOS release packages so executable permissions are preserved."
    }

    $zipExecutable = if ($zipCommand.Path) { $zipCommand.Path } else { $zipCommand.Source }
    Push-Location $StagingDirectory
    try {
      Invoke-NativeCommand $zipExecutable @("-r", "../$ZipName", ".")
    } finally {
      Pop-Location
    }
    return
  }

  Compress-Archive -Path "$StagingDirectory/*" -DestinationPath $ZipName -Force
}

$repoRoot = Resolve-RepoRoot
Set-Location $repoRoot

Write-Step "Using repository root: $repoRoot"

if (!(Test-Path -LiteralPath "server.py")) {
  throw "server.py was not found. Run this script from the CainFlow repository checkout."
}

if (!$SkipReadinessValidation) {
  Write-Step "Running release readiness validation"
  & "$repoRoot\scripts\validate-release-readiness.ps1" -TagName $TagName -Python $Python
  if ($LASTEXITCODE -ne 0) {
    throw "Release readiness validation failed."
  }
} else {
  Write-Step "Skipping release readiness validation"
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

$hostPlatform = Get-HostPlatform
$targetPlatform = Resolve-TargetPlatform -RequestedPlatform $TargetPlatform -HostPlatform $hostPlatform
$isWindowsTarget = $targetPlatform -eq "windows"
$dataSeparator = if ($isWindowsTarget) { ";" } else { ":" }
$launcherBaseName = "CainFlow_Launcher"
$launcherFileName = if ($isWindowsTarget) { "$launcherBaseName.exe" } else { $launcherBaseName }
$releaseProgramName = if ($isWindowsTarget) { "CainFlow.exe" } else { "CainFlow" }
$specFileName = "$launcherBaseName.spec"
$distProgramPath = Join-Path "dist" $launcherFileName
$stagingDirectory = "release_staging"
$stagedProgramPath = Join-Path $stagingDirectory $releaseProgramName

Write-Step "Target platform: $targetPlatform"

Write-Step "Checking required release inputs"
foreach ($file in @("server.py", "index.html", "index.js", "index.css", "js/services/notification-sw.js", "cainflow.ico", "backend/routes/media_routes.py", "backend/services/media_recovery_service.py")) {
  if (!(Test-Path -LiteralPath $file -PathType Leaf)) {
    throw "Required release file is missing: $file"
  }
}
foreach ($directory in @("backend", "css", "js", "sounds")) {
  if (!(Test-Path -LiteralPath $directory)) {
    throw "Required release directory is missing: $directory"
  }
}

Write-Step "Cleaning previous local build outputs"
Remove-PathIfExists "build"
Remove-PathIfExists "dist"
Remove-PathIfExists $stagingDirectory
Remove-PathIfExists $specFileName

$releaseName = Get-ReleaseName
$zipName = if ($isWindowsTarget) {
  "Cainflow_$(Get-SafeFileNamePart $releaseName).zip"
} else {
  "Cainflow_$(Get-SafeFileNamePart $releaseName)_macos.zip"
}
Remove-PathIfExists $zipName

Write-Step "Building $launcherFileName with PyInstaller"
$pyInstallerArgs = @(
  "-m", "PyInstaller",
  "--clean",
  "--noconfirm",
  "--log-level", "INFO",
  "--onefile",
  "--optimize", "2",
  "--exclude-module", "asyncio",
  "--exclude-module", "doctest",
  "--exclude-module", "multiprocessing",
  "--exclude-module", "pdb",
  "--exclude-module", "sqlite3",
  "--exclude-module", "test",
  "--exclude-module", "tkinter",
  "--exclude-module", "unittest",
  "--hidden-import", "backend.routes.media_routes",
  "--hidden-import", "backend.services.media_recovery_service",
  "--name", $launcherBaseName,
  "--add-data", (Join-PyInstallerDataSpec "index.html" "." $dataSeparator),
  "--add-data", (Join-PyInstallerDataSpec "index.js" "." $dataSeparator),
  "--add-data", (Join-PyInstallerDataSpec "index.css" "." $dataSeparator),
  "--add-data", (Join-PyInstallerDataSpec "js/services/notification-sw.js" "js/services" $dataSeparator),
  "--add-data", (Join-PyInstallerDataSpec "cainflow.ico" "." $dataSeparator),
  "--add-data", (Join-PyInstallerDataSpec "css" "css" $dataSeparator),
  "--add-data", (Join-PyInstallerDataSpec "js" "js" $dataSeparator),
  "--add-data", (Join-PyInstallerDataSpec "sounds" "sounds" $dataSeparator),
  "server.py"
)
if ($isWindowsTarget) {
  $pyInstallerArgs = $pyInstallerArgs[0..($pyInstallerArgs.Count - 2)] + @("--icon", "cainflow.ico") + $pyInstallerArgs[-1]
}
& $Python @pyInstallerArgs

if (!(Test-Path -LiteralPath $distProgramPath)) {
  throw "PyInstaller completed, but $distProgramPath was not found."
}

Write-Step "Preparing $stagingDirectory"
New-Item -ItemType Directory -Path $stagingDirectory | Out-Null
Copy-Item -LiteralPath $distProgramPath -Destination $stagedProgramPath

if ($targetPlatform -eq "macos") {
  Invoke-NativeCommand "chmod" @("+x", $stagedProgramPath)
  $codesignCommand = Get-Command codesign -ErrorAction SilentlyContinue
  if ($codesignCommand) {
    $codesignExecutable = if ($codesignCommand.Path) { $codesignCommand.Path } else { $codesignCommand.Source }
    Invoke-NativeCommand $codesignExecutable @("--force", "--sign", "-", $stagedProgramPath)
  }
}

foreach ($noticeFile in @("LICENSE", "NOTICE")) {
  if (Test-Path -LiteralPath $noticeFile) {
    Copy-Item -LiteralPath $noticeFile -Destination (Join-Path $stagingDirectory $noticeFile)
  }
}

if (Test-Path -LiteralPath "workflows") {
  Copy-Item -LiteralPath "workflows" -Destination $stagingDirectory -Recurse
} else {
  New-Item -ItemType Directory -Path (Join-Path $stagingDirectory "workflows") | Out-Null
}

Write-Step "Creating $zipName"
New-ReleaseZip -StagingDirectory $stagingDirectory -ZipName $zipName -Platform $targetPlatform

Write-Step "Cleaning temporary build files"
Remove-PathIfExists "build"
Remove-PathIfExists "dist"
Remove-PathIfExists $stagingDirectory
Remove-PathIfExists $specFileName

$zipPath = (Resolve-Path -LiteralPath $zipName).Path
Write-Host ""
Write-Host "Done: $zipPath" -ForegroundColor Green
