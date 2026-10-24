// Real isolated PostgreSQL + real immutable publication files. Source, parser
// and scanner below are fixtures: this suite is NOT an AV or OS-sandbox test.
import test,{before,beforeEach,afterEach,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {applyMigrations} from '../server/migrations.mjs';
import {claimImport,assertAttempt,attemptStage,failImport} from '../server/import-jobs.mjs';
import {createRanobeRequest,beginRanobeRun,assertRanobeRun,getRanobeFeed,getRanobeRun,getRanobeParts,getRanobeChapters,ranobeChapterFingerprint} from '../server/ranobe-store.mjs';
import {processRanobeFull,ranobeInventoryDescriptors,RANOBE_POLICY} from '../server/ranobe-acquisition.mjs';
import {normalizeRanobeInventory,selectRanobeBranch,verifyRanobeChapter} from '../server/ranobe.mjs';
import {readPublication,validateBook} from '../server/publication-files.mjs';
import {checkedPublicationView,sha256} from '../server/publication-model.mjs';

const database=new URL(process.env.TEST_DATABASE_URL||'postgres://invalid/disabled');
if(process.env.GARGANTUA_TEST_ISOLATED!=='1'||!/^\/gargantua_test_[a-z0-9_]+$/.test(database.pathname))throw Error('Explicit isolated TEST_DATABASE_URL required; refusing production');
const schema='ranobe_acquisition_'+randomUUID().replaceAll('-','');
const admin=new pg.Pool({connectionString:database.href,max:1,statement_timeout:15000});
const isolated=new URL(database);isolated.searchParams.set('options',`-c search_path=${schema}`);
const pool=new pg.Pool({connectionString:isolated.href,max:8,statement_timeout:15000});
const owner={id:randomUUID()},slug='123--synthetic',url=`https://ranobelib.me/ru/book/${slug}`;
const capacity={checkCapacity:async()=>{}},png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
let created=false,roots;

before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);created=true;await applyMigrations(pool);});
beforeEach(async()=>{
 await pool.query('TRUNCATE profiles,works RESTART IDENTITY CASCADE');
 await pool.query('UPDATE settings SET imports_paused=false,serving_paused=false WHERE id=1');
 await pool.query("INSERT INTO profiles(id,login,password,role) VALUES($1,$2,'synthetic-no-login','owner')",[owner.id,'fixture-'+owner.id]);
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gargantua-ranobe-acquisition-'));
 roots={root,quarantine:path.join(root,'quarantine'),jobs:path.join(root,'jobs'),library:path.join(root,'library')};
 for(const directory of [roots.library,path.join(roots.quarantine,'incoming'),path.join(roots.quarantine,'attempts'),path.join(roots.jobs,'pending'),path.join(roots.jobs,'results')])await fs.mkdir(directory,{recursive:true,mode:0o700});
});
afterEach(async()=>{if(roots){assert.equal(path.dirname(roots.root),os.tmpdir());assert.match(path.basename(roots.root),/^gargantua-ranobe-acquisition-/);await fs.rm(roots.root,{recursive:true,force:true});roots=null;}});
after(async()=>{await pool.end();try{if(created){assert.match(schema,/^ranobe_acquisition_[a-f0-9]{32}$/);await admin.query(`DROP SCHEMA ${schema} CASCADE`);}}finally{await admin.end();}});

const count=async table=>Number((await pool.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
const error=(code,message=code,extra={})=>Object.assign(new Error(message),{code,...extra});
function inventory(size,{branch=null,incomplete=false,restrictedAt=0}={}){
 const list=Array.from({length:size},(_,i)=>({id:1001+i,index:i+1,volume:'1',number:String(i+1),number_secondary:'1',branches_count:1,branches:[{id:1001+i,branch_id:branch,created_at:'2021-01-01T00:00:00.000000Z',expired_type:i+1===restrictedAt?1:0,teams:[{id:7,name:'Fixture team'}]}]}));
 return normalizeRanobeInventory({slug,meta:{id:123,site:3,slug_url:slug,rus_name:'Synthetic novel',authors:[{name:'Synthetic author'}],is_licensed:false,items_count:{uploaded:size+(incomplete?1:0),total:0}},list,envelope:{data:list}});
}

// Construct deterministic inert parser output while retaining a local footnote
// reference and image resource. No source HTML is executed or called safe here.
function parsedFixture(bundle,{rich=false}={}){
 const html=bundle.chapters[0].html,match=html.match(/fixture chapter (\d+)/),number=Number(match?.[1]);
 assert.ok(Number.isSafeInteger(number)&&number>0,'fixture chapter body binds its number');
 const text=`Body of fixture chapter ${number}.`,assets={},blocks=[{type:'text',text}];
 const structured=[{id:'paragraph',type:'paragraph',text,spans:[{start:0,end:4,kind:'link',target:'note'}]},{id:'note',type:'footnote',text:'A local fixture note.',referenceId:'paragraph'}];
 blocks.push({type:'text',text:'A local fixture note.'});
 const images=Object.values(bundle.images);if(images.length){
  assert.equal(images.length,1);const name=number%2?'image-7.png':'image-9.png';assets[name]=images[0];
  blocks.push({type:'image',asset:name,text:'Fixture illustration'});structured.push({id:'illustration',type:'image',resource:name,text:'Fixture illustration'});
 }
 const book={title:bundle.title,author:bundle.author,language:bundle.language,chapters:[{title:bundle.chapters[0].title,blocks}],assets};
 if(rich)book.structure={schemaVersion:2,chapters:[{id:'parsed-chapter',revision:1,title:bundle.chapters[0].title,blocks:structured}],warnings:[]};
 validateBook(book);return {book,rawSha256:sha256(Buffer.from(JSON.stringify(bundle))),scanner:'synthetic scanner fixture; not real AV'};
}
function source(size,options={}){
 const state={size,options,fetches:[],parses:[],images:[],scans:[],resolves:0};
 state.adapter={
  resolveRanobe:async requested=>{assert.equal(requested,url);state.resolves++;return inventory(state.size,state.options);},
  fetchRanobeChapter:async(info,chapter,branchId)=>{
   const n=Number(chapter.number);state.fetches.push(n);
   if(n===state.options.missingAt)throw error('RANOBE_CONTENT','Synthetic chapter missing');
   const data={id:chapter.branches[0].id,manga_id:123,branch_id:branchId,volume:chapter.volume,number:chapter.number,number_secondary:'1',content:`<p>fixture chapter ${n}</p>${state.options.images?`<img src="https://imglib.info/fixture-${n}.png">`:''}${n===state.options.threatAt?'SYNTHETIC-THREAT-MARKER':''}`,expired_type:0,expired_at:null,bundle_id:null,type:'chapter'};
   if(n===state.options.wrongBranchAt)data.branch_id=77;
   if(n===state.options.restrictedResponseAt)data.is_paid=true;
   return {data:verifyRanobeChapter(data,{slug:info.slug,chapter,branchId}),raw:Buffer.from(JSON.stringify({data}))};
  }
 };
 state.parseChapter=async(_pool,_parent,_run,key,bundle)=>{const parsed=parsedFixture(bundle,state.options);state.parses.push({key,rawSha256:parsed.rawSha256,bundle:structuredClone(bundle)});await state.options.afterParse?.(state.parses.length);return parsed;};
 state.scanBytes=async bytes=>{assert.ok(Buffer.isBuffer(bytes));state.scans.push(sha256(bytes));if(bytes.includes(Buffer.from('SYNTHETIC-THREAT-MARKER')))throw error('SYNTHETIC_AV_THREAT','Synthetic scanner fixture threat',{threat:true});};
 state.fetchImage=async(imageUrl,opts)=>{assert.equal(new URL(imageUrl).hostname,'imglib.info');assert.equal(opts.maxRedirects,0);assert.equal(opts.headers.Referer,'https://ranobelib.me/');assert.equal(opts.headers.Cookie,undefined);state.images.push(imageUrl);return {buffer:Buffer.from(png),url:imageUrl,type:'image/png'};};
 return state;
}
async function request(extra={}){
 const created=await createRanobeRequest(pool,owner,{url,branch:null,idempotencyKey:randomUUID(),...extra},capacity),parent=await claimImport(pool);
 assert.ok(parent);assert.equal(parent.id,created.import.id);return {...created,parent};
}
async function execute(parent,fixture,options={}){
 const report={checks:[]};
 try{return await processRanobeFull(pool,parent,{...roots,report,signal:new AbortController().signal,
  allowed:async()=>assertAttempt(pool,parent),stage:async value=>attemptStage(pool,parent,value,report),record:async value=>report.checks.push(value),waitResources:async()=>{await options.waitResources?.();},
  adapter:fixture.adapter,parseChapter:fixture.parseChapter,scanBytes:fixture.scanBytes,fetchImage:fixture.fetchImage,version:async()=> 'synthetic scanner fixture; not real AV',maxPartsPerSlice:options.maxPartsPerSlice??100});}
 catch(failure){await failImport(pool,parent,failure,report);throw failure;}
}
async function publications(runId){
 const parts=await getRanobeParts(pool,runId),result=[];
 for(const part of parts){assert.equal(part.status,'ready');const row=(await pool.query('SELECT * FROM books WHERE id=$1',[part.book_id])).rows[0];const checked=await readPublication(roots.library,row);checkedPublicationView(row,checked.content);assert.equal(sha256(checked.raw),row.content_sha256);result.push({part,row,book:checked.content});}
 return result;
}
async function noHead(feedId){assert.equal((await getRanobeFeed(pool,feedId)).head_run_id,null);assert.equal((await pool.query("SELECT count(*)::int AS n FROM ranobe_runs WHERE status='ready'")).rows[0].n,0);}

test('55 chapters yield durably, resume without refetch, append only 2, force revalidates without duplicate books',{timeout:180000},async()=>{
 const f=source(55),first=await request(),yielded=await execute(first.parent,f,{maxPartsPerSlice:1});
 assert.equal(yielded.yielded,true);assert.equal(yielded.chapters,50);assert.deepEqual(f.fetches,Array.from({length:50},(_,i)=>i+1));await noHead(first.feed.id);
 assert.equal((await getRanobeParts(pool,yielded.runId)).length,1);assert.equal(await count('books'),1);
 const resumed=await claimImport(pool);assert.equal(resumed.id,first.parent.id);assert.notEqual(resumed.attempt_token,first.parent.attempt_token);await assert.rejects(()=>assertAttempt(pool,first.parent),{code:'LEASE_LOST'});
 const ready=await execute(resumed,f);assert.equal(ready.status,'ready');assert.equal(ready.id,yielded.runId);assert.deepEqual(f.fetches,Array.from({length:55},(_,i)=>i+1));
 const old=await publications(ready.id);assert.deepEqual(old.map(p=>p.book.chapters.length),[50,5]);assert.equal((await getRanobeFeed(pool,first.feed.id)).head_run_id,ready.id);
 const saved=await getRanobeChapters(pool,ready.id,{limit:200});assert.equal(saved.length,55);for(const parse of f.parses){const row=saved.find(item=>item.source_key===parse.key);assert.ok(row,'every parsed chapter has a persisted checkpoint');assert.equal(row.raw_sha256,sha256(Buffer.from(JSON.stringify(parse.bundle))));assert.equal(row.raw_sha256,parse.rawSha256);assert.equal(row.prepared_book,null);}
 // The observed upstream inventory has no reliable content updated_at. Append
 // reuses unchanged release hints; it cannot detect a silent old-chapter edit.
 // force below therefore fetches EVERY chapter rather than claiming freshness
 // from the metadata timestamp or the existing checkpoint alone.
 f.size=57;f.fetches=[];f.parses=[];const update=await request(),updated=await execute(update.parent,f);assert.equal(updated.previous_head_id,ready.id);assert.deepEqual(f.fetches,[56,57]);
 const next=await publications(updated.id);assert.deepEqual(next.map(p=>p.book.chapters.length),[50,7]);assert.equal(next[0].row.id,old[0].row.id);assert.equal(await count('books'),3);assert.equal((await getRanobeRun(pool,ready.id)).status,'ready');
 for(let i=0;i<5;i++)assert.equal(ranobeChapterFingerprint(next[1].book,i),ranobeChapterFingerprint(old[1].book,i));
 f.fetches=[];f.parses=[];const forced=await request({force:true}),verified=await execute(forced.parent,f);assert.equal(verified.force_revalidate,true);assert.deepEqual(f.fetches,Array.from({length:57},(_,i)=>i+1));
 assert.deepEqual((await publications(verified.id)).map(p=>p.row.id),next.map(p=>p.row.id));assert.equal(await count('books'),3);assert.equal((await getRanobeFeed(pool,first.feed.id)).head_run_id,verified.id);
});

test('one transient source failure retries the same chapter without losing checked checkpoints',async()=>{
 const s=await request(),f=source(3),fetch=f.adapter.fetchRanobeChapter;let failed=false,calls=0;
 f.adapter.fetchRanobeChapter=async(...args)=>{calls++;if(!failed&&args[1].number==='2'){failed=true;throw error('RANOBE_UNAVAILABLE','temporary fixture',{transient:true});}return fetch(...args);};
 const ready=await execute(s.parent,f);assert.equal(ready.status,'ready');assert.equal(calls,4);assert.deepEqual(f.fetches,[1,2,3]);assert.equal(f.parses.length,3);assert.equal((await publications(ready.id))[0].book.chapters.length,3);
});

test('wrong release branch enters review and cannot activate any head',async()=>{
 const s=await request(),f=source(4,{wrongBranchAt:3});await assert.rejects(()=>execute(s.parent,f),{code:'IDENTITY_REVIEW'});await noHead(s.feed.id);
 assert.equal((await pool.query('SELECT status FROM imports WHERE id=$1',[s.parent.id])).rows[0].status,'source-review');assert.deepEqual(f.fetches,[1,2,3]);assert.equal(await count('books'),0);
});
test('blocking a loaded old part before repack publication prevents any new passed book',async()=>{
 const first=await request(),f=source(4),original=await execute(first.parent,f),old=(await publications(original.id))[0];
 f.size=5;f.fetches=[];const update=await request(),scan=f.scanBytes;let blocked=false;
 f.scanBytes=async(bytes,options)=>{
  await scan(bytes,options);
  // This is the assembled new part's scan, after old chapters were loaded and
  // before the guarded publish transaction. Raw/HTML scans cannot match it.
  if(!blocked&&bytes.toString('utf8').startsWith('Synthetic novel — главы')&&bytes.includes(Buffer.from('Body of fixture chapter 5.'))){
   assert.deepEqual(f.fetches,[5]);await pool.query("UPDATE books SET security_state='blocked' WHERE id=$1",[old.row.id]);blocked=true;
  }
 };
 await assert.rejects(()=>execute(update.parent,f),{code:'RANOBE_SOURCE_BLOCKED',status:423,blocked:true});assert.equal(blocked,true);
 assert.equal(await count('books'),1,'no newly inserted passed publication may escape a known source block');
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM books WHERE security_state='passed'")).rows[0].n,0);
 const feed=await getRanobeFeed(pool,first.feed.id);assert.equal(feed.head_run_id,original.id,'the previous head is preserved, though its blocked book is not readable');
 assert.equal((await pool.query('SELECT status FROM imports WHERE id=$1',[update.parent.id])).rows[0].status,'blocked');
 const next=(await pool.query('SELECT * FROM ranobe_runs WHERE import_id=$1',[update.parent.id])).rows[0];assert.equal(next.status,'building');const parts=await getRanobeParts(pool,next.id);assert.equal(parts.length,1);assert.equal(parts[0].status,'building');assert.equal(parts[0].book_id,null);
});
test('source guard holds actual PostgreSQL SHARE locks until publication transaction ends',async()=>{
 const first=await request(),f=source(2),ready=await execute(first.parent,f),old=(await publications(ready.id))[0];f.size=3;
 const update=await request(),info=await f.adapter.resolveRanobe(url),descriptors=ranobeInventoryDescriptors(info,selectRanobeBranch(info,null,{requireComplete:true}));
 const run=await beginRanobeRun(pool,update.parent,{title:info.title,author:info.author,policyVersion:RANOBE_POLICY,chapters:descriptors}),guard=await pool.connect(),blocker=await pool.connect();
 try{
  await guard.query('BEGIN');await assertRanobeRun(guard,update.parent,run.id,{sourceKeys:[descriptors[0].key]});
  await blocker.query('BEGIN');await blocker.query("SET LOCAL lock_timeout='100ms'");
  await assert.rejects(()=>blocker.query("UPDATE books SET security_state='blocked' WHERE id=$1",[old.row.id]),{code:'55P03'});await blocker.query('ROLLBACK');
  await guard.query('COMMIT');await blocker.query("UPDATE books SET security_state='blocked' WHERE id=$1",[old.row.id]);
  await guard.query('BEGIN');await assert.rejects(()=>assertRanobeRun(guard,update.parent,run.id,{sourceKeys:[descriptors[0].key]}),{code:'RANOBE_SOURCE_BLOCKED',blocked:true});await guard.query('ROLLBACK');
 }finally{await guard.query('ROLLBACK').catch(()=>{});await blocker.query('ROLLBACK').catch(()=>{});guard.release();blocker.release();}
 assert.equal((await getRanobeFeed(pool,first.feed.id)).head_run_id,ready.id);assert.equal(await count('books'),1);
});
test('a synthetic scanner threat in one chapter blocks full activation',async()=>{
 const s=await request(),f=source(4,{threatAt:3});await assert.rejects(()=>execute(s.parent,f),{code:'SYNTHETIC_AV_THREAT',threat:true});await noHead(s.feed.id);
 assert.equal((await pool.query('SELECT status,security_state FROM imports WHERE id=$1',[s.parent.id])).rows[0].status,'blocked');assert.deepEqual(f.fetches,[1,2,3]);assert.equal(f.parses.length,2);assert.equal(await count('books'),0);
});
test('access-denied illustration holds the whole new snapshot for source review rather than silently dropping the image',async()=>{
 const s=await request(),f=source(2,{images:true});f.fetchImage=async()=>{throw error('FETCH_HTTP','source access denied',{httpStatus:403});};
 await assert.rejects(()=>execute(s.parent,f),{code:'IDENTITY_REVIEW'});await noHead(s.feed.id);assert.equal(f.parses.length,0);assert.equal(await count('books'),0);assert.equal((await pool.query('SELECT status FROM imports WHERE id=$1',[s.parent.id])).rows[0].status,'source-review');
});
test('resource pause releases attempt, preserves checked chapter, and resumes remaining chapters',async()=>{
 const s=await request(),f=source(4);let paused=false;
 await assert.rejects(()=>execute(s.parent,f,{waitResources:async()=>{if(!paused&&f.fetches.length===1){paused=true;await pool.query('UPDATE settings SET imports_paused=true WHERE id=1');throw error('IMPORT_PAUSED');}}}),{code:'IMPORT_PAUSED'});
 await noHead(s.feed.id);const job=(await pool.query('SELECT * FROM imports WHERE id=$1',[s.parent.id])).rows[0];assert.equal(job.status,'queued');assert.equal(job.lease_expires_at,null);assert.equal(await count('ranobe_chapters'),1);assert.equal(await claimImport(pool),null);
 await pool.query('UPDATE settings SET imports_paused=false WHERE id=1');const parent=await claimImport(pool);assert.notEqual(parent.attempt_token,s.parent.attempt_token);await assert.rejects(()=>assertAttempt(pool,s.parent),{code:'LEASE_LOST'});
 const ready=await execute(parent,f);assert.equal(ready.status,'ready');assert.deepEqual(f.fetches,[1,2,3,4]);assert.equal((await publications(ready.id))[0].book.chapters.length,4);
});
test('cancellation while parser fixture is running fences checkpoint and publication',async()=>{
 const s=await request(),f=source(4,{afterParse:async n=>{if(n===1)await pool.query("UPDATE imports SET status='cancelled',lease_expires_at=NULL WHERE id=$1",[s.parent.id]);}});
 await assert.rejects(()=>execute(s.parent,f),{code:'LEASE_LOST'});await noHead(s.feed.id);assert.equal(await count('ranobe_chapters'),0);assert.equal(await count('books'),0);assert.equal((await pool.query('SELECT status FROM imports WHERE id=$1',[s.parent.id])).rows[0].status,'cancelled');
});
test('role revocation during parse requires renewed approval before cache or head writes',async()=>{
 const s=await request(),f=source(2,{afterParse:async()=>pool.query("UPDATE profiles SET role='reader' WHERE id=$1",[owner.id])});
 await assert.rejects(()=>execute(s.parent,f),{code:'APPROVAL_REVOKED'});await noHead(s.feed.id);assert.equal(await count('ranobe_chapters'),0);assert.equal((await pool.query('SELECT status,approved_by FROM imports WHERE id=$1',[s.parent.id])).rows[0].status,'pending-approval');
});
test('image resource renaming preserves chapter fingerprints and local rich references',async()=>{
 const s=await request(),f=source(4,{images:true,rich:true}),ready=await execute(s.parent,f),parts=await publications(ready.id);assert.equal(parts.length,1);const book=parts[0].book;
 assert.equal(f.images.length,4);assert.deepEqual(Object.keys(book.assets),['image-0.png']);assert.equal(sha256(Buffer.from(book.assets['image-0.png'],'base64')),sha256(png));
 const checkpoints=await getRanobeChapters(pool,ready.id);for(let i=0;i<4;i++){
  assert.equal(ranobeChapterFingerprint(book,i),checkpoints[i].content_sha256);const blocks=book.structure.chapters[i].blocks,ids=new Set(blocks.map(b=>b.id));assert.ok(ids.has(blocks[0].spans[0].target));assert.ok(ids.has(blocks[1].referenceId));assert.equal(blocks[2].resource,'image-0.png');assert.equal(book.chapters[i].blocks[2].asset,'image-0.png');
 }
 assert.equal(new Set(book.structure.chapters.map(c=>c.id)).size,4);assert.equal(new Set(book.structure.chapters.flatMap(c=>c.blocks.map(b=>b.id))).size,12);
});
for(const [name,options]of [['missing chapter',{missingAt:3}],['restricted response',{restrictedResponseAt:3}],['restricted inventory',{restrictedAt:3}],['incomplete inventory count',{incomplete:true}]])test(`${name} cannot be marked as a complete full import`,async()=>{
 const s=await request(),f=source(4,options);await assert.rejects(()=>execute(s.parent,f),{code:'IDENTITY_REVIEW'});await noHead(s.feed.id);assert.equal(await count('books'),0);assert.equal((await pool.query('SELECT status FROM imports WHERE id=$1',[s.parent.id])).rows[0].status,'source-review');
});
