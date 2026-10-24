<# Runs at most one fully restored backup per local calendar day. Safe to call
after sign-in and hourly for catchup. No production service is started here. #>
[CmdletBinding()]
param([switch]$Force,[ValidateRange(2,365)][int]$Keep=7)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'backup-common.ps1')
. (Join-Path $PSScriptRoot 'backup-cycle-common.ps1')
. (Join-Path $PSScriptRoot 'startup-common.ps1')
. (Join-Path $PSScriptRoot 'lifecycle-stop-guard.ps1')

# These jobs belong to this PC, independently of an interactive shell's context.
$env:DOCKER_CONTEXT='desktop-linux'
foreach($option in @('DOCKER_HOST','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH')){Remove-Item -LiteralPath ('Env:'+ $option) -ErrorAction SilentlyContinue}

function Invoke-GargantuaBackupChild {
    param([string]$Script,[string[]]$ChildArguments)
    $shell=Get-GargantuaPowerShell -ProjectRoot $script:GargantuaProjectRoot
    # ProcessStartInfo(CreateNoWindow) gives the stage private pipes and no
    # shared console/control-event lifetime with its scheduled parent. In
    # particular, a child CTRL_CLOSE exit must become a recorded stage failure,
    # rather than tearing down the cycle before its state/finally can commit.
    Invoke-GargantuaNative -Operation ('isolated backup stage '+(Split-Path $Script -Leaf)) -Command $shell -Arguments (@('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$Script)+@($ChildArguments)) -TimeoutSeconds 3600|Out-Null
}
$probe={
    try{
        Assert-GargantuaLocalDockerContext
        Invoke-GargantuaDocker -Operation 'probe Docker for automatic backup' -Arguments @('info','--format','{{.ServerVersion}}')|Out-Null
        $db=Get-GargantuaService -Service 'db';$app=Get-GargantuaService -Service 'app'
        return [bool]($db.running -and -not $db.paused -and $app.running -and -not $app.paused)
    }catch{return $false}
}
$snapshot={param($Destination) Invoke-GargantuaBackupChild -Script (Join-Path $PSScriptRoot 'backup.ps1') -ChildArguments @('-DestinationRoot',$Destination)}
$restore={param($Backup,$Root,$Report) Invoke-GargantuaBackupChild -Script (Join-Path $PSScriptRoot 'verify-backup.ps1') -ChildArguments @('-Path',$Backup,'-RestoreRoot',$Root,'-Cleanup','-ReportPath',$Report)}
$protect={param($Path) Set-GargantuaPrivateDirectory -Path $Path}
$recover={
    param($Project,$Managed)
    if(-not @(Get-GargantuaInterruptedCycleJournals -ProjectRoot $Project -ManagedRoot $Managed).Count){return 0}
    $lease=Open-GargantuaLifecycleLock -ProjectRoot $Project
    if(-not $lease){throw 'Lifecycle operation is active; interrupted backup recovery will retry.'}
    try{
        if(Test-GargantuaCycleLeaseBusy -Path (Join-Path $Project '.local/backup-snapshot.lock')){throw 'Snapshot is active; interrupted recovery will retry.'}
        $quiet=Wait-GargantuaPendingStopBarrier -ProjectRoot $Project -CurrentHandler {param($Service) Get-GargantuaService -Service $Service} -Cancelled {param($GuardProject) Test-Path -LiteralPath (Join-Path $GuardProject '.local/operations/manual-stop.json')}
        if($quiet.status -ne 'clear'){throw 'Interrupted snapshot recovery was cancelled by a manual stop.'}
        Restore-GargantuaInterruptedCycles -ProjectRoot $Project -ManagedRoot $Managed -CurrentHandler {param($Name) Get-GargantuaService -Service $Name} -RestoreHandler {param($State) Restore-GargantuaHandler -State $State}
    }finally{$lease.Dispose()}
}
$result=Invoke-GargantuaBackupCycle -ProjectRoot $script:GargantuaProjectRoot -Force:$Force -Keep $Keep -Probe $probe -Snapshot $snapshot -Restore $restore -ProtectDirectory $protect -Recover $recover
$result|ConvertTo-Json -Depth 15
if($result.status -in @('failed','validated-with-cleanup-warning')){exit 1}
exit 0
