[CmdletBinding()]
param([switch]$ProbeOnly,[switch]$Once,[ValidateRange(1,15)][int]$IntervalSeconds=10)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'resource-policy.ps1')
. (Join-Path $PSScriptRoot 'resource-monitor-io.ps1')
$projectRoot=[IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
if($ProbeOnly){
    $sample=Get-GargantuaHostResourceSample -ProjectRoot $projectRoot
    Get-GargantuaResourceDecision -Sample $sample -Previous $null -NowMs ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())|ConvertTo-Json -Depth 8
    return
}
$runtimeDir=Join-Path $projectRoot '.local/runtime'
New-Item -ItemType Directory -Force -Path $runtimeDir|Out-Null
$monitorLock=$null;$previous=$null;$pidPath=Join-Path $runtimeDir 'monitor.pid';$statePath=Join-Path $runtimeDir 'resources.json'
# Also recognise a pre-upgrade monitor that did not yet hold monitor.lock.
if(Test-Path -LiteralPath $pidPath){
    $existingId=0
    if([int]::TryParse((Get-Content -LiteralPath $pidPath -Raw).Trim(),[ref]$existingId) -and $existingId -gt 0 -and $existingId -ne $PID){
        $existing=Get-CimInstance Win32_Process -Filter "ProcessId=$existingId" -ErrorAction Stop
        $thisScript=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'resource-monitor.ps1'))
        if($existing -and $existing.CommandLine -and $existing.CommandLine.IndexOf($thisScript,[StringComparison]::OrdinalIgnoreCase) -ge 0){throw 'Другой монитор ресурсов уже работает. Его состояние не изменено.'}
    }
}
try{
    try{$monitorLock=Open-GargantuaMonitorLock -RuntimeRoot $runtimeDir}catch{throw 'Монитор ресурсов уже запущен или файл блокировки недоступен.'}
    $owner=[Text.UTF8Encoding]::new($false).GetBytes((@{pid=$PID;startedAt=[DateTimeOffset]::UtcNow.ToString('o')}|ConvertTo-Json -Compress))
    $monitorLock.SetLength(0);$monitorLock.Write($owner,0,$owner.Length);$monitorLock.Flush($true)
    [IO.File]::WriteAllText($pidPath,[string]$PID,[Text.UTF8Encoding]::new($false))
    do{
        try{$sample=Get-GargantuaHostResourceSample -ProjectRoot $projectRoot}catch{$sample=$null}
        $next=Get-GargantuaResourceDecision -Sample $sample -Previous $previous -NowMs ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
        Write-GargantuaResourceJson -Path $statePath -Value $next
        $previous=$next
        if(-not $Once){Start-Sleep -Seconds $IntervalSeconds}
    }while(-not $Once)
}finally{
    if($monitorLock){
        try{$blocked=Get-GargantuaResourceDecision -Sample $null -Previous $null -NowMs ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds());$blocked.message='Монитор ресурсов остановлен. Тяжёлые задачи ждут; чтение доступно.';Write-GargantuaResourceJson -Path $statePath -Value $blocked}catch{}
        try{if((Test-Path -LiteralPath $pidPath) -and (Get-Content -LiteralPath $pidPath -Raw).Trim() -eq [string]$PID){Remove-Item -LiteralPath $pidPath -ErrorAction Stop}}catch{}
        $monitorLock.Dispose()
    }
}
