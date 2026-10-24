[CmdletBinding()]
param([string]$Serial, [switch]$Install)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
Set-Location -LiteralPath $projectRoot
$packageId = 'local.gargantua.mvp.debug'
$apkPath = Join-Path $projectRoot 'releases/Gargantua-Android/Gargantua-preview.apk'
if (-not (Get-Command adb -ErrorAction SilentlyContinue)) { throw 'Не найден Android Platform Tools (adb). Установите его и добавьте в PATH.' }
if (-not $Serial) {
    $deviceLines = @(adb devices | Where-Object { $_ -match '^\S+\s+device\s*$' })
    if ($deviceLines.Count -ne 1) { throw 'Подключите и разблокируйте один Android-телефон, подтвердите USB-отладку. Для нескольких телефонов укажите -Serial.' }
    $Serial = ($deviceLines[0] -split '\s+')[0]
}
$adbTarget = @('-s', $Serial)
docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    $dockerApp = Join-Path $env:LOCALAPPDATA 'Programs/DockerDesktop/Docker Desktop.exe'
    if (Test-Path -LiteralPath $dockerApp) {
        Start-Process -FilePath $dockerApp -ArgumentList '--background' -WindowStyle Hidden
        for ($attempt = 0; $attempt -lt 45; $attempt++) {
            Start-Sleep -Seconds 1
            docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
            if ($LASTEXITCODE -eq 0) { break }
        }
    }
}
if ($LASTEXITCODE -ne 0) { throw 'Запустите Docker Desktop для поиска и скачивания. Сохранённые книги доступны в приложении без сервера.' }
docker compose up -d --no-build --no-recreate
if ($LASTEXITCODE -ne 0) { throw 'Не удалось запустить сервер Гаргантюа. Сначала выполните scripts/build-mvp.ps1.' }
$healthy = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try { $healthy = (Invoke-RestMethod -Uri 'http://127.0.0.1:3080/api/mvp/health' -TimeoutSec 2).ok; if ($healthy) { break } } catch { }
    Start-Sleep -Seconds 1
}
if (-not $healthy) { throw 'Сервер не ответил. Проверьте Docker Desktop.' }
$installed = adb @adbTarget shell pm path $packageId
if ($Install -or -not ($installed -match '^package:')) {
    if (-not (Test-Path -LiteralPath $apkPath)) { throw 'APK не найден. Сначала выполните scripts/build-android-mvp.ps1.' }
    adb @adbTarget install -r $apkPath
    if ($LASTEXITCODE -ne 0) { throw 'Телефон отклонил установку APK. Подтвердите установку на телефоне и повторите запуск.' }
}
adb @adbTarget reverse tcp:3080 tcp:3080
if ($LASTEXITCODE -ne 0) { throw 'Не удалось подключить сервер к телефону через USB.' }
adb @adbTarget shell am start -n "$packageId/local.gargantua.mvp.MainActivity" --es gargantua.server http://127.0.0.1:3080 --ez gargantua.offline false --es gargantua.orientation auto
if ($LASTEXITCODE -ne 0) { throw 'Не удалось открыть приложение на телефоне.' }
Write-Output 'Гаргантюа открыта на телефоне. Поиск и скачивание доступны через USB; сохранённые книги читаются без подключения.'
