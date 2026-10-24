[CmdletBinding()]
param([string]$DesktopExe,[switch]$Narrow)
$ErrorActionPreference='Stop'
$workspace=(Resolve-Path -LiteralPath (Split-Path $PSScriptRoot -Parent)).Path
if(-not $DesktopExe){$DesktopExe=Join-Path $workspace 'releases/Cotology-Windows/Cotology.exe'}
$desktopPath=(Resolve-Path -LiteralPath $DesktopExe).Path
if([IO.Path]::GetFileName($desktopPath) -ne 'Cotology.exe'){throw 'Only the manifested Cotology.exe entry point may run this test'}
$nodePath=(Get-Command node -ErrorAction Stop).Source
$runRoot=Join-Path $workspace ('.local/test-results/book-card-client-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $runRoot -Force|Out-Null
$checkData=[IO.Path]::GetFullPath((Join-Path $env:APPDATA 'Cotology-DiscoverySelfCheck'))
if([IO.Path]::GetFileName($checkData) -ne 'Cotology-DiscoverySelfCheck' -or [IO.Path]::GetDirectoryName($checkData) -ne [IO.Path]::GetFullPath($env:APPDATA)){throw 'Unexpected isolated test data path'}
$fixturePath=Join-Path $workspace 'scripts/book-card-client-fixture.mjs';$readyPath=Join-Path $runRoot 'fixture-ready.json'
$fixtureProcess=$null;$clientProcess=$null;$failure=$null;$reports=@{};$fixtureStoppedBeforeOffline=$false;$releaseProof=$null;$ready=$null;$journal=$null
$oldOrigin=$env:COTOLOGY_DISCOVERY_FIXTURE_ORIGIN;$oldCredentials=$env:COTOLOGY_SELF_CHECK_CREDENTIALS;$oldRunAsNode=$env:ELECTRON_RUN_AS_NODE
function Get-BookCardReleaseProof {
 $root=[IO.Path]::GetFullPath((Split-Path $desktopPath -Parent));$manifestPath=Join-Path $root 'release-manifest.json';$checksumPath=Join-Path $root 'release-manifest.sha256'
 if(-not(Test-Path -LiteralPath $manifestPath -PathType Leaf) -or -not(Test-Path -LiteralPath $checksumPath -PathType Leaf) -or (Get-Item -LiteralPath $manifestPath).Length -gt 1048576){throw 'A complete bounded release manifest is required'}
 $sha=(Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant();$expected=([IO.File]::ReadAllText($checksumPath)).Trim()
 if($expected -notmatch '^([a-f0-9]{64})\s+release-manifest\.json$' -or $Matches[1] -ne $sha){throw 'Release manifest checksum mismatch'}
 $manifest=Get-Content -LiteralPath $manifestPath -Raw -Encoding utf8|ConvertFrom-Json
 if($manifest.schemaVersion -ne 1 -or $manifest.kind -ne 'gargantua-desktop-release' -or $manifest.status -ne 'complete' -or $manifest.appImageId -notmatch '^sha256:[a-f0-9]{64}$' -or @($manifest.files).Count -gt 2000 -or @($manifest.files).Count -lt 10){throw 'Unexpected release manifest identity'}
 $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase);$checked=0
 foreach($entry in $manifest.files){
  $relative=[string]$entry.path
  if(-not $relative -or [IO.Path]::IsPathRooted($relative) -or $relative.Contains('\') -or $relative.Contains(':') -or ($relative.Split('/')|Where-Object{$_ -in @('','.','..') -or $_.EndsWith('.') -or $_.EndsWith(' ')}) -or -not $seen.Add($relative)){throw 'Unsafe or duplicate release file path'}
  $target=[IO.Path]::GetFullPath((Join-Path $root $relative));if(-not $target.StartsWith($root+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Release path escaped the verified root'}
  $cursor=$target;while($cursor.Length -ge $root.Length){$item=Get-Item -LiteralPath $cursor -Force;if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked release files cannot be verified'};if($cursor.Equals($root,[StringComparison]::OrdinalIgnoreCase)){break};$cursor=[IO.Path]::GetDirectoryName($cursor)}
  $file=Get-Item -LiteralPath $target -Force
  if($file.PSIsContainer -or $file.Length -ne [long]$entry.bytes -or $entry.sha256 -notmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256){throw ('Release content mismatch: '+$relative)}
  $checked++
 }
 foreach($required in @('Cotology.exe','resources/app/main.cjs','resources/app/preload.cjs','resources/app/dist/index.html')){if(-not $seen.Contains($required)){throw ('Release manifest omitted required file: '+$required)}}
 $cardChunks=@($manifest.files|Where-Object{$_.path -match '^resources/app/dist/assets/book-card-selfcheck-[A-Za-z0-9_-]+\.js$'});$discoveryChunks=@($manifest.files|Where-Object{$_.path -match '^resources/app/dist/assets/discovery-selfcheck-[A-Za-z0-9_-]+\.js$'})
 if($cardChunks.Count -ne 1 -or $discoveryChunks.Count -ne 1){throw 'Release lacks one guarded unified-card acceptance chunk'}
 $cardCode=[IO.File]::ReadAllText((Join-Path $root $cardChunks[0].path));$dispatchCode=[IO.File]::ReadAllText((Join-Path $root $discoveryChunks[0].path))
 if(-not $cardCode.Contains('gargantua-book-card-selfcheck') -or -not $cardCode.Contains('Four primary sections replace duplicated server and audio navigation') -or -not $dispatchCode.Contains('book-card-selfcheck')){throw 'Release predates the unified book card acceptance contract'}
 $main=[IO.File]::ReadAllText((Join-Path $root 'resources/app/main.cjs'));$preload=[IO.File]::ReadAllText((Join-Path $root 'resources/app/preload.cjs'))
 if(-not $main.Contains("process.argv.includes('--discovery-self-check')") -or -not $main.Contains('Cotology-DiscoverySelfCheck') -or -not $main.Contains('COTOLOGY_DISCOVERY_FIXTURE_ORIGIN') -or -not $preload.Contains('selfCheckDiscovery:') -or -not $preload.Contains('--cotology-discovery-self-check')){throw 'Release lacks the established isolated discovery capability'}
 if($Narrow -and -not $main.Contains('--self-check-narrow')){throw 'Release does not support a guarded narrow native test window'}
 if((Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sha){throw 'Release manifest changed during validation'}
 return @{manifestSha256=$sha;appImageId=$manifest.appImageId;applicationVersion=$manifest.applicationVersion;filesChecked=$checked;allFilesSha256Verified=$true}
}
function Wait-BookCardReport([string]$Mode,[datetime]$Started){
 $source=Join-Path $checkData ('discovery-'+$Mode+'-report.json');$deadline=[DateTime]::UtcNow.AddSeconds(300)
 while([DateTime]::UtcNow -lt $deadline){
  if((Test-Path -LiteralPath $source) -and (Get-Item -LiteralPath $source).LastWriteTimeUtc -ge $Started){
   try{$value=Get-Content -LiteralPath $source -Raw -Encoding utf8|ConvertFrom-Json}catch{Start-Sleep -Milliseconds 100;continue}
   Copy-Item -LiteralPath $source -Destination (Join-Path $runRoot ('discovery-'+$Mode+'-report.json'))
   $clientProcess.WaitForExit(15000)|Out-Null;$clientProcess.Refresh();if(-not $clientProcess.HasExited){throw ('Book card '+$Mode+' did not safely close')}
   $closePath=Join-Path $checkData 'close-status.json';if(-not(Test-Path -LiteralPath $closePath) -or (Get-Item -LiteralPath $closePath).LastWriteTimeUtc -lt $Started){throw 'Fresh native close proof is missing'}
   $closed=Get-Content -LiteralPath $closePath -Raw -Encoding utf8|ConvertFrom-Json;Copy-Item -LiteralPath $closePath -Destination (Join-Path $runRoot ('discovery-'+$Mode+'-close.json'))
   $acknowledged=if($closed.PSObject.Properties.Name -contains 'rendererAcknowledged'){$closed.rendererAcknowledged}else{$closed.acknowledged}
   if(-not $acknowledged -or $closed.timedOut -or -not $closed.storageFlushed -or -not $closed.storageClosed -or -not $closed.audioClosed -or $closed.rejectedPromises -ne 0){throw ('Native close or storage flush failed: '+$Mode)}
   $screenshot=Join-Path $checkData ('discovery-'+$Mode+'-screenshot.png');if(Test-Path -LiteralPath $screenshot){Copy-Item -LiteralPath $screenshot -Destination $runRoot}
   if($value.kind -ne 'gargantua-book-card-selfcheck' -or [bool]$value.narrowDesktopWindow -ne [bool]$Narrow){throw 'The executable ran a different acceptance probe or viewport'}
   if(-not $value.ok){throw ('Book card '+$Mode+' failed: '+$value.error+'; report '+$source)}
   return $value
  }
  $clientProcess.Refresh();if($clientProcess.HasExited){throw ('Book card '+$Mode+' exited without a fresh report')};Start-Sleep -Milliseconds 150
 }
 throw ('Book card '+$Mode+' timed out')
}
try{
 $releaseProof=Get-BookCardReleaseProof
 if(@(Get-CimInstance Win32_Process -Filter "Name='Cotology.exe'"|Where-Object{$_.CommandLine -match '(?:^|\s)--discovery-self-check(?:\s|$)'}).Count){throw 'Another isolated discovery check is active; its data will not be moved'}
 if(Test-Path -LiteralPath $checkData){
  $item=Get-Item -LiteralPath $checkData -Force;if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Isolated data directory is not a regular owned directory'}
  $archive=[IO.Path]::GetFullPath((Join-Path $runRoot 'previous-selfcheck-data'));if(-not $archive.StartsWith([IO.Path]::GetFullPath($runRoot)+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetPathRoot($archive) -ne [IO.Path]::GetPathRoot($checkData)){throw 'Unsafe isolated archive target'}
  Move-Item -LiteralPath $checkData -Destination $archive
 }
 $fixtureProcess=Start-Process -FilePath $nodePath -ArgumentList @(('"'+$fixturePath+'"'),'--ready',('"'+$readyPath+'"')) -WorkingDirectory $workspace -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runRoot 'fixture.stdout') -RedirectStandardError (Join-Path $runRoot 'fixture.stderr') -PassThru
 $deadline=[DateTime]::UtcNow.AddSeconds(20);while(-not(Test-Path -LiteralPath $readyPath)){$fixtureProcess.Refresh();if($fixtureProcess.HasExited -or [DateTime]::UtcNow -ge $deadline){throw ('Book card fixture failed: '+(Join-Path $runRoot 'fixture.stderr'))};Start-Sleep -Milliseconds 100}
 $ready=Get-Content -LiteralPath $readyPath -Raw -Encoding utf8|ConvertFrom-Json
 if($ready.pid -ne $fixtureProcess.Id -or $ready.origin -notmatch '^http://127\.0\.0\.1:[1-9][0-9]{0,4}$' -or ([uri]$ready.origin).Port -eq 3080 -or $ready.kind -ne 'gargantua-book-card-selfcheck'){throw 'Unexpected owned loopback fixture identity'}
 $env:COTOLOGY_DISCOVERY_FIXTURE_ORIGIN=$ready.origin;$env:COTOLOGY_SELF_CHECK_CREDENTIALS=$null;$env:ELECTRON_RUN_AS_NODE=$null
 $arguments=@('--discovery-self-check');if($Narrow){$arguments+='--self-check-narrow'}
 $started=[DateTime]::UtcNow;$clientProcess=Start-Process -FilePath $desktopPath -ArgumentList $arguments -WorkingDirectory (Split-Path $desktopPath -Parent) -WindowStyle Hidden -PassThru;$reports.online=Wait-BookCardReport 'online' $started
 $journal=Invoke-RestMethod -Uri ($ready.origin+'/test/status') -TimeoutSec 10;$journal|ConvertTo-Json -Depth 10|Set-Content -LiteralPath (Join-Path $runRoot 'fixture-requests.json') -Encoding utf8
 if($journal.unexpectedGeneration -ne 0){throw 'A card action attempted to start acquisition, translation or TTS'}
 $downloaded=@($ready.groups|Where-Object{$_.id -in @($ready.completeId,$ready.missingId)}|ForEach-Object{$_.publicationIds})+@($ready.ordinaryId)
 foreach($id in $downloaded){if($journal.downloads.$id -ne 1){throw ('Expected exactly one explicit text transfer: '+$id)}}
 $ordinals=@($journal.requests|Where-Object{$_.path -match ('^/api/derived/jobs/'+$ready.audioJobId+'/audio/segments/([0-9]+)$')}|ForEach-Object{[int]($_.path.Split('/')[-1])}|Sort-Object -Unique);if($ordinals.Count -ne 2 -or $ordinals[0] -ne 0 -or $ordinals[1] -ne 1){throw 'Both synthetic audio segments were not transferred'}
 Stop-Process -Id $fixtureProcess.Id -ErrorAction Stop;$fixtureProcess.WaitForExit(5000)|Out-Null;$fixtureProcess=$null;$fixtureStoppedBeforeOffline=$true
 $env:COTOLOGY_DISCOVERY_FIXTURE_ORIGIN=$null;$arguments+= '--offline';$started=[DateTime]::UtcNow;$clientProcess=Start-Process -FilePath $desktopPath -ArgumentList $arguments -WorkingDirectory (Split-Path $desktopPath -Parent) -WindowStyle Hidden -PassThru;$reports.offline=Wait-BookCardReport 'offline' $started
 $finalRelease=Get-BookCardReleaseProof;if($finalRelease.manifestSha256 -ne $releaseProof.manifestSha256){throw 'Release changed between the online and offline native processes'}
}catch{$failure=$_.Exception.Message}
finally{
 $env:COTOLOGY_DISCOVERY_FIXTURE_ORIGIN=$oldOrigin;$env:COTOLOGY_SELF_CHECK_CREDENTIALS=$oldCredentials;$env:ELECTRON_RUN_AS_NODE=$oldRunAsNode
 foreach($owned in @($clientProcess,$fixtureProcess)){if($null -ne $owned){$owned.Refresh();if(-not $owned.HasExited){Stop-Process -Id $owned.Id -ErrorAction SilentlyContinue}}}
 $summary=@{schemaVersion=1;ok= -not [bool]$failure;scope='REAL_WINDOWS_EXE_UNIFIED_BOOK_CARD_GENERIC_SERIAL_GROUPS_SEPARATE_TEXT_AUDIO_COLD_OFFLINE';syntheticFixture=$true;freshTtsGenerated=$false;productionDataUsed=$false;actualUserDataModified=$false;androidTested=$false;narrowDesktopWindow=[bool]$Narrow;createdAt=[DateTimeOffset]::UtcNow.ToString('o');error=$failure;onlineChecks=@($reports.online.results).Count;offlineChecks=@($reports.offline.results).Count;fixtureStoppedBeforeOffline=$fixtureStoppedBeforeOffline;application=$desktopPath;release=$releaseProof;isolatedUserData=$checkData;sourceFingerprints=@{}}
 foreach($relative in @('scripts/test-book-card-client.ps1','scripts/book-card-client-fixture.mjs','src/book-card-selfcheck.js','src/discovery-selfcheck.js','src/LibraryApp.jsx','src/BookCard.jsx','src/AudioShelf.jsx','src/library.css','desktop/main.cjs','desktop/preload.cjs')){if(Test-Path -LiteralPath (Join-Path $workspace $relative)){$summary.sourceFingerprints[$relative]=(Get-FileHash -LiteralPath (Join-Path $workspace $relative) -Algorithm SHA256).Hash.ToLowerInvariant()}}
 [IO.File]::WriteAllText((Join-Path $runRoot 'report.json'),($summary|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
}
if($failure){throw ($failure+'; run '+$runRoot)}
Write-Host ('Unified book card native checks passed: '+$runRoot)
