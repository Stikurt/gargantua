param(
  [Parameter(Mandatory=$true)][Guid]$RequestId,
  [string]$OutputPath
)
$ErrorActionPreference = 'Stop'
$docker = Join-Path $env:LOCALAPPDATA 'Programs/DockerDesktop/resources/bin/docker.exe'
if (!(Test-Path -LiteralPath $docker)) { throw 'Docker Desktop executable not found' }
$request = $RequestId.ToString('D')
# All source content, credentials, cookies and model inputs are deliberately
# excluded. The database also enforces a read-only, bounded transaction.
$sql = @"
BEGIN READ ONLY;
SET LOCAL statement_timeout = '8s';
SET LOCAL lock_timeout = '2s';
WITH target AS (
 SELECT id,status,phase,revision,import_id,outputs,error,updated_at
 FROM discovery_requests WHERE id='$request'::uuid
), selected_import AS (
 SELECT i.* FROM imports i JOIN target t ON i.id=t.import_id
), selected_feed AS (
 SELECT f.* FROM ranobe_feeds f JOIN selected_import i ON f.id::text=i.options->>'feedId'
), selected_runs AS (
 SELECT r.* FROM ranobe_runs r JOIN selected_feed f ON r.feed_id=f.id
 ORDER BY r.created_at DESC LIMIT 5
)
SELECT json_build_object(
 'observedAt',clock_timestamp(),
 'readOnly',current_setting('transaction_read_only')='on',
 'request',(SELECT row_to_json(t) FROM target t),
 'import',(SELECT json_build_object('id',i.id,'status',i.status,'stage',i.stage,'error',i.error,
   'securityState',i.security_state,'attempt',i.attempt_number,'leaseExpiresAt',i.lease_expires_at,
   'progress',i.report->'progress','source',i.report->'source','sourceRetryCount',i.report->'sourceRetryCount',
   'updatedAt',i.updated_at) FROM selected_import i),
 'feed',(SELECT json_build_object('id',f.id,'remoteId',f.remote_id,'branch',f.branch_key,
   'language',f.language,'revision',f.revision,'headSnapshotId',f.head_run_id,
   'activeImportId',f.active_import_id,'autoUpdate',f.auto_update,'nextCheckAt',f.next_check_at) FROM selected_feed f),
 'runs',COALESCE((SELECT json_agg(json_build_object('id',r.id,'status',r.status,'targetChapters',r.chapter_count,
   'inventorySha256',r.inventory_sha256,'preparedChapters',(SELECT count(*) FROM ranobe_run_chapters c WHERE c.run_id=r.id AND c.chapter_id IS NOT NULL),
   'readyParts',(SELECT count(*) FROM ranobe_run_parts p WHERE p.run_id=r.id AND p.status='ready'),
   'publishedChapters',(SELECT COALESCE(sum(jsonb_array_length(p.source_keys)),0) FROM ranobe_run_parts p WHERE p.run_id=r.id AND p.status='ready'),
   'publishedBytes',(SELECT COALESCE(sum(b.content_bytes),0) FROM ranobe_run_parts p JOIN books b ON b.id=p.book_id WHERE p.run_id=r.id AND p.status='ready'),
   'unsafePublishedParts',(SELECT count(*) FROM ranobe_run_parts p JOIN books b ON b.id=p.book_id WHERE p.run_id=r.id AND p.status='ready' AND b.security_state<>'passed'),
   'createdAt',r.created_at,'activatedAt',r.activated_at)) FROM selected_runs r),'[]'::json)
);
COMMIT;
"@
$lines = & $docker --context desktop-linux exec cotology-db-1 psql -X -q -t -A -v ON_ERROR_STOP=1 -U cotology_admin -d library -c $sql
if ($LASTEXITCODE -ne 0) { throw 'Read-only progress query failed' }
$raw = ($lines -join "`n").Trim()
$parsed = $raw | ConvertFrom-Json
if ($parsed.readOnly -ne $true) { throw 'Database did not confirm read-only transaction' }
$json = $parsed | ConvertTo-Json -Depth 30
if ($OutputPath) {
  $destination = [IO.Path]::GetFullPath($OutputPath)
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
  [IO.File]::WriteAllText($destination,$json,[Text.UTF8Encoding]::new($false))
}
$json
