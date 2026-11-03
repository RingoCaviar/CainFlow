param(
  [string]$Python = "python",
  [string]$Node = "node",
  [ValidateRange(1, 64)][int]$FastConcurrency = 4,
  [ValidateRange(1, 16)][int]$BrowserConcurrency = 2,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$runnerArgs = @((Join-Path $PSScriptRoot "run-tests.mjs"), "--mode", "full", "--python", $Python,
  "--fast-concurrency", "$FastConcurrency", "--browser-concurrency", "$BrowserConcurrency")
if ($DryRun) { $runnerArgs += "--dry-run" }
& $Node @runnerArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
