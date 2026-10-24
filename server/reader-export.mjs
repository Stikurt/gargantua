import {createHash, timingSafeEqual} from 'node:crypto';
import {TextDecoder} from 'node:util';
import {canonicalReaderJson, validateReaderEntity} from './reader-data-model.mjs';

export const READER_EXPORT_FORMAT='gargantua-reader-data';
export const READER_EXPORT_VERSION=1;
export const MAX_READER_EXPORT_BYTES=8*1024*1024;
export const MAX_READER_EXPORT_ENTITIES=25000;
const HASH=/^[a-f0-9]{64}$/;
const RECORD_KEYS=['entityType','entityId','revision','deleted','payload','updatedAt'];
const FORBIDDEN_KEYS=new Set(['__proto__','prototype','constructor']);
const failure=message=>Object.assign(new Error(message),{status:400,code:'READER_EXPORT_INVALID'});
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>record(value)&&Object.keys(value).every(key=>keys.includes(key));
const digest=value=>createHash('sha256').update(canonicalReaderJson(value),'utf8').digest('hex');

function timestamp(value){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)throw failure('Некорректная дата файла данных читателя');
 return value;
}

function entities(value,{project=false}={}){
 if(!Array.isArray(value)||value.length>MAX_READER_EXPORT_ENTITIES)throw failure('Слишком много записей в файле данных читателя');
 const seen=new Set();
 return value.map(source=>{
  if(!record(source)||!project&&(!exact(source,RECORD_KEYS)||!RECORD_KEYS.slice(0,5).every(key=>Object.hasOwn(source,key))||source.deleted===true&&source.payload!==null))throw failure('В файле есть неизвестные или недостающие поля записи читателя');
  // Projection is deliberate: a store row may also have profile/device fields,
  // but a portable file must never contain those fields or an old deleted note.
  const row={entityType:source.entityType,entityId:source.entityId,revision:source.revision,deleted:source.deleted,payload:source.deleted===true?null:source.payload};
  if(source.updatedAt!==undefined)row.updatedAt=timestamp(source.updatedAt);
  const checked=validateReaderEntity(row),key=`${checked.entityType}:${checked.entityId}`;
  if(seen.has(key))throw failure('Повторяющийся идентификатор записи в файле данных читателя');
  seen.add(key);
  return checked;
 });
}

function boundedBytes(value){
 let bytes;
 if(typeof value==='string'){
  // Check before allocating its UTF-8 representation. UTF-8 is never shorter
  // than a well-formed UTF-16 string measured in code units for this bound.
  if(value.length>MAX_READER_EXPORT_BYTES||!value.isWellFormed())throw failure('Файл данных читателя слишком большой или содержит неверный текст');
  bytes=Buffer.from(value,'utf8');
 }else if(value instanceof Uint8Array)bytes=value;
 else throw failure('Ожидается JSON-файл данных читателя');
 if(bytes.byteLength>MAX_READER_EXPORT_BYTES)throw failure('Файл данных читателя превышает 8 МБ');
 return bytes;
}

/** Metadata only: it neither opens books nor follows any URL or file path. */
export function createReaderExport(value,{createdAt=new Date().toISOString()}={}){
 const payload={entities:entities(value,{project:true}).sort((a,b)=>a.entityType.localeCompare(b.entityType,'en')||a.entityId.localeCompare(b.entityId,'en'))};
 const envelope={format:READER_EXPORT_FORMAT,version:READER_EXPORT_VERSION,createdAt:timestamp(createdAt),payload,sha256:digest(payload)};
 boundedBytes(canonicalReaderJson(envelope));
 return envelope;
}

export function serializeReaderExport(value,options){
 return Buffer.from(boundedBytes(canonicalReaderJson(createReaderExport(value,options))+'\n'));
}

/** Validate a portable file; returned revisions describe its source, not CAS
 * authority over the destination. The caller must preview and create explicit
 * mutations against the authenticated destination snapshot. */
export function parseReaderExport(value){
 const bytes=boundedBytes(value);let envelope;
 try{
  const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
  envelope=JSON.parse(text,(key,item)=>{if(FORBIDDEN_KEYS.has(key))throw failure('Недопустимый ключ в файле данных читателя');return item;});
 }catch{throw failure('Не удалось прочитать корректный UTF-8 JSON-файл данных читателя');}
 if(!exact(envelope,['format','version','createdAt','payload','sha256'])||envelope.format!==READER_EXPORT_FORMAT||envelope.version!==READER_EXPORT_VERSION||!exact(envelope.payload,['entities'])||typeof envelope.sha256!=='string'||!HASH.test(envelope.sha256))throw failure('Неподдерживаемый формат файла данных читателя');
 const createdAt=timestamp(envelope.createdAt);
 // Shape and string bounds are checked before canonicalization/hashing, so an
 // attacker cannot turn arbitrary nested JSON into an expensive hash request.
 const normalized=entities(envelope.payload.entities),actual=digest(envelope.payload);
 if(!timingSafeEqual(Buffer.from(actual,'hex'),Buffer.from(envelope.sha256,'hex')))throw failure('Контрольная сумма файла данных читателя не совпала');
 return {entities:normalized,sha256:actual,createdAt};
}
