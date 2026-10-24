import {createHash} from 'node:crypto';

export const canonicalJson=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item);
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const reject=message=>{throw Object.assign(new Error(message),{code:'PUBLICATION_STRUCTURE',status:423});};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>keys.includes(k));
const text=(value,max)=>typeof value==='string'&&value.length<=max&&value.isWellFormed();
export const shortTitle=value=>Array.from(value).slice(0,250).join('');
const identifier=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(value);
const kinds=['paragraph','heading','quote','verse','list','table','image','footnote','ruby'];
export function validateStructure(structure,chapterCount){
 if(!exact(structure,['schemaVersion','chapters','warnings'])||structure.schemaVersion!==2||!Array.isArray(structure.chapters)||structure.chapters.length!==chapterCount||!Array.isArray(structure.warnings)||structure.warnings.length>100)reject('Неверная структура документа');
 for(const warning of structure.warnings)if(!text(warning,120))reject('Недопустимое предупреждение структуры');
 const chapters=new Set(),blocks=new Set(),references=[];let count=0,total=0;
 for(const chapter of structure.chapters){
  if(!exact(chapter,['id','revision','title','blocks'])||!identifier(chapter.id)||chapters.has(chapter.id)||chapter.revision!==1||!text(chapter.title,300)||!Array.isArray(chapter.blocks)||!chapter.blocks.length||chapter.blocks.length>30000)reject('Неверная структурированная глава');
  chapters.add(chapter.id);
  for(const block of chapter.blocks){
   if(++count>200000||!exact(block,['id','type','text','resource','referenceId','direction','spans','rows','level'])||!identifier(block.id)||blocks.has(block.id)||!kinds.includes(block.type)||!text(block.text,100000))reject('Неверный структурированный блок');
   blocks.add(block.id);total+=block.text.length;if(total>12*1024*1024)reject('Текст структуры превышает лимит');
   if(block.direction!==undefined&&!['ltr','rtl','auto'].includes(block.direction))reject('Неверное направление текста');
   if(block.level!==undefined&&(!Number.isInteger(block.level)||block.level<1||block.level>6||block.type!=='heading'))reject('Неверный уровень заголовка');
   if(block.type==='image'){if(!/^image-\d{1,3}\.png$/.test(block.resource||''))reject('Неверный ресурс изображения');}
   else if(block.resource!==undefined)reject('Ресурс задан для нетекстового типа');
   if(block.referenceId!==undefined){if(!identifier(block.referenceId))reject('Неверная ссылка блока');references.push(block.referenceId);}
   if(block.spans!==undefined){
    if(!Array.isArray(block.spans)||block.spans.length>2000)reject('Слишком много inline-акцентов');
    for(const span of block.spans){
     if(!exact(span,['start','end','kind','target'])||!Number.isSafeInteger(span.start)||!Number.isSafeInteger(span.end)||span.start<0||span.end<=span.start||span.end>block.text.length||!['emphasis','strong','code','link','superscript','subscript'].includes(span.kind))reject('Неверный inline-акцент');
     // UTF-16 boundaries must not split a surrogate pair.
     for(const offset of [span.start,span.end])if(offset>0&&offset<block.text.length&&/[\uD800-\uDBFF]/.test(block.text[offset-1])&&/[\uDC00-\uDFFF]/.test(block.text[offset]))reject('Inline-ссылка разрезает символ');
     if(span.kind==='link'){if(!identifier(span.target))reject('Внешняя или неверная ссылка');references.push(span.target);}else if(span.target!==undefined)reject('Недопустимая цель акцента');
    }
   }
   if(block.rows!==undefined){if(block.type!=='table'||!Array.isArray(block.rows)||block.rows.length>1000||block.rows.some(row=>!Array.isArray(row)||!row.length||row.length>100||row.some(cell=>!text(cell,10000))))reject('Неверная таблица');}
  }
 }
 for(const reference of references)if(!blocks.has(reference))reject('Ссылка указывает на отсутствующий блок');
 return structure;
}

export function structureFor(book){
 if(book.structure)return validateStructure(book.structure,book.chapters.length);
 // Old immutable packages stay untouched. Their v2 projection explicitly
 // records the lost source structure instead of inventing recoverable markup.
 return {schemaVersion:2,warnings:['LEGACY_STRUCTURE_ONLY'],chapters:book.chapters.map((chapter,c)=>({id:`c-${c}`,revision:1,title:chapter.title,blocks:chapter.blocks.map((block,b)=>({id:`c-${c}-b-${b}`,type:block.type==='text'?'paragraph':block.type,text:block.text,...(block.type==='image'?{resource:block.asset}:{})}))}))};
}
export function makePublicationManifest(row,book){
 const structure=structureFor(book);
 const readingOrder=structure.chapters.map(chapter=>{const data=Buffer.from(canonicalJson(publicChapter(chapter)));return {chapterId:chapter.id,path:`chapters/${chapter.id}.json`,sha256:sha256(data),bytes:data.length,mediaType:'application/json'};});
 const resources=Object.entries(book.assets).sort(([a],[b])=>a<b?-1:1).map(([name,data])=>{const raw=Buffer.from(data,'base64');return {path:`assets/${name}`,sha256:sha256(raw),bytes:raw.length,mediaType:'image/png'};});
 return {schemaVersion:2,id:row.id,revision:1,workId:row.work_id,expressionId:row.expression_id,editionId:row.edition_id,title:shortTitle(book.title),language:/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(book.language)?book.language:'und',readingOrder,resources};
}
export const publicChapter=chapter=>({...chapter,title:shortTitle(chapter.title),blocks:chapter.blocks.map(block=>block.type==='image'?{...block,resource:`assets/${block.resource}`}:block)});
export function checkedPublicationView(row,book){
 const manifest=makePublicationManifest(row,book),bytes=Buffer.from(canonicalJson(manifest));
 if(!row.publication_manifest||canonicalJson(manifest)!==canonicalJson(row.publication_manifest)||sha256(bytes)!==row.publication_sha256)reject('Версия публикации не соответствует сохранённому договору');
 return {manifest,bytes,structure:structureFor(book)};
}
