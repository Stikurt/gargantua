<# Offline monotonic-clock readiness faults. Does not create a container or read
a production snapshot. Probe/inspect callbacks stand in for bounded commands. #>
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
. (Join-Path $project 'scripts/backup-common.ps1')
. (Join-Path $project 'scripts/backup-cycle-restore.ps1')
$cases=[Collections.Generic.List[object]]::new()
function Assert-RestoreReadiness([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message}}
function Test-RestoreReadiness([string]$Name,[scriptblock]$Body){try{& $Body;$cases.Add(@{name=$Name;status='PASS'});Write-Host "PASS $Name"}catch{$cases.Add(@{name=$Name;status='FAIL';error=$_.Exception.Message});Write-Host "FAIL $Name`: $($_.Exception.Message)"}}
$script:clock=0L;$script:timeouts=@();$script:probes=0
function Reset-RestoreReadiness {$script:clock=0L;$script:timeouts=@();$script:probes=0}
$elapsed={$script:clock};$pause={param($Milliseconds) $script:clock+=$Milliseconds}
$running={param($Timeout) $script:timeouts+=@($Timeout);[pscustomobject]@{Status='running';Running=$true;OOMKilled=$false;Dead=$false;ExitCode=0;Error=''}}
Test-RestoreReadiness 'slow initialized database can become ready inside actual elapsed deadline' {
    Reset-RestoreReadiness
    $r=Wait-GargantuaRestoreDatabase -TimeoutSeconds 120 -ElapsedMilliseconds $elapsed -Pause $pause -Inspect $running -Probe {
        param($Timeout);$script:timeouts+=@($Timeout);$script:clock+=1000;$script:probes++
        if($script:clock -ge 90000){return '1'};throw 'Fake temporary init: final TCP database is not ready.'
    }
    Assert-RestoreReadiness ($r.status -eq 'ready' -and $r.elapsedMilliseconds -ge 90000 -and $r.elapsedMilliseconds -lt 120000) 'Slow real-time init was rejected or deadline ignored.'
    Assert-RestoreReadiness (@($script:timeouts|Where-Object {$_ -lt 1 -or $_ -gt 5}).Count -eq 0) 'Native command timeout exceeded five seconds.'
}
Test-RestoreReadiness 'exited database fails promptly and exposes only sanitized state' {
    Reset-RestoreReadiness
    $r=Wait-GargantuaRestoreDatabase -ElapsedMilliseconds $elapsed -Pause $pause -Probe {param($Timeout);throw 'private SQL credential content'} -Inspect {param($Timeout);[pscustomobject]@{Status='exited';Running=$false;OOMKilled=$false;Dead=$false;ExitCode=1;Error='private mount details'}}
    $json=$r|ConvertTo-Json -Depth 8
    Assert-RestoreReadiness ($r.status -eq 'container-exited' -and $r.attempts -eq 1 -and $r.containerState.exitCode -eq 1 -and $r.containerState.errorPresent -and $json -notmatch 'private|credential|mount') 'Exited state or private-error suppression failed.'
}
Test-RestoreReadiness 'OOM failure is distinguished from startup timeout' {
    Reset-RestoreReadiness
    $r=Wait-GargantuaRestoreDatabase -ElapsedMilliseconds $elapsed -Pause $pause -Probe {param($Timeout);throw 'not ready'} -Inspect {param($Timeout);[pscustomobject]@{Status='exited';Running=$false;OOMKilled=$true;Dead=$false;ExitCode=137;Error=''}}
    Assert-RestoreReadiness ($r.status -eq 'container-oom' -and $r.containerState.oomKilled -and $r.containerState.exitCode -eq 137) 'OOM cause was lost.'
}
Test-RestoreReadiness 'hung commands consume the elapsed budget without multiplying the deadline by attempt count' {
    Reset-RestoreReadiness
    $r=Wait-GargantuaRestoreDatabase -TimeoutSeconds 12 -ElapsedMilliseconds $elapsed -Pause $pause -Inspect $running -Probe {param($Timeout);$script:timeouts+=@($Timeout);$script:clock+=$Timeout*1000;throw 'Fake bounded native command timed out.'}
    Assert-RestoreReadiness ($r.status -eq 'timeout' -and $r.elapsedMilliseconds -le 12000 -and $r.attempts -le 3) 'Elapsed deadline multiplied by command timeout.'
}
Test-RestoreReadiness 'inspect failure remains bounded and never substitutes for successful TCP query' {
    Reset-RestoreReadiness
    $r=Wait-GargantuaRestoreDatabase -TimeoutSeconds 3 -ElapsedMilliseconds $elapsed -Pause $pause -Probe {param($Timeout);return '0'} -Inspect {param($Timeout);throw 'private inspect failure'}
    Assert-RestoreReadiness ($r.status -eq 'timeout' -and $r.inspectFailures -gt 0 -and $r.elapsedMilliseconds -le 3000) 'Unavailable state bypassed readiness or deadline.'
}
Test-RestoreReadiness 'restore helper and integration sources parse without execution' {
    foreach($file in @('scripts/backup-cycle-restore.ps1','scripts/verify-backup.ps1','tests/backup-cycle-restore.test.ps1')){
        $tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $project $file),[ref]$tokens,[ref]$errors)|Out-Null
        Assert-RestoreReadiness (@($errors).Count -eq 0) ('Syntax errors in '+$file)
    }
}
$failed=@($cases|Where-Object status -eq 'FAIL')
Write-GargantuaJson -Path (Join-Path $project '.local/test-results/backup-cycle-restore-offline.json') -Value @{createdAt=[DateTimeOffset]::UtcNow.ToString('o');scope='Offline monotonic-clock faults only; no container or production snapshot';passed=$cases.Count-$failed.Count;failed=$failed.Count;cases=$cases.ToArray()}
Write-Host ('Restore readiness checks: '+($cases.Count-$failed.Count)+' passed; '+$failed.Count+' failed.')
if($failed.Count){exit 1};exit 0
