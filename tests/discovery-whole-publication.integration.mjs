// Disposable PostgreSQL only. Synthetic sealed metadata and callbacks; no files,
// network, production database, parser or model execution are used here.
import test,{before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {applyMigrations} from '../server/migrations.mjs';
import {assignBookModel,sealPublicationModel} from '../server/work-model.mjs';
import {canonicalJson,sha256} from '../server/publication-model.mjs';
import {packageDigest} from '../server/publication-files.mjs';
import {makeChapterSelection} from '../server/derived-selection.mjs';
import {findLocalDiscoveryPlan} from '../server/discovery-library.mjs';
import {createDiscoveryRequest,claimDiscoveryRequest,finishDiscoveryRequest,completeDiscoveryFromLibrary,getDiscoveryRequest} from '../server/discovery-requests.mjs';

const url=new URL(process.env.TEST_DATABASE_URL||'postgres://invalid/disabled');
if(process.env.GARGANTUA_TEST_ISOLATED!=='1'||!/^\/gargantua_test_[a-z0-9_]+$/.test(url.pathname))throw Error('Explicit isolated TEST_DATABASE_URL required; refusing production');
const schema='whole_book_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:url.href,max:1,statement_timeout:10000});
const isolated=new URL(url);isolated.searchParams.set('options',`-c search_path=${schema}`);
const pool=new pg.Pool({connectionString:isolated.href,max:5,statement_timeout:10000}),owner={id:randomUUID()};let created=false;
const hash=value=>sha256(Buffer.from(canonicalJson(value)));
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);created=true;await applyMigrations(pool);});
beforeEach(async()=>{await pool.query('TRUNCATE profiles,works,derived_recipes RESTART IDENTITY CASCADE');await pool.query('UPDATE settings SET imports_paused=false,serving_paused=false WHERE id=1');await pool.query("INSERT INTO profiles(id,login,password,role) VALUES($1,$2,'synthetic-no-login','owner')",[owner.id,'whole-book-'+owner.id]);});
after(async()=>{await pool.end();try{if(created){assert.match(schema,/^whole_book_[a-f0-9]{32}$/);await admin.query(`DROP SCHEMA ${schema} CASCADE`);}}finally{await admin.end();}});

async function seedBook({model,language='en',chapters=4,kind='upload'}={}){
 const content={title:'Synthetic same title',author:'Synthetic Author',language,chapters:Array.from({length:chapters},(_,index)=>({title:'Chapter '+(index+1),blocks:[{type:'text',text:'Synthetic chapter '+index+' '+randomUUID()}]})),assets:{}},raw=Buffer.from(JSON.stringify(content)),checksum=sha256(raw),artifact={schemaVersion:1,files:[{path:'book.json',bytes:raw.length,sha256:checksum}]},identity=model??await assignBookModel(pool,content),bookId=randomUUID(),importId=randomUUID();
 await pool.query("INSERT INTO imports(id,requested_by,kind,filename,status,book_id) VALUES($1,$2,$3,'synthetic.txt','completed',$4)",[importId,owner.id,kind,bookId]);
 const row=(await pool.query('INSERT INTO books(id,title,author,language,chapter_count,sha256,import_id,requested_by,content_sha256,content_bytes,package_sha256,artifact_manifest,work_id,expression_id,edition_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$6,$9,$10,$11,$12,$13,$14) RETURNING *',[bookId,content.title,content.author,language,chapters,checksum,importId,owner.id,raw.length,packageDigest(artifact),JSON.stringify(artifact),identity.work_id,identity.expression_id,identity.edition_id])).rows[0];
 return sealPublicationModel(pool,row,content);
}
async function seedTranslation(source,{version=2,start=1,count=source.chapter_count}={}){
 const jobId=randomUUID(),expressionId=randomUUID(),editionId=randomUUID(),attemptId=randomUUID(),recipe={kind:'translation',language:'ru',manifest:{schemaVersion:1,profile:'synthetic-coverage-only'}},recipeSha=hash(recipe);
 await pool.query('INSERT INTO derived_recipes(sha256,kind,language,manifest) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[recipeSha,recipe.kind,recipe.language,JSON.stringify(recipe.manifest)]);
 await pool.query("INSERT INTO expressions(id,work_id,language,kind,variant_key,source_expression_id,recipe) VALUES($1,$2,'ru','machine-translation',$3,$4,$5)",[expressionId,source.work_id,'synthetic:'+jobId,source.expression_id,JSON.stringify({sha256:recipeSha})]);
 await pool.query("INSERT INTO editions(id,expression_id,source_kind) VALUES($1,$2,'machine-translation')",[editionId,expressionId]);
 const book=await seedBook({model:{work_id:source.work_id,expression_id:expressionId,edition_id:editionId},language:'ru',chapters:count,kind:'derived-translation'}),sourceManifest={schemaVersion:version,sourceLanguage:source.language,workId:source.work_id,expressionId:source.expression_id,snapshotId:null,parts:[{ordinal:0,publicationId:source.id,editionId:source.edition_id,publicationSha256:source.publication_sha256,packageSha256:source.package_sha256,chapterCount:source.chapter_count}]};
 if(version===2)sourceManifest.selection=makeChapterSelection([source],{start,count});
 const sourceSha=hash(sourceManifest),segment={schemaVersion:1,jobId,attemptId,ordinal:0,kind:'translation',inputSha256:'a'.repeat(64),recipeSha256:recipeSha,profileSha256:'b'.repeat(64),file:{path:attemptId+'/000000.txt',sha256:'c'.repeat(64),bytes:1,mediaType:'text/plain; charset=utf-8'},scan:{version:'synthetic-no-file',checkedAt:'2026-10-24T00:00:00.000Z',sha256:'c'.repeat(64)},quality:'machine-draft'},manifest={schemaVersion:1,jobId,kind:'translation',sourceSha256:sourceSha,recipeSha256:recipeSha,quality:'machine-draft',publicationIds:[book.id],segments:[segment]},plan={schemaVersion:1,sourceSha256:sourceSha,kind:'translation',segments:[{ordinal:0,sourceSha256:segment.inputSha256}]};
 await pool.query('INSERT INTO derived_sources(sha256,work_id,expression_id,manifest) VALUES($1,$2,$3,$4)',[sourceSha,source.work_id,source.expression_id,JSON.stringify(sourceManifest)]);
 await pool.query('INSERT INTO derived_source_parts(source_sha256,ordinal,book_id,expression_id,edition_id,publication_sha256,package_sha256) VALUES($1,0,$2,$3,$4,$5,$6)',[sourceSha,source.id,source.expression_id,source.edition_id,source.publication_sha256,source.package_sha256]);
 await pool.query("INSERT INTO derived_jobs(id,kind,source_sha256,recipe_sha256,status,plan,plan_sha256,total_segments,completed_segments) VALUES($1,'translation',$2,$3,'completed',$4,$5,1,1)",[jobId,sourceSha,recipeSha,JSON.stringify(plan),hash(plan)]);
 await pool.query('INSERT INTO derived_results(job_id,work_id,expression_id,edition_id,manifest,sha256,bytes) VALUES($1,$2,$3,$4,$5,$6,$7)',[jobId,book.work_id,book.expression_id,book.edition_id,JSON.stringify(manifest),hash(manifest),Buffer.byteLength(canonicalJson(manifest))]);
 return book;
}
async function selectLibrary(book){
 const candidate={id:'local_'+book.id,identity:{provider:'library',remoteId:book.id},bookId:book.id,kind:'book',title:book.title,availability:'library',eligibleForAcquisition:true,downloadSelections:[]};
 await createDiscoveryRequest(pool,owner,{idempotencyKey:randomUUID(),query:book.title});const metadata=await claimDiscoveryRequest(pool);
 await finishDiscoveryRequest(pool,metadata,{status:'resolved',nextAction:'reuse',selectedCandidateId:candidate.id,candidates:[candidate],providerErrors:[],clarifications:[],hasMore:false});
 return claimDiscoveryRequest(pool);
}

for(const version of [1,2])test(`complete v${version} translation verifies every file ancestor while its rows are locked`,async()=>{
 const source=await seedBook(),book=await seedTranslation(source,{version}),claim=await selectLibrary(book),checked=[];
 const result=await completeDiscoveryFromLibrary(pool,claim,book.id,{verifyExisting:async row=>{
  checked.push(row.id);const probe=await pool.connect();try{await probe.query('BEGIN');await probe.query("SET LOCAL lock_timeout='100ms'");await assert.rejects(()=>probe.query("UPDATE books SET security_state='blocked' WHERE id=$1",[row.id]),{code:'55P03'});}finally{await probe.query('ROLLBACK');probe.release();}
 }});
 assert.equal(result.status,'book-ready');assert.equal(result.outputs.book.publicationId,book.id);assert.equal(result.outputs.translation.status,'not-required');assert.deepEqual(checked,[book.id,source.id]);
});

test('a stale library selection cannot complete a one-chapter translation as a four-chapter book',async()=>{
 const source=await seedBook(),partial=await seedTranslation(source,{start:3,count:1}),plan=await findLocalDiscoveryPlan(pool,{query:partial.title,language:'ru',allowOriginal:false},{titles:[partial.title]});
 assert.ok(!plan?.candidates.some(candidate=>candidate.bookId===partial.id));
 const claim=await selectLibrary(partial);let verified=0;await assert.rejects(()=>completeDiscoveryFromLibrary(pool,claim,partial.id,{verifyExisting:async()=>{verified++;}}),{code:'DISCOVERY_LIBRARY_INCOMPLETE'});
 const stored=await getDiscoveryRequest(pool,owner,claim.id);assert.equal(stored.status,'processing');assert.equal(stored.revision,claim.revision);assert.equal(verified,0);assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit WHERE action='discovery.library-reused'")).rows[0].n,0);
});

test('a full translation becomes unavailable when its original is blocked or its package fails verification',async()=>{
 const source=await seedBook(),book=await seedTranslation(source),claim=await selectLibrary(book);await pool.query("UPDATE books SET security_state='blocked' WHERE id=$1",[source.id]);let checked=[];
 await assert.rejects(()=>completeDiscoveryFromLibrary(pool,claim,book.id,{verifyExisting:async row=>{checked.push(row.id);}}),{code:'DISCOVERY_LIBRARY_INCOMPLETE'});assert.deepEqual(checked,[]);
 await pool.query("UPDATE books SET security_state='passed' WHERE id=$1",[source.id]);await assert.rejects(()=>completeDiscoveryFromLibrary(pool,claim,book.id,{verifyExisting:async row=>{checked.push(row.id);if(row.id===source.id)throw Object.assign(new Error('Synthetic corrupt source file'),{code:'PUBLICATION_INTEGRITY'});}}),{code:'PUBLICATION_INTEGRITY'});
 assert.deepEqual(checked,[book.id,source.id]);assert.equal((await getDiscoveryRequest(pool,owner,claim.id)).status,'processing');
});

test('a complete child of a partial translation remains excluded and cannot complete a stale card',async()=>{
 const source=await seedBook(),partial=await seedTranslation(source,{start:2,count:1}),child=await seedTranslation(partial),claim=await selectLibrary(child);let verified=0;
 await assert.rejects(()=>completeDiscoveryFromLibrary(pool,claim,child.id,{verifyExisting:async()=>{verified++;}}),{code:'DISCOVERY_LIBRARY_INCOMPLETE'});assert.equal(verified,0);
});
