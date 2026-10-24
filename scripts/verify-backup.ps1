<#
.SYNOPSIS
Restore a snapshot into a new network-isolated PostgreSQL container and file root.
.DESCRIPTION
Never uses production compose/database/volumes. Requires a trusted local PostgreSQL
17 image (never pulled). Keeps the stopped container/data/report by default.
Legacy v1 backups get isolated structural restore checks without claiming a missing
consistent baseline. Quarantine and unfinished jobs are not restored.
.EXAMPLE
./scripts/verify-backup.ps1 -Path ./backups/snapshot-... -RestoreRoot ./.local/restore-checks/check-1
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$Path,
    [string]$RestoreRoot = '',
    [string]$PostgresImage = 'postgres:17-bookworm',
    [switch]$Cleanup,
    [string]$ReportPath = ''
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'backup-common.ps1')
. (Join-Path $PSScriptRoot 'backup-cycle-restore.ps1')
$token = [Guid]::NewGuid().ToString('N')
$containerName = 'gargantua-restore-check-' + $token
$containerId = $null; $created = $false; $createAttempted = $false; $rootCreated = $false
$reportStream = $null
$failure = $null; $cleanupErrors = [Collections.Generic.List[string]]::new()
$validation = $null; $backupDir = $null; $owned = $false
$databaseReadiness = $null
try {
    $backupDir = Get-GargantuaFullPath ((Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path)
    # Before creating a Docker resource: verify sizes/hashes/paths/complete marker.
    Invoke-GargantuaPython -Operation 'preflight backup integrity' -Arguments @('preflight','--backup',$backupDir) | Out-Null
    if ($backupDir.Contains(',')) { throw 'Backup path cannot contain Docker bind-mount delimiters.' }
    if (-not $RestoreRoot) { $RestoreRoot = Join-Path $script:GargantuaProjectRoot ('.local/restore-checks/verify-' + $token) }
    $RestoreRoot = Get-GargantuaFullPath $RestoreRoot
    Assert-GargantuaNoReparseAncestors -Path $RestoreRoot
    if (Test-Path -LiteralPath $RestoreRoot) { throw 'Restore target must be a new, nonexistent directory.' }
    if ($RestoreRoot.Contains(',') -or (Test-GargantuaPathWithin -Root $backupDir -Target $RestoreRoot)) { throw 'Restore target cannot be inside the backup or contain Docker mount delimiters.' }
    if ($Cleanup -and -not $ReportPath) { throw 'Cleanup requires an explicit ReportPath outside the restore root.' }
    if (-not $ReportPath) { $ReportPath = Join-Path $RestoreRoot 'verification-report.json' }
    $ReportPath = Get-GargantuaFullPath $ReportPath
    Assert-GargantuaNoReparseAncestors -Path $ReportPath
    if (Test-GargantuaPathWithin -Root $backupDir -Target $ReportPath) { throw 'Verification report cannot modify the input backup.' }
    $insideRestore = Test-GargantuaPathWithin -Root $RestoreRoot -Target $ReportPath
    if (($Cleanup -and $insideRestore) -or ($insideRestore -and $ReportPath -ne (Join-Path $RestoreRoot 'verification-report.json'))) { throw 'Only the default report filename is allowed inside a retained restore root; cleanup reports must be outside.' }
    if (Test-Path -LiteralPath $ReportPath) { throw 'Refusing to overwrite an existing verification report.' }
    if ($PostgresImage -notmatch '^[a-zA-Z0-9][a-zA-Z0-9./_:@-]{0,200}$') { throw 'Invalid local PostgreSQL image reference.' }
    $imageId = (Invoke-GargantuaDocker -Operation 'check local trusted postgres image' -Arguments @('image','inspect','--format','{{.Id}}',$PostgresImage)).Trim()
    if ($imageId -notmatch '^sha256:[a-f0-9]{64}$') { throw 'Trusted PostgreSQL image is not available locally.' }

    New-Item -ItemType Directory -Force -Path (Split-Path $RestoreRoot -Parent) | Out-Null
    New-Item -ItemType Directory -Path $RestoreRoot | Out-Null
    $rootCreated = $true
    Set-GargantuaPrivateDirectory -Path $RestoreRoot
    Write-GargantuaJson -Path (Join-Path $RestoreRoot 'restore-owner.json') -Value @{version=1;token=$token;root=$RestoreRoot;container=$containerName;createdAt=[DateTimeOffset]::UtcNow.ToString('o')}
    $owned = $true
    New-Item -ItemType Directory -Force -Path (Split-Path $ReportPath -Parent) | Out-Null
    $reportStream = [IO.File]::Open($ReportPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    if (-not $insideRestore) {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        Invoke-GargantuaNative -Operation 'protect external verification report' -Command 'icacls' -Arguments @($ReportPath,'/inheritance:r','/grant:r',($identity+':F'),'*S-1-5-18:F') | Out-Null
    }
    $pgData = Join-Path $RestoreRoot 'postgres'
    New-Item -ItemType Directory -Path $pgData | Out-Null
    Copy-Item -LiteralPath (Join-Path $backupDir 'books') -Destination (Join-Path $RestoreRoot 'books') -Recurse -ErrorAction Stop
    $snapshotInventory = $null
    if (Test-Path -LiteralPath (Join-Path $backupDir 'db-inventory.json')) {
        $snapshotInventory = Get-Content -LiteralPath (Join-Path $backupDir 'db-inventory.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    }
    if ($snapshotInventory.derivedSupported) {
        Copy-Item -LiteralPath (Join-Path $backupDir 'derived') -Destination (Join-Path $RestoreRoot 'derived') -Recurse -ErrorAction Stop
    }

    # Only this new bind root is writable. No host ports or external network;
    # no application, worker, Docker socket or production mount is attached.
    $createArguments = @('create','--pull','never','--name',$containerName,
        '--label',('gargantua.verify-token='+$token),'--network','none',
        '--memory','512m','--cpus','1','--pids-limit','128','--shm-size','128m',
        '--read-only','--security-opt','no-new-privileges:true','--cap-drop','ALL',
        '--cap-add','CHOWN','--cap-add','FOWNER','--cap-add','DAC_OVERRIDE','--cap-add','SETUID','--cap-add','SETGID',
        '--tmpfs','/tmp:rw,size=128m,mode=1777','--tmpfs','/var/run/postgresql:rw,size=16m,mode=3775',
        '--mount',('type=bind,source='+$pgData+',target=/var/lib/postgresql/data'),
        '--mount',('type=bind,source='+(Join-Path $backupDir 'database.dump')+',target=/restore-input.dump,readonly'),
        '--env','POSTGRES_HOST_AUTH_METHOD=trust','--env','POSTGRES_DB=restore_check',$imageId)
    $createAttempted = $true
    $containerId = (Invoke-GargantuaDocker -Operation 'create isolated restore container' -Arguments $createArguments).Trim()
    $created = $true
    if ($containerId -notmatch '^[a-f0-9]{12,64}$') { throw 'Unexpected restore container identifier.' }
    Invoke-GargantuaDocker -Operation 'start isolated restore database' -Arguments @('start',$containerId) | Out-Null
    # The temporary init server accepts Unix sockets before the final database
    # exists. A bounded TCP query proves readiness; a dead/OOM container fails
    # promptly with safe structured diagnostics before cleanup removes it.
    $databaseReadiness=Wait-GargantuaRestoreDatabase -TimeoutSeconds 120 -Probe {
        param($Timeout)
        Invoke-GargantuaDocker -Operation 'wait for isolated database' -Arguments @('exec',$containerId,'psql','-h','127.0.0.1','-X','-U','postgres','-d','restore_check','-A','-t','-v','ON_ERROR_STOP=1','-c','SELECT 1;') -TimeoutSeconds $Timeout
    } -Inspect {
        param($Timeout)
        Invoke-GargantuaDocker -Operation 'inspect isolated database readiness failure' -Arguments @('inspect','--format','{{json .State}}',$containerId) -TimeoutSeconds $Timeout|ConvertFrom-Json
    }
    if ($databaseReadiness.status -ne 'ready') { throw ('Isolated database did not become ready: '+$databaseReadiness.status+'. See sanitized databaseReadiness diagnostics.') }
    Invoke-GargantuaDocker -Operation 'restore isolated database' -Arguments @('exec',$containerId,'pg_restore','-U','postgres','-d','restore_check','--no-owner','--no-acl','--exit-on-error','--single-transaction','/restore-input.dump') | Out-Null

    $remote = '/tmp/gargantua-verify-' + $token
    Invoke-GargantuaDocker -Operation 'create isolated inventory staging' -Arguments @('exec',$containerId,'mkdir','-m','700',$remote) | Out-Null
    $sqlPath = Join-Path $RestoreRoot 'restored-inventory.sql'
    Invoke-GargantuaPython -Operation 'prepare restored inventory query' -Arguments @('inventory-sql','--remote',$remote,'--output',$sqlPath) | Out-Null
    Invoke-GargantuaDocker -Operation 'read restored database inventory' -Arguments @('exec','-i',$containerId,'psql','-X','-U','postgres','-d','restore_check','-v','ON_ERROR_STOP=1') -InputText (Get-Content -LiteralPath $sqlPath -Raw -Encoding UTF8) | Out-Null
    foreach ($name in @('db-inventory.json','db-table-fingerprints.jsonl')) {
        # Docker archive/cp APIs do not reliably cover tmpfs on a read-only root.
        # Transfer ASCII only and decode privately to preserve exact UTF-8 bytes.
        $encoded = Invoke-GargantuaDocker -Operation "read restored $name" -Arguments @('exec',$containerId,'base64','--wrap=0',($remote+'/'+$name))
        Write-GargantuaBase64File -Path (Join-Path $RestoreRoot $name) -Encoded $encoded -MaxBytes (32*1024*1024)
    }
    $validationPath = Join-Path $RestoreRoot 'library-validation.json'
    Invoke-GargantuaPython -Operation 'compare restored database and book files' -Arguments @('compare','--backup',$backupDir,'--restored',$RestoreRoot,'--books',(Join-Path $RestoreRoot 'books'),'--report',$validationPath) | Out-Null
    $validation = Get-Content -LiteralPath $validationPath -Raw -Encoding UTF8 | ConvertFrom-Json
    # These mutations affect only the newly restored container, after comparison.
    # Preserve roles/history but disable sessions/outgoing work before later review.
    $recoverySql = @'
BEGIN;
DELETE FROM public.sessions;
UPDATE public.settings SET imports_paused=true,serving_paused=true WHERE id=1;
UPDATE public.imports SET status='error',security_state='error',stage='Recovery hold: source inputs must be reviewed',error='Snapshot excludes unfinished quarantine/jobs' WHERE status IN ('uploading','queued','processing');
DO $recovery$
BEGIN
 IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='imports' AND column_name='lease_expires_at') THEN
  EXECUTE 'UPDATE public.imports SET lease_expires_at=NULL';
 END IF;
 IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='imports' AND column_name='attempt_token') THEN
  EXECUTE 'UPDATE public.imports SET attempt_token=NULL';
 END IF;
 IF to_regclass('public.import_attempts') IS NOT NULL THEN
  EXECUTE 'UPDATE public.import_attempts SET state=''interrupted'',ended_at=COALESCE(ended_at,now()),error=''Recovery hold: snapshot excludes unfinished source inputs/jobs'' WHERE state IN (''running'',''prepared'',''placed'')';
 END IF;
 IF to_regclass('public.discovery_requests') IS NOT NULL THEN
  EXECUTE $discovery$
   UPDATE public.discovery_requests SET
    status=CASE WHEN status IN ('pending-approval','queued','processing','needs-review','selected','acquiring') THEN 'pending-approval' ELSE status END,
    revision=revision+CASE WHEN status IN ('pending-approval','queued','processing','needs-review','selected','acquiring') THEN 1 ELSE 0 END,
    approved_by=CASE WHEN status IN ('pending-approval','queued','processing','needs-review','selected','acquiring') THEN NULL ELSE approved_by END,
    decision_reason=CASE WHEN status IN ('pending-approval','queued','processing','needs-review','selected','acquiring') THEN NULL ELSE decision_reason END,
    error=CASE WHEN status IN ('pending-approval','queued','processing','needs-review','selected','acquiring') THEN 'Recovery hold: discovery/acquisition requires new owner approval' ELSE error END,
    attempt_token=NULL,lease_expires_at=NULL
  $discovery$;
 END IF;
 IF to_regclass('public.discovery_attempts') IS NOT NULL THEN
  EXECUTE 'UPDATE public.discovery_attempts SET state=''interrupted'',ended_at=COALESCE(ended_at,now()),error=''Recovery hold: active discovery/acquisition was interrupted'' WHERE state=''running''';
 END IF;
 IF to_regclass('public.ranobe_feeds') IS NOT NULL THEN
  EXECUTE 'UPDATE public.ranobe_feeds SET auto_update=false,active_import_id=NULL,revision=revision+1,updated_at=now()';
 END IF;
 IF to_regclass('public.ranobe_runs') IS NOT NULL THEN
  EXECUTE 'UPDATE public.ranobe_runs SET status=''abandoned'' WHERE status=''building''';
 END IF;
 IF to_regclass('public.ranobe_scratch') IS NOT NULL THEN
  -- Raw files are deliberately excluded. Preserve safe checkpoints and immutable
  -- ready heads; remove only trackers for inputs that cannot be restored.
  EXECUTE 'DELETE FROM public.ranobe_scratch';
 END IF;
 IF to_regclass('public.derived_jobs') IS NOT NULL THEN
  -- Keep immutable completed rows, results and every accepted checkpoint. The
  -- completed attempt token is historical provenance, not a live lease.
  EXECUTE $derived_jobs$
   UPDATE public.derived_jobs SET
    status=CASE WHEN status IN ('queued','processing','paused','approval-required') THEN 'paused' ELSE status END,
    pause_reason=CASE WHEN status IN ('queued','processing','paused','approval-required') THEN 'recovery-hold' ELSE pause_reason END,
    error=CASE WHEN status IN ('queued','processing','paused','approval-required') THEN 'Recovery hold: derivative work requires review and new approval' ELSE error END,
    attempt_token=NULL,lease_expires_at=NULL,next_attempt_at=NULL,revision=revision+1,updated_at=now()
   WHERE status<>'completed'
  $derived_jobs$;
  EXECUTE 'UPDATE public.derived_attempts SET state=''interrupted'',ended_at=COALESCE(ended_at,now()),error=''Recovery hold: model execution was interrupted'' WHERE state=''running''';
  EXECUTE 'UPDATE public.derived_requests SET status=''pending-approval'',approved_by=NULL,decision_reason=NULL,revision=revision+1,updated_at=now() WHERE status=''active''';
 END IF;
END
$recovery$;
COMMIT;
'@
    Invoke-GargantuaDocker -Operation 'hold isolated recovery and revoke restored sessions' -Arguments @('exec','-i',$containerId,'psql','-X','-U','postgres','-d','restore_check','-v','ON_ERROR_STOP=1') -InputText $recoverySql | Out-Null
    $confirmSql = @'
DO $hold$
DECLARE active_attempts boolean;
BEGIN
 IF EXISTS(SELECT 1 FROM public.sessions) OR NOT EXISTS(SELECT 1 FROM public.settings WHERE id=1 AND imports_paused AND serving_paused) THEN
  RAISE EXCEPTION 'Recovery sessions/settings hold failed';
 END IF;
 IF EXISTS(SELECT 1 FROM public.imports i WHERE i.status IN ('uploading','queued','processing') OR to_jsonb(i)->>'lease_expires_at' IS NOT NULL OR to_jsonb(i)->>'attempt_token' IS NOT NULL) THEN
  RAISE EXCEPTION 'Recovery queue/lease hold failed';
 END IF;
 IF to_regclass('public.import_attempts') IS NOT NULL THEN
  EXECUTE 'SELECT EXISTS(SELECT 1 FROM public.import_attempts WHERE state IN (''running'',''prepared'',''placed''))' INTO active_attempts;
  IF active_attempts THEN RAISE EXCEPTION 'Recovery attempt hold failed'; END IF;
 END IF;
 IF to_regclass('public.discovery_requests') IS NOT NULL THEN
  EXECUTE 'SELECT EXISTS(SELECT 1 FROM public.discovery_requests WHERE status IN (''queued'',''processing'',''needs-review'',''selected'',''acquiring'') OR attempt_token IS NOT NULL OR lease_expires_at IS NOT NULL OR (status=''pending-approval'' AND (approved_by IS NOT NULL OR decision_reason IS NOT NULL)))' INTO active_attempts;
  IF active_attempts THEN RAISE EXCEPTION 'Recovery discovery request hold failed'; END IF;
 END IF;
 IF to_regclass('public.discovery_attempts') IS NOT NULL THEN
  EXECUTE 'SELECT EXISTS(SELECT 1 FROM public.discovery_attempts WHERE state=''running'')' INTO active_attempts;
  IF active_attempts THEN RAISE EXCEPTION 'Recovery discovery attempt hold failed'; END IF;
 END IF;
 IF to_regclass('public.ranobe_feeds') IS NOT NULL THEN
  EXECUTE 'SELECT EXISTS(SELECT 1 FROM public.ranobe_feeds WHERE auto_update OR active_import_id IS NOT NULL)' INTO active_attempts;
  IF active_attempts THEN RAISE EXCEPTION 'Recovery Ranobe subscription hold failed'; END IF;
 END IF;
 IF to_regclass('public.ranobe_runs') IS NOT NULL THEN
  EXECUTE 'SELECT EXISTS(SELECT 1 FROM public.ranobe_runs WHERE status=''building'')' INTO active_attempts;
  IF active_attempts THEN RAISE EXCEPTION 'Recovery Ranobe build hold failed'; END IF;
 END IF;
 IF to_regclass('public.ranobe_scratch') IS NOT NULL THEN
  EXECUTE 'SELECT EXISTS(SELECT 1 FROM public.ranobe_scratch)' INTO active_attempts;
  IF active_attempts THEN RAISE EXCEPTION 'Recovery Ranobe raw-input hold failed'; END IF;
 END IF;
 IF to_regclass('public.derived_jobs') IS NOT NULL THEN
  EXECUTE 'SELECT EXISTS(SELECT 1 FROM public.derived_jobs WHERE status IN (''queued'',''processing'',''approval-required'') OR lease_expires_at IS NOT NULL OR (status<>''completed'' AND attempt_token IS NOT NULL))' INTO active_attempts;
  IF active_attempts THEN RAISE EXCEPTION 'Recovery derivative lease/queue hold failed'; END IF;
  EXECUTE 'SELECT EXISTS(SELECT 1 FROM public.derived_attempts WHERE state=''running'')' INTO active_attempts;
  IF active_attempts THEN RAISE EXCEPTION 'Recovery model attempt hold failed'; END IF;
  EXECUTE 'SELECT EXISTS(SELECT 1 FROM public.derived_requests WHERE status=''active'')' INTO active_attempts;
  IF active_attempts THEN RAISE EXCEPTION 'Recovery derivative approval hold failed'; END IF;
 END IF;
END
$hold$;
SELECT true;
'@
    $safe = Invoke-GargantuaDocker -Operation 'confirm isolated recovery hold' -Arguments @('exec','-i',$containerId,'psql','-X','-U','postgres','-d','restore_check','-q','-A','-t','-v','ON_ERROR_STOP=1') -InputText $confirmSql
    if ($safe.Trim() -ne 't') { throw 'Isolated recovery hold was not confirmed.' }
} catch { $failure = $_.Exception.Message }
finally {
    if ($createAttempted) {
        try {
            if (-not $created) {
                $found = (Invoke-GargantuaDocker -Operation 'resolve uncertain own container creation' -Arguments @('ps','-a','--filter',('name=^/'+$containerName+'$'),'--format','{{.ID}}')).Trim()
                if ($found) {
                    if ($found -notmatch '^[a-f0-9]{12,64}$') { throw 'Uncertain restore container identity.' }
                    $created = $true
                }
            }
            if ($created) {
            $savedToken = (Invoke-GargantuaDocker -Operation 'confirm restore container ownership' -Arguments @('inspect','--format','{{index .Config.Labels "gargantua.verify-token"}}',$containerName)).Trim()
            if ($savedToken -ne $token) { throw 'Container ownership mismatch; stop/cleanup refused.' }
            Invoke-GargantuaDocker -Operation 'stop own restore container' -Arguments @('stop','--time','15',$containerName) | Out-Null
            $running = (Invoke-GargantuaDocker -Operation 'confirm restore container stopped' -Arguments @('inspect','--format','{{.State.Running}}',$containerName)).Trim()
            if ($running -ne 'false') { throw 'Restore container is still running.' }
            if ($Cleanup) { Invoke-GargantuaDocker -Operation 'remove own restore container' -Arguments @('rm',$containerName) | Out-Null }
            }
        } catch { $cleanupErrors.Add($_.Exception.Message) }
    }
}

if ($Cleanup -and $owned -and $cleanupErrors.Count -eq 0) {
    try {
        Assert-GargantuaOwnedRestore -Path $RestoreRoot -Token $token
        Invoke-GargantuaPython -Operation 'validate own restore cleanup boundary' -Arguments @('cleanup-check','--root',$RestoreRoot,'--token',$token) | Out-Null
        Remove-Item -LiteralPath $RestoreRoot -Recurse -Force -ErrorAction Stop
    } catch { $cleanupErrors.Add($_.Exception.Message) }
}
$retained = $owned -and (Test-Path -LiteralPath $RestoreRoot)
$report = @{version=1;status='failed';backup=$backupDir;restoreRoot=$RestoreRoot;container=$containerName;
    error=$failure;cleanupErrors=$cleanupErrors.ToArray();validation=$validation;operations=$script:GargantuaOperations.ToArray();
    createdAt=[DateTimeOffset]::UtcNow.ToString('o');scope='Isolated restore; never production activation';
    recoveryHold='After comparison: sessions revoked, imports/serving paused, active import/discovery leases/tokens cleared and attempts interrupted; active discovery requests require new approval; unfinished derivative jobs paused with live leases/tokens cleared, running model attempts interrupted and active derivative requests require new approval; completed derivative rows/results/checkpoints and historical attempt tokens preserved; Ranobe auto updates disabled and builds abandoned, ready heads/safe checkpoints preserved; raw scratch trackers removed; legacy schema checked conditionally';
    environmentKept=$retained;cleanupRequested=[bool]$Cleanup;databaseReadiness=$databaseReadiness}
if (-not $failure -and $cleanupErrors.Count -eq 0 -and $validation) { $report.status='validated' }
if ($reportStream) {
    try {
        $reportBytes = [Text.UTF8Encoding]::new($false).GetBytes(($report | ConvertTo-Json -Depth 30))
        $reportStream.Write($reportBytes,0,$reportBytes.Length); $reportStream.Flush($true)
    } finally { $reportStream.Dispose() }
}
if ($failure -or $cleanupErrors.Count -or -not $validation) {
    throw "Isolated restore verification failed. Production was not modified. $failure $($cleanupErrors -join ' ')"
}
Write-Host "Isolated restore validated. Report: $ReportPath"
if (-not $Cleanup) { Write-Host "Stopped recovery environment retained: $RestoreRoot (container $containerName)." }
