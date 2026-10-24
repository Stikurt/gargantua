import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {AUDIO_LIMITS,audioSegmentPath,validateAudioWav,validateAudioManifest} from '../src/audio.mjs';

export const AUDIO_FIXTURE=Object.freeze({jobId:'b1000000-0000-4000-8000-000000000001',profileId:'b1000000-0000-4000-8000-000000000002',workId:'b1000000-0000-4000-8000-000000000003',expressionId:'b1000000-0000-4000-8000-000000000004',editionId:'b1000000-0000-4000-8000-000000000005',requestId:'b1000000-0000-4000-8000-000000000006',bookId:'b1000000-0000-4000-8000-000000000007'});
const workspace=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const defaultSample=path.join(workspace,'.local/s5-queue/c91584ab9b514d4f8facb8f114a2e97f/reports/audio-sample.wav');
const checksum=bytes=>createHash('sha256').update(bytes).digest('hex');
function canonical(value){if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';}
export async function createAudioClientFixture({samplePath=defaultSample,port=0,chapterBatches=false}={}){
 const stat=await fs.stat(samplePath);if(!stat.isFile()||stat.size<46||stat.size>AUDIO_LIMITS.chunkBytes)throw Error('Fixture sample is not a bounded audio chunk');
 const bytes=await fs.readFile(samplePath),pcm=validateAudioWav(bytes),audioHash=checksum(bytes),now='2026-10-23T00:00:00.000Z';
 const manifest=validateAudioManifest({schemaVersion:1,jobId:AUDIO_FIXTURE.jobId,kind:'audio',sourceSha256:'a'.repeat(64),recipeSha256:'b'.repeat(64),quality:'technical-unlistened',workId:AUDIO_FIXTURE.workId,expressionId:AUDIO_FIXTURE.expressionId,editionId:AUDIO_FIXTURE.editionId,
  segments:[0,1].map(ordinal=>({ordinal,sha256:audioHash,bytes:bytes.length,mediaType:'audio/wav',durationSeconds:pcm.durationSeconds,sampleRate:22050,url:audioSegmentPath(AUDIO_FIXTURE.jobId,ordinal)}))});
 const manifestBytes=Buffer.from(canonical(manifest)),manifestSha256=checksum(manifestBytes);
 const profile={id:AUDIO_FIXTURE.profileId,login:'audio-fixture',name:'Проверка аудиоплеера',role:'owner',csrf:'fixture-only-no-production-session'};
 const book={id:AUDIO_FIXTURE.bookId,title:'Проверка аудиоплеера — локальная озвучка',author:'Тестовая библиотека',chapter_count:1,security_state:'passed',language:'ru',work_id:AUDIO_FIXTURE.workId,expression_id:AUDIO_FIXTURE.expressionId,edition_id:AUDIO_FIXTURE.editionId,shelf:'reading',created_at:now};
 const job={id:AUDIO_FIXTURE.jobId,kind:'audio',status:'completed',revision:3,completedSegments:2,totalSegments:2,pauseReason:null,error:null,createdAt:now,updatedAt:now,nextAttemptAt:null};
 // Deliberately distinct from the public body digest: the private server result
 // hash is not the identity of the public client manifest.
 const request={id:AUDIO_FIXTURE.requestId,jobId:AUDIO_FIXTURE.jobId,kind:'audio',status:'completed',revision:2,requestedBy:profile.id,audio:true,approvedBy:profile.id,decisionReason:'fixture-approved',jobStatus:'completed',completedSegments:2,totalSegments:2,createdAt:now,updatedAt:now,job,result:{jobId:AUDIO_FIXTURE.jobId,sha256:'c'.repeat(64),url:`/api/derived/jobs/${AUDIO_FIXTURE.jobId}/result`}};
 const batchCreates=[],batchTickets=new Map(),batchRequests=[];
 if(chapterBatches){book.chapter_count=10;Object.assign(request,{title:book.title,author:book.author,sourceLanguage:'ru',publicationIds:[book.id],snapshotId:null,chapterRange:{start:1,count:5,total:10,hasMore:true,nextStart:6}});}
 const requests=[];
 const send=(res,status,body,type='application/json; charset=utf-8',extra={})=>{const data=Buffer.isBuffer(body)?body:Buffer.from(typeof body==='string'?body:canonical(body));res.writeHead(status,{'Content-Type':type,'Content-Length':String(data.length),'X-Content-SHA256':checksum(data),'X-Content-Type-Options':'nosniff','Cache-Control':'no-store',...extra});res.end(data);};
 const server=http.createServer(async(req,res)=>{
  let url;try{url=new URL(req.url,'http://127.0.0.1');}catch{return send(res,400,{error:'Invalid request'});}
  requests.push({method:req.method,path:url.pathname,at:new Date().toISOString()});
  if(req.method==='POST'&&url.pathname==='/api/login')return send(res,200,{ok:true},undefined,{'Set-Cookie':'cotology=audio-fixture-session; HttpOnly; SameSite=Strict; Path=/'});
  if(chapterBatches&&req.method==='POST'&&url.pathname==='/api/derived/requests'){
   try{
    const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>32768)return send(res,413,{error:'Fixture input limit'});chunks.push(chunk);}
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8')),range=body.chapterRange;
    if(Object.keys(body).some(key=>!['idempotencyKey','kind','publicationIds','sourceLanguage','chapterRange'].includes(key))||!/^[-a-f0-9]{36}$/u.test(body.idempotencyKey??'')||body.kind!=='audio'||body.sourceLanguage!=='ru'||JSON.stringify(body.publicationIds)!==JSON.stringify([book.id])||!range||Object.keys(range).some(key=>!['start','count'].includes(key))||!Number.isSafeInteger(range.start)||range.start<1||range.start>10||!Number.isSafeInteger(range.count)||range.count<1||range.count>50)return send(res,400,{error:'Invalid explicit fixture chapter batch'});
    const before=batchTickets.get(body.idempotencyKey),sha=checksum(Buffer.from(canonical(body)));batchCreates.push(body);
    if(before)return before.sha===sha?send(res,200,{request:before.request,reused:true,idempotent:true}):send(res,409,{error:'Fixture intent key conflict'});
    const number=batchRequests.length+1,id=`b2000000-0000-4000-8000-${String(number).padStart(12,'0')}`,jobId=`b3000000-0000-4000-8000-${String(number).padStart(12,'0')}`,count=Math.min(range.count,10-range.start+1),nextStart=range.start+count;
    const created={id,jobId,kind:'audio',status:'active',jobStatus:'queued',requestedBy:profile.id,revision:1,sourceLanguage:'ru',publicationIds:[book.id],snapshotId:null,title:book.title,author:book.author,createdAt:now,updatedAt:now,chapterRange:{start:range.start,count,total:10,hasMore:nextStart<=10,nextStart:nextStart<=10?nextStart:null}};
    batchRequests.push(created);batchTickets.set(body.idempotencyKey,{sha,request:created});return send(res,202,{request:created,reused:false,idempotent:false});
   }catch{return send(res,400,{error:'Invalid fixture batch body'});}
  }
  if(req.method!=='GET')return send(res,405,{error:'Read-only audio test fixture'});
  if(chapterBatches&&url.pathname==='/api/fixture/chapter-batches')return send(res,200,{enabled:true,creates:batchCreates,uniqueJobs:batchRequests.length});
  if(url.pathname==='/api/library/serial-groups')return send(res,200,{schemaVersion:1,groups:[]});
  if(url.pathname==='/test/status')return send(res,200,{schemaVersion:1,requests:requests.slice(),manifestSha256,jobId:AUDIO_FIXTURE.jobId});
  if(url.pathname==='/api/me')return send(res,200,profile,undefined,{'Set-Cookie':'cotology=audio-fixture-session; HttpOnly; SameSite=Strict; Path=/'});
  if(url.pathname==='/api/books')return send(res,200,[book]);
  if(url.pathname==='/api/status')return send(res,200,{settings:{imports_paused:false,serving_paused:false},statuses:[]});
  if(url.pathname==='/api/imports')return send(res,200,[]);
  if(url.pathname==='/api/catalogs')return send(res,200,{revision:1,catalogs:[]});
  if(url.pathname==='/api/policy')return send(res,200,{text:'Изолированная проверка аудиоплеера. Рабочая библиотека не используется.'});
  if(url.pathname==='/api/derived/requests')return send(res,200,[request,...batchRequests]);
  if(url.pathname===`/api/derived/requests/${AUDIO_FIXTURE.requestId}`)return send(res,200,request);
  if(url.pathname==='/api/derived/profiles')return send(res,200,{schemaVersion:1,profiles:[{id:'fixture-piper-denis',kind:'audio',sourceLanguage:'ru',targetLanguage:'ru',profileSha256:'d'.repeat(64),quality:'NOT_LISTENED',requiresGpu:false}]});
  if(url.pathname===`/api/derived/jobs/${AUDIO_FIXTURE.jobId}/result`)return send(res,200,manifestBytes);
  if(manifest.segments.some(segment=>url.pathname===segment.url))return send(res,200,bytes,'audio/wav',{'ETag':`"${audioHash}"`});
  return send(res,404,{error:'Audio test route not found'});
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
 return {origin:`http://127.0.0.1:${server.address().port}`,profile,book,job,manifest,manifestSha256,audioSha256:audioHash,requests,close:()=>new Promise((resolve,reject)=>{server.closeAllConnections();server.close(error=>error?reject(error):resolve());})};
}
async function main(){
 const args=process.argv.slice(2),values={};for(let index=0;index<args.length;index+=2){if(!['--sample','--ready','--port','--chapter-batches'].includes(args[index])||args[index+1]===undefined)throw Error('Usage: --sample <wav> --ready <json> --port <0..65535> [--chapter-batches true]');values[args[index]]=args[index+1];}if(values['--chapter-batches']!==undefined&&values['--chapter-batches']!=='true')throw Error('Explicit chapter-batches mode must be true');
 const port=values['--port']===undefined?0:Number(values['--port']);if(!Number.isSafeInteger(port)||port<0||port>65535)throw Error('Invalid fixture port');
 const fixture=await createAudioClientFixture({samplePath:values['--sample']||defaultSample,port,chapterBatches:values['--chapter-batches']==='true'});
 const ready={schemaVersion:1,pid:process.pid,origin:fixture.origin,...AUDIO_FIXTURE,manifestSha256:fixture.manifestSha256,audioSha256:fixture.audioSha256,durationSeconds:fixture.manifest.segments[0].durationSeconds,chunkBytes:fixture.manifest.segments[0].bytes};
 if(values['--ready']){const file=path.resolve(values['--ready']),relative=path.relative(workspace,file);if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('Fixture reports must stay in this workspace');await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(ready,null,2));}
 process.stdout.write(JSON.stringify(ready)+'\n');let closing=false;for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{if(closing)return;closing=true;fixture.close().then(()=>process.exit(0));});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(error=>{process.stderr.write(String(error.stack)+'\n');process.exit(1);});
