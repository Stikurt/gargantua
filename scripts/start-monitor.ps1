$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'resource-monitor-io.ps1')
. (Join-Path $PSScriptRoot 'runtime-common.ps1')
$runtimePath=Join-Path (Split-Path $PSScriptRoot -Parent) '.local/runtime'
New-Item -ItemType Directory -Force -Path $runtimePath|Out-Null
$monitorPidPath=Join-Path $runtimePath 'monitor.pid'
$expectedScript=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'resource-monitor.ps1'))
if(Test-Path -LiteralPath $monitorPidPath){
    $savedId=0
    if([int]::TryParse((Get-Content -LiteralPath $monitorPidPath -Raw).Trim(),[ref]$savedId) -and $savedId -gt 0){
        $process=Get-CimInstance Win32_Process -Filter "ProcessId=$savedId" -ErrorAction Stop
        if($process -and $process.CommandLine -and $process.CommandLine.IndexOf($expectedScript,[StringComparison]::OrdinalIgnoreCase) -ge 0){Write-Host 'Монитор ресурсов уже работает.';return}
    }
}
# A stale PID never authorizes stopping a process. The child must independently
# acquire this same lock before it may publish any state.
$probe=$null
try{$probe=Open-GargantuaMonitorLock -RuntimeRoot $runtimePath}catch{Write-Host 'Монитор ресурсов уже работает или блокировка недоступна.';return}finally{if($probe){$probe.Dispose()}}
$pwsh=Get-GargantuaPowerShell
$environment=Get-GargantuaManagedEnvironment
$projectRoot=[IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
# A detached child must never retain the startup task's stdout/stderr pipes.
# Keep at most one bounded previous log for this otherwise silent governor.
Assert-GargantuaRuntimePath $runtimePath
foreach($name in @('monitor.stdout.log','monitor.stderr.log')){
    $path=Join-Path $runtimePath $name;$previous=$path+'.1'
    Assert-GargantuaRuntimePath $path;Assert-GargantuaRuntimePath $previous
    if(Test-Path -LiteralPath $path -PathType Leaf){
        $stream=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
        try{$count=[int][Math]::Min(65536,$stream.Length);$buffer=[byte[]]::new($count);$null=$stream.Seek(-$count,[IO.SeekOrigin]::End);$read=$stream.Read($buffer,0,$count);if($read -ne $count){throw 'Monitor log rotation could not read its bounded tail.'}}finally{$stream.Dispose()}
        [IO.File]::WriteAllBytes($previous,$buffer);Remove-Item -LiteralPath $path -Force
    }
}
Start-Process -FilePath $pwsh -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$expectedScript+'"')) -Environment $environment -WorkingDirectory $projectRoot -RedirectStandardOutput (Join-Path $runtimePath 'monitor.stdout.log') -RedirectStandardError (Join-Path $runtimePath 'monitor.stderr.log') -WindowStyle Hidden|Out-Null
Write-Host 'Запуск монитора ресурсов. Показатели должны обновиться через несколько секунд.'
