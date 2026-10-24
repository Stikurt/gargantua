[CmdletBinding()]
param([string]$Image='cotology-app:core-next')
$ErrorActionPreference='Stop'
$PSNativeCommandUseErrorActionPreference=$false
$project=[IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
Set-Location $project
$token=[Guid]::NewGuid().ToString('N')
$network='gargantua-core-test-'+$token
$database='gargantua-core-pg-'+$token
$resultRoot=Join-Path $project ('.local/test-results/server-core-'+$token)
New-Item -ItemType Directory -Path $resultRoot -Force | Out-Null
$networkCreated=$false;$databaseCreated=$false;$failure=$null;$testExit=-1
$output=@();$imageId=$null
function Docker-Checked([string[]]$DockerArgs){
 $value=& docker @DockerArgs 2>&1
 if($LASTEXITCODE -ne 0){throw ('Test Docker operation failed: '+$DockerArgs[0])}
 return (($value|ForEach-Object{[string]$_}) -join "`n")
}
try{
 $imageId=(Docker-Checked @('image','inspect','--format','{{.Id}}',$Image)).Trim()
 Docker-Checked @('network','create','--internal','--label',('gargantua.test='+$token),$network)|Out-Null;$networkCreated=$true
 Docker-Checked @('run','-d','--pull','never','--name',$database,'--label',('gargantua.test='+$token),'--network',$network,'--network-alias','postgres','--read-only','--tmpfs','/var/lib/postgresql/data:size=512m','--tmpfs','/var/run/postgresql','--tmpfs','/tmp','--memory','768m','--cpus','1','--pids-limit','100','-e','POSTGRES_USER=test_runner','-e','POSTGRES_DB=gargantua_test_core','-e','POSTGRES_HOST_AUTH_METHOD=trust','postgres:17-bookworm','-c','max_wal_size=128MB','-c','min_wal_size=32MB','-c','checkpoint_timeout=30s')|Out-Null;$databaseCreated=$true
 $ready=$false
 for($attempt=0;$attempt -lt 30;$attempt++){
  & docker exec $database pg_isready -h 127.0.0.1 -U test_runner -d gargantua_test_core *> $null
  if($LASTEXITCODE -eq 0){$ready=$true;break};Start-Sleep -Seconds 1
 }
 if(-not $ready){throw 'Disposable PostgreSQL readiness timeout'}
 $testArguments=@('run','--rm','--pull','never','--network',$network,'--read-only','--tmpfs','/tmp:size=1g,mode=1777','--memory','512m','--cpus','2','--pids-limit','128','--mount',('type=bind,src='+(Join-Path $project 'docs/gargantua/api.openapi.json')+',dst=/contract/api.openapi.json,readonly'),'--mount',('type=bind,src='+(Join-Path $project 'docs/gargantua/examples')+',dst=/app/docs/gargantua/examples,readonly'),'-e','TEST_API_SPEC_PATH=/contract/api.openapi.json','-e','GARGANTUA_TEST_ISOLATED=1','-e','TEST_DATABASE_URL=postgres://test_runner@postgres:5432/gargantua_test_core','--entrypoint','node',$imageId,'--test','--test-concurrency=1','--test-reporter=tap','tests/security.test.mjs','tests/local-import.test.mjs','tests/native-store.test.mjs','tests/publication-files.test.mjs','tests/job-files.test.mjs','tests/server-durability.integration.mjs','tests/upload-lifecycle.integration.mjs','tests/admission-lifecycle.test.mjs','tests/admission-lifecycle.integration.mjs','tests/publication-model.test.mjs','tests/fetch-network.test.mjs','tests/scan-network.test.mjs','tests/work-model.integration.mjs','tests/catalog-save.integration.mjs','tests/discovery-providers.test.mjs','tests/discovery-verification.test.mjs','tests/discovery-orchestrator.test.mjs','tests/discovery-requests.integration.mjs','tests/discovery-orchestrator.integration.mjs','tests/ranobe-adapter.test.mjs','tests/ranobe-source-retry.test.mjs','tests/ranobe-publication.test.mjs','tests/ranobe-store.integration.mjs','tests/ranobe-acquisition.integration.mjs','tests/ranobe-api.integration.mjs')
 $testArguments+=@('tests/discovery-library.test.mjs','tests/discovery-provider-adversarial.test.mjs','tests/discovery-whole-publication.test.mjs','tests/discovery-whole-publication.integration.mjs')
 $testArguments+=@('tests/discovery-language.test.mjs','tests/search-query.test.mjs')
 $testArguments+=@('tests/server-serial-groups.test.mjs','tests/serial-groups.test.mjs','tests/serial-reader.test.mjs','tests/chapter-batches.test.mjs','tests/discovery-client.test.mjs','tests/search-query-contract.test.mjs')
 $testArguments+=@('tests/derived-selection.test.mjs','tests/derived-batching.test.mjs')
 $testArguments+=@('tests/derived-plan.test.mjs','tests/derived-audio-plan.test.mjs','tests/derived-safety-files.test.mjs','tests/derived-queue.integration.mjs','tests/derived-orchestrator.integration.test.mjs','tests/derived-api.test.mjs')
 $testArguments+=@('tests/parser-idle.test.mjs','tests/derived-spool.test.mjs')
 $testArguments+=@('tests/audio.test.mjs','tests/audio-engine.test.mjs','tests/native-audio.test.mjs','tests/audio-client-fixture.test.mjs','tests/audio-requests.test.mjs')
 $testArguments+=@('tests/reader-data-model.test.mjs','tests/reader-export.test.mjs','tests/reader-publication.test.mjs','tests/reader-data.integration.mjs','tests/reader-api.integration.mjs','tests/publication-admission.test.mjs')
 # Derived file tests write only to the private, disposable container tmpfs.
 $testArguments=@('run','-e','DERIVED_TEST_ROOT=/tmp/derived-safety-files')+$testArguments[1..($testArguments.Length-1)]
 $previous=$ErrorActionPreference;$ErrorActionPreference='Continue'
 try{$output=@(& docker @testArguments 2>&1);$testExit=$LASTEXITCODE}finally{$ErrorActionPreference=$previous}
 $text=($output|ForEach-Object{[string]$_}) -join "`n"
 [IO.File]::WriteAllText((Join-Path $resultRoot 'tests.tap'),$text,[Text.UTF8Encoding]::new($false))
 if($testExit -ne 0){throw "Core tests failed; private test log retained in $resultRoot"}
}catch{$failure=$_.Exception.Message}
finally{
 if($databaseCreated){
  try{if((Docker-Checked @('inspect','--format','{{index .Config.Labels "gargantua.test"}}',$database)).Trim() -ne $token){throw 'Test container ownership mismatch'};Docker-Checked @('rm','-f',$database)|Out-Null}catch{$failure=($failure+'; '+$_.Exception.Message).Trim('; ')}
 }
 if($networkCreated){
  try{if((Docker-Checked @('network','inspect','--format','{{index .Labels "gargantua.test"}}',$network)).Trim() -ne $token){throw 'Test network ownership mismatch'};Docker-Checked @('network','rm',$network)|Out-Null}catch{$failure=($failure+'; '+$_.Exception.Message).Trim('; ')}
 }
 $counts=@{}
 foreach($name in @('tests','pass','fail','skipped')){if(($output -join "`n") -match ('(?m)^# '+$name+' (\d+)\s*$')){$counts[$name]=[int]$Matches[1]}}
 $report=@{status=if($failure){'failed'}else{'passed'};scope='REAL_ISOLATED_POSTGRES_API_PROCESS_CRASH_AND_MODULE_TESTS_NOT_PRODUCTION';createdAt=[DateTimeOffset]::UtcNow.ToString('o');imageId=$imageId;exitCode=$testExit;counts=$counts;error=$failure;productionDatabaseUsed=$false;externalNetwork=$false;sourceFingerprints=@{}}
 $sourceFiles=@(Get-ChildItem -LiteralPath (Join-Path $project 'server') -Recurse -File | Where-Object { $_.Extension -in @('.mjs','.sql') } | ForEach-Object { [IO.Path]::GetRelativePath($project,$_.FullName).Replace('\','/') })
 $sourceFiles+=@('docs/gargantua/api.openapi.json','tests/server-durability.integration.mjs','tests/work-model.integration.mjs','tests/catalog-save.integration.mjs','tests/publication-model.test.mjs','tests/fetch-network.test.mjs','tests/scan-network.test.mjs','tests/discovery-providers.test.mjs','tests/discovery-verification.test.mjs','tests/discovery-orchestrator.test.mjs','tests/discovery-requests.integration.mjs','tests/discovery-orchestrator.integration.mjs','tests/ranobe-adapter.test.mjs','tests/ranobe-source-retry.test.mjs','tests/ranobe-publication.test.mjs','tests/ranobe-store.integration.mjs','tests/ranobe-acquisition.integration.mjs','tests/ranobe-api.integration.mjs')
 $sourceFiles+=@('tests/discovery-library.test.mjs','tests/discovery-provider-adversarial.test.mjs','tests/discovery-whole-publication.test.mjs','tests/discovery-whole-publication.integration.mjs')
 $sourceFiles+=@('tests/discovery-language.test.mjs','tests/fixtures/discovery-language-samples.mjs','src/search-query.mjs','tests/search-query.test.mjs')
 $sourceFiles+=@('src/chapter-batches.mjs','src/serial-groups.mjs','src/serial-reader.mjs','src/discovery-client.mjs','src/discovery-delivery.mjs','tests/server-serial-groups.test.mjs','tests/serial-groups.test.mjs','tests/serial-reader.test.mjs','tests/chapter-batches.test.mjs','tests/discovery-client.test.mjs','tests/search-query-contract.test.mjs','tests/derived-selection.test.mjs','tests/derived-batching.test.mjs')
 $sourceFiles+=@('inference/profiles.json','tests/derived-plan.test.mjs','tests/derived-audio-plan.test.mjs','tests/derived-safety-files.test.mjs','tests/derived-queue.integration.mjs','tests/derived-orchestrator.integration.test.mjs','tests/derived-api.test.mjs')
 $sourceFiles+=@('tests/parser-idle.test.mjs','tests/derived-spool.test.mjs')
 $sourceFiles+=@('docs/gargantua/examples/locator-v2.json','tests/reader-data-model.test.mjs','tests/reader-export.test.mjs','tests/reader-publication.test.mjs','tests/reader-data.integration.mjs','tests/reader-api.integration.mjs','tests/publication-admission.test.mjs')
 foreach($file in $sourceFiles){$report.sourceFingerprints[$file]=(Get-FileHash -LiteralPath (Join-Path $project $file) -Algorithm SHA256).Hash.ToLowerInvariant()}
 [IO.File]::WriteAllText((Join-Path $resultRoot 'report.json'),($report|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))
}
if($failure){throw $failure}
Write-Host ('Core verification passed: '+$resultRoot)
Write-Host ($counts|ConvertTo-Json -Compress)
