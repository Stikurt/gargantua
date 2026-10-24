[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Image)
$ErrorActionPreference='Stop'
$PSNativeCommandUseErrorActionPreference=$false
$project=[IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
Set-Location $project
$token=[Guid]::NewGuid().ToString('N')
$network='gargantua-packed-audio-'+$token
$database='gargantua-packed-pg-'+$token
$resultRoot=Join-Path $project ('.local/test-results/packed-audio-pg-'+$token)
New-Item -ItemType Directory -Path $resultRoot | Out-Null
$networkCreated=$false;$databaseCreated=$false;$failure=$null;$testExit=-1;$output=@();$imageId=$null
$sourceFiles=@('server/derived-audio-plan.mjs','server/derived-plan.mjs','server/derived-orchestrator.mjs','server/derived-jobs.mjs','server/derived-files.mjs','scripts/narration-preflight.mjs','tests/derived-audio-plan.test.mjs','tests/derived-segmentation.test.mjs','tests/narration-preflight.test.mjs','tests/derived-orchestrator.integration.test.mjs','inference/profiles.json')
function Fingerprints { $values=@{};foreach($file in $sourceFiles){$values[$file]=(Get-FileHash -LiteralPath (Join-Path $project $file) -Algorithm SHA256).Hash.ToLowerInvariant()};return $values }
$before=Fingerprints
function Docker-Checked([string[]]$DockerArgs){$value=& docker --context desktop-linux @DockerArgs 2>&1;if($LASTEXITCODE -ne 0){throw ('Packed audio test Docker operation failed: '+$DockerArgs[0])};return (($value|ForEach-Object{[string]$_}) -join "`n")}
try{
 $imageId=(Docker-Checked @('image','inspect','--format','{{.Id}}',$Image)).Trim()
 Docker-Checked @('network','create','--internal','--label',('gargantua.test='+$token),$network)|Out-Null;$networkCreated=$true
 Docker-Checked @('run','-d','--pull','never','--name',$database,'--label',('gargantua.test='+$token),'--network',$network,'--network-alias','postgres','--read-only','--tmpfs','/var/lib/postgresql/data:size=512m','--tmpfs','/var/run/postgresql','--tmpfs','/tmp','--memory','768m','--cpus','1','--pids-limit','100','-e','POSTGRES_USER=test_runner','-e','POSTGRES_DB=gargantua_test_packed','-e','POSTGRES_HOST_AUTH_METHOD=trust','postgres:17-bookworm','-c','max_wal_size=128MB','-c','min_wal_size=32MB')|Out-Null;$databaseCreated=$true
 $ready=$false;for($attempt=0;$attempt -lt 30;$attempt++){& docker --context desktop-linux exec $database pg_isready -h 127.0.0.1 -U test_runner -d gargantua_test_packed *> $null;if($LASTEXITCODE -eq 0){$ready=$true;break};Start-Sleep -Seconds 1};if(-not $ready){throw 'Disposable PostgreSQL readiness timeout'}
 $arguments=@('run','--rm','--pull','never','--network',$network,'--read-only','--tmpfs','/tmp:size=1g,mode=1777','--memory','512m','--cpus','2','--pids-limit','128','--cap-drop','ALL','--security-opt','no-new-privileges:true')
 foreach($name in @('server','tests','scripts','inference')){$arguments+=@('--mount',('type=bind,src='+(Join-Path $project $name)+',dst=/app/'+$name+',readonly'))}
 $arguments+=@('-e','GARGANTUA_TEST_ISOLATED=1','-e','TEST_DATABASE_URL=postgres://test_runner@postgres:5432/gargantua_test_packed','--entrypoint','node',$imageId,'--test','--test-concurrency=1','--test-reporter=tap','tests/derived-audio-plan.test.mjs','tests/derived-segmentation.test.mjs','tests/narration-preflight.test.mjs','tests/derived-orchestrator.integration.test.mjs')
 $previous=$ErrorActionPreference;$ErrorActionPreference='Continue';try{$output=@(& docker --context desktop-linux @arguments 2>&1);$testExit=$LASTEXITCODE}finally{$ErrorActionPreference=$previous}
 [IO.File]::WriteAllText((Join-Path $resultRoot 'tests.tap'),(($output|ForEach-Object{[string]$_}) -join "`n"),[Text.UTF8Encoding]::new($false))
 if($testExit -ne 0){throw 'Packed audio isolated PostgreSQL tests failed'}
}catch{$failure=$_.Exception.Message}
finally{
 if($databaseCreated){try{if((Docker-Checked @('inspect','--format','{{index .Config.Labels "gargantua.test"}}',$database)).Trim() -ne $token){throw 'Test container ownership mismatch'};Docker-Checked @('rm','-f',$database)|Out-Null}catch{$failure=($failure+'; '+$_.Exception.Message).Trim('; ')}}
 if($networkCreated){try{if((Docker-Checked @('network','inspect','--format','{{index .Labels "gargantua.test"}}',$network)).Trim() -ne $token){throw 'Test network ownership mismatch'};Docker-Checked @('network','rm',$network)|Out-Null}catch{$failure=($failure+'; '+$_.Exception.Message).Trim('; ')}}
 $after=Fingerprints;$sourceStable=$true;foreach($file in $sourceFiles){if($before[$file] -ne $after[$file]){$sourceStable=$false}};if(-not $sourceStable){$failure=($failure+'; Source changed while bind-mounted tests were running').Trim('; ')}
 $counts=@{};foreach($name in @('tests','pass','fail','skipped')){if(($output -join "`n") -match ('(?m)^# '+$name+' (\d+)\s*$')){$counts[$name]=[int]$Matches[1]}}
 $report=@{status=if($failure){'FAIL'}else{'PASS'};scope='REAL_ISOLATED_POSTGRES_AND_SPOOL_WITH_SYNTHETIC_PROVIDER_NO_MODEL_OR_AV_CLAIM';completedAt=[DateTimeOffset]::UtcNow.ToString('o');imageId=$imageId;exitCode=$testExit;counts=$counts;productionDatabaseUsed=$false;externalNetwork=$false;actualInferenceRun=$false;bindMountedSources=$true;sourceStable=$sourceStable;sourceFingerprintsBefore=$before;sourceFingerprintsAfter=$after;error=$failure}
 [IO.File]::WriteAllText((Join-Path $resultRoot 'report.json'),($report|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
}
if($failure){throw ($failure+'; report: '+$resultRoot)}
Write-Host ('Packed audio PostgreSQL verification passed: '+$resultRoot)
Write-Host ($counts|ConvertTo-Json -Compress)
