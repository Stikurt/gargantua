import {randomUUID} from 'node:crypto';
import {canonicalJson,sha256} from './publication-model.mjs';
import {requestedChapterRange,normalizedChapterRange,makeChapterSelection,assertSelectionBooks,publicChapterRange} from './derived-selection.mjs';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HASH=/^[a-f0-9]{64}$/;
const TRANSIENT_DATABASE_CODES=new Set(['08000','08001','08003','08004','08006','08007','08P01','57P01','57P02','57P03','40001','40P01','53300','55P03','ECONNRESET','ETIMEDOUT','ECONNREFUSED','EPIPE','ENETDOWN','ENETRESET','ENETUNREACH','EHOSTUNREACH','EAI_AGAIN','ERR_SOCKET_CLOSED','PROTOCOL_CONNECTION_LOST','CONNECTION_LOST']);
const TRANSIENT_DATABASE_MESSAGES=new Set(['Connection terminated unexpectedly','Connection terminated','Connection terminated due to connection timeout','Client has encountered a connection error and is not queryable','timeout exceeded when trying to connect']);
const transientDatabase=error=>TRANSIENT_DATABASE_CODES.has(error?.code)||!error?.code&&TRANSIENT_DATABASE_MESSAGES.has(error?.message);
const fail=(message,status=400,code='DERIVED_INPUT')=>Object.assign(new Error(message),{status,code});
const lost=()=>fail('Попытка перевода или озвучивания устарела.',409,'DERIVED_LEASE_LOST');
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const identifier=value=>{if(typeof value!=='string'||!UUID.test(value))throw fail('Некорректный ID');return value.toLowerCase();};
const checksum=value=>{if(typeof value!=='string'||!HASH.test(value))throw fail('Некорректная контрольная сумма');return value;};
const kind=value=>{if(!['translation','audio'].includes(value))throw fail('Неизвестный вид производной');return value;};
const hasAuto=role=>['owner','trusted-import'].includes(role);
const seconds=(value=120)=>{if(!Number.isSafeInteger(value)||value<1||value>600)throw fail('Недопустимый срок владения');return value;};
const revision=value=>{if(!Number.isSafeInteger(value)||value<1)throw fail('Нужна актуальная revision');return value;};
const conflict=()=>fail('Заявка уже изменилась. Обновите её.',409,'DERIVED_CONFLICT');
function jsonObject(value,max=65536){
 if(!record(value))throw fail('Ожидается объект');
 let encoded;try{encoded=canonicalJson(value);}catch{throw fail('Объект не сериализуется');}
 if(typeof encoded!=='string'||Buffer.byteLength(encoded)>max)throw fail('Превышен размер объекта',413,'DERIVED_LIMIT');
 const parsed=JSON.parse(encoded);if(!record(parsed))throw fail('Ожидается объект');return parsed;
}
async function transaction(pool,operation){const client=await pool.connect();try{await client.query('BEGIN');const value=await operation(client);await client.query('COMMIT');return value;}catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}}
async function actor(client,profile){const row=(await client.query('SELECT id,role FROM profiles WHERE id=$1 FOR SHARE',[identifier(profile?.id)])).rows[0];if(!row)throw fail('Профиль недоступен',401,'DERIVED_AUTH');return row;}
async function audit(client,who,action,target,details={}){await client.query('INSERT INTO audit(actor,action,target,details) VALUES($1,$2,$3,$4)',[who,action,target,JSON.stringify(details)]);}
async function capacity(client,profileId,{jobId=null,newGlobal=false}={}){
 const row=(await client.query("SELECT count(DISTINCT j.id)::int AS global,count(DISTINCT j.id) FILTER(WHERE r.requested_by=$1 AND r.status<>'cancelled')::int AS personal,count(DISTINCT j.id) FILTER(WHERE j.id=$2 AND r.requested_by=$1 AND r.status<>'cancelled')::int AS existing FROM derived_jobs j LEFT JOIN derived_requests r ON r.job_id=j.id WHERE j.status NOT IN('completed','cancelled','failed','blocked')",[profileId,jobId])).rows[0];
 if(newGlobal&&row.global>=30||!row.existing&&row.personal>=5)throw fail('Лимит активной обработки: 5 на профиль и 30 на сервер.',429,'DERIVED_QUOTA');
}
async function notPaused(client){if((await client.query('SELECT imports_paused FROM settings WHERE id=1 FOR SHARE')).rows[0]?.imports_paused)throw fail('Обработка приостановлена владельцем.',423,'IMPORT_PAUSED');}
async function jobLock(client,id){return (await client.query('SELECT *,lease_expires_at>clock_timestamp() AS lease_valid FROM derived_jobs WHERE id=$1 FOR UPDATE',[identifier(id)])).rows[0];}
async function sourceFor(client,sourceSha,ancestors=new Set()){
 if(ancestors.has(sourceSha)||ancestors.size>=16)throw fail('Неверная цепочка исходных версий.',423,'DERIVED_SOURCE_BLOCKED');ancestors.add(sourceSha);
 const source=(await client.query('SELECT * FROM derived_sources WHERE sha256=$1 FOR SHARE',[checksum(sourceSha)])).rows[0];if(!source)throw fail('Исходная публикация отсутствует',423,'DERIVED_SOURCE_BLOCKED');
 const parts=(await client.query('SELECT p.ordinal,p.publication_sha256 AS pinned_publication_sha256,p.package_sha256 AS pinned_package_sha256,b.* FROM derived_source_parts p JOIN books b ON b.id=p.book_id WHERE p.source_sha256=$1 ORDER BY p.ordinal FOR SHARE OF b',[sourceSha])).rows;
 if(parts.length!==source.manifest.parts.length||parts.some((part,index)=>part.ordinal!==index||part.work_id!==source.work_id||part.expression_id!==source.expression_id||part.security_state!=='passed'||!part.artifact_manifest||!part.publication_manifest||part.publication_sha256!==part.pinned_publication_sha256||part.package_sha256!==part.pinned_package_sha256||part.id!==source.manifest.parts[index].publicationId))throw fail('Оригинал заблокирован или его версия не подтверждена.',423,'DERIVED_SOURCE_BLOCKED');
 const expression=(await client.query('SELECT kind FROM expressions WHERE id=$1',[source.expression_id])).rows[0];
 if(expression?.kind==='machine-translation'){
  const origins=(await client.query('SELECT j.source_sha256,r.manifest FROM derived_results r JOIN derived_jobs j ON j.id=r.job_id WHERE r.expression_id=$1 AND j.kind=\'translation\' AND j.status=\'completed\'',[source.expression_id])).rows.filter(row=>parts.every(part=>row.manifest.publicationIds?.includes(part.id)));
  if(origins.length!==1)throw fail('Не подтверждено происхождение машинного перевода.',423,'DERIVED_SOURCE_BLOCKED');await sourceFor(client,origins[0].source_sha256,ancestors);
 }
 const value={...source,parts};assertSelectionBooks(value);return value;
}
async function jobMetadata(client,job){if(!job)return job;
 const source=(await client.query("SELECT s.manifest,w.title,w.authors,nullif(f.title,'') AS canonical_title,nullif(f.author,'') AS canonical_author FROM derived_sources s JOIN works w ON w.id=s.work_id LEFT JOIN ranobe_runs run ON run.id=s.snapshot_id LEFT JOIN ranobe_feeds f ON f.id=run.feed_id WHERE s.sha256=$1",[job.source_sha256])).rows[0],parent=(await client.query("SELECT s.manifest,nullif(f.title,'') AS canonical_title,nullif(f.author,'') AS canonical_author FROM derived_requests r JOIN derived_jobs j ON j.id=r.parent_job_id JOIN derived_sources s ON s.sha256=j.source_sha256 LEFT JOIN ranobe_runs run ON run.id=s.snapshot_id LEFT JOIN ranobe_feeds f ON f.id=run.feed_id WHERE r.job_id=$1 ORDER BY r.created_at LIMIT 1",[job.id])).rows[0],author=source?.canonical_author??parent?.canonical_author;
 return {...job,source_manifest:source?.manifest,parent_source_manifest:parent?.manifest,source_title:source?.canonical_title??parent?.canonical_title??source?.title,source_authors:author?[author]:source?.authors,source_language:source?.manifest.sourceLanguage};}
function requestMetadata(request,job){return {...request,...Object.fromEntries(['source_manifest','parent_source_manifest','source_sha256','source_title','source_authors','source_language'].map(key=>[key,job[key]]))};}
async function authorized(client,row,depth=0){
 if(depth>16)return false;
 if(!['active','completed'].includes(row.status))return false;
 if(row.discovery_request_id){const origin=(await client.query('SELECT status,requested_by FROM discovery_requests WHERE id=$1 FOR SHARE',[row.discovery_request_id])).rows[0];if(origin?.status!=='book-ready'||origin.requested_by!==row.requested_by)return false;}
 if(row.parent_request_id){const parent=(await client.query('SELECT * FROM derived_requests WHERE id=$1 AND requested_by=$2 FOR SHARE',[row.parent_request_id,row.requested_by])).rows[0];if(!parent||parent.job_id!==row.parent_job_id||!await authorized(client,parent,depth+1))return false;}
 if(row.decision_reason==='role-auto-approval')return hasAuto((await client.query('SELECT role FROM profiles WHERE id=$1 FOR SHARE',[row.requested_by])).rows[0]?.role);
 return row.decision_reason==='owner-approval'&&(await client.query('SELECT role FROM profiles WHERE id=$1 FOR SHARE',[row.approved_by])).rows[0]?.role==='owner';
}
async function authorizedSubscribers(client,jobId,{demote=false}={}){
 const rows=(await client.query("SELECT * FROM derived_requests WHERE job_id=$1 AND status IN('active','completed') ORDER BY id FOR UPDATE",[jobId])).rows,allowed=[];
 for(const row of rows){if(await authorized(client,row))allowed.push(row);else if(demote)await client.query("UPDATE derived_requests SET status='pending-approval',approved_by=NULL,decision_reason=NULL,revision=revision+1,updated_at=now() WHERE id=$1",[row.id]);}
 return allowed;
}
async function live(client,claim,{verifySource,allowPaused=false}={}){
 await client.query('SELECT pg_advisory_xact_lock(84627196)');
 const row=await jobLock(client,claim?.id);if(!row||row.status!=='processing'||row.attempt_token!==identifier(claim.attempt_token??claim.attemptToken)||!row.lease_valid)throw lost();
 if(!allowPaused)await notPaused(client);
 // Keep every active grant current, including when another subscriber still
 // authorizes shared work. Publication callbacks may then choose an active
 // initiator without accidentally attributing new output to a revoked grant.
 if(!(await authorizedSubscribers(client,row.id,{demote:true})).length)throw fail('Разрешение на обработку отозвано.',409,'DERIVED_APPROVAL_REQUIRED');
 const source=await sourceFor(client,row.source_sha256);if(verifySource)await verifySource(source);return {row,source};
}
async function endAttempt(client,row,state,error=null){if(row.attempt_token)await client.query("UPDATE derived_attempts SET state=$1,error=$2,ended_at=now() WHERE token=$3 AND state='running'",[state,error,row.attempt_token]);}
async function owned(client,profile,requestId){const who=await actor(client,profile),request=(await client.query('SELECT * FROM derived_requests WHERE id=$1 FOR UPDATE',[identifier(requestId)])).rows[0];if(!request||request.requested_by!==who.id&&who.role!=='owner')throw fail('Заявка не найдена.',404,'DERIVED_NOT_FOUND');return {who,request};}

export async function registerDerivedRecipe(pool,value){
 if(!record(value)||Object.keys(value).some(key=>!['kind','language','manifest'].includes(key)))throw fail('Некорректный рецепт');
 const recipeKind=kind(value.kind),language=value.language;if(typeof language!=='string'||!/^[a-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(language))throw fail('Некорректный язык');
 const manifest=jsonObject(value.manifest),hash=sha256(Buffer.from(canonicalJson({kind:recipeKind,language,manifest})));
 return transaction(pool,async client=>{await client.query('INSERT INTO derived_recipes(sha256,kind,language,manifest) VALUES($1,$2,$3,$4) ON CONFLICT(sha256) DO NOTHING',[hash,recipeKind,language,JSON.stringify(manifest)]);return (await client.query('SELECT * FROM derived_recipes WHERE sha256=$1',[hash])).rows[0];});
}
export async function createDerivedRequest(pool,profile,input,{verifySource}={}){
 if(!record(input)||Object.keys(input).some(key=>!['idempotencyKey','kind','recipeSha256','publicationIds','snapshotId','sourceLanguage','discoveryRequestId','parentJobId','parentRequestId','audio','chapterRange'].includes(key)))throw fail('Неизвестные параметры обработки');
 const key=identifier(input.idempotencyKey),jobKind=kind(input.kind),recipeSha=checksum(input.recipeSha256);
 const requestedRange=requestedChapterRange(input.chapterRange,jobKind);
 if(!Array.isArray(input.publicationIds)||!input.publicationIds.length||input.publicationIds.length>20000)throw fail('Нужен точный список публикаций');
 const ids=input.publicationIds.map(identifier);if(new Set(ids).size!==ids.length)throw fail('Публикация повторяется');
 const snapshotId=input.snapshotId==null?null:identifier(input.snapshotId),discoveryId=input.discoveryRequestId==null?null:identifier(input.discoveryRequestId),parentJobId=input.parentJobId==null?null:identifier(input.parentJobId),parentRequestId=input.parentRequestId==null?null:identifier(input.parentRequestId),audioRequested=input.audio??jobKind==='translation';
 if(typeof audioRequested!=='boolean'||jobKind==='audio'&&audioRequested||Boolean(parentJobId)!==Boolean(parentRequestId))throw fail('Некорректные настройки продолжения');
 if(input.sourceLanguage!==undefined&&!['en','ru'].includes(input.sourceLanguage))throw fail('Нужен подтверждённый язык en или ru');
 const body={kind:jobKind,recipeSha256:recipeSha,publicationIds:ids,snapshotId,sourceLanguage:input.sourceLanguage??null,discoveryRequestId:discoveryId,parentJobId,parentRequestId,audio:audioRequested},legacyBodySha=sha256(Buffer.from(canonicalJson(body)));
 return transaction(pool,async client=>{
  await client.query('SELECT pg_advisory_xact_lock(84627196)');const who=await actor(client,profile);
  const old=(await client.query('SELECT * FROM derived_idempotency WHERE profile_id=$1 AND key=$2',[who.id,key])).rows[0];
  if(old){const request=(await client.query('SELECT * FROM derived_requests WHERE id=$1',[old.request_id])).rows[0],job=await jobMetadata(client,(await client.query('SELECT * FROM derived_jobs WHERE id=$1',[request.job_id])).rows[0]);let matches=input.chapterRange===undefined&&old.body_sha256===legacyBodySha;
   if(!matches){const coverage=publicChapterRange(job.source_manifest),range=normalizedChapterRange(requestedRange,coverage.total,jobKind);matches=old.body_sha256===sha256(Buffer.from(canonicalJson({...body,chapterRange:range})));}
   if(!matches)throw fail('Ключ уже использован с другим запросом.',409,'DERIVED_IDEMPOTENCY');return {request:requestMetadata(request,job),job,reused:true,idempotent:true};}
  const recipe=(await client.query('SELECT * FROM derived_recipes WHERE sha256=$1 AND kind=$2 FOR SHARE',[recipeSha,jobKind])).rows[0];if(!recipe)throw fail('Рецепт недоступен.',409,'DERIVED_RECIPE');
  let discovery=null,discoveryApproval=null;
  if(discoveryId){discovery=(await client.query('SELECT * FROM discovery_requests WHERE id=$1 FOR SHARE',[discoveryId])).rows[0];if(!discovery||discovery.requested_by!==who.id||discovery.status!=='book-ready')throw fail('Исходный поиск не принадлежит готовой заявке.',409,'DERIVED_DISCOVERY');const expected=discovery.outputs.book.publicationIds??[discovery.outputs.book.publicationId];if(canonicalJson(ids)!==canonicalJson(expected)||snapshotId!==(discovery.outputs.book.snapshotId??null))throw fail('Публикации не соответствуют поиску.',409,'DERIVED_DISCOVERY');}
  let parentSubscription=null;
  if(parentJobId){const parent=(await client.query('SELECT j.status,r.manifest FROM derived_jobs j JOIN derived_results r ON r.job_id=j.id WHERE j.id=$1 FOR SHARE OF j,r',[parentJobId])).rows[0];parentSubscription=(await client.query("SELECT * FROM derived_requests WHERE id=$1 AND job_id=$2 AND requested_by=$3 AND status IN('active','completed') FOR SHARE",[parentRequestId,parentJobId,who.id])).rows[0];if(jobKind!=='audio'||!parent||parent.status!=='completed'||!parentSubscription?.audio_requested||!await authorized(client,parentSubscription)||canonicalJson(ids)!==canonicalJson(parent.manifest.publicationIds))throw fail('Озвучивание не соответствует готовому переводу и разрешённой заявке.',409,'DERIVED_PARENT');}
  const rows=(await client.query('SELECT * FROM books WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',[ids])).rows,map=new Map(rows.map(row=>[row.id,row]));
  const books=ids.map(id=>map.get(id));if(books.some(row=>!row||row.security_state!=='passed'||!row.artifact_manifest||!row.publication_manifest||!HASH.test(row.publication_sha256)||!HASH.test(row.package_sha256)))throw fail('Книга не прошла проверку или заблокирована.',423,'DERIVED_SOURCE_BLOCKED');
  if(books.some(row=>row.work_id!==books[0].work_id||row.expression_id!==books[0].expression_id))throw fail('Части относятся к разным вариантам книги.',409,'DERIVED_SOURCE_MISMATCH');
  const languages=new Set(books.map(row=>(row.language||'und').toLowerCase().split('-')[0]).filter(value=>value!=='und'));
  const sourceLanguage=input.sourceLanguage??(languages.size===1?[...languages][0]:null);if(!['en','ru'].includes(sourceLanguage)||languages.size>1||languages.size===1&&!languages.has(sourceLanguage))throw fail('Нужен подтверждённый исходный язык.',409,'DERIVED_LANGUAGE_REQUIRED');
  if(jobKind==='translation'&&(sourceLanguage!=='en'||recipe.language!=='ru')||jobKind==='audio'&&(sourceLanguage!=='ru'||recipe.language!=='ru'))throw fail('Локальный профиль не поддерживает эту пару языков.',409,'DERIVED_LANGUAGE_UNSUPPORTED');
  if(discovery){
   if(jobKind==='translation'&&(discovery.input.language!==recipe.language||audioRequested!==discovery.input.audio)||jobKind==='audio'&&(!discovery.input.audio||discovery.input.language!==sourceLanguage||audioRequested))throw fail('Настройки обработки не соответствуют одобренному поиску.',409,'DERIVED_DISCOVERY');
   if(discovery.decision_reason==='role-auto-approval'&&hasAuto(who.role))discoveryApproval={approved_by:who.id,decision_reason:'role-auto-approval'};
   else if(discovery.approved_by&&(await client.query('SELECT role FROM profiles WHERE id=$1 FOR SHARE',[discovery.approved_by])).rows[0]?.role==='owner')discoveryApproval={approved_by:discovery.approved_by,decision_reason:'owner-approval'};
  }
  if(snapshotId){const run=(await client.query("SELECT * FROM ranobe_runs WHERE id=$1 AND status='ready' FOR SHARE",[snapshotId])).rows[0],parts=(await client.query('SELECT ordinal,book_id,status FROM ranobe_run_parts WHERE run_id=$1 ORDER BY ordinal FOR SHARE',[snapshotId])).rows;if(!run||!parts.length||parts.some(part=>part.status!=='ready')||canonicalJson(ids)!==canonicalJson(parts.map(part=>part.book_id)))throw fail('Нужны все части зафиксированной версии новеллы.',409,'DERIVED_SNAPSHOT');}
  const selection=makeChapterSelection(books,requestedRange,jobKind),chapterRange={start:selection.start,count:selection.count},bodySha=sha256(Buffer.from(canonicalJson({...body,chapterRange})));
  if(parentJobId&&(selection.start!==1||selection.count!==selection.total))throw fail('Озвучивание должно охватывать ровно готовый пакет перевода.',409,'DERIVED_PARENT');
  if(discovery&&canonicalJson(normalizedChapterRange(discovery.input.chapterRange,selection.total,'translation'))!==canonicalJson(chapterRange))throw fail('Диапазон не соответствует одобренному поиску.',409,'DERIVED_DISCOVERY');
  const manifest={schemaVersion:2,sourceLanguage,workId:books[0].work_id,expressionId:books[0].expression_id,snapshotId,parts:books.map((book,ordinal)=>({ordinal,publicationId:book.id,editionId:book.edition_id,publicationSha256:book.publication_sha256,packageSha256:book.package_sha256,chapterCount:book.chapter_count})),selection};
  const sourceSha=sha256(Buffer.from(canonicalJson(manifest)));await client.query('INSERT INTO derived_sources(sha256,work_id,expression_id,snapshot_id,manifest) VALUES($1,$2,$3,$4,$5) ON CONFLICT(sha256) DO NOTHING',[sourceSha,books[0].work_id,books[0].expression_id,snapshotId,JSON.stringify(manifest)]);
  for(const [ordinal,book]of books.entries())await client.query('INSERT INTO derived_source_parts(source_sha256,ordinal,book_id,expression_id,edition_id,publication_sha256,package_sha256) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(source_sha256,ordinal) DO NOTHING',[sourceSha,ordinal,book.id,book.expression_id,book.edition_id,book.publication_sha256,book.package_sha256]);
  const source=await sourceFor(client,sourceSha);if(verifySource)await verifySource(source);
  let job=(await client.query('SELECT * FROM derived_jobs WHERE kind=$1 AND source_sha256=$2 AND recipe_sha256=$3 FOR UPDATE',[jobKind,sourceSha,recipeSha])).rows[0],reused=Boolean(job);
  if(!job){await capacity(client,who.id,{newGlobal:true});job=(await client.query("INSERT INTO derived_jobs(id,kind,source_sha256,recipe_sha256,status) VALUES($1,$2,$3,$4,'approval-required') RETURNING *",[randomUUID(),jobKind,sourceSha,recipeSha])).rows[0];}
  // The grant covers these exact requested outputs and parent initiative. A
  // reader cannot upgrade an approved text-only request to audio by reusing it.
  let request=(await client.query("SELECT * FROM derived_requests WHERE job_id=$1 AND requested_by=$2 AND status<>'cancelled' AND parent_request_id IS NOT DISTINCT FROM $3::uuid AND audio_requested=$4 AND discovery_request_id IS NOT DISTINCT FROM $5::uuid ORDER BY created_at LIMIT 1 FOR UPDATE",[job.id,who.id,parentRequestId,audioRequested,discoveryId])).rows[0];
  if(!request){if(!['completed','failed','blocked','cancelled'].includes(job.status))await capacity(client,who.id,{jobId:job.id});const grant=parentSubscription??discoveryApproval,auto=hasAuto(who.role)||Boolean(grant),approvedBy=grant?.approved_by??(auto?who.id:null),reason=grant?.decision_reason??(auto?'role-auto-approval':null);request=(await client.query('INSERT INTO derived_requests(id,job_id,requested_by,discovery_request_id,parent_job_id,parent_request_id,audio_requested,status,approved_by,decision_reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',[randomUUID(),job.id,who.id,discoveryId,parentJobId,parentRequestId,audioRequested,auto?(job.status==='completed'?'completed':'active'):'pending-approval',approvedBy,reason])).rows[0];}
  if(request.status==='active'&&['approval-required','cancelled'].includes(job.status)){if(job.status==='cancelled')await capacity(client,who.id,{jobId:job.id,newGlobal:true});job=(await client.query("UPDATE derived_jobs SET status='queued',pause_reason=NULL,error=NULL,next_attempt_at=NULL,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *",[job.id])).rows[0];}
  await client.query('INSERT INTO derived_idempotency(profile_id,key,body_sha256,request_id) VALUES($1,$2,$3,$4)',[who.id,key,bodySha,request.id]);await audit(client,who.id,reused?'derived.reused':'derived.created',request.id,{jobId:job.id,kind:jobKind,sourceSha256:sourceSha,recipeSha256:recipeSha});job=await jobMetadata(client,job);return {request:requestMetadata(request,job),job,reused,idempotent:false};
 });
}

// A historical approval grants reading an already completed output. Revoking
// auto approval prevents future expensive work; it does not revoke library use.
const readyReadGrant=row=>row.status==='completed'&&row.approved_by&&['owner-approval','role-auto-approval'].includes(row.decision_reason);
export async function getDerivedRequest(pool,profile,requestId){return transaction(pool,async client=>{const {request}=await owned(client,profile,requestId),job=await jobMetadata(client,(await client.query('SELECT * FROM derived_jobs WHERE id=$1',[request.job_id])).rows[0]);let result=null;if(readyReadGrant(request)&&!(await client.query('SELECT serving_paused FROM settings WHERE id=1 FOR SHARE')).rows[0]?.serving_paused){try{await sourceFor(client,job.source_sha256);result=(await client.query('SELECT * FROM derived_results WHERE job_id=$1',[job.id])).rows[0]??null;}catch(error){if(error.code!=='DERIVED_SOURCE_BLOCKED')throw error;}}return {...request,source_title:job.source_title,source_authors:job.source_authors,source_language:job.source_language,source_manifest:job.source_manifest,parent_source_manifest:job.parent_source_manifest,source_sha256:job.source_sha256,job,result};});}
export async function getDerivedResult(pool,profile,jobId){return transaction(pool,async client=>{const who=await actor(client,profile);if((await client.query('SELECT serving_paused FROM settings WHERE id=1 FOR SHARE')).rows[0]?.serving_paused)throw fail('Выдача библиотеки приостановлена.',423,'SERVING_PAUSED');const job=(await client.query("SELECT * FROM derived_jobs WHERE id=$1 AND status='completed' FOR SHARE",[identifier(jobId)])).rows[0];if(!job)throw fail('Результат не найден.',404,'DERIVED_NOT_FOUND');if(who.role!=='owner'){const subscriptions=(await client.query('SELECT * FROM derived_requests WHERE job_id=$1 AND requested_by=$2 FOR SHARE',[job.id,who.id])).rows;if(!subscriptions.some(readyReadGrant))throw fail('Результат не найден.',404,'DERIVED_NOT_FOUND');}const source=await sourceFor(client,job.source_sha256),result=(await client.query('SELECT * FROM derived_results WHERE job_id=$1 FOR SHARE',[job.id])).rows[0];if(!result)throw fail('Результат не найден.',404,'DERIVED_NOT_FOUND');return {job:await jobMetadata(client,job),source,result};});}
export async function assertDerivedPublication(pool,publicationId,{client:existingClient}={}){const check=async client=>{if((await client.query('SELECT serving_paused FROM settings WHERE id=1 FOR SHARE')).rows[0]?.serving_paused)throw fail('Выдача библиотеки приостановлена.',423,'SERVING_PAUSED');const book=(await client.query('SELECT b.*,e.kind AS expression_kind FROM books b JOIN expressions e ON e.id=b.expression_id WHERE b.id=$1 FOR SHARE OF b,e',[identifier(publicationId)])).rows[0];if(!book||book.security_state!=='passed'||!book.artifact_manifest||!book.publication_manifest)throw fail('Публикация недоступна.',423,'DERIVED_SOURCE_BLOCKED');if(book.expression_kind!=='machine-translation')return {book,source:null};const origins=(await client.query("SELECT j.source_sha256,r.manifest FROM derived_results r JOIN derived_jobs j ON j.id=r.job_id WHERE r.expression_id=$1 AND j.kind='translation' AND j.status='completed'",[book.expression_id])).rows.filter(row=>row.manifest.publicationIds?.includes(book.id));if(origins.length!==1)throw fail('Происхождение перевода не подтверждено.',423,'DERIVED_SOURCE_BLOCKED');return {book,source:await sourceFor(client,origins[0].source_sha256)};};return existingClient?check(existingClient):transaction(pool,check);}
export async function listDerivedRequests(pool,profile,{limit=50}={}){if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw fail('Недопустимый лимит');return transaction(pool,async client=>{const who=await actor(client,profile);return (await client.query(`SELECT r.*,j.kind,j.status AS job_status,j.completed_segments,j.total_segments,j.pause_reason,j.error,j.source_sha256,s.manifest AS source_manifest,ps.manifest AS parent_source_manifest,coalesce(nullif(f.title,''),nullif(pf.title,''),w.title) AS source_title,CASE WHEN coalesce(nullif(f.author,''),nullif(pf.author,'')) IS NOT NULL THEN jsonb_build_array(coalesce(nullif(f.author,''),nullif(pf.author,''))) ELSE w.authors END AS source_authors,s.manifest->>\'sourceLanguage\' AS source_language FROM derived_requests r JOIN derived_jobs j ON j.id=r.job_id JOIN derived_sources s ON s.sha256=j.source_sha256 JOIN works w ON w.id=s.work_id LEFT JOIN ranobe_runs run ON run.id=s.snapshot_id LEFT JOIN ranobe_feeds f ON f.id=run.feed_id LEFT JOIN derived_jobs pj ON pj.id=r.parent_job_id LEFT JOIN derived_sources ps ON ps.sha256=pj.source_sha256 LEFT JOIN ranobe_runs pr ON pr.id=ps.snapshot_id LEFT JOIN ranobe_feeds pf ON pf.id=pr.feed_id WHERE ($1::boolean OR r.requested_by=$2) ORDER BY r.created_at DESC,r.id DESC LIMIT $3`,[who.role==='owner',who.id,limit])).rows;});}
export async function decideDerivedRequest(pool,profile,data){
 if(!record(data)||Object.keys(data).some(key=>!['id','action','expectedRevision'].includes(key))||!['approve','cancel','retry'].includes(data.action))throw fail('Неизвестное действие');revision(data.expectedRevision);
 return transaction(pool,async client=>{await client.query('SELECT pg_advisory_xact_lock(84627196)');const {who,request}=await owned(client,profile,data.id);if(request.revision!==data.expectedRevision)throw conflict();const job=await jobLock(client,request.job_id);
  if(data.action==='cancel'){
   if(request.status==='cancelled')return request;
   const next=(await client.query("UPDATE derived_requests SET status='cancelled',revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *",[request.id])).rows[0];
   if(job.status!=='completed'&&!(await authorizedSubscribers(client,job.id,{demote:true})).length){await endAttempt(client,job,'cancelled');await client.query("UPDATE derived_jobs SET status='cancelled',lease_expires_at=NULL,attempt_token=NULL,pause_reason=NULL,next_attempt_at=NULL,revision=revision+1,updated_at=now() WHERE id=$1",[job.id]);}
   await audit(client,who.id,'derived.cancelled',request.id,{jobId:job.id});return next;
  }
  if(data.action==='approve'&&who.role!=='owner')throw fail('Одобрять может только владелец.',403,'DERIVED_FORBIDDEN');
  if(request.status==='cancelled')throw fail('Отменённой заявке нужен новый запрос.',409,'DERIVED_CANCELLED');
  if(data.action==='retry'&&(!['failed','blocked','paused','approval-required'].includes(job.status)||!await authorized(client,request)&&who.role!=='owner'))throw fail('Повтор недоступен.',409,'DERIVED_APPROVAL_REQUIRED');
  if(['failed','blocked','cancelled'].includes(job.status))await capacity(client,request.requested_by,{jobId:job.id,newGlobal:true});
  await sourceFor(client,job.source_sha256);
  const next=(await client.query('UPDATE derived_requests SET status=$1,approved_by=$2,decision_reason=$3,revision=revision+1,updated_at=now() WHERE id=$4 RETURNING *',[job.status==='completed'?'completed':'active',who.role==='owner'?who.id:request.approved_by,who.role==='owner'?'owner-approval':request.decision_reason,request.id])).rows[0];
  if(['failed','blocked','paused','approval-required','cancelled'].includes(job.status))await client.query("UPDATE derived_jobs SET status='queued',error=NULL,pause_reason=NULL,next_attempt_at=NULL,revision=revision+1,updated_at=now() WHERE id=$1",[job.id]);
  await audit(client,who.id,'derived.'+data.action,request.id,{jobId:job.id});return next;
 });
}

export async function claimDerivedJob(pool,{leaseSeconds=120,kind:requestedKind}={}){
 const duration=seconds(leaseSeconds);if(requestedKind!==undefined)kind(requestedKind);
 return transaction(pool,async client=>{
  await client.query('SELECT pg_advisory_xact_lock(84627196)');if((await client.query('SELECT imports_paused FROM settings WHERE id=1 FOR SHARE')).rows[0]?.imports_paused)return null;
  if((await client.query("SELECT 1 FROM derived_jobs WHERE status='processing' AND lease_expires_at>clock_timestamp() FOR UPDATE")).rowCount)return null;
  // Reconcile every expired kind first, even when this worker asks for one kind.
  // Otherwise an expired audio row would retain the unique heavy slot while a
  // translation-only worker tried to claim a different job.
  for(const expired of (await client.query("SELECT * FROM derived_jobs WHERE status='processing' AND lease_expires_at<=clock_timestamp() FOR UPDATE")).rows){await endAttempt(client,expired,'interrupted');await client.query("UPDATE derived_jobs SET status='queued',pause_reason='lease-expired',attempt_token=NULL,lease_expires_at=NULL,revision=revision+1,updated_at=now() WHERE id=$1",[expired.id]);}
  const candidates=(await client.query("SELECT * FROM derived_jobs WHERE (status IN('queued','approval-required') OR status='paused' AND (next_attempt_at IS NULL OR next_attempt_at<=clock_timestamp()) OR status='processing' AND lease_expires_at<=clock_timestamp()) AND ($1::text IS NULL OR kind=$1) ORDER BY (pause_reason='lease-expired') DESC NULLS LAST,updated_at,created_at LIMIT 30 FOR UPDATE SKIP LOCKED",[requestedKind??null])).rows;
  for(const row of candidates){
   await endAttempt(client,row,'interrupted');const subscribers=await authorizedSubscribers(client,row.id,{demote:true});
   if(!subscribers.length){await client.query("UPDATE derived_jobs SET status='approval-required',attempt_token=NULL,lease_expires_at=NULL,revision=revision+1,updated_at=now() WHERE id=$1",[row.id]);continue;}
   let source;try{source=await sourceFor(client,row.source_sha256);}catch(error){if(!['DERIVED_SOURCE_BLOCKED','DERIVED_SELECTION_INTEGRITY'].includes(error.code))throw error;await client.query("UPDATE derived_jobs SET status='blocked',attempt_token=NULL,lease_expires_at=NULL,error='DERIVED_SOURCE_BLOCKED',revision=revision+1,updated_at=now() WHERE id=$1",[row.id]);continue;}
   const token=randomUUID(),number=row.attempt_number+1;await client.query("INSERT INTO derived_attempts(token,job_id,number,state) VALUES($1,$2,$3,'running')",[token,row.id,number]);
   const job=(await client.query("UPDATE derived_jobs SET status='processing',attempt_token=$1,attempt_number=$2,lease_expires_at=clock_timestamp()+$3*interval '1 second',pause_reason=NULL,next_attempt_at=NULL,error=NULL,revision=revision+1,updated_at=now() WHERE id=$4 RETURNING *",[token,number,duration,row.id])).rows[0];return {...job,source,recipe:(await client.query('SELECT * FROM derived_recipes WHERE sha256=$1',[job.recipe_sha256])).rows[0],subscribers};
  }return null;
 });
}
export async function assertDerivedAttempt(pool,claim,{verifySource}={}){return transaction(pool,async client=>{const {row,source}=await live(client,claim,{verifySource});return {...row,source};});}
export async function renewDerivedJob(pool,claim,{leaseSeconds=120,verifySource}={}){const duration=seconds(leaseSeconds);return transaction(pool,async client=>{const {row}=await live(client,claim,{verifySource});return (await client.query("UPDATE derived_jobs SET lease_expires_at=clock_timestamp()+$1*interval '1 second' WHERE id=$2 RETURNING *",[duration,row.id])).rows[0];});}
export async function setDerivedPlan(pool,claim,value){
 if(!record(value)||Object.keys(value).some(key=>!['segments','sha256','manifest'].includes(key))||!Number.isSafeInteger(value.segments)||value.segments<1||value.segments>50000)throw fail('Некорректный план');
 const manifest=jsonObject(value.manifest,16777216);if(!Array.isArray(manifest.segments)||manifest.segments.length!==value.segments||manifest.segments.some((segment,index)=>!record(segment)||segment.ordinal!==index||!HASH.test(segment.sourceSha256)))throw fail('План должен содержать упорядоченные суммы исходных фрагментов');
 const hash=sha256(Buffer.from(canonicalJson(manifest)));if(value.sha256!==undefined&&checksum(value.sha256)!==hash)throw fail('Сумма плана не совпала.',409,'DERIVED_PLAN_CONFLICT');
 return transaction(pool,async client=>{const {row}=await live(client,claim);if(row.plan){if(row.plan_sha256!==hash||row.total_segments!==value.segments||canonicalJson(row.plan)!==canonicalJson(manifest))throw fail('Зафиксированный план изменился.',409,'DERIVED_PLAN_CONFLICT');return row;}return (await client.query('UPDATE derived_jobs SET plan=$1,plan_sha256=$2,total_segments=$3,revision=revision+1,updated_at=now() WHERE id=$4 RETURNING *',[JSON.stringify(manifest),hash,value.segments,row.id])).rows[0];});
}
export async function checkpointDerivedJob(pool,claim,value){
 if(!record(value)||Object.keys(value).some(key=>!['ordinal','sourceSha256','outputSha256','outputBytes','manifest'].includes(key))||!Number.isSafeInteger(value.ordinal)||value.ordinal<0||value.ordinal>=50000||!Number.isSafeInteger(value.outputBytes)||value.outputBytes<1||value.outputBytes>33554432)throw fail('Некорректная контрольная точка');
 const sourceSha=checksum(value.sourceSha256),outputSha=checksum(value.outputSha256),manifest=jsonObject(value.manifest);
 return transaction(pool,async client=>{const {row}=await live(client,claim);if(!row.plan||row.plan.segments[value.ordinal]?.sourceSha256!==sourceSha)throw fail('Фрагмент отсутствует в исходном плане.',409,'DERIVED_CHECKPOINT_SOURCE');
  const old=(await client.query('SELECT * FROM derived_checkpoints WHERE job_id=$1 AND ordinal=$2',[row.id,value.ordinal])).rows[0];if(old){if(old.source_sha256!==sourceSha||old.output_sha256!==outputSha||Number(old.output_bytes)!==value.outputBytes||canonicalJson(old.manifest)!==canonicalJson(manifest))throw fail('Готовый фрагмент уже имеет другой результат.',409,'DERIVED_CHECKPOINT_CONFLICT');return {...old,reused:true};}
  if(value.ordinal!==row.completed_segments)throw fail('Нельзя пропускать фрагменты.',409,'DERIVED_CHECKPOINT_ORDER');
  const saved=(await client.query('INSERT INTO derived_checkpoints(job_id,ordinal,attempt_token,source_sha256,output_sha256,output_bytes,manifest) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[row.id,value.ordinal,row.attempt_token,sourceSha,outputSha,value.outputBytes,JSON.stringify(manifest)])).rows[0];await client.query('UPDATE derived_jobs SET completed_segments=completed_segments+1,revision=revision+1,updated_at=now() WHERE id=$1',[row.id]);return {...saved,reused:false};
 });
}
export async function listDerivedCheckpoints(pool,claim){return transaction(pool,async client=>{const {row}=await live(client,claim);return (await client.query('SELECT * FROM derived_checkpoints WHERE job_id=$1 ORDER BY ordinal',[row.id])).rows;});}
export async function pauseDerivedJob(pool,claim,{reason='resource-pressure',retryAfterSeconds=30}={}){
 if(typeof reason!=='string'||!/^[-a-z0-9_]{1,120}$/.test(reason)||!Number.isSafeInteger(retryAfterSeconds)||retryAfterSeconds<1||retryAfterSeconds>86400)throw fail('Некорректная пауза');
 return transaction(pool,async client=>{await client.query('SELECT pg_advisory_xact_lock(84627196)');const row=await jobLock(client,claim?.id);if(!row||row.status!=='processing'||row.attempt_token!==identifier(claim.attempt_token??claim.attemptToken)||!row.lease_valid)return {stale:true};await endAttempt(client,row,'paused',reason);return (await client.query("UPDATE derived_jobs SET status='paused',pause_reason=$1,next_attempt_at=clock_timestamp()+$2*interval '1 second',lease_expires_at=NULL,attempt_token=NULL,revision=revision+1,updated_at=now() WHERE id=$3 RETURNING *",[reason,retryAfterSeconds,row.id])).rows[0];});
}
export async function failDerivedJob(pool,claim,error){
 return transaction(pool,async client=>{await client.query('SELECT pg_advisory_xact_lock(84627196)');const row=await jobLock(client,claim?.id);if(row?.status==='completed')return {published:true,result:(await client.query('SELECT * FROM derived_results WHERE job_id=$1',[row.id])).rows[0]};if(!row||row.status!=='processing'||row.attempt_token!==identifier(claim.attempt_token??claim.attemptToken)||!row.lease_valid||error?.code==='DERIVED_LEASE_LOST')return {stale:true};
  const approval=error?.code==='DERIVED_APPROVAL_REQUIRED',blocked=['DERIVED_SOURCE_BLOCKED','DERIVED_SELECTION_INTEGRITY'].includes(error?.code)||error?.code==='SCAN_THREAT'||Boolean(error?.threat||error?.blocked),paused=!blocked&&(['IMPORT_PAUSED','WORKER_STOPPING','RESOURCE_PRESSURE','GPU_OVERHEAT','THERMAL_PAUSE','SCAN_UNAVAILABLE','SCAN_STALE','SCAN_DEADLINE','SCAN_IDLE_TIMEOUT','SCAN_TRUNCATED','SCAN_PROTOCOL'].includes(error?.code)||transientDatabase(error)),reason=String(error?.code||error?.message||'DERIVED_FAILED').slice(0,600),state=approval?'approval-required':blocked?'blocked':paused?'paused':'failed';
  if(approval)await authorizedSubscribers(client,row.id,{demote:true});await endAttempt(client,row,paused||approval?'interrupted':'failed',reason);
  const next=(await client.query("UPDATE derived_jobs SET status=$1,error=$2,pause_reason=$3,next_attempt_at=CASE WHEN $4 THEN clock_timestamp()+interval '30 seconds' ELSE NULL END,lease_expires_at=NULL,attempt_token=NULL,revision=revision+1,updated_at=now() WHERE id=$5 RETURNING *",[state,paused?null:reason,paused?reason.slice(0,120):null,paused,row.id])).rows[0];await audit(client,null,'derived.'+state,row.id,{attempt:claim.attempt_token??claim.attemptToken,reason,...(blocked&&typeof error?.sha256==='string'&&HASH.test(error.sha256)?{rejectedSha256:error.sha256}:{})});return next;
 });
}
function resultValue(value){
 if(!record(value)||Object.keys(value).some(key=>!['manifest','sha256','bytes','workId','expressionId','editionId'].includes(key))||!Number.isSafeInteger(value.bytes)||value.bytes<1)throw fail('Некорректный готовый результат');
 const manifest=jsonObject(value.manifest,16777216),hash=checksum(value.sha256);if(sha256(Buffer.from(canonicalJson(manifest)))!==hash)throw fail('Сумма манифеста результата не совпала.',409,'DERIVED_RESULT_CONFLICT');return {...value,manifest,workId:identifier(value.workId),expressionId:identifier(value.expressionId),editionId:identifier(value.editionId)};
}
export async function finishDerivedJob(pool,claim,result,{publish,verifySource}={}){
 return transaction(pool,async client=>{const {row,source}=await live(client,claim,{verifySource});if(!row.plan||row.completed_segments!==row.total_segments||(await client.query('SELECT count(*)::int AS n FROM derived_checkpoints WHERE job_id=$1',[row.id])).rows[0].n!==row.total_segments)throw fail('Книга ещё не обработана полностью.',409,'DERIVED_INCOMPLETE');
  const output=resultValue(publish?await publish(client,row,source,result):result);if(output.workId!==source.work_id)throw fail('Результат принадлежит другому произведению.',409,'DERIVED_RESULT_IDENTITY');
  const expression=(await client.query('SELECT * FROM expressions WHERE id=$1 AND work_id=$2 FOR SHARE',[output.expressionId,output.workId])).rows[0],edition=(await client.query('SELECT * FROM editions WHERE id=$1 AND expression_id=$2 FOR SHARE',[output.editionId,output.expressionId])).rows[0];
  if(!expression||!edition||row.kind==='translation'&&(expression.kind!=='machine-translation'||expression.source_expression_id!==source.expression_id||output.expressionId===source.expression_id)||row.kind==='audio'&&output.expressionId!==source.expression_id)throw fail('Неверная связь оригинала и производного варианта.',409,'DERIVED_RESULT_IDENTITY');
  if(row.kind==='translation'){
   const ids=output.manifest.publicationIds;if(!Array.isArray(ids)||!ids.length||ids.length>20000||ids.some(value=>typeof value!=='string'||!UUID.test(value))||new Set(ids).size!==ids.length)throw fail('Нет полного списка публикаций перевода.',409,'DERIVED_RESULT_IDENTITY');
   const publications=(await client.query('SELECT * FROM books WHERE id=ANY($1::uuid[]) FOR SHARE',[ids])).rows;if(publications.length!==ids.length||publications.some(book=>book.work_id!==output.workId||book.expression_id!==output.expressionId||book.security_state!=='passed'||!book.artifact_manifest||!book.publication_manifest))throw fail('Публикации перевода не соответствуют готовому варианту.',409,'DERIVED_RESULT_IDENTITY');
  }
  // Recheck roles, pause and source after the root publication callback too.
  await live(client,claim);
  const saved=(await client.query('INSERT INTO derived_results(job_id,work_id,expression_id,edition_id,manifest,sha256,bytes) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[row.id,output.workId,output.expressionId,output.editionId,JSON.stringify(output.manifest),output.sha256,output.bytes])).rows[0];
  await endAttempt(client,row,'finished');await client.query("UPDATE derived_jobs SET status='completed',lease_expires_at=NULL,error=NULL,pause_reason=NULL,next_attempt_at=NULL,revision=revision+1,updated_at=now() WHERE id=$1",[row.id]);await client.query("UPDATE derived_requests SET status='completed',revision=revision+1,updated_at=now() WHERE job_id=$1 AND status='active'",[row.id]);await audit(client,null,'derived.completed',row.id,{kind:row.kind,sourceSha256:row.source_sha256,recipeSha256:row.recipe_sha256,resultSha256:output.sha256});return saved;
 });
}
