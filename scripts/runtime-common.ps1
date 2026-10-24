# Product-owned Windows runtimes. No cache/PATH fallback and no install side effects.
$script:GargantuaRuntimeProject=[IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
function Assert-GargantuaRuntimePath {
    param([Parameter(Mandatory)][string]$Path)
    $current=[IO.Path]::GetFullPath($Path)
    while($current){
        if((Test-Path -LiteralPath $current) -and (Get-Item -LiteralPath $current -Force).Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)){throw 'Runtime path contains a reparse point.'}
        $parent=[IO.Directory]::GetParent($current);if(-not $parent){break};$current=$parent.FullName
    }
}
function Get-GargantuaRuntimeManifest {
    param([string]$ProjectRoot=$script:GargantuaRuntimeProject)
    $root=Join-Path ([IO.Path]::GetFullPath($ProjectRoot)) '.local/tools/runtime';Assert-GargantuaRuntimePath $root
    $path=Join-Path $root 'runtime-manifest.json'
    Assert-GargantuaRuntimePath $path
    if(-not(Test-Path -LiteralPath $path -PathType Leaf)){throw 'Product runtime is not prepared. Run scripts/runtime-prepare.ps1 once before enabling automatic operation.'}
    if((Get-Item -LiteralPath $path).Length -gt 2MB){throw 'Product runtime manifest exceeds its bound.'}
    $manifest=Get-Content -LiteralPath $path -Raw -Encoding UTF8|ConvertFrom-Json
    if($manifest.schemaVersion -ne 1 -or $manifest.status -ne 'complete' -or $manifest.powershell.executable -ne 'powershell-7.6.5/pwsh.exe' -or $manifest.python.executable -ne 'python-3.12.14/python.exe' -or @($manifest.files).Count -gt 10000){throw 'Unsupported product runtime manifest.'}
    return [pscustomobject]@{root=$root;manifest=$manifest}
}
function Get-GargantuaRuntimeExecutable {
    param([Parameter(Mandatory)][ValidateSet('powershell','python')][string]$Kind,[string]$ProjectRoot=$script:GargantuaRuntimeProject)
    $runtime=Get-GargantuaRuntimeManifest -ProjectRoot $ProjectRoot
    $relative=$runtime.manifest.$Kind.executable;$path=Join-Path $runtime.root $relative
    Assert-GargantuaRuntimePath $path
    $entry=@($runtime.manifest.files|Where-Object path -eq $relative)
    if($entry.Count -ne 1 -or $entry[0].sha256 -notmatch '^[a-f0-9]{64}$' -or -not(Test-Path -LiteralPath $path -PathType Leaf)){throw 'Product runtime executable identity is missing.'}
    if((Get-Item -LiteralPath $path).Length -ne $entry[0].bytes -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry[0].sha256){throw 'Product runtime executable integrity check failed.'}
    return $path
}
function Get-GargantuaPowerShell {
    param([string]$ProjectRoot=$script:GargantuaRuntimeProject)
    return Get-GargantuaRuntimeExecutable -Kind powershell -ProjectRoot $ProjectRoot
}
function Get-GargantuaPythonRuntime {
    param([string]$ProjectRoot=$script:GargantuaRuntimeProject)
    return @{command=(Get-GargantuaRuntimeExecutable -Kind python -ProjectRoot $ProjectRoot);prefix=@('-E','-s','-B')}
}
function Get-GargantuaDockerExecutable {
    param([string]$ProjectRoot=$script:GargantuaRuntimeProject)
    # Docker Desktop is the independently installed host service. Do not copy it.
    $candidates=@((Join-Path $env:USERPROFILE 'AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe'),(Join-Path $env:LOCALAPPDATA 'Programs/DockerDesktop/resources/bin/docker.exe'),(Join-Path $env:ProgramFiles 'Docker/Docker/resources/bin/docker.exe'))
    foreach($path in $candidates){if(Test-Path -LiteralPath $path -PathType Leaf){Assert-GargantuaRuntimePath $path;return [IO.Path]::GetFullPath($path)}}
    throw 'Docker Desktop executable was not found in its installed location.'
}
function Get-GargantuaManagedEnvironment {
    param([string]$ProjectRoot=$script:GargantuaRuntimeProject)
    $docker=Get-GargantuaDockerExecutable -ProjectRoot $ProjectRoot
    $powershell=Get-GargantuaPowerShell -ProjectRoot $ProjectRoot
    $paths=[Collections.Generic.List[string]]::new()
    foreach($entry in @((Split-Path $docker -Parent),(Join-Path $env:SystemRoot 'System32'),$env:SystemRoot,(Join-Path $env:SystemRoot 'System32/Wbem'))+@([Environment]::GetEnvironmentVariable('Path','Machine') -split ';')){
        $expanded=[Environment]::ExpandEnvironmentVariables([string]$entry).Trim().Trim('"')
        if($expanded -match '^[A-Za-z]:[\\/]' -and $expanded -notmatch '(?i)[\\/]\.cache[\\/]codex-runtimes[\\/]|[\\/]WindowsApps(?:[\\/]|$)' -and (Test-Path -LiteralPath $expanded -PathType Container) -and $expanded -notin $paths){$paths.Add($expanded)}
    }
    return @{
        PATH=($paths -join ';');DOCKER_CONTEXT='desktop-linux';DOCKER_HOST='';DOCKER_TLS_VERIFY='';DOCKER_CERT_PATH='';
        PYTHONHOME='';PYTHONPATH='';PYTHONNOUSERSITE='1';PYTHONDONTWRITEBYTECODE='1';
        PSModulePath=(@((Join-Path (Split-Path $powershell -Parent) 'Modules'),(Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/Modules'),(Join-Path $env:ProgramFiles 'WindowsPowerShell/Modules')) -join ';');
        POWERSHELL_TELEMETRY_OPTOUT='1'
    }
}
