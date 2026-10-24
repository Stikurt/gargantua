param([string]$DesktopExe, [string]$SamplePath, [switch]$Mobile, [switch]$ChapterBatches)
$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path -LiteralPath (Split-Path $PSScriptRoot -Parent)).Path
if (-not $DesktopExe) { $DesktopExe = Join-Path $workspace 'releases/Cotology-Windows/Cotology.exe' }
$desktopPath = (Resolve-Path -LiteralPath $DesktopExe).Path
$nodePath = (Get-Command node -ErrorAction Stop).Source
$runRoot = Join-Path $workspace ('.local/audio-client-check/' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $runRoot | Out-Null
$readyPath = Join-Path $runRoot 'fixture-ready.json'
$fixtureScript = Join-Path $workspace 'scripts/audio-client-fixture.mjs'
$fixtureProcess = $null
$clientProcess = $null
$previousOrigin = $env:COTOLOGY_AUDIO_FIXTURE_ORIGIN
$checkData = Join-Path $env:APPDATA $(if ($Mobile) { 'Cotology-AudioSelfCheck-Mobile' } else { 'Cotology-AudioSelfCheck' })
function Wait-CheckReport([string]$Mode, [datetime]$StartedAt) {
    $reportPath = Join-Path $checkData ('audio-' + $Mode + '-report.json')
    $deadline = [DateTime]::UtcNow.AddSeconds(100)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ((Test-Path -LiteralPath $reportPath) -and (Get-Item -LiteralPath $reportPath).LastWriteTimeUtc -ge $StartedAt) {
            try { $value = Get-Content -LiteralPath $reportPath -Raw -Encoding utf8 | ConvertFrom-Json } catch { Start-Sleep -Milliseconds 100; continue }
            Copy-Item -LiteralPath $reportPath -Destination (Join-Path $runRoot ('audio-' + $Mode + '-report.json'))
            $screenshot = Join-Path $checkData ('audio-' + $Mode + '-screenshot.png')
            $imageDeadline = [DateTime]::UtcNow.AddSeconds(3)
            while ([DateTime]::UtcNow -lt $imageDeadline) {
                if ((Test-Path -LiteralPath $screenshot) -and (Get-Item -LiteralPath $screenshot).LastWriteTimeUtc -ge $StartedAt) { Copy-Item -LiteralPath $screenshot -Destination $runRoot; break }
                Start-Sleep -Milliseconds 100
            }
            Get-ChildItem -LiteralPath $checkData -Filter ('audio-' + $Mode + '-*.png') -File | Where-Object { $_.LastWriteTimeUtc -ge $StartedAt } | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $runRoot }
            if (-not $value.ok) { throw ('Audio ' + $Mode + ' self-check failed: ' + $value.error + '. Report: ' + $reportPath) }
            return $value
        }
        $clientProcess.Refresh()
        if ($clientProcess.HasExited) { throw ('Audio ' + $Mode + ' application exited without a new report. Inspect: ' + $checkData) }
        Start-Sleep -Milliseconds 150
    }
    throw ('Audio ' + $Mode + ' self-check timed out. Inspect: ' + $checkData)
}
try {
    $fixtureArguments = @(('"' + $fixtureScript + '"'), '--ready', ('"' + $readyPath + '"'))
    if ($ChapterBatches) { $fixtureArguments += @('--chapter-batches','true') }
    if ($SamplePath) { $resolvedSample = (Resolve-Path -LiteralPath $SamplePath).Path; $fixtureArguments += @('--sample', ('"' + $resolvedSample + '"')) }
    $fixtureProcess = Start-Process -FilePath $nodePath -ArgumentList $fixtureArguments -WorkingDirectory $workspace -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runRoot 'fixture.stdout') -RedirectStandardError (Join-Path $runRoot 'fixture.stderr') -PassThru
    $readyDeadline = [DateTime]::UtcNow.AddSeconds(15)
    while (-not (Test-Path -LiteralPath $readyPath)) {
        $fixtureProcess.Refresh()
        if ($fixtureProcess.HasExited -or [DateTime]::UtcNow -ge $readyDeadline) { throw ('Audio fixture did not start: ' + (Join-Path $runRoot 'fixture.stderr')) }
        Start-Sleep -Milliseconds 100
    }
    $ready = Get-Content -LiteralPath $readyPath -Raw -Encoding utf8 | ConvertFrom-Json
    if ($ready.pid -ne $fixtureProcess.Id -or $ready.origin -notmatch '^http://127\.0\.0\.1:[1-9][0-9]{0,4}$') { throw 'Unexpected audio fixture identity' }
    $env:COTOLOGY_AUDIO_FIXTURE_ORIGIN = $ready.origin
    $started = [DateTime]::UtcNow
    $clientArguments = @('--audio-self-check')
    if ($Mobile) { $clientArguments += '--audio-self-check-mobile' }
    $clientProcess = Start-Process -FilePath $desktopPath -ArgumentList $clientArguments -WorkingDirectory (Split-Path $desktopPath -Parent) -WindowStyle Hidden -PassThru
    $online = Wait-CheckReport 'online' $started
    $clientProcess.WaitForExit(5000) | Out-Null
    $clientProcess.Refresh()
    if (-not $clientProcess.HasExited) { throw 'Online self-check application did not exit' }
    $journal = Invoke-RestMethod -Uri ($ready.origin + '/test/status') -TimeoutSec 10
    $journal | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $runRoot 'fixture-requests.json') -Encoding utf8
    Stop-Process -Id $fixtureProcess.Id -ErrorAction Stop
    $fixtureProcess.WaitForExit(5000) | Out-Null
    $fixtureProcess = $null
    $started = [DateTime]::UtcNow
    $clientArguments = @('--audio-self-check', '--offline')
    if ($Mobile) { $clientArguments += '--audio-self-check-mobile' }
    $clientProcess = Start-Process -FilePath $desktopPath -ArgumentList $clientArguments -WorkingDirectory (Split-Path $desktopPath -Parent) -WindowStyle Hidden -PassThru
    $offline = Wait-CheckReport 'offline' $started
    $clientProcess.WaitForExit(5000) | Out-Null
    @{ schemaVersion = 1; ok = $true; narrowDesktopWindow = [bool]$Mobile; onlineChecks = $online.results.Count; offlineChecks = $offline.results.Count; fixtureStoppedBeforeOffline = $true; reports = $runRoot } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runRoot 'summary.json') -Encoding utf8
    Write-Host ('Audio application checks passed. Reports and screenshots: ' + $runRoot)
} finally {
    $env:COTOLOGY_AUDIO_FIXTURE_ORIGIN = $previousOrigin
    foreach ($ownedProcess in @($clientProcess, $fixtureProcess)) {
        if ($null -ne $ownedProcess) { $ownedProcess.Refresh(); if (-not $ownedProcess.HasExited) { Stop-Process -Id $ownedProcess.Id -ErrorAction SilentlyContinue } }
    }
}
