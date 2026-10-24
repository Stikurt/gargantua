import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonicalJson,sha256} from './publication-model.mjs';
import {readBoundedFile,durableWrite,syncDirectory} from './publication-files.mjs';
import {derivedId,immutableBytes} from './derived-files.mjs';

const safe=async p=>{const s=await fs.lstat(p);if(!s.isDirectory()||s.isSymbolicLink())throw Object.assign(new Error('Неверный каталог исполнителя'),{code:'DERIVED_SPOOL'});};
async function jsonFile(p,max=65536){return JSON.parse((await readBoundedFile(p,max)).toString('utf8'));}
export async function replacePrivateJson(filename,value){
 const temporary=path.join(path.dirname(filename),`.update-${randomUUID()}.tmp`);await safe(path.dirname(filename));
 await durableWrite(temporary,Buffer.from(canonicalJson(value)));
 try{
  for(let attempt=0;;attempt++)try{await fs.rename(temporary,filename);break;}catch(error){
   // A Windows reader of a bind-mounted permit can briefly deny replacement.
   // Retry the same fully fsynced bytes; never remove the previous valid permit.
   if(!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt>=19)throw error;
   await new Promise(resolve=>setTimeout(resolve,25));
  }
  await syncDirectory(path.dirname(filename));
 }finally{await fs.unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
export async function executorState(runtime){try{return await jsonFile(path.join(runtime,'daemon.json'),8192);}catch{return null;}}
export function executorIsIdle(state,now=Date.now()){
 const age=now-state?.updatedAt;
 return state?.schemaVersion===1&&state.state==='idle'&&state.cleanupVerified===true&&typeof state.updatedAt==='number'&&Number.isFinite(age)&&age>=-5000&&age<45000;
}
/** No imports/parser may compete with an unresolved model after a worker crash. */
export async function inferenceBarrier(spool,runtime){
 const state=await executorState(runtime);
 if(state&&(state.cleanupVerified!==true||state.state==='running'||state.state==='blocked_cleanup'))return false;
 let incoming=[];try{await safe(path.join(spool,'incoming'));incoming=await fs.readdir(path.join(spool,'incoming'));}catch(e){if(e.code!=='ENOENT')return false;}
 for(const attempt of incoming){if(!/^[a-f0-9-]{36}$/.test(attempt))continue;
  try{const r=await jsonFile(path.join(spool,'output',attempt,'result.json'));if(r.cleanupVerified===true)continue;return false;}catch(e){if(e.code!=='ENOENT')return false;}
  try{const permit=await jsonFile(path.join(spool,'incoming',attempt,'permit.json'),2048);if(typeof permit.expiresAt!=='number'||permit.expiresAt>Date.now())return false;}catch{return false;}
 }
 // A fresh host idle receipt follows its startup reap / verified cleanup.
 // Once pending permits are excluded, historical per-segment logs need not
 // be reread on every tick of a long-lived library.
 if(executorIsIdle(state))return true;
 let attempts=[];try{await safe(path.join(runtime,'attempts'));attempts=await fs.readdir(path.join(runtime,'attempts'));}catch(e){if(e.code!=='ENOENT')return false;}
 for(const attempt of attempts){if(!/^[a-f0-9-]{36}$/.test(attempt))continue;try{const r=await jsonFile(path.join(spool,'retired',attempt+'.json'));if(r.attemptId===attempt&&r.cleanupVerified===true)continue;}catch{}
  try{const r=await jsonFile(path.join(spool,'output',attempt,'result.json'));if(r.attemptId!==attempt||r.cleanupVerified!==true)return false;}catch{return false;}}
 return true;
}
export async function retireInferenceInput(spool,request,receipt){
 if(receipt.attemptId!==request.attemptId||receipt.cleanupVerified!==true)throw Object.assign(new Error('Остановка модели не подтверждена'),{code:'DERIVED_EXECUTOR_UNSAFE'});
 derivedId(request.attemptId);const retired=path.join(spool,'retired');await fs.mkdir(retired,{recursive:true,mode:0o700});await safe(retired);
 await immutableBytes(path.join(retired,request.attemptId+'.json'),Buffer.from(canonicalJson(receipt)));
 for(const parent of ['incoming','output']){await safe(path.join(spool,parent));const target=path.join(spool,parent,request.attemptId);await safe(target);await fs.rm(target,{recursive:true});await syncDirectory(path.join(spool,parent));}
}
export async function createInferenceInput(spool,request){
 derivedId(request.attemptId);derivedId(request.jobId);derivedId(request.segmentId);
 await safe(spool);
 for(const name of ['incoming','output']){await fs.mkdir(path.join(spool,name),{recursive:true,mode:0o700});await safe(path.join(spool,name));}
 const directory=path.join(spool,'incoming',request.attemptId);await fs.mkdir(directory,{mode:0o700});await safe(directory);
 const bytes=Buffer.from(canonicalJson(request));if(bytes.length>32768)throw Object.assign(new Error('Слишком большой вход модели'),{code:'DERIVED_INPUT_LIMIT'});
 await immutableBytes(path.join(directory,'input.json'),bytes);
 return {requestSha256:sha256(bytes),directory,permit:async(expiresAt=Date.now()+20000)=>replacePrivateJson(path.join(directory,'permit.json'),{schemaVersion:1,jobId:request.jobId,attemptId:request.attemptId,segmentId:request.segmentId,expiresAt}),
  result:()=>jsonFile(path.join(spool,'output',request.attemptId,'result.json')),
  artifact:async(result)=>{const expected=request.kind==='translation'?'text.txt':'audio.wav',a=result.artifact;
   if(!a||a.filename!==expected||!Number.isSafeInteger(a.bytes)||a.bytes<1||a.bytes>(request.kind==='translation'?25600:8*1024*1024)||a.mime!==(request.kind==='translation'?'text/plain; charset=utf-8':'audio/wav'))throw Object.assign(new Error('Неверный файл исполнителя'),{code:'DERIVED_OUTPUT'});
   const buffer=await readBoundedFile(path.join(spool,'output',request.attemptId,expected),a.bytes);if(buffer.length!==a.bytes||sha256(buffer)!==a.sha256)throw Object.assign(new Error('Выход модели изменён'),{code:'DERIVED_OUTPUT'});return buffer;}
 };
}
export function verifyInferenceReceipt(result,request,requestSha256,providerRecipeSha256){
 for(const key of ['jobId','attemptId','segmentId','kind','profile','profileSha256','recipeSha256','inputSha256'])if(result?.[key]!==request[key])throw Object.assign(new Error('Ответ относится к другой попытке'),{code:'DERIVED_OUTPUT'});
 if(result.schemaVersion!==1||result.requestSha256!==requestSha256||result.providerRecipeSha256!==providerRecipeSha256||result.cleanupVerified!==true||!Array.isArray(result.cleanup)||result.status==='completed'&&!result.cleanup.length||result.cleanup.some(r=>r.verifiedStopped!==true)||!['completed','paused','failed'].includes(result.status))throw Object.assign(new Error('Исполнитель не подтвердил безопасное завершение'),{code:'DERIVED_EXECUTOR_UNSAFE'});
 return result;
}
