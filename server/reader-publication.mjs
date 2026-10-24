import {readPublication} from './publication-files.mjs';
import {checkedPublicationView} from './publication-model.mjs';
import {assertDerivedPublication} from './derived-jobs.mjs';
import {readerUuid,readerDataError,validateReaderLocator} from './reader-data-model.mjs';

const bad=message=>{throw readerDataError('READER_LOCATOR',message,400);};
const unavailable=()=>readerDataError('READER_PUBLICATION_INTEGRITY','Книга временно недоступна: сохранённые файлы не прошли проверку целостности.',423);
const boundary=(text,offset)=>offset>=0&&offset<=text.length&&!(offset>0&&offset<text.length&&/[\uD800-\uDBFF]/.test(text[offset-1])&&/[\uDC00-\uDFFF]/.test(text[offset]));

function quoteAt(text,quote,offset){
 const end=offset+quote.exact.length;
 if(!boundary(text,offset)||!boundary(text,end)||text.slice(offset,end)!==quote.exact)bad('Текстовый якорь не совпадает с указанным местом книги');
 if(quote.prefix!==undefined&&(offset<quote.prefix.length||text.slice(offset-quote.prefix.length,offset)!==quote.prefix))bad('Начало контекста текстового якоря не совпадает');
 if(quote.suffix!==undefined&&text.slice(end,end+quote.suffix.length)!==quote.suffix)bad('Конец контекста текстового якоря не совпадает');
}

/** Validate against the immutable public structure, never a scroll estimate.
 * The caller supplies already verified book bytes; checkedPublicationView also
 * binds the derived structure to the stored immutable manifest/hash. */
export function validatePublicationLocator(book,row,value){
 const locator=validateReaderLocator(value),publicationId=readerUuid(row.id),view=checkedPublicationView(row,book);
 if(!Number.isSafeInteger(row.chapter_count)||row.chapter_count!==view.structure.chapters.length)throw unavailable();
 if(locator.type==='legacy'){
  if(locator.chapter>=view.structure.chapters.length)bad('Глава сохранённой позиции отсутствует в этой версии книги');
  return locator;
 }
 if(locator.publicationId!==publicationId||locator.publicationRevision!==view.manifest.revision)bad('Локатор относится к другой книге или версии');
 const chapter=view.structure.chapters.find(item=>item.id===locator.chapterId);
 if(!chapter)bad('Глава локатора отсутствует в этой версии книги');
 if(locator.blockId===undefined)return locator;
 const block=chapter.blocks.find(item=>item.id===locator.blockId);
 if(!block)bad('Блок локатора отсутствует в указанной главе');
 const text=block.text;
 if(locator.offset!==undefined&&!boundary(text,locator.offset))bad('Смещение выходит за текст или разрезает символ');
 if(locator.quote!==undefined){
  let offset=locator.offset;
  if(offset===undefined){
   offset=text.indexOf(locator.quote.exact);
   if(offset<0||text.indexOf(locator.quote.exact,offset+1)>=0)bad('Для повторяющегося или отсутствующего текстового якоря нужно точное смещение');
  }
  quoteAt(text,locator.quote,offset);
 }
 return locator;
}

/** No network, parser, raw HTML or client path is involved. When called by a
 * sync transaction, all permission/source guards use that same DB client. */
export async function verifyReaderPublication(pool,publicationId,locator,{publicationRevision=1,client}={}){
 const id=readerUuid(publicationId),normalized=validateReaderLocator(locator);
 if(publicationRevision!==1)bad('Поддерживается неизменяемая версия публикации 1');
 if(normalized.type!=='legacy'&&(normalized.publicationId!==id||normalized.publicationRevision!==publicationRevision))bad('Локатор относится к другой книге или версии');
 const database=client??pool;
 const row=(await database.query('SELECT b.*,s.serving_paused FROM books b CROSS JOIN settings s WHERE b.id=$1 AND s.id=1 FOR SHARE OF b,s',[id])).rows[0];
 if(!row)throw readerDataError('READER_PUBLICATION','Публикация не найдена',404);
 if(row.security_state!=='passed'||row.serving_paused!==false)throw readerDataError('READER_PUBLICATION_BLOCKED','Выдача книги приостановлена проверкой безопасности или владельцем',423);
 await assertDerivedPublication(pool,id,{client});
 let content;
 try{({content}=await readPublication(process.env.LIBRARY_DIR||'/library',row));}
 catch{throw unavailable();}
 try{return validatePublicationLocator(content,row,normalized);}
 catch(error){if(error.code==='PUBLICATION_STRUCTURE')throw unavailable();throw error;}
}
