// Explicit trusted original fixture. Not an HTTP handler or production worker.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {applyMigrations} from '/app/server/migrations.mjs';
import {assignBookModel,sealPublicationModel} from '/app/server/work-model.mjs';
import {stagePublication,placePublication,readPublication,textForScan,durableWrite} from '/app/server/publication-files.mjs';
import {scannerVersion,scan} from '/app/server/scan.mjs';
import {requestDerived,processDerivedStep,syncDerivedRequests} from '/app/server/derived-orchestrator.mjs';
import {claimDerivedJob,getDerivedResult} from '/app/server/derived-jobs.mjs';
import {readDerivedManifest,readDerivedSegment,validateDerivedWav} from '/app/server/derived-files.mjs';
import {checkedDerivedResult} from '/app/server/derived-api.mjs';
import {executorState,executorIsIdle} from '/app/server/derived-spool.mjs';
import {canonicalJson,sha256} from '/app/server/publication-model.mjs';

const token=process.env.GARGANTUA_FRESH_TTS_TOKEN;
assert.match(token,/^[a-f0-9]{32}$/);
const database=new URL(process.env.DATABASE_URL||'postgres://invalid/disabled');
assert.equal(database.hostname,'gargantua-tts-'+token.slice(0,12)+'-db');
assert.equal(database.pathname,'/library');assert.equal(database.username,'cotology_app');
const library='/library',spool='/inference-spool',runtime='/inference-runtime',reportRoot='/fixture-report';
const pool=new pg.Pool({connectionString:database.href,max:4,statement_timeout:15000});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const encode=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
const emit=value=>console.log(JSON.stringify(value));
async function save(name,value){const target=path.join(reportRoot,name),temp=target+'.'+randomUUID()+'.tmp';await durableWrite(temp,encode(value));await fs.rename(temp,target);}
const controller=new AbortController();for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>controller.abort(Object.assign(Error('Fixture stopping'),{code:'WORKER_STOPPING'})));
async function allowed(){
 if(controller.signal.aborted)throw controller.signal.reason;
 const r=JSON.parse(await fs.readFile('/resources/resources.json','utf8')),age=Date.now()-r.updatedAt;
 if(r.schemaVersion!==2||r.allowHeavy!==true||r.metricsAvailable!==true||r.dockerStorageKnown!==true||r.maxHeavyJobs!==1||!Number.isFinite(age)||age< -5000||age>30000)throw Object.assign(Error('Awaiting live shared one-job resource budget'),{code:'RESOURCE_PRESSURE'});
}
function joinedWav(buffers){
 const pcm=[];for(const b of buffers){validateDerivedWav(b);let n=12;while(n+8<=b.length){const bytes=b.readUInt32LE(n+4);if(b.toString('ascii',n,n+4)==='data')pcm.push(b.subarray(n+8,n+8+bytes));n+=8+bytes+(bytes%2);}}
 const data=Buffer.concat(pcm),header=Buffer.alloc(44);header.write('RIFF');header.writeUInt32LE(36+data.length,4);header.write('WAVE',8);header.write('fmt ',12);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(22050,24);header.writeUInt32LE(44100,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(data.length,40);const bytes=Buffer.concat([header,data]);validateDerivedWav(bytes);return bytes;
}
async function main(){
 await fs.mkdir(reportRoot,{recursive:true});
 assert.equal(Number((await pool.query("SELECT count(*) AS n FROM information_schema.tables WHERE table_schema='public'")).rows[0].n),0,'Only empty isolated DB permitted');
 await fs.mkdir(path.join(library,'books'),{recursive:true});assert.deepEqual(await fs.readdir(path.join(library,'books')),[],'Only empty isolated library permitted');
 await applyMigrations(pool);await allowed();
 const daemonBefore=await executorState(runtime);assert.ok(executorIsIdle(daemonBefore),'Existing executor must be fresh idle before fixture admission');
 const owner={id:randomUUID(),role:'owner'},sentences=['Мира открыла красную книгу и нашла серебряный ключ.','За окном шумел дождь, а в комнате было тепло и тихо.','Утром друзья вернули книгу на полку и отправились домой.'];
 // Empty chapter headings deliberately avoid six synthesis calls; all 3 bodies
 // are complete chapters, and chapter identities/order remain in the source plan.
 const book={title:'Три тихие страницы — изолированная проверка',author:'Оригинальный технический текст Gargantua',language:'ru',assets:{},chapters:sentences.map(text=>({title:'',blocks:[{type:'text',text}]}))};
 const scanner=await scannerVersion();await scan(textForScan(book));
 await pool.query('INSERT INTO profiles(id,login,password,role) VALUES($1,$2,$3,$4)',[owner.id,'fresh_tts_fixture','NOT_A_LOGIN_PASSWORD',owner.role]);
 const sourceId=randomUUID(),importId=randomUUID(),identity=await assignBookModel(pool,book),prepared=await stagePublication(library,randomUUID(),sourceId,book);await placePublication(library,prepared);
 await pool.query("INSERT INTO imports(id,requested_by,kind,filename,status,stage,security_state,approved_by,decision_reason,book_id,report) VALUES($1,$2,'synthetic-fresh-tts',$3,'completed','Synthetic original scanned','passed',$2,'fixture-owner',$4,$5)",[importId,owner.id,book.title,sourceId,JSON.stringify({scanner,checkedAt:new Date().toISOString(),synthetic:true,token})]);
 const row=(await pool.query('INSERT INTO books(id,title,author,language,chapter_count,sha256,import_id,requested_by,content_sha256,content_bytes,package_sha256,artifact_manifest,work_id,expression_id,edition_id) VALUES($1,$2,$3,$4,3,$5,$6,$7,$5,$8,$9,$10,$11,$12,$13) RETURNING *',[sourceId,book.title,book.author,'ru',prepared.contentSha256,importId,owner.id,prepared.contentBytes,prepared.packageSha256,JSON.stringify(prepared.manifest),identity.work_id,identity.expression_id,identity.edition_id])).rows[0];
 const original=await sealPublicationModel(pool,row,book),before=(await readPublication(library,original)).content;
 await save('original-book.json',before);
 const input={idempotencyKey:randomUUID(),kind:'audio',publicationIds:[sourceId],sourceLanguage:'ru',audio:false};
 const created=await requestDerived(pool,owner,input,{library}),repeated=await requestDerived(pool,owner,input,{library});
 assert.equal(repeated.job.id,created.job.id);assert.equal(repeated.idempotent,true);
 await save('seed.json',{token,ownerId:owner.id,sourceId,jobId:created.job.id,sourceContentSha256:original.content_sha256,sourcePackageSha256:original.package_sha256,sourcePublicationSha256:original.publication_sha256,daemonPid:daemonBefore.pid});
 emit({phase:'seeded',jobId:created.job.id,sourceId,chapters:3});
 const deadline=Date.now()+5*60*1000;let last='',completed=false;
 while(Date.now()<deadline&&!controller.signal.aborted){
  await syncDerivedRequests(pool,{library});
  const jobs=(await pool.query('SELECT id,kind,status,completed_segments,total_segments,error,pause_reason FROM derived_jobs ORDER BY created_at')).rows;
  assert.equal(jobs.length,1);assert.equal(jobs[0].kind,'audio');
  const summary=JSON.stringify(jobs);if(summary!==last){emit({phase:'queue',jobs});last=summary;}
  if(jobs.some(j=>['failed','blocked','cancelled'].includes(j.status)))throw Error('Terminal isolated queue failure: '+summary);
  if(jobs.every(j=>j.status==='completed')){completed=true;break;}
  try{await allowed();}catch(e){if(e.code!=='RESOURCE_PRESSURE')throw e;await sleep(1000);continue;}
  const claim=await claimDerivedJob(pool,{leaseSeconds:120});
  if(claim)await processDerivedStep(pool,claim,{library,spool,runtime,allowed,signal:controller.signal});else await sleep(750);
 }
 assert.equal(completed,true,'Bounded fresh TTS deadline exhausted');
 const sourceAfter=(await pool.query('SELECT * FROM books WHERE id=$1',[sourceId])).rows[0];
 for(const key of ['content_sha256','package_sha256','publication_sha256'])assert.equal(sourceAfter[key],original[key]);
 assert.deepEqual((await readPublication(library,sourceAfter)).content,before);assert.equal(Number((await pool.query('SELECT count(*) AS n FROM books')).rows[0].n),1);
 const job=(await pool.query('SELECT * FROM derived_jobs WHERE id=$1',[created.job.id])).rows[0];
 assert.equal(job.status,'completed');assert.equal(job.total_segments,3);assert.equal(job.completed_segments,3);
 assert.deepEqual(job.plan.segments.map(x=>[x.ordinal,x.chapterIndex,x.blockIndex]),[[0,0,0],[1,1,0],[2,2,0]]);
 const grant=await getDerivedResult(pool,owner,job.id),loaded=await readDerivedManifest(library,grant.result),recipe=(await pool.query('SELECT * FROM derived_recipes WHERE sha256=$1',[job.recipe_sha256])).rows[0];
 const manifest=checkedDerivedResult(grant,loaded,recipe);assert.equal(manifest.segments.length,3);
 const segmentProofs=[],buffers=[],receipts=[];
 for(const [index,segment] of manifest.segments.entries()){
  const b=await readDerivedSegment(library,job.id,segment);await scan(b);buffers.push(b);
  assert.equal(segment.ordinal,index);assert.equal(segment.inputSha256,sha256(Buffer.from(sentences[index])));
  const receipt=JSON.parse(await fs.readFile(path.join(spool,'retired',segment.attemptId+'.json'),'utf8'));
  assert.equal(receipt.status,'completed');assert.equal(receipt.kind,'tts');assert.equal(receipt.jobId,job.id);assert.equal(receipt.attemptId,segment.attemptId);assert.equal(receipt.inputSha256,segment.inputSha256);assert.equal(receipt.profileSha256,recipe.manifest.profileSha256);assert.equal(receipt.cleanupVerified,true);assert.equal(receipt.artifact.sha256,segment.file.sha256);assert.ok(receipt.cleanup.length>0);assert.ok(receipt.cleanup.every(x=>x.verifiedStopped===true));
  for(const parent of ['incoming','output'])await assert.rejects(fs.lstat(path.join(spool,parent,segment.attemptId)),e=>e.code==='ENOENT');
  await save('receipt-'+index+'.json',receipt);receipts.push(receipt);
  await fs.writeFile(path.join(reportRoot,'chapter-'+(index+1)+'.wav'),b);
  segmentProofs.push({ordinal:index,chapterIndex:index,sourceText:sentences[index],sourceSha256:segment.inputSha256,attemptId:segment.attemptId,sha256:sha256(b),bytes:b.length,pcm:validateDerivedWav(b),scanner:segment.scan.version,verifiedStopped:receipt.cleanup.every(x=>x.verifiedStopped===true),runtimeImage:receipt.runtimeImage,profileSha256:receipt.profileSha256,providerRecipeSha256:receipt.providerRecipeSha256,startedAt:receipt.startedAt,finishedAt:receipt.finishedAt});
 }
 assert.ok(receipts.every(x=>x.runtimeImage===recipe.manifest.profileDescriptor.runtimeImage));
 const sorted=[...receipts].sort((a,b)=>a.startedAt-b.startedAt);for(let i=1;i<sorted.length;i++)assert.ok(sorted[i-1].finishedAt<=sorted[i].startedAt,'Shared executor must serialize synthesis');
 const duplicate=await requestDerived(pool,owner,{...input,idempotencyKey:randomUUID()},{library});assert.equal(duplicate.job.id,job.id);assert.equal(duplicate.reused,true);assert.equal(Number((await pool.query('SELECT count(*) AS n FROM derived_jobs')).rows[0].n),1);
 const joined=joinedWav(buffers);await scan(joined);await fs.writeFile(path.join(reportRoot,'audio-three-chapters.wav'),joined);
 await save('derived-manifest.json',manifest);await save('plan.json',job.plan);
 const attempts=(await pool.query('SELECT token,job_id,state,error,started_at,ended_at FROM derived_attempts ORDER BY started_at')).rows;
 for(let n=0;n<30&&!executorIsIdle(await executorState(runtime));n++)await sleep(1000);
 const daemonAfter=await executorState(runtime);assert.equal(daemonAfter.pid,daemonBefore.pid);assert.ok(executorIsIdle(daemonAfter));
 const report={schemaVersion:1,status:'PASS',completedAt:new Date().toISOString(),token,productionDbUsed:false,productionLibraryMounted:false,productionDaemonReconfigured:false,newHostExecutorStarted:false,sharedExistingSingleExecutor:true,cpuOnly:true,gpuRequested:false,realLocalModel:true,realClamAV:true,auditoryReview:'NOT_LISTENED',weightsAntivirus:'NOT_FULLY_SCANNED',sourceLanguage:'ru',sourceId,jobId:job.id,originalUnchanged:true,originalStoredSeparately:true,sourceContentSha256:original.content_sha256,sourcePackageSha256:original.package_sha256,sourcePublicationSha256:original.publication_sha256,originalFileSha256:sha256(await fs.readFile(path.join(reportRoot,'original-book.json'))),idempotentAndLogicalDuplicatesReused:true,allThreeChaptersCompletelySynthesized:true,ordinalOrderPreserved:true,globalSingleExecutorCleanupVerified:true,daemonBefore,daemonAfter,segments:segmentProofs,attempts,sample:{file:'audio-three-chapters.wav',sha256:sha256(joined),bytes:joined.length,pcm:validateDerivedWav(joined)},manifestSha256:grant.result.sha256,recipeSha256:job.recipe_sha256,profileSha256:recipe.manifest.profileSha256,seedScanner:scanner};
 await save('model-queue-report.json',report);emit({phase:'verified',status:'PASS',jobId:job.id,segments:segmentProofs.map(x=>({chapter:x.chapterIndex+1,seconds:x.pcm.durationSeconds,sha256:x.sha256})),sample:report.sample});
}
try{await main();}catch(error){await save('failure.json',{status:'FAIL',message:error.message,code:error.code,stack:error.stack}).catch(()=>{});throw error;}finally{await pool.end();}
