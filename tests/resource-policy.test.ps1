<# Offline only: policy, synthetic path discovery, atomic file replacement and locks.
No production metrics file, monitor instance, Docker, WSL or CIM is touched. #>
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
. (Join-Path $project 'scripts/resource-policy.ps1')
. (Join-Path $project 'scripts/resource-monitor-io.ps1')
$cases=[Collections.Generic.List[object]]::new()
$now=[long]1800000000000
function Assert-ResourceTest([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message}}
function Test-ResourceCase([string]$Name,[scriptblock]$Body){try{& $Body;$cases.Add(@{name=$Name;status='PASS'});Write-Host "PASS $Name"}catch{$cases.Add(@{name=$Name;status='FAIL';error=$_.Exception.Message});Write-Host "FAIL $Name`: $($_.Exception.Message)"}}
function New-HealthySample {return [pscustomobject]@{observedAt=$now;freeMb=4096;cpuPercent=20;projectDiskFreeMb=12000;dockerDiskFreeMb=15000;dockerStorageKnown=$true}}
function New-AllowedState {
    $state=$null
    for($i=0;$i -lt 3;$i++){$state=Get-GargantuaResourceDecision -Sample (New-HealthySample) -Previous $state -NowMs $now}
    return $state
}
function New-StorageFixture([string]$Name){$path=Join-Path $fixtures $Name;New-Item -ItemType Directory -Path $path|Out-Null;return $path}
function Write-StorageFile([string]$Profile,[string]$Relative){$path=Join-Path $Profile $Relative;New-Item -ItemType Directory -Path (Split-Path $path -Parent) -Force|Out-Null;[IO.File]::WriteAllBytes($path,[byte[]]@());return $path}
$token=[Guid]::NewGuid().ToString('N')
$allowed=[IO.Path]::GetFullPath((Join-Path $project '.local/test-results'))
$root=[IO.Path]::GetFullPath((Join-Path $allowed ('resource-policy-'+$token)))
$fixtures=Join-Path $root 'fixtures';$owned=$false
try{
    if(-not $root.StartsWith($allowed+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $root)){throw 'Invalid new test root'}
    New-Item -ItemType Directory -Path $fixtures -Force|Out-Null
    Write-GargantuaResourceJson -Path (Join-Path $root 'test-owner.json') -Value @{token=$token;root=$root};$owned=$true
    Test-ResourceCase 'startup requires three consecutive healthy readings' {
        $state=$null
        for($i=1;$i -le 3;$i++){$state=Get-GargantuaResourceDecision -Sample (New-HealthySample) -Previous $state -NowMs $now;Assert-ResourceTest ($state.healthyReadings -eq $i) 'Healthy counter differs';Assert-ResourceTest ($state.allowHeavy -eq ($i -eq 3)) 'Heavy work was admitted too early or never admitted'}
        Assert-ResourceTest ($state.hostDiskFreeMb -eq 12000 -and $state.maxHeavyJobs -eq 1) 'Combined disk minimum or one-job bound differs'
    }
    Test-ResourceCase 'low RAM pauses immediately' {$sample=New-HealthySample;$sample.freeMb=1535;$state=Get-GargantuaResourceDecision -Sample $sample -Previous (New-AllowedState) -NowMs $now;Assert-ResourceTest (-not $state.allowHeavy -and $state.healthyReadings -eq 0 -and 'pressure-ram' -in $state.reasons) 'Low RAM did not revoke admission'}
    Test-ResourceCase 'high CPU pauses immediately' {$sample=New-HealthySample;$sample.cpuPercent=91;$state=Get-GargantuaResourceDecision -Sample $sample -Previous (New-AllowedState) -NowMs $now;Assert-ResourceTest (-not $state.allowHeavy -and 'pressure-cpu' -in $state.reasons) 'High CPU did not revoke admission'}
    Test-ResourceCase 'project and Docker disks independently pause work' {foreach($field in @('projectDiskFreeMb','dockerDiskFreeMb')){$sample=New-HealthySample;$sample.$field=1023;$state=Get-GargantuaResourceDecision -Sample $sample -Previous (New-AllowedState) -NowMs $now;Assert-ResourceTest (-not $state.allowHeavy -and $state.hostDiskFreeMb -eq 1023) 'A low disk was masked by the other disk'}}
    Test-ResourceCase 'unclear Docker storage fails closed even with numeric free space' {$sample=New-HealthySample;$sample.dockerStorageKnown=$false;$state=Get-GargantuaResourceDecision -Sample $sample -Previous (New-AllowedState) -NowMs $now;Assert-ResourceTest (-not $state.allowHeavy -and -not $state.metricsAvailable -and $state.healthyReadings -eq 0) 'Unknown storage retained a permit'}
    Test-ResourceCase 'missing malformed nonfinite and out-of-range metrics fail closed' {foreach($pair in @(@('freeMb',$null),@('freeMb','4096'),@('freeMb',[double]::NaN),@('cpuPercent',101),@('cpuPercent',-1),@('dockerDiskFreeMb',[double]::PositiveInfinity))){$sample=New-HealthySample;$sample.($pair[0])=$pair[1];$state=Get-GargantuaResourceDecision -Sample $sample -Previous (New-AllowedState) -NowMs $now;Assert-ResourceTest (-not $state.allowHeavy -and -not $state.metricsAvailable) 'Malformed metric was admitted'}}
    Test-ResourceCase 'stale and future-dated samples fail closed' {foreach($offset in @(-30001,5001)){$sample=New-HealthySample;$sample.observedAt=$now+$offset;$state=Get-GargantuaResourceDecision -Sample $sample -Previous (New-AllowedState) -NowMs $now;Assert-ResourceTest (-not $state.allowHeavy -and -not $state.metricsAvailable) 'Untrusted sample timestamp was admitted'}}
    Test-ResourceCase 'stale or malformed prior permit cannot bypass warmup' {foreach($case in @('stale','future','malformed')){$previous=New-AllowedState;if($case -eq 'stale'){$previous.updatedAt=$now-45001}elseif($case -eq 'future'){$previous.updatedAt=$now+5001}else{$previous.allowHeavy='true'};$state=Get-GargantuaResourceDecision -Sample (New-HealthySample) -Previous $previous -NowMs $now;Assert-ResourceTest (-not $state.allowHeavy -and $state.healthyReadings -eq 1) 'Untrusted prior state bypassed warmup'}}
    Test-ResourceCase 'mid-band holds a permit but cannot resume a pause' {$sample=New-HealthySample;$sample.freeMb=1800;$sample.cpuPercent=80;$state=Get-GargantuaResourceDecision -Sample $sample -Previous (New-AllowedState) -NowMs $now;Assert-ResourceTest ($state.allowHeavy -and $state.healthyReadings -eq 0) 'Hysteresis did not retain a valid permit';$state=Get-GargantuaResourceDecision -Sample $sample -Previous $null -NowMs $now;Assert-ResourceTest (-not $state.allowHeavy) 'Mid-band incorrectly resumed paused work'}
    Test-ResourceCase 'rising pressure resets recovery and needs three healthy samples again' {$state=New-AllowedState;$pressure=New-HealthySample;$pressure.cpuPercent=99;$state=Get-GargantuaResourceDecision -Sample $pressure -Previous $state -NowMs $now;for($i=1;$i -le 2;$i++){$state=Get-GargantuaResourceDecision -Sample (New-HealthySample) -Previous $state -NowMs $now;Assert-ResourceTest (-not $state.allowHeavy) 'Recovery resumed before three samples'};$state=Get-GargantuaResourceDecision -Sample $pressure -Previous $state -NowMs $now;Assert-ResourceTest ($state.healthyReadings -eq 0 -and -not $state.allowHeavy) 'Repeated pressure failed to reset recovery';for($i=1;$i -le 3;$i++){$state=Get-GargantuaResourceDecision -Sample (New-HealthySample) -Previous $state -NowMs $now};Assert-ResourceTest $state.allowHeavy 'Recovery never resumed'}
    Test-ResourceCase 'strict healthy thresholds do not count boundary values' {$sample=New-HealthySample;$sample.freeMb=2304;$sample.cpuPercent=75;$sample.dockerDiskFreeMb=2048;$state=Get-GargantuaResourceDecision -Sample $sample -Previous $null -NowMs $now;Assert-ResourceTest (-not $state.allowHeavy -and $state.healthyReadings -eq 0) 'Boundary values were counted as healthy'}
    Test-ResourceCase 'known default data VHDX is discovered without a guest command' {$profile=New-StorageFixture 'default';$path=Write-StorageFile $profile 'AppData/Local/Docker/wsl/disk/docker_data.vhdx';$storage=Get-GargantuaDockerStorage -UserProfile $profile;Assert-ResourceTest ($storage.known -and $storage.paths.Count -eq 1 -and $storage.paths[0] -eq $path) 'Default data VHDX was not identified'}
    Test-ResourceCase 'system VHDX alone cannot establish the Docker data location' {$profile=New-StorageFixture 'system-only';Write-StorageFile $profile 'AppData/Local/Docker/wsl/distro/ext4.vhdx'|Out-Null;$storage=Get-GargantuaDockerStorage -UserProfile $profile;Assert-ResourceTest (-not $storage.known) 'System image was mistaken for the data image'}
    Test-ResourceCase 'ambiguous default data VHDX paths fail closed' {$profile=New-StorageFixture 'ambiguous';Write-StorageFile $profile 'AppData/Local/Docker/wsl/disk/docker_data.vhdx'|Out-Null;Write-StorageFile $profile 'AppData/Local/Docker/wsl/data/ext4.vhdx'|Out-Null;$storage=Get-GargantuaDockerStorage -UserProfile $profile;Assert-ResourceTest (-not $storage.known -and $storage.reason -eq 'docker-storage-ambiguous') 'Ambiguous images were silently selected'}
    Test-ResourceCase 'configured data folder overrides obsolete default files' {$profile=New-StorageFixture 'configured';Write-StorageFile $profile 'AppData/Local/Docker/wsl/disk/docker_data.vhdx'|Out-Null;$configured=Join-Path $profile 'relocated';$path=Write-StorageFile $configured 'disk/docker_data.vhdx';$settings=Join-Path $profile 'settings.json';Write-GargantuaResourceJson -Path $settings -Value @{dataFolder=$configured;ignoredPrivateField='not emitted'};$storage=Get-GargantuaDockerStorage -UserProfile $profile -SettingsPath $settings;Assert-ResourceTest ($storage.known -and $storage.paths.Count -eq 1 -and $storage.paths[0] -eq $path) 'Configured location did not take precedence'}
    Test-ResourceCase 'missing configured folder never falls back to an obsolete default' {$profile=New-StorageFixture 'missing-configured';Write-StorageFile $profile 'AppData/Local/Docker/wsl/disk/docker_data.vhdx'|Out-Null;$settings=Join-Path $profile 'settings.json';Write-GargantuaResourceJson -Path $settings -Value @{dataFolder=(Join-Path $profile 'missing')};$storage=Get-GargantuaDockerStorage -UserProfile $profile -SettingsPath $settings;Assert-ResourceTest (-not $storage.known) 'Missing configured storage was hidden by an old default'}
    Test-ResourceCase 'malformed settings and invalid dataFolder fail closed' {$profile=New-StorageFixture 'malformed';Write-StorageFile $profile 'AppData/Local/Docker/wsl/disk/docker_data.vhdx'|Out-Null;$settings=Join-Path $profile 'settings.json';foreach($text in @('{bad','[]','{"dataFolder":42}','{"dataFolder":"relative/path"}')){[IO.File]::WriteAllText($settings,$text);$storage=Get-GargantuaDockerStorage -UserProfile $profile -SettingsPath $settings;Assert-ResourceTest (-not $storage.known) ('Malformed synthetic settings were admitted: '+$text)}}
    Test-ResourceCase 'atomic state create and replacement preserve Unicode and fresh fields' {$path=Join-Path $fixtures 'state.json';Write-GargantuaResourceJson -Path $path -Value (New-AllowedState);$state=Get-GargantuaResourceDecision -Sample $null -Previous $null -NowMs ($now+1);$state.message='Пауза — чтение доступно 🌌';Write-GargantuaResourceJson -Path $path -Value $state;$read=Get-Content -LiteralPath $path -Raw -Encoding UTF8|ConvertFrom-Json;Assert-ResourceTest (-not $read.allowHeavy -and $read.updatedAt -eq ($now+1) -and $read.message -eq $state.message -and $read.reasons -is [array]) 'Atomic replacement lost state, array shape or Unicode';Assert-ResourceTest (@(Get-ChildItem -LiteralPath $fixtures -Filter '*.tmp').Count -eq 0) 'Atomic writer left a temporary file'}
    Test-ResourceCase 'an exclusive instance lock rejects another writer and releases cleanly' {$runtime=New-StorageFixture 'lock';$first=Open-GargantuaMonitorLock -RuntimeRoot $runtime;$second=$null;try{$blocked=$false;try{$second=Open-GargantuaMonitorLock -RuntimeRoot $runtime}catch{$blocked=$true};Assert-ResourceTest $blocked 'A second writer acquired the held monitor lock'}finally{if($second){$second.Dispose()};$first.Dispose()};$third=Open-GargantuaMonitorLock -RuntimeRoot $runtime;$third.Dispose()}
    Test-ResourceCase 'monitor lock is exclusive across two PowerShell processes' {
        $runtime=New-StorageFixture 'cross-process-lock';$probeFile=Join-Path $fixtures 'lock-probe.ps1'
        [IO.File]::WriteAllText($probeFile,@'
param([string]$Helper,[string]$RuntimeRoot)
$ErrorActionPreference='Stop'
. $Helper
try{$handle=Open-GargantuaMonitorLock -RuntimeRoot $RuntimeRoot;$handle.Dispose();exit 0}catch{exit 17}
'@,[Text.UTF8Encoding]::new($false))
        $pwsh=(Get-Command pwsh.exe -CommandType Application -ErrorAction Stop|Select-Object -First 1).Source
        $helper=Join-Path $project 'scripts/resource-monitor-io.ps1';$first=Open-GargantuaMonitorLock -RuntimeRoot $runtime
        try{& $pwsh -NoProfile -NonInteractive -File $probeFile -Helper $helper -RuntimeRoot $runtime;Assert-ResourceTest ($LASTEXITCODE -eq 17) 'A second process acquired the active instance lock'}finally{$first.Dispose()}
        & $pwsh -NoProfile -NonInteractive -File $probeFile -Helper $helper -RuntimeRoot $runtime
        Assert-ResourceTest ($LASTEXITCODE -eq 0) 'Lock remained stale after its owning handle closed'
    }
    Test-ResourceCase 'monitor scripts parse and cannot mutate Docker or awaken WSL' {foreach($name in @('resource-policy.ps1','resource-monitor-io.ps1','resource-monitor.ps1','start-monitor.ps1')){$tokens=$null;$errors=$null;$ast=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $project ('scripts/'+$name)),[ref]$tokens,[ref]$errors);Assert-ResourceTest (@($errors).Count -eq 0) ('Syntax error in '+$name);$forbidden=@($ast.FindAll({param($node) $node -is [System.Management.Automation.Language.CommandAst] -and $node.GetCommandName() -in @('docker','docker.exe','wsl','wsl.exe','Stop-Process','Stop-Service','Restart-Service')},$true));Assert-ResourceTest ($forbidden.Count -eq 0) ('Forbidden host mutation/guest command in '+$name)};$start=Get-Content -LiteralPath (Join-Path $project 'scripts/start-monitor.ps1') -Raw;Assert-ResourceTest ($start.Contains('-WindowStyle Hidden')) 'Background monitor launch lost the hidden window setting'}
}catch{$cases.Add(@{name='harness';status='FAIL';error=$_.Exception.Message});Write-Host $_.Exception.Message}
finally{
    if($owned){
        try{$marker=Get-Content -LiteralPath (Join-Path $root 'test-owner.json') -Raw|ConvertFrom-Json;if($marker.token -ne $token -or $marker.root -ne $root -or -not $fixtures.StartsWith($root+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Cleanup ownership mismatch'};if((Get-Item -LiteralPath $fixtures).Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)){throw 'Cleanup target is a reparse point'};Remove-Item -LiteralPath $fixtures -Recurse -Force -ErrorAction Stop}catch{$cases.Add(@{name='owned-cleanup';status='FAIL';error=$_.Exception.Message})}
        $failed=@($cases.ToArray()|Where-Object status -eq 'FAIL')
        Write-GargantuaResourceJson -Path (Join-Path $root 'report.json') -Value @{status=$(if($failed.Count){'FAIL'}else{'PASS'});cases=$cases.ToArray();passed=$cases.Count-$failed.Count;failed=$failed.Count;productionMonitorRestarted=$false;productionResourcesWritten=$false;dockerCommands=$false;wslCommands=$false}
    }
}
$failed=@($cases.ToArray()|Where-Object status -eq 'FAIL')
Write-Host ("Resource policy offline checks: {0} passed, {1} failed. Report: {2}" -f ($cases.Count-$failed.Count),$failed.Count,(Join-Path $root 'report.json'))
if($failed.Count){exit 1};exit 0
