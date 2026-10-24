param([ValidateSet('status','enable','disable')][string]$Action = 'status')
$ErrorActionPreference = 'Stop'
$tailscalePath = Join-Path $env:ProgramFiles 'Tailscale/tailscale.exe'
if (-not (Test-Path -LiteralPath $tailscalePath)) { throw 'Установите Tailscale для Windows с tailscale.com/download' }
switch ($Action) {
    'status' { & $tailscalePath status; & $tailscalePath serve status }
    'enable' {
        $state = & $tailscalePath status --json | ConvertFrom-Json
        if ($LASTEXITCODE -ne 0 -or $state.BackendState -ne 'Running') { throw 'Сначала войдите в Tailscale на этом ПК и одобрите устройство в своей сети.' }
        Invoke-RestMethod 'http://127.0.0.1:3080/api/health' | Out-Null
        & $tailscalePath serve --bg --https=443 http://127.0.0.1:3080
        if ($LASTEXITCODE -ne 0) { throw 'Tailscale не включил HTTPS. Выполните подсказку Tailscale для HTTPS вашей сети.' }
        & $tailscalePath serve status
    }
    'disable' {
        & $tailscalePath serve --https=443 off
        if ($LASTEXITCODE -ne 0) { throw 'Не удалось отключить HTTPS-публикацию в Tailscale.' }
    }
}
