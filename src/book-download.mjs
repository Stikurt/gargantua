const MB=1024*1024;
export const DOWNLOAD_LIMITS=Object.freeze({bytes:32*MB,assets:200,assetBytes:20*MB,chapters:1000,blocks:200000});
const SHA=/^[a-f0-9]{64}$/;
const ID=/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/;
const ASSET=/^image-\d{1,3}\.png$/;
const forbidden=new Set(['__proto__','constructor','prototype']);
const fail=(message,code='DOWNLOAD_INVALID')=>{throw Object.assign(new Error(message),{code});};
/** Measure JSON without first allocating a possibly enormous serialized value.
 * Repeated object references count repeatedly; cycles/getters never execute. */
export function boundedJsonBytes(value,limit=DOWNLOAD_LIMITS.bytes){
 if(!Number.isSafeInteger(limit)||limit<1||limit>DOWNLOAD_LIMITS.bytes)fail('Неверный лимит JSON');
 let bytes=0,nodes=0;const active=new Set();
 const add=n=>{bytes+=n;if(bytes>limit)fail('Пакет книги превышает безопасный объём','DOWNLOAD_SIZE');};
 const string=value=>{add(2);for(let i=0;i<value.length;i++){const unit=value.charCodeAt(i);if(unit<32)add([8,9,10,12,13].includes(unit)?2:6);else if(unit===34||unit===92)add(2);else if(unit<128)add(1);else if(unit<2048)add(2);else if(unit>=0xd800&&unit<=0xdbff){const next=value.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))fail('Повреждён Unicode JSON');add(4);}else if(unit>=0xdc00&&unit<=0xdfff)fail('Повреждён Unicode JSON');else add(3);}};
 function visit(item,depth){
  if(++nodes>1_000_000||depth>64)fail('Слишком сложный пакет книги');
  if(item===null){add(4);return;}if(typeof item==='string'){string(item);return;}if(typeof item==='boolean'){add(item?4:5);return;}if(typeof item==='number'){if(!Number.isFinite(item))fail('Недопустимое число JSON');add(JSON.stringify(item).length);return;}
  if(typeof item!=='object'||active.has(item))fail('Пакет должен содержать обычные JSON-данные');active.add(item);
  try{
   if(Array.isArray(item)){
    if(Object.getPrototypeOf(item)!==Array.prototype||item.length>30000||Object.keys(item).length!==item.length)fail('Недопустимый массив книги');add(2+Math.max(item.length-1,0));
    for(let i=0;i<item.length;i++){const descriptor=Object.getOwnPropertyDescriptor(item,String(i));if(!descriptor||!Object.hasOwn(descriptor,'value'))fail('Активное поле массива запрещено');visit(descriptor.value,depth+1);}
   }else{
    if(![Object.prototype,null].includes(Object.getPrototypeOf(item)))fail('Недопустимый объект книги');const keys=Object.keys(item);if(keys.length>1000)fail('Слишком много полей книги');add(2+Math.max(keys.length-1,0));
    for(const key of keys){if(forbidden.has(key))fail('Опасное поле книги');const descriptor=Object.getOwnPropertyDescriptor(item,key);if(!descriptor||!Object.hasOwn(descriptor,'value'))fail('Активное поле книги запрещено');string(key);add(1);visit(descriptor.value,depth+1);}
   }
  }finally{active.delete(item);}
 }
 visit(value,0);return bytes;
}
function record(value,keys){
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail('Недопустимая структура книги');
 for(const [key,descriptor]of Object.entries(Object.getOwnPropertyDescriptors(value)))if(forbidden.has(key)||!keys.includes(key)||!Object.hasOwn(descriptor,'value'))fail('Неизвестное или активное поле книги');
}
function text(value,max,{empty=true}={}){if(typeof value!=='string'||!value.isWellFormed()||value.length>max||(!empty&&!value.length)||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value))fail('Недопустимый текст книги');return value;}
function identifier(value){if(typeof value!=='string'||!ID.test(value))fail('Недопустимый идентификатор блока');return value;}
function base64(value){
 if(typeof value!=='string'||value.length>16*MB||value.length%4!==0||!value.length||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))fail('Некорректная иллюстрация');
 const binary=atob(value);if(btoa(binary)!==value)fail('Неканоническая иллюстрация');return Uint8Array.from(binary,c=>c.charCodeAt(0));
}
function png(bytes){
 const signature=[137,80,78,71,13,10,26,10];
 if(bytes.length<33||!signature.every((n,i)=>bytes[i]===n))fail('Разрешены только подготовленные PNG');
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),kind=String.fromCharCode(...bytes.subarray(12,16));
 const width=view.getUint32(16),height=view.getUint32(20);
 if(view.getUint32(8)!==13||kind!=='IHDR'||width<1||height<1||width>8192||height>8192||width*height>12_000_000||bytes[26]!==0||bytes[27]!==0||bytes[28]>1)fail('Иллюстрация превышает безопасные размеры');
 let offset=8,chunks=0,ended=false,hasData=false;
 while(offset<bytes.length){
  if(++chunks>10000||offset+12>bytes.length)fail('Повреждён PNG');const size=view.getUint32(offset),type=String.fromCharCode(...bytes.subarray(offset+4,offset+8));
  if(size>20*MB||offset+12+size>bytes.length||!/[A-Za-z]{4}/.test(type)||['acTL','fcTL','fdAT'].includes(type))fail('Небезопасная структура PNG');
  if(type==='IDAT')hasData=true;if(type==='IEND'){if(size!==0||offset+12!==bytes.length)fail('Избыточные данные PNG');ended=true;}
  offset+=12+size;
 }
 if(!ended||!hasData)fail('Неполная иллюстрация PNG');
}
function structure(value,chapterCount,assets){
 record(value,['schemaVersion','chapters','warnings']);if(value.schemaVersion!==2||!Array.isArray(value.chapters)||value.chapters.length!==chapterCount||!Array.isArray(value.warnings)||value.warnings.length>100)fail('Повреждённая структура публикации');
 value.warnings.forEach(w=>text(w,120));const chapters=new Set(),blocks=new Set(),references=[];let count=0,total=0;
 for(const chapter of value.chapters){
  record(chapter,['id','revision','title','blocks']);identifier(chapter.id);if(chapters.has(chapter.id)||chapter.revision!==1||!Array.isArray(chapter.blocks)||!chapter.blocks.length||chapter.blocks.length>30000)fail('Недопустимая структурированная глава');chapters.add(chapter.id);text(chapter.title,300);
  for(const block of chapter.blocks){
   record(block,['id','type','text','resource','referenceId','direction','spans','rows','level']);identifier(block.id);if(blocks.has(block.id)||++count>DOWNLOAD_LIMITS.blocks||!['paragraph','heading','quote','verse','list','table','image','footnote','ruby'].includes(block.type))fail('Недопустимый структурированный блок');blocks.add(block.id);text(block.text,100000);total+=block.text.length;if(total>12*MB)fail('Слишком большой структурированный текст');
   if(block.direction!==undefined&&!['ltr','rtl','auto'].includes(block.direction))fail('Недопустимое направление текста');
   if(block.level!==undefined&&(!Number.isInteger(block.level)||block.level<1||block.level>6||block.type!=='heading'))fail('Недопустимый уровень заголовка');
   if(block.type==='image'){if(typeof block.resource!=='string'||!ASSET.test(block.resource)||!assets.has(block.resource))fail('Отсутствует локальный ресурс изображения');}else if(block.resource!==undefined)fail('Внешние ресурсы запрещены');
   if(block.referenceId!==undefined)references.push(identifier(block.referenceId));
   if(block.spans!==undefined){
    if(!Array.isArray(block.spans)||block.spans.length>2000)fail('Слишком много акцентов текста');
    for(const span of block.spans){record(span,['start','end','kind','target']);if(!Number.isSafeInteger(span.start)||!Number.isSafeInteger(span.end)||span.start<0||span.end<=span.start||span.end>block.text.length||!['emphasis','strong','code','link','superscript','subscript'].includes(span.kind))fail('Неверный текстовый акцент');for(const at of [span.start,span.end])if(at>0&&at<block.text.length&&/[\uD800-\uDBFF]/.test(block.text[at-1])&&/[\uDC00-\uDFFF]/.test(block.text[at]))fail('Акцент разрезает символ');if(span.kind==='link')references.push(identifier(span.target));else if(span.target!==undefined)fail('Внешняя ссылка запрещена');}
   }
   if(block.rows!==undefined){if(block.type!=='table'||!Array.isArray(block.rows)||block.rows.length>1000)fail('Неверная таблица');for(const row of block.rows){if(!Array.isArray(row)||!row.length||row.length>100)fail('Неверная строка таблицы');row.forEach(cell=>text(cell,10000));}}
  }
 }
 for(const target of references)if(!blocks.has(target))fail('Внутренняя ссылка не найдена');
}

/** All strings are inert data. The renderer must continue using text nodes. */
export function validateBookContent(content,{allowLocal=false}={}){
 boundedJsonBytes(content);
 record(content,['title','author','language','chapters','assets','structure','sourceMetadata','derivation',...(allowLocal?['localImport','illustrationsOmitted']:[])]);
 text(content.title,300,{empty:false});text(content.author,300);if(content.language!==undefined)text(content.language,30);else if(!allowLocal)fail('Не указан язык публикации');
 if(!Array.isArray(content.chapters)||!content.chapters.length||content.chapters.length>DOWNLOAD_LIMITS.chapters)fail('Неверное оглавление');
 record(content.assets,Object.keys(content.assets||{}));const assets=new Set();let assetBytes=0,count=0;
 for(const [name,data]of Object.entries(content.assets)){if(!ASSET.test(name)||assets.size>=DOWNLOAD_LIMITS.assets)fail('Внешний или неизвестный ресурс книги');const bytes=base64(data);png(bytes);assetBytes+=bytes.length;if(assetBytes>DOWNLOAD_LIMITS.assetBytes)fail('Слишком большой объём иллюстраций');assets.add(name);}
 for(const chapter of content.chapters){
  record(chapter,['title','blocks']);text(chapter.title,300);if(!Array.isArray(chapter.blocks)||!chapter.blocks.length||chapter.blocks.length>30000)fail('Неверная глава');
  for(const block of chapter.blocks){if(++count>DOWNLOAD_LIMITS.blocks)fail('Слишком много блоков книги');if(block?.type==='image'){record(block,['type','asset','text']);text(block.text,500);if(!assets.has(block.asset))fail('Иллюстрация отсутствует');}else{record(block,['type','text']);if(!['text','heading',...(allowLocal?['paragraph']:[])].includes(block.type))fail('Активное или неизвестное содержимое книги');text(block.text,100000);}}
 }
 if(content.structure!==undefined)structure(content.structure,content.chapters.length,assets);
 if(content.localImport!==undefined&&content.localImport!==true||content.illustrationsOmitted!==undefined&&typeof content.illustrationsOmitted!=='boolean')fail('Неверные свойства локального импорта');
 if(content.sourceMetadata!==undefined){const m=content.sourceMetadata;record(m,['schemaVersion','format','provenance','title','authors','languages','identifiers']);if(m.schemaVersion!==1||!['epub','txt'].includes(m.format)||m.provenance!==(m.format==='epub'?'opf':'gutenberg-txt-header'))fail('Неверное происхождение книги');text(m.title,300);for(const [field,limit,max]of [['authors',16,200],['languages',16,30],['identifiers',32,500]]){if(!Array.isArray(m[field])||m[field].length>limit)fail('Неверные метаданные источника');m[field].forEach(v=>text(v,max));}}
 if(content.derivation!==undefined){const d=content.derivation;record(d,['schemaVersion','kind','quality','sourceSha256','recipeSha256','jobId']);if(d.schemaVersion!==1||d.kind!=='machine-translation'||d.quality!=='machine-draft'||!SHA.test(d.sourceSha256)||!SHA.test(d.recipeSha256)||typeof d.jobId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(d.jobId))fail('Неверное происхождение перевода');}
 return content;
}

export async function validateDownloadedBook(raw,expectedSHA,{book}={}){
 const bytes=raw instanceof Uint8Array?raw:raw instanceof ArrayBuffer?new Uint8Array(raw):null;
 if(!bytes||!bytes.length||bytes.length>DOWNLOAD_LIMITS.bytes)fail('Скачанная книга пуста или превышает 32 МиБ','DOWNLOAD_SIZE');
 const stored=book?.content_sha256,expected=expectedSHA||stored;
 if(typeof expected!=='string'||!SHA.test(expected)||stored!==undefined&&(!SHA.test(stored)||stored!==expected))fail('Не получена согласованная контрольная сумма книги','DOWNLOAD_HASH_MISSING');
 const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');if(sha256!==expected)fail('Контрольная сумма скачанной книги не совпала','DOWNLOAD_HASH_MISMATCH');
 if(book?.content_bytes!==undefined&&Number(book.content_bytes)!==bytes.length)fail('Размер книги не соответствует карточке','DOWNLOAD_SIZE');
 let content;try{content=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes), (key,value)=>{if(forbidden.has(key))fail('Опасное поле книги');return value;});}catch(error){if(error.code?.startsWith('DOWNLOAD_'))throw error;fail('Скачанная книга содержит повреждённый JSON или UTF-8');}
 validateBookContent(content);
 if(book?.chapter_count!==undefined&&book.chapter_count!==content.chapters.length||book?.title!==undefined&&book.title!==content.title||book?.author!==undefined&&book.author!==content.author)fail('Скачана другая книга или неполный текст','DOWNLOAD_IDENTITY');
 return {content,sha256,bytes:bytes.length};
}

/** The declared length is advisory; actual streamed bytes enforce the bound. */
export async function readDownloadedResponse(response,book){
 if(!response||typeof response!=='object'||response.ok!==true||!response.headers||!response.body?.getReader)fail('Ответ скачивания недоступен','DOWNLOAD_RESPONSE');
 const declared=response.headers.get('Content-Length');
 if(declared!==null&&(!/^\d+$/.test(declared)||!Number.isSafeInteger(Number(declared))||Number(declared)>DOWNLOAD_LIMITS.bytes)){await response.body.cancel().catch(()=>{});fail('Объявленный размер книги превышает лимит','DOWNLOAD_SIZE');}
 const reader=response.body.getReader(),parts=[];let total=0,current=null,used=0;
 try{
  while(true){
   const {value,done}=await reader.read();if(done)break;if(!(value instanceof Uint8Array))fail('Неизвестный формат потока книги','DOWNLOAD_RESPONSE');total+=value.length;
   if(total>DOWNLOAD_LIMITS.bytes||declared!==null&&total>Number(declared)){await reader.cancel().catch(()=>{});fail('Поток книги превысил объявленный или безопасный объём','DOWNLOAD_SIZE');}
   // Fixed-size accumulation keeps one-byte network chunks from creating an
   // unbounded list of JS objects or retaining oversized backing buffers.
   let offset=0;while(offset<value.length){if(!current||used===current.length){current=new Uint8Array(Math.min(MB,DOWNLOAD_LIMITS.bytes-(total-value.length+offset)));parts.push(current);used=0;}const take=Math.min(current.length-used,value.length-offset);current.set(value.subarray(offset,offset+take),used);used+=take;offset+=take;}
  }
 }catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
 if(declared!==null&&Number(declared)!==total)fail('Поток книги оборван или изменён','DOWNLOAD_SIZE');
 const bytes=new Uint8Array(total);let offset=0;for(let i=0;i<parts.length;i++){const part=i===parts.length-1?parts[i].subarray(0,used):parts[i];bytes.set(part,offset);offset+=part.length;}
 return validateDownloadedBook(bytes,response.headers.get('X-Content-SHA256'),{book});
}
