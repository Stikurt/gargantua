[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$CaptureDirectory,[string]$DesktopExe,[switch]$SyntheticContractSmoke)
$ErrorActionPreference='Stop'
$workspace=(Resolve-Path -LiteralPath (Split-Path $PSScriptRoot -Parent)).Path
if(-not $DesktopExe){$DesktopExe=Join-Path $workspace 'releases/Cotology-Windows/Cotology.exe'}
$desktopPath=(Resolve-Path -LiteralPath $DesktopExe).Path
if([IO.Path]::GetFileName($desktopPath) -ne 'Cotology.exe'){throw 'Only the verified release Cotology.exe entry point may run this test'}
$nodePath=(Get-Command node -ErrorAction Stop).Source
$runRoot=Join-Path $workspace ('.local/test-results/real-delivery-client-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $runRoot -Force|Out-Null
$checkData=[IO.Path]::GetFullPath((Join-Path $env:APPDATA 'Cotology-DiscoverySelfCheck'))
$expectedParent=[IO.Path]::GetFullPath($env:APPDATA)
if([IO.Path]::GetFileName($checkData) -ne 'Cotology-DiscoverySelfCheck' -or [IO.Path]::GetDirectoryName($checkData) -ne $expectedParent){throw 'Unexpected isolated reader data path'}
$fixturePath=Join-Path $workspace 'scripts/real-delivery-fixture.mjs'
$readyPath=Join-Path $runRoot 'fixture-ready.json'
$fixtureProcess=$null;$clientProcess=$null;$failure=$null;$reports=@{};$fixtureStoppedBeforeOffline=$false;$releaseProof=$null
$oldReaderOrigin=$env:COTOLOGY_DISCOVERY_FIXTURE_ORIGIN
$oldCredentials=$env:COTOLOGY_SELF_CHECK_CREDENTIALS
$oldRunAsNode=$env:ELECTRON_RUN_AS_NODE
function Get-ReaderReleaseProof {
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
  $target=[IO.Path]::GetFullPath((Join-Path $root $relative));if(-not $target.StartsWith($root+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Release path escaped its verified root'}
  $cursor=$target
  while($cursor.Length -ge $root.Length){$item=Get-Item -LiteralPath $cursor -Force;if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked release files cannot be verified'};if($cursor.Equals($root,[StringComparison]::OrdinalIgnoreCase)){break};$cursor=[IO.Path]::GetDirectoryName($cursor)}
  $file=Get-Item -LiteralPath $target -Force
  if($file.PSIsContainer -or $file.Length -ne [long]$entry.bytes -or $entry.sha256 -notmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256){throw ('Release file does not match the manifest: '+$relative)}
  $checked++
 }
 if(-not $seen.Contains('Cotology.exe') -or -not $seen.Contains('resources/app/main.cjs') -or -not $seen.Contains('resources/app/preload.cjs') -or -not $seen.Contains('resources/app/dist/index.html')){throw 'Release manifest omitted required application files'}
 $discoveryChunks=@($manifest.files|Where-Object{$_.path -match '^resources/app/dist/assets/discovery-selfcheck-[A-Za-z0-9_-]+\.js$'})
 if($discoveryChunks.Count -ne 1){throw 'Release does not include one isolated discovery renderer test; refusing to launch'}
 $discoveryCode=[IO.File]::ReadAllText((Join-Path $root $discoveryChunks[0].path))
 if(-not $discoveryCode.Contains('Local library directly exposes the server book list without losing the server copy')){throw 'Release predates the server-book visibility regression; refusing to claim the current acceptance'}
 $realChunks=@($manifest.files|Where-Object{$_.path -match '^resources/app/dist/assets/real-delivery-selfcheck-[A-Za-z0-9_-]+\.js$'})
 if($realChunks.Count -ne 1 -or -not $discoveryCode.Contains('real-delivery-selfcheck')){throw 'Release does not contain the guarded real-output acceptance probe; refusing executable launch'}
 $packagedMain=[IO.File]::ReadAllText((Join-Path $root 'resources/app/main.cjs'));$packagedPreload=[IO.File]::ReadAllText((Join-Path $root 'resources/app/preload.cjs'))
 if(-not $packagedMain.Contains("process.argv.includes('--discovery-self-check')") -or -not $packagedMain.Contains('Cotology-DiscoverySelfCheck') -or -not $packagedMain.Contains('COTOLOGY_DISCOVERY_FIXTURE_ORIGIN') -or -not $packagedPreload.Contains('selfCheckDiscovery:') -or -not $packagedPreload.Contains('--cotology-discovery-self-check')){throw 'Release does not support the isolated discovery test capability; refusing to start any executable'}
 if((Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sha){throw 'Release manifest changed during validation'}
 return @{manifestSha256=$sha;appImageId=$manifest.appImageId;applicationVersion=$manifest.applicationVersion;filesChecked=$checked;allFilesSha256Verified=$true}
}
function Wait-ReaderReport([string]$Mode,[datetime]$Started){
 $source=Join-Path $checkData ('discovery-'+$Mode+'-report.json');$deadline=[DateTime]::UtcNow.AddSeconds(14460)
 while([DateTime]::UtcNow -lt $deadline){
  if((Test-Path -LiteralPath $source) -and (Get-Item -LiteralPath $source).LastWriteTimeUtc -ge $Started){
   try{$value=Get-Content -LiteralPath $source -Raw -Encoding utf8|ConvertFrom-Json}catch{Start-Sleep -Milliseconds 100;continue}
   Copy-Item -LiteralPath $source -Destination (Join-Path $runRoot ('discovery-'+$Mode+'-report.json'))
   $clientProcess.WaitForExit(15000)|Out-Null;$clientProcess.Refresh();if(-not $clientProcess.HasExited){throw ('Reader '+$Mode+' did not safely close')}
   $closePath=Join-Path $checkData 'close-status.json'
   if(-not (Test-Path -LiteralPath $closePath) -or (Get-Item -LiteralPath $closePath).LastWriteTimeUtc -lt $Started){throw 'Fresh native close proof missing'}
   $closed=Get-Content -LiteralPath $closePath -Raw -Encoding utf8|ConvertFrom-Json
   Copy-Item -LiteralPath $closePath -Destination (Join-Path $runRoot ('discovery-'+$Mode+'-close.json'))
   $acknowledged=if($closed.PSObject.Properties.Name -contains 'rendererAcknowledged'){$closed.rendererAcknowledged}else{$closed.acknowledged}
   if(-not $acknowledged -or $closed.timedOut -or -not $closed.storageFlushed -or -not $closed.storageClosed -or -not $closed.audioClosed -or $closed.rejectedPromises -ne 0){throw ('Native close/flush acknowledgement failed: '+$Mode)}
   $screenshot=Join-Path $checkData ('discovery-'+$Mode+'-screenshot.png');if(Test-Path -LiteralPath $screenshot){Copy-Item -LiteralPath $screenshot -Destination $runRoot}
   if(-not $value.ok){throw ('Reader '+$Mode+' failed: '+$value.error+'; report '+$source)}
   return $value
  }
  $clientProcess.Refresh();if($clientProcess.HasExited){throw ('Reader '+$Mode+' exited without a fresh report; '+$checkData)}
  Start-Sleep -Milliseconds 150
 }
 throw ('Reader '+$Mode+' timed out; '+$checkData)
}
try{
 $releaseProof=Get-ReaderReleaseProof
 $captureRoot=(Resolve-Path -LiteralPath $CaptureDirectory).Path
 $captureManifest=Join-Path $captureRoot 'capture.json'
 if(-not(Test-Path -LiteralPath $captureManifest -PathType Leaf) -or (Get-Item -LiteralPath $captureManifest).Length -gt 67108864){throw 'A bounded exact-output capture manifest is required'}
 $capture=Get-Content -LiteralPath $captureManifest -Raw -Encoding utf8|ConvertFrom-Json
 $captureSha=(Get-FileHash -LiteralPath $captureManifest -Algorithm SHA256).Hash.ToLowerInvariant()
 if($capture.kind -ne 'gargantua-private-real-output-replay' -or $capture.schemaVersion -ne 1 -or ([IO.File]::ReadAllText((Join-Path $captureRoot 'capture.sha256'))).Trim() -ne ($captureSha+'  capture.json')){throw 'The exact private output capture identity is invalid'}
 if($capture.provenance -ne 'authenticated-production-api' -and -not($SyntheticContractSmoke -and $capture.provenance -eq 'synthetic-contract-fixture')){throw 'Real acceptance requires authenticated production provenance; synthetic smoke must be explicitly selected'}
 $alreadyRunning=@(Get-CimInstance Win32_Process -Filter "Name='Cotology.exe'"|Where-Object{$_.CommandLine -match '(?:^|\s)--discovery-self-check(?:\s|$)'})
 if($alreadyRunning.Count){throw 'An isolated discovery check is already active; its data will not be changed'}
 if(Test-Path -LiteralPath $checkData){
  $item=Get-Item -LiteralPath $checkData -Force;if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Self-check data is not a regular isolated directory'}
  $archive=[IO.Path]::GetFullPath((Join-Path $runRoot 'previous-selfcheck-data'));if(-not $archive.StartsWith([IO.Path]::GetFullPath($runRoot)+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetPathRoot($archive) -ne [IO.Path]::GetPathRoot($checkData)){throw 'Unsafe isolated fixture archive path'}
  Move-Item -LiteralPath $checkData -Destination $archive
 }
 $fixtureArguments=@(('"'+$fixturePath+'"'),'--capture',('"'+$captureRoot+'"'),'--ready',('"'+$readyPath+'"'));if($SyntheticContractSmoke){$fixtureArguments+='--synthetic-contract-smoke'}
 $fixtureProcess=Start-Process -FilePath $nodePath -ArgumentList $fixtureArguments -WorkingDirectory $workspace -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runRoot 'fixture.stdout') -RedirectStandardError (Join-Path $runRoot 'fixture.stderr') -PassThru
 $deadline=[DateTime]::UtcNow.AddMinutes(10);while(-not(Test-Path -LiteralPath $readyPath)){$fixtureProcess.Refresh();if($fixtureProcess.HasExited -or [DateTime]::UtcNow -ge $deadline){throw ('Exact private replay validation/start failed: '+(Join-Path $runRoot 'fixture.stderr'))};Start-Sleep -Milliseconds 200}
 $ready=Get-Content -LiteralPath $readyPath -Raw -Encoding utf8|ConvertFrom-Json
 if($ready.pid -ne $fixtureProcess.Id -or $ready.origin -notmatch '^http://127\.0\.0\.1:[1-9][0-9]{0,4}$' -or ([uri]$ready.origin).Port -eq 3080 -or $ready.captureSha256 -ne $captureSha){throw 'Unexpected owned private replay identity'}
 $env:COTOLOGY_DISCOVERY_FIXTURE_ORIGIN=$ready.origin;$env:COTOLOGY_SELF_CHECK_CREDENTIALS=$null;$env:ELECTRON_RUN_AS_NODE=$null
 $started=[DateTime]::UtcNow;$clientProcess=Start-Process -FilePath $desktopPath -ArgumentList @('--discovery-self-check') -WorkingDirectory (Split-Path $desktopPath -Parent) -WindowStyle Hidden -PassThru
 $reports.online=Wait-ReaderReport 'online' $started
 if($reports.online.captureSha256 -ne $captureSha -or $reports.online.captureProvenance -ne $capture.provenance){throw 'The client did not execute the selected exact-output acceptance probe'}
 $journal=Invoke-RestMethod -Uri ($ready.origin+'/test/status') -TimeoutSec 20
 $journal|ConvertTo-Json -Depth 12|Set-Content -LiteralPath (Join-Path $runRoot 'fixture-requests.json') -Encoding utf8
 foreach($book in $capture.books){$route='/api/books/'+$book.id+'/download';if(@($journal.requests|Where-Object{$_.method -eq 'GET' -and $_.path -eq $route}).Count -ne 1){throw ('An exact publication was not transferred once through the real UI: '+$book.id)}}
 foreach($job in $capture.jobs){
  $prefix='/api/derived/jobs/'+$job.id+'/audio/segments/'
  $ordinals=@($journal.requests|Where-Object{$_.method -eq 'GET' -and $_.path.StartsWith($prefix,[StringComparison]::Ordinal)}|ForEach-Object{[int]($_.path.Substring($prefix.Length))}|Sort-Object -Unique)
  if($ordinals.Count -ne $job.segmentCount -or $ordinals[0] -ne 0 -or $ordinals[-1] -ne $job.segmentCount-1){throw ('Not every actual narrated segment was fetched by the application: '+$job.id)}
 }
 Stop-Process -Id $fixtureProcess.Id -ErrorAction Stop;$fixtureProcess.WaitForExit(5000)|Out-Null;$fixtureProcess=$null;$fixtureStoppedBeforeOffline=$true
 $env:COTOLOGY_DISCOVERY_FIXTURE_ORIGIN=$null;$started=[DateTime]::UtcNow;$clientProcess=Start-Process -FilePath $desktopPath -ArgumentList @('--discovery-self-check','--offline') -WorkingDirectory (Split-Path $desktopPath -Parent) -WindowStyle Hidden -PassThru
 $reports.offline=Wait-ReaderReport 'offline' $started
 if($reports.offline.captureSha256 -ne $captureSha){throw 'Offline cold process used a different capture'}
 $finalReleaseProof=Get-ReaderReleaseProof;if($finalReleaseProof.manifestSha256 -ne $releaseProof.manifestSha256){throw 'Tested release changed between the two real application processes'}
 if((Get-FileHash -LiteralPath $captureManifest -Algorithm SHA256).Hash.ToLowerInvariant() -ne $captureSha){throw 'Source capture changed during application acceptance'}
}catch{$failure=$_.Exception.Message}
finally{
 $env:COTOLOGY_DISCOVERY_FIXTURE_ORIGIN=$oldReaderOrigin;$env:COTOLOGY_SELF_CHECK_CREDENTIALS=$oldCredentials;$env:ELECTRON_RUN_AS_NODE=$oldRunAsNode
 foreach($owned in @($clientProcess,$fixtureProcess)){if($null -ne $owned){$owned.Refresh();if(-not $owned.HasExited){Stop-Process -Id $owned.Id -ErrorAction SilentlyContinue}}}
 $summary=@{schemaVersion=1;ok= -not [bool]$failure;scope='REAL_WINDOWS_EXE_EXACT_CAPTURED_BYTES_REPLAY_DOWNLOAD_AND_SERVER_FREE_COLD_RESTART';captureProvenance=$capture.provenance;syntheticContractSmoke=[bool]$SyntheticContractSmoke;voiceQuality='NOT_LISTENED';newSourceSearchPerformed=$false;productionMutated=$false;actualUserDataModified=$false;sourceBookTextsIncludedInReport=$false;createdAt=[DateTimeOffset]::UtcNow.ToString('o');error=$failure;onlineChecks=$reports.online.results.Count;offlineChecks=$reports.offline.results.Count;fixtureStoppedBeforeOffline=$fixtureStoppedBeforeOffline;application=$desktopPath;release=$releaseProof;captureSha256=$captureSha;bookParts=@($capture.books).Count;chapters=($capture.groups|Measure-Object -Property chapterCount -Sum).Sum;originalChapters=($capture.groups|Measure-Object -Property originalChapterCount -Sum).Sum;translatedChapters=($capture.groups|Measure-Object -Property translatedChapterCount -Sum).Sum;audioJobs=@($capture.jobs).Count;audioSegments=($capture.jobs|Measure-Object -Property segmentCount -Sum).Sum;isolatedUserData=$checkData;sourceFingerprints=@{}}
 foreach($relative in @('scripts/test-real-delivery-client.ps1','scripts/real-delivery-fixture.mjs','scripts/real-delivery-capture.mjs','src/real-delivery-selfcheck.js','src/discovery-selfcheck.js')){$summary.sourceFingerprints[$relative]=(Get-FileHash -LiteralPath (Join-Path $workspace $relative) -Algorithm SHA256).Hash.ToLowerInvariant()}
 [IO.File]::WriteAllText((Join-Path $runRoot 'report.json'),($summary|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
}
if($failure){throw ($failure+'; run '+$runRoot)}
if($SyntheticContractSmoke){Write-Host ('Synthetic contract smoke passed; this is not real-book or narration acceptance: '+$runRoot)}else{Write-Host ('Actual private text and narration application acceptance passed: '+$runRoot)}
