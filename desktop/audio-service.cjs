const {AudioStore,checksum,DESKTOP_AUDIO_CAPABILITIES}=require('./audio-store.cjs');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,HASH=/^[a-f0-9]{64}$/;
const error=(message,code='AUDIO_NETWORK')=>Object.assign(new Error(message),{code});
function args(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw error('Неверный запрос аудио','AUDIO_ARGUMENT');return value;}
function reference(value,keys=[]){args(value,['scopeId','jobId',...keys]);if(!HASH.test(value.scopeId||'')||!UUID.test(value.jobId||''))throw error('Неверная ссылка аудио','AUDIO_ARGUMENT');return value;}
function byteRange(value,length){const match=typeof value==='string'&&value.length<=128&&/^bytes=(\d*)-(\d*)$/.exec(value);if(!match||!match[1]&&!match[2])return null;let start,end;if(!match[1]){const suffix=Number(match[2]);if(!Number.isSafeInteger(suffix)||suffix<=0)return null;start=Math.max(0,length-suffix);end=length-1;}else{start=Number(match[1]);end=match[2]?Number(match[2]):length-1;if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=length||end<start)return null;end=Math.min(end,length-1);}return {start,end};}
function sleep(ms,signal){if(signal?.aborted)return Promise.reject(signal.reason||error('Загрузка отменена','AUDIO_CANCELLED'));if(ms<=0)return Promise.resolve();return new Promise((resolve,reject)=>{const done=()=>{signal?.removeEventListener('abort',abort);resolve();},timer=setTimeout(done,ms),abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(signal.reason||error('Загрузка отменена','AUDIO_CANCELLED'));};signal?.addEventListener('abort',abort,{once:true});});}
function retryAfter(value,now){if(typeof value!=='string'||value.length>128)return null;const text=value.trim();if(/^\d{1,7}$/.test(text))return Number(text)*1000;const time=Date.parse(text);return Number.isFinite(time)?Math.max(0,time-now):null;}
class AudioService{
 capabilities(value){if(value!==undefined)throw error('Возможности хранилища доступны только для чтения','AUDIO_ARGUMENT');return DESKTOP_AUDIO_CAPABILITIES;}
 constructor(root,{validators,server,cookie,offline=()=>false,fetchImpl=fetch,now=Date.now,delay=sleep,pacingMs=600,retryBudgetMs=120000}={}){
  this.validators=validators;this.server=server;this.cookie=cookie;this.offline=offline;this.fetch=fetchImpl;this.store=new AudioStore(root,{validateManifest:validators.validateAudioManifest,verifyChunk:validators.verifyAudioChunk});this.pending=new Map();
  this.now=now;this.delay=delay;this.pacingMs=pacingMs;this.retryBudgetMs=retryBudgetMs;this.nextChunkAt=0;this.shutdown=new AbortController();
 }
 async bytes(route,{max,signal,expectedSha,authCookie=this.cookie()}={}){
  if(!/^\/api\/(?:me|derived\/jobs\/[a-f0-9-]{36}\/(?:result|audio\/segments\/(?:0|[1-9]\d{0,4})))$/.test(route))throw error('Недопустимый адрес аудио','AUDIO_ARGUMENT');
  const origin=this.server(),deadline=this.now()+this.retryBudgetMs,combined=signal?AbortSignal.any([signal,this.shutdown.signal]):this.shutdown.signal,chunk=route.includes('/audio/segments/');
  for(let attempt=0;attempt<4;attempt++){
   if(combined.aborted)throw combined.reason||error('Загрузка отменена','AUDIO_CANCELLED');
   if(this.offline())throw error('Домашний сервер недоступен. Сохранённые фрагменты доступны без сети.','AUDIO_OFFLINE');
   if(this.cookie()!==authCookie||this.server()!==origin)throw error('Профиль или сервер изменился','AUDIO_SCOPE');
   if(chunk){const now=this.now(),next=Math.max(now,this.nextChunkAt);if(next>=deadline)throw error('Сервер занят. Повторите загрузку позже.','AUDIO_RETRY_LATER');this.nextChunkAt=next+this.pacingMs;await this.delay(next-now,combined);}
   if(combined.aborted)throw combined.reason||error('Загрузка отменена','AUDIO_CANCELLED');
   if(this.cookie()!==authCookie||this.server()!==origin)throw error('Профиль или сервер изменился','AUDIO_SCOPE');
   const remaining=deadline-this.now();if(remaining<=0)throw error('Сервер занят. Готовая часть сохранена; повторите скачивание позже.','AUDIO_RETRY_LATER');
   let backoff=null;
   try{
    const abort=AbortSignal.any([combined,AbortSignal.timeout(Math.max(1,Math.min(90000,remaining)))]);
    const response=await this.fetch(origin+route,{method:'GET',redirect:'error',headers:{'X-Cotology':'1',...(authCookie?{Cookie:authCookie}:{})},signal:abort});
    if(response.status!==200){await response.body?.cancel().catch(()=>{});if([429,502,503,504].includes(response.status))backoff=retryAfter(response.headers.get('retry-after'),this.now())??(response.status===429?60000:1000*2**attempt);else throw error(response.status===401?'Войдите в нужный профиль для скачивания аудио.':'Сервер не выдал аудио. Повторите позже.',response.status===401?'AUDIO_AUTH':'AUDIO_HTTP_'+response.status);}
    else{
     const length=response.headers.get('content-length');if(length&&(!/^\d+$/.test(length)||Number(length)>max)){await response.body?.cancel();throw error('Сервер вернул слишком большой файл','AUDIO_INTEGRITY');}
     const chunks=[];let total=0;const reader=response.body?.getReader();if(!reader)throw error('Сервер вернул пустой ответ','AUDIO_INTEGRITY');
     try{for(;;){const part=await reader.read();if(part.done)break;total+=part.value.byteLength;if(total>max)throw error('Сервер вернул слишком большой файл','AUDIO_INTEGRITY');chunks.push(Buffer.from(part.value));}}catch(failure){await reader.cancel().catch(()=>{});throw failure;}
     const bytes=Buffer.concat(chunks),sha=response.headers.get('x-content-sha256');if(expectedSha&&(sha!==expectedSha||checksum(bytes)!==expectedSha))throw error('Не совпала контрольная сумма аудио','AUDIO_INTEGRITY');if(combined.aborted)throw combined.reason||error('Загрузка отменена','AUDIO_CANCELLED');if(this.cookie()!==authCookie||this.server()!==origin)throw error('Профиль или сервер изменился','AUDIO_SCOPE');return {bytes,sha};
    }
   }catch(failure){if(combined.aborted)throw combined.reason||failure;if(typeof failure.code==='string'&&failure.code.startsWith('AUDIO_'))throw failure;backoff=1000*2**attempt;}
   if(attempt===3||backoff>65000||this.now()+backoff>=deadline)throw error('Сервер занят или соединение прервано. Готовая часть сохранена; повторите скачивание позже.','AUDIO_RETRY_LATER');
   await this.delay(Math.max(100,backoff),combined);
  }
 }
 async identity(profileId){const session=this.cookie(),result=await this.bytes('/api/me',{max:65536,authCookie:session});let profile;try{profile=JSON.parse(result.bytes.toString('utf8'));}catch{throw error('Не удалось подтвердить профиль','AUDIO_AUTH');}if(profile.id!==profileId||session!==this.cookie())throw error('Для этой аудиокниги войдите в её профиль на исходном сервере.','AUDIO_SCOPE');return session;}
 async bound(row){if(new URL(this.server()).origin!==row.serverOrigin)throw error('Подключите исходный сервер этой аудиокниги. Скачанные фрагменты доступны без него.','AUDIO_SCOPE');return this.identity(row.profileId);}
 async register(value){args(value,['profileId','jobId','title','author']);if(!UUID.test(value.profileId||'')||!UUID.test(value.jobId||''))throw error('Неверный идентификатор аудио','AUDIO_ARGUMENT');const session=await this.identity(value.profileId),result=await this.bytes(`/api/derived/jobs/${value.jobId}/result`,{max:16*1024*1024,authCookie:session});
  if(!HASH.test(result.sha||''))throw error('Сервер не подтвердил целостность описания аудио','AUDIO_INTEGRITY');const parsed=await this.validators.parseAudioManifest(result.bytes,{expectedSha256:result.sha,expectedJobId:value.jobId});if(session!==this.cookie())throw error('Профиль изменился во время загрузки','AUDIO_SCOPE');return this.store.register(this.server(),value.profileId,value.jobId,parsed.manifest,value,result.bytes);
 }
 async row(value,extra=[]){reference(value,extra);return this.store.scoped(value.scopeId,value.jobId);}
 async get(value){const row=await this.row(value);return this.store.get(row.serverOrigin,row.profileId,row.jobId);}
 async list(){return this.store.listAll();}
 async download(value){const row=await this.row(value);this.validators.assertAudioDownloadable(row.manifest,{capabilities:this.capabilities()});const session=await this.bound(row);return this.store.download(row.serverOrigin,row.profileId,row.jobId,async(segment,signal)=>{if(this.cookie()!==session||new URL(this.server()).origin!==row.serverOrigin)throw error('Профиль или сервер изменился','AUDIO_SCOPE');return (await this.bytes(this.validators.audioSegmentPath(row.jobId,segment.ordinal),{max:segment.bytes,expectedSha:segment.sha256,signal,authCookie:session})).bytes;});}
 async cancel(value){const row=await this.row(value);return this.store.cancel(row.serverOrigin,row.profileId,row.jobId);}
 async remove(value){reference(value);let row;try{row=await this.store.scoped(value.scopeId,value.jobId);}catch(failure){if(failure.code==='AUDIO_NOT_FOUND')return true;throw failure;}return this.store.remove(row.serverOrigin,row.profileId,row.jobId);}
 async positionGet(value){const row=await this.row(value);return this.store.positionGet(row.serverOrigin,row.profileId,row.jobId);}
 async positionPut(value){const row=await this.row(value,['position']),position=args(value.position,['jobId','manifestSha256','ordinal','seconds','rate','updatedAt','completed']);if(position.jobId!==row.jobId||position.manifestSha256!==row.manifestSha256)throw error('Изменилась версия аудио','AUDIO_POSITION');return this.store.positionPut(row.serverOrigin,row.profileId,row.jobId,position);}
 async url(value){const row=await this.row(value,['ordinal']);if(!Number.isSafeInteger(value.ordinal)||value.ordinal<0||value.ordinal>=row.manifest.segments.length)throw error('Неверный номер фрагмента','AUDIO_ARGUMENT');const entry=await this.store.chunk(row.scope,row.jobId,value.ordinal);
  if(!entry.bytes){const key=row.scope+'/'+row.jobId+'/'+value.ordinal;if(!this.pending.has(key)){const promise=(async()=>{const session=await this.bound(row);return this.store.saveOne(row.scope,row.jobId,value.ordinal,async segment=>(await this.bytes(this.validators.audioSegmentPath(row.jobId,segment.ordinal),{max:segment.bytes,expectedSha:segment.sha256,authCookie:session})).bytes);})();this.pending.set(key,promise);promise.finally(()=>{if(this.pending.get(key)===promise)this.pending.delete(key);}).catch(()=>{});}await this.pending.get(key);}
  return this.store.url(row.serverOrigin,row.profileId,row.jobId,value.ordinal);
 }
 async serve(request){try{const url=new URL(request.url),match=/^\/__audio\/([a-f0-9]{64})\/([a-f0-9-]{36})\/(0|[1-9]\d{0,4})\/([a-f0-9]{64})\.wav$/.exec(url.pathname);if(url.origin!=='null'&&url.origin!=='cotology://app'||url.host!=='app'||url.search||url.hash||!match||!['GET','HEAD'].includes(request.method))return new Response(null,{status:404});
   const {segment,bytes}=await this.store.protocolEntry(match[1],match[2],Number(match[3]),match[4]);if(!bytes)return new Response('Этот фрагмент не скачан',{status:404});
   const headers={'Content-Type':'audio/wav','Content-Length':String(bytes.length),'Accept-Ranges':'bytes','ETag':`"${segment.sha256}"`,'X-Content-SHA256':segment.sha256,'X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'",'Cache-Control':'private, no-store'};
   const range=request.headers.get('Range');if(range){const part=byteRange(range,bytes.length);if(!part)return new Response(null,{status:416,headers:{...headers,'Content-Range':`bytes */${bytes.length}`,'Content-Length':'0'}});const body=bytes.subarray(part.start,part.end+1);return new Response(request.method==='HEAD'?null:body,{status:206,headers:{...headers,'Content-Range':`bytes ${part.start}-${part.end}/${bytes.length}`,'Content-Length':String(body.length)}});}
   return new Response(request.method==='HEAD'?null:bytes,{headers});
  }catch{return new Response('Аудиофрагмент не прошёл проверку. Повторите скачивание.',{status:423,headers:{'Content-Type':'text/plain;charset=utf-8','X-Content-Type-Options':'nosniff'}});}}
 async close(){this.shutdown.abort();for(const control of this.store.active.values())control.abort.abort();await Promise.allSettled([...this.store.active.values()].map(control=>control.done).concat([...this.pending.values()]));}
}
module.exports={AudioService,byteRange,retryAfter};
