// Shared by the web interface and native stores. No URL, path, or model data from
// a manifest becomes a filesystem location or a network destination.
export const AUDIO_LIMITS=Object.freeze({manifestBytes:16*1024*1024,segments:50000,downloadSegments:8192,totalBytes:8*1024*1024*1024,chunkBytes:8*1024*1024,minSeconds:0.1,maxSeconds:180,sampleRate:22050});
const DESKTOP_AUDIO_BYTES=16*1024*1024*1024,DESKTOP_AUDIO_RESERVE=512*1024*1024;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/;
const failure=message=>Object.assign(new Error(message),{code:'AUDIO_INTEGRITY'});
const validId=value=>typeof value==='string'&&UUID.test(value);
const validHash=value=>typeof value==='string'&&HASH.test(value);
function exactObject(value,keys){
 if(!value||typeof value!=='object'||Array.isArray(value)||![null,Object.prototype].includes(Object.getPrototypeOf(value))||Object.keys(value).length!==keys.length||Object.keys(value).some(key=>!keys.includes(key)))throw failure('Неверный формат аудиоданных');
}
function asBytes(value){
 if(value instanceof Uint8Array)return value;
 if(value instanceof ArrayBuffer)return new Uint8Array(value);
 throw failure('Ожидались двоичные аудиоданные');
}
export function audioSegmentPath(jobId,ordinal){
 if(!validId(jobId)||!Number.isSafeInteger(ordinal)||ordinal<0||ordinal>=AUDIO_LIMITS.segments)throw failure('Неверный идентификатор аудиофрагмента');
 return `/api/derived/jobs/${jobId}/audio/segments/${ordinal}`;
}
function checkedSegment(value,jobId,ordinal){
 exactObject(value,['ordinal','sha256','bytes','mediaType','durationSeconds','sampleRate','url']);
 if(value.ordinal!==ordinal||!validHash(value.sha256)||!Number.isSafeInteger(value.bytes)||value.bytes<46||value.bytes>AUDIO_LIMITS.chunkBytes||value.mediaType!=='audio/wav'||!Number.isFinite(value.durationSeconds)||value.durationSeconds<AUDIO_LIMITS.minSeconds||value.durationSeconds>AUDIO_LIMITS.maxSeconds||value.sampleRate!==AUDIO_LIMITS.sampleRate||value.url!==audioSegmentPath(jobId,ordinal))throw failure('Неверное описание аудиофрагмента');
 // Every admitted fragment is mono 16-bit PCM with only fmt/data chunks.
 const frames=value.durationSeconds*AUDIO_LIMITS.sampleRate;
 if(Math.abs(frames-Math.round(frames))>0.00001||Math.round(frames)*2+44!==value.bytes)throw failure('Размер и длительность аудиофрагмента не совпадают');
 return {ordinal,sha256:value.sha256,bytes:value.bytes,mediaType:'audio/wav',durationSeconds:value.durationSeconds,sampleRate:AUDIO_LIMITS.sampleRate,url:audioSegmentPath(jobId,ordinal)};
}
export function validateAudioManifest(value,{expectedJobId}={}){
 exactObject(value,['schemaVersion','jobId','kind','sourceSha256','recipeSha256','quality','workId','expressionId','editionId','segments']);
 if(value.schemaVersion!==1||value.kind!=='audio'||value.quality!=='technical-unlistened'||!validId(value.jobId)||expectedJobId!==undefined&&value.jobId!==expectedJobId||!validHash(value.sourceSha256)||!validHash(value.recipeSha256)||!['workId','expressionId','editionId'].every(key=>validId(value[key]))||!Array.isArray(value.segments)||!value.segments.length||value.segments.length>AUDIO_LIMITS.segments)throw failure('Неверный аудиоманифест');
 const segments=Array.from(value.segments,(segment,ordinal)=>checkedSegment(segment,value.jobId,ordinal));
 return {schemaVersion:1,jobId:value.jobId,kind:'audio',sourceSha256:value.sourceSha256,recipeSha256:value.recipeSha256,quality:'technical-unlistened',workId:value.workId,expressionId:value.expressionId,editionId:value.editionId,segments};
}
export async function audioSha256(value){
 const bytes=asBytes(value);
 if(!globalThis.crypto?.subtle)throw failure('Проверка целостности недоступна в этом приложении');
 const digest=await globalThis.crypto.subtle.digest('SHA-256',bytes);
 return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
}
export async function parseAudioManifest(value,{expectedSha256,expectedJobId}={}){
 const bytes=asBytes(value);
 if(!bytes.byteLength||bytes.byteLength>AUDIO_LIMITS.manifestBytes||expectedSha256!==undefined&&!validHash(expectedSha256))throw failure('Неверный размер или отпечаток аудиоманифеста');
 const sha256=await audioSha256(bytes);
 if(expectedSha256!==undefined&&sha256!==expectedSha256)throw failure('Аудиоманифест повреждён');
 let data;try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw failure('Аудиоманифест не читается');}
 return {manifest:validateAudioManifest(data,{expectedJobId}),sha256};
}
export function validateAudioWav(value){
 const bytes=asBytes(value),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 const name=(offset,length)=>String.fromCharCode(...bytes.subarray(offset,offset+length));
 if(bytes.byteLength<46||bytes.byteLength>AUDIO_LIMITS.chunkBytes||name(0,4)!=='RIFF'||name(8,4)!=='WAVE'||view.getUint32(4,true)+8!==bytes.byteLength)throw failure('Неверный WAV');
 let offset=12,format=null,dataStart=-1,dataLength=0;
 while(offset+8<=bytes.byteLength){
  const tag=name(offset,4),length=view.getUint32(offset+4,true),start=offset+8,end=start+length;
  if(end>bytes.byteLength)throw failure('Оборванный WAV');
  if(tag==='fmt '){
   if(format||length!==16)throw failure('Неподдерживаемый PCM');
   format={code:view.getUint16(start,true),channels:view.getUint16(start+2,true),sampleRate:view.getUint32(start+4,true),byteRate:view.getUint32(start+8,true),align:view.getUint16(start+12,true),bits:view.getUint16(start+14,true)};
  }else if(tag==='data'){
   if(dataStart!==-1)throw failure('Повторный PCM');dataStart=start;dataLength=length;
  }else throw failure('Посторонний WAV chunk');
  offset=end+(length%2);
 }
 if(offset!==bytes.byteLength||!format||dataStart<0||!dataLength||dataLength%2||format.code!==1||format.channels!==1||format.sampleRate!==AUDIO_LIMITS.sampleRate||format.byteRate!==AUDIO_LIMITS.sampleRate*2||format.align!==2||format.bits!==16)throw failure('Неподдерживаемый формат аудио');
 const frames=dataLength/2,durationSeconds=frames/AUDIO_LIMITS.sampleRate;
 if(durationSeconds<AUDIO_LIMITS.minSeconds||durationSeconds>AUDIO_LIMITS.maxSeconds)throw failure('Недопустимая длительность аудиофрагмента');
 let nonzero=0,clipped=0;
 for(let index=dataStart;index<dataStart+dataLength;index+=2){const sample=view.getInt16(index,true);if(sample)nonzero++;if(Math.abs(sample)>=32760)clipped++;}
 if(!nonzero||clipped/frames>0.02)throw failure('Тишина или аномальное ограничение аудио');
 return {frames,sampleRate:AUDIO_LIMITS.sampleRate,channels:1,sampleWidth:2,durationSeconds};
}
export async function verifyAudioChunk(value,segment){
 const bytes=asBytes(value);
 // Also validate detached segment descriptors before using them as trust input.
 if(!segment||!Number.isSafeInteger(segment.ordinal)||typeof segment.url!=='string')throw failure('Неверное описание аудиофрагмента');
 const match=/^\/api\/derived\/jobs\/([a-f0-9-]{36})\/audio\/segments\/(0|[1-9]\d{0,4})$/.exec(segment.url);
 if(!match||Number(match[2])!==segment.ordinal)throw failure('Неверная ссылка аудиофрагмента');
 checkedSegment(segment,match[1],segment.ordinal);
 if(bytes.byteLength!==segment.bytes)throw failure('Аудиофрагмент загружен не полностью');
 const sha256=await audioSha256(bytes);
 if(sha256!==segment.sha256)throw failure('Аудиофрагмент повреждён');
 const pcm=validateAudioWav(bytes);
 if(Math.abs(pcm.durationSeconds-segment.durationSeconds)>0.5/AUDIO_LIMITS.sampleRate)throw failure('Длительность аудиофрагмента не совпадает');
 return {...pcm,sha256,bytes:bytes.byteLength};
}
export function audioSummary(manifest){
 const checked=validateAudioManifest(manifest);
 return {totalBytes:checked.segments.reduce((sum,segment)=>sum+segment.bytes,0),totalDurationSeconds:checked.segments.reduce((sum,segment)=>sum+segment.durationSeconds,0),segments:checked.segments.length};
}
export function audioDownloadLimits(capabilities){
 if(capabilities===undefined)return {maxBytes:AUDIO_LIMITS.totalBytes,maxSegments:AUDIO_LIMITS.downloadSegments};
 exactObject(capabilities,['schemaVersion','platform','maxAudioBytes','freeReserveBytes','maxSegments']);
 if(capabilities.schemaVersion!==1||capabilities.platform!=='windows'||capabilities.maxAudioBytes!==DESKTOP_AUDIO_BYTES||capabilities.freeReserveBytes!==DESKTOP_AUDIO_RESERVE||capabilities.maxSegments!==AUDIO_LIMITS.downloadSegments)throw failure('Неверная возможность локального аудиохранилища');
 return {maxBytes:DESKTOP_AUDIO_BYTES,maxSegments:AUDIO_LIMITS.downloadSegments};
}
export function assertAudioDownloadable(manifest,{maxBytes,maxSegments=AUDIO_LIMITS.downloadSegments,capabilities}={}){
 const limits=audioDownloadLimits(capabilities);if(maxBytes===undefined)maxBytes=limits.maxBytes;
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>limits.maxBytes||!Number.isSafeInteger(maxSegments)||maxSegments<1||maxSegments>limits.maxSegments)throw failure('Неверный предел локального аудиохранилища');
 const summary=audioSummary(manifest);
 if(summary.totalBytes>maxBytes||summary.segments>maxSegments)throw Object.assign(new Error(`Аудиокнига превышает предел локального хранилища (${Math.floor(maxBytes/1024**3)} ГБ, ${maxSegments} фрагмента)`),{code:'AUDIO_STORAGE_LIMIT'});
 return summary;
}
function positionOptions(manifest,{manifestSha256,updatedAt=Date.now(),rate=1}={}){
 const checked=validateAudioManifest(manifest);
 if(!validHash(manifestSha256)||!Number.isSafeInteger(updatedAt)||updatedAt<0||!Number.isFinite(rate)||rate<0.5||rate>2)throw failure('Неверная привязка позиции аудио');
 return {checked,manifestSha256,updatedAt,rate};
}
export function seekAudioPosition(manifest,absoluteSeconds,options={}){
 const {checked,manifestSha256,updatedAt,rate}=positionOptions(manifest,options);
 if(!Number.isFinite(absoluteSeconds))throw failure('Неверная позиция аудио');
 const total=checked.segments.reduce((sum,segment)=>sum+segment.durationSeconds,0);
 let remaining=Math.max(0,Math.min(total,absoluteSeconds)),ordinal=0;
 while(ordinal<checked.segments.length-1&&remaining>=checked.segments[ordinal].durationSeconds){remaining-=checked.segments[ordinal].durationSeconds;ordinal++;}
 const seconds=Math.max(0,Math.min(checked.segments[ordinal].durationSeconds,remaining));
 return {jobId:checked.jobId,manifestSha256,ordinal,seconds,rate,updatedAt,completed:absoluteSeconds>=total};
}
export function normalizeAudioPosition(manifest,value,{manifestSha256,updatedAt}={}){
 if(!value||typeof value!=='object'||value.jobId!==manifest?.jobId||!validHash(value.manifestSha256)||manifestSha256!==undefined&&value.manifestSha256!==manifestSha256||!Number.isSafeInteger(value.ordinal)||value.ordinal<0||!Number.isFinite(value.seconds)||value.seconds<0||!Number.isSafeInteger(value.updatedAt)||value.updatedAt<0||typeof value.completed!=='boolean'||value.rate!==undefined&&(!Number.isFinite(value.rate)||value.rate<0.5||value.rate>2))return null;
 const checked=validateAudioManifest(manifest);
 if(value.ordinal>=checked.segments.length)return null;
 // Oversized local positions are rejected instead of silently overwriting a
 // valid saved position with a different or corrupted recording's duration.
 if(value.seconds>checked.segments[value.ordinal].durationSeconds+1/AUDIO_LIMITS.sampleRate)return null;
 const absolute=checked.segments.slice(0,value.ordinal).reduce((sum,segment)=>sum+segment.durationSeconds,0)+value.seconds;
 return seekAudioPosition(checked,absolute,{manifestSha256:value.manifestSha256,updatedAt:updatedAt===undefined?value.updatedAt:updatedAt,rate:value.rate??1});
}
export function absoluteAudioPosition(manifest,value,options={}){
 const position=normalizeAudioPosition(manifest,value,options);
 if(!position)return null;
 return manifest.segments.slice(0,position.ordinal).reduce((sum,segment)=>sum+segment.durationSeconds,0)+position.seconds;
}
export function advanceAudioPosition(manifest,value,deltaSeconds,options={}){
 if(!Number.isFinite(deltaSeconds))throw failure('Неверный шаг перемотки');
 const current=absoluteAudioPosition(manifest,value,options);
 if(current===null)throw failure('Позиция относится к другой аудиокниге');
 return seekAudioPosition(manifest,current+deltaSeconds,{manifestSha256:options.manifestSha256??value.manifestSha256,updatedAt:options.updatedAt??Date.now(),rate:options.rate??value.rate??1});
}
