[CmdletBinding()]
param([ValidateSet('start','stop','status')][string]$Action='status')
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'runtime-common.ps1')
$projectRoot=[IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$runtimeRoot=Join-Path $projectRoot '.local/inference-runtime'
$statePath=Join-Path $runtimeRoot 'daemon.json'
$executorPath=Join-Path $projectRoot 'inference/executor.py'
New-Item -ItemType Directory -Force -Path $runtimeRoot|Out-Null
function Get-ExecutorState {
    if(-not(Test-Path -LiteralPath $statePath -PathType Leaf)){return $null}
    $handle=$null;$reader=$null
    try{
        $sharing=[IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
        $handle=[IO.File]::Open($statePath,[IO.FileMode]::Open,[IO.FileAccess]::Read,$sharing)
        if($handle.Length -gt 8192){throw 'Некорректный статус обработчика.'}
        $reader=[IO.StreamReader]::new($handle,[Text.UTF8Encoding]::new($false,$true),$false,1024,$true)
        return $reader.ReadToEnd()|ConvertFrom-Json
    }finally{if($reader){$reader.Dispose()};if($handle){$handle.Dispose()}}
}
function Get-ExecutorProcess($State){
    if(-not $State -or ($State.pid -isnot [int] -and $State.pid -isnot [long]) -or $State.pid -le 0 -or $State.pid -gt [int]::MaxValue){return $null}
    $entry=Get-CimInstance Win32_Process -Filter "ProcessId=$($State.pid)" -ErrorAction Stop
    if($entry -and $entry.CommandLine -and $entry.CommandLine.IndexOf($executorPath,[StringComparison]::OrdinalIgnoreCase) -ge 0){return $entry}
    return $null
}
$state=Get-ExecutorState
$existing=Get-ExecutorProcess $state
if($Action -eq 'status'){
    if($existing){$state|ConvertTo-Json -Depth 6}else{[pscustomobject]@{state='not-running';cleanupVerified=$false;message='Статус процесса не подтверждён; остаточные контейнеры проверяются при следующем запуске.'}|ConvertTo-Json}
    return
}
if($Action -eq 'stop'){
    if(-not $existing){Write-Output 'Обработчик не запущен. Отсутствие остаточных контейнеров проверяется при резервном копировании.';return}
    $stopPath=Join-Path $runtimeRoot 'stop.json'
    $temporary=$stopPath+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes((@{schemaVersion=1;pid=[int]$state.pid;requestedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}|ConvertTo-Json -Compress))
    try{
        $stream=[IO.File]::Open($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
        $writeDeadline=[DateTime]::UtcNow.AddSeconds(2)
        do{
            try{
                if(Test-Path -LiteralPath $stopPath){[IO.File]::Replace($temporary,$stopPath,[NullString]::Value)}else{[IO.File]::Move($temporary,$stopPath)}
                break
            }catch [IO.IOException]{if([DateTime]::UtcNow -ge $writeDeadline){throw};Start-Sleep -Milliseconds 25}
            catch [UnauthorizedAccessException]{if([DateTime]::UtcNow -ge $writeDeadline){throw};Start-Sleep -Milliseconds 25}
        }while($true)
    }finally{if(Test-Path -LiteralPath $temporary){Remove-Item -LiteralPath $temporary -ErrorAction SilentlyContinue}}
    $deadline=[DateTime]::UtcNow.AddSeconds(50)
    do{
        Start-Sleep -Milliseconds 500
        $current=Get-ExecutorState
        $live=Get-ExecutorProcess $state
        if(-not $live -and $current -and $current.state -eq 'stopped' -and $current.cleanupVerified){Write-Output 'Обработчик остановлен; модельные контейнеры проверены.';return}
    }while([DateTime]::UtcNow -lt $deadline)
    throw 'Безопасная остановка ещё не подтверждена. Процесс принудительно не завершён; проверьте .local/inference-runtime/daemon.json.'
}
if($existing){Write-Output 'Обработчик перевода и озвучки уже запущен.';return}
$pythonRuntime=Get-GargantuaPythonRuntime -ProjectRoot $projectRoot
$pythonPath=$pythonRuntime.command
$environment=Get-GargantuaManagedEnvironment -ProjectRoot $projectRoot
# Keep the previous failure evidence before opening fresh redirected logs.
$historyRoot=Join-Path $runtimeRoot 'history'
New-Item -ItemType Directory -Force -Path $historyRoot|Out-Null
$historyStamp=[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')+'-'+[Guid]::NewGuid().ToString('N').Substring(0,8)
foreach($name in @('daemon.stdout.log','daemon.stderr.log')){
    $oldLog=Join-Path $runtimeRoot $name
    if(Test-Path -LiteralPath $oldLog -PathType Leaf){
        Move-Item -LiteralPath $oldLog -Destination (Join-Path $historyRoot ($historyStamp+'-'+$name)) -ErrorAction Stop
    }
}
$arguments=@($pythonRuntime.prefix)+@('-u',('"'+$executorPath+'"'),'--spool',('"'+(Join-Path $projectRoot '.local/inference-spool')+'"'))
$launched=Start-Process -FilePath $pythonPath -ArgumentList $arguments -WorkingDirectory $projectRoot -Environment $environment -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimeRoot 'daemon.stdout.log') -RedirectStandardError (Join-Path $runtimeRoot 'daemon.stderr.log')
$deadline=[DateTime]::UtcNow.AddSeconds(15)
do{
    Start-Sleep -Milliseconds 300
    $current=Get-ExecutorState
    if($current -and $current.pid -eq $launched.Id -and $current.state -in @('idle','running')){Write-Output 'Локальный обработчик перевода и озвучки запущен.';return}
    $launched.Refresh()
    if($launched.HasExited){throw 'Обработчик завершился при запуске. Подробности: .local/inference-runtime/daemon.stderr.log'}
}while([DateTime]::UtcNow -lt $deadline)
throw 'Запуск ещё не подтверждён. Проверьте .local/inference-runtime/daemon.json и журнал ошибок.'
