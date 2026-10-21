param(
  [Parameter(Mandatory = $true)]
  [string]$TagName
)

$ErrorActionPreference = 'Stop'

# Immutable compatibility list for versions published before decimal rollover.
$legacyTags = @('v3.5.10', 'v3.5.11', 'v3.5.12', 'v3.6.10')
if ($TagName -cnotmatch '^v(0|[1-9][0-9]*)\.[0-9]\.[0-9]$' -and $TagName -cnotin $legacyTags) {
  throw "Invalid release version '$TagName': use vMAJOR.MINOR.PATCH with MINOR/PATCH from 0 to 9 (decimal rollover). After v3.6.10 use v3.7.0."
}
