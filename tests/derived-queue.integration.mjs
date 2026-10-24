// Real PostgreSQL migrations and durable transitions in a disposable database
// schema. No production DB, model execution, provider network or user files.
import test,{before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {applyMigrations} from '../server/migrations.mjs';
import {assignBookModel,sealPublicationModel} from '../server/work-model.mjs';
import {canonicalJson,sha256} from '../server/publication-model.mjs';
import {packageDigest} from '../server/publication-files.mjs';
import {registerDerivedRecipe,createDerivedRequest,getDerivedRequest,getDerivedResult,assertDerivedPublication,listDerivedRequests,decideDerivedRequest,claimDerivedJob,renewDerivedJob,assertDerivedAttempt,setDerivedPlan,checkpointDerivedJob,listDerivedCheckpoints,pauseDerivedJob,failDerivedJob,finishDerivedJob} from '../server/derived-jobs.mjs';

const url=new URL(process.env.TEST_DATABASE_URL||'postgres://invalid/disabled');
if(process.env.GARGANTUA_TEST_ISOLATED!=='1'||!/^\/gargantua_test_[a-z0-9_]+$/.test(url.pathname))throw Error('Explicit isolated TEST_DATABASE_URL required; refusing production');
const schema='derived_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:url.href,max:1,statement_timeout:10000});
const isolated=new URL(url);isolated.searchParams.set('options',`-c search_path=${schema}`);
const pool=new pg.Pool({connectionString:isolated.href,max:12,statement_timeout:10000});let created=false,recipes;
const owner={id:randomUUID()},trusted={id:randomUUID()},reader={id:randomUUID()},other={id:randomUUID()};
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);created=true;await applyMigrations(pool);});
beforeEach(async()=>{
 await pool.query('TRUNCATE profiles,works,derived_recipes RESTART IDENTITY CASCADE');await pool.query('UPDATE settings SET imports_paused=false,serving_paused=false WHERE id=1');
 for(const [profile,role]of [[owner,'owner'],[trusted,'trusted-import'],[reader,'reader'],[other,'reader']])await pool.query('INSERT INTO profiles(id,login,password,role) VALUES($1,$2,$3,$4)',[profile.id,'test-'+profile.id,'synthetic-no-login',role]);
 recipes={translation:await registerDerivedRecipe(pool,{kind:'translation',language:'ru',manifest:{schemaVersion:1,modelSha256:'a'.repeat(64),runtime:'test-only',recipe:'faithful-v1'}}),audio:await registerDerivedRecipe(pool,{kind:'audio',language:'ru',manifest:{schemaVersion:1,modelSha256:'b'.repeat(64),runtime:'test-only',recipe:'piper-v1'}})};
});
after(async()=>{await pool.end();try{if(created){assert.match(schema,/^derived_[a-f0-9]{32}$/);await admin.query(`DROP SCHEMA ${schema} CASCADE`);}}finally{await admin.end();}});
const count=async table=>Number((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count);
async function tx(operation){const c=await pool.connect();try{await c.query('BEGIN');const value=await operation(c);await c.query('COMMIT');return value;}catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}finally{c.release();}}
async function seedBook({language='en',model,client=pool,text='Synthetic book '+randomUUID(),title='Synthetic original',author='Test',chapters=1}={}){
 const book={title,author,language,chapters:Array.from({length:chapters},(_,i)=>({title:'Chapter '+(i+1),blocks:[{type:'text',text:text+' '+i}]})),assets:{}},raw=Buffer.from(JSON.stringify(book)),checksum=sha256(raw),manifest={schemaVersion:1,files:[{path:'book.json',bytes:raw.length,sha256:checksum}]},identity=model??await assignBookModel(client,book),bookId=randomUUID(),importId=randomUUID();
 await client.query("INSERT INTO imports(id,requested_by,kind,filename,status,book_id) VALUES($1,$2,'upload','fixture.txt','completed',$3)",[importId,owner.id,bookId]);
 const row=(await client.query('INSERT INTO books(id,title,author,language,chapter_count,sha256,import_id,requested_by,content_sha256,content_bytes,package_sha256,artifact_manifest,work_id,expression_id,edition_id) VALUES($1,$2,$3,$4,$14,$5,$6,$7,$5,$8,$9,$10,$11,$12,$13) RETURNING *',[bookId,book.title,book.author,language,checksum,importId,owner.id,raw.length,packageDigest(manifest),JSON.stringify(manifest),identity.work_id,identity.expression_id,identity.edition_id,chapters])).rows[0];return sealPublicationModel(client,row,book);
}
const input=(book,kind='translation',extra={})=>({idempotencyKey:randomUUID(),kind,recipeSha256:recipes[kind].sha256,publicationIds:[book.id],...extra});
const segment=(ordinal,text)=>({ordinal,sourceSha256:sha256(Buffer.from(text)),text});
async function plan(claim,texts=['First source.','Second source.']){return setDerivedPlan(pool,claim,{segments:texts.length,manifest:{schemaVersion:1,segments:texts.map((text,index)=>segment(index,text))}});}
async function checkpoint(claim,ordinal,text='result'){const row=(await pool.query('SELECT plan FROM derived_jobs WHERE id=$1',[claim.id])).rows[0];return checkpointDerivedJob(pool,claim,{ordinal,sourceSha256:row.plan.segments[ordinal].sourceSha256,outputSha256:sha256(Buffer.from(text)),outputBytes:Buffer.byteLength(text),manifest:{path:`${claim.id}/${claim.attempt_token}/${ordinal}.json`,mediaType:'application/json'}});}
async function readyClaim({profile=owner,language='en',kind='translation',...options}={}){const book=await seedBook({language}),created=await createDerivedRequest(pool,profile,input(book,kind,options)),claim=await claimDerivedJob(pool);return {book,created,claim};}
async function translatedResult(client,row,source){
 const expressionId=randomUUID(),editionId=randomUUID();await client.query("INSERT INTO expressions(id,work_id,language,kind,variant_key,source_expression_id,recipe) VALUES($1,$2,'ru','machine-translation',$3,$4,$5)",[expressionId,source.work_id,'machine:'+row.id,source.expression_id,JSON.stringify({sha256:row.recipe_sha256})]);await client.query("INSERT INTO editions(id,expression_id,source_kind) VALUES($1,$2,'machine-translation')",[editionId,expressionId]);
 const book=await seedBook({client,language:'ru',model:{work_id:source.work_id,expression_id:expressionId,edition_id:editionId}}),manifest={schemaVersion:1,kind:'translation',publicationIds:[book.id],quality:'machine-draft'},bytes=Buffer.byteLength(canonicalJson(manifest));return {manifest,sha256:sha256(Buffer.from(canonicalJson(manifest))),bytes,workId:source.work_id,expressionId,editionId};
}
async function completeTranslation(fixture){await plan(fixture.claim,['One source.']);await checkpoint(fixture.claim,0);return finishDerivedJob(pool,fixture.claim,null,{publish:translatedResult});}

test('migration008 is idempotent and recipes are exact immutable content identities',async()=>{
 await applyMigrations(pool);const same=await registerDerivedRecipe(pool,{language:'ru',manifest:{recipe:'faithful-v1',runtime:'test-only',modelSha256:'a'.repeat(64),schemaVersion:1},kind:'translation'});assert.equal(same.sha256,recipes.translation.sha256);assert.equal(await count('derived_recipes'),2);
 await assert.rejects(()=>pool.query("UPDATE derived_recipes SET language='en' WHERE sha256=$1",[same.sha256]),/immutable/);await assert.rejects(()=>pool.query('DELETE FROM derived_recipes WHERE sha256=$1',[same.sha256]),/immutable/);
});
test('roles come from DB, with separate approvals and exact source seals',async()=>{
 const book=await seedBook(),pending=await createDerivedRequest(pool,{id:reader.id,role:'owner'},input(book));assert.equal(pending.request.status,'pending-approval');assert.equal(pending.job.status,'approval-required');assert.equal(pending.request.audio_requested,true);assert.equal(await claimDerivedJob(pool),null);
 const approved=await decideDerivedRequest(pool,owner,{id:pending.request.id,action:'approve',expectedRevision:1});assert.equal(approved.status,'active');assert.equal(approved.approved_by,owner.id);const claim=await claimDerivedJob(pool);assert.equal(claim.source.manifest.parts[0].publicationSha256,book.publication_sha256);assert.equal(claim.source.manifest.sourceLanguage,'en');assert.equal(claim.source.parts[0].id,book.id);
});

test('new admission defaults to five immutable physical chapters; explicit next batch stays separate',async()=>{
 const book=await seedBook({chapters:12}),before=(await pool.query('SELECT * FROM books WHERE id=$1',[book.id])).rows[0],body=input(book),first=await createDerivedRequest(pool,owner,body),source=(await pool.query('SELECT * FROM derived_sources WHERE sha256=$1',[first.job.source_sha256])).rows[0];
 assert.equal(source.manifest.schemaVersion,2);assert.deepEqual([source.manifest.selection.start,source.manifest.selection.count,source.manifest.selection.total],[1,5,12]);assert.deepEqual(source.manifest.selection.chapters.map(c=>c.chapterIndex),[0,1,2,3,4]);assert.equal(source.manifest.parts[0].publicationSha256,book.publication_sha256);
 assert.equal((await createDerivedRequest(pool,owner,{...body,chapterRange:{start:1,count:5}})).job.id,first.job.id);
 await assert.rejects(()=>createDerivedRequest(pool,owner,{...body,chapterRange:{start:6,count:5}}),{code:'DERIVED_IDEMPOTENCY'});
 const next=await createDerivedRequest(pool,owner,input(book,'translation',{chapterRange:{start:6,count:5}}));assert.notEqual(next.job.id,first.job.id);
 const final=await createDerivedRequest(pool,owner,input(book,'translation',{chapterRange:{start:11,count:5}}));assert.equal(final.job.source_manifest.selection.count,2);
 assert.deepEqual((await pool.query('SELECT * FROM books WHERE id=$1',[book.id])).rows[0],before);
});
test('range limits, bounds, source seals and reader approval are enforced together',async()=>{
 const book=await seedBook({chapters:60}),ru=await seedBook({language:'ru',chapters:60});
 for(const chapterRange of [{start:0,count:5},{start:1,count:6},{start:61,count:1},{start:1,count:1,force:true}])await assert.rejects(()=>createDerivedRequest(pool,owner,input(book,'translation',{chapterRange})),{code:'DERIVED_CHAPTER_RANGE'});
 await assert.rejects(()=>createDerivedRequest(pool,owner,input(ru,'audio',{chapterRange:{start:1,count:51}})),{code:'DERIVED_CHAPTER_RANGE'});
 const pending=await createDerivedRequest(pool,reader,input(book,'translation',{chapterRange:{start:6,count:5}}));assert.equal(pending.request.status,'pending-approval');assert.equal(await claimDerivedJob(pool),null);
 await pool.query("UPDATE books SET security_state='blocked' WHERE id=$1",[book.id]);await assert.rejects(()=>decideDerivedRequest(pool,owner,{id:pending.request.id,action:'approve',expectedRevision:1}),{code:'DERIVED_SOURCE_BLOCKED'});
 const audio=await createDerivedRequest(pool,owner,input(ru,'audio',{chapterRange:{start:6,count:50}}));assert.equal(audio.job.source_manifest.selection.count,50);assert.equal(audio.job.source_manifest.selection.chapters.at(-1).chapterIndex,54);
});
test('canonical clipped batch deduplicates and survives a new database connection',async()=>{
 const book=await seedBook({chapters:7}),body=input(book,'translation',{chapterRange:{start:6,count:5}}),first=await createDerivedRequest(pool,owner,body),connection=new pg.Pool({connectionString:isolated.href,max:2});
 try{const again=await createDerivedRequest(connection,owner,{...body,chapterRange:{start:6,count:2}});assert.equal(again.idempotent,true);assert.equal(again.job.id,first.job.id);const duplicate=await createDerivedRequest(connection,trusted,input(book,'translation',{chapterRange:{start:6,count:2}}));assert.equal(duplicate.job.id,first.job.id);assert.equal(duplicate.reused,true);}finally{await connection.end();}
});
test('legacy whole-book source and stable idempotency are returned before new defaults',async()=>{
 const book=await seedBook({chapters:12}),body=input(book),manifest={schemaVersion:1,sourceLanguage:'en',workId:book.work_id,expressionId:book.expression_id,snapshotId:null,parts:[{ordinal:0,publicationId:book.id,editionId:book.edition_id,publicationSha256:book.publication_sha256,packageSha256:book.package_sha256,chapterCount:12}]},hash=sha256(Buffer.from(canonicalJson(manifest))),jobId=randomUUID(),requestId=randomUUID();
 await pool.query('INSERT INTO derived_sources(sha256,work_id,expression_id,manifest) VALUES($1,$2,$3,$4)',[hash,book.work_id,book.expression_id,JSON.stringify(manifest)]);await pool.query('INSERT INTO derived_source_parts(source_sha256,ordinal,book_id,expression_id,edition_id,publication_sha256,package_sha256) VALUES($1,0,$2,$3,$4,$5,$6)',[hash,book.id,book.expression_id,book.edition_id,book.publication_sha256,book.package_sha256]);
 await pool.query("INSERT INTO derived_jobs(id,kind,source_sha256,recipe_sha256,status) VALUES($1,'translation',$2,$3,'queued')",[jobId,hash,recipes.translation.sha256]);await pool.query("INSERT INTO derived_requests(id,job_id,requested_by,status,audio_requested,approved_by,decision_reason) VALUES($1,$2,$3,'active',true,$3,'role-auto-approval')",[requestId,jobId,owner.id]);
 const legacyBody={kind:'translation',recipeSha256:recipes.translation.sha256,publicationIds:[book.id],snapshotId:null,sourceLanguage:null,discoveryRequestId:null,parentJobId:null,parentRequestId:null,audio:true};await pool.query('INSERT INTO derived_idempotency(profile_id,key,body_sha256,request_id) VALUES($1,$2,$3,$4)',[owner.id,body.idempotencyKey,sha256(Buffer.from(canonicalJson(legacyBody))),requestId]);
 const again=await createDerivedRequest(pool,owner,body);assert.equal(again.job.id,jobId);assert.equal(again.idempotent,true);assert.equal(again.job.source_manifest.schemaVersion,1);assert.equal((await claimDerivedJob(pool)).source.manifest.schemaVersion,1);assert.equal(await count('derived_jobs'),1);
 await assert.rejects(()=>createDerivedRequest(pool,owner,{...body,chapterRange:{start:1,count:5}}),{code:'DERIVED_IDEMPOTENCY'});
});
test('idempotency survives concurrent retries and never conflates source or options',async()=>{
 const book=await seedBook(),body=input(book),rows=await Promise.all(Array.from({length:6},()=>createDerivedRequest(pool,owner,body)));assert.equal(new Set(rows.map(row=>row.job.id)).size,1);assert.equal(await count('derived_requests'),1);assert.equal(await count('derived_idempotency'),1);
 await assert.rejects(()=>createDerivedRequest(pool,owner,{...body,audio:false}),{code:'DERIVED_IDEMPOTENCY'});const reused=await createDerivedRequest(pool,trusted,input(book));assert.equal(reused.reused,true);assert.equal(reused.job.id,rows[0].job.id);assert.notEqual(reused.request.id,rows[0].request.id);assert.equal(await count('derived_jobs'),1);
});
test('different recipes produce separate variants; exact originals never change',async()=>{
 const book=await seedBook(),before=(await pool.query('SELECT * FROM books WHERE id=$1',[book.id])).rows[0];await createDerivedRequest(pool,owner,input(book));const next=await registerDerivedRecipe(pool,{kind:'translation',language:'ru',manifest:{recipe:'v2',modelSha256:'a'.repeat(64)}}),other=await createDerivedRequest(pool,owner,input(book,'translation',{recipeSha256:next.sha256}));assert.equal(other.reused,false);assert.equal(await count('derived_jobs'),2);assert.deepEqual((await pool.query('SELECT * FROM books WHERE id=$1',[book.id])).rows[0],before);
});
test('unknown source language needs explicit confirmation and supported profile',async()=>{
 const und=await seedBook({language:'und'});await assert.rejects(()=>createDerivedRequest(pool,owner,input(und)),{code:'DERIVED_LANGUAGE_REQUIRED'});const accepted=await createDerivedRequest(pool,owner,input(und,'translation',{sourceLanguage:'en'}));assert.equal(accepted.job.status,'queued');
 const ru=await seedBook({language:'ru'});await assert.rejects(()=>createDerivedRequest(pool,owner,input(ru,'translation',{sourceLanguage:'en'})),{code:'DERIVED_LANGUAGE_REQUIRED'});await assert.rejects(()=>createDerivedRequest(pool,owner,input(ru)),{code:'DERIVED_LANGUAGE_UNSUPPORTED'});await assert.rejects(()=>createDerivedRequest(pool,owner,input(und,'audio',{sourceLanguage:'en'})),{code:'DERIVED_LANGUAGE_UNSUPPORTED'});
});
test('unsealed, blocked or mixed-identity source parts are rejected atomically',async()=>{
 const first=await seedBook(),second=await seedBook();await assert.rejects(()=>createDerivedRequest(pool,owner,input(first,'translation',{publicationIds:[first.id,second.id]})),{code:'DERIVED_SOURCE_MISMATCH'});
 await pool.query("UPDATE books SET security_state='blocked' WHERE id=$1",[first.id]);await assert.rejects(()=>createDerivedRequest(pool,owner,input(first)),{code:'DERIVED_SOURCE_BLOCKED'});assert.equal(await count('derived_sources'),0);
 await pool.query("UPDATE books SET security_state='passed' WHERE id=$1",[first.id]);await assert.rejects(()=>createDerivedRequest(pool,owner,input(first),{verifySource:async()=>{throw Error('Synthetic corrupt bytes');}}),/Synthetic corrupt bytes/);assert.equal(await count('derived_sources'),0);
});
test('ready Ranobe snapshots require every ordered publication, not first part',async()=>{
 const first=await seedBook(),second=await seedBook({model:{work_id:first.work_id,expression_id:first.expression_id,edition_id:first.edition_id}}),feed=randomUUID(),run=randomUUID(),parentImport=randomUUID();
 await pool.query("INSERT INTO imports(id,requested_by,kind,status) VALUES($1,$2,'ranobe','completed')",[parentImport,owner.id]);await pool.query("INSERT INTO ranobe_feeds(id,remote_id,slug,branch_key,language,requested_by) VALUES($1,'1','1--synthetic','default','en',$2)",[feed,owner.id]);await pool.query("INSERT INTO ranobe_runs(id,feed_id,import_id,inventory_sha256,chapter_count,policy_version) VALUES($1,$2,$3,$4,2,'synthetic')",[run,feed,parentImport,'1'.repeat(64)]);
 for(const [ordinal,book]of [first,second].entries())await pool.query("INSERT INTO ranobe_run_parts(id,run_id,ordinal,keys_sha256,source_keys,import_id,book_id,package_sha256,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'ready')",[randomUUID(),run,ordinal,String(ordinal+2).repeat(64),JSON.stringify(['chapter-'+ordinal]),book.import_id,book.id,book.package_sha256]);await pool.query("UPDATE ranobe_runs SET status='ready',activated_at=now() WHERE id=$1",[run]);
 await assert.rejects(()=>createDerivedRequest(pool,owner,input(first,'translation',{snapshotId:run})),{code:'DERIVED_SNAPSHOT'});await assert.rejects(()=>createDerivedRequest(pool,owner,input(first,'translation',{snapshotId:run,publicationIds:[second.id,first.id]})),{code:'DERIVED_SNAPSHOT'});const result=await createDerivedRequest(pool,owner,input(first,'translation',{snapshotId:run,publicationIds:[first.id,second.id]}));assert.equal(result.job.status,'queued');
});
test('source order contributes to identity and snapshots cannot be edited',async()=>{
 const first=await seedBook(),second=await seedBook({model:{work_id:first.work_id,expression_id:first.expression_id,edition_id:first.edition_id}}),a=await createDerivedRequest(pool,owner,input(first,'translation',{publicationIds:[first.id,second.id]})),b=await createDerivedRequest(pool,owner,input(first,'translation',{publicationIds:[second.id,first.id]}));assert.notEqual(a.job.source_sha256,b.job.source_sha256);await assert.rejects(()=>pool.query('UPDATE derived_sources SET manifest=manifest WHERE sha256=$1',[a.job.source_sha256]),/immutable/);await assert.rejects(()=>pool.query('DELETE FROM derived_source_parts WHERE source_sha256=$1',[a.job.source_sha256]),/immutable/);
});
test('claims share one heavy slot, expired attempts are fenced and progress persists',async()=>{
 const fixture=await readyClaim();await plan(fixture.claim);const first=await checkpoint(fixture.claim,0);await createDerivedRequest(pool,trusted,input(await seedBook()));assert.equal(await claimDerivedJob(pool),null);
 await pool.query("UPDATE derived_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[fixture.claim.id]);const claim=await claimDerivedJob(pool);assert.notEqual(claim.attempt_token,fixture.claim.attempt_token);await assert.rejects(()=>renewDerivedJob(pool,fixture.claim),{code:'DERIVED_LEASE_LOST'});await assert.rejects(()=>checkpoint(fixture.claim,1),{code:'DERIVED_LEASE_LOST'});assert.equal((await failDerivedJob(pool,fixture.claim,Error('late'))).stale,true);const saved=await listDerivedCheckpoints(pool,claim);assert.equal(saved.length,1);assert.equal(saved[0].output_sha256,first.output_sha256);assert.equal(claim.completed_segments,1);assert.equal((await pool.query('SELECT state FROM derived_attempts WHERE token=$1',[fixture.claim.attempt_token])).rows[0].state,'interrupted');
});
test('claim serialization is safe under concurrent polling',async()=>{
 const book=await seedBook();await createDerivedRequest(pool,owner,input(book));const claims=(await Promise.all(Array.from({length:8},()=>claimDerivedJob(pool)))).filter(Boolean);assert.equal(claims.length,1);assert.equal(await count('derived_attempts'),1);
});
test('plan identity, exact segment hash, ordered checkpoints and duplicate conflicts',async()=>{
 const {claim}=await readyClaim();await plan(claim);await assert.rejects(()=>plan(claim,['Changed source.']),{code:'DERIVED_PLAN_CONFLICT'});await assert.rejects(()=>checkpoint(claim,1),{code:'DERIVED_CHECKPOINT_ORDER'});await assert.rejects(()=>checkpointDerivedJob(pool,claim,{ordinal:0,sourceSha256:'f'.repeat(64),outputSha256:'a'.repeat(64),outputBytes:1,manifest:{path:'x'}}),{code:'DERIVED_CHECKPOINT_SOURCE'});
 const first=await checkpoint(claim,0);assert.equal(first.reused,false);assert.equal((await checkpoint(claim,0)).reused,true);await assert.rejects(()=>checkpoint(claim,0,'different'),{code:'DERIVED_CHECKPOINT_CONFLICT'});await assert.rejects(()=>pool.query('UPDATE derived_checkpoints SET output_bytes=2 WHERE job_id=$1',[claim.id]),/immutable/);assert.equal((await assertDerivedAttempt(pool,claim)).completed_segments,1);
});
test('thermal pause persists cooldown and checkpoints then resumes with new fence',async()=>{
 const {claim}=await readyClaim();await plan(claim);await checkpoint(claim,0);const paused=await pauseDerivedJob(pool,claim,{reason:'gpu-overheat',retryAfterSeconds:60});assert.equal(paused.status,'paused');assert.equal(paused.completed_segments,1);assert.equal(await claimDerivedJob(pool),null);await assert.rejects(()=>renewDerivedJob(pool,claim),{code:'DERIVED_LEASE_LOST'});
 await pool.query("UPDATE derived_jobs SET next_attempt_at=now()-interval '1 second' WHERE id=$1",[claim.id]);const next=await claimDerivedJob(pool);assert.equal(next.id,claim.id);assert.notEqual(next.attempt_token,claim.attempt_token);assert.equal((await listDerivedCheckpoints(pool,next)).length,1);await checkpoint(next,1);
});
test('owner pause and revoked roles fence every checkpoint and final commit',async()=>{
 const fixture=await readyClaim({profile:trusted});await plan(fixture.claim,['One']);await pool.query('UPDATE settings SET imports_paused=true WHERE id=1');await assert.rejects(()=>renewDerivedJob(pool,fixture.claim),{code:'IMPORT_PAUSED'});await assert.rejects(()=>checkpoint(fixture.claim,0),{code:'IMPORT_PAUSED'});assert.equal(await claimDerivedJob(pool),null);await pool.query('UPDATE settings SET imports_paused=false WHERE id=1');
 await pool.query("UPDATE profiles SET role='reader' WHERE id=$1",[trusted.id]);await assert.rejects(()=>checkpoint(fixture.claim,0),{code:'DERIVED_APPROVAL_REQUIRED'});const failed=await failDerivedJob(pool,fixture.claim,{code:'DERIVED_APPROVAL_REQUIRED'});assert.equal(failed.status,'approval-required');const request=await getDerivedRequest(pool,trusted,fixture.created.request.id);assert.equal(request.status,'pending-approval');assert.equal(request.approved_by,null);
});
test('cancelling one subscriber preserves another; final cancellation fences worker',async()=>{
 const fixture=await readyClaim(),shared=await createDerivedRequest(pool,trusted,input(fixture.book));await decideDerivedRequest(pool,owner,{id:fixture.created.request.id,expectedRevision:1,action:'cancel'});assert.equal((await assertDerivedAttempt(pool,fixture.claim)).id,fixture.claim.id);await decideDerivedRequest(pool,trusted,{id:shared.request.id,expectedRevision:1,action:'cancel'});await assert.rejects(()=>assertDerivedAttempt(pool,fixture.claim),{code:'DERIVED_LEASE_LOST'});assert.equal((await pool.query('SELECT status FROM derived_jobs WHERE id=$1',[fixture.claim.id])).rows[0].status,'cancelled');
});
test('source blocking after admission is checked on claim, renew and checkpoint',async()=>{
 const fixture=await readyClaim();await plan(fixture.claim);await pool.query("UPDATE books SET security_state='blocked' WHERE id=$1",[fixture.book.id]);await assert.rejects(()=>renewDerivedJob(pool,fixture.claim),{code:'DERIVED_SOURCE_BLOCKED'});await assert.rejects(()=>checkpoint(fixture.claim,0),{code:'DERIVED_SOURCE_BLOCKED'});assert.equal((await failDerivedJob(pool,fixture.claim,{code:'DERIVED_SOURCE_BLOCKED'})).status,'blocked');
 await assert.rejects(()=>decideDerivedRequest(pool,owner,{id:fixture.created.request.id,expectedRevision:1,action:'retry'}),{code:'DERIVED_SOURCE_BLOCKED'});
});
test('atomic finalization requires all segments and separate translation expression',async()=>{
 const fixture=await readyClaim();await plan(fixture.claim,['One']);await assert.rejects(()=>finishDerivedJob(pool,fixture.claim,null,{publish:translatedResult}),{code:'DERIVED_INCOMPLETE'});await checkpoint(fixture.claim,0);const before=await count('books');
 await assert.rejects(()=>finishDerivedJob(pool,fixture.claim,null,{publish:async(client,row,source)=>{await translatedResult(client,row,source);throw Error('Synthetic final transaction failure');}}),/Synthetic final transaction failure/);assert.equal(await count('books'),before);assert.equal(await count('derived_results'),0);
 const result=await finishDerivedJob(pool,fixture.claim,null,{publish:translatedResult});assert.notEqual(result.expression_id,fixture.book.expression_id);assert.equal(result.work_id,fixture.book.work_id);const saved=await getDerivedRequest(pool,owner,fixture.created.request.id);assert.equal(saved.status,'completed');assert.equal(saved.result.sha256,result.sha256);assert.equal(saved.job.status,'completed');assert.equal((await failDerivedJob(pool,fixture.claim,Error('ambiguous commit'))).published,true);await assert.rejects(()=>renewDerivedJob(pool,fixture.claim),{code:'DERIVED_LEASE_LOST'});
 await assert.rejects(()=>pool.query("UPDATE derived_jobs SET status='queued' WHERE id=$1",[fixture.claim.id]),/immutable/);await assert.rejects(()=>pool.query('DELETE FROM derived_results WHERE job_id=$1',[fixture.claim.id]),/immutable/);assert.equal((await pool.query('SELECT publication_sha256 FROM books WHERE id=$1',[fixture.book.id])).rows[0].publication_sha256,fixture.book.publication_sha256);
});
test('completed translation dedup does not rerun and reader result stays gated',async()=>{
 const fixture=await readyClaim();await completeTranslation(fixture);const readerRequest=await createDerivedRequest(pool,reader,input(fixture.book));assert.equal(readerRequest.job.status,'completed');assert.equal(readerRequest.request.status,'pending-approval');assert.equal((await getDerivedRequest(pool,reader,readerRequest.request.id)).result,null);const approved=await decideDerivedRequest(pool,owner,{id:readerRequest.request.id,expectedRevision:1,action:'approve'});assert.equal(approved.status,'completed');assert.ok((await getDerivedRequest(pool,reader,approved.id)).result);assert.equal(await claimDerivedJob(pool),null);assert.equal(await count('derived_attempts'),1);
});
test('one approved reader request inherits audio only for exact translated publications',async()=>{
 const book=await seedBook(),created=await createDerivedRequest(pool,reader,input(book)),approved=await decideDerivedRequest(pool,owner,{id:created.request.id,expectedRevision:1,action:'approve'}),claim=await claimDerivedJob(pool),fixture={book,created:{...created,request:approved},claim},translated=await completeTranslation(fixture),published=translated.manifest.publicationIds;
 const audio=await createDerivedRequest(pool,reader,{idempotencyKey:randomUUID(),kind:'audio',recipeSha256:recipes.audio.sha256,publicationIds:published,parentJobId:claim.id,parentRequestId:approved.id,sourceLanguage:'ru'});assert.equal(audio.request.status,'active');assert.equal(audio.request.approved_by,owner.id);assert.equal(audio.request.decision_reason,'owner-approval');assert.equal(audio.job.status,'queued');
 await assert.rejects(()=>createDerivedRequest(pool,reader,{idempotencyKey:randomUUID(),kind:'audio',recipeSha256:recipes.audio.sha256,publicationIds:[book.id],parentJobId:claim.id,parentRequestId:approved.id,sourceLanguage:'ru'}),{code:'DERIVED_PARENT'});
 const audioClaim=await claimDerivedJob(pool);assert.equal(audioClaim.kind,'audio');const current=await getDerivedRequest(pool,reader,approved.id);await decideDerivedRequest(pool,reader,{id:approved.id,expectedRevision:current.revision,action:'cancel'});await assert.rejects(()=>renewDerivedJob(pool,audioClaim),{code:'DERIVED_APPROVAL_REQUIRED'});
});
test('blocking original prevents audio even when translated books remain passed',async()=>{
 const fixture=await readyClaim();const translated=await completeTranslation(fixture);await pool.query("UPDATE books SET security_state='blocked' WHERE id=$1",[fixture.book.id]);await assert.rejects(()=>createDerivedRequest(pool,owner,{idempotencyKey:randomUUID(),kind:'audio',recipeSha256:recipes.audio.sha256,publicationIds:translated.manifest.publicationIds,sourceLanguage:'ru'}),{code:'DERIVED_SOURCE_BLOCKED'});assert.equal(await count('derived_jobs'),1);
});
test('reader visibility, owner decisions and optimistic request revisions are enforced',async()=>{
 const book=await seedBook(),a=await createDerivedRequest(pool,reader,input(book)),b=await createDerivedRequest(pool,other,input(book));await assert.rejects(()=>getDerivedRequest(pool,reader,b.request.id),{status:404});assert.equal((await listDerivedRequests(pool,reader)).length,1);assert.equal((await listDerivedRequests(pool,owner)).length,2);await assert.rejects(()=>decideDerivedRequest(pool,reader,{id:a.request.id,action:'approve',expectedRevision:1}),{status:403});await decideDerivedRequest(pool,owner,{id:a.request.id,action:'approve',expectedRevision:1});await assert.rejects(()=>decideDerivedRequest(pool,owner,{id:a.request.id,action:'cancel',expectedRevision:1}),{code:'DERIVED_CONFLICT'});
});
test('request lists preserve original work metadata across translated audio and reader visibility',async()=>{
 const original=await seedBook({title:'The original work title',author:'Original Writer'}),created=await createDerivedRequest(pool,owner,input(original)),claim=await claimDerivedJob(pool),translated=await completeTranslation({book:original,created,claim});
 const audio=await createDerivedRequest(pool,owner,{idempotencyKey:randomUUID(),kind:'audio',recipeSha256:recipes.audio.sha256,publicationIds:translated.manifest.publicationIds,parentJobId:claim.id,parentRequestId:created.request.id,sourceLanguage:'ru'});
 const rows=await listDerivedRequests(pool,owner);assert.equal(rows.length,2);for(const row of rows){assert.equal(row.source_title,'The original work title');assert.deepEqual(row.source_authors,['Original Writer']);assert.equal(row.source_language,row.kind==='translation'?'en':'ru');}
 const audioRow=rows.find(row=>row.job_id===audio.job.id);assert.equal(audioRow.parent_job_id,claim.id);assert.equal(audioRow.parent_request_id,created.request.id);
 const visible=await seedBook({title:'Reader visible title',author:'Known Writer'}),hidden=await seedBook({title:'Another profile private request',author:'Another Writer'});await createDerivedRequest(pool,reader,input(visible));await createDerivedRequest(pool,other,input(hidden));
 const personal=await listDerivedRequests(pool,{id:reader.id,role:'owner'});assert.equal(personal.length,1);assert.equal(personal[0].source_title,'Reader visible title');assert.deepEqual(personal[0].source_authors,['Known Writer']);assert.equal(personal[0].source_language,'en');assert.equal(JSON.stringify(personal).includes('Another profile private request'),false);
});
test('ready reading survives auto-approval revocation while new work remains fenced',async()=>{
 const fixture=await readyClaim({profile:trusted}),translated=await completeTranslation(fixture);await pool.query("UPDATE profiles SET role='reader' WHERE id=$1",[trusted.id]);const read=await getDerivedResult(pool,trusted,fixture.claim.id);assert.equal(read.result.sha256,translated.sha256);assert.ok((await getDerivedRequest(pool,trusted,fixture.created.request.id)).result);
 await assert.rejects(()=>createDerivedRequest(pool,trusted,{idempotencyKey:randomUUID(),kind:'audio',recipeSha256:recipes.audio.sha256,publicationIds:translated.manifest.publicationIds,parentJobId:fixture.claim.id,parentRequestId:fixture.created.request.id,sourceLanguage:'ru'}),{code:'DERIVED_PARENT'});
});
test('result and global publication reads check serving pause and original ancestry',async()=>{
 const fixture=await readyClaim(),translated=await completeTranslation(fixture),publicationId=translated.manifest.publicationIds[0];assert.equal((await assertDerivedPublication(pool,publicationId)).source.sha256,fixture.claim.source_sha256);await assert.rejects(()=>getDerivedResult(pool,other,fixture.claim.id),{status:404});
 await pool.query('UPDATE settings SET serving_paused=true WHERE id=1');await assert.rejects(()=>getDerivedResult(pool,owner,fixture.claim.id),{code:'SERVING_PAUSED'});await assert.rejects(()=>assertDerivedPublication(pool,publicationId),{code:'SERVING_PAUSED'});assert.equal((await getDerivedRequest(pool,owner,fixture.created.request.id)).result,null);
 await pool.query('UPDATE settings SET serving_paused=false WHERE id=1');await pool.query("UPDATE books SET security_state='blocked' WHERE id=$1",[fixture.book.id]);await assert.rejects(()=>getDerivedResult(pool,owner,fixture.claim.id),{code:'DERIVED_SOURCE_BLOCKED'});await assert.rejects(()=>assertDerivedPublication(pool,publicationId),{code:'DERIVED_SOURCE_BLOCKED'});
});
test('reader cannot upgrade a text-only owner approval to automatic audio',async()=>{
 const book=await seedBook(),textOnly=await createDerivedRequest(pool,reader,input(book,'translation',{audio:false}));await decideDerivedRequest(pool,owner,{id:textOnly.request.id,expectedRevision:1,action:'approve'});const claim=await claimDerivedJob(pool),translated=await completeTranslation({book,claim,created:textOnly});
 const upgraded=await createDerivedRequest(pool,reader,input(book,'translation',{audio:true}));assert.notEqual(upgraded.request.id,textOnly.request.id);assert.equal(upgraded.request.status,'pending-approval');assert.equal((await getDerivedRequest(pool,reader,textOnly.request.id)).audio_requested,false);
 await assert.rejects(()=>createDerivedRequest(pool,reader,{idempotencyKey:randomUUID(),kind:'audio',recipeSha256:recipes.audio.sha256,publicationIds:translated.manifest.publicationIds,parentJobId:claim.id,parentRequestId:textOnly.request.id,sourceLanguage:'ru'}),{code:'DERIVED_PARENT'});
});
test('expired other-kind lease cannot retain the unique heavy slot',async()=>{
 const audio=await readyClaim({kind:'audio',language:'ru'});await createDerivedRequest(pool,owner,input(await seedBook()));await pool.query("UPDATE derived_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[audio.claim.id]);const translation=await claimDerivedJob(pool,{kind:'translation'});assert.equal(translation.kind,'translation');assert.equal((await pool.query('SELECT status FROM derived_jobs WHERE id=$1',[audio.claim.id])).rows[0].status,'queued');
});
test('personal queue quota includes subscriptions to existing jobs and releases cancelled grants',async()=>{
 const books=[];for(let index=0;index<6;index++){const book=await seedBook();books.push(book);await createDerivedRequest(pool,index<5?owner:trusted,input(book));}
 const subscriptions=[];for(const book of books.slice(0,5))subscriptions.push(await createDerivedRequest(pool,reader,input(book)));
 await assert.rejects(()=>createDerivedRequest(pool,reader,input(books[5])),{code:'DERIVED_QUOTA'});await decideDerivedRequest(pool,reader,{id:subscriptions[0].request.id,action:'cancel',expectedRevision:1});assert.equal((await createDerivedRequest(pool,reader,input(books[5]))).request.status,'pending-approval');assert.equal(await count('derived_jobs'),6);
});
test('composite DB foreign keys reject cross-edition and cross-source parts',async()=>{
 const first=await seedBook(),other=await seedBook(),created=await createDerivedRequest(pool,owner,input(first));
 await assert.rejects(()=>pool.query('INSERT INTO derived_source_parts(source_sha256,ordinal,book_id,expression_id,edition_id,publication_sha256,package_sha256) VALUES($1,1,$2,$3,$4,$5,$6)',[created.job.source_sha256,other.id,first.expression_id,first.edition_id,other.publication_sha256,other.package_sha256]),{code:'23503'});
 await assert.rejects(()=>pool.query('INSERT INTO derived_source_parts(source_sha256,ordinal,book_id,expression_id,edition_id,publication_sha256,package_sha256) VALUES($1,1,$2,$3,$4,$5,$6)',[created.job.source_sha256,other.id,other.expression_id,other.edition_id,other.publication_sha256,other.package_sha256]),{code:'23503'});assert.equal((await pool.query('SELECT count(*)::int AS n FROM derived_source_parts WHERE source_sha256=$1',[created.job.source_sha256])).rows[0].n,1);
});
test('scanner outages pause with a durable retry clock and preserve every accepted checkpoint',async()=>{
 const fixture=await readyClaim();await plan(fixture.claim,['One source.']);const prefix=await checkpoint(fixture.claim,0);let current=fixture.claim;
 for(const code of ['SCAN_UNAVAILABLE','SCAN_STALE','SCAN_DEADLINE','SCAN_IDLE_TIMEOUT','SCAN_TRUNCATED','SCAN_PROTOCOL']){const paused=await failDerivedJob(pool,current,{code});assert.equal(paused.status,'paused');assert.equal(paused.completed_segments,1);assert.equal(paused.pause_reason,code);assert.equal(paused.error,null);assert.ok(new Date(paused.next_attempt_at)>new Date());assert.equal(await claimDerivedJob(pool),null);await pool.query("UPDATE derived_jobs SET next_attempt_at=now()-interval '1 second' WHERE id=$1",[current.id]);const next=await claimDerivedJob(pool);assert.notEqual(next.attempt_token,current.attempt_token);assert.equal((await listDerivedCheckpoints(pool,next))[0].output_sha256,prefix.output_sha256);current=next;}
});
test('threats are blocked with only a validated exact rejected hash in audit',async()=>{
 const fixture=await readyClaim(),hash=sha256(Buffer.from('inert synthetic threat fixture'));const blocked=await failDerivedJob(pool,fixture.claim,{code:'SCAN_THREAT',threat:true,sha256:hash});assert.equal(blocked.status,'blocked');const audit=(await pool.query("SELECT details FROM audit WHERE action='derived.blocked' AND target=$1",[fixture.claim.id])).rows[0].details;assert.equal(audit.rejectedSha256,hash);
 const another=await readyClaim();await failDerivedJob(pool,another.claim,{code:'DERIVED_INTEGRITY',blocked:true,sha256:'not-a-hash'});const details=(await pool.query("SELECT details FROM audit WHERE action='derived.blocked' AND target=$1",[another.claim.id])).rows[0].details;assert.equal(Object.hasOwn(details,'rejectedSha256'),false);
});
test('deterministic scanner input and configuration errors fail without automatic retries',async()=>{
 for(const code of ['SCAN_INPUT','SCAN_CONFIG']){const fixture=await readyClaim();const failed=await failDerivedJob(pool,fixture.claim,{code});assert.equal(failed.status,'failed');assert.equal(failed.next_attempt_at,null);assert.equal(failed.pause_reason,null);assert.equal(failed.error,code);}
});
test('only named transient database and transport errors pause with progress preserved',async()=>{
 const fixture=await readyClaim();await plan(fixture.claim,['One source.']);await checkpoint(fixture.claim,0);let claim=fixture.claim;
 for(const code of ['08006','08007','08P01','57P01','57P02','57P03','40001','40P01','53300','55P03','ECONNRESET','ETIMEDOUT','ECONNREFUSED','PROTOCOL_CONNECTION_LOST']){const paused=await failDerivedJob(pool,claim,{code});assert.equal(paused.status,'paused',code);assert.equal(paused.completed_segments,1);await pool.query("UPDATE derived_jobs SET next_attempt_at=now()-interval '1 second' WHERE id=$1",[claim.id]);claim=await claimDerivedJob(pool);}
 assert.equal((await failDerivedJob(pool,claim,{code:'DERIVED_PROFILE'})).status,'failed');
});
