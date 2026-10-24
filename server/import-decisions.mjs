export const canRetryImport=row=>['error','blocked'].includes(row?.status)||row?.status==='source-review'&&row.kind==='ranobe'&&row.options?.mode==='full';

export async function applyImportDecision(pool,{id,expectedStatus,action,actor=null,reason=''}){
 if(!['approve','retry','reject','cancel'].includes(action))throw new Error('Unsupported import decision');
 if(expectedStatus==='uploading'||expectedStatus==='completed'||(expectedStatus==='processing'&&action!=='cancel'))throw Object.assign(new Error('Эта передача или завершённая книга не допускает такое изменение.'),{status:409});
 if(action==='approve'&&expectedStatus!=='pending-approval'||action==='retry'&&!['error','blocked','source-review'].includes(expectedStatus))throw Object.assign(new Error('Состояние заявки не допускает это действие.'),{status:409});
 if(action==='cancel'&&!['queued','processing','pending-approval','source-review'].includes(expectedStatus))throw Object.assign(new Error('Заявка уже закрыта или файл ещё передаётся.'),{status:409});
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  if(action==='retry'&&expectedStatus==='source-review'){
   const owner=(await client.query("SELECT id FROM profiles WHERE id=$1 AND role='owner' FOR SHARE",[actor])).rows[0];
   if(!owner)throw Object.assign(new Error('Повтор проверки источника доступен только владельцу.'),{status:403});
   const current=(await client.query('SELECT status,kind,options FROM imports WHERE id=$1 FOR UPDATE',[id])).rows[0];
   if(current?.status!==expectedStatus||!canRetryImport(current))throw Object.assign(new Error('Повтор проверки требует поддерживаемый адаптер полной ветки RanobeLib.'),{status:409});
  }
  const next=action==='reject'?'rejected':action==='cancel'?'cancelled':'queued';
  const changed=await client.query("UPDATE imports SET status=$1,security_state='pending',stage='',error=NULL,approved_by=$2,decision_reason=$3,lease_expires_at=NULL,updated_at=now() WHERE id=$4 AND status=$5 RETURNING id,attempt_token",[next,actor,reason||'explicit-approval',id,expectedStatus]);
  if(!changed.rowCount)throw Object.assign(new Error('Заявка уже изменилась. Обновите список и повторите действие.'),{status:409});
  if(action==='cancel'&&changed.rows[0].attempt_token)await client.query("UPDATE import_attempts SET state='interrupted',ended_at=now() WHERE token=$1 AND state IN('running','prepared','placed')",[changed.rows[0].attempt_token]);
  await client.query('INSERT INTO audit(actor,action,target,details) VALUES($1,$2,$3,$4)',[actor,`import.${action}`,id,JSON.stringify({reason})]);
  await client.query('COMMIT');
 }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
}
