# Task definitions and ownership checks. No task is registered by dot-sourcing.
. (Join-Path $PSScriptRoot 'runtime-common.ps1')
function Get-GargantuaManagedTaskDefinitions {
    param([Parameter(Mandatory)][string]$ProjectRoot)
    $project=[IO.Path]::GetFullPath($ProjectRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $hash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($project.ToUpperInvariant()+'|'+$sid))).Substring(0,12).ToLowerInvariant()
    $pwsh=Get-GargantuaPowerShell -ProjectRoot $project
    $definitions=[Collections.Generic.List[object]]::new()
    $start=& (Join-Path $project 'scripts/startup-task.ps1') -Action definition -TaskName ('Gargantua-'+$hash+'-Startup')
    [xml]$startXml=$start.xml
    $startTag='Gargantua-operations:v1:'+ $hash+':startup'
    $startXml.Task.RegistrationInfo.Description=$startTag+' | Start library after this user signs in; respects manual stop.'
    $definitions.Add([pscustomobject]@{role='startup';name=$start.name;tag=$startTag;userSid=$sid;command=$pwsh;arguments=$start.arguments;workingDirectory=$project;xml=$startXml.OuterXml})
    $entry=Join-Path $project 'scripts/backup-cycle.ps1'
    $arguments='-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$entry+'"'
    $tag='Gargantua-operations:v1:'+ $hash+':backup'
    $escape={param($value)[Security.SecurityElement]::Escape([string]$value)}
    $boundary=(Get-Date).Date.AddMinutes(10).ToString('yyyy-MM-ddTHH:mm:ss')
    $xml=@"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
 <RegistrationInfo><Description>$(& $escape $tag) | Check hourly; create and restore-verify at most one daily automatic snapshot.</Description></RegistrationInfo>
 <Triggers>
  <LogonTrigger><Enabled>true</Enabled><Delay>PT10M</Delay><UserId>$(& $escape $sid)</UserId></LogonTrigger>
  <TimeTrigger><Repetition><Interval>PT1H</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>$boundary</StartBoundary><Enabled>true</Enabled></TimeTrigger>
 </Triggers>
 <Principals><Principal id="Owner"><UserId>$(& $escape $sid)</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
 <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>false</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><Enabled>true</Enabled><Hidden>false</Hidden><ExecutionTimeLimit>PT4H</ExecutionTimeLimit><Priority>7</Priority><RestartOnFailure><Interval>PT15M</Interval><Count>2</Count></RestartOnFailure></Settings>
 <Actions Context="Owner"><Exec><Command>$(& $escape $pwsh)</Command><Arguments>$(& $escape $arguments)</Arguments><WorkingDirectory>$(& $escape $project)</WorkingDirectory></Exec></Actions>
</Task>
"@
    $definitions.Add([pscustomobject]@{role='backup';name=('Gargantua-'+$hash+'-Backup');tag=$tag;userSid=$sid;command=$pwsh;arguments=$arguments;workingDirectory=$project;xml=$xml})
    return $definitions.ToArray()
}
function Assert-GargantuaManagedTask {
    param([Parameter(Mandatory)][string]$Xml,[Parameter(Mandatory)]$Definition)
    if($Xml.Length -gt 128KB){throw 'Task definition exceeds the ownership-check limit.'}
    $readerSettings=[Xml.XmlReaderSettings]::new();$readerSettings.DtdProcessing=[Xml.DtdProcessing]::Prohibit;$readerSettings.XmlResolver=$null
    $reader=[Xml.XmlReader]::Create([IO.StringReader]::new($Xml),$readerSettings)
    try{$document=[Xml.XmlDocument]::new();$document.XmlResolver=$null;$document.Load($reader)}finally{$reader.Dispose()}
    $ns=[Xml.XmlNamespaceManager]::new($document.NameTable);$ns.AddNamespace('t','http://schemas.microsoft.com/windows/2004/02/mit/task')
    $description=$document.SelectSingleNode('/t:Task/t:RegistrationInfo/t:Description',$ns)
    $principal=$document.SelectNodes('/t:Task/t:Principals/t:Principal',$ns)
    $actions=$document.SelectSingleNode('/t:Task/t:Actions',$ns)
    $children=@($actions.ChildNodes|Where-Object NodeType -eq ([Xml.XmlNodeType]::Element))
    if(-not $description -or -not $description.InnerText.StartsWith($Definition.tag+' | ',[StringComparison]::Ordinal) -or $principal.Count -ne 1 -or $children.Count -ne 1 -or $children[0].LocalName -ne 'Exec'){throw 'Refusing to modify an unowned or changed task.'}
    foreach($pair in @(@('t:UserId',$Definition.userSid),@('t:LogonType','InteractiveToken'),@('t:RunLevel','LeastPrivilege'))){
        $node=$principal[0].SelectSingleNode($pair[0],$ns)
        $actual=if($node){$node.InnerText}else{''}
        # Windows omits this element on export when its schema default applies.
        if(-not $node -and $pair[0] -eq 't:RunLevel'){$actual='LeastPrivilege'}
        if($pair[0] -eq 't:UserId' -and $actual -cne $pair[1]){
            try{$actual=([Security.Principal.NTAccount]::new($actual)).Translate([Security.Principal.SecurityIdentifier]).Value}catch{throw 'Task principal cannot be resolved to its owner.'}
        }
        if($actual -cne $pair[1]){throw 'Task principal does not match this non-elevated user.'}
    }
    foreach($pair in @(@('t:Command',$Definition.command),@('t:Arguments',$Definition.arguments),@('t:WorkingDirectory',$Definition.workingDirectory))){
        $node=$children[0].SelectSingleNode($pair[0],$ns)
        if(-not $node -or $node.InnerText -ine $pair[1]){throw 'Task action does not match this project.'}
    }
    return $true
}
