import {canonicalJson,sha256,structureFor} from './publication-model.mjs';
import {validateBook} from './publication-files.mjs';
import {derivedUuid} from './derived-files.mjs';
import {selectedChapterIndices,selectedPartIndices} from './derived-selection.mjs';

// A server recipe must explicitly select this revision. Existing v1 recipes,
// plans, checkpoints and translation segmentation keep their original identity.
export const PACKED_AUDIO_SEGMENTATION='audio-unicode-ranges-v2';
export const PACKED_AUDIO_CHARACTERS=700;
export const PACKED_AUDIO_PLAN_BYTES=14*1024*1024;
const HASH=/^[a-f0-9]{64}$/;
const bad=message=>Object.assign(new Error(message),{code:'DERIVED_UNSUPPORTED_STRUCTURE',status:409});
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&Object.keys(value).every(key=>keys.includes(key));

function checked(book,indices=null){
 validateBook(book);const structure=structureFor(book);
 for(const index of indices??structure.chapters.map((_,index)=>index)){const chapter=structure.chapters[index];if(!chapter)throw bad('Исходная глава отсутствует');for(const block of chapter.blocks)if(['table','ruby'].includes(block.type)||block.rows||block.spans?.some(span=>span.kind==='link'))throw bad('Таблицы, ruby и встроенные ссылки требуют отдельного профиля; оригинал сохранён');}
 return structure;
}
function boundary(chars,start,available){
 let end=Math.min(start+available,chars.length);
 if(end===chars.length)return end;
 // Prefer a sentence boundary in the latter half. Whitespace is the fallback;
 // offsets remain Unicode code points and cover the source without truncation.
 const floor=start+Math.floor(available/2);let whitespace=-1;
 for(let i=end;i>floor;i--)if(/\s/u.test(chars[i-1])){
  if(whitespace<0)whitespace=i;
  let j=i-2;while(j>=start&&/["'»”’\)\]]/u.test(chars[j]))j--;
  if(j>=start&&/[.!?…]/u.test(chars[j]))return i;
 }
 return whitespace>start?whitespace:end;
}
function addPart(source,book,partIndex,segments){
 validateBook(book);const structure=structureFor(book),selected=selectedChapterIndices(source,partIndex,structure.chapters);checked(book,selected);
 for(const [chapterIndex,chapter]of structure.chapters.entries()){
  if(!selected.includes(chapterIndex))continue;
  const items=[{blockIndex:-1,text:chapter.title},...chapter.blocks.map((block,blockIndex)=>({blockIndex,text:block.text}))];
  let ranges=[],pieces=[],characters=0;
  const flush=()=>{
   if(!ranges.length)return;
   const text=pieces.join('\n\n'),locator={partIndex,publicationId:source.parts[partIndex].id,chapterIndex,ranges};
   if(!text.trim()){ranges=[];pieces=[];characters=0;return;}
   if(Array.from(text).length>PACKED_AUDIO_CHARACTERS)throw bad('Неверная длина фрагмента озвучивания');
   segments.push({...locator,ordinal:segments.length,id:derivedUuid(`${source.sha256}|audio|${PACKED_AUDIO_SEGMENTATION}|${canonicalJson(locator)}`),sourceSha256:sha256(Buffer.from(text))});
   if(segments.length>50000)throw bad('Неподдерживаемый размер книги');
   ranges=[];pieces=[];characters=0;
  };
  for(const item of items){
   if(!item.text.trim())continue;const chars=Array.from(item.text);let start=0;
   while(start<chars.length){
    let available=PACKED_AUDIO_CHARACTERS-characters-(ranges.length?2:0);
    // Avoid needlessly cutting a new paragraph into a tiny remainder.
    if(available<=0||available<50&&chars.length-start>available){flush();available=PACKED_AUDIO_CHARACTERS;}
    const end=boundary(chars,start,available),text=chars.slice(start,end).join('');
    ranges.push({blockIndex:item.blockIndex,start,end,sha256:sha256(Buffer.from(text))});pieces.push(text);characters+=(pieces.length>1?2:0)+(end-start);start=end;
    if(start<chars.length)flush();
   }
  }
  flush();
 }
}
function seal(source,segments){
 if(!segments.length)throw bad('Неподдерживаемый размер книги');
 const manifest={schemaVersion:1,segmentationRevision:PACKED_AUDIO_SEGMENTATION,sourceSha256:source.sha256,kind:'audio',segments},bytes=Buffer.from(canonicalJson(manifest));
 // Leave headroom for PostgreSQL's expanded JSONB representation. No inference
 // or source mutation has happened when this bounded planning check rejects.
 if(bytes.length>PACKED_AUDIO_PLAN_BYTES)throw Object.assign(new Error('План диапазонов озвучивания превышает безопасный размер; исходник сохранён'),{code:'DERIVED_MANIFEST_TOO_LARGE',status:409});
 return {segments:segments.length,sha256:sha256(bytes),manifest};
}
function sourceShape(source){if(!source||!HASH.test(source.sha256||'')||!Array.isArray(source.parts)||!source.parts.length||source.parts.length>20000||source.parts.some(part=>typeof part?.id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(part.id)))throw bad('Неверный набор исходных частей озвучивания');}
export function makePackedAudioPlan(source,contents){
 sourceShape(source);if(!Array.isArray(contents)||contents.length!==source.parts.length)throw bad('Неверный набор исходных частей озвучивания');
 const segments=[];contents.forEach((book,index)=>addPart(source,book,index,segments));return seal(source,segments);
}
export async function makePackedAudioPlanStreaming(source,loadPart){
 sourceShape(source);if(typeof loadPart!=='function')throw bad('Нет загрузчика исходных частей озвучивания');
 const segments=[];for(const index of selectedPartIndices(source))addPart(source,await loadPart(index),index,segments);return seal(source,segments);
}
export function packedAudioSourceUnit(contents,unit){
 if(!unit||!Number.isSafeInteger(unit.partIndex)||unit.partIndex<0||!Number.isSafeInteger(unit.chapterIndex)||unit.chapterIndex<0||!Array.isArray(unit.ranges)||!unit.ranges.length||unit.ranges.length>PACKED_AUDIO_CHARACTERS||!HASH.test(unit.sourceSha256||''))throw bad('Неверный диапазон исходного аудиофрагмента');
 const book=contents[unit.partIndex];if(!book)throw bad('Исходная часть отсутствует');
 const chapter=checked(book,[unit.chapterIndex]).chapters[unit.chapterIndex];if(!chapter)throw bad('Исходная глава отсутствует');
 const pieces=[];let previous=-2;
 for(const range of unit.ranges){
  if(!exact(range,['blockIndex','start','end','sha256'])||!Number.isSafeInteger(range.blockIndex)||range.blockIndex< -1||range.blockIndex<=previous||!Number.isSafeInteger(range.start)||!Number.isSafeInteger(range.end)||range.start<0||range.end<=range.start||!HASH.test(range.sha256||''))throw bad('Неверный диапазон исходного блока');
  const text=range.blockIndex===-1?chapter.title:chapter.blocks[range.blockIndex]?.text;if(typeof text!=='string')throw bad('Исходный блок отсутствует');
  const chars=Array.from(text);if(range.end>chars.length)throw bad('Диапазон вышел за пределы исходного блока');
  const piece=chars.slice(range.start,range.end).join('');if(sha256(Buffer.from(piece))!==range.sha256)throw bad('Исходный фрагмент изменён');pieces.push(piece);previous=range.blockIndex;
 }
 const value=pieces.join('\n\n');if(!value.trim()||Array.from(value).length>PACKED_AUDIO_CHARACTERS||sha256(Buffer.from(value))!==unit.sourceSha256)throw bad('Исходный фрагмент изменён');return value;
}
