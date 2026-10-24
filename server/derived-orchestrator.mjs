import fs from 'node:fs/promises';
import path from 'node:path';
import {canonicalJson,sha256} from './publication-model.mjs';
import {readPublication,stagePublication,placePublication,readBoundedFile,textForScan} from './publication-files.mjs';
import {sealPublicationModel} from './work-model.mjs';
import {scannerVersion,scan} from './scan.mjs';
import {registerDerivedRecipe,createDerivedRequest,claimDerivedJob,assertDerivedAttempt,renewDerivedJob,setDerivedPlan,listDerivedCheckpoints,checkpointDerivedJob,pauseDerivedJob,failDerivedJob,finishDerivedJob,getDerivedResult} from './derived-jobs.mjs';
import {makeDerivedPlanStreaming,sourceUnit,translatedBooks,assertDerivedPartBudget,assertDerivedManifestBudget} from './derived-plan.mjs';
import {PACKED_AUDIO_SEGMENTATION,makePackedAudioPlanStreaming,packedAudioSourceUnit} from './derived-audio-plan.mjs';
import {derivedUuid,storeDerivedSegment,readDerivedSegment,writeDerivedManifest,validateDerivedText,validateDerivedWav} from './derived-files.mjs';
import {executorState,executorIsIdle,createInferenceInput,verifyInferenceReceipt,retireInferenceInput} from './derived-spool.mjs';
import {detectPublicationLanguage,languageSourceSetSha,currentLanguageDetection} from './discovery-language.mjs';
import {selectedPartIndices,publicChapterRange} from './derived-selection.mjs';

const fail=(message,code)=>Object.assign(new Error(message),{code});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export async function derivedProfiles(){return JSON.parse(await fs.readFile(new URL('../inference/profiles.json',import.meta.url),'utf8'));}
function checkedGlossary(glossary){
 if(!glossary||typeof glossary!=='object'||Array.isArray(glossary)||Object.keys(glossary).length>30||Object.entries(glossary).some(([k,v])=>typeof v!=='string'||!k||!v||Array.from(k).length>80||Array.from(v).length>80||!k.isWellFormed()||!v.isWellFormed()))throw fail('Неверный словарь','DERIVED_GLOSSARY');
 return glossary;
}
export function derivedSegmentationRevision(kind,recipe){
 const revision=recipe?.segmentationRevision;
 if(revision==='derived-unicode-v1'||kind==='audio'&&revision===PACKED_AUDIO_SEGMENTATION)return revision;
 throw fail('Неизвестная версия сегментации закреплённого рецепта','DERIVED_UNSUPPORTED_STRUCTURE');
}
export async function derivedPlanForRecipe(source,load,kind,recipe){
 return derivedSegmentationRevision(kind,recipe)===PACKED_AUDIO_SEGMENTATION?makePackedAudioPlanStreaming(source,load):makeDerivedPlanStreaming(source,load,kind);
}
export function derivedSourceUnitForRecipe(contents,unit,kind,recipe){
 if(derivedSegmentationRevision(kind,recipe)===PACKED_AUDIO_SEGMENTATION)return packedAudioSourceUnit(contents,unit);
 if(unit?.ranges!==undefined)throw fail('Диапазоны озвучивания не соответствуют старому рецепту','DERIVED_UNSUPPORTED_STRUCTURE');
 return sourceUnit(contents,unit);
}
export async function recipeFor(pool,kind,{glossary={}}={}){
 const profiles=await derivedProfiles(),row=profiles.profiles[kind==='audio'?'tts':'translation'];
 if(!row||!/^[a-f0-9]{64}$/.test(row.profileSha256)||!/^[a-f0-9]{64}$/.test(row.providerRecipeSha256))throw fail('Профиль локальной модели недоступен','DERIVED_PROFILE');
 checkedGlossary(glossary);
 return registerDerivedRecipe(pool,{kind,language:'ru',manifest:{schemaVersion:1,profileId:row.descriptor.id,profileSha256:row.profileSha256,providerRecipeSha256:row.providerRecipeSha256,profileDescriptor:row.descriptor,segmentationRevision:kind==='audio'?PACKED_AUDIO_SEGMENTATION:'derived-unicode-v1',normalizationRevision:'identity-v1',glossary:kind==='translation'?glossary:{}}});
}
export async function verifyDerivedSource(library,source){for(const row of source.parts)await readPublication(library,row);return true;}
function sourceLoader(library,source){let last=-1,value=null;return async index=>{if(index!==last){value=(await readPublication(library,source.parts[index])).content;last=index;}return value;};}
const loadUnit=async(load,unit,claim)=>derivedSourceUnitForRecipe([await load(unit.partIndex)],{...unit,partIndex:0},claim.kind,claim.recipe.manifest);
export async function requestDerived(pool,profile,input,{library}={}){
 const {glossary={},...data}=input;checkedGlossary(glossary);
 // Stable intent keys (including discovery continuations) keep the recipe they
 // originally accepted. A software upgrade must neither fork a completed job
 // nor turn a retry into an idempotency conflict. The transaction below still
 // verifies all source/options fields against the original request body hash.
 const old=(await pool.query('SELECT recipe.* FROM derived_idempotency i JOIN derived_requests r ON r.id=i.request_id JOIN derived_jobs j ON j.id=r.job_id JOIN derived_recipes recipe ON recipe.sha256=j.recipe_sha256 WHERE i.profile_id=$1 AND i.key=$2',[profile.id,data.idempotencyKey])).rows[0];
 if(old&&(old.kind!==data.kind||canonicalJson(old.manifest.glossary??{})!==canonicalJson(data.kind==='translation'?glossary:{})))throw Object.assign(fail('Ключ уже использован с другим запросом.','DERIVED_IDEMPOTENCY'),{status:409});
 const recipe=old??await recipeFor(pool,data.kind,{glossary});
 return createDerivedRequest(pool,profile,{...data,recipeSha256:recipe.sha256},{verifySource:library?source=>verifyDerivedSource(library,source):undefined});
}
async function segmentRequest(claim,unit,load){
 const recipe=claim.recipe.manifest,text=await loadUnit(load,unit,claim),prior=[];
 if(claim.kind==='translation')for(let n=Math.max(0,unit.ordinal-2);n<unit.ordinal;n++){
  const previous=claim.plan.segments[n];if(previous.publicationId===unit.publicationId&&previous.chapterIndex===unit.chapterIndex)prior.push(Array.from(await loadUnit(load,previous,claim)).slice(-600).join(''));
 }
 return {schemaVersion:1,jobId:claim.id,segmentId:unit.id,attemptId:claim.attempt_token,kind:claim.kind==='audio'?'tts':'translation',profile:recipe.profileId,profileSha256:recipe.profileSha256,recipeSha256:claim.recipe_sha256,inputSha256:unit.sourceSha256,text,sourceLanguage:claim.kind==='translation'?'en':'ru',targetLanguage:'ru',...(claim.kind==='translation'?{previousSourceContext:prior,glossary:recipe.glossary}:{})};
}
async function waitStopped(runtime,request){
 for(let n=0;n<70;n++){const state=await executorState(runtime);if(state?.cleanupVerified===true&&state.state!=='running'&&state.state!=='blocked_cleanup')return true;await sleep(1000);}return false;
}
async function infer(pool,claim,unit,load,{spool,runtime,signal,allowed}){
 const state=await executorState(runtime);
 if(!executorIsIdle(state))throw fail('Ожидается локальный исполнитель','RESOURCE_PRESSURE');
 const request=await segmentRequest(claim,unit,load),invocation=await createInferenceInput(spool,request);let error=null,receipt=null,checking=false;
 await invocation.permit();
 const heartbeat=setInterval(async()=>{if(checking)return;checking=true;try{if(signal?.aborted)throw signal.reason||fail('Остановка','WORKER_STOPPING');await renewDerivedJob(pool,claim);await allowed?.();await invocation.permit();}catch(e){error=e;await invocation.permit(Date.now()-1).catch(()=>{});}finally{checking=false;}},4000);heartbeat.unref();
 try{
  const deadline=Date.now()+450000;
  while(Date.now()<deadline){
   if(error)throw error;if(signal?.aborted)throw signal.reason||fail('Остановка','WORKER_STOPPING');
   try{receipt=await invocation.result();break;}catch(e){if(e.code!=='ENOENT')throw e;}
   await sleep(500);
  }
  if(!receipt)throw fail('Исполнитель не ответил; попытка отложена','RESOURCE_PRESSURE');
  verifyInferenceReceipt(receipt,request,invocation.requestSha256,claim.recipe.manifest.providerRecipeSha256);
  if(receipt.status!=='completed'){
   if(receipt.retryable||receipt.status==='paused')throw fail('Пауза локального исполнителя: '+String(receipt.code).slice(0,80),'RESOURCE_PRESSURE');
   throw fail('Модель отклонила сегмент: '+String(receipt.code).slice(0,80),'DERIVED_PROVIDER_OUTPUT');
  }
  const bytes=await invocation.artifact(receipt);if(claim.kind==='translation')validateDerivedText(bytes);else validateDerivedWav(bytes);
  await assertDerivedAttempt(pool,claim);return {bytes,receipt,request,invocation};
 }finally{
  clearInterval(heartbeat);await invocation.permit(Date.now()-1).catch(()=>{});
  if(!receipt||receipt.cleanupVerified!==true)await waitStopped(runtime,request);
  if(receipt?.cleanupVerified===true)await retireInferenceInput(spool,request,receipt).catch(()=>{});
 }
}
async function placeTranslated(library,claim,source,books,scanner,offset=0){
 const items=[];
 for(let p=0;p<books.length;p++){
  const book=books[p],part=offset+p,id=derivedUuid(`translated-book|${claim.id}|${part}`),attemptId=derivedUuid(`translated-stage|${claim.id}|${claim.attempt_token}|${part}`);
  await scanner.scan(textForScan(book));for(const data of Object.values(book.assets))await scanner.scan(Buffer.from(data,'base64'));
  let prepared;
  try{
   const raw=await readBoundedFile(path.join(library,'books',id,'book.json'),32*1024*1024);
   if(!raw.equals(Buffer.from(JSON.stringify(book))))throw fail('Найден другой подготовленный перевод','DERIVED_INTEGRITY');
   const {inspectLegacyPublication}=await import('./publication-files.mjs');
   const checked=await inspectLegacyPublication(library,{id,title:book.title,author:book.author,language:book.language,chapter_count:book.chapters.length});
   prepared={id,attemptId,manifest:checked.manifest,contentSha256:checked.contentSha256,contentBytes:checked.contentBytes,packageSha256:checked.packageSha256};
  }catch(e){if(e.code!=='ENOENT')throw e;prepared=await stagePublication(library,attemptId,id,book);await placePublication(library,prepared);}
  await readPublication(library,{id,chapter_count:book.chapters.length,artifact_manifest:prepared.manifest,content_sha256:prepared.contentSha256,content_bytes:prepared.contentBytes,package_sha256:prepared.packageSha256});
  items.push({prepared,chapterCount:book.chapters.length,sourcePartIndex:part,editionId:derivedUuid(`translated-edition|${claim.id}|${part}`),importId:derivedUuid(`translated-import|${claim.id}|${part}`)});
 }
 return items;
}
async function insertTranslated(client,claim,source,items,library){
 const expressionId=derivedUuid(`translated-expression|${claim.id}`),variant=`machine:${claim.id}`;
 await client.query("INSERT INTO expressions(id,work_id,language,kind,variant_key,label,source_expression_id,recipe) VALUES($1,$2,'ru','machine-translation',$3,'Машинный перевод: черновик',$4,$5) ON CONFLICT(id) DO NOTHING",[expressionId,source.work_id,variant,source.expression_id,JSON.stringify({jobId:claim.id,sourceSha256:claim.source_sha256,recipeSha256:claim.recipe_sha256,quality:'machine-draft'})]);
 const actor=(await client.query("SELECT requested_by,approved_by FROM derived_requests WHERE job_id=$1 AND status='active' ORDER BY created_at,id LIMIT 1",[claim.id])).rows[0];if(!actor)throw fail('Нет разрешённой заявки','DERIVED_APPROVAL_REQUIRED');
 for(const {prepared,chapterCount,editionId,importId,sourcePartIndex:p} of items){
  const {content:book}=await readPublication(library,{id:prepared.id,chapter_count:chapterCount,artifact_manifest:prepared.manifest,content_sha256:prepared.contentSha256,content_bytes:prepared.contentBytes,package_sha256:prepared.packageSha256});
  await client.query('INSERT INTO editions(id,expression_id,source_kind,external_ids,coverage) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING',[editionId,expressionId,'machine-translation',JSON.stringify({derivedJobId:claim.id,sourcePublicationId:source.parts[p].id}),JSON.stringify({kind:'machine-translated-source-part',sourcePublicationId:source.parts[p].id,declaredChapters:book.chapters.length})]);
  await client.query("INSERT INTO imports(id,requested_by,kind,filename,status,stage,security_state,approved_by,decision_reason,book_id,report) VALUES($1,$2,'derived-translation',$3,'completed','Готов машинный черновик','passed',$4,'derived-owner-policy',$5,$6) ON CONFLICT(id) DO NOTHING",[importId,actor.requested_by,book.title,actor.approved_by,prepared.id,JSON.stringify({derivedJobId:claim.id,sourceSha256:claim.source_sha256,recipeSha256:claim.recipe_sha256})]);
  const inserted=(await client.query('INSERT INTO books(id,title,author,language,chapter_count,sha256,import_id,requested_by,content_sha256,content_bytes,package_sha256,artifact_manifest,work_id,expression_id,edition_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$6,$9,$10,$11,$12,$13,$14) ON CONFLICT(id) DO NOTHING RETURNING *',[prepared.id,book.title,book.author,'ru',book.chapters.length,prepared.contentSha256,importId,actor.requested_by,prepared.contentBytes,prepared.packageSha256,JSON.stringify(prepared.manifest),source.work_id,expressionId,editionId])).rows[0];
  if(inserted)await sealPublicationModel(client,inserted,book);
 }
 return expressionId;
}
async function finalize(pool,claim,load,checkpoints,{library,signal,scanner}){
 const segments=checkpoints.map(row=>row.manifest);await scanner.scannerVersion({signal});for(const segment of segments){if(signal?.aborted)throw signal.reason;await scanner.scan(await readDerivedSegment(library,claim.id,segment),{signal});}
 let items=null,publicationIds,expressionId=claim.source.expression_id,editionId=claim.source.parts[0].edition_id;
 if(claim.kind==='translation'){
  items=[];
  for(const p of selectedPartIndices(claim.source)){
   const units=claim.plan.segments.filter(unit=>unit.partIndex===p),outputs=[];
   assertDerivedPartBudget(claim.source.parts[p],units.map(unit=>checkpoints[unit.ordinal]));
   for(const unit of units)outputs.push(await readDerivedSegment(library,claim.id,segments[unit.ordinal]));
   const books=translatedBooks({...claim.source,parts:[claim.source.parts[p]]},[await load(p)],{segments:units.map(unit=>({...unit,partIndex:0}))},outputs,{schemaVersion:1,kind:'machine-translation',quality:'machine-draft',sourceSha256:claim.source_sha256,recipeSha256:claim.recipe_sha256,jobId:claim.id});await assertDerivedAttempt(pool,claim);
   items.push(...await placeTranslated(library,claim,claim.source,books,scanner,p));
  }
  publicationIds=items.map(x=>x.prepared.id);expressionId=derivedUuid(`translated-expression|${claim.id}`);editionId=items[0].editionId;
 }
 const manifest={schemaVersion:1,jobId:claim.id,kind:claim.kind,sourceSha256:claim.source_sha256,recipeSha256:claim.recipe_sha256,quality:claim.kind==='translation'?'machine-draft':'technical-unlistened',segments,...(publicationIds?{publicationIds}:{})};
 await scanner.scannerVersion();await scanner.scan(Buffer.from(canonicalJson(manifest)));await assertDerivedAttempt(pool,claim);
 const prepared=await writeDerivedManifest(library,claim.id,manifest),result={...prepared,workId:claim.source.work_id,expressionId,editionId};
 return finishDerivedJob(pool,claim,result,{verifySource:source=>verifyDerivedSource(library,source),publish:items?async(client,row,source,value)=>{await insertTranslated(client,row,source,items,library);return value;}:undefined});
}
export async function processDerivedStep(pool,claim,{library,spool,runtime,signal:parentSignal,allowed,scanner:providerScanner={scan,scannerVersion}}={}){
 const controller=new AbortController(),signal=controller.signal,abort=()=>controller.abort(parentSignal.reason||fail('Остановка','WORKER_STOPPING'));if(parentSignal?.aborted)abort();else parentSignal?.addEventListener('abort',abort,{once:true});let renewing=false;
 const scanner={scannerVersion:options=>providerScanner.scannerVersion({...options,signal}),scan:async(bytes,options)=>{try{return await providerScanner.scan(bytes,{...options,signal});}catch(error){if(error?.threat===true)error.sha256=sha256(bytes);throw error;}}};
 const heartbeat=setInterval(async()=>{if(renewing||signal.aborted)return;renewing=true;try{await renewDerivedJob(pool,claim);await allowed?.();}catch(error){controller.abort(error);}finally{renewing=false;}},4000);heartbeat.unref();
 try{
  await allowed?.();await assertDerivedAttempt(pool,claim);const load=sourceLoader(library,claim.source);
  const revision=derivedSegmentationRevision(claim.kind,claim.recipe.manifest);
  if(claim.plan&&claim.plan.segmentationRevision!==revision)throw fail('План не соответствует закреплённому рецепту','DERIVED_PLAN_CONFLICT');
  const plan=claim.plan?{segments:claim.total_segments,sha256:claim.plan_sha256,manifest:claim.plan}:await derivedPlanForRecipe(claim.source,load,claim.kind,claim.recipe.manifest);
  assertDerivedManifestBudget(plan.manifest,claim.source.parts.length);
  const current=await setDerivedPlan(pool,claim,plan);claim={...claim,...current,source:claim.source,recipe:claim.recipe};
  const checkpoints=await listDerivedCheckpoints(pool,claim);
  for(const [index,row] of checkpoints.entries()){if(row.ordinal!==index||row.source_sha256!==claim.plan.segments[row.ordinal].sourceSha256||row.output_sha256!==row.manifest.file.sha256)throw fail('Повреждён сохранённый прогресс','DERIVED_INTEGRITY');}
  // Validate the preceding committed file now; finalization verifies the entire
  // prefix before publishing. Reading all PCM files after every segment is quadratic.
  if(checkpoints.length)await readDerivedSegment(library,claim.id,checkpoints.at(-1).manifest);
  if(checkpoints.length===claim.total_segments)return await finalize(pool,claim,load,checkpoints,{library,signal,scanner});
  const unit=claim.plan.segments[checkpoints.length],version=await scanner.scannerVersion({signal});
  const generated=await infer(pool,claim,unit,load,{spool,runtime,signal,allowed});
  await assertDerivedAttempt(pool,claim);await scanner.scan(generated.bytes,{signal});await scanner.scannerVersion({signal});await allowed?.();
  const manifest=await storeDerivedSegment(library,claim,unit.ordinal,generated.bytes,{inputSha256:unit.sourceSha256,profileSha256:claim.recipe.manifest.profileSha256,scanVersion:version});
  await checkpointDerivedJob(pool,claim,{ordinal:unit.ordinal,sourceSha256:unit.sourceSha256,outputSha256:manifest.file.sha256,outputBytes:manifest.file.bytes,manifest});
  return await pauseDerivedJob(pool,claim,{reason:'segment-complete',retryAfterSeconds:1});
 }catch(error){return failDerivedJob(pool,claim,signal?.aborted?(signal.reason||fail('Остановка','WORKER_STOPPING')):error);}
 finally{clearInterval(heartbeat);parentSignal?.removeEventListener('abort',abort);}
}
export async function syncDerivedRequests(pool,{library}={}){
 let changed=0;
 const expected=new Set(['DERIVED_PARENT','DERIVED_DISCOVERY','DERIVED_SOURCE_BLOCKED','DERIVED_QUOTA','DERIVED_AUTH','DERIVED_LANGUAGE_REQUIRED','DERIVED_LANGUAGE_UNSUPPORTED','DERIVED_CHAPTER_RANGE','DERIVED_SELECTION_INTEGRITY']);
 // A withdrawn or cancelled parent grant cannot keep occupying the first page
 // of follow-ups forever. Admission still rechecks the exact source and grant.
 const completed=(await pool.query("SELECT r.*,d.manifest FROM derived_requests r JOIN derived_jobs j ON j.id=r.job_id JOIN derived_results d ON d.job_id=j.id JOIN profiles p ON p.id=r.requested_by LEFT JOIN profiles a ON a.id=r.approved_by WHERE j.kind='translation' AND j.status='completed' AND r.status='completed' AND r.audio_requested AND ((r.decision_reason='role-auto-approval' AND p.role IN('owner','trusted-import')) OR (r.decision_reason='owner-approval' AND a.role='owner')) AND (r.discovery_request_id IS NULL OR EXISTS(SELECT 1 FROM discovery_requests q WHERE q.id=r.discovery_request_id AND q.status='book-ready')) AND NOT EXISTS(SELECT 1 FROM derived_requests child WHERE child.parent_request_id=r.id) AND NOT EXISTS(SELECT 1 FROM derived_source_parts s JOIN books b ON b.id=s.book_id WHERE s.source_sha256=j.source_sha256 AND b.security_state<>'passed') ORDER BY r.created_at LIMIT 20")).rows;
 for(const parent of completed)try{const prior=(await pool.query('SELECT s.manifest FROM derived_jobs j JOIN derived_sources s ON s.sha256=j.source_sha256 WHERE j.id=$1',[parent.job_id])).rows[0],range=publicChapterRange(prior?.manifest);if(!range||range.count>5)continue;const child=await requestDerived(pool,{id:parent.requested_by},{idempotencyKey:derivedUuid(`audio-after|${parent.id}`),kind:'audio',publicationIds:parent.manifest.publicationIds,sourceLanguage:'ru',parentJobId:parent.job_id,parentRequestId:parent.id,audio:false,chapterRange:{start:1,count:range.count}},{library});if(!child.idempotent)changed++;}catch(error){if(!expected.has(error.code))throw error;}
 async function describe(profile,requestId){
  const request=(await pool.query('SELECT * FROM derived_requests WHERE id=$1 AND requested_by=$2',[requestId,profile.id])).rows[0];if(!request)return {status:'unavailable'};
  const job=(await pool.query('SELECT j.*,s.manifest AS source_manifest,(SELECT ps.manifest FROM derived_jobs pj JOIN derived_sources ps ON ps.sha256=pj.source_sha256 WHERE pj.id=$2) AS parent_source_manifest FROM derived_jobs j JOIN derived_sources s ON s.sha256=j.source_sha256 WHERE j.id=$1',[request.job_id,request.parent_job_id])).rows[0],chapterRange=publicChapterRange(job.source_manifest),originChapterRange=publicChapterRange(job.parent_source_manifest);
  const item={status:request.status==='pending-approval'?'approval-required':request.status==='cancelled'?'cancelled':job.status,jobId:job.id,requestId:request.id,jobStatus:job.status,requestStatus:request.status,completedSegments:job.completed_segments,totalSegments:job.total_segments,pauseReason:job.pause_reason,...(chapterRange?{chapterRange,partial:chapterRange.count<chapterRange.total,...(originChapterRange?{originChapterRange,partial:originChapterRange.count<originChapterRange.total}:{})}:{})};
  if(job.status==='completed'&&request.status==='completed')try{const ready=await getDerivedResult(pool,profile,job.id);item.status='ready';if(ready.result.manifest.publicationIds)item.publicationIds=ready.result.manifest.publicationIds;}catch(error){if(error.code==='DERIVED_SOURCE_BLOCKED')item.status='blocked';else if(error.code==='SERVING_PAUSED'){item.status='paused';item.pauseReason='serving-paused';}else if(error.code==='DERIVED_NOT_FOUND')item.status='approval-required';else throw error;}
  return item;
 }
 async function submitDiscovery(row,profile,kind,data){
  const legacy=derivedUuid(`discovery-derived|${row.id}|${kind}`),old=(await pool.query('SELECT 1 FROM derived_idempotency WHERE profile_id=$1 AND key=$2',[profile.id,legacy])).rowCount;
  return requestDerived(pool,profile,{idempotencyKey:old?legacy:derivedUuid(`discovery-derived-v2|${row.id}|${kind}`),kind,...data,...(old?{}:{chapterRange:row.input.chapterRange??{start:1,count:5}})},{library});
 }
 // Terminal outputs no longer churn their discovery revision. A retry,
 // approval, cancellation or new checkpoint makes its projection eligible again.
 const discoveries=(await pool.query("SELECT q.* FROM discovery_requests q WHERE q.status='book-ready' AND (q.outputs->'translation'->>'status' IN('pending-provider','queued','processing','paused','approval-required','waiting-translation','waiting-provider') OR q.outputs->'audio'->>'status' IN('pending-provider','queued','processing','paused','approval-required','waiting-translation','waiting-provider') OR ((q.outputs->'translation'->>'status'='needs-language' OR q.outputs->'audio'->>'status'='needs-language') AND q.outputs->'sourceLanguage'->'evidence'->>'method'='bounded-text-language-v1') OR EXISTS(SELECT 1 FROM derived_requests r JOIN derived_jobs j ON j.id=r.job_id WHERE (r.discovery_request_id=q.id OR r.parent_request_id IN(SELECT parent.id FROM derived_requests parent WHERE parent.discovery_request_id=q.id)) AND (q.outputs->j.kind->>'jobStatus' IS DISTINCT FROM j.status OR q.outputs->j.kind->>'requestStatus' IS DISTINCT FROM r.status OR (q.outputs->j.kind->>'completedSegments')::integer IS DISTINCT FROM j.completed_segments))) ORDER BY q.updated_at LIMIT 30")).rows;
 for(const row of discoveries){
  const profile={id:row.requested_by},outputs=structuredClone(row.outputs),target=row.input.language,ids=row.outputs.book.publicationIds??[row.outputs.book.publicationId];
  try{
   if(!Array.isArray(ids)||!ids.length||ids.some(id=>typeof id!=='string'))throw fail('Нет точной исходной публикации','DERIVED_SOURCE_BLOCKED');
   const rows=(await pool.query('SELECT * FROM books WHERE id=ANY($1::uuid[])',[ids])).rows,byId=new Map(rows.map(book=>[book.id,book]));if(rows.length!==ids.length)throw fail('Исходная публикация отсутствует','DERIVED_SOURCE_BLOCKED');
   const books=ids.map(id=>byId.get(id)),languages=new Set(books.map(book=>(book.language||'und').toLowerCase().split('-')[0]));let language=languages.size===1?[...languages][0]:'und';
   if(language==='und'){
    const previous=row.outputs.sourceLanguage,sourceSetSha256=languageSourceSetSha(books);
    const detection=currentLanguageDetection(previous,sourceSetSha256)?previous:await detectPublicationLanguage(library,books);
    outputs.sourceLanguage=detection;
    if(detection.status==='blocked')throw fail('Исходные файлы не прошли проверку языка','DERIVED_SOURCE_BLOCKED');
    language=detection.language??'und';
   }
   if(language==='und'){
    outputs.translation={status:'needs-language',language:target,reason:'SOURCE_LANGUAGE_UNCONFIRMED'};outputs.audio={status:row.input.audio?'needs-language':'not-requested',...(row.input.audio?{reason:'SOURCE_LANGUAGE_UNCONFIRMED'}:{})};
   }else if(language===target){
    outputs.translation={status:'not-required',language:target};
    if(!row.input.audio)outputs.audio={status:'not-requested'};
    else if(language!=='ru')outputs.audio={status:'unsupported',reason:'LOCAL_TTS_LANGUAGE_UNSUPPORTED',language};
    else{const submitted=await submitDiscovery(row,profile,'audio',{publicationIds:ids,...(row.outputs.book.snapshotId?{snapshotId:row.outputs.book.snapshotId}:{}),sourceLanguage:'ru',discoveryRequestId:row.id,audio:false});outputs.audio=await describe(profile,submitted.request.id);}
   }else if(language!=='en'||target!=='ru'){
    outputs.translation={status:'unsupported',language:target,reason:'LOCAL_TRANSLATION_LANGUAGE_UNSUPPORTED'};outputs.audio={status:row.input.audio?'unsupported':'not-requested',...(row.input.audio?{reason:'TRANSLATION_LANGUAGE_UNSUPPORTED'}:{})};
   }else{
    const submitted=await submitDiscovery(row,profile,'translation',{publicationIds:ids,...(row.outputs.book.snapshotId?{snapshotId:row.outputs.book.snapshotId}:{}),sourceLanguage:'en',discoveryRequestId:row.id,audio:row.input.audio});
    outputs.translation={...await describe(profile,submitted.request.id),language:target};
    if(!row.input.audio)outputs.audio={status:'not-requested'};
    else{const child=(await pool.query('SELECT id FROM derived_requests WHERE parent_request_id=$1 ORDER BY created_at LIMIT 1',[submitted.request.id])).rows[0];outputs.audio=child?await describe(profile,child.id):{status:outputs.translation.status==='cancelled'?'cancelled':outputs.translation.status==='blocked'?'blocked':outputs.translation.status==='ready'?'approval-required':'waiting-translation',parentJobId:submitted.job.id,parentRequestId:submitted.request.id};}
   }
  }catch(error){
   if(!expected.has(error.code))throw error;
   const status=['DERIVED_SOURCE_BLOCKED','DERIVED_SELECTION_INTEGRITY'].includes(error.code)?'blocked':error.code==='DERIVED_CHAPTER_RANGE'?'needs-chapter-range':error.code==='DERIVED_LANGUAGE_REQUIRED'?'needs-language':error.code==='DERIVED_LANGUAGE_UNSUPPORTED'?'unsupported':error.code==='DERIVED_QUOTA'?'waiting-provider':'approval-required';
   outputs.translation={status,language:target,reason:error.code};outputs.audio={status:row.input.audio?status:'not-requested',...(row.input.audio?{reason:error.code}:{})};
  }
  const selected=outputs.translation?.chapterRange??outputs.audio?.originChapterRange??outputs.audio?.chapterRange;
  if(selected)outputs.batch={chapterRange:selected,partial:selected.count<selected.total,automaticContinuation:false};
  if(canonicalJson(outputs)!==canonicalJson(row.outputs))changed+=(await pool.query("UPDATE discovery_requests SET outputs=$1,revision=revision+1,updated_at=now() WHERE id=$2 AND status='book-ready' AND outputs=$3::jsonb",[JSON.stringify(outputs),row.id,JSON.stringify(row.outputs)])).rowCount;
 }
 return changed;
}
