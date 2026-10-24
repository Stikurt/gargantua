// Private, authenticated read-only capture of already published real outputs.
// No credentials, cookies, request headers or book text appear in its stdout.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {readDownloadedResponse} from '../src/book-download.mjs';
import {parseAudioManifest,verifyAudioChunk,assertAudioDownloadable} from '../src/audio.mjs';
import {discoveryPublications} from '../src/discovery-delivery.mjs';
import {loadDesktopAudioProof} from './desktop-audio-proof.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export function createPacedPublishedAudioReader(get,{now=Date.now,delay=sleep,pacingMs=600,retryBudgetMs=120000}={}){
 if(typeof get!=='function'||typeof now!=='function'||typeof delay!=='function'||!Number.isSafeInteger(pacingMs)||pacingMs<600||!Number.isSafeInteger(retryBudgetMs)||retryBudgetMs<1||retryBudgetMs>120000)throw Error('Invalid bounded published-audio reader');
 let queue=Promise.resolve(),nextAt=0;
 async function read(route){
  if(typeof route!=='string'||!/^\/api\/derived\/jobs\/[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\/audio\/segments\/(0|[1-9]\d{0,4})$/.test(route)||Number(route.split('/').at(-1))>=50000)throw Error('Only exact published audio GET routes may be retried');
  const deadline=now()+retryBudgetMs;
  for(let attempt=0;attempt<4;attempt++){
   const start=Math.max(now(),nextAt);if(start>=deadline)throw Error('Published audio retry budget exhausted');await delay(Math.max(0,start-now()));nextAt=now()+pacingMs;
   const remaining=deadline-now();if(remaining<=0)throw Error('Published audio retry budget exhausted');let backoff=null,response;
   try{response=await get(route,{signal:AbortSignal.timeout(Math.min(60000,remaining))});}catch{backoff=1000*2**attempt;}
   if(response){
    if(response.status===200)return response;
    await response.body?.cancel().catch(()=>{});
    if(![429,502,503,504].includes(response.status))throw Error(`Published audio unavailable (${response.status})`);
    const header=response.headers.get('retry-after');
    if(typeof header==='string'&&header.length<=128){if(/^\d{1,7}$/.test(header.trim()))backoff=Number(header.trim())*1000;else{const timestamp=Date.parse(header);if(Number.isFinite(timestamp))backoff=Math.max(0,timestamp-now());}}
    if(backoff===null)backoff=response.status===429?60000:1000*2**attempt;
   }
   if(attempt===3||!Number.isFinite(backoff)||backoff>60000||now()+backoff>=deadline)throw Error('Published audio retry budget exhausted; captured source files are preserved');
   await delay(Math.max(100,backoff));
  }
 }
 return route=>{const result=queue.catch(()=>{}).then(()=>read(route));queue=result.catch(()=>{});return result;};
}
export async function boundedBytes(response,limit){
 if(!response.ok)throw Error(`Published output unavailable (${response.status})`);
 const declared=response.headers.get('content-length');if(declared&&(!/^\d+$/.test(declared)||Number(declared)>limit)){await response.body?.cancel();throw Error('Output declared size exceeds capture limit');}
 const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>limit)throw Error('Output stream exceeds capture limit');chunks.push(chunk);}const bytes=Buffer.concat(chunks,size);
 if(declared&&Number(declared)!==size)throw Error('Published output length mismatch');
 const digest=response.headers.get('x-content-sha256');if(!/^[a-f0-9]{64}$/.test(digest||'')||hash(bytes)!==digest)throw Error('Published output SHA256 mismatch');
 return {bytes,sha256:digest};
}
export function checkedSpec(value){
 if(value?.schemaVersion!==1||value.kind!=='gargantua-real-delivery-spec'||!Array.isArray(value.groups)||value.groups.length<1||value.groups.length>8)throw Error('Invalid explicit real-output delivery spec');
 const seen=new Set();for(const group of value.groups){if(!uuid(group.requestId)||seen.has(group.requestId)||!Number.isSafeInteger(group.expectedChapters)||group.expectedChapters<1||group.expectedChapters>20000||group.audio!==undefined&&typeof group.audio!=='boolean')throw Error('Invalid or duplicate real-output group');seen.add(group.requestId);}
 return value;
}
export async function captureRealDelivery({spec,destination,source='http://127.0.0.1:3080',credentials,desktopAudioProof,desktopExe,onProgress=()=>{}}){
 checkedSpec(spec);if(source!=='http://127.0.0.1:3080')throw Error('Real-output capture accepts only the local production API');
 const audioEvidence=desktopAudioProof!==undefined||desktopExe!==undefined?await loadDesktopAudioProof({proofPath:desktopAudioProof,desktopExe}):null;
 const output=path.resolve(destination);try{await fs.mkdir(output,{recursive:false});}catch(error){throw Error('A fresh private capture directory is required',{cause:error});}
 const credential=JSON.parse((await fs.readFile(credentials,'utf8')).replace(/^\uFEFF/,''));
 const login=await fetch(source+'/api/login',{method:'POST',headers:{'Content-Type':'application/json','X-Cotology':'1'},body:JSON.stringify({login:credential.login,password:credential.password}),signal:AbortSignal.timeout(30000)});
 if(login.status!==200)throw Error('Private capture authentication failed');const cookie=login.headers.get('set-cookie')?.split(';')[0];if(!cookie)throw Error('Private capture session missing');
 const get=(route,{signal}={})=>fetch(source+route,{headers:{Cookie:cookie},signal:signal??AbortSignal.timeout(60000)}),audioGet=createPacedPublishedAudioReader(get);
 let csrf;const artifacts=[],books=[],jobs=[],groups=[];
 const write=async(relative,bytes)=>{const target=path.join(output,relative);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes,{flag:'wx'});const row={path:relative,bytes:bytes.length,sha256:hash(bytes)};artifacts.push(row);return row;};
 try{
  const meResponse=await get('/api/me');if(meResponse.status!==200)throw Error('Private capture profile unavailable');const me=await meResponse.json();csrf=me.csrf;if(!uuid(me.id))throw Error('Invalid capture profile');
  const derivedResponse=await get('/api/derived/requests?limit=100');if(derivedResponse.status!==200)throw Error('Derived requests unavailable');const derived=await derivedResponse.json();
  for(const input of spec.groups){
   const response=await get('/api/discovery/requests/'+input.requestId);if(response.status!==200)throw Error('Selected discovery request unavailable');const row=await response.json();
   if(row.requested_by!==me.id||row.id!==input.requestId||row.outputs?.book?.status!=='ready')throw Error('Selected discovery result is not ready for this profile');
   const publicationIds=discoveryPublications(row),groupBooks=[];let chapterCount=0;
   for(const id of publicationIds){
    let saved=books.find(book=>book.id===id);if(!saved){
     const detailResponse=await get('/api/books/'+id);if(detailResponse.status!==200)throw Error('Published book metadata unavailable');const detail=await detailResponse.json(),book=detail.book;
     if(book?.id!==id||book.security_state!=='passed')throw Error('Published book did not pass mandatory security checks');
     const download=await get('/api/books/'+id+'/download'),exact=await boundedBytes(download,32*1024*1024);
     const verified=await readDownloadedResponse(new Response(exact.bytes,{headers:{'Content-Length':String(exact.bytes.length),'X-Content-SHA256':exact.sha256}}),book);
     const artifact=await write('books/'+id+'.json',exact.bytes);
     const chapters=verified.content.chapters.map(chapter=>({title:chapter.title,sha256:hash(Buffer.from(JSON.stringify(chapter)))}));
     saved={id,metadata:book,artifact,chapters,chapterCount:chapters.length};books.push(saved);
    }
    chapterCount+=saved.chapterCount;groupBooks.push(saved.id);
   }
   if(chapterCount!==input.expectedChapters)throw Error('Real book chapter coverage does not match the requested exact branch');
   const originalIds=row.outputs.book.publicationIds??[row.outputs.book.publicationId],translatedIds=row.outputs.translation?.status==='ready'?row.outputs.translation.publicationIds||[]:[];
   const chaptersFor=ids=>ids.reduce((sum,id)=>sum+books.find(book=>book.id===id).chapterCount,0);
   const group={requestId:row.id,publicationIds:groupBooks,chapterCount,originalPublicationIds:originalIds,translatedPublicationIds:translatedIds,originalChapterCount:chaptersFor(originalIds),translatedChapterCount:chaptersFor(translatedIds),query:row.query_text,audioJobs:[]};
   const requestArtifact=await write('requests/'+row.id+'.json',Buffer.from(JSON.stringify(row)));group.requestArtifact=requestArtifact;
   if(input.audio!==false){
    const jobId=row.outputs?.audio?.jobId;if(row.outputs?.audio?.status!=='ready'||!uuid(jobId))throw Error('The actual selected book has no complete published narration');
    let saved=jobs.find(job=>job.id===jobId);if(!saved){
     const requests=derived.filter(request=>request.jobId===jobId&&request.kind==='audio'&&request.requestedBy===me.id&&!['cancelled','rejected'].includes(request.status));
     if(!requests.length||!requests.some(request=>(request.jobStatus||request.job?.status)==='completed'))throw Error('Completed audio grant is not visible for this profile');
     const result=await boundedBytes(await get('/api/derived/jobs/'+jobId+'/result'),16*1024*1024),parsed=await parseAudioManifest(result.bytes,{expectedSha256:result.sha256,expectedJobId:jobId});
     const summary=assertAudioDownloadable(parsed.manifest,{...(audioEvidence?{capabilities:audioEvidence.capabilities}:{})}),manifestArtifact=await write('audio/'+jobId+'/manifest.json',result.bytes),segments=[];
     if(jobs.reduce((sum,job)=>sum+job.totalBytes,0)+summary.totalBytes>(audioEvidence?.limits.maxBytes??8*1024**3))throw Error('Selected audio jobs exceed the total target client quota');
     for(const segment of parsed.manifest.segments){
      const exact=await boundedBytes(await audioGet(segment.url),8*1024*1024);await verifyAudioChunk(exact.bytes,segment);const artifact=await write('audio/'+jobId+'/'+segment.ordinal+'.wav',exact.bytes);segments.push({ordinal:segment.ordinal,artifact});
      if(segment.ordinal%50===0)await onProgress({phase:'audio-capture',jobId,completed:segment.ordinal+1,total:parsed.manifest.segments.length});
     }
     saved={id:jobId,manifestArtifact,manifestSha256:result.sha256,segmentCount:segments.length,totalBytes:summary.totalBytes,totalDurationSeconds:summary.totalDurationSeconds,segments,requests};jobs.push(saved);
    }
    group.audioJobs.push(saved.id);
   }
   groups.push(group);await onProgress({phase:'group-captured',requestId:row.id,chapters:chapterCount,publications:publicationIds.length,audioJobs:group.audioJobs.length});
  }
  const manifest={schemaVersion:1,kind:'gargantua-private-real-output-replay',provenance:'authenticated-production-api',capturedAt:new Date().toISOString(),source,profileId:me.id,...(audioEvidence?{desktopAudioEvidence:audioEvidence}:{}),groups,books,jobs,artifacts};
  const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');await fs.writeFile(path.join(output,'capture.json'),bytes,{flag:'wx'});await fs.writeFile(path.join(output,'capture.sha256'),hash(bytes)+'  capture.json\n',{flag:'wx'});
  return {directory:output,manifestSha256:hash(bytes),groups:groups.length,books:books.length,chapters:groups.reduce((sum,group)=>sum+group.chapterCount,0),audioJobs:jobs.length,audioSegments:jobs.reduce((sum,job)=>sum+job.segmentCount,0),audioBytes:jobs.reduce((sum,job)=>sum+job.totalBytes,0),textAndAudioBytesUnaltered:true};
 }finally{if(csrf)await fetch(source+'/api/logout',{method:'POST',headers:{Cookie:cookie,'X-Cotology':'1','X-CSRF-Token':csrf},signal:AbortSignal.timeout(10000)}).catch(()=>{});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=Object.fromEntries(process.argv.slice(2).reduce((list,value,index,all)=>{if(value.startsWith('--'))list.push([value.slice(2),all[index+1]]);return list;},[]));
 const root=path.resolve(fileURLToPath(new URL('../',import.meta.url))),spec=JSON.parse(await fs.readFile(args.spec,'utf8'));
 const report=await captureRealDelivery({spec,destination:args.destination,credentials:path.join(root,'.local/login.txt'),...(args['desktop-capability-proof']||args['desktop-exe']?{desktopAudioProof:args['desktop-capability-proof'],desktopExe:args['desktop-exe']}:{}),onProgress:progress=>console.log(JSON.stringify(progress))});console.log(JSON.stringify(report));
}
