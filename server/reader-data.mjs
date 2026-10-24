import {createHash} from 'node:crypto';
import {normalizeReaderMutation,normalizeReaderPayload,validateReaderEntity,readerUuid,readerDataError,canonicalReaderJson,CATALOG_ENTITY_ID,READER_ENTITY_TYPES,readerMutationIdV2} from './reader-data-model.mjs';

export const READER_LIMITS=Object.freeze({batch:10,changes:100,retainedChanges:5000,retainedChangeBytes:8*1024*1024,retainedAccepted:1000,retainedReceiptBytes:8*1024*1024,journalRows:250000,journalBytes:96*1024*1024,entities:10000,reading:5000,bookmark:2000,devices:100});
const digest=value=>createHash('sha256').update(canonicalReaderJson(value)).digest('hex');
const numeric=value=>{const number=Number(value);if(!Number.isSafeInteger(number)||number<0)throw readerDataError('READER_INTEGRITY','Неверная версия данных читателя',423);return number;};
const fail=(code,message,status=409)=>{throw readerDataError(code,message,status);};
const profileId=profile=>readerUuid(typeof profile==='string'?profile:profile?.id);
export function readerEntityRecord(row){return validateReaderEntity({entityType:row.entity_type,entityId:row.entity_id,revision:row.revision,deleted:row.deleted,payload:row.payload,updatedAt:row.updated_at instanceof Date?row.updated_at.toISOString():row.updated_at});}
export function readerCursor(profile,revision){return Buffer.from(canonicalReaderJson({schemaVersion:1,profileId:profileId(profile),revision:numeric(revision)})).toString('base64url');}
export function parseReaderCursor(profile,value){
 if(typeof value!=='string'||value.length>200||!/^[A-Za-z0-9_-]+$/.test(value))fail('READER_CURSOR','Некорректный курсор синхронизации',400);
 let parsed;try{const bytes=Buffer.from(value,'base64url');if(bytes.toString('base64url')!==value)throw Error();parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('READER_CURSOR','Некорректный курсор синхронизации',400);}
 if(!parsed||Object.keys(parsed).sort().join(',')!=='profileId,revision,schemaVersion'||parsed.schemaVersion!==1||parsed.profileId!==profileId(profile)||!Number.isSafeInteger(parsed.revision)||parsed.revision<0)fail('READER_CURSOR','Курсор относится к другому профилю или версии',400);
 return parsed.revision;
}

export async function withReaderTransaction(pool,profile,operation){
 const id=profileId(profile),client=await pool.connect();
 try{
  await client.query('BEGIN');
  await client.query("SET LOCAL TIME ZONE 'UTC'");await client.query("SET LOCAL DateStyle TO 'ISO, YMD'");
  // Every writer reaches the global budget before a profile lock. Readers use
  // a separate MVCC snapshot and keep working when write admission is full.
  await client.query('SELECT pg_advisory_xact_lock(84627193)');
  if(!(await client.query('SELECT id FROM profiles WHERE id=$1 FOR KEY SHARE',[id])).rowCount)fail('READER_PROFILE','Профиль не найден',404);
  await client.query('INSERT INTO reader_profiles(profile_id) VALUES($1) ON CONFLICT DO NOTHING',[id]);
  const head=(await client.query('SELECT * FROM reader_profiles WHERE profile_id=$1 FOR UPDATE',[id])).rows[0];
  head.revision=numeric(head.revision);head.min_revision=numeric(head.min_revision);const original=head.revision;
  const result=await operation(client,id,head);
  if(head.revision!==original){
   const retained=(await client.query(`SELECT change_revision FROM (
    SELECT change_revision,row_number() OVER (ORDER BY change_revision DESC) AS n,
     sum(reader_journal_row_bytes('reader_changes',to_jsonb(t))) OVER (ORDER BY change_revision DESC) AS bytes
    FROM reader_changes t WHERE profile_id=$1
   ) retained WHERE n<=$2 AND bytes<=$3 ORDER BY change_revision LIMIT 1`,[id,READER_LIMITS.retainedChanges,READER_LIMITS.retainedChangeBytes])).rows[0];
   const floor=Math.max(head.min_revision,retained?numeric(retained.change_revision)-1:head.revision);
   await client.query('UPDATE reader_profiles SET revision=$2,min_revision=$3 WHERE profile_id=$1',[id,head.revision,floor]);
   await client.query('DELETE FROM reader_changes WHERE profile_id=$1 AND change_revision<=$2',[id,floor]);
  }
  await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK').catch(()=>{});if(error.code==='P0001'&&error.constraint?.startsWith('reader_journal_')){const mapped=readerDataError('READER_STORAGE_FULL','Достигнут безопасный объём журнала; сохранённые данные доступны, новые изменения приостановлены',429);mapped.snapshotRequired=false;throw mapped;}throw error;}finally{client.release();}
}
const transaction=withReaderTransaction;
async function readTransaction(pool,profile,operation){
 const id=profileId(profile),client=await pool.connect();
 try{
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  if(!(await client.query('SELECT id FROM profiles WHERE id=$1',[id])).rowCount)fail('READER_PROFILE','Профиль не найден',404);
  const saved=(await client.query('SELECT revision,min_revision FROM reader_profiles WHERE profile_id=$1',[id])).rows[0];
  const head={revision:numeric(saved?.revision??0),min_revision:numeric(saved?.min_revision??0)};
  const result=await operation(client,id,head);await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}
async function receipt(client,id,mutation,bodyHash){
 const previous=(await client.query('SELECT body_sha256,result FROM reader_mutations WHERE profile_id=$1 AND mutation_id=$2',[id,mutation.mutationId])).rows[0];
 if(!previous)return null;
 if(previous.body_sha256!==bodyHash)fail('READER_IDEMPOTENCY','Этот ID операции уже использован с другим содержимым');
 return previous.result;
}
async function device(client,id,mutation){
 const version=mutation.protocolVersion??1;
 let row=(await client.query('SELECT * FROM reader_devices WHERE profile_id=$1 AND device_id=$2',[id,mutation.deviceId])).rows[0];
 if(!row){
  const count=numeric((await client.query('SELECT count(*) AS n FROM reader_devices WHERE profile_id=$1',[id])).rows[0].n);
  if(count>=READER_LIMITS.devices)fail('READER_QUOTA','Достигнут лимит устройств синхронизации',429);
  await client.query('INSERT INTO reader_devices(profile_id,device_id,last_counter,protocol_version) VALUES($1,$2,0,$3)',[id,mutation.deviceId,version]);row={last_counter:0,protocol_version:version,compacted_through:0};
 }
 if(row.protocol_version!==version)fail('READER_PROTOCOL','Поток устройства закреплён за другой версией протокола; создайте новый ID потока');
 const next=numeric(row.last_counter)+1;
 if(version===2&&mutation.counter<=numeric(row.compacted_through)){
  const error=readerDataError('READER_RECEIPT_COMPACTED','Операция уже учтена; получите снимок и согласуйте локальную очередь',409);Object.assign(error,{consumed:true,snapshotRequired:true,expectedCounter:next});throw error;
 }
 if(mutation.counter!==next){const error=readerDataError('READER_COUNTER','Нарушен порядок операций устройства',409);error.expectedCounter=next;throw error;}
}

/** Caller holds withReaderTransaction's lock. Full conflicts are never removed.
 * Accepted v1 IDs keep an exact hash ledger; accepted v2 IDs are fenced forever
 * by their device's monotonic counter and immutable protocol. */
export async function compactReaderJournal(client,id){
 const candidates=(await client.query(`SELECT * FROM (
  SELECT t.*,d.protocol_version,row_number() OVER (ORDER BY t.created_at DESC,t.mutation_id) AS n,
   sum(reader_journal_row_bytes('reader_mutations',to_jsonb(t))) OVER (ORDER BY t.created_at DESC,t.mutation_id) AS retained_bytes
  FROM reader_mutations t JOIN reader_devices d USING(profile_id,device_id)
  WHERE t.profile_id=$1 AND t.result->>'status'='accepted' AND NOT t.compacted
 ) candidates WHERE n>$2 OR retained_bytes>$3 ORDER BY device_id,counter`,[id,READER_LIMITS.retainedAccepted,READER_LIMITS.retainedReceiptBytes])).rows;
 const compacted=new Map();
 for(const row of candidates){
  if(row.protocol_version===1){
   const result={mutationId:row.mutation_id,status:'accepted',compacted:true,entityType:row.entity_type,entityId:row.entity_id,revision:row.accepted_revision,snapshotRequired:true};
   await client.query('UPDATE reader_mutations SET compacted=true,body=NULL,canonical_body=NULL,result=$3 WHERE profile_id=$1 AND mutation_id=$2',[id,row.mutation_id,JSON.stringify(result)]);
  }else{
   let state=compacted.get(row.device_id);
   if(!state){const previous=(await client.query('SELECT compacted_through,compacted_accepted,compaction_sha256 FROM reader_devices WHERE profile_id=$1 AND device_id=$2',[id,row.device_id])).rows[0];state={through:numeric(previous.compacted_through),count:numeric(previous.compacted_accepted),sha:previous.compaction_sha256??'gargantua-reader-compaction-v1'};compacted.set(row.device_id,state);}
   state.through=Math.max(state.through,numeric(row.counter));state.count++;
   state.sha=createHash('sha256').update(state.sha+'\0'+row.mutation_id+'\0'+row.counter+'\0'+row.body_sha256).digest('hex');
   await client.query('DELETE FROM reader_mutations WHERE profile_id=$1 AND mutation_id=$2',[id,row.mutation_id]);
  }
 }
 for(const [deviceId,state]of compacted)await client.query('UPDATE reader_devices SET compacted_through=$3,compacted_accepted=$4,compaction_sha256=$5 WHERE profile_id=$1 AND device_id=$2',[id,deviceId,state.through,state.count,state.sha]);
 return candidates.length;
}
async function capacity(client,id,mutation,current){
 if(mutation.operation!=='upsert')return;
 if(!current){
  const total=numeric((await client.query('SELECT count(*) AS n FROM reader_entities WHERE profile_id=$1',[id])).rows[0].n);
  if(total>=READER_LIMITS.entities)fail('READER_QUOTA','Достигнут лимит сохранённых объектов и удалений',429);
 }
 if((!current||current.deleted)&&mutation.entityType!=='catalog'){
  const active=numeric((await client.query('SELECT count(*) AS n FROM reader_entities WHERE profile_id=$1 AND entity_type=$2 AND NOT deleted',[id,mutation.entityType])).rows[0].n);
  if(active>=READER_LIMITS[mutation.entityType])fail('READER_QUOTA','Достигнут лимит позиций или закладок',429);
 }
}

/** Internal bridge for legacy routes. Caller must hold withReaderTransaction's
 * profile lock. This function writes the same version/feed/projection atomically
 * but deliberately does not invent a modern device counter or receipt.
 */
export async function appendReaderEntityChange(client,id,head,input,services={}){
 const change={...input,entityId:readerUuid(input.entityId)};
 if(!READER_ENTITY_TYPES.includes(change.entityType)||!['upsert','delete'].includes(change.operation)||change.entityType==='catalog'&&change.entityId!==CATALOG_ENTITY_ID)fail('READER_VALIDATION','Недопустимая операция данных читателя',400);
 if(change.operation==='upsert'){
  change.payload=normalizeReaderPayload(change.entityType,change.payload);
  if(change.entityType==='reading'&&change.entityId!==change.payload.publicationId)fail('READER_VALIDATION','ID позиции должен совпадать с публикацией',400);
 }
 const current=(await client.query('SELECT * FROM reader_entities WHERE profile_id=$1 AND entity_type=$2 AND entity_id=$3',[id,change.entityType,change.entityId])).rows[0]??null;
 if(change.expectedRevision!==undefined){
  if(!Number.isSafeInteger(change.expectedRevision)||change.expectedRevision<0||change.expectedRevision>2147483646)fail('READER_VALIDATION','Недопустимая исходная версия',400);
  if(change.expectedRevision!==(current?.revision??0))return {status:'conflict',code:'REVISION_CONFLICT',current:current?readerEntityRecord(current):null};
 }else if(current?.modern_write)fail('READER_UPGRADE_REQUIRED','Эти данные уже изменены новым клиентом; обновите приложение для безопасной синхронизации');
 if((current?.revision??0)>=2147483647||head.revision>=Number.MAX_SAFE_INTEGER)fail('READER_REVISION_LIMIT','Исчерпан диапазон версий данных читателя',423);
 await capacity(client,id,change,current);
 if(!current&&change.operation==='delete'){
  const total=numeric((await client.query('SELECT count(*) AS n FROM reader_entities WHERE profile_id=$1',[id])).rows[0].n);
  if(total>=READER_LIMITS.entities)fail('READER_QUOTA','Достигнут лимит сохранённых объектов и удалений',429);
 }
 if(change.operation==='upsert'&&change.entityType!=='catalog'){
  if(typeof services.verifyPublication!=='function')fail('READER_VERIFIER_MISSING','Проверка публикации недоступна',503);
  const book=(await client.query('SELECT id,security_state FROM books WHERE id=$1 FOR SHARE',[change.payload.publicationId])).rows[0];
  if(!book)fail('READER_PUBLICATION','Публикация не найдена',404);
  if(book.security_state!=='passed')fail('READER_PUBLICATION_BLOCKED','Публикация заблокирована проверкой безопасности',423);
  await services.verifyPublication(change.payload.publicationId,change.payload.locator,{publicationRevision:change.payload.publicationRevision,client});
 }
 const payload=change.operation==='delete'?(current?.payload??null):change.payload,legacyId=change.legacyId===undefined?null:readerUuid(change.legacyId);
 const changed=(await client.query('INSERT INTO reader_entities(profile_id,entity_type,entity_id,revision,deleted,payload,legacy_id) VALUES($1,$2,$3,1,$4,$5,$6) ON CONFLICT(profile_id,entity_type,entity_id) DO UPDATE SET revision=reader_entities.revision+1,deleted=EXCLUDED.deleted,payload=EXCLUDED.payload,legacy_id=COALESCE(EXCLUDED.legacy_id,reader_entities.legacy_id),updated_at=now() RETURNING *',[id,change.entityType,change.entityId,change.operation==='delete',payload===null?null:JSON.stringify(payload),legacyId])).rows[0];
 const entity=readerEntityRecord(changed);head.revision++;
 await client.query('INSERT INTO reader_changes(profile_id,change_revision,entity_type,entity_id,record) VALUES($1,$2,$3,$4,$5)',[id,head.revision,change.entityType,change.entityId,JSON.stringify(entity)]);
 if(typeof services.projectEntity==='function')await services.projectEntity(client,id,entity,current);
 await client.query("INSERT INTO audit(actor,action,target,details) VALUES($1,'reader.changed',$2,$3)",[id,change.entityId,JSON.stringify({entityType:change.entityType,revision:entity.revision,deleted:entity.deleted})]);
 return {status:'accepted',entity};
}

/** Only persisted session profile IDs are passed by the route. Device IDs are
 * sequencing labels inside that profile, never authentication or fingerprints.
 * All mutations in a batch are atomic; consumed CAS conflicts are durable data.
 */
export async function applyReaderMutations(pool,profile,input,services={}){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>key!=='mutations')||!Array.isArray(input.mutations)||input.mutations.length>READER_LIMITS.batch)fail('READER_VALIDATION','Не больше 10 операций за один запрос',400);
 const mutations=input.mutations.map(normalizeReaderMutation);
 for(const mutation of mutations)if(mutation.protocolVersion===2&&mutation.mutationId!==readerMutationIdV2(profile,mutation.deviceId,mutation.counter))fail('READER_MUTATION_ID','ID операции версии 2 не соответствует профилю, устройству и счётчику',400);
 if(Buffer.byteLength(canonicalReaderJson(mutations))>256000)fail('READER_PAYLOAD_LIMIT','Пакет синхронизации превышает лимит',413);
 return transaction(pool,profile,async(client,id,head)=>{
  await compactReaderJournal(client,id);
  const results=[];
  for(const mutation of mutations){
   const bodyHash=digest(mutation),old=await receipt(client,id,mutation,bodyHash);
   if(old){results.push(old);continue;}
   await device(client,id,mutation);
   const changed=await appendReaderEntityChange(client,id,head,{entityType:mutation.entityType,entityId:mutation.entityId,operation:mutation.operation,payload:mutation.payload,expectedRevision:mutation.baseRevision},services);
   const result={mutationId:mutation.mutationId,...changed,...(changed.status==='conflict'?{proposed:mutation}:{})};
   await client.query('INSERT INTO reader_mutations(profile_id,mutation_id,device_id,counter,body_sha256,body,canonical_body,result,entity_type,entity_id,accepted_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[id,mutation.mutationId,mutation.deviceId,mutation.counter,bodyHash,JSON.stringify(mutation),canonicalReaderJson(mutation),JSON.stringify(result),mutation.entityType,mutation.entityId,result.status==='accepted'?result.entity.revision:null]);
   if(result.status==='accepted')await client.query('UPDATE reader_entities SET modern_write=true WHERE profile_id=$1 AND entity_type=$2 AND entity_id=$3',[id,mutation.entityType,mutation.entityId]);
   await client.query('UPDATE reader_devices SET last_counter=$3,updated_at=now() WHERE profile_id=$1 AND device_id=$2',[id,mutation.deviceId,mutation.counter]);
   if(result.status==='conflict')await client.query("INSERT INTO audit(actor,action,target,details) VALUES($1,'reader.conflict',$2,$3)",[id,mutation.entityId,JSON.stringify({mutationId:mutation.mutationId,entityType:mutation.entityType})]);
   results.push(result);
  }
  await compactReaderJournal(client,id);
  return {schemaVersion:1,cursor:readerCursor(id,head.revision),results};
 });
}

export async function readerSnapshot(pool,profile){return readTransaction(pool,profile,async(client,id,head)=>{
 const rows=(await client.query('SELECT * FROM reader_entities WHERE profile_id=$1 ORDER BY entity_type,entity_id LIMIT $2',[id,READER_LIMITS.entities+1])).rows;
 if(rows.length>READER_LIMITS.entities)fail('READER_QUOTA','Снимок данных превышает лимит',423);
 const devices=(await client.query('SELECT device_id,last_counter,protocol_version,compacted_through,compacted_accepted FROM reader_devices WHERE profile_id=$1 ORDER BY device_id',[id])).rows.map(row=>({deviceId:row.device_id,lastCounter:numeric(row.last_counter),protocolVersion:row.protocol_version,compactedThrough:numeric(row.compacted_through),compactedCount:numeric(row.compacted_accepted)}));
 return {schemaVersion:1,cursor:readerCursor(id,head.revision),entities:rows.map(readerEntityRecord),devices};
});}

export async function readerChanges(pool,profile,{cursor,limit=100}={}){
 if(!Number.isSafeInteger(limit)||limit<1||limit>READER_LIMITS.changes)fail('READER_VALIDATION','Размер страницы: от 1 до 100',400);
 const after=parseReaderCursor(profile,cursor);
 return readTransaction(pool,profile,async(client,id,head)=>{
  const latest=numeric(head.revision),floor=numeric(head.min_revision);
  if(after<floor)fail('READER_SNAPSHOT_REQUIRED','История изменений сокращена; получите полный снимок',409);
  if(after>latest)fail('READER_CURSOR','Курсор опережает данные сервера',409);
  const rows=(await client.query('SELECT change_revision,record FROM reader_changes WHERE profile_id=$1 AND change_revision>$2 ORDER BY change_revision LIMIT $3',[id,after,limit+1])).rows;
  const hasMore=rows.length>limit,selected=rows.slice(0,limit),position=hasMore?numeric(selected.at(-1).change_revision):latest;
  return {schemaVersion:1,cursor:readerCursor(id,position),changes:selected.map(row=>({changeRevision:numeric(row.change_revision),entity:validateReaderEntity(row.record)})),hasMore};
 });
}

function conflictCursor(profile,row){return Buffer.from(canonicalReaderJson({schemaVersion:1,profileId:profileId(profile),createdAt:row.created_at_text,mutationId:row.mutation_id})).toString('base64url');}
function parseConflictCursor(profile,value){
 if(value===undefined||value===null)return null;
 if(typeof value!=='string'||value.length>400||!/^[A-Za-z0-9_-]+$/.test(value))fail('READER_CURSOR','Некорректный курсор конфликтов',400);
 let parsed;
 try{const bytes=Buffer.from(value,'base64url');if(bytes.toString('base64url')!==value)throw Error();parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('READER_CURSOR','Некорректный курсор конфликтов',400);}
 if(!parsed||Object.keys(parsed).sort().join(',')!=='createdAt,mutationId,profileId,schemaVersion'||parsed.schemaVersion!==1||parsed.profileId!==profileId(profile)||typeof parsed.createdAt!=='string'||parsed.createdAt.length>40||!/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d{1,6})?[+-]\d\d(?::\d\d)?$/.test(parsed.createdAt))fail('READER_CURSOR','Курсор относится к другому профилю или версии',400);
 // Preserve PostgreSQL's microseconds verbatim. JS Date is used only to reject
 // impossible calendar components; it is never used to rebuild the SQL key.
 const [date,time]=parsed.createdAt.split(' '),[year,month,day]=date.split('-').map(Number),parts=/^(\d\d):(\d\d):(\d\d)(?:\.\d{1,6})?([+-])(\d\d)(?::(\d\d))?$/.exec(time);
 const calendar=new Date(0);calendar.setUTCFullYear(year,month-1,day);calendar.setUTCHours(0,0,0,0);
 if(year<1||calendar.getUTCFullYear()!==year||calendar.getUTCMonth()!==month-1||calendar.getUTCDate()!==day||!parts||Number(parts[1])>23||Number(parts[2])>59||Number(parts[3])>59||Number(parts[5])>15||Number(parts[6]??0)>59)fail('READER_CURSOR','Некорректное время курсора конфликтов',400);
 try{parsed.mutationId=readerUuid(parsed.mutationId);}catch{fail('READER_CURSOR','Некорректный ID курсора конфликтов',400);}
 return parsed;
}
export async function readerConflicts(pool,profile,{limit=50,cursor}={}){
 if(!Number.isSafeInteger(limit)||limit<1||limit>100)fail('READER_VALIDATION','Размер страницы: от 1 до 100',400);
 const after=parseConflictCursor(profile,cursor);
 return readTransaction(pool,profile,async(client,id)=>{
  // A deployment's DateStyle/TimeZone must not change a cursor's wire format.
  await client.query("SET LOCAL DateStyle TO 'ISO, YMD'");await client.query("SET LOCAL TIME ZONE 'UTC'");
  const rows=(await client.query("SELECT result,mutation_id,created_at::text AS created_at_text FROM reader_mutations WHERE profile_id=$1 AND result->>'status'='conflict' AND ($2::timestamptz IS NULL OR created_at<$2 OR (created_at=$2 AND mutation_id>$3::uuid)) ORDER BY created_at DESC,mutation_id LIMIT $4",[id,after?.createdAt??null,after?.mutationId??null,limit+1])).rows;
  const selected=rows.slice(0,limit),hasMore=rows.length>limit;
  return {conflicts:selected.map(row=>row.result),cursor:hasMore?conflictCursor(id,selected.at(-1)):null,hasMore};
 });
}
