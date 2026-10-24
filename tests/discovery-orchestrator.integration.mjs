// Real isolated PG/files and loopback HTTP; provider metadata is synthetic.
// Does not fetch book files, run production services, or claim antivirus proof.
import test,{before,beforeEach,after} from 'node:test';
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
import {createDiscoverySearch} from '../server/discovery-providers.mjs';
import {createDiscoveryRequest,getDiscoveryRequest,claimDiscoveryRequest,finishDiscoveryRequest,syncDiscoveryImport,decideDiscoveryRequest} from '../server/discovery-requests.mjs';
import {buildDiscoveryPlan,acquireDiscovery,processDiscovery} from '../server/discovery-orchestrator.mjs';
import {claimImport,markPrepared,publishImport} from '../server/import-jobs.mjs';
import {stagePublication,placePublication} from '../server/publication-files.mjs';
import {sha256} from '../server/publication-model.mjs';

const url=new URL(process.env.TEST_DATABASE_URL||'postgres://invalid/disabled');
if(process.env.GARGANTUA_TEST_ISOLATED!=='1'||!/^\/gargantua_test_[a-z0-9_]+$/.test(url.pathname))throw Error('Explicit isolated TEST_DATABASE_URL required; refusing production');
const schema='discovery_orch_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:url.href,max:1,statement_timeout:10000});
const isolated=new URL(url);isolated.searchParams.set('options',`-c search_path=${schema}`);
const pool=new pg.Pool({connectionString:isolated.href,max:10,statement_timeout:10000});
const owner={id:randomUUID()},trusted={id:randomUUID()},reader={id:randomUUID()},other={id:randomUUID()},password='synthetic-test-password-123';let root,quarantine,library,created=false,encodedPassword;
const input=(query='Synthetic book',extra={})=>({idempotencyKey:randomUUID(),query,...extra});
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);created=true;await applyMigrations(pool);root=await fs.mkdtemp(path.join(os.tmpdir(),'gargantua-discovery-orch-'));quarantine=path.join(root,'quarantine');library=path.join(root,'library');encodedPassword=await passwordHash(password);});
beforeEach(async()=>{
 await pool.query('TRUNCATE profiles,works RESTART IDENTITY CASCADE');await pool.query('UPDATE settings SET imports_paused=false,serving_paused=false WHERE id=1');
 for(const [profile,role,label]of [[owner,'owner','owner'],[trusted,'trusted-import','trusted'],[reader,'reader','reader'],[other,'reader','other']])await pool.query('INSERT INTO profiles(id,login,password,role) VALUES($1,$2,$3,$4)',[profile.id,label,encodedPassword,role]);
 await fs.mkdir(path.join(quarantine,'incoming'),{recursive:true});await fs.mkdir(path.join(quarantine,'attempts'),{recursive:true});await fs.mkdir(library,{recursive:true});
});
after(async()=>{await pool.end();try{if(created){assert.match(schema,/^discovery_orch_[a-f0-9]{32}$/);await admin.query(`DROP SCHEMA ${schema} CASCADE`);}}finally{await admin.end();}if(root){assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('gargantua-discovery-orch-'));await fs.rm(root,{recursive:true,force:true});}});
function metadataSearch({title='Synthetic book',language='ru'}={}){
 let clock=0;const calls=[];
 const search=createDiscoverySearch({clock:()=>clock,sleep:async ms=>{clock+=ms;},fetchSafe:async(value,options)=>{
  const url=new URL(value);calls.push(url.href);assert.equal(options.maxRedirects,0);
  const data=url.hostname==='gutendex.com'?{results:[{id:11,title,authors:[{name:'Synthetic author'}],languages:[language],copyright:false,media_type:'Text',formats:{'application/epub+zip':'https://www.gutenberg.org/cache/epub/11/pg11-images.epub'}}],count:1,next:null}:url.hostname==='openlibrary.org'?{docs:[],numFound:0}:{data:[]};
  return {buffer:Buffer.from(JSON.stringify(data)),type:'application/json',url:url.href};
 }});return {search,calls};
}
async function planned(profile=owner,value=input(),searchOptions={}){
 const created=await createDiscoveryRequest(pool,profile,value),claim=await claimDiscoveryRequest(pool);assert.equal(claim.id,created.request.id);const metadata=metadataSearch(searchOptions),plan=await buildDiscoveryPlan(pool,claim,{search:metadata.search});const row=await finishDiscoveryRequest(pool,claim,plan);assert.equal(row.status,'selected');const acquisition=await claimDiscoveryRequest(pool);assert.equal(acquisition.phase,'acquisition');return {claim:acquisition,plan,metadata};
}
async function seedPublication(){
 const importId=randomUUID();await pool.query("INSERT INTO imports(id,requested_by,kind,filename,status,decision_reason) VALUES($1,$2,'upload','fixture.txt','queued','owner')",[importId,owner.id]);
 const row=await claimImport(pool),book={title:'Synthetic book',author:'Synthetic author',language:'ru',chapters:[{title:'One',blocks:[{type:'text',text:'Synthetic local fixture '+randomUUID()}]}],assets:{}};
 const prepared=await stagePublication(library,row.attempt_token,row.resultBookId,book);await markPrepared(pool,row,prepared.manifest);await placePublication(library,prepared);await markPrepared(pool,row,prepared.manifest,'placed');const id=await publishImport(pool,row,book,prepared,{sha256:sha256(Buffer.from('synthetic raw fixture'))});return {id,prepared,book};
}
test('metadata plan to acquisition commits one exact import with persisted expectations and atomic link',async()=>{
 const {claim,metadata}=await planned(),result=await acquireDiscovery(pool,claim,{quarantine,library});assert.equal(result.status,'acquiring');
 const row=(await pool.query('SELECT * FROM imports WHERE id=$1',[result.import_id])).rows[0];assert.equal(row.requested_by,owner.id);assert.equal(row.kind,'file');assert.equal(row.filename,'gutenberg-11.epub');assert.equal(row.source_url,'https://gutenberg.pglaf.org/cache/epub/11/pg11-images.epub');assert.equal(row.options.discovery.requestId,claim.id);assert.equal(row.options.discovery.planRevision,1);assert.equal(row.options.discovery.expected.title,'Synthetic book');assert.equal(row.options.discovery.download.maxRedirects,0);assert.equal(row.options.discovery.sourceIdentity.provider,'gutenberg');
 assert.equal(Number((await pool.query('SELECT count(*) FROM imports')).rows[0].count),1);await assert.rejects(()=>acquireDiscovery(pool,claim,{quarantine,library}),{code:'DISCOVERY_LEASE_LOST'});assert.equal(Number((await pool.query('SELECT count(*) FROM imports')).rows[0].count),1);
 assert.ok(metadata.calls.every(value=>['openlibrary.org','gutendex.com','api.cdnlibs.org'].includes(new URL(value).hostname)),'only metadata fixture endpoints were used');
});
test('a confirmed full Ranobe branch acquires one shared feed without pretending the source language is known',async()=>{
 const candidate={id:'dsc_'+'a'.repeat(32),kind:'book',title:'Synthetic full novel',authors:[],languages:[],identity:{provider:'ranobelib',remoteId:'123'},availability:'ranobe-full',eligibleForAcquisition:true,sourceBinding:{provider:'ranobelib',remoteId:'123',slug:'123--synthetic',branchId:null,completeness:{verified:true}},downloadSelections:[]};
 const acquire=async profile=>{await createDiscoveryRequest(pool,profile,input('Full novel '+randomUUID()));const metadata=await claimDiscoveryRequest(pool);await finishDiscoveryRequest(pool,metadata,{status:'resolved',nextAction:'acquire',candidates:[candidate],selectedCandidateId:candidate.id,providerErrors:[],clarifications:[],hasMore:false});const claim=await claimDiscoveryRequest(pool);assert.equal(claim.phase,'acquisition');return acquireDiscovery(pool,claim,{quarantine,library});};
 const first=await acquire(owner),second=await acquire(trusted);assert.equal(first.status,'acquiring');assert.equal(second.import_id,first.import_id);const job=(await pool.query('SELECT * FROM imports WHERE id=$1',[first.import_id])).rows[0];assert.equal(job.kind,'ranobe');assert.equal(job.options.mode,'full');assert.equal(job.options.branch,null);assert.equal(job.options.language,'und');assert.equal(job.requested_by,owner.id);assert.equal(Number((await pool.query('SELECT count(*) FROM imports')).rows[0].count),1);const requests=(await pool.query('SELECT profile_id FROM ranobe_feed_requests ORDER BY created_at')).rows;assert.deepEqual(requests.map(r=>r.profile_id),[owner.id,trusted.id]);
});
function readerRanobePlan(){const candidate={id:'dsc_'+'b'.repeat(32),kind:'book',title:'Approved reader full novel',authors:[],languages:[],identity:{provider:'ranobelib',remoteId:'123'},availability:'ranobe-full',eligibleForAcquisition:true,sourceBinding:{provider:'ranobelib',remoteId:'123',slug:'123--synthetic',branchId:null,completeness:{verified:true}},downloadSelections:[]};return {status:'resolved',nextAction:'acquire',candidates:[candidate],selectedCandidateId:candidate.id,providerErrors:[],clarifications:[],hasMore:false};}
async function approvedReaderClaim(created){await decideDiscoveryRequest(pool,owner,{id:created.request.id,action:'approve',expectedRevision:created.request.revision});const metadata=await claimDiscoveryRequest(pool);assert.equal(metadata.id,created.request.id);await finishDiscoveryRequest(pool,metadata,readerRanobePlan());return claimDiscoveryRequest(pool);}
test('an owner-approved reader discovery queues the selected full branch without a second approval',async()=>{
 const created=await createDiscoveryRequest(pool,reader,input('Reader full branch')),claim=await approvedReaderClaim(created),linked=await acquireDiscovery(pool,claim,{quarantine,library});
 const job=(await pool.query('SELECT id,status,kind,requested_by,approved_by,decision_reason,options FROM imports WHERE id=$1',[linked.import_id])).rows[0];assert.equal(job.status,'queued');assert.equal(job.kind,'ranobe');assert.equal(job.requested_by,reader.id);assert.equal(job.approved_by,owner.id);assert.equal(job.decision_reason,'discovery-owner-approval');assert.equal(job.options.mode,'full');assert.equal(job.options.language,'und');assert.equal(linked.status,'acquiring');
 const audits=(await pool.query("SELECT actor,target,details FROM audit WHERE action='import.discovery-owner-approved'")).rows;assert.equal(audits.length,1);assert.equal(audits[0].actor,owner.id);assert.equal(audits[0].target,job.id);assert.equal(audits[0].details.discoveryRequestId,created.request.id);assert.equal(audits[0].details.requestedBy,reader.id);
 assert.equal((await claimImport(pool)).id,job.id,'approved source is claimable without another owner action');
});
test('unapproved or revoked reader discovery cannot spoof an owner grant through the acquisition claim',async()=>{
 const created=await createDiscoveryRequest(pool,reader,input('Unapproved full branch')),plan=readerRanobePlan();assert.equal(created.request.status,'pending-approval');assert.equal(await claimDiscoveryRequest(pool),null);
 const forged={...created.request,status:'processing',phase:'acquisition',attempt_token:randomUUID(),approved_by:owner.id,decision_reason:'owner-approval',plan,selected_candidate_id:plan.selectedCandidateId};
 await assert.rejects(()=>acquireDiscovery(pool,forged,{quarantine,library}),{code:'DISCOVERY_LEASE_LOST'});assert.equal(Number((await pool.query('SELECT count(*) FROM imports')).rows[0].count),0);
 const claim=await approvedReaderClaim(created);await pool.query('UPDATE discovery_requests SET approved_by=NULL,decision_reason=NULL WHERE id=$1',[claim.id]);await assert.rejects(()=>acquireDiscovery(pool,{...claim,approved_by:owner.id,decision_reason:'owner-approval'},{quarantine,library}),{code:'DISCOVERY_APPROVAL_REQUIRED'});
 assert.equal(Number((await pool.query('SELECT count(*) FROM imports')).rows[0].count),0);assert.equal(Number((await pool.query('SELECT count(*) FROM ranobe_feed_requests')).rows[0].count),0);assert.equal(Number((await pool.query("SELECT count(*) FROM audit WHERE action='import.discovery-owner-approved'")).rows[0].count),0);
});
test('capacity refusal rolls back import creation and leaves no orphan link',async()=>{
 const {claim}=await planned();for(let n=0;n<6;n++)await pool.query("INSERT INTO imports(id,requested_by,kind,filename,status) VALUES($1,$2,'file','reserved.epub','queued')",[randomUUID(),owner.id]);
 await assert.rejects(()=>acquireDiscovery(pool,claim,{quarantine,library}),{status:507});assert.equal(Number((await pool.query('SELECT count(*) FROM imports')).rows[0].count),6);const row=await getDiscoveryRequest(pool,owner,claim.id);assert.equal(row.import_id,null);assert.equal(row.status,'processing');
});
test('persisted source-policy tampering fails before creating an import',async()=>{
 const created=await createDiscoveryRequest(pool,owner,input()),claim=await claimDiscoveryRequest(pool),metadata=metadataSearch(),plan=await buildDiscoveryPlan(pool,claim,{search:metadata.search});plan.candidates[0].downloadSelections[0].url='https://127.0.0.1/private.epub';await finishDiscoveryRequest(pool,claim,plan);const acquisition=await claimDiscoveryRequest(pool);
 await assert.rejects(()=>acquireDiscovery(pool,acquisition,{quarantine,library}),{code:'DISCOVERY_NEEDS_REVIEW'});assert.equal(Number((await pool.query('SELECT count(*) FROM imports')).rows[0].count),0);assert.equal((await getDiscoveryRequest(pool,owner,created.request.id)).import_id,null);
});
test('different profiles share one exact source acquisition while keeping independent requests and audio wishes',async()=>{
 const first=await planned(owner),a=await acquireDiscovery(pool,first.claim,{quarantine,library}),second=await planned(trusted,input('Synthetic book',{audio:false})),b=await acquireDiscovery(pool,second.claim,{quarantine,library});assert.equal(a.import_id,b.import_id);
 const rows=(await pool.query('SELECT requested_by,options FROM imports ORDER BY created_at')).rows;assert.equal(rows.length,1);assert.equal(rows[0].requested_by,owner.id);assert.equal(rows[0].options.discovery.requestId,first.claim.id);
 const requests=(await pool.query('SELECT requested_by,acquisition_key,input FROM discovery_requests ORDER BY created_at')).rows;assert.deepEqual(requests.map(row=>row.requested_by),[owner.id,trusted.id]);assert.equal(requests[0].acquisition_key,requests[1].acquisition_key);assert.equal(requests[0].input.audio,true);assert.equal(requests[1].input.audio,false);
 const audits=(await pool.query("SELECT actor,target FROM audit WHERE action='discovery.source-shared' ORDER BY id")).rows;assert.deepEqual(audits.map(item=>item.actor),[trusted.id]);
});
test('library-first reuse verifies exact local files and a corrupted package never becomes ready',async()=>{
 const local=await seedPublication(),created=await createDiscoveryRequest(pool,owner,input()),metadata=await claimDiscoveryRequest(pool),plan=await buildDiscoveryPlan(pool,metadata,{search:async()=>{throw Error('external metadata should not run for an accepted local match');}});assert.equal(plan.candidates[0].bookId,local.id);await finishDiscoveryRequest(pool,metadata,plan);const claim=await claimDiscoveryRequest(pool),filename=path.join(library,'books',local.id,'book.json'),bytes=await fs.readFile(filename);await fs.writeFile(filename,'corrupt synthetic bytes');
 try{await assert.rejects(()=>acquireDiscovery(pool,claim,{quarantine,library}),{code:'PUBLICATION_INTEGRITY'});assert.notEqual((await getDiscoveryRequest(pool,owner,created.request.id)).outputs.book.status,'ready');}finally{await fs.writeFile(filename,bytes);}
 const ready=await acquireDiscovery(pool,claim,{quarantine,library});assert.equal(ready.status,'book-ready');assert.equal(ready.outputs.book.publicationId,local.id);assert.equal(ready.outputs.audio.status,'pending-provider');assert.equal(Number((await pool.query('SELECT count(*) FROM imports')).rows[0].count),1);
});
test('identity review sync exposes bounded reason codes without source URLs or observed raw fields',async()=>{
 const {claim}=await planned(),linked=await acquireDiscovery(pool,claim,{quarantine,library});await pool.query("UPDATE imports SET status='source-review',report=$1,error='unsafe raw error' WHERE id=$2",[JSON.stringify({identityVerification:{status:'review_required',verified:false,reasons:['SOURCE_TITLE_MISMATCH','https://user:secret@example.org/x','unsafe\ncode'],observed:{title:'Private raw field'},url:'https://secret.invalid/?token=private'}}),linked.import_id]);
 const reviewed=await syncDiscoveryImport(pool,linked.id);assert.equal(reviewed.status,'needs-review');assert.equal(reviewed.outputs.book.status,'identity-review');assert.equal(reviewed.error,'SOURCE_IDENTITY_REVIEW');assert.deepEqual(reviewed.outputs.book.reasonCodes,['SOURCE_TITLE_MISMATCH']);assert.ok(!JSON.stringify(reviewed.outputs).includes('secret'));assert.ok(!JSON.stringify(reviewed.outputs).includes('Private raw'));
});
test('process wrapper persists provider errors and parent cancellation rather than losing durable ownership',async()=>{
 const created=await createDiscoveryRequest(pool,owner,input()),claim=await claimDiscoveryRequest(pool),controller=new AbortController();controller.abort(Object.assign(new Error('synthetic worker stop'),{code:'WORKER_STOPPING'}));const result=await processDiscovery(pool,claim,{signal:controller.signal,quarantine,library,search:async()=>{throw Error('must not search');}});assert.equal(result.status,'queued');assert.equal(result.id,created.request.id);assert.equal(result.lease_expires_at,null);
});

test('all-source outage schedules bounded persistent retry rather than claiming the book was not found',async()=>{
 const created=await createDiscoveryRequest(pool,owner,input('Temporarily unavailable title')),claim=await claimDiscoveryRequest(pool);
 const result=await processDiscovery(pool,claim,{quarantine,library,search:async()=>({status:'unavailable',candidates:[],providerErrors:[{provider:'openlibrary',code:'SOURCE_UNAVAILABLE',retryable:true}]})});
 assert.equal(result.id,created.request.id);assert.equal(result.status,'queued');assert.equal(result.retry_count,1);assert.ok(result.next_attempt_at>Date.now());assert.equal(await claimDiscoveryRequest(pool),null);assert.equal(result.plan,null);
});

test('console help, refinement and retry work against isolated current migrations',async()=>{
 const created=await createDiscoveryRequest(pool,owner,input('Original console query')),claim=await claimDiscoveryRequest(pool),reviewed=await finishDiscoveryRequest(pool,claim,{status:'not_found',candidates:[],clarifications:[],providerErrors:[],hasMore:false});
 async function cli(args){const child=spawn(process.execPath,['server/cli.mjs',...args],{cwd:process.cwd(),env:{...process.env,DATABASE_URL:isolated.href},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',data=>{stdout+=data;});child.stderr.on('data',data=>{stderr=(stderr+data).slice(-2048);});const [code]=await once(child,'exit');assert.equal(code,0,stderr);return stdout;}
 const help=await cli(['help']);assert.match(help,/discovery more/);assert.match(help,/discovery refine/);assert.match(help,/discovery retry/);
 const refined=JSON.parse(await cli(['discovery','refine',created.request.id,String(reviewed.revision),'Свидание с Рамой автора Артура Кларка','--allow-original','--no-audio']));assert.equal(refined.input.query,'Свидание с Рамой автора Артура Кларка');assert.equal(refined.input.allowOriginal,true);assert.equal(refined.input.audio,false);assert.equal(refined.status,'queued');
 const next=await claimDiscoveryRequest(pool);await pool.query("UPDATE discovery_requests SET status='error',lease_expires_at=NULL WHERE id=$1",[next.id]);const failed=await getDiscoveryRequest(pool,owner,next.id),retried=JSON.parse(await cli(['discovery','retry',failed.id,String(failed.revision)]));assert.equal(retried.status,'queued');assert.equal(retried.retry_count,0);
});

test('source access denial remains a review without automatic durable retries',async()=>{
 await createDiscoveryRequest(pool,owner,input('Access-denied source title'));const claim=await claimDiscoveryRequest(pool);
 const result=await processDiscovery(pool,claim,{quarantine,library,search:async()=>({status:'unavailable',candidates:[],providerErrors:[{provider:'openlibrary',code:'SOURCE_ACCESS_DENIED',retryable:false}],clarifications:[],hasMore:false})});
 assert.equal(result.status,'needs-review');assert.equal(result.retry_count,0);assert.equal(result.next_attempt_at,null);assert.equal(await claimDiscoveryRequest(pool),null);
});
test('real HTTP discovery routes enforce authentication, CSRF, strict input and per-profile visibility',async()=>{
 const base='http://127.0.0.1:3080',origin='http://localhost:3080',api=spawn(process.execPath,['server/app.mjs'],{cwd:process.cwd(),env:{...process.env,DATABASE_URL:isolated.href,LIBRARY_DIR:library,QUARANTINE_DIR:quarantine,APP_ORIGIN:origin},stdio:['ignore','ignore','pipe']});let errors='';api.stderr.on('data',bytes=>{errors=(errors+bytes.toString()).slice(-4096);});const exited=once(api,'exit');
 try{
  let ready=false;for(let n=0;n<100;n++){if(api.exitCode!==null)break;try{if((await fetch(base+'/api/health',{signal:AbortSignal.timeout(300)})).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,50));}assert.ok(ready,'isolated child API did not start: '+errors);
  assert.equal((await fetch(base+'/api/discovery/requests')).status,401);
  async function login(name){const result=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json','X-Cotology':'1',Origin:origin},body:JSON.stringify({login:name,password})});assert.equal(result.status,200);const cookie=result.headers.get('set-cookie').split(';')[0],me=await (await fetch(base+'/api/me',{headers:{Cookie:cookie}})).json();return {Cookie:cookie,'X-Cotology':'1','X-CSRF-Token':me.csrf,Origin:origin,'Content-Type':'application/json'};}
  const a=await login('reader'),b=await login('other'),adminHeaders=await login('owner');
  const post=(headers,body)=>fetch(base+'/api/discovery/requests',{method:'POST',headers,body:JSON.stringify(body)});
  const noCsrf={...a};delete noCsrf['X-CSRF-Token'];assert.equal((await post(noCsrf,input())).status,403);assert.equal((await post({...a,Origin:'https://other.invalid'},input())).status,403);
  assert.equal((await post(a,input('https://example.org/book.epub'))).status,400);assert.equal((await post(a,input('Valid book',{downloadUrl:'https://example.org/book.epub'}))).status,400);
  const accepted=await post(a,input());assert.equal(accepted.status,202);const created=(await accepted.json()).request;assert.equal(created.status,'pending-approval');assert.equal(created.input.audio,true);
  assert.equal((await fetch(base+'/api/discovery/requests/'+created.id,{headers:b})).status,404);assert.equal((await fetch(base+'/api/discovery/requests/'+created.id,{headers:adminHeaders})).status,200);
  const forbidden=await fetch(base+'/api/discovery/requests/'+created.id+'/decision',{method:'POST',headers:a,body:JSON.stringify({action:'approve',expectedRevision:created.revision})});assert.equal(forbidden.status,403);
  const approved=await fetch(base+'/api/discovery/requests/'+created.id+'/decision',{method:'POST',headers:adminHeaders,body:JSON.stringify({action:'approve',expectedRevision:created.revision})});assert.equal(approved.status,200);assert.equal((await approved.json()).status,'queued');
  await pool.query("UPDATE discovery_requests SET status='needs-review' WHERE id=$1",[created.id]);const current=await getDiscoveryRequest(pool,reader,created.id);
  const refined=await fetch(base+'/api/discovery/requests/'+created.id+'/decision',{method:'POST',headers:a,body:JSON.stringify({action:'refine',expectedRevision:current.revision,allowOriginal:true})});assert.equal(refined.status,200);const clarification=await refined.json();assert.equal(clarification.status,'pending-approval');assert.equal(clarification.input.allowOriginal,true);assert.equal(clarification.approved_by,null);
 }finally{if(api.exitCode===null){api.kill('SIGTERM');await Promise.race([exited,new Promise(resolve=>setTimeout(resolve,3000))]);if(api.exitCode===null){api.kill('SIGKILL');await exited;}}}
});
