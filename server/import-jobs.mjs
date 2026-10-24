import { randomUUID } from 'node:crypto';
import {assignBookModel,sealPublicationModel} from './work-model.mjs';
const lost=()=>Object.assign(new Error('Попытка устарела или срок владения задачей истёк'),{code:'LEASE_LOST'});
async function transaction(pool,fn){
 const client=await pool.connect();
 try{await client.query('BEGIN');const value=await fn(client);await client.query('COMMIT');return value;}
 catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
}
export async function claimImport(pool,leaseSeconds=120){
 return transaction(pool,async c=>{
  if((await c.query('SELECT imports_paused FROM settings WHERE id=1 FOR SHARE')).rows[0].imports_paused)return null;
  const row=(await c.query("SELECT * FROM imports WHERE kind<>'ranobe-part' AND (status='queued' OR (status='processing' AND (lease_expires_at IS NULL OR lease_expires_at<now()))) ORDER BY updated_at,created_at LIMIT 1 FOR UPDATE SKIP LOCKED")).rows[0];
  if(!row)return null;
  const existing=(await c.query('SELECT * FROM books WHERE import_id=$1',[row.id])).rows[0];
  if(existing){
   await c.query("UPDATE imports SET status='completed',book_id=$1,security_state=$2,stage='Готово',error=NULL,lease_expires_at=NULL,cleanup_pending=true WHERE id=$3",[existing.id,existing.security_state,row.id]);return null;
  }
  if(row.attempt_token)await c.query("UPDATE import_attempts SET state='interrupted',ended_at=now() WHERE token=$1 AND state IN('running','prepared','placed')",[row.attempt_token]);
  const token=randomUUID(),bookId=randomUUID(),number=row.attempt_number+1;
  await c.query("INSERT INTO import_attempts(token,import_id,number,book_id,state) VALUES($1,$2,$3,$4,'running')",[token,row.id,number,bookId]);
  return (await c.query("UPDATE imports SET status='processing',security_state='scanning',attempt_number=$1,attempt_token=$2,lease_expires_at=now()+$3*interval '1 second',error=NULL,updated_at=now() WHERE id=$4 RETURNING *",[number,token,leaseSeconds,row.id])).rows.map(r=>({...r,resultBookId:bookId}))[0];
 });
}
export async function renewImport(pool,row,leaseSeconds=120){
 const r=await pool.query("UPDATE imports SET lease_expires_at=now()+$1*interval '1 second' WHERE id=$2 AND attempt_token=$3 AND status='processing' AND lease_expires_at>now()",[leaseSeconds,row.id,row.attempt_token]);
 if(!r.rowCount)throw lost();
}
export async function assertAttempt(pool,row){
 const r=await pool.query("SELECT 1 FROM imports WHERE id=$1 AND attempt_token=$2 AND status='processing' AND lease_expires_at>now()",[row.id,row.attempt_token]);if(!r.rowCount)throw lost();
}
export async function attemptStage(pool,row,stage,report){
 const r=await pool.query("UPDATE imports SET stage=$1,report=COALESCE($2,report),updated_at=now() WHERE id=$3 AND attempt_token=$4 AND status='processing' AND lease_expires_at>now()",[stage,report?JSON.stringify(report):null,row.id,row.attempt_token]);if(!r.rowCount)throw lost();
}
export async function markPrepared(pool,row,manifest,state='prepared'){
 return transaction(pool,async c=>{
  const current=(await c.query("SELECT 1 FROM imports WHERE id=$1 AND attempt_token=$2 AND status='processing' AND lease_expires_at>now() FOR UPDATE",[row.id,row.attempt_token])).rowCount;
  if(!current)throw lost();
  await c.query('UPDATE import_attempts SET artifact_manifest=$1,state=$2 WHERE token=$3',[JSON.stringify(manifest),state,row.attempt_token]);
 });
}
export async function publishImport(pool,row,book,prepared,report,{verifyExisting,source=null,guard=null}={}){
 return transaction(pool,async c=>{
  if(guard)await guard(c);
  const current=(await c.query('SELECT *,lease_expires_at>now() AS lease_valid FROM imports WHERE id=$1 FOR UPDATE',[row.id])).rows[0];
  if(current?.attempt_token!==row.attempt_token||current.status!=='processing'||!current.lease_valid)throw lost();
  const state=(await c.query('SELECT * FROM settings WHERE id=1 FOR SHARE')).rows[0];if(state.imports_paused)throw Object.assign(new Error('Импорт приостановлен до публикации'),{code:'IMPORT_PAUSED'});
  const role=(await c.query('SELECT role FROM profiles WHERE id=$1 FOR SHARE',[current.requested_by])).rows[0]?.role;
  if(current.decision_reason==='role-auto-approval'&&!['owner','trusted-import'].includes(role))throw Object.assign(new Error('Автоодобрение отозвано'),{code:'APPROVAL_REVOKED'});
  const attempt=(await c.query('SELECT * FROM import_attempts WHERE token=$1 FOR UPDATE',[row.attempt_token])).rows[0];
  if(attempt?.state!=='placed'||attempt.book_id!==prepared.id||!equalManifest(attempt.artifact_manifest,prepared.manifest))throw new Error('Подготовленный результат не принадлежит попытке');
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,74))',[prepared.contentSha256]);
  const duplicate=(await c.query('SELECT * FROM books WHERE content_sha256=$1 FOR SHARE',[prepared.contentSha256])).rows[0];
  let result=prepared.id;
  if(duplicate){
   if(duplicate.security_state!=='passed')throw Object.assign(new Error('Такая копия уже заблокирована владельцем. Требуется отдельная проверка.'),{blocked:true});
   if(!verifyExisting)throw new Error('Повторная копия требует проверки существующего пакета');
   await verifyExisting(duplicate);result=duplicate.id;report={...report,deduplicatedTo:result};
  }else{
   const model=await assignBookModel(c,book,{source});
   const inserted=(await c.query('INSERT INTO books(id,title,author,language,chapter_count,sha256,import_id,requested_by,content_sha256,content_bytes,package_sha256,artifact_manifest,work_id,expression_id,edition_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *',[prepared.id,book.title,book.author,book.language,book.chapters.length,report.sha256,row.id,current.requested_by,prepared.contentSha256,prepared.contentBytes,prepared.packageSha256,JSON.stringify(prepared.manifest),model.work_id,model.expression_id,model.edition_id])).rows[0];
   await sealPublicationModel(c,inserted,book);
  }
  await c.query("UPDATE imports SET status='completed',security_state='passed',stage='Готово',book_id=$1,report=$2,error=NULL,lease_expires_at=NULL,cleanup_pending=true,cleanup_error=NULL,updated_at=now() WHERE id=$3",[result,JSON.stringify(report),row.id]);
  await c.query("UPDATE import_attempts SET state=$1,reused_book_id=$2,ended_at=now() WHERE token=$3",[duplicate?'reused':'published',duplicate?result:null,row.attempt_token]);
  await c.query('INSERT INTO audit(actor,action,target,details) VALUES(NULL,$1,$2,$3)',[duplicate?'import.reused':'import.published',result,JSON.stringify({importId:row.id,requestedBy:current.requested_by,attempt:row.attempt_token,packageSha256:duplicate?.package_sha256||prepared.packageSha256})]);
  return result;
 });
}
function equalManifest(a,b){return a?.schemaVersion===b.schemaVersion&&Array.isArray(a.files)&&a.files.length===b.files.length&&a.files.every((f,i)=>['path','bytes','sha256'].every(k=>f[k]===b.files[i][k]));}

// Also handles an ambiguous COMMIT response: an existing result wins over an error.
export async function failImport(pool,row,error,report){
 return transaction(pool,async c=>{
  const current=(await c.query('SELECT *,lease_expires_at>now() AS lease_valid FROM imports WHERE id=$1 FOR UPDATE',[row.id])).rows[0];
  const existing=(await c.query('SELECT id,security_state FROM books WHERE import_id=$1',[row.id])).rows[0];
  if(existing){
   await c.query("UPDATE imports SET status='completed',book_id=$1,security_state=$2,error=NULL,stage='Готово',lease_expires_at=NULL,cleanup_pending=true WHERE id=$3",[existing.id,existing.security_state,row.id]);return {published:true,bookId:existing.id};
  }
  if(current?.attempt_token!==row.attempt_token||current.status!=='processing'||!current.lease_valid||error.code==='LEASE_LOST')return {stale:true};
  if(['IMPORT_PAUSED','WORKER_STOPPING','APPROVAL_REVOKED'].includes(error.code)){
   await c.query("UPDATE imports SET status=$2,security_state='pending',stage='Ожидание продолжения или решения владельца',approved_by=CASE WHEN $2='pending-approval' THEN NULL ELSE approved_by END,decision_reason=CASE WHEN $2='pending-approval' THEN NULL ELSE decision_reason END,error=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1",[row.id,error.code==='APPROVAL_REVOKED'?'pending-approval':'queued']);
   await c.query("UPDATE import_attempts SET state='interrupted',ended_at=now() WHERE token=$1",[row.attempt_token]);return {paused:true};
  }
  const reason=String(error.message).slice(0,600),blocked=Boolean(error.threat||error.blocked),review=error.code==='IDENTITY_REVIEW';
  const failed={...report,failure:reason,failedAt:new Date().toISOString()};
  await c.query("UPDATE imports SET status=$1,security_state=$2,error=$3,report=$4,lease_expires_at=NULL,updated_at=now() WHERE id=$5",[review?'source-review':blocked?'blocked':'error',review?'pending':blocked?'blocked':'error',reason,JSON.stringify(failed),row.id]);
  await c.query("UPDATE import_attempts SET state='failed',error=$1,ended_at=now() WHERE token=$2",[reason,row.attempt_token]);
  await c.query('INSERT INTO audit(actor,action,target,details) VALUES(NULL,$1,$2,$3)',[review?'import.identity-review':blocked?'import.blocked':'import.error',row.id,JSON.stringify({reason,attempt:row.attempt_token})]);return {published:false};
 });
}

export async function reconcileAttempts(pool,remove){
 const rows=(await pool.query("SELECT a.* FROM import_attempts a WHERE a.state IN('running','prepared','placed','reused','failed','interrupted','cleaned') ORDER BY a.cleanup_checked_at NULLS FIRST,a.started_at LIMIT 100")).rows;
 let cleaned=0,failed=0;
 for(const attempt of rows)try{await transaction(pool,async c=>{
  // Parent lock fences a concurrent claim/publish; reference checks precede deletion.
  const row=(await c.query('SELECT *,lease_expires_at>now() AS lease_valid FROM imports WHERE id=$1 FOR UPDATE',[attempt.import_id])).rows[0];
  await c.query('UPDATE import_attempts SET cleanup_checked_at=now() WHERE token=$1',[attempt.token]);
  if(row?.status==='processing'&&row.attempt_token===attempt.token&&row.lease_valid)return;
  if((await c.query('SELECT 1 FROM books WHERE id=$1',[attempt.book_id])).rowCount)return;
  await remove(attempt);
  await c.query("UPDATE import_attempts SET state='cleaned',cleanup_error=NULL,ended_at=COALESCE(ended_at,now()) WHERE token=$1",[attempt.token]);cleaned++;
 });}catch(e){
  await pool.query('UPDATE import_attempts SET cleanup_error=$1,cleanup_checked_at=now() WHERE token=$2',[String(e.code||'CLEANUP_FAILED').slice(0,100),attempt.token]);failed++;
 }
 return {cleaned,failed};
}
