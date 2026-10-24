import {randomUUID} from 'node:crypto';
import {canonicalJson,sha256} from './publication-model.mjs';
import {validateBook} from './publication-files.mjs';
import {ranobeSlug} from './ranobe.mjs';

const MiB=1024*1024,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const OPEN=['queued','processing','pending-approval','source-review'],AUTO=['owner','trusted-import'];
const fail=(code,message,status=409)=>Object.assign(new Error(message),{code,status});
const lost=()=>fail('LEASE_LOST','Попытка полной загрузки устарела');
const checksum=value=>sha256(Buffer.from(canonicalJson(value)));
const text=(value,max,empty=false)=>typeof value==='string'&&value.length<=(max)&&value.isWellFormed()&&(empty||value.length>0)&&!/[\p{Cc}\p{Cf}]/u.test(value);
const uuid=value=>{if(!UUID.test(value||''))throw fail('RANOBE_INPUT','Некорректный идентификатор',400);return value;};
async function tx(pool,fn){const c=await pool.connect();try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}}
const audit=(c,actor,action,target,details={})=>c.query('INSERT INTO audit(actor,action,target,details) VALUES($1,$2,$3,$4)',[actor,action,target,JSON.stringify(details)]);
async function profile(c,id){const p=(await c.query('SELECT id,role FROM profiles WHERE id=$1 FOR SHARE',[uuid(id)])).rows[0];if(!p)throw fail('RANOBE_PROFILE','Профиль недоступен',403);return p;}
function requestInput(input){
 if(!input||Object.keys(input).some(k=>!['url','branch','language','autoUpdate','force','idempotencyKey'].includes(k))||!Object.hasOwn(input,'branch'))throw fail('RANOBE_INPUT','Нужно явно выбрать ветку, включая основную',400);
 const slug=ranobeSlug(input.url),branch=input.branch;
 if(branch!==null&&!(Number.isSafeInteger(branch)&&branch>=0)&&!(typeof branch==='string'&&/^\d{1,20}$/.test(branch)))throw fail('RANOBE_INPUT','Некорректная ветка',400);
 const language=input.language??'ru',autoUpdate=input.autoUpdate??true,force=input.force??false;
 if(typeof language!=='string'||!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(language)||language.length>30||typeof autoUpdate!=='boolean'||typeof force!=='boolean')throw fail('RANOBE_INPUT','Некорректные параметры полной загрузки',400);
 const branchId=branch===null?null:BigInt(branch).toString();
 return {url:`https://ranobelib.me/ru/book/${slug}`,slug,remoteId:slug.split('--')[0],branchKey:branchId??'default',branch:branchId,language:language.toLowerCase(),autoUpdate,force,idempotencyKey:uuid(input.idempotencyKey)};
}
export async function createRanobeRequest(pool,actor,input,options={}){return tx(pool,c=>createRanobeRequestInTransaction(c,actor,input,options));}
// Caller owns admission before entering this transaction. Capacity sees this same
// transaction and must not start a separate transaction or acquire admission again.
export async function createRanobeRequestInTransaction(c,actor,input,{checkCapacity,scheduled=false}={}){
 const data=requestInput(input),hash=checksum({...data,idempotencyKey:undefined});
 await c.query('SELECT pg_advisory_xact_lock(84627197)');const p=await profile(c,actor.id);
 const prior=(await c.query('SELECT * FROM ranobe_feed_requests WHERE profile_id=$1 AND idempotency_key=$2',[p.id,data.idempotencyKey])).rows[0];
 if(prior){if(prior.body_sha256!==hash)throw fail('RANOBE_IDEMPOTENCY','Этот ключ уже относится к другому запросу');return {request:prior,feed:(await c.query('SELECT * FROM ranobe_feeds WHERE id=$1',[prior.feed_id])).rows[0],import:(await c.query('SELECT * FROM imports WHERE id=$1',[prior.import_id])).rows[0],reused:true,idempotent:true};}
 const feedId=randomUUID();
 await c.query('INSERT INTO ranobe_feeds(id,remote_id,slug,branch_key,language,requested_by,approved_by,auto_update) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(provider,remote_id,branch_key,language) DO NOTHING',[feedId,data.remoteId,data.slug,data.branchKey,data.language,p.id,AUTO.includes(p.role)?p.id:null,data.autoUpdate]);
 let feed=(await c.query("SELECT * FROM ranobe_feeds WHERE provider='ranobelib' AND remote_id=$1 AND branch_key=$2 AND language=$3 FOR UPDATE",[data.remoteId,data.branchKey,data.language])).rows[0];
 let job=feed.active_import_id?(await c.query('SELECT * FROM imports WHERE id=$1',[feed.active_import_id])).rows[0]:null,reused=!!job&&OPEN.includes(job.status);
 if(job?.status==='blocked')throw fail('RANOBE_BLOCKED','Источник заблокирован; требуется решение владельца',423);
 if(reused&&data.force&&!job.options?.force)throw fail('RANOBE_FORCE_BUSY','Полная перепроверка возможна после текущей загрузки');
 if(reused&&job.status==='pending-approval'&&p.role==='owner'){
  // Do not wait for a parent row while holding the feed: a worker follows the
  // reverse order. A concurrently approved/claimed job asks this caller to retry.
  let pending;try{pending=(await c.query("SELECT * FROM imports WHERE id=$1 AND status='pending-approval' FOR UPDATE NOWAIT",[job.id])).rows[0];}catch(e){if(e.code==='55P03')throw fail('RANOBE_BUSY','Заявка меняется; повторите запрос');throw e;}
  if(pending){job=(await c.query("UPDATE imports SET status='queued',approved_by=$1,decision_reason='shared-owner-approval',error=NULL,updated_at=now() WHERE id=$2 RETURNING *",[p.id,job.id])).rows[0];await audit(c,p.id,'ranobe.shared-owner-approval',job.id,{feedId:feed.id,requestedBy:job.requested_by});}
 }
 if(!reused){
  if(scheduled){
   const subscriber=await profile(c,feed.requested_by),approver=feed.approved_by?await profile(c,feed.approved_by):null;
   if(!AUTO.includes(subscriber.role)&&approver?.role!=='owner')throw fail('APPROVAL_REVOKED','Автообновление требует действующего разрешения владельца',403);
   if(p.id!==subscriber.id)throw fail('RANOBE_SUBSCRIBER','Обновление принадлежит другому профилю',403);
  }
  const counts=(await c.query("SELECT count(*)::int AS total,count(*) FILTER(WHERE requested_by=$1)::int AS own FROM imports WHERE status=ANY($2::text[])",[p.id,[...OPEN,'uploading']])).rows[0];
  if(counts.total>=30||counts.own>=5)throw fail('RANOBE_QUOTA','Слишком много открытых заявок',429);
  if(typeof checkCapacity!=='function')throw fail('RANOBE_CAPACITY','Проверка резерва хранилища обязательна',500);await checkCapacity(c);
  const id=randomUUID(),auto=AUTO.includes(p.role)||(scheduled&&feed.approved_by),options={mode:'full',branch:data.branch,language:data.language,force:data.force,feedId:feed.id};
  job=(await c.query("INSERT INTO imports(id,requested_by,kind,filename,source_url,status,approved_by,decision_reason,options) VALUES($1,$2,'ranobe','RanobeLib — полная книга',$3,$4,$5,$6,$7) RETURNING *",[id,p.id,data.url,auto?'queued':'pending-approval',auto?(AUTO.includes(p.role)?p.id:feed.approved_by):null,auto?(AUTO.includes(p.role)?'role-auto-approval':'feed-owner-approval'):null,JSON.stringify(options)])).rows[0];
  await c.query("UPDATE ranobe_runs SET status='abandoned' WHERE feed_id=$1 AND status='building'",[feed.id]);
  feed=(await c.query("UPDATE ranobe_feeds SET active_import_id=$1,next_check_at=now()+update_interval_hours*interval '1 hour',revision=revision+1,updated_at=now() WHERE id=$2 RETURNING *",[id,feed.id])).rows[0];
 }
 const request=(await c.query('INSERT INTO ranobe_feed_requests(id,feed_id,profile_id,idempotency_key,body_sha256,import_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[randomUUID(),feed.id,p.id,data.idempotencyKey,hash,job.id])).rows[0];
 await audit(c,p.id,reused?'ranobe.request-shared':'ranobe.request-created',job.id,{feedId:feed.id,requestId:request.id,scheduled});return {feed,request,import:job,reused,idempotent:false};
}
export async function getRanobeFeed(pool,id){return (await pool.query('SELECT * FROM ranobe_feeds WHERE id=$1',[uuid(id)])).rows[0]??null;}
export async function listRanobeFeeds(pool,{limit=100}={}){if(!Number.isInteger(limit)||limit<1||limit>200)throw fail('RANOBE_INPUT','Некорректный размер списка',400);return (await pool.query('SELECT * FROM ranobe_feeds ORDER BY updated_at DESC,id LIMIT $1',[limit])).rows;}
export async function getRanobeRun(pool,id){return (await pool.query('SELECT * FROM ranobe_runs WHERE id=$1',[uuid(id)])).rows[0]??null;}
export async function getRanobeParts(pool,id){return (await pool.query('SELECT * FROM ranobe_run_parts WHERE run_id=$1 ORDER BY ordinal',[uuid(id)])).rows;}
export async function getRanobeChapters(pool,id,{after=-1,limit=50,includePrepared=true}={}){
 if(!Number.isInteger(after)||after< -1||after>19999||!Number.isInteger(limit)||limit<1||limit>200)throw fail('RANOBE_INPUT','Некорректное окно глав',400);
 const rows=(await pool.query(`SELECT m.*,c.raw_sha256,c.content_sha256,c.prepared_bytes,c.book_id,c.chapter_index,c.scanner_version,c.parser_version,${includePrepared?'c.prepared_book':'NULL::jsonb AS prepared_book'} FROM ranobe_run_chapters m LEFT JOIN ranobe_chapters c ON c.id=m.chapter_id WHERE m.run_id=$1 AND m.ordinal>$2 ORDER BY m.ordinal LIMIT $3`,[uuid(id),after,limit])).rows;return rows;
}
// Lock order: parent import -> settings/profile -> run -> feed -> source books
// (UUID order, SHARE) -> child import. Manual block UPDATE conflicts with SHARE.
// This is also a publishImport guard, on that publication transaction's client.
async function assertRanobeParent(c,parent){
 const job=(await c.query("SELECT *,lease_expires_at>clock_timestamp() AS live FROM imports WHERE id=$1 FOR UPDATE",[uuid(parent.id)])).rows[0];
 if(!job||job.attempt_token!==parent.attempt_token||job.status!=='processing'||!job.live||job.kind!=='ranobe'||job.options?.mode!=='full')throw lost();
 if((await c.query('SELECT imports_paused FROM settings WHERE id=1 FOR SHARE')).rows[0].imports_paused)throw fail('IMPORT_PAUSED','Импорт приостановлен',423);
 const p=await profile(c,job.requested_by);
 if(job.decision_reason==='role-auto-approval'){if(!AUTO.includes(p.role))throw fail('APPROVAL_REVOKED','Автоодобрение отозвано',403);}
 else if(!job.approved_by||(await profile(c,job.approved_by)).role!=='owner')throw fail('APPROVAL_REVOKED','Требуется действующее решение владельца',403);
 return job;
}
export async function assertRanobeRun(c,parent,runId,{sourceKeys}={}){
 const job=await assertRanobeParent(c,parent);
 const run=(await c.query('SELECT * FROM ranobe_runs WHERE id=$1 AND import_id=$2 FOR UPDATE',[uuid(runId),job.id])).rows[0];if(!run||run.status!=='building')throw lost();
 const feed=(await c.query('SELECT * FROM ranobe_feeds WHERE id=$1 FOR UPDATE',[run.feed_id])).rows[0];if(feed.active_import_id!==job.id)throw lost();
 // Optional on the publication transaction: hold every materialized source's
 // current security decision until COMMIT, rather than trusting a prior read.
 if(sourceKeys!==undefined)await assertCheckpointSources(c,run.id,sourceKeys);
 return {job,run,feed};
}
async function assertCheckpointSources(c,runId,keys=null){
 if(keys!==null&&(!Array.isArray(keys)||keys.length<1||keys.length>50||keys.some(key=>!text(key,180))||new Set(keys).size!==keys.length))throw fail('RANOBE_PART','Некорректные источники части',400);
 const rows=(await c.query("SELECT b.id,b.security_state FROM books b WHERE b.id IN(SELECT x.book_id FROM ranobe_run_chapters m JOIN ranobe_chapters x ON x.id=m.chapter_id WHERE m.run_id=$1 AND x.book_id IS NOT NULL AND ($2::text[] IS NULL OR m.source_key=ANY($2::text[]))) ORDER BY b.id FOR SHARE OF b",[runId,keys])).rows;
 if(rows.some(row=>row.security_state!=='passed'))throw Object.assign(fail('RANOBE_SOURCE_BLOCKED','Исходная часть заблокирована: новая публикация запрещена',423),{blocked:true});
}
function inventory(input){
 if(!input||!text(input.title,300)||!text(input.author,300,true)||!text(input.policyVersion,120)||!Array.isArray(input.chapters)||input.chapters.length<1||input.chapters.length>20000)throw fail('RANOBE_INVENTORY','Некорректное оглавление',400);
 const seen=new Set();return input.chapters.map(x=>{if(!x||!text(x.key,180)||seen.has(x.key)||!text(x.revisionHint??'',200,true)||!text(x.title??'',300,true)||!text(String(x.volume??''),80,true)||!text(String(x.number??''),80,true))throw fail('RANOBE_INVENTORY','Повторяющаяся или некорректная глава',400);seen.add(x.key);return {key:x.key,revisionHint:x.revisionHint??'',title:x.title??'',volume:String(x.volume??''),number:String(x.number??'')};});
}
export async function reuseUnchangedRanobeHead(pool,parent,input){
 const items=inventory(input),hash=checksum(items);
 input.signal?.throwIfAborted();
 if(typeof input.verifyBook!=='function')throw fail('RANOBE_VERIFY_REQUIRED','Нужна проверка сохранённых частей',500);
 const probe=await tx(pool,async c=>{
  const job=await assertRanobeParent(c,parent);if(job.options.force)return null;
  if((await c.query('SELECT 1 FROM ranobe_runs WHERE import_id=$1',[job.id])).rowCount)return null;
  const current=(await c.query('SELECT * FROM ranobe_feeds WHERE id=$1',[uuid(job.options.feedId)])).rows[0];if(!current||current.active_import_id!==job.id)throw lost();if(!current.head_run_id)return null;
  const run=(await c.query("SELECT * FROM ranobe_runs WHERE id=$1 AND feed_id=$2 AND status='ready' FOR SHARE",[current.head_run_id,current.id])).rows[0];
  if(!run||run.inventory_sha256!==hash||run.policy_version!==input.policyVersion||run.chapter_count!==items.length)return null;
  const feed=(await c.query('SELECT * FROM ranobe_feeds WHERE id=$1 FOR SHARE',[current.id])).rows[0];if(feed.active_import_id!==job.id||feed.head_run_id!==run.id)throw lost();return {run,feed};
 });
 if(!probe)return null;
 // Do not hold the parent while hashing potentially hundreds of immutable
 // packages: its heartbeat must be free to renew throughout verification.
 const inspected=(await pool.query('SELECT b.*,p.package_sha256 AS expected_package FROM ranobe_run_parts p JOIN books b ON b.id=p.book_id WHERE p.run_id=$1 AND p.status=\'ready\' ORDER BY p.ordinal',[probe.run.id])).rows,verified=new Map();
 for(const row of inspected){
  input.signal?.throwIfAborted();
  if(row.security_state!=='passed')throw Object.assign(fail('RANOBE_SOURCE_BLOCKED','Сохранённая часть заблокирована',423),{blocked:true});
  if(!row.artifact_manifest||!row.publication_manifest||row.package_sha256!==row.expected_package)throw fail('RANOBE_VERIFY_CHANGED','Сохранённая часть не прошла проверку',423);
  await input.verifyBook(row);verified.set(row.id,row.package_sha256);
 }
 return tx(pool,async c=>{
  input.signal?.throwIfAborted();
  const job=await assertRanobeParent(c,parent);
  const run=(await c.query("SELECT * FROM ranobe_runs WHERE id=$1 AND feed_id=$2 AND status='ready' FOR SHARE",[probe.run.id,probe.feed.id])).rows[0];
  const feed=(await c.query('SELECT * FROM ranobe_feeds WHERE id=$1 FOR UPDATE',[probe.feed.id])).rows[0];
  if(!run||feed?.active_import_id!==job.id||feed.head_run_id!==run.id||job.options.force||run.inventory_sha256!==hash||run.policy_version!==input.policyVersion||(await c.query('SELECT 1 FROM ranobe_runs WHERE import_id=$1',[job.id])).rowCount)throw lost();
  const locked=(await c.query("SELECT b.* FROM books b WHERE b.id IN(SELECT p.book_id FROM ranobe_run_parts p WHERE p.run_id=$1 UNION SELECT x.book_id FROM ranobe_run_chapters m JOIN ranobe_chapters x ON x.id=m.chapter_id WHERE m.run_id=$1 AND x.book_id IS NOT NULL) ORDER BY b.id FOR SHARE OF b",[run.id])).rows;
  if(locked.some(b=>b.security_state!=='passed'))throw Object.assign(fail('RANOBE_SOURCE_BLOCKED','Исходная часть заблокирована',423),{blocked:true});
  const byId=new Map(locked.map(b=>[b.id,b])),parts=(await c.query('SELECT * FROM ranobe_run_parts WHERE run_id=$1 ORDER BY ordinal FOR SHARE',[run.id])).rows;
  let covered=0;if(!parts.length)throw fail('RANOBE_INCOMPLETE','Нет сохранённых частей',423);
  for(const part of parts){const book=byId.get(part.book_id);if(part.status!=='ready'||part.ordinal!==covered||!book?.artifact_manifest||!book.publication_manifest||book.package_sha256!==part.package_sha256||verified.get(book.id)!==book.package_sha256||part.source_keys.some((key,i)=>items[covered+i]?.key!==key))throw fail('RANOBE_VERIFY_CHANGED','Состав сохранённой версии изменился',423);covered+=part.source_keys.length;}
  if(covered!==run.chapter_count)throw fail('RANOBE_INCOMPLETE','Не все главы входят в сохранённую версию',423);
  const report={...(job.report||{}),feedId:feed.id,runId:run.id,unchanged:true,chapters:run.chapter_count,parts:parts.map(p=>({id:p.id,bookId:p.book_id,chapters:p.source_keys.length})),sourceInventorySha256:hash};
  await c.query("UPDATE imports SET status='completed',security_state='passed',stage='Новых глав нет; сохранённая версия проверена',book_id=$1,report=$2,error=NULL,lease_expires_at=NULL,cleanup_pending=true,updated_at=now() WHERE id=$3",[parts[0].book_id,JSON.stringify(report),job.id]);
  await c.query("UPDATE import_attempts SET state='reused',reused_book_id=$1,ended_at=now() WHERE token=$2",[parts[0].book_id,parent.attempt_token]);
  await c.query('UPDATE ranobe_feed_requests SET result_run_id=$1 WHERE feed_id=$2 AND import_id=$3',[run.id,feed.id,job.id]);
  await c.query("UPDATE ranobe_feeds SET title=$1,author=$2,approved_by=$3,active_import_id=NULL,next_check_at=now()+update_interval_hours*interval '1 hour',revision=revision+1,updated_at=now() WHERE id=$4",[input.title,input.author,job.approved_by,feed.id]);
  await audit(c,null,'ranobe.head-reused',feed.id,{runId:run.id,importId:job.id,requestedBy:job.requested_by,chapters:run.chapter_count});
  return {...run,id:run.id,runId:run.id,feedId:feed.id,unchanged:true,parts};
 });
}
export async function beginRanobeRun(pool,parent,input){
 const items=inventory(input),hash=checksum(items);
 return tx(pool,async c=>{
  const existing=(await c.query('SELECT * FROM ranobe_runs WHERE import_id=$1',[uuid(parent.id)])).rows[0];
  if(existing){await assertRanobeRun(c,parent,existing.id);return existing;}
  // Bootstrap needs the same fenced parent check before the run exists.
  const job=(await c.query('SELECT *,lease_expires_at>clock_timestamp() AS live FROM imports WHERE id=$1 FOR UPDATE',[parent.id])).rows[0];
  if(job?.status!=='processing'||job.attempt_token!==parent.attempt_token||!job.live||job.options?.mode!=='full')throw lost();
  const feed=(await c.query('SELECT * FROM ranobe_feeds WHERE id=$1 FOR UPDATE',[uuid(job.options.feedId)])).rows[0];if(!feed||feed.active_import_id!==job.id)throw lost();
  const id=randomUUID(),run=(await c.query('INSERT INTO ranobe_runs(id,feed_id,import_id,previous_head_id,inventory_sha256,chapter_count,policy_version,force_revalidate) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[id,feed.id,job.id,feed.head_run_id,hash,items.length,input.policyVersion,Boolean(job.options.force)])).rows[0];
  await assertRanobeRun(c,parent,id);
  const payload=items.map((x,ordinal)=>({...x,ordinal}));
  await c.query("INSERT INTO ranobe_run_chapters(run_id,feed_id,ordinal,source_key,revision_hint,metadata) SELECT $1,$2,(x->>'ordinal')::int,x->>'key',x->>'revisionHint',x-'key'-'revisionHint'-'ordinal' FROM jsonb_array_elements($3::jsonb) x",[id,feed.id,JSON.stringify(payload)]);
  if(!run.force_revalidate)await c.query("UPDATE ranobe_run_chapters m SET chapter_id=(SELECT c.id FROM ranobe_chapters c LEFT JOIN books b ON b.id=c.book_id WHERE c.feed_id=m.feed_id AND c.source_key=m.source_key AND c.revision_hint=m.revision_hint AND c.policy_version=$2 AND (c.prepared_book IS NOT NULL OR (b.security_state='passed' AND b.artifact_manifest IS NOT NULL AND b.publication_manifest IS NOT NULL)) ORDER BY c.created_at DESC,c.id LIMIT 1) WHERE m.run_id=$1",[id,input.policyVersion]);
  await c.query('UPDATE ranobe_feeds SET title=$1,author=$2,approved_by=$3,updated_at=now() WHERE id=$4',[input.title,input.author,job.approved_by,feed.id]);
  await audit(c,null,'ranobe.run-started',id,{feedId:feed.id,importId:job.id,chapters:items.length,inventorySha256:hash});return run;
 });
}
// Stable across asset renumbering in bounded parts; includes rich structure IDs.
export function ranobeChapterFingerprint(book,index=0){
 validateBook(book);return chapterFingerprint(book,index);
}
function chapterFingerprint(book,index){
 const chapter=book.chapters[index];if(!chapter)throw fail('RANOBE_CHAPTER','Глава отсутствует');
 const normalize=value=>Array.isArray(value)?value.map(normalize):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,(k==='asset'||k==='resource')&&Object.hasOwn(book.assets,v)?'sha256:'+sha256(Buffer.from(book.assets[v],'base64')):normalize(v)])):value;
 return checksum(normalize({chapter,structure:book.structure?.chapters[index]??null}));
}
async function reclaimClosedCheckpoints(c,needed){
 let freed=0,cursor=null;
 while(freed<needed){
  const candidates=(await c.query("SELECT x.id,x.feed_id,x.source_key,x.content_sha256,x.prepared_bytes,x.created_at::text AS cursor_time FROM ranobe_chapters x WHERE x.prepared_book IS NOT NULL AND ($1::timestamptz IS NULL OR (x.created_at,x.id)>($1::timestamptz,$2::uuid)) AND NOT EXISTS(SELECT 1 FROM ranobe_run_chapters m JOIN ranobe_runs r ON r.id=m.run_id JOIN imports i ON i.id=r.import_id WHERE m.chapter_id=x.id AND (r.status='ready' OR r.status='building' AND i.status=ANY($3::text[]))) ORDER BY x.created_at,x.id LIMIT 100 FOR UPDATE OF x SKIP LOCKED",[cursor?.cursor_time??null,cursor?.id??null,OPEN])).rows;
  if(!candidates.length)break;
  for(const checkpoint of candidates){
   cursor=checkpoint;
   const total=Number((await c.query('SELECT count(*) AS n FROM ranobe_run_chapters WHERE chapter_id=$1',[checkpoint.id])).rows[0].n);
   // A retry/activation may have raced the candidate query. Lock its parents
   // without waiting: other workers may already own their own parent + quota.
   const refs=(await c.query('SELECT r.id,r.status AS run_status,i.status AS import_status FROM ranobe_run_chapters m JOIN ranobe_runs r ON r.id=m.run_id JOIN imports i ON i.id=r.import_id WHERE m.chapter_id=$1 FOR SHARE OF r,i SKIP LOCKED',[checkpoint.id])).rows;
   if(refs.length!==total||refs.some(r=>r.run_status==='ready'||r.run_status==='building'&&OPEN.includes(r.import_status)))continue;
   await c.query('UPDATE ranobe_run_chapters SET chapter_id=NULL WHERE chapter_id=$1',[checkpoint.id]);
   const removed=await c.query('DELETE FROM ranobe_chapters WHERE id=$1 AND prepared_book IS NOT NULL RETURNING id',[checkpoint.id]);
   if(removed.rowCount){freed+=checkpoint.prepared_bytes;await audit(c,null,'ranobe.checkpoint-evicted',checkpoint.id,{feedId:checkpoint.feed_id,sourceKey:checkpoint.source_key,contentSha256:checkpoint.content_sha256,bytes:checkpoint.prepared_bytes});}
   if(freed>=needed)break;
  }
 }
 return freed;
}
export async function saveRanobeChapter(pool,parent,runId,key,{book,rawSha256,scannerVersion,parserVersion}){
 validateBook(book);if(book.chapters.length!==1||!/^([a-f0-9]{64})$/.test(rawSha256)||!text(scannerVersion,300)||!text(parserVersion,120))throw fail('RANOBE_CHAPTER','Неверное подтверждение проверки главы',400);
 const bytes=Buffer.byteLength(canonicalJson(book)),fingerprint=ranobeChapterFingerprint(book);if(bytes>20*MiB)throw fail('RANOBE_CHAPTER_SIZE','Одна глава превышает безопасный лимит',413);
 return tx(pool,async c=>{
  const {run,feed}=await assertRanobeRun(c,parent,runId);if(book.language!==feed.language)throw fail('RANOBE_LANGUAGE','Язык главы не совпадает с подпиской');
  const item=(await c.query('SELECT * FROM ranobe_run_chapters WHERE run_id=$1 AND source_key=$2 FOR UPDATE',[run.id,key])).rows[0];if(!item)throw fail('RANOBE_CHAPTER','Главы нет в зафиксированном оглавлении');
  if(item.chapter_id){const old=(await c.query('SELECT * FROM ranobe_chapters WHERE id=$1',[item.chapter_id])).rows[0];if(old.content_sha256!==fingerprint)throw fail('RANOBE_CHECKPOINT_CONFLICT','Глава уже подготовлена с другим содержимым');return old;}
  await c.query('SELECT pg_advisory_xact_lock(84627198)');
  const existing=(await c.query('SELECT * FROM ranobe_chapters WHERE feed_id=$1 AND source_key=$2 AND revision_hint=$3 AND policy_version=$4 AND content_sha256=$5',[feed.id,key,item.revision_hint,run.policy_version,fingerprint])).rows[0];
  let saved=existing;
  if(!saved){let used=Number((await c.query('SELECT COALESCE(sum(prepared_bytes),0) AS bytes FROM ranobe_chapters WHERE prepared_book IS NOT NULL')).rows[0].bytes);if(used+bytes>64*MiB)used-=await reclaimClosedCheckpoints(c,used+bytes-64*MiB);if(used+bytes>64*MiB)throw fail('RANOBE_CACHE_FULL','Лимит проверенных незавершённых глав 64 МБ. Сначала сохраните готовые части.',507);await assertRanobeRun(c,parent,runId);
   saved=(await c.query('INSERT INTO ranobe_chapters(id,feed_id,source_key,revision_hint,policy_version,raw_sha256,content_sha256,prepared_book,prepared_bytes,scanner_version,parser_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',[randomUUID(),feed.id,key,item.revision_hint,run.policy_version,rawSha256,fingerprint,JSON.stringify(book),bytes,scannerVersion,parserVersion])).rows[0];}
  await c.query('UPDATE ranobe_run_chapters SET chapter_id=$1 WHERE run_id=$2 AND source_key=$3',[saved.id,run.id,key]);return saved;
 });
}
async function partItems(c,runId,keys){
 if(!Array.isArray(keys)||keys.length<1||keys.length>50||keys.some(k=>!text(k,180))||new Set(keys).size!==keys.length)throw fail('RANOBE_PART','Неверный диапазон части',400);
 const rows=(await c.query('SELECT m.*,c.content_sha256,c.prepared_book,c.book_id,c.chapter_index FROM ranobe_run_chapters m LEFT JOIN ranobe_chapters c ON c.id=m.chapter_id WHERE m.run_id=$1 AND m.source_key=ANY($2::text[]) ORDER BY m.ordinal FOR UPDATE OF m',[runId,keys])).rows;
 if(rows.length!==keys.length||rows.some((x,i)=>x.source_key!==keys[i]||!x.chapter_id||(i&&x.ordinal!==rows[i-1].ordinal+1)))throw fail('RANOBE_PART','Часть должна содержать последовательные подготовленные главы');return rows;
}
export async function beginRanobePart(pool,parent,runId,{keys,title,filename='RanobeLib part'}){
 if(!text(title,300)||!text(filename,300))throw fail('RANOBE_PART','Некорректное название части',400);
 return tx(pool,async c=>{
  const {job,run}=await assertRanobeRun(c,parent,runId),items=await partItems(c,runId,keys),hash=checksum(keys);
  let part=(await c.query('SELECT * FROM ranobe_run_parts WHERE run_id=$1 AND keys_sha256=$2 FOR UPDATE',[run.id,hash])).rows[0];
  if(!part){
   if((await c.query('SELECT 1 FROM ranobe_run_parts WHERE run_id=$1 AND source_keys ?| $2::text[] LIMIT 1',[run.id,keys])).rowCount)throw fail('RANOBE_PART_OVERLAP','Главы уже входят в другую часть');
   const childId=randomUUID();await c.query("INSERT INTO imports(id,requested_by,kind,filename,status,approved_by,decision_reason,options) VALUES($1,$2,'ranobe-part',$3,'processing',$4,$5,$6)",[childId,job.requested_by,filename,job.approved_by,job.decision_reason,JSON.stringify({ranobePart:{parentId:job.id,runId:run.id,keys,title}})]);
   part=(await c.query('INSERT INTO ranobe_run_parts(id,run_id,ordinal,keys_sha256,source_keys,import_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[randomUUID(),run.id,items[0].ordinal,hash,JSON.stringify(keys),childId])).rows[0];
  }
  const child=(await c.query('SELECT * FROM imports WHERE id=$1 FOR UPDATE',[part.import_id])).rows[0];
  if(child.status==='completed')return {...child,resultBookId:child.book_id,part};
  if(child.attempt_token)await c.query("UPDATE import_attempts SET state='interrupted',ended_at=now() WHERE token=$1 AND state IN('running','prepared','placed')",[child.attempt_token]);
  const token=randomUUID(),bookId=randomUUID(),number=child.attempt_number+1;
  await c.query("INSERT INTO import_attempts(token,import_id,number,book_id,state) VALUES($1,$2,$3,$4,'running')",[token,child.id,number,bookId]);
  const claimed=(await c.query("UPDATE imports SET status='processing',security_state='scanning',attempt_number=$1,attempt_token=$2,lease_expires_at=clock_timestamp()+interval '120 seconds',error=NULL,updated_at=now() WHERE id=$3 RETURNING *",[number,token,child.id])).rows[0];
  return {...claimed,resultBookId:bookId,part};
 });
}
async function commitPart(c,parent,runId,{bookId,keys,verifyBook,reuse=false}){
 if(typeof verifyBook!=='function')throw fail('RANOBE_VERIFY_REQUIRED','Нужна проверка опубликованного пакета',500);
   await assertRanobeRun(c,parent,runId,{sourceKeys:keys});const items=await partItems(c,runId,keys),part=(await c.query('SELECT * FROM ranobe_run_parts WHERE run_id=$1 AND keys_sha256=$2 FOR UPDATE',[runId,checksum(keys)])).rows[0];if(!part)throw fail('RANOBE_PART','Часть не зарегистрирована');
  const row=(await c.query('SELECT * FROM books WHERE id=$1 FOR SHARE',[uuid(bookId)])).rows[0],child=(await c.query('SELECT * FROM imports WHERE id=$1 FOR UPDATE',[part.import_id])).rows[0];
  if(!row||row.security_state!=='passed'||!row.artifact_manifest||!row.publication_manifest||(!reuse&&(child.status!=='completed'||child.book_id!==row.id)))throw fail('RANOBE_PART','Пакет части не опубликован или заблокирован',423);
  const inspected=await verifyBook(row),book=inspected?.content??inspected;validateBook(book);if(book.chapters.length!==keys.length||items.some((item,i)=>item.content_sha256!==chapterFingerprint(book,i)))throw fail('RANOBE_PART_HASH','Содержимое части не совпадает с проверенными главами',423);
  await assertRanobeRun(c,parent,runId);
  if(part.status==='ready'){if(part.book_id!==row.id||part.package_sha256!==row.package_sha256)throw fail('RANOBE_PART_CONFLICT','Часть уже зафиксирована');return part;}
  if(reuse){await c.query("UPDATE imports SET status='completed',security_state='passed',stage='Проверенная часть уже есть',book_id=$1,error=NULL,lease_expires_at=NULL,cleanup_pending=true,updated_at=now() WHERE id=$2",[row.id,child.id]);await c.query("UPDATE import_attempts SET state='reused',reused_book_id=$1,ended_at=now() WHERE token=$2",[row.id,child.attempt_token]);}
  for(let i=0;i<items.length;i++)if(items[i].prepared_book)await c.query('UPDATE ranobe_chapters SET prepared_book=NULL,book_id=$1,chapter_index=$2 WHERE id=$3 AND prepared_book IS NOT NULL',[row.id,i,items[i].chapter_id]);
  const result=(await c.query("UPDATE ranobe_run_parts SET status='ready',book_id=$1,package_sha256=$2 WHERE id=$3 RETURNING *",[row.id,row.package_sha256,part.id])).rows[0];await audit(c,null,'ranobe.part-ready',part.id,{runId,bookId:row.id,chapters:keys.length});return result;
}
export async function commitRanobePart(pool,parent,runId,options){return tx(pool,c=>commitPart(c,parent,runId,options));}
export async function reuseRanobePart(pool,parent,runId,options){await beginRanobePart(pool,parent,runId,{keys:options.keys,title:options.title||'RanobeLib — готовая часть'});return tx(pool,c=>commitPart(c,parent,runId,{...options,reuse:true}));}
export async function activateRanobeRun(pool,parent,runId,{verifyBook}={}){
 if(typeof verifyBook!=='function')throw fail('RANOBE_VERIFY_REQUIRED','Нужна проверка всех пакетов',500);
 // File hashing can take minutes for a 20k chapter novel. Do it without holding
 // the parent row, so its heartbeat can renew; commit rechecks every DB identity.
 const inspected=(await pool.query('SELECT p.book_id,b.* FROM ranobe_run_parts p JOIN books b ON b.id=p.book_id WHERE p.run_id=$1 AND p.status=\'ready\' ORDER BY p.ordinal',[uuid(runId)])).rows,verified=new Map();
 for(const row of inspected){await verifyBook(row);verified.set(row.id,row.package_sha256);}
 return tx(pool,async c=>{
   const {job,run,feed}=await assertRanobeRun(c,parent,runId,{sourceKeys:null}),parts=(await c.query('SELECT p.*,b.security_state,b.package_sha256 AS actual_package,b.artifact_manifest,b.publication_manifest FROM ranobe_run_parts p LEFT JOIN books b ON b.id=p.book_id WHERE p.run_id=$1 ORDER BY p.ordinal FOR SHARE OF p',[runId])).rows;
  const maps=(await c.query('SELECT ordinal,source_key,chapter_id FROM ranobe_run_chapters WHERE run_id=$1 ORDER BY ordinal',[runId])).rows;
  if(maps.length!==run.chapter_count||maps.some((x,i)=>x.ordinal!==i||!x.chapter_id)||!parts.length)throw fail('RANOBE_INCOMPLETE','Не все главы подготовлены');
  let covered=0;for(const part of parts){if(part.ordinal!==covered||part.status!=='ready'||part.security_state!=='passed'||part.package_sha256!==part.actual_package||!part.artifact_manifest||!part.publication_manifest||part.source_keys.some((key,i)=>maps[covered+i]?.source_key!==key))throw fail('RANOBE_INCOMPLETE','Неполный или повреждённый набор частей',423);covered+=part.source_keys.length;
   const row=(await c.query('SELECT * FROM books WHERE id=$1 FOR SHARE',[part.book_id])).rows[0];if(row?.security_state!=='passed'||verified.get(row.id)!==row.package_sha256)throw fail('RANOBE_VERIFY_CHANGED','Набор пакетов изменился после проверки',423);}
  if(covered!==run.chapter_count)throw fail('RANOBE_INCOMPLETE','Есть главы вне сохранённых частей');
  if(feed.head_run_id!==run.previous_head_id)throw fail('RANOBE_HEAD_CHANGED','Активная версия уже изменилась');
  await c.query("UPDATE ranobe_runs SET status='ready',activated_at=now() WHERE id=$1",[runId]);
  await c.query('UPDATE ranobe_feeds SET head_run_id=$1,active_import_id=NULL,revision=revision+1,next_check_at=now()+update_interval_hours*interval \'1 hour\',updated_at=now() WHERE id=$2',[runId,feed.id]);
  const report={...(job.report||{}),feedId:feed.id,runId,chapters:run.chapter_count,parts:parts.map(p=>({id:p.id,bookId:p.book_id,chapters:p.source_keys.length})),sourceInventorySha256:run.inventory_sha256};
  await c.query("UPDATE imports SET status='completed',security_state='passed',stage='Полная версия готова',book_id=$1,report=$2,error=NULL,lease_expires_at=NULL,cleanup_pending=true,updated_at=now() WHERE id=$3",[parts[0].book_id,JSON.stringify(report),job.id]);
  await c.query('UPDATE ranobe_feed_requests SET result_run_id=$1 WHERE feed_id=$2 AND import_id=$3',[runId,feed.id,job.id]);
  await c.query("UPDATE import_attempts SET state='published',ended_at=now() WHERE token=$1",[parent.attempt_token]);await audit(c,null,'ranobe.head-activated',feed.id,{runId,previousHeadId:run.previous_head_id,chapters:run.chapter_count,parts:parts.length});return {...run,status:'ready',parts};
 });
}
export async function registerRanobeScratch(pool,parent,runId,{token,key,rawSha256=null}){
 uuid(token);if(!text(key,180)||(rawSha256!==null&&!/^[a-f0-9]{64}$/.test(rawSha256)))throw fail('RANOBE_SCRATCH','Некорректный временный вход',400);
 return tx(pool,async c=>{await assertRanobeRun(c,parent,runId);if(!(await c.query('SELECT 1 FROM ranobe_run_chapters WHERE run_id=$1 AND source_key=$2',[runId,key])).rowCount)throw fail('RANOBE_CHAPTER','Глава отсутствует');return (await c.query('INSERT INTO ranobe_scratch(token,parent_attempt,run_id,source_key,raw_sha256) VALUES($1,$2,$3,$4,$5) RETURNING *',[token,parent.attempt_token,runId,key,rawSha256])).rows[0];});
}
// Remove tracker only AFTER owned quarantine/parser files have been removed.
export async function finishRanobeScratch(pool,parent,runId,token){return tx(pool,async c=>{await assertRanobeRun(c,parent,runId);return (await c.query('DELETE FROM ranobe_scratch WHERE token=$1 AND parent_attempt=$2 AND run_id=$3 RETURNING token',[uuid(token),parent.attempt_token,runId])).rowCount;});}
// Parser may finish an already copied job after cancellation. Retain its tracker
// beyond the bounded parser deadline before reaping any late output.
export async function listStaleRanobeScratch(pool,{limit=50}={}){if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw fail('RANOBE_INPUT','Некорректный размер списка',400);return (await pool.query("SELECT s.* FROM ranobe_scratch s JOIN import_attempts a ON a.token=s.parent_attempt JOIN imports i ON i.id=a.import_id WHERE NOT COALESCE(i.status='processing' AND i.attempt_token=s.parent_attempt AND i.lease_expires_at>clock_timestamp(),false) AND COALESCE(a.ended_at,i.lease_expires_at,s.created_at+interval '120 seconds')<clock_timestamp()-interval '70 seconds' ORDER BY s.created_at LIMIT $1",[limit])).rows;}
export async function removeStaleRanobeScratch(pool,token){
 return tx(pool,async c=>{const scratch=(await c.query('SELECT s.*,a.import_id FROM ranobe_scratch s JOIN import_attempts a ON a.token=s.parent_attempt WHERE s.token=$1',[uuid(token)])).rows[0];if(!scratch)return false;const job=(await c.query('SELECT *,lease_expires_at>clock_timestamp() AS live FROM imports WHERE id=$1 FOR UPDATE',[scratch.import_id])).rows[0];if(job.status==='processing'&&job.attempt_token===scratch.parent_attempt&&job.live)throw lost();return (await c.query('DELETE FROM ranobe_scratch WHERE token=$1',[token])).rowCount>0;});
}
export async function yieldRanobeRun(pool,parent,runId){return tx(pool,async c=>{await assertRanobeRun(c,parent,runId);await c.query("UPDATE import_attempts SET state='interrupted',ended_at=now() WHERE token=$1",[parent.attempt_token]);await c.query("UPDATE imports SET status='queued',security_state='pending',lease_expires_at=NULL,stage='Продолжение полной загрузки',updated_at=now() WHERE id=$1",[parent.id]);});}
export async function configureRanobeFeed(pool,actor,id,{autoUpdate,expectedRevision}){
 if(typeof autoUpdate!=='boolean'||!Number.isSafeInteger(expectedRevision)||expectedRevision<1)throw fail('RANOBE_INPUT','Некорректная настройка подписки',400);
 return tx(pool,async c=>{const p=await profile(c,actor.id),feed=(await c.query('SELECT * FROM ranobe_feeds WHERE id=$1 FOR UPDATE',[uuid(id)])).rows[0];if(!feed)throw fail('RANOBE_FEED','Подписка не найдена',404);if(p.role!=='owner'&&!(p.id===feed.requested_by&&AUTO.includes(p.role)))throw fail('RANOBE_PERMISSION','Настройка доступна владельцу или авторизованному инициатору',403);if(feed.revision!==expectedRevision)throw fail('RANOBE_REVISION','Подписка уже изменилась');const row=(await c.query('UPDATE ranobe_feeds SET auto_update=$1,approved_by=$2,revision=revision+1,updated_at=now() WHERE id=$3 RETURNING *',[autoUpdate,p.id,feed.id])).rows[0];await audit(c,p.id,'ranobe.subscription',feed.id,{autoUpdate});return row;});
}
export async function listDueRanobeFeeds(pool,{limit=5}={}){if(!Number.isSafeInteger(limit)||limit<1||limit>20)throw fail('RANOBE_INPUT','Некорректный размер очереди',400);return (await pool.query('SELECT f.* FROM ranobe_feeds f LEFT JOIN imports i ON i.id=f.active_import_id WHERE f.auto_update AND f.next_check_at<=now() AND (i.id IS NULL OR i.status NOT IN(\'queued\',\'processing\',\'pending-approval\',\'source-review\',\'blocked\')) ORDER BY f.next_check_at,f.id LIMIT $1',[limit])).rows;}
export async function enqueueRanobeUpdate(pool,id,{checkCapacity}={}){
 return tx(pool,async c=>{await c.query('SELECT pg_advisory_xact_lock(84627197)');const feed=(await c.query('SELECT * FROM ranobe_feeds WHERE id=$1 FOR UPDATE',[uuid(id)])).rows[0];if(!feed||!feed.auto_update||new Date(feed.next_check_at)>new Date())return null;
  const p=await profile(c,feed.requested_by),approver=feed.approved_by?await profile(c,feed.approved_by):null;
  if(!AUTO.includes(p.role)&&approver?.role!=='owner'){await c.query('UPDATE ranobe_feeds SET auto_update=false,revision=revision+1,updated_at=now() WHERE id=$1',[feed.id]);await audit(c,null,'ranobe.subscription-revoked',feed.id);return {revoked:true};}
  return createRanobeRequestInTransaction(c,p,{url:`https://ranobelib.me/ru/book/${feed.slug}`,branch:feed.branch_key==='default'?null:feed.branch_key,language:feed.language,autoUpdate:true,force:false,idempotencyKey:randomUUID()},{checkCapacity,scheduled:true});
 });
}
