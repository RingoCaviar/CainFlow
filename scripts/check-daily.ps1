param(
  [string]$Base = "",
  [string[]]$Group = @(),
  [string[]]$ChangedPath = @(),
  [string]$Python = "python",
  [string]$Node = "node",
  [ValidateRange(1, 64)][int]$FastConcurrency = 4,
  [ValidateRange(1, 16)][int]$BrowserConcurrency = 2,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$runnerArgs = @((Join-Path $PSScriptRoot "run-tests.mjs"), "--mode", "daily", "--python", $Python,
  "--fast-concurrency", "$FastConcurrency", "--browser-concurrency", "$BrowserConcurrency")
if ($Base) { $runnerArgs += @("--base", $Base) }
foreach ($name in $Group) { $runnerArgs += @("--group", $name) }
foreach ($path in $ChangedPath) { $runnerArgs += @("--changed", $path) }
if ($DryRun) { $runnerArgs += "--dry-run" }
& $Node @runnerArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
