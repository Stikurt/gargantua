[CmdletBinding()]
param([string]$Destination='releases/Cotology-Windows',[string]$Image='')
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'backup-common.ps1')
$workspace=[IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent));Set-Location $workspace
$token=[Guid]::NewGuid().ToString('N')
$releases=[IO.Path]::GetFullPath((Join-Path $workspace 'releases'))
function Assert-ReleaseTarget([string]$Target){
    $resolved=[IO.Path]::GetFullPath($Target)
    if(-not $resolved.StartsWith($releases+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Каталог сборки должен находиться внутри releases проекта.'}
    Assert-GargantuaNoReparseAncestors -Path $resolved
    return $resolved
}
$releaseRoot=Assert-ReleaseTarget ([IO.Path]::GetFullPath((Join-Path $workspace $Destination)))
$stage=Assert-ReleaseTarget ($releaseRoot+'.building-'+$token)
$previous=Assert-ReleaseTarget ($releaseRoot+'.previous-'+$token)
if(Test-Path -LiteralPath $stage){throw 'Временная папка сборки уже существует.'}
$running=Get-Process Cotology -ErrorAction SilentlyContinue|Where-Object{$_.Path -and $_.Path.Equals((Join-Path $releaseRoot 'Cotology.exe'),[StringComparison]::OrdinalIgnoreCase)}
if($running){throw 'Закройте приложение в целевой папке перед заменой сборки.'}
$runtime=Get-Content -LiteralPath (Join-Path $workspace 'desktop/runtime.json') -Raw -Encoding UTF8|ConvertFrom-Json
if($runtime.version -notmatch '^\d+\.\d+\.\d+$' -or $runtime.sha256 -notmatch '^[a-f0-9]{64}$'){throw 'Неверная закреплённая версия runtime.'}
$runtimeZip=Join-Path $workspace ('.local/electron-cache/electron-v'+$runtime.version+'-win32-x64.zip')
Assert-GargantuaNoReparseAncestors -Path $runtimeZip
if(-not(Test-Path -LiteralPath $runtimeZip -PathType Leaf)){
    New-Item -ItemType Directory -Force -Path (Split-Path $runtimeZip -Parent)|Out-Null
    $download=$runtimeZip+'.download-'+$token
    Invoke-WebRequest -Uri $runtime.source -OutFile $download -TimeoutSec 300
    if((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToLowerInvariant() -ne $runtime.sha256){throw 'Не совпал SHA-256 загруженного runtime.'}
    Move-Item -LiteralPath $download -Destination $runtimeZip
}
if((Get-FileHash -LiteralPath $runtimeZip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $runtime.sha256){throw 'Не совпал SHA-256 runtime.'}
if(-not $Image){
    # The installed server may intentionally carry an older web interface.
    # Build the current sources without replacing or restarting that server.
    $Image='cotology-app:desktop-ui'
    Invoke-GargantuaDocker -Operation 'build current desktop UI sources' -Arguments @('build','--pull=false','-t',$Image,$workspace) -TimeoutSeconds 600|Out-Null
}
$imageId=(Invoke-GargantuaDocker -Operation 'confirm local desktop image' -Arguments @('image','inspect','--format','{{.Id}}',$Image)).Trim()
if($imageId -notmatch '^sha256:[a-f0-9]{64}$'){throw 'Не удалось закрепить образ интерфейса.'}
$copyContainer=$null;$previousMoved=$false;$promoted=$false
try{
    New-Item -ItemType Directory -Force -Path (Split-Path $stage -Parent)|Out-Null
    New-Item -ItemType Directory -Path $stage|Out-Null
    # Start from the verified runtime archive; no previous JS/CSS is inherited.
    Expand-Archive -LiteralPath $runtimeZip -DestinationPath $stage
    Move-Item -LiteralPath (Join-Path $stage 'electron.exe') -Destination (Join-Path $stage 'Cotology.exe')
    $appRoot=Join-Path $stage 'resources/app'
    New-Item -ItemType Directory -Path $appRoot,(Join-Path $appRoot 'dist'),(Join-Path $appRoot 'selfcheck')|Out-Null
    foreach($file in @('package.json','main.cjs','preload.cjs','store.cjs','sqlite-store.cjs','close-coordinator.cjs','audio-store.cjs','audio-service.cjs')){
        $source=Join-Path $workspace ('desktop/'+$file);Assert-GargantuaNoReparseAncestors -Path $source
        Copy-Item -LiteralPath $source -Destination $appRoot
    }
    Copy-Item -LiteralPath (Join-Path $workspace 'src/audio.mjs') -Destination (Join-Path $appRoot 'audio.mjs')
    foreach($file in Get-ChildItem -LiteralPath (Join-Path $workspace 'desktop/selfcheck') -File){Assert-GargantuaNoReparseAncestors -Path $file.FullName;Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $appRoot 'selfcheck')}
    $copyContainer=(Invoke-GargantuaDocker -Operation 'open immutable desktop UI image' -Arguments @('create','--pull','never','--network','none','--read-only','--label',('org.gargantua.desktop-build='+$token),$imageId)).Trim()
    if($copyContainer -notmatch '^[a-f0-9]{64}$'){throw 'Неизвестный контейнер сборки.'}
    Invoke-GargantuaDocker -Operation 'copy fresh desktop UI bundle' -Arguments @('cp',($copyContainer+':/app/dist/.'),(Join-Path $appRoot 'dist'))|Out-Null
    $package=Get-Content -LiteralPath (Join-Path $appRoot 'package.json') -Raw -Encoding UTF8|ConvertFrom-Json
    $builtAt=[DateTimeOffset]::UtcNow.ToString('o')
    Write-GargantuaJson -Path (Join-Path $stage 'build-info.json') -Value @{schemaVersion=2;runtimeVersion=$runtime.version;runtimeArchiveSha256=$runtime.sha256;builtAt=$builtAt;applicationVersion=$package.version;productName=$package.productName;appImageId=$imageId;userDataIdentity='Cotology';executable='Cotology.exe';freshBundle=$true}
    $files=[Collections.Generic.List[object]]::new()
    foreach($file in Get-ChildItem -LiteralPath $stage -Recurse -Force -File|Sort-Object FullName){
        Assert-GargantuaNoReparseAncestors -Path $file.FullName
        $files.Add(@{path=[IO.Path]::GetRelativePath($stage,$file.FullName).Replace('\','/');bytes=$file.Length;sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()})
    }
    $manifestPath=Join-Path $stage 'release-manifest.json'
    Write-GargantuaJson -Path $manifestPath -Value @{schemaVersion=1;kind='gargantua-desktop-release';status='complete';builtAt=$builtAt;applicationVersion=$package.version;runtimeArchiveSha256=$runtime.sha256;appImageId=$imageId;files=$files.ToArray();excluded=@('release-manifest.json','release-manifest.sha256')}
    $manifestSha=(Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText((Join-Path $stage 'release-manifest.sha256'),($manifestSha+"  release-manifest.json`n"),[Text.UTF8Encoding]::new($false))
    foreach($file in $files){
        $actual=Get-Item -LiteralPath (Join-Path $stage $file.path)
        if($actual.Length -ne $file.bytes -or (Get-FileHash -LiteralPath $actual.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256){throw 'Проверка файлов собранного приложения не пройдена.'}
    }
    if(Test-Path -LiteralPath $releaseRoot){$null=Assert-ReleaseTarget $releaseRoot;$null=Assert-ReleaseTarget $previous;Move-Item -LiteralPath $releaseRoot -Destination $previous;$previousMoved=$true}
    try{$null=Assert-ReleaseTarget $stage;$null=Assert-ReleaseTarget $releaseRoot;Move-Item -LiteralPath $stage -Destination $releaseRoot;$promoted=$true}
    catch{if($previousMoved -and -not(Test-Path -LiteralPath $releaseRoot)){Move-Item -LiteralPath $previous -Destination $releaseRoot;$previousMoved=$false};throw}
    Write-Host ('Windows-приложение: '+(Join-Path $releaseRoot 'Cotology.exe'))
    Write-Host ('Проверены все файлы сборки; manifest SHA-256: '+$manifestSha)
    if($previousMoved){Write-Host ('Прежняя сборка сохранена: '+$previous)}
    Write-Host 'Папка данных Cotology сохранена. Первый запуск проверит миграцию библиотеки в storage-v2.'
}catch{
    if(-not $promoted -and (Test-Path -LiteralPath $stage)){Write-GargantuaJson -Path (Join-Path $stage 'build-failed.json') -Value @{schemaVersion=1;status='incomplete';token=$token;previousReleasePreserved=$true;error=$_.Exception.Message}}
    throw
}finally{
    if($copyContainer){
        $owner=(Invoke-GargantuaDocker -Operation 'verify own desktop build container' -Arguments @('inspect','--format','{{index .Config.Labels "org.gargantua.desktop-build"}}',$copyContainer)).Trim()
        if($owner -ne $token){throw 'Контейнер сборки имеет другую метку; удаление отменено.'}
        Invoke-GargantuaDocker -Operation 'remove only own desktop build container' -Arguments @('rm',$copyContainer)|Out-Null
    }
}
