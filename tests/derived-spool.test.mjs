import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {replacePrivateJson} from '../server/derived-spool.mjs';
test('permit sharing violations retry the same bytes without deleting the previous valid file',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gargantua-permit-')),file=path.join(root,'permit.json');
 try{
  await fs.writeFile(file,'{"old":true}');const rename=fs.rename.bind(fs);let calls=0;
  const mocked=t.mock.method(fs,'rename',async(...args)=>{calls++;if(calls<3){assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),{old:true});throw Object.assign(Error('fixture sharing conflict'),{code:'EPERM'});}return rename(...args);});
  await replacePrivateJson(file,{fresh:true});mocked.mock.restore();assert.equal(calls,3);assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),{fresh:true});assert.deepEqual(await fs.readdir(root),['permit.json']);
 }finally{assert.ok(path.basename(root).startsWith('gargantua-permit-'));await fs.rm(root,{recursive:true,force:true});}
});
test('a persistent replacement failure preserves the old permit and cleans its own temporary file',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gargantua-permit-')),file=path.join(root,'permit.json');
 try{await fs.writeFile(file,'{"old":true}');const mocked=t.mock.method(fs,'rename',async()=>{throw Object.assign(Error('fixture permission conflict'),{code:'EACCES'});});await assert.rejects(()=>replacePrivateJson(file,{fresh:true}),{code:'EACCES'});mocked.mock.restore();assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),{old:true});assert.deepEqual(await fs.readdir(root),['permit.json']);}
 finally{assert.ok(path.basename(root).startsWith('gargantua-permit-'));await fs.rm(root,{recursive:true,force:true});}
});
