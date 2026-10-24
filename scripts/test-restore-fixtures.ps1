<#
.SYNOPSIS
Opt-in synthetic end-to-end snapshot/restore fixture. Never addresses production Compose.
.DESCRIPTION
Without -Execute this prints NOT_RUN. An executed run uses only local image IDs,
new GUID-labelled containers/volumes, no published ports, and no external network.
The only host writes are in a new .local/test-results/restore-fixtures-* directory.
The candidate app image must contain migrations 003/004/005/006/007. It runs migrations
and seed insertion, never app/worker/parser. Discovery/Ranobe queues remain inert.
The existing verify-backup.ps1 performs the actual separate restore and recovery hold.
Docker resources are removed only after exact ownership-label checks. Synthetic
snapshot, SQL, files, assertions and reports remain on the host for review.
.EXAMPLE
./scripts/test-restore-fixtures.ps1 -Execute -AppImage cotology-app:core-next
#>
[CmdletBinding()]
param([switch]$Execute,[string]$AppImage='cotology-app:core-next',[string]$PostgresImage='postgres:17-bookworm')
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'backup-common.ps1')
if (-not $Execute) { Write-Host 'NOT_RUN: synthetic fixture is opt-in. Review this script, then use -Execute. No Docker command was issued.'; return }

$runId=[Guid]::NewGuid().ToString('N')
$prefix='gargantua-test-restore-'+$runId
$labelKey='gargantua.test.restore'
$label=$labelKey+'='+$runId
$root=Get-GargantuaFullPath (Join-Path $script:GargantuaProjectRoot ('.local/test-results/restore-fixtures-'+$runId))
$allowed=Get-GargantuaFullPath (Join-Path $script:GargantuaProjectRoot '.local/test-results')
$seed=Join-Path $root 'seed'; $snapshot=Join-Path $root 'snapshot'; $restore=Join-Path $root 'restored'; $post=Join-Path $root 'post-hold'
$sourceName=$prefix+'-db'; $clientName=$prefix+'-migrate'; $readName=$prefix+'-read'
$dbVolume=$prefix+'-database'; $libraryVolume=$prefix+'-library'
$resources=[Collections.Generic.List[object]]::new()
$cleanupErrors=[Collections.Generic.List[string]]::new()
$failure=$null; $before=$null; $after=$null; $verifyReport=$null; $publicationRead=$null; $rootOwned=$false
$timer=[Diagnostics.Stopwatch]::StartNew()

function Invoke-FixturePython {
    param([string]$Operation,[string[]]$Arguments)
    $python=Get-GargantuaPython
    Invoke-GargantuaNative -Operation $Operation -Command $python.command -Arguments (@($python.prefix)+@((Join-Path $script:GargantuaProjectRoot 'tests/fixtures/restore-fixture.py'))+@($Arguments))
}
function Add-FixtureResource {
    param([string]$Kind,[string]$Name,[string]$Key=$labelKey,[string]$Token=$runId)
    if (-not ($resources | Where-Object { $_.kind -eq $Kind -and $_.name -eq $Name })) { $resources.Add([pscustomobject]@{kind=$Kind;name=$Name;key=$Key;token=$Token}) }
}
function Assert-FixtureResource {
    param([Parameter(Mandatory)]$Resource)
    if ($Resource.key -eq $labelKey) {
        if (-not $Resource.name.StartsWith($prefix+'-',[StringComparison]::Ordinal) -or $Resource.token -ne $runId) { throw 'Synthetic resource name/token mismatch.' }
    } elseif ($Resource.key -eq 'gargantua.verify-token') {
        if ($Resource.token -notmatch '^[a-f0-9]{32}$' -or $Resource.name -ne ('gargantua-restore-check-'+$Resource.token)) { throw 'Unexpected nested verification resource.' }
    } else { throw 'Unapproved fixture ownership label.' }
    $format=if($Resource.kind -eq 'container'){'{{index .Config.Labels "'+$Resource.key+'"}}'}else{'{{index .Labels "'+$Resource.key+'"}}'}
    $value=(Invoke-GargantuaDocker -Operation ('confirm synthetic '+$Resource.kind+' ownership') -Arguments @($Resource.kind,'inspect','--format',$format,$Resource.name)).Trim()
    if($value -ne $Resource.token){throw 'Synthetic Docker ownership mismatch; mutation refused.'}
}
function Receive-FixtureFile {
    param([string]$Container,[string]$Remote,[string]$Destination,[int]$Limit=33554432)
    $encoded=Invoke-GargantuaDocker -Operation 'read only synthetic fixture bytes' -Arguments @('exec',$Container,'base64','--wrap=0',$Remote)
    Write-GargantuaBase64File -Path $Destination -Encoded $encoded -MaxBytes $Limit
}
function Write-FixtureState {
    param([string]$Container,[string]$User,[string]$Database,[string]$Remote,[string]$Destination)
    $state=Get-Content -LiteralPath (Join-Path $seed 'state.sql') -Raw -Encoding UTF8
    $query='\o '+$Remote+"`n"+$state+"`n\o`n"
    Invoke-GargantuaDocker -Operation 'inspect only synthetic table state' -Arguments @('exec','-i',$Container,'psql','-q','-X','-U',$User,'-d',$Database,'-v','ON_ERROR_STOP=1','-A','-t') -InputText $query | Out-Null
    Receive-FixtureFile -Container $Container -Remote $Remote -Destination $Destination
}
function Register-NestedRestore {
    $marker=Join-Path $restore 'restore-owner.json'
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) { return }
    $owner=Get-Content -LiteralPath $marker -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($owner.root -ne $restore -or $owner.token -notmatch '^[a-f0-9]{32}$' -or $owner.container -ne ('gargantua-restore-check-'+$owner.token)) { throw 'Nested restore ownership record differs; cleanup refused.' }
    Add-FixtureResource -Kind 'container' -Name $owner.container -Key 'gargantua.verify-token' -Token $owner.token
}

try {
    if (-not (Test-GargantuaPathWithin -Root $allowed -Target $root) -or $root -eq $allowed) { throw 'Synthetic report root escaped .local/test-results.' }
    Assert-GargantuaNoReparseAncestors -Path $root
    if (Test-Path -LiteralPath $root) { throw 'Synthetic run root already exists.' }
    foreach($path in @($root,$script:GargantuaProjectRoot)){if($path.Contains(',')){throw 'Fixture bind paths cannot contain Docker mount delimiters.'}}
    New-Item -ItemType Directory -Path $root -Force | Out-Null
    Set-GargantuaPrivateDirectory -Path $root
    Write-GargantuaJson -Path (Join-Path $root 'fixture-owner.json') -Value @{version=1;runId=$runId;root=$root;synthetic=$true}
    $rootOwned=$true
    foreach($path in @($seed,$snapshot,$post)){New-Item -ItemType Directory -Path $path | Out-Null}
    Write-GargantuaJson -Path (Join-Path $root 'report.json') -Value @{status='RUNNING';synthetic=$true;runId=$runId;productionDataUsed=$false}
    Invoke-FixturePython -Operation 'build only synthetic restore data' -Arguments @('build','--root',$seed) | Out-Null
    $expected=Get-Content -LiteralPath (Join-Path $seed 'expected.json') -Raw -Encoding UTF8 | ConvertFrom-Json

    $ids=@{}
    foreach($image in @($PostgresImage,$AppImage)){
        if($image -notmatch '^[a-zA-Z0-9][a-zA-Z0-9./_:@-]{0,200}$'){throw 'Invalid trusted local fixture image reference.'}
        $imageId=(Invoke-GargantuaDocker -Operation 'require a local fixture image; never pull' -Arguments @('image','inspect','--format','{{.Id}}',$image)).Trim()
        if($imageId -notmatch '^sha256:[a-f0-9]{64}$'){throw 'Fixture image ID is unavailable.'}
        $declared=Invoke-GargantuaDocker -Operation 'reject unexpected anonymous image volumes' -Arguments @('image','inspect','--format','{{json .Config.Volumes}}',$imageId)
        if($declared -and $declared.Trim() -ne 'null'){
            foreach($name in ($declared|ConvertFrom-Json).PSObject.Properties.Name){if($image -ne $PostgresImage -or $name -ne '/var/lib/postgresql/data'){throw 'Unexpected image-declared fixture volume.'}}
        }
        $ids[$image]=$imageId
    }
    foreach($volume in @($dbVolume,$libraryVolume)){
        Add-FixtureResource -Kind 'volume' -Name $volume
        Invoke-GargantuaDocker -Operation 'create a new labelled synthetic volume' -Arguments @('volume','create','--label',$label,$volume) | Out-Null
        Assert-FixtureResource ($resources | Where-Object { $_.name -eq $volume } | Select-Object -First 1)
    }
    $password=[Guid]::NewGuid().ToString('N')
    Add-FixtureResource -Kind 'container' -Name $sourceName
    $create=@('create','--pull','never','--name',$sourceName,'--label',$label,'--network','none','--read-only','--security-opt','no-new-privileges:true',
        '--cap-drop','ALL','--cap-add','CHOWN','--cap-add','FOWNER','--cap-add','DAC_OVERRIDE','--cap-add','SETUID','--cap-add','SETGID',
        '--memory','512m','--cpus','1','--pids-limit','128','--shm-size','128m','--tmpfs','/tmp:rw,size=128m,mode=1777','--tmpfs','/var/run/postgresql:rw,size=16m,mode=3775',
        '--mount',('type=volume,source='+$dbVolume+',target=/var/lib/postgresql/data'),'--mount',('type=volume,source='+$libraryVolume+',target=/fixture-library'),
        '--mount',('type=bind,source='+$seed+',target=/fixture-seed,readonly'),'--env','PGDATA=/var/lib/postgresql/data/pgdata','--env','POSTGRES_USER=cotology_app',
        '--env',('POSTGRES_PASSWORD='+$password),'--env',('PGPASSWORD='+$password),'--env','POSTGRES_DB=library',$ids[$PostgresImage])
    Invoke-GargantuaDocker -Operation 'create new isolated fixture PostgreSQL' -Arguments $create | Out-Null
    Assert-FixtureResource ($resources | Where-Object { $_.name -eq $sourceName } | Select-Object -First 1)
    Invoke-GargantuaDocker -Operation 'start only synthetic source PostgreSQL' -Arguments @('start',$sourceName) | Out-Null
    $ready=$false
    for($i=0;$i -lt 60;$i++){
        try{$probe=Invoke-GargantuaDocker -Operation 'wait for final synthetic PostgreSQL' -Arguments @('exec',$sourceName,'psql','-h','127.0.0.1','-X','-U','cotology_app','-d','library','-q','-A','-t','-v','ON_ERROR_STOP=1','-c','SELECT 1;');if($probe.Trim() -eq '1'){$ready=$true;break}}catch{Start-Sleep -Seconds 1}
    }
    if(-not $ready){throw 'Synthetic source PostgreSQL did not become ready.'}
    Add-FixtureResource -Kind 'container' -Name $clientName
    $clientFile=Join-Path $script:GargantuaProjectRoot 'tests/fixtures/restore-fixture-client.mjs'
    $client=@('create','--pull','never','--name',$clientName,'--label',$label,'--network',('container:'+$sourceName),'--read-only','--user','1000:1000',
        '--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','384m','--cpus','1','--pids-limit','64','--tmpfs','/tmp:rw,nosuid,noexec,size=32m,mode=1777',
        '--mount',('type=bind,source='+$seed+',target=/fixture-seed,readonly'),'--mount',('type=bind,source='+$clientFile+',target=/fixture-client.mjs,readonly'),
        '--env','GARGANTUA_RESTORE_FIXTURE=1','--env',('DATABASE_URL=postgres://cotology_app:'+$password+'@127.0.0.1:5432/library'),$ids[$AppImage],'node','/fixture-client.mjs')
    Invoke-GargantuaDocker -Operation 'create migration-only candidate client in isolated PG namespace' -Arguments $client | Out-Null
    Assert-FixtureResource ($resources | Where-Object { $_.name -eq $clientName } | Select-Object -First 1)
    Invoke-GargantuaDocker -Operation 'start only candidate migrations and synthetic seeding' -Arguments @('start',$clientName) | Out-Null
    $clientDone=$false
    for($i=0;$i -lt 90;$i++){
        $state=(Invoke-GargantuaDocker -Operation 'read synthetic migration-client exit' -Arguments @('inspect','--format','{{json .State}}',$clientName))|ConvertFrom-Json
        if($state.Status -eq 'exited'){$clientDone=$true;if($state.ExitCode -ne 0){throw 'Candidate migration/fixture insertion failed; inspect retained synthetic logs.'};break}
        if($state.Dead){throw 'Synthetic migration client became dead.'};Start-Sleep -Seconds 1
    }
    if(-not $clientDone){throw 'Synthetic migration client exceeded its bounded runtime.'}
    Invoke-GargantuaDocker -Operation 'copy only synthetic seed files into its new library volume' -Arguments @('exec',$sourceName,'sh','-c','set -eu; test -z "$(ls -A /fixture-library)"; cp -R /fixture-seed/books /fixture-library/books') | Out-Null

    $remote='/tmp/gargantua-snapshot-'+$runId
    Invoke-GargantuaDocker -Operation 'create synthetic snapshot staging' -Arguments @('exec',$sourceName,'mkdir','-m','700',$remote) | Out-Null
    $queryPath=Join-Path $snapshot 'snapshot-inventory.sql'
    Invoke-GargantuaPython -Operation 'prepare existing exported-snapshot protocol' -Arguments @('inventory-sql','--remote',$remote,'--snapshot','--output',$queryPath) | Out-Null
    Invoke-GargantuaDocker -Operation 'capture synthetic dump and fingerprints in the same snapshot' -Arguments @('exec','-i',$sourceName,'psql','-X','-U','cotology_app','-d','library','-v','ON_ERROR_STOP=1') -InputText (Get-Content -LiteralPath $queryPath -Raw -Encoding UTF8) | Out-Null
    foreach($file in @('database.dump','db-inventory.json','db-table-fingerprints.jsonl','ranobe-checkpoints.jsonl','ranobe-metadata.jsonl')){Receive-FixtureFile -Container $sourceName -Remote ($remote+'/'+$file) -Destination (Join-Path $snapshot $file) -Limit 67108864}
    $captured=Get-Content -LiteralPath (Join-Path $snapshot 'db-inventory.json') -Raw -Encoding UTF8|ConvertFrom-Json
    if($captured.ranobeMetadataFormat -ne 'source-jsonl-v1' -or (Get-Item -LiteralPath (Join-Path $snapshot 'db-inventory.json')).Length -gt 32MB){throw 'Synthetic snapshot did not use the bounded source-only metadata protocol.'}
    $captured=$null
    Write-FixtureState -Container $sourceName -User 'cotology_app' -Database 'library' -Remote ($remote+'/fixture-state.json') -Destination (Join-Path $snapshot 'fixture-state.json')
    $expectedPaths=[Collections.Generic.List[string]]::new()
    foreach($book in $expected.books){foreach($file in $book.artifact_manifest.files){$expectedPaths.Add($book.id+'/'+$file.path)}}
    $remoteFiles=Invoke-GargantuaDocker -Operation 'check synthetic library inventory' -Arguments @('exec',$sourceName,'find','/fixture-library/books','-type','f','-printf','%P\n')
    $actualPaths=@($remoteFiles -split '\r?\n'|Where-Object{$_}|Sort-Object)
    if(($actualPaths -join '|') -ne (($expectedPaths.ToArray()|Sort-Object)-join '|')){throw 'Synthetic library volume contains unexpected or missing resources.'}
    foreach($book in $expected.books){
        $folder=Join-Path $snapshot ('books/'+$book.id);New-Item -ItemType Directory -Path $folder -Force | Out-Null
        foreach($file in $book.artifact_manifest.files){Receive-FixtureFile -Container $sourceName -Remote ('/fixture-library/books/'+$book.id+'/'+$file.path) -Destination (Join-Path $folder $file.path)}
    }
    Invoke-GargantuaPython -Operation 'capture current source without runtime data or secrets' -Arguments @('source','--project',$script:GargantuaProjectRoot,'--output',(Join-Path $snapshot 'source.tar.gz')) | Out-Null
    Write-GargantuaJson -Path (Join-Path $snapshot 'snapshot-metadata.json') -Value @{version=2;snapshotId=$runId;snapshotProtocol='pg-exported-repeatable-read';handlers=@();handlersRestored=$true;
        sourceDatabaseImage=$ids[$PostgresImage];sourceContainerImages=@{migrationClient=$ids[$AppImage]};runtimeImagesIncluded=$false;sessionRowsExcluded=$true;synthetic=$true;
        note='No processing handlers were created. Candidate migration client exited before the snapshot. Current workspace source is captured separately from pinned runtime image IDs.'}
    Write-GargantuaJson -Path (Join-Path $snapshot 'operations.json') -Value $script:GargantuaOperations.ToArray()
    Invoke-GargantuaPython -Operation 'validate and finalize only synthetic snapshot' -Arguments @('finalize','--backup',$snapshot) | Out-Null
    & (Join-Path $PSScriptRoot 'verify-backup.ps1') -Path $snapshot -RestoreRoot $restore -PostgresImage $ids[$PostgresImage] -ReportPath (Join-Path $root 'verification-report.json')
    Register-NestedRestore
    $verifyReport=Get-Content -LiteralPath (Join-Path $root 'verification-report.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if($verifyReport.status -ne 'validated'){throw 'Existing verifier did not report a validated synthetic restore.'}
    Invoke-FixturePython -Operation 'assert all synthetic rows survived before recovery hold' -Arguments @('assert-before','--seed',$seed,'--snapshot',$snapshot,'--restored',$restore,'--source-state',(Join-Path $snapshot 'fixture-state.json'),'--report',(Join-Path $root 'assert-before.json')) | Out-Null
    $before=Get-Content -LiteralPath (Join-Path $root 'assert-before.json') -Raw -Encoding UTF8|ConvertFrom-Json

    $restoredResource=$resources|Where-Object{$_.key -eq 'gargantua.verify-token'}|Select-Object -First 1
    Assert-FixtureResource $restoredResource
    Invoke-GargantuaDocker -Operation 'start only retained synthetic recovery PostgreSQL for read-only assertions' -Arguments @('start',$restoredResource.name) | Out-Null
    $ready=$false
    for($i=0;$i -lt 45;$i++){
        try{$probe=Invoke-GargantuaDocker -Operation 'wait for retained synthetic recovery PostgreSQL' -Arguments @('exec',$restoredResource.name,'psql','-h','127.0.0.1','-X','-U','postgres','-d','restore_check','-q','-A','-t','-c','SELECT 1;');if($probe.Trim() -eq '1'){$ready=$true;break}}catch{Start-Sleep -Seconds 1}
    }
    if(-not $ready){throw 'Retained synthetic recovery PostgreSQL did not become ready.'}
    $postRemote='/tmp/gargantua-verify-'+[Guid]::NewGuid().ToString('N')
    Invoke-GargantuaDocker -Operation 'create post-hold synthetic inventory staging' -Arguments @('exec',$restoredResource.name,'mkdir','-m','700',$postRemote) | Out-Null
    $postQuery=Join-Path $post 'inventory.sql'
    Invoke-GargantuaPython -Operation 'prepare existing post-hold inventory protocol' -Arguments @('inventory-sql','--remote',$postRemote,'--output',$postQuery) | Out-Null
    Invoke-GargantuaDocker -Operation 'read only synthetic post-hold inventory' -Arguments @('exec','-i',$restoredResource.name,'psql','-X','-U','postgres','-d','restore_check','-v','ON_ERROR_STOP=1') -InputText (Get-Content -LiteralPath $postQuery -Raw -Encoding UTF8) | Out-Null
    foreach($file in @('db-inventory.json','db-table-fingerprints.jsonl')){Receive-FixtureFile -Container $restoredResource.name -Remote ($postRemote+'/'+$file) -Destination (Join-Path $post $file)}
    Write-FixtureState -Container $restoredResource.name -User 'postgres' -Database 'restore_check' -Remote ($postRemote+'/fixture-state.json') -Destination (Join-Path $post 'fixture-state.json')
    Invoke-FixturePython -Operation 'assert explicit recovery hold and preserved publication history' -Arguments @('assert-after','--seed',$seed,'--snapshot',$snapshot,'--source-state',(Join-Path $snapshot 'fixture-state.json'),'--post-root',$post,'--post-state',(Join-Path $post 'fixture-state.json'),'--report',(Join-Path $root 'assert-after.json')) | Out-Null
    $after=Get-Content -LiteralPath (Join-Path $root 'assert-after.json') -Raw -Encoding UTF8|ConvertFrom-Json
    Add-FixtureResource -Kind 'container' -Name $readName
    $reader=@('create','--pull','never','--name',$readName,'--label',$label,'--network',('container:'+$restoredResource.name),'--read-only','--user','1000:1000',
        '--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','384m','--cpus','1','--pids-limit','64','--tmpfs','/tmp:rw,nosuid,noexec,size=32m,mode=1777',
        '--mount',('type=bind,source='+(Join-Path $restore 'books')+',target=/fixture-library/books,readonly'),'--mount',('type=bind,source='+$clientFile+',target=/fixture-client.mjs,readonly'),
        '--env','GARGANTUA_RESTORE_FIXTURE=1','--env','DATABASE_URL=postgres://postgres@127.0.0.1:5432/restore_check',$ids[$AppImage],'node','/fixture-client.mjs','verify')
    Invoke-GargantuaDocker -Operation 'create read-only publication-contract fixture client' -Arguments $reader | Out-Null
    Assert-FixtureResource ($resources|Where-Object{$_.name -eq $readName}|Select-Object -First 1)
    Invoke-GargantuaDocker -Operation 'read only restored publication bytes and v2 contracts' -Arguments @('start',$readName)|Out-Null
    $readDone=$false
    for($i=0;$i -lt 60;$i++){
        $state=(Invoke-GargantuaDocker -Operation 'read publication-contract client exit' -Arguments @('inspect','--format','{{json .State}}',$readName))|ConvertFrom-Json
        if($state.Status -eq 'exited'){$readDone=$true;if($state.ExitCode -ne 0){throw 'Restored publication-contract read failed; inspect synthetic logs.'};break}
        if($state.Dead){throw 'Publication-contract read client became dead.'};Start-Sleep -Seconds 1
    }
    if(-not $readDone){throw 'Publication-contract read exceeded its bounded runtime.'}
    $publicationRead=(Invoke-GargantuaDocker -Operation 'read synthetic publication-contract result' -Arguments @('logs',$readName))|ConvertFrom-Json
    if($publicationRead.status -ne 'PUBLICATIONS_VALIDATED' -or $publicationRead.books -ne 2 -or $publicationRead.chapters -ne 5 -or $publicationRead.resources -ne 1){throw 'Publication-contract client did not prove the expected fixture coverage.'}
}catch{$failure=$_.Exception.Message}
finally{
    if($rootOwned){
        try{Register-NestedRestore}catch{$cleanupErrors.Add($_.Exception.Message)}
        # Logs contain only synthetic fixture activity. No production resource is queried.
        foreach($resource in $resources.ToArray()|Where-Object{$_.kind -eq 'container'}){
            try{Assert-FixtureResource $resource;$logs=Invoke-GargantuaDocker -Operation 'save only owned synthetic container logs' -Arguments @('logs',$resource.name);[IO.File]::WriteAllText((Join-Path $root ($resource.name+'.log')),$logs,[Text.UTF8Encoding]::new($false))}catch{$cleanupErrors.Add($_.Exception.Message)}
        }
        for($i=$resources.Count-1;$i -ge 0;$i--){
            $resource=$resources[$i]
            if($resource.kind -ne 'container'){continue}
            try{Assert-FixtureResource $resource;Invoke-GargantuaDocker -Operation 'remove only owned synthetic container' -Arguments @('container','rm','--force',$resource.name)|Out-Null}catch{$cleanupErrors.Add($_.Exception.Message)}
        }
        foreach($resource in $resources.ToArray()|Where-Object{$_.kind -eq 'volume'}){
            try{Assert-FixtureResource $resource;Invoke-GargantuaDocker -Operation 'remove only owned synthetic volume' -Arguments @('volume','rm',$resource.name)|Out-Null}catch{$cleanupErrors.Add($_.Exception.Message)}
        }
        $status=if(-not $failure -and $cleanupErrors.Count -eq 0 -and $before.status -eq 'PASS' -and $after.status -eq 'PASS' -and $publicationRead.status -eq 'PUBLICATIONS_VALIDATED'){'PASS'}else{'FAIL'}
        Write-GargantuaJson -Path (Join-Path $root 'report.json') -Value @{version=1;status=$status;synthetic=$true;runId=$runId;root=$root;failure=$failure;
            cleanupErrors=$cleanupErrors.ToArray();resources=$resources.ToArray();beforeRecovery=$before;afterRecovery=$after;publicationRead=$publicationRead;elapsedSeconds=[Math]::Round($timer.Elapsed.TotalSeconds,3);
            operations=$script:GargantuaOperations.ToArray();productionDataUsed=$false;productionComposeUsed=$false;publishedHostPorts=$false;externalNetwork=$false;
            executableQueueCreated=$false;hostEvidenceRetained=$true;runtimeAccepted=($status -eq 'PASS');appImageId=$ids[$AppImage]}
    }
}
if($failure -or $cleanupErrors.Count -or -not $before -or -not $after -or -not $publicationRead){throw "Synthetic restore fixture failed; no runtime PASS claimed. Report: $root. $failure $($cleanupErrors -join '; ')"}
Write-Host "PASS: synthetic snapshot/restore with nonempty import/discovery attempts, leases, idempotency, PNG, nested catalogues and publication model. Report: $(Join-Path $root 'report.json')"
