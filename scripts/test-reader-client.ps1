[CmdletBinding()]
param([string]$DesktopExe)
$ErrorActionPreference='Stop'
$workspace=(Resolve-Path -LiteralPath (Split-Path $PSScriptRoot -Parent)).Path
if(-not $DesktopExe){$DesktopExe=Join-Path $workspace 'releases/Cotology-Windows/Cotology.exe'}
$desktopPath=(Resolve-Path -LiteralPath $DesktopExe).Path
$nodePath=(Get-Command node -ErrorAction Stop).Source
$runRoot=Join-Path $workspace ('.local/test-results/reader-client-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $runRoot -Force|Out-Null
$checkData=[IO.Path]::GetFullPath((Join-Path $env:APPDATA 'Cotology-ReaderSelfCheck'))
$expectedParent=[IO.Path]::GetFullPath($env:APPDATA)
if([IO.Path]::GetFileName($checkData) -ne 'Cotology-ReaderSelfCheck' -or [IO.Path]::GetDirectoryName($checkData) -ne $expectedParent){throw 'Unexpected isolated reader data path'}
$fixturePath=Join-Path $runRoot 'fixture.mjs'
$readyPath=Join-Path $runRoot 'fixture-ready.json'
$fixtureProcess=$null;$clientProcess=$null;$failure=$null;$reports=@{};$fixtureStoppedBeforeOffline=$false;$releaseProof=$null
$oldReaderOrigin=$env:COTOLOGY_READER_FIXTURE_ORIGIN
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
 if((Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sha){throw 'Release manifest changed during validation'}
 return @{manifestSha256=$sha;appImageId=$manifest.appImageId;applicationVersion=$manifest.applicationVersion;filesChecked=$checked;allFilesSha256Verified=$true}
}
function Wait-ReaderReport([string]$Mode,[datetime]$Started){
 $source=Join-Path $checkData ('reader-'+$Mode+'-report.json');$deadline=[DateTime]::UtcNow.AddSeconds(175)
 while([DateTime]::UtcNow -lt $deadline){
  if((Test-Path -LiteralPath $source) -and (Get-Item -LiteralPath $source).LastWriteTimeUtc -ge $Started){
   try{$value=Get-Content -LiteralPath $source -Raw -Encoding utf8|ConvertFrom-Json}catch{Start-Sleep -Milliseconds 100;continue}
   Copy-Item -LiteralPath $source -Destination (Join-Path $runRoot ('reader-'+$Mode+'-report.json'))
   $clientProcess.WaitForExit(15000)|Out-Null;$clientProcess.Refresh();if(-not $clientProcess.HasExited){throw ('Reader '+$Mode+' did not safely close')}
   $closePath=Join-Path $checkData 'close-status.json'
   if(-not (Test-Path -LiteralPath $closePath) -or (Get-Item -LiteralPath $closePath).LastWriteTimeUtc -lt $Started){throw 'Fresh native close proof missing'}
   $closed=Get-Content -LiteralPath $closePath -Raw -Encoding utf8|ConvertFrom-Json
   Copy-Item -LiteralPath $closePath -Destination (Join-Path $runRoot ('reader-'+$Mode+'-close.json'))
   $acknowledged=if($closed.PSObject.Properties.Name -contains 'rendererAcknowledged'){$closed.rendererAcknowledged}else{$closed.acknowledged}
   if(-not $acknowledged -or $closed.timedOut -or -not $closed.storageFlushed -or -not $closed.storageClosed -or -not $closed.audioClosed -or $closed.rejectedPromises -ne 0){throw ('Native close/flush acknowledgement failed: '+$Mode)}
   if($Mode -eq 'online' -and $value.pendingCloseEdit){$closedTime=if($closed.at -is [DateTime]){[DateTimeOffset]::new($closed.at.ToUniversalTime())}else{[DateTimeOffset]::Parse([string]$closed.at,[Globalization.CultureInfo]::InvariantCulture)};$closedAt=$closedTime.ToUnixTimeMilliseconds();if($closedAt-[long]$value.pendingCloseEdit.at -ge 600){throw 'Close proof was too slow to distinguish the handshake from normal debounce; rerun required'}}
   $screenshot=Join-Path $checkData ('reader-'+$Mode+'-screenshot.png');if(Test-Path -LiteralPath $screenshot){Copy-Item -LiteralPath $screenshot -Destination $runRoot}
   if(-not $value.ok){throw ('Reader '+$Mode+' failed: '+$value.error+'; report '+$source)}
   return $value
  }
  $clientProcess.Refresh();if($clientProcess.HasExited){throw ('Reader '+$Mode+' exited without a fresh report; '+$checkData)}
  Start-Sleep -Milliseconds 150
 }
 throw ('Reader '+$Mode+' timed out; '+$checkData)
}
$fixture=@'
import http from 'node:http';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
const ready=process.argv[process.argv.indexOf('--ready')+1];
const PROFILE='c2000000-0000-4000-8000-000000000002',BOOK='c2000000-0000-4000-8000-000000000001';
const content={title:'Серверная автономная история',author:'Синтетический автор',language:'ru',chapters:[{title:'Без сервера',blocks:[{type:'text',text:'Серверный текст доступен без сети. Это отдельная синтетическая книга для проверки скачивания.'},{type:'text',text:'Оригинальная библиотека пользователя не участвует в проверке.'}]}],assets:{}};
const raw=Buffer.from(JSON.stringify(content)),hash=createHash('sha256').update(raw).digest('hex');
const book={id:BOOK,title:content.title,author:content.author,language:'ru',chapter_count:1,content_sha256:hash,content_bytes:raw.length,sha256:hash,security_state:'passed',shelf:'planned',created_at:'2026-10-23T00:00:00.000Z'};
const serialId=n=>'c3000000-0000-4000-8000-'+String(n).padStart(12,'0'),serialTitle='Объединённая синтетическая новелла';
const serialParts=Array.from({length:6},(_,partIndex)=>{
 const chapterOffset=partIndex*50,chapterCount=partIndex===5?25:50,id=serialId(partIndex+1),title=serialTitle+` · главы ${chapterOffset+1}–${chapterOffset+chapterCount}`;
 const content={title,author:'Синтетический автор',language:'ru',chapters:Array.from({length:chapterCount},(_,index)=>({title:'Глава '+(chapterOffset+index+1),blocks:Array.from({length:24},(_,block)=>({type:'text',text:`[SERIAL_CHAPTER_${chapterOffset+index+1}] Абзац ${block+1}. `+'Отдельная проверенная часть общей книги сохраняет свою позицию и закладки. '.repeat(5)}))})),assets:{}};
 const raw=Buffer.from(JSON.stringify(content)),sha=createHash('sha256').update(raw).digest('hex');
 return {content,raw,book:{id,title,author:content.author,language:'ru',chapter_count:chapterCount,content_sha256:sha,content_bytes:raw.length,package_sha256:sha,sha256:sha,security_state:'passed',serial_feed_id:serialId(990),shelf:'planned',created_at:'2026-10-23T00:00:00.000Z'},part:{publicationId:id,chapterOffset,chapterCount,contentSha256:sha,packageSha256:sha,securityState:'passed'}};
});
const serialGroup={schemaVersion:1,id:serialId(990),snapshotId:serialId(991),provider:'ranobelib',title:serialTitle,author:'Синтетический автор',language:'ru',branch:'synthetic-275',snapshotStatus:'ready',inventorySha256:createHash('sha256').update('synthetic-275-chapters-not-production').digest('hex'),totalChapters:275,parts:serialParts.map(row=>row.part)};
const requests=[],entities=new Map(),devices=new Map(),receipts=new Map(),changes=[];let revision=0;
const cursor=()=>Buffer.from(JSON.stringify({schemaVersion:1,profileId:PROFILE,revision})).toString('base64url');
const json=(response,status,value)=>{response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(JSON.stringify(value));};
function mutationId(m){const bytes=createHash('sha256').update(`gargantua-reader-v2\0${PROFILE}\0${m.deviceId}\0${m.counter}`).digest().subarray(0,16);bytes[6]=(bytes[6]&15)|128;bytes[8]=(bytes[8]&63)|128;const h=bytes.toString('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;}
const server=http.createServer(async(request,response)=>{
 try{
  const url=new URL(request.url,'http://127.0.0.1');if(requests.length<1000)requests.push({method:request.method,path:url.pathname,at:new Date().toISOString()});
  if(url.pathname==='/test/status')return json(response,200,{requests,revision,books:7,profile:PROFILE,rawSha256:hash,serialGroup});
  if(url.pathname==='/api/fixture/integrity'){const bytes=Buffer.from('{"fixture":"headers"}');response.writeHead(200,{'Content-Type':'application/json','X-Content-SHA256':createHash('sha256').update(bytes).digest('hex'),'ETag':'"synthetic-raw-bytes"'});return response.end(bytes);}
  if(url.pathname==='/api/fixture/oversize'){response.writeHead(200,{'Content-Type':'application/octet-stream'});const block=Buffer.alloc(1024*1024,32);for(let i=0;i<33&&!response.destroyed;i++)if(!response.write(block))await new Promise(resolve=>{const done=()=>{response.removeListener('drain',done);response.removeListener('close',done);resolve();};response.once('drain',done);response.once('close',done);});return response.end();}
  if(url.pathname==='/api/me')return json(response,200,{id:PROFILE,login:'isolated-reader-fixture',role:'owner',csrf:'reader-fixture-csrf'});
  if(url.pathname==='/api/books')return json(response,200,[book,...serialParts.map(row=>row.book)]);
  if(url.pathname==='/api/library/serial-groups')return json(response,200,{schemaVersion:1,groups:[serialGroup]});
  const serial=serialParts.find(row=>url.pathname===`/api/books/${row.book.id}`||url.pathname.startsWith(`/api/books/${row.book.id}/`));
  if(serial){
   if(url.pathname===`/api/books/${serial.book.id}/download`){response.writeHead(200,{'Content-Type':'application/json','Content-Length':serial.raw.length,'X-Content-SHA256':serial.book.content_sha256});return response.end(serial.raw);}
   if(url.pathname===`/api/books/${serial.book.id}`)return json(response,200,{book:serial.book,chapters:serial.content.chapters.map((chapter,index)=>({title:chapter.title,index})),reading:null,bookmarks:[]});
   const match=url.pathname.match(/\/chapters\/([0-9]+)$/);if(match){const chapter=serial.content.chapters[Number(match[1])];return json(response,chapter?200:404,chapter||{error:'Synthetic chapter does not exist'});}
  }
  if(url.pathname===`/api/books/${BOOK}/download`){response.writeHead(200,{'Content-Type':'application/json','Content-Length':raw.length,'X-Content-SHA256':hash});return response.end(raw);}
  if(url.pathname===`/api/books/${BOOK}`)return json(response,200,{book,chapters:content.chapters.map((c,index)=>({title:c.title,index})),reading:null,bookmarks:[]});
  if(url.pathname.startsWith(`/api/books/${BOOK}/chapters/`))return json(response,200,content.chapters[Number(url.pathname.split('/').at(-1))]);
  if(url.pathname==='/api/status')return json(response,200,{version:'isolated-reader-fixture',statuses:[{name:'scanner',value:{ready:true,version:'synthetic-no-antivirus-claim'}}],settings:{imports_paused:false,serving_paused:false}});
  if(url.pathname==='/api/catalogs')return json(response,200,{revision:0,catalogs:[]});
  if(url.pathname==='/api/imports')return json(response,200,[]);
  if(url.pathname==='/api/logout')return json(response,200,{ok:true});
  if(url.pathname==='/api/v2/reader/snapshot')return json(response,200,{schemaVersion:1,cursor:cursor(),entities:[...entities.values()],devices:[...devices].map(([deviceId,lastCounter])=>({deviceId,lastCounter,protocolVersion:2,compactedThrough:0,compactedCount:0}))});
  if(url.pathname==='/api/v2/reader/changes')return json(response,200,{schemaVersion:1,cursor:cursor(),changes,hasMore:false});
  if(url.pathname==='/api/v2/reader/conflicts')return json(response,200,{conflicts:[],cursor:null,hasMore:false});
  if(url.pathname==='/api/v2/reader/mutations'&&request.method==='POST'){
   const chunks=[];let size=0;for await(const chunk of request){size+=chunk.length;if(size>256000)return json(response,413,{error:'fixture request bound'});chunks.push(chunk);}const input=JSON.parse(Buffer.concat(chunks).toString('utf8')),results=[];
   for(const m of input.mutations){
    const bodyHash=createHash('sha256').update(JSON.stringify(m)).digest('hex'),old=receipts.get(m.mutationId);if(old){if(old.hash!==bodyHash)return json(response,409,{error:'fixture idempotency',code:'READER_IDEMPOTENCY'});results.push(old.result);continue;}
    const expected=(devices.get(m.deviceId)||0)+1;if(m.protocolVersion!==2||m.mutationId!==mutationId(m))return json(response,400,{error:'fixture deterministic identity',code:'READER_MUTATION_ID'});if(m.counter!==expected)return json(response,409,{error:'fixture counter',code:'READER_COUNTER',expectedCounter:expected});
    const key=m.entityType+':'+m.entityId,current=entities.get(key)||null;let result;
    if(m.baseRevision!==(current?.revision||0))result={mutationId:m.mutationId,status:'conflict',code:'REVISION_CONFLICT',current,proposed:m};else{const entity={entityType:m.entityType,entityId:m.entityId,revision:(current?.revision||0)+1,deleted:m.operation==='delete',payload:m.operation==='delete'?(current?.payload||null):m.payload,updatedAt:new Date().toISOString()};entities.set(key,entity);revision++;changes.push({changeRevision:revision,entity});result={mutationId:m.mutationId,status:'accepted',entity};}
    devices.set(m.deviceId,m.counter);receipts.set(m.mutationId,{hash:bodyHash,result});results.push(result);
   }return json(response,200,{schemaVersion:1,cursor:cursor(),results});
  }
  return json(response,404,{error:'Synthetic route not implemented',path:url.pathname});
 }catch(error){if(!response.headersSent)json(response,500,{error:String(error.message)});else response.destroy();}
});
server.listen(0,'127.0.0.1',async()=>{const port=server.address().port;await fs.writeFile(ready,JSON.stringify({pid:process.pid,origin:`http://127.0.0.1:${port}`,profile:PROFILE,book:BOOK,sha256:hash}));});
'@
try{
 $releaseProof=Get-ReaderReleaseProof
 if(Test-Path -LiteralPath $checkData){
  $item=Get-Item -LiteralPath $checkData -Force;if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Reader test directory is not a regular owned fixture directory'}
  $archive=[IO.Path]::GetFullPath((Join-Path $runRoot 'previous-selfcheck-data'));if(-not $archive.StartsWith([IO.Path]::GetFullPath($runRoot)+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetPathRoot($archive) -ne [IO.Path]::GetPathRoot($checkData)){throw 'Unsafe fixture archive target'}
  Move-Item -LiteralPath $checkData -Destination $archive
 }
 [IO.File]::WriteAllText($fixturePath,$fixture,[Text.UTF8Encoding]::new($false))
 $fixtureProcess=Start-Process -FilePath $nodePath -ArgumentList @(('"'+$fixturePath+'"'),'--ready',('"'+$readyPath+'"')) -WorkingDirectory $workspace -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runRoot 'fixture.stdout') -RedirectStandardError (Join-Path $runRoot 'fixture.stderr') -PassThru
 $deadline=[DateTime]::UtcNow.AddSeconds(15);while(-not(Test-Path -LiteralPath $readyPath)){$fixtureProcess.Refresh();if($fixtureProcess.HasExited -or [DateTime]::UtcNow -ge $deadline){throw ('Reader fixture did not start: '+(Join-Path $runRoot 'fixture.stderr'))};Start-Sleep -Milliseconds 100}
 $ready=Get-Content -LiteralPath $readyPath -Raw -Encoding utf8|ConvertFrom-Json;if($ready.pid -ne $fixtureProcess.Id -or $ready.origin -notmatch '^http://127\.0\.0\.1:[1-9][0-9]{0,4}$' -or ([uri]$ready.origin).Port -eq 3080){throw 'Unexpected isolated fixture identity'}
 $env:COTOLOGY_READER_FIXTURE_ORIGIN=$ready.origin;$env:COTOLOGY_SELF_CHECK_CREDENTIALS=$null;$env:ELECTRON_RUN_AS_NODE=$null
 $started=[DateTime]::UtcNow;$clientProcess=Start-Process -FilePath $desktopPath -ArgumentList @('--reader-self-check') -WorkingDirectory (Split-Path $desktopPath -Parent) -WindowStyle Hidden -PassThru
 $reports.online=Wait-ReaderReport 'online' $started
 $journal=Invoke-RestMethod -Uri ($ready.origin+'/test/status') -TimeoutSec 10;$journal|ConvertTo-Json -Depth 10|Set-Content -LiteralPath (Join-Path $runRoot 'fixture-requests.json') -Encoding utf8
 if(-not ($journal.requests|Where-Object{$_.path -eq '/api/books/c2000000-0000-4000-8000-000000000001/download'})){throw 'Actual server-book download was not observed by the isolated fixture'}
 if(-not ($journal.requests|Where-Object{$_.path -eq '/api/library/serial-groups'})){throw 'The application did not request authoritative serial groups'}
 foreach($part in $journal.serialGroup.parts){$path='/api/books/'+$part.publicationId+'/download';if(@($journal.requests|Where-Object{$_.method -eq 'GET' -and $_.path -eq $path}).Count -ne 1){throw ('Download-all did not transfer exactly one immutable packet for '+$part.publicationId)}}
 Stop-Process -Id $fixtureProcess.Id -ErrorAction Stop;$fixtureProcess.WaitForExit(5000)|Out-Null;$fixtureProcess=$null;$fixtureStoppedBeforeOffline=$true
 $env:COTOLOGY_READER_FIXTURE_ORIGIN=$null;$started=[DateTime]::UtcNow;$clientProcess=Start-Process -FilePath $desktopPath -ArgumentList @('--reader-self-check','--offline') -WorkingDirectory (Split-Path $desktopPath -Parent) -WindowStyle Hidden -PassThru
 $reports.offline=Wait-ReaderReport 'offline' $started
 $finalReleaseProof=Get-ReaderReleaseProof;if($finalReleaseProof.manifestSha256 -ne $releaseProof.manifestSha256){throw 'The tested release changed between the online and offline processes'}
}catch{$failure=$_.Exception.Message}
finally{
 $env:COTOLOGY_READER_FIXTURE_ORIGIN=$oldReaderOrigin;$env:COTOLOGY_SELF_CHECK_CREDENTIALS=$oldCredentials;$env:ELECTRON_RUN_AS_NODE=$oldRunAsNode
 foreach($owned in @($clientProcess,$fixtureProcess)){if($null -ne $owned){$owned.Refresh();if(-not $owned.HasExited){Stop-Process -Id $owned.Id -ErrorAction SilentlyContinue}}}
 $summary=@{schemaVersion=1;ok= -not [bool]$failure;scope='REAL_WINDOWS_EXE_UI_WORKER_SQLITE_COLD_OFFLINE_NOT_PRODUCTION_OR_ANDROID';createdAt=[DateTimeOffset]::UtcNow.ToString('o');error=$failure;onlineChecks=$reports.online.results.Count;offlineChecks=$reports.offline.results.Count;fixtureStoppedBeforeOffline=$fixtureStoppedBeforeOffline;application=$desktopPath;executableSha256=(Get-FileHash -LiteralPath $desktopPath -Algorithm SHA256).Hash.ToLowerInvariant();release=$releaseProof;isolatedUserData=$checkData;productionDataUsed=$false;sourceFingerprints=@{}}
 foreach($relative in @('scripts/test-reader-client.ps1','src/reader-selfcheck.js','src/Reader.jsx','src/serial-reader.mjs','src/serial-groups.mjs','src/library-state.mjs','src/book-download.mjs','src/LibraryApp.jsx','src/main.jsx','desktop/main.cjs','desktop/preload.cjs')){$summary.sourceFingerprints[$relative]=(Get-FileHash -LiteralPath (Join-Path $workspace $relative) -Algorithm SHA256).Hash.ToLowerInvariant()}
 [IO.File]::WriteAllText((Join-Path $runRoot 'report.json'),($summary|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))
}
if($failure){throw ($failure+'; run '+$runRoot)}
Write-Host ('Reader application checks passed. Reports and screenshots: '+$runRoot)
