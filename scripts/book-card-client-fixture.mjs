// Loopback-only synthetic catalogue for the existing isolated Windows check.
// It has no acquisition adapter, production credentials or model executor.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {createAudioClientFixture,AUDIO_FIXTURE} from './audio-client-fixture.mjs';
import {syntheticWav} from './discovery-client-fixture.mjs';
import {validateSerialGroupsResponse} from '../src/serial-groups.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const uuid=(family,index)=>`${family}000000-0000-4000-8000-${String(index).padStart(12,'0')}`;
const now='2026-10-24T00:00:00.000Z';
export async function createBookCardClientFixture({samplePath,port=0}={}){
 if(!samplePath)throw Error('An explicitly owned synthetic WAV is required');
 const audio=await createAudioClientFixture({samplePath}),profile=audio.profile,packets=new Map(),groups=[];
 function packet(id,title,count,{offset=0,serial=null,branch='Основной перевод',ordinary=false}={}){
  const content={title,author:'Синтетический автор',language:'ru',assets:{},chapters:Array.from({length:count},(_,i)=>({title:`Глава ${offset+i+1}`,blocks:[{type:'text',text:`BOOK-CARD-${id}-CHAPTER-${offset+i+1}`},...Array.from({length:32},(_,j)=>({type:'text',text:`Синтетический абзац ${j+1} для проверки главы ${offset+i+1}. `.repeat(7)}))]}))};
  const bytes=Buffer.from(JSON.stringify(content)),digest=sha(bytes),book={id,title,author:content.author,language:'ru',chapter_count:count,security_state:'passed',content_sha256:digest,content_bytes:bytes.length,sha256:digest,shelf:'planned',created_at:now,work_id:ordinary?AUDIO_FIXTURE.workId:uuid('c2',serial||50),expression_id:ordinary?AUDIO_FIXTURE.expressionId:uuid('c3',serial||50),edition_id:ordinary?AUDIO_FIXTURE.editionId:uuid('c4',serial||50),...(serial?{serial_feed_id:uuid('c5',serial),serial_branch:branch}:{})};
  const value={book,content,bytes};packets.set(id,value);return value;
 }
 function serial({index,title,branch='Основной перевод',counts=[2,2],offsets=[0,2],total=4,status='ready'}){
  const parts=counts.map((count,i)=>packet(uuid('c1',index*10+i+1),`${title} · часть ${i+1}`,count,{offset:offsets[i],serial:index,branch}));
  const group={schemaVersion:1,id:uuid('c5',index),snapshotId:uuid('c6',index),provider:'ranobelib',title,author:'Синтетический автор',language:'ru',branch,snapshotStatus:status,inventorySha256:sha(Buffer.from(`${index}:${branch}`)),totalChapters:total,parts:parts.map((row,i)=>({publicationId:row.book.id,chapterOffset:offsets[i],chapterCount:counts[i],contentSha256:row.book.content_sha256,packageSha256:sha(Buffer.from(`package:${row.book.id}`)),securityState:'passed'}))};groups.push(group);return group;
 }
 const complete=serial({index:1,title:'Атлас ветров'}),missing=serial({index:2,title:'Сад холодного солнца',counts:[1,1],offsets:[0,2],total:3,status:'building'}),otherBranch=serial({index:3,title:'Атлас ветров',branch:'Другой перевод'});
 const ordinary=packet(AUDIO_FIXTURE.bookId,'Обычная книга для карточки',2,{ordinary:true});
 validateSerialGroupsResponse({schemaVersion:1,groups});
 const audioRequest={...await(await fetch(audio.origin+'/api/derived/requests')).json().then(rows=>rows[0]),title:ordinary.book.title,author:ordinary.book.author,profileId:profile.id,sourceLanguage:'ru',publicationIds:[ordinary.book.id],sourcePublicationIds:[ordinary.book.id],snapshotId:null,chapterRange:{start:1,count:2,total:2,hasMore:false,nextStart:null}};
 const requests=[],mutations=[],downloads=new Map(),devices=new Map(),receipts=new Map(),entities=new Map();let revision=0;
 const configuration={schemaVersion:1,kind:'gargantua-book-card-selfcheck',profileId:profile.id,ordinaryId:ordinary.book.id,audioJobId:AUDIO_FIXTURE.jobId,audioRequestId:AUDIO_FIXTURE.requestId,audioSha256:audio.audioSha256,audioManifestSha256:audio.manifestSha256,groups:groups.map(group=>({id:group.id,snapshotId:group.snapshotId,title:group.title,branch:group.branch,totalChapters:group.totalChapters,status:group.snapshotStatus,publicationIds:group.parts.map(part=>part.publicationId),representativeId:group.parts[0].publicationId})),books:[...packets.values()].map(row=>({id:row.book.id,chapters:row.book.chapter_count,sha256:row.book.content_sha256,bytes:row.bytes.length})),completeId:complete.id,missingId:missing.id,otherBranchId:otherBranch.id};
 const send=(res,status,value,headers={})=>{const bytes=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value));res.writeHead(status,{'Content-Type':'application/json','Content-Length':bytes.length,'X-Content-SHA256':sha(bytes),'Cache-Control':'no-store',...headers});res.end(bytes);};
 const read=async req=>{const chunks=[];let count=0;for await(const chunk of req){count+=chunk.length;if(count>262144)throw Error('Synthetic request limit');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));};
 const cursor=()=>Buffer.from(JSON.stringify({schemaVersion:1,profileId:profile.id,revision})).toString('base64url');
 const server=http.createServer(async(req,res)=>{try{
  const url=new URL(req.url,'http://127.0.0.1');requests.push({method:req.method,path:url.pathname});if(requests.length>10000)throw Error('Synthetic request count limit');
  if(['/test/status','/api/fixture/book-card-state'].includes(url.pathname))return send(res,200,{schemaVersion:1,requests,mutations,downloads:Object.fromEntries(downloads),unexpectedGeneration:requests.filter(row=>row.method==='POST'&&['/api/derived/requests','/api/discovery/requests'].includes(row.path)).length});
  if(url.pathname==='/api/fixture/book-card')return send(res,200,configuration);
  if(url.pathname==='/api/me')return send(res,200,profile,{'Set-Cookie':'cotology=book-card-fixture; HttpOnly; SameSite=Strict; Path=/'});
  if(url.pathname==='/api/books')return send(res,200,[...packets.values()].map(row=>row.book));
  if(url.pathname==='/api/library/serial-groups')return send(res,200,{schemaVersion:1,groups});
  if(url.pathname==='/api/derived/requests')return req.method==='GET'?send(res,200,[audioRequest]):send(res,409,{error:'Generation is forbidden in book card acceptance'});
  if(url.pathname===`/api/derived/requests/${AUDIO_FIXTURE.requestId}`)return send(res,200,audioRequest);
  if(url.pathname==='/api/discovery/requests')return req.method==='GET'?send(res,200,[]):send(res,409,{error:'Acquisition is forbidden in book card acceptance'});
  const match=/^\/api\/books\/([a-f0-9-]{36})(?:\/(download|chapters\/([0-9]+)))?$/.exec(url.pathname);
  if(match&&packets.has(match[1])){const row=packets.get(match[1]);if(match[2]==='download'){downloads.set(match[1],(downloads.get(match[1])||0)+1);return send(res,200,row.bytes);}if(match[3]!==undefined){const chapter=row.content.chapters[Number(match[3])];return chapter?send(res,200,chapter):send(res,404,{error:'No synthetic chapter'});}return send(res,200,{book:row.book,chapters:row.content.chapters.map((chapter,index)=>({title:chapter.title,index})),reading:null,bookmarks:[]});}
  if(url.pathname==='/api/v2/reader/snapshot')return send(res,200,{schemaVersion:1,cursor:cursor(),entities:[...entities.values()],devices:[...devices].map(([deviceId,lastCounter])=>({deviceId,lastCounter,protocolVersion:2,compactedThrough:0,compactedCount:0}))});
  if(url.pathname==='/api/v2/reader/conflicts')return send(res,200,{conflicts:[],cursor:null,hasMore:false});
  if(url.pathname==='/api/v2/reader/mutations'&&req.method==='POST'){const body=await read(req),results=[];for(const mutation of body.mutations){mutations.push({entityType:mutation.entityType,entityId:mutation.entityId});const old=receipts.get(mutation.mutationId);if(old){results.push(old);continue;}const key=mutation.entityType+':'+mutation.entityId,current=entities.get(key),entity={entityType:mutation.entityType,entityId:mutation.entityId,revision:(current?.revision||0)+1,deleted:mutation.operation==='delete',payload:mutation.payload,updatedAt:now};entities.set(key,entity);devices.set(mutation.deviceId,mutation.counter);revision++;const value={mutationId:mutation.mutationId,status:'accepted',entity};results.push(value);receipts.set(mutation.mutationId,value);}return send(res,200,{schemaVersion:1,cursor:cursor(),results});}
  if(url.pathname==='/api/logout')return send(res,200,{ok:true});
  if(url.pathname.startsWith('/api/derived/')||['/api/status','/api/imports','/api/catalogs','/api/policy'].includes(url.pathname)){const response=await fetch(audio.origin+url.pathname);return send(res,response.status,Buffer.from(await response.arrayBuffer()),{'Content-Type':response.headers.get('Content-Type')||'application/json'});}
  return send(res,404,{error:'Synthetic book card route not available'});
 }catch(error){if(!res.headersSent)send(res,500,{error:String(error.message)});else res.destroy();}});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
 return {origin:`http://127.0.0.1:${server.address().port}`,configuration,packets,groups,close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await audio.close();}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const index=process.argv.indexOf('--ready'),ready=process.argv[index+1];if(index<0||!path.isAbsolute(ready))throw Error('An absolute owned fixture ready path is required');
 const samplePath=path.join(path.dirname(ready),'synthetic-book-card-tone.wav');await fs.writeFile(samplePath,syntheticWav());const fixture=await createBookCardClientFixture({samplePath});await fs.writeFile(ready,JSON.stringify({schemaVersion:1,pid:process.pid,origin:fixture.origin,scope:'SYNTHETIC_BOOK_CARD_NOT_LIVE_ACQUISITION_OR_TTS',...fixture.configuration}));
}
