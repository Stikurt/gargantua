# Shared, narrowly scoped helpers. Dot-source from backup.ps1/verify-backup.ps1.
$script:GargantuaOperations = [Collections.Generic.List[object]]::new()
$script:GargantuaProjectRoot = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
. (Join-Path $PSScriptRoot 'runtime-common.ps1')

function Invoke-GargantuaNative {
    param([Parameter(Mandatory)][string]$Operation, [Parameter(Mandatory)][string]$Command,
          [string[]]$Arguments = @(), [AllowNull()][string]$InputText = $null,
          [ValidateRange(1,3600)][int]$TimeoutSeconds=900)
    try {
        if($Command -in @('docker','docker.exe')){$Command=Get-GargantuaDockerExecutable -ProjectRoot $script:GargantuaProjectRoot}
        $native = Get-Command -Name $Command -CommandType Application -ErrorAction Stop | Select-Object -First 1
    }
    catch { throw "$Operation failed: required executable is unavailable." }
    $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=$native.Source;$info.UseShellExecute=$false;$info.CreateNoWindow=$true
    $info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true;$info.RedirectStandardInput=($null -ne $InputText)
    $info.StandardOutputEncoding=[Text.UTF8Encoding]::new($false);$info.StandardErrorEncoding=[Text.UTF8Encoding]::new($false)
    if($null -ne $InputText){$info.StandardInputEncoding=[Text.UTF8Encoding]::new($false)}
    $info.Environment['DOCKER_CONTEXT']='desktop-linux'
    foreach($option in @('DOCKER_HOST','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH')){$null=$info.Environment.Remove($option)}
    foreach($argument in $Arguments){$info.ArgumentList.Add($argument)}
    $process=[Diagnostics.Process]::new();$process.StartInfo=$info
    $code=$null;$output='';$global:LASTEXITCODE=$null;$timer=[Diagnostics.Stopwatch]::StartNew()
    try {
        if(-not $process.Start()){throw 'Native process did not start.'}
        $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
        if($null -ne $InputText){
            $normalized=$InputText.Replace("`r`n","`n").Replace("`r","`n")
            if($normalized.Length -gt 16MB){throw 'Native input exceeded its bound.'}
            $write=$process.StandardInput.WriteAsync($normalized)
            $remaining=[Math]::Max(1,[int]($TimeoutSeconds*1000-$timer.ElapsedMilliseconds))
            if(-not $write.Wait($remaining)){throw [TimeoutException]::new()}
            $null=$write.GetAwaiter().GetResult();$process.StandardInput.Close()
        }
        $remaining=[Math]::Max(1,[int]($TimeoutSeconds*1000-$timer.ElapsedMilliseconds))
        if(-not $process.WaitForExit($remaining)){throw [TimeoutException]::new()}
        $code=$process.ExitCode
        if(-not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdout,$stderr),3000)){throw [TimeoutException]::new()}
        $output=$stdout.GetAwaiter().GetResult();$null=$stderr.GetAwaiter().GetResult()
        if($output.Length -gt 96MB){throw 'Native output exceeded its bound.'}
    }catch [TimeoutException] {
        $code=-2
        try{if(-not $process.HasExited){$process.Kill($true);$null=$process.WaitForExit(3000)}}catch{}
        throw "$Operation timed out; only its own command process was terminated. Private command output was not printed."
    }catch{
        try{if(-not $process.HasExited){$process.Kill($true);$null=$process.WaitForExit(3000)}}catch{}
        throw "$Operation failed (exit $code). Private command output was not printed."
    }finally{
        $global:LASTEXITCODE=$code
        $script:GargantuaOperations.Add([pscustomobject]@{operation=$Operation;exitCode=$code;at=[DateTimeOffset]::UtcNow.ToString('o');timeoutSeconds=$TimeoutSeconds})
        $process.Dispose()
    }
    if($null -eq $code -or $code -ne 0){throw "$Operation failed (exit $code). Private command output was not printed."}
    return $output.TrimEnd("`r","`n")
}

function Invoke-GargantuaDocker {
    param([Parameter(Mandatory)][string]$Operation, [string[]]$Arguments, [AllowNull()][string]$InputText=$null,
          [ValidateRange(1,3600)][int]$TimeoutSeconds=900)
    Invoke-GargantuaNative -Operation $Operation -Command 'docker' -Arguments $Arguments -InputText $InputText -TimeoutSeconds $TimeoutSeconds
}

function Get-GargantuaPython {
    return Get-GargantuaPythonRuntime -ProjectRoot $script:GargantuaProjectRoot
}

function Invoke-GargantuaPython {
    param([Parameter(Mandatory)][string]$Operation, [string[]]$Arguments)
    $runtime = Get-GargantuaPython
    $all = @($runtime.prefix) + @((Join-Path $PSScriptRoot 'backup-artifacts.py')) + @($Arguments)
    Invoke-GargantuaNative -Operation $Operation -Command $runtime.command -Arguments $all
}

function Set-GargantuaPrivateDirectory {
    param([Parameter(Mandatory)][string]$Path)
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'These orchestration scripts require Windows owner/SYSTEM ACL support.' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    Invoke-GargantuaNative -Operation 'protect private directory' -Command 'icacls' -Arguments @($Path,'/inheritance:r','/grant:r',"${identity}:(OI)(CI)F",'*S-1-5-18:(OI)(CI)F') | Out-Null
}

function Write-GargantuaJson {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)]$Value)
    $text = ConvertTo-Json -InputObject $Value -Depth 30
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($text+"`n")
    $temporary = $Path + '.tmp'
    $stream = [IO.File]::Open($temporary,[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($temporary,$Path,[NullString]::Value) }
    else { [IO.File]::Move($temporary,$Path) }
}

function Get-GargantuaService {
    param([Parameter(Mandatory)][string]$Service)
    $ids = Invoke-GargantuaDocker -Operation "find $Service container" -Arguments @('compose','--project-directory',$script:GargantuaProjectRoot,'-f',(Join-Path $script:GargantuaProjectRoot 'compose.yaml'),'ps','-a','-q',$Service)
    $list = @($ids -split '\s+' | Where-Object { $_ })
    if ($list.Count -gt 1) { throw 'Snapshot supports one container per service, not replicas.' }
    if (-not $list.Count) { return [pscustomobject]@{service=$Service;id='';exists=$false;running=$false;paused=$false;status='absent'} }
    if ($list[0] -notmatch '^[a-f0-9]{12,64}$') { throw 'Unexpected container identifier.' }
    $state = Invoke-GargantuaDocker -Operation "inspect $Service state" -Arguments @('inspect','--format','{{json .State}}',$list[0]) | ConvertFrom-Json
    if ($state.Restarting -or $state.Dead -or $state.Status -notin @('running','paused','exited','created')) { throw "Unstable $Service state; snapshot was not started." }
    return [pscustomobject]@{service=$Service;id=$list[0];exists=$true;running=[bool]$state.Running;paused=[bool]$state.Paused;status=[string]$state.Status}
}

function Assert-GargantuaStopped {
    param([Parameter(Mandatory)]$State)
    if (-not $State.exists) { return }
    $current = Invoke-GargantuaDocker -Operation "confirm $($State.service) stopped" -Arguments @('inspect','--format','{{json .State}}',$State.id) | ConvertFrom-Json
    if ($current.Running -or $current.Restarting -or $current.Paused) { throw 'Publisher/processor did not stop.' }
}

function Restore-GargantuaHandler {
    param([Parameter(Mandatory)]$State)
    if (-not $State.exists) { return }
    $current = Invoke-GargantuaDocker -Operation "inspect $($State.service) before restore" -Arguments @('inspect','--format','{{json .State}}',$State.id) | ConvertFrom-Json
    if ($State.running) {
        if (-not $current.Running) { Invoke-GargantuaDocker -Operation "restore $($State.service) running" -Arguments @('start',$State.id) | Out-Null }
        $current = Invoke-GargantuaDocker -Operation "inspect $($State.service) restored" -Arguments @('inspect','--format','{{json .State}}',$State.id) | ConvertFrom-Json
        if ($State.paused -and -not $current.Paused) { Invoke-GargantuaDocker -Operation "restore $($State.service) paused" -Arguments @('pause',$State.id) | Out-Null }
        if (-not $State.paused -and $current.Paused) { Invoke-GargantuaDocker -Operation "restore $($State.service) unpaused" -Arguments @('unpause',$State.id) | Out-Null }
    } else {
        if ($current.Paused) { Invoke-GargantuaDocker -Operation "restore $($State.service) before stop" -Arguments @('unpause',$State.id) | Out-Null }
        if ($current.Running) { Invoke-GargantuaDocker -Operation "restore $($State.service) stopped" -Arguments @('stop','--time','15',$State.id) | Out-Null }
    }
    $last = Invoke-GargantuaDocker -Operation "confirm $($State.service) original state" -Arguments @('inspect','--format','{{json .State}}',$State.id) | ConvertFrom-Json
    if ([bool]$last.Running -ne $State.running -or [bool]$last.Paused -ne $State.paused -or $last.Restarting) { throw "Failed to restore original $($State.service) state." }
}

function Assert-GargantuaOwnedRestore {
    param([Parameter(Mandatory)][string]$Path,[Parameter(Mandatory)][string]$Token)
    $full = [IO.Path]::GetFullPath($Path)
    $marker = Join-Path $full 'restore-owner.json'
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) { throw 'Restore ownership marker missing; cleanup refused.' }
    $saved = Get-Content -LiteralPath $marker -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($saved.token -ne $Token -or $saved.root -ne $full -or (Get-Item -LiteralPath $full).Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) { throw 'Restore ownership mismatch; cleanup refused.' }
}

function Get-GargantuaFullPath {
    param([Parameter(Mandatory)][string]$Path)
    $full = [IO.Path]::GetFullPath($Path)
    if ($full -eq [IO.Path]::GetPathRoot($full)) { return $full }
    return $full.TrimEnd([char[]]@([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar))
}

function Test-GargantuaPathWithin {
    param([Parameter(Mandatory)][string]$Root,[Parameter(Mandatory)][string]$Target)
    $base = Get-GargantuaFullPath $Root
    $child = Get-GargantuaFullPath $Target
    $prefix = $base.TrimEnd([char[]]@([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar)) + [IO.Path]::DirectorySeparatorChar
    return $child.Equals($base,[StringComparison]::OrdinalIgnoreCase) -or $child.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)
}

function Assert-GargantuaNoReparseAncestors {
    param([Parameter(Mandatory)][string]$Path)
    $current = Get-GargantuaFullPath $Path
    while ($current) {
        if ((Test-Path -LiteralPath $current) -and (Get-Item -LiteralPath $current -Force).Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) { throw 'Reparse/junction ancestor is not an isolated target.' }
        $parent = [IO.Directory]::GetParent($current)
        if (-not $parent) { break }
        $current = $parent.FullName
    }
}

function Write-GargantuaBase64File {
    param([Parameter(Mandatory)][string]$Path,[Parameter(Mandatory)][string]$Encoded,
          [ValidateRange(1,67108864)][int]$MaxBytes=33554432)
    $data = $Encoded.Trim()
    if ($data.Length -gt (4*[Math]::Ceiling($MaxBytes/3.0)) -or $data -notmatch '^[A-Za-z0-9+/]+={0,2}$') { throw 'Invalid or oversized private metadata transfer.' }
    try { $bytes = [Convert]::FromBase64String($data) }
    catch { throw 'Private metadata transfer is not valid base64.' }
    if ($bytes.Length -gt $MaxBytes) { throw 'Private metadata exceeds the validation limit.' }
    $stream = [IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}
