// Actual application HTTP, sessions/CSRF, disposable PostgreSQL schema and
// immutable publication files. No worker, remote provider or production DB.
import test,{before,beforeEach,afterEach,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import pg from 'pg';
import {applyMigrations} from '../server/migrations.mjs';
import {passwordHash} from '../server/security.mjs';
import {claimImport,markPrepared,publishImport} from '../server/import-jobs.mjs';
import {stagePublication,placePublication,digest} from '../server/publication-files.mjs';
import {CATALOG_ENTITY_ID,readerMutationIdV2} from '../server/reader-data-model.mjs';
import {createReaderExport,parseReaderExport,MAX_READER_EXPORT_BYTES} from '../server/reader-export.mjs';

const database=new URL(process.env.TEST_DATABASE_URL||'postgres://invalid/disabled');
if(process.env.GARGANTUA_TEST_ISOLATED!=='1'||!/^\/gargantua_test_[a-z0-9_]+$/.test(database.pathname))throw Error('Explicit isolated TEST_DATABASE_URL required; refusing production');
const schema='reader_api_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:database.href,max:1,statement_timeout:15000});
const isolated=new URL(database);isolated.searchParams.set('options',`-c search_path=${schema}`);
const pool=new pg.Pool({connectionString:isolated.href,max:6,statement_timeout:15000});
const owner={id:randomUUID(),login:'reader_api_owner'},reader={id:randomUUID(),login:'reader_api_reader'},other={id:randomUUID(),login:'reader_api_other'};
const password='synthetic-reader-api-password-12345',origin='http://gargantua-reader-isolated.test',appUrl=new URL('../server/app.mjs',import.meta.url).href;
const text='😀 Проверочный текст для безопасного якоря.';
const content={title:'Синтетическая книга HTTP',author:'Синтетический автор',language:'ru',assets:{},chapters:[{title:'Первая',blocks:[{type:'text',text}]},{title:'Вторая',blocks:[{type:'text',text:'Вторая глава.'}]}],structure:{schemaVersion:2,warnings:[],chapters:[{id:'first',revision:1,title:'Первая',blocks:[{id:'p1',type:'paragraph',text}]},{id:'second',revision:1,title:'Вторая',blocks:[{id:'p2',type:'paragraph',text:'Вторая глава.'}]}]}};
let created=false,root,library,child,base,hashed,publication;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);created=true;await applyMigrations(pool);hashed=await passwordHash(password);});
beforeEach(async()=>{
 await pool.query('TRUNCATE profiles,works RESTART IDENTITY CASCADE');await pool.query('UPDATE settings SET imports_paused=false,serving_paused=false WHERE id=1');
 for(const [profile,role]of [[owner,'owner'],[reader,'reader'],[other,'reader']])await pool.query('INSERT INTO profiles(id,login,password,role) VALUES($1,$2,$3,$4)',[profile.id,profile.login,hashed,role]);
 root=await fs.mkdtemp(path.join(os.tmpdir(),'gargantua-reader-api-'));library=path.join(root,'library');const quarantine=path.join(root,'quarantine');
 for(const directory of [library,path.join(quarantine,'incoming'),path.join(quarantine,'attempts')])await fs.mkdir(directory,{recursive:true,mode:0o700});
 const importId=randomUUID();await pool.query("INSERT INTO imports(id,requested_by,kind,filename,status,decision_reason) VALUES($1,$2,'upload','synthetic-reader.txt','queued','role-auto-approval')",[importId,owner.id]);
 const job=await claimImport(pool);assert.equal(job.id,importId);const prepared=await stagePublication(library,job.attempt_token,job.resultBookId,content);await markPrepared(pool,job,prepared.manifest);await placePublication(library,prepared);await markPrepared(pool,job,prepared.manifest,'placed');
 publication=await publishImport(pool,job,content,prepared,{sha256:digest(Buffer.from('Synthetic reader HTTP fixture original'))});
 const bootstrap=`import net from 'node:net';const listen=net.Server.prototype.listen;net.Server.prototype.listen=function(...args){if(args[0]===3080){args[0]=0;args[1]='127.0.0.1';this.once('listening',()=>console.log('ISOLATED_READER_HTTP_PORT:'+this.address().port));}return listen.apply(this,args);};await import(${JSON.stringify(appUrl)});`;
 child=spawn(process.execPath,['--input-type=module','-e',bootstrap],{env:{...process.env,DATABASE_URL:isolated.href,QUARANTINE_DIR:quarantine,LIBRARY_DIR:library,APP_ORIGIN:origin},stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='',spawnError;child.once('error',error=>{spawnError=error;});child.stdout.on('data',bytes=>{stdout=(stdout+bytes.toString()).slice(-8192);});child.stderr.on('data',bytes=>{stderr=(stderr+bytes.toString()).slice(-8192);});
 const deadline=Date.now()+20000;
 while(Date.now()<deadline){
  if(spawnError)throw spawnError;if(child.exitCode!==null||child.signalCode!==null)throw Error('Isolated reader API exited: '+stderr.slice(-1000));
  const match=stdout.match(/ISOLATED_READER_HTTP_PORT:(\d+)/);if(match){base='http://127.0.0.1:'+match[1];assert.equal((await fetch(base+'/api/health',{signal:AbortSignal.timeout(1000)})).status,200);return;}await pause(50);
 }
 throw Error('Isolated reader API did not start: '+stderr.slice(-1000));
});
afterEach(async()=>{
 if(child&&child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill('SIGTERM');await Promise.race([done,pause(3000)]);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await done;}}child=null;
 if(root){assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^gargantua-reader-api-[A-Za-z0-9]+$/);await fs.rm(root,{recursive:true,force:true});root=null;}
});
after(async()=>{await pool.end();try{if(created){assert.match(schema,/^reader_api_[a-f0-9]{32}$/);await admin.query(`DROP SCHEMA ${schema} CASCADE`);}}finally{await admin.end();}});

async function api(route,{method='GET',json,raw,session,headers={}}={}){
 const all={'X-Cotology':'1',Origin:origin,...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{}),...headers};
 if(json!==undefined||raw!==undefined)all['Content-Type']='application/json';
 return fetch(base+'/api'+route,{method,headers:all,body:raw!==undefined?raw:json===undefined?undefined:JSON.stringify(json),signal:AbortSignal.timeout(15000)});
}
async function value(response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json();}
async function login(profile=owner){
 const response=await api('/login',{method:'POST',json:{login:profile.login,password}});assert.equal(response.status,200);const cookie=response.headers.get('set-cookie').split(';')[0];assert.match(cookie,/^cotology=[a-f0-9]{64}$/);
 const me=await value(await api('/me',{session:{cookie,csrf:''}}));assert.equal(me.id,profile.id);assert.match(me.csrf,/^[a-f0-9]{64}$/);return {cookie,csrf:me.csrf};
}
const snapshot=async session=>value(await api('/v2/reader/snapshot',{session}));
const number=async(table,where='',parameters=[])=>Number((await pool.query(`SELECT count(*) AS n FROM ${table} ${where}`,parameters)).rows[0].n);
const locator=(extra={})=>({publicationId:publication,publicationRevision:1,chapterId:'first',blockId:'p1',offset:3,quote:{exact:'Проверочный текст',prefix:'😀 ',suffix:' для безопасного якоря.'},progression:0.2,...extra});
const payload=(extra={})=>({publicationId:publication,publicationRevision:1,locator:locator(),shelf:'reading',...extra});
const mutation=(extra={})=>({mutationId:randomUUID(),deviceId:randomUUID(),counter:1,entityType:'reading',entityId:publication,baseRevision:0,operation:'upsert',payload:payload(),...extra});
const mutate=async(session,changes)=>value(await api('/v2/reader/mutations',{method:'POST',session,json:{mutations:Array.isArray(changes)?changes:[changes]}}));
const bookmarkPayload=(note='Личная закладка')=>{const {shelf,...rest}=payload();return {...rest,note};};
const catalogs=(title='Моя серия')=>[{id:randomUUID(),title,parent:null,items:[{id:publication,scope:'server',title:content.title,author:content.author},{id:randomUUID(),scope:'device',title:'Только локальная книга',author:''}]}];

test('actual authentication, origin and CSRF guard reader snapshots and mutations',async()=>{
 assert.equal((await api('/v2/reader/snapshot')).status,401);const body={mutations:[mutation()]};assert.equal((await api('/v2/reader/mutations',{method:'POST',json:body})).status,401);
 const session=await login();for(const headers of [{'X-CSRF-Token':''},{'X-CSRF-Token':'invalid'},{Origin:'https://foreign.invalid'},{'X-Cotology':''}])assert.equal((await api('/v2/reader/mutations',{method:'POST',session,json:body,headers})).status,403);
 assert.equal(await number('reader_entities'),0);await pool.query('DELETE FROM sessions WHERE profile_id=$1',[owner.id]);assert.equal((await api('/v2/reader/snapshot',{session})).status,401);
});
test('legacy reading writes enter the revision feed and exact replay has no extra event',async()=>{
 const session=await login(),initial=await snapshot(session),body={chapter:1,position:0.37,shelf:'paused'},route=`/books/${publication}/reading`;
 assert.deepEqual(await value(await api(route,{method:'PUT',session,json:body})),{ok:true});assert.deepEqual(await value(await api(route,{method:'PUT',session,json:body})),{ok:true});
 const current=await snapshot(session);assert.equal(current.entities.length,1);assert.equal(current.entities[0].revision,1);assert.deepEqual(current.entities[0].payload.locator,{type:'legacy',chapter:1,position:0.37});
 const changes=await value(await api('/v2/reader/changes?cursor='+encodeURIComponent(initial.cursor),{session}));assert.equal(changes.changes.length,1);assert.equal(changes.changes[0].entity.payload.shelf,'paused');
 const book=await value(await api(`/books/${publication}`,{session}));assert.equal(book.reading.position,0.37);
});
test('legacy bookmark retry is idempotent, mismatched retry conflicts and deletion preserves tombstone',async()=>{
 const session=await login(),id=randomUUID(),route=`/books/${publication}/bookmarks`,body={id,chapter:0,position:0.2,note:'Нужное место'};
 assert.deepEqual(await value(await api(route,{method:'POST',session,json:body})),{id});assert.deepEqual(await value(await api(route,{method:'POST',session,json:body})),{id});
 assert.equal((await api(route,{method:'POST',session,json:{...body,note:'Изменённый повтор'}})).status,409);assert.equal(await number('bookmarks'),1);assert.equal(await number('reader_changes'),1);
 await value(await api(`/bookmarks/${id}`,{method:'DELETE',session}));await value(await api(`/bookmarks/${id}`,{method:'DELETE',session}));
 const entities=(await snapshot(session)).entities;assert.equal(entities.length,1);assert.equal(entities[0].deleted,true);assert.equal(entities[0].revision,2);assert.equal(await number('bookmarks'),0);assert.equal(await number('reader_changes'),2);
 assert.equal((await api(route,{method:'POST',session,json:body})).status,409);
});
test('modern canonical reading projects a legacy approximation while blind legacy overwrite is rejected',async()=>{
 const session=await login(),input=mutation(),first=await mutate(session,input);assert.equal(first.results[0].status,'accepted');
 const book=await value(await api(`/books/${publication}`,{session}));assert.equal(book.reading.chapter,0);assert.equal(book.reading.position,0,'publication-wide progression is not a legacy chapter scroll ratio');
 const response=await api(`/books/${publication}/reading`,{method:'PUT',session,json:{chapter:1,position:0.8,shelf:'finished'}});assert.equal(response.status,409);assert.equal((await response.json()).code,'READER_UPGRADE_REQUIRED');
 const current=(await snapshot(session)).entities[0];assert.equal(current.revision,1);assert.equal(current.payload.locator.offset,3);assert.equal(current.payload.locator.progression,0.2);assert.equal(current.payload.locator.chapterId,'first');
});
test('modern bookmark aliases remain readable to legacy clients and blind deletion cannot erase a newer anchor',async()=>{
 const session=await login(),id=randomUUID(),input=mutation({entityType:'bookmark',entityId:id,payload:bookmarkPayload()}),result=await mutate(session,input);assert.equal(result.results[0].status,'accepted');
 const book=await value(await api(`/books/${publication}`,{session}));assert.equal(book.bookmarks.length,1);assert.equal(book.bookmarks[0].note,'Личная закладка');
 const alias=book.bookmarks[0].id;assert.notEqual(alias,id);assert.equal((await api(`/bookmarks/${alias}`,{method:'DELETE',session})).status,409);assert.equal((await snapshot(session)).entities[0].deleted,false);
 const removed=await mutate(session,{...input,mutationId:randomUUID(),counter:2,baseRevision:1,operation:'delete',payload:undefined});assert.equal(removed.results[0].entity.deleted,true);assert.equal((await value(await api(`/books/${publication}`,{session}))).bookmarks.length,0);
});
test('legacy alias lookup cannot confuse one bookmark alias with another modern entity ID',async()=>{
 const session=await login(),device=randomUUID(),a=randomUUID();await mutate(session,mutation({deviceId:device,counter:1,entityType:'bookmark',entityId:a,payload:bookmarkPayload('Современная A')}));
 const alias=(await value(await api(`/books/${publication}`,{session}))).bookmarks[0].id;
 await mutate(session,mutation({deviceId:device,counter:2,entityType:'bookmark',entityId:alias,payload:bookmarkPayload('Современная B с ID псевдонима A')}));
 const deletion=await api(`/bookmarks/${alias}`,{method:'DELETE',session});assert.equal(deletion.status,409);assert.equal((await deletion.json()).code,'READER_UPGRADE_REQUIRED');
 assert.equal((await api(`/books/${publication}/bookmarks`,{method:'POST',session,json:{id:alias,chapter:0,position:0.3,note:'Устаревшая правка A'}})).status,409);
 const entities=(await snapshot(session)).entities;assert.equal(entities.length,2);assert.ok(entities.every(entity=>!entity.deleted));assert.equal(entities.find(entity=>entity.entityId===a).payload.note,'Современная A');assert.equal(entities.find(entity=>entity.entityId===alias).payload.note,'Современная B с ID псевдонима A');
});
test('legacy deletion before creation reserves a tombstone and rejects later stale creation',async()=>{
 const session=await login(),id=randomUUID();await value(await api(`/bookmarks/${id}`,{method:'DELETE',session}));
 const entity=(await snapshot(session)).entities[0];assert.equal(entity.entityId,id);assert.equal(entity.deleted,true);assert.equal(entity.payload,null);
 const stored=(await pool.query("SELECT legacy_id FROM reader_entities WHERE profile_id=$1 AND entity_type='bookmark' AND entity_id=$2",[owner.id,id])).rows[0];assert.equal(stored.legacy_id,id);
 assert.equal((await api(`/books/${publication}/bookmarks`,{method:'POST',session,json:{id,chapter:0,position:0,note:'Устаревшая офлайн-закладка'}})).status,409);assert.equal(await number('bookmarks'),0);assert.equal((await snapshot(session)).entities[0].revision,1);
});
test('legacy and modern catalog saves share the same CAS revision without uploading local books',async()=>{
 const session=await login(),first=catalogs('Серия A');assert.deepEqual(await value(await api('/catalogs',{method:'PUT',session,json:{revision:0,catalogs:first}})),{revision:1});
 const input=mutation({entityType:'catalog',entityId:CATALOG_ENTITY_ID,baseRevision:1,payload:{catalogs:catalogs('Серия B')}});assert.equal((await mutate(session,input)).results[0].entity.revision,2);
 assert.equal((await api('/catalogs',{method:'PUT',session,json:{revision:1,catalogs:first}})).status,409);const current=await value(await api('/catalogs',{session}));assert.equal(current.revision,2);assert.equal(current.catalogs[0].title,'Серия B');
 assert.deepEqual(await value(await api('/catalogs',{method:'PUT',session,json:{revision:2,catalogs:first}})),{revision:3});assert.equal((await snapshot(session)).entities[0].revision,3);assert.equal(await number('books'),1);assert.equal(await number('imports'),1);
});
test('exact mutation replay is stable, changed bodies fail and stale conflicts remain recoverable',async()=>{
 const session=await login(),input=mutation(),first=await mutate(session,input);assert.deepEqual(await mutate(session,input),first);assert.equal(await number('reader_mutations'),1);
 const changed=await api('/v2/reader/mutations',{method:'POST',session,json:{mutations:[{...input,payload:payload({shelf:'finished'})}]}});assert.equal(changed.status,409);assert.equal((await changed.json()).code,'READER_IDEMPOTENCY');
 const conflictInput=mutation({payload:payload({shelf:'paused'})}),conflict=await mutate(session,conflictInput);assert.equal(conflict.results[0].status,'conflict');assert.equal(conflict.results[0].current.revision,1);assert.equal(conflict.results[0].proposed.payload.shelf,'paused');
 const stored=await value(await api('/v2/reader/conflicts',{session}));assert.equal(stored.conflicts.length,1);assert.equal(stored.conflicts[0].mutationId,conflictInput.mutationId);assert.equal((await snapshot(session)).entities[0].payload.shelf,'reading');
});
test('private data stays profile-scoped even for owner and foreign cursor or body identity is rejected',async()=>{
 const ownerSession=await login(),readSession=await login(reader),otherSession=await login(other),id=randomUUID();
 await mutate(readSession,mutation({entityType:'bookmark',entityId:id,payload:bookmarkPayload('Секрет читателя')}));await mutate(otherSession,mutation({entityType:'bookmark',entityId:id,payload:bookmarkPayload('Другая заметка')}));
 assert.deepEqual((await snapshot(ownerSession)).entities,[]);assert.equal((await snapshot(readSession)).entities[0].payload.note,'Секрет читателя');assert.equal((await snapshot(otherSession)).entities[0].payload.note,'Другая заметка');
 const foreign=(await snapshot(readSession)).cursor;assert.equal((await api('/v2/reader/changes?cursor='+foreign,{session:otherSession})).status,400);
 const spoof=await api('/v2/reader/mutations',{method:'POST',session:ownerSession,json:{mutations:[{...mutation(),profileId:reader.id}]}});assert.equal(spoof.status,400);
 const exported=await value(await api('/v2/reader/export',{session:ownerSession}));assert.deepEqual(exported.payload.entities,[]);
});
test('portable export and selected import roundtrip metadata with target revisions, exact retries and later conflicts',async()=>{
 const ownerSession=await login(),readSession=await login(reader),device=randomUUID(),mark=randomUUID(),inputs=[mutation({deviceId:device,counter:1}),mutation({deviceId:device,counter:2,entityType:'bookmark',entityId:mark,payload:bookmarkPayload('Переносимая заметка')}),mutation({deviceId:device,counter:3,entityType:'catalog',entityId:CATALOG_ENTITY_ID,payload:{catalogs:catalogs()}})];
 await mutate(ownerSession,inputs);const exported=await api('/v2/reader/export',{session:ownerSession});assert.equal(exported.status,200);assert.match(exported.headers.get('content-disposition'),/gargantua-reader-data\.json/);
 const parsed=parseReaderExport(new Uint8Array(await exported.arrayBuffer()));assert.equal(parsed.entities.length,3);const archive=createReaderExport(parsed.entities.map(entity=>({...entity,revision:9000}))),importDevice=randomUUID();
 const preview=await value(await api('/v2/reader/import/preview',{method:'POST',session:readSession,raw:JSON.stringify(archive)}));assert.equal(preview.applied,false);assert.equal(preview.entries.length,3);assert.ok(preview.entries.every(entry=>entry.sourceRevision===9000&&entry.baseRevision===0&&entry.status==='new'));assert.deepEqual((await snapshot(readSession)).entities,[]);
 const selections=archive.payload.entities.map((entity,index)=>({entityType:entity.entityType,entityId:entity.entityId,mutationId:randomUUID(),deviceId:importDevice,counter:index+1,baseRevision:0})),request={archive,selections};
 const first=await value(await api('/v2/reader/import',{method:'POST',session:readSession,json:request}));assert.equal(first.archiveSha256,archive.sha256);assert.ok(first.results.every(result=>result.status==='accepted'&&result.entity.revision===1));assert.deepEqual(await value(await api('/v2/reader/import',{method:'POST',session:readSession,json:request})),first);
 const readerSnapshot=await snapshot(readSession);assert.equal(readerSnapshot.entities.length,3);assert.equal(readerSnapshot.entities.find(entity=>entity.entityType==='bookmark').payload.note,'Переносимая заметка');assert.equal(await number('books'),1);assert.equal(await number('imports'),1);
 const readSelection=selections.find(selection=>selection.entityType==='reading');await mutate(readSession,mutation({deviceId:importDevice,counter:4,baseRevision:1,payload:payload({shelf:'finished'})}));
 const stale={archive,selections:[{...readSelection,mutationId:randomUUID(),counter:5}]},conflict=await value(await api('/v2/reader/import',{method:'POST',session:readSession,json:stale}));assert.equal(conflict.results[0].status,'conflict');assert.equal(conflict.results[0].current.revision,2);assert.equal(conflict.results[0].current.payload.shelf,'finished');
});
test('selected tombstone import deletes only that metadata record and keeps other bookmarks',async()=>{
 const session=await login(),device=randomUUID(),a=randomUUID(),b=randomUUID();await mutate(session,[mutation({deviceId:device,counter:1,entityType:'bookmark',entityId:a,payload:bookmarkPayload('Удаляем')}),mutation({deviceId:device,counter:2,entityType:'bookmark',entityId:b,payload:bookmarkPayload('Сохраняем')})]);
 const archive=createReaderExport([{entityType:'bookmark',entityId:a,revision:77,deleted:true,payload:null}]),selection={entityType:'bookmark',entityId:a,mutationId:randomUUID(),deviceId:device,counter:3,baseRevision:1};
 const preview=await value(await api('/v2/reader/import/preview',{method:'POST',session,raw:JSON.stringify(archive)}));assert.equal(preview.entries[0].status,'deletion');assert.equal(preview.entries[0].baseRevision,1);assert.equal((await snapshot(session)).entities.filter(entity=>!entity.deleted).length,2);
 const result=await value(await api('/v2/reader/import',{method:'POST',session,json:{archive,selections:[selection]}}));assert.equal(result.results[0].entity.deleted,true);const entities=(await snapshot(session)).entities;assert.equal(entities.find(entity=>entity.entityId===b).deleted,false);assert.equal(await number('bookmarks'),1);
});
test('missing publication is a preview placeholder; import never downloads content or consumes a counter',async()=>{
 const session=await login(),unknown=randomUUID(),device=randomUUID(),row={entityType:'reading',entityId:unknown,revision:100,deleted:false,payload:{publicationId:unknown,publicationRevision:1,locator:{type:'legacy',chapter:0,position:0},shelf:'planned'}},archive=createReaderExport([row]);
 const preview=await value(await api('/v2/reader/import/preview',{method:'POST',session,raw:JSON.stringify(archive)}));assert.equal(preview.entries[0].status,'unavailable-publication');
 const response=await api('/v2/reader/import',{method:'POST',session,json:{archive,selections:[{entityType:'reading',entityId:unknown,mutationId:randomUUID(),deviceId:device,counter:1,baseRevision:0}]}});assert.equal(response.status,404);assert.equal((await response.json()).code,'READER_PUBLICATION');
 assert.equal(await number('reader_entities'),0);assert.equal(await number('reader_mutations'),0);assert.equal(await number('reader_devices'),0);assert.equal(await number('books'),1);assert.equal(await number('imports'),1);
 const accepted=await mutate(session,mutation({deviceId:device,entityType:'catalog',entityId:CATALOG_ENTITY_ID,payload:{catalogs:[]}}));assert.equal(accepted.results[0].status,'accepted');
});
test('large valid portable preview bypasses the ordinary 32KB JSON limit without applying data',async()=>{
 const session=await login(),entities=Array.from({length:80},()=>({entityType:'bookmark',entityId:randomUUID(),revision:1,deleted:false,payload:bookmarkPayload('я'.repeat(500))})),archive=createReaderExport(entities),raw=JSON.stringify(archive);assert.ok(Buffer.byteLength(raw)>32768);
 const preview=await value(await api('/v2/reader/import/preview',{method:'POST',session,raw}));assert.equal(preview.entries.length,80);assert.equal(preview.applied,false);assert.equal(await number('reader_entities'),0);
});
test('archive checksum, strict selections and import limits are enforced through real HTTP',async()=>{
 const session=await login(),archive=createReaderExport([{entityType:'reading',entityId:publication,revision:1,deleted:false,payload:payload()}]);
 const tampered=structuredClone(archive);tampered.payload.entities[0].payload.shelf='finished';assert.equal((await api('/v2/reader/import/preview',{method:'POST',session,raw:JSON.stringify(tampered)})).status,400);
 const selection={entityType:'reading',entityId:publication,mutationId:randomUUID(),deviceId:randomUUID(),counter:1,baseRevision:0};
 for(const selections of [[],Array(11).fill(selection),[selection,selection],[{...selection,profileId:reader.id}],[{...selection,entityId:randomUUID()}]])assert.equal((await api('/v2/reader/import',{method:'POST',session,json:{archive,selections}})).status,400);
 assert.equal((await api('/v2/reader/import/preview',{method:'POST',session,raw:Buffer.alloc(MAX_READER_EXPORT_BYTES+1,32)})).status,413);assert.equal(await number('reader_entities'),0);
});
test('actual quote validation failure rolls back receipts, counters, metadata and legacy projection',async()=>{
 const session=await login(),input=mutation({payload:payload({locator:locator({offset:1})})}),response=await api('/v2/reader/mutations',{method:'POST',session,json:{mutations:[input]}});assert.equal(response.status,400);
 for(const table of ['reader_entities','reader_changes','reader_mutations','reader_devices','reading'])assert.equal(await number(table),0);
 assert.equal((await mutate(session,{...input,payload:payload()})).results[0].status,'accepted');
});
test('actual corrupted immutable file blocks new metadata writes with a safe error',async()=>{
 const session=await login(),filename=path.join(library,'books',publication,'book.json');await fs.appendFile(filename,' ');
 const response=await api('/v2/reader/mutations',{method:'POST',session,json:{mutations:[mutation()]}});assert.equal(response.status,423);const body=await response.json();assert.equal(body.code,'READER_PUBLICATION_INTEGRITY');assert.ok(!JSON.stringify(body).includes(root));assert.equal(await number('reader_entities'),0);assert.equal(await number('reader_mutations'),0);
});
test('security block forbids upserts while explicit deletion of existing private metadata remains available',async()=>{
 const session=await login(),input=mutation();await mutate(session,input);await pool.query("UPDATE books SET security_state='blocked' WHERE id=$1",[publication]);
 const response=await api('/v2/reader/mutations',{method:'POST',session,json:{mutations:[{...input,mutationId:randomUUID(),counter:2,baseRevision:1,payload:payload({shelf:'finished'})}]}});assert.equal(response.status,423);
 const deleted=await mutate(session,{...input,mutationId:randomUUID(),counter:2,baseRevision:1,operation:'delete',payload:undefined});assert.equal(deleted.results[0].entity.deleted,true);assert.equal(await number('reading'),0);
});
test('modern batch validation and forged download fields never create an acquisition',async()=>{
 const session=await login();assert.equal((await api('/v2/reader/mutations',{method:'POST',session,json:{mutations:Array.from({length:11},()=>mutation())}})).status,400);
 const response=await api('/v2/reader/mutations',{method:'POST',session,json:{mutations:[mutation({payload:{...payload(),downloadUrl:'https://example.invalid/book.epub'}})]}});assert.equal(response.status,400);assert.equal(await number('reader_entities'),0);assert.equal(await number('imports'),1);
});
test('counter-bound v2 operations replay safely and expose only their own stream checkpoints',async()=>{
 const session=await login(),deviceId=randomUUID(),input=mutation({deviceId,protocolVersion:2,mutationId:readerMutationIdV2(owner.id,deviceId,1)});
 const first=await mutate(session,input),again=await mutate(session,input);assert.deepEqual(again.results,first.results);
 const saved=await snapshot(session);assert.equal(saved.devices.length,1);assert.equal(saved.devices[0].deviceId,deviceId);assert.equal(saved.devices[0].lastCounter,1);assert.equal(saved.devices[0].protocolVersion,2);
 assert.deepEqual((await snapshot(await login(other))).devices,[]);
 const forged=await api('/v2/reader/mutations',{method:'POST',session,json:{mutations:[{...input,mutationId:randomUUID(),counter:2,baseRevision:1}]}});assert.equal(forged.status,400);
 const downgrade=await api('/v2/reader/mutations',{method:'POST',session,json:{mutations:[{...input,protocolVersion:undefined,mutationId:randomUUID(),counter:2,baseRevision:1}]}});assert.equal(downgrade.status,409);assert.equal((await downgrade.json()).code,'READER_PROTOCOL');
 assert.equal((await snapshot(session)).devices[0].lastCounter,1);
});
test('storage capacity is visible to the owner without leaking another profile metadata',async()=>{
 const session=await login(),result=await value(await api('/v2/reader/storage',{session}));assert.deepEqual(result.protocolVersions,[1,2]);assert.equal(result.maxRows,250000);assert.equal(result.maxBytes,96*1024*1024);assert.equal(result.rows,0);
 assert.equal((await api('/v2/reader/storage',{session:await login(reader)})).status,403);
 assert.equal(await number('reader_profiles'),0,'read-only empty snapshots do not consume journal capacity');
});
