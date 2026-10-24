[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
. (Join-Path $project 'scripts/operations-tasks.ps1')
$definitions=@(Get-GargantuaManagedTaskDefinitions $project)
$results=[Collections.Generic.List[object]]::new()
function Case($name,[scriptblock]$body){try{& $body;$results.Add(@{name=$name;passed=$true})}catch{$results.Add(@{name=$name;passed=$false;error=$_.Exception.Message})}}
function MustReject([string]$xml,$definition){$rejected=$false;try{$null=Assert-GargantuaManagedTask -Xml $xml -Definition $definition}catch{$rejected=$true};if(-not $rejected){throw 'Unowned task was accepted.'}}
foreach($definition in $definitions){
    Case ($definition.role+' valid owner and exact action accepted') {$null=Assert-GargantuaManagedTask -Xml $definition.xml -Definition $definition}
    Case ($definition.role+' Windows default least privilege survives export') {
        $xml=$definition.xml.Replace('<RunLevel>LeastPrivilege</RunLevel>','')
        $service=New-Object -ComObject 'Schedule.Service';$task=$service.NewTask(0);$task.XmlText=$xml
        if($task.Principal.RunLevel -ne 0){throw 'Windows default changed.'}
        $null=Assert-GargantuaManagedTask -Xml $xml -Definition $definition
    }
    Case ($definition.role+' task accepted by actual Windows XML schema') {$service=New-Object -ComObject 'Schedule.Service';$task=$service.NewTask(0);$task.XmlText=$definition.xml;if($task.Actions.Count -ne 1 -or $task.Principal.LogonType -ne 3 -or $task.Principal.RunLevel -ne 0){throw 'Unexpected task privileges.'}}
    Case ($definition.role+' foreign project tag refused') {MustReject ($definition.xml.Replace($definition.tag,'UnrelatedTask')) $definition}
    Case ($definition.role+' elevated principal refused') {MustReject ($definition.xml.Replace('LeastPrivilege','HighestAvailable')) $definition}
    Case ($definition.role+' altered command arguments refused') {MustReject ($definition.xml.Replace('-Action run','-Action status').Replace('backup-cycle.ps1','other.ps1')) $definition}
    Case ($definition.role+' extra action refused') {MustReject ($definition.xml.Replace('</Exec></Actions>','</Exec><Exec><Command>cmd.exe</Command></Exec></Actions>')) $definition}
}
Case 'wrong principal refused' {MustReject ($definitions[0].xml.Replace($definitions[0].userSid,'S-1-5-18')) $definitions[0]}
Case 'DTD and external entities refused without reading them' {MustReject ($definitions[0].xml.Replace('<Task version=','<!DOCTYPE Task [<!ENTITY external SYSTEM "file:///never-read">]><Task version=')) $definitions[0]}
Case 'backup has one-hour catchup and sign-in triggers' {[xml]$xml=$definitions[1].xml;if($xml.Task.Triggers.TimeTrigger.Repetition.Interval -ne 'PT1H' -or $xml.Task.Triggers.LogonTrigger.Delay -ne 'PT10M'){throw 'Missing backup catchup.'}}
$report=@{status=if(@($results|Where-Object {-not $_.passed}).Count){'failed'}else{'passed'};tests=$results.Count;cases=$results.ToArray();realTaskRegistration=$false;realDocker=$false}
$target=Join-Path $project '.local/test-results/operations-task-definitions.json'
$report|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $target -Encoding UTF8
$report|ConvertTo-Json -Depth 8
if($report.status -ne 'passed'){exit 1}
