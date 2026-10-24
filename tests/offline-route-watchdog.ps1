param([Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{32}$')][string]$Token,[int]$MaxSeconds=180)
$ErrorActionPreference='Stop'
$workspacePath=Split-Path $PSScriptRoot -Parent
Set-Location $workspacePath
$statePath=Join-Path $workspacePath ".local/runtime/phone-offline-$Token.json"
$donePath=Join-Path $workspacePath ".local/runtime/phone-offline-$Token.done"
try {
 & "$workspacePath/scripts/remote.ps1" disable
 if ($LASTEXITCODE -ne 0) { throw 'Could not disable the reader route' }
 @{offline=$true;expiresAt=[DateTimeOffset]::UtcNow.AddSeconds($MaxSeconds).ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath $statePath
 for($elapsed=0;$elapsed -lt $MaxSeconds;$elapsed+=2){if(Test-Path -LiteralPath $donePath){break};Start-Sleep -Seconds 2}
} finally {
 & "$workspacePath/scripts/remote.ps1" enable
 if($LASTEXITCODE -eq 0){@{offline=$false;restoredAt=[DateTimeOffset]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath $statePath}
}
