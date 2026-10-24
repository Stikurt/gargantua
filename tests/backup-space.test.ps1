<# Offline only. Synthetic estimates, source files and entrypoint mocks.
No Docker/WSL, production lock, production snapshot or handler is touched. #>
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
. (Join-Path $project 'scripts/backup-common.ps1')
. (Join-Path $project 'scripts/backup-space.ps1')
. (Join-Path $project 'scripts/startup-common.ps1')
. (Join-Path $project 'scripts/backup-cycle-lock.ps1')
$cases=[Collections.Generic.List[object]]::new()
function Assert-SpaceTest([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message}}
function Test-SpaceCase([string]$Name,[scriptblock]$Body){try{& $Body;$cases.Add(@{name=$Name;status='PASS'});Write-Host "PASS $Name"}catch{$cases.Add(@{name=$Name;status='FAIL';error=$_.Exception.Message});Write-Host "FAIL $Name`: $($_.Exception.Message)"}}
function Assert-SpaceRejected([scriptblock]$Body){$failed=$false;try{& $Body|Out-Null}catch{$failed=$true};Assert-SpaceTest $failed 'Unknown or insufficient capacity was admitted'}
function New-SizeEstimate {return [pscustomobject]@{databaseBytes=100MB;libraryBytes=200MB;sourceArchiveBytes=10MB;runtimeImageBytes=0L}}
function New-SameVolumes([long]$Free=20GB){return @(@{role='destination';diskId='C';freeBytes=$Free},@{role='workspace';diskId='c';freeBytes=$Free},@{role='docker';diskId='C';freeBytes=$Free})}
$token=[Guid]::NewGuid().ToString('N')
$allowed=[IO.Path]::GetFullPath((Join-Path $project '.local/test-results'))
$root=Join-Path $allowed ('backup-space-'+$token);$fixtures=Join-Path $root 'fixtures';$owned=$false
try{
    if(-not $root.StartsWith($allowed+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $root)){throw 'Invalid new test root'}
    New-Item -ItemType Directory -Path $fixtures -Force|Out-Null
    Write-GargantuaJson -Path (Join-Path $root 'test-owner.json') -Value @{token=$token;root=$root};$owned=$true
    Test-SpaceCase 'same volume aggregates destination workspace and staging once' {
        $result=Get-GargantuaBackupSpaceDecision -Estimates (New-SizeEstimate) -Volumes (New-SameVolumes)
        Assert-SpaceTest ($result.volumes.Count -eq 1 -and $result.volumes[0].roles.Count -eq 3) 'Shared volume did not aggregate'
        $expected=2GB+$result.snapshotBoundBytes+64MB+$result.databaseStagingBoundBytes
        Assert-SpaceTest ($result.volumes[0].requiredBytes -eq $expected) 'Shared budget omitted a simultaneous allocation or double-counted reserve'
        Assert-SpaceTest ($result.databaseStagingBoundBytes -ge (1GB+200MB)) 'Ranobe/derivative metadata, checkpoint and core sidecar staging slack was omitted'
    }
    Test-SpaceCase 'separate volumes require independent reserves and budgets' {
        $volumes=New-SameVolumes;$volumes[1].diskId='D';$volumes[2].diskId='E'
        $result=Get-GargantuaBackupSpaceDecision -Estimates (New-SizeEstimate) -Volumes $volumes
        Assert-SpaceTest ($result.volumes.Count -eq 3) 'Separate storage was conflated'
        foreach($volume in $result.volumes){Assert-SpaceTest ($volume.requiredBytes -gt 2GB) 'A location has no reserve/allocation'}
        $volumes[2].freeBytes=2GB
        Assert-SpaceRejected {Get-GargantuaBackupSpaceDecision -Estimates (New-SizeEstimate) -Volumes $volumes}
    }
    Test-SpaceCase 'one free-space number cannot fund three independent checks on same disk' {
        $result=Get-GargantuaBackupSpaceDecision -Estimates (New-SizeEstimate) -Volumes (New-SameVolumes)
        Assert-SpaceRejected {Get-GargantuaBackupSpaceDecision -Estimates (New-SizeEstimate) -Volumes (New-SameVolumes ($result.volumes[0].requiredBytes-1))}
        $equal=Get-GargantuaBackupSpaceDecision -Estimates (New-SizeEstimate) -Volumes (New-SameVolumes $result.volumes[0].requiredBytes)
        Assert-SpaceTest $equal.volumes[0].sufficient 'Exact conservative bound was rejected'
    }
    Test-SpaceCase 'unknown malformed nonfinite negative fractional and overflowing estimates deny' {
        foreach($bad in @($null,'100',-1,0.5,[double]::NaN,[double]::PositiveInfinity,[decimal]9007199254740992)){
            $estimate=New-SizeEstimate;$estimate.databaseBytes=$bad
            Assert-SpaceRejected {Get-GargantuaBackupSpaceDecision -Estimates $estimate -Volumes (New-SameVolumes)}
        }
    }
    Test-SpaceCase 'missing location identity metric and conflicting readings fail conservatively' {
        Assert-SpaceRejected {Get-GargantuaBackupSpaceDecision -Estimates (New-SizeEstimate) -Volumes @((New-SameVolumes)[0])}
        $volumes=New-SameVolumes;$volumes[1].diskId='';Assert-SpaceRejected {Get-GargantuaBackupSpaceDecision -Estimates (New-SizeEstimate) -Volumes $volumes}
        $volumes=New-SameVolumes;$volumes[1].freeBytes=$null;Assert-SpaceRejected {Get-GargantuaBackupSpaceDecision -Estimates (New-SizeEstimate) -Volumes $volumes}
        $volumes=New-SameVolumes;$volumes[1].freeBytes=1GB;Assert-SpaceRejected {Get-GargantuaBackupSpaceDecision -Estimates (New-SizeEstimate) -Volumes $volumes}
    }
    Test-SpaceCase 'image archive allocation is conditional and includes conservative tar slack' {
        $estimate=New-SizeEstimate;$before=Get-GargantuaBackupSpaceDecision -Estimates $estimate -Volumes (New-SameVolumes)
        $estimate.runtimeImageBytes=1GB;$after=Get-GargantuaBackupSpaceDecision -Estimates $estimate -Volumes (New-SameVolumes)
        Assert-SpaceTest (($after.snapshotBoundBytes-$before.snapshotBoundBytes) -eq (2GB+64MB)) 'Runtime archive bound differs'
    }
    Test-SpaceCase 'duplicate VHDX paths on the same volume never double count a staging role' {
        $volumes=New-SameVolumes;$volumes+=@{role='docker';diskId='c';freeBytes=19GB}
        $result=Get-GargantuaBackupSpaceDecision -Estimates (New-SizeEstimate) -Volumes $volumes
        Assert-SpaceTest ($result.volumes.Count -eq 1 -and $result.volumes[0].roles.Count -eq 3 -and $result.volumes[0].freeBytes -eq 19GB) 'Shared VHDX metric did not use the minimum without duplicating allocations'
    }
    Test-SpaceCase 'source estimate and archive use the same bounded selection without build secrets' {
        $source=Join-Path $fixtures 'source';New-Item -ItemType Directory -Path (Join-Path $source 'server'),(Join-Path $source 'android/node_modules'),(Join-Path $source 'scripts') -Force|Out-Null
        [IO.File]::WriteAllText((Join-Path $source 'compose.yaml'),'services: {}')
        [IO.File]::WriteAllText((Join-Path $source 'package.json'),'{}')
        [IO.File]::WriteAllText((Join-Path $source 'server/db.mjs'),'// synthetic Unicode Гаргантюа')
        [IO.File]::WriteAllText((Join-Path $source 'android/node_modules/private.txt'),'excluded')
        [IO.File]::WriteAllText((Join-Path $source 'scripts/.env'),'excluded')
        $estimate=Invoke-GargantuaPython -Operation 'offline synthetic source size' -Arguments @('source-estimate','--project',$source)|ConvertFrom-Json
        $archive=Join-Path $fixtures 'source.tar.gz';Invoke-GargantuaPython -Operation 'offline synthetic source archive' -Arguments @('source','--project',$source,'--output',$archive)|Out-Null
        Assert-SpaceTest ($estimate.files -eq 3 -and $estimate.archiveBoundBytes -ge (Get-Item -LiteralPath $archive).Length) 'Source selection or archive bound differs'
        Remove-Item -LiteralPath (Join-Path $source 'server/db.mjs')
        Assert-SpaceRejected {Invoke-GargantuaPython -Operation 'offline missing required source' -Arguments @('source-estimate','--project',$source)}
    }
    Test-SpaceCase 'reader journal exact preflight precedes all remaining read-only estimates' {
        $script:readerProbe='{"supported":true,"rows":10,"bytes":4096,"maxRows":250000,"maxBytes":100663296}'
        $script:probeOperations=[Collections.Generic.List[string]]::new()
        function Invoke-GargantuaPython {param($Operation,$Arguments);if($Arguments[0] -eq 'reader-preflight-sql'){return 'SYNTHETIC READ-ONLY SQL'};if($Arguments[0] -eq 'source-estimate'){return '{"archiveBoundBytes":100}'};throw 'Unexpected probe command'}
        function Invoke-GargantuaDocker {param($Operation,$Arguments,$InputText,$TimeoutSeconds);$script:probeOperations.Add($Operation);switch($Operation){
            'verify exact reader journal budget before snapshot' {Assert-SpaceTest ($InputText -eq 'SYNTHETIC READ-ONLY SQL' -and $TimeoutSeconds -eq 60) 'Exact probe transport/deadline differs';return $script:readerProbe}
            'estimate database physical relations read-only' {return '1000'}
            'estimate published regular files read-only' {return '{"bytes":200,"files":1}'}
            default {throw 'Unexpected Docker probe'}
        }}
        $estimate=Get-GargantuaBackupEstimates -Database @{id='synthetic-db'} -App @{exists=$true;running=$true;paused=$false;id='synthetic-app'} -Handlers @()
        Assert-SpaceTest ($script:probeOperations[0] -eq 'verify exact reader journal budget before snapshot' -and $estimate.readerJournal.bytes -eq 4096) 'Journal admission was omitted or occurred after remaining probes'
    }
    Test-SpaceCase 'unknown malformed or oversized journal preflight denies without later probes' {
        function Invoke-GargantuaPython {param($Operation,$Arguments);return 'SYNTHETIC READ-ONLY SQL'}
        function Invoke-GargantuaDocker {param($Operation,$Arguments,$InputText,$TimeoutSeconds);$script:probeCount++;if($Operation -ne 'verify exact reader journal budget before snapshot'){throw 'Later probe after denied journal'};return $script:readerProbe}
        foreach($bad in @('{}','not-json','{"supported":"yes"}','{"supported":true,"rows":250001,"bytes":10,"maxRows":250000,"maxBytes":100663296}','{"supported":true,"rows":1,"bytes":100663297,"maxRows":250000,"maxBytes":100663296}','{"supported":true,"rows":1,"bytes":10,"maxRows":500000,"maxBytes":100663296}')){
            $script:probeCount=0;$script:readerProbe=$bad
            Assert-SpaceRejected {Get-GargantuaBackupEstimates -Database @{id='synthetic-db'} -App @{exists=$true;running=$true;paused=$false;id='synthetic-app'} -Handlers @()}
            Assert-SpaceTest ($script:probeCount -eq 1) 'Denied journal caused a subsequent operation'
        }
    }
    Test-SpaceCase 'capacity refusal in actual entrypoint creates no snapshot and never restores or stops handlers' {
        # Execute the actual entrypoint body with only its helper imports removed.
        # Every service/storage probe is a local fake, and its project/lock is owned.
        $script:GargantuaProjectRoot=Join-Path $fixtures 'entrypoint';New-Item -ItemType Directory -Path $script:GargantuaProjectRoot|Out-Null
        $script:mutations=0;$script:estimated=$false;$script:volumeProbes=0
        function Get-GargantuaService {param($Service);return [pscustomobject]@{service=$Service;id=('a'*64);exists=$true;running=$true;paused=($Service -eq 'parser');status='running'}}
        function Get-GargantuaBackupEstimates {param($Database,$App,$Handlers,[switch]$IncludeRuntimeImages);$script:estimated=$true;return New-SizeEstimate}
        function Get-GargantuaDockerStorage {return [pscustomobject]@{known=$true;paths=@('synthetic-vhdx')}}
        function Get-GargantuaBackupVolume {param($Path,$Role);$script:volumeProbes++;return @{role=$Role;diskId='synthetic';freeBytes=1GB}}
        function Invoke-GargantuaDocker {$script:mutations++;throw 'Forbidden Docker command in offline test'}
        function Restore-GargantuaHandler {$script:mutations++;throw 'Forbidden restore after preflight refusal'}
        function Set-GargantuaPrivateDirectory {param($Path);if($Path -ne (Join-Path $script:GargantuaProjectRoot '.local/operations')){$script:mutations++;throw 'Forbidden snapshot creation before preflight'}}
        $text=Get-Content -LiteralPath (Join-Path $project 'scripts/backup.ps1') -Raw
        $entrypointText=[regex]::Replace($text,'(?m)^\. \(Join-Path \$PSScriptRoot ''(?:backup-common|backup-space|backup-inference|resource-monitor-io|startup-common|backup-cycle-lock|lifecycle-stop-guard)\.ps1''\)\r?$','')
        $destination=Join-Path $script:GargantuaProjectRoot 'backups'
        Assert-SpaceRejected {& ([scriptblock]::Create($entrypointText)) -DestinationRoot $destination}
        $lease=Open-GargantuaSnapshotLease -Path (Join-Path $script:GargantuaProjectRoot '.local/backup-snapshot.lock') -Token ([Guid]::NewGuid().ToString('N'));$lease.Dispose()
        Assert-SpaceTest ($script:estimated -and $script:volumeProbes -eq 3 -and $script:mutations -eq 0 -and -not (Test-Path -LiteralPath $destination)) 'Preflight not reached, mutated handlers, left held lock, or created a snapshot'
        $script:GargantuaProjectRoot=$project
    }
    Test-SpaceCase 'modified PowerShell and Python sources parse offline' {
        foreach($name in @('scripts/backup.ps1','scripts/backup-space.ps1','tests/backup-space.test.ps1')){$tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $project $name),[ref]$tokens,[ref]$errors)|Out-Null;Assert-SpaceTest (@($errors).Count -eq 0) ('Parse failed: '+$name)}
        $runtime=Get-GargantuaPython
        Invoke-GargantuaNative -Operation 'offline Python AST parse' -Command $runtime.command -Arguments (@($runtime.prefix)+@('-B','-c','import ast,pathlib,sys; ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))',(Join-Path $project 'scripts/backup-artifacts.py')))|Out-Null
    }
}catch{$cases.Add(@{name='harness';status='FAIL';error=$_.Exception.Message});Write-Host $_.Exception.Message}
finally{
    if($owned){
        try{$marker=Get-Content -LiteralPath (Join-Path $root 'test-owner.json') -Raw|ConvertFrom-Json;if($marker.token -ne $token -or $marker.root -ne $root -or -not $fixtures.StartsWith($root+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Cleanup ownership mismatch'};Assert-GargantuaNoReparseAncestors -Path $fixtures;if(@(Get-ChildItem -LiteralPath $fixtures -Recurse -Force|Where-Object{$_.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)}).Count){throw 'Nested reparse point; cleanup refused'};Remove-Item -LiteralPath $fixtures -Recurse -Force -ErrorAction Stop}catch{$cases.Add(@{name='owned-cleanup';status='FAIL';error=$_.Exception.Message})}
        $failed=@($cases.ToArray()|Where-Object status -eq 'FAIL')
        Write-GargantuaJson -Path (Join-Path $root 'report.json') -Value @{status=$(if($failed.Count){'FAIL'}else{'PASS'});cases=$cases.ToArray();passed=$cases.Count-$failed.Count;failed=$failed.Count;dockerCommands=$false;productionSnapshotStarted=$false;productionHandlersChanged=$false}
    }
}
$failed=@($cases.ToArray()|Where-Object status -eq 'FAIL')
Write-Host ("Backup space offline checks: {0} passed, {1} failed. Report: {2}" -f ($cases.Count-$failed.Count),$failed.Count,(Join-Path $root 'report.json'))
if($failed.Count){exit 1};exit 0
