# Daily backup lifecycle. Helpers accept isolated callbacks for offline fault tests;
# production entrypoint always binds the existing snapshot/restore implementations.
function Read-GargantuaCycleJson {
    param([string]$Path,[int]$MaxBytes=1MB)
    Assert-GargantuaNoReparseAncestors -Path $Path
    $item=Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if($item.PSIsContainer -or $item.Length -gt $MaxBytes){throw 'Invalid or oversized backup-cycle metadata.'}
    return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Write-GargantuaCycleImmutable {
    param([string]$Path,$Value)
    Assert-GargantuaNoReparseAncestors -Path $Path
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Depth 15)+"`n")
    $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
}

function Assert-GargantuaCycleTree {
    param([string]$Root,[int]$MaxEntries=500000)
    Assert-GargantuaNoReparseAncestors -Path $Root
    $resolved=(Resolve-Path -LiteralPath $Root -ErrorAction Stop).Path
    if((Get-GargantuaFullPath $resolved) -ne (Get-GargantuaFullPath $Root)){throw 'Backup-cycle resolved boundary differs.'}
    $pending=[Collections.Generic.Stack[string]]::new();$pending.Push($resolved);$count=0
    while($pending.Count){
        foreach($item in @(Get-ChildItem -LiteralPath $pending.Pop() -Force -ErrorAction Stop)){
            $count++;if($count -gt $MaxEntries){throw 'Backup-cycle tree exceeds safe cleanup bound.'}
            if($item.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint) -or -not (Test-GargantuaPathWithin -Root $Root -Target $item.FullName)){throw 'Linked or escaped backup-cycle child; cleanup refused.'}
            if($item.PSIsContainer){$pending.Push($item.FullName)}
        }
    }
}

function Test-GargantuaCycleLeaseBusy {
    param([string]$Path)
    Assert-GargantuaNoReparseAncestors -Path $Path
    if(-not (Test-Path -LiteralPath $Path)){return $false}
    $probe=$null
    try{
        $probe=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
        if((Split-Path $Path -Leaf) -eq 'backup-snapshot.lock'){
            if($probe.Length -gt 128){throw 'Snapshot lease marker needs review.'}
            $data=[byte[]]::new([int]$probe.Length);$null=$probe.Read($data,0,$data.Length);$saved=[Text.Encoding]::UTF8.GetString($data).Trim()
            if($saved -and $saved -notmatch '^[a-fA-F0-9]{32}$'){throw 'Snapshot lease marker needs review.'}
        }
        return $false
    }
    catch [IO.IOException]{if(($_.Exception.HResult -band 65535) -in @(32,33)){return $true};throw}
    finally{if($probe){$probe.Dispose()}}
}

function Assert-GargantuaCyclePayload {
    param([Parameter(Mandatory)][string]$Snapshot,[Parameter(Mandatory)]$Manifest)
    Assert-GargantuaNoReparseAncestors -Path $Snapshot
    if($Manifest.files -isnot [Array] -or $Manifest.files.Count -gt 500000){throw 'Invalid or oversized snapshot file inventory.'}
    $expected=[Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach($record in @($Manifest.files)){
        $relative=$record.path
        if($relative -isnot [string] -or -not $relative -or $relative -eq 'manifest.json' -or $relative -match '[\x00-\x1f\\:]' -or $relative.StartsWith('/')){throw 'Snapshot manifest contains a reserved or nonportable path.'}
        $parts=$relative.Split('/')
        foreach($part in $parts){if(-not $part -or $part -in @('.','..') -or $part.EndsWith('.') -or $part.EndsWith(' ')){throw 'Snapshot manifest path escapes or aliases a file.'}}
        if($expected.ContainsKey($relative)){throw 'Snapshot manifest contains duplicate portable paths.'}
        if(($record.bytes -isnot [long] -and $record.bytes -isnot [int] -and $record.bytes -isnot [uint32] -and $record.bytes -isnot [uint64]) -or $record.bytes -lt 0 -or $record.bytes -gt [long]::MaxValue -or $record.sha256 -isnot [string] -or $record.sha256 -notmatch '^[a-fA-F0-9]{64}$'){throw 'Snapshot file has an invalid byte count or SHA256.'}
        $expected.Add($relative,$record)
    }
    foreach($required in @('database.dump','source.tar.gz','db-inventory.json','db-table-fingerprints.jsonl','snapshot-metadata.json')){if(-not $expected.ContainsKey($required)){throw 'Snapshot lacks a required database/source/baseline input.'}}
    # Walk with .NET enumerators rather than following recursive shell paths.
    # Every directory and file is checked before use; unknown files and links
    # make the historical restore evidence ineligible for today's decisions.
    $actual=[Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
    $pending=[Collections.Generic.Stack[IO.DirectoryInfo]]::new();$pending.Push([IO.DirectoryInfo]::new($Snapshot));$entries=0
    while($pending.Count){
        foreach($item in $pending.Pop().EnumerateFileSystemInfos()){
            $entries++;if($entries -gt 500000){throw 'Snapshot tree exceeds the verification bound.'}
            if($item.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)){throw 'Snapshot payload contains a reparse point.'}
            if(-not (Test-GargantuaPathWithin -Root $Snapshot -Target $item.FullName)){throw 'Snapshot payload escaped its canonical boundary.'}
            if($item -is [IO.DirectoryInfo]){$pending.Push($item);continue}
            $relative=$item.FullName.Substring($Snapshot.Length+1).Replace('\','/')
            if($relative -eq 'manifest.json'){continue}
            if(-not $expected.ContainsKey($relative) -or $actual.ContainsKey($relative)){throw 'Snapshot contains an unlisted or duplicate file.'}
            $actual.Add($relative,$item)
        }
    }
    if($actual.Count -ne $expected.Count){throw 'A manifest-listed snapshot file is missing.'}
    foreach($relative in $expected.Keys){
        $record=$expected[$relative];$stream=$null;$sha=$null
        try{
            # FileShare.Read permits independent readers while excluding writes
            # and deletion during this byte check. Size and hash use one handle.
            $stream=[IO.File]::Open($actual[$relative].FullName,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
            if($stream.Length -ne [long]$record.bytes){throw 'Snapshot payload byte count differs from its restore-verified manifest.'}
            $sha=[Security.Cryptography.SHA256]::Create();$digest=([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant()
            if($digest -ne $record.sha256.ToLowerInvariant() -or $stream.Length -ne [long]$record.bytes){throw 'Snapshot payload SHA256 differs from its restore-verified manifest.'}
        }finally{if($sha){$sha.Dispose()};if($stream){$stream.Dispose()}}
    }
}

function Get-GargantuaInterruptedCycleJournals {
    param([string]$ProjectRoot,[string]$ManagedRoot)
    if(-not (Test-Path -LiteralPath $ManagedRoot)){return}
    Assert-GargantuaNoReparseAncestors -Path $ManagedRoot
    foreach($dir in @(Get-ChildItem -LiteralPath $ManagedRoot -Force -Directory)){
        if($dir.Name -notmatch '^cycle-([a-f0-9]{32})$'){continue};$cycleId=$Matches[1]
        try{
            Assert-GargantuaNoReparseAncestors -Path $dir.FullName
            $owner=Read-GargantuaCycleJson -Path (Join-Path $dir.FullName 'cycle-owner.json')
            if($owner.kind -ne 'gargantua-automatic-backup' -or $owner.version -ne 1 -or $owner.cycleId -ne $cycleId -or $owner.root -ne $dir.FullName -or $owner.projectRoot -ne $ProjectRoot){continue}
        }catch{continue}
        if((Test-Path -LiteralPath (Join-Path $dir.FullName 'validated.json')) -or (Test-Path -LiteralPath (Join-Path $dir.FullName 'recovery-complete.json'))){continue}
        $payload=Join-Path $dir.FullName 'payload'
        if(-not (Test-Path -LiteralPath $payload)){continue}
        Assert-GargantuaNoReparseAncestors -Path $payload
        $children=@(Get-ChildItem -LiteralPath $payload -Force)
        if(-not $children.Count){continue}
        if($children.Count -ne 1 -or -not $children[0].PSIsContainer -or $children[0].Name -notmatch '^snapshot-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-[a-f0-9]{8}$'){throw 'Interrupted automatic cycle has an ambiguous snapshot; service recovery needs review.'}
        $snapshot=$children[0].FullName;Assert-GargantuaNoReparseAncestors -Path $snapshot
        $manifest=Read-GargantuaCycleJson -Path (Join-Path $snapshot 'manifest.json') -MaxBytes 64MB
        if($manifest.status -eq 'ready'){continue}
        if($manifest.status -eq 'incomplete' -and @($manifest.recoveryErrors).Count -eq 0){continue}
        if($manifest.status -notin @('building','incomplete') -or $manifest.snapshotId -notmatch '^[a-f0-9]{32}$'){throw 'Interrupted snapshot has invalid identity/state; service recovery needs review.'}
        $journalPath=Join-Path $snapshot 'service-state-before.json'
        if(-not (Test-Path -LiteralPath $journalPath)){continue} # journal precedes first service mutation
        $journal=Read-GargantuaCycleJson -Path $journalPath
        if($journal.snapshotId -ne $manifest.snapshotId -or @($journal.handlers).Count -ne 2 -or @($journal.handlers|Where-Object {$_.service -eq 'worker'}).Count -ne 1 -or @($journal.handlers|Where-Object {$_.service -eq 'parser'}).Count -ne 1){throw 'Interrupted service journal identity differs; recovery needs review.'}
        foreach($handler in @($journal.handlers)){
            if($handler.exists -isnot [bool] -or $handler.running -isnot [bool] -or $handler.paused -isnot [bool] -or ($handler.exists -and $handler.id -notmatch '^[a-f0-9]{12,64}$') -or ($handler.paused -and -not $handler.running)){throw 'Interrupted service state is invalid; recovery needs review.'}
        }
        [pscustomobject]@{cycleId=$cycleId;path=$dir.FullName;snapshotId=$manifest.snapshotId;handlers=@($journal.handlers)}
    }
}

function Restore-GargantuaInterruptedCycles {
    param([string]$ProjectRoot,[string]$ManagedRoot,[scriptblock]$CurrentHandler,[scriptblock]$RestoreHandler)
    $journals=@(Get-GargantuaInterruptedCycleJournals -ProjectRoot $ProjectRoot -ManagedRoot $ManagedRoot)
    if(-not $journals.Count){return 0}
    if(Test-Path -LiteralPath (Join-Path $ProjectRoot '.local/operations/manual-stop.json')){throw 'Interrupted backup recovery is held by the manual server stop.'}
    # Validate every journal/current ID before the first mutation. Multiple old
    # interrupted snapshots are ambiguous, even if their IDs happen to match.
    if($journals.Count -ne 1){throw 'Multiple interrupted backup journals need review before service recovery.'}
    $entry=$journals[0]
    foreach($handler in $entry.handlers){
        $current=& $CurrentHandler $handler.service
        if($current.exists -ne $handler.exists -or ($handler.exists -and $current.id -ne $handler.id)){throw 'A service container was recreated after an interrupted backup; recovery needs review.'}
    }
    foreach($handler in $entry.handlers){& $RestoreHandler $handler|Out-Null}
    Write-GargantuaCycleImmutable -Path (Join-Path $entry.path 'recovery-complete.json') -Value @{version=1;cycleId=$entry.cycleId;snapshotId=$entry.snapshotId;recoveredAt=[DateTimeOffset]::UtcNow.ToString('o');snapshotStillInvalid=$true}
    return 1
}

function Get-GargantuaValidatedCycle {
    param([string]$ProjectRoot,[string]$ManagedRoot,[string]$CyclePath)
    $path=Get-GargantuaFullPath $CyclePath
    if((Split-Path $path -Parent) -ne $ManagedRoot -or (Split-Path $path -Leaf) -notmatch '^cycle-([a-f0-9]{32})$'){throw 'Not an owned automatic-backup directory.'}
    $token=$Matches[1]
    Assert-GargantuaNoReparseAncestors -Path $path
    $owner=Read-GargantuaCycleJson -Path (Join-Path $path 'cycle-owner.json')
    if($owner.version -ne 1 -or $owner.kind -ne 'gargantua-automatic-backup' -or $owner.cycleId -ne $token -or $owner.root -ne $path -or $owner.projectRoot -ne $ProjectRoot -or $owner.localDate -notmatch '^\d{4}-\d{2}-\d{2}$'){throw 'Automatic-backup ownership mismatch.'}
    $done=Read-GargantuaCycleJson -Path (Join-Path $path 'validated.json')
    if($done.version -ne 1 -or $done.status -ne 'restore-validated' -or $done.cycleId -ne $token -or $done.localDate -ne $owner.localDate -or $done.snapshotName -notmatch '^snapshot-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-[a-f0-9]{8}$' -or $done.snapshotId -notmatch '^[a-f0-9]{32}$'){throw 'Automatic backup lacks a complete validation marker.'}
    $snapshot=Join-Path (Join-Path $path 'payload') $done.snapshotName
    Assert-GargantuaNoReparseAncestors -Path $snapshot
    if((Resolve-Path -LiteralPath $snapshot -ErrorAction Stop).Path -ne $snapshot){throw 'Snapshot resolved outside its managed path.'}
    $manifestPath=Join-Path $snapshot 'manifest.json';$metadataPath=Join-Path $snapshot 'snapshot-metadata.json';$reportPath=Join-Path $path 'verification-report.json'
    $manifest=Read-GargantuaCycleJson -Path $manifestPath -MaxBytes 64MB
    $metadata=Read-GargantuaCycleJson -Path $metadataPath
    $report=Read-GargantuaCycleJson -Path $reportPath -MaxBytes 8MB
    if($manifest.version -ne 2 -or $manifest.status -ne 'ready' -or $manifest.integrityValidated -ne $true -or $metadata.snapshotId -ne $done.snapshotId -or $metadata.handlersRestored -ne $true){throw 'Snapshot integrity/identity marker differs.'}
    if((Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $done.manifestSha256 -or (Get-FileHash -LiteralPath $reportPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $done.reportSha256){throw 'Automatic-backup validation evidence changed.'}
    Assert-GargantuaCyclePayload -Snapshot $snapshot -Manifest $manifest
    $expectedRestore=Join-Path $ProjectRoot ('.local/restore-checks/automatic-'+$token)
    if($report.version -ne 1 -or $report.status -ne 'validated' -or $report.backup -ne $snapshot -or $report.restoreRoot -ne $expectedRestore -or $report.cleanupRequested -ne $true -or $report.environmentKept -ne $false -or @($report.cleanupErrors).Count -ne 0 -or $report.error -or $report.validation.status -ne 'validated' -or $report.validation.databaseTablesCompared -lt 1 -or (Test-Path -LiteralPath $expectedRestore)){throw 'Isolated restore and cleanup were not fully confirmed.'}
    $finished=if($done.finishedAt -is [DateTime] -or $done.finishedAt -is [DateTimeOffset]){[DateTimeOffset]$done.finishedAt}else{[DateTimeOffset]::ParseExact($done.finishedAt,'o',[Globalization.CultureInfo]::InvariantCulture)}
    return [pscustomobject]@{cycleId=$token;path=$path;snapshot=$snapshot;localDate=$owner.localDate;finishedAt=$finished;marker=$done}
}

function Get-GargantuaCycleInventory {
    param([string]$ProjectRoot,[string]$ManagedRoot)
    $valid=[Collections.Generic.List[object]]::new();$ignored=0
    if(Test-Path -LiteralPath $ManagedRoot){
        Assert-GargantuaNoReparseAncestors -Path $ManagedRoot
        foreach($item in @(Get-ChildItem -LiteralPath $ManagedRoot -Force -ErrorAction Stop)){
            if(-not $item.PSIsContainer -or $item.Name -notmatch '^cycle-[a-f0-9]{32}$'){$ignored++;continue}
            try{$valid.Add((Get-GargantuaValidatedCycle -ProjectRoot $ProjectRoot -ManagedRoot $ManagedRoot -CyclePath $item.FullName))}catch{$ignored++}
        }
    }
    return [pscustomobject]@{validated=@($valid.ToArray()|Sort-Object finishedAt -Descending);ignored=$ignored}
}

function Invoke-GargantuaCycleRetention {
    param([string]$ProjectRoot,[string]$ManagedRoot,[ValidateRange(2,365)][int]$Keep=7,[string[]]$ProtectCycleIds=@())
    $inventory=Get-GargantuaCycleInventory -ProjectRoot $ProjectRoot -ManagedRoot $ManagedRoot
    $protect=@($ProtectCycleIds)+@($inventory.validated|Select-Object -First ([Math]::Max(2,$Keep))|ForEach-Object {$_.cycleId})
    $removed=[Collections.Generic.List[string]]::new();$errors=[Collections.Generic.List[string]]::new()
    foreach($candidate in @($inventory.validated)){
        if($candidate.cycleId -in $protect){continue}
        try{
            # Re-read GUID/identity/evidence immediately before examining and
            # deleting this one owned tree. No wildcard or cross-shell deletion.
            $confirmed=Get-GargantuaValidatedCycle -ProjectRoot $ProjectRoot -ManagedRoot $ManagedRoot -CyclePath $candidate.path
            if($confirmed.cycleId -in $protect){throw 'Protected backup cannot be rotated.'}
            $rootChildren=@(Get-ChildItem -LiteralPath $confirmed.path -Force)
            if(@($rootChildren|Where-Object {$_.Name -notin @('cycle-owner.json','payload','verification-report.json','validated.json')}).Count){throw 'Unknown content in automatic cycle; cleanup refused.'}
            $payloadChildren=@(Get-ChildItem -LiteralPath (Join-Path $confirmed.path 'payload') -Force)
            if($payloadChildren.Count -ne 1 -or $payloadChildren[0].FullName -ne $confirmed.snapshot){throw 'Unknown payload in automatic cycle; cleanup refused.'}
            Assert-GargantuaCycleTree -Root $confirmed.path
            $manifest=Read-GargantuaCycleJson -Path (Join-Path $confirmed.snapshot 'manifest.json') -MaxBytes 64MB
            $knownFiles=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase);$knownDirs=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
            $null=$knownFiles.Add('manifest.json')
            foreach($record in @($manifest.files)){
                $relative=[string]$record.path
                if(-not $relative -or $relative -match '(^/|\\|:|(^|/)\.\.?(/|$))'){throw 'Unsafe manifest path; cleanup refused.'}
                $null=$knownFiles.Add($relative)
                $parts=$relative.Split('/');for($index=1;$index -lt $parts.Count;$index++){$null=$knownDirs.Add(($parts[0..($index-1)] -join '/'))}
            }
            # Empty books/derived roots are legitimate for a small library.
            $null=$knownDirs.Add('books');$null=$knownDirs.Add('derived')
            foreach($item in @(Get-ChildItem -LiteralPath $confirmed.snapshot -Force -Recurse)){
                $relative=$item.FullName.Substring($confirmed.snapshot.Length+1).Replace('\','/')
                if(($item.PSIsContainer -and -not $knownDirs.Contains($relative)) -or (-not $item.PSIsContainer -and -not $knownFiles.Contains($relative))){throw 'Unknown content inside the snapshot; cleanup refused.'}
            }
            Assert-GargantuaNoReparseAncestors -Path $confirmed.path
            Remove-Item -LiteralPath $confirmed.path -Recurse -Force -ErrorAction Stop
            $removed.Add($confirmed.cycleId)
        }catch{$message='Retention refused/failed for cycle '+$candidate.cycleId+': '+$_.Exception.Message;if($message.Length -gt 700){$message=$message.Substring(0,700)};$errors.Add($message)}
    }
    return [pscustomobject]@{removed=@($removed.ToArray()|Select-Object -First 40);removedCount=$removed.Count;errors=@($errors.ToArray()|Select-Object -First 20);errorCount=$errors.Count;ignored=$inventory.ignored;keep=$Keep}
}

function Write-GargantuaCycleState {
    param([string]$StatePath,$Previous,$Result)
    $history=@();if($Previous -and $Previous.history){$history=@($Previous.history|Select-Object -Last 39|ForEach-Object {
        $errorText=[string]$_.error;if($errorText.Length -gt 700){$errorText=$errorText.Substring(0,700)}
        @{at=([string]$_.at).Substring(0,[Math]::Min(64,([string]$_.at).Length));status=([string]$_.status).Substring(0,[Math]::Min(40,([string]$_.status).Length));cycleId=([string]$_.cycleId).Substring(0,[Math]::Min(32,([string]$_.cycleId).Length));error=$errorText}
    })}
    $history+=@([pscustomobject]@{at=$Result.at;status=$Result.status;cycleId=$Result.cycleId;error=$Result.error})
    $lastGood=$null
    if($Previous -and $Previous.lastGood -and $Previous.lastGood.cycleId -match '^[a-f0-9]{32}$' -and $Previous.lastGood.localDate -match '^\d{4}-\d{2}-\d{2}$' -and ([string]$Previous.lastGood.snapshot).Length -le 2048 -and ([string]$Previous.lastGood.at).Length -le 64){$lastGood=@{cycleId=$Previous.lastGood.cycleId;localDate=[string]$Previous.lastGood.localDate;snapshot=[string]$Previous.lastGood.snapshot;at=[string]$Previous.lastGood.at}}
    if($Result.status -in @('validated','validated-with-cleanup-warning')){$lastGood=@{cycleId=$Result.cycleId;localDate=$Result.localDate;snapshot=$Result.snapshot;at=$Result.at}}
    $retentionWarning=$null
    if($Previous -and $Previous.retentionWarning){$retentionWarning=@{pending=$true;message='Older automatic backup cleanup needs attention; restore-validated backups remain available.'}}
    if($Result.status -eq 'validated-with-cleanup-warning'){$retentionWarning=@{pending=$true;message='Older automatic backup cleanup needs attention; restore-validated backups remain available.'}}
    elseif($Result.status -eq 'validated'){$retentionWarning=$null}
    Assert-GargantuaNoReparseAncestors -Path $StatePath
    Assert-GargantuaNoReparseAncestors -Path ($StatePath+'.tmp')
    Write-GargantuaJson -Path $StatePath -Value @{version=1;lastResult=$Result;lastGood=$lastGood;retentionWarning=$retentionWarning;history=@($history|Select-Object -Last 40)}
}

function Invoke-GargantuaBackupCycle {
    [CmdletBinding()]
    param([string]$ProjectRoot,[DateTimeOffset]$Now=[DateTimeOffset]::Now,[switch]$Force,[ValidateRange(2,365)][int]$Keep=7,
        [Parameter(Mandatory)][scriptblock]$Probe,[Parameter(Mandatory)][scriptblock]$Snapshot,[Parameter(Mandatory)][scriptblock]$Restore,
        [Parameter(Mandatory)][scriptblock]$ProtectDirectory,[scriptblock]$Recover={param($Project,$Managed) return 0})
    $project=Get-GargantuaFullPath $ProjectRoot;$operations=Join-Path $project '.local/operations';$managed=Join-Path $project 'backups/automatic'
    $statePath=Join-Path $operations 'backup-state.json';$lockPath=Join-Path $operations 'backup-cycle.lock'
    $lock=$null;$previous=$null;$cycle=$null;$cycleId=$null;$snapshotPath=$null
    $result=[pscustomobject][ordered]@{version=1;status='failed';at=$Now.ToString('o');localDate=$Now.ToString('yyyy-MM-dd');cycleId=$null;snapshot=$null;error=$null;retention=$null;unvalidatedOrUnknown=0;recoveredInterruptedCycles=0}
    try{
        Assert-GargantuaNoReparseAncestors -Path $operations;Assert-GargantuaNoReparseAncestors -Path $managed
        New-Item -ItemType Directory -Force -Path $operations|Out-Null;& $ProtectDirectory $operations|Out-Null
        Assert-GargantuaNoReparseAncestors -Path $lockPath
        try{$lock=[IO.File]::Open($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}catch [IO.IOException]{if(($_.Exception.HResult -band 65535) -notin @(32,33)){throw};$result.status='skipped-busy';return [pscustomobject]$result}
        $lock.SetLength(0);$bytes=[Text.UTF8Encoding]::new($false).GetBytes(([string]$PID));$lock.Write($bytes,0,$bytes.Length);$lock.Flush($true)
        if(Test-Path -LiteralPath $statePath){try{$previous=Read-GargantuaCycleJson -Path $statePath}catch{$previous=$null}}
        $manualStop=Join-Path $operations 'manual-stop.json'
        if(Test-Path -LiteralPath $manualStop){Assert-GargantuaNoReparseAncestors -Path $manualStop;$result.status='skipped-server-off';return $result}
        if((Test-GargantuaCycleLeaseBusy -Path (Join-Path $project '.local/backup-snapshot.lock')) -or (Test-GargantuaCycleLeaseBusy -Path (Join-Path $operations 'lifecycle.lock'))){$result.status='skipped-busy';return $result}
        $result.recoveredInterruptedCycles=& $Recover $project $managed
        $inventory=Get-GargantuaCycleInventory -ProjectRoot $project -ManagedRoot $managed
        $result.unvalidatedOrUnknown=$inventory.ignored
        $lastGoodEligible=$false
        if($previous -and $previous.lastGood){$lastGoodEligible=@($inventory.validated|Where-Object {$_.cycleId -eq $previous.lastGood.cycleId}).Count -eq 1}
        if(-not $lastGoodEligible){
            $oldHistory=@();$oldWarning=$null;if($previous){$oldHistory=@($previous.history);$oldWarning=$previous.retentionWarning}
            $lastGood=$null
            if($inventory.validated.Count){$newest=$inventory.validated[0];$lastGood=@{cycleId=$newest.cycleId;localDate=$newest.localDate;snapshot=$newest.snapshot;at=$newest.finishedAt.ToString('o')}}
            $previous=[pscustomobject]@{history=$oldHistory;lastGood=$lastGood;retentionWarning=$oldWarning}
        }
        if(-not $Force -and @($inventory.validated|Where-Object {$_.localDate -eq $result.localDate}).Count){
            $result.status='not-due';return $result
        }
        # Respect intentional downtime. Neither this runner nor the preflight
        # starts Docker Desktop, a compose service or any stopped handler.
        if((Test-GargantuaCycleLeaseBusy -Path (Join-Path $project '.local/backup-snapshot.lock')) -or (Test-GargantuaCycleLeaseBusy -Path (Join-Path $operations 'lifecycle.lock'))){$result.status='skipped-busy';return $result}
        $ready=& $Probe
        if(-not $ready){$result.status='skipped-server-off';return $result}
        New-Item -ItemType Directory -Force -Path $managed|Out-Null;& $ProtectDirectory $managed|Out-Null
        $cycleId=[Guid]::NewGuid().ToString('N');$cycle=Join-Path $managed ('cycle-'+$cycleId);$result.cycleId=$cycleId
        if(Test-Path -LiteralPath $cycle){throw 'Automatic backup cycle already exists.'}
        New-Item -ItemType Directory -Path $cycle|Out-Null;& $ProtectDirectory $cycle|Out-Null
        Write-GargantuaCycleImmutable -Path (Join-Path $cycle 'cycle-owner.json') -Value @{version=1;kind='gargantua-automatic-backup';cycleId=$cycleId;root=$cycle;projectRoot=$project;createdAt=$Now.ToString('o');localDate=$result.localDate}
        $payload=Join-Path $cycle 'payload';New-Item -ItemType Directory -Path $payload|Out-Null
        & $Snapshot $payload|Out-Null
        # Existing backup.ps1 deliberately prints a human summary. Discover the
        # sole actual child inside this run's newly-created private destination.
        $children=@(Get-ChildItem -LiteralPath $payload -Force -ErrorAction Stop)
        if($children.Count -ne 1 -or -not $children[0].PSIsContainer -or $children[0].Name -notmatch '^snapshot-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-[a-f0-9]{8}$'){throw 'Snapshot did not produce exactly one owned snapshot directory.'}
        $snapshotPath=$children[0].FullName;$result.snapshot=$snapshotPath
        Assert-GargantuaNoReparseAncestors -Path $snapshotPath
        $manifestPath=Join-Path $snapshotPath 'manifest.json';$manifest=Read-GargantuaCycleJson -Path $manifestPath -MaxBytes 64MB
        $metadata=Read-GargantuaCycleJson -Path (Join-Path $snapshotPath 'snapshot-metadata.json')
        if($manifest.version -ne 2 -or $manifest.status -ne 'ready' -or $manifest.integrityValidated -ne $true -or $metadata.snapshotId -notmatch '^[a-f0-9]{32}$' -or $metadata.handlersRestored -ne $true){throw 'Snapshot integrity is incomplete; restore validation was not claimed.'}
        $reportPath=Join-Path $cycle 'verification-report.json';$restoreRoot=Join-Path $project ('.local/restore-checks/automatic-'+$cycleId)
        & $Restore $snapshotPath $restoreRoot $reportPath|Out-Null
        $report=Read-GargantuaCycleJson -Path $reportPath -MaxBytes 8MB
        if($report.version -ne 1 -or $report.status -ne 'validated' -or $report.backup -ne $snapshotPath -or $report.restoreRoot -ne $restoreRoot -or $report.cleanupRequested -ne $true -or $report.environmentKept -ne $false -or @($report.cleanupErrors).Count -ne 0 -or $report.error -or $report.validation.status -ne 'validated' -or $report.validation.databaseTablesCompared -lt 1 -or (Test-Path -LiteralPath $restoreRoot)){throw 'Restore verification or isolated environment cleanup did not complete.'}
        Write-GargantuaCycleImmutable -Path (Join-Path $cycle 'validated.json') -Value @{version=1;status='restore-validated';cycleId=$cycleId;localDate=$result.localDate;snapshotName=$children[0].Name;snapshotId=$metadata.snapshotId;finishedAt=[DateTimeOffset]::UtcNow.ToString('o');manifestSha256=(Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant();reportSha256=(Get-FileHash -LiteralPath $reportPath -Algorithm SHA256).Hash.ToLowerInvariant()}
        # A crash after this immutable marker remains recoverable on the next
        # run even if state.json could not be committed.
        $confirmed=Get-GargantuaValidatedCycle -ProjectRoot $project -ManagedRoot $managed -CyclePath $cycle
        $result.status='validated'
        $protect=@($cycleId);if($previous -and $previous.lastGood -and $previous.lastGood.cycleId){$protect+=@($previous.lastGood.cycleId)}
        $result.retention=Invoke-GargantuaCycleRetention -ProjectRoot $project -ManagedRoot $managed -Keep $Keep -ProtectCycleIds $protect
        if(@($result.retention.errors).Count){$result.status='validated-with-cleanup-warning';$result.error='The new backup is restore-validated, but older backup cleanup needs attention.'}
    }catch{
        $result.status='failed';$message=$_.Exception.Message;if($message.Length -gt 700){$message=$message.Substring(0,700)};$result.error=$message
    }finally{
        if($lock){
            try{Write-GargantuaCycleState -StatePath $statePath -Previous $previous -Result ([pscustomobject]$result)}catch{if($result.status -in @('validated','validated-with-cleanup-warning')){$result.status='validated-with-cleanup-warning'}else{$result.status='failed'};$result.error='Backup-cycle state could not be committed; immutable cycle evidence is retained.'}
            $lock.Dispose()
        }
    }
    return [pscustomobject]$result
}
