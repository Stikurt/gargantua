[CmdletBinding()]
param([string]$Image='869beb94')
$ErrorActionPreference='Stop'
$PSNativeCommandUseErrorActionPreference=$false
$project=[IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$dockerPath=(Get-Command docker -CommandType Application -ErrorAction Stop).Source
$token=[Guid]::NewGuid().ToString('N');$network='gargantua-probe-check-'+$token;$database='gargantua-probe-pg-'+$token
$resultRoot=Join-Path $project ('.local/test-results/chapter-batch-verifier-'+$token)
New-Item -ItemType Directory -Path $resultRoot | Out-Null
$networkCreated=$false;$databaseCreated=$false;$failure=$null;$testExit=-1;$output=@();$imageId=$null
function Docker-Checked([string[]]$Arguments){$value=& $dockerPath --context desktop-linux @Arguments 2>&1;if($LASTEXITCODE -ne 0){throw ('Isolated discovery verification failed: '+$Arguments[0])};return (($value|ForEach-Object{[string]$_}) -join "`n").Trim()}
try{
 $imageId=Docker-Checked @('image','inspect','--format','{{.Id}}',$Image)
 Docker-Checked @('network','create','--internal','--label',('gargantua.probe-test='+$token),$network)|Out-Null;$networkCreated=$true
 Docker-Checked @('run','-d','--pull','never','--name',$database,'--label',('gargantua.probe-test='+$token),'--network',$network,'--network-alias','postgres','--read-only','--tmpfs','/var/lib/postgresql/data:size=512m','--tmpfs','/var/run/postgresql','--tmpfs','/tmp','--memory','768m','--cpus','1','--pids-limit','100','-e','POSTGRES_USER=test_runner','-e','POSTGRES_DB=gargantua_test_chapter_batches','-e','POSTGRES_HOST_AUTH_METHOD=trust','postgres:17-bookworm','-c','max_wal_size=128MB','-c','min_wal_size=32MB')|Out-Null;$databaseCreated=$true
 $ready=$false;for($attempt=0;$attempt -lt 30;$attempt++){& $dockerPath --context desktop-linux exec $database pg_isready -h 127.0.0.1 -U test_runner -d gargantua_test_chapter_batches *> $null;if($LASTEXITCODE -eq 0){$ready=$true;break};Start-Sleep -Seconds 1};if(-not $ready){throw 'Disposable discovery PostgreSQL did not become ready'}
 $args=@('run','--rm','--pull','never','--network',$network,'--read-only','--tmpfs','/tmp:size=512m,mode=1777','--memory','512m','--cpus','1','--pids-limit','100','--cap-drop','ALL','--security-opt','no-new-privileges:true','--mount',('type=bind,src='+(Join-Path $project 'scripts')+',dst=/probe,readonly'),'-e','GARGANTUA_TEST_ISOLATED=1','-e','DATABASE_URL=postgres://test_runner@postgres:5432/gargantua_test_chapter_batches','--entrypoint','node',$imageId,'/probe/fixtures/chapter-batch-verifier-selfcheck.mjs')
 $output=@(& $dockerPath --context desktop-linux @args 2>&1);$testExit=$LASTEXITCODE
 [IO.File]::WriteAllText((Join-Path $resultRoot 'fixture.json'),(($output|ForEach-Object{[string]$_}) -join "`n"),[Text.UTF8Encoding]::new($false))
 if($testExit -ne 0){throw 'Isolated chapter batch verifier assertions failed; test output retained'}
 $fixtureResult=($output -join "`n")|ConvertFrom-Json
 if($fixtureResult.ok -ne $true -or $fixtureResult.reports.Count -ne 12 -or @($fixtureResult.reports|Where-Object{$_.ok -ne $true}).Count -ne 0){throw 'Expected twelve successful verifier fixture scenarios'}
}catch{$failure=$_.Exception.Message}
finally{
 if($databaseCreated){try{if((Docker-Checked @('inspect','--format','{{index .Config.Labels "gargantua.probe-test"}}',$database)) -ne $token){throw 'Disposable database ownership mismatch'};Docker-Checked @('rm','-f',$database)|Out-Null}catch{$failure=($failure+'; '+$_.Exception.Message).Trim('; ')}}
 if($networkCreated){try{if((Docker-Checked @('network','inspect','--format','{{index .Labels "gargantua.probe-test"}}',$network)) -ne $token){throw 'Disposable network ownership mismatch'};Docker-Checked @('network','rm',$network)|Out-Null}catch{$failure=($failure+'; '+$_.Exception.Message).Trim('; ')}}
 $counts=@{};foreach($name in @('tests','pass','fail','skipped')){if(($output -join "`n") -match ('(?m)^# '+$name+' (\d+)\s*$')){$counts[$name]=[int]$Matches[1]}}
 $fingerprints=@{};foreach($name in @('server/derived-selection.mjs','server/derived-jobs.mjs','server/discovery-requests.mjs','server/discovery-api.mjs','server/derived-api.mjs','server/derived-plan.mjs','server/derived-audio-plan.mjs','server/derived-orchestrator.mjs','tests/ranobe-adapter.test.mjs','tests/discovery-language.test.mjs','tests/derived-orchestrator.integration.test.mjs','tests/fixtures/derived-selection-v2.json','scripts/verify-chapter-batch.mjs','scripts/fixtures/chapter-batch-verifier-selfcheck.mjs')){$fingerprints[$name]=(Get-FileHash -LiteralPath (Join-Path $project $name) -Algorithm SHA256).Hash.ToLowerInvariant()}
 if($fixtureResult){$counts=@{scenarios=$fixtureResult.reports.Count;pass=@($fixtureResult.reports|Where-Object{$_.ok -eq $true}).Count;fail=@($fixtureResult.reports|Where-Object{$_.ok -ne $true}).Count}}
 $report=@{status=if($failure){'failed'}else{'passed'};scope='ISOLATED_POSTGRES_AND_DURABLE_PUBLICATION_FIXTURES';createdAt=[DateTimeOffset]::UtcNow.ToString('o');imageId=$imageId;sourceOverlay=$false;exitCode=$testExit;counts=$counts;error=$failure;productionDatabaseUsed=$false;externalNetwork=$false;freshModelInference=$false;sourceFingerprints=$fingerprints;ownedResourcesRemoved=(-not $failure)}
 [IO.File]::WriteAllText((Join-Path $resultRoot 'report.json'),($report|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
}
Write-Host ('Chapter batch verifier selfcheck: '+$resultRoot)
if($failure){throw $failure}
Write-Host ($counts|ConvertTo-Json -Compress)
