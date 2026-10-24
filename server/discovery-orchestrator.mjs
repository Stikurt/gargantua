import {randomUUID,createHash} from 'node:crypto';
import {interpretDiscoveryQuery,searchDiscovery,searchSelectedDiscovery,gutenbergDownloadSelection,canContinueDiscoveryPlan} from './discovery-providers.mjs';
import {findLocalDiscoveryPlan,reuseDiscoveredSources} from './discovery-library.mjs';
import {finishDiscoveryRequest,failDiscoveryRequest,renewDiscoveryRequest,withDiscoveryAcquisition,withDiscoverySourceAcquisition,completeDiscoveryFromLibrary,syncDiscoveryImport} from './discovery-requests.mjs';
import {acquireImportAdmission,checkImportCapacity} from './import-admission.mjs';
import {readPublication} from './publication-files.mjs';
import {checkedPublicationView} from './publication-model.mjs';
import {resolveRanobe,selectRanobeBranch} from './ranobe.mjs';
import {createRanobeRequestInTransaction} from './ranobe-store.mjs';

const failure=(code,message)=>Object.assign(new Error(message),{code});
const digest=value=>createHash('sha256').update(value).digest('hex').slice(0,32);
export async function libraryDiscoveryPlan(pool,row){
 const input=row.input,parsed=interpretDiscoveryQuery(input.query,{intent:input.intent});
 if(parsed.intent!=='book')return null;
 return findLocalDiscoveryPlan(pool,input,{titles:parsed.titleAliases,authors:parsed.authorHint?[parsed.authorHint.name,...(parsed.authorHint.aliases??[])]:[]});
}

export function acquisitionSelection(candidate){
 if(candidate?.kind!=='book'||candidate.identity?.provider!=='gutendex'||candidate.availability!=='fetchable'||!candidate.eligibleForAcquisition||candidate.blockedReason||candidate.conflictingMetadata||candidate.identityEvidenceIncomplete||candidate.sourceBinding?.copyright!==false)throw failure('DISCOVERY_NEEDS_REVIEW','Нужен проверенный источник книги; автоматическое скачивание не разрешено');
 const selected=candidate.downloadSelections?.find(item=>item.extension==='epub')??candidate.downloadSelections?.find(item=>item.extension==='txt');
 if(!selected||selected.expected?.provider!=='gutenberg'||selected.expected.remoteId!==candidate.identity.remoteId)throw failure('DISCOVERY_NEEDS_REVIEW','Привязка файла к выбранной книге не подтверждена');
 const allowed=gutenbergDownloadSelection(selected.originalUrl,selected.mimeType,candidate.identity.remoteId);
 if(!allowed||allowed.url!==selected.url||allowed.extension!==selected.extension||selected.maxRedirects!==0||selected.requiresQuarantine!==true)throw failure('DISCOVERY_NEEDS_REVIEW','Источник файла больше не соответствует политике адаптера');
 if(selected.expected.title!==candidate.title||JSON.stringify(selected.expected.authors)!==JSON.stringify(candidate.authors.map(author=>author.name))||!selected.expected.language)throw failure('DISCOVERY_NEEDS_REVIEW','Недостаточно однозначных метаданных файла');
 return selected;
}

// `request` is the live DB row supplied by withDiscoveryAcquisition, never a
// client claim or request body. A reader's accepted discovery already authorizes
// this persisted source selection, so importing it needs no second approval.
async function transferOwnerApproval(client,request,result){
 if(result.import.status!=='pending-approval'||!request.approved_by)return;
 const owner=(await client.query("SELECT id FROM profiles WHERE id=$1 AND role='owner' FOR SHARE",[request.approved_by])).rows[0];if(!owner)return;
 // The feed row is locked by creation/sharing. Never wait for a parent import
 // held by a worker following parent -> feed ordering.
 let pending;try{pending=(await client.query("SELECT id,requested_by FROM imports WHERE id=$1 AND status='pending-approval' AND kind='ranobe' AND options->>'mode'='full' FOR UPDATE NOWAIT",[result.import.id])).rows[0];}catch(error){if(error.code==='55P03')throw Object.assign(failure('DISCOVERY_IMPORT_BUSY','Заявка меняется; повторите действие'),{status:409});throw error;}
 if(!pending)return;
 await client.query("UPDATE imports SET status='queued',approved_by=$1,decision_reason='discovery-owner-approval',error=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$2",[owner.id,pending.id]);
 await client.query("INSERT INTO audit(actor,action,target,details) VALUES($1,'import.discovery-owner-approved',$2,$3)",[owner.id,pending.id,JSON.stringify({discoveryRequestId:request.id,feedId:result.feed.id,requestedBy:pending.requested_by})]);
}

export async function buildDiscoveryPlan(pool,row,{signal,search=searchDiscovery,searchSelected=searchSelectedDiscovery}={}){
 const selection=row.plan?.candidates?.find(item=>item.id===row.selected_candidate_id);
 const options={language:row.input.language,allowOriginal:row.input.allowOriginal,signal};
 if(row.plan?.continuationRequested===true){
  if(!canContinueDiscoveryPlan(row.plan))throw failure('DISCOVERY_CONTINUATION','Продолжение не соответствует сохранённому плану поиска');
  return reuseDiscoveredSources(pool,await search(row.input.query,{...options,intent:row.input.intent,continuation:row.plan.plan.continuation}),row.input);
 }
 if(selection?.identity?.provider==='ranobelib'&&selection.availability==='needs-preview'){
  const binding=selection.sourceBinding,info=await resolveRanobe(`https://ranobelib.me/ru/book/${binding.slug}`,{signal});
  if(info.workId!==selection.identity.remoteId)throw failure('DISCOVERY_NEEDS_REVIEW','Источник вернул другую книгу');
  const candidates=[];let hasMore=false;
  for(const summary of info.branches){
   if(candidates.length>=20){hasMore=true;break;}
   try{const branch=selectRanobeBranch(info,summary.id,{requireComplete:true});candidates.push({id:`dsc_${digest(`ranobelib:${info.workId}:${branch.branchKey}`)}`,identity:{provider:'ranobelib',remoteId:info.workId},kind:'book',title:info.title,authors:info.author?[{name:info.author,remoteId:null}]:[],languages:[],languageEvidence:'not-provided-by-source',availability:'ranobe-full',eligibleForAcquisition:true,downloadSelections:[],branchLabel:summary.label,chapterCount:branch.chapters.length,sourceBinding:{provider:'ranobelib',remoteId:info.workId,slug:info.slug,branchId:summary.id,completeness:info.completeness}});}catch(error){if(!['RANOBE_RESTRICTED','RANOBE_INCOMPLETE'].includes(error.code))throw error;}
  }
  return {query:row.input.query,intent:'book',language:row.input.language,allowOriginal:row.input.allowOriginal,metadataOnly:true,candidates,clarifications:[{code:'CHOOSE_RANOBE_BRANCH',message:'Выберите ветку перевода. Источник не подтверждает язык; книга будет сохранена с пометкой неизвестного языка до отдельной проверки.',candidateIds:candidates.map(candidate=>candidate.id)},...(hasMore?[{code:'MORE_RANOBE_BRANCHES',message:'Показаны первые 20 веток. Полный список доступен через предпросмотр RanobeLib.',candidateIds:[]}]:[])],providerErrors:[],hasMore,status:candidates.length?'needs_clarification':'not_found',selectedCandidateId:null,nextAction:'none',plan:{kind:'ranobe-branches',scope:'source-inventory-snapshot',originalWorkComplete:false}};
 }
 if(selection?.kind==='author')return searchSelected(selection,options);
 if(selection?.kind==='book'&&['openlibrary','curated'].includes(selection.identity?.provider)){
  // A selected catalogue work fixes the author context. Never fall back to the
  // original broad query (or to a different same-title local book).
  const local=await findLocalDiscoveryPlan(pool,row.input,{titles:[selection.title],authors:(selection.authors??[]).map(author=>author.name),requireAuthor:true,context:{provider:selection.identity.provider,remoteId:selection.identity.remoteId,scope:'selected-work-local-match'}});
  if(local)return local;
  return reuseDiscoveredSources(pool,await searchSelected(selection,options),row.input);
 }
 const local=await libraryDiscoveryPlan(pool,row);if(local)return local;
 return reuseDiscoveredSources(pool,await search(row.input.query,{...options,intent:row.input.intent}),row.input);
}

export async function acquireDiscovery(pool,claim,{quarantine,library,verifyLocal=async book=>{const bytes=await readPublication(library,book);checkedPublicationView(book,bytes.content);}}){
 const candidate=claim.plan?.candidates?.find(item=>item.id===claim.selected_candidate_id);
 if(candidate?.identity?.provider==='library'){
  return completeDiscoveryFromLibrary(pool,claim,candidate.bookId,{verifyExisting:verifyLocal});
 }
 if(candidate?.identity?.provider==='ranobelib'&&candidate.availability==='ranobe-full'){
  const binding=candidate.sourceBinding;
  if(!binding||binding.provider!=='ranobelib'||binding.remoteId!==candidate.identity.remoteId||binding.slug?.split('--')[0]!==binding.remoteId||!Object.hasOwn(binding,'branchId')||binding.completeness?.verified!==true)throw failure('DISCOVERY_NEEDS_REVIEW','Ветка источника не подтверждена');
  const release=await acquireImportAdmission(pool);try{return await withDiscoveryAcquisition(pool,claim,async(client,row)=>{
   const result=await createRanobeRequestInTransaction(client,{id:row.requested_by},{url:`https://ranobelib.me/ru/book/${binding.slug}`,branch:binding.branchId,language:'und',autoUpdate:true,force:false,idempotencyKey:row.id},{checkCapacity:database=>checkImportCapacity(database,quarantine,library)});await transferOwnerApproval(client,row,result);return result.import.id;
  });}finally{await release();}
 }
 const selected=acquisitionSelection(candidate),release=await acquireImportAdmission(pool);
 try{return await withDiscoverySourceAcquisition(pool,claim,selected,async(client,row)=>{
  await checkImportCapacity(client,quarantine,library);
  const id=randomUUID(),sourceIdentity={provider:'gutenberg',remoteId:candidate.identity.remoteId,variant:`gutenberg:${candidate.identity.remoteId}:${selected.expected.language}`,kind:'unclassified',label:'Project Gutenberg',coverage:{kind:'source-file'}};
  const options={discovery:{requestId:row.id,planRevision:row.plan_revision,candidateId:candidate.id,expected:selected.expected,download:{url:selected.url,originalUrl:selected.originalUrl,mimeType:selected.mimeType,maxRedirects:0},sourceIdentity}};
  await client.query("INSERT INTO imports(id,requested_by,kind,filename,source_url,status,approved_by,decision_reason,options) VALUES($1,$2,'file',$3,$4,'queued',$5,$6,$7)",[id,row.requested_by,`gutenberg-${candidate.identity.remoteId}.${selected.extension}`,selected.url,row.approved_by,row.decision_reason,JSON.stringify(options)]);
  await client.query("INSERT INTO audit(actor,action,target,details) VALUES($1,'import.discovery-request',$2,$3)",[row.requested_by,id,JSON.stringify({discoveryRequestId:row.id,candidateId:candidate.id,provider:'gutenberg',remoteId:candidate.identity.remoteId})]);return id;
 },{verifyExisting:verifyLocal});}finally{await release();}
}

export async function processDiscovery(pool,claim,{signal,quarantine,library,search,searchSelected,verifyLocal}={}){
 const controller=new AbortController(),abort=()=>controller.abort(signal.reason??failure('WORKER_STOPPING','Обработчик остановлен'));
 if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
 let checking=false,heartbeatError;
 const heartbeat=setInterval(async()=>{if(checking)return;checking=true;try{await renewDiscoveryRequest(pool,claim);}catch(error){heartbeatError=error;controller.abort(error);}finally{checking=false;}},5000);heartbeat.unref();
 try{
  controller.signal.throwIfAborted();
  const settings=(await pool.query('SELECT imports_paused FROM settings WHERE id=1')).rows[0];if(settings.imports_paused)throw failure('IMPORT_PAUSED','Импорт приостановлен');
  if(claim.phase==='discovery'){
   const plan=await buildDiscoveryPlan(pool,claim,{signal:controller.signal,search,searchSelected});controller.signal.throwIfAborted();
   // Provider failures are not evidence that the requested book does not exist.
   // Retain the bounded durable backoff instead of ending in an empty choice.
   const temporary=(plan.providerErrors??[]).some(item=>item.retryable===true||item.code==='DEADLINE');
   if(temporary&&!plan.candidates?.length&&['unavailable','incomplete'].includes(plan.status))throw failure('DISCOVERY_SOURCE_UNAVAILABLE','Источники временно недоступны. Поиск будет повторён с ограничением попыток.');
   return await finishDiscoveryRequest(pool,claim,plan);
  }
  controller.signal.throwIfAborted();return await acquireDiscovery(pool,claim,{quarantine,library,verifyLocal});
 }catch(error){return await failDiscoveryRequest(pool,claim,heartbeatError??(controller.signal.aborted?controller.signal.reason:error));}
 finally{clearInterval(heartbeat);signal?.removeEventListener('abort',abort);}
}

export async function syncDiscoveryImports(pool){
 const rows=(await pool.query("SELECT d.id FROM discovery_requests d WHERE d.status='acquiring' OR d.status='needs-review' AND d.outputs->'book'->>'status'='identity-review' AND EXISTS(SELECT 1 FROM imports i WHERE i.id=d.import_id AND i.kind='ranobe' AND i.options->>'mode'='full' AND i.status IN('queued','processing','completed')) ORDER BY d.updated_at LIMIT 30")).rows;
 for(const row of rows)await syncDiscoveryImport(pool,row.id);return rows.length;
}
