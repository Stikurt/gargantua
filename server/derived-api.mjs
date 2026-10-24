import {z} from 'zod';
import {rateLimit} from 'express-rate-limit';
import {getDerivedRequest,listDerivedRequests,decideDerivedRequest,getDerivedResult} from './derived-jobs.mjs';
import {requestDerived,derivedProfiles} from './derived-orchestrator.mjs';
import {readDerivedManifest,readDerivedSegment,validateSegmentManifest} from './derived-files.mjs';
import {canonicalJson,sha256} from './publication-model.mjs';
import {publicChapterRange} from './derived-selection.mjs';

const id=z.string().uuid(),hash=/^[a-f0-9]{64}$/;
const glossary=z.record(z.string().min(1).max(80),z.string().min(1).max(80)).refine(value=>Object.keys(value).length<=30,'Максимум 30 записей словаря');
const chapterRange=z.object({start:z.number().int().min(1).max(20000000),count:z.number().int().min(1).max(50)}).strict();
const input=z.object({idempotencyKey:id,kind:z.enum(['translation','audio']),publicationIds:z.array(id).min(1).max(20000),snapshotId:id.nullable().optional(),sourceLanguage:z.enum(['en','ru']).optional(),discoveryRequestId:id.nullable().optional(),audio:z.boolean().optional(),glossary:glossary.optional(),chapterRange:chapterRange.optional()}).strict().refine(value=>value.kind!=='translation'||!value.chapterRange||value.chapterRange.count<=5,'Перевод — до 5 глав за запрос');
const decision=z.object({action:z.enum(['approve','cancel','retry']),expectedRevision:z.number().int().positive()}).strict();
const integrity=(message='Производный результат не прошёл проверку целостности')=>Object.assign(new Error(message),{status:423,code:'DERIVED_INTEGRITY'});
const errorCode=value=>typeof value==='string'&&/^[A-Z][A-Z0-9_-]{0,119}$/.test(value)?value:null;
const reason=value=>typeof value==='string'&&/^[-a-zA-Z0-9_]{1,120}$/.test(value)?value:null;
const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>value?.[key]!==undefined).map(key=>[key,value[key]]));
function metadataText(value,max=300){if(typeof value!=='string')return '';let text=value.toWellFormed().replace(/[\x00-\x1f\x7f]/gu,' ').trim().slice(0,max);if(/[\uD800-\uDBFF]$/.test(text))text=text.slice(0,-1);return text;}
function coverage(row){const manifest=row?.source_manifest;if(!manifest)return {};const chapterRange=publicChapterRange(manifest),originChapterRange=publicChapterRange(row.parent_source_manifest);return {chapterRange,partial:(originChapterRange??chapterRange).count<(originChapterRange??chapterRange).total,publicationIds:manifest.parts.map(part=>part.publicationId),snapshotId:manifest.snapshotId??null,...(row.source_sha256?{sourceSha256:row.source_sha256}:{}),...(originChapterRange?{originChapterRange}:{})};}
function titleMetadata(row){const bookTitle=metadataText(row?.source_title),manifest=row?.parent_source_manifest??row?.source_manifest,range=manifest?.schemaVersion===2?publicChapterRange(manifest):null,rangeInTitle=Boolean(range&&bookTitle),suffix=rangeInTitle?` · Главы ${range.start}–${range.start+range.count-1} из ${range.total}`:'';return {bookTitle,title:rangeInTitle?metadataText(bookTitle,300-suffix.length)+suffix:bookTitle,rangeInTitle};}

export function publicDerivedJob(job){
 if(!job)return null;
 return {id:job.id,kind:job.kind,status:job.status,revision:job.revision,completedSegments:job.completed_segments,totalSegments:job.total_segments,pauseReason:reason(job.pause_reason),error:errorCode(job.error),createdAt:job.created_at,updatedAt:job.updated_at,nextAttemptAt:job.next_attempt_at,...coverage(job),...titleMetadata(job)};
}
export function publicDerivedRequest(row){
 return {...pick(row,['id','revision','status']),jobId:row.job_id,requestedBy:row.requested_by,audio:row.audio_requested,approvedBy:row.approved_by,decisionReason:row.decision_reason,createdAt:row.created_at,updatedAt:row.updated_at,...coverage(row),
  parentJobId:id.safeParse(row.parent_job_id).success?row.parent_job_id:null,parentRequestId:id.safeParse(row.parent_request_id).success?row.parent_request_id:null,
  ...titleMetadata(row),author:metadataText(Array.isArray(row.source_authors)?row.source_authors.filter(value=>typeof value==='string').slice(0,16).map(value=>metadataText(value)).filter(Boolean).join(', '):''),sourceLanguage:typeof row.source_language==='string'&&row.source_language.length<=35&&/^[a-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(row.source_language)?row.source_language:null,
  ...(row.kind?{kind:row.kind}:{}),...(row.job_status?{jobStatus:row.job_status,completedSegments:row.completed_segments,totalSegments:row.total_segments,pauseReason:reason(row.pause_reason),error:errorCode(row.error)}:{}),
  ...(row.job?{job:publicDerivedJob(row.job)}:{}),...(row.result?{result:{jobId:row.result.job_id,sha256:row.result.sha256,url:`/api/derived/jobs/${row.result.job_id}/result`}}:{})};
}

export function checkedDerivedResult(grant,loaded,recipe){
 const {job,source,result}=grant,manifest=loaded.manifest;
 if(!job||!source||!result||!manifest||job.status!=='completed'||result.job_id!==job.id||source.sha256!==job.source_sha256||result.work_id!==source.work_id
  ||manifest.schemaVersion!==1||manifest.jobId!==job.id||manifest.kind!==job.kind||manifest.sourceSha256!==job.source_sha256||manifest.recipeSha256!==job.recipe_sha256
  ||manifest.quality!==(job.kind==='translation'?'machine-draft':'technical-unlistened')||!Array.isArray(manifest.segments)||!manifest.segments.length||manifest.segments.length>50000
  ||manifest.segments.length!==job.total_segments||job.completed_segments!==job.total_segments||!job.plan||!Array.isArray(job.plan.segments)||job.plan.segments.length!==manifest.segments.length
  ||job.plan.sourceSha256!==job.source_sha256||job.plan.kind!==job.kind||!hash.test(job.recipe_sha256)
  ||!recipe||recipe.sha256!==job.recipe_sha256||recipe.kind!==job.kind||!hash.test(recipe.manifest?.profileSha256||'')
  ||sha256(Buffer.from(canonicalJson({kind:recipe.kind,language:recipe.language,manifest:recipe.manifest})))!==job.recipe_sha256)throw integrity();
 for(const [ordinal,segment]of manifest.segments.entries()){
  validateSegmentManifest(segment,job.id);
  if(segment.ordinal!==ordinal||segment.kind!==job.kind||segment.recipeSha256!==job.recipe_sha256||segment.profileSha256!==recipe.manifest.profileSha256||segment.inputSha256!==job.plan.segments[ordinal]?.sourceSha256)throw integrity();
 }
 if(job.kind==='translation'&&(!Array.isArray(manifest.publicationIds)||!manifest.publicationIds.length||manifest.publicationIds.length>20000||new Set(manifest.publicationIds).size!==manifest.publicationIds.length||manifest.publicationIds.some(value=>!id.safeParse(value).success)))throw integrity();
 return manifest;
}
function publicManifest(grant,manifest){
 // Installed native clients validate this exact envelope. Display/coverage
 // metadata belongs to request/job projections and must not change its hash.
 return {schemaVersion:1,jobId:grant.job.id,kind:manifest.kind,sourceSha256:manifest.sourceSha256,recipeSha256:manifest.recipeSha256,quality:manifest.quality,
  workId:grant.result.work_id,expressionId:grant.result.expression_id,editionId:grant.result.edition_id,
  ...(manifest.publicationIds?{publications:manifest.publicationIds.map(value=>({id:value,url:`/api/v2/publications/${value}?revision=1`}))}:{}),
  segments:manifest.segments.map(segment=>({ordinal:segment.ordinal,sha256:segment.file.sha256,bytes:segment.file.bytes,mediaType:segment.file.mediaType,
   ...(segment.pcm?{durationSeconds:segment.pcm.durationSeconds,sampleRate:segment.pcm.sampleRate}:{}),url:`/api/derived/jobs/${grant.job.id}/${manifest.kind==='audio'?'audio/':''}segments/${segment.ordinal}`}))};
}

/** One bounded RFC7233 byte range. Unsupported/multipart ranges are rejected. */
export function derivedRange(value,length){
 if(typeof value!=='string'||value.length>128||!Number.isSafeInteger(length)||length<1)return null;
 const match=/^bytes=(\d*)-(\d*)$/.exec(value);if(!match||!match[1]&&!match[2])return null;
 const number=text=>text.length<=16&&Number.isSafeInteger(Number(text))?Number(text):NaN;
 let start,end;
 if(!match[1]){const suffix=number(match[2]);if(!(suffix>0))return null;start=Math.max(0,length-suffix);end=length-1;}
 else{start=number(match[1]);end=match[2]?number(match[2]):length-1;if(start<0||start>=length||end<start||!Number.isSafeInteger(start)||!Number.isSafeInteger(end))return null;end=Math.min(end,length-1);}
 return {start,end};
}
const matchesEtag=(value,etag)=>typeof value==='string'&&value.length<=2048&&value.split(',').some(item=>item.trim()==='*'||item.trim().replace(/^W\//,'')===etag);
function send(req,res,bytes,type,{range=false}={}){
 const checksum=sha256(bytes),etag=`"${checksum}"`;res.set('ETag',etag).set('X-Content-SHA256',checksum).set('X-Content-Type-Options','nosniff').set('Content-Type',type).set('Content-Security-Policy',"default-src 'none'");
 if(range)res.set('Accept-Ranges','bytes');
 if(matchesEtag(req.get('If-None-Match'),etag))return res.status(304).end();
 const requested=req.get('Range'),ifRange=req.get('If-Range');
 if(range&&requested&&(!ifRange||ifRange===etag)){
  const part=derivedRange(requested,bytes.length);
  if(!part)return res.set('Content-Range',`bytes */${bytes.length}`).status(416).end();
  const body=bytes.subarray(part.start,part.end+1);return res.set('Content-Range',`bytes ${part.start}-${part.end}/${bytes.length}`).set('Content-Length',String(body.length)).status(206).end(body);
 }
 return res.set('Content-Length',String(bytes.length)).status(200).end(bytes);
}

export function derivedRoutes(app,{auth,wrap,error,pool,library,services={}}){
 const api={request:requestDerived,getRequest:getDerivedRequest,list:listDerivedRequests,decide:decideDerivedRequest,getResult:getDerivedResult,profiles:derivedProfiles,readManifest:readDerivedManifest,readSegment:readDerivedSegment,
  getRecipe:async hash=>(await pool.query('SELECT * FROM derived_recipes WHERE sha256=$1',[hash])).rows[0],...services};
 let activeReads=0;
 const readSlot=(_req,res,next)=>{
  if(activeReads>=2)return res.set('Retry-After','1').status(429).json({error:'Сейчас обрабатываются два чтения книги. Повторите через секунду.'});
  activeReads++;let released=false;
  const release=()=>{if(!released){released=true;activeReads--;}};
  res.once('finish',release);res.once('close',release);next();
 };
 const admission=rateLimit({windowMs:60000,limit:12,standardHeaders:'draft-8',legacyHeaders:false,message:{error:'Слишком много изменений заявок. Подождите минуту.'}});
 app.post('/api/derived/requests',auth,admission,readSlot,wrap(async(req,res)=>{
  const value=await api.request(pool,req.profile,input.parse(req.body),{library});res.status(value.idempotent||value.reused?200:202).json({request:publicDerivedRequest(value.request),job:publicDerivedJob(value.job),reused:!!value.reused,idempotent:!!value.idempotent});
 }));
 app.get('/api/derived/requests',auth,wrap(async(req,res)=>{const query=z.object({limit:z.coerce.number().int().min(1).max(100).default(50)}).strict().parse(req.query);res.json((await api.list(pool,req.profile,query)).map(publicDerivedRequest));}));
 app.get('/api/derived/requests/:id',auth,wrap(async(req,res)=>res.json(publicDerivedRequest(await api.getRequest(pool,req.profile,id.parse(req.params.id))))));
 app.post('/api/derived/requests/:id/decision',auth,admission,wrap(async(req,res)=>res.json(publicDerivedRequest(await api.decide(pool,req.profile,{id:id.parse(req.params.id),...decision.parse(req.body)})))));
 app.get('/api/derived/profiles',auth,wrap(async(_req,res)=>{
  const profiles=await api.profiles();res.json({schemaVersion:1,profiles:Object.entries(profiles.profiles).map(([kind,row])=>({id:row.descriptor.id,kind:kind==='tts'?'audio':'translation',sourceLanguage:row.descriptor.sourceLanguage,targetLanguage:row.descriptor.targetLanguage,profileSha256:row.profileSha256,quality:row.descriptor.qualityStatus,requiresGpu:kind==='translation'}))});
 }));
 async function loaded(req){
  const jobId=id.parse(req.params.id),grant=await api.getResult(pool,req.profile,jobId),checked=await api.readManifest(library,grant.result),recipe=await api.getRecipe(grant.job.recipe_sha256);
  const manifest=checkedDerivedResult(grant,checked,recipe);return {grant,manifest};
 }
 async function recheck(req,grant){
  const current=await api.getResult(pool,req.profile,grant.job.id);
  if(current.job.source_sha256!==grant.job.source_sha256||current.job.recipe_sha256!==grant.job.recipe_sha256||current.result.sha256!==grant.result.sha256)throw integrity();
 }
 app.get('/api/derived/jobs/:id/result',auth,readSlot,wrap(async(req,res)=>{const {grant,manifest}=await loaded(req),bytes=Buffer.from(canonicalJson(publicManifest(grant,manifest)));await recheck(req,grant);send(req,res,bytes,'application/json; charset=utf-8');}));
 const segmentRoute=audioOnly=>wrap(async(req,res)=>{
  const ordinal=z.string().regex(/^(0|[1-9]\d{0,4})$/).transform(Number).refine(value=>value<50000).parse(req.params.ordinal),{grant,manifest}=await loaded(req);
  if(audioOnly&&manifest.kind!=='audio'||!manifest.segments[ordinal])throw error('Фрагмент не найден',404);
  const entry=manifest.segments[ordinal],bytes=await api.readSegment(library,grant.job.id,entry);await recheck(req,grant);
  send(req,res,bytes,entry.file.mediaType,{range:manifest.kind==='audio'});
 });
 app.get('/api/derived/jobs/:id/audio/segments/:ordinal',auth,readSlot,segmentRoute(true));
 app.get('/api/derived/jobs/:id/segments/:ordinal',auth,readSlot,segmentRoute(false));
}
