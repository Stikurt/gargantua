import fs from 'node:fs/promises';
import path from 'node:path';
import {durableWrite, syncDirectory, withPinnedDirectory} from './publication-files.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_JOB_BYTES=4096;
const invalid=message=>Object.assign(new Error(message),{code:'PARSER_JOB_INVALID'});
function token(value){if(typeof value!=='string'||!UUID.test(value))throw invalid('Некорректный токен задачи парсера');return value;}

function encodeSpec(spec){
 let json;
 try{json=JSON.stringify(spec);}catch{throw invalid('Некорректный JSON задачи парсера');}
 if(typeof json!=='string'||Buffer.byteLength(json,'utf8')>MAX_JOB_BYTES)throw invalid('Задача парсера превышает лимит 4096 байт');
 // Validate the exact serialized value, including any custom serialization,
 // rather than inspecting one value and writing a different one.
 const value=JSON.parse(json),keys=['id','inputId','inputScope','inputSha256','extension','filename'];
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))throw invalid('Некорректная структура задачи парсера');
 token(value.id);
 if(value.inputId!==value.id||value.inputScope!=='attempts'||typeof value.inputSha256!=='string'||!/^[a-f0-9]{64}$/.test(value.inputSha256)||!['epub','fb2','txt','ranobe'].includes(value.extension)||typeof value.filename!=='string'||!value.filename.length||value.filename.length>300||/[\x00-\x1f\x7f]/.test(value.filename))throw invalid('Некорректная привязка или параметры задачи парсера');
 return {id:value.id,bytes:Buffer.from(json,'utf8')};
}

export async function writeParserJob(jobs,spec){
 const {id,bytes}=encodeSpec(spec);
 return withPinnedDirectory(path.join(jobs,'pending'),async directory=>{
  const temporary=path.join(directory,id+'.tmp'),destination=path.join(directory,id+'.json');
  // Attempt tokens are never reused. Preserve an existing job instead of
  // silently changing its immutable input while a parser might be reading it.
  try{await fs.lstat(destination);throw invalid('Задача с этим токеном уже существует');}
  catch(e){if(e.code!=='ENOENT')throw e;}
  // wx refuses an existing leaf, including a symlink. rename changes the
  // directory entry and never follows a destination symlink.
  await durableWrite(temporary,bytes);
  await fs.rename(temporary,destination);
  await syncDirectory(directory);
  return {attemptToken:id,bytes:bytes.length};
 });
}

export async function cleanupParserJob(jobs,attemptToken){
 const id=token(attemptToken),nonce=new RegExp('^'+id+'\\.[a-f0-9]{32}\\.tmp$');
 let removed=0,firstError;
 for(const subdirectory of ['pending','results']){
  try{
   await withPinnedDirectory(path.join(jobs,subdirectory),async directory=>{
    let changed=false,visited=0;
    // Streaming enumeration does not load unknown entries into an array.
    const entries=await fs.opendir(directory);
    for await(const entry of entries){
     if(++visited>10000)throw Object.assign(new Error('Слишком много объектов для одной очистки задач'),{code:'CLEANUP_SCAN_LIMIT'});
     const name=entry.name;
     if(name!==id+'.json'&&name!==id+'.tmp'&&!nonce.test(name))continue;
     try{
      // unlink never traverses a leaf symlink; matching directories are not
      // recursively removed. Unrecognized names are left untouched.
      await fs.unlink(path.join(directory,name));removed++;changed=true;
     }catch(e){if(e.code!=='ENOENT')firstError??=e;}
    }
    if(changed)await syncDirectory(directory);
   });
  }catch(e){if(e.code!=='ENOENT')firstError??=e;}
 }
 if(firstError)throw firstError;
 return {removed};
}
