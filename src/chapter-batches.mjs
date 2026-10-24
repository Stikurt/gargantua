/** Explicit, bounded chapter batches. These helpers never submit a request or
 * pick a book; only server-provided immutable publication IDs can be reused. */
import {DEVICE} from './catalogs.mjs';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const fail=message=>{throw Object.assign(Error(message),{code:'CHAPTER_BATCH_INPUT'});};
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const reservations=new WeakMap();
const uuid=value=>{if(typeof value!=='string'||!UUID.test(value))fail('Не подтверждён источник книги');return value.toLowerCase();};
export function chapterRangeInput(value={start:1,count:5},{kind='discovery'}={}){
 const max=kind==='audio'?50:5;if(!['audio','translation','discovery'].includes(kind)||!record(value)||Object.keys(value).some(key=>!['start','count'].includes(key))||!Number.isSafeInteger(value.start)||value.start<1||value.start>20000||!Number.isSafeInteger(value.count)||value.count<1||value.count>max)fail(`Укажите первую главу и количество от 1 до ${max}`);
 return {start:value.start,count:value.count};
}
export function chapterRangeInfo(value){
 if(!record(value)||Object.keys(value).some(key=>!['start','count','total','hasMore','nextStart'].includes(key))||!Number.isSafeInteger(value.start)||value.start<1||!Number.isSafeInteger(value.count)||value.count<1||value.count>20000||!Number.isSafeInteger(value.total)||value.total<1||value.total>20000||value.start+value.count-1>value.total||typeof value.hasMore!=='boolean'||value.hasMore!==(value.start+value.count-1<value.total)||value.nextStart!==(value.hasMore?value.start+value.count:null))fail('Сервер не подтвердил диапазон глав');
 return {start:value.start,count:value.count,total:value.total,hasMore:value.hasMore,nextStart:value.nextStart};
}
export function chapterBatchLabel(row){
 const value=row?.originChapterRange??row?.chapterRange;if(!value)return '';
 try{const range=chapterRangeInfo(value);return `Главы ${range.start}–${range.start+range.count-1} из ${range.total}`;}catch{return 'Диапазон глав требует проверки';}
}
export function chapterBatchInput(value){
 if(!record(value)||!['audio','translation'].includes(value.kind)||!Array.isArray(value.publicationIds)||!value.publicationIds.length||value.publicationIds.length>20000)fail('Выберите подтверждённую книгу');
 const publicationIds=value.publicationIds.map(uuid);if(new Set(publicationIds).size!==publicationIds.length)fail('В источнике повторяется часть книги');
 if(!['ru','en'].includes(value.sourceLanguage)||value.kind==='audio'&&value.sourceLanguage!=='ru'||value.kind==='translation'&&value.sourceLanguage!=='en')fail('Язык источника требует проверки на сервере');
 if(value.audio!==undefined&&typeof value.audio!=='boolean')fail('Неверные настройки озвучки');
 const range=value.chapterRange?.total!==undefined?chapterRangeInfo(value.chapterRange):chapterRangeInput(value.chapterRange,{kind:value.kind});
 return {kind:value.kind,publicationIds,...(value.snapshotId?{snapshotId:uuid(value.snapshotId)}:{}),sourceLanguage:value.sourceLanguage,chapterRange:chapterRangeInput({start:range.start,count:range.count},{kind:value.kind}),...(value.kind==='translation'?{audio:value.audio??true}:{})};
}
export function nextChapterBatch(row,{parents=[],count=5}={}){
 let source=row;
 if(row?.originChapterRange){source=parents.find(parent=>parent.id===row.parentRequestId&&parent.jobId===row.parentJobId&&parent.requestedBy===row.requestedBy&&parent.kind==='translation');if(!source)fail('Для продолжения перевода обновите исходную заявку');}
 const range=chapterRangeInfo(source?.chapterRange);if(!range.hasMore)fail('Последняя глава этого источника уже включена');
 return chapterBatchInput({...source,chapterRange:{start:range.nextStart,count}});
}
const digest=async(value,crypto)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),byte=>byte.toString(16).padStart(2,'0')).join('');
/** A lost response reuses the same ticket after a process restart. Changing the
 * source snapshot, kind or range deliberately creates a different intent. */
export async function reserveChapterBatch(storage,{profileId,serverIdentity},value,{crypto=globalThis.crypto}={}){
 profileId=uuid(profileId);if(typeof serverIdentity!=='string'||!serverIdentity||serverIdentity.length>2048||/[\p{Cc}\p{Cf}]/u.test(serverIdentity)||typeof storage?.get!=='function'||typeof storage?.put!=='function'||!crypto?.subtle||typeof crypto.randomUUID!=='function')fail('Не удалось сохранить заявку на обработку');
 const input=chapterBatchInput(value),key=`${DEVICE}:chapter-batch:${await digest(JSON.stringify([profileId,serverIdentity,input]),crypto)}`;
 let queue=reservations.get(storage);if(!queue){queue=new Map();reservations.set(storage,queue);}const previous=queue.get(key)??Promise.resolve();
 const next=previous.catch(()=>{}).then(async()=>{const old=await storage.get(key);
  if(old!==undefined&&old!==null){if(!record(old)||!UUID.test(old.idempotencyKey??'')||JSON.stringify(chapterBatchInput(old))!==JSON.stringify(input))fail('Сохранённая заявка повреждена. Исходные данные оставлены для проверки');return {key,body:{idempotencyKey:old.idempotencyKey,...input}};}
  const body={idempotencyKey:crypto.randomUUID(),...input};await storage.put(key,body);return {key,body};
 });queue.set(key,next);try{return await next;}finally{if(queue.get(key)===next)queue.delete(key);}
}
