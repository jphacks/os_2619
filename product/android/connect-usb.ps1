param(
    [Parameter(Mandatory = $true)][string]$Serial,
    [int]$Port = 8000
)

$adbPath = Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'
if (-not (Test-Path -LiteralPath $adbPath)) { throw "ADB not found: $adbPath" }

# ADB reverse entries disappear when USB transport reconnects. Keep the dashboard reachable
# on the phone at 127.0.0.1 while this script runs; stop it with Ctrl+C.
while ($true) {
    $devices = & $adbPath devices 2>$null
    $connected = $devices | Where-Object { $_ -match "^$([regex]::Escape($Serial))\s+device(\s|$)" }
    if ($connected) {
        $routes = & $adbPath -s $Serial reverse --list 2>$null
        if (-not ($routes | Where-Object { $_ -match "tcp:$Port\s+tcp:$Port" })) {
            & $adbPath -s $Serial reverse "tcp:$Port" "tcp:$Port" | Out-Null
            if ($LASTEXITCODE -eq 0) { Write-Output "ADB reverse restored for $Serial on port $Port" }
        }
    }
    Start-Sleep -Seconds 2
}
