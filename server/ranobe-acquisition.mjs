import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {resolveRanobe,selectRanobeBranch,fetchRanobeChapter,extractRanobeImageUrls,sanitizeRanobeTransportError} from './ranobe.mjs';
import {fetchSafe} from './fetch.mjs';
import {scan,scannerVersion} from './scan.mjs';
import {writeParserJob,cleanupParserJob} from './job-files.mjs';
import {canonicalJson,sha256,checkedPublicationView} from './publication-model.mjs';
import {validateBook,textForScan,readPublication,readBoundedFile,durableWrite,stagePublication,placePublication} from './publication-files.mjs';
import {markPrepared,publishImport,failImport,renewImport} from './import-jobs.mjs';
import {beginRanobeRun,reuseUnchangedRanobeHead,getRanobeFeed,getRanobeChapters,getRanobeParts,saveRanobeChapter,beginRanobePart,commitRanobePart,reuseRanobePart,activateRanobeRun,assertRanobeRun,yieldRanobeRun,registerRanobeScratch,finishRanobeScratch,listStaleRanobeScratch,removeStaleRanobeScratch,ranobeChapterFingerprint,listDueRanobeFeeds,enqueueRanobeUpdate} from './ranobe-store.mjs';
import {bindRanobeChapter,extractRanobeChapter,assembleRanobePart,ranobePartWouldOverflow} from './ranobe-publication.mjs';
import {acquireImportAdmission,checkImportCapacity} from './import-admission.mjs';
import {retryRanobeSource} from './ranobe-source-retry.mjs';

export const RANOBE_POLICY='ranobe-isolated-chapter-v1';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const fail=(code,message)=>Object.assign(new Error(message),{code});
const hash=value=>sha256(Buffer.from(canonicalJson(value)));
const reviewCodes=new Set(['RANOBE_IDENTITY','RANOBE_INVENTORY','RANOBE_INCOMPLETE','RANOBE_RESTRICTED','RANOBE_CONTENT','RANOBE_INPUT','RANOBE_SOURCE_CHANGED']);

export function ranobeInventoryDescriptors(info,branch){
 return branch.chapters.map(chapter=>{
  const release=chapter.branches.find(item=>item.branchKey===branch.branchKey);
  const key=`ranobelib:${info.workId}:${branch.branchKey}:v${chapter.volume}:c${chapter.number}`;
  // A release ID/timestamp is only an upstream hint. Silent edits cannot be
  // detected without refetching; force=true explicitly revalidates every chapter.
  return {key,revisionHint:hash({releaseId:release.releaseId,updatedAt:release.updated_at,numberSecondary:chapter.number_secondary}),title:`Том ${chapter.volume}. Глава ${chapter.number}`,volume:chapter.volume,number:chapter.number};
 });
}

async function scanPrepared(book,{signal,scanBytes=scan,version=scannerVersion}){
 validateBook(book);await scanBytes(textForScan(book),{signal});
 for(const data of Object.values(book.assets))await scanBytes(Buffer.from(data,'base64'),{signal});
 return version({signal});
}

export async function parseRanobeChapter(pool,parent,run,key,bundle,{quarantine,jobs,signal,allowed,scanBytes=scan,version=scannerVersion}={}){
 const raw=Buffer.from(JSON.stringify(bundle));if(raw.length>20*1024*1024)throw fail('RANOBE_CONTENT','Глава и иллюстрации превышают безопасный размер');
 const token=randomUUID(),rawSha256=sha256(raw),input=path.join(quarantine,'attempts',token);let parsed;
 await registerRanobeScratch(pool,parent,run.id,{token,key,rawSha256});
 try{
  await fs.mkdir(path.dirname(input),{recursive:true,mode:0o700});await durableWrite(input,raw);
  await scanBytes(raw,{signal});await allowed();
  await writeParserJob(jobs,{id:token,inputId:token,inputScope:'attempts',inputSha256:rawSha256,extension:'ranobe',filename:'RanobeLib chapter'});
  const deadline=Date.now()+65000;
  while(Date.now()<deadline){
   signal?.throwIfAborted();await allowed();
   try{parsed=JSON.parse((await readBoundedFile(path.join(jobs,'results',token+'.json'),25*1024*1024)).toString('utf8'));break;}catch(error){if(error.code!=='ENOENT')throw error;}
   await sleep(300);
  }
  if(!parsed)throw fail('RANOBE_PARSER_TIMEOUT','Изолированный разбор главы не завершён вовремя');
  if(parsed.attemptToken!==token||parsed.sha256!==rawSha256)throw fail('RANOBE_IDENTITY','Результат парсера не соответствует полученному входу');
  if(!parsed.ok)throw Object.assign(new Error(parsed.error||'Парсер отклонил главу'),{code:'RANOBE_PARSER_REJECTED',blocked:true});
  validateBook(parsed.book);const scanner=await scanPrepared(parsed.book,{signal,scanBytes,version});return {book:parsed.book,rawSha256,scanner};
 }finally{
  // UUID scratch is registered before the first write. A crash/lease loss leaves
  // a tracked object for the next worker; no raw input is stored in PostgreSQL.
  let cleaned=true;try{await cleanupParserJob(jobs,token);}catch{cleaned=false;}
  try{await fs.unlink(input);}catch(error){if(error.code!=='ENOENT')cleaned=false;}
  // Without a committed result, the runner may still be finishing its bounded
  // child after cancellation. Keep the tracker for delayed stale cleanup.
  if(cleaned&&parsed)await finishRanobeScratch(pool,parent,run.id,token).catch(()=>{});
 }
}

async function verifiedBook(library,row){const checked=await readPublication(library,row);checkedPublicationView(row,checked.content);return checked.content;}

export async function processRanobeFull(pool,parent,{quarantine,jobs,library,signal,allowed,waitResources,stage,record,report,adapter={resolveRanobe,fetchRanobeChapter},fetchImage=fetchSafe,scanBytes=scan,version=scannerVersion,parseChapter=parseRanobeChapter,maxPartsPerSlice=1}={}){
 let activeChild;
 try{
  report.sourceRetryCount=Math.max(report.sourceRetryCount??0,parent.report?.sourceRetryCount??0);
  await waitResources();await stage('RanobeLib: полное оглавление и выбранная ветка');
  const sourceCall=operation=>retryRanobeSource(operation,{signal,allowed,stage,report});
  const info=await sourceCall(()=>adapter.resolveRanobe(parent.source_url,{signal})),branchId=parent.options.branch===null?null:Number(parent.options.branch),branch=selectRanobeBranch(info,branchId,{requireComplete:true}),descriptors=ranobeInventoryDescriptors(info,branch);
  const feed=await getRanobeFeed(pool,parent.options.feedId);if(!feed||feed.remote_id!==info.workId||String(feed.branch_key)!==(branchId===null?'default':String(branchId)))throw fail('RANOBE_IDENTITY','Подписка не соответствует выбранной книге и ветке');
  report.source={provider:'ranobelib',slug:info.slug,branch:branchId,feedId:feed.id,coverage:'source-inventory-snapshot',observedChapters:descriptors.length,originalWorkComplete:false,languageBasis:'configured-by-request-not-provided-by-source',inventoryCompleteness:info.completeness};
  await record('RanobeLib: оглавление получено; проверка изменений');
  const unchanged=await reuseUnchangedRanobeHead(pool,parent,{title:info.title,author:info.author,chapters:descriptors,policyVersion:RANOBE_POLICY,signal,verifyBook:row=>verifiedBook(library,row)});
  if(unchanged)return unchanged;
  const run=await beginRanobeRun(pool,parent,{title:info.title,author:info.author,chapters:descriptors,policyVersion:RANOBE_POLICY});
  if(run.policy_version!==RANOBE_POLICY)throw fail('RANOBE_SOURCE_CHANGED','Нужна новая проверка после изменения политики парсера');
  const fresh=new Map(descriptors.map((item,index)=>[item.key,{descriptor:item,chapter:branch.chapters[index]}]));
  report.source={provider:'ranobelib',slug:info.slug,branch:branchId,feedId:feed.id,runId:run.id,coverage:'source-inventory-snapshot',targetChapters:run.chapter_count,observedChapters:descriptors.length,originalWorkComplete:false,languageBasis:'configured-by-request-not-provided-by-source',sourceInventorySha256:run.inventory_sha256,inventoryCompleteness:info.completeness};
  await record(info.completeness.counterMismatch?'RanobeLib: два одинаковых снимка оглавления; счётчик карточки отстаёт, ветка зафиксирована':'RanobeLib: оглавление подтверждено счётчиком источника; ветка зафиксирована');
  const previous=run.previous_head_id?await getRanobeParts(pool,run.previous_head_id):[],previousByFirst=new Map(previous.filter(item=>item.status==='ready').map(item=>[item.source_keys[0],item]));
  let parts=await getRanobeParts(pool,run.id),covered=0,finishedParts=0;
  for(const part of parts){if(part.status!=='ready')break;if(part.ordinal!==covered)throw fail('RANOBE_SOURCE_CHANGED','Непоследовательный checkpoint частей');covered+=part.source_keys.length;}
  let cachedId,cachedBook;
  const load=async row=>{
   let book=row.prepared_book;
   if(!book){
    if(!row.book_id)throw fail('RANOBE_SOURCE_CHANGED','Отсутствует проверенный checkpoint главы');
    if(cachedId!==row.book_id){const stored=(await pool.query('SELECT * FROM books WHERE id=$1 AND security_state=\'passed\'',[row.book_id])).rows[0];if(!stored)throw fail('RANOBE_SOURCE_CHANGED','Сохранённая часть недоступна');cachedBook=await verifiedBook(library,stored);cachedId=stored.id;}
    book=extractRanobeChapter(cachedBook,row.chapter_index);
   }
   validateBook(book);if(book.chapters.length!==1||ranobeChapterFingerprint(book)!==row.content_sha256)throw fail('RANOBE_SOURCE_CHANGED','Checkpoint главы не прошёл проверку целостности');return book;
  };
  while(covered<run.chapter_count){
   await allowed();await waitResources();
   // A growing novel must recheck the guest filesystem between parts too;
   // host/VHDX free space alone does not prove guest space is available.
   while(true){try{await checkImportCapacity(pool,quarantine,library,{exclude:parent.id});break;}catch(error){if(error.status===423)throw fail('IMPORT_PAUSED','Импорт приостановлен');if(error.status!==507)throw error;await stage('RanobeLib: ожидание места для следующей части');await sleep(5000);await allowed();}}
   const window=await getRanobeChapters(pool,run.id,{after:covered-1,limit:50});if(!window.length)throw fail('RANOBE_INCOMPLETE','Оглавление checkpoint неполно');
   const chapters=[],keys=[];
   for(let row of window){
    await allowed();await waitResources();
    if(!row.chapter_id){
     const current=fresh.get(row.source_key);if(!current||current.descriptor.revisionHint!==row.revision_hint)throw fail('RANOBE_SOURCE_CHANGED','Источник изменил главу во время получения; предыдущая версия сохранена');
     await stage(`RanobeLib: глава ${row.ordinal+1} из ${run.chapter_count}`);
     const response=await sourceCall(()=>adapter.fetchRanobeChapter(info,current.chapter,branchId,{signal}));await scanBytes(response.raw,{signal});await scanBytes(Buffer.from(response.data.content),{signal});
     if(!response.data.identityVerified||response.data.sourceChapterKey!==row.source_key)throw fail('RANOBE_IDENTITY','Источник вернул другую главу');
     const bundle={title:info.title,author:info.author,language:feed.language,chapters:[{title:row.metadata.title,html:response.data.content}],images:{}};let imageBytes=0;
     for(const image of extractRanobeImageUrls(response.data.content,{slug:info.slug,releaseId:response.data.releaseId})){
      await allowed();const result=await sourceCall(async()=>{try{return await fetchImage(image.url,{maxBytes:4*1024*1024,maxRedirects:0,signal,headers:{Referer:'https://ranobelib.me/',Accept:'image/png,image/jpeg,image/webp'}});}catch(error){throw sanitizeRanobeTransportError(error);}});await scanBytes(result.buffer,{signal});imageBytes+=result.buffer.length;
      if(imageBytes>12*1024*1024)throw fail('RANOBE_CONTENT','Иллюстрации одной главы превышают лимит');bundle.images[image.ref]=result.buffer.toString('base64');
     }
     const prepared=await parseChapter(pool,parent,run,row.source_key,bundle,{quarantine,jobs,signal,allowed,scanBytes,version});
     const bound=bindRanobeChapter(prepared.book,{feedId:feed.id,key:row.source_key,title:info.title,author:info.author,language:feed.language,chapterTitle:row.metadata.title});
     const checkpoint=await saveRanobeChapter(pool,parent,run.id,row.source_key,{book:bound,rawSha256:prepared.rawSha256,scannerVersion:prepared.scanner,parserVersion:RANOBE_POLICY});row={...row,...checkpoint,source_key:row.source_key,ordinal:row.ordinal};
    }
    const book=await load(row);if(ranobePartWouldOverflow(chapters,book))break;chapters.push(book);keys.push(row.source_key);
   }
   if(!keys.length)throw fail('RANOBE_CONTENT','Главу нельзя сохранить в пределах безопасного размера части');
   const old=previousByFirst.get(keys[0]);let committed=false;
   if(old&&JSON.stringify(old.source_keys)===JSON.stringify(keys)){
    try{await reuseRanobePart(pool,parent,run.id,{keys,bookId:old.book_id,title:info.title,verifyBook:row=>verifiedBook(library,row)});committed=true;}
    catch(error){if(error.code!=='RANOBE_PART_HASH')throw error;}
   }
   if(!committed){
    const book=assembleRanobePart(chapters,{title:info.title,author:info.author,language:feed.language,first:covered+1,last:covered+keys.length});
    // The parent lease is renewed during long antivirus/image checks. Create
    // the short publication attempt only after those checks have finished.
    const scanner=await scanPrepared(book,{signal,scanBytes,version});await allowed();
    activeChild=await beginRanobePart(pool,parent,run.id,{keys,title:book.title});
    if(activeChild.status!=='completed'){
     const childReport={sha256:hash(keys.map((key,index)=>({key,contentSha256:ranobeChapterFingerprint(chapters[index])}))),source:report.source,policy:RANOBE_POLICY,checks:[]};
     childReport.scanner=scanner;
     await allowed();await renewImport(pool,activeChild);
     const prepared=await stagePublication(library,activeChild.attempt_token,activeChild.resultBookId,book);await markPrepared(pool,activeChild,prepared.manifest);await allowed();await placePublication(library,prepared);await markPrepared(pool,activeChild,prepared.manifest,'placed');
     await readPublication(library,{id:prepared.id,chapter_count:book.chapters.length,artifact_manifest:prepared.manifest,content_sha256:prepared.contentSha256,content_bytes:prepared.contentBytes,package_sha256:prepared.packageSha256});
     const source={provider:'ranobelib',remoteId:info.workId,variant:`branch:${branchId??'default'}:${feed.language}`,kind:'human-translation',label:`RanobeLib: ветка ${branchId??'основная'}`,coverage:{kind:'source-inventory-part',feedId:feed.id,runId:run.id,first:covered+1,count:keys.length,total:run.chapter_count,keys}};
     await publishImport(pool,activeChild,book,prepared,childReport,{source,guard:client=>assertRanobeRun(client,parent,run.id,{sourceKeys:keys}),verifyExisting:row=>readPublication(library,row)});
    }
    const actual=(await pool.query('SELECT book_id FROM imports WHERE id=$1',[activeChild.id])).rows[0];await commitRanobePart(pool,parent,run.id,{keys,bookId:actual.book_id,verifyBook:row=>verifiedBook(library,row)});activeChild=null;
   }
   covered+=keys.length;finishedParts++;report.progress={chapters:covered,total:run.chapter_count};await record(`RanobeLib: сохранено ${covered} из ${run.chapter_count} глав`);await stage(`RanobeLib: сохранено ${covered} из ${run.chapter_count} глав`);
   if(covered<run.chapter_count&&finishedParts>=maxPartsPerSlice){await yieldRanobeRun(pool,parent,run.id);return {yielded:true,runId:run.id,chapters:covered};}
  }
  await allowed();const activated=await activateRanobeRun(pool,parent,run.id,{verifyBook:row=>verifiedBook(library,row)});
  if(hash(descriptors)!==run.inventory_sha256)await pool.query('UPDATE ranobe_feeds SET next_check_at=now() WHERE id=$1 AND head_run_id=$2',[feed.id,run.id]);
  return activated;
 }catch(error){
  if(activeChild)await failImport(pool,activeChild,error,{policy:RANOBE_POLICY,parentId:parent.id}).catch(()=>{});
  if(reviewCodes.has(error.code))throw Object.assign(error,{code:'IDENTITY_REVIEW'});throw error;
 }
}

export async function reconcileRanobeScratch(pool,{quarantine,jobs}){
 for(const scratch of await listStaleRanobeScratch(pool)){
  await cleanupParserJob(jobs,scratch.token);await fs.unlink(path.join(quarantine,'attempts',scratch.token)).catch(error=>{if(error.code!=='ENOENT')throw error;});await removeStaleRanobeScratch(pool,scratch.token);
 }
}
export async function scheduleRanobeUpdates(pool,{quarantine,library}){
 for(const feed of await listDueRanobeFeeds(pool)){
  let release;try{release=await acquireImportAdmission(pool);await enqueueRanobeUpdate(pool,feed.id,{checkCapacity:client=>checkImportCapacity(client,quarantine,library)});}catch(error){if(![423,429,507].includes(error.status))throw error;return;}finally{if(release)await release();}
 }
}
