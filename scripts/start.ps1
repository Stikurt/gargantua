$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'startup-common.ps1')
$project=[IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$lease=Open-GargantuaLifecycleLock -ProjectRoot $project
if(-not $lease){throw 'Идёт запуск, остановка или создание снимка. Повторите запуск после завершения операции.'}
try{
    $hold=Join-Path (Get-GargantuaAutomationRoot $project) 'manual-stop.json'
    Assert-GargantuaStartupPath $hold
    if(Test-Path -LiteralPath $hold){Remove-Item -LiteralPath $hold -Force}
}finally{$lease.Dispose()}
$result=Invoke-GargantuaStartup -ProjectRoot $project
if($result.state -ne 'ready'){throw ('Запуск не завершён: '+$result.state+' / '+$result.reason+'. Подробности: .local/operations/startup-status.json')}
Write-Host 'http://localhost:3080'
