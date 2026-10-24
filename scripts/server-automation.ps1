[CmdletBinding()]
param([ValidateSet('help','plan','status','enable','disable','remove','run-startup','run-backup')][string]$Action='status')
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'startup-common.ps1')
. (Join-Path $PSScriptRoot 'operations-tasks.ps1')
$project=[IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
if($Action -eq 'help'){
    Write-Output @'
./scripts/server-automation.ps1 plan          # определения заданий, без установки
./scripts/server-automation.ps1 enable        # автозапуск и ежедневные проверяемые копии
./scripts/server-automation.ps1 status        # задания и последние результаты
./scripts/server-automation.ps1 run-startup   # проверить запуск через планировщик
./scripts/server-automation.ps1 run-backup    # проверить, нужна ли сегодняшняя копия
./scripts/backup-cycle.ps1 -Force             # дополнительная копия с пробным восстановлением
./scripts/stop.ps1                           # остановить и удерживать сервер выключенным
./scripts/start.ps1                          # снять ручную остановку и запустить
./scripts/server-automation.ps1 disable      # выключить задания, сохранив данные
./scripts/server-automation.ps1 remove       # убрать только задания этого проекта
'@
    return
}
$definitions=@(Get-GargantuaManagedTaskDefinitions -ProjectRoot $project)
if($Action -eq 'plan'){$definitions|ConvertTo-Json -Depth 8;return}
function Get-OwnedTask($definition){
    $task=Get-ScheduledTask -TaskName $definition.name -TaskPath '\' -ErrorAction SilentlyContinue
    if($task){$null=Assert-GargantuaManagedTask -Xml (Export-ScheduledTask -TaskName $definition.name -TaskPath '\' -ErrorAction Stop) -Definition $definition}
    return $task
}
if($Action -eq 'status'){
    $tasks=@(foreach($definition in $definitions){
        $task=Get-OwnedTask $definition
        if($task){$info=Get-ScheduledTaskInfo -InputObject $task;[pscustomobject]@{role=$definition.role;name=$definition.name;installed=$true;state=[string]$task.State;lastResult=$info.LastTaskResult;lastRun=$info.LastRunTime;nextRun=$info.NextRunTime}}
        else{[pscustomobject]@{role=$definition.role;name=$definition.name;installed=$false}}
    })
    $root=Get-GargantuaAutomationRoot $project
    $backup=$null;$path=Join-Path $root 'backup-state.json'
    if(Test-Path -LiteralPath $path -PathType Leaf){Assert-GargantuaStartupPath $path;if((Get-Item -LiteralPath $path).Length -gt 256KB){throw 'Backup state too large'};$backup=Get-Content -LiteralPath $path -Raw -Encoding UTF8|ConvertFrom-Json}
    @{tasks=$tasks;startup=(Get-GargantuaStartupStatus $project);backup=$backup;timeZone=[TimeZoneInfo]::Local.Id}|ConvertTo-Json -Depth 20
    return
}
foreach($definition in $definitions){$null=Get-OwnedTask $definition}
if($Action -in @('run-startup','run-backup')){
    $role=$Action.Substring(4);$definition=$definitions|Where-Object role -eq $role
    $task=Get-OwnedTask $definition
    if(-not $task -or $task.State -eq 'Disabled'){throw 'Enable this project task before requesting a run.'}
    Start-ScheduledTask -TaskName $definition.name -TaskPath '\'
    @{requested=$true;role=$role;taskName=$definition.name}|ConvertTo-Json
    return
}
if($Action -eq 'enable'){
    $runtime=Get-GargantuaAutomationRoot $project;Assert-GargantuaStartupPath $runtime
    New-Item -ItemType Directory -Path $runtime -Force|Out-Null
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name
    Invoke-GargantuaStartupNative -Command icacls -Arguments @($runtime,'/inheritance:r','/grant:r',"${identity}:(OI)(CI)F",'*S-1-5-18:(OI)(CI)F')|Out-Null
    $installed=[Collections.Generic.List[object]]::new();$previous=@{}
    try{
        foreach($definition in $definitions){
            $task=Get-OwnedTask $definition
            $previous[$definition.name]=if($task){Export-ScheduledTask -TaskName $definition.name -TaskPath '\'}else{$null}
            Register-ScheduledTask -TaskName $definition.name -TaskPath '\' -Xml $definition.xml -Force|Out-Null
            $installed.Add($definition)
            $null=Get-OwnedTask $definition
        }
        Write-GargantuaAutomationJson -Path (Join-Path $runtime 'installation.json') -Value @{schemaVersion=1;enabled=$true;project=$project;tasks=@($definitions|Select-Object role,name);userSid=$definitions[0].userSid;installedAt=[DateTimeOffset]::UtcNow.ToString('o');timeZone=[TimeZoneInfo]::Local.Id;dailyBackupCheck='hourly, once per local calendar day; catch up after sign-in';keepVerified=7;requiresPassword=$false;elevated=$false}
    }catch{
        $problem=$_.Exception.Message;$rollback=[Collections.Generic.List[string]]::new()
        foreach($definition in $installed){try{$null=Get-OwnedTask $definition;if($previous[$definition.name]){Register-ScheduledTask -TaskName $definition.name -TaskPath '\' -Xml $previous[$definition.name] -Force|Out-Null}else{Unregister-ScheduledTask -TaskName $definition.name -TaskPath '\' -Confirm:$false}}catch{$rollback.Add($definition.name)}}
        throw ('Could not install managed tasks: '+$problem+'. Rollback errors: '+($rollback -join ', '))
    }
    @{enabled=$true;tasks=@($definitions|Select-Object role,name);passwordStored=$false;administratorRights=$false}|ConvertTo-Json -Depth 5
    return
}
foreach($definition in $definitions){
    $task=Get-OwnedTask $definition
    if(-not $task){continue}
    if($Action -eq 'disable'){Disable-ScheduledTask -TaskName $definition.name -TaskPath '\'|Out-Null}
    else{Unregister-ScheduledTask -TaskName $definition.name -TaskPath '\' -Confirm:$false}
}
@{action=$Action;tasks=@($definitions.name);backupsAndCurrentServerPreserved=$true}|ConvertTo-Json
