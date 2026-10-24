import fs from 'node:fs/promises';
import path from 'node:path';
const MiB=1024*1024;
const deny=(message,status)=>Object.assign(new Error(message),{status});

// One admission writer until its durable reservation/mutation has settled.
// Multipart bytes are covered by the committed uploading reservation, so the
// response lifecycle must never determine when this session lock is released.
export async function acquireImportAdmission(pool){
 const client=await pool.connect();let knownFree=false,released;
 try{
  const owned=(await client.query('SELECT pg_try_advisory_lock(84627192) AS owned')).rows[0].owned;
  knownFree=!owned;
  if(!owned)throw deny('Другая заявка сейчас сохраняется. Повторите через несколько секунд.',429);
  return ()=>released??=(async()=>{let broken;try{await client.query('SELECT pg_advisory_unlock(84627192)');}catch(e){broken=e;throw e;}finally{client.release(broken);}})();
 }catch(e){
  // A failed lock response can be ambiguous. Closing the session releases any
  // lock it may have acquired; returning that session to the pool would not.
  client.release(knownFree?undefined:e);throw e;
 }
}
export function assertImportRequestActive(req,res){
 // A fully consumed IncomingMessage can be destroyed during normal handling;
 // an incomplete destroyed request or destroyed response is a disconnect.
 if(req.aborted||(req.destroyed&&!req.complete)||res.destroyed)throw deny('Соединение прервано. Повторите запрос.',499);
}
export async function withImportAdmission(pool,req,res,operation){
 const release=await acquireImportAdmission(pool);
 try{
  const assertActive=()=>assertImportRequestActive(req,res);
  assertActive();return await operation(assertActive);
 }finally{await release();}
}
export async function checkImportCapacity(pool,quarantine,library,{exclude=null}={}){
 if((await pool.query('SELECT imports_paused FROM settings WHERE id=1')).rows[0].imports_paused)throw deny('Импорт приостановлен владельцем',423);
 const count=(await pool.query("SELECT count(*)::int AS open_count,count(*) FILTER(WHERE kind IN('file','upload','ranobe'))::int AS potential FROM imports WHERE status IN('uploading','queued','processing','pending-approval','source-review') AND ($1::uuid IS NULL OR id<>$1)",[exclude])).rows[0];
 if(count.open_count>=30)throw deny('Очередь заполнена: максимум 30 открытых заявок',429);
 let used=0,entries=0;
 for(const scope of ['incoming','attempts']){
  const directory=path.join(quarantine,scope);let names;
  try{const dir=await fs.lstat(directory);if(!dir.isDirectory()||dir.isSymbolicLink())throw deny('Недопустимое хранилище карантина',507);names=await fs.readdir(directory);}catch(e){if(e.code==='ENOENT')continue;throw e;}
  for(const name of names){
   if(++entries>100)throw deny('Карантин содержит слишком много объектов; требуется очистка закрытых задач',507);
   let stat;try{stat=await fs.lstat(path.join(directory,name));}catch(e){if(e.code==='ENOENT')continue;throw e;}
   if(!stat.isFile()||stat.isSymbolicLink())throw deny('Необычный объект в карантине; требуется проверка владельца',507);used+=stat.size;
  }
 }
 // Deliberately conservative: account for existing bytes AND the full input
 // plus attempt snapshot of each pending request. A crash leaves real bytes,
 // which remain counted even if no reservation row was committed.
 const reserved=(count.potential+1)*40*MiB;
 if(used+reserved>256*MiB)throw deny('Карантин заполнен с учётом ожидающих книг. Дождитесь обработки или очистите закрытые файлы.',507);
 const budgets=[[quarantine,reserved],[library,(count.potential+1)*60*MiB]],devices=new Map();
 // Named Docker volumes often share the same underlying disk. Reserving each
 // against the same free bytes independently would double-spend that space.
 for(const [directory,budget] of budgets){
  const [disk,entry]=await Promise.all([fs.statfs(directory),fs.stat(directory)]),free=Number(disk.bavail)*Number(disk.bsize);
  const group=devices.get(entry.dev)||{free,budget:0};group.free=Math.min(group.free,free);group.budget+=budget;devices.set(entry.dev,group);
 }
 for(const {free,budget}of devices.values())if(!Number.isFinite(free)||free<300*MiB+budget)throw deny('Недостаточно места с учётом совместного резерва карантина, публикации и метаданных',507);
 return {usedBytes:used,reservedBytes:reserved,openRequests:count.open_count};
}
