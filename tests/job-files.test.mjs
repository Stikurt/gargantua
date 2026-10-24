import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {writeParserJob,cleanupParserJob} from '../server/job-files.mjs';

const TOKEN='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222';
const spec=()=>({id:TOKEN,inputId:TOKEN,inputScope:'attempts',inputSha256:'a'.repeat(64),extension:'txt',filename:'Проверка.txt'});
async function temporary(fn){
 const parent=path.resolve(process.env.GARGANTUA_JOB_FILES_TEST_TMP||os.tmpdir());await fs.mkdir(parent,{recursive:true});
 const root=await fs.mkdtemp(path.join(parent,'gargantua-job-files-'));
 try{
  await fs.mkdir(path.join(root,'pending'));await fs.mkdir(path.join(root,'results'));
  return await fn(root);
 }finally{
  assert.ok(path.resolve(root).startsWith(parent+path.sep)&&path.basename(root).startsWith('gargantua-job-files-'));
  await fs.rm(root,{recursive:true,force:true});
 }
}
async function symlink(t,target,link,type){
 try{await fs.symlink(target,link,type);return true;}
 catch(e){if(process.platform==='win32'&&['EPERM','EACCES'].includes(e.code)){t.skip('Symlinks unavailable on this Windows test host');return false;}throw e;}
}

test('writeParserJob publishes the exact bounded attempt spec and leaves no temporary file',()=>temporary(async jobs=>{
 const value=spec(),result=await writeParserJob(jobs,value),raw=await fs.readFile(path.join(jobs,'pending',TOKEN+'.json'));
 assert.deepEqual(JSON.parse(raw),value);assert.equal(result.attemptToken,TOKEN);assert.equal(result.bytes,raw.length);assert.ok(raw.length<=4096);
 assert.deepEqual(await fs.readdir(path.join(jobs,'pending')),[TOKEN+'.json']);
 if(process.platform!=='win32')assert.equal((await fs.stat(path.join(jobs,'pending',TOKEN+'.json'))).mode&0o777,0o600);
}));
test('invalid UUID, oversized JSON and mismatched scope are rejected before writing any files',()=>temporary(async jobs=>{
 const cases=[{...spec(),id:'../../outside'},{...spec(),id:'-'.repeat(36)},
  {...spec(),inputId:OTHER},{...spec(),inputScope:'incoming'},{...spec(),inputSha256:'bad'},
  {...spec(),filename:'x'.repeat(4096)},{...spec(),extension:'exe'},{...spec(),storageRoot:'/elsewhere'}];
 for(const value of cases)await assert.rejects(()=>writeParserJob(jobs,value),{code:'PARSER_JOB_INVALID'});
 await assert.rejects(()=>cleanupParserJob(jobs,'../'+TOKEN),{code:'PARSER_JOB_INVALID'});
 assert.deepEqual(await fs.readdir(path.join(jobs,'pending')),[]);assert.deepEqual(await fs.readdir(path.join(jobs,'results')),[]);
}));
test('an existing job or staging file is preserved rather than overwritten',()=>temporary(async jobs=>{
 const destination=path.join(jobs,'pending',TOKEN+'.json'),temporary=path.join(jobs,'pending',TOKEN+'.tmp');
 await fs.writeFile(destination,'existing job');await assert.rejects(()=>writeParserJob(jobs,spec()),{code:'PARSER_JOB_INVALID'});
 assert.equal(await fs.readFile(destination,'utf8'),'existing job');
 await fs.unlink(destination);await fs.writeFile(temporary,'earlier staging file');
 await assert.rejects(()=>writeParserJob(jobs,spec()),{code:'EEXIST'});assert.equal(await fs.readFile(temporary,'utf8'),'earlier staging file');
}));
test('cleanup removes only exact owned job and nonce temporary names in both directories',()=>temporary(async jobs=>{
 const owned=[TOKEN+'.json',TOKEN+'.tmp',TOKEN+'.'+'a'.repeat(32)+'.tmp'];
 const unknown=[OTHER+'.json',OTHER+'.'+'b'.repeat(32)+'.tmp',TOKEN+'.json.bak',TOKEN+'.'+'a'.repeat(31)+'.tmp',TOKEN+'.'+'C'.repeat(32)+'.tmp','unrelated.tmp'];
 for(const sub of ['pending','results'])for(const name of [...owned,...unknown])await fs.writeFile(path.join(jobs,sub,name),name);
 assert.equal((await cleanupParserJob(jobs,TOKEN)).removed,6);
 for(const sub of ['pending','results']){
  assert.deepEqual((await fs.readdir(path.join(jobs,sub))).sort(),[...unknown].sort());
  for(const name of unknown)assert.equal(await fs.readFile(path.join(jobs,sub,name),'utf8'),name);
 }
 assert.equal((await cleanupParserJob(jobs,TOKEN)).removed,0);
}));
test('cleanup never recursively deletes a matching directory',()=>temporary(async jobs=>{
 const directory=path.join(jobs,'pending',TOKEN+'.tmp');await fs.mkdir(directory);await fs.writeFile(path.join(directory,'keep.txt'),'preserve');
 await fs.writeFile(path.join(jobs,'results',TOKEN+'.json'),'owned result');
 await assert.rejects(()=>cleanupParserJob(jobs,TOKEN));
 assert.equal(await fs.readFile(path.join(directory,'keep.txt'),'utf8'),'preserve');
 assert.deepEqual(await fs.readdir(path.join(jobs,'results')),[]);
}));
test('write refuses a symlink staging leaf without opening its target',t=>temporary(async jobs=>{
 const outside=path.join(jobs,'outside.txt');await fs.writeFile(outside,'do not change');
 if(!await symlink(t,outside,path.join(jobs,'pending',TOKEN+'.tmp'),'file'))return;
 await assert.rejects(()=>writeParserJob(jobs,spec()),{code:'EEXIST'});
 assert.equal(await fs.readFile(outside,'utf8'),'do not change');
}));
test('cleanup unlinks owned leaf symlinks while preserving their targets',t=>temporary(async jobs=>{
 const outside=path.join(jobs,'outside.txt');await fs.writeFile(outside,'do not change');
 if(!await symlink(t,outside,path.join(jobs,'results',TOKEN+'.json'),'file'))return;
 assert.equal((await cleanupParserJob(jobs,TOKEN)).removed,1);
 assert.equal(await fs.readFile(outside,'utf8'),'do not change');
}));
test('symlink pending/results parents cannot redirect writing or cleanup outside the job scope',t=>temporary(async jobs=>{
 const outside=path.join(jobs,'outside-directory');await fs.mkdir(outside);await fs.writeFile(path.join(outside,TOKEN+'.json'),'preserve');
 await fs.rmdir(path.join(jobs,'pending'));
 if(!await symlink(t,outside,path.join(jobs,'pending'),'dir'))return;
 await assert.rejects(()=>writeParserJob(jobs,spec()));await assert.rejects(()=>cleanupParserJob(jobs,TOKEN));
 assert.equal(await fs.readFile(path.join(outside,TOKEN+'.json'),'utf8'),'preserve');
 await fs.unlink(path.join(jobs,'pending'));await fs.mkdir(path.join(jobs,'pending'));
 await fs.rmdir(path.join(jobs,'results'));await fs.symlink(outside,path.join(jobs,'results'),'dir');
 await assert.rejects(()=>cleanupParserJob(jobs,TOKEN));
 assert.equal(await fs.readFile(path.join(outside,TOKEN+'.json'),'utf8'),'preserve');
}));
