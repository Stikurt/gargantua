import {readDownloadedResponse,validateBookContent} from './book-download.mjs';
import {commitLocalBook} from './library-state.mjs';
import {validateSerialGroup,rememberSerialGroups} from './serial-groups.mjs';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export function discoveryPublications(row){
 if(row?.outputs?.book?.status!=='ready')throw Error('Текст ещё не готов');
 const book=row.outputs.book,translation=row.outputs.translation;
 const original=book.publicationIds??[book.publicationId];
 const translated=translation?.status==='ready'?(translation.publicationIds||[]):[];
 if(translation?.status==='ready'&&(!Array.isArray(translated)||!translated.length))throw Error('Сервер не указал публикации готового перевода');
 if(!Array.isArray(original)||!original.length||!Array.isArray(translated)||original.length+translated.length>20000||[...original,...translated].some(id=>!uuid.test(id||'')))throw Error('Сервер не указал точные публикации книги');
 return [...new Set([...original,...translated].map(id=>id.toLowerCase()))];
}
// Each verified immutable part commits separately. A later failure keeps earlier
// parts available, and a retry reuses them instead of downloading them again.
export async function downloadDiscoveryBook({row,profile,connect,api,storage,onProgress=()=>{},serialGroups=[]}){
 if(!uuid.test(profile?.id||''))throw Error('Нужен профиль для получения книги');
 const ids=discoveryPublications(row);
 const groups=serialGroups.filter(group=>group.parts.some(part=>ids.includes(part.publicationId))).map(validateSerialGroup);
 const checkProfile=async()=>{if((await connect()).id!==profile.id)throw Error('Профиль сменился. Обновите поиск перед скачиванием.');};
 await checkProfile();
 if(groups.length)await rememberSerialGroups(storage,profile.id,groups);
 let saved=0,reused=0;
 for(const id of ids){
  try{
   await checkProfile();
   const binding=groups.flatMap(group=>group.parts).find(part=>part.publicationId===id);
   const checkBinding=book=>{if(binding&&(binding.securityState!=='passed'||book.chapter_count!==binding.chapterCount||book.content_sha256!==binding.contentSha256||book.package_sha256!==binding.packageSha256))throw Error('Публикация не соответствует проверенному снимку объединённой книги');};
   const packet=await storage.get(`${profile.id}:book:${id}`);
   if(packet){
    if(packet.book?.id!==id||packet.book?.owner!==profile.id||packet.book?.scope!=='server')throw Error('Локальная копия относится к другой книге или профилю');
    if(packet.book.security_state!=='passed')throw Error('Локальная копия не имеет подтверждённого статуса проверки. Удалите эту копию через библиотеку и скачайте заново');
    checkBinding(packet.book);
    validateBookContent(packet.content);
    if(packet.book.title!==packet.content.title||packet.book.author!==packet.content.author||packet.book.chapter_count!==packet.content.chapters.length)throw Error('Карточка локальной книги не соответствует тексту');
    await checkProfile();
    await commitLocalBook(storage,{owner:profile.id,book:packet.book,content:packet.content,scope:'server'});reused++;
   }
   else{
    const detail=await api(`/books/${id}`),book=detail.book;
    if(book?.id!==id||book.security_state!=='passed')throw Error('Публикация недоступна или не прошла проверку');
    checkBinding(book);
    const response=await api(`/books/${id}/download`,{raw:true}),verified=await readDownloadedResponse(response,book);
    await checkProfile();
    await commitLocalBook(storage,{owner:profile.id,book:{...book,content_sha256:verified.sha256,content_bytes:verified.bytes},content:verified.content,scope:'server'});saved++;
   }
   onProgress({saved,reused,completed:saved+reused,total:ids.length});
  }catch(error){throw Object.assign(Error(`Сохранено ${saved+reused} из ${ids.length}. ${error.message}. Повторное скачивание продолжит с оставшихся частей.`),{cause:error,saved,reused,total:ids.length});}
 }
 return {saved,reused,total:ids.length};
}
export async function downloadSerialGroup({group,profile,connect,api,storage,onProgress=()=>{}}){
 group=validateSerialGroup(group);const parts=group.parts.filter(part=>part.securityState==='passed');
 if(!parts.length)throw Error('У этой книги ещё нет проверенных глав');
 const result=await downloadDiscoveryBook({row:{outputs:{book:{status:'ready',multipart:true,publicationIds:parts.map(part=>part.publicationId)}}},profile,connect,api,storage,onProgress,serialGroups:[group]});
 const headers={};for(const part of parts){const packet=await storage.get(`${profile.id}:book:${part.publicationId}`);if(packet.book.content_sha256!==part.contentSha256||packet.book.chapter_count!==part.chapterCount)throw Error('Скачанная часть не соответствует выбранному снимку');headers[part.publicationId]=packet.content.chapters.map((chapter,index)=>({index,title:chapter.title}));}
 await rememberSerialGroups(storage,profile.id,[group],{headers:{[group.id]:headers}});
 const availableChapters=parts.reduce((sum,part)=>sum+part.chapterCount,0);return {...result,availableChapters,totalChapters:group.totalChapters,complete:group.snapshotStatus==='ready'&&availableChapters===group.totalChapters};
}
