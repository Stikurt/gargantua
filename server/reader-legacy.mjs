import {createHash,randomUUID} from 'node:crypto';
import {withReaderTransaction,appendReaderEntityChange} from './reader-data.mjs';
import {CATALOG_ENTITY_ID,readerUuid,readerDataError,normalizeReaderPayload,canonicalReaderJson} from './reader-data-model.mjs';
import {verifyReaderPublication} from './reader-publication.mjs';

const conflict=message=>{throw readerDataError('READER_LEGACY_CONFLICT',message,409);};
const mapCollision=error=>{if(error.code==='23505'&&['reader_legacy_bookmark_identity','bookmarks_pkey'].includes(error.constraint))conflict('Идентификатор закладки уже занят');throw error;};
async function legacyTransaction(...args){try{return await withReaderTransaction(...args);}catch(error){mapCollision(error);}}
function bookmarkAlias(profile,id){
 const bytes=createHash('sha256').update('gargantua-legacy-bookmark-v1\0'+profile+'\0'+id).digest().subarray(0,16);
 bytes[6]=(bytes[6]&15)|80;bytes[8]=(bytes[8]&63)|128;
 const hex=bytes.toString('hex');return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
}
/** A compatibility projection, never the authority for a v2 text anchor. */
async function legacyCoordinates(client,payload){
 if(payload.locator.type==='legacy')return {chapter:payload.locator.chapter,position:payload.locator.position};
 const row=(await client.query('SELECT publication_manifest FROM books WHERE id=$1',[payload.publicationId])).rows[0];
 const chapter=row?.publication_manifest?.readingOrder?.findIndex(entry=>entry.chapterId===payload.locator.chapterId);
 if(!Number.isInteger(chapter)||chapter<0)conflict('Глава публикации не найдена');
 // Publication-wide progression is not the old chapter scroll ratio.
 return {chapter,position:0};
}
async function project(client,profile,entity,prior){
 if(entity.entityType==='catalog'){
  await client.query('INSERT INTO profile_catalogs(profile_id,revision,catalogs,updated_at) VALUES($1,$2,$3,$4) ON CONFLICT(profile_id) DO UPDATE SET revision=EXCLUDED.revision,catalogs=EXCLUDED.catalogs,updated_at=EXCLUDED.updated_at',[profile,entity.revision,JSON.stringify(entity.deleted?[]:entity.payload.catalogs),entity.updatedAt]);return;
 }
 if(entity.entityType==='reading'){
  if(entity.deleted){await client.query('DELETE FROM reading WHERE profile_id=$1 AND book_id=$2',[profile,entity.entityId]);return;}
  const coordinates=await legacyCoordinates(client,entity.payload);
  await client.query('INSERT INTO reading(profile_id,book_id,chapter,position,shelf,updated_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(profile_id,book_id) DO UPDATE SET chapter=EXCLUDED.chapter,position=EXCLUDED.position,shelf=EXCLUDED.shelf,updated_at=EXCLUDED.updated_at',[profile,entity.entityId,coordinates.chapter,coordinates.position,entity.payload.shelf,entity.updatedAt]);return;
 }
 const saved=(await client.query("SELECT legacy_id FROM reader_entities WHERE profile_id=$1 AND entity_type='bookmark' AND entity_id=$2",[profile,entity.entityId])).rows[0];
 const legacyId=saved?.legacy_id??prior?.legacy_id??bookmarkAlias(profile,entity.entityId);
 await client.query("UPDATE reader_entities SET legacy_id=$3 WHERE profile_id=$1 AND entity_type='bookmark' AND entity_id=$2",[profile,entity.entityId,legacyId]);
 if(entity.deleted){await client.query('DELETE FROM bookmarks WHERE id=$1 AND profile_id=$2',[legacyId,profile]);return;}
 const coordinates=await legacyCoordinates(client,entity.payload);
 const result=await client.query('INSERT INTO bookmarks(id,profile_id,book_id,chapter,position,note,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET chapter=EXCLUDED.chapter,position=EXCLUDED.position,note=EXCLUDED.note WHERE bookmarks.profile_id=EXCLUDED.profile_id AND bookmarks.book_id=EXCLUDED.book_id RETURNING id',[legacyId,profile,entity.payload.publicationId,coordinates.chapter,coordinates.position,entity.payload.note,entity.updatedAt]);
 if(!result.rowCount)conflict('Идентификатор закладки уже занят');
}
export async function projectReaderEntity(...args){try{return await project(...args);}catch(error){mapCollision(error);}}
const services=pool=>({verifyPublication:(id,locator,options)=>verifyReaderPublication(pool,id,locator,options),projectEntity:projectReaderEntity});

export async function saveLegacyReading(pool,profile,book,data){
 const payload=normalizeReaderPayload('reading',{publicationId:book.id,publicationRevision:1,locator:{type:'legacy',chapter:data.chapter,position:data.position},shelf:data.shelf});
 return legacyTransaction(pool,profile,async(client,id,head)=>{
  const current=(await client.query("SELECT * FROM reader_entities WHERE profile_id=$1 AND entity_type='reading' AND entity_id=$2",[id,book.id])).rows[0];
  if(current&&!current.deleted&&canonicalReaderJson(current.payload)===canonicalReaderJson(payload))return {ok:true};
  await appendReaderEntityChange(client,id,head,{entityType:'reading',entityId:book.id,operation:'upsert',payload},services(pool));return {ok:true};
 });
}
export async function saveLegacyBookmark(pool,profile,book,data){
 const requested=readerUuid(data.id??randomUUID()),payload=normalizeReaderPayload('bookmark',{publicationId:book.id,publicationRevision:1,locator:{type:'legacy',chapter:data.chapter,position:data.position},note:data.note});
 return legacyTransaction(pool,profile,async(client,id,head)=>{
  const current=(await client.query("SELECT * FROM reader_entities WHERE profile_id=$1 AND entity_type='bookmark' AND legacy_id=$2",[id,requested])).rows[0];
  if(current){
   if(current.deleted)conflict('Эта закладка уже удалена; создайте новую с другим ID');
   if(canonicalReaderJson(current.payload)!==canonicalReaderJson(payload))conflict('Закладка уже существует с другим содержимым');
   return {id:current.legacy_id??requested};
  }
  if((await client.query('SELECT 1 FROM bookmarks WHERE id=$1',[requested])).rowCount||(await client.query("SELECT 1 FROM reader_entities WHERE legacy_id=$1 OR (profile_id=$2 AND entity_type='bookmark' AND entity_id=$1)",[requested,id])).rowCount)conflict('Идентификатор закладки уже занят');
  await appendReaderEntityChange(client,id,head,{entityType:'bookmark',entityId:requested,operation:'upsert',payload,legacyId:requested},services(pool));return {id:requested};
 });
}
export async function deleteLegacyBookmark(pool,profile,bookmark){
 const requested=readerUuid(bookmark);
 return legacyTransaction(pool,profile,async(client,id,head)=>{
  const current=(await client.query("SELECT * FROM reader_entities WHERE profile_id=$1 AND entity_type='bookmark' AND legacy_id=$2",[id,requested])).rows[0];
  if(current?.deleted)return {ok:true};
  if(!current&&(await client.query("SELECT 1 FROM reader_entities WHERE legacy_id=$1 OR (profile_id=$2 AND entity_type='bookmark' AND entity_id=$1)",[requested,id])).rowCount)return {ok:true};
  await appendReaderEntityChange(client,id,head,{entityType:'bookmark',entityId:current?.entity_id??requested,legacyId:requested,operation:'delete'},services(pool));return {ok:true};
 });
}
export async function saveLegacyCatalogs(pool,profile,data){
 return legacyTransaction(pool,profile,async(client,id,head)=>{
  const result=await appendReaderEntityChange(client,id,head,{entityType:'catalog',entityId:CATALOG_ENTITY_ID,operation:'upsert',payload:{catalogs:data.catalogs},expectedRevision:data.revision},{projectEntity:projectReaderEntity});
  if(result.status==='conflict')conflict('Каталоги изменились на другом устройстве. Загрузите серверную версию.');
  await client.query("INSERT INTO audit(actor,action,target,details) VALUES($1,'catalogs.saved',$2,$3)",[id,id,JSON.stringify({count:data.catalogs.length,revision:result.entity.revision})]);return {revision:result.entity.revision};
 });
}
