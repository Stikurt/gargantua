// Immutable chapter coverage is part of source identity, never a mutable job
// option. Source manifest v1 keeps its original whole-publication semantics.
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const ID=/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/u;
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>record(value)&&Object.keys(value).length===keys.length&&Object.keys(value).every(key=>keys.includes(key));
const invalid=(message='Неверный диапазон глав',status=400,code='DERIVED_CHAPTER_RANGE')=>Object.assign(new Error(message),{status,code});
const broken=()=>invalid('Закреплённый диапазон глав не соответствует исходной публикации',423,'DERIVED_SELECTION_INTEGRITY');
export const DEFAULT_CHAPTER_BATCH=5,MAX_TRANSLATION_CHAPTERS=5,MAX_AUDIO_CHAPTERS=50;

export function requestedChapterRange(value,kind='translation'){
 if(!['translation','audio'].includes(kind))throw invalid();
 const range=value===undefined?{start:1,count:DEFAULT_CHAPTER_BATCH}:value;
 if(!exact(range,['start','count'])||!Number.isSafeInteger(range.start)||range.start<1||range.start>20000000||!Number.isSafeInteger(range.count)||range.count<1||range.count>(kind==='audio'?MAX_AUDIO_CHAPTERS:MAX_TRANSLATION_CHAPTERS))throw invalid();
 return {start:range.start,count:range.count};
}
export function normalizedChapterRange(value,total,kind='translation'){
 const range=requestedChapterRange(value,kind);
 if(!Number.isSafeInteger(total)||total<1||total>20000000)throw broken();
 if(range.start>total)throw invalid('Начальная глава находится за концом закреплённой книги');
 return {start:range.start,count:Math.min(range.count,total-range.start+1)};
}
function partCounts(parts){
 if(!Array.isArray(parts)||!parts.length||parts.length>20000)throw broken();
 let total=0;const offsets=[];
 for(const [index,part]of parts.entries()){
  if(!record(part)||part.ordinal!==index||!UUID.test(part.publicationId??'')||!Number.isSafeInteger(part.chapterCount)||part.chapterCount<1||part.chapterCount>1000)throw broken();
  offsets.push(total);total+=part.chapterCount;
 }
 if(total>20000000)throw broken();
 return {total,offsets};
}
export function sourceChapterSelection(source){
 const manifest=source?.manifest;
 if(!manifest||manifest.schemaVersion===1){if(manifest&&Object.hasOwn(manifest,'selection'))throw broken();return null;}
 if(manifest.schemaVersion!==2)throw broken();
 const value=manifest.selection,{total,offsets}=partCounts(manifest.parts);
 if(!exact(value,['schemaVersion','start','count','total','chapters'])||value.schemaVersion!==1||value.total!==total||!Number.isSafeInteger(value.start)||value.start<1||!Number.isSafeInteger(value.count)||value.count<1||value.count>MAX_AUDIO_CHAPTERS||value.start+value.count-1>total||!Array.isArray(value.chapters)||value.chapters.length!==value.count)throw broken();
 const seen=new Set();
 for(const [index,chapter]of value.chapters.entries()){
  if(!exact(chapter,['ordinal','partIndex','publicationId','chapterIndex','chapterId'])||chapter.ordinal!==value.start-1+index||!Number.isSafeInteger(chapter.partIndex)||chapter.partIndex<0||chapter.partIndex>=manifest.parts.length||!Number.isSafeInteger(chapter.chapterIndex)||chapter.chapterIndex<0||chapter.chapterIndex>=manifest.parts[chapter.partIndex].chapterCount||chapter.publicationId!==manifest.parts[chapter.partIndex].publicationId||chapter.ordinal!==offsets[chapter.partIndex]+chapter.chapterIndex||!ID.test(chapter.chapterId??'')||seen.has(chapter.publicationId+'|'+chapter.chapterId))throw broken();
  seen.add(chapter.publicationId+'|'+chapter.chapterId);
 }
 return value;
}
export function makeChapterSelection(books,value,kind='translation'){
 if(!Array.isArray(books)||!books.length||books.length>20000)throw broken();
 let total=0;const offsets=[];
 for(const book of books){
  const order=book?.publication_manifest?.readingOrder,count=book?.chapter_count;
  if(!UUID.test(book?.id??'')||!Number.isSafeInteger(count)||count<1||count>1000||!Array.isArray(order)||order.length!==count)throw broken();
  offsets.push(total);total+=count;
 }
 const range=normalizedChapterRange(value,total,kind);
 const chapters=[];
 for(const [partIndex,book]of books.entries()){
  const first=Math.max(0,range.start-1-offsets[partIndex]),last=Math.min(book.chapter_count,range.start-1+range.count-offsets[partIndex]);
  for(let chapterIndex=first;chapterIndex<last;chapterIndex++){
   const entry=book.publication_manifest.readingOrder[chapterIndex];if(!ID.test(entry?.chapterId??''))throw broken();
   chapters.push({ordinal:offsets[partIndex]+chapterIndex,partIndex,publicationId:book.id,chapterIndex,chapterId:entry.chapterId});
  }
 }
 return {schemaVersion:1,...range,total,chapters};
}
export function assertSelectionBooks(source,books=source.parts){
 const selection=sourceChapterSelection(source);if(!selection)return null;
 const expected=makeChapterSelection(books,{start:selection.start,count:selection.count},'audio');
 if(['schemaVersion','start','count','total'].some(key=>selection[key]!==expected[key])||selection.chapters.some((entry,index)=>Object.keys(entry).some(key=>entry[key]!==expected.chapters[index]?.[key])))throw broken();
 return selection;
}
export function selectedChapterIndices(source,partIndex,chapters){
 if(!Array.isArray(chapters)||!Number.isSafeInteger(partIndex)||partIndex<0||!source?.parts?.[partIndex])throw broken();
 const selection=sourceChapterSelection(source);if(!selection)return chapters.map((_,index)=>index);
 const publicationId=source.parts[partIndex].id,selected=selection.chapters.filter(chapter=>chapter.publicationId===publicationId);
 for(const entry of selected)if(chapters[entry.chapterIndex]?.id!==entry.chapterId)throw broken();
 return selected.map(chapter=>chapter.chapterIndex);
}
export function selectedPartIndices(source){
 const selection=sourceChapterSelection(source);if(!selection)return source.parts.map((_,index)=>index);
 const ids=new Set(selection.chapters.map(chapter=>chapter.publicationId));
 return source.parts.flatMap((part,index)=>ids.has(part.id)?[index]:[]);
}
export function publicChapterRange(manifest){
 if(!manifest)return undefined;
 const selected=sourceChapterSelection({manifest});
 const total=selected?.total??partCounts(manifest.parts).total,start=selected?.start??1,count=selected?.count??total,hasMore=start+count-1<total;
 return {start,count,total,hasMore,nextStart:hasMore?start+count:null};
}
