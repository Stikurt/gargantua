[CmdletBinding()]
param([switch]$SkipUiBuild, [switch]$SkipBuilderBuild)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
Set-Location -LiteralPath $projectRoot
$assetsRoot = Join-Path $projectRoot 'android/mvp/src/main/assets'
$signingRoot = Join-Path $projectRoot '.local/android-mvp-signing'
$releaseRoot = Join-Path $projectRoot 'releases/Gargantua-Android'
New-Item -ItemType Directory -Force -Path $assetsRoot,$signingRoot,$releaseRoot | Out-Null

if (-not $SkipUiBuild) {
    docker build --target build -t gargantua-mobile-ui:local .
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось собрать интерфейс телефона.' }
}
if (-not $SkipBuilderBuild) {
    docker build -t cotology-android-builder:local android
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось подготовить Android SDK.' }
}
if (-not (Test-Path -LiteralPath (Join-Path $assetsRoot 'native-bridge.js'))) {
    throw 'Отсутствует мост Android native-bridge.js.'
}

# Copy only the active MVP application; legacy audio/browser bundles are excluded.
$copyContainer = docker create --network none gargantua-mobile-ui:local
if ($LASTEXITCODE -ne 0) { throw 'Не удалось открыть собранный интерфейс.' }
try {
    $generatedAssets = [IO.Path]::GetFullPath((Join-Path $assetsRoot 'assets'))
    $expectedAssets = [IO.Path]::GetFullPath((Join-Path $projectRoot 'android/mvp/src/main/assets/assets'))
    if ($generatedAssets -ne $expectedAssets -or -not $generatedAssets.StartsWith([IO.Path]::GetFullPath($assetsRoot) + [IO.Path]::DirectorySeparatorChar)) {
        throw 'Некорректный путь сгенерированных ресурсов.'
    }
    if (Test-Path -LiteralPath $generatedAssets) { Remove-Item -LiteralPath $generatedAssets -Recurse -Force }
    foreach ($relative in @('index.html','icon.svg','assets')) {
        docker cp ($copyContainer + ':/app/dist/' + $relative) $assetsRoot
        if ($LASTEXITCODE -ne 0) { throw "Не удалось получить ресурс интерфейса: $relative" }
    }
} finally {
    docker rm $copyContainer | Out-Null
}

$gradleLog = Join-Path $releaseRoot 'build-checks.log'
docker run --rm --memory=3g --cpus=2 --mount "type=bind,source=$projectRoot/android,target=/project" --mount 'type=volume,source=cotology_android_gradle,target=/home/gradle/.gradle' --mount "type=bind,source=$signingRoot,target=/root/.android" cotology-android-builder:local gradle --no-daemon :mvp:testDebugUnitTest :mvp:lintDebug :mvp:assembleDebug 2>&1 | Tee-Object -FilePath $gradleLog
if ($LASTEXITCODE -ne 0) { throw 'Сборка или проверки Android-приложения завершились ошибкой.' }

$apkPath = Join-Path $releaseRoot 'Gargantua-preview.apk'
Copy-Item -LiteralPath (Join-Path $projectRoot 'android/mvp/build/outputs/apk/debug/mvp-debug.apk') -Destination $apkPath -Force
$metadata = Get-Content -LiteralPath (Join-Path $projectRoot 'android/mvp/build/outputs/apk/debug/output-metadata.json') -Raw | ConvertFrom-Json
$index = Get-Content -LiteralPath (Join-Path $assetsRoot 'index.html') -Raw
$activeAssets = @('index.html','native-bridge.js')
$activeAssets += @([regex]::Matches($index,'(?:src|href)="(/assets/[^"]+)"') | ForEach-Object { $_.Groups[1].Value.TrimStart('/') })
$assetHashes = foreach ($relative in ($activeAssets | Sort-Object -Unique)) {
    @{path=$relative;sha256=(Get-FileHash -LiteralPath (Join-Path $assetsRoot $relative) -Algorithm SHA256).Hash.ToLowerInvariant()}
}
@{
    version=$metadata.elements[0].versionName
    versionCode=$metadata.elements[0].versionCode
    packageId=$metadata.applicationId
    minSdk=$metadata.minSdkVersionForDexing
    targetSdk=35
    sha256=(Get-FileHash -LiteralPath $apkPath -Algorithm SHA256).Hash.ToLowerInvariant()
    builtAt=[DateTimeOffset]::UtcNow.ToString('o')
    activeAssets=@($assetHashes)
    verifiedOnPhone=$false
    audioIncluded=$false
    serverVersion='0.7.1'
} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $releaseRoot 'build-info.json') -Encoding utf8
Write-Output ('Готово: ' + $apkPath)
