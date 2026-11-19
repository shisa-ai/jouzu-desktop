param(
 [Parameter(Mandatory=$true)][string]$InstallRoot,
 [switch]$Prepare,
 [switch]$Report,
 [switch]$Install
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$version = '1.25.2733.0'
$digest = 'bf3ef2012f6c44d8340a4c58125acc9498d19b580f9890dc043cdf831852e796'
$parent = Join-Path $InstallRoot 'runtime\terminal'
$installed = Join-Path $parent 'installed'
$archive = Join-Path $parent 'WindowsTerminal.zip'
$system = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\wt.exe' } else { $null }

# An app execution alias carries no version, so the file it points to is read.
function Get-FileVersion([string]$Path) {
 $item = Get-Item -LiteralPath $Path
 $version = $item.VersionInfo.FileVersion
 if (-not $version -and $Path -like '*\WindowsApps\*') {
  $package = Get-AppxPackage -Name Microsoft.WindowsTerminal -ErrorAction SilentlyContinue
  if ($package) { $version = $package.Version.ToString() }
 }
 return $version
}

# A portable Windows Terminal tree is usable when its host executable is there.
function Get-Terminal([string]$Root) {
 if (-not $Root) { return $null }
 foreach ($name in @('WindowsTerminal.exe','wt.exe')) {
  $file = Join-Path $Root $name
  if (Test-Path -LiteralPath $file -PathType Leaf) { return [pscustomobject]@{ path = $file; root = $Root } }
 }
 return $null
}

# The directory is what an installation writes, so its presence tells a broken copy from a missing one.
$bundledPresent = Test-Path -LiteralPath $installed -PathType Container
$bundledInfo = Get-Terminal $installed
$systemInfo = if ($system -and (Test-Path -LiteralPath $system -PathType Leaf)) { [pscustomobject]@{ path = $system; root = $null } } else { $null }

if ($Report) {
 $value = [ordered]@{
  bundled = if ($bundledInfo) { [ordered]@{ path = $bundledInfo.path; version = (Get-FileVersion $bundledInfo.path) } } else { $null }
  system = if ($systemInfo) { [ordered]@{ path = $systemInfo.path; version = (Get-FileVersion $systemInfo.path) } } else { $null }
  bundled_present = $bundledPresent
  effective = if ($bundledInfo) { $bundledInfo.path } elseif ($systemInfo) { $systemInfo.path } else { $null }
  archive = (Test-Path -LiteralPath $archive -PathType Leaf)
  version = $version
 }
 Write-Output ($value | ConvertTo-Json -Compress -Depth 3)
 exit 0
}

# The copy Jouzu ships resolves first. A Windows Terminal this PC already has answers a launch, and
# never a preparation or an installation.
foreach ($info in @($bundledInfo)) {
 if ($info) { Write-Output $info.path; exit 0 }
}
if (-not ($Prepare -or $Install)) {
 if ($systemInfo) { Write-Output $systemInfo.path; exit 0 }
 throw 'Windows Terminal is unavailable. Install it in Jouzu Desktop under Settings, System.'
}

New-Item -ItemType Directory -Path $parent -Force | Out-Null
if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) {
 if (-not $Install) { throw 'The bundled Windows Terminal package is missing. Install it in Jouzu Desktop under Settings, System.' }
 $url = "https://github.com/microsoft/terminal/releases/download/v$version/Microsoft.WindowsTerminal_${version}_x64.zip"
 Invoke-WebRequest -Uri $url -OutFile $archive
}
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $digest) {
 if ($Install) { Remove-Item -LiteralPath $archive -Force }
 throw 'Windows Terminal archive integrity verification failed'
}
# A downloaded archive carries the mark of the web; remove it before extracting.
Unblock-File -LiteralPath $archive -ErrorAction SilentlyContinue
$stage = Join-Path $parent ('prepare-' + [guid]::NewGuid().ToString('N'))
try {
 Expand-Archive -LiteralPath $archive -DestinationPath $stage
 $inner = Get-ChildItem -LiteralPath $stage -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'WindowsTerminal.exe') } | Select-Object -First 1
 if (-not $inner) { throw 'Windows Terminal archive has no host executable' }
 if (Test-Path -LiteralPath $installed) { Remove-Item -LiteralPath $installed -Recurse -Force }
 Move-Item -LiteralPath $inner.FullName -Destination $installed
 Write-Output (Join-Path $installed 'WindowsTerminal.exe')
} finally {
 if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
