// Requires a new disposable PostgreSQL, never the production library database.
import test,{before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import pg from 'pg';
import {applyMigrations} from '../server/migrations.mjs';
import {claimImport,assertAttempt,markPrepared,publishImport,failImport,reconcileAttempts} from '../server/import-jobs.mjs';
import {stagePublication,placePublication,readPublication,removeAttemptFiles,digest} from '../server/publication-files.mjs';
import {passwordHash} from '../server/security.mjs';
import {acquireImportAdmission,checkImportCapacity} from '../server/import-admission.mjs';
import {applyImportDecision} from '../server/import-decisions.mjs';
const url=new URL(process.env.TEST_DATABASE_URL||'postgres://invalid/disabled');
if(process.env.GARGANTUA_TEST_ISOLATED!=='1'||!/^\/gargantua_test_[a-z0-9_]+$/.test(url.pathname))throw new Error('Explicit isolated TEST_DATABASE_URL is required; refusing any production database');
const pool=new pg.Pool({connectionString:url.href,max:12,statement_timeout:10000});
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6QkAAAAASUVORK5CYII=','base64');
const book={title:'Synthetic integration fixture',author:'Test',language:'ru',chapters:[{title:'Chapter 1',blocks:[{type:'text',text:'Проверка сохранения.'},{type:'image',asset:'image-1.png',text:'Карта'}]}],assets:{'image-1.png':png.toString('base64')}};
let root,profile;
before(async()=>{await applyMigrations(pool);root=await fs.mkdtemp(path.join(os.tmpdir(),'gargantua-core-integration-'));});
beforeEach(async()=>{
 await pool.query('TRUNCATE audit,reading,bookmarks,profile_catalogs,sessions,import_attempts,books,imports,profiles,works RESTART IDENTITY CASCADE');
 await pool.query('UPDATE settings SET imports_paused=false,serving_paused=false WHERE id=1');profile=randomUUID();
 await pool.query("INSERT INTO profiles(id,login,password,role) VALUES($1,'tester',$2,'owner')",[profile,await passwordHash('synthetic-test-password-123')]);
});
after(async()=>{await pool.end();if(root){assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('gargantua-core-integration-'));await fs.rm(root,{recursive:true,force:true});}});
async function enqueue(){const id=randomUUID();await pool.query("INSERT INTO imports(id,requested_by,kind,filename,status,decision_reason) VALUES($1,$2,'upload','test.txt','queued','role-auto-approval')",[id,profile]);return id;}
async function prepared(row){const p=await stagePublication(root,row.attempt_token,row.resultBookId,book);await markPrepared(pool,row,p.manifest);await placePublication(root,p);await markPrepared(pool,row,p.manifest,'placed');return p;}
const report={sha256:digest(Buffer.from('synthetic original'))};
const result=async()=> (await pool.query('SELECT * FROM imports ORDER BY created_at LIMIT 1')).rows[0];
const bookCount=async()=>Number((await pool.query('SELECT count(*) FROM books')).rows[0].count);

test('migration ledger is stable and rejects edits/unknown future versions',async()=>{
 const original=(await pool.query('SELECT version,sha256 FROM schema_migrations ORDER BY version')).rows;await applyMigrations(pool);assert.equal(original.length,10);
 await pool.query("UPDATE schema_migrations SET sha256='tampered' WHERE version=$1",[original[0].version]);
 try{await assert.rejects(()=>applyMigrations(pool),/Изменена применённая/);}finally{await pool.query('UPDATE schema_migrations SET sha256=$1 WHERE version=$2',[original[0].sha256,original[0].version]);}
 await pool.query("INSERT INTO schema_migrations(version,sha256) VALUES('999-future.sql','future')");
 try{await assert.rejects(()=>applyMigrations(pool),/неизвестную версию/);}finally{await pool.query("DELETE FROM schema_migrations WHERE version='999-future.sql'");}
});
test('concurrent claims grant one durable attempt without resetting a live worker',async()=>{
 await enqueue();const rows=(await Promise.all(Array.from({length:8},()=>claimImport(pool)))).filter(Boolean);assert.equal(rows.length,1);assert.equal((await result()).attempt_number,1);
 assert.equal(await claimImport(pool),null);await assertAttempt(pool,rows[0]);
});
test('a stale owner rejection cannot overwrite a claimed or published import',async()=>{
 const id=await enqueue(),stale=(await pool.query('SELECT status FROM imports WHERE id=$1',[id])).rows[0];
 const row=await claimImport(pool);
 await assert.rejects(()=>applyImportDecision(pool,{id,expectedStatus:stale.status,action:'reject'}),{status:409});
 assert.equal((await result()).status,'processing');
 const p=await prepared(row);await publishImport(pool,row,book,p,report);
 await assert.rejects(()=>applyImportDecision(pool,{id,expectedStatus:stale.status,action:'reject'}),{status:409});
 assert.equal((await result()).status,'completed');assert.equal(await bookCount(),1);
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit WHERE action='import.reject'")).rows[0].n,0);
});
test('owner decision and audit commit together or preserve the original queue state',async()=>{
 const id=await enqueue();
 await pool.query("ALTER TABLE audit ADD CONSTRAINT test_reject_audit_failure CHECK(action<>'import.reject') NOT VALID");
 try{await assert.rejects(()=>applyImportDecision(pool,{id,expectedStatus:'queued',action:'reject'}),{code:'23514'});assert.equal((await result()).status,'queued');}
 finally{await pool.query('ALTER TABLE audit DROP CONSTRAINT test_reject_audit_failure');}
 await applyImportDecision(pool,{id,expectedStatus:'queued',action:'reject'});
 assert.equal((await result()).status,'rejected');assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit WHERE action='import.reject'")).rows[0].n,1);
});
test('cancelling a live attempt fences publication and reconciles only its unreferenced files',async()=>{
 const id=await enqueue(),row=await claimImport(pool),p=await prepared(row);
 await applyImportDecision(pool,{id,expectedStatus:'processing',action:'cancel',actor:profile});
 await assert.rejects(()=>publishImport(pool,row,book,p,report),{code:'LEASE_LOST'});
 assert.equal((await failImport(pool,row,new Error('late failure'),report)).stale,true);
 await reconcileAttempts(pool,attempt=>removeAttemptFiles(root,attempt.token,attempt.book_id,{removePlaced:true}));
 assert.equal((await result()).status,'cancelled');assert.equal(await bookCount(),0);await assert.rejects(()=>fs.lstat(path.join(root,'books',p.id)),{code:'ENOENT'});
});
test('expired attempt cannot publish or overwrite the fresh attempt failure state',async()=>{
 await enqueue();const first=await claimImport(pool),p=await prepared(first);
 await pool.query("UPDATE imports SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[first.id]);const second=await claimImport(pool);assert.notEqual(first.attempt_token,second.attempt_token);
 await assert.rejects(()=>publishImport(pool,first,book,p,report),{code:'LEASE_LOST'});assert.equal((await failImport(pool,first,new Error('late error'),report)).stale,true);
 assert.equal((await result()).attempt_token,second.attempt_token);assert.equal((await result()).status,'processing');assert.equal(await bookCount(),0);
 const removed=[];await reconcileAttempts(pool,async a=>{removed.push(a.token);await removeAttemptFiles(root,a.token,a.book_id,{removePlaced:true});});assert.ok(removed.includes(first.attempt_token));await assertAttempt(pool,second);
});
test('expired failure stays recoverable before another claim and bad cleanup does not block the queue',async()=>{
 await enqueue();const first=await claimImport(pool);await prepared(first);
 await pool.query("UPDATE imports SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[first.id]);
 assert.equal((await failImport(pool,first,new Error('late network error'),report)).stale,true);assert.equal((await result()).status,'processing');
 const reconciliation=await reconcileAttempts(pool,async()=>{throw Object.assign(new Error('injected cleanup permission error'),{code:'EACCES'});});assert.equal(reconciliation.failed,1);
 const second=await claimImport(pool);assert.notEqual(first.attempt_token,second.attempt_token);assert.equal((await result()).status,'processing');
 assert.equal((await pool.query('SELECT cleanup_error FROM import_attempts WHERE token=$1',[first.attempt_token])).rows[0].cleanup_error,'EACCES');
});
test('known cleaned attempts are swept again if a late stale writer recreates files',async()=>{
 await enqueue();const first=await claimImport(pool);await pool.query("UPDATE imports SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[first.id]);
 await reconcileAttempts(pool,a=>removeAttemptFiles(root,a.token,a.book_id,{removePlaced:true}));
 const late=await stagePublication(root,first.attempt_token,first.resultBookId,book);await assert.rejects(()=>markPrepared(pool,first,late.manifest),{code:'LEASE_LOST'});
 await reconcileAttempts(pool,a=>removeAttemptFiles(root,a.token,a.book_id,{removePlaced:true}));await assert.rejects(()=>fs.stat(path.join(root,'.staging',first.attempt_token)),{code:'ENOENT'});
});
test('concurrent admission is serialized and pending input budgets include unfinished uploads',async()=>{
 const release=await acquireImportAdmission(pool);await assert.rejects(()=>acquireImportAdmission(pool),{status:429});await release();await release();
 const again=await acquireImportAdmission(pool);try{
  for(let n=0;n<6;n++){const id=await enqueue();await pool.query("UPDATE imports SET status='uploading' WHERE id=$1",[id]);}
  await assert.rejects(()=>checkImportCapacity(pool,root,root),{status:507});
  await pool.query("UPDATE imports SET status='rejected'");const available=await checkImportCapacity(pool,root,root);assert.equal(available.reservedBytes,40*1024*1024);
 }finally{await again();}
});
test('audit insert failure rolls back publication and success status in the real database',async()=>{
 await enqueue();const row=await claimImport(pool),p=await prepared(row);
 await pool.query("CREATE OR REPLACE FUNCTION test_fail_publish_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='import.published' THEN RAISE EXCEPTION 'injected audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER test_audit_failure BEFORE INSERT ON audit FOR EACH ROW EXECUTE FUNCTION test_fail_publish_audit()");
 try{await assert.rejects(()=>publishImport(pool,row,book,p,report),/injected audit failure/);assert.equal(await bookCount(),0);assert.equal((await result()).status,'processing');}
 finally{await pool.query('DROP TRIGGER test_audit_failure ON audit; DROP FUNCTION test_fail_publish_audit()');}
 await failImport(pool,row,new Error('retryable publication failure'),report);assert.equal((await result()).status,'error');
 await reconcileAttempts(pool,a=>removeAttemptFiles(root,a.token,a.book_id,{removePlaced:true}));await assert.rejects(()=>fs.stat(path.join(root,'books',p.id)),{code:'ENOENT'});
});
test('a lost COMMIT response does not erase a committed book or create a duplicate',async()=>{
 await enqueue();const row=await claimImport(pool),p=await prepared(row);
 const ambiguous={connect:async()=>{const c=await pool.connect();return {release:()=>c.release(),query:async(sql,params)=>{const r=await c.query(sql,params);if(sql==='COMMIT')throw new Error('injected lost commit response');return r;}};}};
 await assert.rejects(()=>publishImport(ambiguous,row,book,p,report),/lost commit response/);
 const recovered=await failImport(pool,row,new Error('cleanup/network failure'),report);assert.equal(recovered.published,true);assert.equal(await bookCount(),1);assert.equal((await result()).status,'completed');
 assert.equal(Number((await pool.query("SELECT count(*) FROM audit WHERE action='import.published'")).rows[0].count),1);
 await readPublication(root,(await pool.query('SELECT * FROM books')).rows[0]);
 await pool.query("UPDATE imports SET status='queued' WHERE id=$1",[row.id]);assert.equal(await claimImport(pool),null);assert.equal(await bookCount(),1);assert.equal((await result()).status,'completed');
});
test('permission revocation and pause are rechecked at activation',async()=>{
 await enqueue();const row=await claimImport(pool),p=await prepared(row);await pool.query("UPDATE profiles SET role='reader' WHERE id=$1",[profile]);
 await assert.rejects(()=>publishImport(pool,row,book,p,report),/отозвано/);assert.equal(await bookCount(),0);await pool.query("UPDATE profiles SET role='owner' WHERE id=$1",[profile]);
 await pool.query('UPDATE settings SET imports_paused=true WHERE id=1');let paused;
 try{await publishImport(pool,row,book,p,report);}catch(e){paused=e;}assert.equal(paused.code,'IMPORT_PAUSED');await failImport(pool,row,paused,report);assert.equal((await result()).status,'queued');
});
test('database unique/check constraints reject duplicate publication and partial integrity metadata',async()=>{
 await enqueue();const row=await claimImport(pool),p=await prepared(row);await publishImport(pool,row,book,p,report);
 await assert.rejects(()=>pool.query("INSERT INTO books SELECT (jsonb_populate_record(NULL::books,to_jsonb(b)||jsonb_build_object('id',$1::uuid))).* FROM books b WHERE id=$2",[randomUUID(),p.id]),{code:'23505'});
 await assert.rejects(()=>pool.query('UPDATE books SET content_sha256=NULL WHERE id=$1',[p.id]),{code:'P0001'});
});
async function abruptChild(row,crashAt){
 const code=`import pg from 'pg';import {stagePublication,placePublication} from './server/publication-files.mjs';import {markPrepared,publishImport} from './server/import-jobs.mjs';const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});const row=JSON.parse(process.env.TEST_ROW),book=JSON.parse(process.env.TEST_BOOK);const p=await stagePublication(process.env.TEST_ROOT,row.attempt_token,row.resultBookId,book);await markPrepared(pool,row,p.manifest);await placePublication(process.env.TEST_ROOT,p);await markPrepared(pool,row,p.manifest,'placed');if(process.env.CRASH_AT==='placement')process.exit(80);await publishImport(pool,row,book,p,JSON.parse(process.env.TEST_REPORT));process.exit(81);`;
 const child=spawn(process.execPath,['--input-type=module','-e',code],{env:{...process.env,TEST_ROW:JSON.stringify(row),TEST_BOOK:JSON.stringify(book),TEST_ROOT:root,TEST_REPORT:JSON.stringify(report),CRASH_AT:crashAt},stdio:['ignore','pipe','pipe']});let errors='';child.stderr.on('data',b=>{errors+=b;});return await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',exit=>[80,81].includes(exit)?resolve(exit):reject(new Error('Crash child failed: '+errors.slice(0,500))));});
}
test('real child death after file placement leaves no visible result and is reconciled',async()=>{
 await enqueue();const first=await claimImport(pool);assert.equal(await abruptChild(first,'placement'),80);assert.equal(await bookCount(),0);await fs.stat(path.join(root,'books',first.resultBookId,'book.json'));
 await pool.query("UPDATE imports SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[first.id]);const second=await claimImport(pool);await reconcileAttempts(pool,a=>removeAttemptFiles(root,a.token,a.book_id,{removePlaced:true}));
 await assert.rejects(()=>fs.stat(path.join(root,'books',first.resultBookId)),{code:'ENOENT'});const p=await prepared(second);await publishImport(pool,second,book,p,report);assert.equal(await bookCount(),1);
});
test('real child death after commit retains the exact book and one audit event',async()=>{
 await enqueue();const row=await claimImport(pool);assert.equal(await abruptChild(row,'commit'),81);assert.equal((await result()).status,'completed');assert.equal((await result()).cleanup_pending,true);
 await failImport(pool,row,new Error('late post-commit failure'),report);assert.equal(await bookCount(),1);await readPublication(root,(await pool.query('SELECT * FROM books')).rows[0]);
 assert.equal(Number((await pool.query("SELECT count(*) FROM audit WHERE action='import.published'")).rows[0].count),1);
});
test('real API returns verified original bytes and rejects later text/asset corruption',async()=>{
 await enqueue();const row=await claimImport(pool),p=await prepared(row);await publishImport(pool,row,book,p,report);
 await fs.mkdir(path.join(root,'incoming'),{recursive:true});await fs.mkdir(path.join(root,'attempts'),{recursive:true});
 const api=spawn(process.execPath,['server/app.mjs'],{env:{...process.env,DATABASE_URL:url.href,LIBRARY_DIR:root,QUARANTINE_DIR:root,APP_ORIGIN:'http://localhost:3080'},stdio:['ignore','pipe','pipe']});let errors='';api.stderr.on('data',b=>errors+=b);api.stdout.resume();
 try{
  let ready=false;for(let i=0;i<80;i++){try{if((await fetch('http://127.0.0.1:3080/api/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready,errors.slice(0,500));
  const login=await fetch('http://127.0.0.1:3080/api/login',{method:'POST',headers:{'Content-Type':'application/json','X-Cotology':'1'},body:JSON.stringify({login:'tester',password:'synthetic-test-password-123'})});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0],headers={Cookie:cookie};
  const me=await (await fetch('http://127.0.0.1:3080/api/me',{headers})).json();
  const status=await (await fetch('http://127.0.0.1:3080/api/status',{headers})).json();assert.equal(status.storageVersion,10);assert.equal(status.version,'0.2.0-core.14');
  const upload=new FormData();upload.append('file',new Blob(['A synthetic local file.']),'local.txt');
  const accepted=await fetch('http://127.0.0.1:3080/api/imports/upload',{method:'POST',headers:{...headers,'X-Cotology':'1','X-CSRF-Token':me.csrf},body:upload});assert.equal(accepted.status,202);const uploadId=(await accepted.json()).id;
  assert.equal((await pool.query('SELECT status FROM imports WHERE id=$1',[uploadId])).rows[0].status,'queued');assert.equal((await fs.readFile(path.join(root,'incoming',uploadId),'utf8')),'A synthetic local file.');
  const download=await fetch(`http://127.0.0.1:3080/api/books/${p.id}/download`,{headers});assert.equal(download.status,200);assert.equal(download.headers.get('x-content-sha256'),p.contentSha256);assert.equal(digest(Buffer.from(await download.arrayBuffer())),p.contentSha256);
  const image=await fetch(`http://127.0.0.1:3080/api/books/${p.id}/assets/image-1.png`,{headers});assert.equal(image.status,200);assert.ok(Buffer.from(await image.arrayBuffer()).equals(png));
  const filename=path.join(root,'books',p.id,'book.json'),original=await fs.readFile(filename);await fs.writeFile(filename,Buffer.from('tampered'));
  for(const suffix of ['','/download','/chapters/0','/assets/image-1.png'])assert.equal((await fetch(`http://127.0.0.1:3080/api/books/${p.id}${suffix}`,{headers})).status,423);
  await fs.writeFile(filename,original);await fs.unlink(path.join(root,'books',p.id,'image-1.png'));assert.equal((await fetch(`http://127.0.0.1:3080/api/books/${p.id}/download`,{headers})).status,423);
 }finally{api.kill('SIGTERM');await new Promise(resolve=>{api.once('exit',resolve);setTimeout(()=>{api.kill('SIGKILL');resolve();},3000).unref();});}
});
