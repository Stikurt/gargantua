import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonicalJson,sha256} from './publication-model.mjs';
import {readBoundedFile,durableWrite,syncDirectory} from './publication-files.mjs';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/;
export const DERIVED_FILE_LIMIT=12*1024*1024;
const bad=message=>Object.assign(new Error(message),{code:'DERIVED_INTEGRITY',status:423,blocked:true});
export function derivedId(value){if(typeof value!=='string'||!UUID.test(value))throw bad('Неверный идентификатор производной');return value;}
export function derivedUuid(value){const h=sha256(Buffer.from(value));return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;}
async function directory(value){const st=await fs.lstat(value);if(!st.isDirectory()||st.isSymbolicLink())throw bad('Недопустимый каталог производной');}
export async function ensureDerivedRoot(library){const root=path.join(library,'derived');await fs.mkdir(root,{recursive:true,mode:0o700});await directory(root);return root;}
export async function derivedJobRoot(library,jobId){derivedId(jobId);const root=await ensureDerivedRoot(library),job=path.join(root,jobId);await fs.mkdir(job,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});await directory(job);return job;}
export async function immutableBytes(filename,bytes){
 const parent=path.dirname(filename),temporary=path.join(parent,`.write-${randomUUID()}.tmp`);
 await directory(parent);await durableWrite(temporary,bytes);
 try{
  try{await fs.link(temporary,filename);await syncDirectory(parent);}
  catch(e){if(e.code!=='EEXIST')throw e;const existing=await readBoundedFile(filename,Math.max(bytes.length,1));if(!existing.equals(bytes))throw bad('Неизменяемый файл уже содержит другую версию');}
 }finally{await fs.unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});await syncDirectory(parent);}
}
export function validateDerivedText(bytes){
 if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>32768)throw bad('Неверный размер переведённого фрагмента');
 let value;try{value=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw bad('Перевод не является UTF-8');}
 if(!value.trim()||!value.isWellFormed()||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value))throw bad('Пустой или повреждённый перевод');
 return value;
}
export function validateDerivedWav(bytes){
 if(!Buffer.isBuffer(bytes)||bytes.length<46||bytes.length>DERIVED_FILE_LIMIT||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE'||bytes.readUInt32LE(4)+8!==bytes.length)throw bad('Неверный WAV');
 let offset=12,format=null,data=null;
 while(offset+8<=bytes.length){
  const name=bytes.toString('ascii',offset,offset+4),length=bytes.readUInt32LE(offset+4),start=offset+8,end=start+length;
  if(end>bytes.length)throw bad('Оборванный WAV');
  if(name==='fmt '){if(format||length!==16)throw bad('Неподдерживаемый PCM');format={code:bytes.readUInt16LE(start),channels:bytes.readUInt16LE(start+2),sampleRate:bytes.readUInt32LE(start+4),byteRate:bytes.readUInt32LE(start+8),align:bytes.readUInt16LE(start+12),bits:bytes.readUInt16LE(start+14)};}
  else if(name==='data'){if(data)throw bad('Повторный PCM');data=bytes.subarray(start,end);}
  else throw bad('Посторонний WAV chunk');
  offset=end+(length%2);
 }
 if(offset!==bytes.length||!format||!data?.length||format.code!==1||format.channels!==1||format.sampleRate!==22050||format.bits!==16||format.align!==2||format.byteRate!==44100||data.length%2)throw bad('Неподдерживаемый формат аудио');
 const frames=data.length/2,durationSeconds=frames/format.sampleRate;
 if(durationSeconds<0.1||durationSeconds>180)throw bad('Аудиофрагмент вне допустимой длительности');
 let nonzero=0,clipped=0;for(let i=0;i<data.length;i+=2){const v=data.readInt16LE(i);if(v)nonzero++;if(Math.abs(v)>=32760)clipped++;}
 if(!nonzero||clipped/frames>0.02)throw bad('Тишина или аномальное ограничение аудио');
 return {frames,sampleRate:22050,channels:1,sampleWidth:2,durationSeconds};
}
export function validateSegmentManifest(value,jobId){
 if(!value||value.schemaVersion!==1||value.jobId!==derivedId(jobId)||!['translation','audio'].includes(value.kind)||!Number.isSafeInteger(value.ordinal)||value.ordinal<0||value.ordinal>49999)throw bad('Неверная запись сегмента');
 derivedId(value.attemptId);
 for(const key of ['inputSha256','recipeSha256','profileSha256'])if(!HASH.test(value[key]||''))throw bad('Не закреплён рецепт сегмента');
 const extension=value.kind==='translation'?'txt':'wav',expected=`${value.attemptId}/${String(value.ordinal).padStart(6,'0')}.${extension}`,f=value.file;
 if(!f||f.path!==expected||!HASH.test(f.sha256||'')||!Number.isSafeInteger(f.bytes)||f.bytes<1||f.bytes>(value.kind==='translation'?32768:DERIVED_FILE_LIMIT)||f.mediaType!==(value.kind==='translation'?'text/plain; charset=utf-8':'audio/wav'))throw bad('Недопустимый файл сегмента');
 if(!value.scan||value.scan.sha256!==f.sha256||typeof value.scan.version!=='string'||!value.scan.version.trim()||Buffer.byteLength(value.scan.version)>512||typeof value.scan.checkedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.scan.checkedAt)||!Number.isFinite(Date.parse(value.scan.checkedAt)))throw bad('Сегмент не привязан к проверке угроз');
 if(value.quality!==(value.kind==='translation'?'machine-draft':'technical-unlistened'))throw bad('Неверная отметка качества');
 return value;
}
export async function storeDerivedSegment(library,claim,ordinal,bytes,{inputSha256,profileSha256,scanVersion,pcm}={}){
 const job=await derivedJobRoot(library,claim.id),attempt=path.join(job,derivedId(claim.attempt_token));
 await fs.mkdir(attempt,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});await directory(attempt);
 const extension=claim.kind==='translation'?'txt':'wav';
 if(claim.kind==='translation')validateDerivedText(bytes);else pcm=validateDerivedWav(bytes);
 const manifest={schemaVersion:1,jobId:claim.id,attemptId:claim.attempt_token,ordinal,kind:claim.kind,inputSha256,recipeSha256:claim.recipe_sha256,profileSha256,
  file:{path:`${claim.attempt_token}/${String(ordinal).padStart(6,'0')}.${extension}`,sha256:sha256(bytes),bytes:bytes.length,mediaType:claim.kind==='translation'?'text/plain; charset=utf-8':'audio/wav'},
  ...(pcm?{pcm}:{}),scan:{version:scanVersion,checkedAt:new Date().toISOString(),sha256:sha256(bytes)},quality:claim.kind==='translation'?'machine-draft':'technical-unlistened'};
 validateSegmentManifest(manifest,claim.id);await immutableBytes(path.join(job,...manifest.file.path.split('/')),bytes);return manifest;
}
export async function readDerivedSegment(library,jobId,manifest){
 validateSegmentManifest(manifest,jobId);const root=path.join(library,'derived');await directory(root);const job=path.join(root,jobId);await directory(job);await directory(path.join(job,manifest.attemptId));
 const bytes=await readBoundedFile(path.join(job,...manifest.file.path.split('/')),manifest.file.bytes);
 if(bytes.length!==manifest.file.bytes||sha256(bytes)!==manifest.file.sha256)throw bad('Фрагмент повреждён');
 if(manifest.kind==='translation')validateDerivedText(bytes);else if(canonicalJson(validateDerivedWav(bytes))!==canonicalJson(manifest.pcm))throw bad('Аудио не соответствует записи кадров');
 return bytes;
}
export function validateDerivedManifest(manifest,jobId){
 if(!manifest||manifest.jobId!==derivedId(jobId)||manifest.schemaVersion!==1||!['translation','audio'].includes(manifest.kind)||!HASH.test(manifest.sourceSha256||'')||!HASH.test(manifest.recipeSha256||'')||manifest.quality!==(manifest.kind==='translation'?'machine-draft':'technical-unlistened')||!Array.isArray(manifest.segments)||!manifest.segments.length||manifest.segments.length>50000)throw bad('Неверный итоговый манифест');
 if(manifest.kind==='translation'&&(!Array.isArray(manifest.publicationIds)||!manifest.publicationIds.length||manifest.publicationIds.length>50000||new Set(manifest.publicationIds).size!==manifest.publicationIds.length))throw bad('Нет отдельных публикаций перевода');
 if(manifest.publicationIds)for(const id of manifest.publicationIds)derivedId(id);
 if(manifest.kind==='audio'&&manifest.publicationIds!==undefined)throw bad('Неверные публикации аудио');
 for(const [i,s] of manifest.segments.entries()){validateSegmentManifest(s,jobId);if(s.ordinal!==i||s.kind!==manifest.kind||s.recipeSha256!==manifest.recipeSha256)throw bad('Нарушен порядок сегментов');}
 return manifest;
}
export async function writeDerivedManifest(library,jobId,manifest){
 validateDerivedManifest(manifest,jobId);
 const bytes=Buffer.from(canonicalJson(manifest));if(bytes.length>16*1024*1024)throw bad('Манифест слишком велик');
 await immutableBytes(path.join(await derivedJobRoot(library,jobId),'manifest.json'),bytes);return {manifest,sha256:sha256(bytes),bytes:bytes.length};
}
export async function readDerivedManifest(library,result){
 derivedId(result.job_id);const job=path.join(library,'derived',result.job_id);await directory(path.join(library,'derived'));await directory(job);
 const bytes=await readBoundedFile(path.join(job,'manifest.json'),16*1024*1024);
 if(bytes.length!==Number(result.bytes)||sha256(bytes)!==result.sha256)throw bad('Манифест производной повреждён');
 let manifest;try{manifest=JSON.parse(bytes.toString('utf8'));}catch{throw bad('Манифест не читается');}
 if(canonicalJson(manifest)!==canonicalJson(result.manifest)||manifest.jobId!==result.job_id)throw bad('Манифест не соответствует БД');
 validateDerivedManifest(manifest,result.job_id);
 return {manifest,bytes};
}
