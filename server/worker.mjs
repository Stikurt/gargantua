import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { query, pool, migrate } from './db.mjs';
import { scannerVersion, scan } from './scan.mjs';
import { fetchSafe } from './fetch.mjs';
import { hash, fileType } from './security.mjs';
import {resolveRanobe,ranobeJson}from'./ranobe.mjs';
import {claimImport,renewImport,assertAttempt,attemptStage,markPrepared,publishImport,failImport,reconcileAttempts} from './import-jobs.mjs';
import {stagePublication,placePublication,readPublication,readBoundedFile,removeAttemptFiles,durableWrite,validateBook,textForScan} from './publication-files.mjs';
import {writeParserJob,cleanupParserJob} from './job-files.mjs';
import {expireIncompleteUploads} from './upload-lifecycle.mjs';
import {claimDiscoveryRequest} from './discovery-requests.mjs';
import {processDiscovery,syncDiscoveryImports} from './discovery-orchestrator.mjs';
import {verifyDiscoveredBook} from './discovery-verification.mjs';
import {gutenbergDownloadSelection} from './discovery-providers.mjs';
import {processRanobeFull,reconcileRanobeScratch,scheduleRanobeUpdates} from './ranobe-acquisition.mjs';
import {claimDerivedJob} from './derived-jobs.mjs';
import {processDerivedStep,syncDerivedRequests} from './derived-orchestrator.mjs';
import {inferenceBarrier,executorState,executorIsIdle} from './derived-spool.mjs';
import {createParserIdleBarrier} from './parser-idle.mjs';
await migrate();
const qdir=process.env.QUARANTINE_DIR||'/quarantine',jobs=process.env.JOBS_DIR||'/jobs',clean=process.env.LIBRARY_DIR||'/library';
const inferenceSpool=process.env.INFERENCE_SPOOL||'/inference-spool',inferenceRuntime=process.env.INFERENCE_RUNTIME||'/inference-runtime';
const parserIdle=createParserIdleBarrier();
async function derivedAllowed(){
 if(stopped)throw Object.assign(new Error('Обработчик остановлен'),{code:'WORKER_STOPPING'});
 const settings=(await query('SELECT imports_paused FROM settings WHERE id=1')).rows[0];
 if(settings.imports_paused)throw Object.assign(new Error('Очередь приостановлена владельцем'),{code:'IMPORT_PAUSED'});
 if(!(await resourceState()).allowHeavy)throw Object.assign(new Error('Ожидание ресурсов ПК'),{code:'RESOURCE_PRESSURE'});
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const text=z.string().max(100000);
const block=z.discriminatedUnion('type',[
  z.object({type:z.literal('text'),text}).strict(),
  z.object({type:z.literal('heading'),text}).strict(),
  z.object({type:z.literal('image'),asset:z.string().regex(/^image-\d{1,3}\.png$/),text:z.string().max(500)}).strict()
]);
const bookSchema=z.object({title:z.string().min(1).max(300),author:z.string().max(300),language:z.string().max(30),chapters:z.array(z.object({title:z.string().max(300),blocks:z.array(block).min(1).max(30000)}).strict()).min(1).max(1000),assets:z.record(z.string().regex(/^image-\d{1,3}\.png$/),z.string().max(16*1024*1024)),structure:z.unknown().optional(),sourceMetadata:z.unknown().optional()}).strict();
async function stage(row,value){await attemptStage(pool,row,value);}
async function allowed(row){
  if(row.abortReason)throw row.abortReason;
  if(stopped)throw Object.assign(new Error('Обработчик остановлен; задача продолжится после запуска'),{code:'WORKER_STOPPING'});
  if(row.leaseLost)throw Object.assign(new Error('Связь владения задачей потеряна'),{code:'LEASE_LOST'});
  await assertAttempt(pool,row);
  const settings=(await query('SELECT * FROM settings WHERE id=1')).rows[0];
  if(settings.imports_paused)throw Object.assign(new Error('Импорт приостановлен владельцем'),{code:'IMPORT_PAUSED'});
  if(row.decision_reason==='role-auto-approval') {
    const role=(await query('SELECT role FROM profiles WHERE id=$1',[row.requested_by])).rows[0]?.role;
    if(!['owner','trusted-import'].includes(role))throw Object.assign(new Error('Право автоодобрения отозвано. Требуется решение владельца'),{code:'APPROVAL_REVOKED'});
  }
}
async function resourceState(){
  try{
    const state=JSON.parse((await fs.readFile('/resources/resources.json','utf8')).replace(/^\uFEFF/,''));
    const age=Date.now()-state?.updatedAt;
    if(typeof state?.updatedAt!=='number'||!Number.isFinite(age)||age< -5000||age>45000||typeof state?.allowHeavy!=='boolean')return {allowHeavy:false,message:'Монитор ресурсов не предоставил актуальное корректное состояние. Очередь ждёт.'};
    return state;
  }catch{return {allowHeavy:false,message:'Ожидаем монитор ресурсов Windows. Запустите scripts/start-monitor.ps1.'};}
}
async function waitResources(row){
  while(true){
    await allowed(row);const state=await resourceState();
    await query("INSERT INTO system_status(name,value) VALUES('resources',$1) ON CONFLICT(name) DO UPDATE SET value=$1,updated_at=now()",[state]);
    if(state.allowHeavy)return;
    await stage(row,'Ожидание свободных ресурсов ПК');await sleep(5000);
  }
}
async function cleanJob(id){
  await cleanupParserJob(jobs,id);
}
async function run(row){
  const report={checks:[],startedAt:new Date().toISOString(),policy:'v1'};
  const controller=new AbortController(),signal=controller.signal;activeController=controller;
  const record=async(name)=>{report.checks.push({name,at:new Date().toISOString()});await attemptStage(pool,row,name,report);};
  let checking=false;
  const heartbeat=setInterval(async()=>{if(checking)return;checking=true;try{await renewImport(pool,row);await allowed(row);}catch(e){row.abortReason=e;if(e.code==='LEASE_LOST')row.leaseLost=true;controller.abort(e);}finally{checking=false;}},5000);heartbeat.unref();
  try{
    await waitResources(row);await stage(row,'Ожидание актуального антивируса');
    const incoming=await fs.readdir(path.join(qdir,'incoming'));let occupied=0;
    for(const name of incoming)if(name!==row.id&&/^[a-f0-9-]{36}$/.test(name))occupied+=(await fs.stat(path.join(qdir,'incoming',name)).catch(()=>({size:0}))).size;
    if(occupied+20*1024*1024>256*1024*1024)throw new Error('Карантин заполнен. Удалите неактивные файлы через security purge');
    const disk=await fs.statfs(qdir);if(Number(disk.bavail)*Number(disk.bsize)<300*1024*1024)throw new Error('Недостаточно места для безопасной обработки');
    const scanner=await scannerVersion({signal});report.scanner=scanner;await record('Актуальность сигнатур: не старше 7 дней');
    if(row.kind==='ranobe'&&row.options?.mode==='full'){
      await processRanobeFull(pool,row,{quarantine:qdir,jobs,library:clean,signal,allowed:()=>allowed(row),waitResources:()=>waitResources(row),stage:value=>stage(row,value),record,report});return;
    }
    await fs.mkdir(path.join(qdir,'attempts'),{recursive:true,mode:0o700});
    const input=path.join(qdir,'attempts',row.attempt_token);
    if(row.kind==='ranobe'){
      await stage(row,'RanobeLib: проверка выбранной ветки и диапазона');
      const info=await resolveRanobe(row.source_url,{signal}),opt=row.options;
      const matching=info.list.filter(c=>(c.branches||[]).some(b=>(b.branch_id??null)===(opt.branch??null)));
      const selected=matching.slice(opt.start-1,opt.start-1+opt.count);
      if(!selected.length)throw new Error('В выбранной ветке нет глав заданного диапазона');
      const bundle={title:info.title,author:info.author,language:'ru',chapters:[],images:{}};
      for(const chapter of selected){
        await waitResources(row);
        const params=new URLSearchParams({number:String(chapter.number),volume:String(chapter.volume)});
        if(opt.branch!==null)params.set('branch_id',String(opt.branch));
        const response=await ranobeJson(info.slug,`/chapter?${params}`,{signal});await scan(response.raw,{signal});
        const c=response.data;
        if(String(c.manga_id)!==info.slug.split('--')[0] || String(c.volume)!==String(chapter.volume) || String(c.number)!==String(chapter.number))throw new Error('Источник вернул другую книгу или главу');
        if(typeof c.content!=='string'||!c.content.trim())throw new Error('Глава недоступна или имеет неподдерживаемый формат');
        if((c.branch_id??null)!==(opt.branch??null))throw new Error('Источник вернул другую ветку перевода');
        for(const match of c.content.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)){
          const ref=match[1].replaceAll('&amp;','&'),url=new URL(ref);
          if(!['cdnlibs.org','imglib.info'].some(host=>url.hostname===host||url.hostname.endsWith('.'+host)))throw new Error('В главе изображение с неподключённого домена. Требуется рассмотрение');
          if(!bundle.images[ref]){
            if(Object.keys(bundle.images).length>=50)throw new Error('Слишком много изображений');
            const asset=await fetchSafe(url.href,{maxBytes:4*1024*1024,signal});await scan(asset.buffer,{signal});bundle.images[ref]=asset.buffer.toString('base64');
          }
        }
        bundle.chapters.push({title:`Том ${chapter.volume}. Глава ${chapter.number}${c.name?' — '+String(c.name).slice(0,150):''}`,html:c.content});
        if(Buffer.byteLength(JSON.stringify(bundle))>20*1024*1024)throw new Error('Выбранный диапазон превышает 20 МБ');
        await sleep(1500);
      }
      report.source={slug:info.slug,branch:opt.branch,start:opt.start,requestedCount:opt.count,receivedCount:selected.length,branchTotal:matching.length};
      await durableWrite(input,Buffer.from(JSON.stringify(bundle)));await record('RanobeLib: диапазон и ветка подтверждены; ответы проверены');
    }else if(row.kind==='file') {
      const discovery=row.options?.discovery;
      if(discovery){const selected=gutenbergDownloadSelection(discovery.download?.originalUrl,discovery.download?.mimeType,discovery.expected?.remoteId);if(!selected||selected.url!==row.source_url||selected.extension!==fileType(row.filename))throw Object.assign(new Error('Источник не совпадает с сохранённым выбором'),{code:'IDENTITY_REVIEW'});}
      await stage(row,'Загрузка в карантин');const response=await fetchSafe(row.source_url,{signal,...(discovery?{maxRedirects:0}:{})});
      if(/text\/html/i.test(response.type))throw new Error('Ссылка вернула HTML-страницу, а не книгу');
      await durableWrite(input,response.buffer);await record('HTTPS, DNS и перенаправления проверены');
    }
    if(row.kind==='upload')await durableWrite(input,await readBoundedFile(path.join(qdir,'incoming',row.id),20*1024*1024));
    const raw=await readBoundedFile(input,20*1024*1024);report.sha256=hash(raw);report.size=raw.length;report.attemptToken=row.attempt_token;
    await waitResources(row);await stage(row,'Антивирус: исходный файл');await scan(raw,{signal});await record('Исходный файл: угроз не обнаружено');
    await waitResources(row);await stage(row,'Изолированная проверка формата и содержимого');
    const spec={id:row.attempt_token,inputId:row.attempt_token,inputScope:'attempts',inputSha256:report.sha256,extension:row.kind==='ranobe'?'ranobe':fileType(row.filename),filename:row.filename};
    await writeParserJob(jobs,spec);
    let result;
    for(let n=0;n<65;n++){
      await sleep(1000);await allowed(row);
      try{
        const resultPath=path.join(jobs,'results',`${row.attempt_token}.json`);
        result=JSON.parse((await readBoundedFile(resultPath,25*1024*1024)).toString('utf8'));break;
      }catch(e){if(e.code!=='ENOENT')throw e;}
    }
    if(!result)throw new Error('Обработчик не завершил проверку за отведённое время');
    if(result.attemptToken!==row.attempt_token)throw new Error('Результат обработчика относится к другой попытке');
    if(!result.ok)throw Object.assign(new Error(result.error||'Проверка структуры не пройдена'),{blocked:true});
    if(result.sha256!==report.sha256)throw new Error('Результат относится к другой версии входного файла. Публикация запрещена');
    const book=bookSchema.parse(result.book);validateBook(book);
    if(row.options?.discovery){
      const identity=verifyDiscoveredBook({expected:row.options.discovery.expected,book,extension:fileType(row.filename),rawInput:raw,expectedInputSha256:report.sha256});report.identityVerification=identity;
      if(!identity.verified)throw Object.assign(new Error('Нужен разбор соответствия книги: '+identity.reasons.join(', ')),{code:'IDENTITY_REVIEW'});
      // These fields are observed in the actual input, never copied from the
      // search expectation. TXT's legacy filename fallback is not evidence.
      if(fileType(row.filename)==='txt'){book.title=identity.observed.title;book.author=identity.observed.authors.join(', ').slice(0,300);book.language=identity.observed.languages[0];validateBook(book);}
    }
    await record('Структура, пути архива, лимиты XML/изображений и очистка: пройдены');
    // ClamAV checked the raw container recursively. Scan the exact rendered text
    // too, before JSON escaping, so decoded entity/base64 content is not hidden.
    await waitResources(row);await stage(row,'Антивирус: подготовленный текст и иллюстрации');
    const inert=textForScan(book);
    await scan(inert,{signal});
    let assetBytes=0;
    for(const data of Object.values(book.assets)){
      const buffer=Buffer.from(data,'base64');assetBytes+=buffer.length;
      if(!buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || assetBytes>20*1024*1024)throw new Error('Неверный формат или объём подготовленных иллюстраций');
      await scan(buffer,{signal});
    }
    for(const c of book.chapters)for(const b of c.blocks)if(b.type==='image'&&!book.assets[b.asset])throw new Error('Иллюстрация отсутствует в подготовленном пакете');
    await scannerVersion({signal});await record('Подготовленные данные: угроз не обнаружено');
    report.identity=row.options?.discovery?'Фактические метаданные сверены с выбранной записью источника':'Метаданные извлечены; соответствие ожиданиям проверяет владелец';
    await allowed(row);
    const prepared=await stagePublication(clean,row.attempt_token,row.resultBookId,book);
    await markPrepared(pool,row,prepared.manifest);await allowed(row);
    await placePublication(clean,prepared);await markPrepared(pool,row,prepared.manifest,'placed');
    await readPublication(clean,{id:prepared.id,chapter_count:book.chapters.length,artifact_manifest:prepared.manifest,content_sha256:prepared.contentSha256,content_bytes:prepared.contentBytes,package_sha256:prepared.packageSha256});
    const source=row.kind==='ranobe'?{provider:'ranobelib',remoteId:String(report.source.slug.split('--')[0]),variant:`branch:${report.source.branch??'default'}:${book.language||'ru'}`,kind:'human-translation',label:`RanobeLib: ${report.source.branch??'основная ветка'}`,coverage:{kind:report.source.start===1&&report.source.receivedCount===report.source.branchTotal?'source-inventory-complete':'chapter-range',start:report.source.start,count:report.source.receivedCount,total:report.source.branchTotal}}:(row.options?.discovery?.sourceIdentity||null);
    await publishImport(pool,row,book,prepared,report,{source,verifyExisting:existing=>readPublication(clean,existing)});
  }catch(e){
    await failImport(pool,row,row.abortReason||(stopped?Object.assign(new Error('Обработчик остановлен'),{code:'WORKER_STOPPING'}):e),report);
  }finally{clearInterval(heartbeat);activeController=null;}
}
async function cleanupPublished(){
  for(const row of (await query('SELECT id,attempt_token FROM imports WHERE cleanup_pending AND status=\'completed\' LIMIT 100')).rows){
    try{
      await fs.unlink(path.join(qdir,'incoming',row.id)).catch(e=>{if(e.code!=='ENOENT')throw e;});
      if(row.attempt_token){await fs.unlink(path.join(qdir,'attempts',row.attempt_token)).catch(e=>{if(e.code!=='ENOENT')throw e;});await cleanJob(row.attempt_token);}
      await query('UPDATE imports SET cleanup_pending=false,cleanup_error=NULL WHERE id=$1 AND status=\'completed\'',[row.id]);
    }catch(e){await query('UPDATE imports SET cleanup_error=$1 WHERE id=$2',[String(e.code||e.message).slice(0,200),row.id]);}
  }
}
async function expireUploads(){
  const result=await expireIncompleteUploads(pool,qdir);
  if(result.cleanupErrors)console.error('Expired upload cleanup: retained inputs require owner review');
}
const shutdown=new AbortController();
let stopped=false,activeController=null;process.on('SIGTERM',()=>{stopped=true;const reason=Object.assign(new Error('Обработчик остановлен'),{code:'WORKER_STOPPING'});shutdown.abort(reason);activeController?.abort(reason);});
const workerLock=await pool.connect();workerLock.on('error',()=>{stopped=true;});
if(!(await workerLock.query('SELECT pg_try_advisory_lock(84627191) AS owned')).rows[0].owned){workerLock.release();await pool.end();console.error('Другой обработчик уже владеет очередью');process.exit(1);}
while(!stopped){
  try{
    await expireUploads();
    await cleanupPublished();
    await reconcileRanobeScratch(pool,{quarantine:qdir,jobs});
    await syncDiscoveryImports(pool);
    await reconcileAttempts(pool,async attempt=>{
      await removeAttemptFiles(clean,attempt.token,attempt.book_id,{removePlaced:true});
      await cleanJob(attempt.token);
      await fs.unlink(path.join(qdir,'attempts',attempt.token)).catch(e=>{if(e.code!=='ENOENT')throw e;});
    });
    await query("INSERT INTO system_status(name,value) VALUES('worker',$1) ON CONFLICT(name) DO UPDATE SET value=$1,updated_at=now()",[{alive:true}]);
    try{const version=await scannerVersion({timeoutMs:3000,signal:shutdown.signal});await query("INSERT INTO system_status(name,value) VALUES('scanner',$1) ON CONFLICT(name) DO UPDATE SET value=$1,updated_at=now()",[{ready:true,version}]);}
    catch(e){await query("INSERT INTO system_status(name,value) VALUES('scanner',$1) ON CONFLICT(name) DO UPDATE SET value=$1,updated_at=now()",[{ready:false,error:e.message}]);}
    const paused=(await query('SELECT imports_paused FROM settings WHERE id=1')).rows[0].imports_paused;
    const resources=await resourceState();await query("INSERT INTO system_status(name,value) VALUES('resources',$1) ON CONFLICT(name) DO UPDATE SET value=$1,updated_at=now()",[resources]);
    const executor=await executorState(inferenceRuntime),inferenceSafe=await inferenceBarrier(inferenceSpool,inferenceRuntime);
    await query("INSERT INTO system_status(name,value) VALUES('derived-executor',$1) ON CONFLICT(name) DO UPDATE SET value=$1,updated_at=now()",[{state:executor?.state||'not-running',cleanupVerified:inferenceSafe,updatedAt:executor?.updatedAt,thermal:executor?.thermal}]);
    if(!paused&&inferenceSafe){
      await syncDerivedRequests(pool,{library:clean});
      if(resources.allowHeavy)await scheduleRanobeUpdates(pool,{quarantine:qdir,library:clean});
      const row=await claimImport(pool);if(row){try{await run(row);}finally{parserIdle.markBusy();}}
      else if(resources.allowHeavy){
        const importStillLive=(await query("SELECT EXISTS(SELECT 1 FROM imports WHERE status='processing' AND (lease_expires_at IS NULL OR lease_expires_at>clock_timestamp())) AS live")).rows[0].live;
        const parserSafe=!importStillLive&&await parserIdle.allowed(jobs);
        const derived=parserSafe&&executorIsIdle(executor)?await claimDerivedJob(pool):null;
        if(derived){const controller=new AbortController();activeController=controller;try{await processDerivedStep(pool,derived,{library:clean,spool:inferenceSpool,runtime:inferenceRuntime,signal:controller.signal,allowed:derivedAllowed});}finally{activeController=null;}}
        else if(!importStillLive){const discovery=await claimDiscoveryRequest(pool);if(discovery){const controller=new AbortController();activeController=controller;try{await processDiscovery(pool,discovery,{signal:controller.signal,quarantine:qdir,library:clean});}finally{activeController=null;}}}
      }
    }
  }catch(e){console.error('Worker:',e.code||e.name);}
  await sleep(4000);
}
await workerLock.query('SELECT pg_advisory_unlock(84627191)').catch(()=>{});workerLock.release();
await pool.end();
