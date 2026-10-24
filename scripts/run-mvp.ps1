$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
Set-Location -LiteralPath $project
$exe=Join-Path $project 'releases/Gargantua-MVP/Gargantua.exe'
if(-not(Test-Path -LiteralPath $exe)){ & (Join-Path $PSScriptRoot 'build-mvp.ps1') }
docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
if($LASTEXITCODE -ne 0){
  $dockerApp=Join-Path $env:LOCALAPPDATA 'Programs/DockerDesktop/Docker Desktop.exe'
  if(Test-Path -LiteralPath $dockerApp){
    Start-Process -FilePath $dockerApp -ArgumentList '--background' -WindowStyle Hidden
    for($attempt=0;$attempt -lt 45;$attempt++){
      Start-Sleep -Seconds 1
      docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
      if($LASTEXITCODE -eq 0){break}
    }
  }
}
if($LASTEXITCODE -eq 0){
  docker compose up -d
  if($LASTEXITCODE -ne 0){throw 'Не удалось запустить сервер Гаргантюа.'}
  for($attempt=0;$attempt -lt 30;$attempt++){
    try{$health=Invoke-RestMethod -Uri 'http://127.0.0.1:3080/api/mvp/health' -TimeoutSec 2;if($health.ok){break}}catch{}
    Start-Sleep -Seconds 1
  }
}
Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe -Parent)
