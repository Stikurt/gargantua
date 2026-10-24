import {createHash} from 'node:crypto';
import {validateBook,digest} from './publication-files.mjs';
import {structureFor,canonicalJson} from './publication-model.mjs';
const stable=(prefix,value)=>prefix+createHash('sha256').update(value).digest('hex').slice(0,32);
const short=(value,max=300)=>{let result='';for(const character of String(value)){if(result.length+character.length>max)break;result+=character;}return result;};
const bad=message=>Object.assign(new Error(message),{code:'RANOBE_PUBLICATION_INVALID',blocked:true});
export const RANOBE_PART_CHAPTERS=50,RANOBE_PART_TARGET=12*1024*1024;

/** Each chapter gets an identity independent of its ordinal or part boundaries.
 * References remain local to that parsed chapter; external links stay inert. */
export function bindRanobeChapter(book,{feedId,key,title,author,language,chapterTitle}){
 validateBook(book);if(book.chapters.length!==1)throw bad('Ожидалась одна проверенная глава');
 const copy=structuredClone(book),structure=structureFor(copy),chapter=structure.chapters[0],ids=new Map(chapter.blocks.map(block=>[block.id,stable('b-rb-',`${feedId}|${key}|${block.id}`)]));
 chapter.id=stable('c-rb-',`${feedId}|${key}`);chapter.title=short(chapterTitle);
 for(const block of chapter.blocks){
  block.id=ids.get(block.id);
  if(block.referenceId){if(!ids.has(block.referenceId))throw bad('Ссылка главы указывает за пределы её проверенного содержимого');block.referenceId=ids.get(block.referenceId);}
  for(const span of block.spans??[])if(span.target){if(!ids.has(span.target))throw bad('Ссылка главы не подтверждена');span.target=ids.get(span.target);}
 }
 copy.title=short(title);copy.author=short(author);copy.language=language;copy.chapters[0].title=short(chapterTitle);copy.structure=structure;
 delete copy.sourceMetadata;validateBook(copy);return copy;
}

/** Materialize one chapter from an already hash-verified immutable part. */
export function extractRanobeChapter(book,index){
 validateBook(book);if(!Number.isInteger(index)||index<0||index>=book.chapters.length)throw bad('Отсутствует сохранённая глава');
 const chapter=structuredClone(book.chapters[index]),structured=structuredClone(structureFor(book).chapters[index]),names=new Set();
 for(const block of chapter.blocks)if(block.type==='image')names.add(block.asset);
 for(const block of structured.blocks)if(block.type==='image')names.add(block.resource);
 const assets=Object.fromEntries([...names].map(name=>{if(!book.assets[name])throw bad('Отсутствует сохранённая иллюстрация');return [name,book.assets[name]];}));
 const result={title:book.title,author:book.author,language:book.language,chapters:[chapter],assets,structure:{schemaVersion:2,chapters:[structured],warnings:[...(book.structure?.warnings??['LEGACY_STRUCTURE_ONLY'])]}};
 validateBook(result);return result;
}

export function assembleRanobePart(chapters,{title,author,language,first,last}){
 if(!chapters.length||chapters.length>RANOBE_PART_CHAPTERS)throw bad('Неверное число глав части');
 const result={title:short(`${title} — главы ${first}–${last}`),author:short(author),language,chapters:[],assets:{},structure:{schemaVersion:2,chapters:[],warnings:[]}},resources=new Map(),warnings=new Set();
 for(const book of chapters){
  validateBook(book);if(book.chapters.length!==1)throw bad('Составная глава должна быть проверена отдельно');const copied=structuredClone(book),mapping=new Map();
  for(const [oldName,encoded]of Object.entries(copied.assets)){
   const sha=digest(Buffer.from(encoded,'base64'));let name=resources.get(sha);
   if(!name){name=`image-${resources.size}.png`;resources.set(sha,name);result.assets[name]=encoded;}
   mapping.set(oldName,name);
  }
  for(const block of copied.chapters[0].blocks)if(block.type==='image')block.asset=mapping.get(block.asset);
  const structure=structureFor(copied);for(const block of structure.chapters[0].blocks)if(block.type==='image')block.resource=mapping.get(block.resource)??block.resource;
  for(const warning of structure.warnings)warnings.add(warning);
  result.chapters.push(copied.chapters[0]);result.structure.chapters.push(structure.chapters[0]);
 }
 result.structure.warnings=[...warnings].sort();validateBook(result);
 if(Buffer.byteLength(canonicalJson(result))>20*1024*1024)throw bad('Часть книги превышает безопасный размер');return result;
}

export function ranobePartWouldOverflow(chapters,next){
 if(chapters.length>=RANOBE_PART_CHAPTERS)return true;
 const values=[...chapters,next],bytes=values.reduce((sum,book)=>sum+Buffer.byteLength(canonicalJson(book)),0),assets=values.reduce((sum,book)=>sum+Object.keys(book.assets).length,0);
 return chapters.length>0&&(bytes+65536>RANOBE_PART_TARGET||assets>100);
}
