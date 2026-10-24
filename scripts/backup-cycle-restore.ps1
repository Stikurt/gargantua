# Bounded readiness checks for the new isolated restore container only. Native
# probe/inspect callbacks receive their remaining per-command timeout explicitly.
function Wait-GargantuaRestoreDatabase {
    [CmdletBinding()]
    param([Parameter(Mandatory)][scriptblock]$Probe,[Parameter(Mandatory)][scriptblock]$Inspect,
          [ValidateRange(1,600)][int]$TimeoutSeconds=120,[scriptblock]$ElapsedMilliseconds=$null,
          [scriptblock]$Pause={param($Milliseconds) Start-Sleep -Milliseconds $Milliseconds})
    $timer=[Diagnostics.Stopwatch]::StartNew()
    if(-not $ElapsedMilliseconds){$ElapsedMilliseconds={$timer.ElapsedMilliseconds}}
    $budget=[long]$TimeoutSeconds*1000;$attempts=0;$inspectFailures=0;$lastState=$null;$reason='timeout'
    while(([long](& $ElapsedMilliseconds)) -lt $budget){
        $remaining=$budget-[long](& $ElapsedMilliseconds)
        if($remaining -lt 1000){break}
        $commandTimeout=[Math]::Max(1,[Math]::Min(5,[int][Math]::Floor($remaining/1000.0)))
        $attempts++
        try{
            $result=& $Probe $commandTimeout
            if(([string]$result).Trim() -eq '1'){
                return [pscustomobject]@{status='ready';attempts=$attempts;elapsedMilliseconds=[long](& $ElapsedMilliseconds);timeoutSeconds=$TimeoutSeconds;containerState=$lastState;inspectFailures=$inspectFailures}
            }
        }catch{} # private native output is never copied into readiness metadata
        $remaining=$budget-[long](& $ElapsedMilliseconds)
        if($remaining -lt 1000){break}
        $commandTimeout=[Math]::Max(1,[Math]::Min(5,[int][Math]::Floor($remaining/1000.0)))
        try{
            $state=& $Inspect $commandTimeout
            $status=if($state.Status -in @('created','running','exited','dead','paused','restarting')){[string]$state.Status}else{'unknown'}
            $exitCode=$null;if($state.ExitCode -is [int] -or $state.ExitCode -is [long]){$exitCode=$state.ExitCode}
            $lastState=[pscustomobject]@{status=$status;running=($state.Running -eq $true);oomKilled=($state.OOMKilled -eq $true);dead=($state.Dead -eq $true);exitCode=$exitCode;errorPresent=[bool]([string]$state.Error)}
            if($lastState.oomKilled){$reason='container-oom';break}
            if($lastState.dead -or (-not $lastState.running -and $status -in @('exited','dead'))){$reason='container-exited';break}
        }catch{$inspectFailures++}
        $remaining=$budget-[long](& $ElapsedMilliseconds)
        if($remaining -gt 0){& $Pause ([int][Math]::Min(1000,$remaining))|Out-Null}
    }
    return [pscustomobject]@{status=$reason;attempts=$attempts;elapsedMilliseconds=[long](& $ElapsedMilliseconds);timeoutSeconds=$TimeoutSeconds;containerState=$lastState;inspectFailures=$inspectFailures}
}
