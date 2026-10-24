# Host-only helpers. No Docker/WSL command is invoked and no guest is awakened.
function Open-GargantuaMonitorLock {
    param([Parameter(Mandatory)][string]$RuntimeRoot)
    return [IO.File]::Open((Join-Path $RuntimeRoot 'monitor.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
}
function Write-GargantuaResourceJson {
    param([Parameter(Mandatory)][string]$Path,[Parameter(Mandatory)]$Value)
    $temporary=$Path+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-Json -InputObject $Value -Depth 12 -Compress)+"`n")
    try{
        $stream=[IO.File]::Open($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
        if(Test-Path -LiteralPath $Path){[IO.File]::Replace($temporary,$Path,[NullString]::Value)}else{[IO.File]::Move($temporary,$Path)}
    }finally{if(Test-Path -LiteralPath $temporary){Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue}}
}
function Get-GargantuaDockerStorage {
    param([string]$UserProfile=$env:USERPROFILE,[string]$SettingsPath='')
    if(-not $SettingsPath){$SettingsPath=Join-Path $UserProfile 'AppData/Roaming/Docker/settings-store.json'}
    $folder=$null;$source='known-default';$problem=$null
    if(Test-Path -LiteralPath $SettingsPath -PathType Leaf){
        try{
            if((Get-Item -LiteralPath $SettingsPath -ErrorAction Stop).Length -gt 2MB){throw 'settings-size'}
            $json=Get-Content -LiteralPath $SettingsPath -Raw -Encoding UTF8 -ErrorAction Stop
            if(-not $json.TrimStart().StartsWith('{')){throw 'settings-root'}
            $settings=ConvertFrom-Json -InputObject $json -AsHashtable -ErrorAction Stop
            if($settings -isnot [Collections.IDictionary]){throw 'settings-root'}
            $configured=$settings['dataFolder'];$settings=$null;$json=$null
            if($null -ne $configured -and $configured -ne ''){
                if($configured -isnot [string] -or $configured -notmatch '^[A-Za-z]:[\\/]' -or $configured -match '\.vhdx$'){throw 'settings-data-folder'}
                $folder=[IO.Path]::GetFullPath($configured);$source='settings-dataFolder'
            }
        }catch{$problem='docker-settings-unavailable'}
    }
    if($problem){return [pscustomobject]@{known=$false;paths=@();source=$source;reason=$problem}}
    if(-not $folder){$folder=Join-Path $UserProfile 'AppData/Local/Docker/wsl'}
    $candidates=@('disk/docker_data.vhdx','data/ext4.vhdx','data/docker_data.vhdx','docker_data.vhdx','wsl/disk/docker_data.vhdx','wsl/data/ext4.vhdx')|ForEach-Object{Join-Path $folder $_}
    $found=[Collections.Generic.List[string]]::new()
    foreach($candidate in $candidates){
        try{if(Test-Path -LiteralPath $candidate -PathType Leaf -ErrorAction Stop){$item=Get-Item -LiteralPath $candidate -Force -ErrorAction Stop;if($item.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)){throw 'VHDX-reparse'};$found.Add($item.FullName)}}catch{return [pscustomobject]@{known=$false;paths=@();source=$source;reason='docker-storage-unavailable'}}
    }
    $data=@($found.ToArray()|Sort-Object -Unique)
    if($data.Count -ne 1){return [pscustomobject]@{known=$false;paths=@();source=$source;reason=$(if($data.Count){'docker-storage-ambiguous'}else{'docker-storage-not-found'})}}
    $paths=[Collections.Generic.List[string]]::new();$paths.Add($data[0])
    foreach($system in @((Join-Path $UserProfile 'AppData/Local/Docker/wsl/distro/ext4.vhdx'),(Join-Path $folder 'disk/docker_system.vhdx'))){
        try{if(Test-Path -LiteralPath $system -PathType Leaf -ErrorAction Stop){$item=Get-Item -LiteralPath $system -Force -ErrorAction Stop;if($item.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)){throw 'system-VHDX-reparse'};$paths.Add($item.FullName)}}catch{return [pscustomobject]@{known=$false;paths=@();source=$source;reason='docker-system-storage-unavailable'}}
    }
    return [pscustomobject]@{known=$true;paths=@($paths.ToArray()|Sort-Object -Unique);source=$source;reason=$null}
}
function Get-GargantuaPathFreeMb {
    param([Parameter(Mandatory)][string]$Path)
    $full=[IO.Path]::GetFullPath($Path)
    if(-not (Test-Path -LiteralPath $full -ErrorAction Stop)){throw 'Storage path is unavailable.'}
    if(Get-Command Get-Volume -ErrorAction SilentlyContinue){
        try{$volume=Get-Volume -FilePath $full -ErrorAction Stop;if($null -ne $volume.SizeRemaining -and $volume.SizeRemaining -ge 0){return [Math]::Floor([double]$volume.SizeRemaining/1MB)}}catch{}
    }
    # Never mistake a redirected mount/junction for free space on its parent drive.
    $current=$full
    while($current){
        $item=Get-Item -LiteralPath $current -Force -ErrorAction Stop
        if($item.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)){throw 'Storage volume identity is unresolved.'}
        $parent=[IO.Directory]::GetParent($current);if(-not $parent){break};$current=$parent.FullName
    }
    $drive=[IO.DriveInfo]::new([IO.Path]::GetPathRoot($full))
    if(-not $drive.IsReady -or $drive.DriveType -ne [IO.DriveType]::Fixed){throw 'Storage drive is not an available fixed local volume.'}
    return [Math]::Floor([double]$drive.AvailableFreeSpace/1MB)
}
function Get-GargantuaHostResourceSample {
    param([Parameter(Mandatory)][string]$ProjectRoot)
    $sample=[pscustomobject]@{observedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();freeMb=$null;cpuPercent=$null;projectDiskFreeMb=$null;dockerDiskFreeMb=$null;dockerStorageKnown=$false}
    try{$os=Get-CimInstance Win32_OperatingSystem -ErrorAction Stop;if($null -ne $os.FreePhysicalMemory){$sample.freeMb=[Math]::Floor([double]$os.FreePhysicalMemory/1024)}}catch{}
    try{$cpu=Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'" -ErrorAction Stop;if($null -ne $cpu.PercentProcessorTime){$sample.cpuPercent=[double]$cpu.PercentProcessorTime}}catch{}
    try{$sample.projectDiskFreeMb=Get-GargantuaPathFreeMb -Path $ProjectRoot}catch{}
    try{$storage=Get-GargantuaDockerStorage}catch{$storage=[pscustomobject]@{known=$false;paths=@()}}
    $sample.dockerStorageKnown=[bool]$storage.known
    if($storage.known){try{$values=@($storage.paths|ForEach-Object{Get-GargantuaPathFreeMb -Path $_});if($values.Count -eq 0){throw 'No storage metric'};$sample.dockerDiskFreeMb=($values|Measure-Object -Minimum).Minimum}catch{$sample.dockerStorageKnown=$false;$sample.dockerDiskFreeMb=$null}}
    return $sample
}
