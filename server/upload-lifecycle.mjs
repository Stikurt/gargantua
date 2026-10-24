import fs from 'node:fs/promises';
import path from 'node:path';
import {acquireImportAdmission} from './import-admission.mjs';
import {readBoundedFile} from './publication-files.mjs';

export async function assertUploadRetryable(row,quarantine){
 if(row.kind!=='upload')return;
 try{
  if(!row.filename)throw new Error('Incomplete upload');
  await readBoundedFile(path.join(quarantine,'incoming',row.id),20*1024*1024);
 }catch{
  throw Object.assign(new Error('Исходный файл загрузки отсутствует или передача не завершена. Выберите файл заново.'),{status:400});
 }
}

export async function expireIncompleteUploads(pool,quarantine){
 let release;
 try{release=await acquireImportAdmission(pool);}catch(e){if(e.status===429)return {busy:true,expired:0,cleanupErrors:0};throw e;}
 try{
  // Retry and purge use the same admission lock. The terminal row cannot be
  // requeued between this commit and removal of its incomplete input.
  const expired=await pool.query("UPDATE imports SET status='error',security_state='error',error='Передача файла была прервана. Повторно выберите файл.',updated_at=now() WHERE status='uploading' AND created_at<now()-interval '15 minutes' RETURNING id");
  let cleanupErrors=0;
  for(const row of expired.rows)try{await fs.unlink(path.join(quarantine,'incoming',row.id));}catch(e){if(e.code!=='ENOENT')cleanupErrors++;}
  return {busy:false,expired:expired.rowCount,cleanupErrors};
 }finally{await release();}
}
