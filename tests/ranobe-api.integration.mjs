// Actual app/auth/session/CSRF/routes over loopback HTTP, isolated PostgreSQL
// schema and temporary storage. No worker or provider network is started.
// The child bootstrap substitutes ONLY listen(3080) with a loopback ephemeral
// port, avoiding collisions with the existing durability HTTP suite.
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
import {claimImport} from '../server/import-jobs.mjs';
import {createRanobeRequest,beginRanobeRun} from '../server/ranobe-store.mjs';

const database=new URL(process.env.TEST_DATABASE_URL||'postgres://invalid/disabled');
if(process.env.GARGANTUA_TEST_ISOLATED!=='1'||!/^\/gargantua_test_[a-z0-9_]+$/.test(database.pathname))throw Error('Explicit isolated TEST_DATABASE_URL required; refusing production');
const schema='ranobe_api_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:database.href,max:1,statement_timeout:15000});
const isolated=new URL(database);isolated.searchParams.set('options',`-c search_path=${schema}`);
const pool=new pg.Pool({connectionString:isolated.href,max:5,statement_timeout:15000});
const owner={id:randomUUID(),login:'synthetic_owner'},reader={id:randomUUID(),login:'synthetic_reader'},password='synthetic-api-password-12345';
const requestBody=(extra={})=>({url:'https://ranobelib.me/ru/book/123--synthetic',branch:null,idempotencyKey:randomUUID(),...extra});
const appUrl=new URL('../server/app.mjs',import.meta.url).href,origin='http://gargantua-isolated-http.test';
let created=false,root,child,base,hashed;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);created=true;await applyMigrations(pool);hashed=await passwordHash(password);});
beforeEach(async()=>{
 await pool.query('TRUNCATE profiles,works RESTART IDENTITY CASCADE');await pool.query('UPDATE settings SET imports_paused=false,serving_paused=false WHERE id=1');
 for(const [profile,role]of [[owner,'owner'],[reader,'reader']])await pool.query('INSERT INTO profiles(id,login,password,role) VALUES($1,$2,$3,$4)',[profile.id,profile.login,hashed,role]);
 root=await fs.mkdtemp(path.join(os.tmpdir(),'gargantua-ranobe-api-'));const quarantine=path.join(root,'quarantine'),library=path.join(root,'library');
 for(const directory of [library,path.join(quarantine,'incoming'),path.join(quarantine,'attempts')])await fs.mkdir(directory,{recursive:true,mode:0o700});
 const bootstrap=`import net from 'node:net';const listen=net.Server.prototype.listen;net.Server.prototype.listen=function(...args){if(args[0]===3080){args[0]=0;args[1]='127.0.0.1';this.once('listening',()=>console.log('ISOLATED_HTTP_PORT:'+this.address().port));}return listen.apply(this,args);};await import(${JSON.stringify(appUrl)});`;
 child=spawn(process.execPath,['--input-type=module','-e',bootstrap],{env:{...process.env,DATABASE_URL:isolated.href,QUARANTINE_DIR:quarantine,LIBRARY_DIR:library,APP_ORIGIN:origin},stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='',spawnError;child.once('error',error=>{spawnError=error;});child.stdout.on('data',bytes=>{stdout=(stdout+bytes.toString()).slice(-8192);});child.stderr.on('data',bytes=>{stderr=(stderr+bytes.toString()).slice(-8192);});
 const deadline=Date.now()+15000;while(Date.now()<deadline){if(spawnError)throw spawnError;if(child.exitCode!==null||child.signalCode!==null)throw Error('Isolated API exited: '+stderr.slice(-500));const match=stdout.match(/ISOLATED_HTTP_PORT:(\d+)/);if(match){base='http://127.0.0.1:'+match[1];assert.equal((await fetch(base+'/api/health',{signal:AbortSignal.timeout(1000)})).status,200);return;}await pause(50);}throw Error('Isolated API did not start: '+stderr.slice(-500));
});
afterEach(async()=>{
 if(child&&child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill('SIGTERM');await Promise.race([done,pause(3000)]);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await done;}}child=null;
 if(root){assert.equal(path.dirname(root),os.tmpdir());assert.match(path.basename(root),/^gargantua-ranobe-api-/);await fs.rm(root,{recursive:true,force:true});root=null;}
});
after(async()=>{await pool.end();try{if(created){assert.match(schema,/^ranobe_api_[a-f0-9]{32}$/);await admin.query(`DROP SCHEMA ${schema} CASCADE`);}}finally{await admin.end();}});
async function api(route,{method='GET',json,session,headers={}}={}){
 const all={'X-Cotology':'1',Origin:origin,...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{}),...headers};
 if(json!==undefined)all['Content-Type']='application/json';return fetch(base+'/api'+route,{method,headers:all,body:json===undefined?undefined:JSON.stringify(json),signal:AbortSignal.timeout(10000)});
}
async function login(profile=owner){const response=await api('/login',{method:'POST',json:{login:profile.login,password}});assert.equal(response.status,200);const cookie=response.headers.get('set-cookie').split(';')[0];assert.match(cookie,/^cotology=[a-f0-9]{64}$/);const me=await api('/me',{session:{cookie,csrf:''}});assert.equal(me.status,200);const value=await me.json();assert.equal(value.id,profile.id);assert.match(value.csrf,/^[a-f0-9]{64}$/);return {cookie,csrf:value.csrf};}
const number=async table=>Number((await pool.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);

test('only owner can retry a reviewed supported full branch without a new import or initiative',async()=>{
 const created=await createRanobeRequest(pool,reader,requestBody(),{checkCapacity:async()=>{}}),job=created.import;
 await pool.query("UPDATE imports SET status='source-review',error='Synthetic unsupported typed node' WHERE id=$1",[job.id]);
 const readerSession=await login(reader),ownerSession=await login();
 assert.equal((await api(`/imports/${job.id}/decision`,{method:'POST',json:{action:'retry'},session:readerSession})).status,403);
 assert.equal((await pool.query('SELECT status FROM imports WHERE id=$1',[job.id])).rows[0].status,'source-review');
 assert.equal((await api(`/imports/${job.id}/decision`,{method:'POST',json:{action:'retry',reason:'Adapter fixed; rerun every check'},session:ownerSession})).status,200);
 const retried=(await pool.query('SELECT * FROM imports WHERE id=$1',[job.id])).rows[0];
 assert.equal(retried.status,'queued');assert.equal(retried.security_state,'pending');assert.equal(retried.requested_by,reader.id);assert.equal(retried.approved_by,owner.id);assert.deepEqual(retried.options,job.options);
 assert.equal(await number('imports'),1);assert.equal(await number('ranobe_feed_requests'),1);
 assert.equal((await claimImport(pool)).id,job.id);
});

test('owner retry cannot turn an unknown reviewed website or preview-only Ranobe into a full adapter',async()=>{
 const session=await login();
 for(const [kind,options] of [['source-review',{}],['ranobe',{}],['file',{}],['upload',{}]]){
  const id=randomUUID();await pool.query("INSERT INTO imports(id,requested_by,kind,filename,status,options) VALUES($1,$2,$3,'synthetic-review','source-review',$4)",[id,owner.id,kind,JSON.stringify(options)]);
  const result=await api(`/imports/${id}/decision`,{method:'POST',json:{action:'retry'},session});assert.equal(result.status,400);
  assert.equal((await pool.query('SELECT status FROM imports WHERE id=$1',[id])).rows[0].status,'source-review');
 }
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit WHERE action='import.retry'")).rows[0].n,0);
});

test('real sessions, CSRF and origin protection reject unauthenticated or forged requests',async()=>{
 const body=requestBody();assert.equal((await api('/ranobe/requests',{method:'POST',json:body})).status,401);assert.equal((await api('/ranobe/feeds')).status,401);
 const session=await login();
 for(const headers of [{'X-CSRF-Token':''},{'X-CSRF-Token':'incorrect'},{Origin:'https://foreign.invalid'},{'X-Cotology':''}])assert.equal((await api('/ranobe/requests',{method:'POST',json:body,session,headers})).status,403);
 assert.equal(await number('imports'),0);assert.equal(await number('ranobe_feeds'),0);
 await pool.query('DELETE FROM sessions WHERE profile_id=$1',[owner.id]);assert.equal((await api('/ranobe/requests',{method:'POST',json:body,session})).status,401);assert.equal(await number('imports'),0);
});

test('logical book metadata requires the real authenticated session and has no side effects',async()=>{
 assert.equal((await api('/library/serial-groups')).status,401);const session=await login();
 const response=await api('/library/serial-groups',{session});assert.equal(response.status,200);assert.deepEqual(await response.json(),{schemaVersion:1,groups:[]});
 assert.equal(await number('books'),0);assert.equal(await number('ranobe_runs'),0);assert.equal(await number('ranobe_feed_requests'),0);
});
test('branch is required and strict booleans preserve explicit false rather than defaults',async()=>{
 const session=await login(),missing=requestBody();delete missing.branch;
 for(const body of [missing,requestBody({branch:false}),requestBody({branch:'77'}),requestBody({autoUpdate:'false'}),requestBody({force:0}),requestBody({untrustedInternalField:true})])assert.equal((await api('/ranobe/requests',{method:'POST',json:body,session})).status,400);
 assert.equal(await number('imports'),0);
 const body=requestBody({autoUpdate:false,force:false}),response=await api('/ranobe/requests',{method:'POST',json:body,session});assert.equal(response.status,202);const value=await response.json();assert.equal(value.feed.auto_update,false);assert.equal(value.feed.branch_key,'default');assert.equal(value.import.options.branch,null);assert.equal(value.import.options.force,false);assert.equal(value.import.status,'queued');
 const repeated=await api('/ranobe/requests',{method:'POST',json:body,session});assert.equal(repeated.status,200);assert.equal((await repeated.json()).import.id,value.import.id);
 assert.equal((await api('/ranobe/requests',{method:'POST',json:{...body,force:true},session})).status,409);assert.equal(await number('imports'),1);
});
test('subscription settings enforce live roles and compare-and-swap revisions',async()=>{
 const session=await login(),readSession=await login(reader),created=await api('/ranobe/requests',{method:'POST',json:requestBody(),session});assert.equal(created.status,202);const {feed}=await created.json(),route=`/ranobe/feeds/${feed.id}/settings`;
 assert.equal((await api(route,{method:'POST',json:{autoUpdate:false,expectedRevision:feed.revision},session:readSession})).status,403);
 assert.equal((await api(route,{method:'POST',json:{autoUpdate:'false',expectedRevision:feed.revision},session})).status,400);
 const changed=await api(route,{method:'POST',json:{autoUpdate:false,expectedRevision:feed.revision},session});assert.equal(changed.status,200);const current=await changed.json();assert.equal(current.auto_update,false);assert.equal(current.revision,feed.revision+1);
 assert.equal((await api(route,{method:'POST',json:{autoUpdate:true,expectedRevision:feed.revision},session})).status,409);
 await pool.query("UPDATE profiles SET role='reader' WHERE id=$1",[owner.id]);assert.equal((await api(route,{method:'POST',json:{autoUpdate:true,expectedRevision:current.revision},session})).status,403);
 assert.equal((await pool.query('SELECT auto_update FROM ranobe_feeds WHERE id=$1',[feed.id])).rows[0].auto_update,false);
});
test('snapshot HTTP metadata binds the explicit branch and hides unrelated unfinished feeds',async()=>{
 const session=await login(),readSession=await login(reader),created=await api('/ranobe/requests',{method:'POST',json:requestBody({branch:77}),session});assert.equal(created.status,202);const {feed,import:job}=await created.json();
 const parent=await claimImport(pool);assert.equal(parent.id,job.id);const run=await beginRanobeRun(pool,parent,{title:'Synthetic novel',author:'Synthetic author',policyVersion:'test-http-v1',chapters:[{key:'ranobelib:123:branch:77:v1:c1',revisionHint:'release-1001',title:'Chapter 1',volume:'1',number:'1'}]});
 const route=`/ranobe/feeds/${feed.id}/snapshots/${run.id}`,response=await api(route,{session});assert.equal(response.status,200);const snapshot=await response.json();assert.equal(snapshot.feedId,feed.id);assert.equal(snapshot.snapshotId,run.id);assert.equal(snapshot.branch,'77');assert.equal(snapshot.status,'building');assert.equal(snapshot.originalWorkComplete,false);assert.equal(snapshot.coverage,'source-inventory-snapshot');assert.equal(snapshot.chapterCount,1);assert.deepEqual(snapshot.parts,[]);
 assert.equal((await api(`/ranobe/feeds/${feed.id}`,{session:readSession})).status,404);assert.equal((await api(route,{session:readSession})).status,404);assert.deepEqual(await (await api('/ranobe/feeds',{session:readSession})).json(),[]);
 const other=await createRanobeRequest(pool,owner,requestBody(),{checkCapacity:async()=>{}});assert.equal((await api(`/ranobe/feeds/${other.feed.id}/snapshots/${run.id}`,{session})).status,404);
 const shared=await api('/ranobe/requests',{method:'POST',json:requestBody({branch:77}),session:readSession});assert.equal(shared.status,200);assert.equal((await shared.json()).import.id,parent.id);assert.equal((await api(`/ranobe/feeds/${feed.id}`,{session:readSession})).status,200);assert.equal((await api(route,{session:readSession})).status,404,'joining a request does not expose unfinished snapshot internals');
});
