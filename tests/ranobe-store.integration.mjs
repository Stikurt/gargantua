// Disposable PostgreSQL schema only; no provider network, raw files or services.
import test,{before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import pg from 'pg';
import {applyMigrations} from '../server/migrations.mjs';
import {claimImport} from '../server/import-jobs.mjs';
import {assignBookModel,sealPublicationModel} from '../server/work-model.mjs';
import {packageDigest} from '../server/publication-files.mjs';
import {sha256} from '../server/publication-model.mjs';
import {listSerialGroups,withSerialMembership} from '../server/serial-groups.mjs';
import {createRanobeRequest,createRanobeRequestInTransaction,beginRanobeRun,reuseUnchangedRanobeHead,getRanobeChapters,getRanobeRun,getRanobeFeed,getRanobeParts,saveRanobeChapter,ranobeChapterFingerprint,beginRanobePart,commitRanobePart,reuseRanobePart,activateRanobeRun,yieldRanobeRun,configureRanobeFeed,listDueRanobeFeeds,enqueueRanobeUpdate,registerRanobeScratch,finishRanobeScratch,listStaleRanobeScratch,removeStaleRanobeScratch} from '../server/ranobe-store.mjs';

const url=new URL(process.env.TEST_DATABASE_URL||'postgres://invalid/disabled');
if(process.env.GARGANTUA_TEST_ISOLATED!=='1'||!/^\/gargantua_test_[a-z0-9_]+$/.test(url.pathname))throw Error('Explicit isolated TEST_DATABASE_URL required; refusing production');
const schema='ranobe_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:url.href,max:1,statement_timeout:15000});
const isolated=new URL(url);isolated.searchParams.set('options',`-c search_path=${schema}`);const pool=new pg.Pool({connectionString:isolated.href,max:12,statement_timeout:15000});let created=false;
const owner={id:randomUUID()},trusted={id:randomUUID()},reader={id:randomUUID()},other={id:randomUUID()},capacity={checkCapacity:async()=>{}};
const input=(extra={})=>({url:'https://ranobelib.me/ru/book/123--synthetic',branch:null,idempotencyKey:randomUUID(),...extra});
const entries=(n=2,extra={})=>Array.from({length:n},(_,i)=>({key:'chapter-'+(i+1),revisionHint:'release-1',title:'Chapter '+(i+1),volume:'1',number:String(i+1),...extra}));
const one=(name='Chapter 1',content='Safe inert text')=>({title:'Synthetic novel',author:'Synthetic author',language:'ru',chapters:[{title:name,blocks:[{type:'text',text:content}]}],assets:{}});
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);created=true;await applyMigrations(pool);});
beforeEach(async()=>{await pool.query('TRUNCATE profiles,works RESTART IDENTITY CASCADE');await pool.query('UPDATE settings SET imports_paused=false,serving_paused=false WHERE id=1');for(const [p,role]of [[owner,'owner'],[trusted,'trusted-import'],[reader,'reader'],[other,'reader']])await pool.query('INSERT INTO profiles(id,login,password,role) VALUES($1,$2,$3,$4)',[p.id,'fixture-'+p.id,'synthetic-no-login',role]);});
after(async()=>{await pool.end();try{if(created){assert.match(schema,/^ranobe_[a-f0-9]{32}$/);await admin.query(`DROP SCHEMA ${schema} CASCADE`);}}finally{await admin.end();}});
const count=async table=>Number((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count);
async function start(n=2,actor=owner,requestInput=input()){
 const result=await createRanobeRequest(pool,actor,requestInput,capacity),parent=await claimImport(pool);assert.equal(parent.id,result.import.id);
 const run=await beginRanobeRun(pool,parent,{title:'Synthetic novel',author:'Synthetic author',policyVersion:'test-v1',chapters:entries(n)});return {...result,parent,run};
}
async function checkpoint(s,index=0,book=one('Chapter '+(index+1))){return saveRanobeChapter(pool,s.parent,s.run.id,'chapter-'+(index+1),{book,rawSha256:'a'.repeat(64),scannerVersion:'synthetic scanner',parserVersion:'test-1'});}
async function publishFixture(child,book){
 const raw=Buffer.from(JSON.stringify(book)),hash=sha256(raw),manifest={schemaVersion:1,files:[{path:'book.json',bytes:raw.length,sha256:hash}]},model=await assignBookModel(pool,book,{source:{provider:'ranobelib',remoteId:'123',variant:'branch:default:ru',kind:'human-translation'}});
 const row=(await pool.query('INSERT INTO books(id,title,author,language,chapter_count,sha256,import_id,requested_by,content_sha256,content_bytes,package_sha256,artifact_manifest,work_id,expression_id,edition_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$6,$9,$10,$11,$12,$13,$14) RETURNING *',[child.resultBookId,book.title,book.author,book.language,book.chapters.length,hash,child.id,child.requested_by,raw.length,packageDigest(manifest),JSON.stringify(manifest),model.work_id,model.expression_id,model.edition_id])).rows[0];
 await sealPublicationModel(pool,row,book);await pool.query("UPDATE imports SET status='completed',book_id=$1,security_state='passed',lease_expires_at=NULL WHERE id=$2",[row.id,child.id]);await pool.query("UPDATE import_attempts SET state='published' WHERE token=$1",[child.attempt_token]);return row;
}
async function readyPart(s,keys,books){const child=await beginRanobePart(pool,s.parent,s.run.id,{keys,title:'Synthetic novel — part'}),book={...books[0],chapters:books.flatMap(b=>b.chapters)},row=await publishFixture(child,book),verifyBook=async value=>{assert.equal(value.id,row.id);return book;};const part=await commitRanobePart(pool,s.parent,s.run.id,{keys,bookId:row.id,verifyBook});return {part,book,row,verifyBook};}
async function readyHead(n=1){const s=await start(n),books=entries(n).map(x=>one(x.title)),published=[];for(let i=0;i<n;i++)await checkpoint(s,i,books[i]);for(let i=0;i<n;i+=50)published.push(await readyPart(s,entries(n).slice(i,i+50).map(x=>x.key),books.slice(i,i+50)));const verifyBook=async row=>{const p=published.find(p=>p.row.id===row.id);assert.ok(p);return p.book;};await activateRanobeRun(pool,s.parent,s.run.id,{verifyBook});return {...s,published,verifyBook};}
const sameHead=(s,extra={})=>({title:'Synthetic novel',author:'Synthetic author',policyVersion:'test-v1',chapters:entries(s.run.chapter_count),verifyBook:s.verifyBook,...extra});
async function nextParent(actor=owner,extra={}){const result=await createRanobeRequest(pool,actor,input(extra),capacity),parent=await claimImport(pool);assert.equal(parent.id,result.import.id);return {...result,parent};}

test('logical library uses one pinned snapshot for multipart books without changing publication storage',async()=>{
 const s=await readyHead(51),before=(await pool.query('SELECT id,content_sha256,package_sha256 FROM books ORDER BY id')).rows;
 const ownerGroups=await listSerialGroups(pool,{...owner,role:'owner'}),readerGroups=await listSerialGroups(pool,{...reader,role:'reader'});
 assert.deepEqual(readerGroups,ownerGroups);assert.equal(ownerGroups.groups.length,1);const group=ownerGroups.groups[0];
 assert.equal(group.id,s.feed.id);assert.equal(group.snapshotId,s.run.id);assert.equal(group.totalChapters,51);assert.equal(group.snapshotStatus,'ready');assert.deepEqual(group.parts.map(p=>[p.chapterOffset,p.chapterCount]),[[0,50],[50,1]]);
 const marked=await withSerialMembership(pool,s.published.map(p=>p.row));assert.ok(marked.every(book=>book.serial_feed_id===s.feed.id));
 const next=await nextParent(),building=await beginRanobeRun(pool,next.parent,{title:'Synthetic novel',author:'Synthetic author',policyVersion:'test-v1',chapters:entries(52)});assert.notEqual(building.id,s.run.id);
 assert.equal((await listSerialGroups(pool,{...owner,role:'owner'})).groups[0].snapshotId,s.run.id,'an incomplete update never silently replaces a published head');
 await pool.query("UPDATE books SET security_state='blocked' WHERE id=$1",[s.published[1].row.id]);
 assert.equal((await listSerialGroups(pool,{...reader,role:'reader'})).groups[0].parts[1].securityState,'blocked');
 assert.deepEqual((await pool.query('SELECT id,content_sha256,package_sha256 FROM books ORDER BY id')).rows,before,'logical grouping never rewrites original bytes or identities');
});

test('an unfinished first logical book is visible only through its existing feed grant',async()=>{
 const s=await start(51),books=entries(50).map(x=>one(x.title));for(let i=0;i<50;i++)await checkpoint(s,i,books[i]);await readyPart(s,entries(50).map(x=>x.key),books);
 const groups=await listSerialGroups(pool,{...owner,role:'owner'});assert.equal(groups.groups.length,1);assert.equal(groups.groups[0].snapshotStatus,'building');assert.equal(groups.groups[0].totalChapters,51);assert.equal(groups.groups[0].parts.length,1);assert.equal(groups.groups[0].parts[0].chapterCount,50);
 assert.deepEqual((await listSerialGroups(pool,{...reader,role:'reader'})).groups,[]);
 const shared=await createRanobeRequest(pool,trusted,input(),capacity);assert.equal(shared.feed.id,s.feed.id);assert.equal((await listSerialGroups(pool,{...trusted,role:'trusted-import'})).groups[0].snapshotId,s.run.id);
});

test('console owner approval of a reader full-branch request records its grant and permits a real claim/run',async()=>{
 const request=await createRanobeRequest(pool,reader,input(),capacity);assert.equal(request.import.status,'pending-approval');assert.equal(await claimImport(pool),null);
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gargantua-ranobe-cli-'));
 try{
  const quarantine=path.join(root,'quarantine'),library=path.join(root,'library');await fs.mkdir(quarantine);await fs.mkdir(library);
  const runCli=(action,id)=>promisify(execFile)(process.execPath,['server/cli.mjs','requests',action,id],{cwd:process.cwd(),env:{...process.env,DATABASE_URL:isolated.href,QUARANTINE_DIR:quarantine,LIBRARY_DIR:library},timeout:20000,maxBuffer:8192});
  await runCli('approve',request.import.id);
  const approved=(await pool.query('SELECT * FROM imports WHERE id=$1',[request.import.id])).rows[0];assert.equal(approved.status,'queued');assert.equal(approved.requested_by,reader.id);assert.equal(approved.approved_by,owner.id);assert.equal(approved.decision_reason,'console-owner-approval');
  const event=(await pool.query("SELECT actor,details FROM audit WHERE action='import.approve' AND target=$1",[request.import.id])).rows;assert.equal(event.length,1);assert.equal(event[0].actor,owner.id);assert.equal(event[0].details.reason,'console-owner-approval');
  const parent=await claimImport(pool);assert.equal(parent.id,request.import.id);const run=await beginRanobeRun(pool,parent,{title:'CLI approved synthetic book',author:'',policyVersion:'test-v1',chapters:entries(1)});assert.ok(run.id);
  await pool.query("UPDATE imports SET status='source-review',lease_expires_at=NULL WHERE id=$1",[parent.id]);await assert.rejects(()=>runCli('approve',parent.id));assert.equal((await pool.query('SELECT status FROM imports WHERE id=$1',[parent.id])).rows[0].status,'source-review');assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit WHERE action='import.approve' AND target=$1",[parent.id])).rows[0].n,1);
  await runCli('retry',parent.id);const resumed=await claimImport(pool);assert.equal(resumed.id,parent.id);assert.equal(resumed.requested_by,reader.id);assert.equal(resumed.attempt_number,2);assert.equal(await count('imports'),1);
  assert.equal((await beginRanobeRun(pool,resumed,{title:'CLI approved synthetic book',author:'',policyVersion:'test-v1',chapters:entries(1)})).id,run.id,'same immutable inventory and same initiative resume');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('51 unchanged checks reuse one ready head without new runs/maps and preserve shared initiators/history',async()=>{
 const s=await readyHead(51),baseline={runs:await count('ranobe_runs'),maps:await count('ranobe_run_chapters'),parts:await count('ranobe_run_parts'),books:await count('books')};let checks=0,first;
 for(let i=0;i<51;i++){const next=await nextParent(i%2?owner:trusted);if(!i){first=next;const shared=await createRanobeRequest(pool,other,input(),capacity);assert.equal(shared.import.id,next.import.id);assert.equal(shared.import.requested_by,trusted.id);}
  const done=await reuseUnchangedRanobeHead(pool,next.parent,sameHead(s,{verifyBook:async row=>{checks++;return s.verifyBook(row);}}));assert.equal(done.unchanged,true);assert.equal(done.id,s.run.id);assert.equal(done.runId,s.run.id);assert.equal((await pool.query('SELECT status FROM imports WHERE id=$1',[next.parent.id])).rows[0].status,'completed');}
 assert.equal(checks,102);assert.deepEqual({runs:await count('ranobe_runs'),maps:await count('ranobe_run_chapters'),parts:await count('ranobe_run_parts'),books:await count('books')},baseline);const results=(await pool.query('SELECT * FROM ranobe_feed_requests WHERE import_id=$1 ORDER BY created_at',[first.parent.id])).rows;assert.equal(results.length,2);assert.deepEqual(results.map(r=>r.profile_id),[trusted.id,other.id]);assert.ok(results.every(r=>r.result_run_id===s.run.id));
 const historical=await createRanobeRequest(pool,trusted,{...input(),idempotencyKey:first.request.idempotency_key},capacity);assert.equal(historical.idempotent,true);assert.equal(historical.import.id,first.parent.id);assert.equal(historical.request.result_run_id,s.run.id);await assert.rejects(()=>pool.query('UPDATE ranobe_feed_requests SET result_run_id=NULL WHERE id=$1',[first.request.id]),/immutable/);
});
test('force, changed inventory and changed policy bypass fast reuse and build distinct durable snapshots',async()=>{
 const s=await readyHead(2);
 for(const scenario of [{request:{force:true},plan:{}},{request:{},plan:{chapters:entries(3)}},{request:{},plan:{policyVersion:'test-v2'}}]){
  const next=await nextParent(owner,scenario.request),plan=sameHead(s,scenario.plan);assert.equal(await reuseUnchangedRanobeHead(pool,next.parent,plan),null);const run=await beginRanobeRun(pool,next.parent,plan);assert.notEqual(run.id,s.run.id);assert.equal(run.chapter_count,plan.chapters.length);assert.equal(Number((await pool.query('SELECT count(*) FROM ranobe_run_chapters WHERE run_id=$1',[run.id])).rows[0].count),plan.chapters.length);await pool.query("UPDATE imports SET status='cancelled',lease_expires_at=NULL WHERE id=$1",[next.parent.id]);
 }
 assert.equal((await getRanobeFeed(pool,s.feed.id)).head_run_id,s.run.id);assert.equal(await count('ranobe_runs'),4);
});
test('fast reuse requires physical verification and fresh passed/role/lease decisions before committing',async()=>{
 const s=await readyHead(),next=await nextParent(trusted),bookId=s.published[0].row.id;await pool.query("UPDATE books SET security_state='blocked' WHERE id=$1",[bookId]);await assert.rejects(()=>reuseUnchangedRanobeHead(pool,next.parent,sameHead(s)),{code:'RANOBE_SOURCE_BLOCKED'});await pool.query("UPDATE books SET security_state='passed' WHERE id=$1",[bookId]);
 await assert.rejects(()=>reuseUnchangedRanobeHead(pool,next.parent,sameHead(s,{verifyBook:async()=>{throw Object.assign(Error('Synthetic corruption'),{code:'PUBLICATION_INTEGRITY'});}})),{code:'PUBLICATION_INTEGRITY'});
 await assert.rejects(()=>reuseUnchangedRanobeHead(pool,next.parent,sameHead(s,{verifyBook:async row=>{await pool.query("UPDATE books SET security_state='blocked' WHERE id=$1",[bookId]);return s.verifyBook(row);}})),{code:'RANOBE_SOURCE_BLOCKED'});await pool.query("UPDATE books SET security_state='passed' WHERE id=$1",[bookId]);
 await assert.rejects(()=>reuseUnchangedRanobeHead(pool,next.parent,sameHead(s,{verifyBook:async row=>{await pool.query("UPDATE profiles SET role='reader' WHERE id=$1",[trusted.id]);return s.verifyBook(row);}})),{code:'APPROVAL_REVOKED'});await pool.query("UPDATE profiles SET role='trusted-import' WHERE id=$1",[trusted.id]);
 await assert.rejects(()=>reuseUnchangedRanobeHead(pool,next.parent,sameHead(s,{verifyBook:async row=>{await pool.query("UPDATE imports SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[next.parent.id]);return s.verifyBook(row);}})),{code:'LEASE_LOST'});
 assert.equal((await pool.query('SELECT status FROM imports WHERE id=$1',[next.parent.id])).rows[0].status,'processing');assert.equal((await pool.query('SELECT result_run_id FROM ranobe_feed_requests WHERE id=$1',[next.request.id])).rows[0].result_run_id,null);assert.equal(await count('ranobe_runs'),1);assert.equal((await getRanobeFeed(pool,s.feed.id)).head_run_id,s.run.id);
});

test('branch is explicit, roles are re-read and shared request provenance is never stolen',async()=>{
 const absent=input();delete absent.branch;await assert.rejects(()=>createRanobeRequest(pool,owner,absent,capacity),{status:400});
 const value=input(),a=await createRanobeRequest(pool,{...reader,role:'owner'},value,capacity),b=await createRanobeRequest(pool,other,input(),capacity);assert.equal(a.import.status,'pending-approval');assert.equal(b.import.id,a.import.id);assert.equal(b.import.requested_by,reader.id);assert.equal(b.request.profile_id,other.id);assert.equal(await count('imports'),1);assert.equal(await count('ranobe_feed_requests'),2);
 const again=await createRanobeRequest(pool,reader,value,capacity);assert.equal(again.idempotent,true);await assert.rejects(()=>createRanobeRequest(pool,reader,{...value,language:'en'},capacity),{code:'RANOBE_IDEMPOTENCY'});assert.equal(await count('audit'),2);
});
test('concurrent branch requests have one active import; force does not silently reuse a weaker request',async()=>{
 const result=await Promise.all(Array.from({length:8},()=>createRanobeRequest(pool,owner,input(),capacity)));assert.equal(new Set(result.map(x=>x.import.id)).size,1);assert.equal(await count('imports'),1);assert.equal(await count('ranobe_feed_requests'),8);
 await assert.rejects(()=>createRanobeRequest(pool,owner,input({force:true}),capacity),{code:'RANOBE_FORCE_BUSY'});const branch=await createRanobeRequest(pool,owner,input({branch:77}),capacity);assert.notEqual(branch.feed.id,result[0].feed.id);
});
test('owner sharing a pending reader request approves it without changing the first initiator',async()=>{
 const first=await createRanobeRequest(pool,reader,input(),capacity),trustedShare=await createRanobeRequest(pool,trusted,input(),capacity);assert.equal(trustedShare.import.status,'pending-approval');
 const ownerShare=await createRanobeRequest(pool,owner,input(),capacity);assert.equal(ownerShare.import.id,first.import.id);assert.equal(ownerShare.import.status,'queued');assert.equal(ownerShare.import.requested_by,reader.id);assert.equal(ownerShare.import.approved_by,owner.id);assert.equal(ownerShare.import.decision_reason,'shared-owner-approval');assert.equal(ownerShare.request.profile_id,owner.id);assert.equal(await count('imports'),1);
 const parent=await claimImport(pool);const run=await beginRanobeRun(pool,parent,{title:'Shared safe novel',author:'',policyVersion:'test-v1',chapters:entries(1)});assert.ok(run.id);await pool.query("UPDATE profiles SET role='reader' WHERE id=$1",[owner.id]);await assert.rejects(()=>saveRanobeChapter(pool,parent,run.id,'chapter-1',{book:one(),rawSha256:'a'.repeat(64),scannerVersion:'synthetic',parserVersion:'1'}),{code:'APPROVAL_REVOKED'});
});
test('capacity failure and surrounding transaction rollback leave no orphan import/feed/request',async()=>{
 await assert.rejects(()=>createRanobeRequest(pool,owner,input(),{checkCapacity:async()=>{throw Object.assign(Error('Synthetic full'),{status:507});}}),{status:507});assert.equal(await count('imports'),0);assert.equal(await count('ranobe_feeds'),0);
 const c=await pool.connect();try{await c.query('BEGIN');await createRanobeRequestInTransaction(c,owner,input(),capacity);await c.query('ROLLBACK');}finally{c.release();}assert.equal(await count('imports'),0);assert.equal(await count('ranobe_feed_requests'),0);
});
test('20k inventory is durable and resumable across attempt tokens, without widening parser limits',async()=>{
 const s=await start(20000);assert.equal(s.run.chapter_count,20000);assert.equal(await count('ranobe_run_chapters'),20000);assert.equal((await getRanobeChapters(pool,s.run.id,{after:19998}))[0].source_key,'chapter-20000');
 await yieldRanobeRun(pool,s.parent,s.run.id);const parent=await claimImport(pool);assert.notEqual(parent.attempt_token,s.parent.attempt_token);const same=await beginRanobeRun(pool,parent,{title:'Changed source',author:'',policyVersion:'test-v2',chapters:entries(1)});assert.equal(same.id,s.run.id);assert.equal(same.chapter_count,20000);await assert.rejects(()=>checkpoint(s),{code:'LEASE_LOST'});
});
test('checkpoint content is strict inert one-chapter data; fingerprint and policy are immutable',async()=>{
 const s=await start(),saved=await checkpoint(s);assert.equal(saved.content_sha256,ranobeChapterFingerprint(one()));assert.equal((await checkpoint(s)).id,saved.id);
 await assert.rejects(()=>checkpoint(s,0,one('Chapter 1','Different')),{code:'RANOBE_CHECKPOINT_CONFLICT'});await assert.rejects(()=>checkpoint(s,1,{...one(),html:'<script>unsafe</script>'}),{code:'PUBLICATION_INTEGRITY'});await assert.rejects(()=>checkpoint(s,1,{...one(),chapters:[...one().chapters,...one().chapters]}),{status:400});
 await assert.rejects(()=>pool.query('UPDATE ranobe_chapters SET content_sha256=$1 WHERE id=$2',['b'.repeat(64),saved.id]),/immutable/);assert.equal((await getRanobeChapters(pool,s.run.id))[0].prepared_book.chapters.length,1);
});
test('global prepared cache has a real 64 MiB bound across valid large inert checkpoints',async()=>{
 const s=await start(4),chunk='x'.repeat(100000),large=index=>({...one('Chapter '+(index+1)),chapters:[{title:'Chapter '+(index+1),blocks:Array.from({length:200},()=>({type:'text',text:chunk}))}]});
 for(let i=0;i<3;i++)await checkpoint(s,i,large(i));
 const before=Number((await pool.query('SELECT sum(prepared_bytes) AS bytes FROM ranobe_chapters WHERE prepared_book IS NOT NULL')).rows[0].bytes);assert.ok(before<64*1024*1024&&before>56*1024*1024);
 await assert.rejects(()=>checkpoint(s,3,large(3)),{code:'RANOBE_CACHE_FULL',status:507});assert.equal(await count('ranobe_chapters'),3);assert.equal((await pool.query('SELECT chapter_id FROM ranobe_run_chapters WHERE run_id=$1 AND ordinal=3',[s.run.id])).rows[0].chapter_id,null);
 await pool.query("UPDATE imports SET status='cancelled',lease_expires_at=NULL WHERE id=$1",[s.parent.id]);
 const next=await start(1,owner,input({url:'https://ranobelib.me/ru/book/456--reclamation'}));await checkpoint(next,0,large(0));
 assert.equal(await count('ranobe_chapters'),3);assert.equal((await pool.query('SELECT count(*)::int AS n FROM ranobe_run_chapters WHERE run_id=$1 AND chapter_id IS NOT NULL',[s.run.id])).rows[0].n,2);assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit WHERE action='ranobe.checkpoint-evicted'")).rows[0].n,1);assert.equal(await count('books'),0);const used=Number((await pool.query('SELECT sum(prepared_bytes) AS bytes FROM ranobe_chapters WHERE prepared_book IS NOT NULL')).rows[0].bytes);assert.ok(used<=64*1024*1024);
});
test('part range is bounded, non-overlapping and generated child is never queued',async()=>{
 const s=await start(3);for(let i=0;i<3;i++)await checkpoint(s,i);const child=await beginRanobePart(pool,s.parent,s.run.id,{keys:['chapter-1','chapter-2'],title:'Part 1'});assert.equal(child.status,'processing');assert.equal(child.kind,'ranobe-part');assert.equal(child.options.ranobePart.parentId,s.parent.id);
 await assert.rejects(()=>beginRanobePart(pool,s.parent,s.run.id,{keys:['chapter-2','chapter-3'],title:'Overlap'}),{code:'RANOBE_PART_OVERLAP'});await assert.rejects(()=>beginRanobePart(pool,s.parent,s.run.id,{keys:['chapter-1','chapter-3'],title:'Gap'}),{code:'RANOBE_PART'});assert.equal(await count('ranobe_run_parts'),1);
});
test('commit checks exact chapters and actual deduplicated book ID before clearing safe cache',async()=>{
 const s=await start();await checkpoint(s,0);await checkpoint(s,1);const child=await beginRanobePart(pool,s.parent,s.run.id,{keys:['chapter-1','chapter-2'],title:'Part'}),book={...one(),chapters:[...one().chapters,...one('Chapter 2').chapters]},row=await publishFixture(child,book);
 await assert.rejects(()=>commitRanobePart(pool,s.parent,s.run.id,{keys:['chapter-1','chapter-2'],bookId:row.id,verifyBook:async()=>({...book,chapters:[...one('Wrong').chapters,...one('Chapter 2').chapters]})}),{code:'RANOBE_PART_HASH'});assert.equal((await getRanobeChapters(pool,s.run.id))[0].book_id,null);
 const part=await commitRanobePart(pool,s.parent,s.run.id,{keys:['chapter-1','chapter-2'],bookId:row.id,verifyBook:async()=>book});assert.equal(part.book_id,row.id);const chapters=await getRanobeChapters(pool,s.run.id);assert.equal(chapters[0].prepared_book,null);assert.equal(chapters[1].chapter_index,1);
});
test('only a fully verified snapshot activates; previous packages, notes and snapshots stay readable',async()=>{
 const s=await start();await checkpoint(s,0);await checkpoint(s,1);await assert.rejects(()=>activateRanobeRun(pool,s.parent,s.run.id,{verifyBook:async()=>one()}),{code:'RANOBE_INCOMPLETE'});assert.equal((await getRanobeFeed(pool,s.feed.id)).head_run_id,null);
 const p=await readyPart(s,['chapter-1','chapter-2'],[one(),one('Chapter 2')]);await pool.query('INSERT INTO bookmarks(id,profile_id,book_id,chapter,note) VALUES($1,$2,$3,1,$4)',[randomUUID(),owner.id,p.row.id,'Synthetic preserved note']);
 await activateRanobeRun(pool,s.parent,s.run.id,{verifyBook:p.verifyBook});assert.equal((await getRanobeFeed(pool,s.feed.id)).head_run_id,s.run.id);await assert.rejects(()=>pool.query('UPDATE ranobe_run_chapters SET ordinal=100 WHERE run_id=$1 AND ordinal=0',[s.run.id]),/immutable/);await assert.rejects(()=>pool.query("UPDATE ranobe_runs SET status='abandoned',activated_at=NULL WHERE id=$1",[s.run.id]),/immutable/);
 const update=await start(3);const old=await getRanobeChapters(pool,update.run.id);assert.equal(old[0].book_id,p.row.id);assert.equal(old[1].book_id,p.row.id);assert.equal(old[2].chapter_id,null);assert.equal((await getRanobeRun(pool,s.run.id)).status,'ready');assert.equal(await count('bookmarks'),1);
 await reuseRanobePart(pool,update.parent,update.run.id,{keys:['chapter-1','chapter-2'],bookId:p.row.id,verifyBook:p.verifyBook});assert.equal(await count('books'),1);await checkpoint(update,2);const next=await readyPart(update,['chapter-3'],[one('Chapter 3')]);await activateRanobeRun(pool,update.parent,update.run.id,{verifyBook:async row=>row.id===p.row.id?p.book:next.book});assert.equal((await getRanobeFeed(pool,s.feed.id)).head_run_id,update.run.id);assert.equal(await count('books'),2);assert.equal(await count('bookmarks'),1);
});
test('blocking a published part prevents head activation and preserves the old head',async()=>{
 const s=await start(1);await checkpoint(s);const p=await readyPart(s,['chapter-1'],[one()]);await pool.query("UPDATE books SET security_state='blocked' WHERE id=$1",[p.row.id]);await assert.rejects(()=>activateRanobeRun(pool,s.parent,s.run.id,{verifyBook:p.verifyBook}),{code:'RANOBE_SOURCE_BLOCKED',blocked:true,status:423});assert.equal((await getRanobeFeed(pool,s.feed.id)).head_run_id,null);
});
test('pause and role revocation fence checkpoint, scratch and publication changes',async()=>{
 const s=await start(1,trusted);await pool.query('UPDATE settings SET imports_paused=true WHERE id=1');await assert.rejects(()=>checkpoint(s),{code:'IMPORT_PAUSED'});await pool.query('UPDATE settings SET imports_paused=false WHERE id=1');await pool.query("UPDATE profiles SET role='reader' WHERE id=$1",[trusted.id]);await assert.rejects(()=>checkpoint(s),{code:'APPROVAL_REVOKED'});assert.equal(await count('ranobe_chapters'),0);
});
test('scheduler rechecks trusted role and owner grants; revocation disables automation',async()=>{
 const s=await start(1,trusted);await pool.query("UPDATE imports SET status='cancelled',lease_expires_at=NULL WHERE id=$1",[s.parent.id]);await pool.query("UPDATE ranobe_feeds SET next_check_at=now()-interval '1 second' WHERE id=$1",[s.feed.id]);assert.equal((await listDueRanobeFeeds(pool)).length,1);
 const scheduled=await enqueueRanobeUpdate(pool,s.feed.id,capacity);assert.equal(scheduled.import.decision_reason,'role-auto-approval');const parent=await claimImport(pool);const run=await beginRanobeRun(pool,parent,{title:'Synthetic novel',author:'Synthetic author',policyVersion:'test-v1',chapters:entries(1)});assert.ok(run.id);
 await pool.query("UPDATE imports SET status='cancelled',lease_expires_at=NULL WHERE id=$1",[parent.id]);await pool.query("UPDATE profiles SET role='reader' WHERE id=$1",[trusted.id]);await pool.query("UPDATE ranobe_feeds SET next_check_at=now()-interval '1 second' WHERE id=$1",[s.feed.id]);assert.equal((await enqueueRanobeUpdate(pool,s.feed.id,capacity)).revoked,true);assert.equal((await getRanobeFeed(pool,s.feed.id)).auto_update,false);
 const feed=await getRanobeFeed(pool,s.feed.id);await configureRanobeFeed(pool,owner,feed.id,{autoUpdate:true,expectedRevision:feed.revision});const granted=await enqueueRanobeUpdate(pool,feed.id,capacity);assert.equal(granted.import.requested_by,trusted.id);assert.equal(granted.import.approved_by,owner.id);assert.equal(granted.import.decision_reason,'feed-owner-approval');
});
test('tracked scratch is attempt-fenced and stale cleanup does not remove live trackers',async()=>{
 const s=await start(1),token=randomUUID();await registerRanobeScratch(pool,s.parent,s.run.id,{token,key:'chapter-1'});assert.equal((await listStaleRanobeScratch(pool)).length,0);await assert.rejects(()=>removeStaleRanobeScratch(pool,token),{code:'LEASE_LOST'});assert.equal(await finishRanobeScratch(pool,s.parent,s.run.id,token),1);
 const stale=randomUUID();await registerRanobeScratch(pool,s.parent,s.run.id,{token:stale,key:'chapter-1',rawSha256:'a'.repeat(64)});await yieldRanobeRun(pool,s.parent,s.run.id);assert.equal((await listStaleRanobeScratch(pool)).length,0);await pool.query("UPDATE import_attempts SET ended_at=now()-interval '71 seconds' WHERE token=$1",[s.parent.attempt_token]);assert.equal((await listStaleRanobeScratch(pool))[0].token,stale);assert.equal(await removeStaleRanobeScratch(pool,stale),true);assert.equal(await count('ranobe_scratch'),0);
});
