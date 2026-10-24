$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$localIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
foreach ($folder in @('.local','backups')) {
    if (Test-Path -LiteralPath $folder) {
        icacls $folder /inheritance:r /grant:r "${localIdentity}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Не удалось ограничить доступ к $folder" }
    }
}
if (Test-Path -LiteralPath .env) {
    icacls .env /inheritance:r /grant:r "${localIdentity}:F" '*S-1-5-18:F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось ограничить доступ к .env' }
}
