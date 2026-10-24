$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
New-Item -ItemType Directory -Force .local, .local/runtime | Out-Null
if (-not (Test-Path .env)) {
    $dbSecret = [Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
    "DB_PASSWORD=$dbSecret" | Set-Content .env -Encoding utf8
}
if (-not (Select-String -Path .env -Pattern '^DB_ADMIN_PASSWORD=' -Quiet)) {
    $adminSecret = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
    "DB_ADMIN_PASSWORD=$adminSecret" | Add-Content .env -Encoding utf8
}
& "$PSScriptRoot/protect-local.ps1"
docker compose up -d --build
if ($LASTEXITCODE -ne 0) { throw 'Не удалось запустить контейнеры' }
docker compose exec -T db sh /docker-entrypoint-initdb.d/10-roles.sh
if ($LASTEXITCODE -ne 0) { throw 'Не удалось настроить отдельные роли БД' }
docker compose restart app worker | Out-Null
for ($attempt = 0; $attempt -lt 50; $attempt++) {
    try { $null = Invoke-RestMethod http://localhost:3080/api/health -TimeoutSec 3; break } catch { Start-Sleep -Seconds 2 }
}
if (-not (Test-Path .local/login.txt)) {
    $bootstrap = docker compose exec -T app node server/cli.mjs bootstrap
    if ($LASTEXITCODE -eq 0) { $bootstrap | Set-Content .local/login.txt -Encoding utf8 }
}
& "$PSScriptRoot/start-monitor.ps1"
Write-Host 'Библиотека: http://localhost:3080'
Write-Host 'Первый вход: .local/login.txt. Смените пароль в настройках профиля.'
Write-Host 'Сканер может обновлять базы несколько минут; до готовности импорт закрыт.'
