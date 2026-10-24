// Session/advisory-lock regressions; disposable PostgreSQL only, no HTTP server.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {acquireImportAdmission,withImportAdmission} from '../server/import-admission.mjs';

const url=new URL(process.env.TEST_DATABASE_URL||'postgres://invalid/disabled');
if(process.env.GARGANTUA_TEST_ISOLATED!=='1'||!/^\/gargantua_test_[a-z0-9_]+$/.test(url.pathname))throw new Error('Explicit isolated TEST_DATABASE_URL is required; refusing any production database');
const pool=new pg.Pool({connectionString:url.href,max:3,connectionTimeoutMillis:10000,statement_timeout:10000});
// A separate pool prevents a leaked, reentrant session lock from passing probes.
const competitor=new pg.Pool({connectionString:url.href,max:1,connectionTimeoutMillis:10000,statement_timeout:10000});
const table='test_admission_'+randomUUID().replaceAll('-','');
const gate=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const request=()=>({req:{aborted:false,complete:false,destroyed:false},res:Object.assign(new EventEmitter(),{destroyed:false})});
before(async()=>{await pool.query(`CREATE TABLE ${table}(id uuid PRIMARY KEY)`);});
after(async()=>{try{await pool.query(`DROP TABLE IF EXISTS ${table}`);}finally{await pool.end();await competitor.end();}});
function delayedAcquisition({acquired,proceed,fail=false}){
 return {connect:async()=>{const client=await pool.connect();return {
  release:e=>client.release(e),
  query:async(sql,values)=>{const result=await client.query(sql,values);if(sql.includes('pg_try_advisory_lock')){acquired.resolve();await proceed.promise;if(fail)throw new Error('injected lost lock response');}return result;}
 };}};
}
async function assertAvailable(){const release=await acquireImportAdmission(competitor);await release();}

test('real PostgreSQL lock acquired before a disconnect is released after the delayed response',async()=>{
 const acquired=gate(),proceed=gate(),{req,res}=request();let entered=false;
 const pending=withImportAdmission(delayedAcquisition({acquired,proceed}),req,res,async()=>{entered=true;});
 await acquired.promise;res.destroyed=true;res.emit('close');proceed.resolve();
 await assert.rejects(pending,{status:499});assert.equal(entered,false);await assertAvailable();
});
test('real PostgreSQL admission stays owned through an INSERT settling after response close',async()=>{
 const started=gate(),proceed=gate(),{req,res}=request(),id=randomUUID();
 const pending=withImportAdmission(pool,req,res,async()=>{started.resolve();await proceed.promise;await pool.query(`INSERT INTO ${table}(id) VALUES($1)`,[id]);});
 await started.promise;res.destroyed=true;res.emit('close');
 try{await assert.rejects(()=>acquireImportAdmission(competitor),{status:429});}finally{proceed.resolve();}
 await pending;assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE id=$1`,[id])).rows[0].n,1);await assertAvailable();
});
test('real PostgreSQL abort during capacity work cannot create a new durable reservation',async()=>{
 const started=gate(),proceed=gate(),{req,res}=request(),id=randomUUID();
 const pending=withImportAdmission(pool,req,res,async assertActive=>{started.resolve();await proceed.promise;assertActive();await pool.query(`INSERT INTO ${table}(id) VALUES($1)`,[id]);});
 await started.promise;req.aborted=true;res.destroyed=true;proceed.resolve();await assert.rejects(pending,{status:499});
 assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE id=$1`,[id])).rows[0].n,0);await assertAvailable();
});
test('ambiguous real PostgreSQL acquisition closes the lock-owning session',async()=>{
 const acquired=gate(),proceed=gate(),pending=acquireImportAdmission(delayedAcquisition({acquired,proceed,fail:true}));
 await acquired.promise;proceed.resolve();await assert.rejects(pending,/injected lost lock response/);
 // release(error) destroys the socket; wait for the server to observe close.
 let release;
 for(let n=0;n<40;n++){try{release=await acquireImportAdmission(competitor);break;}catch(e){if(e.status!==429)throw e;await new Promise(r=>setTimeout(r,25));}}
 assert.ok(release,'Destroyed owner session must release its lock');await release();
});
