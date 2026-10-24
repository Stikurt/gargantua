# Pure clock and service callbacks; no Docker, service or scheduled task changes.
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
. (Join-Path $project 'scripts/lifecycle-stop-guard.ps1')
$root=Join-Path $project ('.local/test-results/lifecycle-stop-guard-'+[Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root)|Out-Null
$cases=[Collections.Generic.List[object]]::new()
function Assert-Guard([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message}}
function Test-Guard([string]$Name,[scriptblock]$Body){try{& $Body;$cases.Add(@{name=$Name;status='PASS'});Write-Host "PASS $Name"}catch{$cases.Add(@{name=$Name;status='FAIL';error=$_.Exception.Message});Write-Host "FAIL ${Name}: $($_.Exception.Message)"}}
function New-GuardFixture([string]$Name){
    $path=Join-Path $root $Name;[IO.Directory]::CreateDirectory($path)|Out-Null
    $script:GuardNow=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();$script:GuardStart=$script:GuardNow
    $script:GuardSleeps=0;$script:GuardCancel=$false;$script:GuardSleepAction=$null;$script:GuardId='a'*64
    return $path
}
function Write-GuardJson([string]$Path,$Value){[IO.Directory]::CreateDirectory((Split-Path $Path -Parent))|Out-Null;[IO.File]::WriteAllText($Path,($Value|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))}
function New-GuardIntent([string]$Path,[int]$Timeout=30,[long]$Age=0){
    $target=Join-Path $Path '.local/operations/stop-intents/12345678123412341234123456789abc-worker.json'
    Write-GuardJson $target @{schemaVersion=1;kind='gargantua-snapshot-stop';projectRoot=$Path;snapshotId='12345678123412341234123456789abc';service='worker';containerId=('a'*64);issuedAtMs=($script:GuardNow-$Age);timeoutSeconds=$Timeout;rpcTimeoutSeconds=($Timeout+15);graceSeconds=5}
    return $target
}
function Invoke-Guard([string]$Path){
    Wait-GargantuaPendingStopBarrier -ProjectRoot $Path -CurrentHandler {param($Service)[pscustomobject]@{exists=$true;id=$script:GuardId}} -Clock {return $script:GuardNow} -Sleep {param($Milliseconds)$script:GuardNow+=$Milliseconds;$script:GuardSleeps++;if($script:GuardSleepAction){& $script:GuardSleepAction}} -Cancelled {return $script:GuardCancel}
}
function New-LegacyGuard([string]$Path,[long]$Age,[switch]$Modern){
    $snapshot=Join-Path $Path 'backups/snapshot-2026-10-23_00-00-00-a1b2c3d4';$id='a1b2c3d4'+('0'*24)
    Write-GuardJson (Join-Path $snapshot 'manifest.json') @{version=2;status='building';snapshotId=$id;createdAt=[DateTimeOffset]::FromUnixTimeMilliseconds($script:GuardNow-$Age).ToString('o')}
    $journal=@{snapshotId=$id;handlers=@(@{service='worker';exists=$true;running=$true;paused=$false;id=('a'*64)},@{service='parser';exists=$false;running=$false;paused=$false;id=''})}
    if($Modern){$journal.stopIntentProtocol='central-rpc-v1'}
    Write-GuardJson (Join-Path $snapshot 'service-state-before.json') $journal
}
Test-Guard 'crashed stop client waits through latest possible delivery and daemon kill deadline' {
    $path=New-GuardFixture 'pending';$intent=New-GuardIntent $path;$before=Get-Content -LiteralPath $intent -Raw
    $result=Invoke-Guard $path
    Assert-Guard ($result.status -eq 'clear' -and $result.waitedMs -eq 80000 -and $script:GuardSleeps -eq 80) 'Guard allowed startup before the late RPC deadline.'
    Assert-Guard ((Get-Content -LiteralPath $intent -Raw) -eq $before) 'Read-only guard rewrote or removed RPC evidence.'
}
Test-Guard 'expired stop intent does not impose a new fixed delay on every startup' {
    $path=New-GuardFixture 'expired';$null=New-GuardIntent $path 30 90000
    foreach($pass in 1..2){$result=Invoke-Guard $path;Assert-Guard ($result.waitedMs -eq 0 -and $result.pendingCount -eq 0) 'Expired intent caused a fresh wait.'}
    Assert-Guard ($script:GuardSleeps -eq 0) 'Expired metadata slept anyway.'
}
Test-Guard 'manual server hold cancels an in-progress wait before mutation is allowed' {
    $path=New-GuardFixture 'cancel';$null=New-GuardIntent $path;$script:GuardSleepAction={if($script:GuardNow-$script:GuardStart -ge 2000){$script:GuardCancel=$true}}
    $result=Invoke-Guard $path;Assert-Guard ($result.status -eq 'cancelled' -and $result.waitedMs -eq 2000) 'Manual hold did not cancel pending startup.'
}
Test-Guard 'active intent cannot authorize recovery of a recreated container' {
    $path=New-GuardFixture 'recreated';$null=New-GuardIntent $path;$script:GuardId='b'*64;$errorText=''
    try{Invoke-Guard $path|Out-Null}catch{$errorText=$_.Exception.Message}
    Assert-Guard ($errorText.Contains('identity differs') -and $script:GuardSleeps -eq 0) 'Mismatched container identity was ignored.'
}
Test-Guard 'container identity is rechecked after the outstanding RPC deadline' {
    $path=New-GuardFixture 'changed';$null=New-GuardIntent $path;$script:GuardSleepAction={$script:GuardId='b'*64};$errorText=''
    try{Invoke-Guard $path|Out-Null}catch{$errorText=$_.Exception.Message}
    Assert-Guard ($errorText.Contains('identity changed')) 'Identity changed during waiting but startup was authorized.'
}
Test-Guard 'malformed deadline evidence fails closed without an unbounded sleep' {
    $path=New-GuardFixture 'bad';$intent=New-GuardIntent $path;$data=Get-Content -LiteralPath $intent -Raw|ConvertFrom-Json;$data.rpcTimeoutSeconds=900;Write-GuardJson $intent $data;$errorText=''
    try{Invoke-Guard $path|Out-Null}catch{$errorText=$_.Exception.Message}
    Assert-Guard ($errorText.Contains('deadline is invalid') -and $script:GuardSleeps -eq 0) 'Unbounded delivery timeout was accepted.'
}
Test-Guard 'legacy interrupted snapshot waits only remaining creation plus 245 seconds' {
    $path=New-GuardFixture 'legacy';New-LegacyGuard $path 200000
    $result=Invoke-Guard $path;Assert-Guard ($result.waitedMs -eq 45000) 'Legacy barrier did not use its immutable creation time.'
    $again=Invoke-Guard $path;Assert-Guard ($again.waitedMs -eq 0) 'Legacy metadata imposed another fixed delay.'
}
Test-Guard 'modern journal with successfully removed intents has no legacy delay' {
    $path=New-GuardFixture 'modern';New-LegacyGuard $path 0 -Modern
    $result=Invoke-Guard $path;Assert-Guard ($result.waitedMs -eq 0 -and $script:GuardSleeps -eq 0) 'Normal successful RPC inherited the old legacy timeout.'
}
Test-Guard 'maximum allowed stop timeout has a finite 260 second RPC fence' {
    $path=New-GuardFixture 'maximum';$null=New-GuardIntent $path 120
    $result=Invoke-Guard $path;Assert-Guard ($result.waitedMs -eq 260000 -and $script:GuardSleeps -eq 260) 'Maximum stop timeout escaped the bounded fence.'
}
$failed=@($cases.ToArray()|Where-Object status -eq 'FAIL')
$report=@{status=$(if($failed.Count){'FAIL'}else{'PASS'});cases=$cases.ToArray();passed=$cases.Count-$failed.Count;failed=$failed.Count;dockerCommands=$false;servicesChanged=$false;productionEvidenceModified=$false;realWaits=$false}
[IO.File]::WriteAllText((Join-Path $root 'report.json'),($report|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))
Write-Host ("Stop RPC guard checks: {0} passed, {1} failed. Report: {2}" -f ($cases.Count-$failed.Count),$failed.Count,(Join-Path $root 'report.json'))
if($failed.Count){exit 1};exit 0
