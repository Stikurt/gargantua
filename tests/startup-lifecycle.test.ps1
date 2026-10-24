<#
Offline lifecycle fault tests. All production Docker/start operations are injected;
only owned temporary fixtures and two short-lived benign PowerShell children run.
#>
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
. (Join-Path $project 'scripts/startup-common.ps1')
$cases=[Collections.Generic.List[object]]::new()
$token=[Guid]::NewGuid().ToString('N')
$root=[IO.Path]::GetFullPath((Join-Path $project ('.local/test-results/startup-lifecycle-'+$token)))
$fixtures=Join-Path $root 'fixtures'
Assert-GargantuaStartupPath $root
New-Item -ItemType Directory -Path $fixtures -Force|Out-Null
Write-GargantuaAutomationJson -Path (Join-Path $root 'test-owner.json') -Value @{root=$root;token=$token}
function Assert-StartupTest([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message}}
function Test-StartupCase([string]$Name,[scriptblock]$Body){
    try{& $Body;$cases.Add(@{name=$Name;status='PASS'});Write-Host "PASS $Name"}
    catch{$cases.Add(@{name=$Name;status='FAIL';error=$_.Exception.Message});Write-Host "FAIL ${Name}: $($_.Exception.Message)"}
}
function New-StartupFixture([string]$Name){
    $path=Join-Path $fixtures $Name;New-Item -ItemType Directory -Path $path -Force|Out-Null
    $script:Mock=[pscustomobject]@{calls=[Collections.Generic.List[string]]::new();docker=0;healthy=0;dockerReadyAt=1;healthyAt=1;monitorStarted=$false;executorStarted=$false;fail='';sleepAction=$null;clock=[DateTimeOffset]::Parse('2026-10-23T00:00:00Z')}
    return $path
}
function New-StartupOperations {
    return @{
        PrivateRoot={param($c)New-Item -ItemType Directory -Path $c.runtime -Force|Out-Null}
        DockerReady={param($c)$script:Mock.calls.Add('probe');$script:Mock.docker++;return $script:Mock.docker -ge $script:Mock.dockerReadyAt}
        DesktopStart={param($c)$script:Mock.calls.Add('desktop');if($script:Mock.fail -eq 'desktop'){throw 'PRIVATE_MARKER desktop failure'}}
        ComposeUp={param($c)$script:Mock.calls.Add('compose');if($script:Mock.fail -eq 'compose'){throw 'PRIVATE_MARKER compose failure'}}
        StopBarrier={param($c)[pscustomobject]@{status='clear';waitedMs=0;pendingCount=0}}
        Healthy={param($c)$script:Mock.calls.Add('health');$script:Mock.healthy++;return $script:Mock.healthy -ge $script:Mock.healthyAt}
        MonitorStart={param($c)$script:Mock.calls.Add('monitor');if($script:Mock.fail -eq 'monitor'){throw 'PRIVATE_MARKER monitor failure'};$script:Mock.monitorStarted=$true}
        MonitorReady={param($c)$script:Mock.calls.Add('governor');return $script:Mock.monitorStarted}
        ExecutorStart={param($c)$script:Mock.calls.Add('executor');if($script:Mock.fail -eq 'executor'){throw 'PRIVATE_MARKER executor failure'};$script:Mock.executorStarted=$true}
        ExecutorReady={param($c)$script:Mock.calls.Add('executor-proof');return $script:Mock.executorStarted}
        Sleep={param($c)$script:Mock.calls.Add('sleep');if($script:Mock.sleepAction){& $script:Mock.sleepAction $c};$script:Mock.clock=$script:Mock.clock.AddSeconds(5)}
        Clock={param($c)return $script:Mock.clock}
    }
}
function Invoke-StartupFixture([string]$Path,[int]$DockerAttempts=4,[int]$HealthAttempts=4){
    return Invoke-GargantuaStartup -ProjectRoot $Path -Operations (New-StartupOperations) -DockerAttempts $DockerAttempts -HealthAttempts $HealthAttempts -RetrySeconds 0
}
function New-StartupMonitorEvidence([string]$Path,[long]$AgeMs=0){
    $runtime=Join-Path $Path '.local/runtime';New-Item -ItemType Directory -Path $runtime -Force|Out-Null
    [IO.File]::WriteAllText((Join-Path $runtime 'monitor.pid'),'99999')
    Write-GargantuaAutomationJson -Path (Join-Path $runtime 'resources.json') -Value @{schemaVersion=2;updatedAt=([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()-$AgeMs);metricsAvailable=$false;allowHeavy=$false;maxHeavyJobs=1}
    $script:MonitorEvidencePath=$Path
    return [IO.File]::Open((Join-Path $runtime 'monitor.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
}
function Get-StartupMonitorProcess([int]$MonitorId){
    return [pscustomobject]@{ProcessId=$MonitorId;CommandLine=('pwsh.exe -NoProfile -File "'+(Join-Path $script:MonitorEvidencePath 'scripts/resource-monitor.ps1')+'"')}
}
function New-StartupExecutorEvidence([string]$Path,[string]$State='idle',[long]$AgeMs=0){
    $runtime=Join-Path $Path '.local/inference-runtime';New-Item -ItemType Directory -Path $runtime -Force|Out-Null
    Write-GargantuaAutomationJson -Path (Join-Path $runtime 'daemon.json') -Value @{schemaVersion=1;pid=88888;state=$State;cleanupVerified=($State -eq 'idle');updatedAt=([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()-$AgeMs);attemptId='12345678-1234-4123-8123-123456789abc'}
    $script:ExecutorEvidencePath=$Path
    return [IO.File]::Open((Join-Path $runtime 'daemon.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
}
function Get-StartupExecutorProcess([int]$ExecutorId){
    return [pscustomobject]@{ProcessId=$ExecutorId;CommandLine=('python.exe -E -s -B -u "'+(Join-Path $script:ExecutorEvidencePath 'inference/executor.py')+'" --spool example')}
}
function New-StartupPipeLauncher {
    $path=Join-Path $fixtures 'inherited-pipe-launcher.py'
    if(-not(Test-Path -LiteralPath $path)){
        [IO.File]::WriteAllText($path,@'
import json
import os
from pathlib import Path
import subprocess
import sys
for stream in (sys.stdout, sys.stderr):
    os.set_inheritable(stream.fileno(), True)
child = subprocess.Popen([sys.executable, "-E", "-s", "-B", "-c", "import time; time.sleep(9)"],
    stdin=subprocess.DEVNULL, stdout=sys.stdout, stderr=sys.stderr, close_fds=False,
    creationflags=subprocess.CREATE_NO_WINDOW)
Path(sys.argv[1]).write_text(json.dumps({"pid": child.pid}), encoding="utf-8")
print("PRIVATE_PIPE_MARKER", flush=True)
raise SystemExit(int(sys.argv[2]))
'@,[Text.UTF8Encoding]::new($false))
    }
    return $path
}
try{
    Test-StartupCase 'already ready Docker is reused and helpers follow healthy services' {
        $path=New-StartupFixture 'ready';$result=Invoke-StartupFixture $path
        Assert-StartupTest ($result.state -eq 'ready') 'Ready boot was rejected.'
        Assert-StartupTest (($script:Mock.calls -join ',') -eq 'probe,compose,health,sleep,health,governor,monitor,governor,executor-proof,executor,executor-proof') 'Services were not admitted in their safe dependency order.'
    }
    Test-StartupCase 'slow Docker is started once and readiness is retried within a bound' {
        $path=New-StartupFixture 'slow-docker';$script:Mock.dockerReadyAt=3;$result=Invoke-StartupFixture $path
        Assert-StartupTest ($result.state -eq 'ready' -and $result.dockerAttempts -eq 3) 'Cold Docker readiness was not retried.'
        Assert-StartupTest (@($script:Mock.calls|Where-Object{$_ -eq 'desktop'}).Count -eq 1) 'Docker Desktop was launched repeatedly.'
    }
    Test-StartupCase 'unavailable Docker reaches the attempt bound without starting services' {
        $path=New-StartupFixture 'absent-docker';$script:Mock.dockerReadyAt=99;$result=Invoke-StartupFixture $path
        Assert-StartupTest ($result.state -eq 'failed' -and $result.reason -eq 'docker-not-ready' -and $result.dockerAttempts -eq 4) 'Docker failure was unbounded or misreported.'
        Assert-StartupTest ('compose' -notin $script:Mock.calls -and 'monitor' -notin $script:Mock.calls) 'Unavailable Docker admitted dependent work.'
    }
    Test-StartupCase 'manual stop persists across a new startup invocation' {
        $path=New-StartupFixture 'manual-stop';$runtime=Get-GargantuaAutomationRoot $path;New-Item -ItemType Directory -Path $runtime -Force|Out-Null
        Write-GargantuaAutomationJson -Path (Join-Path $runtime 'manual-stop.json') -Value @{reason='user-stop'}
        foreach($i in 1..2){$result=Invoke-StartupFixture $path;Assert-StartupTest ($result.state -eq 'skipped' -and $result.reason -eq 'manual-stop') 'Manual stop was resurrected.'}
        Assert-StartupTest ($script:Mock.calls.Count -eq 0) 'Automatic start did work behind a manual stop.'
    }
    Test-StartupCase 'active lifecycle owner defers startup and its release permits a later run' {
        $path=New-StartupFixture 'busy-lifecycle';$lock=Open-GargantuaLifecycleLock $path
        try{$result=Invoke-StartupFixture $path;Assert-StartupTest ($result.state -eq 'deferred' -and $result.reason -eq 'lifecycle-busy' -and $script:Mock.calls.Count -eq 0) 'Concurrent lifecycle work was not respected.'}finally{$lock.Dispose()}
        $result=Invoke-StartupFixture $path;Assert-StartupTest ($result.state -eq 'ready') 'Released persistent lock remained falsely busy.'
    }
    Test-StartupCase 'second startup instance cannot replace the first instance status' {
        $path=New-StartupFixture 'duplicate-start';$runtime=Get-GargantuaAutomationRoot $path;New-Item -ItemType Directory -Path $runtime -Force|Out-Null
        $lock=[IO.File]::Open((Join-Path $runtime 'startup.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
        try{$result=Invoke-StartupFixture $path;Assert-StartupTest ($result.reason -eq 'startup-already-running' -and $script:Mock.calls.Count -eq 0) 'Second instance was admitted.';Assert-StartupTest (-not(Test-Path (Join-Path $runtime 'startup-status.json'))) 'Second instance overwrote owner status.'}finally{$lock.Dispose()}
    }
    Test-StartupCase 'legacy active snapshot lock blocks even without the unified lock' {
        $path=New-StartupFixture 'legacy-snapshot';$local=Join-Path $path '.local';New-Item -ItemType Directory -Path $local -Force|Out-Null
        $lock=[IO.File]::Open((Join-Path $local 'backup-snapshot.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
        try{$result=Invoke-StartupFixture $path;Assert-StartupTest ($result.reason -eq 'backup-snapshot' -and $script:Mock.calls.Count -eq 0) 'Active old snapshot lock was bypassed.'}finally{$lock.Dispose()}
    }
    Test-StartupCase 'unheld old GUID marker does not disable all future sign-ins' {
        $path=New-StartupFixture 'stale-snapshot';$local=Join-Path $path '.local';New-Item -ItemType Directory -Path $local -Force|Out-Null
        $lockPath=Join-Path $local 'backup-snapshot.lock';$guid=[Guid]::NewGuid().ToString('N');[IO.File]::WriteAllText($lockPath,$guid)
        $result=Invoke-StartupFixture $path;Assert-StartupTest ($result.state -eq 'ready') 'A crashed old snapshot was mistaken for a live process.'
        Assert-StartupTest ((Get-Content -LiteralPath $lockPath -Raw) -eq $guid) 'Startup deleted or rewrote old snapshot evidence.'
    }
    Test-StartupCase 'unknown lock contents fail closed and remain available for inspection' {
        $path=New-StartupFixture 'unknown-snapshot';$local=Join-Path $path '.local';New-Item -ItemType Directory -Path $local -Force|Out-Null
        $lockPath=Join-Path $local 'backup-snapshot.lock';[IO.File]::WriteAllText($lockPath,'unknown-owner')
        $result=Invoke-StartupFixture $path;Assert-StartupTest ($result.reason -eq 'backup-lock-needs-review' -and $script:Mock.calls.Count -eq 0) 'Malformed lock metadata admitted startup.'
        Assert-StartupTest ((Get-Content -LiteralPath $lockPath -Raw) -eq 'unknown-owner') 'Unknown marker was removed.'
    }
    Test-StartupCase 'manual stop arriving during Docker readiness cancels remaining startup' {
        $path=New-StartupFixture 'interrupted-start';$script:Mock.dockerReadyAt=99
        $script:Mock.sleepAction={param($c)Write-GargantuaAutomationJson -Path (Join-Path $c.runtime 'manual-stop.json') -Value @{reason='stop-during-start'}}
        $result=Invoke-StartupFixture $path
        Assert-StartupTest ($result.reason -eq 'manual-stop' -and 'compose' -notin $script:Mock.calls -and 'monitor' -notin $script:Mock.calls) 'Late user stop was ignored.'
    }
    Test-StartupCase 'compose failure preserves diagnostic phase and suppresses private output' {
        $path=New-StartupFixture 'compose-failure';$script:Mock.fail='compose';$result=Invoke-StartupFixture $path
        Assert-StartupTest ($result.state -eq 'failed' -and $result.phase -eq 'compose' -and 'monitor' -notin $script:Mock.calls) 'Compose failure admitted helpers.'
        $runtime=Get-GargantuaAutomationRoot $path;$text=(Get-Content -LiteralPath (Join-Path $runtime 'startup-status.json') -Raw)+(Get-Content -LiteralPath (Join-Path $runtime 'startup-events.jsonl') -Raw)
        Assert-StartupTest (-not $text.Contains('PRIVATE_MARKER')) 'Command contents escaped to lifecycle metadata.'
        $lock=Open-GargantuaLifecycleLock $path;Assert-StartupTest ($null -ne $lock) 'Failed startup retained lifecycle ownership.';$lock.Dispose()
    }
    Test-StartupCase 'slow scanner readiness gates both host helpers until services are healthy' {
        $path=New-StartupFixture 'slow-health';$script:Mock.healthyAt=3;$result=Invoke-StartupFixture $path
        Assert-StartupTest ($result.state -eq 'ready' -and $result.healthAttempts -eq 4) 'Healthy service retries were not applied.'
        Assert-StartupTest ($script:Mock.calls.IndexOf('monitor') -gt $script:Mock.calls.LastIndexOf('health')) 'Host helper preceded final health confirmation.'
    }
    Test-StartupCase 'persistent unhealthy services reach a finite bound and never start heavy executor' {
        $path=New-StartupFixture 'unhealthy';$script:Mock.healthyAt=99;$result=Invoke-StartupFixture $path
        Assert-StartupTest ($result.reason -eq 'services-not-healthy' -and $result.healthAttempts -eq 4 -and 'executor' -notin $script:Mock.calls) 'Unhealthy services admitted execution or retried without bound.'
    }
    Test-StartupCase 'resource monitor failure prevents executor admission' {
        $path=New-StartupFixture 'monitor-failure';$script:Mock.fail='monitor';$result=Invoke-StartupFixture $path
        Assert-StartupTest ($result.state -eq 'failed' -and $result.phase -eq 'monitor' -and 'executor' -notin $script:Mock.calls) 'Executor bypassed missing monitor.'
    }
    Test-StartupCase 'existing owned governor with fresh fail-closed sample is reused without another launch' {
        $path=New-StartupFixture 'governor-existing';$lock=New-StartupMonitorEvidence $path
        try{
            $operations=New-StartupOperations;$operations.MonitorReady={param($c)Test-GargantuaStartupMonitor -ProjectRoot $c.project -ProcessLookup ${function:Get-StartupMonitorProcess}}
            $result=Invoke-GargantuaStartup -ProjectRoot $path -Operations $operations -RetrySeconds 0
            Assert-StartupTest ($result.state -eq 'ready' -and 'monitor' -notin $script:Mock.calls -and 'executor' -in $script:Mock.calls) 'Existing fresh fail-closed governor was not reused.'
        }finally{$lock.Dispose()}
    }
    Test-StartupCase 'monitor lock access denied cannot be mistaken for an already running governor' {
        $path=New-StartupFixture 'governor-denied';$lock=New-StartupMonitorEvidence $path
        try{
            $operations=New-StartupOperations;$operations.MonitorReady={param($c)Test-GargantuaStartupMonitor -ProjectRoot $c.project -ProcessLookup ${function:Get-StartupMonitorProcess} -LockProbe {param($p)throw [UnauthorizedAccessException]::new('Injected lock ACL denial')}}
            $result=Invoke-GargantuaStartup -ProjectRoot $path -Operations $operations -RetrySeconds 0
            Assert-StartupTest ($result.state -eq 'failed' -and $result.phase -eq 'monitor' -and 'executor' -notin $script:Mock.calls) 'Inaccessible monitor lock produced a ready boot.'
        }finally{$lock.Dispose()}
    }
    Test-StartupCase 'stale PID pointing at another script cannot prove resource governance' {
        $path=New-StartupFixture 'governor-stale-pid';$lock=New-StartupMonitorEvidence $path
        try{
            $operations=New-StartupOperations;$operations.MonitorReady={param($c)Test-GargantuaStartupMonitor -ProjectRoot $c.project -ProcessLookup {param($id)[pscustomobject]@{ProcessId=$id;CommandLine='pwsh.exe -File unrelated.ps1'}}}
            $result=Invoke-GargantuaStartup -ProjectRoot $path -Operations $operations -MonitorAttempts 2 -RetrySeconds 0
            Assert-StartupTest ($result.state -eq 'failed' -and $result.reason -eq 'monitor-not-ready' -and 'executor' -notin $script:Mock.calls) 'Unrelated process and a stale PID admitted executor.'
        }finally{$lock.Dispose()}
    }
    Test-StartupCase 'a live owned monitor without a fresh published sample cannot produce ready' {
        $path=New-StartupFixture 'governor-stale-sample';$lock=New-StartupMonitorEvidence $path 60000
        try{
            $operations=New-StartupOperations;$operations.MonitorReady={param($c)Test-GargantuaStartupMonitor -ProjectRoot $c.project -ProcessLookup ${function:Get-StartupMonitorProcess}}
            $result=Invoke-GargantuaStartup -ProjectRoot $path -Operations $operations -MonitorAttempts 2 -RetrySeconds 0
            Assert-StartupTest ($result.reason -eq 'monitor-not-ready' -and 'executor' -notin $script:Mock.calls) 'A hung monitor with stale output was reported ready.'
        }finally{$lock.Dispose()}
    }
    Test-StartupCase 'fresh monitor metadata without an active lock owner cannot produce ready' {
        $path=New-StartupFixture 'governor-unheld';$lock=New-StartupMonitorEvidence $path;$lock.Dispose()
        $operations=New-StartupOperations;$operations.MonitorReady={param($c)Test-GargantuaStartupMonitor -ProjectRoot $c.project -ProcessLookup ${function:Get-StartupMonitorProcess}}
        $result=Invoke-GargantuaStartup -ProjectRoot $path -Operations $operations -MonitorAttempts 2 -RetrySeconds 0
        Assert-StartupTest ($result.reason -eq 'monitor-not-ready' -and 'executor' -notin $script:Mock.calls) 'Recent metadata alone admitted executor after its publisher stopped.'
    }
    Test-StartupCase 'unknown metrics never admit a forged heavy-work permission' {
        $path=New-StartupFixture 'governor-invalid-permit';$lock=New-StartupMonitorEvidence $path
        try{
            Write-GargantuaAutomationJson -Path (Join-Path $path '.local/runtime/resources.json') -Value @{schemaVersion=2;updatedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();metricsAvailable=$false;allowHeavy=$true}
            $proof=Test-GargantuaStartupMonitor -ProjectRoot $path -ProcessLookup ${function:Get-StartupMonitorProcess}
            Assert-StartupTest (-not $proof) 'An inconsistent published permit was trusted.'
        }finally{$lock.Dispose()}
    }
    Test-StartupCase 'executor failure is a failed boot rather than a false healthy success' {
        $path=New-StartupFixture 'executor-failure';$script:Mock.fail='executor';$result=Invoke-StartupFixture $path
        Assert-StartupTest ($result.state -eq 'failed' -and $result.phase -eq 'executor') 'Missing executor was reported as a complete boot.'
    }
    Test-StartupCase 'fresh idle executor with a live identity and daemon lock is reused without launching' {
        $path=New-StartupFixture 'executor-existing';$lock=New-StartupExecutorEvidence $path
        try{
            $operations=New-StartupOperations;$operations.ExecutorReady={param($c)Test-GargantuaStartupExecutor -ProjectRoot $c.project -ProcessLookup ${function:Get-StartupExecutorProcess}}
            $result=Invoke-GargantuaStartup -ProjectRoot $path -Operations $operations -RetrySeconds 0
            Assert-StartupTest ($result.state -eq 'ready' -and 'executor' -notin $script:Mock.calls) 'Healthy executor was not reused safely.'
        }finally{$lock.Dispose()}
    }
    Test-StartupCase 'executor helper exit zero cannot mask an unrelated stale PID' {
        $path=New-StartupFixture 'executor-stale-pid';$lock=New-StartupExecutorEvidence $path
        try{
            $operations=New-StartupOperations;$operations.ExecutorReady={param($c)Test-GargantuaStartupExecutor -ProjectRoot $c.project -ProcessLookup {param($id)[pscustomobject]@{ProcessId=$id;CommandLine='python.exe unrelated.py'}}}
            $result=Invoke-GargantuaStartup -ProjectRoot $path -Operations $operations -ExecutorAttempts 2 -RetrySeconds 0
            Assert-StartupTest ($result.state -eq 'failed' -and $result.reason -eq 'executor-not-ready') 'Helper exit zero replaced live executor proof.'
        }finally{$lock.Dispose()}
    }
    Test-StartupCase 'executor lock access denial cannot be treated as proof of ownership' {
        $path=New-StartupFixture 'executor-denied';$lock=New-StartupExecutorEvidence $path
        try{
            $operations=New-StartupOperations;$operations.ExecutorReady={param($c)Test-GargantuaStartupExecutor -ProjectRoot $c.project -ProcessLookup ${function:Get-StartupExecutorProcess} -LockProbe {param($p)throw [UnauthorizedAccessException]::new('Injected executor lock denial')}}
            $result=Invoke-GargantuaStartup -ProjectRoot $path -Operations $operations -RetrySeconds 0
            Assert-StartupTest ($result.state -eq 'failed' -and $result.phase -eq 'executor') 'Executor permission failure produced ready status.'
        }finally{$lock.Dispose()}
    }
    Test-StartupCase 'stale idle executor output fails even when its matching process and lock remain' {
        $path=New-StartupFixture 'executor-stale-idle';$lock=New-StartupExecutorEvidence $path 'idle' 60000
        try{
            $operations=New-StartupOperations;$operations.ExecutorReady={param($c)Test-GargantuaStartupExecutor -ProjectRoot $c.project -ProcessLookup ${function:Get-StartupExecutorProcess}}
            $result=Invoke-GargantuaStartup -ProjectRoot $path -Operations $operations -ExecutorAttempts 2 -RetrySeconds 0
            Assert-StartupTest ($result.reason -eq 'executor-not-ready') 'Hung idle executor metadata was trusted.'
        }finally{$lock.Dispose()}
    }
    Test-StartupCase 'fresh executor metadata without its held daemon lock cannot produce ready' {
        $path=New-StartupFixture 'executor-unheld';$lock=New-StartupExecutorEvidence $path;$lock.Dispose()
        $operations=New-StartupOperations;$operations.ExecutorReady={param($c)Test-GargantuaStartupExecutor -ProjectRoot $c.project -ProcessLookup ${function:Get-StartupExecutorProcess}}
        $result=Invoke-GargantuaStartup -ProjectRoot $path -Operations $operations -ExecutorAttempts 2 -RetrySeconds 0
        Assert-StartupTest ($result.reason -eq 'executor-not-ready') 'Released daemon lock still authorized readiness.'
    }
    Test-StartupCase 'active segment may reuse a running executor older than idle heartbeat bound' {
        $path=New-StartupFixture 'executor-running';$lock=New-StartupExecutorEvidence $path 'running' 120000
        $execution=[IO.File]::Open((Join-Path $path '.local/inference-runtime/execution.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
        try{
            $proof=Test-GargantuaStartupExecutor -ProjectRoot $path -ProcessLookup ${function:Get-StartupExecutorProcess}
            Assert-StartupTest $proof 'Legitimate bounded running segment was mistaken for stale idle metadata.'
        }finally{$execution.Dispose();$lock.Dispose()}
    }
    Test-StartupCase 'running executor needs its execution lock and cannot exceed bounded running age' {
        $path=New-StartupFixture 'executor-running-invalid';$lock=New-StartupExecutorEvidence $path 'running' 120000
        $executionPath=Join-Path $path '.local/inference-runtime/execution.lock';[IO.File]::WriteAllText($executionPath,'')
        try{
            Assert-StartupTest (-not(Test-GargantuaStartupExecutor -ProjectRoot $path -ProcessLookup ${function:Get-StartupExecutorProcess})) 'Running without an execution owner was accepted.'
            $execution=[IO.File]::Open($executionPath,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
            try{
                Write-GargantuaAutomationJson -Path (Join-Path $path '.local/inference-runtime/daemon.json') -Value @{schemaVersion=1;pid=88888;state='running';cleanupVerified=$false;attemptId='12345678-1234-4123-8123-123456789abc';updatedAt=([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()-901000)}
                Assert-StartupTest (-not(Test-GargantuaStartupExecutor -ProjectRoot $path -ProcessLookup ${function:Get-StartupExecutorProcess})) 'Expired running metadata was accepted indefinitely.'
            }finally{$execution.Dispose()}
        }finally{$lock.Dispose()}
    }
    Test-StartupCase 'blocked cleanup executor state is never a ready process' {
        $path=New-StartupFixture 'executor-blocked';$lock=New-StartupExecutorEvidence $path 'blocked_cleanup'
        try{Assert-StartupTest (-not(Test-GargantuaStartupExecutor -ProjectRoot $path -ProcessLookup ${function:Get-StartupExecutorProcess})) 'Blocked cleanup was accepted as healthy executor.'}finally{$lock.Dispose()}
    }
    Test-StartupCase 'overall deadline stops retries even when attempt count remains' {
        $path=New-StartupFixture 'deadline';$script:Mock.dockerReadyAt=99;$script:Mock.sleepAction={param($c)$script:Mock.clock=$script:Mock.clock.AddMinutes(15)}
        $result=Invoke-StartupFixture $path
        Assert-StartupTest ($result.reason -eq 'startup-deadline' -and $result.dockerAttempts -lt 4 -and 'compose' -notin $script:Mock.calls) 'Deadline did not bound readiness attempts.'
    }
    Test-StartupCase 'status of an uninitialized project is read-only and does not launch anything' {
        $path=New-StartupFixture 'readonly';$status=Get-GargantuaStartupStatus -ProjectRoot $path
        Assert-StartupTest ($null -eq $status.last -and $null -eq $status.block -and -not(Test-Path -LiteralPath (Join-Path $path '.local'))) 'Read-only status created lifecycle files.'
    }
    Test-StartupCase 'event history rotates within a fixed two-file bound' {
        $path=New-StartupFixture 'logs';$runtime=Get-GargantuaAutomationRoot $path;New-Item -ItemType Directory -Path $runtime -Force|Out-Null
        $log=Join-Path $runtime 'startup-events.jsonl';[IO.File]::WriteAllText($log,('x'*65537))
        $result=Invoke-StartupFixture $path
        Assert-StartupTest ((Get-Item -LiteralPath $log).Length -lt 64KB -and (Test-Path -LiteralPath ($log+'.1'))) 'Bounded log rotation was not applied.'
    }
    Test-StartupCase 'lifecycle ownership is exclusive across Windows processes' {
        $path=New-StartupFixture 'cross-process';$child=Join-Path $fixtures 'lock-child.ps1'
        [IO.File]::WriteAllText($child,@'
param([string]$Helper,[string]$Project)
$ErrorActionPreference='Stop'
. $Helper
$lock=Open-GargantuaLifecycleLock -ProjectRoot $Project
if(-not $lock){exit 17}
$lock.Dispose();exit 0
'@,[Text.UTF8Encoding]::new($false))
        $pwsh=(Get-Command pwsh.exe -CommandType Application|Select-Object -First 1).Source;$helper=Join-Path $project 'scripts/startup-common.ps1'
        $lock=Open-GargantuaLifecycleLock $path
        try{& $pwsh -NoProfile -NonInteractive -File $child -Helper $helper -Project $path;Assert-StartupTest ($LASTEXITCODE -eq 17) 'Another process acquired an active lifecycle lock.'}finally{$lock.Dispose()}
        & $pwsh -NoProfile -NonInteractive -File $child -Helper $helper -Project $path;Assert-StartupTest ($LASTEXITCODE -eq 0) 'Persistent lock did not release after process completion.'
    }
    Test-StartupCase 'native command timeout is finite and does not leak stderr' {
        $timer=[Diagnostics.Stopwatch]::StartNew();$message=''
        try{Invoke-GargantuaStartupNative -Command pwsh.exe -Arguments @('-NoProfile','-NonInteractive','-Command','[Console]::Error.WriteLine("PRIVATE_NATIVE_MARKER"); Start-Sleep -Seconds 30') -TimeoutSeconds 1|Out-Null}catch{$message=$_.Exception.Message}
        Assert-StartupTest ($message.Contains('timed out') -and -not $message.Contains('PRIVATE_NATIVE_MARKER') -and $timer.Elapsed.TotalSeconds -lt 10) 'Native timeout did not bound its own child safely.'
    }
    Test-StartupCase 'default native mode rejects inherited pipe EOF loss within a finite bound' {
        $python=Get-GargantuaPythonRuntime;$launcher=New-StartupPipeLauncher;$pidFile=Join-Path $fixtures 'pipe-default.json';$message='';$timer=[Diagnostics.Stopwatch]::StartNew()
        try{Invoke-GargantuaStartupNative -Command $python.command -Arguments (@($python.prefix)+@($launcher,$pidFile,'0')) -TimeoutSeconds 10|Out-Null}catch{$message=$_.Exception.Message}
        Assert-StartupTest ($message.Contains('output did not close') -and -not $message.Contains('PRIVATE_PIPE_MARKER') -and $timer.Elapsed.TotalSeconds -lt 8) 'Default native mode ignored inherited pipe loss or leaked output.'
    }
    Test-StartupCase 'explicit detached mode accepts zero parent exit while separately provable child stays alive' {
        $python=Get-GargantuaPythonRuntime;$launcher=New-StartupPipeLauncher;$pidFile=Join-Path $fixtures 'pipe-detached.json';$timer=[Diagnostics.Stopwatch]::StartNew()
        $output=Invoke-GargantuaStartupNative -Command $python.command -Arguments (@($python.prefix)+@($launcher,$pidFile,'0')) -TimeoutSeconds 10 -AllowDetachedOutput
        $child=Get-Content -LiteralPath $pidFile -Raw|ConvertFrom-Json;$alive=Get-Process -Id ([int]$child.pid) -ErrorAction SilentlyContinue
        Assert-StartupTest ($null -ne $alive -and $output -eq '' -and $timer.Elapsed.TotalSeconds -lt 8) 'Explicit detached mode blocked on inherited pipe or terminated its valid child.'
    }
    Test-StartupCase 'detached output permission never hides a nonzero parent exit code' {
        $python=Get-GargantuaPythonRuntime;$launcher=New-StartupPipeLauncher;$pidFile=Join-Path $fixtures 'pipe-failed.json';$message='';$timer=[Diagnostics.Stopwatch]::StartNew()
        try{Invoke-GargantuaStartupNative -Command $python.command -Arguments (@($python.prefix)+@($launcher,$pidFile,'7')) -TimeoutSeconds 10 -AllowDetachedOutput|Out-Null}catch{$message=$_.Exception.Message}
        Assert-StartupTest ($message.Contains('exit 7') -and -not $message.Contains('PRIVATE_PIPE_MARKER') -and $timer.Elapsed.TotalSeconds -lt 8) 'Detached output permission masked a launcher failure.'
    }
    Test-StartupCase 'managed children use local Docker without changing the parent environment' {
        $beforeContext=$env:DOCKER_CONTEXT;$beforeHost=$env:DOCKER_HOST
        try{
            $env:DOCKER_CONTEXT='offline-test-remote';$env:DOCKER_HOST='tcp://127.0.0.1:1'
            $text=Invoke-GargantuaStartupNative -Command pwsh.exe -Arguments @('-NoProfile','-NonInteractive','-Command','[Console]::Write(($env:DOCKER_CONTEXT+"|"+$env:DOCKER_HOST))') -TimeoutSeconds 10
            Assert-StartupTest ($text -eq 'desktop-linux|' -and $env:DOCKER_CONTEXT -eq 'offline-test-remote' -and $env:DOCKER_HOST -eq 'tcp://127.0.0.1:1') 'Managed child inherited remote Docker or changed the parent environment.'
        }finally{$env:DOCKER_CONTEXT=$beforeContext;$env:DOCKER_HOST=$beforeHost}
    }
    Test-StartupCase 'reviewable logon task uses current-user token without elevation or password' {
        $definition=& (Join-Path $project 'scripts/startup-task.ps1')
        [xml]$xml=$definition.xml;$ns=[Xml.XmlNamespaceManager]::new($xml.NameTable);$ns.AddNamespace('t','http://schemas.microsoft.com/windows/2004/02/mit/task')
        Assert-StartupTest ($xml.SelectSingleNode('//t:LogonType',$ns).InnerText -eq 'InteractiveToken' -and $xml.SelectSingleNode('//t:RunLevel',$ns).InnerText -eq 'LeastPrivilege') 'Logon task requested an elevated or stored-password identity.'
        Assert-StartupTest ($xml.SelectSingleNode('//t:LogonTrigger/t:UserId',$ns).InnerText -eq [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) 'Task could run on another user sign-in.'
        Assert-StartupTest ($xml.SelectSingleNode('//t:MultipleInstancesPolicy',$ns).InnerText -eq 'IgnoreNew' -and $xml.SelectSingleNode('//t:ExecutionTimeLimit',$ns).InnerText -eq 'PT15M') 'Task lost concurrency/deadline constraints.'
        Assert-StartupTest ($definition.registered -eq $false -and $definition.arguments.Contains('-WindowStyle Hidden')) 'Definition helper mutated scheduling state or exposed a console.'
    }
}catch{$cases.Add(@{name='harness';status='FAIL';error=$_.Exception.Message})}
finally{
    try{
        $owner=Get-Content -LiteralPath (Join-Path $root 'test-owner.json') -Raw|ConvertFrom-Json
        if($owner.token -ne $token -or $owner.root -ne $root -or -not $fixtures.StartsWith($root+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Owned fixture cleanup refused.'}
        Assert-GargantuaStartupPath $fixtures
        Remove-Item -LiteralPath $fixtures -Recurse -Force
    }catch{$cases.Add(@{name='owned-cleanup';status='FAIL';error=$_.Exception.Message})}
    $failed=@($cases.ToArray()|Where-Object status -eq 'FAIL')
    Write-GargantuaAutomationJson -Path (Join-Path $root 'report.json') -Value @{status=$(if($failed.Count){'FAIL'}else{'PASS'});cases=$cases.ToArray();passed=$cases.Count-$failed.Count;failed=$failed.Count;productionDockerStarted=$false;productionServicesChanged=$false;scheduledTasksRegistered=$false}
}
Write-Host ("Startup lifecycle checks: {0} passed, {1} failed. Report: {2}" -f ($cases.Count-$failed.Count),$failed.Count,(Join-Path $root 'report.json'))
if($failed.Count){exit 1};exit 0
