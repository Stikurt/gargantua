[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
Set-Location -LiteralPath $projectRoot
$tailscalePath = Join-Path $env:ProgramFiles 'Tailscale/tailscale.exe'
if (-not (Test-Path -LiteralPath $tailscalePath)) { throw 'Не найден Tailscale. Установите его и подключите ПК к своей сети Tailscale.' }
$tailState = & $tailscalePath status --json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $tailState.BackendState -ne 'Running') { throw 'Включите Tailscale на ПК и войдите в свою сеть.' }
$serverHost = ([string]$tailState.Self.DNSName).TrimEnd('.')
if (-not $serverHost) { throw 'Tailscale не сообщил имя этого ПК.' }
$serverOrigin = 'https://' + $serverHost
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
if ($LASTEXITCODE -ne 0) { throw 'Запустите Docker Desktop для поиска и скачивания.' }
docker compose up -d --no-build --no-recreate
if ($LASTEXITCODE -ne 0) { throw 'Не удалось запустить книжный сервер Гаргантюа.' }
$serve = & $tailscalePath serve status --json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Не удалось проверить приватный HTTPS Tailscale.' }
$serveEntry = $serve.Web.PSObject.Properties | Where-Object Name -EQ ($serverHost + ':443')
$httpsEntry = $serve.TCP.PSObject.Properties | Where-Object Name -EQ '443'
$publicEntries = @($serve.AllowFunnel.PSObject.Properties | Where-Object { $_.Name -eq ($serverHost + ':443') -and $_.Value -eq $true })
if ($publicEntries.Count -gt 0) { throw 'Для этого запуска требуется приватный Serve. Обнаружен публичный Funnel; проверьте конфигурацию Tailscale.' }
if (-not $serveEntry -or -not $httpsEntry.Value.HTTPS -or $serveEntry.Value.Handlers.'/'.Proxy -ne 'http://127.0.0.1:3080') {
    throw 'Приватный HTTPS-маршрут не настроен на книжный сервер. Выполните scripts/remote.ps1 enable и повторите запуск.'
}
$ready = $false
for ($attempt = 0; $attempt -lt 10; $attempt++) {
    try { $ready = (Invoke-RestMethod -Uri ($serverOrigin + '/api/mvp/health') -TimeoutSec 5).ok; if ($ready) { break } } catch { }
    Start-Sleep -Seconds 1
}
if (-not $ready) { throw 'Сервер не ответил по HTTPS Tailscale. Проверьте подключение ПК к своей сети.' }
Write-Output ('Сервер Гаргантюа готов: ' + $serverOrigin)
Write-Output 'Откройте Гаргантюа на телефоне с включённым Tailscale. USB не требуется. ПК должен оставаться включённым.'
