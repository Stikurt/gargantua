<# Offline fault tests only. All fake snapshots, journals and rotation targets
are children of one GUID-owned fixture. No Docker, tasks or real backup run. #>
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
. (Join-Path $project 'scripts/backup-common.ps1')
. (Join-Path $project 'scripts/backup-cycle-common.ps1')
. (Join-Path $project 'scripts/backup-cycle-lock.ps1')
$cases=[Collections.Generic.List[object]]::new();$token=[Guid]::NewGuid().ToString('N')
$base=Join-Path $project '.local/test-results';$root=Join-Path $base ('backup-cycle-'+$token)
$script:fixture='';$script:snapshotCount=0;$script:restoreCount=0;$script:mode='';$script:recovered=@()
function Assert-Cycle([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message}}
function Assert-CycleThrows([scriptblock]$Body){$thrown=$false;try{& $Body|Out-Null}catch{$thrown=$true};Assert-Cycle $thrown 'Expected refusal did not occur.'}
function Test-Cycle([string]$Name,[scriptblock]$Body){try{& $Body;$cases.Add(@{name=$Name;status='PASS'});Write-Host "PASS $Name"}catch{$cases.Add(@{name=$Name;status='FAIL';error=$_.Exception.Message});Write-Host "FAIL $Name`: $($_.Exception.Message)"}}
function New-CycleFixture {
    $script:fixture=Join-Path $root ([Guid]::NewGuid().ToString('N'));New-Item -ItemType Directory -Path $script:fixture|Out-Null
    $script:snapshotCount=0;$script:restoreCount=0;$script:mode='';$script:recovered=@();return $script:fixture
}
$snapshot={
    param($Destination)
    $script:snapshotCount++
    if($script:mode -eq 'snapshot-error'){throw 'Injected snapshot interruption.'}
    $id=[Guid]::NewGuid().ToString('N');$path=Join-Path $Destination ('snapshot-2026-10-23_12-00-00-'+$id.Substring(0,8))
    New-Item -ItemType Directory -Path $path|Out-Null
    $status=if($script:mode -eq 'incomplete'){'building'}else{'ready'}
    Write-GargantuaJson -Path (Join-Path $path 'snapshot-metadata.json') -Value @{snapshotId=$id;handlersRestored=$true}
    foreach($name in @('database.dump','source.tar.gz','db-inventory.json','db-table-fingerprints.jsonl')){[IO.File]::WriteAllText((Join-Path $path $name),'OFFLINE-FAKE-CONTENT')}
    New-Item -ItemType Directory -Path (Join-Path $path 'books')|Out-Null;[IO.File]::WriteAllText((Join-Path $path 'books/chapter.txt'),'OFFLINE-FAKE-CHAPTER')
    $files=@(Get-ChildItem -LiteralPath $path -File -Recurse|ForEach-Object {@{path=$_.FullName.Substring($path.Length+1).Replace('\','/');bytes=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}})
    Write-GargantuaJson -Path (Join-Path $path 'manifest.json') -Value @{version=2;status=$status;integrityValidated=($status -eq 'ready');snapshotId=$id;files=$files}
}
$restore={
    param($Backup,$RestoreRoot,$ReportPath)
    $script:restoreCount++
    if($script:mode -eq 'restore-error'){throw 'Injected isolated restore failure.'}
    if($script:mode -eq 'no-report'){return}
    $cleanupErrors=@();$retained=$false;$status='validated'
    if($script:mode -eq 'cleanup-error'){$cleanupErrors=@('Injected cleanup failure');$retained=$true;$status='failed'}
    if($script:mode -eq 'retained-root'){New-Item -ItemType Directory -Path $RestoreRoot -Force|Out-Null}
    Write-GargantuaJson -Path $ReportPath -Value @{version=1;status=$status;backup=$Backup;restoreRoot=$RestoreRoot;cleanupRequested=$true;environmentKept=$retained;cleanupErrors=$cleanupErrors;error=$null;validation=@{status='validated';databaseTablesCompared=34}}
}
function Invoke-FakeCycle {
    param([DateTimeOffset]$Now=[DateTimeOffset]::Parse('2026-10-23T12:00:00+05:00'),[switch]$Force,[int]$Keep=7,[scriptblock]$Probe={return $true})
    Invoke-GargantuaBackupCycle -ProjectRoot $script:fixture -Now $Now -Force:$Force -Keep $Keep -Probe $Probe -Snapshot $snapshot -Restore $restore -ProtectDirectory {param($Path)}
}
function Get-FakeInventory {Get-GargantuaCycleInventory -ProjectRoot $script:fixture -ManagedRoot (Join-Path $script:fixture 'backups/automatic')}
function New-InterruptedJournal {
    $script:mode='incomplete';$result=Invoke-FakeCycle;$script:mode=''
    $state=@([pscustomobject]@{service='worker';id=('a'*64);exists=$true;running=$true;paused=$false},[pscustomobject]@{service='parser';id=('b'*64);exists=$true;running=$true;paused=$false})
    $manifest=Read-GargantuaCycleJson (Join-Path $result.snapshot 'manifest.json')
    Write-GargantuaJson -Path (Join-Path $result.snapshot 'service-state-before.json') -Value @{snapshotId=$manifest.snapshotId;handlers=$state}
    return $result
}
function Restore-FakeInterrupted {
    param([switch]$Mismatch)
    $script:mismatch=[bool]$Mismatch
    Restore-GargantuaInterruptedCycles -ProjectRoot $script:fixture -ManagedRoot (Join-Path $script:fixture 'backups/automatic') -CurrentHandler {
        param($Name)
        $id=if($Name -eq 'worker'){'a'*64}else{'b'*64};if($script:mismatch -and $Name -eq 'parser'){$id='c'*64}
        [pscustomobject]@{service=$Name;id=$id;exists=$true;running=$false;paused=$false}
    } -RestoreHandler {param($State) $script:recovered+=@($State.service)}
}
try{
    Assert-GargantuaNoReparseAncestors -Path $root
    New-Item -ItemType Directory -Path $root -Force|Out-Null
    Write-GargantuaCycleImmutable -Path (Join-Path $root 'test-owner.json') -Value @{token=$token;root=$root}
    Test-Cycle 'full success requires real-shaped restore report and cleanup confirmation' {
        New-CycleFixture|Out-Null;$r=Invoke-FakeCycle
        Assert-Cycle ($r.status -eq 'validated' -and $script:snapshotCount -eq 1 -and $script:restoreCount -eq 1) ('Cycle not validated: '+$r.error)
        Assert-Cycle ((Get-FakeInventory).validated.Count -eq 1) 'Validated evidence not rediscovered.'
        $state=Read-GargantuaCycleJson (Join-Path $script:fixture '.local/operations/backup-state.json')
        Assert-Cycle ($state.lastGood.cycleId -eq $r.cycleId) 'Last good missing.'
    }
    Test-Cycle 'daily due uses local date and catches up after a missed day' {
        New-CycleFixture|Out-Null;$first=Invoke-FakeCycle;$skip=Invoke-FakeCycle -Now ([DateTimeOffset]::Parse('2026-10-23T23:59:00+05:00'));$next=Invoke-FakeCycle -Now ([DateTimeOffset]::Parse('2026-10-25T00:01:00+05:00'))
        Assert-Cycle ($first.status -eq 'validated' -and $skip.status -eq 'not-due' -and $next.status -eq 'validated' -and $script:snapshotCount -eq 2) 'Daily catchup/due differed.'
    }
    Test-Cycle 'force permits explicit second verification on same day' {
        New-CycleFixture|Out-Null;Invoke-FakeCycle|Out-Null;$r=Invoke-FakeCycle -Force
        Assert-Cycle ($r.status -eq 'validated' -and $script:snapshotCount -eq 2) 'Force did not run.'
    }
    Test-Cycle 'server off is an expected skip without creating a snapshot or starting services' {
        New-CycleFixture|Out-Null;$r=Invoke-FakeCycle -Probe {return $false}
        Assert-Cycle ($r.status -eq 'skipped-server-off' -and $script:snapshotCount -eq 0 -and -not (Test-Path -LiteralPath (Join-Path $script:fixture 'backups/automatic'))) 'Off server was touched.'
    }
    Test-Cycle 'concurrent runner cannot pass the exclusive cycle lease' {
        New-CycleFixture|Out-Null;$ops=Join-Path $script:fixture '.local/operations';New-Item -ItemType Directory -Path $ops -Force|Out-Null
        $lease=[IO.File]::Open((Join-Path $ops 'backup-cycle.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
        try{$r=Invoke-FakeCycle;Assert-Cycle ($r.status -eq 'skipped-busy' -and $script:snapshotCount -eq 0) 'Concurrent cycle was admitted.'}finally{$lease.Dispose()}
    }
    Test-Cycle 'inaccessible cycle lease is a failure rather than an expected busy skip' {
        New-CycleFixture|Out-Null;$ops=Join-Path $script:fixture '.local/operations';New-Item -ItemType Directory -Path (Join-Path $ops 'backup-cycle.lock') -Force|Out-Null
        $r=Invoke-FakeCycle
        Assert-Cycle ($r.status -eq 'failed' -and $script:snapshotCount -eq 0) 'An inaccessible lock was hidden as expected contention.'
    }
    Test-Cycle 'explicit manual stop prevents backup even if service probe would report online' {
        New-CycleFixture|Out-Null;$ops=Join-Path $script:fixture '.local/operations';New-Item -ItemType Directory -Path $ops -Force|Out-Null
        Write-GargantuaJson -Path (Join-Path $ops 'manual-stop.json') -Value @{stopped=$true}
        $r=Invoke-FakeCycle -Force -Probe {throw 'Probe must not be called after explicit stop.'}
        Assert-Cycle ($r.status -eq 'skipped-server-off' -and $script:snapshotCount -eq 0) 'Explicit stop ignored.'
    }
    Test-Cycle 'manual snapshot lease and lifecycle operations block automatic snapshot' {
        foreach($relative in @('.local/backup-snapshot.lock','.local/operations/lifecycle.lock')){
            New-CycleFixture|Out-Null;$path=Join-Path $script:fixture $relative;New-Item -ItemType Directory -Force -Path (Split-Path $path -Parent)|Out-Null
            $lease=[IO.File]::Open($path,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
            try{$r=Invoke-FakeCycle;Assert-Cycle ($r.status -eq 'skipped-busy' -and $script:snapshotCount -eq 0) 'Shared service operation raced.'}finally{$lease.Dispose()}
        }
    }
    Test-Cycle 'failed restore preserves prior last good and does not fulfill daily due' {
        New-CycleFixture|Out-Null;$good=Invoke-FakeCycle;$script:mode='restore-error';$failed=Invoke-FakeCycle -Now ([DateTimeOffset]::Parse('2026-10-24T12:00:00+05:00'))
        $state=Read-GargantuaCycleJson (Join-Path $script:fixture '.local/operations/backup-state.json')
        Assert-Cycle ($failed.status -eq 'failed' -and $state.lastGood.cycleId -eq $good.cycleId -and (Get-FakeInventory).validated.Count -eq 1) 'Failed restore replaced valid copy.'
        $script:mode='';$retry=Invoke-FakeCycle -Now ([DateTimeOffset]::Parse('2026-10-24T13:00:00+05:00'));Assert-Cycle ($retry.status -eq 'validated') 'Failure incorrectly satisfied daily schedule.'
    }
    Test-Cycle 'interrupted manifest never reaches restore or acquires success marker' {
        New-CycleFixture|Out-Null;$script:mode='incomplete';$r=Invoke-FakeCycle
        Assert-Cycle ($r.status -eq 'failed' -and $script:restoreCount -eq 0 -and (Get-FakeInventory).validated.Count -eq 0) 'Building manifest promoted.'
    }
    Test-Cycle 'absent report cleanup errors and retained isolated root all fail closed' {
        foreach($mode in @('no-report','cleanup-error','retained-root')){
            New-CycleFixture|Out-Null;$script:mode=$mode;$r=Invoke-FakeCycle
            Assert-Cycle ($r.status -eq 'failed' -and (Get-FakeInventory).validated.Count -eq 0) ('Unsafe restore accepted: '+$mode)
        }
    }
    Test-Cycle 'lost state is rebuilt from immutable markers without a duplicate daily backup' {
        New-CycleFixture|Out-Null;$r=Invoke-FakeCycle;Remove-Item -LiteralPath (Join-Path $script:fixture '.local/operations/backup-state.json')
        $second=Invoke-FakeCycle;$rebuilt=Read-GargantuaCycleJson (Join-Path $script:fixture '.local/operations/backup-state.json')
        Assert-Cycle ($second.status -eq 'not-due' -and $script:snapshotCount -eq 1 -and $rebuilt.lastGood.cycleId -eq $r.cycleId) 'State loss duplicated daily copy or lost last good identity.'
    }
    Test-Cycle 'retention keeps newest three validated copies and ignores manual or failed trees' {
        New-CycleFixture|Out-Null
        $managed=Join-Path $script:fixture 'backups/automatic';New-Item -ItemType Directory -Path (Join-Path $managed 'manual-copy') -Force|Out-Null
        [IO.File]::WriteAllText((Join-Path $managed 'manual-copy/keep.txt'),'untouched')
        $script:mode='snapshot-error';Invoke-FakeCycle|Out-Null;$script:mode=''
        1..8|ForEach-Object {Invoke-FakeCycle -Force -Keep 3|Out-Null}
        $inventory=Get-FakeInventory
        Assert-Cycle ($inventory.validated.Count -eq 3 -and $inventory.ignored -eq 2 -and (Test-Path -LiteralPath (Join-Path $managed 'manual-copy/keep.txt'))) 'Rotation deleted unknown/failed data or kept wrong validated count.'
    }
    Test-Cycle 'changed report hash cannot be treated as validated or deleted' {
        New-CycleFixture|Out-Null;$good=Invoke-FakeCycle;$cycle=Split-Path (Split-Path $good.snapshot -Parent) -Parent
        [IO.File]::AppendAllText((Join-Path $cycle 'verification-report.json'),' ')
        Assert-Cycle ((Get-FakeInventory).validated.Count -eq 0) 'Altered report was trusted.'
        Invoke-GargantuaCycleRetention -ProjectRoot $script:fixture -ManagedRoot (Join-Path $script:fixture 'backups/automatic') -Keep 2|Out-Null
        Assert-Cycle (Test-Path -LiteralPath $cycle) 'Altered evidence was deleted.'
    }
    Test-Cycle 'missing dump truncated book and same-size corruption are ineligible without deleting remaining good copies' {
        foreach($fault in @('missing-dump','truncated-book','same-size-book')){
            New-CycleFixture|Out-Null;$first=Invoke-FakeCycle;$second=Invoke-FakeCycle -Force;$third=Invoke-FakeCycle -Force
            $bad=if($fault -eq 'missing-dump'){Join-Path $third.snapshot 'database.dump'}else{Join-Path $third.snapshot 'books/chapter.txt'}
            if($fault -eq 'missing-dump'){Remove-Item -LiteralPath $bad}
            elseif($fault -eq 'truncated-book'){[IO.File]::WriteAllText($bad,'x')}
            else{$bytes=[IO.File]::ReadAllBytes($bad);$bytes[0]=$bytes[0] -bxor 1;[IO.File]::WriteAllBytes($bad,$bytes)}
            $inventory=Get-FakeInventory
            Assert-Cycle ($inventory.validated.Count -eq 2 -and $inventory.ignored -eq 1) ('Corrupt payload remained eligible: '+$fault)
            $notDue=Invoke-FakeCycle;$state=Read-GargantuaCycleJson (Join-Path $script:fixture '.local/operations/backup-state.json')
            Assert-Cycle ($notDue.status -eq 'not-due' -and $state.lastGood.cycleId -ne $third.cycleId -and $state.lastGood.cycleId -in @($first.cycleId,$second.cycleId)) 'State still advertised a corrupted snapshot as last good.'
            $managed=Join-Path $script:fixture 'backups/automatic';$retention=Invoke-GargantuaCycleRetention -ProjectRoot $script:fixture -ManagedRoot $managed -Keep 2
            Assert-Cycle ($retention.removedCount -eq 0 -and (Test-Path -LiteralPath $first.snapshot) -and (Test-Path -LiteralPath $second.snapshot) -and (Test-Path -LiteralPath $third.snapshot)) 'Corruption justified deleting good or corrupt evidence.'
            # Both remaining usable copies have yesterday's date. A corrupt
            # copy claiming today cannot suppress the replacement daily backup.
            $next=Invoke-FakeCycle -Now ([DateTimeOffset]::Parse('2026-10-24T12:00:00+05:00'))
            Assert-Cycle ($next.status -eq 'validated' -and $script:snapshotCount -eq 4) 'Corrupt latest payload suppressed a replacement.'
        }
    }
    Test-Cycle 'a corrupt sole current-day copy never fulfills daily due' {
        New-CycleFixture|Out-Null;$bad=Invoke-FakeCycle;Remove-Item -LiteralPath (Join-Path $bad.snapshot 'database.dump')
        $replacement=Invoke-FakeCycle
        Assert-Cycle ($replacement.status -eq 'validated' -and $script:snapshotCount -eq 2 -and (Test-Path -LiteralPath $bad.snapshot)) 'Missing current-day dump blocked replacement or was automatically deleted.'
    }
    Test-Cycle 'unknown nested cycle content produces a visible retention error without invalidating new backup' {
        New-CycleFixture|Out-Null;$old=Invoke-FakeCycle;$oldCycle=Split-Path (Split-Path $old.snapshot -Parent) -Parent
        New-Item -ItemType Directory -Path (Join-Path $oldCycle 'personal-notes')|Out-Null
        Invoke-FakeCycle -Force -Keep 2|Out-Null;Invoke-FakeCycle -Force -Keep 2|Out-Null;$r=Invoke-FakeCycle -Force -Keep 2
        Assert-Cycle ($r.status -eq 'validated-with-cleanup-warning' -and @($r.retention.errors).Count -gt 0 -and (Test-Path -LiteralPath $oldCycle) -and (Get-FakeInventory).validated.Count -eq 3) 'Cleanup failure hidden or new validated backup discarded.'
        Invoke-FakeCycle|Out-Null;$state=Read-GargantuaCycleJson (Join-Path $script:fixture '.local/operations/backup-state.json')
        Assert-Cycle $state.retentionWarning.pending 'An expected not-due check erased the outstanding cleanup warning.'
    }
    Test-Cycle 'snapshot persistent leases recover stale GUIDs but reject corruption and concurrency' {
        New-CycleFixture|Out-Null;$path=Join-Path $script:fixture '.local/backup-snapshot.lock';$lease=Open-GargantuaSnapshotLease -Path $path -Token ('a'*32)
        try{Assert-CycleThrows {Open-GargantuaSnapshotLease -Path $path -Token ('b'*32)}}finally{$lease.Dispose()}
        $lease=Open-GargantuaSnapshotLease -Path $path -Token ('b'*32);$lease.Dispose()
        [IO.File]::WriteAllText($path,'unexpected')
        Assert-CycleThrows {Open-GargantuaSnapshotLease -Path $path -Token ('c'*32)}
        Assert-Cycle ((Get-Content -LiteralPath $path -Raw) -eq 'unexpected') 'Invalid old marker was overwritten.'
    }
    Test-Cycle 'stop intent is immutable and captures conservative late RPC deadline before service mutation' {
        New-CycleFixture|Out-Null;$snapshotId=[Guid]::NewGuid().ToString('N');$state=[pscustomobject]@{service='parser';id=('a'*64);exists=$true;running=$true;paused=$false}
        $path=New-GargantuaSnapshotStopIntent -ProjectRoot $script:fixture -SnapshotId $snapshotId -State $state -TimeoutSeconds 30
        $intent=Read-GargantuaCycleJson -Path $path
        Assert-Cycle ($intent.schemaVersion -eq 1 -and $intent.projectRoot -eq $script:fixture -and $intent.containerId -eq $state.id -and $intent.timeoutSeconds -eq 30 -and $intent.rpcTimeoutSeconds -eq 45 -and $intent.graceSeconds -eq 5 -and ($intent.timeoutSeconds+$intent.rpcTimeoutSeconds+$intent.graceSeconds) -eq 80) 'Pending stop deadline omitted delivery/stop lifetime.'
        $before=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
        Assert-CycleThrows {New-GargantuaSnapshotStopIntent -ProjectRoot $script:fixture -SnapshotId $snapshotId -State $state -TimeoutSeconds 30}
        Assert-Cycle ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -eq $before) 'Existing immutable stop intent was replaced.'
    }
    Test-Cycle 'only exact snapshot and container ownership can clear a completed stop intent' {
        New-CycleFixture|Out-Null;$snapshotId=[Guid]::NewGuid().ToString('N');$state=[pscustomobject]@{service='worker';id=('a'*64);exists=$true;running=$true;paused=$false}
        $path=New-GargantuaSnapshotStopIntent -ProjectRoot $script:fixture -SnapshotId $snapshotId -State $state -TimeoutSeconds 120
        $other=[pscustomobject]@{service='worker';id=('b'*64);exists=$true;running=$true;paused=$false}
        Assert-CycleThrows {Remove-GargantuaSnapshotStopIntent -ProjectRoot $script:fixture -SnapshotId $snapshotId -State $other}
        Assert-Cycle (Test-Path -LiteralPath $path) 'Foreign container ownership removed a stop intent.'
        Remove-GargantuaSnapshotStopIntent -ProjectRoot $script:fixture -SnapshotId $snapshotId -State $state
        Assert-Cycle (-not (Test-Path -LiteralPath $path)) 'Confirmed own intent was not cleared.'
    }
    Test-Cycle 'abrupt control-code child exit is captured while parent commits failed cycle state' {
        New-CycleFixture|Out-Null
        $ast=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $project 'scripts/backup-cycle.ps1'),[ref]$null,[ref]$null)
        $definition=@($ast.FindAll({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-GargantuaBackupChild'},$true))
        Assert-Cycle ($definition.Count -eq 1) 'Actual isolated stage launcher is ambiguous.'
        . ([scriptblock]::Create($definition[0].Extent.Text))
        $childPath=Join-Path $script:fixture 'abrupt-child.ps1';[IO.File]::WriteAllText($childPath,'[Environment]::Exit(-1073741510)')
        $r=Invoke-GargantuaBackupCycle -ProjectRoot $script:fixture -Probe {return $true} -ProtectDirectory {param($Path)} -Snapshot {param($Destination) Invoke-GargantuaBackupChild -Script $childPath -ChildArguments @()} -Restore {throw 'Restore must not run after a failed child.'}
        $state=Read-GargantuaCycleJson -Path (Join-Path $script:fixture '.local/operations/backup-state.json')
        Assert-Cycle ($r.status -eq 'failed' -and $state.lastResult.status -eq 'failed' -and $state.lastResult.error -match '1073741510') 'A child control-code exit tore down the parent or left stale success/offline state.'
    }
    Test-Cycle 'reparse and prefix sibling boundaries never allow rotation outside managed root' {
        New-CycleFixture|Out-Null;$outside=Join-Path $root 'outside';New-Item -ItemType Directory -Path $outside -Force|Out-Null;[IO.File]::WriteAllText((Join-Path $outside 'keep.txt'),'keep')
        $managed=Join-Path $script:fixture 'backups/automatic';New-Item -ItemType Directory -Path $managed -Force|Out-Null
        $junction=Join-Path $managed ('cycle-'+[Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Junction -Path $junction -Target $outside|Out-Null
        try{
            Invoke-GargantuaCycleRetention -ProjectRoot $script:fixture -ManagedRoot $managed -Keep 2|Out-Null
            Assert-CycleThrows {Get-GargantuaValidatedCycle -ProjectRoot $script:fixture -ManagedRoot $managed -CyclePath ($managed+'-other/cycle-'+[Guid]::NewGuid().ToString('N'))}
            Assert-Cycle ((Test-Path -LiteralPath (Join-Path $outside 'keep.txt')) -and (Test-Path -LiteralPath $junction)) 'Reparse was traversed/deleted.'
        }finally{Remove-Item -LiteralPath $junction -Force}
    }
    Test-Cycle 'nested reparse in an otherwise validated old backup refuses cleanup' {
        New-CycleFixture|Out-Null;$old=Invoke-FakeCycle;$oldCycle=Split-Path (Split-Path $old.snapshot -Parent) -Parent
        $outside=Join-Path $root 'outside';$junction=Join-Path $old.snapshot 'linked';New-Item -ItemType Junction -Path $junction -Target $outside|Out-Null
        try{1..3|ForEach-Object {$r=Invoke-FakeCycle -Force -Keep 2};Assert-Cycle ($r.status -eq 'validated' -and $r.retention.ignored -ge 1 -and (Test-Path -LiteralPath $oldCycle) -and (Test-Path -LiteralPath (Join-Path $outside 'keep.txt'))) 'Nested link was qualified, traversed or deleted.'}finally{Remove-Item -LiteralPath $junction -Force}
    }
    Test-Cycle 'killed snapshot journal restores only exact same worker and parser IDs once' {
        New-CycleFixture|Out-Null;$interrupted=New-InterruptedJournal;$count=Restore-FakeInterrupted
        Assert-Cycle ($count -eq 1 -and $script:recovered.Count -eq 2 -and (Get-FakeInventory).validated.Count -eq 0) 'Interrupted handlers not recovered safely.'
        Assert-Cycle ((Restore-FakeInterrupted) -eq 0) 'Recovery journal applied twice.'
    }
    Test-Cycle 'recreated container or explicit manual stop blocks interrupted recovery before any mutation' {
        New-CycleFixture|Out-Null;New-InterruptedJournal|Out-Null
        Assert-CycleThrows {Restore-FakeInterrupted -Mismatch};Assert-Cycle ($script:recovered.Count -eq 0) 'Changed container partially restored.'
        $ops=Join-Path $script:fixture '.local/operations';Write-GargantuaJson -Path (Join-Path $ops 'manual-stop.json') -Value @{stopped=$true}
        Assert-CycleThrows {Restore-FakeInterrupted};Assert-Cycle ($script:recovered.Count -eq 0) 'Manual stop was overridden.'
    }
    Test-Cycle 'state history stays bounded despite many skipped checks' {
        New-CycleFixture|Out-Null;1..55|ForEach-Object {Invoke-FakeCycle -Probe {return $false}|Out-Null}
        $path=Join-Path $script:fixture '.local/operations/backup-state.json';$state=Read-GargantuaCycleJson $path
        Assert-Cycle ($state.history.Count -eq 40 -and (Get-Item -LiteralPath $path).Length -lt 64KB) 'State history grew unbounded.'
    }
    Test-Cycle 'all changed lifecycle sources parse offline' {
        foreach($name in @('scripts/backup-cycle.ps1','scripts/backup-cycle-common.ps1','scripts/backup-cycle-lock.ps1','scripts/backup.ps1','tests/backup-cycle.test.ps1')){
            $tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $project $name),[ref]$tokens,[ref]$errors)|Out-Null
            Assert-Cycle (@($errors).Count -eq 0) ('Parse failure: '+$name)
        }
    }
}catch{$cases.Add(@{name='test harness';status='FAIL';error=$_.Exception.Message});Write-Host ('FAIL harness: '+$_.Exception.Message)}
finally{
    if(Test-Path -LiteralPath $root){
        $owner=Read-GargantuaCycleJson -Path (Join-Path $root 'test-owner.json')
        if($owner.token -ne $token -or $owner.root -ne $root -or -not (Test-GargantuaPathWithin -Root $base -Target $root)){throw 'Owned fixture cleanup boundary differs.'}
        Assert-GargantuaCycleTree -Root $root
        Remove-Item -LiteralPath $root -Recurse -Force
    }
}
$failed=@($cases|Where-Object status -eq 'FAIL');$report=Join-Path $base 'backup-cycle-offline.json'
Write-GargantuaJson -Path $report -Value @{createdAt=[DateTimeOffset]::UtcNow.ToString('o');scope='Offline injected faults only; no production backup or Docker invoked';passed=$cases.Count-$failed.Count;failed=$failed.Count;cases=$cases.ToArray()}
Write-Host ('Backup cycle checks: '+($cases.Count-$failed.Count)+' passed; '+$failed.Count+' failed.')
if($failed.Count){exit 1};exit 0
