# Produces a concrete, reviewable task definition; never registers a task.
[CmdletBinding()]
param([ValidateSet('definition','status')][string]$Action='definition',[string]$TaskName='Gargantua Library - Start')
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'startup-common.ps1')
$project=[IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
if($Action -eq 'status'){
    $task=Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if(-not $task){[pscustomobject]@{name=$TaskName;installed=$false};return}
    $info=Get-ScheduledTaskInfo -InputObject $task -ErrorAction Stop
    [pscustomobject]@{name=$TaskName;installed=$true;state=[string]$task.State;lastResult=$info.LastTaskResult;lastRun=$info.LastRunTime;nextRun=$info.NextRunTime};return
}
$pwsh=Get-GargantuaPowerShell -ProjectRoot $project
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$entry=Join-Path $project 'scripts/startup-server.ps1'
$arguments='-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$entry+'" -Action run'
$escape={param($value)[Security.SecurityElement]::Escape([string]$value)}
$xml=@"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Start the personal library after Windows sign-in. Respects manual stop and backup locks; no administrator rights or stored password.</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><Delay>PT30S</Delay><UserId>$(& $escape $sid)</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>$(& $escape $sid)</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>false</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><Enabled>true</Enabled><Hidden>false</Hidden><ExecutionTimeLimit>PT15M</ExecutionTimeLimit><Priority>7</Priority><RestartOnFailure><Interval>PT2M</Interval><Count>3</Count></RestartOnFailure></Settings>
  <Actions Context="Author"><Exec><Command>$(& $escape $pwsh)</Command><Arguments>$(& $escape $arguments)</Arguments><WorkingDirectory>$(& $escape $project)</WorkingDirectory></Exec></Actions>
</Task>
"@
[pscustomobject]@{name=$TaskName;userSid=$sid;command=$pwsh;arguments=$arguments;workingDirectory=$project;xml=$xml;registered=$false;interactiveToken=$true;elevated=$false;requiresPassword=$false}
