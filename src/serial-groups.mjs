// A reading group references immutable publications. It never joins their raw
// packages, guesses by title, or becomes a publication sent to reader sync.
import {DEVICE} from './catalogs.mjs';
export const SERIAL_GROUP_REGISTRY_KEY=`${DEVICE}:serial-groups`;
export const SERIAL_GROUP_LIMITS=Object.freeze({groups:100,parts:400,chapters:20000,responseBytes:4*1024*1024,receipts:2000,receiptBytes:8*1024*1024});
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA=/^[a-f0-9]{64}$/;
const locks=new WeakMap();
const fail=message=>{throw Object.assign(Error(message),{code:'SERIAL_GROUP_INVALID'});};
function object(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value))||Object.keys(value).some(key=>!keys.includes(key))||Object.values(Object.getOwnPropertyDescriptors(value)).some(row=>!Object.hasOwn(row,'value')))fail('Неверные метаданные объединённой книги');}
function id(value){if(typeof value!=='string'||!UUID.test(value))fail('Неверный идентификатор объединённой книги');return value;}
function text(value,max,{empty=false}={}){if(typeof value!=='string'||!value.isWellFormed()||value.length>max||!empty&&!value.length||/[\p{Cc}\p{Cf}]/u.test(value))fail('Неверный текст метаданных объединённой книги');return value;}
function size(value,limit){const encoded=JSON.stringify(value);if(new TextEncoder().encode(encoded).length>limit)fail('Метаданные объединённой книги превышают предел');}
export function validateSerialGroup(input){
 object(input,['schemaVersion','id','snapshotId','provider','title','author','language','branch','snapshotStatus','inventorySha256','totalChapters','parts']);
 if(input.schemaVersion!==1||input.provider!=='ranobelib'||!['building','ready'].includes(input.snapshotStatus)||!SHA.test(input.inventorySha256||'')||!Number.isSafeInteger(input.totalChapters)||input.totalChapters<1||input.totalChapters>SERIAL_GROUP_LIMITS.chapters||!Array.isArray(input.parts)||input.parts.length>SERIAL_GROUP_LIMITS.parts)fail('Неверная версия объединённой книги');
 const group={schemaVersion:1,id:id(input.id),snapshotId:id(input.snapshotId),provider:'ranobelib',title:text(input.title,300),author:text(input.author,300,{empty:true}),language:text(input.language,30),branch:text(input.branch,120),snapshotStatus:input.snapshotStatus,inventorySha256:input.inventorySha256,totalChapters:input.totalChapters,parts:[]};
 const seen=new Set();let end=0;
 for(const part of input.parts){
  object(part,['publicationId','chapterOffset','chapterCount','contentSha256','packageSha256','securityState']);
  if(!Number.isSafeInteger(part.chapterOffset)||part.chapterOffset<0||part.chapterOffset<end||!Number.isSafeInteger(part.chapterCount)||part.chapterCount<1||part.chapterCount>50||part.chapterOffset+part.chapterCount>group.totalChapters||!SHA.test(part.contentSha256||'')||!SHA.test(part.packageSha256||'')||!['passed','blocked','pending'].includes(part.securityState))fail('Неверные границы или безопасность частей книги');
  const publicationId=id(part.publicationId);if(seen.has(publicationId))fail('Повтор публикации в объединённой книге');seen.add(publicationId);end=part.chapterOffset+part.chapterCount;
  group.parts.push({publicationId,chapterOffset:part.chapterOffset,chapterCount:part.chapterCount,contentSha256:part.contentSha256,packageSha256:part.packageSha256,securityState:part.securityState});
 }
 if(group.snapshotStatus==='ready'&&(group.parts.length===0||group.parts[0].chapterOffset!==0||end!==group.totalChapters||group.parts.some((part,index)=>index>0&&part.chapterOffset!==group.parts[index-1].chapterOffset+group.parts[index-1].chapterCount)))fail('Готовая книга содержит пропуск частей');
 return group;
}
export function validateSerialGroupsResponse(value){
 object(value,['schemaVersion','groups']);if(value.schemaVersion!==1||!Array.isArray(value.groups)||value.groups.length>SERIAL_GROUP_LIMITS.groups)fail('Неверный список объединённых книг');
 const groups=value.groups.map(validateSerialGroup),feeds=new Set(),publications=new Set();
 for(const group of groups){if(feeds.has(group.id))fail('Два текущих снимка одной книги');feeds.add(group.id);for(const part of group.parts){if(publications.has(part.publicationId))fail('Публикация относится к разным текущим книгам');publications.add(part.publicationId);}}
 size({schemaVersion:1,groups},SERIAL_GROUP_LIMITS.responseBytes);return groups;
}
function receiptKey(owner,group){return `${id(owner)}:serial-group:${id(group.id)}:${id(group.snapshotId)}`;}
function registry(value){if(value===undefined||value===null)return {schemaVersion:1,refs:[]};object(value,['schemaVersion','refs']);if(value.schemaVersion!==1||!Array.isArray(value.refs)||value.refs.length>SERIAL_GROUP_LIMITS.receipts)fail('Повреждён индекс объединённых книг');const seen=new Set();for(const ref of value.refs){object(ref,['owner','feedId','snapshotId','active','updatedAt']);id(ref.owner);id(ref.feedId);id(ref.snapshotId);if(typeof ref.active!=='boolean'||!Number.isSafeInteger(ref.updatedAt)||ref.updatedAt<0)fail('Повреждена версия объединённой книги');const key=ref.owner+'|'+ref.feedId+'|'+ref.snapshotId;if(seen.has(key))fail('Повтор версии объединённой книги');seen.add(key);}return value;}
function headersFor(group,headers={}){
 object(headers,group.parts.map(part=>part.publicationId));const output={};
 for(const part of group.parts){const rows=headers[part.publicationId];if(rows===undefined)continue;if(!Array.isArray(rows)||rows.length!==part.chapterCount)fail('Оглавление части не соответствует снимку');output[part.publicationId]=rows.map((row,index)=>{object(row,['index','title']);if(row.index!==index)fail('Неверный порядок оглавления части');return {index,title:text(row.title,300,{empty:true})};});}
 return output;
}
export function validateSerialReceipt(value,owner){object(value,['schemaVersion','owner','group','headers','updatedAt','active']);if(value.schemaVersion!==1||value.owner!==id(owner)||!Number.isSafeInteger(value.updatedAt)||value.updatedAt<0||value.active!==undefined&&typeof value.active!=='boolean')fail('Книга принадлежит другому профилю');const group=validateSerialGroup(value.group),result={schemaVersion:1,owner,group,headers:headersFor(group,value.headers),updatedAt:value.updatedAt};size(result,SERIAL_GROUP_LIMITS.receiptBytes);return result;}
async function locked(storage,action){const previous=locks.get(storage)||Promise.resolve(),next=previous.catch(()=>{}).then(action);locks.set(storage,next);try{return await next;}finally{if(locks.get(storage)===next)locks.delete(storage);}}
/** Enrich existing local parts with metadata only. Their original packet,
 * progress and bookmarks remain byte-for-byte untouched by this operation. */
export function rememberSerialGroups(storage,owner,groups,{headers={},now=Date.now(),activate=true}={}){
 id(owner);groups=validateSerialGroupsResponse({schemaVersion:1,groups});
 return locked(storage,async()=>{const current=registry(await storage.get(SERIAL_GROUP_REGISTRY_KEY)),refs=current.refs.map(ref=>({...ref})),writes=[];
  for(const incoming of groups){let group=incoming;const key=receiptKey(owner,group),known=await storage.get(key),previous=known?validateSerialReceipt(known,owner):null;
   for(const ref of refs.filter(ref=>ref.owner===owner&&ref.feedId===group.id&&ref.snapshotId!==group.snapshotId)){const raw=await storage.get(receiptKey(owner,{id:ref.feedId,snapshotId:ref.snapshotId}));if(!raw||validateSerialReceipt(raw,owner).group.branch!==group.branch)fail('Ветка сохранённой книги не соответствует новой версии');}
   if(previous){const before=previous.group;if(before.id!==group.id||before.snapshotId!==group.snapshotId||before.branch!==group.branch||before.inventorySha256!==group.inventorySha256||before.totalChapters!==group.totalChapters)fail('Сохранённый снимок книги изменился');for(const part of group.parts){const old=before.parts.find(row=>row.publicationId===part.publicationId),overlap=before.parts.find(row=>row.chapterOffset===part.chapterOffset);if(old&&(old.chapterOffset!==part.chapterOffset||old.chapterCount!==part.chapterCount||old.contentSha256!==part.contentSha256||old.packageSha256!==part.packageSha256)||overlap&&overlap.publicationId!==part.publicationId)fail('Неизменяемая часть снимка была заменена');}
    const merged=[...before.parts];for(const part of group.parts){const index=merged.findIndex(row=>row.publicationId===part.publicationId);if(index<0)merged.push(part);else merged[index]=part;}merged.sort((a,b)=>a.chapterOffset-b.chapterOffset);group=validateSerialGroup({...group,snapshotStatus:before.snapshotStatus==='ready'?'ready':group.snapshotStatus,parts:merged});
   }
   const merged={...(previous?.headers||{}),...(headers[group.id]||{})},receipt=validateSerialReceipt({schemaVersion:1,owner,group,headers:merged,updatedAt:now},owner);
   if(activate)for(const ref of refs)if(ref.owner===owner&&ref.feedId===group.id)ref.active=false;
   const old=refs.findIndex(ref=>ref.owner===owner&&ref.feedId===group.id&&ref.snapshotId===group.snapshotId),ref={owner,feedId:group.id,snapshotId:group.snapshotId,active:activate||(old>=0&&refs[old].active),updatedAt:now};if(old<0)refs.push(ref);else refs[old]=ref;
   writes.push({type:'put',key,value:receipt});
  }
  if(refs.length>SERIAL_GROUP_LIMITS.receipts)fail('Достигнут предел сохранённых версий книг');writes.push({type:'put',key:SERIAL_GROUP_REGISTRY_KEY,value:{schemaVersion:1,refs}});if(writes.length>1)await storage.apply(writes);return groups;
 });
}
export async function localSerialReceipts(storage,{owner,includeVersions=true}={}){
 if(owner!==undefined)id(owner);const refs=registry(await storage.get(SERIAL_GROUP_REGISTRY_KEY)).refs.filter(ref=>(!owner||ref.owner===owner)&&(includeVersions||ref.active)),result=[];
 for(const ref of refs){const raw=await storage.get(receiptKey(ref.owner,{id:ref.feedId,snapshotId:ref.snapshotId}));if(!raw)fail('Сохранённое описание версии книги отсутствует');const receipt=validateSerialReceipt(raw,ref.owner);result.push({...receipt,active:ref.active});}return result;
}
// A publication ID is only a reference. Availability also requires the exact
// immutable bytes, chapter count and passed verification stored at download.
// An old/recovered index without those seals can be shown for recovery, but is
// never promoted to a complete, verified snapshot merely by matching its ID.
function partAvailability(part,book){
 if(!book)return 'missing';
 if(book.chapter_count!==part.chapterCount)return 'chapter-count';
 if(book.content_sha256!==part.contentSha256)return 'content-sha256';
 if(book.package_sha256!==part.packageSha256)return 'package-sha256';
 if(part.securityState!=='passed'||book.security_state!=='passed')return 'security-state';
 return null;
}
export function groupBookCards(books,receipts,{owner,server=false,versions={}}={}){
 if(!Array.isArray(books)||!Array.isArray(receipts))fail('Неверные книги для объединения');const cards=[],hidden=new Set(),families=new Map(),assigned=new Map();
 for(const row of receipts){if(owner&&row.owner!==owner)continue;const receipt=validateSerialReceipt(row.group?{schemaVersion:1,owner:row.owner,group:row.group,headers:row.headers||{},updatedAt:row.updatedAt||0}:row,row.owner),key=receipt.owner+'|'+receipt.group.id;let list=families.get(key);if(!list){list=[];families.set(key,list);}list.push({...receipt,active:row.active!==false});}
 for(const [family,variants]of families){const byNewest=variants.slice().sort((a,b)=>b.updatedAt-a.updatedAt),current=byNewest.find(row=>row.active)||byNewest[0],explicit=variants.find(row=>row.group.snapshotId===versions[family]),matches=row=>row.group.parts.map(part=>{const book=books.find(book=>book.id===part.publicationId&&(server||book.owner===row.owner));return {part,book,reason:partAvailability(part,book)};}),hasSaved=row=>matches(row).some(({reason})=>reason===null),hasStored=row=>matches(row).some(({book})=>Boolean(book)),isComplete=row=>row.group.snapshotStatus==='ready'&&row.group.parts.reduce((sum,part)=>sum+part.chapterCount,0)===row.group.totalChapters&&matches(row).every(({reason})=>reason===null);let selected=explicit||current;
  // Updates may reuse the first packets of an older snapshot. Those few
  // packets must not silently replace a fully downloaded offline edition.
  if(!server&&!explicit&&!isComplete(selected))selected=byNewest.find(isComplete)||(hasSaved(selected)?selected:byNewest.find(hasSaved)||byNewest.find(hasStored)||selected);const group=selected.group;
  if(variants.some(row=>row.group.branch!==group.branch))fail('Одна группа содержит разные ветки перевода');
  for(const version of variants)for(const part of version.group.parts){const key=version.owner+'|'+part.publicationId;if(assigned.has(key)&&assigned.get(key)!==family)fail('Публикация неоднозначно связана с разными книгами');assigned.set(key,family);}
  for(const version of variants)for(const part of version.group.parts)hidden.add(selected.owner+'|'+part.publicationId);
  const matching=matches(selected),available=matching.filter(row=>row.reason===null),first=available[0]?.book||matching.find(row=>row.book)?.book;if(!first)continue;
  const totalDownloaded=available.reduce((sum,row)=>sum+row.part.chapterCount,0),resume=available.slice().sort((a,b)=>(b.book.lastRead||0)-(a.book.lastRead||0))[0];
  cards.push({...first,owner:selected.owner,title:group.title,author:group.author,chapter_count:group.totalChapters,serialGroup:group,serialReceipt:selected,serialVersions:server?variants:variants.filter(hasStored),serialSavedOlderVersion:!server&&selected.group.snapshotId!==current.group.snapshotId,serialLatestSnapshotId:current.group.snapshotId,serialUpdateAvailable:!server&&selected.group.snapshotId!==current.group.snapshotId,serialAvailableChapters:totalDownloaded,serialReady:isComplete(selected),serialUnavailableParts:matching.filter(row=>row.reason!==null).map(row=>({publicationId:row.part.publicationId,reason:row.reason})),serialFamily:family,resumePublicationId:resume?.book.id||null,chapter:resume?resume.part.chapterOffset+(resume.book.chapter||0):0,position:resume?.book.position||0,lastRead:resume?.book.lastRead||first.lastRead});
 }
 for(const book of books){const knownFeed=server&&book.serial_feed_id&&families.has(owner+'|'+book.serial_feed_id);if(!knownFeed&&!hidden.has((server?owner:book.owner)+'|'+book.id))cards.push(book);}return cards;
}
export function serialGroupForBook(receipts,owner,publicationId,{snapshotId}={}){id(owner);id(publicationId);const found=receipts.filter(row=>row.owner===owner&&row.group.parts.some(part=>part.publicationId===publicationId)&&(!snapshotId||row.group.snapshotId===snapshotId));const active=found.filter(row=>row.active!==false);const candidates=snapshotId?found:active.length?active:found;if(!candidates.length)return null;const feeds=new Set(candidates.map(row=>row.group.id));if(feeds.size!==1)fail('Публикация неоднозначно связана с разными книгами');return candidates.slice().sort((a,b)=>b.updatedAt-a.updatedAt)[0];}
export function serialChapterTarget(group,globalIndex){group=validateSerialGroup(group);if(!Number.isSafeInteger(globalIndex)||globalIndex<0||globalIndex>=group.totalChapters)fail('Глава вне объединённой книги');const part=group.parts.find(row=>globalIndex>=row.chapterOffset&&globalIndex<row.chapterOffset+row.chapterCount);if(!part||part.securityState!=='passed')throw Object.assign(Error('Эта глава ещё не получена и не проверена. Подключитесь к серверу позднее.'),{code:'SERIAL_CHAPTER_UNAVAILABLE'});return {publicationId:part.publicationId,index:globalIndex-part.chapterOffset,position:0};}
export async function serialReaderContext(storage,receipt,{api,books=[],online=false}={}){
 const {owner,group}=validateSerialReceipt(receipt,receipt.owner),parts=[],allMarks=[],enriched={};let changed=false;
 for(const part of group.parts){let headers=receipt.headers?.[part.publicationId],available=false;
  let known=books.find(book=>book.owner===owner&&book.id===part.publicationId),packet;
  if(!headers||!books.length){packet=await storage.get(`${owner}:book:${part.publicationId}`);if(packet){known=packet.book;headers=packet.content.chapters.map((chapter,index)=>({index,title:chapter.title}));changed=true;}}
  if(known){if(known.id!==part.publicationId||known.owner!==owner||known.chapter_count!==part.chapterCount||known.content_sha256!==part.contentSha256||known.package_sha256!==part.packageSha256||known.security_state!=='passed')fail('Локальная часть не соответствует сохранённому снимку или не имеет подтверждённой проверки. Скачайте её заново.');available=part.securityState==='passed';}
  if(online&&part.securityState==='passed')try{const detail=await api('/books/'+part.publicationId);if(detail.book.id!==part.publicationId||detail.book.chapter_count!==part.chapterCount||detail.book.content_sha256!==part.contentSha256||detail.book.security_state!=='passed')fail('Серверная часть не соответствует выбранному снимку');headers=detail.chapters;available=true;changed=true;}catch(error){if(error.code==='SERIAL_GROUP_INVALID'||error.status&&![401,404].includes(error.status))throw error;if(!known)available=false;}
  if(headers)headers=headersFor({...group,parts:[part]},{[part.publicationId]:headers})[part.publicationId];
  if(headers)enriched[part.publicationId]=headers;
  parts.push({...part,chapters:headers||[],available});const marks=(await storage.entries(`${owner}:mark:${part.publicationId}:`)).map(([,mark])=>({...mark,publicationId:part.publicationId}));allMarks.push(...marks);
 }
 if(changed)await rememberSerialGroups(storage,owner,[group],{headers:{[group.id]:enriched},activate:false});
 return {serialGroup:{...group,parts},serialBookmarks:allMarks};
}
