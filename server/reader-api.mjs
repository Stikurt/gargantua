import express from 'express';
import {rateLimit} from 'express-rate-limit';
import {applyReaderMutations,readerSnapshot,readerChanges,readerConflicts,READER_LIMITS} from './reader-data.mjs';
import {canonicalReaderJson,readerDataError,readerUuid} from './reader-data-model.mjs';
import {serializeReaderExport,parseReaderExport,MAX_READER_EXPORT_BYTES} from './reader-export.mjs';
import {verifyReaderPublication} from './reader-publication.mjs';
import {publicationAdmission,publicationHandler,publicationWork} from './publication-admission.mjs';

const invalid=message=>{throw readerDataError('READER_IMPORT_INVALID',message,400);};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>keys.includes(key));
const rawImport=express.raw({type:'application/json',limit:MAX_READER_EXPORT_BYTES});
function decoded(bytes){
 if(!Buffer.isBuffer(bytes))invalid('Нужен JSON-файл данных читателя');
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{invalid('Не удалось прочитать JSON-файл данных читателя');}
}
function archiveObject(value){
 let bytes;try{bytes=Buffer.from(JSON.stringify(value));}catch{invalid('Неверная структура файла данных читателя');}
 return parseReaderExport(bytes);
}
export function readerRoutes(app,{auth,wrap,pool}){
 const work=fn=>publicationWork(wrap,fn),handle=fn=>publicationHandler(wrap,fn);
 const services={verifyPublication:(id,locator,options)=>verifyReaderPublication(pool,id,locator,options)};
 // Projection is installed separately to keep old clients and the new sync API
 // within the same transaction, including audit and change-feed writes.
 importProjection(services);
 const bounded=rateLimit({windowMs:60000,limit:12,standardHeaders:'draft-8',legacyHeaders:false,message:{error:'Данные читателя: повторите через минуту'}});
 app.get('/api/v2/reader/storage',auth,work(async(req,res)=>{
  if(req.profile.role!=='owner')throw readerDataError('READER_FORBIDDEN','Сводка хранилища доступна владельцу',403);
  const row=(await pool.query('SELECT rows,bytes FROM reader_journal_budget WHERE singleton')).rows[0];
  if(!row)throw readerDataError('READER_INTEGRITY','Сводка хранилища временно недоступна',423);
  res.json({schemaVersion:1,rows:Number(row.rows),bytes:Number(row.bytes),maxRows:READER_LIMITS.journalRows,maxBytes:READER_LIMITS.journalBytes,retention:{acceptedPerProfile:READER_LIMITS.retainedAccepted,acceptedBytesPerProfile:READER_LIMITS.retainedReceiptBytes,changeBytesPerProfile:READER_LIMITS.retainedChangeBytes},protocolVersions:[1,2]});
 }));
 app.get('/api/v2/reader/snapshot',auth,work(async(req,res)=>res.json(await readerSnapshot(pool,req.profile))));
 app.get('/api/v2/reader/changes',auth,work(async(req,res)=>{
  if(Object.keys(req.query).some(key=>!['cursor','limit'].includes(key)))invalid('Неизвестный параметр синхронизации');
  res.json(await readerChanges(pool,req.profile,{cursor:req.query.cursor,limit:req.query.limit===undefined?100:Number(req.query.limit)}));
 }));
 app.get('/api/v2/reader/conflicts',auth,work(async(req,res)=>{
  if(Object.keys(req.query).some(key=>!['cursor','limit'].includes(key)))invalid('Неизвестный параметр списка конфликтов');
  res.json({schemaVersion:1,...await readerConflicts(pool,req.profile,{cursor:req.query.cursor,limit:req.query.limit===undefined?50:Number(req.query.limit)})});
 }));
 app.post('/api/v2/reader/mutations',auth,bounded,work(async(req,res)=>res.json(await applyReaderMutations(pool,req.profile,req.body,services))));
 app.get('/api/v2/reader/export',auth,bounded,work(async(req,res)=>{
  const snapshot=await readerSnapshot(pool,req.profile),bytes=serializeReaderExport(snapshot.entities);
  res.type('application/json').set('Content-Disposition','attachment; filename="gargantua-reader-data.json"').send(bytes);
 }));
 app.post('/api/v2/reader/import/preview',auth,bounded,publicationAdmission,rawImport,handle(async(req,res)=>{
  const archive=parseReaderExport(req.body),snapshot=await readerSnapshot(pool,req.profile),current=new Map(snapshot.entities.map(entity=>[entity.entityType+':'+entity.entityId,entity]));
  const publications=[...new Set(archive.entities.filter(entity=>!entity.deleted&&entity.entityType!=='catalog').map(entity=>entity.payload.publicationId))];
  const available=new Set(publications.length?(await pool.query("SELECT id FROM books WHERE id=ANY($1::uuid[]) AND security_state='passed'",[publications])).rows.map(row=>row.id):[]);
  const entries=archive.entities.map(entity=>{
   const target=current.get(entity.entityType+':'+entity.entityId),same=target&&target.deleted===entity.deleted&&(entity.deleted||canonicalReaderJson(target.payload)===canonicalReaderJson(entity.payload));
   return {entityType:entity.entityType,entityId:entity.entityId,sourceRevision:entity.revision,baseRevision:target?.revision??0,status:same?'same':!entity.deleted&&entity.entityType!=='catalog'&&!available.has(entity.payload.publicationId)?'unavailable-publication':entity.deleted?'deletion':target?'different':'new'};
  });
  res.json({schemaVersion:1,sha256:archive.sha256,cursor:snapshot.cursor,entries,applied:false});
 }));
 app.post('/api/v2/reader/import',auth,bounded,publicationAdmission,rawImport,handle(async(req,res)=>{
  const input=decoded(req.body);
  if(!exact(input,['archive','selections'])||!Array.isArray(input.selections)||input.selections.length<1||input.selections.length>10)invalid('Выберите от 1 до 10 записей и их текущие версии');
  const archive=archiveObject(input.archive),entities=new Map(archive.entities.map(entity=>[entity.entityType+':'+entity.entityId,entity])),seen=new Set();
  const mutations=input.selections.map(selection=>{
   if(!exact(selection,['entityType','entityId','mutationId','deviceId','counter','baseRevision','protocolVersion']))invalid('Неизвестные поля выбора записи');
   const id=readerUuid(selection.entityId),key=selection.entityType+':'+id,entity=entities.get(key);
   if(!entity||seen.has(key))invalid('Запись отсутствует в файле или выбрана дважды');seen.add(key);
   return {...selection,entityId:id,operation:entity.deleted?'delete':'upsert',...(entity.deleted?{}:{payload:entity.payload})};
  });
  res.json({archiveSha256:archive.sha256,...await applyReaderMutations(pool,req.profile,{mutations},services)});
 }));
}

import {projectReaderEntity} from './reader-legacy.mjs';
function importProjection(services){services.projectEntity=projectReaderEntity;}
