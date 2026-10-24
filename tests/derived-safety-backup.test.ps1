# Offline inference/snapshot exclusion checks. Does not contact Docker or touch
# the actual runtime locks, library, services or backup directories.
$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
. (Join-Path $project 'scripts/backup-common.ps1')
. (Join-Path $project 'scripts/backup-inference.ps1')
$base = Join-Path $project '.local/test-results/derived-safety-backup'
$token = [Guid]::NewGuid().ToString('N')
$root = Join-Path $base $token
New-Item -ItemType Directory -Path $root -Force | Out-Null
$script:GargantuaProjectRoot = $root
$script:containers = ''
$script:states = @{}
$script:unavailable = $false
$script:dockerCalls = 0
function Invoke-GargantuaDocker {
    param($Operation,$Arguments)
    $script:dockerCalls++
    if ($script:unavailable) { throw 'Synthetic daemon unavailable' }
    if ($Arguments[0] -eq 'ps') { return $script:containers }
    if ($Arguments[0] -eq 'inspect') { return ($script:states[$Arguments[-1]] | ConvertTo-Json -Compress) }
    throw 'Unexpected mocked operation'
}
$cases = [Collections.Generic.List[object]]::new()
function Case($Name,$Body) {
    try { & $Body; $cases.Add(@{name=$Name;status='PASS'}) }
    catch { $cases.Add(@{name=$Name;status='FAIL';error=$_.Exception.Message}) }
}
function Throws($Body) { $failed=$false; try { & $Body } catch { $failed=$true }; if (-not $failed) { throw 'Expected refusal' } }
$handle = $null
try {
    Case 'empty owned container set grants exclusive snapshot lock' {
        $handle = Enter-GargantuaInferenceSnapshot
        if ($null -eq $handle -or -not $handle.CanWrite) { throw 'No live exclusive handle' }
        $handle.Dispose()
    }
    Case 'executor-owned open handle blocks snapshot before Docker read' {
        $filename = Join-Path $root '.local/inference-runtime/execution.lock'
        $owner = [IO.File]::Open($filename,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::ReadWrite)
        try {
            $before=$script:dockerCalls
            Throws { $other=Enter-GargantuaInferenceSnapshot; $other.Dispose() }
            if ($script:dockerCalls -ne $before) { throw 'Read daemon without acquiring exclusion' }
        } finally { $owner.Dispose() }
    }
    Case 'running orphan container blocks snapshot despite free lock' {
        $script:containers='a'*64
        $script:states[$script:containers]=@{Status='running';Running=$true;Paused=$false;Restarting=$false}
        Throws { $other=Enter-GargantuaInferenceSnapshot; $other.Dispose() }
    }
    Case 'paused orphan container blocks snapshot' {
        $script:states[$script:containers]=@{Status='paused';Running=$true;Paused=$true;Restarting=$false}
        Throws { $other=Enter-GargantuaInferenceSnapshot; $other.Dispose() }
    }
    Case 'stopped owned container permits snapshot' {
        $script:states[$script:containers]=@{Status='exited';Running=$false;Paused=$false;Restarting=$false}
        $other=Enter-GargantuaInferenceSnapshot; $other.Dispose()
    }
    Case 'unknown daemon state blocks and releases lock for later retry' {
        $script:unavailable=$true
        Throws { $other=Enter-GargantuaInferenceSnapshot; $other.Dispose() }
        $script:unavailable=$false
        $other=Enter-GargantuaInferenceSnapshot; $other.Dispose()
    }
    Case 'malformed container state is not proof of stop' {
        $script:states[$script:containers]=@{Status='unknown'}
        Throws { $other=Enter-GargantuaInferenceSnapshot; $other.Dispose() }
    }
    Case 'unsafe identifier is rejected without interpolation' {
        $script:containers='../arbitrary'
        Throws { $other=Enter-GargantuaInferenceSnapshot; $other.Dispose() }
    }
} finally {
    if ($handle) { $handle.Dispose() }
}
$failures=@($cases | Where-Object status -eq 'FAIL')
Write-GargantuaJson -Path (Join-Path $root 'report.json') -Value @{status=$(if($failures.Count){'FAIL'}else{'PASS'});cases=$cases.ToArray();passed=$cases.Count-$failures.Count;failed=$failures.Count;dockerCommands=$false;productionTouched=$false}
$cases | ForEach-Object { Write-Host ($_.status+' '+$_.name) }
if ($failures.Count) { $failures | ForEach-Object { Write-Host $_.error }; exit 1 }
