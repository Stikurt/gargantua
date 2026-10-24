[CmdletBinding()]
param([string]$Image='cotology-app:core11-candidate')
$ErrorActionPreference='Stop'
$workspace=[IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$docker=Join-Path $env:LOCALAPPDATA 'Programs/DockerDesktop/resources/bin/docker.exe'
$token=[Guid]::NewGuid().ToString('N');$database='gargantua-serial-pg-'+$token;$network='gargantua-serial-net-'+$token
$root=Join-Path $workspace ('.local/test-results/server-serial-groups-'+$token)
[IO.Directory]::CreateDirectory($root)|Out-Null
$createdNetwork=$false;$createdDatabase=$false;$failure=$null;$output=@();$exit=-1
function Invoke-Checked([string[]]$Arguments){$value=@(& $docker --context desktop-linux @Arguments 2>&1);if($LASTEXITCODE){throw ('Isolated test operation failed: '+$Arguments[0])};return ($value -join "`n")}
$files=@('server/app.mjs','server/serial-groups.mjs','tests/server-serial-groups.test.mjs','tests/ranobe-store.integration.mjs','tests/ranobe-api.integration.mjs')
$fingerprints=@{};foreach($file in $files){$fingerprints[$file]=(Get-FileHash -LiteralPath (Join-Path $workspace $file) -Algorithm SHA256).Hash.ToLowerInvariant()}
try{
 $imageId=(Invoke-Checked @('image','inspect','--format','{{.Id}}',$Image)).Trim()
 Invoke-Checked @('network','create','--internal','--label',('gargantua.test='+$token),$network)|Out-Null;$createdNetwork=$true
 Invoke-Checked @('run','-d','--pull','never','--name',$database,'--label',('gargantua.test='+$token),'--network',$network,'--network-alias','postgres','--read-only','--tmpfs','/var/lib/postgresql/data:size=512m','--tmpfs','/var/run/postgresql','--tmpfs','/tmp','--memory','768m','--cpus','1','--pids-limit','100','-e','POSTGRES_USER=test_runner','-e','POSTGRES_DB=gargantua_test_serial','-e','POSTGRES_HOST_AUTH_METHOD=trust','postgres:17-bookworm','-c','max_wal_size=128MB','-c','min_wal_size=32MB')|Out-Null;$createdDatabase=$true
 $ready=$false;for($attempt=0;$attempt -lt 30;$attempt++){& $docker --context desktop-linux exec $database pg_isready -h 127.0.0.1 -U test_runner -d gargantua_test_serial *> $null;if($LASTEXITCODE -eq 0){$ready=$true;break};Start-Sleep -Seconds 1};if(-not $ready){throw 'Disposable test database readiness timeout'}
 $arguments=@('run','--rm','--pull','never','--network',$network,'--read-only','--tmpfs','/tmp:size=512m,mode=1777','--memory','512m','--cpus','2','--pids-limit','128')
 foreach($file in $files){$arguments+=@('--mount',('type=bind,src='+(Join-Path $workspace $file)+',dst=/app/'+$file+',readonly'))}
 $arguments+=@('-e','GARGANTUA_TEST_ISOLATED=1','-e','TEST_DATABASE_URL=postgres://test_runner@postgres:5432/gargantua_test_serial','--entrypoint','node',$imageId,'--test','--test-concurrency=1','--test-reporter=tap','tests/server-serial-groups.test.mjs','tests/ranobe-store.integration.mjs','tests/ranobe-api.integration.mjs')
 $output=@(& $docker --context desktop-linux @arguments 2>&1);$exit=$LASTEXITCODE
 [IO.File]::WriteAllText((Join-Path $root 'tests.tap'),($output -join "`n"),[Text.UTF8Encoding]::new($false))
 if($exit){throw 'Serial group PostgreSQL/HTTP tests failed'}
 foreach($file in $files){if((Get-FileHash -LiteralPath (Join-Path $workspace $file) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $fingerprints[$file]){throw 'A tested source changed during the isolated run'}}
}catch{$failure=$_.Exception.Message}
finally{
 if($createdDatabase){try{if((Invoke-Checked @('inspect','--format','{{index .Config.Labels "gargantua.test"}}',$database)).Trim() -ne $token){throw 'Test database ownership mismatch'};Invoke-Checked @('rm','-f',$database)|Out-Null}catch{$failure=($failure+'; '+$_.Exception.Message).Trim('; ')}}
 if($createdNetwork){try{if((Invoke-Checked @('network','inspect','--format','{{index .Labels "gargantua.test"}}',$network)).Trim() -ne $token){throw 'Test network ownership mismatch'};Invoke-Checked @('network','rm',$network)|Out-Null}catch{$failure=($failure+'; '+$_.Exception.Message).Trim('; ')}}
 $counts=@{};foreach($name in @('tests','pass','fail','skipped')){if(($output -join "`n") -match ('(?m)^# '+$name+' (\d+)\s*$')){$counts[$name]=[int]$Matches[1]}}
 $report=@{status=if($failure){'failed'}else{'passed'};scope='ISOLATED_REAL_POSTGRES_AND_AUTHENTICATED_HTTP_WITH_SYNTHETIC_PUBLICATIONS';createdAt=[DateTimeOffset]::UtcNow.ToString('o');imageId=$imageId;counts=$counts;error=$failure;exitCode=$exit;sourceFingerprints=$fingerprints;productionDatabaseUsed=$false;externalNetwork=$false}
 [IO.File]::WriteAllText((Join-Path $root 'report.json'),($report|ConvertTo-Json -Depth 7),[Text.UTF8Encoding]::new($false))
}
if($failure){throw ($failure+'; '+$root)}
Write-Output ('Serial group acceptance passed: '+$root);Write-Output ($counts|ConvertTo-Json -Compress)
