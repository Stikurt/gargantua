// Explicit, reusable local-model proof. Never part of the default unit suite.
// The caller creates a disposable PostgreSQL+library, stops production heavy
// workers, and exclusively reserves the one model slot before --phase run.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {applyMigrations} from '../server/migrations.mjs';
import {assignBookModel,sealPublicationModel} from '../server/work-model.mjs';
import {stagePublication,placePublication,readPublication,textForScan,durableWrite} from '../server/publication-files.mjs';
import {scannerVersion,scan} from '../server/scan.mjs';
import {requestDerived,processDerivedStep,syncDerivedRequests} from '../server/derived-orchestrator.mjs';
import {claimDerivedJob,getDerivedResult} from '../server/derived-jobs.mjs';
import {readDerivedManifest,readDerivedSegment} from '../server/derived-files.mjs';
import {checkedDerivedResult} from '../server/derived-api.mjs';
import {canonicalJson,sha256} from '../server/publication-model.mjs';

const phase=process.argv[process.argv.indexOf('--phase')+1];
if(!['seed','run','verify'].includes(phase)||process.env.GARGANTUA_MODEL_LIVE!=='1')throw Error('Explicit GARGANTUA_MODEL_LIVE=1 and --phase seed|run|verify required');
const database=new URL(process.env.DATABASE_URL||'postgres://invalid/disabled');
if(database.hostname!=='gargantua-s5-queue-db'||database.pathname!=='/library'||database.username!=='cotology_app')throw Error('Refusing database outside the exact disposable local-model fixture topology');
const library='/library',spool='/inference-spool',runtime='/inference-runtime',reportRoot='/fixture-report';
const pool=new pg.Pool({connectionString:database.href,max:4,statement_timeout:15000});
const stateFile=path.join(reportRoot,'state.json'),reportFile=path.join(reportRoot,'model-queue-report.json');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const encode=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
async function replace(filename,value){const temporary=filename+'.'+randomUUID()+'.tmp';await durableWrite(temporary,encode(value));await fs.rename(temporary,filename);}
async function state(){return JSON.parse(await fs.readFile(stateFile,'utf8'));}
const stopping=new AbortController();for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>stopping.abort(Object.assign(Error('Controlled fixture interruption'),{code:'WORKER_STOPPING'})));
async function allowed(){
 if(stopping.signal.aborted)throw stopping.signal.reason;
 const resource=JSON.parse(await fs.readFile('/resources/resources.json','utf8'));
 if(resource.schemaVersion!==2||resource.allowHeavy!==true||resource.metricsAvailable!==true||resource.dockerStorageKnown!==true||Date.now()-resource.updatedAt>30000)throw Object.assign(Error('Awaiting fresh host resource permission'),{code:'RESOURCE_PRESSURE'});
}
async function prefixUnchanged(saved){
 for(const row of saved.prefix||[]){const current=(await pool.query('SELECT * FROM derived_checkpoints WHERE job_id=$1 AND ordinal=$2',[row.jobId,row.ordinal])).rows[0];assert.ok(current);assert.equal(current.output_sha256,row.sha256);assert.equal(Number(current.output_bytes),row.bytes);await readDerivedSegment(library,row.jobId,current.manifest);}
}
async function seed(){
 assert.equal(Number((await pool.query("SELECT count(*) AS n FROM information_schema.tables WHERE table_schema='public'")).rows[0].n),0,'Fixture DB must be empty before seeding');
 await fs.mkdir(path.join(library,'books'),{recursive:true});assert.equal((await fs.readdir(path.join(library,'books'))).length,0,'Fixture library must be empty; production mount refused');
 await applyMigrations(pool);
 const owner={id:randomUUID(),role:'owner'},book={title:'Synthetic silver key',author:'Gargantua original fixture',language:'en',assets:{},chapters:[{title:'The silver key',blocks:[{type:'text',text:'Mira put the silver key beside the red book. She did not open the door. At dawn, she returned with two letters.'}]}]};
 const checkedAt=new Date().toISOString(),scanner=await scannerVersion();await scan(textForScan(book));
 await pool.query('INSERT INTO profiles(id,login,password,role) VALUES($1,$2,$3,$4)',[owner.id,'isolated_model_fixture','NOT_A_LOGIN_PASSWORD',owner.role]);
 const id=randomUUID(),importId=randomUUID(),identity=await assignBookModel(pool,book),prepared=await stagePublication(library,randomUUID(),id,book);await placePublication(library,prepared);
 await pool.query("INSERT INTO imports(id,requested_by,kind,filename,status,stage,security_state,approved_by,decision_reason,book_id,report) VALUES($1,$2,'synthetic-model-fixture',$3,'completed','Synthetic fixture scanned','passed',$2,'fixture-owner',$4,$5)",[importId,owner.id,book.title,id,JSON.stringify({scanner,checkedAt,synthetic:true})]);
 const row=(await pool.query('INSERT INTO books(id,title,author,language,chapter_count,sha256,import_id,requested_by,content_sha256,content_bytes,package_sha256,artifact_manifest,work_id,expression_id,edition_id) VALUES($1,$2,$3,$4,1,$5,$6,$7,$5,$8,$9,$10,$11,$12,$13) RETURNING *',[id,book.title,book.author,'en',prepared.contentSha256,importId,owner.id,prepared.contentBytes,prepared.packageSha256,JSON.stringify(prepared.manifest),identity.work_id,identity.expression_id,identity.edition_id])).rows[0];
 const original=await sealPublicationModel(pool,row,book),key=randomUUID();
 const body={idempotencyKey:key,kind:'translation',publicationIds:[id],sourceLanguage:'en',audio:true,glossary:{Mira:'Мира'}};
 const created=await requestDerived(pool,owner,body,{library}),repeated=await requestDerived(pool,owner,body,{library});
 assert.equal(repeated.job.id,created.job.id);assert.equal(repeated.idempotent,true);
 const saved={schemaVersion:1,createdAt:new Date().toISOString(),databaseHost:database.hostname,database:'library',schema:'public',ownerId:owner.id,sourceId:id,requestId:created.request.id,translationJobId:created.job.id,sourceContentSha256:original.content_sha256,sourcePackageSha256:original.package_sha256,sourcePublicationSha256:original.publication_sha256,seedScanner:scanner,prefix:[]};
 await replace(stateFile,saved);console.log(JSON.stringify({phase:'seeded',translationJobId:created.job.id,sourceId:id,idempotentDuplicateReused:true}));
}
async function run(){
 const saved=await state();await prefixUnchanged(saved);
 const maximum=Number(process.env.GARGANTUA_STOP_AFTER_CHECKPOINTS||0);if(!Number.isSafeInteger(maximum)||maximum<0||maximum>100)throw Error('Invalid explicit stop-after-checkpoints limit');
 const initial=Number((await pool.query('SELECT count(*) AS n FROM derived_checkpoints')).rows[0].n),deadline=Date.now()+20*60*1000;
 let last='';
 while(Date.now()<deadline&&!stopping.signal.aborted){
  await syncDerivedRequests(pool,{library});
  const jobs=(await pool.query('SELECT id,kind,status,completed_segments,total_segments,error,pause_reason FROM derived_jobs ORDER BY created_at')).rows;
  const snapshot=JSON.stringify(jobs);if(snapshot!==last){console.log(JSON.stringify({phase:'queue',jobs}));last=snapshot;}
  if(jobs.some(job=>['failed','blocked','cancelled'].includes(job.status)))throw Error('Fixture queue entered terminal failure: '+snapshot);
  if(jobs.length===2&&jobs.every(job=>job.status==='completed')){await verify();return;}
  try{await allowed();}catch(error){if(error.code!=='RESOURCE_PRESSURE')throw error;await sleep(1000);continue;}
  const claim=await claimDerivedJob(pool,{leaseSeconds:120});
  if(claim)await processDerivedStep(pool,claim,{library,spool,runtime,allowed,signal:stopping.signal});else await sleep(1000);
  const count=Number((await pool.query('SELECT count(*) AS n FROM derived_checkpoints')).rows[0].n);
  if(maximum&&count-initial>=maximum){
   saved.prefix=(await pool.query('SELECT job_id AS "jobId",ordinal,output_sha256 AS sha256,output_bytes AS bytes FROM derived_checkpoints ORDER BY job_id,ordinal')).rows.map(row=>({...row,bytes:Number(row.bytes)}));
   await replace(stateFile,saved);console.log(JSON.stringify({phase:'controlled-checkpoint-stop',completedCheckpoints:count,prefix:saved.prefix}));return;
  }
 }
 if(stopping.signal.aborted){console.log('{"phase":"controlled-signal-stop"}');return;}
 throw Error('Bounded20minute live queue deadline exceeded; resources or cooling may still require attention');
}
async function verify(){
 const saved=await state();await prefixUnchanged(saved);
 const original=(await pool.query('SELECT * FROM books WHERE id=$1',[saved.sourceId])).rows[0];
 assert.equal(original.content_sha256,saved.sourceContentSha256);assert.equal(original.package_sha256,saved.sourcePackageSha256);assert.equal(original.publication_sha256,saved.sourcePublicationSha256);await readPublication(library,original);
 const jobs=(await pool.query('SELECT * FROM derived_jobs ORDER BY created_at')).rows;assert.equal(jobs.length,2);assert.ok(jobs.every(job=>job.status==='completed'));
 const summaries=[],owner={id:saved.ownerId};let longest=null,translation=[];
 for(const job of jobs){
  const grant=await getDerivedResult(pool,owner,job.id),loaded=await readDerivedManifest(library,grant.result),recipe=(await pool.query('SELECT * FROM derived_recipes WHERE sha256=$1',[job.recipe_sha256])).rows[0],manifest=checkedDerivedResult(grant,loaded,recipe);
  let bytes=0,duration=0;
  for(const segment of manifest.segments){const buffer=await readDerivedSegment(library,job.id,segment);await scan(buffer);bytes+=buffer.length;if(job.kind==='translation')translation.push(buffer.toString('utf8'));else{duration+=segment.pcm.durationSeconds;if(!longest||segment.pcm.durationSeconds>longest.duration){longest={bytes:buffer,duration:segment.pcm.durationSeconds};}}}
  summaries.push({id:job.id,kind:job.kind,segments:manifest.segments.length,bytes,durationSeconds:duration,sourceSha256:job.source_sha256,recipeSha256:job.recipe_sha256,manifestSha256:grant.result.sha256,quality:manifest.quality});
 }
 const before=Number((await pool.query('SELECT count(*) AS n FROM derived_jobs')).rows[0].n);
 const duplicate=await requestDerived(pool,owner,{idempotencyKey:randomUUID(),kind:'translation',publicationIds:[saved.sourceId],sourceLanguage:'en',audio:true,glossary:{Mira:'Мира'}},{library});
 assert.equal(duplicate.job.id,saved.translationJobId);assert.equal(duplicate.reused,true);assert.equal(Number((await pool.query('SELECT count(*) AS n FROM derived_jobs')).rows[0].n),before);
 const report={schemaVersion:1,status:'completed',completedAt:new Date().toISOString(),syntheticOriginal:true,realLocalModels:true,realClam:true,productionLibraryMounted:false,databaseHost:database.hostname,database:'library',schema:'public',sourceId:saved.sourceId,originalUnchanged:true,idempotentAndLogicalDuplicateReused:true,preservedCheckpointPrefix:saved.prefix,jobs:summaries,auditoryReview:'NOT_LISTENED',translationQuality:'MACHINE_DRAFT',weightsAntivirus:'NOT_FULLY_SCANNED'};
 await replace(reportFile,report);await fs.writeFile(path.join(reportRoot,'translation-sample.txt'),translation.join('\n\n'));if(longest)await fs.writeFile(path.join(reportRoot,'audio-sample.wav'),longest.bytes);
 console.log(JSON.stringify({phase:'verified',...report}));
}
try{await fs.mkdir(reportRoot,{recursive:true});await ({seed,run,verify}[phase])();}finally{await pool.end();}
