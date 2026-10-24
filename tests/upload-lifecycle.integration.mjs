import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {applyMigrations} from '../server/migrations.mjs';
import {acquireImportAdmission} from '../server/import-admission.mjs';
import {expireIncompleteUploads,assertUploadRetryable} from '../server/upload-lifecycle.mjs';

const url=new URL(process.env.TEST_DATABASE_URL||'postgres://invalid/disabled');
if(process.env.GARGANTUA_TEST_ISOLATED!=='1'||!/^\/gargantua_test_[a-z_]+$/.test(url.pathname))throw new Error('Disposable isolated database required');
const pool=new pg.Pool({connectionString:url.href,max:4,connectionTimeoutMillis:5000,statement_timeout:10000});
const owner=randomUUID();let root;
before(async()=>{
 await applyMigrations(pool);root=await fs.mkdtemp(path.join(os.tmpdir(),'upload-lifecycle-'));await fs.mkdir(path.join(root,'incoming'));
 await pool.query("INSERT INTO profiles(id,login,password,role) VALUES($1,$2,'not-used','owner')",[owner,'upload_'+randomUUID()]);
});
after(async()=>{await pool.query('DELETE FROM imports WHERE requested_by=$1',[owner]);await pool.query('DELETE FROM profiles WHERE id=$1',[owner]);await pool.end();if(root){assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('upload-lifecycle-'));await fs.rm(root,{recursive:true,force:true});}});
async function incoming({old=true,filename=''}={}){
 const id=randomUUID();await pool.query("INSERT INTO imports(id,requested_by,kind,filename,status,created_at) VALUES($1,$2,'upload',$3,'uploading',now()-$4*interval '1 minute')",[id,owner,filename,old?16:1]);
 const file=path.join(root,'incoming',id);await fs.writeFile(file,'unfinished upload');return {id,file,kind:'upload',filename};
}

test('expiration skips busy admission and preserves a still-reserved input',async()=>{
 const row=await incoming(),release=await acquireImportAdmission(pool);
 try{assert.deepEqual(await expireIncompleteUploads(pool,root),{busy:true,expired:0,cleanupErrors:0});assert.equal((await pool.query('SELECT status FROM imports WHERE id=$1',[row.id])).rows[0].status,'uploading');await fs.access(row.file);}
 finally{await release();}
});

test('expiration holds admission until removal settles; incomplete input cannot be retried',async()=>{
 const row=await incoming(),entered=Promise.withResolvers(),continueRemoval=Promise.withResolvers(),original=fs.unlink;
 fs.unlink=async file=>{if(file===row.file){entered.resolve();await continueRemoval.promise;}return original(file);};
 const task=expireIncompleteUploads(pool,root);
 try{
  await Promise.race([entered.promise,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Removal did not start')),5000).unref())]);
  assert.equal((await pool.query('SELECT status FROM imports WHERE id=$1',[row.id])).rows[0].status,'error');
  await assert.rejects(()=>acquireImportAdmission(pool),e=>e.status===429);
  await assert.rejects(()=>assertUploadRetryable(row,root),e=>e.status===400);
 }finally{continueRemoval.resolve();fs.unlink=original;await task;}
 await assert.rejects(()=>fs.lstat(row.file),{code:'ENOENT'});
 const release=await acquireImportAdmission(pool);await release();
});

test('fresh upload stays reserved; retry requires complete bounded regular source',async()=>{
 const fresh=await incoming({old:false,filename:'source.txt'});await expireIncompleteUploads(pool,root);
 assert.equal((await pool.query('SELECT status FROM imports WHERE id=$1',[fresh.id])).rows[0].status,'uploading');
 await assertUploadRetryable(fresh,root);
 await fs.unlink(fresh.file);await assert.rejects(()=>assertUploadRetryable(fresh,root),e=>e.status===400);
 await fs.symlink('/etc/passwd',fresh.file);await assert.rejects(()=>assertUploadRetryable(fresh,root),e=>e.status===400);
 await assertUploadRetryable({kind:'file'},root);
});
