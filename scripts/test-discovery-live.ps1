param([string]$Image='cotology-app:search-next')
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$token=[Guid]::NewGuid().ToString('N');$name='gargantua-test-search-live-'+$token
$root=Join-Path $project ('.local/test-results/discovery-live-'+$token)
New-Item -ItemType Directory -Path $root|Out-Null
$created=$false;$failure=$null;$imageId=$null
function Docker-Checked([string[]]$Arguments){$output=& docker @Arguments 2>&1;if($LASTEXITCODE -ne 0){throw ('Metadata acceptance Docker operation failed: '+$Arguments[0])};return ($output -join "`n").Trim()}
try{
 $imageId=Docker-Checked @('image','inspect','--format','{{.Id}}',$Image)
 Docker-Checked @('create','--pull','never','--name',$name,'--label',('gargantua.metadata-probe='+$token),'--network','bridge','--read-only','--tmpfs','/tmp:size=32m,mode=1777','--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','384m','--cpus','1','--pids-limit','64','--mount',('type=bind,src='+$root+',dst=/probe-report'),'-e','GARGANTUA_METADATA_PROBE=1','--entrypoint','node',$imageId,'tests/discovery-live.acceptance.mjs')|Out-Null;$created=$true
 Docker-Checked @('start',$name)|Out-Null
 $done=$false
 for($attempt=0;$attempt -lt 240;$attempt++){
  $state=(Docker-Checked @('inspect','--format','{{json .State}}',$name))|ConvertFrom-Json
  if($state.Status -eq 'exited'){$done=$true;if($state.ExitCode -ne 0){throw 'Live metadata assertions failed; private report retained'};break};Start-Sleep -Seconds 1
 }
 if(-not $done){throw 'Metadata acceptance exceeded the finite run budget'}
 $report=Get-Content -LiteralPath (Join-Path $root 'report.json') -Raw|ConvertFrom-Json
 if(-not $report.ok){throw 'Metadata acceptance did not confirm expected cases'}
}catch{$failure=$_.Exception.Message}
finally{
 if($created){try{if((Docker-Checked @('inspect','--format','{{index .Config.Labels "gargantua.metadata-probe"}}',$name)) -ne $token){throw 'Metadata probe ownership mismatch'};Docker-Checked @('rm','-f',$name)|Out-Null}catch{$failure=($failure+'; '+$_.Exception.Message).Trim('; ')}}
 [IO.File]::WriteAllText((Join-Path $root 'harness.json'),(@{ok=(-not $failure);imageId=$imageId;error=$failure;productionAccess=$false;bookDownloads=0;createdAt=[DateTimeOffset]::UtcNow.ToString('o')}|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
}
if($failure){throw $failure}
Write-Host ('Live metadata acceptance passed: '+$root)
