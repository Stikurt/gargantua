# Windows lifecycle helpers. Dot-sourcing does not start Docker or write files.
. (Join-Path $PSScriptRoot 'runtime-common.ps1')
. (Join-Path $PSScriptRoot 'lifecycle-stop-guard.ps1')
function Assert-GargantuaStartupPath {
    param([Parameter(Mandatory)][string]$Path)
    $current=[IO.Path]::GetFullPath($Path)
    while($current){
        if((Test-Path -LiteralPath $current) -and (Get-Item -LiteralPath $current -Force).Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)){throw 'Lifecycle path contains a reparse point.'}
        $parent=[IO.Directory]::GetParent($current);if(-not $parent){break};$current=$parent.FullName
    }
}
function Get-GargantuaAutomationRoot {
    param([Parameter(Mandatory)][string]$ProjectRoot)
    return Join-Path ([IO.Path]::GetFullPath($ProjectRoot)) '.local/operations'
}
function Open-GargantuaLifecycleLock {
    param([Parameter(Mandatory)][string]$ProjectRoot)
    $root=Get-GargantuaAutomationRoot $ProjectRoot
    Assert-GargantuaStartupPath $root
    New-Item -ItemType Directory -Path $root -Force|Out-Null
    try{return [IO.File]::Open((Join-Path $root 'lifecycle.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}
    catch [IO.IOException]{if(($_.Exception.HResult -band 65535) -in @(32,33)){return $null};throw}
}
function Get-GargantuaStartupBlock {
    param([Parameter(Mandatory)][string]$ProjectRoot)
    $root=Get-GargantuaAutomationRoot $ProjectRoot
    Assert-GargantuaStartupPath $root
    if(Test-Path -LiteralPath (Join-Path $root 'manual-stop.json')){return 'manual-stop'}
    $snapshot=Join-Path $ProjectRoot '.local/backup-snapshot.lock'
    if(Test-Path -LiteralPath $snapshot){
        Assert-GargantuaStartupPath $snapshot
        $probe=$null
        try{
            $probe=[IO.File]::Open($snapshot,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)
            if($probe.Length -gt 128){return 'backup-lock-needs-review'}
            $bytes=[byte[]]::new([int]$probe.Length);$null=$probe.Read($bytes,0,$bytes.Length)
            $text=[Text.Encoding]::UTF8.GetString($bytes).Trim()
            # An old crashed backup left an unheld GUID marker. A new persistent
            # handle lock may be empty. Neither means a process is still active.
            if($text -and $text -notmatch '^[a-fA-F0-9]{32}$'){return 'backup-lock-needs-review'}
        }catch [IO.IOException]{if(($_.Exception.HResult -band 65535) -in @(32,33)){return 'backup-snapshot'};throw}
        finally{if($probe){$probe.Dispose()}}
    }
    return $null
}
function Write-GargantuaAutomationJson {
    param([Parameter(Mandatory)][string]$Path,[Parameter(Mandatory)]$Value)
    Assert-GargantuaStartupPath $Path
    $temporary=$Path+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-Json -InputObject $Value -Depth 16 -Compress)+"`n")
    if($bytes.Length -gt 64KB){throw 'Lifecycle metadata exceeds its bound.'}
    try{
        $handle=[IO.File]::Open($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try{$handle.Write($bytes,0,$bytes.Length);$handle.Flush($true)}finally{$handle.Dispose()}
        if(Test-Path -LiteralPath $Path){[IO.File]::Replace($temporary,$Path,[NullString]::Value)}else{[IO.File]::Move($temporary,$Path)}
    }finally{if(Test-Path -LiteralPath $temporary){Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue}}
}
function Invoke-GargantuaStartupNative {
    param([Parameter(Mandatory)][string]$Command,[string[]]$Arguments=@(),[ValidateRange(1,180)][int]$TimeoutSeconds=15,[string]$WorkingDirectory='',
          [switch]$AllowDetachedOutput)
    if($Command -in @('pwsh','pwsh.exe')){$Command=Get-GargantuaPowerShell}
    elseif($Command -in @('docker','docker.exe')){$Command=Get-GargantuaDockerExecutable}
    $native=Get-Command $Command -CommandType Application -ErrorAction Stop|Select-Object -First 1
    $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=$native.Source;$info.UseShellExecute=$false;$info.CreateNoWindow=$true
    $info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
    # Scope stable binaries, modules and the local Desktop context to children.
    $environment=Get-GargantuaManagedEnvironment
    foreach($name in $environment.Keys){$info.Environment[$name]=$environment[$name]}
    if($WorkingDirectory){$info.WorkingDirectory=$WorkingDirectory}
    foreach($argument in $Arguments){$info.ArgumentList.Add($argument)}
    $process=[Diagnostics.Process]::new();$process.StartInfo=$info
    try{
        if(-not $process.Start()){throw 'Lifecycle child could not start.'}
        $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
        if(-not $process.WaitForExit($TimeoutSeconds*1000)){
            try{$process.Kill($true)}catch{}
            $process.WaitForExit(3000)|Out-Null
            throw 'Lifecycle command timed out; only its own command process was terminated.'
        }
        if($process.ExitCode -ne 0){throw ('Lifecycle command failed (exit '+$process.ExitCode+'); private output suppressed.')}
        # Windows descendants can retain inherited non-standard handles even
        # when their stdout/stderr are redirected. Only known launch helpers
        # with a separate live readiness proof may discard that inherited pipe.
        if(-not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdout,$stderr),2000)){
            if(-not $AllowDetachedOutput){throw 'Lifecycle command output did not close within its bound.'}
            $process.StandardOutput.Dispose();$process.StandardError.Dispose()
            return ''
        }
        $out=$stdout.GetAwaiter().GetResult();$null=$stderr.GetAwaiter().GetResult()
        if($out.Length -gt 1MB){throw 'Lifecycle command output exceeded its bound.'}
        return $out
    }finally{$process.Dispose()}
}
function Assert-GargantuaLocalDockerContext {
    $endpoint=Invoke-GargantuaStartupNative -Command docker -Arguments @('context','inspect','desktop-linux','--format','{{.Endpoints.docker.Host}}') -TimeoutSeconds 5
    if($endpoint.Trim() -ne 'npipe:////./pipe/dockerDesktopLinuxEngine'){throw 'Managed startup requires the local Docker Desktop Linux named pipe.'}
}
function Get-GargantuaStartupStatus {
    param([Parameter(Mandatory)][string]$ProjectRoot)
    $root=Get-GargantuaAutomationRoot $ProjectRoot
    Assert-GargantuaStartupPath $root
    $path=Join-Path $root 'startup-status.json';$last=$null
    if(Test-Path -LiteralPath $path -PathType Leaf){
        if((Get-Item -LiteralPath $path).Length -gt 64KB){throw 'Startup status exceeds its bound.'}
        $last=Get-Content -LiteralPath $path -Raw -Encoding UTF8|ConvertFrom-Json
    }
    return [pscustomobject]@{schemaVersion=1;block=(Get-GargantuaStartupBlock $ProjectRoot);last=$last;observedAt=[DateTimeOffset]::UtcNow.ToString('o');note='Stored startup result; status does not start Docker or probe services.'}
}
function Get-GargantuaStartupHealth {
    param([Parameter(Mandatory)][string]$ProjectRoot)
    $args=@('compose','--project-directory',$ProjectRoot,'-f',(Join-Path $ProjectRoot 'compose.yaml'),'ps','-a','--format','json')
    try{
        $text=Invoke-GargantuaStartupNative -Command docker -Arguments $args -WorkingDirectory $ProjectRoot -TimeoutSeconds 10
        if($text.TrimStart().StartsWith('[')){$rows=@($text|ConvertFrom-Json)}else{$rows=@($text -split "`n"|Where-Object{$_.Trim()}|ForEach-Object{$_|ConvertFrom-Json})}
        foreach($name in @('app','db','worker','parser','clamav')){
            $row=@($rows|Where-Object Service -eq $name)
            if($row.Count -ne 1 -or $row[0].State -ne 'running'){return $false}
            if($name -in @('db','clamav') -and $row[0].Health -ne 'healthy'){return $false}
        }
        $handler=[Net.Http.HttpClientHandler]::new();$handler.AllowAutoRedirect=$false;$handler.UseProxy=$false
        $client=[Net.Http.HttpClient]::new($handler);$client.Timeout=[TimeSpan]::FromSeconds(3)
        try{$response=$client.GetAsync('http://127.0.0.1:3080/api/health').GetAwaiter().GetResult();try{
            if(-not $response.IsSuccessStatusCode){return $false}
            $body=$response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
            if($body.Length -gt 1024){return $false}
            $health=$body|ConvertFrom-Json;return $health.ok -is [bool] -and $health.ok
        }finally{$response.Dispose()}}finally{$client.Dispose();$handler.Dispose()}
    }catch{return $false}
}
function Test-GargantuaStartupMonitor {
    param([Parameter(Mandatory)][string]$ProjectRoot,[long]$NowMs=([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()),
          [scriptblock]$ProcessLookup={param($MonitorId)Get-CimInstance Win32_Process -Filter "ProcessId=$MonitorId" -OperationTimeoutSec 3 -ErrorAction Stop},
          [scriptblock]$LockProbe={param($LockPath)
              $handle=$null
              try{$handle=[IO.File]::Open($LockPath,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);return $false}
              catch [IO.IOException]{if(($_.Exception.HResult -band 65535) -in @(32,33)){return $true};throw}
              finally{if($handle){$handle.Dispose()}}
          })
    $runtime=Join-Path $ProjectRoot '.local/runtime';Assert-GargantuaStartupPath $runtime
    $pidPath=Join-Path $runtime 'monitor.pid';$statePath=Join-Path $runtime 'resources.json';$lockPath=Join-Path $runtime 'monitor.lock'
    foreach($path in @($pidPath,$statePath,$lockPath)){
        Assert-GargantuaStartupPath $path
        if(-not(Test-Path -LiteralPath $path -PathType Leaf)){return $false}
    }
    if((Get-Item -LiteralPath $pidPath).Length -gt 32 -or (Get-Item -LiteralPath $statePath).Length -gt 16KB){return $false}
    $monitorId=0
    if(-not [int]::TryParse((Get-Content -LiteralPath $pidPath -Raw).Trim(),[ref]$monitorId) -or $monitorId -le 0){return $false}
    $process=& $ProcessLookup $monitorId
    $expected=[IO.Path]::GetFullPath((Join-Path $ProjectRoot 'scripts/resource-monitor.ps1'))
    if(-not $process -or $process.ProcessId -ne $monitorId -or $process.CommandLine -isnot [string]){return $false}
    # Require a complete command-line argument, not a similarly named script.
    $escaped=[regex]::Escape($expected)
    $argument='(?i)(?:^|\s)-File\s+(?:"'+$escaped+'"|'+$escaped+'(?=\s|$))'
    if($process.CommandLine -notmatch $argument){return $false}
    # Access denied or malformed lock paths are errors, never evidence that the
    # governor is running. Only an actual sharing violation proves ownership.
    if(-not(& $LockProbe $lockPath)){return $false}
    try{$state=Get-Content -LiteralPath $statePath -Raw -Encoding UTF8|ConvertFrom-Json}catch{return $false}
    if(($state.schemaVersion -isnot [int] -and $state.schemaVersion -isnot [long]) -or $state.schemaVersion -ne 2 -or $state.allowHeavy -isnot [bool] -or $state.metricsAvailable -isnot [bool]){return $false}
    if($state.updatedAt -isnot [int] -and $state.updatedAt -isnot [long]){return $false}
    if(($NowMs-$state.updatedAt) -lt -5000 -or ($NowMs-$state.updatedAt) -gt 30000){return $false}
    if(-not $state.metricsAvailable -and $state.allowHeavy){return $false}
    return $true
}
function Test-GargantuaStartupExecutor {
    param([Parameter(Mandatory)][string]$ProjectRoot,[long]$NowMs=([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()),
          [scriptblock]$ProcessLookup={param($ExecutorId)Get-CimInstance Win32_Process -Filter "ProcessId=$ExecutorId" -OperationTimeoutSec 3 -ErrorAction Stop},
          [scriptblock]$LockProbe={param($LockPath)
              $handle=$null
              try{$handle=[IO.File]::Open($LockPath,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);return $false}
              catch [IO.IOException]{if(($_.Exception.HResult -band 65535) -in @(32,33)){return $true};throw}
              finally{if($handle){$handle.Dispose()}}
          })
    $runtime=Join-Path $ProjectRoot '.local/inference-runtime';$statePath=Join-Path $runtime 'daemon.json';$lockPath=Join-Path $runtime 'daemon.lock'
    foreach($path in @($runtime,$statePath,$lockPath)){Assert-GargantuaStartupPath $path;if(-not(Test-Path -LiteralPath $path)){return $false}}
    if(-not(Test-Path -LiteralPath $statePath -PathType Leaf) -or (Get-Item -LiteralPath $statePath).Length -gt 8192){return $false}
    try{$state=Get-Content -LiteralPath $statePath -Raw -Encoding UTF8|ConvertFrom-Json}catch{return $false}
    if(($state.schemaVersion -isnot [int] -and $state.schemaVersion -isnot [long]) -or $state.schemaVersion -ne 1 -or $state.state -notin @('idle','running')){return $false}
    if(($state.pid -isnot [int] -and $state.pid -isnot [long]) -or $state.pid -le 0 -or $state.pid -gt [int]::MaxValue -or ($state.updatedAt -isnot [int] -and $state.updatedAt -isnot [long])){return $false}
    $age=$NowMs-$state.updatedAt
    if($age -lt -5000){return $false}
    if($state.state -eq 'idle'){
        if($age -gt 30000 -or $state.cleanupVerified -isnot [bool] -or -not $state.cleanupVerified){return $false}
    }else{
        # Running is published once per segment, not every guard heartbeat.
        # Cold health (210s), execution (240s) and verified retirement fit this
        # conservative 15-minute identity bound; expired state fails closed.
        if($age -gt 900000 -or $state.attemptId -isnot [string] -or $state.attemptId -notmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'){return $false}
        $execution=Join-Path $runtime 'execution.lock';Assert-GargantuaStartupPath $execution
        if(-not(Test-Path -LiteralPath $execution -PathType Leaf) -or -not(& $LockProbe $execution)){return $false}
    }
    $process=& $ProcessLookup ([int]$state.pid)
    if(-not $process -or $process.ProcessId -ne $state.pid -or $process.CommandLine -isnot [string]){return $false}
    $escaped=[regex]::Escape([IO.Path]::GetFullPath((Join-Path $ProjectRoot 'inference/executor.py')))
    if($process.CommandLine -notmatch ('(?i)(?:^|\s)(?:"'+$escaped+'"|'+$escaped+'(?=\s|$))')){return $false}
    if(-not(& $LockProbe $lockPath)){return $false}
    return $true
}
function Invoke-GargantuaStartup {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$ProjectRoot,[hashtable]$Operations=@{},
          [ValidateRange(1,40)][int]$DockerAttempts=24,[ValidateRange(1,90)][int]$HealthAttempts=72,[ValidateRange(1,12)][int]$MonitorAttempts=5,[ValidateRange(1,12)][int]$ExecutorAttempts=5,[ValidateRange(0,10)][int]$RetrySeconds=5)
    $ProjectRoot=[IO.Path]::GetFullPath($ProjectRoot)
    $root=Get-GargantuaAutomationRoot $ProjectRoot
    Assert-GargantuaStartupPath $root
    $defaults=@{
        PrivateRoot={param($c)
            New-Item -ItemType Directory -Path $c.runtime -Force|Out-Null
            if([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT){throw 'Windows owner ACL support is required.'}
            $identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name
            Invoke-GargantuaStartupNative -Command icacls -Arguments @($c.runtime,'/inheritance:r','/grant:r',"${identity}:(OI)(CI)F",'*S-1-5-18:(OI)(CI)F')|Out-Null
        }
        DockerReady={param($c)try{Assert-GargantuaLocalDockerContext;$answer=Invoke-GargantuaStartupNative -Command docker -Arguments @('info','--format','{{.OSType}}') -TimeoutSeconds 5;return $answer.Trim() -eq 'linux'}catch{return $false}}
        DesktopStart={param($c)Assert-GargantuaLocalDockerContext;Invoke-GargantuaStartupNative -Command docker -Arguments @('desktop','start','--detach','--timeout','15') -TimeoutSeconds 20 -AllowDetachedOutput|Out-Null}
        ComposeUp={param($c)Invoke-GargantuaStartupNative -Command docker -Arguments @('compose','--project-directory',$c.project,'-f',(Join-Path $c.project 'compose.yaml'),'up','-d','--no-build','--pull','never') -WorkingDirectory $c.project -TimeoutSeconds 180|Out-Null}
        StopBarrier={param($c)
            Wait-GargantuaPendingStopBarrier -ProjectRoot $c.project -CurrentHandler {
                param($Service)
                $text=Invoke-GargantuaStartupNative -Command docker -Arguments @('compose','--project-directory',$c.project,'-f',(Join-Path $c.project 'compose.yaml'),'ps','-a','-q',$Service) -WorkingDirectory $c.project -TimeoutSeconds 10
                $ids=@($text -split '\s+'|Where-Object{$_})
                if($ids.Count -gt 1 -or ($ids.Count -eq 1 -and $ids[0] -notmatch '^[a-f0-9]{12,64}$')){throw 'Pending stop guard received an ambiguous service identity.'}
                return [pscustomobject]@{exists=($ids.Count -eq 1);id=$(if($ids.Count){$ids[0]}else{''})}
            }
        }
        Healthy={param($c)Get-GargantuaStartupHealth -ProjectRoot $c.project}
        MonitorStart={param($c)Invoke-GargantuaStartupNative -Command pwsh.exe -Arguments @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',(Join-Path $c.project 'scripts/start-monitor.ps1')) -WorkingDirectory $c.project -TimeoutSeconds 30 -AllowDetachedOutput|Out-Null}
        MonitorReady={param($c)Test-GargantuaStartupMonitor -ProjectRoot $c.project}
        ExecutorStart={param($c)Invoke-GargantuaStartupNative -Command pwsh.exe -Arguments @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',(Join-Path $c.project 'scripts/derived-executor.ps1'),'-Action','start') -WorkingDirectory $c.project -TimeoutSeconds 30 -AllowDetachedOutput|Out-Null}
        ExecutorReady={param($c)Test-GargantuaStartupExecutor -ProjectRoot $c.project}
        Sleep={param($c)if($c.retrySeconds){Start-Sleep -Seconds $c.retrySeconds}}
        Clock={param($c)[DateTimeOffset]::UtcNow}
    }
    foreach($key in $Operations.Keys){if(-not $defaults.ContainsKey($key)){throw ('Unknown startup operation: '+$key)};$defaults[$key]=$Operations[$key]}
    $context=[pscustomobject]@{project=$ProjectRoot;runtime=$root;retrySeconds=$RetrySeconds}
    & $defaults.PrivateRoot $context
    $instance=$null;$lifecycle=$null;$events=[Collections.Generic.List[object]]::new()
    $started=& $defaults.Clock $context
    $result=[ordered]@{schemaVersion=1;pid=$PID;state='starting';reason=$null;phase='locking';startedAt=$started.ToString('o');finishedAt=$null;dockerAttempts=0;healthAttempts=0;monitorAttempts=0;executorAttempts=0}
    try{
        try{$instance=[IO.File]::Open((Join-Path $root 'startup.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}catch [IO.IOException]{if(($_.Exception.HResult -band 65535) -in @(32,33)){return [pscustomobject]@{schemaVersion=1;state='skipped';reason='startup-already-running'}};throw}
        $lifecycle=Open-GargantuaLifecycleLock -ProjectRoot $ProjectRoot
        if(-not $lifecycle){$result.state='deferred';$result.reason='lifecycle-busy';return [pscustomobject]$result}
        $phases=@('docker','stop-barrier','compose','health','monitor','executor')
        foreach($phase in $phases){
            $block=Get-GargantuaStartupBlock -ProjectRoot $ProjectRoot
            if($block){$result.state='skipped';$result.reason=$block;break}
            $now=& $defaults.Clock $context
            if(($now-$started).TotalSeconds -ge 840){throw 'startup-deadline'}
            $result.phase=$phase;$events.Add(@{phase=$phase;at=$now.ToString('o')})
            Write-GargantuaAutomationJson -Path (Join-Path $root 'startup-status.json') -Value $result
            switch($phase){
                'docker'{
                    $ready=& $defaults.DockerReady $context;$result.dockerAttempts=1
                    if(-not $ready){& $defaults.DesktopStart $context
                        for($attempt=1;$attempt -lt $DockerAttempts -and -not $ready;$attempt++){
                            if(Get-GargantuaStartupBlock $ProjectRoot){break}
                            $now=& $defaults.Clock $context;if(($now-$started).TotalSeconds -ge 840){throw 'startup-deadline'}
                            & $defaults.Sleep $context;$ready=& $defaults.DockerReady $context;$result.dockerAttempts++
                        }
                    }
                    if(-not $ready){if(Get-GargantuaStartupBlock $ProjectRoot){continue};throw 'docker-not-ready'}
                }
                'stop-barrier'{
                    $barrier=& $defaults.StopBarrier $context
                    if($barrier.status -eq 'cancelled'){$result.state='skipped';$result.reason='manual-stop'}
                    elseif($barrier.status -ne 'clear'){throw 'stop-barrier-not-clear'}
                }
                'compose'{& $defaults.ComposeUp $context}
                'health'{
                    $healthy=$false;$consecutive=0
                    for($attempt=0;$attempt -lt $HealthAttempts;$attempt++){
                        if(Get-GargantuaStartupBlock $ProjectRoot){break}
                        $result.healthAttempts++;$sample=& $defaults.Healthy $context
                        if($sample){$consecutive++}else{$consecutive=0}
                        if($consecutive -ge 2){$healthy=$true;break};& $defaults.Sleep $context
                        $now=& $defaults.Clock $context;if(($now-$started).TotalSeconds -ge 840){throw 'startup-deadline'}
                    }
                    if(-not $healthy){if(Get-GargantuaStartupBlock $ProjectRoot){continue};throw 'services-not-healthy'}
                }
                'monitor'{
                    $governor=& $defaults.MonitorReady $context;$result.monitorAttempts++
                    if(-not $governor){
                        & $defaults.MonitorStart $context
                        for($attempt=0;$attempt -lt $MonitorAttempts;$attempt++){
                            if(Get-GargantuaStartupBlock $ProjectRoot){break}
                            $governor=& $defaults.MonitorReady $context;$result.monitorAttempts++
                            if($governor){break}
                            $now=& $defaults.Clock $context;if(($now-$started).TotalSeconds -ge 840){throw 'startup-deadline'}
                            if($attempt+1 -lt $MonitorAttempts){& $defaults.Sleep $context}
                        }
                    }
                    if(-not $governor){if(Get-GargantuaStartupBlock $ProjectRoot){continue};throw 'monitor-not-ready'}
                }
                'executor'{
                    $executor=& $defaults.ExecutorReady $context;$result.executorAttempts++
                    if(-not $executor){
                        & $defaults.ExecutorStart $context
                        for($attempt=0;$attempt -lt $ExecutorAttempts;$attempt++){
                            if(Get-GargantuaStartupBlock $ProjectRoot){break}
                            $executor=& $defaults.ExecutorReady $context;$result.executorAttempts++
                            if($executor){break}
                            $now=& $defaults.Clock $context;if(($now-$started).TotalSeconds -ge 840){throw 'startup-deadline'}
                            if($attempt+1 -lt $ExecutorAttempts){& $defaults.Sleep $context}
                        }
                    }
                    if(-not $executor){if(Get-GargantuaStartupBlock $ProjectRoot){continue};throw 'executor-not-ready'}
                }
            }
            if($result.state -eq 'skipped'){break}
        }
        if($result.state -eq 'starting'){$result.state='ready';$result.reason='services-healthy';$result.phase='complete'}
    }catch{
        $result.state='failed';$result.reason=switch($_.Exception.Message){'docker-not-ready'{'docker-not-ready'};'services-not-healthy'{'services-not-healthy'};'monitor-not-ready'{'monitor-not-ready'};'executor-not-ready'{'executor-not-ready'};'startup-deadline'{'startup-deadline'};default{'phase-failed'}}
        # Never publish command stderr, credentials or user data in startup metadata.
    }finally{
        try{if($instance){
            $result.finishedAt=(& $defaults.Clock $context).ToString('o')
            Write-GargantuaAutomationJson -Path (Join-Path $root 'startup-status.json') -Value $result
            $logPath=Join-Path $root 'startup-events.jsonl'
            if((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -gt 64KB){
                $previous=$logPath+'.1';if(Test-Path -LiteralPath $previous){Remove-Item -LiteralPath $previous -Force};[IO.File]::Move($logPath,$previous)
            }
            $events.Add(@{state=$result.state;reason=$result.reason;phase=$result.phase;at=$result.finishedAt})
            $lines=(@($events.ToArray()|ForEach-Object{ConvertTo-Json -InputObject $_ -Compress}) -join "`n")+"`n"
            [IO.File]::AppendAllText($logPath,$lines,[Text.UTF8Encoding]::new($false))
        }}finally{if($lifecycle){$lifecycle.Dispose()};if($instance){$instance.Dispose()}}
    }
    return [pscustomobject]$result
}
