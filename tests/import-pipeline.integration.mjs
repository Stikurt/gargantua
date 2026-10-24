// Real API -> ClamAV -> isolated parser -> publication. Disposable data only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import pg from 'pg';
import {applyMigrations} from '../server/migrations.mjs';
import {passwordHash} from '../server/security.mjs';
import {scannerVersion} from '../server/scan.mjs';

const runId=process.env.GARGANTUA_TEST_RUN||'',suffix=runId.replaceAll('-','').slice(0,12);
const database=new URL(process.env.TEST_DATABASE_URL||'postgres://invalid/disabled');
if(process.env.GARGANTUA_TEST_ISOLATED!=='1'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(runId)||database.pathname!=='/gargantua_test_pipeline'||database.hostname!==`gargantua-test-pipeline-${suffix}-db`||database.username!=='pipeline_test'||!['postgres:','postgresql:'].includes(database.protocol))throw new Error('Refusing non-isolated pipeline database/configuration');
const roots={quarantine:'/quarantine',jobs:'/jobs',library:'/library',resources:'/resources'};
const origin='http://127.0.0.1:3080',reportFile='/resources/import-pipeline-report.json';
const pool=new pg.Pool({connectionString:database.href,max:3,connectionTimeoutMillis:10000,statement_timeout:10000});
const children=[],checks=[];let timer,refresh=Promise.resolve(),refreshError,cookie='',csrf='',heavyAllowed=true;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const summary={scope:'ISOLATED_REAL_IMPORT_PIPELINE',runId,startedAt:new Date().toISOString(),ok:false,checks,
 limitations:['Synthetic resource-monitor fixture; does not test the Windows monitor or adaptive budgets.','Reuses only VERSION/INSTREAM on the existing scanner; does not update scanner configuration or databases.','Exercises one TXT publication and the antivirus control string; not EPUB/FB2/translation/TTS/native-client acceptance.','Server download issuance is not a device filesystem/index commit.','Cleanup fault is an empty directory at one explicitly owned test input path; not a power-loss simulation.']};

function record(name,details={}){checks.push({name,ok:true,...details});console.log('PASS:',name);}
function assertChildren(){for(const child of children)if(!child.expectedStop&&(child.process.exitCode!==null||child.process.signalCode!==null||child.error))throw new Error(`${child.name} exited before acceptance completed`);if(refreshError)throw refreshError;}
async function waitFor(name,probe,{timeout=20000,interval=100}={}){
 const deadline=Date.now()+timeout;let last;
 while(Date.now()<deadline){assertChildren();last=await probe();if(last)return last;await sleep(interval);}
 throw new Error(`Timed out: ${name}`);
}
function start(name,file){
 const child={name,tail:'',error:null,process:spawn(process.execPath,[file],{cwd:'/app',env:{...process.env,DATABASE_URL:database.href,APP_ORIGIN:origin,QUARANTINE_DIR:roots.quarantine,JOBS_DIR:roots.jobs,LIBRARY_DIR:roots.library},stdio:['ignore','pipe','pipe']})};
 child.process.on('error',error=>{child.error=error;});
 for(const stream of [child.process.stdout,child.process.stderr])stream.on('data',bytes=>{child.tail=(child.tail+bytes.toString()).slice(-32768);});
 children.push(child);return child;
}
async function stop(child){
 child.expectedStop=true;
 if(child.process.exitCode!==null||child.process.signalCode!==null)return;
 const done=once(child.process,'exit').catch(()=>{});child.process.kill('SIGTERM');
 await Promise.race([done,sleep(8000)]);
 if(child.process.exitCode===null&&child.process.signalCode===null){child.process.kill('SIGKILL');await Promise.race([done,sleep(2000)]);}
}
async function resourceFixture(){
 const temp=path.join(roots.resources,'resources.tmp');
 await fs.writeFile(temp,JSON.stringify({updatedAt:Date.now(),allowHeavy:heavyAllowed,message:'Isolated synthetic acceptance resource budget'}));
 await fs.rename(temp,path.join(roots.resources,'resources.json'));
}
async function api(route,{method='GET',json,body,authenticated=true}={}){
 const headers={'X-Cotology':'1',Origin:origin};
 if(authenticated&&cookie)headers.Cookie=cookie;
 if(authenticated&&csrf)headers['X-CSRF-Token']=csrf;
 if(json!==undefined){headers['Content-Type']='application/json';body=JSON.stringify(json);}
 const response=await fetch(origin+'/api'+route,{method,headers,body,signal:AbortSignal.timeout(10000)});
 if(!response.ok){const value=await response.text();throw new Error(`API ${method} ${route}: HTTP ${response.status}: ${value.slice(0,350)}`);}
 return response;
}
async function upload(bytes,filename){const form=new FormData();form.set('file',new Blob([bytes],{type:'text/plain'}),filename);return (await (await api('/imports/upload',{method:'POST',body:form})).json()).id;}
async function importRow(id){return (await pool.query('SELECT * FROM imports WHERE id=$1',[id])).rows[0];}
async function terminal(id){return waitFor('import terminal state',async()=>{const row=await importRow(id);return ['completed','blocked','error'].includes(row?.status)?row:false;},{timeout:90000});}
async function download(id,expectedHash){
 const response=await api(`/books/${id}/download`),bytes=Buffer.from(await response.arrayBuffer());
 assert.equal(response.headers.get('x-content-sha256'),expectedHash);assert.equal(hash(bytes),expectedHash);
 return JSON.parse(bytes.toString('utf8'));
}

try{
 // Volume markers are created only by this harness' new-volume initializer.
 // Refuse even a test-named DB if storage is not demonstrably this test run.
 for(const directory of Object.values(roots))assert.equal(await fs.readFile(path.join(directory,'.pipeline-test-run'),'utf8'),runId);
 for(const directory of [path.join(roots.quarantine,'incoming'),path.join(roots.quarantine,'attempts'),path.join(roots.jobs,'pending'),path.join(roots.jobs,'results'),path.join(roots.library,'books')])assert.deepEqual(await fs.readdir(directory),[]);
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'")).rows[0].n,0,'Database must be new; this test never truncates a preexisting schema');
 await applyMigrations(pool);record('fresh isolated database and storage guards');
 const profile=randomUUID(),login='pipeline_owner',password='synthetic-'+randomUUID();
 await pool.query("INSERT INTO profiles(id,login,password,role) VALUES($1,$2,$3,'owner')",[profile,login,await passwordHash(password)]);
 const scanner=await scannerVersion();summary.scannerVersion=scanner;record('live scanner freshness / VERSION');
 await resourceFixture();timer=setInterval(()=>{refresh=refresh.then(resourceFixture).catch(error=>{refreshError=error;});},1000);
 start('api','/app/server/app.mjs');
 await waitFor('API startup',async()=>{try{return (await fetch(origin+'/api/health',{signal:AbortSignal.timeout(1000)})).ok;}catch{return false;}},{timeout:20000});
 const loginResponse=await api('/login',{method:'POST',json:{login,password},authenticated:false});await loginResponse.json();
 cookie=(loginResponse.headers.getSetCookie()[0]||'').split(';')[0];assert.match(cookie,/^cotology=[a-f0-9]{64}$/);
 const me=await (await api('/me')).json();assert.equal(me.id,profile);assert.equal(me.role,'owner');csrf=me.csrf;assert.match(csrf,/^[a-f0-9]{64}$/);
 start('worker','/app/server/worker.mjs');record('real API login / CSRF / worker startup');

 const text=Buffer.from('Синтетическая проверка полного пути импорта.\n\nВторая строка остаётся читаемой.','utf8');
 const cleanId=await upload(text,'pipeline-fixture.txt'),completed=await terminal(cleanId);
 assert.equal(completed.status,'completed',completed.error||'Clean TXT was not published');assert.equal(completed.security_state,'passed');
 assert.equal(completed.requested_by,profile);assert.equal(completed.report.sha256,hash(text));assert.equal(completed.report.attemptToken,completed.attempt_token);
 assert.ok(completed.report.checks.some(check=>check.name==='Исходный файл: угроз не обнаружено'));
 assert.ok(completed.report.checks.some(check=>check.name==='Подготовленные данные: угроз не обнаружено'));
 const book=(await pool.query('SELECT * FROM books WHERE import_id=$1',[cleanId])).rows[0];assert.ok(book);assert.equal(book.id,completed.book_id);
 assert.ok(book.artifact_manifest?.files.some(file=>file.path==='book.json'));assert.match(book.content_sha256,/^[a-f0-9]{64}$/);
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM import_attempts WHERE token=$1 AND state='published'",[completed.attempt_token])).rows[0].n,1);
 record('TXT upload -> raw scan -> attempt-scoped parser -> derived scan -> publication',{importId:cleanId,bookId:book.id});

 // The worker sleeps four seconds after run(). Polling above catches COMMIT
 // promptly, then a known empty directory injects unlink failure without ever
 // modifying the published package. This lives only in the new test volume.
 const fault=path.join(roots.quarantine,'incoming',cleanId);
 try{const entry=await fs.lstat(fault);assert.ok(entry.isFile()&&!entry.isSymbolicLink());await fs.unlink(fault);}catch(error){if(error.code!=='ENOENT')throw error;}
 await fs.mkdir(fault,{mode:0o700});
 const failedCleanup=await waitFor('post-publication cleanup error',async()=>{const row=await importRow(cleanId);return row.cleanup_pending&&row.cleanup_error?row:false;},{timeout:20000});
 assert.equal(failedCleanup.status,'completed');assert.equal(failedCleanup.book_id,book.id);
 const downloaded=await download(book.id,book.content_sha256);assert.equal(downloaded.chapters[0].blocks[0].text,'Синтетическая проверка полного пути импорта.');
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM books WHERE import_id=$1',[cleanId])).rows[0].n,1);
 record('cleanup failure preserves completed publication and download hash',{cleanupError:failedCleanup.cleanup_error});
 await fs.rmdir(fault); // Empty, explicitly owned fault directory only.
 await waitFor('cleanup recovery',async()=>{const row=await importRow(cleanId);return !row.cleanup_pending&&row.cleanup_error===null;},{timeout:20000});
 await assert.rejects(()=>fs.lstat(path.join(roots.quarantine,'attempts',completed.attempt_token)),{code:'ENOENT'});
 record('cleanup retries successfully after removal of the injected empty directory');

 const mark=randomUUID();await (await api(`/books/${book.id}/reading`,{method:'PUT',json:{chapter:0,position:0.42,shelf:'reading'}})).json();
 await (await api(`/books/${book.id}/bookmarks`,{method:'POST',json:{id:mark,chapter:0,position:0.42,note:'Synthetic acceptance bookmark'}})).json();
 const detail=await (await api(`/books/${book.id}`)).json();assert.equal(detail.reading.position,0.42);assert.ok(detail.bookmarks.some(item=>item.id===mark));
 const chapter=await (await api(`/books/${book.id}/chapters/0`)).json();assert.deepEqual(chapter,downloaded.chapters[0]);
 record('online chapter / progress / bookmark persist through the real API');

 heavyAllowed=false;await refresh;await resourceFixture();
 const pausedId=await upload(text,'pipeline-fixture.txt');
 await waitFor('resource wait',async()=>{const row=await importRow(pausedId);return row.status==='processing'&&row.stage==='Ожидание свободных ресурсов ПК';},{timeout:20000});
 await pool.query('UPDATE settings SET imports_paused=true WHERE id=1');
 await waitFor('administrative pause requeues without error',async()=>{const row=await importRow(pausedId);return row.status==='queued'&&!row.error;},{timeout:20000});
 assert.equal((await api(`/books/${book.id}/chapters/0`)).status,200);record('resource shortage and administrative pause preserve the job and online reading');
 heavyAllowed=true;await refresh;await resourceFixture();await pool.query('UPDATE settings SET imports_paused=false WHERE id=1');
 const reused=await terminal(pausedId);assert.equal(reused.status,'completed',reused.error);assert.equal(reused.book_id,book.id);assert.equal(reused.report.deduplicatedTo,book.id);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM books')).rows[0].n,1);await download(book.id,book.content_sha256);
 record('paused job resumes automatically and exact duplicate reuses the verified publication');

 heavyAllowed=false;await refresh;await resourceFixture();
 const cancelledId=await upload(Buffer.from('Synthetic cancelled input'),'cancelled-fixture.txt');
 await waitFor('cancellable processing attempt',async()=>{const row=await importRow(cancelledId);return row.status==='processing'&&row.attempt_token;},{timeout:20000});
 await (await api(`/imports/${cancelledId}/cancel`,{method:'POST'})).json();
 await waitFor('cancelled attempt cleanup',async()=>{const row=await importRow(cancelledId);const a=(await pool.query('SELECT state FROM import_attempts WHERE token=$1',[row.attempt_token])).rows[0];return row.status==='cancelled'&&a?.state==='cleaned';},{timeout:20000});
 heavyAllowed=true;await refresh;await resourceFixture();assert.equal((await pool.query('SELECT count(*)::int AS n FROM books')).rows[0].n,1);
 record('real API cancellation fences a processing attempt without affecting the existing book');

 // An owner-controlled fixture supplies trusted expected metadata directly to
 // the disposable DB. Public upload APIs do not accept this internal field.
 heavyAllowed=false;await refresh;await resourceFixture();
 const mismatchId=await upload(Buffer.from('A harmless different book, without Gutenberg identity metadata.'),'mismatch.txt');
 await pool.query('UPDATE imports SET options=$1 WHERE id=$2',[JSON.stringify({discovery:{expected:{provider:'gutenberg',remoteId:'11',title:"Alice’s Adventures in Wonderland",authors:['Carroll, Lewis'],language:'en',languages:['en']}}}),mismatchId]);
 heavyAllowed=true;await refresh;await resourceFixture();
 const identityReview=await waitFor('identity mismatch held',async()=>{const row=await importRow(mismatchId);return ['source-review','blocked','error','completed'].includes(row.status)?row:false;},{timeout:90000});
 assert.equal(identityReview.status,'source-review');assert.equal(identityReview.security_state,'pending');assert.equal(identityReview.book_id,null);
 assert.ok(identityReview.report.identityVerification.reasons.includes('GUTENBERG_WRAPPER_MISSING'));
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM books')).rows[0].n,1);
 record('safe but wrong book is held for identity review and never published');

 // Standard harmless antivirus control: encoded in host source, decoded only
 // in this disposable container's memory. Never print or save its plaintext
 // in host sources, host logs or reports. Upload is confined to the test volume.
 const control=Buffer.from(['WDVPIVAlQEFQWzRcUFpYNTQoUF4pN0NDKTd9','JEVJQ0FSLVNUQU5EQVJELUFOVElWSVJVUy1URVNULUZJTEUhJEgrSCo='].join(''),'base64');
 assert.equal(control.length,68);
 const blockedId=await upload(control,'antivirus-control.txt'),blocked=await terminal(blockedId);
 assert.equal(blocked.status,'blocked',blocked.error||'Antivirus control was not blocked');assert.equal(blocked.security_state,'blocked');
 assert.match(blocked.error,/FOUND/,'Blocking must come from live scanner detection');
 assert.ok(!blocked.report.checks.some(check=>check.name==='Исходный файл: угроз не обнаружено'||check.name.startsWith('Структура,')),'The control must not pass the raw-scan gate or reach parser acceptance');
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM books WHERE import_id=$1',[blockedId])).rows[0].n,0);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM books')).rows[0].n,1);
 const blockedAttempts=(await pool.query('SELECT token FROM import_attempts WHERE import_id=$1',[blockedId])).rows;assert.equal(blockedAttempts.length,1);
 await assert.rejects(()=>fs.lstat(path.join(roots.jobs,'pending',blockedAttempts[0].token+'.json')),{code:'ENOENT'});
 record('live antivirus control blocked before parser job / no published book',{importId:blockedId});
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit WHERE action='import.published' AND target=$1",[book.id])).rows[0].n,1);
 assert.ok((await pool.query("SELECT 1 FROM audit WHERE action='book.package.issued' AND actor=$1 AND target=$2",[profile,book.id])).rowCount);

 if(process.env.GARGANTUA_TEST_LIVE_DISCOVERY==='1'){
  summary.liveDiscovery=true;summary.limitations.push('One live public-domain-US Gutenberg TXT consistency/import sample, not proof of availability/rights/quality for the whole source. No translation/audio provider runs.');
  const created=await(await api('/discovery/requests',{method:'POST',json:{idempotencyKey:randomUUID(),query:"Alice's Adventures in Wonderland",language:'en',audio:true,intent:'book'}})).json();
  const requestId=created.request.id;
  let request=await waitFor('live metadata discovery',async()=>{const row=await(await api('/discovery/requests/'+requestId)).json();return ['needs-review','selected','acquiring','book-ready','error'].includes(row.status)?row:false;},{timeout:75000,interval:500});
  assert.notEqual(request.status,'error',request.error);
  summary.liveDiscoveryPlan={status:request.status,providerErrors:request.plan?.providerErrors,candidates:request.plan?.candidates?.map(item=>({identity:item.identity,title:item.title,availability:item.availability,blockedReason:item.blockedReason})),requestCount:request.plan?.requestCount,hasMore:request.plan?.hasMore};
  if(request.status==='needs-review'&&!request.plan.candidates.some(item=>item.identity?.provider==='gutendex'&&item.identity.remoteId==='11')){
   // Real clarification: a catalogue record is not a file. Select the exact
   // known work, then let core.5 refresh its author and resolve safe sources.
   const work=request.plan.candidates.find(item=>item.identity?.provider==='openlibrary'&&item.identity.remoteId==='OL138052W');assert.ok(work,'Canonical Alice work absent; no arbitrary title fallback');
   await api(`/discovery/requests/${requestId}/decision`,{method:'POST',json:{action:'select',expectedRevision:request.revision,planRevision:request.plan_revision,candidateId:work.id}});
   const revision=request.plan_revision;
   request=await waitFor('canonical work source clarification',async()=>{const row=await(await api('/discovery/requests/'+requestId)).json();return row.plan_revision>revision&&['needs-review','selected','acquiring','book-ready','error'].includes(row.status)?row:false;},{timeout:75000,interval:500});
   summary.liveWorkExpansion={status:request.status,source:request.plan?.sourceResolutionFor,providerErrors:request.plan?.providerErrors,identities:request.plan?.candidates?.map(item=>item.identity)};
  }
  if(request.status==='needs-review'){
   const candidate=request.plan.candidates.find(item=>item.identity?.provider==='gutendex'&&item.identity.remoteId==='11');assert.ok(candidate,'Live query did not return Gutenberg 11');assert.equal(candidate.availability,'fetchable');
   request=await(await api(`/discovery/requests/${requestId}/decision`,{method:'POST',json:{action:'select',expectedRevision:request.revision,planRevision:request.plan_revision,candidateId:candidate.id}})).json();
  }
  request=await waitFor('live selected book imported',async()=>{const row=await(await api('/discovery/requests/'+requestId)).json();return ['book-ready','needs-review','error'].includes(row.status)?row:false;},{timeout:120000,interval:500});
  assert.equal(request.status,'book-ready',request.error||JSON.stringify(request.outputs));assert.equal(request.outputs.translation.status,'not-required');assert.equal(request.outputs.audio.status,'pending-provider');
  const imported=await importRow(request.import_id);assert.equal(imported.report.identityVerification.verified,true);assert.equal(imported.report.identityVerification.observed.sourceIds[0],'11');assert.equal(imported.requested_by,profile);
  const liveBook=(await pool.query('SELECT * FROM books WHERE id=$1',[request.outputs.book.publicationId])).rows[0];await download(liveBook.id,liveBook.content_sha256);
  record('live title query -> persisted selection -> mirror TXT -> antivirus -> isolated parser -> identity gate -> publication',{provider:'gutenberg',remoteId:'11',inputBytes:imported.report.size,inputSha256:imported.report.sha256});
  const again=await(await api('/discovery/requests',{method:'POST',json:{idempotencyKey:randomUUID(),query:"Alice's Adventures in Wonderland",language:'en',audio:false,intent:'book'}})).json();
  const reusedRequest=await waitFor('local library reuse',async()=>{const row=await(await api('/discovery/requests/'+again.request.id)).json();return ['book-ready','error','needs-review'].includes(row.status)?row:false;},{timeout:30000,interval:300});
  assert.equal(reusedRequest.status,'book-ready',reusedRequest.error);assert.equal(reusedRequest.outputs.book.publicationId,liveBook.id);assert.equal(reusedRequest.import_id,null);assert.equal(reusedRequest.plan.requestCount,0);assert.equal((await pool.query('SELECT count(*)::int AS n FROM books')).rows[0].n,2);
  record('second title request reuses verified local publication without another download');
 }
 if(process.env.GARGANTUA_TEST_RANOBE==='1'){
  const {acceptRanobePipeline}=await import('./ranobe-pipeline.acceptance.mjs');
  await acceptRanobePipeline({pool,api,profile,roots,record,waitFor,start,stop,children,download,summary,control});
 }
 summary.ok=true;
}catch(error){summary.error={name:error.name,code:error.code||null,message:String(error.message).slice(0,1500)};process.exitCode=1;}
finally{
 clearInterval(timer);await refresh.catch(()=>{});
 for(const child of children.toReversed())await stop(child);
 summary.children=children.map(child=>({name:child.name,exitCode:child.process.exitCode,signal:child.process.signalCode,logTail:child.tail}));
 await pool.end();summary.finishedAt=new Date().toISOString();
 await fs.writeFile(reportFile,JSON.stringify(summary,null,2),{mode:0o600});console.log(JSON.stringify(summary));
}
