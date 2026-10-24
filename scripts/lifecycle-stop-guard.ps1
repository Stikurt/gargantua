# Read-only fence for Docker stop RPCs whose issuing process died. Callers hold
# the shared lifecycle lock; this helper never starts/stops services or deletes
# evidence. Central intents are durable before their RPC can be submitted.
. (Join-Path $PSScriptRoot 'runtime-common.ps1')
function Read-GargantuaStopGuardJson {
    param([Parameter(Mandatory)][string]$Path,[int]$MaxBytes=32768)
    Assert-GargantuaRuntimePath $Path
    $file=Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if($file.PSIsContainer -or $file.Length -gt $MaxBytes){throw 'Stop RPC evidence has invalid size or type.'}
    return Get-Content -LiteralPath $Path -Raw -Encoding UTF8|ConvertFrom-Json -DateKind String
}
function Get-GargantuaLegacyStopWindows {
    param([Parameter(Mandatory)][string]$ProjectRoot,[Parameter(Mandatory)][long]$NowMs)
    $backupRoot=Join-Path $ProjectRoot 'backups';if(-not(Test-Path -LiteralPath $backupRoot)){return}
    Assert-GargantuaRuntimePath $backupRoot
    $candidates=[Collections.Generic.List[object]]::new()
    $direct=@(Get-ChildItem -LiteralPath $backupRoot -Force -Directory)
    if($direct.Count -gt 2000){throw 'Backup root exceeds the bounded stop-evidence directory limit.'}
    foreach($directory in $direct){
        if($directory.Name -match '^snapshot-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-[a-f0-9]{8}$'){$candidates.Add(@{path=$directory.FullName;createdAt=$null})}
    }
    $automatic=Join-Path $backupRoot 'automatic'
    if(Test-Path -LiteralPath $automatic){
        Assert-GargantuaRuntimePath $automatic
        $cycles=@(Get-ChildItem -LiteralPath $automatic -Force -Directory)
        if($cycles.Count -gt 2000){throw 'Automatic backup root exceeds the bounded stop-evidence limit.'}
        foreach($cycle in $cycles){
            if($cycle.Name -notmatch '^cycle-([a-f0-9]{32})$'){continue};$cycleId=$Matches[1]
            Assert-GargantuaRuntimePath $cycle.FullName
            $ownerPath=Join-Path $cycle.FullName 'cycle-owner.json'
            if(-not(Test-Path -LiteralPath $ownerPath -PathType Leaf)){continue}
            $owner=Read-GargantuaStopGuardJson $ownerPath
            if($owner.kind -ne 'gargantua-automatic-backup' -or $owner.version -ne 1 -or $owner.cycleId -ne $cycleId -or $owner.root -ne $cycle.FullName -or $owner.projectRoot -ne $ProjectRoot){continue}
            if((Test-Path -LiteralPath (Join-Path $cycle.FullName 'validated.json')) -or (Test-Path -LiteralPath (Join-Path $cycle.FullName 'recovery-complete.json'))){continue}
            $payload=Join-Path $cycle.FullName 'payload';if(-not(Test-Path -LiteralPath $payload)){continue}
            Assert-GargantuaRuntimePath $payload;$children=@(Get-ChildItem -LiteralPath $payload -Force)
            if(-not $children.Count){continue}
            if($children.Count -ne 1 -or -not $children[0].PSIsContainer -or $children[0].Name -notmatch '^snapshot-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-[a-f0-9]{8}$'){throw 'Interrupted cycle has ambiguous stop evidence.'}
            $candidates.Add(@{path=$children[0].FullName;createdAt=$owner.createdAt})
        }
    }
    foreach($candidate in $candidates){
        $path=$candidate.path;Assert-GargantuaRuntimePath $path
        $journalPath=Join-Path $path 'service-state-before.json';if(-not(Test-Path -LiteralPath $journalPath -PathType Leaf)){continue}
        $journal=Read-GargantuaStopGuardJson $journalPath
        if($journal.stopIntentProtocol -eq 'central-rpc-v1'){continue}
        if($journal.stopIntentProtocol){throw 'Unknown stop RPC journal protocol.'}
        $manifestPath=Join-Path $path 'manifest.json';$manifest=Read-GargantuaStopGuardJson -Path $manifestPath -MaxBytes 67108864
        if($manifest.status -eq 'ready' -or ($manifest.status -eq 'incomplete' -and @($manifest.recoveryErrors).Count -eq 0)){continue}
        if($manifest.version -ne 2 -or $manifest.status -notin @('building','incomplete') -or $manifest.snapshotId -notmatch '^[a-f0-9]{32}$' -or $journal.snapshotId -ne $manifest.snapshotId -or -not (Split-Path $path -Leaf).EndsWith($manifest.snapshotId.Substring(0,8),[StringComparison]::Ordinal)){throw 'Legacy stop RPC journal identity is invalid.'}
        $stamp=$manifest.createdAt;if(-not $stamp){$stamp=$candidate.createdAt}
        if(-not $stamp){throw 'Legacy stop RPC evidence has no bounded creation timestamp.'}
        try{$created=[DateTimeOffset]::Parse([string]$stamp,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind).ToUnixTimeMilliseconds()}catch{throw 'Legacy stop RPC timestamp is invalid.'}
        if($created-$NowMs -gt 5000){throw 'Legacy stop RPC timestamp is unexpectedly in the future.'}
        $until=$created+245000
        if($until -le $NowMs){continue}
        if(@($journal.handlers).Count -ne 2 -or @($journal.handlers|Where-Object service -eq 'worker').Count -ne 1 -or @($journal.handlers|Where-Object service -eq 'parser').Count -ne 1){throw 'Legacy stop RPC service set is invalid.'}
        foreach($handler in $journal.handlers){
            if($handler.exists -isnot [bool] -or $handler.running -isnot [bool] -or $handler.paused -isnot [bool] -or ($handler.paused -and -not $handler.running)){throw 'Legacy stop RPC service state is invalid.'}
            if($handler.exists -and $handler.running){
                if($handler.id -notmatch '^[a-f0-9]{12,64}$'){throw 'Legacy stop RPC container ID is invalid.'}
                [pscustomobject]@{source='legacy';service=$handler.service;containerId=$handler.id;untilMs=$until;evidence=$path}
            }
        }
    }
}
function Get-GargantuaPendingStopBarrier {
    param([Parameter(Mandatory)][string]$ProjectRoot,[Parameter(Mandatory)][scriptblock]$CurrentHandler,
          [long]$NowMs=([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()))
    $ProjectRoot=[IO.Path]::GetFullPath($ProjectRoot);Assert-GargantuaRuntimePath $ProjectRoot
    $records=[Collections.Generic.List[object]]::new();$directory=Join-Path $ProjectRoot '.local/operations/stop-intents'
    if(Test-Path -LiteralPath $directory){
        Assert-GargantuaRuntimePath $directory;$files=@(Get-ChildItem -LiteralPath $directory -Force)
        if($files.Count -gt 2000){throw 'Stop RPC intent inventory exceeds its bound.'}
        foreach($file in $files){
            if($file.PSIsContainer -or $file.Name -notmatch '^([a-f0-9]{32})-(worker|parser)\.json$'){throw 'Unknown stop RPC intent entry requires review.'}
            $snapshotId=$Matches[1];$service=$Matches[2];$intent=Read-GargantuaStopGuardJson $file.FullName
            if($intent.schemaVersion -ne 1 -or $intent.kind -ne 'gargantua-snapshot-stop' -or $intent.projectRoot -ne $ProjectRoot -or $intent.snapshotId -ne $snapshotId -or $intent.service -ne $service -or $intent.containerId -notmatch '^[a-f0-9]{12,64}$'){throw 'Stop RPC intent identity is invalid.'}
            if(($intent.issuedAtMs -isnot [int] -and $intent.issuedAtMs -isnot [long]) -or ($intent.timeoutSeconds -isnot [int] -and $intent.timeoutSeconds -isnot [long]) -or ($intent.rpcTimeoutSeconds -isnot [int] -and $intent.rpcTimeoutSeconds -isnot [long]) -or ($intent.graceSeconds -isnot [int] -and $intent.graceSeconds -isnot [long]) -or $intent.timeoutSeconds -lt 1 -or $intent.timeoutSeconds -gt 120 -or $intent.rpcTimeoutSeconds -ne ($intent.timeoutSeconds+15) -or $intent.graceSeconds -ne 5){throw 'Stop RPC intent deadline is invalid.'}
            if($intent.issuedAtMs-$NowMs -gt 5000 -or $intent.issuedAtMs -lt 0){throw 'Stop RPC intent timestamp is invalid.'}
            $until=$intent.issuedAtMs+1000*($intent.rpcTimeoutSeconds+$intent.timeoutSeconds+$intent.graceSeconds)
            if($until -gt $NowMs){$records.Add([pscustomobject]@{source='intent';service=$service;containerId=$intent.containerId;untilMs=$until;evidence=$file.FullName})}
        }
    }
    foreach($legacy in @(Get-GargantuaLegacyStopWindows -ProjectRoot $ProjectRoot -NowMs $NowMs)){$records.Add($legacy)}
    $current=@{}
    foreach($record in $records){
        if(-not $current.ContainsKey($record.service)){$current[$record.service]=& $CurrentHandler $record.service}
        $state=$current[$record.service]
        if(-not $state -or $state.exists -isnot [bool] -or -not $state.exists -or $state.id -ne $record.containerId){throw 'A container identity differs from its pending stop RPC; automatic startup/recovery requires review.'}
    }
    $until=$NowMs;if($records.Count){$until=[long](($records.ToArray()|Measure-Object untilMs -Maximum).Maximum)}
    return [pscustomobject]@{status='clear';pendingCount=$records.Count;untilMs=$until;remainingMs=[long][Math]::Max(0,$until-$NowMs);records=$records.ToArray()}
}
function Wait-GargantuaPendingStopBarrier {
    param([Parameter(Mandatory)][string]$ProjectRoot,[Parameter(Mandatory)][scriptblock]$CurrentHandler,
          [scriptblock]$Cancelled={param($Project)Test-Path -LiteralPath (Join-Path $Project '.local/operations/manual-stop.json')},
          [scriptblock]$Clock={ [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() },
          [scriptblock]$Sleep={param($Milliseconds)Start-Sleep -Milliseconds $Milliseconds},
          [ValidateRange(260,300)][int]$MaxWaitSeconds=265)
    $started=[long](& $Clock)
    if(& $Cancelled $ProjectRoot){return [pscustomobject]@{status='cancelled';waitedMs=0;pendingCount=0}}
    $barrier=Get-GargantuaPendingStopBarrier -ProjectRoot $ProjectRoot -CurrentHandler $CurrentHandler -NowMs $started
    while($true){
        if(& $Cancelled $ProjectRoot){return [pscustomobject]@{status='cancelled';waitedMs=([long](& $Clock)-$started);pendingCount=$barrier.pendingCount}}
        $now=[long](& $Clock);$remaining=$barrier.untilMs-$now
        if($remaining -le 0){break}
        if($now -lt $started-5000 -or $now-$started -gt $MaxWaitSeconds*1000 -or $remaining -gt ($MaxWaitSeconds*1000+5000)){throw 'Pending stop RPC wait exceeded its bounded clock window.'}
        & $Sleep ([int][Math]::Min(1000,$remaining))
    }
    # Revalidate the identities observed while the RPC was pending before the
    # caller may start/restore anything, even though that deadline just elapsed.
    $checked=@{}
    foreach($record in $barrier.records){
        if(-not $checked.ContainsKey($record.service)){$checked[$record.service]=& $CurrentHandler $record.service}
        $current=$checked[$record.service]
        if(-not $current -or $current.exists -isnot [bool] -or -not $current.exists -or $current.id -ne $record.containerId){throw 'Container identity changed while waiting for a pending stop RPC.'}
    }
    return [pscustomobject]@{status='clear';waitedMs=([long](& $Clock)-$started);pendingCount=$barrier.pendingCount}
}
