import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createDiscoverySearch,canContinueDiscoveryPlan} from '../server/discovery-providers.mjs';
import {DISCOVERY_DEFAULTS,discoveryInput,discoveryRow,createdDiscovery,discoveryList,newestDiscoveryRow,pollingDiscovery,discoveryActions,candidateChoice,candidateNote,discoveryDecision,discoveryOutput,reserveDiscoverySubmission,discoveryStorageScope,discoveryPublicationIds,createDiscoveryController} from '../src/discovery-client.mjs';

const owner={id:randomUUID(),role:'owner'},reader={id:randomUUID(),role:'reader'};
const row=(changes={})=>({id:randomUUID(),requested_by:owner.id,revision:3,plan_revision:1,status:'needs-review',query_text:'Test Book',input:{...DISCOVERY_DEFAULTS,query:'Test Book'},import_id:null,plan:{candidates:[],clarifications:[],providerErrors:[],hasMore:false,plan:null},outputs:{book:{status:'needs-review'},translation:{status:'pending-provider',language:'ru'},audio:{status:'pending-provider'}},...changes});
function fixture({open=[],gut=[],ranobe=[],authors=[],works=[]}={}){
 let now=0;return createDiscoverySearch({clock:()=>now,sleep:async ms=>{now+=ms;},fetchSafe:async url=>{
  const parsed=new URL(url);let data;
  if(parsed.pathname==='/search.json')data={docs:open,numFound:open.length};
  else if(parsed.pathname==='/search/authors.json')data={docs:authors,numFound:authors.length};
  else if(/\/works\.json$/.test(parsed.pathname)){const offset=Number(parsed.searchParams.get('offset')||0),limit=Number(parsed.searchParams.get('limit')||10);data={entries:works.slice(offset,offset+limit),size:100};}
  else if(parsed.hostname==='gutendex.com')data={results:gut,count:gut.length,next:null};
  else data={data:ranobe};
  return {buffer:Buffer.from(JSON.stringify(data)),type:'application/json',url};
 }});
}
const gut=(changes={})=>({id:11,title:'Test Book',authors:[{name:'Test Author'}],languages:['ru'],copyright:false,media_type:'Text',formats:{'application/epub+zip':'https://www.gutenberg.org/cache/epub/11/pg11-images.epub'},...changes});

test('server query forms preserve intention and exclude URL/source objects',()=>{
 for(const [intent,query] of [['auto','Коты-воители'],['book','Свидание с Рамой'],['author','Артур Кларк'],['series','Коты-воители']])assert.deepEqual(discoveryInput({query,intent,downloadUrl:'https://untrusted.test',candidate:{url:'file:///x'}}),{query,intent,language:'ru',allowOriginal:false,audio:true});
 assert.equal(discoveryInput({query:'  Two   words  '}).query,'Two words');
 assert.equal(discoveryInput({query:'Title\nline'}).query,'Title line');
 for(const query of ['x','x'.repeat(301),'Title\u202e','https://evil.test/a.epub','www.evil.test','file:///a'])assert.throws(()=>discoveryInput({query}));
 for(const changes of [{intent:'url'},{audio:'true'},{allowOriginal:1},{language:'ru-RU'}])assert.throws(()=>discoveryInput({query:'Book',...changes}));
});
test('create envelopes and raw list/detail rows match the durable API, not the legacy array',()=>{
 const value=row();assert.equal(createdDiscovery({request:value,reused:true,idempotent:false}),value);assert.equal(discoveryRow(value),value);assert.deepEqual(discoveryList([value]),[value]);
 for(const bad of [value,[],{request:{...value,status:'ready'}},{request:{...value,plan_revision:undefined}}])assert.throws(()=>createdDiscovery(bad));
 assert.throws(()=>discoveryList({requests:[value]}));assert.throws(()=>discoveryList(Array(101).fill(value)));
});
test('real Ranobe card enables only metadata/branch preview, never direct acquisition',async()=>{
 const plan=await fixture({ranobe:[{slug_url:'123--test-book',rus_name:'Книга',name:'Test Book'}]})('Книга');
 const card=plan.candidates.find(item=>item.identity.provider==='ranobelib');assert.equal(card.blockedReason,'SOURCE_LANGUAGE_UNKNOWN');assert.equal(candidateChoice(card).kind,'expand');
 const request=row({plan});const body=discoveryDecision(request,'select',{candidateId:card.id,url:'https://evil.test',branchId:99});
 assert.deepEqual(body,{action:'select',expectedRevision:3,planRevision:1,candidateId:card.id});assert.match(candidateNote(card),/Язык/);
});
test('full-branch UI keeps two translation branches distinct and sends only the persisted candidate ID',()=>{
 // Shape emitted by buildDiscoveryPlan after resolveRanobe/selectRanobeBranch.
 const branch=(branchId,label)=>({id:'dsc_branch'+branchId,kind:'book',title:'Книга',identity:{provider:'ranobelib',remoteId:'123'},availability:'ranobe-full',eligibleForAcquisition:true,downloadSelections:[],branchLabel:label,chapterCount:27,sourceBinding:{provider:'ranobelib',remoteId:'123',slug:'123--test-book',branchId,completeness:{verified:true}}});
 const a=branch(1,'Перевод А'),b=branch(2,'Перевод Б'),request=row({plan:{candidates:[a,b]}});
 assert.equal(candidateChoice(a).kind,'acquire');assert.notEqual(discoveryDecision(request,'select',{candidateId:a.id}).candidateId,discoveryDecision(request,'select',{candidateId:b.id}).candidateId);
 assert.equal(candidateChoice({...a,sourceBinding:{...a.sourceBinding,completeness:{verified:false}}}),null);
 assert.throws(()=>discoveryDecision(request,'select',{candidateId:'missing'}));
});
test('real catalogue records are source lookups; contradictory or already-expanded metadata cannot download',async()=>{
 const plan=await fixture({open:[{key:'/works/OL1W',title:'Test Book',author_name:['Test Author'],language:['eng']}]})('Test Book');
 const book=plan.candidates[0];assert.equal(book.availability,'metadata-only');assert.equal(book.blockedReason,'ORIGINAL_NOT_ALLOWED');assert.equal(candidateChoice(book).kind,'expand');
 assert.equal(candidateChoice({...book,sourceResolutionAttempted:true}),null);assert.equal(candidateChoice({...book,conflictingMetadata:true}),null);assert.equal(candidateChoice({...book,identityEvidenceIncomplete:true}),null);
 const downloadable=await fixture({gut:[gut()]})('Test Book');assert.equal(candidateChoice(downloadable.candidates[0]).kind,'acquire');
 const restricted=await fixture({gut:[gut({copyright:true})]})('Test Book');assert.equal(candidateChoice(restricted.candidates[0]),null);
 const noOriginal=await fixture({gut:[gut({languages:['en']})]})('Test Book');assert.equal(candidateChoice(noOriginal.candidates[0]),null);
});
test('real series plan offers individual tomes and hasMore alone never invents pagination',async()=>{
 const plan=await fixture()('серия Коты воители'),request=row({plan});
 assert.equal(plan.plan.items.length,6);assert.ok(plan.candidates.every(item=>candidateChoice(item).kind==='expand'));assert.equal(discoveryActions(request,owner).more,false);
 assert.equal(discoveryActions(row({plan:{...plan,hasMore:true}}),owner).more,false);
});
test('real author continuation is nested in plan.plan; selection/more carry both current revisions',async()=>{
 const search=fixture({authors:[{key:'OL2623461A',name:'Arthur C. Clarke',top_work:'Rendezvous with Rama'}],works:Array.from({length:30},(_,index)=>({key:`/works/OL${index+3}W`,title:'Test work '+index}))});
 const plan=await search('все книги автора Артура Кларка'),request=row({revision:9,plan_revision:4,plan});
 assert.equal(plan.plan.kind,'author');assert.equal(canContinueDiscoveryPlan(plan),true);assert.equal(discoveryActions(request,owner).more,true);
 assert.deepEqual(discoveryDecision(request,'more'),{action:'more',expectedRevision:9,planRevision:4});
 assert.equal(discoveryActions({...request,plan:{...plan,continuationRequested:true}},owner).more,false);
 assert.equal(discoveryActions({...request,import_id:randomUUID()},owner).more,false);
});
test('retry, refine, approve and cancel capabilities reflect actual rows/role, not client desired status',()=>{
 const pending=row({status:'pending-approval',requested_by:reader.id});assert.equal(discoveryActions(pending,owner).approve,true);assert.equal(discoveryActions(pending,reader).approve,false);
 assert.equal(discoveryActions(row({status:'error'}),owner).retry,true);assert.equal(discoveryActions(row({status:'error',import_id:randomUUID()}),owner).retry,false);
 assert.equal(discoveryActions(row({status:'needs-review'}),owner).refine,true);assert.equal(discoveryActions(row({status:'book-ready'}),owner).cancel,false);assert.equal(discoveryActions(row(),reader).select,false);
 const refined=discoveryDecision(row(),'refine',{query:'Артур Кларк',intent:'author',audio:false,allowOriginal:true,expectedRevision:999});
 assert.deepEqual(refined,{action:'refine',expectedRevision:3,query:'Артур Кларк',intent:'author',language:'ru',audio:false,allowOriginal:true});
 for(const status of ['pending-approval','queued','processing','selected','acquiring'])assert.equal(pollingDiscovery(row({status})),true);
 for(const status of ['needs-review','cancelled','error'])assert.equal(pollingDiscovery(row({status})),false);
 assert.equal(pollingDiscovery(row({status:'book-ready',outputs:{book:{status:'ready'},audio:{status:'ready'},translation:{status:'not-required'}}})),false);
});
test('late poll cannot regress a newer decision revision or change a different request',()=>{
 const before=row({revision:5}),after={...before,revision:6,status:'cancelled'};
 assert.equal(newestDiscoveryRow(after,before),after);assert.equal(newestDiscoveryRow(before,after),after);
 const another=row();assert.equal(newestDiscoveryRow(after,another),another);
});
test('book-ready never claims that pending translation or TTS is ready',()=>{
 const value=discoveryOutput(row({status:'book-ready',outputs:{book:{status:'ready',publicationId:randomUUID()},translation:{status:'pending-provider'},audio:{status:'pending-provider'}}}));
 assert.equal(value.ready,true);assert.match(value.audio,/ещё не запущено/);assert.match(value.translation,/ещё не запущен/);
 assert.match(discoveryOutput(row({outputs:{audio:{status:'not-requested'},translation:{status:'not-required'}}})).audio,/не запрашивалось/);
});
test('uncertain submit and reopened dialog reuse durable key; changed options get a new key',async()=>{
 const map=new Map(),storage={get:async key=>map.get(key),put:async(key,value)=>{map.set(key,structuredClone(value));}},a=randomUUID(),b=randomUUID();let made=0;
 const first=await reserveDiscoverySubmission(storage,owner.id,{query:'Book'},()=>{made++;return a;});
 const retry=await reserveDiscoverySubmission(storage,owner.id,{query:'  Book  '},()=>{throw Error('must reuse');});assert.deepEqual(retry,first);assert.equal(made,1);
 const changed=await reserveDiscoverySubmission(storage,owner.id,{query:'Book',allowOriginal:true},()=>b);assert.equal(changed.body.idempotencyKey,b);
 await assert.rejects(()=>reserveDiscoverySubmission(storage,null,{query:'Book'}),/нужен вход/);
 assert.notEqual((await reserveDiscoverySubmission(storage,reader.id,{query:'Book'},()=>randomUUID())).key,first.key);
});
test('storage failure prevents a submit ticket from being returned',async()=>{
 await assert.rejects(()=>reserveDiscoverySubmission({get:async()=>null,put:async()=>{throw Error('disk full');}},owner.id,{query:'Book'},randomUUID),/disk full/);
});

function memoryStorage(){const map=new Map();return {map,get:async key=>copy(map.get(key)),put:async(key,value)=>{map.set(key,copy(value));},remove:async key=>{map.delete(key);}};}
const copy=value=>value===undefined?undefined:structuredClone(value);
const serverIdentity='http://127.0.0.1:14000';
const controller=(api,storage=memoryStorage(),extra={})=>createDiscoveryController({api,storage,profile:owner,serverIdentity,...extra});
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}

test('durable tickets isolate profile, server and exact options; A-B-A does not lose an uncertain key',async()=>{
 const storage=memoryStorage(),a=await reserveDiscoverySubmission(storage,owner.id,{query:'Книга'},randomUUID,serverIdentity);
 const b=await reserveDiscoverySubmission(storage,owner.id,{query:'Другая книга'},randomUUID,serverIdentity);
 const repeat=await reserveDiscoverySubmission(storage,owner.id,{query:'Книга'},()=>{throw Error('must reuse');},serverIdentity);
 assert.deepEqual(repeat,a);assert.notEqual(a.key,b.key);assert.ok(a.key.length<=220);
 for(const [profileId,address] of [[reader.id,serverIdentity],[owner.id,'https://reader.example']])assert.notEqual((await reserveDiscoverySubmission(storage,profileId,{query:'Книга'},randomUUID,address)).body.idempotencyKey,a.body.idempotencyKey);
 assert.equal(await discoveryStorageScope(owner.id,'https://reader.example/'),await discoveryStorageScope(owner.id,'https://reader.example:443'));
 for(const address of ['file:///tmp/x','https://user:pass@example.test','https://example.test/other','https://example.test/?secret=x'])await assert.rejects(()=>discoveryStorageScope(owner.id,address));
});

test('concurrent reservation of the same input persists one key before either caller can send',async()=>{
 const storage=memoryStorage();let made=0;const makeId=()=>{made++;return randomUUID();};
 const [a,b]=await Promise.all([reserveDiscoverySubmission(storage,owner.id,{query:'Книга'},makeId,serverIdentity),reserveDiscoverySubmission(storage,owner.id,{query:'Книга'},makeId,serverIdentity)]);
 assert.deepEqual(a,b);assert.equal(made,1);
});

test('book readiness, multipart parts and derived output labels remain independent',()=>{
 const ids=[randomUUID(),randomUUID()],request=row({status:'book-ready',outputs:{book:{status:'ready',multipart:true,publicationIds:ids},audio:{status:'processing'},translation:{status:'not-required'}}});
 assert.deepEqual(discoveryPublicationIds(request),ids);assert.equal(discoveryOutput(request).ready,true);assert.equal(discoveryOutput(request).audioReady,false);assert.equal(pollingDiscovery(request),true);
 for(const status of ['pending-provider','queued','processing','paused','approval-required','waiting-translation','waiting-provider']){
  const value={...request,outputs:{...request.outputs,audio:{status}}};assert.equal(pollingDiscovery(value),true);assert.ok(discoveryOutput(value).audio);
 }
 for(const status of ['needs-language','unsupported','blocked','failed','cancelled','ready']){
  const value={...request,outputs:{...request.outputs,audio:{status}}};assert.equal(pollingDiscovery(value),false);assert.ok(discoveryOutput(value).audio);
 }
 for(const value of [{status:'ready',multipart:true,publicationIds:[ids[0],ids[0]]},{status:'ready',multipart:true,publicationId:ids[0]},{status:'ready',publicationId:'bad'},{status:'pending',publicationId:ids[0]}])assert.deepEqual(discoveryPublicationIds({outputs:{book:value}}),[]);
 assert.match(discoveryOutput({...request,outputs:{audio:{status:'waiting-translation'}}}).audio,/после завершения перевода/);
});

test('lost create response survives controller recreation and reuses the reserved key',async()=>{
 const storage=memoryStorage(),created=row({status:'queued'}),bodies=[];
 let client=controller(async(path,options)=>{assert.equal(path,'/discovery/requests');bodies.push(copy(options.body));throw Error('Connection lost');},storage);
 await assert.rejects(()=>client.submit({query:'Книга'}),/Connection lost/);client.dispose();
 client=controller(async(path,options)=>{bodies.push(copy(options.body));return {request:created};},storage);
 await client.submit({query:'Книга'});assert.equal(bodies[0].idempotencyKey,bodies[1].idempotencyKey);assert.equal(client.getState().selected.id,created.id);
 assert.equal([...storage.map.keys()].filter(key=>key.includes(':submit:')).length,0);client.dispose();
});

test('failed durable receipt keeps the idempotency key even after server success',async()=>{
 const storage=memoryStorage(),put=storage.put;storage.put=async(key,value)=>{if(key.endsWith(':state'))throw Error('disk full');return put(key,value);};
 const client=controller(async()=>({request:row({status:'queued'})}),storage);
 await assert.rejects(()=>client.submit({query:'Книга'}),/disk full/);
 assert.equal([...storage.map.keys()].filter(key=>key.includes(':submit:')).length,1);client.dispose();
});

test('storage reservation failure and overlapping actions cannot cause a POST',async()=>{
 let calls=0;const bad=controller(async()=>{calls++;},{get:async()=>null,put:async()=>{throw Error('disk full');}});
 await assert.rejects(()=>bad.submit({query:'Книга'}),/disk full/);assert.equal(calls,0);bad.dispose();
 const pending=deferred(),client=controller(async()=>{calls++;return pending.promise;});
 const first=client.submit({query:'Книга'});await new Promise(resolve=>setTimeout(resolve,5));
 await assert.rejects(()=>client.submit({query:'Книга'}),error=>error.code==='DISCOVERY_CLIENT_BUSY');
 pending.resolve({request:row({status:'queued'})});await first;assert.equal(calls,1);client.dispose();
});

test('controller resumes its cached selected request offline without cross-server or profile leakage',async()=>{
 const storage=memoryStorage(),first=row({created_at:'2026-10-23T12:00:00Z'}),second=row({created_at:'2026-10-23T11:00:00Z'});let client=controller(async()=>[first,second],storage);
 await client.list({initial:true});await client.flush();client.dispose();
 client=controller(async()=>{throw Error('offline');},storage);await client.restore();assert.equal(client.getState().selected.id,first.id);
 await assert.rejects(()=>client.select(second.id),/offline/);assert.equal(client.getState().selected.id,second.id);assert.equal(client.getState().offline,true);client.dispose();
 for(const extra of [{profile:reader},{serverIdentity:'https://elsewhere.test'}]){const other=controller(async()=>[],storage,extra);await other.restore();assert.equal(other.getState().rows.length,0);other.dispose();}
});

test('a stale decision gets one409 refresh and is never retried with the new revision',async()=>{
 const before=row({revision:3}),after={...before,revision:4,status:'cancelled'};let posts=0,gets=0;
 const client=controller(async(path,options)=>{if(options?.method==='POST'){posts++;assert.equal(options.body.expectedRevision,3);throw Object.assign(Error('changed'),{status:409});}if(path.endsWith(before.id)){gets++;return after;}return [before];});
 await client.list({initial:true});await assert.rejects(()=>client.decide('cancel'),error=>error.status===409);
 assert.equal(posts,1);assert.equal(gets,1);assert.equal(client.getState().selected.revision,4);assert.equal(client.getState().error.status,409);
 await assert.rejects(()=>client.decide('cancel'),/недоступно/);assert.equal(posts,1);client.dispose();
});

test('late polls and history refreshes cannot regress newer revisions or erase a freshly submitted request',async()=>{
 const first=row({revision:4,status:'queued'}),poll=deferred(),listing=deferred(),newRow=row({status:'queued'});let listCalls=0;
 const client=controller(async(path,options)=>{if(options?.method==='POST')return {request:newRow};if(path.endsWith(first.id))return poll.promise;if(++listCalls===1)return [first];return listing.promise;});
 await client.list({initial:true});const pollPromise=client.refresh();
 const listPromise=client.list();await client.submit({query:'Новая книга'});
 poll.resolve({...first,revision:3});listing.resolve([{...first,revision:2}]);await Promise.all([pollPromise,listPromise]);
 assert.equal(client.getState().selected.id,newRow.id);assert.equal(client.getState().rows.find(value=>value.id===first.id).revision,4);assert.ok(client.getState().rows.some(value=>value.id===newRow.id));client.dispose();
});

test('polling stops on auth failure, disposes timers and does not emit a response after disposal',async()=>{
 const timers=new Map();let next=0,calls=0;const callbacks=[];
 const client=controller(async path=>{calls++;if(path==='/discovery/requests')return [row({status:'queued'})];throw Object.assign(Error('login'),{status:401});},memoryStorage(),{setTimer:fn=>{timers.set(++next,fn);return next;},clearTimer:id=>timers.delete(id),onChange:state=>callbacks.push(state)});
 await client.list({initial:true});client.startPolling();assert.equal(timers.size,1);const tick=[...timers.values()][0];timers.clear();await tick();assert.equal(calls,2);assert.equal(timers.size,0);assert.equal(client.getState().error.status,401);
 client.startPolling();assert.equal(timers.size,1);client.dispose();assert.equal(timers.size,0);
 const pending=deferred();let emissions=0;const late=controller(async()=>pending.promise,memoryStorage(),{onChange:()=>{emissions++;}});const listing=late.list();late.dispose();const prior=emissions;pending.resolve([]);await listing;assert.equal(emissions,prior);
});

test('malformed and cross-profile API rows do not replace the saved search',async()=>{
 const saved=row();let response=[saved];const client=controller(async()=>response,memoryStorage(),{profile:{...owner,role:'reader'}});
 await client.list({initial:true});response=[{...saved,requested_by:reader.id,revision:4}];await assert.rejects(()=>client.list(),/другого профиля/);assert.equal(client.getState().selected.revision,3);
 response={requests:[saved]};await assert.rejects(()=>client.list(),/Некорректный список/);client.dispose();
});

test('unchanged polling does not rewrite the durable cache on every interval',async()=>{
 const value=row({status:'queued'}),storage=memoryStorage(),put=storage.put;let writes=0;storage.put=async(key,payload)=>{writes++;return put(key,payload);};
 const client=controller(async path=>path==='/discovery/requests'?[copy(value)]:copy(value),storage);
 await client.list({initial:true});assert.equal(writes,1);await client.refresh();await client.refresh();assert.equal(writes,1);
 value.revision++;await client.refresh();assert.equal(writes,2);client.dispose();
});

test('polling waits for each refresh and does not continue terminal language or finished outputs',async()=>{
 const value=row({status:'book-ready',outputs:{book:{status:'ready',publicationId:randomUUID()},translation:{status:'not-required'},audio:{status:'processing'}}}),pending=deferred(),timers=new Map();let counter=0,calls=0;
 const client=controller(async path=>{calls++;return path==='/discovery/requests'?[value]:pending.promise;},memoryStorage(),{setTimer:fn=>{timers.set(++counter,fn);return counter;},clearTimer:id=>timers.delete(id)});
 await client.list({initial:true});client.startPolling();const callback=[...timers.values()][0];timers.clear();const tick=callback();await Promise.resolve();assert.equal(timers.size,0);
 pending.resolve({...value,revision:4,outputs:{...value.outputs,audio:{status:'needs-language'}}});await tick;const terminalTick=[...timers.values()][0];timers.clear();await terminalTick();assert.equal(calls,2);client.dispose();
});

test('a late initial disk restore cannot overwrite a newly submitted search',async()=>{
 const old=row(),created=row({status:'queued'}),pending=deferred(),started=deferred(),storage=memoryStorage(),get=storage.get;
 storage.get=async key=>{if(key.endsWith(':state')){started.resolve();return pending.promise;}return get(key);};
 const client=controller(async()=>({request:created}),storage),restoring=client.restore();await started.promise;
 await client.submit({query:'Новая книга'});pending.resolve({schemaVersion:1,selectedId:old.id,rows:[old]});await restoring;
 assert.equal(client.getState().selected.id,created.id);assert.equal(client.getState().restored,true);client.dispose();
});
