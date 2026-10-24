import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {validateStructure} from './publication-model.mjs';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const PNG=Buffer.from([137,80,78,71,13,10,26,10]);
const MAX_JSON=32*1024*1024,MAX_ASSETS=20*1024*1024;
export const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const failure=message=>Object.assign(new Error(message),{code:'PUBLICATION_INTEGRITY',status:423});
const id=value=>{if(!UUID.test(value||''))throw failure('Некорректный идентификатор публикации');return value;};
const asset=name=>/^image-\d{1,3}\.png$/.test(name);
export function textForScan(book){return Buffer.from([book.title,book.author,...book.chapters.flatMap(c=>[c.title,...c.blocks.map(b=>b.text)]),...(book.structure?.chapters||[]).flatMap(c=>[c.title,...c.blocks.flatMap(b=>[b.text,...(b.rows||[]).flat()])]),...(book.sourceMetadata?[book.sourceMetadata.title,...book.sourceMetadata.authors,...book.sourceMetadata.languages,...book.sourceMetadata.identifiers]:[])].join('\n'));}

export function validateSourceMetadata(meta){
 const keys=['schemaVersion','format','provenance','title','authors','languages','identifiers'];
 const str=(value,max)=>typeof value==='string'&&value.length<=max&&value.isWellFormed()&&!/[\p{Cc}\p{Cf}]/u.test(value);
 const list=(value,count,max)=>Array.isArray(value)&&value.length<=count&&value.every(item=>str(item,max));
 if(!meta||typeof meta!=='object'||Array.isArray(meta)||Object.keys(meta).length!==keys.length||Object.keys(meta).some(key=>!keys.includes(key))||meta.schemaVersion!==1||!['epub','txt'].includes(meta.format)||meta.provenance!==(meta.format==='epub'?'opf':'gutenberg-txt-header')||!str(meta.title,300)||!list(meta.authors,16,200)||!list(meta.languages,16,30)||!list(meta.identifiers,32,500))throw failure('Неверные метаданные источника');
 return meta;
}

// Inert provenance carried by server-generated packages. This metadata never
// grants a role, bypasses scan or assigns a trusted Expression by itself.
export function validateDerivation(value){
 const keys=['schemaVersion','kind','quality','sourceSha256','recipeSha256','jobId'];
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||Object.keys(value).some(key=>!keys.includes(key))||value.schemaVersion!==1||value.kind!=='machine-translation'||value.quality!=='machine-draft'||typeof value.jobId!=='string'||!UUID.test(value.jobId)||value.jobId!==value.jobId.toLowerCase()||!['sourceSha256','recipeSha256'].every(key=>typeof value[key]==='string'&&/^[a-f0-9]{64}$/.test(value[key])))throw failure('Неверные метаданные происхождения машинного перевода');
 return value;
}

export function validateBook(book){
 const exact=(obj,keys)=>obj&&typeof obj==='object'&&!Array.isArray(obj)&&Object.keys(obj).every(k=>keys.includes(k));
 const str=(s,max)=>typeof s==='string'&&s.length<=max&&s.isWellFormed();
 if(!exact(book,['title','author','language','chapters','assets','structure','sourceMetadata','derivation'])||!str(book.title,300)||!book.title||!str(book.author,300)||!str(book.language,30)||!Array.isArray(book.chapters)||!book.chapters.length||book.chapters.length>1000||!exact(book.assets,Object.keys(book.assets||{})))throw failure('Неверная структура подготовленной книги');
 if(Object.hasOwn(book,'sourceMetadata'))validateSourceMetadata(book.sourceMetadata);
 if(Object.hasOwn(book,'derivation'))validateDerivation(book.derivation);
 let blocks=0,total=0;const decoded=new Map();
 for(const [name,data] of Object.entries(book.assets)){
  if(!asset(name)||!str(data,16*1024*1024)||data.length%4!==0)throw failure('Неверная подготовленная иллюстрация');
  const bytes=Buffer.from(data,'base64');total+=bytes.length;
  if(bytes.toString('base64')!==data||!bytes.subarray(0,8).equals(PNG)||total>MAX_ASSETS||decoded.size>=200)throw failure('Неверный формат или объём иллюстраций');
  decoded.set(name,bytes);
 }
 for(const c of book.chapters){
  if(!exact(c,['title','blocks'])||!str(c.title,300)||!Array.isArray(c.blocks)||!c.blocks.length||c.blocks.length>30000)throw failure('Неверная глава');
  for(const b of c.blocks){
   if(++blocks>200000)throw failure('Слишком много блоков');
   if(b?.type==='image'){
    if(!exact(b,['type','asset','text'])||!str(b.text,500)||!decoded.has(b.asset))throw failure('Иллюстрация отсутствует в пакете');
   }else if(!exact(b,['type','text'])||!['text','heading'].includes(b.type)||!str(b.text,100000))throw failure('Неверный текстовый блок');
  }
 }
 if(book.structure){validateStructure(book.structure,book.chapters.length);for(const c of book.structure.chapters)for(const b of c.blocks)if(b.type==='image'&&!decoded.has(b.resource))throw failure('Ресурс структуры отсутствует');}
 return decoded;
}

export function canonicalManifest(manifest){
 if(manifest?.schemaVersion!==1||!Array.isArray(manifest.files)||!manifest.files.length||manifest.files.length>201)throw failure('Манифест публикации отсутствует или повреждён');
 const seen=new Set();let total=0;
 const files=manifest.files.map(f=>{
  if(!f||!(f.path==='book.json'||asset(f.path))||seen.has(f.path)||!Number.isSafeInteger(f.bytes)||f.bytes<1||f.bytes>(f.path==='book.json'?MAX_JSON:MAX_ASSETS)||!/^[a-f0-9]{64}$/.test(f.sha256))throw failure('Недопустимый ресурс манифеста');
  seen.add(f.path);total+=f.bytes;return {path:f.path,bytes:f.bytes,sha256:f.sha256};
 }).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 if(!seen.has('book.json')||total>MAX_JSON+MAX_ASSETS)throw failure('Неполный или чрезмерный пакет');
 return {schemaVersion:1,files};
}
export const packageDigest=manifest=>digest(Buffer.from(JSON.stringify(canonicalManifest(manifest))));

export async function syncDirectory(directory){
 let handle;
 try{handle=await fs.open(directory,constants.O_RDONLY);await handle.sync();}
 catch(e){if(process.platform!=='win32'||!['EPERM','EISDIR','EINVAL','ENOTSUP'].includes(e.code))throw e;}
 finally{await handle?.close();}
}
export async function durableWrite(filename,bytes){
 const handle=await fs.open(filename,'wx',0o600);
 try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
}
async function directoryOnly(directory){const stat=await fs.lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw failure('Недопустимый каталог публикации');}
export async function withPinnedDirectory(directory,fn){
 if(process.platform==='linux'){
  const parent=await fs.open(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{return await fn(`/proc/self/fd/${parent.fd}`);}finally{await parent.close();}
 }
 await directoryOnly(directory);return fn(directory);
}
export async function readBoundedFile(filename,limit){
 if(!Number.isSafeInteger(limit)||limit<1||limit>MAX_JSON)throw failure('Недопустимый лимит чтения');
 return withPinnedDirectory(path.dirname(filename),async parent=>{
 const pinned=path.join(parent,path.basename(filename)),entry=await fs.lstat(pinned);if(entry.isSymbolicLink()||!entry.isFile())throw failure('Недопустимый файл');
 const handle=await fs.open(pinned,constants.O_RDONLY|(constants.O_NOFOLLOW||0)|(constants.O_NONBLOCK||0));
 try{
  const before=await handle.stat();if(!before.isFile()||before.dev!==entry.dev||before.ino!==entry.ino||before.size>limit||before.size<1)throw failure('Неверный размер или тип ресурса');
  // Read at most the declared budget even if the file grows after fstat.
  const bytes=Buffer.alloc(before.size+1);let length=0;
  while(length<bytes.length){const r=await handle.read(bytes,length,bytes.length-length,null);if(!r.bytesRead)break;length+=r.bytesRead;}
  const after=await handle.stat();if(length!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw failure('Ресурс изменился во время чтения');
  return bytes.subarray(0,length);
 }finally{await handle.close();}
 });
}
export async function stagePublication(root,attemptId,bookId,book){
 id(attemptId);id(bookId);const assets=validateBook(book),json=Buffer.from(JSON.stringify(book));
 if(json.length>MAX_JSON)throw failure('Подготовленная книга превышает лимит');
 const staging=path.join(root,'.staging');await fs.mkdir(staging,{recursive:true,mode:0o700});await directoryOnly(staging);
 const stage=path.join(staging,attemptId);await fs.mkdir(stage,{mode:0o700});
 const files=[];
 for(const [name,bytes] of [['book.json',json],...assets]){
  await durableWrite(path.join(stage,name),bytes);files.push({path:name,bytes:bytes.length,sha256:digest(bytes)});
 }
 await syncDirectory(stage);await syncDirectory(staging);
 const manifest=canonicalManifest({schemaVersion:1,files});
 return {id:bookId,attemptId,manifest,contentSha256:digest(json),contentBytes:json.length,packageSha256:packageDigest(manifest)};
}
export async function placePublication(root,prepared){
 id(prepared.id);id(prepared.attemptId);const parent=path.join(root,'books');await fs.mkdir(parent,{recursive:true,mode:0o700});await directoryOnly(parent);
 const stage=path.join(root,'.staging',prepared.attemptId),destination=path.join(parent,prepared.id);await directoryOnly(stage);
 try{await fs.lstat(destination);throw failure('Каталог результата уже существует');}catch(e){if(e.code!=='ENOENT')throw e;}
 await fs.rename(stage,destination);await syncDirectory(parent);await syncDirectory(path.join(root,'.staging'));
 return prepared;
}
export async function readPublication(root,row){
 id(row.id);const manifest=canonicalManifest(row.artifact_manifest);
 if(packageDigest(manifest)!==row.package_sha256)throw failure('Хеш манифеста публикации не совпадает');
 const directory=path.join(root,'books',row.id);await directoryOnly(path.join(root,'books'));await directoryOnly(directory);
 const buffers=new Map();
 for(const f of manifest.files){
  const bytes=await readBoundedFile(path.join(directory,f.path),f.bytes);
  if(bytes.length!==f.bytes||digest(bytes)!==f.sha256)throw failure('Контрольная сумма ресурса не совпадает');
  buffers.set(f.path,bytes);
 }
 const raw=buffers.get('book.json');
 if(digest(raw)!==row.content_sha256||raw.length!==Number(row.content_bytes))throw failure('Контрольная сумма текста не совпадает');
 let content;try{content=JSON.parse(raw.toString('utf8'));}catch{throw failure('Подготовленный текст повреждён');}
 const assets=validateBook(content);
 if(content.chapters.length!==row.chapter_count||buffers.size!==assets.size+1)throw failure('Состав публикации не совпадает');
 for(const [name,bytes] of assets)if(!buffers.get(name)?.equals(bytes))throw failure('Текст и ресурс иллюстрации не совпадают');
 return {content,raw,buffers,manifest};
}

export async function inspectLegacyPublication(root,row){
 id(row.id);const directory=path.join(root,'books',row.id);await directoryOnly(path.join(root,'books'));await directoryOnly(directory);
 const raw=await readBoundedFile(path.join(directory,'book.json'),MAX_JSON);
 let content;try{content=JSON.parse(raw.toString('utf8'));}catch{throw failure('Существующий текст повреждён');}
 const assets=validateBook(content);
 if(content.title!==row.title||content.author!==row.author||content.language!==row.language||content.chapters.length!==row.chapter_count)throw failure('Существующая книга не соответствует записи БД');
 const buffers=new Map([['book.json',raw]]);
 for(const [name,expected] of assets){const bytes=await readBoundedFile(path.join(directory,name),MAX_ASSETS);if(!bytes.equals(expected))throw failure('Существующая иллюстрация не соответствует тексту');buffers.set(name,bytes);}
 const manifest=canonicalManifest({schemaVersion:1,files:[...buffers].map(([name,bytes])=>({path:name,bytes:bytes.length,sha256:digest(bytes)}))});
 return {content,raw,buffers,manifest,contentSha256:digest(raw),contentBytes:raw.length,packageSha256:packageDigest(manifest)};
}

// The caller must first prove DB ownership and absence of published references.
export async function removeAttemptFiles(root,attemptId,bookId,{removePlaced=false}={}){
 id(attemptId);id(bookId);
 for(const directory of [path.join(root,'.staging',attemptId),...(removePlaced?[path.join(root,'books',bookId)]:[])]){
  try{await directoryOnly(directory);await fs.rm(directory,{recursive:true});await syncDirectory(path.dirname(directory));}
  catch(e){if(e.code!=='ENOENT')throw e;}
 }
}
