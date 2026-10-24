# Read-only capacity probes and a pure, injectable backup budget. No service mutation.
function Get-GargantuaBackupByteCount {
    param([AllowNull()]$Value,[string]$Name='size')
    if ($null -eq $Value -or $Value -is [bool] -or $Value -is [string] -or
        $Value -isnot [ValueType]) { throw "Backup preflight: unknown $Name." }
    try { $number=[decimal]$Value } catch { throw "Backup preflight: invalid $Name." }
    if ($number -lt 0 -or $number -gt 9007199254740991 -or [decimal]::Truncate($number) -ne $number) { throw "Backup preflight: invalid $Name." }
    return [long]$number
}

function Get-GargantuaBackupSpaceDecision {
    param([Parameter(Mandatory)]$Estimates,[Parameter(Mandatory)][object[]]$Volumes)
    $database=Get-GargantuaBackupByteCount $Estimates.databaseBytes 'database size'
    $library=Get-GargantuaBackupByteCount $Estimates.libraryBytes 'published library size'
    $source=Get-GargantuaBackupByteCount $Estimates.sourceArchiveBytes 'source archive bound'
    $images=Get-GargantuaBackupByteCount $Estimates.runtimeImageBytes 'runtime image size'
    # A physical-relation estimate is deliberately larger than expected compressed
    # pg_dump. Explicit slack also covers separately bounded source metadata
    # (256 MiB), derivative metadata (256 MiB), reader metadata (128 MiB;
    # the v2 writer budget is strictly smaller at 96 MiB), sanitized checkpoints (96 MiB),
    # core/fingerprint inventories (32 MiB each), plus staging slack. Compressed
    # physical relations alone cannot bound the separately serialized JSON text.
    $dumpBound=Get-GargantuaBackupByteCount ([decimal]$database*2+1GB) 'database staging bound'
    $imageBound=0L;if($images -gt 0){$imageBound=Get-GargantuaBackupByteCount ([decimal]$images*2+64MB) 'runtime archive bound'}
    $snapshotBound=Get-GargantuaBackupByteCount ([decimal]$library*2+$dumpBound+$source+$imageBound+256MB) 'snapshot bound'
    $roles=@{destination=$snapshotBound;workspace=64MB;docker=$dumpBound}
    $groups=@{};$seen=@{}
    foreach($volume in $Volumes){
        $role=[string]$volume.role;$id=[string]$volume.diskId
        if(-not $roles.ContainsKey($role) -or [string]::IsNullOrWhiteSpace($id)){throw 'Backup preflight: unknown storage identity.'}
        $free=Get-GargantuaBackupByteCount $volume.freeBytes 'free space'
        $key=$id.ToLowerInvariant()
        if(-not $groups.ContainsKey($key)){$groups[$key]=@{diskId=$id;freeBytes=$free;requiredBytes=2GB;roles=[Collections.Generic.List[string]]::new()}}
        $group=$groups[$key];$group.freeBytes=[Math]::Min($group.freeBytes,$free)
        # Several VHDX files on one volume share one staging budget and reserve.
        if(-not $group.roles.Contains($role)){$group.requiredBytes=Get-GargantuaBackupByteCount ([decimal]$group.requiredBytes+$roles[$role]) 'volume budget';$group.roles.Add($role)}
        $seen[$role]=$true
    }
    foreach($role in $roles.Keys){if(-not $seen.ContainsKey($role)){throw "Backup preflight: missing $role storage metric."}}
    $result=@($groups.Values|ForEach-Object{[pscustomobject]@{diskId=$_.diskId;freeBytes=$_.freeBytes;requiredBytes=$_.requiredBytes;roles=$_.roles.ToArray();sufficient=($_.freeBytes -ge $_.requiredBytes)}})
    if(@($result|Where-Object{-not $_.sufficient}).Count){throw 'Backup preflight: insufficient free space; no handlers were stopped.'}
    return [pscustomobject]@{version=1;checkedAt=[DateTimeOffset]::UtcNow.ToString('o');reserveBytesPerVolume=2GB;databaseStagingBoundBytes=$dumpBound;snapshotBoundBytes=$snapshotBound;volumes=$result;readerJournal=$Estimates.readerJournal}
}

function Get-GargantuaBackupVolume {
    param([Parameter(Mandatory)][string]$Path,[Parameter(Mandatory)][string]$Role)
    $current=Get-GargantuaFullPath $Path
    Assert-GargantuaNoReparseAncestors -Path $current
    while(-not (Test-Path -LiteralPath $current -ErrorAction Stop)){
        $parent=[IO.Directory]::GetParent($current);if(-not $parent){throw 'Backup preflight: storage ancestor unavailable.'};$current=$parent.FullName
    }
    if(Get-Command Get-Volume -ErrorAction SilentlyContinue){
        try{
            $volumes=@(Get-Volume -FilePath $current -ErrorAction Stop)
            if($volumes.Count -eq 1 -and $volumes[0].UniqueId -and $volumes[0].DriveType -eq 'Fixed'){
                $free=Get-GargantuaBackupByteCount $volumes[0].SizeRemaining 'volume free space'
                return [pscustomobject]@{role=$Role;diskId=[string]$volumes[0].UniqueId;freeBytes=$free}
            }
        }catch{throw 'Backup preflight: volume free space or identity is unavailable.'}
        throw 'Backup preflight: volume free space or identity is unavailable.'
    }
    $drive=[IO.DriveInfo]::new([IO.Path]::GetPathRoot($current))
    if(-not $drive.IsReady -or $drive.DriveType -ne [IO.DriveType]::Fixed){throw 'Backup preflight: storage is not an available fixed local volume.'}
    return [pscustomobject]@{role=$Role;diskId=$drive.Name.ToLowerInvariant();freeBytes=(Get-GargantuaBackupByteCount $drive.AvailableFreeSpace 'drive free space')}
}

function Get-GargantuaBackupEstimates {
    param([Parameter(Mandatory)]$Database,[Parameter(Mandatory)]$App,[object[]]$Handlers,[switch]$IncludeRuntimeImages)
    if(-not $App.exists -or -not $App.running -or $App.paused){throw 'Backup preflight: a running unpaused app is required for a read-only library size probe.'}
    $readerSql=Invoke-GargantuaPython -Operation 'prepare read-only exact reader journal preflight' -Arguments @('reader-preflight-sql')
    $readerRaw=Invoke-GargantuaDocker -Operation 'verify exact reader journal budget before snapshot' -Arguments @('exec','-i',$Database.id,'psql','-X','-qAt','-U','cotology_app','-d','library','-v','ON_ERROR_STOP=1') -InputText $readerSql -TimeoutSeconds 60
    try{$readerJournal=$readerRaw|ConvertFrom-Json -ErrorAction Stop}catch{throw 'Backup preflight: invalid reader journal probe.'}
    if($readerJournal.supported -isnot [bool]){throw 'Backup preflight: unknown reader journal support.'}
    if($readerJournal.supported){
        $readerRows=Get-GargantuaBackupByteCount $readerJournal.rows 'reader journal rows'
        $readerBytes=Get-GargantuaBackupByteCount $readerJournal.bytes 'reader journal bytes'
        if($readerJournal.maxRows -ne 250000 -or $readerJournal.maxBytes -ne 96MB -or $readerRows -gt 250000 -or $readerBytes -gt 96MB){throw 'Backup preflight: reader journal exceeds its writer budget.'}
    }
    $query="SELECT COALESCE(sum(pg_total_relation_size(c.oid)),0)::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','m');"
    $raw=Invoke-GargantuaDocker -Operation 'estimate database physical relations read-only' -Arguments @('exec',$Database.id,'psql','-X','-qAt','-U','cotology_app','-d','library','-v','ON_ERROR_STOP=1','-c',$query)
    if($raw.Trim() -notmatch '^\d{1,16}$'){throw 'Backup preflight: unknown database size.'}
    $databaseBytes=Get-GargantuaBackupByteCount ([decimal]$raw.Trim()) 'database size'
    $code=@'
const fs=require('node:fs'),p=require('node:path');
let bytes=0,files=0,entries=0;
function walk(dir,depth){if(depth>32)throw Error('depth');const s=fs.lstatSync(dir);if(!s.isDirectory()||s.isSymbolicLink())throw Error('directory');for(const name of fs.readdirSync(dir)){if(++entries>200000)throw Error('entry limit');const file=p.join(dir,name),st=fs.lstatSync(file);if(st.isSymbolicLink())throw Error('link');if(st.isDirectory())walk(file,depth+1);else{if(!st.isFile()||!Number.isSafeInteger(st.size)||st.size<0)throw Error('file');bytes+=st.size;if(!Number.isSafeInteger(bytes))throw Error('size');files++;}}}
walk('/library/books',0);if(fs.existsSync('/library/derived'))walk('/library/derived',0);process.stdout.write(JSON.stringify({bytes,files}));
'@
    $library=Invoke-GargantuaDocker -Operation 'estimate published regular files read-only' -Arguments @('exec',$App.id,'node','-e',$code)|ConvertFrom-Json
    $libraryBytes=Get-GargantuaBackupByteCount $library.bytes 'library size'
    $source=Invoke-GargantuaPython -Operation 'estimate bounded selected source files read-only' -Arguments @('source-estimate','--project',$script:GargantuaProjectRoot)|ConvertFrom-Json
    $sourceBytes=Get-GargantuaBackupByteCount $source.archiveBoundBytes 'source archive bound'
    $images=0L
    if($IncludeRuntimeImages){
        $ids=[Collections.Generic.List[string]]::new()
        foreach($state in @($Database,$App)+@($Handlers)){
            if($state.exists){$image=(Invoke-GargantuaDocker -Operation 'resolve image for capacity estimate' -Arguments @('inspect','--format','{{.Image}}',$state.id)).Trim();if($image -notmatch '^sha256:[a-f0-9]{64}$'){throw 'Backup preflight: invalid image identity.'};$ids.Add($image)}
        }
        foreach($image in @($ids.ToArray()|Sort-Object -Unique)){
            $size=(Invoke-GargantuaDocker -Operation 'estimate captured runtime image read-only' -Arguments @('image','inspect','--format','{{.Size}}',$image)).Trim()
            if($size -notmatch '^\d{1,16}$'){throw 'Backup preflight: unknown runtime image size.'}
            $images=Get-GargantuaBackupByteCount ([decimal]$images+[decimal]$size) 'runtime image total'
        }
    }
    return [pscustomobject]@{databaseBytes=$databaseBytes;libraryBytes=$libraryBytes;sourceArchiveBytes=$sourceBytes;runtimeImageBytes=$images;readerJournal=$readerJournal}
}
