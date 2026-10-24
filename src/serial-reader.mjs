// A reading projection only. Publication identities, chapter offsets within a
// publication, stored bookmarks and original book packets are never rewritten.
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail=(message,code='SERIAL_READER_CONTEXT')=>{throw Object.assign(new Error(message),{code});};
function inert(value){if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value))||Object.values(Object.getOwnPropertyDescriptors(value)).some(field=>!Object.hasOwn(field,'value')))fail('Недопустимое объединённое оглавление');}
function headers(value,count){
 if(!Array.isArray(value)||value.length!==count)fail('Количество заголовков не соответствует части книги');
 return value.map((chapter,index)=>{inert(chapter);if(chapter.index!==index||typeof chapter.title!=='string'||chapter.title.length>300||!chapter.title.isWellFormed())fail('Некорректный заголовок главы');return {index,title:chapter.title};});
}
function marksFor(data,parts){
 const active=data.book.id,all=[...(Array.isArray(data.serialBookmarks)?data.serialBookmarks.filter(mark=>mark?.publicationId!==active):[]),...(Array.isArray(data.bookmarks)?data.bookmarks:[]).map(mark=>({...mark,publicationId:active}))],seen=new Set(),rows=[];
 for(const mark of all){
  if(!mark||typeof mark!=='object'||typeof mark.id!=='string')continue;const part=parts.find(part=>part.publicationId===mark.publicationId);if(!part||!Number.isSafeInteger(mark.chapter)||mark.chapter<0||mark.chapter>=part.chapterCount||!Number.isFinite(mark.position)||mark.position<0||mark.position>1)continue;
  const key=mark.publicationId+':'+mark.id;if(seen.has(key))continue;seen.add(key);rows.push({...mark,note:typeof mark.note==='string'?mark.note.slice(0,500):'',globalIndex:part.chapterOffset+mark.chapter,available:part.available});
 }
 return rows;
}
export function serialReaderModel(data,index){
 const book=data?.book;if(!UUID.test(book?.id||''))fail('Некорректная исходная публикация');
 const physical=headers(data.chapters,data.chapters?.length);if(!physical.length||physical.length>1000||!Number.isSafeInteger(index)||index<0||index>=physical.length)fail('Некорректная глава исходной части');
 let parts,title=book.title,author=book.author,totalChapters=physical.length,group=null;
 if(data.serialGroup){
  group=data.serialGroup;inert(group);
  if(group.schemaVersion!==1||!UUID.test(group.id||'')||!UUID.test(group.snapshotId||'')||group.provider!=='ranobelib'||typeof group.title!=='string'||group.title.length>300||!group.title.isWellFormed()||typeof group.author!=='string'||group.author.length>300||!group.author.isWellFormed()||!Number.isSafeInteger(group.totalChapters)||group.totalChapters<1||group.totalChapters>20000||!Array.isArray(group.parts)||!group.parts.length||group.parts.length>20000)fail('Неполные метаданные объединённой книги');
  const identities=new Set();let end=0;
  parts=group.parts.map(part=>{
   inert(part);if(!UUID.test(part.publicationId||'')||identities.has(part.publicationId)||!Number.isSafeInteger(part.chapterOffset)||part.chapterOffset<end||!Number.isSafeInteger(part.chapterCount)||part.chapterCount<1||part.chapterCount>1000||part.chapterOffset+part.chapterCount>group.totalChapters||!['passed','blocked','pending'].includes(part.securityState))fail('Части объединённой книги пересекаются или повреждены');
   identities.add(part.publicationId);end=part.chapterOffset+part.chapterCount;
   if(part.chapters!==undefined&&!Array.isArray(part.chapters))fail('Некорректные заголовки части книги');
   const current=part.publicationId===book.id,chapters=current?physical:part.chapters?.length?headers(part.chapters,part.chapterCount):[];
   if(current&&part.chapterCount!==physical.length)fail('Активная часть не соответствует объединённому оглавлению');
   return {...part,chapters,available:part.securityState==='passed'&&(current||part.available===true)&&chapters.length===part.chapterCount};
  });
  if(!identities.has(book.id))fail('Активная публикация относится к другому снимку книги');title=group.title;author=group.author||book.author;totalChapters=group.totalChapters;
 }else parts=[{publicationId:book.id,chapterOffset:0,chapterCount:physical.length,chapters:physical,available:true}];
 const toc=Array.from({length:totalChapters},(_,globalIndex)=>({globalIndex,publicationId:null,index:null,title:`Глава ${globalIndex+1} — ещё не подготовлена`,available:false}));
 for(const part of parts)for(let local=0;local<part.chapterCount;local++)toc[part.chapterOffset+local]={globalIndex:part.chapterOffset+local,publicationId:part.publicationId,index:local,title:part.chapters[local]?.title||`Глава ${part.chapterOffset+local+1}`,available:part.available};
 const current=parts.find(part=>part.publicationId===book.id),globalIndex=current.chapterOffset+index;
 return {group,title,author,totalChapters,globalIndex,toc,parts,bookmarks:marksFor(data,parts),previous:globalIndex?toc[globalIndex-1]:null,next:globalIndex+1<totalChapters?toc[globalIndex+1]:null};
}
export function serialReaderTarget(model,globalIndex,position=0){
 if(!Number.isSafeInteger(globalIndex)||globalIndex<0||globalIndex>=model.toc.length||!Number.isFinite(position)||position<0||position>1)fail('Некорректный переход к главе','SERIAL_READER_TARGET');
 const target=model.toc[globalIndex];if(!target.available||!UUID.test(target.publicationId||''))fail('Эта часть книги ещё не сохранена или недоступна. Скачайте книгу целиком при доступном сервере.','SERIAL_READER_UNAVAILABLE');
 return {publicationId:target.publicationId,index:target.index,position};
}

/** Shared with the real Reader: flush before a cross-part load, then expose a
 * generation fence and a second flush immediately before the parent commits. */
export function createSerialReaderNavigator({flush,openPart,onBusy=()=>{}}){
 if(typeof flush!=='function'||typeof openPart!=='function')throw Error('Reading transition callbacks required');
 let generation=0,disposed=false,busy=false;
 const invalidate=()=>{generation++;busy=false;if(!disposed)onBusy(false);};
 async function open(target){
  if(disposed||busy)return false;const token=++generation;busy=true;onBusy(true);const isCurrent=()=>!disposed&&generation===token;
  try{await flush();if(!isCurrent())return false;const result=await openPart(target,{isCurrent,beforeCommit:async()=>{if(!isCurrent())return false;await flush();return isCurrent();}});return isCurrent()&&result!==false;}
  finally{if(isCurrent()){busy=false;onBusy(false);}}
 }
 return {open,invalidate,isBusy:()=>busy,dispose:()=>{disposed=true;generation++;busy=false;}};
}
