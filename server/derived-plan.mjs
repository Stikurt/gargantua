import {canonicalJson,sha256,structureFor} from './publication-model.mjs';
import {validateBook,validateDerivation} from './publication-files.mjs';
import {derivedUuid,validateDerivedText} from './derived-files.mjs';
import {sourceChapterSelection,selectedChapterIndices,selectedPartIndices} from './derived-selection.mjs';

const bad=message=>Object.assign(new Error(message),{code:'DERIVED_UNSUPPORTED_STRUCTURE',status:409});
const MAX=700;
/** Budget before allocating all accepted outputs for one source publication. */
export function assertDerivedPartBudget(part,checkpoints){
 const sourceBytes=Number(part?.content_bytes),outputBytes=checkpoints.reduce((sum,row)=>sum+Number(row.output_bytes),0);
 if(!Number.isSafeInteger(sourceBytes)||sourceBytes<1||!Number.isSafeInteger(outputBytes)||outputBytes<1||outputBytes>8*1024*1024||sourceBytes+4*outputBytes+65536>32*1024*1024)throw Object.assign(new Error('Перевод этой части требует более мелкого разбиения; оригинал и сохранённые фрагменты не изменены'),{code:'DERIVED_RESULT_TOO_LARGE',status:409});
 return {sourceBytes,outputBytes};
}
export function assertDerivedManifestBudget(plan,parts){
 const count=plan?.segments?.length;
 // Fixed server-built segment fields, with <=512 UTF-8 bytes for scan version,
 // fit in 2 KiB each. Reserve the publication IDs and top-level envelope too.
 if(!Number.isSafeInteger(count)||count<1||!Number.isSafeInteger(parts)||parts<1||4096+2048*count+40*parts>16*1024*1024)throw Object.assign(new Error('План требует постраничного манифеста или более крупных исходных фрагментов; генерация ещё не запускалась'),{code:'DERIVED_MANIFEST_TOO_LARGE',status:409});
}
const short=(value,max)=>{let result='';for(const ch of value){if(result.length+ch.length>max)break;result+=ch;}return result;};
/** Unicode code-point ranges cover every source character once; no tokenizer truncation. */
export function splitDerivedText(text,max=MAX){
 if(typeof text!=='string'||!text.isWellFormed()||!Number.isInteger(max)||max<50||max>MAX)throw bad('Неверный текст сегментации');
 const chars=Array.from(text),units=[];let start=0;
 while(start<chars.length){let end=Math.min(start+max,chars.length);
  if(end<chars.length){let boundary=-1;for(let i=end;i>start+Math.floor(max/2);i--)if(/[\s]/u.test(chars[i-1])){boundary=i;break;}if(boundary>start)end=boundary;}
  const value=chars.slice(start,end).join('');units.push({start,end,text:value});start=end;
 }
 return units;
}
function checkedStructure(book,indices=null){
 validateBook(book);const structure=structureFor(book);
 for(const index of indices??structure.chapters.map((_,index)=>index)){
  const c=structure.chapters[index];if(!c)throw bad('Исходная глава отсутствует');
  for(const b of c.blocks){
  if(['table','ruby'].includes(b.type)||b.rows||b.spans?.some(s=>s.kind==='link'))throw bad('Таблицы, ruby и встроенные ссылки требуют отдельного профиля; оригинал сохранён');
  }
 }
 return structure;
}
export function makeDerivedPlan(source,contents,kind){
 if(!['translation','audio'].includes(kind)||contents.length!==source.parts.length)throw bad('Неверный набор исходных частей');
 const segments=[];
 for(let p=0;p<contents.length;p++){
  validateBook(contents[p]);const structure=structureFor(contents[p]),selected=selectedChapterIndices(source,p,structure.chapters);checkedStructure(contents[p],selected);
  if(kind==='translation'&&sourceChapterSelection(source)){
   const ids=new Set(selected.flatMap(index=>structure.chapters[index].blocks.map(block=>block.id)));
   for(const index of selected)for(const block of structure.chapters[index].blocks)if(block.referenceId&&!ids.has(block.referenceId))throw bad('Сноска находится за пределами выбранных глав; нужен пакет с её исходной главой');
  }
  for(const c of selected){
   const chapter=structure.chapters[c],items=[{blockIndex:-1,text:chapter.title},...chapter.blocks.map((b,i)=>({blockIndex:i,text:b.text}))];
   for(const item of items)for(const unit of splitDerivedText(item.text)){
    if(!unit.text.trim())continue;
    const locator={partIndex:p,publicationId:source.parts[p].id,chapterIndex:c,blockIndex:item.blockIndex,start:unit.start,end:unit.end};
    const sourceSha256=sha256(Buffer.from(unit.text)),ordinal=segments.length;
    segments.push({...locator,ordinal,id:derivedUuid(`${source.sha256}|${kind}|${canonicalJson(locator)}`),sourceSha256});
   }
  }
 }
 if(!segments.length||segments.length>50000)throw bad('Неподдерживаемый размер книги');
 const manifest={schemaVersion:1,segmentationRevision:'derived-unicode-v1',sourceSha256:source.sha256,kind,segments};
 return {segments:segments.length,sha256:sha256(Buffer.from(canonicalJson(manifest))),manifest};
}
export async function makeDerivedPlanStreaming(source,loadPart,kind){
 const segments=[];
 for(const p of selectedPartIndices(source)){
  const local=makeDerivedPlan({...source,parts:[source.parts[p]]},[await loadPart(p)],kind);
  for(const entry of local.manifest.segments){
   const {ordinal:ignored,id:ignoredId,sourceSha256,...locator}=entry;locator.partIndex=p;
   segments.push({...locator,ordinal:segments.length,id:derivedUuid(`${source.sha256}|${kind}|${canonicalJson(locator)}`),sourceSha256});
  }
 }
 if(!segments.length||segments.length>50000)throw bad('Неподдерживаемый размер книги');
 const manifest={schemaVersion:1,segmentationRevision:'derived-unicode-v1',sourceSha256:source.sha256,kind,segments};
 return {segments:segments.length,sha256:sha256(Buffer.from(canonicalJson(manifest))),manifest};
}
export function sourceUnit(contents,unit){
 const structure=checkedStructure(contents[unit.partIndex],[unit.chapterIndex]),chapter=structure.chapters[unit.chapterIndex];
 if(!chapter)throw bad('Исходная глава отсутствует');
 const text=unit.blockIndex===-1?chapter.title:chapter.blocks[unit.blockIndex]?.text;
 if(typeof text!=='string')throw bad('Исходный блок отсутствует');
 const value=Array.from(text).slice(unit.start,unit.end).join('');if(sha256(Buffer.from(value))!==unit.sourceSha256)throw bad('Исходный фрагмент изменён');return value;
}
export function translatedBooks(source,contents,plan,outputs,derivation=undefined){
 if(outputs.length!==plan.segments.length)throw bad('Перевод не завершён');
 if(derivation!==undefined){validateDerivation(derivation);if(derivation.sourceSha256!==source.sha256)throw bad('Метаданные перевода не соответствуют точному исходнику');}
 const copies=contents.map((book,index)=>{const original=structureFor(book),selected=selectedChapterIndices(source,index,original.chapters),structure=structuredClone(checkedStructure(book,selected));return {title:book.title,author:book.author,language:'ru',assets:structuredClone(book.assets),structure,chapters:[],...(derivation!==undefined?{derivation:structuredClone(derivation)}:{})};});
 const groups=new Map();
 for(const [i,unit] of plan.segments.entries()){
  if(typeof outputs[i]==='string'&&!outputs[i].isWellFormed())throw bad('Перевод содержит повреждённую Unicode-строку');
  const text=validateDerivedText(typeof outputs[i]==='string'?Buffer.from(outputs[i]):outputs[i]),key=`${unit.partIndex}|${unit.chapterIndex}|${unit.blockIndex}`;
  if(!groups.has(key))groups.set(key,[]);groups.get(key).push({unit,text});
 }
 for(const [key,list] of groups){
  const [p,c,b]=key.split('|').map(Number),original=b===-1?copies[p].structure.chapters[c].title:copies[p].structure.chapters[c].blocks[b].text;
  const chars=Array.from(original);let end=0,value='';
  for(const {unit,text} of list){const originalUnit=chars.slice(unit.start,unit.end).join(''),leading=/^\s*/u.exec(originalUnit)[0],trailing=/\s*$/u.exec(originalUnit)[0];value+=chars.slice(end,unit.start).join('')+leading+text.trim()+trailing;end=unit.end;}
  value+=chars.slice(end).join('');
  if(b===-1){if(value.length>300)throw bad('Переведённый заголовок превышает лимит; он не обрезан');copies[p].structure.chapters[c].title=value;}else copies[p].structure.chapters[c].blocks[b].text=value;
 }
 const selection=sourceChapterSelection(source),result=[];
 for(const [index,book]of copies.entries()){
  const selected=selectedChapterIndices(source,index,book.structure.chapters);if(!selected.length)continue;
  if(selection){
   book.structure.chapters=selected.map(chapter=>book.structure.chapters[chapter]);
   const resources=new Set(book.structure.chapters.flatMap(chapter=>chapter.blocks.filter(block=>block.type==='image').map(block=>block.resource)));
   book.assets=Object.fromEntries(Object.entries(book.assets).filter(([name])=>resources.has(name)));
  }
  const physical=selection?.chapters.filter(chapter=>chapter.publicationId===source.parts[index].id),suffix=physical?.length?` — главы ${physical[0].ordinal+1}–${physical.at(-1).ordinal+1} — машинный перевод`:' — машинный перевод';
  book.title=short(book.title,300-suffix.length)+suffix;
  const warnings=new Set(book.structure.warnings);warnings.add('MACHINE_TRANSLATION_DRAFT');
  for(const c of book.structure.chapters)for(const b of c.blocks)if(b.spans?.length){delete b.spans;warnings.add('MACHINE_TRANSLATION_INLINE_FORMATTING_OMITTED');}
  book.structure.warnings=[...warnings].slice(0,100);
  book.chapters=book.structure.chapters.map(c=>({title:c.title,blocks:c.blocks.map(b=>{if(b.type==='image'&&b.text.length>500)throw bad('Переведённая подпись слишком длинная; оригинал сохранён');return b.type==='image'?{type:'image',asset:b.resource,text:b.text}:{type:b.type==='heading'?'heading':'text',text:b.text};})}));
  validateBook(book);
  result.push(book);
 }
 return result;
}
