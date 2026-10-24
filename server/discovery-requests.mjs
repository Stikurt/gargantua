import {randomUUID} from 'node:crypto';
import {canonicalJson,sha256} from './publication-model.mjs';
import {interpretDiscoveryQuery,canExpandDiscoveryCandidate,canContinueDiscoveryPlan} from './discovery-providers.mjs';
import {requestedChapterRange} from './derived-selection.mjs';
import {WHOLE_PUBLICATION_METADATA_SQL,wholeLibraryPublication} from './discovery-whole-publication.mjs';

const ACTIVE=['pending-approval','queued','processing','needs-review','selected','acquiring'];
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const identifier=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(value);
const error=(message,status=400,code='DISCOVERY_INPUT')=>Object.assign(new Error(message),{status,code});
const id=value=>{if(typeof value!=='string'||!UUID.test(value))throw error('Некорректный ID');return value.toLowerCase();};
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const conflict=()=>error('Заявка уже изменилась. Обновите её и повторите действие.',409,'DISCOVERY_CONFLICT');
const lost=()=>error('Срок владения поиском истёк или попытка отменена.',409,'DISCOVERY_LEASE_LOST');
const revision=value=>{if(!Number.isSafeInteger(value)||value<1)throw error('Нужна актуальная revision');return value;};
const lease=value=>{value??=120;if(!Number.isSafeInteger(value)||value<1||value>600)throw error('Недопустимый срок владения');return value;};
const hasAuto=role=>role==='owner'||role==='trusted-import';
const RETRY_SECONDS=[5,30,120];
function transient(failure){return ['DISCOVERY_IMPORT_BUSY','DISCOVERY_SOURCE_BUSY','DISCOVERY_SOURCE_UNAVAILABLE','DEADLINE','SOURCE_UNAVAILABLE','FETCH_TIMEOUT','FETCH_IDLE_TIMEOUT','FETCH_DNS','FETCH_TRUNCATED','ECONNRESET','ECONNREFUSED','ETIMEDOUT','EAI_AGAIN','ENETUNREACH','EHOSTUNREACH','40001','40P01','55P03'].includes(failure?.code)||failure?.code==='FETCH_HTTP'&&[408,425,429,500,502,503,504].includes(failure?.httpStatus);}
async function transaction(pool,operation){const client=await pool.connect();try{await client.query('BEGIN');const result=await operation(client);await client.query('COMMIT');return result;}catch(failure){await client.query('ROLLBACK').catch(()=>{});throw failure;}finally{client.release();}}
async function actor(client,profile){const row=(await client.query('SELECT id,role FROM profiles WHERE id=$1 FOR SHARE',[id(profile?.id)])).rows[0];if(!row)throw error('Профиль недоступен',401,'DISCOVERY_AUTH');return row;}
async function audit(client,who,action,target,details={}){await client.query('INSERT INTO audit(actor,action,target,details) VALUES($1,$2,$3,$4)',[who,action,target,JSON.stringify(details)]);}
async function notPaused(client){if((await client.query('SELECT imports_paused FROM settings WHERE id=1 FOR SHARE')).rows[0].imports_paused)throw error('Импорт приостановлен',423,'IMPORT_PAUSED');}
async function authorize(client,row){
 const profile=(await client.query('SELECT role FROM profiles WHERE id=$1 FOR SHARE',[row.requested_by])).rows[0];
 if(row.decision_reason==='role-auto-approval')return hasAuto(profile?.role);
 if(!row.approved_by)return false;
 return (await client.query('SELECT role FROM profiles WHERE id=$1 FOR SHARE',[row.approved_by])).rows[0]?.role==='owner';
}
async function owned(client,profile,requestId){const who=await actor(client,profile),row=(await client.query('SELECT * FROM discovery_requests WHERE id=$1 FOR UPDATE',[id(requestId)])).rows[0];if(!row||row.requested_by!==who.id&&who.role!=='owner')throw error('Заявка не найдена',404,'DISCOVERY_NOT_FOUND');return {who,row};}
function normalize(input){
 if(!record(input)||Object.keys(input).some(key=>!['idempotencyKey','query','intent','language','audio','allowOriginal','chapterRange'].includes(key)))throw error('Запрос принимает название, без ссылок на скачивание');
 const key=id(input.idempotencyKey),intent=input.intent??'auto',language=input.language??'ru',audio=input.audio??true,allowOriginal=input.allowOriginal??false;
 if(typeof input.query!=='string'||/(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/iu.test(input.query))throw error('Укажите название или автора; загрузка по URL — отдельная операция');
 let interpreted;try{interpreted=interpretDiscoveryQuery(input.query,{intent});}catch{throw error('Укажите корректное название или автора от 2 до 300 символов');}
 if(!/^[a-z]{2}$/.test(language)||typeof audio!=='boolean'||typeof allowOriginal!=='boolean')throw error('Некорректные настройки языка или аудио');
 const legacy={query:interpreted.query,intent,language,audio,allowOriginal},body={...legacy,chapterRange:requestedChapterRange(input.chapterRange,'translation')};return {key,body,bodyHash:sha256(Buffer.from(canonicalJson(body))),legacyBodyHash:input.chapterRange===undefined?sha256(Buffer.from(canonicalJson(legacy))):null};
}
function outputsFor(input){return {book:{status:'pending'},translation:{status:'pending-provider',language:input.language},audio:{status:input.audio?'pending-provider':'not-requested'}};}
function planSnapshot(plan){
 if(!record(plan)||!Array.isArray(plan.candidates)||plan.candidates.length>20)throw error('Неверный план поиска');
 let encoded;try{encoded=canonicalJson(plan);}catch{throw error('План не сериализуется');}
 if(Buffer.byteLength(encoded)>128*1024)throw error('План превышает лимит',413,'DISCOVERY_PLAN_LIMIT');
 const saved=JSON.parse(encoded),seen=new Set();
 for(const candidate of saved.candidates){if(!record(candidate)||!identifier(candidate.id)||seen.has(candidate.id)||!['book','author','series'].includes(candidate.kind))throw error('Неверный или повторный кандидат');seen.add(candidate.id);}
 if(saved.selectedCandidateId!==undefined&&saved.selectedCandidateId!==null&&!seen.has(saved.selectedCandidateId))throw error('Выбор отсутствует в сохранённом плане');
 return saved;
}
function libraryCandidate(candidate){return candidate?.availability==='library'&&candidate.identity?.provider==='library'&&typeof candidate.bookId==='string'&&UUID.test(candidate.bookId)&&candidate.identity.remoteId===candidate.bookId;}
function ranobeIdentity(candidate){const source=candidate?.sourceBinding;return candidate?.kind==='book'&&candidate.identity?.provider==='ranobelib'&&source?.provider==='ranobelib'&&typeof candidate.identity.remoteId==='string'&&/^[1-9][0-9]{0,9}$/.test(candidate.identity.remoteId)&&source.remoteId===candidate.identity.remoteId&&typeof source.slug==='string'&&new RegExp('^'+candidate.identity.remoteId+'--[a-zA-Z0-9_-]{1,150}$').test(source.slug);}
function ranobeFullCandidate(candidate){const source=candidate?.sourceBinding;return ranobeIdentity(candidate)&&candidate.availability==='ranobe-full'&&candidate.eligibleForAcquisition===true&&Object.hasOwn(source,'branchId')&&(source.branchId===null||Number.isSafeInteger(source.branchId)&&source.branchId>0&&source.branchId<=999999999999999)&&source.completeness?.verified===true;}
function fetchable(candidate){return candidate?.kind==='book'&&candidate.eligibleForAcquisition===true&&!candidate.blockedReason&&!candidate.conflictingMetadata&&!candidate.identityEvidenceIncomplete&&(libraryCandidate(candidate)||ranobeFullCandidate(candidate)||candidate.identity?.provider!=='ranobelib'&&candidate.availability==='fetchable'&&Array.isArray(candidate.downloadSelections)&&candidate.downloadSelections.length>0);}
function selected(row){const candidate=row.plan?.candidates?.find(item=>item.id===row.selected_candidate_id);if(!fetchable(candidate))throw error('Нужен подтверждённый источник книги или уточнение ветки.',409,'DISCOVERY_NEEDS_REVIEW');return candidate;}
function exactSourceKey(row,selection){
 const candidate=selected(row),expected=selection?.expected;
 if(candidate.identity?.provider!=='gutendex'||candidate.sourceBinding?.provider!=='gutenberg'||candidate.sourceBinding?.copyright!==false||candidate.sourceBinding?.remoteId!==candidate.identity.remoteId||typeof candidate.identity.remoteId!=='string'||!/^[1-9][0-9]{0,9}$/.test(candidate.identity.remoteId)||!record(selection)||!candidate.downloadSelections.some(item=>canonicalJson(item)===canonicalJson(selection)))throw error('Файл не соответствует сохранённому выбору',409,'DISCOVERY_SELECTION');
 if(!record(expected)||expected.provider!=='gutenberg'||expected.remoteId!==candidate.identity.remoteId||expected.title!==candidate.title||!Array.isArray(candidate.authors)||canonicalJson(expected.authors)!==canonicalJson(candidate.authors.map(author=>author.name))||typeof expected.language!=='string'||!/^[a-z]{2}$/.test(expected.language)||!['epub','txt'].includes(selection.extension)||typeof selection.url!=='string'||selection.url.length>2000||selection.maxRedirects!==0||selection.requiresQuarantine!==true)throw error('Недостаточно проверенных данных источника',409,'DISCOVERY_SELECTION');
 const value={policy:'gutenberg-exact-file-v1',provider:'gutenberg',remoteId:candidate.identity.remoteId,url:selection.url,originalUrl:selection.originalUrl,extension:selection.extension,mimeType:selection.mimeType,expected};
 return sha256(Buffer.from(canonicalJson(value)));
}
function readyOutputs(row,book){return {book:{status:'ready',...(row.import_id?{importId:row.import_id}:{}),publicationId:book.id},translation:{status:book.language===row.input.language?'not-required':'pending-provider',language:row.input.language},audio:{status:row.input.audio?'pending-provider':'not-requested'}};}
async function importedReadyOutputs(client,row,imported){
 if(imported.kind==='ranobe'&&imported.options?.mode==='full'){
  const feedId=imported.options.feedId;if(!UUID.test(feedId||''))return null;
  // The completed import may have reused an earlier immutable head. Bind the
  // result to this profile's persisted initiative, never a mutable report field.
  const links=(await client.query('SELECT DISTINCT result_run_id FROM ranobe_feed_requests WHERE feed_id=$1 AND import_id=$2 AND profile_id=$3 AND result_run_id IS NOT NULL LIMIT 2',[feedId,row.import_id,row.requested_by])).rows;if(links.length!==1)return null;
  const snapshotId=links[0].result_run_id,run=(await client.query("SELECT * FROM ranobe_runs WHERE id=$1 AND feed_id=$2 AND status='ready' FOR SHARE",[snapshotId,feedId])).rows[0];if(!run)return null;
  const parts=(await client.query('SELECT p.*,b.language,b.security_state,b.artifact_manifest,b.publication_manifest,b.package_sha256 AS actual_package FROM ranobe_run_parts p LEFT JOIN books b ON b.id=p.book_id WHERE p.run_id=$1 ORDER BY p.ordinal FOR SHARE OF p',[run.id])).rows;
  let covered=0;if(!parts.length||parts.length>20000)return null;
  for(const part of parts){if(part.ordinal!==covered||part.status!=='ready'||!part.book_id||part.security_state!=='passed'||!part.artifact_manifest||!part.publication_manifest||part.package_sha256!==part.actual_package)return null;covered+=part.source_keys.length;}
  if(covered!==run.chapter_count)return null;
  const language=parts[0].language&&parts[0].language!=='und'&&parts.every(p=>p.language===parts[0].language)?parts[0].language:'und';
  return {book:{status:'ready',importId:row.import_id,multipart:true,feedId,snapshotId,chapterCount:run.chapter_count,publicationIds:parts.map(part=>part.book_id)},translation:{status:language!=='und'&&language===row.input.language?'not-required':'pending-provider',language:row.input.language},audio:{status:row.input.audio?'pending-provider':'not-requested'}};
 }
 const book=(await client.query("SELECT id,language FROM books WHERE id=$1 AND security_state='passed' AND artifact_manifest IS NOT NULL AND publication_manifest IS NOT NULL FOR SHARE",[imported.book_id])).rows[0];return book?readyOutputs(row,book):null;
}
async function live(client,claim,phase){const row=(await client.query('SELECT *,lease_expires_at>clock_timestamp() AS lease_valid FROM discovery_requests WHERE id=$1 FOR UPDATE',[id(claim.id)])).rows[0];if(!row||row.status!=='processing'||row.attempt_token!==id(claim.attempt_token??claim.attemptToken)||!row.lease_valid||phase&&row.phase!==phase)throw lost();return row;}

export async function createDiscoveryRequest(pool,profile,input){
 const normalized=normalize(input);
 return transaction(pool,async client=>{
  // Separate metadata-admission writer; no filesystem/network operations here.
  await client.query('SELECT pg_advisory_xact_lock(84627195)');const who=await actor(client,profile);
  const old=(await client.query('SELECT body_hash,request_id FROM discovery_idempotency WHERE profile_id=$1 AND key=$2',[who.id,normalized.key])).rows[0];
  if(old){if(old.body_hash!==normalized.bodyHash&&old.body_hash!==normalized.legacyBodyHash)throw error('Этот ключ уже использован с другим запросом',409,'DISCOVERY_IDEMPOTENCY');return {request:(await client.query('SELECT * FROM discovery_requests WHERE id=$1',[old.request_id])).rows[0],reused:true,idempotent:true};}
  // Reuse an active request for the same profile and options despite harmless
  // letter-case changes. This does not infer that two publications are equal.
  const {query,...options}=normalized.body;
  let row=(await client.query("SELECT * FROM discovery_requests WHERE requested_by=$1 AND status=ANY($2::text[]) AND lower(query_text)=lower($3) AND input-'query'=$4::jsonb ORDER BY created_at LIMIT 1 FOR UPDATE",[who.id,ACTIVE,query,JSON.stringify(options)])).rows[0];
  const reused=Boolean(row);
  if(!row){
   const counts=(await client.query('SELECT count(*)::int AS global,count(*) FILTER(WHERE requested_by=$1)::int AS personal FROM discovery_requests WHERE status=ANY($2::text[])',[who.id,ACTIVE])).rows[0];
   if(counts.personal>=5||counts.global>=30)throw error('Лимит активных запросов: 5 на профиль и 30 на сервер',429,'DISCOVERY_QUOTA');
   const auto=hasAuto(who.role),requestId=randomUUID();row=(await client.query('INSERT INTO discovery_requests(id,requested_by,body_hash,input,query_text,status,approved_by,decision_reason,outputs) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',[requestId,who.id,normalized.bodyHash,JSON.stringify(normalized.body),normalized.body.query,auto?'queued':'pending-approval',auto?who.id:null,auto?'role-auto-approval':null,JSON.stringify(outputsFor(normalized.body))])).rows[0];
  }
  await client.query('INSERT INTO discovery_idempotency(profile_id,key,body_hash,request_id) VALUES($1,$2,$3,$4)',[who.id,normalized.key,normalized.bodyHash,row.id]);
  await audit(client,who.id,reused?'discovery.reused':'discovery.created',row.id,{autoApproved:row.status==='queued'});return {request:row,reused,idempotent:false};
 });
}
export async function getDiscoveryRequest(pool,profile,requestId){return transaction(pool,async client=>(await owned(client,profile,requestId)).row);}
export async function listDiscoveryRequests(pool,profile,{limit=50}={}){if(!Number.isInteger(limit)||limit<1||limit>100)throw error('Недопустимый лимит');return transaction(pool,async client=>{const who=await actor(client,profile);return (await client.query('SELECT * FROM discovery_requests WHERE ($1::boolean OR requested_by=$2) ORDER BY created_at DESC,id DESC LIMIT $3',[who.role==='owner',who.id,limit])).rows;});}
export async function decideDiscoveryRequest(pool,profile,data){
 if(!record(data)||Object.keys(data).some(key=>!['id','action','expectedRevision','candidateId','planRevision','query','intent','language','allowOriginal','audio','chapterRange'].includes(key))||!['approve','cancel','select','retry','refine','more'].includes(data.action)||data.action!=='refine'&&['query','intent','language','allowOriginal','audio','chapterRange'].some(key=>data[key]!==undefined))throw error('Неизвестное действие поиска');revision(data.expectedRevision);
 return transaction(pool,async client=>{
  if(['retry','refine'].includes(data.action))await client.query('SELECT pg_advisory_xact_lock(84627195)');
  const {who,row}=await owned(client,profile,data.id);if(row.revision!==data.expectedRevision)throw conflict();
  if(data.action==='more'){
   if(row.status!=='needs-review'||row.import_id||data.planRevision!==undefined&&data.planRevision!==row.plan_revision||!record(row.plan?.plan)||!canContinueDiscoveryPlan(row.plan)||row.plan.continuationRequested===true)throw error('Следующая страница не подтверждена сохранённым планом. Уточните запрос.',409,'DISCOVERY_CONTINUATION');
   if(!await authorize(client,row))throw error('Требуется новое одобрение владельца',409,'DISCOVERY_APPROVAL_REQUIRED');
   const snapshot=planSnapshot({...row.plan,selectedCandidateId:null,continuationRequested:true}),outputs={...row.outputs,book:{status:'pending'}};
   const result=(await client.query("UPDATE discovery_requests SET status='queued',plan=$1,plan_revision=plan_revision+1,selected_candidate_id=NULL,phase=NULL,outputs=$2,retry_count=0,next_attempt_at=NULL,lease_expires_at=NULL,error=NULL,revision=revision+1,updated_at=now() WHERE id=$3 RETURNING *",[JSON.stringify(snapshot),JSON.stringify(outputs),row.id])).rows[0];
   await audit(client,who.id,'discovery.more',row.id,{revision:result.revision,planRevision:result.plan_revision,continuation:snapshot.plan.continuation});return result;
  }
  if(['retry','refine'].includes(data.action)){
   if(row.import_id||!(data.action==='retry'?['error']:['error','needs-review']).includes(row.status))throw error('Уточнить или повторить можно поиск без связанного импорта. Проверка источника требует отдельного решения.',409,'DISCOVERY_RESTART_REQUIRED');
   if(!ACTIVE.includes(row.status)){
    const counts=(await client.query('SELECT count(*)::int AS global,count(*) FILTER(WHERE requested_by=$1)::int AS personal FROM discovery_requests WHERE status=ANY($2::text[])',[row.requested_by,ACTIVE])).rows[0];
    if(counts.personal>=5||counts.global>=30)throw error('Лимит активных запросов: 5 на профиль и 30 на сервер',429,'DISCOVERY_QUOTA');
   }
   const refined=data.action==='refine',changes=Object.fromEntries(['query','intent','language','allowOriginal','audio','chapterRange'].filter(key=>data[key]!==undefined).map(key=>[key,data[key]])),normalized=refined?normalize({...row.input,...changes,idempotencyKey:randomUUID()}):null;
   const requester=(await client.query('SELECT role FROM profiles WHERE id=$1 FOR SHARE',[row.requested_by])).rows[0];
   const manual=who.role==='owner',auto=hasAuto(requester?.role),allowed=manual||auto||!refined&&await authorize(client,row);
   const next=allowed?(!refined&&row.phase==='acquisition'&&fetchable(row.plan?.candidates?.find(item=>item.id===row.selected_candidate_id))?'selected':'queued'):'pending-approval';
   const approved=manual?who.id:auto?row.requested_by:allowed?row.approved_by:null,reason=manual?'owner-approval':auto?'role-auto-approval':allowed?row.decision_reason:null;
   const input=normalized?.body??row.input,outputs=outputsFor(input);if(next==='selected')outputs.book.status='selected';
   const result=(await client.query('UPDATE discovery_requests SET input=$1,query_text=$2,body_hash=$3,status=$4,approved_by=$5,decision_reason=$6,plan=CASE WHEN $7 THEN NULL ELSE plan END,plan_revision=CASE WHEN $7 THEN 0 ELSE plan_revision END,selected_candidate_id=CASE WHEN $7 THEN NULL ELSE selected_candidate_id END,phase=CASE WHEN $7 THEN NULL ELSE phase END,outputs=$8,retry_count=0,next_attempt_at=NULL,acquisition_key=NULL,attempt_token=NULL,lease_expires_at=NULL,error=NULL,revision=revision+1,updated_at=now() WHERE id=$9 RETURNING *',[JSON.stringify(input),input.query,normalized?.bodyHash??row.body_hash,next,approved,reason,refined,JSON.stringify(outputs),row.id])).rows[0];
   await audit(client,who.id,'discovery.'+data.action,row.id,{revision:result.revision,...(refined?{previousInput:row.input,input}:{}),status:next});return result;
  }
  let next,choice=row.selected_candidate_id,outputs=row.outputs;
  if(data.action==='approve'){
   if(who.role!=='owner')throw error('Одобрение доступно владельцу',403,'DISCOVERY_FORBIDDEN');if(row.status!=='pending-approval')throw conflict();next=row.phase==='acquisition'&&fetchable(row.plan?.candidates?.find(item=>item.id===choice))?'selected':'queued';outputs={...outputs,book:{status:next==='selected'?'selected':'pending'}};
   await client.query("UPDATE discovery_requests SET approved_by=$1,decision_reason='owner-approval' WHERE id=$2",[who.id,row.id]);
  }else if(data.action==='select'){
   if(!['needs-review','selected'].includes(row.status)||data.planRevision!==row.plan_revision)throw conflict();if(!await authorize(client,row))throw error('Требуется новое одобрение владельца',409,'DISCOVERY_APPROVAL_REQUIRED');
   if(!identifier(data.candidateId))throw error('Нужен ID сохранённого кандидата');const candidate=row.plan?.candidates.find(item=>item.id===data.candidateId);if(!candidate)throw error('Кандидат отсутствует в этой версии плана',409,'DISCOVERY_SELECTION');
   // A metadata lookup may establish the missing language/source. Language
   // gates still apply to the later file acquisition, not this bounded lookup.
   const metadataAllowed=!candidate.blockedReason||['SOURCE_LANGUAGE_UNKNOWN','ORIGINAL_NOT_ALLOWED'].includes(candidate.blockedReason);
   const expand=metadataAllowed&&!candidate.conflictingMetadata&&!candidate.identityEvidenceIncomplete&&(canExpandDiscoveryCandidate(candidate)||ranobeIdentity(candidate)&&candidate.availability==='needs-preview');
   choice=candidate.id;next=expand?'queued':fetchable(candidate)?'selected':'needs-review';outputs={...outputs,book:{status:next==='queued'?'pending':next==='selected'?'selected':'needs-review'}};
  }else{
   if(row.status==='cancelled')throw conflict();next='cancelled';
   if(row.import_id){
    const linked=(await client.query('SELECT * FROM imports WHERE id=$1 FOR UPDATE',[row.import_id])).rows[0];
    const canCancel=linked?.requested_by===who.id||who.role==='owner';
    if(linked&&canCancel&&['queued','processing','pending-approval','source-review'].includes(linked.status)){
     await client.query("UPDATE imports SET status='cancelled',security_state='pending',stage='',error=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1",[row.import_id]);
     if(linked.attempt_token)await client.query("UPDATE import_attempts SET state='interrupted',ended_at=now() WHERE token=$1 AND state IN('running','prepared','placed')",[linked.attempt_token]);
     await audit(client,who.id,'import.cancel',row.import_id,{discoveryRequestId:row.id});
    }else if(linked?.status==='completed'&&linked.book_id){const ready=await importedReadyOutputs(client,row,linked);if(ready)outputs=ready;
    }else if(linked&&!canCancel)await audit(client,who.id,'discovery.import-detached',row.id,{importId:row.import_id});
   }
   if(row.attempt_token)await client.query("UPDATE discovery_attempts SET state='interrupted',ended_at=now() WHERE token=$1 AND state='running'",[row.attempt_token]);
   outputs={...outputs,book:outputs.book.status==='ready'?outputs.book:{status:'cancelled'},translation:outputs.translation.status==='not-required'?outputs.translation:{...outputs.translation,status:'cancelled'},audio:outputs.audio.status==='not-requested'?outputs.audio:{...outputs.audio,status:'cancelled'}};
  }
  const changed=(await client.query('UPDATE discovery_requests SET status=$1,selected_candidate_id=$2,outputs=$3,revision=revision+1,lease_expires_at=NULL,next_attempt_at=NULL,retry_count=0,error=NULL,updated_at=now() WHERE id=$4 RETURNING *',[next,choice,JSON.stringify(outputs),row.id])).rows[0];
  await audit(client,who.id,'discovery.'+data.action,row.id,{revision:changed.revision,planRevision:row.plan_revision,candidateId:data.action==='select'?choice:undefined});return changed;
 });
}
export async function claimDiscoveryRequest(pool,leaseSeconds=120){
 leaseSeconds=lease(leaseSeconds);
 return transaction(pool,async client=>{
  if((await client.query('SELECT imports_paused FROM settings WHERE id=1 FOR SHARE')).rows[0].imports_paused)return null;
  const row=(await client.query("SELECT * FROM discovery_requests WHERE (status IN('queued','selected') AND (next_attempt_at IS NULL OR next_attempt_at<=now())) OR (status='processing' AND lease_expires_at<now()) ORDER BY updated_at,created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED")).rows[0];if(!row)return null;
  if(!await authorize(client,row)){
   if(row.attempt_token)await client.query("UPDATE discovery_attempts SET state='interrupted',ended_at=now() WHERE token=$1 AND state='running'",[row.attempt_token]);
   await client.query("UPDATE discovery_requests SET status='pending-approval',approved_by=NULL,decision_reason=NULL,lease_expires_at=NULL,revision=revision+1,updated_at=now() WHERE id=$1",[row.id]);await audit(client,null,'discovery.approval-required',row.id);return null;
  }
  const phase=row.status==='selected'?'acquisition':row.status==='processing'?row.phase:'discovery';if(phase==='acquisition')selected(row);
  if(row.attempt_token)await client.query("UPDATE discovery_attempts SET state='interrupted',ended_at=now() WHERE token=$1 AND state='running'",[row.attempt_token]);
  const token=randomUUID(),number=row.attempt_number+1;await client.query("INSERT INTO discovery_attempts(token,request_id,number,phase,state) VALUES($1,$2,$3,$4,'running')",[token,row.id,number,phase]);
  const claimed=(await client.query("UPDATE discovery_requests SET status='processing',phase=$1,attempt_number=$2,attempt_token=$3,lease_expires_at=now()+$4*interval '1 second',next_attempt_at=NULL,revision=revision+1,error=NULL,updated_at=now() WHERE id=$5 RETURNING *",[phase,number,token,leaseSeconds,row.id])).rows[0];
  await audit(client,null,'discovery.claimed',row.id,{attempt:token,phase});return claimed;
 });
}
export async function renewDiscoveryRequest(pool,claim,leaseSeconds=120){leaseSeconds=lease(leaseSeconds);return transaction(pool,async client=>{const row=await live(client,claim);await notPaused(client);if(!await authorize(client,row))throw error('Право автоодобрения отозвано',403,'DISCOVERY_APPROVAL_REQUIRED');const result=await client.query("UPDATE discovery_requests SET lease_expires_at=now()+$1*interval '1 second' WHERE id=$2 RETURNING *",[leaseSeconds,row.id]);return result.rows[0];});}
export async function finishDiscoveryRequest(pool,claim,plan){
 const snapshot=planSnapshot(plan);
 return transaction(pool,async client=>{
  const row=await live(client,claim,'discovery');await notPaused(client);if(!await authorize(client,row))throw error('Требуется новое одобрение',403,'DISCOVERY_APPROVAL_REQUIRED');
  const choice=snapshot.selectedCandidateId??null,candidate=snapshot.candidates.find(item=>item.id===choice),nextAction=snapshot.nextAction==='acquire'||libraryCandidate(candidate)&&['reuse','already-server'].includes(snapshot.nextAction),auto=snapshot.status==='resolved'&&nextAction&&!snapshot.hasMore&&snapshot.candidates.filter(fetchable).length===1&&!(snapshot.providerErrors||[]).length&&!(snapshot.clarifications||[]).length&&fetchable(candidate);
  const next=auto?'selected':'needs-review',outputs={...row.outputs,book:{status:auto?'selected':'needs-review'}};
  const result=(await client.query('UPDATE discovery_requests SET status=$1,plan=$2,plan_revision=plan_revision+1,selected_candidate_id=$3,outputs=$4,lease_expires_at=NULL,next_attempt_at=NULL,retry_count=0,revision=revision+1,error=NULL,updated_at=now() WHERE id=$5 RETURNING *',[next,JSON.stringify(snapshot),choice,JSON.stringify(outputs),row.id])).rows[0];
  await client.query("UPDATE discovery_attempts SET state='finished',ended_at=now() WHERE token=$1",[row.attempt_token]);await audit(client,null,'discovery.planned',row.id,{planRevision:result.plan_revision,status:next});return result;
 });
}
export async function failDiscoveryRequest(pool,claim,failure){
 return transaction(pool,async client=>{
  let row;try{row=await live(client,claim);}catch(error){if(error.code==='DISCOVERY_LEASE_LOST')return {stale:true};throw error;}
  const paused=['IMPORT_PAUSED','WORKER_STOPPING'].includes(failure?.code),approval=failure?.code==='DISCOVERY_APPROVAL_REQUIRED';
  const retry=!paused&&!approval&&transient(failure)&&row.retry_count<RETRY_SECONDS.length,delay=retry?RETRY_SECONDS[row.retry_count]:null;
  const next=approval?'pending-approval':paused||retry?(row.phase==='acquisition'?'selected':'queued'):'error';
  const message=paused||approval?null:String(failure?.message||'Ошибка поиска').replace(/[\x00-\x1f\x7f]/g,' ').slice(0,600);
  const outputs={...row.outputs,book:{status:next==='error'?'error':next==='selected'?'selected':'pending'}};
  const result=(await client.query("UPDATE discovery_requests SET status=$1,error=$2,outputs=$3,approved_by=CASE WHEN $4 THEN NULL ELSE approved_by END,decision_reason=CASE WHEN $4 THEN NULL ELSE decision_reason END,lease_expires_at=NULL,next_attempt_at=CASE WHEN $5::int IS NULL THEN NULL ELSE now()+$5*interval '1 second' END,retry_count=retry_count+CASE WHEN $5::int IS NULL THEN 0 ELSE 1 END,revision=revision+1,updated_at=now() WHERE id=$6 RETURNING *",[next,message,JSON.stringify(outputs),approval,delay,row.id])).rows[0];
  await client.query('UPDATE discovery_attempts SET state=$1,error=$2,ended_at=now() WHERE token=$3',[paused||approval?'interrupted':'failed',message,row.attempt_token]);await audit(client,null,'discovery.failed',row.id,{code:failure?.code||'DISCOVERY_ERROR',status:next});return result;
 });
}
async function link(client,row,importId){
 // A shared feed callback holds its feed row. Do not lock the parent import
 // here (worker order is parent -> feed); linking never changes the import.
 const imported=(await client.query('SELECT id,requested_by,kind,status,options FROM imports WHERE id=$1',[id(importId)])).rows[0];
 let shared=false;
 if(imported?.kind==='ranobe'&&imported.options?.mode==='full'){
  const candidate=selected(row),source=candidate.sourceBinding,feedId=imported.options.feedId;
  if(ranobeFullCandidate(candidate)&&UUID.test(feedId||''))shared=Boolean((await client.query("SELECT 1 FROM ranobe_feed_requests r JOIN ranobe_feeds f ON f.id=r.feed_id WHERE r.feed_id=$1 AND r.import_id=$2 AND r.profile_id=$3 AND f.remote_id=$4 AND f.branch_key=$5 LIMIT 1",[feedId,imported.id,row.requested_by,source.remoteId,source.branchId===null?'default':String(source.branchId)])).rowCount);
 }
 if(imported?.kind==='file'&&row.acquisition_key)shared=Boolean((await client.query('SELECT 1 FROM discovery_requests WHERE acquisition_key=$1 AND import_id=$2 AND id<>$3 LIMIT 1',[row.acquisition_key,imported.id,row.id])).rowCount);
 if(!imported||!['file','ranobe'].includes(imported.kind)||!['queued','processing','completed','pending-approval','source-review'].includes(imported.status)||(imported.kind==='ranobe'&&imported.options?.mode==='full'?!shared:imported.requested_by!==row.requested_by&&!shared))throw error('Импорт не принадлежит выбранному запросу',409,'DISCOVERY_IMPORT');
 const outputs={...row.outputs,book:{status:'acquiring',importId:imported.id}};
 const result=(await client.query("UPDATE discovery_requests SET status='acquiring',import_id=$1,outputs=$2,lease_expires_at=NULL,revision=revision+1,updated_at=now() WHERE id=$3 RETURNING *",[imported.id,JSON.stringify(outputs),row.id])).rows[0];
 await client.query("UPDATE discovery_attempts SET state='finished',ended_at=now() WHERE token=$1",[row.attempt_token]);await audit(client,null,'discovery.import-linked',row.id,{importId:imported.id});return result;
}
export async function withDiscoveryAcquisition(pool,claim,createImport){
 if(typeof createImport!=='function')throw new TypeError('Нужен серверный обработчик импорта');
 return transaction(pool,async client=>{
  const row=await live(client,claim,'acquisition');if(claim.revision!==undefined&&row.revision!==claim.revision)throw conflict();
  if((await client.query('SELECT imports_paused FROM settings WHERE id=1 FOR SHARE')).rows[0].imports_paused)throw error('Импорт приостановлен',423,'IMPORT_PAUSED');
  if(!await authorize(client,row))throw error('Требуется новое одобрение',403,'DISCOVERY_APPROVAL_REQUIRED');selected(row);
  // Callback must use THIS client for INSERT/capacity decisions, never start
  // another transaction or perform network I/O while owning this row lock.
  const importId=await createImport(client,row);await live(client,claim,'acquisition');return link(client,row,importId);
 });
}
// Only an owner-controlled source adapter calls this helper after checking its
// URL/rights policy. The exact choice is re-read under the request lock; a
// stale claim or another edition cannot attach to an unrelated acquisition.
export async function withDiscoverySourceAcquisition(pool,claim,selection,createImport,{verifyExisting}={}){
 if(typeof createImport!=='function')throw new TypeError('Нужен серверный обработчик импорта');
 return transaction(pool,async client=>{
  let row=await live(client,claim,'acquisition');if(claim.revision!==undefined&&row.revision!==claim.revision)throw conflict();await notPaused(client);
  if(!await authorize(client,row))throw error('Требуется новое одобрение',403,'DISCOVERY_APPROVAL_REQUIRED');
  const key=exactSourceKey(row,selection);
  // Keyed transaction lock excludes duplicate work across profiles, while the
  // per-request rows preserve separate initiators and requested outputs.
  await client.query('SELECT pg_advisory_xact_lock($1::bigint)',[BigInt.asIntN(64,BigInt('0x'+key.slice(0,16))).toString()]);
  await live(client,claim,'acquisition');
  row=(await client.query('UPDATE discovery_requests SET acquisition_key=$1 WHERE id=$2 RETURNING *',[key,row.id])).rows[0];
  if(typeof verifyExisting==='function'){
   // A source may finish after this request's plan was saved. Reuse only a
   // unique publication with byte-bound identity proof and a fresh seal check.
   const matches=(await client.query("SELECT DISTINCT i.book_id FROM imports i JOIN books b ON b.id=i.book_id WHERE i.kind='file' AND i.status='completed' AND i.source_url=$1 AND i.filename LIKE $2 AND i.options->'discovery'->'expected'=$3::jsonb AND i.options->'discovery'->'download'=$4::jsonb AND i.report->'identityVerification'->'verified'='true'::jsonb AND i.report->'identityVerification'->>'inputSha256'=i.report->>'sha256' AND i.report->>'sha256' ~ '^[a-f0-9]{64}$' AND b.security_state='passed' AND b.artifact_manifest IS NOT NULL AND b.publication_manifest IS NOT NULL LIMIT 2",[selection.url,'%.'+selection.extension,JSON.stringify(selection.expected),JSON.stringify({url:selection.url,originalUrl:selection.originalUrl,mimeType:selection.mimeType,maxRedirects:0})])).rows;
   if(matches.length===1){
    const book=(await client.query("SELECT * FROM books WHERE id=$1 AND security_state='passed' AND artifact_manifest IS NOT NULL AND publication_manifest IS NOT NULL FOR SHARE",[matches[0].book_id])).rows[0];
    if(book){
     await verifyExisting(book);await live(client,claim,'acquisition');
     const ready=(await client.query("UPDATE discovery_requests SET status='book-ready',outputs=$1,lease_expires_at=NULL,next_attempt_at=NULL,retry_count=0,revision=revision+1,error=NULL,updated_at=now() WHERE id=$2 RETURNING *",[JSON.stringify(readyOutputs(row,book)),row.id])).rows[0];
     await client.query("UPDATE discovery_attempts SET state='finished',ended_at=now() WHERE token=$1",[row.attempt_token]);await audit(client,row.requested_by,'discovery.source-reused',row.id,{publicationId:book.id,key});return ready;
    }
   }
  }
  const existing=(await client.query("SELECT i.id FROM discovery_requests d JOIN imports i ON i.id=d.import_id WHERE d.acquisition_key=$1 AND d.id<>$2 AND i.kind='file' AND i.status IN('queued','processing','pending-approval') ORDER BY i.created_at,i.id LIMIT 1",[key,row.id])).rows[0];
  const importId=existing?.id??await createImport(client,row);
  await live(client,claim,'acquisition');
  const imported=(await client.query('SELECT kind,filename,source_url,options FROM imports WHERE id=$1',[id(importId)])).rows[0],download=imported?.options?.discovery?.download;
  if(imported?.kind!=='file'||imported.source_url!==selection.url||!imported.filename?.endsWith('.'+selection.extension)||canonicalJson(imported.options?.discovery?.expected??null)!==canonicalJson(selection.expected)||canonicalJson(download??null)!==canonicalJson({url:selection.url,originalUrl:selection.originalUrl,mimeType:selection.mimeType,maxRedirects:0}))throw error('Импорт не связан с выбранным файлом',409,'DISCOVERY_IMPORT');
  if(existing)await audit(client,row.requested_by,'discovery.source-shared',row.id,{importId,key});
  return link(client,row,importId);
 });
}
export async function linkDiscoveryImport(pool,data){return withDiscoveryAcquisition(pool,data,async()=>id(data.importId));}
export async function completeDiscoveryFromLibrary(pool,claim,bookId,{verifyExisting}={}){
 if(typeof verifyExisting!=='function')throw error('Повторное использование требует проверки существующего пакета',409,'DISCOVERY_VERIFICATION_REQUIRED');
 return transaction(pool,async client=>{
  const row=await live(client,claim,'acquisition');await notPaused(client);if(!await authorize(client,row))throw error('Требуется новое одобрение',403,'DISCOVERY_APPROVAL_REQUIRED');
  const candidate=selected(row);bookId=id(bookId);if(!libraryCandidate(candidate)||candidate.bookId!==bookId)throw error('Книга не соответствует выбранному плану',409,'DISCOVERY_SELECTION');
  const book=(await client.query(`SELECT b.*,${WHOLE_PUBLICATION_METADATA_SQL} FROM books b WHERE b.id=$1 FOR SHARE OF b`,[bookId])).rows[0];if(!book||book.security_state!=='passed'||!book.artifact_manifest||!book.publication_manifest)throw error('Книга недоступна или требует проверки',423,'DISCOVERY_LIBRARY_BLOCKED');
  const coverage=await wholeLibraryPublication(client,book,{lock:true});if(!coverage.whole)throw error('Эта публикация содержит часть книги или её полное происхождение не подтверждено',423,'DISCOVERY_LIBRARY_INCOMPLETE');
  for(const original of coverage.books)await verifyExisting(original);await live(client,claim,'acquisition');
  const result=(await client.query("UPDATE discovery_requests SET status='book-ready',outputs=$1,lease_expires_at=NULL,revision=revision+1,error=NULL,updated_at=now() WHERE id=$2 RETURNING *",[JSON.stringify(readyOutputs(row,book)),row.id])).rows[0];
  await client.query("UPDATE discovery_attempts SET state='finished',ended_at=now() WHERE token=$1",[row.attempt_token]);await audit(client,null,'discovery.library-reused',row.id,{publicationId:bookId});return result;
 });
}
export async function syncDiscoveryImport(pool,requestId){
 return transaction(pool,async client=>{
  const row=(await client.query('SELECT * FROM discovery_requests WHERE id=$1 FOR UPDATE',[id(requestId)])).rows[0];if(!row||!['acquiring','needs-review'].includes(row.status)||!row.import_id)return row||null;
  const imported=(await client.query('SELECT i.kind,i.status,i.book_id,i.options,i.report,b.language,b.security_state,b.artifact_manifest,b.publication_manifest FROM imports i LEFT JOIN books b ON b.id=i.book_id WHERE i.id=$1 FOR SHARE OF i',[row.import_id])).rows[0];
  // A supported adapter can be fixed after a fail-closed review. Only an
  // explicit owner retry of that same full Ranobe import resumes this link;
  // unknown sites and unrelated clarification states remain untouched.
  if(row.status==='needs-review'&&!(row.outputs?.book?.status==='identity-review'&&imported?.kind==='ranobe'&&imported.options?.mode==='full'&&['queued','processing','completed'].includes(imported.status)))return row;
  let next,outputs=row.outputs,reason=null;
  if(imported?.status==='completed'){
   const ready=await importedReadyOutputs(client,row,imported);if(ready){next='book-ready';outputs=ready;}else{next='error';outputs={...outputs,book:{status:'unavailable',importId:row.import_id}};}
  }else if(imported?.status==='source-review'){
   const reasons=Array.isArray(imported.report?.identityVerification?.reasons)?imported.report.identityVerification.reasons.filter(code=>typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(code)).slice(0,20):[];
   next='needs-review';reason='SOURCE_IDENTITY_REVIEW';outputs={...outputs,book:{status:'identity-review',importId:row.import_id,reasonCodes:reasons.length?reasons:['SOURCE_IDENTITY_REVIEW'],identityReport:{status:'review_required',verified:false,assurance:'metadata-consistency-only'}}};
  }else if(imported?.status==='pending-approval'){
   next='acquiring';reason='IMPORT_APPROVAL_REQUIRED';outputs={...outputs,book:{status:'approval-required',importId:row.import_id,reasonCodes:['IMPORT_APPROVAL_REQUIRED']}};
  }else if(imported&&['queued','processing'].includes(imported.status)&&['approval-required','identity-review'].includes(row.outputs.book.status)){
   next='acquiring';outputs={...outputs,book:{status:'acquiring',importId:row.import_id}};
  }else if(imported&&['error','blocked','rejected','cancelled'].includes(imported.status)){next='error';outputs={...outputs,book:{status:imported.status,importId:row.import_id}};}else return row;
  if(row.status===next&&row.error===reason&&canonicalJson(row.outputs)===canonicalJson(outputs))return row;
  const result=(await client.query('UPDATE discovery_requests SET status=$1,outputs=$2,error=$3,revision=revision+1,updated_at=now() WHERE id=$4 RETURNING *',[next,JSON.stringify(outputs),reason,row.id])).rows[0];await audit(client,null,'discovery.import-synced',row.id,{status:next,importId:row.import_id});return result;
 });
}
