<# Bootstrap the already tested portable runtimes once. No services/tasks are
started. Normal execution never references these bootstrap source locations. #>
[CmdletBinding()]
param([ValidateSet('prepare','verify','status')][string]$Action='status',
      [string]$PowerShellSource=(Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell'),
      [string]$PythonSource=(Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/python'))
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'runtime-common.ps1')
$project=[IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent));$tools=Join-Path $project '.local/tools';$target=Join-Path $tools 'runtime'
if($Action -eq 'status'){
    $runtime=Get-GargantuaRuntimeManifest -ProjectRoot $project
    [pscustomobject]@{status=$runtime.manifest.status;powershell=$runtime.manifest.powershell.version;python=$runtime.manifest.python.version;files=@($runtime.manifest.files).Count;bytes=$runtime.manifest.bytes;root=$runtime.root};return
}
function Get-RuntimeFiles([string]$Root,[string[]]$ExcludedRelativeDirectories=@()){
    $queue=[Collections.Generic.Stack[string]]::new();$queue.Push($Root)
    while($queue.Count){foreach($item in Get-ChildItem -LiteralPath $queue.Pop() -Force -ErrorAction Stop){
        if($item.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)){throw 'Runtime source contains a reparse point.'}
        if($item.PSIsContainer){
            $relative=[IO.Path]::GetRelativePath($Root,$item.FullName).Replace('\','/')
            if($relative -notin $ExcludedRelativeDirectories){$queue.Push($item.FullName)}
        }else{$item}
    }}
}
function Test-RuntimeFiles([string]$Root){
    Assert-GargantuaRuntimePath $Root
    $manifestPath=Join-Path $Root 'runtime-manifest.json';$manifest=Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8|ConvertFrom-Json
    if($manifest.schemaVersion -ne 1 -or $manifest.status -ne 'complete' -or @($manifest.files).Count -gt 10000){throw 'Runtime manifest is invalid.'}
    $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase);$total=0L
    # Walk every entry once and reject every reparse point; avoid repeatedly
    # walking the same Windows ancestors thousands of times during verification.
    $inventory=@{}
    foreach($file in Get-RuntimeFiles $Root){
        $relative=[IO.Path]::GetRelativePath($Root,$file.FullName).Replace('\','/')
        if($relative -ne 'runtime-manifest.json'){$inventory[$relative]=$file}
    }
    foreach($entry in $manifest.files){
        if($entry.path -notmatch '^(powershell-7\.6\.5|python-3\.12\.14)/[A-Za-z0-9_ .+()/-]+$' -or $entry.path -match '(^|/)\.\.(/|$)' -or $entry.sha256 -notmatch '^[a-f0-9]{64}$' -or -not $seen.Add($entry.path)){throw 'Runtime manifest path or checksum is invalid.'}
        $file=$inventory[$entry.path]
        if(-not $file -or $file.Length -ne $entry.bytes -or (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256){throw 'Runtime file integrity verification failed.'}
        $total+=$file.Length
    }
    if($inventory.Count -ne $seen.Count -or $total -ne $manifest.bytes){throw 'Runtime inventory does not match its manifest.'}
    return [pscustomobject]@{status='verified';files=$seen.Count;bytes=$total;root=$Root}
}
if($Action -eq 'verify'){Test-RuntimeFiles $target;return}
Assert-GargantuaRuntimePath $tools
New-Item -ItemType Directory -Force -Path $tools|Out-Null
$identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name
& (Join-Path $env:SystemRoot 'System32/icacls.exe') $tools /inheritance:r /grant:r "${identity}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F'|Out-Null
if($LASTEXITCODE -ne 0){throw 'Could not protect product runtime directory.'}
$lease=$null;$stage=$null
try{
    $lease=[IO.File]::Open((Join-Path $tools 'runtime-prepare.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    if(Test-Path -LiteralPath $target){Test-RuntimeFiles $target;return}
    foreach($source in @($PowerShellSource,$PythonSource)){Assert-GargantuaRuntimePath $source;if(-not(Test-Path -LiteralPath $source -PathType Container)){throw 'Explicit bootstrap runtime source is missing.'}}
    foreach($file in @((Join-Path $PowerShellSource 'pwsh.exe'),(Join-Path $PythonSource 'python.exe'))){if((Get-AuthenticodeSignature -LiteralPath $file).Status -ne 'Valid'){throw 'Bootstrap executable signature is not valid.'}}
    $token=[Guid]::NewGuid().ToString('N');$stage=Join-Path $tools ('.runtime-stage-'+$token);New-Item -ItemType Directory -Path $stage|Out-Null
    $entries=[Collections.Generic.List[object]]::new();$total=0L
    foreach($selection in @(@{root=$PowerShellSource;directory='powershell-7.6.5';kind='powershell'},@{root=$PythonSource;directory='python-3.12.14';kind='python'})){
        $source=[IO.Path]::GetFullPath($selection.root).TrimEnd([IO.Path]::DirectorySeparatorChar)
        $excluded=if($selection.kind -eq 'python'){@('Lib/site-packages','tcl','include','libs','Scripts')}else{@()}
        foreach($file in Get-RuntimeFiles $source -ExcludedRelativeDirectories $excluded){
            $relative=[IO.Path]::GetRelativePath($source,$file.FullName).Replace('\','/')
            if($selection.kind -eq 'python' -and ($relative -match '^Lib/site-packages/' -or $relative -match '^(tcl|include|libs|Scripts)/')){continue}
            if($file.Length -gt 128MB -or $entries.Count -ge 10000){throw 'Bootstrap file inventory exceeds its bound.'}
            $destinationRelative=$selection.directory+'/'+$relative;$destination=Join-Path $stage $destinationRelative
            [IO.Directory]::CreateDirectory((Split-Path $destination -Parent))|Out-Null
            [IO.File]::Copy($file.FullName,$destination,$false)
            $checksum=(Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
            if($checksum -ne (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()){throw 'Bootstrap copy changed while being captured.'}
            $entries.Add(@{path=$destinationRelative;bytes=$file.Length;sha256=$checksum});$total+=$file.Length
        }
    }
    # An application-local allowlist prevents registry/user/environment Python
    # paths. Host scripts use only stdlib plus the two trusted project folders.
    $pth=".`nLib`nDLLs`n..\..\..\..\inference`n..\..\..\..\scripts`n"
    $pthRelative='python-3.12.14/python312._pth';$pthPath=Join-Path $stage $pthRelative
    [IO.File]::WriteAllText($pthPath,$pth,[Text.UTF8Encoding]::new($false))
    $pthFile=Get-Item -LiteralPath $pthPath;$entries.Add(@{path=$pthRelative;bytes=$pthFile.Length;sha256=(Get-FileHash -LiteralPath $pthPath -Algorithm SHA256).Hash.ToLowerInvariant()});$total+=$pthFile.Length
    $manifest=@{schemaVersion=1;status='complete';preparedAt=[DateTimeOffset]::UtcNow.ToString('o');powershell=@{version='7.6.5';executable='powershell-7.6.5/pwsh.exe'};python=@{version='3.12.14';executable='python-3.12.14/python.exe';thirdPartyPackages=$false;isolatedPaths=$true};files=$entries.ToArray();bytes=$total;source='Explicit bootstrap sources copied once; ordinary operation uses only these product-owned files.'}
    [IO.File]::WriteAllText((Join-Path $stage 'runtime-manifest.json'),($manifest|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
    Test-RuntimeFiles $stage|Out-Null
    # Benign smoke tests only: never launch executor, Docker or production jobs.
    $ps=Join-Path $stage 'powershell-7.6.5/pwsh.exe';$py=Join-Path $stage 'python-3.12.14/python.exe'
    $psVersion= & $ps -NoProfile -NonInteractive -Command '$PSVersionTable.PSVersion.ToString()'
    if($LASTEXITCODE -ne 0 -or $psVersion.Trim() -ne '7.6.5'){throw 'Copied PowerShell version test failed.'}
    $pyVersion= & $py -E -s -B -c 'import sys,ssl,sqlite3,ctypes,hashlib,tarfile,zlib,subprocess,wave,protocol; print(".".join(map(str,sys.version_info[:3]))); assert sys.flags.isolated and not sys.flags.no_site == 0'
    if($LASTEXITCODE -ne 0 -or $pyVersion.Trim() -ne '3.12.14'){throw 'Copied Python stdlib isolation test failed.'}
    Assert-GargantuaRuntimePath $target
    [IO.Directory]::Move($stage,$target);$stage=$null
    Test-RuntimeFiles $target
}finally{
    # Failed staging is retained as evidence; it is never made executable by the
    # resolver, and no recursive delete of a computed runtime path is performed.
    if($lease){$lease.Dispose()}
}
