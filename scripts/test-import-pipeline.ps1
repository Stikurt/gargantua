param(
    [string]$SourceRoot = (Join-Path $PSScriptRoot '..'),
    [string]$AppImage = 'cotology-app:core-next',
    [string]$ParserImage = 'cotology-parser:core-next',
    [string]$PostgresImage = 'postgres:17-bookworm',
    [string]$ScannerContainer = 'cotology-clamav-1',
    [string]$ScannerNetwork = 'cotology_data',
    [ValidateRange(60,3600)][int]$TimeoutSeconds = 300,
    [switch]$LiveDiscovery,
    [switch]$Ranobe,
    [switch]$LiveRanobe
)
$ErrorActionPreference = 'Stop'
$SourceRoot = (Resolve-Path -LiteralPath $SourceRoot).ProviderPath
if (-not [IO.Path]::IsPathRooted($SourceRoot) -or -not (Test-Path -LiteralPath (Join-Path $SourceRoot 'tests/import-pipeline.integration.mjs'))) { throw 'SourceRoot must resolve to this project workspace.' }
$runId = [guid]::NewGuid().ToString('D')
$short = $runId.Replace('-','').Substring(0,12)
$prefix = "gargantua-test-pipeline-$short"
$labelKey = 'gargantua.test.run'
$label = "$labelKey=$runId"
$network = "$prefix-net"
$db = "$prefix-db"
$client = "$prefix-client"
$parser = "$prefix-parser"
$initializer = "$prefix-init"
$password = [guid]::NewGuid().ToString('N')
$databaseUrl = "postgres://pipeline_test:${password}@${db}:5432/gargantua_test_pipeline"
$containers = [Collections.Generic.List[string]]::new()
$volumes = [Collections.Generic.List[string]]::new()
$networkCreated = $false
$failure = $null
$imageIds = @{}
$testExit = $null
$teardownErrors = [Collections.Generic.List[string]]::new()
$reportDirectory = Join-Path $SourceRoot ".local/test-results/import-pipeline-$runId"
$reportDirectory = [IO.Path]::GetFullPath($reportDirectory)
if (-not $reportDirectory.StartsWith($SourceRoot + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Test report path escaped SourceRoot.' }
New-Item -ItemType Directory -Path $reportDirectory | Out-Null

function Invoke-DockerChecked {
    param([string[]]$Arguments,[string]$Step)
    $output = & docker @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw "$Step failed: $($output -join [Environment]::NewLine)" }
    return ($output -join [Environment]::NewLine).Trim()
}
function Test-OwnResource {
    param([string]$Kind,[string]$Name)
    $format = if ($Kind -eq 'container') { '{{ index .Config.Labels "gargantua.test.run" }}' } else { '{{ index .Labels "gargantua.test.run" }}' }
    $value = & docker $Kind inspect --format $format $Name 2>$null
    return ($LASTEXITCODE -eq 0 -and (($value -join '').Trim() -eq $runId) -and $Name.StartsWith($prefix,[StringComparison]::Ordinal))
}
function Add-TestContainer {
    param([string]$Name,[string[]]$Arguments)
    # Resolve the inspected image token to an immutable ID before creation.
    for($imageIndex=0;$imageIndex -lt $Arguments.Length;$imageIndex++) {
        if($imageIds.ContainsKey($Arguments[$imageIndex])) { $Arguments[$imageIndex]=$imageIds[$Arguments[$imageIndex]] }
    }
    $null = Invoke-DockerChecked -Arguments (@('create','--pull=never','--name',$Name,'--label',$label) + $Arguments) -Step "Create $Name"
    $containers.Add($Name)
}

try {
    # Inspect only: no production exec, database credentials, mounts, ports,
    # scanner updates or image pulls. Both attached networks must be internal.
    foreach ($image in @($AppImage,$ParserImage,$PostgresImage)) {
        $imageIds[$image] = Invoke-DockerChecked -Arguments @('image','inspect','--format','{{.Id}}',$image) -Step "Require local image $image"
        $declared = Invoke-DockerChecked -Arguments @('image','inspect','--format','{{json .Config.Volumes}}',$image) -Step 'Inspect image-declared volumes'
        if ($declared -and $declared -ne 'null') {
            $declaredPaths = ($declared | ConvertFrom-Json).PSObject.Properties.Name
            foreach ($declaredPath in $declaredPaths) {
                if ($image -ne $PostgresImage -or $declaredPath -ne '/var/lib/postgresql/data') { throw 'Unexpected image-declared volume: refusing an anonymous, unlabeled test volume.' }
            }
        }
    }
    if ((Invoke-DockerChecked -Arguments @('network','inspect','--format','{{.Internal}}',$ScannerNetwork) -Step 'Inspect scanner network') -ne 'true') { throw 'ScannerNetwork must already be internal.' }
    $scannerState = Invoke-DockerChecked -Arguments @('container','inspect','--format','{{.State.Running}}',$ScannerContainer) -Step 'Inspect existing scanner'
    if ($scannerState -ne 'true') { throw 'Existing scanner is not running; this test will not start or modify it.' }
    $scannerNetworks = Invoke-DockerChecked -Arguments @('container','inspect','--format','{{json .NetworkSettings.Networks}}',$ScannerContainer) -Step 'Inspect scanner attachment'
    if ((($scannerNetworks | ConvertFrom-Json).PSObject.Properties.Name) -notcontains $ScannerNetwork) { throw 'Existing scanner is not attached to ScannerNetwork.' }
    $networkArgs=@('network','create','--label',$label);if(-not ($LiveDiscovery -or $LiveRanobe)){$networkArgs+='--internal'}
    $null = Invoke-DockerChecked -Arguments ($networkArgs+@($network)) -Step 'Create owned test network'
    $networkCreated = $true
    $owned = @{}
    foreach ($scope in @('q','jobs','library','resources')) {
        $name = "$prefix-$scope"
        $null = Invoke-DockerChecked -Arguments @('volume','create','--label',$label,$name) -Step "Create new $scope volume"
        if (-not (Test-OwnResource -Kind 'volume' -Name $name)) { throw 'Test volume ownership not confirmed; refusing to mount it.' }
        $volumes.Add($name); $owned[$scope] = $name
    }
    $mounts = @('--mount',"type=volume,src=$($owned.q),dst=/quarantine",'--mount',"type=volume,src=$($owned.jobs),dst=/jobs",'--mount',"type=volume,src=$($owned.library),dst=/library",'--mount',"type=volume,src=$($owned.resources),dst=/resources")
    $initialize = @'
const fs=require('node:fs');
const roots=['/quarantine','/jobs','/library','/resources'];
const subdirs=['/quarantine/incoming','/quarantine/attempts','/jobs/pending','/jobs/results','/library/books'];
for(const root of roots){if(fs.readdirSync(root).length)throw Error('Test volume is not fresh');fs.chmodSync(root,0o700);}
for(const dir of subdirs)fs.mkdirSync(dir,{mode:0o700});
const markers=roots.map(root=>root+'/.pipeline-test-run');
for(const file of markers)fs.writeFileSync(file,process.env.GARGANTUA_TEST_RUN,{flag:'wx',mode:0o600});
for(const item of [...markers,...subdirs,...roots].sort((a,b)=>b.length-a.length))fs.chownSync(item,1000,1000);
'@
    Add-TestContainer -Name $initializer -Arguments (@('--network','none','--read-only','--user','0:0','--cap-drop=ALL','--cap-add=CHOWN','--cap-add=FOWNER','--memory=128m','--cpus=0.5','--pids-limit=32','--env',"GARGANTUA_TEST_RUN=$runId") + $mounts + @($AppImage,'node','-e',$initialize))
    $null = Invoke-DockerChecked -Arguments @('start','--attach',$initializer) -Step 'Initialize only new test volumes'
    if ((Invoke-DockerChecked -Arguments @('container','inspect','--format','{{.State.ExitCode}}',$initializer) -Step 'Check initializer exit') -ne '0') { throw 'New-volume initialization failed.' }

    Add-TestContainer -Name $db -Arguments @('--network',$network,'--read-only','--user','postgres','--cap-drop=ALL','--memory=512m','--cpus=1','--pids-limit=96','--tmpfs','/var/lib/postgresql/data:rw,noexec,nosuid,size=256m,mode=1777','--tmpfs','/var/run/postgresql:rw,noexec,nosuid,size=8m,mode=1777','--tmpfs','/tmp:rw,noexec,nosuid,size=32m,mode=1777','--env','PGDATA=/var/lib/postgresql/data/pgdata','--env','POSTGRES_USER=pipeline_test','--env',"POSTGRES_PASSWORD=$password",'--env','POSTGRES_DB=gargantua_test_pipeline',$PostgresImage)
    $null = Invoke-DockerChecked -Arguments @('start',$db) -Step 'Start disposable PostgreSQL'
    $ready = $false
    for ($attempt=0; $attempt -lt 45; $attempt++) {
        $null = & docker exec $db pg_isready -h 127.0.0.1 -U pipeline_test -d gargantua_test_pipeline 2>&1
        if ($LASTEXITCODE -eq 0) { $ready = $true; break }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { throw 'Disposable PostgreSQL did not become ready.' }
    Add-TestContainer -Name $parser -Arguments @('--network','none','--read-only','--user','1000:1000','--cap-drop=ALL','--security-opt','no-new-privileges:true','--memory=384m','--cpus=0.75','--pids-limit=32','--tmpfs','/tmp:rw,nosuid,noexec,size=64m,mode=1777','--mount',"type=volume,src=$($owned.q),dst=/quarantine,readonly",'--mount',"type=volume,src=$($owned.jobs),dst=/jobs",$ParserImage)
    $null = Invoke-DockerChecked -Arguments @('start',$parser) -Step 'Start isolated parser'
    $liveEnv=@();if($LiveDiscovery){$liveEnv+=@('--env','GARGANTUA_TEST_LIVE_DISCOVERY=1')};if($Ranobe -or $LiveRanobe){$liveEnv+=@('--env','GARGANTUA_TEST_RANOBE=1')};if($LiveRanobe){$liveEnv+=@('--env','GARGANTUA_TEST_LIVE_RANOBE=1')}
    Add-TestContainer -Name $client -Arguments (@('--network',$network,'--read-only','--user','1000:1000','--cap-drop=ALL','--security-opt','no-new-privileges:true','--memory=384m','--cpus=1','--pids-limit=64','--tmpfs','/tmp:rw,nosuid,noexec,size=64m,mode=1777','--env','GARGANTUA_TEST_ISOLATED=1','--env',"GARGANTUA_TEST_RUN=$runId",'--env',"TEST_DATABASE_URL=$databaseUrl",'--env',"CLAM_HOST=$ScannerContainer",'--env','CLAM_PORT=3310') + $liveEnv + $mounts + @($AppImage,'node','tests/import-pipeline.integration.mjs'))
    # Only this new client joins the existing internal scanner network.
    $null = Invoke-DockerChecked -Arguments @('network','connect',$ScannerNetwork,$client) -Step 'Attach only test client to existing scanner network'
    $null = Invoke-DockerChecked -Arguments @('start',$client) -Step 'Start acceptance client'
    Write-Host "Isolated pipeline acceptance running. Reports: $reportDirectory"
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $state = Invoke-DockerChecked -Arguments @('container','inspect','--format','{{.State.Status}} {{.State.ExitCode}}',$client) -Step 'Read test-client status'
        if ($state.StartsWith('exited ')) { $testExit = [int]($state.Split(' ')[1]); break }
        if ($state.StartsWith('dead ')) { throw 'Acceptance client became dead.' }
        Start-Sleep -Seconds 1
    }
    if ($null -eq $testExit) { throw 'Acceptance client exceeded its bounded runtime.' }
    if ($testExit -ne 0) { throw "Acceptance client failed with exit code $testExit. Inspect saved isolated logs/report." }
} catch { $failure = $_ }
finally {
    try {
        foreach ($name in $containers) {
            if (Test-OwnResource -Kind 'container' -Name $name) {
                $logs = & docker logs $name 2>&1
                [IO.File]::WriteAllText((Join-Path $reportDirectory "$name.log"),($logs -join [Environment]::NewLine))
            }
        }
        if (Test-OwnResource -Kind 'container' -Name $client) {
            $null = & docker cp "${client}:/resources/import-pipeline-report.json" (Join-Path $reportDirectory 'report.json') 2>&1
            if ($LASTEXITCODE -ne 0 -and $null -ne $testExit) { $teardownErrors.Add('report-copy-failed') }
        }
    } catch { $teardownErrors.Add('artifact-save-failed') }
    # Remove only resources with BOTH this unpredictable ownership label and
    # this generated name prefix. Never remove the shared scanner/network.
    for ($i=$containers.Count-1; $i -ge 0; $i--) {
        $name=$containers[$i]
        try {
            if (Test-OwnResource -Kind 'container' -Name $name) { $null=& docker container rm --force $name 2>&1; if($LASTEXITCODE -ne 0){$teardownErrors.Add("container:$name")} }
            else { $teardownErrors.Add("ownership-not-confirmed:container:$name") }
        } catch { $teardownErrors.Add("container:$name") }
    }
    foreach ($name in $volumes) {
        try {
            if (Test-OwnResource -Kind 'volume' -Name $name) { $null=& docker volume rm $name 2>&1; if($LASTEXITCODE -ne 0){$teardownErrors.Add("volume:$name")} }
            else { $teardownErrors.Add("ownership-not-confirmed:volume:$name") }
        } catch { $teardownErrors.Add("volume:$name") }
    }
    if ($networkCreated) { try {
        if (Test-OwnResource -Kind 'network' -Name $network) { $null=& docker network rm $network 2>&1; if($LASTEXITCODE -ne 0){$teardownErrors.Add("network:$network")} }
        else { $teardownErrors.Add("ownership-not-confirmed:network:$network") }
    } catch { $teardownErrors.Add("network:$network") } }
    $harness = @{runId=$runId;ok=($null -eq $failure -and $teardownErrors.Count -eq 0);clientExit=$testExit;images=@($AppImage,$ParserImage,$PostgresImage);appImageId=$imageIds[$AppImage];parserImageId=$imageIds[$ParserImage];reportDirectory=$reportDirectory;teardownErrors=@($teardownErrors);productionScannerModified=$false;hostPorts=$false;productionDataMounts=$false;liveDiscovery=[bool]$LiveDiscovery;ranobe=([bool]$Ranobe -or [bool]$LiveRanobe);liveRanobe=[bool]$LiveRanobe;externalNetwork=([bool]$LiveDiscovery -or [bool]$LiveRanobe)}
    if ($failure) { $harness.error=$failure.Exception.Message }
    [IO.File]::WriteAllText((Join-Path $reportDirectory 'harness.json'),($harness | ConvertTo-Json -Depth 5))
}
if ($failure) { throw $failure }
if ($teardownErrors.Count) { throw "Owned test-resource cleanup incomplete: $($teardownErrors -join ', ')" }
Write-Host "PASS: real isolated import pipeline. Report: $(Join-Path $reportDirectory 'report.json')"
