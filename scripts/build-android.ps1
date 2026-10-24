param([string]$Image='')
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$workspacePath = (Get-Location).Path
New-Item -ItemType Directory -Force (Join-Path $workspacePath '.local/android-signing') | Out-Null
& "$PSScriptRoot/protect-local.ps1"
docker build -t cotology-android-builder:local android
if ($LASTEXITCODE -ne 0) { throw 'Не удалось подготовить Android SDK' }
# Copy the exact bundled UI from the running server build, without secrets or book files.
$assetsPath = Join-Path $workspacePath 'android/app/src/main/assets'
New-Item -ItemType Directory -Force $assetsPath | Out-Null
if($Image){
 $copyContainer='cotology-android-copy-'+[guid]::NewGuid().ToString('N').Substring(0,12)
 docker create --name $copyContainer $Image | Out-Null
 if($LASTEXITCODE -ne 0){throw 'Не удалось открыть образ интерфейса'}
 try{docker cp "${copyContainer}:/app/dist/." $assetsPath;if($LASTEXITCODE -ne 0){throw 'Не удалось получить интерфейс для APK'}}finally{docker rm $copyContainer | Out-Null}
}else{docker compose cp app:/app/dist/. $assetsPath;if ($LASTEXITCODE -ne 0) { throw 'Не удалось получить интерфейс для APK' }}
docker run --rm --memory=3g --cpus=2 --mount "type=bind,source=$workspacePath/android,target=/project" --mount 'type=volume,source=cotology_android_gradle,target=/home/gradle/.gradle' --mount "type=bind,source=$workspacePath/.local/android-signing,target=/root/.android" cotology-android-builder:local gradle --no-daemon :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
if ($LASTEXITCODE -ne 0) { throw 'Сборка или проверки APK завершились ошибкой' }
$releasePath = Join-Path $workspacePath 'releases/Cotology-Android'
New-Item -ItemType Directory -Force $releasePath | Out-Null
Copy-Item -LiteralPath 'android/app/build/outputs/apk/debug/app-debug.apk' -Destination (Join-Path $releasePath 'Cotology-preview.apk') -Force
$apkMetadata=Get-Content 'android/app/build/outputs/apk/debug/output-metadata.json' -Raw | ConvertFrom-Json
@{version=$apkMetadata.elements[0].versionName;versionCode=$apkMetadata.elements[0].versionCode;minSdk=$apkMetadata.minSdkVersionForDexing;targetSdk=35;sha256=(Get-FileHash -LiteralPath (Join-Path $releasePath 'Cotology-preview.apk') -Algorithm SHA256).Hash;verifiedOnPhone=$false;builtAt=[DateTimeOffset]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $releasePath 'build-info.json') -Encoding utf8
Get-FileHash -LiteralPath (Join-Path $releasePath 'Cotology-preview.apk') -Algorithm SHA256 | Format-List
Write-Host 'Тестовый APK собран. Подпись debug хранится в .local/android-signing; это ещё не релиз для распространения.'
