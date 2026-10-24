[CmdletBinding()]
param([switch]$SkipImageBuild, [string]$Image='gargantua-mvp:local')
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
Set-Location -LiteralPath $project
$release=[IO.Path]::GetFullPath((Join-Path $project 'releases/Gargantua-MVP'))
$executable=Join-Path $release 'Gargantua.exe'
if(Get-Process Gargantua -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $executable }) {throw 'Закройте Гаргантюа перед пересборкой.'}
$runtime=Get-Content -LiteralPath (Join-Path $project 'desktop/runtime.json') -Raw | ConvertFrom-Json
$archive=Join-Path $project ('.local/electron-cache/electron-v'+$runtime.version+'-win32-x64.zip')
if(-not(Test-Path -LiteralPath $archive)){throw 'Отсутствует ранее загруженный Electron runtime.'}
if((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $runtime.sha256){throw 'Поврежден архив Electron runtime.'}
if(-not $SkipImageBuild){docker compose build; if($LASTEXITCODE -ne 0){throw 'Не удалось собрать MVP.'}}
if(-not(Test-Path -LiteralPath $executable)){
  New-Item -ItemType Directory -Force -Path $release | Out-Null
  Expand-Archive -LiteralPath $archive -DestinationPath $release -Force
  Move-Item -LiteralPath (Join-Path $release 'electron.exe') -Destination $executable
}
$application=Join-Path $release 'resources/app'
New-Item -ItemType Directory -Force -Path $application | Out-Null
Copy-Item -LiteralPath (Join-Path $project 'desktop/mvp-main.cjs'),(Join-Path $project 'desktop/mvp-preload.cjs'),(Join-Path $project 'desktop/close-coordinator.cjs') -Destination $application
[IO.File]::WriteAllText((Join-Path $application 'package.json'),'{"name":"gargantua-mvp","productName":"Гаргантюа","version":"0.7.1","main":"mvp-main.cjs","private":true}',[Text.UTF8Encoding]::new($false))
$container=docker create --network none $Image
if($LASTEXITCODE -ne 0){throw 'Образ MVP не найден.'}
try {
  docker cp ($container+':/app/dist') $application
  if($LASTEXITCODE -ne 0){throw 'Не удалось скопировать интерфейс MVP.'}
} finally {docker rm $container | Out-Null}
$build=@{version='0.7.1';builtAt=[DateTimeOffset]::UtcNow.ToString('o');runtimeVersion=$runtime.version;runtimeSha256=$runtime.sha256;executable='Gargantua.exe';profile='Gargantua-MVP'}
$build | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $release 'build-info.json') -Encoding utf8
Write-Output ('Готово: '+$executable)
