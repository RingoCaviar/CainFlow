param(
  [Parameter(Mandatory = $true)]
  [string]$TagName
)

$ErrorActionPreference = "Stop"

if ($TagName -notmatch '^[A-Za-z0-9._-]+$') {
  throw "Invalid release tag: $TagName"
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$notesPath = Join-Path $repoRoot "docs/releases/$TagName.md"
if (!(Test-Path -LiteralPath $notesPath -PathType Leaf)) {
  throw "Release notes are required: $notesPath"
}

$content = Get-Content -LiteralPath $notesPath -Raw -Encoding UTF8
$displayVersion = if ($TagName.StartsWith('v')) { $TagName.Substring(1) } else { $TagName }
$heading = "## 🚀 $displayVersion 更新内容"
if (!$content.TrimStart().StartsWith($heading)) {
  throw "Release notes must start with the versioned update heading: $heading"
}

$updateSection = [regex]::Match($content, '(?m)^## 🚀 [^\r\n]+ 更新内容[ \t]*\r?\n([\s\S]*?)(?=^## |\z)')
if (!$updateSection.Success -or $updateSection.Groups[1].Value -notmatch '(?m)^### .+' -or
    $updateSection.Groups[1].Value -notmatch '(?m)^- .{8,}') {
  throw "Release notes need a topic heading and a concrete update item."
}

foreach ($section in @('升级说明', '下载', '完整变更')) {
  $sectionPattern = '(?m)^## [^\r\n]* ' + [regex]::Escape($section) + '[ \t]*\r?\n([\s\S]*?)(?=^## |\z)'
  $sectionMatch = [regex]::Match($content, $sectionPattern)
  if (!$sectionMatch.Success) {
    throw "Release notes are missing the $section section."
  }
  if ([string]::IsNullOrWhiteSpace($sectionMatch.Groups[1].Value)) {
    throw "Release notes have an empty $section section."
  }
}

if ($content -notmatch [regex]::Escape("Cainflow_$TagName.zip")) {
  throw "Release notes must name the Windows package for $TagName."
}

if ($content -match 'Automated CainFlow build|TODO|待补充') {
  throw "Release notes contain placeholder text."
}

Write-Host "Release notes validated: $notesPath"
