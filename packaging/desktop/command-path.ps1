param(
 [Parameter(Mandatory=$true)][string]$Directory,
 [ValidateSet('Report','Install','Append','Precedence','Restore','Remove')][string]$Action = 'Report',
 [string]$InstallRoot,
 [string]$ValueName = 'Path',
 [string]$PathValue,
 [switch]$Write
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

# The commands the entries answer, and the order Windows would try them in: an executable first, then
# the cmd wrapper, then the PowerShell script.
$commands = @('jz', 'jouzu')
$suffixes = @('.exe', '.cmd', '.ps1')

# A PATH entry is compared without its quotes, its trailing separator or its case, because an entry
# written by another tool may carry any of those.
function Get-Comparison([string]$Entry) {
 return $Entry.Trim().Trim('"').TrimEnd('').ToLowerInvariant()
}

function Get-Entries([string]$Value) {
 if (-not $Value) { return @() }
 return @($Value -split ';' | Where-Object { $_ -and $_.Trim() })
}

# What a newly started shell scans: the machine value first, then the user value, which is the order
# Windows composes them in. A value given to this call is the scan itself, which is what describing one
# value needs.
$scan = @()
if ($PSBoundParameters.ContainsKey('PathValue')) {
 $scan = @(Get-Entries $PathValue)
} else {
 $scan = @(@(Get-Entries ([Environment]::GetEnvironmentVariable($ValueName, 'Machine'))) + @(Get-Entries ([Environment]::GetEnvironmentVariable($ValueName, 'User'))))
}

# What a shell resolves for a command, and from where, following the left-to-right scan.
function Get-Resolution([string]$Name, [string[]]$Entries) {
 foreach ($entry in $Entries) {
  foreach ($suffix in $suffixes) {
   $candidate = Join-Path $entry ($Name + $suffix)
   if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  }
  $plain = Join-Path $entry $Name
  if (Test-Path -LiteralPath $plain -PathType Leaf) { return $plain }
 }
 return $null
}

$user = if ($PSBoundParameters.ContainsKey('PathValue')) { $PathValue } else { [Environment]::GetEnvironmentVariable($ValueName, 'User') }
$entries = @(Get-Entries $user)
$target = Get-Comparison $Directory
$at = -1
for ($index = 0; $index -lt $entries.Count; $index++) {
 if ((Get-Comparison $entries[$index]) -eq $target) { $at = $index; break }
}
if ($at -lt 0) { $position = 'absent' } elseif ($at -eq 0) { $position = 'first' } else { $position = 'later' }

# The shims are the three files a global npm install writes for a command, so a shell finds the entry
# whichever of the three it is: a POSIX script for Git Bash, which does not run a .cmd, a wrapper for
# cmd.exe, and one for PowerShell.
function Write-Shims {
 if (-not $InstallRoot) { throw 'InstallRoot is required to write the entries.' }
 $exe = @{}
 foreach ($name in $commands) {
  $path = Join-Path $InstallRoot ($name + '.exe')
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "$name.exe is missing from the installation." }
  $exe[$name] = $path
 }
 New-Item -ItemType Directory -Path $Directory -Force | Out-Null
 foreach ($name in $commands) {
  $target = $exe[$name]
  $sh = New-Object System.Text.StringBuilder
  [void]$sh.AppendLine('#!/bin/sh')
  [void]$sh.AppendLine("# The managed Jouzu entry. A Bash shell does not run a .cmd, which is why npm's own global")
  [void]$sh.AppendLine("# installs carry this file too.")
  # A shell script needs a forward-slash path, and the separator comes from the platform rather
  # than a literal, so this file reads the same wherever it is reviewed.
  $slash = $target.Replace([IO.Path]::DirectorySeparatorChar, '/')
  [void]$sh.AppendLine('exec "' + $slash + '" "$@"')
  Set-Content -LiteralPath (Join-Path $Directory $name) -Value $sh.ToString().TrimEnd() -NoNewline -Encoding ascii
  Set-Content -LiteralPath (Join-Path $Directory ($name + '.cmd')) -Value ('@echo off' + "`r`n" + '"' + $target + '" %*') -Encoding ascii
  Set-Content -LiteralPath (Join-Path $Directory ($name + '.ps1')) -Value ('& "' + $target + '" @args' + "`r`n" + 'exit $LASTEXITCODE') -Encoding utf8
 }
}

# Microsoft documents that other applications learn about a user environment change through this
# message, which is what makes a newly started shell see the entry without a restart or a logoff.
function Send-EnvironmentChange {
 if (-not ('Jouzu.Native' -as [type])) {
  Add-Type -Namespace Jouzu -Name Native -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint msg, System.IntPtr wParam, string lParam, uint flags, uint timeout, out System.IntPtr result);
'@
 }
 $result = [System.IntPtr]::Zero
 [void][Jouzu.Native]::SendMessageTimeout([System.IntPtr]0xffff, 0x1A, [System.IntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
}

# Every change touches only the entry this installation writes. Other entries an installation or another
# tool added meanwhile stay where they are.
function Set-Entries([string[]]$Next) {
 $value = ($Next -join ';')
 if ($Write) {
  [Environment]::SetEnvironmentVariable($ValueName, $value, 'User')
  Send-EnvironmentChange
 }
 return $value
}

if ($Action -eq 'Install') { Write-Shims }

# A command of the same name that resolves from somewhere else belongs to another installation, and the
# user keeps it: our entry is added only when it would answer for neither name.
$foreign = @()
foreach ($name in $commands) {
 $resolved = Get-Resolution $name $scan
 if ($resolved -and (Get-Comparison (Split-Path -Parent $resolved)) -ne $target) { $foreign += $resolved }
}

$changed = $false
if ($Action -eq 'Append') {
 if ($at -ge 0) { $changed = $false }
 elseif ($foreign.Count -gt 0) { $changed = $false }
 else { $entries = @($entries + $Directory); $changed = $true }
}
if ($Action -eq 'Precedence') {
 # The authorized action: the entry moves to the front, where it answers before another command of the
 # same name. The state records that it was moved, so it can be put back.
 $entries = @($Directory) + @($entries | Where-Object { (Get-Comparison $_) -ne $target })
 $changed = $true
}
if ($Action -eq 'Restore') {
 # The entry goes back to the end, where it answers for neither name unless nothing else does. Every
 # other entry keeps its place, so the resolution the user had is what answers again.
 if ($at -ge 0) { $entries = @($entries | Where-Object { (Get-Comparison $_) -ne $target }) + $Directory; $changed = $true }
}
if ($Action -eq 'Remove') {
 $entries = @($entries | Where-Object { (Get-Comparison $_) -ne $target })
 $changed = $at -ge 0
}
if ($Action -in @('Append', 'Precedence', 'Restore', 'Remove') -and $changed) { [void](Set-Entries $entries) }

# The report describes the state after the action, so a caller does not have to run it twice.
if ($changed) { $entries = @(Get-Entries ($entries -join ';')) } else { $entries = @(Get-Entries $user) }
$at = -1
for ($index = 0; $index -lt $entries.Count; $index++) {
 if ((Get-Comparison $entries[$index]) -eq $target) { $at = $index; break }
}
if ($at -lt 0) { $position = 'absent' } elseif ($at -eq 0) { $position = 'first' } else { $position = 'later' }
$state = [ordered]@{
 directory = $Directory
 shims = (Test-Path -LiteralPath (Join-Path $Directory 'jz.cmd') -PathType Leaf)
 onPath = ($at -ge 0)
 position = $position
 first = ($at -eq 0)
 value = $entries
 commands = @($commands | ForEach-Object { [ordered]@{ name = $_; path = (Get-Resolution $_ $scan) } })
 shadowed = ($foreign.Count -gt 0)
}
Write-Output ($state | ConvertTo-Json -Compress -Depth 4)
