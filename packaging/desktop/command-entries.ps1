param([Parameter(Mandatory=$true)][string]$InstallRoot)
$ErrorActionPreference = 'Stop'

# `jz` and `jouzu` are byte copies of the one signed console, so a terminal entry costs no second
# signature and no extra package bytes. The invoked file name chooses the contract.
$console = Join-Path $InstallRoot 'console.exe'
if (-not (Test-Path -LiteralPath $console -PathType Leaf)) { throw 'console.exe is missing from the installation.' }

foreach ($name in @('jz.exe', 'jouzu.exe')) {
    $target = Join-Path $InstallRoot $name
    try {
        Copy-Item -LiteralPath $console -Destination $target -Force -ErrorAction Stop
        continue
    } catch {
        # A terminal session may be running this copy. Windows allows renaming a running image but not
        # replacing it, so the running copy is renamed aside and a later app start removes it.
    }
    try {
        Rename-Item -LiteralPath $target -NewName ("$name.old-" + [guid]::NewGuid().ToString('N')) -ErrorAction Stop
    } catch {
        throw "Cannot refresh $name. Close the terminal session that is running it and retry."
    }
    Copy-Item -LiteralPath $console -Destination $target -Force
}
Write-Output 'Command entries are in place'
