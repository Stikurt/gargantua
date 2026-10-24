# Pure policy. No filesystem, process, Docker, WSL or CIM calls.
function Test-GargantuaResourceNumber {
    param($Value,[double]$Minimum=0,[double]$Maximum=[double]::MaxValue)
    if($Value -isnot [byte] -and $Value -isnot [int16] -and $Value -isnot [int32] -and $Value -isnot [int64] -and $Value -isnot [single] -and $Value -isnot [double] -and $Value -isnot [decimal]){return $false}
    $number=[double]$Value
    return -not [double]::IsNaN($number) -and -not [double]::IsInfinity($number) -and $number -ge $Minimum -and $number -le $Maximum
}
function Get-GargantuaResourceDecision {
    param([AllowNull()]$Sample,[AllowNull()]$Previous,[Parameter(Mandatory)][long]$NowMs)
    $reasons=[Collections.Generic.List[string]]::new()
    $validTime=$null -ne $Sample -and (Test-GargantuaResourceNumber $Sample.observedAt)
    if(-not $validTime){$reasons.Add('sample-time-invalid')}
    elseif(($NowMs-[double]$Sample.observedAt) -gt 30000){$reasons.Add('sample-stale')}
    elseif(($NowMs-[double]$Sample.observedAt) -lt -5000){$reasons.Add('sample-future')}
    $freeOk=$null -ne $Sample -and (Test-GargantuaResourceNumber $Sample.freeMb)
    $cpuOk=$null -ne $Sample -and (Test-GargantuaResourceNumber $Sample.cpuPercent -Maximum 100)
    $projectOk=$null -ne $Sample -and (Test-GargantuaResourceNumber $Sample.projectDiskFreeMb)
    $dockerOk=$null -ne $Sample -and (Test-GargantuaResourceNumber $Sample.dockerDiskFreeMb)
    $dockerKnown=$null -ne $Sample -and $Sample.dockerStorageKnown -is [bool] -and $Sample.dockerStorageKnown
    if(-not $freeOk){$reasons.Add('ram-unavailable')};if(-not $cpuOk){$reasons.Add('cpu-unavailable')}
    if(-not $projectOk){$reasons.Add('project-disk-unavailable')};if(-not $dockerOk){$reasons.Add('docker-disk-unavailable')}
    if(-not $dockerKnown){$reasons.Add('docker-storage-unknown')}
    $metricsAvailable=$reasons.Count -eq 0
    $previousTrusted=$null -ne $Previous -and $Previous.schemaVersion -is [int] -and $Previous.schemaVersion -eq 2 -and $Previous.allowHeavy -is [bool] -and
        $Previous.metricsAvailable -is [bool] -and $Previous.metricsAvailable -and $Previous.dockerStorageKnown -is [bool] -and $Previous.dockerStorageKnown -and
        (Test-GargantuaResourceNumber $Previous.updatedAt) -and ($NowMs-[double]$Previous.updatedAt) -ge -5000 -and ($NowMs-[double]$Previous.updatedAt) -le 45000 -and
        $Previous.healthyReadings -is [int] -and $Previous.healthyReadings -ge 0 -and $Previous.healthyReadings -le 3 -and
        (Test-GargantuaResourceNumber $Previous.freeMb) -and (Test-GargantuaResourceNumber $Previous.cpuPercent -Maximum 100) -and
        (Test-GargantuaResourceNumber $Previous.projectDiskFreeMb) -and (Test-GargantuaResourceNumber $Previous.dockerDiskFreeMb)
    $count=0;$allow=$false
    if($metricsAvailable){
        $low=$Sample.freeMb -lt 1536 -or $Sample.cpuPercent -gt 90 -or $Sample.projectDiskFreeMb -lt 1024 -or $Sample.dockerDiskFreeMb -lt 1024
        $healthy=$Sample.freeMb -gt 2304 -and $Sample.cpuPercent -lt 75 -and $Sample.projectDiskFreeMb -gt 2048 -and $Sample.dockerDiskFreeMb -gt 2048
        if($low){
            if($Sample.freeMb -lt 1536){$reasons.Add('pressure-ram')};if($Sample.cpuPercent -gt 90){$reasons.Add('pressure-cpu')}
            if($Sample.projectDiskFreeMb -lt 1024){$reasons.Add('pressure-project-disk')};if($Sample.dockerDiskFreeMb -lt 1024){$reasons.Add('pressure-docker-disk')}
        }elseif($healthy){
            $count=if($previousTrusted){[Math]::Min(3,$Previous.healthyReadings+1)}else{1}
            $allow=$count -ge 3 -or ($previousTrusted -and $Previous.allowHeavy)
            if(-not $allow){$reasons.Add('recovering-three-healthy-samples')}
        }else{$allow=$previousTrusted -and $Previous.allowHeavy;$reasons.Add('hysteresis-band')}
    }
    $diskMinimum=if($projectOk -and $dockerOk){[Math]::Min([double]$Sample.projectDiskFreeMb,[double]$Sample.dockerDiskFreeMb)}else{$null}
    return [pscustomobject]@{
        schemaVersion=2;updatedAt=$NowMs;observedAt=$(if($validTime){[long]$Sample.observedAt}else{$null});allowHeavy=[bool]$allow;
        metricsAvailable=[bool]$metricsAvailable;dockerStorageKnown=[bool]$dockerKnown;
        freeMb=$(if($freeOk){[double]$Sample.freeMb}else{$null});cpuPercent=$(if($cpuOk){[double]$Sample.cpuPercent}else{$null});
        projectDiskFreeMb=$(if($projectOk){[double]$Sample.projectDiskFreeMb}else{$null});dockerDiskFreeMb=$(if($dockerOk){[double]$Sample.dockerDiskFreeMb}else{$null});
        hostDiskFreeMb=$diskMinimum;dockerDiskMetricScope='windows-volume-containing-vhdx';healthyReadings=[int]$count;maxHeavyJobs=1;reasons=$reasons.ToArray();
        message=$(if($allow){'Ресурсы доступны. Одна тяжёлая задача.'}elseif(-not $metricsAvailable){'Не все показатели ресурсов доступны. Тяжёлые задачи ждут; чтение доступно.'}else{'Тяжёлые задачи ждут свободных ресурсов ПК; чтение доступно.'})
    }
}
