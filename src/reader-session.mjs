import {DEVICE} from './catalogs.mjs';
import {createReaderSync,READER_CATALOG_ID,normalizeSyncPayload} from './reader-sync.mjs';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const put=(key,value)=>({type:'put',key,value});
const remove=key=>({type:'remove',key});
const coords=value=>({chapter:value?.chapter??0,position:value?.position??0});
/** Adapts the current text reader to the revisioned journal without uploading files. */
export function createReaderSession({storage,api,serverIdentity,crypto=globalThis.crypto}){
 const sessions=new Map(),chapterInfo=new Map();let lastReadingTime=0;
 async function chapters(owner,id){const key=`${owner}:book:${id}`;if(chapterInfo.has(key))return chapterInfo.get(key);const packet=await storage.get(key);if(!packet)return null;if(!Array.isArray(packet.content?.chapters)||!packet.content.chapters.length)throw new Error('Повреждена локальная структура книги. Исходные данные сохранены.');const info={count:packet.content.chapters.length,ids:packet.content.structure?.chapters?.map(c=>c.id)||[]};chapterInfo.set(key,info);if(chapterInfo.size>8)chapterInfo.delete(chapterInfo.keys().next().value);return info;}
 async function projected(owner,entity){
  if(entity.entityType==='catalog')return []; // Adopting a shared catalogue remains explicit.
  const publicationId=entity.payload?.publicationId||(entity.entityType==='reading'?entity.entityId:null);
  if(!publicationId){if(entity.deleted&&entity.entityType==='bookmark')return (await storage.keys(`${owner}:mark:`)).filter(key=>key.endsWith(':'+entity.entityId)).map(remove);return [];}
  const target=entity.entityType==='reading'?`${owner}:position:${publicationId}`:`${owner}:mark:${publicationId}:${entity.entityId}`;
  const previousMarks=entity.entityType==='bookmark'?(await storage.keys(`${owner}:mark:`)).filter(key=>key.endsWith(':'+entity.entityId)):[];
  if(entity.deleted)return [...new Set([...previousMarks,target])].map(remove);
  const info=await chapters(owner,publicationId);
  const locator=entity.payload.locator;
  let chapter=locator.type==='legacy'?locator.chapter:info?.ids.indexOf(locator.chapterId);
  if(chapter===undefined||chapter<0){const match=/^c-(\d+)$/.exec(locator.chapterId||'');chapter=match?Number(match[1]):0;}
  chapter=Math.max(0,Math.min(chapter,(info?.count||20000)-1));
  const position=locator.type==='legacy'?locator.position:0;
  const old=await storage.get(target);
  const value=entity.entityType==='reading'
   ?{chapter,position,shelf:entity.payload.shelf,lastRead:old?.lastRead??(Date.parse(entity.updatedAt)||0),remoteAnchor:locator,remoteRevision:entity.revision,approximate:locator.type!=='legacy'}
   :{id:entity.entityId,chapter,position,note:entity.payload.note,created_at:entity.updatedAt||'1970-01-01T00:00:00.000Z',remoteAnchor:locator,approximate:locator.type!=='legacy'};
  return [...previousMarks.filter(key=>key!==target).map(remove),put(target,value)];
 }
 async function forProfile(profileId){
  if(!UUID.test(profileId)||profileId===DEVICE)throw new Error('Не выбран серверный профиль');
  if(!sessions.has(profileId))sessions.set(profileId,createReaderSync({storage,api,crypto,serverIdentity,profileId,projectEntity:entity=>projected(profileId,entity)}).catch(e=>{sessions.delete(profileId);throw e;}));
  return sessions.get(profileId);
 }
 async function legacy(engine){
  const entries=await storage.entries(`${engine.profileId}:pending:`),batch=[];
  for(const [legacyKey,value]of entries){
   if(batch.length===100)break;
   const match=/^\/books\/([a-f0-9-]{36})\/(reading|bookmarks)$/.exec(value?.url||'');
   if(!match||!UUID.test(match[1])||!value?.body)continue; // Unknown requests stay inert and intact.
   const [,,type]=match,body=value.body;
   if(type==='reading'&&value.method!=='PUT'||type==='bookmarks'&&value.method!=='POST')continue;
   const payload={publicationId:match[1],publicationRevision:1,locator:{type:'legacy',chapter:body.chapter,position:body.position}};
   if(type==='reading')payload.shelf=body.shelf||'reading';else payload.note=body.note||'';
   const entityId=type==='reading'?match[1]:body.id;
   if(!UUID.test(entityId||''))continue;
   const entityType=type==='reading'?'reading':'bookmark';try{normalizeSyncPayload(entityType,payload);}catch{continue;}
   batch.push({legacyKey,proposal:{entityType,entityId,operation:'upsert',payload}});
  }
  if(batch.length)await engine.stageLegacy(batch);
 }
 async function connect(profile){const engine=await forProfile(profile.id);const profiles=await storage.get(`${DEVICE}:syncProfiles`)||[];if(!profiles.some(p=>p.id===profile.id&&p.login===profile.login))await storage.apply([put(`${DEVICE}:syncProfiles`,[...profiles.filter(p=>p.id!==profile.id),{id:profile.id,login:profile.login||'Профиль'}].slice(-100))]);await legacy(engine);await engine.sync();return engine;}
 async function savePosition(book,chapter,position,shelf,{touch=false}={}){
  const owner=book.owner||DEVICE,key=`${owner}:position:${book.id}`;
  const old=await storage.get(key),value={chapter,position,shelf:shelf||old?.shelf||book.shelf||'reading',lastRead:Date.now()};
  const unchanged=old&&old.chapter===chapter&&old.position===position&&old.shelf===value.shelf;
  if(unchanged&&!touch)return {unchanged:true};
  // A user can revisit an existing bookmark without changing its locator.
  // Recency belongs to this device, so touching an explicit open must not
  // enqueue a redundant server edit or downgrade a canonical text anchor.
  if(touch)value.lastRead=Math.max(value.lastRead,lastReadingTime+1,Number.isSafeInteger(old?.lastRead)&&old.lastRead>=0&&old.lastRead<8640000000000000?old.lastRead+1:0);
  lastReadingTime=Math.max(lastReadingTime,value.lastRead);
  if(unchanged){await storage.apply([put(key,{...old,lastRead:value.lastRead})]);return {unchanged:true,touched:true};}
  const sameLocation=old&&old.chapter===chapter&&old.position===position;
  if(sameLocation&&old.remoteAnchor){value.remoteAnchor=old.remoteAnchor;if(old.remoteRevision!==undefined)value.remoteRevision=old.remoteRevision;if(old.approximate!==undefined)value.approximate=old.approximate;}
  const writes=[put(key,value)];
  if(owner===DEVICE)return storage.apply(writes);
  const engine=await forProfile(owner);
  const result=await engine.stage({scope:'server',entityType:'reading',entityId:book.id,operation:'upsert',payload:{publicationId:book.id,publicationRevision:1,locator:sameLocation&&old.remoteAnchor?old.remoteAnchor:{type:'legacy',...coords(value)},shelf:value.shelf},writes});
  engine.sync().catch(()=>{});return result;
 }
 async function saveMark(book,chapter,position,note){
  const owner=book.owner||DEVICE,mark={id:crypto.randomUUID(),chapter,position,note:String(note).slice(0,500),created_at:new Date().toISOString()};
  const writes=[put(`${owner}:mark:${book.id}:${mark.id}`,mark)];
  if(owner===DEVICE)await storage.apply(writes);
  else{const engine=await forProfile(owner);await engine.stage({scope:'server',entityType:'bookmark',entityId:mark.id,operation:'upsert',payload:{publicationId:book.id,publicationRevision:1,locator:{type:'legacy',chapter,position},note:mark.note},writes});engine.sync().catch(()=>{});}
  return mark;
 }
 async function saveCatalogs(profile,catalogs,writes=[],expectedRevision){
  const engine=await forProfile(profile.id);await engine.sync();
  const before=await engine.getState(),entityKey=`catalog:${READER_CATALOG_ID}`,base=expectedRevision??before.remote[entityKey]?.revision??0;
  await engine.stage({scope:'server',entityType:'catalog',entityId:READER_CATALOG_ID,operation:'upsert',payload:{catalogs},writes,expectedBaseRevision:base});
  await engine.sync();const state=await engine.getState(),isCatalog=row=>row.entityType==='catalog'&&row.entityId===READER_CATALOG_ID;
  const pending=state.desired.some(isCatalog)||state.inflight&&isCatalog(state.inflight.mutation)||state.reviews.some(isCatalog);
  return {...state,catalogSaved:!pending&&JSON.stringify(state.remote[entityKey]?.payload)===JSON.stringify(normalizeSyncPayload('catalog',{catalogs}))};
 }
 return Object.freeze({forProfile,connect,savePosition,saveMark,saveCatalogs});
}
