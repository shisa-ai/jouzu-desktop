param(
    [string[]]$Forbidden = @('sessions/messages', 'host-chat-transport'),
    [switch]$Full
)

$ErrorActionPreference = 'Stop'
$desktopDir = Split-Path -Parent $PSScriptRoot
$hostDir = Join-Path $desktopDir 'host'
$repo = Split-Path -Parent (Split-Path -Parent $desktopDir)

$app = $env:JOUZU_HOST_TEST_APP
if ([string]::IsNullOrWhiteSpace($app)) {
    $app = Join-Path $env:LOCALAPPDATA 'Shisa.ai\JouzuDesktop\app'
}
if (-not (Test-Path (Join-Path $app 'bootstrap.mjs')) -or
    -not (Test-Path (Join-Path $app 'node_modules/jouzu/dist/cli.js'))) {
    throw "JOUZU_HOST_TEST_APP is not a Jouzu app directory: $app"
}
$env:JOUZU_HOST_TEST_APP = $app

# The installed desktop may hold the default target exe open. Keep the gate
# out of that directory so it never needs to stop a running app.
if ([string]::IsNullOrWhiteSpace($env:CARGO_TARGET_DIR)) {
    $env:CARGO_TARGET_DIR = Join-Path $hostDir 'target-phase-c-gate'
}

if ($Full) {
    $Forbidden = @(
        'runtime\.event',
        'new_session',
        'get_available_models',
        'ChatConnection',
        'ChatPool',
        'HostChatTransport',
        'commands\.raw',
        'sessions/messages'
    )
}

function Step([string]$name, [scriptblock]$run) {
    Write-Host "`n== $name ==" -ForegroundColor Cyan
    & $run
    if ($LASTEXITCODE -ne 0) {
        throw "$name failed with exit code $LASTEXITCODE"
    }
}

function Scan([string]$root, [string[]]$patterns) {
    if (-not (Test-Path $root)) { return }
    $hits = Get-ChildItem $root -Recurse -File -Include *.ts,*.tsx,*.rs |
        Select-String -Pattern $patterns
    if ($hits) {
        $hits | ForEach-Object { Write-Host ("{0}:{1}: {2}" -f $_.Path, $_.LineNumber, $_.Line.Trim()) -ForegroundColor Red }
        throw "forbidden symbols found under $root"
    }
}

Step 'host tests' { & cargo test --manifest-path (Join-Path $hostDir 'Cargo.toml') }
Step 'host clippy' { & cargo clippy --manifest-path (Join-Path $hostDir 'Cargo.toml') --all-targets }
Step 'desktop typecheck' { Push-Location $desktopDir; try { & npx tsc --noEmit -p tsconfig.json } finally { Pop-Location } }
Step 'desktop tests' { Push-Location $desktopDir; try { & npx vitest run } finally { Pop-Location } }
Step 'desktop build' { Push-Location $desktopDir; try { & npm run build } finally { Pop-Location } }

Write-Host "`n== forbidden scans ==" -ForegroundColor Cyan
Scan (Join-Path $desktopDir 'src') $Forbidden
Scan (Join-Path $hostDir 'src') @('"/sessions/messages"', 'ChatProcess')

Write-Host "`nPASS: Phase C gate" -ForegroundColor Green
