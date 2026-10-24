import {DEVICE} from './catalogs.mjs';
import {validateBookContent,DOWNLOAD_LIMITS,boundedJsonBytes} from './book-download.mjs';

export const LOCAL_LIBRARY_INDEX=`${DEVICE}:downloaded`;
export const LOCAL_LIBRARY_LIMITS=Object.freeze({books:2000,keys:30000,recoveryBytes:2*1024**3});
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{64}$/;
const shelves=new Set(['reading','planned','finished','paused','dropped','favorite']);
const queues=new WeakMap();
const fail=(message,code='LOCAL_LIBRARY_INVALID')=>{throw Object.assign(new Error(message),{code});};
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
function uuid(value){if(typeof value!=='string'||!UUID.test(value))fail('Некорректный идентификатор локальной книги');return value.toLowerCase();}
function inert(value){if(!plain(value)||Object.values(Object.getOwnPropertyDescriptors(value)).some(d=>!Object.hasOwn(d,'value')))fail('Недопустимые метаданные книги');}
function text(value,max,required=false){if(typeof value!=='string'||!value.isWellFormed()||value.length>max||required&&!value.length||/[\p{Cc}\p{Cf}]/u.test(value))fail('Недопустимый текст карточки книги');return value;}
function serial(action,storage){
 if(!storage||typeof storage.get!=='function'||typeof storage.apply!=='function')fail('Нужно хранилище с атомарным сохранением','LOCAL_ATOMIC_REQUIRED');
 const previous=queues.get(storage)||Promise.resolve(),next=previous.catch(()=>{}).then(action);queues.set(storage,next);
 return next.finally(()=>{if(queues.get(storage)===next)queues.delete(storage);});
}
export function refKey(ref){if(!plain(ref))fail('Не указана ссылка книги');return `${uuid(ref.owner)}:${uuid(ref.id)}`;}
function metadata(input,{owner,id,scope,recovered=false}={}){
 inert(input);owner=uuid(owner??input.owner);id=uuid(id??input.id);scope=scope??input.scope??(owner===DEVICE?'device':'server');
 if(!['device','server'].includes(scope)||scope!==(owner===DEVICE?'device':'server')||input.id!==undefined&&uuid(input.id)!==id||input.owner!==undefined&&uuid(input.owner)!==owner)fail('Карточка принадлежит другой книге или профилю');
 const book={id,owner,scope,title:text(input.title,300,true),author:text(input.author??'',300),chapter_count:input.chapter_count};
 if(!Number.isSafeInteger(book.chapter_count)||book.chapter_count<1||book.chapter_count>DOWNLOAD_LIMITS.chapters)fail('Неверное количество глав');
 for(const key of ['sha256','content_sha256','publication_sha256','package_sha256'])if(input[key]!==undefined&&input[key]!==null){if(typeof input[key]!=='string'||!SHA.test(input[key]))fail('Неверная контрольная сумма карточки');book[key]=input[key];}
 for(const key of ['work_id','expression_id','edition_id'])if(input[key]!==undefined&&input[key]!==null)book[key]=uuid(input[key]);
 if(input.language!==undefined)book.language=text(input.language,30);
 if(input.content_bytes!==undefined&&input.content_bytes!==null){const bytes=Number(input.content_bytes);if(!Number.isSafeInteger(bytes)||bytes<1||bytes>DOWNLOAD_LIMITS.bytes)fail('Неверный размер книги');book.content_bytes=bytes;}
 if(input.created_at!==undefined&&input.created_at!==null){const date=text(input.created_at,40);if(!Number.isFinite(Date.parse(date)))fail('Неверная дата книги');book.created_at=date;}
 book.shelf=shelves.has(input.shelf)?input.shelf:'planned';
 if(!recovered&&scope==='server'&&input.security_state!==undefined){if(!['passed','blocked','pending'].includes(input.security_state))fail('Неверный статус проверки');book.security_state=input.security_state;}
 if(recovered||input.recoveredLocalOnly===true)book.recoveredLocalOnly=true;
 return book;
}
function indexValue(value){
 if(value===undefined||value===null)return null;
 inert(value);if(value.schemaVersion!==1||Object.keys(value).some(k=>!['schemaVersion','books'].includes(k))||!Array.isArray(value.books)||value.books.length>LOCAL_LIBRARY_LIMITS.books)fail('Повреждён общий список книг; исходные пакеты сохранены','LOCAL_INDEX_INVALID');
 const seen=new Set(),books=value.books.map(item=>{const book=metadata(item),ref=refKey(book);if(seen.has(ref))fail('Повтор книги в общем списке','LOCAL_INDEX_INVALID');seen.add(ref);return book;});
 return {schemaVersion:1,books};
}
function positionData(value,chapterCount){
 if(!plain(value))return {};
 const result={};if(Number.isSafeInteger(value.chapter)&&value.chapter>=0&&value.chapter<chapterCount)result.chapter=value.chapter;
 if(typeof value.position==='number'&&Number.isFinite(value.position)&&value.position>=0&&value.position<=1)result.position=value.position;
 if(shelves.has(value.shelf))result.shelf=value.shelf;
 if(Number.isSafeInteger(value.lastRead)&&value.lastRead>=0)result.lastRead=value.lastRead;
 return result;
}
async function listed(storage,index){
 const positions=new Map();
 if(typeof storage.entries==='function')for(const owner of new Set(index.books.map(b=>b.owner))){
  const entries=await storage.entries(`${owner}:position:`);if(!Array.isArray(entries)||entries.length>LOCAL_LIBRARY_LIMITS.keys)fail('Слишком много локальных позиций');for(const entry of entries)if(Array.isArray(entry)&&entry.length===2&&typeof entry[0]==='string')positions.set(entry[0],entry[1]);
 }
 const books=[];for(const book of index.books){const key=`${book.owner}:position:${book.id}`,position=typeof storage.entries==='function'?positions.get(key):await storage.get(key);books.push({...book,...positionData(position,book.chapter_count)});}return books;
}
async function recover(storage,persist=true){
 const current=indexValue(await storage.get(LOCAL_LIBRARY_INDEX));if(current)return {books:await listed(storage,current),recovered:0,skipped:[],alreadyIndexed:true,index:current};
 if(typeof storage.keys!=='function')fail('Восстановление списка книг недоступно');
 const keys=await storage.keys('');if(!Array.isArray(keys)||keys.length>LOCAL_LIBRARY_LIMITS.keys)fail('Слишком много локальных записей для восстановления');
 const candidates=keys.filter(key=>typeof key==='string'&&/^[a-f0-9-]{36}:book:[a-f0-9-]{36}$/.test(key));
 if(candidates.length>LOCAL_LIBRARY_LIMITS.books)fail('Найдено больше 2000 пакетов; автоматическая перезапись запрещена','LOCAL_LIBRARY_QUOTA');
 const books=[],skipped=[],catalogs=new Map();let bytes=0;
 for(const key of [...new Set(candidates)].sort()){
  try{
   const [owner,,id]=key.split(':');uuid(owner);uuid(id);const packet=await storage.get(key);inert(packet);validateBookContent(packet.content,{allowLocal:true});
   bytes+=boundedJsonBytes(packet);if(bytes>LOCAL_LIBRARY_LIMITS.recoveryBytes)fail('Восстановление превышает лимит 2 ГиБ','LOCAL_RECOVERY_LIMIT');
   if(!catalogs.has(owner)){const cached=await storage.get(`${owner}:catalog`);catalogs.set(owner,Array.isArray(cached)?cached:[]);}
   const cached=catalogs.get(owner).find(book=>book?.id===id),chosen=packet.book??cached??{};inert(chosen);
   const candidate={...chosen,id:chosen.id??id,title:chosen.title||cached?.title||packet.content.title,author:chosen.author??cached?.author??packet.content.author,chapter_count:chosen.chapter_count??cached?.chapter_count??packet.content.chapters.length};
   const book=metadata(candidate,{owner,id,recovered:true});if(book.chapter_count!==packet.content.chapters.length)fail('Количество глав пакета не совпало с карточкой');books.push(book);
  }catch(error){if(error.code==='LOCAL_RECOVERY_LIMIT')throw error;skipped.push({key,reason:error.code||'LOCAL_PACKET_INVALID'});}
 }
 const index={schemaVersion:1,books};if(persist)await storage.apply([{type:'put',key:LOCAL_LIBRARY_INDEX,value:index}]);return {books:await listed(storage,index),recovered:books.length,skipped,alreadyIndexed:false,index};
}
/** One migration scan. Original packets, lastProfile and personal notes stay put. */
export function recoverLocalLibrary(storage){return serial(async()=>{const {index,...report}=await recover(storage);return report;},storage);}
export async function listLocalBooks(storage){
 const index=indexValue(await storage.get(LOCAL_LIBRARY_INDEX));if(!index)return (await recoverLocalLibrary(storage)).books;return listed(storage,index);
}
async function ownerCatalog(storage,owner){const value=await storage.get(`${owner}:catalog`);if(value===undefined||value===null)return [];if(!Array.isArray(value)||value.length>30000)fail('Повреждён кэш каталога; автоматическая замена запрещена');return value;}
export function commitLocalBook(storage,{owner,book,content,scope}){return serial(async()=>{
 owner=uuid(owner);const normalized=metadata(book,{owner,scope});validateBookContent(content,{allowLocal:normalized.scope==='device'});
 if(normalized.chapter_count!==content.chapters.length)fail('Количество глав не соответствует карточке');
 let index=indexValue(await storage.get(LOCAL_LIBRARY_INDEX));if(!index)index=(await recover(storage,false)).index;
 const ref=refKey(normalized),existing=index.books.find(b=>refKey(b)===ref),sameSource=normalized.scope==='device'&&normalized.sha256?index.books.find(b=>b.owner===owner&&b.sha256===normalized.sha256):null;
 if(sameSource&&sameSource.id!==normalized.id)return {book:sameSource,duplicate:true,ref:refKey(sameSource)};
 if(existing){
  const before=await storage.get(`${owner}:book:${normalized.id}`);
  if(before&&JSON.stringify(before.content)===JSON.stringify(content)&&JSON.stringify(existing)===JSON.stringify(normalized))return {book:existing,duplicate:true,ref};
  if(before&&JSON.stringify(before.content)!==JSON.stringify(content))fail('С этим ID уже сохранён другой неизменяемый текст','LOCAL_BOOK_COLLISION');
  if(existing.content_sha256&&normalized.content_sha256&&existing.content_sha256!==normalized.content_sha256)fail('С этим ID уже сохранён другой неизменяемый текст','LOCAL_BOOK_COLLISION');
  if(existing.sha256&&normalized.sha256&&existing.sha256!==normalized.sha256&&normalized.scope==='device')fail('С этим ID уже сохранён другой исходный файл','LOCAL_BOOK_COLLISION');
 }
 if(!existing&&index.books.length>=LOCAL_LIBRARY_LIMITS.books)fail('Лимит: 2000 локальных книг','LOCAL_LIBRARY_QUOTA');
 const packetKey=`${owner}:book:${normalized.id}`,packet={book:normalized,content,savedAt:Date.now()};
 const envelope=JSON.stringify({key:packetKey,value:packet});if(new TextEncoder().encode(envelope).length>DOWNLOAD_LIMITS.bytes)fail('Локальный пакет превышает 32 МиБ');
 const catalog=await ownerCatalog(storage,owner),position=catalog.findIndex(b=>b?.id===normalized.id),nextCatalog=[...catalog];if(position<0)nextCatalog.push(normalized);else nextCatalog[position]=normalized;
 const next={schemaVersion:1,books:[...index.books.filter(b=>refKey(b)!==ref),normalized]};
 await storage.apply([{type:'put',key:packetKey,value:JSON.parse(envelope).value},{type:'put',key:LOCAL_LIBRARY_INDEX,value:next},{type:'put',key:`${owner}:catalog`,value:nextCatalog}]);return {book:normalized,duplicate:false,ref};
 },storage);}
export function removeLocalBook(storage,reference){return serial(async()=>{
 const ref=refKey(reference),owner=uuid(reference.owner),id=uuid(reference.id);let index=indexValue(await storage.get(LOCAL_LIBRARY_INDEX));if(!index)index=(await recover(storage,false)).index;
 const catalog=await ownerCatalog(storage,owner),next={schemaVersion:1,books:index.books.filter(book=>refKey(book)!==ref)};
 await storage.apply([{type:'remove',key:`${owner}:book:${id}`},{type:'put',key:LOCAL_LIBRARY_INDEX,value:next},{type:'put',key:`${owner}:catalog`,value:catalog.filter(book=>book?.id!==id)}]);return {removed:true,ref};
 },storage);}
