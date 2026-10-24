import {canonicalJson} from './publication-model.mjs';
import {validateCatalogs} from '../src/catalogs.mjs';
import {createHash} from 'node:crypto';

export const CATALOG_ENTITY_ID='00000000-0000-4000-8000-000000000002';
export const canonicalReaderJson=canonicalJson;
export const READER_ENTITY_TYPES=Object.freeze(['reading','bookmark','catalog']);
export const READER_SHELVES=Object.freeze(['reading','planned','finished','paused','dropped','favorite']);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER=/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/;
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
export const readerDataError=(code,message,status=400)=>Object.assign(new Error(message),{code,status});
const bad=message=>{throw readerDataError('READER_VALIDATION',message);};
function object(value,keys){if(!record(value)||Object.keys(value).some(key=>!keys.includes(key)))bad('Неизвестные поля данных читателя');}
export function readerUuid(value){if(typeof value!=='string'||!UUID.test(value))bad('Некорректный ID данных читателя');return value.toLowerCase();}
/** V2 IDs cannot be moved to another profile, device or counter after GC. */
export function readerMutationIdV2(profile,device,counter){
 const profileId=readerUuid(typeof profile==='string'?profile:profile?.id),deviceId=readerUuid(device);integer(counter,1);
 const bytes=createHash('sha256').update(`gargantua-reader-v2\0${profileId}\0${deviceId}\0${counter}`,'utf8').digest().subarray(0,16);
 bytes[6]=(bytes[6]&15)|128;bytes[8]=(bytes[8]&63)|128;
 const hex=bytes.toString('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
function integer(value,min=0,max=Number.MAX_SAFE_INTEGER){if(!Number.isSafeInteger(value)||value<min||value>max)bad('Некорректное целое значение');return value;}
function string(value,max,{min=0,multiline=false}={}){
 if(typeof value!=='string'||!value.isWellFormed()||value.length<min||value.length>max|| (multiline?/[\p{Cf}\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u:/[\p{Cc}\p{Cf}]/u).test(value))bad('Недопустимый текст данных читателя');
 return value;
}
function ratio(value){if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>1)bad('Позиция должна быть от 0 до 1');return Object.is(value,-0)?0:value;}

/** Syntax only. The store also verifies the real immutable publication/anchor. */
export function validateReaderLocator(value){
 if(record(value)&&value.type==='legacy'){
  object(value,['type','chapter','position']);
  return {type:'legacy',chapter:integer(value.chapter,0,19999),position:ratio(value.position)};
 }
 object(value,['publicationId','publicationRevision','chapterId','blockId','offset','quote','progression']);
 if(value.publicationRevision!==1)bad('Поддерживается неизменяемая версия публикации 1');
 if(typeof value.chapterId!=='string'||!IDENTIFIER.test(value.chapterId))bad('Некорректная глава локатора');
 const result={publicationId:readerUuid(value.publicationId),publicationRevision:1,chapterId:value.chapterId};
 if(value.blockId!==undefined){if(typeof value.blockId!=='string'||!IDENTIFIER.test(value.blockId))bad('Некорректный блок локатора');result.blockId=value.blockId;}
 if(value.offset!==undefined){if(!result.blockId)bad('Смещение требует ID блока');result.offset=integer(value.offset,0,100000);}
 if(value.quote!==undefined){
  if(!result.blockId)bad('Текстовый якорь требует ID блока');object(value.quote,['exact','prefix','suffix']);
  result.quote={exact:string(value.quote.exact,1000,{min:1,multiline:true})};
  for(const key of ['prefix','suffix'])if(value.quote[key]!==undefined)result.quote[key]=string(value.quote[key],200,{multiline:true});
 }
 if(value.progression!==undefined)result.progression=ratio(value.progression);
 return result;
}

export function normalizeReaderPayload(entityType,value){
 if(!READER_ENTITY_TYPES.includes(entityType))bad('Неизвестный тип данных читателя');
 if(entityType==='catalog'){
  object(value,['catalogs']);
  if(!Array.isArray(value.catalogs)||value.catalogs.length>100)bad('Не указан список каталогов или превышен лимит');
  const catalogs=value.catalogs.map(catalog=>{
   object(catalog,['id','title','parent','items']);if(!Array.isArray(catalog.items)||catalog.items.length>200)bad('Не указан состав каталога или превышен лимит');
   const seen=new Set(),items=catalog.items.map(item=>{
    object(item,['id','scope','title','author']);if(!['device','server'].includes(item.scope))bad('Неизвестная область книги каталога');
    const result={id:readerUuid(item.id),scope:item.scope,title:string(item.title,250),author:string(item.author,250)},key=result.scope+':'+result.id;
    if(seen.has(key))bad('Повтор книги в одном каталоге');seen.add(key);return result;
   });
   return {id:readerUuid(catalog.id),title:string(catalog.title,120,{min:1}).trim(),parent:catalog.parent===null?null:readerUuid(catalog.parent),items};
  });
  try{validateCatalogs(catalogs);}catch{bad('Неверная структура каталогов или превышен лимит');}
  const result={catalogs};if(Buffer.byteLength(canonicalJson(result))>24000)throw readerDataError('READER_PAYLOAD_LIMIT','Каталоги превышают 24 КБ',413);return result;
 }
 object(value,entityType==='reading'?['publicationId','publicationRevision','locator','shelf']:['publicationId','publicationRevision','locator','note']);
 const publicationId=readerUuid(value.publicationId);if(value.publicationRevision!==1)bad('Поддерживается неизменяемая версия публикации 1');
 const locator=validateReaderLocator(value.locator);
 if(locator.type!=='legacy'&&(locator.publicationId!==publicationId||locator.publicationRevision!==value.publicationRevision))bad('Локатор принадлежит другой публикации');
 const result={publicationId,publicationRevision:1,locator};
 if(entityType==='reading'){
  const shelf=value.shelf??'reading';if(!READER_SHELVES.includes(shelf))bad('Неизвестная полка');result.shelf=shelf;
 }else result.note=string(value.note??'',500,{multiline:true});
 return result;
}

export function normalizeReaderMutation(value){
 object(value,['mutationId','deviceId','counter','entityType','entityId','baseRevision','operation','payload','protocolVersion']);
 const result={mutationId:readerUuid(value.mutationId),deviceId:readerUuid(value.deviceId),counter:integer(value.counter,1),entityType:value.entityType,entityId:readerUuid(value.entityId),baseRevision:integer(value.baseRevision,0,2147483646),operation:value.operation};
 if(value.protocolVersion!==undefined){if(value.protocolVersion!==2)bad('Поддерживается версия протокола 2 или прежний формат без версии');result.protocolVersion=2;}
 if(!READER_ENTITY_TYPES.includes(result.entityType)||!['upsert','delete'].includes(result.operation))bad('Неизвестная операция данных читателя');
 if(result.entityType==='catalog'&&result.entityId!==CATALOG_ENTITY_ID)bad('Неверный ID структуры каталогов');
 if(result.operation==='upsert'){
  result.payload=normalizeReaderPayload(result.entityType,value.payload);
  if(result.entityType==='reading'&&result.entityId!==result.payload.publicationId)bad('ID позиции должен совпадать с публикацией');
 }else if(value.payload!==undefined)bad('Удаление не принимает содержимое объекта');
 return result;
}

export function validateReaderEntity(value){
 object(value,['entityType','entityId','revision','deleted','payload','updatedAt']);
 const result={entityType:value.entityType,entityId:readerUuid(value.entityId),revision:integer(value.revision,value.entityType==='catalog'?0:1,2147483647),deleted:value.deleted};
 if(!READER_ENTITY_TYPES.includes(result.entityType)||typeof result.deleted!=='boolean')bad('Неверная запись данных читателя');
 if(result.revision===0&&result.deleted)bad('Начальная версия каталога не может быть удалённой');
 if(result.entityType==='catalog'&&result.entityId!==CATALOG_ENTITY_ID)bad('Неверный ID структуры каталогов');
 result.payload=result.deleted&&value.payload===null?null:normalizeReaderPayload(result.entityType,value.payload);
 if(result.entityType==='reading'&&result.payload&&result.entityId!==result.payload.publicationId)bad('ID позиции должен совпадать с публикацией');
 if(value.updatedAt!==undefined){
  if(typeof value.updatedAt!=='string'||value.updatedAt.length>40||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(value.updatedAt)||!Number.isFinite(Date.parse(value.updatedAt)))bad('Неверное время данных читателя');result.updatedAt=value.updatedAt;
 }
 return result;
}
