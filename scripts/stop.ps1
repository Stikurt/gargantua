$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'startup-common.ps1')
$project=[IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$runtime=Get-GargantuaAutomationRoot $project
Assert-GargantuaStartupPath $runtime
New-Item -ItemType Directory -Path $runtime -Force|Out-Null
$identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name
Invoke-GargantuaStartupNative -Command icacls -Arguments @($runtime,'/inheritance:r','/grant:r',"${identity}:(OI)(CI)F",'*S-1-5-18:(OI)(CI)F')|Out-Null
# Publish intent first so an in-progress boot can cancel its remaining phases.
Write-GargantuaAutomationJson -Path (Join-Path $runtime 'manual-stop.json') -Value @{schemaVersion=1;reason='explicit-stop';requestedAt=[DateTimeOffset]::UtcNow.ToString('o')}
$lease=$null;$deadline=[DateTimeOffset]::UtcNow.AddMinutes(10)
while(-not $lease -and [DateTimeOffset]::UtcNow -lt $deadline){
    $lease=Open-GargantuaLifecycleLock -ProjectRoot $project
    if(-not $lease){Start-Sleep -Milliseconds 500}
}
if(-not $lease){throw 'Ручная остановка сохранена, но текущая операция не завершилась за 10 минут. Автозапуск заблокирован; проверьте .local/operations.'}
$errors=[Collections.Generic.List[string]]::new()
try{
    try{Invoke-GargantuaStartupNative -Command docker -Arguments @('compose','--project-directory',$project,'-f',(Join-Path $project 'compose.yaml'),'stop','--timeout','30') -WorkingDirectory $project -TimeoutSeconds 180|Out-Null}catch{$errors.Add('Не подтверждена остановка контейнеров.')}
    foreach($helper in @(@('derived-executor.ps1','-Action','stop'),@('stop-monitor.ps1'))){
        try{Invoke-GargantuaStartupNative -Command pwsh.exe -Arguments (@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',(Join-Path $PSScriptRoot $helper[0]))+@($helper|Select-Object -Skip 1)) -WorkingDirectory $project -TimeoutSeconds 65|Out-Null}catch{$errors.Add('Не подтверждена остановка '+$helper[0]+'.')}
    }
}finally{$lease.Dispose()}
if($errors.Count){throw (($errors -join ' ')+' Ручная остановка остаётся активной.')}
Write-Host 'Библиотека остановлена, данные сохранены. Автозапуск приостановлен до ./scripts/start.ps1.'
