# Persistent, exclusive snapshot lease. A process crash releases the OS handle;
# an unheld old GUID marker does not require manual removal.
function Open-GargantuaSnapshotLease {
    param([Parameter(Mandatory)][string]$Path,[Parameter(Mandatory)][string]$Token)
    if($Token -notmatch '^[a-f0-9]{32}$'){throw 'Invalid snapshot lease identity.'}
    Assert-GargantuaNoReparseAncestors -Path $Path
    New-Item -ItemType Directory -Force -Path (Split-Path $Path -Parent)|Out-Null
    $lease=$null
    try{
        $lease=[IO.File]::Open($Path,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
        if($lease.Length -gt 128){throw 'Snapshot lease marker needs review; it was not overwritten.'}
        $bytes=[byte[]]::new([int]$lease.Length);$null=$lease.Read($bytes,0,$bytes.Length)
        $saved=[Text.Encoding]::UTF8.GetString($bytes).Trim()
        if($saved -and $saved -notmatch '^[a-fA-F0-9]{32}$'){throw 'Snapshot lease marker needs review; it was not overwritten.'}
        $lease.SetLength(0);$lease.Position=0;$bytes=[Text.Encoding]::UTF8.GetBytes($Token);$lease.Write($bytes,0,$bytes.Length);$lease.Flush($true)
        $result=$lease;$lease=$null;return $result
    }finally{if($lease){$lease.Dispose()}}
}

function New-GargantuaSnapshotStopIntent {
    param([string]$ProjectRoot,[string]$SnapshotId,$State,[ValidateRange(1,120)][int]$TimeoutSeconds)
    if($SnapshotId -notmatch '^[a-f0-9]{32}$' -or $State.service -notin @('worker','parser') -or $State.id -notmatch '^[a-f0-9]{12,64}$' -or -not $State.exists -or -not $State.running){throw 'Invalid snapshot stop intent identity.'}
    $project=Get-GargantuaFullPath $ProjectRoot;$directory=Join-Path $project '.local/operations/stop-intents'
    Assert-GargantuaNoReparseAncestors -Path $directory
    New-Item -ItemType Directory -Path $directory -Force|Out-Null
    $path=Join-Path $directory ($SnapshotId+'-'+$State.service+'.json')
    Assert-GargantuaNoReparseAncestors -Path $path
    $intent=@{schemaVersion=1;kind='gargantua-snapshot-stop';projectRoot=$project;snapshotId=$SnapshotId;service=$State.service;containerId=$State.id;issuedAtMs=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();timeoutSeconds=$TimeoutSeconds;rpcTimeoutSeconds=$TimeoutSeconds+15;graceSeconds=5}
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($intent|ConvertTo-Json -Compress)+"`n")
    $stream=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
    return $path
}

function Remove-GargantuaSnapshotStopIntent {
    param([string]$ProjectRoot,[string]$SnapshotId,$State)
    $project=Get-GargantuaFullPath $ProjectRoot
    if($SnapshotId -notmatch '^[a-f0-9]{32}$' -or $State.service -notin @('worker','parser')){throw 'Invalid snapshot stop intent cleanup identity.'}
    $directory=Join-Path $project '.local/operations/stop-intents';$path=Join-Path $directory ($SnapshotId+'-'+$State.service+'.json')
    Assert-GargantuaNoReparseAncestors -Path $path
    if(-not (Test-Path -LiteralPath $path)){return}
    if((Get-Item -LiteralPath $path).Length -gt 8KB){throw 'Oversized snapshot stop intent; cleanup refused.'}
    $intent=Get-Content -LiteralPath $path -Raw -Encoding UTF8|ConvertFrom-Json
    if($intent.schemaVersion -ne 1 -or $intent.kind -ne 'gargantua-snapshot-stop' -or $intent.projectRoot -ne $project -or $intent.snapshotId -ne $SnapshotId -or $intent.service -ne $State.service -or $intent.containerId -ne $State.id){throw 'Snapshot stop intent ownership differs; cleanup refused.'}
    Remove-Item -LiteralPath $path -Force -ErrorAction Stop
}
