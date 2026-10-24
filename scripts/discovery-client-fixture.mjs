// Synthetic loopback-only UI fixture. It never searches or downloads real books.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {createAudioClientFixture,AUDIO_FIXTURE} from './audio-client-fixture.mjs';
import {validateAudioManifest} from '../src/audio.mjs';

export const DISCOVERY_FIXTURE=Object.freeze({...AUDIO_FIXTURE,titleRequest:'d1000000-0000-4000-8000-000000000001',authorRequest:'d1000000-0000-4000-8000-000000000002',seriesRequest:'d1000000-0000-4000-8000-000000000003'});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
const now='2026-10-23T00:00:00.000Z';
const title='Цивилизация мудрецов';
const validRange=value=>value===undefined||value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===2&&Object.keys(value).every(key=>['start','count'].includes(key))&&Number.isInteger(value.start)&&value.start>=1&&value.start<=20000&&Number.isInteger(value.count)&&value.count>=1&&value.count<=5;
export function syntheticWav(){
 const sampleRate=22050,seconds=4,pcm=Buffer.alloc(44+sampleRate*seconds*2);pcm.write('RIFF');pcm.writeUInt32LE(pcm.length-8,4);pcm.write('WAVEfmt ',8);pcm.writeUInt32LE(16,16);pcm.writeUInt16LE(1,20);pcm.writeUInt16LE(1,22);pcm.writeUInt32LE(sampleRate,24);pcm.writeUInt32LE(sampleRate*2,28);pcm.writeUInt16LE(2,32);pcm.writeUInt16LE(16,34);pcm.write('data',36);pcm.writeUInt32LE(pcm.length-44,40);for(let i=0;i<sampleRate*seconds;i++)pcm.writeInt16LE(Math.round(Math.sin(2*Math.PI*330*i/sampleRate)*3000),44+i*2);return pcm;
}
export async function createDiscoveryClientFixture({samplePath,port=0}={}){
 if(!samplePath)throw Error('An explicit owned synthetic sample is required');
 const audio=await createAudioClientFixture({samplePath}),profile=audio.profile;
 const content={title,author:'Синтетический тестовый автор',language:'ru',assets:{},chapters:[0,1].map(index=>({title:`Тестовая глава ${index+1}`,blocks:[{type:'text',text:index?'DISCOVERY-LAST-CHAPTER':'DISCOVERY-FIRST-CHAPTER'},...Array.from({length:35},(_,i)=>({type:'text',text:`Синтетический текст для проверки интерфейса, глава ${index+1}, абзац ${i+1}. `.repeat(5)}))]}))};
 const textBytes=Buffer.from(JSON.stringify(content)),book={...audio.book,title:content.title,author:content.author,chapter_count:2,content_sha256:sha(textBytes),content_bytes:textBytes.length,sha256:sha(textBytes)};
 const manifest=validateAudioManifest({...audio.manifest,sourceSha256:sha(textBytes)}),manifestBytes=Buffer.from(canonical(manifest));
 const libraryCandidate={id:'library-existing',kind:'book',title,authors:[{name:content.author}],languages:['ru'],availability:'library',bookId:book.id,identity:{provider:'library',remoteId:book.id},eligibleForAcquisition:true};
 const preview={id:'novel-preview',kind:'book',title,authors:[{name:content.author}],languages:['ru'],availability:'needs-preview',identity:{provider:'ranobelib',remoteId:'12991'},sourceBinding:{provider:'ranobelib',remoteId:'12991',slug:'12991--civilization-of-the-sages'}};
 const branches=[['branch-main',123,'Основной перевод'],['branch-other',124,'Альтернативный перевод']].map(([id,branchId,branchLabel])=>({...preview,id,branchLabel,chapterCount:2,availability:'ranobe-full',eligibleForAcquisition:true,sourceBinding:{...preview.sourceBinding,branchId,completeness:{verified:true}}}));
 const author={id:'author-clarke',kind:'author',title:'Arthur C. Clarke',topWork:'Свидание с Рамой',birthDate:'1917-12-16',identity:{provider:'openlibrary',remoteId:'OL2623461A'},availability:'metadata-only'};
 const authorWork={id:'author-rama',kind:'book',title:'Свидание с Рамой',originalTitle:'Rendezvous with Rama',authors:[{name:'Arthur C. Clarke'}],identity:{provider:'openlibrary',remoteId:'OL153998W'},availability:'metadata-only'};
 const series=Array.from({length:6},(_,i)=>({id:`warriors-volume-${i+1}`,kind:'book',title:['Стань диким!','Огонь и лёд','Лес секретов','Бушующая стихия','Опасная тропа','Битва за лес'][i],authors:[{name:'Эрин Хантер'}],identity:{provider:'curated',remoteId:`warriors:tpc:${i+1}`},availability:'metadata-only'}));
 const requests=[],rows=new Map(),keys=new Map(),createBodies=[],decisionBodies=[],derivedBodies=[],derivedKeys=new Map(),entities=new Map(),devices=new Map(),receipts=new Map();let revision=0,sequence=0,createLost=false,staleBranch=false,derivedLost=false,bookDownloads=0,derivedCreated=0;
 const fault={loseCreateOnce:false,staleBranchOnce:false,loseDerivedOnce:false};
 const response=(res,status,value,headers={})=>{const bytes=Buffer.isBuffer(value)?value:Buffer.from(canonical(value));res.writeHead(status,{'Content-Type':'application/json','Content-Length':bytes.length,'X-Content-SHA256':sha(bytes),'Cache-Control':'no-store',...headers});res.end(bytes);};
 const read=async req=>{const chunks=[];let size=0;for await(const c of req){size+=c.length;if(size>262144)throw Error('Fixture body cap');chunks.push(c);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));};
 const cursor=()=>Buffer.from(JSON.stringify({schemaVersion:1,profileId:profile.id,revision})).toString('base64url');
 const completed=async()=>({...((await(await fetch(audio.origin+'/api/derived/requests')).json())[0]),title,author:content.author,sourcePublicationIds:[book.id]});
 const rowFor=input=>{
  const kind=input.intent==='author'?'author':input.intent==='series'?'series':'book',id=kind==='author'?DISCOVERY_FIXTURE.authorRequest:kind==='series'?DISCOVERY_FIXTURE.seriesRequest:DISCOVERY_FIXTURE.titleRequest;
  const candidates=kind==='author'?[author]:kind==='series'?series:[preview];
  const plan={status:'needs_clarification',candidates,clarifications:[{message:kind==='author'?'Это автор книги «Свидание с Рамой»?':kind==='series'?'Выберите один том первого цикла.':'Проверьте название и выберите ветку перевода.'}],plan:kind==='series'?{kind:'series',title:'Коты-воители — первый цикл',scope:'first-arc-only',items:series.map((item,i)=>({candidateId:item.id,title:item.title,sequence:i+1}))}:null};
  return {id,requested_by:profile.id,query_text:input.query,input:{query:input.query,intent:input.intent,language:input.language,allowOriginal:input.allowOriginal,audio:input.audio,...(input.chapterRange?{chapterRange:input.chapterRange}:{})},status:'needs-review',revision:1,plan_revision:1,plan,outputs:{book:{status:'needs-review'},translation:{status:'pending-provider',language:'ru'},audio:{status:input.audio?'pending-provider':'not-requested'}},created_at:now,updated_at:now};
 };
 const server=http.createServer(async(req,res)=>{
  try{
   const url=new URL(req.url,'http://127.0.0.1');requests.push({method:req.method,path:url.pathname,sequence:++sequence});if(requests.length>4000)throw Error('Fixture request cap');
   if(['/test/status','/api/fixture/state'].includes(url.pathname))return response(res,200,{requests,createBodies,decisionBodies,derivedBodies,rows:[...rows.values()],bookDownloads,derivedCreated,createLost,staleBranch,derivedLost});
   if(url.pathname==='/api/fixture/fault'&&req.method==='POST'){Object.assign(fault,await read(req));return response(res,200,{ok:true});}
   if(url.pathname==='/api/me')return response(res,200,profile,{'Set-Cookie':'cotology=discovery-fixture-session; HttpOnly; SameSite=Strict; Path=/'});
   if(url.pathname==='/api/books')return response(res,200,[book]);
   if(url.pathname===`/api/books/${book.id}/download`){bookDownloads++;return response(res,200,textBytes);}
   if(url.pathname===`/api/books/${book.id}`)return response(res,200,{book,chapters:content.chapters.map((c,index)=>({title:c.title,index})),reading:null,bookmarks:[]});
   if(url.pathname.startsWith(`/api/books/${book.id}/chapters/`))return response(res,200,content.chapters[Number(url.pathname.split('/').at(-1))]);
   if(url.pathname==='/api/status')return response(res,200,{version:'discovery-synthetic-fixture',settings:{},statuses:[]});
   if(url.pathname==='/api/imports')return response(res,200,[]);if(url.pathname==='/api/catalogs')return response(res,200,{revision:0,catalogs:[]});if(url.pathname==='/api/logout')return response(res,200,{ok:true});
   if(url.pathname==='/api/discovery/requests'&&req.method==='GET')return response(res,200,[...rows.values()].reverse());
   if(url.pathname==='/api/discovery/requests'&&req.method==='POST'){
    const body=await read(req);createBodies.push(body);if(Object.keys(body).some(k=>!['idempotencyKey','query','intent','language','allowOriginal','audio','chapterRange'].includes(k))||!validRange(body.chapterRange))return response(res,400,{error:'Unsafe discovery create body'});
    const digest=canonical(body),old=keys.get(body.idempotencyKey);if(old&&old.digest!==digest)return response(res,409,{error:'idempotency',code:'DISCOVERY_IDEMPOTENCY'});
    let row;if(old)row=rows.get(old.id);else{row=[...rows.values()].find(r=>r.input.intent===body.intent&&r.query_text.toLowerCase()===body.query.toLowerCase());if(!row){row=rowFor(body);rows.set(row.id,row);}keys.set(body.idempotencyKey,{digest,id:row.id});}
    if(fault.loseCreateOnce&&!createLost){createLost=true;return response(res,503,{error:'Fixture: saved response was lost'});}return response(res,old?200:202,{request:row,idempotent:!!old,reused:!!old});
   }
   const discovery=/^\/api\/discovery\/requests\/([a-f0-9-]{36})(\/decision)?$/.exec(url.pathname);
   if(discovery&&rows.has(discovery[1])){
    const row=rows.get(discovery[1]);if(req.method==='GET')return response(res,200,row);
    const body=await read(req);decisionBodies.push({...body,requestId:row.id});if(Object.keys(body).some(k=>!['action','expectedRevision','planRevision','candidateId','query','intent','language','allowOriginal','audio','chapterRange'].includes(k))||!validRange(body.chapterRange))return response(res,400,{error:'Unsafe decision body'});
    if(body.expectedRevision!==row.revision||body.action==='select'&&body.planRevision!==row.plan_revision)return response(res,409,{error:'Заявка уже изменилась. Обновите её.',code:'DISCOVERY_CONFLICT'});
    if(body.action==='select'){
     if(!row.plan.candidates.some(c=>c.id===body.candidateId))return response(res,400,{error:'Unknown stored candidate'});
     if(body.candidateId==='novel-preview'){row.plan={...row.plan,candidates:branches};row.plan_revision++;}
     else if(body.candidateId==='branch-main'||body.candidateId==='branch-other'){
      if(fault.staleBranchOnce&&!staleBranch){staleBranch=true;row.revision++;row.updated_at=new Date().toISOString();return response(res,409,{error:'Ветка обновилась. Уточните выбор.',code:'DISCOVERY_CONFLICT'});}
      row.selected_candidate_id=body.candidateId;row.status='book-ready';if(row.input.audio)derivedCreated=1;row.outputs={book:{status:'ready',publicationId:book.id},translation:{status:'not-required',language:'ru'},audio:row.input.audio?{status:'ready',jobId:AUDIO_FIXTURE.jobId,requestId:AUDIO_FIXTURE.requestId,jobStatus:'completed',requestStatus:'completed',completedSegments:2,totalSegments:2}:{status:'not-requested'}};
     }else if(body.candidateId==='author-clarke'){row.plan={...row.plan,candidates:[authorWork],clarifications:[{message:'Ограниченная выборка произведений этого автора.'}],plan:{kind:'author',title:'Arthur C. Clarke',items:[{title:authorWork.title,candidateId:authorWork.id,firstPublicationYear:1973}]}};row.plan_revision++;}
     else{row.plan={...row.plan,candidates:[{...libraryCandidate,id:'selected-volume',title:row.plan.candidates.find(c=>c.id===body.candidateId).title}],clarifications:[{message:'Выбран один том; остальные не скачиваются автоматически.'}]};row.plan_revision++;}
    }else if(body.action==='refine'){row.input={...row.input,...Object.fromEntries(['query','intent','language','allowOriginal','audio','chapterRange'].filter(k=>body[k]!==undefined).map(k=>[k,body[k]]))};row.query_text=row.input.query;row.plan={...row.plan,candidates:[preview]};row.plan_revision++;}
    else if(body.action==='cancel')row.status='cancelled';
    row.revision++;row.updated_at=new Date().toISOString();return response(res,200,row);
   }
   if(url.pathname==='/api/derived/requests'){
    if(req.method==='GET')return response(res,200,derivedCreated?[await completed()]:[]);
    const body=await read(req);derivedBodies.push(body);if(body.kind!=='audio'||body.sourceLanguage!=='ru'||body.publicationIds?.length!==1||body.publicationIds[0]!==book.id||typeof body.idempotencyKey!=='string')return response(res,400,{error:'Unexpected automatic audio request'});
    const digest=canonical(body),old=derivedKeys.get(body.idempotencyKey);if(old&&old!==digest)return response(res,409,{error:'Audio idempotency'});if(!old){derivedKeys.set(body.idempotencyKey,digest);derivedCreated++;}
    if(fault.loseDerivedOnce&&!derivedLost){derivedLost=true;return response(res,503,{error:'Fixture: audio saved response was lost'});}return response(res,200,{request:await completed(),reused:!!old});
   }
   if(url.pathname===`/api/derived/requests/${AUDIO_FIXTURE.requestId}`)return response(res,200,await completed());
   if(url.pathname===`/api/derived/jobs/${AUDIO_FIXTURE.jobId}/result`)return response(res,200,manifestBytes);
   if(url.pathname.startsWith('/api/derived/')){const result=await fetch(audio.origin+url.pathname);return response(res,result.status,Buffer.from(await result.arrayBuffer()),{'Content-Type':result.headers.get('content-type')||'application/json'});}
   if(url.pathname==='/api/v2/reader/snapshot')return response(res,200,{schemaVersion:1,cursor:cursor(),entities:[...entities.values()],devices:[...devices].map(([deviceId,lastCounter])=>({deviceId,lastCounter,protocolVersion:2,compactedThrough:0,compactedCount:0}))});
   if(url.pathname==='/api/v2/reader/conflicts')return response(res,200,{conflicts:[],cursor:null,hasMore:false});
   if(url.pathname==='/api/v2/reader/mutations'&&req.method==='POST'){
    const body=await read(req),results=[];for(const mutation of body.mutations){const old=receipts.get(mutation.mutationId);if(old){results.push(old);continue;}const key=mutation.entityType+':'+mutation.entityId,current=entities.get(key),entity={entityType:mutation.entityType,entityId:mutation.entityId,revision:(current?.revision||0)+1,deleted:mutation.operation==='delete',payload:mutation.payload,updatedAt:now};entities.set(key,entity);devices.set(mutation.deviceId,mutation.counter);revision++;const result={mutationId:mutation.mutationId,status:'accepted',entity};results.push(result);receipts.set(mutation.mutationId,result);}return response(res,200,{schemaVersion:1,cursor:cursor(),results});
   }
   return response(res,404,{error:'Discovery fixture route not implemented',path:url.pathname});
  }catch(error){if(!res.headersSent)response(res,500,{error:String(error.message)});else res.destroy();}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
 return {origin:`http://127.0.0.1:${server.address().port}`,profile,book,manifest,close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await audio.close();}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const index=process.argv.indexOf('--ready'),ready=process.argv[index+1];if(index<0||!path.isAbsolute(ready))throw Error('Absolute ready path required');const sample=path.join(path.dirname(ready),'synthetic-discovery-tone.wav');await fs.writeFile(sample,syntheticWav());const fixture=await createDiscoveryClientFixture({samplePath:sample});await fs.writeFile(ready,JSON.stringify({pid:process.pid,origin:fixture.origin,...DISCOVERY_FIXTURE,audioQuality:'SYNTHETIC_TONE_NOT_NARRATION_OR_FRESH_TTS'}));
}
