[CmdletBinding()]
param([string]$DestinationRoot = '', [ValidateRange(1,120)][int]$StopTimeoutSeconds = 30, [switch]$IncludeRuntimeImages)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'backup-common.ps1')
. (Join-Path $PSScriptRoot 'backup-space.ps1')
. (Join-Path $PSScriptRoot 'backup-inference.ps1')
. (Join-Path $PSScriptRoot 'resource-monitor-io.ps1')
. (Join-Path $PSScriptRoot 'startup-common.ps1')
. (Join-Path $PSScriptRoot 'backup-cycle-lock.ps1')
. (Join-Path $PSScriptRoot 'lifecycle-stop-guard.ps1')

# No settings/roles/audit mutations; restore each original processor state.
$backupDir = $null; $states = @(); $remote = $null; $db = $null
$failure = $null; $recoveryErrors = [Collections.Generic.List[string]]::new()
$lock = $null; $lockPath = Join-Path $script:GargantuaProjectRoot '.local/backup-snapshot.lock'
$token = [Guid]::NewGuid().ToString('N')
$handlersTouched = $false
$inferenceLock = $null
$lifecycleLock = $null
try {
    if (-not $DestinationRoot) { $DestinationRoot = Join-Path $script:GargantuaProjectRoot 'backups' }
    $parent = [IO.Path]::GetFullPath($DestinationRoot)
    $operationsRoot=Get-GargantuaAutomationRoot -ProjectRoot $script:GargantuaProjectRoot
    Assert-GargantuaNoReparseAncestors -Path $operationsRoot
    New-Item -ItemType Directory -Force -Path $operationsRoot|Out-Null
    Set-GargantuaPrivateDirectory -Path $operationsRoot
    $lifecycleLock=Open-GargantuaLifecycleLock -ProjectRoot $script:GargantuaProjectRoot
    if(-not $lifecycleLock){throw 'Lifecycle operation is active; snapshot was not started.'}
    $lock = Open-GargantuaSnapshotLease -Path $lockPath -Token $token

    $db = Get-GargantuaService -Service 'db'
    if (-not $db.running -or $db.paused) { throw 'Database must already be running; snapshot never starts production services.' }
    $app = Get-GargantuaService -Service 'app'
    $states = @((Get-GargantuaService -Service 'worker'), (Get-GargantuaService -Service 'parser'))
    # Serialize estimates under the snapshot lock. No target, staging or service
    # mutation is permitted before every storage location has a known budget.
    $estimates = Get-GargantuaBackupEstimates -Database $db -App $app -Handlers $states -IncludeRuntimeImages:$IncludeRuntimeImages
    $storage = Get-GargantuaDockerStorage
    if (-not $storage.known -or -not @($storage.paths).Count) { throw 'Backup preflight: Docker storage location is unknown.' }
    $volumes = @((Get-GargantuaBackupVolume -Path $parent -Role 'destination'),(Get-GargantuaBackupVolume -Path $script:GargantuaProjectRoot -Role 'workspace'))
    $volumes += @($storage.paths | ForEach-Object { Get-GargantuaBackupVolume -Path $_ -Role 'docker' })
    $capacity = Get-GargantuaBackupSpaceDecision -Estimates $estimates -Volumes $volumes
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    $backupDir = Join-Path $parent ('snapshot-' + [DateTime]::UtcNow.ToString('yyyy-MM-dd_HH-mm-ss') + '-' + $token.Substring(0,8))
    if (Test-Path -LiteralPath $backupDir) { throw 'Snapshot target already exists.' }
    New-Item -ItemType Directory -Path $backupDir | Out-Null
    Set-GargantuaPrivateDirectory -Path $backupDir
    Write-GargantuaJson -Path (Join-Path $backupDir 'manifest.json') -Value @{version=2;status='building';snapshotId=$token;files=@();createdAt=[DateTimeOffset]::UtcNow.ToString('o')}
    Write-GargantuaJson -Path (Join-Path $backupDir 'capacity-preflight.json') -Value $capacity
    Write-GargantuaJson -Path (Join-Path $backupDir 'service-state-before.json') -Value @{snapshotId=$token;handlers=$states;createdAtMs=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();stopTimeoutSeconds=$StopTimeoutSeconds;stopIntentProtocol='central-rpc-v1';note='Recovery journal written before first handler mutation.'}
    foreach ($state in $states) {
        if ($state.running) {
            $handlersTouched = $true
            if ($state.paused) { Invoke-GargantuaDocker -Operation "unpause $($state.service) for snapshot" -Arguments @('unpause',$state.id) | Out-Null }
            # Stamp immediately before this stop RPC, after any unpause work;
            # its quiet deadline must not start during an earlier operation.
            $null=New-GargantuaSnapshotStopIntent -ProjectRoot $script:GargantuaProjectRoot -SnapshotId $token -State $state -TimeoutSeconds $StopTimeoutSeconds
            Invoke-GargantuaDocker -Operation "stop $($state.service) for snapshot" -Arguments @('stop','--time',[string]$StopTimeoutSeconds,$state.id) -TimeoutSeconds ($StopTimeoutSeconds+15) | Out-Null
        }
        Assert-GargantuaStopped -State $state
        if($state.running){Remove-GargantuaSnapshotStopIntent -ProjectRoot $script:GargantuaProjectRoot -SnapshotId $token -State $state}
    }
    # The host inference executor is outside compose. Stop its publisher first,
    # then share its exclusive execution lock and confirm no orphan runtime lives.
    $inferenceLock = Enter-GargantuaInferenceSnapshot
    $reader = $app
    if (-not $reader.exists) { $reader = $states | Where-Object { $_.service -eq 'worker' } | Select-Object -First 1 }
    if (-not $reader.exists) { throw 'No existing library-mounted container; nothing was started.' }
    $remote = '/tmp/gargantua-snapshot-' + $token
    Invoke-GargantuaDocker -Operation 'create private database staging' -Arguments @('exec',$db.id,'mkdir','-m','700',$remote) | Out-Null
    $sqlPath = Join-Path $backupDir 'snapshot-inventory.sql'
    Invoke-GargantuaPython -Operation 'prepare consistent snapshot query' -Arguments @('inventory-sql','--remote',$remote,'--snapshot','--output',$sqlPath) | Out-Null
    $sql = Get-Content -LiteralPath $sqlPath -Raw -Encoding UTF8
    Invoke-GargantuaDocker -Operation 'dump and inventory same exported snapshot' -Arguments @('exec','-i',$db.id,'psql','-X','-U','cotology_app','-d','library','-v','ON_ERROR_STOP=1') -InputText $sql | Out-Null
    foreach ($name in @('database.dump','db-inventory.json','db-table-fingerprints.jsonl')) {
        Invoke-GargantuaDocker -Operation "copy $name" -Arguments @('cp',($db.id+':'+$remote+'/'+$name),(Join-Path $backupDir $name)) | Out-Null
    }
    if ((Get-Item -LiteralPath (Join-Path $backupDir 'db-inventory.json')).Length -gt 32MB) { throw 'Snapshot inventory exceeds the bounded metadata limit.' }
    $capturedInventory = Get-Content -LiteralPath (Join-Path $backupDir 'db-inventory.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($capturedInventory.ranobeSupported) {
        Invoke-GargantuaDocker -Operation 'copy sanitized Ranobe checkpoint sidecar' -Arguments @('cp',($db.id+':'+$remote+'/ranobe-checkpoints.jsonl'),(Join-Path $backupDir 'ranobe-checkpoints.jsonl')) | Out-Null
        if ((Get-Item -LiteralPath (Join-Path $backupDir 'ranobe-checkpoints.jsonl')).Length -gt 96MB) { throw 'Sanitized Ranobe checkpoints exceed their bounded sidecar limit.' }
        if ($capturedInventory.ranobeMetadataFormat) {
            if ($capturedInventory.ranobeMetadataFormat -ne 'source-jsonl-v1') { throw 'Unsupported Ranobe metadata sidecar format.' }
            Invoke-GargantuaDocker -Operation 'copy bounded Ranobe source metadata sidecar' -Arguments @('cp',($db.id+':'+$remote+'/ranobe-metadata.jsonl'),(Join-Path $backupDir 'ranobe-metadata.jsonl')) | Out-Null
            if ((Get-Item -LiteralPath (Join-Path $backupDir 'ranobe-metadata.jsonl')).Length -gt 256MB) { throw 'Ranobe source metadata exceeds its bounded sidecar limit.' }
        }
    }
    $derivedSupported = [bool]$capturedInventory.derivedSupported
    if ($derivedSupported) {
        if ($capturedInventory.derivedMetadataFormat -ne 'source-jsonl-v1') { throw 'Unsupported derivative metadata sidecar format.' }
        Invoke-GargantuaDocker -Operation 'copy bounded derivative checkpoint metadata' -Arguments @('cp',($db.id+':'+$remote+'/derived-metadata.jsonl'),(Join-Path $backupDir 'derived-metadata.jsonl')) | Out-Null
        if ((Get-Item -LiteralPath (Join-Path $backupDir 'derived-metadata.jsonl')).Length -gt 256MB) { throw 'Derivative metadata exceeds its bounded sidecar limit.' }
    }
    if ($capturedInventory.readerSupported) {
        if ($capturedInventory.readerMetadataFormat -notin @('source-jsonl-v1','source-jsonl-v2')) { throw 'Unsupported reader metadata sidecar format.' }
        $readerMetadataRemote = $remote + '/reader-metadata.jsonl'
        $readerMetadataBytes = (Invoke-GargantuaDocker -Operation 'check bounded reader metadata source size' -Arguments @('exec',$db.id,'stat','-c','%s','--',$readerMetadataRemote)).Trim()
        if ($readerMetadataBytes -notmatch '^(0|[1-9][0-9]{0,9})$' -or [long]$readerMetadataBytes -gt 128MB) { throw 'Reader metadata source exceeds its bounded sidecar limit.' }
        $readerMetadataHash = (Invoke-GargantuaDocker -Operation 'hash reader metadata source bytes' -Arguments @('exec',$db.id,'sha256sum','--',$readerMetadataRemote)).Trim()
        if ($readerMetadataHash -notmatch '^([a-f0-9]{64})  /tmp/gargantua-snapshot-[a-f0-9]{32}/reader-metadata\.jsonl$') { throw 'Unexpected reader metadata source hash.' }
        $readerExpectedHash = $Matches[1]
        $readerMetadataLocal = Join-Path $backupDir 'reader-metadata.jsonl'
        Invoke-GargantuaDocker -Operation 'copy bounded reader metadata' -Arguments @('cp',($db.id+':'+$readerMetadataRemote),$readerMetadataLocal) | Out-Null
        if ((Get-Item -LiteralPath $readerMetadataLocal).Length -ne [long]$readerMetadataBytes -or (Get-FileHash -LiteralPath $readerMetadataLocal -Algorithm SHA256).Hash.ToLowerInvariant() -ne $readerExpectedHash) { throw 'Reader metadata copy differs from consistent source bytes.' }
    }
    $capturedInventory = $null
    Invoke-GargantuaDocker -Operation 'copy published books' -Arguments @('cp',($reader.id+':/library/books'),(Join-Path $backupDir 'books')) | Out-Null
    if ($derivedSupported) {
        Invoke-GargantuaDocker -Operation 'copy derivative publications and committed checkpoint files' -Arguments @('cp',($reader.id+':/library/derived'),(Join-Path $backupDir 'derived')) | Out-Null
    }
    foreach ($state in $states) { Assert-GargantuaStopped -State $state }
    Invoke-GargantuaPython -Operation 'capture source and unresolved config' -Arguments @('source','--project',$script:GargantuaProjectRoot,'--output',(Join-Path $backupDir 'source.tar.gz')) | Out-Null
    $dbImage = Invoke-GargantuaDocker -Operation 'record database image identity' -Arguments @('inspect','--format','{{.Image}}',$db.id)
    $images = @{}
    foreach ($state in @($app) + @($states)) {
        if ($state.exists) { $images[$state.service] = (Invoke-GargantuaDocker -Operation "record $($state.service) image identity" -Arguments @('inspect','--format','{{.Image}}',$state.id)).Trim() }
    }
    if ($IncludeRuntimeImages) {
        $uniqueImages = @(@($images.Values) + @($dbImage.Trim()) | Sort-Object -Unique)
        foreach ($image in $uniqueImages) { if ($image -notmatch '^sha256:[a-f0-9]{64}$') { throw 'Invalid captured runtime image identity.' } }
        Invoke-GargantuaDocker -Operation 'archive captured runtime images' -Arguments (@('image','save','--output',(Join-Path $backupDir 'runtime-images.tar')) + $uniqueImages) | Out-Null
    }
    $metadata = @{version=2;snapshotId=$token;snapshotProtocol='pg-exported-repeatable-read';handlers=$states;handlersRestored=$false;
        sourceDatabaseImage=$dbImage.Trim();sourceContainerImages=$images;sessionRowsExcluded=$true;quarantineIncluded=$false;stagingIncluded=$false;derivedIncluded=$derivedSupported;
        runtimeImagesIncluded=[bool]$IncludeRuntimeImages;sourceArchiveScope='Workspace source/config snapshot; may differ from the deployed container revision. Image IDs identify actual container builds.';
        note='Contains private data and password hashes. No runtime .env. Unfinished uploads/jobs may require reupload.'}
} catch { $failure = $_.Exception.Message }
finally {
    # Attempt every recovery action; do not hide the primary error.
    if ($remote -and $db -and $remote -match '^/tmp/gargantua-snapshot-[a-f0-9]{32}$') {
        try { Invoke-GargantuaDocker -Operation 'remove own database staging' -Arguments @('exec',$db.id,'rm','-rf','--',$remote) | Out-Null }
        catch { $recoveryErrors.Add($_.Exception.Message) }
    }
    # Release before restoring worker: its next segment can acquire the lock.
    if ($inferenceLock) {
        try { $inferenceLock.Dispose() } catch { $recoveryErrors.Add('Inference snapshot lock could not be released.') }
    }
    if ($handlersTouched) {
        $mayRestore=$false
        try{
            $quiet=Wait-GargantuaPendingStopBarrier -ProjectRoot $script:GargantuaProjectRoot -CurrentHandler {param($Service) Get-GargantuaService -Service $Service}
            if($quiet.status -ne 'clear'){throw 'Snapshot stop completion is not proved; handler recovery is deferred.'}
            $mayRestore=$true
        }catch{$recoveryErrors.Add($_.Exception.Message)}
        foreach ($state in $states) {
            try { if($mayRestore){Restore-GargantuaHandler -State $state} }
            catch { $recoveryErrors.Add($_.Exception.Message) }
        }
    }
    if ($lock) {
        try { $lock.Dispose() }
        catch { $recoveryErrors.Add('Own snapshot lock could not be released.') }
    }
}

if (-not $failure -and $recoveryErrors.Count -eq 0) {
    try {
        $metadata.handlersRestored = $true
        Write-GargantuaJson -Path (Join-Path $backupDir 'snapshot-metadata.json') -Value $metadata
        Write-GargantuaJson -Path (Join-Path $backupDir 'operations.json') -Value ($script:GargantuaOperations.ToArray())
        Invoke-GargantuaPython -Operation 'validate and publish snapshot manifest' -Arguments @('finalize','--backup',$backupDir) | Out-Null
    } catch { $failure = $_.Exception.Message }
}
if ($failure -or $recoveryErrors.Count) {
    if ($backupDir -and (Test-Path -LiteralPath $backupDir)) {
        try { Write-GargantuaJson -Path (Join-Path $backupDir 'manifest.json') -Value @{version=2;status='incomplete';snapshotId=$token;error=$failure;recoveryErrors=$recoveryErrors.ToArray();files=@()} }
        catch { $recoveryErrors.Add('Incomplete marker could not be recorded; the primary failure is preserved.') }
        try { Write-GargantuaJson -Path (Join-Path $backupDir 'operations.json') -Value ($script:GargantuaOperations.ToArray()) }
        catch { $recoveryErrors.Add('Operation journal could not be recorded.') }
    }
    $recoveryNote = 'Handlers were not changed.'
    if ($handlersTouched) { $recoveryNote = 'Original service states were attempted; review recoveryErrors.' }
    if($lifecycleLock){$lifecycleLock.Dispose();$lifecycleLock=$null}
    throw "Snapshot incomplete. $recoveryNote $failure $($recoveryErrors -join ' ')"
}
if($lifecycleLock){$lifecycleLock.Dispose();$lifecycleLock=$null}
Write-Host "Snapshot integrity checked: $backupDir"
Write-Host 'Separate isolated restore verification is required. Unencrypted private backup; not an independent off-PC copy.'

