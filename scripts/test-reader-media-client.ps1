[CmdletBinding()]
param([string]$DesktopExe)
$ErrorActionPreference='Stop'
$workspace=(Resolve-Path -LiteralPath (Split-Path $PSScriptRoot -Parent)).Path
if(-not $DesktopExe){$DesktopExe=Join-Path $workspace 'releases/Gargantua-Windows-MediaTests-0.3.0/Cotology.exe'}
$desktopPath=(Resolve-Path -LiteralPath $DesktopExe).Path
$nodePath=(Get-Command node -ErrorAction Stop).Source
$runRoot=Join-Path $workspace ('.local/test-results/reader-media-client-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $runRoot -Force|Out-Null
$checkData=[IO.Path]::GetFullPath((Join-Path $env:APPDATA 'Cotology-MediaSelfCheck'))
$expectedParent=[IO.Path]::GetFullPath($env:APPDATA)
if([IO.Path]::GetFileName($checkData) -ne 'Cotology-MediaSelfCheck' -or [IO.Path]::GetDirectoryName($checkData) -ne $expectedParent){throw 'Unexpected isolated reader data path'}
$fixturePath=Join-Path $runRoot 'fixture.mjs'
$readyPath=Join-Path $runRoot 'fixture-ready.json'
$fixtureProcess=$null;$clientProcess=$null;$failure=$null;$reports=@{};$fixtureStoppedBeforeOffline=$false;$releaseProof=$null
$oldReaderOrigin=$env:COTOLOGY_READER_MEDIA_FIXTURE_ORIGIN
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
 $packagedMain=[IO.File]::ReadAllText((Join-Path $root 'resources/app/main.cjs'));$packagedPreload=[IO.File]::ReadAllText((Join-Path $root 'resources/app/preload.cjs'))
 if(-not $packagedMain.Contains("process.argv.includes('--reader-media-self-check')") -or -not $packagedMain.Contains('Cotology-MediaSelfCheck') -or -not $packagedMain.Contains('COTOLOGY_READER_MEDIA_FIXTURE_ORIGIN') -or -not $packagedPreload.Contains('selfCheckMedia:') -or -not $packagedPreload.Contains('--cotology-media-self-check')){throw 'Release does not support the isolated media test capability; refusing to start any executable'}
 if((Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sha){throw 'Release manifest changed during validation'}
 return @{manifestSha256=$sha;appImageId=$manifest.appImageId;applicationVersion=$manifest.applicationVersion;filesChecked=$checked;allFilesSha256Verified=$true}
}
function Wait-ReaderReport([string]$Mode,[datetime]$Started){
 $source=Join-Path $checkData ('reader-media-'+$Mode+'-report.json');$deadline=[DateTime]::UtcNow.AddSeconds(210)
 while([DateTime]::UtcNow -lt $deadline){
  if((Test-Path -LiteralPath $source) -and (Get-Item -LiteralPath $source).LastWriteTimeUtc -ge $Started){
   try{$value=Get-Content -LiteralPath $source -Raw -Encoding utf8|ConvertFrom-Json}catch{Start-Sleep -Milliseconds 100;continue}
   Copy-Item -LiteralPath $source -Destination (Join-Path $runRoot ('reader-media-'+$Mode+'-report.json'))
   $clientProcess.WaitForExit(15000)|Out-Null;$clientProcess.Refresh();if(-not $clientProcess.HasExited){throw ('Reader '+$Mode+' did not safely close')}
   $closePath=Join-Path $checkData 'close-status.json'
   if(-not (Test-Path -LiteralPath $closePath) -or (Get-Item -LiteralPath $closePath).LastWriteTimeUtc -lt $Started){throw 'Fresh native close proof missing'}
   $closed=Get-Content -LiteralPath $closePath -Raw -Encoding utf8|ConvertFrom-Json
   Copy-Item -LiteralPath $closePath -Destination (Join-Path $runRoot ('reader-media-'+$Mode+'-close.json'))
   $acknowledged=if($closed.PSObject.Properties.Name -contains 'rendererAcknowledged'){$closed.rendererAcknowledged}else{$closed.acknowledged}
   if(-not $acknowledged -or $closed.timedOut -or -not $closed.storageFlushed -or -not $closed.storageClosed -or -not $closed.audioClosed -or $closed.rejectedPromises -ne 0){throw ('Native close/flush acknowledgement failed: '+$Mode)}
   if($Mode -eq 'online' -and $value.pendingCloseEdit){$closedTime=if($closed.at -is [DateTime]){[DateTimeOffset]::new($closed.at.ToUniversalTime())}else{[DateTimeOffset]::Parse([string]$closed.at,[Globalization.CultureInfo]::InvariantCulture)};$closedAt=$closedTime.ToUnixTimeMilliseconds();if($closedAt-[long]$value.pendingCloseEdit.at -ge 600){throw 'Close proof was too slow to distinguish the handshake from normal debounce; rerun required'}}
   $screenshot=Join-Path $checkData ('reader-media-'+$Mode+'-screenshot.png');if(Test-Path -LiteralPath $screenshot){Copy-Item -LiteralPath $screenshot -Destination $runRoot}
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
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const ready=process.argv[process.argv.indexOf('--ready')+1],root=process.argv[process.argv.indexOf('--workspace')+1];
const {createAudioClientFixture,AUDIO_FIXTURE}=await import(pathToFileURL(path.join(root,'scripts/audio-client-fixture.mjs')).href);
const {validateAudioManifest,audioSegmentPath}=await import(pathToFileURL(path.join(root,'src/audio.mjs')).href);
const PROFILE=AUDIO_FIXTURE.profileId,BOOK='c3000000-0000-4000-8000-000000000001',NOVEL=AUDIO_FIXTURE.bookId,JOB=AUDIO_FIXTURE.jobId;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item);
const pcm=Buffer.alloc(44+22050*8*2);pcm.write('RIFF',0);pcm.writeUInt32LE(pcm.length-8,4);pcm.write('WAVEfmt ',8);pcm.writeUInt32LE(16,16);pcm.writeUInt16LE(1,20);pcm.writeUInt16LE(1,22);pcm.writeUInt32LE(22050,24);pcm.writeUInt32LE(44100,28);pcm.writeUInt16LE(2,32);pcm.writeUInt16LE(16,34);pcm.write('data',36);pcm.writeUInt32LE(pcm.length-44,40);for(let i=0;i<22050*8;i++)pcm.writeInt16LE(Math.round(Math.sin(2*Math.PI*330*i/22050)*4000),44+i*2);
const sample=path.join(path.dirname(ready),'synthetic-chapter-tone.wav');await fs.writeFile(sample,pcm);const audio=await createAudioClientFixture({samplePath:sample});
const make=(kind,count)=>({title:kind==='book'?'Книга: три главы':'Новелла: двенадцать глав',author:'Синтетический автор',language:'ru',chapters:Array.from({length:count},(_,i)=>({title:`${kind==='book'?'Книга':'Новелла'} — глава ${i+1}`,blocks:[{type:'text',text:i===count-1?(kind==='book'?'BOOK-LAST-3':'NOVEL-LAST-12'):`${kind}-${i+1}`},...Array.from({length:55},(_,j)=>({type:'text',text:`Это синтетическая ${kind==='book'?'книга':'новелла'}, глава ${i+1}, абзац ${j+1}. `.repeat(8)}))]})),assets:{}});
const texts=new Map([[BOOK,make('book',3)],[NOVEL,make('novel',12)]]),raws=new Map([...texts].map(([id,content])=>[id,Buffer.from(JSON.stringify(content))]));
const books=[...texts].map(([id,content])=>({id,title:content.title,author:content.author,language:'ru',chapter_count:content.chapters.length,content_sha256:hash(raws.get(id)),content_bytes:raws.get(id).length,sha256:hash(raws.get(id)),security_state:'passed',shelf:'planned',created_at:'2026-10-23T00:00:00.000Z',...(id===NOVEL?{work_id:AUDIO_FIXTURE.workId,expression_id:AUDIO_FIXTURE.expressionId,edition_id:AUDIO_FIXTURE.editionId}:{})}));
const manifest=validateAudioManifest({...audio.manifest,sourceSha256:hash(raws.get(NOVEL)),segments:Array.from({length:12},(_,ordinal)=>({...audio.manifest.segments[0],ordinal,url:audioSegmentPath(JOB,ordinal)}))}),manifestBytes=Buffer.from(canonical(manifest));
const requests=[],faults=new Map(),attempts={},ttsKeys=new Map(),entities=new Map(),devices=new Map(),receipts=new Map();let revision=0,ttsRequests=0,lastTts=null;
const cursor=()=>Buffer.from(JSON.stringify({schemaVersion:1,profileId:PROFILE,revision})).toString('base64url');
const json=(response,status,value,headers={})=>{const data=Buffer.from(canonical(value));response.writeHead(status,{'Content-Type':'application/json','Content-Length':data.length,'Cache-Control':'no-store','X-Content-SHA256':hash(data),...headers});response.end(data);};
const read=async request=>{const chunks=[];let size=0;for await(const chunk of request){size+=chunk.length;if(size>256000)throw Error('fixture body cap');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));};
function mutationId(m){const bytes=createHash('sha256').update(`gargantua-reader-v2\0${PROFILE}\0${m.deviceId}\0${m.counter}`).digest().subarray(0,16);bytes[6]=(bytes[6]&15)|128;bytes[8]=(bytes[8]&63)|128;const h=bytes.toString('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;}
const completed=async()=>{const value=await(await fetch(audio.origin+'/api/derived/requests')).json(),request=value[0];return {...request,title:'Новелла — 12 синтетических тональных фрагментов',author:'НЕ настоящая TTS-озвучка',completedSegments:12,totalSegments:12,job:{...request.job,completedSegments:12,totalSegments:12}};};
const server=http.createServer(async(request,response)=>{
 try{
  const url=new URL(request.url,'http://127.0.0.1');if(requests.length<2000)requests.push({method:request.method,path:url.pathname,at:new Date().toISOString()});
  if(url.pathname==='/api/fixture/state'||url.pathname==='/test/status')return json(response,200,{attempts,ttsRequests,lastTts,requests,audioRequests:audio.requests,manifestSha256:hash(manifestBytes),audioSegments:12,audioQuality:'SYNTHETIC_CHAPTER_IDENTIFICATION_TONES_NOT_NARRATION_OR_FRESH_TTS'});
  if(url.pathname==='/api/fixture/fault'&&request.method==='POST'){const input=await read(request);if(!texts.has(input.id)||!['normal','wrong-sha','abort'].includes(input.mode))return json(response,400,{error:'invalid fault'});faults.set(input.id,input.mode);return json(response,200,{ok:true});}
  if(url.pathname==='/api/me')return json(response,200,audio.profile,{'Set-Cookie':'cotology=media-fixture-session; HttpOnly; SameSite=Strict; Path=/'});
  if(url.pathname==='/api/books')return json(response,200,books);
  const download=/^\/api\/books\/([a-f0-9-]{36})\/download$/.exec(url.pathname);
  if(download&&texts.has(download[1])){const id=download[1],raw=raws.get(id),mode=faults.get(id)||'normal';attempts[id]=(attempts[id]||0)+1;response.writeHead(200,{'Content-Type':'application/json','Content-Length':raw.length,'X-Content-SHA256':mode==='wrong-sha'?'0'.repeat(64):hash(raw)});if(mode==='abort'){response.write(raw.subarray(0,Math.floor(raw.length/2)));setTimeout(()=>response.destroy(),35);return;}return response.end(raw);}
  const details=/^\/api\/books\/([a-f0-9-]{36})(?:\/chapters\/(\d+))?$/.exec(url.pathname);
  if(details&&texts.has(details[1])){const content=texts.get(details[1]);return details[2]===undefined?json(response,200,{book:books.find(b=>b.id===details[1]),chapters:content.chapters.map((c,index)=>({title:c.title,index})),reading:null,bookmarks:[]}):json(response,200,content.chapters[Number(details[2])]);}
  if(url.pathname==='/api/status')return json(response,200,{version:'media-fixture',settings:{},statuses:[]});
  if(url.pathname==='/api/imports')return json(response,200,[]);if(url.pathname==='/api/catalogs')return json(response,200,{revision:0,catalogs:[]});if(url.pathname==='/api/logout')return json(response,200,{ok:true});
  if(url.pathname==='/api/v2/reader/snapshot')return json(response,200,{schemaVersion:1,cursor:cursor(),entities:[...entities.values()],devices:[...devices].map(([deviceId,lastCounter])=>({deviceId,lastCounter,protocolVersion:2,compactedThrough:0,compactedCount:0}))});
  if(url.pathname==='/api/v2/reader/conflicts')return json(response,200,{conflicts:[],cursor:null,hasMore:false});
  if(url.pathname==='/api/v2/reader/mutations'&&request.method==='POST'){
   const input=await read(request),results=[];for(const m of input.mutations){const digest=hash(Buffer.from(canonical(m))),old=receipts.get(m.mutationId);if(old){if(old.hash!==digest)return json(response,409,{error:'idempotency',code:'READER_IDEMPOTENCY'});results.push(old.result);continue;}if(m.protocolVersion!==2||m.mutationId!==mutationId(m))return json(response,400,{error:'id',code:'READER_MUTATION_ID'});const counter=(devices.get(m.deviceId)||0)+1;if(m.counter!==counter)return json(response,409,{error:'counter',code:'READER_COUNTER',expectedCounter:counter});const key=m.entityType+':'+m.entityId,current=entities.get(key)||null;let result;if(m.baseRevision!==(current?.revision||0))result={mutationId:m.mutationId,status:'conflict',code:'REVISION_CONFLICT',current,proposed:m};else{const entity={entityType:m.entityType,entityId:m.entityId,revision:(current?.revision||0)+1,deleted:m.operation==='delete',payload:m.operation==='delete'?(current?.payload||null):m.payload,updatedAt:new Date().toISOString()};entities.set(key,entity);revision++;result={mutationId:m.mutationId,status:'accepted',entity};}devices.set(m.deviceId,m.counter);receipts.set(m.mutationId,{hash:digest,result});results.push(result);}return json(response,200,{schemaVersion:1,cursor:cursor(),results});
  }
  if(url.pathname==='/api/derived/requests'){
   if(request.method==='GET')return json(response,200,ttsRequests?[await completed()]:[]);
   if(request.method==='POST'){const input=await read(request);if(input.kind!=='audio'||input.sourceLanguage!=='ru'||input.publicationIds?.length!==1||input.publicationIds[0]!==NOVEL||typeof input.idempotencyKey!=='string')return json(response,400,{error:'wrong audio fixture request'});const digest=canonical(input),old=ttsKeys.get(input.idempotencyKey);if(old&&old!==digest)return json(response,409,{error:'TTS idempotency'});if(!old){ttsKeys.set(input.idempotencyKey,digest);ttsRequests++;lastTts=input;}return json(response,200,{request:await completed()});}
  }
  if(url.pathname===`/api/derived/jobs/${JOB}/result`){response.writeHead(200,{'Content-Type':'application/json','Content-Length':manifestBytes.length,'X-Content-SHA256':hash(manifestBytes)});return response.end(manifestBytes);}
  if(manifest.segments.some(segment=>segment.url===url.pathname)){response.writeHead(200,{'Content-Type':'audio/wav','Content-Length':pcm.length,'X-Content-SHA256':hash(pcm),'ETag':`"${hash(pcm)}"`});return response.end(pcm);}
  if(url.pathname==='/api/derived/profiles'){const result=await fetch(audio.origin+url.pathname);response.writeHead(result.status,Object.fromEntries(result.headers));return response.end(Buffer.from(await result.arrayBuffer()));}
  return json(response,404,{error:'Media fixture route not implemented',path:url.pathname});
 }catch(error){if(!response.headersSent)json(response,500,{error:String(error.message)});else response.destroy();}
});
server.listen(0,'127.0.0.1',async()=>{await fs.writeFile(ready,JSON.stringify({pid:process.pid,origin:`http://127.0.0.1:${server.address().port}`,profile:PROFILE,books:[BOOK,NOVEL],job:JOB,audioSegments:12,audioQuality:'SYNTHETIC_TONE_NOT_FRESH_TTS_OR_NARRATION'}));});
'@
try{
 $releaseProof=Get-ReaderReleaseProof
 if(Test-Path -LiteralPath $checkData){
  $item=Get-Item -LiteralPath $checkData -Force;if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Reader test directory is not a regular owned fixture directory'}
  $archive=[IO.Path]::GetFullPath((Join-Path $runRoot 'previous-selfcheck-data'));if(-not $archive.StartsWith([IO.Path]::GetFullPath($runRoot)+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetPathRoot($archive) -ne [IO.Path]::GetPathRoot($checkData)){throw 'Unsafe fixture archive target'}
  Move-Item -LiteralPath $checkData -Destination $archive
 }
 [IO.File]::WriteAllText($fixturePath,$fixture,[Text.UTF8Encoding]::new($false))
 $fixtureProcess=Start-Process -FilePath $nodePath -ArgumentList @(('"'+$fixturePath+'"'),'--ready',('"'+$readyPath+'"'),'--workspace',('"'+$workspace+'"')) -WorkingDirectory $workspace -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runRoot 'fixture.stdout') -RedirectStandardError (Join-Path $runRoot 'fixture.stderr') -PassThru
 $deadline=[DateTime]::UtcNow.AddSeconds(15);while(-not(Test-Path -LiteralPath $readyPath)){$fixtureProcess.Refresh();if($fixtureProcess.HasExited -or [DateTime]::UtcNow -ge $deadline){throw ('Reader fixture did not start: '+(Join-Path $runRoot 'fixture.stderr'))};Start-Sleep -Milliseconds 100}
 $ready=Get-Content -LiteralPath $readyPath -Raw -Encoding utf8|ConvertFrom-Json;if($ready.pid -ne $fixtureProcess.Id -or $ready.origin -notmatch '^http://127\.0\.0\.1:[1-9][0-9]{0,4}$' -or ([uri]$ready.origin).Port -eq 3080){throw 'Unexpected isolated fixture identity'}
 $env:COTOLOGY_READER_MEDIA_FIXTURE_ORIGIN=$ready.origin;$env:COTOLOGY_SELF_CHECK_CREDENTIALS=$null;$env:ELECTRON_RUN_AS_NODE=$null
 $started=[DateTime]::UtcNow;$clientProcess=Start-Process -FilePath $desktopPath -ArgumentList @('--reader-media-self-check') -WorkingDirectory (Split-Path $desktopPath -Parent) -WindowStyle Hidden -PassThru
 $reports.online=Wait-ReaderReport 'online' $started
 $journal=Invoke-RestMethod -Uri ($ready.origin+'/test/status') -TimeoutSec 10;$journal|ConvertTo-Json -Depth 10|Set-Content -LiteralPath (Join-Path $runRoot 'fixture-requests.json') -Encoding utf8
 $ordinaryAttempts=$journal.attempts.'c3000000-0000-4000-8000-000000000001';$novelAttempts=$journal.attempts.'b1000000-0000-4000-8000-000000000007'
 if($ordinaryAttempts -lt 3 -or $novelAttempts -lt 2 -or $journal.ttsRequests -ne 1){throw 'The fixture did not observe failed-download retry/redownload and the selected novel audio request'}
 $audioOrdinals=@($journal.requests|Where-Object{$_.path -match '^/api/derived/jobs/b1000000-0000-4000-8000-000000000001/audio/segments/(\d+)$'}|ForEach-Object{[int]($_.path.Split('/')[-1])}|Sort-Object -Unique)
 if($audioOrdinals.Count -ne 12 -or $audioOrdinals[0] -ne 0 -or $audioOrdinals[-1] -ne 11){throw 'Not every one of the twelve synthetic audio segments was actually requested'}
 Stop-Process -Id $fixtureProcess.Id -ErrorAction Stop;$fixtureProcess.WaitForExit(5000)|Out-Null;$fixtureProcess=$null;$fixtureStoppedBeforeOffline=$true
 $env:COTOLOGY_READER_MEDIA_FIXTURE_ORIGIN=$null;$started=[DateTime]::UtcNow;$clientProcess=Start-Process -FilePath $desktopPath -ArgumentList @('--reader-media-self-check','--offline') -WorkingDirectory (Split-Path $desktopPath -Parent) -WindowStyle Hidden -PassThru
 $reports.offline=Wait-ReaderReport 'offline' $started
 $finalReleaseProof=Get-ReaderReleaseProof;if($finalReleaseProof.manifestSha256 -ne $releaseProof.manifestSha256){throw 'The tested release changed between the online and offline processes'}
}catch{$failure=$_.Exception.Message}
finally{
 $env:COTOLOGY_READER_MEDIA_FIXTURE_ORIGIN=$oldReaderOrigin;$env:COTOLOGY_SELF_CHECK_CREDENTIALS=$oldCredentials;$env:ELECTRON_RUN_AS_NODE=$oldRunAsNode
 foreach($owned in @($clientProcess,$fixtureProcess)){if($null -ne $owned){$owned.Refresh();if(-not $owned.HasExited){Stop-Process -Id $owned.Id -ErrorAction SilentlyContinue}}}
 $summary=@{schemaVersion=1;ok= -not [bool]$failure;scope='REAL_WINDOWS_EXE_BOOK_NOVEL_AUDIO_UI_SYNTHETIC_FIXTURE_NOT_FRESH_TTS_OR_ANDROID';audioSource='SYNTHETIC_CHAPTER_IDENTIFICATION_TONES_NOT_NARRATION_OR_FRESH_TTS';freshTtsGenerated=$false;textBooks=2;ordinaryChapters=3;novelChapters=12;syntheticAudioSegments=12;createdAt=[DateTimeOffset]::UtcNow.ToString('o');error=$failure;onlineChecks=$reports.online.results.Count;offlineChecks=$reports.offline.results.Count;fixtureStoppedBeforeOffline=$fixtureStoppedBeforeOffline;application=$desktopPath;executableSha256=(Get-FileHash -LiteralPath $desktopPath -Algorithm SHA256).Hash.ToLowerInvariant();release=$releaseProof;isolatedUserData=$checkData;productionDataUsed=$false;sourceFingerprints=@{}}
 foreach($relative in @('scripts/test-reader-media-client.ps1','src/reader-media-selfcheck.js','src/library-state.mjs','src/book-download.mjs','src/LibraryApp.jsx','src/main.jsx','desktop/main.cjs','desktop/preload.cjs')){$summary.sourceFingerprints[$relative]=(Get-FileHash -LiteralPath (Join-Path $workspace $relative) -Algorithm SHA256).Hash.ToLowerInvariant()}
 [IO.File]::WriteAllText((Join-Path $runRoot 'report.json'),($summary|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))
}
if($failure){throw ($failure+'; run '+$runRoot)}
Write-Host ('Reader media application checks passed. Reports and screenshots: '+$runRoot)
