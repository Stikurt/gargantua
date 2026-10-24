<# Revalidate earlier real local-model output using the candidate server.
No model generation, production DB/library mounts or host-executor changes. #>
[CmdletBinding()]
param([string]$Image='cotology-app:core-next')
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'backup-common.ps1')
$project=$script:GargantuaProjectRoot
$source=Join-Path $project '.local/s5-queue/c91584ab9b514d4f8facb8f114a2e97f/snapshot-real-models'
$sourceReport=Join-Path $project '.local/s5-queue/c91584ab9b514d4f8facb8f114a2e97f/reports'
Assert-GargantuaNoReparseAncestors -Path $source
$token=[Guid]::NewGuid().ToString('N');$prefix='gargantua-gs-model-'+$token
$network=$prefix+'-net';$database=$prefix+'-db';$runner=$prefix+'-reader'
$root=Join-Path $project ('.local/test-results/gs-model-restore-'+$token)
New-Item -ItemType Directory -Path $root -Force|Out-Null
Set-GargantuaPrivateDirectory -Path $root
$networkCreated=$false;$databaseCreated=$false;$runnerCreated=$false;$failure=$null;$cleanup=[Collections.Generic.List[string]]::new()
$imageId=$null;$prevalidation=$null
function Docker-Checked([string[]]$DockerArgs,[int]$Timeout=120){Invoke-GargantuaDocker -Operation ('isolated model-result acceptance '+$DockerArgs[0]) -Arguments $DockerArgs -TimeoutSeconds $Timeout}
function Assert-Owned([string]$Kind,[string]$Name){
 $format=if($Kind -eq 'network'){'{{index .Labels "gargantua.gs-model"}}'}else{'{{index .Config.Labels "gargantua.gs-model"}}'}
 if((Docker-Checked @($Kind,'inspect','--format',$format,$Name)).Trim() -ne $token){throw 'Fixture ownership mismatch'}
}
try{
 $env:DOCKER_CONTEXT='desktop-linux'
 $prevalidation=Invoke-GargantuaPython -Operation 'validate original model fixture snapshot read-only' -Arguments @('preflight','--backup',$source)|ConvertFrom-Json
 if($prevalidation.status -ne 'ok'){throw 'Original model fixture snapshot is not valid'}
 $prior=Get-Content -LiteralPath (Join-Path $sourceReport 'model-queue-report.json') -Raw|ConvertFrom-Json
 if(-not $prior.realLocalModels -or -not $prior.realClam -or $prior.productionLibraryMounted -or $prior.status -ne 'completed'){throw 'Original model proof is missing'}
 Copy-Item -LiteralPath (Join-Path $sourceReport 'state.json') -Destination (Join-Path $root 'state.json')
 $imageId=(Docker-Checked @('image','inspect','--format','{{.Id}}',$Image)).Trim()
 Docker-Checked @('network','create','--internal','--label',('gargantua.gs-model='+$token),$network)|Out-Null;$networkCreated=$true
 Docker-Checked @('run','-d','--pull','never','--name',$database,'--label',('gargantua.gs-model='+$token),'--network',$network,'--network-alias','gargantua-s5-queue-db','--read-only','--tmpfs','/var/lib/postgresql/data:size=512m','--tmpfs','/var/run/postgresql','--tmpfs','/tmp:size=32m','--memory','768m','--cpus','1','--pids-limit','128','--mount',('type=bind,src='+$source+',dst=/restore-input,readonly'),'-e','POSTGRES_USER=cotology_app','-e','POSTGRES_DB=library','-e','POSTGRES_HOST_AUTH_METHOD=trust','postgres:17-bookworm','-c','max_wal_size=128MB','-c','min_wal_size=32MB')|Out-Null;$databaseCreated=$true
 $ready=$false
 for($n=0;$n -lt 50;$n++){try{Docker-Checked @('exec',$database,'psql','-h','127.0.0.1','-U','cotology_app','-d','library','-At','-c','SELECT 1;') 10|Out-Null;$ready=$true;break}catch{Start-Sleep -Seconds 1}}
 if(-not $ready){throw 'Isolated PostgreSQL did not become ready'}
 Docker-Checked @('exec',$database,'pg_restore','-U','cotology_app','-d','library','--no-owner','--no-acl','--exit-on-error','--single-transaction','/restore-input/database.dump') 120|Out-Null
 $bootstrap=@'
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const {pool,migrate}=await import('./server/db.mjs');
await migrate();
await pool.query('UPDATE settings SET serving_paused=false WHERE id=1');
const state=JSON.parse(await fs.readFile('/fixture-report/state.json','utf8'));
const before=(await pool.query('SELECT id,kind,status,attempt_number FROM derived_jobs ORDER BY id')).rows;
assert.equal(before.length,2);assert.ok(before.every(job=>job.status==='completed'));
const {applyReaderMutations,readerSnapshot}=await import('./server/reader-data.mjs');
const {readerMutationIdV2}=await import('./server/reader-data-model.mjs');
const {verifyReaderPublication}=await import('./server/reader-publication.mjs');
const {projectReaderEntity}=await import('./server/reader-legacy.mjs');
const deviceId=randomUUID(),profile={id:state.ownerId};
const mutation={protocolVersion:2,mutationId:readerMutationIdV2(profile.id,deviceId,1),deviceId,counter:1,entityType:'reading',entityId:state.sourceId,baseRevision:0,operation:'upsert',payload:{publicationId:state.sourceId,publicationRevision:1,locator:{type:'legacy',chapter:0,position:0.25},shelf:'reading'}};
const services={verifyPublication:(id,locator,options)=>verifyReaderPublication(pool,id,locator,options),projectEntity:projectReaderEntity};
const one=await applyReaderMutations(pool,profile,{mutations:[mutation]},services),two=await applyReaderMutations(pool,profile,{mutations:[mutation]},services);
assert.deepEqual(one.results,two.results);assert.equal((await readerSnapshot(pool,profile)).entities.length,1);
const migrations=(await pool.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n;
await fs.writeFile('/fixture-report/candidate-reader-proof.json',JSON.stringify({migrations,mutationReplay:true,readerEntities:1,beforeJobs:before},null,2));
process.argv.push('--phase','verify');
await import('./tests/derived-model-live.integration.mjs');
const after=(await pool.query('SELECT id,kind,status,attempt_number FROM derived_jobs ORDER BY id')).rows;
assert.deepEqual(after,before,'Verification must not regenerate model output or add jobs');
await pool.end();
'@
 Docker-Checked @('create','--pull','never','--name',$runner,'--label',('gargantua.gs-model='+$token),'--network',$network,'--read-only','--tmpfs','/tmp:size=32m,mode=1777','--memory','512m','--cpus','1','--pids-limit','128','--cap-drop','ALL','--security-opt','no-new-privileges:true','--mount',('type=bind,src='+$source+',dst=/library,readonly'),'--mount',('type=bind,src='+$root+',dst=/fixture-report'),'-e','DATABASE_URL=postgres://cotology_app@gargantua-s5-queue-db:5432/library','-e','LIBRARY_DIR=/library','-e','CLAM_HOST=clamav','-e','CLAM_PORT=3310','-e','GARGANTUA_MODEL_LIVE=1','--entrypoint','node',$imageId,'--input-type=module','-e',$bootstrap)|Out-Null;$runnerCreated=$true
 # Only this owned runner joins the scanner network. It never receives Docker
 # socket, host inference spool or production library/database volumes.
 Docker-Checked @('network','connect','cotology_data',$runner)|Out-Null
 Docker-Checked @('start',$runner)|Out-Null
 $finished=$false
 for($n=0;$n -lt 150;$n++){
  $state=Docker-Checked @('inspect','--format','{{json .State}}',$runner)|ConvertFrom-Json
  if($state.Status -eq 'exited'){$finished=$true;if($state.ExitCode -ne 0){throw 'Restored model-result validation failed'};break};Start-Sleep -Seconds 1
 }
 if(-not $finished){throw 'Restored model-result validation exceeded its deadline'}
 $result=Get-Content -LiteralPath (Join-Path $root 'model-queue-report.json') -Raw|ConvertFrom-Json
 if($result.status -ne 'completed' -or -not $result.originalUnchanged -or -not $result.idempotentAndLogicalDuplicateReused){throw 'Model-result assertions were incomplete'}
}catch{$failure=$_.Exception.Message}
finally{
 if($runnerCreated){try{Docker-Checked @('logs',$runner)|Set-Content -LiteralPath (Join-Path $root 'reader.log') -Encoding utf8;Assert-Owned 'container' $runner;Docker-Checked @('rm','-f',$runner)|Out-Null}catch{$cleanup.Add($_.Exception.Message)}}
 if($databaseCreated){try{Assert-Owned 'container' $database;Docker-Checked @('rm','-f',$database)|Out-Null}catch{$cleanup.Add($_.Exception.Message)}}
 if($networkCreated){try{Assert-Owned 'network' $network;Docker-Checked @('network','rm',$network)|Out-Null}catch{$cleanup.Add($_.Exception.Message)}}
 $report=@{status=if($failure -or $cleanup.Count){'failed'}else{'passed'};createdAt=[DateTimeOffset]::UtcNow.ToString('o');scope='REAL_RESTORE_OF_PREVIOUS_MODEL_OUTPUTS_PLUS_NEW_READER_PROTOCOL_AND_FRESH_SCAN_NOT_MODEL_REGENERATION';imageId=$imageId;productionDatabaseUsed=$false;productionLibraryMounted=$false;hostExecutorChanged=$false;modelGenerationRepeated=$false;originalModelProof=(Join-Path $sourceReport 'model-queue-report.json');sourceSnapshot=$source;error=$failure;cleanupErrors=$cleanup.ToArray()}
 [IO.File]::WriteAllText((Join-Path $root 'report.json'),($report|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))
}
if($failure -or $cleanup.Count){throw ('Restore acceptance failed; private reports: '+$root)}
Write-Output ('Restored model output acceptance passed: '+$root)
