[CmdletBinding()]
param([string]$Image='cotology-app:local')
$ErrorActionPreference='Stop'
$PSNativeCommandUseErrorActionPreference=$false
$project=[IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$dockerPath=(Get-Command docker -CommandType Application -ErrorAction Stop).Source
$token=[Guid]::NewGuid().ToString('N');$network='gargantua-discovery-check-'+$token;$database='gargantua-discovery-pg-'+$token
$resultRoot=Join-Path $project ('.local/test-results/discovery-language-'+$token)
New-Item -ItemType Directory -Path $resultRoot | Out-Null
$networkCreated=$false;$databaseCreated=$false;$failure=$null;$testExit=-1;$output=@();$imageId=$null
function Docker-Checked([string[]]$Arguments){$value=& $dockerPath --context desktop-linux @Arguments 2>&1;if($LASTEXITCODE -ne 0){throw ('Isolated discovery verification failed: '+$Arguments[0])};return (($value|ForEach-Object{[string]$_}) -join "`n").Trim()}
try{
 $imageId=Docker-Checked @('image','inspect','--format','{{.Id}}',$Image)
 Docker-Checked @('network','create','--internal','--label',('gargantua.discovery-test='+$token),$network)|Out-Null;$networkCreated=$true
 Docker-Checked @('run','-d','--pull','never','--name',$database,'--label',('gargantua.discovery-test='+$token),'--network',$network,'--network-alias','postgres','--read-only','--tmpfs','/var/lib/postgresql/data:size=512m','--tmpfs','/var/run/postgresql','--tmpfs','/tmp','--memory','768m','--cpus','1','--pids-limit','100','-e','POSTGRES_USER=test_runner','-e','POSTGRES_DB=gargantua_test_discovery','-e','POSTGRES_HOST_AUTH_METHOD=trust','postgres:17-bookworm','-c','max_wal_size=128MB','-c','min_wal_size=32MB')|Out-Null;$databaseCreated=$true
 $ready=$false;for($attempt=0;$attempt -lt 30;$attempt++){& $dockerPath --context desktop-linux exec $database pg_isready -h 127.0.0.1 -U test_runner -d gargantua_test_discovery *> $null;if($LASTEXITCODE -eq 0){$ready=$true;break};Start-Sleep -Seconds 1};if(-not $ready){throw 'Disposable discovery PostgreSQL did not become ready'}
 $args=@('run','--rm','--pull','never','--network',$network,'--read-only','--tmpfs','/tmp:size=1g,mode=1777','--memory','768m','--cpus','2','--pids-limit','128','--cap-drop','ALL','--security-opt','no-new-privileges:true','--mount',('type=bind,src='+(Join-Path $project 'server')+',dst=/app/server,readonly'),'--mount',('type=bind,src='+(Join-Path $project 'tests')+',dst=/app/tests,readonly'),'-e','GARGANTUA_TEST_ISOLATED=1','-e','TEST_DATABASE_URL=postgres://test_runner@postgres:5432/gargantua_test_discovery','--entrypoint','node',$imageId,'--test','--test-concurrency=1','--test-reporter=tap','tests/discovery-language.test.mjs','tests/ranobe-adapter.test.mjs','tests/ranobe-acquisition.integration.mjs','tests/derived-orchestrator.integration.test.mjs','tests/discovery-orchestrator.integration.mjs')
 $output=@(& $dockerPath --context desktop-linux @args 2>&1);$testExit=$LASTEXITCODE
 [IO.File]::WriteAllText((Join-Path $resultRoot 'tests.tap'),(($output|ForEach-Object{[string]$_}) -join "`n"),[Text.UTF8Encoding]::new($false))
 if($testExit -ne 0){throw 'Isolated discovery/language assertions failed; test output retained'}
}catch{$failure=$_.Exception.Message}
finally{
 if($databaseCreated){try{if((Docker-Checked @('inspect','--format','{{index .Config.Labels "gargantua.discovery-test"}}',$database)) -ne $token){throw 'Disposable database ownership mismatch'};Docker-Checked @('rm','-f',$database)|Out-Null}catch{$failure=($failure+'; '+$_.Exception.Message).Trim('; ')}}
 if($networkCreated){try{if((Docker-Checked @('network','inspect','--format','{{index .Labels "gargantua.discovery-test"}}',$network)) -ne $token){throw 'Disposable network ownership mismatch'};Docker-Checked @('network','rm',$network)|Out-Null}catch{$failure=($failure+'; '+$_.Exception.Message).Trim('; ')}}
 $counts=@{};foreach($name in @('tests','pass','fail','skipped')){if(($output -join "`n") -match ('(?m)^# '+$name+' (\d+)\s*$')){$counts[$name]=[int]$Matches[1]}}
 $fingerprints=@{};foreach($name in @('server/ranobe.mjs','server/ranobe-acquisition.mjs','server/discovery-language.mjs','server/derived-orchestrator.mjs','tests/ranobe-adapter.test.mjs','tests/discovery-language.test.mjs','tests/derived-orchestrator.integration.test.mjs','tests/fixtures/discovery-language-samples.mjs')){$fingerprints[$name]=(Get-FileHash -LiteralPath (Join-Path $project $name) -Algorithm SHA256).Hash.ToLowerInvariant()}
 $report=@{status=if($failure){'failed'}else{'passed'};scope='ISOLATED_POSTGRES_AND_DURABLE_PUBLICATION_FIXTURES';createdAt=[DateTimeOffset]::UtcNow.ToString('o');imageId=$imageId;sourceOverlay=$true;exitCode=$testExit;counts=$counts;error=$failure;productionDatabaseUsed=$false;externalNetwork=$false;freshModelInference=$false;sourceFingerprints=$fingerprints;ownedResourcesRemoved=(-not $failure)}
 [IO.File]::WriteAllText((Join-Path $resultRoot 'report.json'),($report|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
}
Write-Host ('Discovery/language verification: '+$resultRoot)
if($failure){throw $failure}
Write-Host ($counts|ConvertTo-Json -Compress)
