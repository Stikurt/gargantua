const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const uuid=value=>typeof value==='string'&&UUID.test(value);
const terminal=new Set(['completed','failed','blocked','cancelled','rejected']);
function state(row){
 if(row?.status==='cancelled'||row?.status==='rejected')return row.status;
 if(row?.status==='pending-approval')return 'pending-approval';
 return row?.jobStatus||row?.job?.status||(row?.status==='active'?'queued':row?.status)||'unknown';
}
function valid(row){return row&&typeof row==='object'&&!Array.isArray(row)&&uuid(row.jobId)&&(row.kind==='audio'||row.kind==='translation'&&row.audio===true);}
function newer(candidate,known,profileId){
 const rank=row=>[profileId&&row.requestedBy===profileId?1:0,row.status==='cancelled'||row.status==='rejected'?0:1,Number.isSafeInteger(row.revision)?row.revision:0,Number.isFinite(Date.parse(row.updatedAt))?Date.parse(row.updatedAt):0];
 const left=rank(candidate),right=rank(known);for(let index=0;index<left.length;index++){if(left[index]!==right[index])return left[index]>right[index];}return false;
}
function childFor(parent,child){
 if(child.kind!=='audio'||child.parentJobId!==parent.jobId||child.jobId===parent.jobId)return false;
 if(uuid(parent.requestedBy)&&uuid(child.requestedBy)&&parent.requestedBy!==child.requestedBy)return false;
 if(uuid(child.parentRequestId)&&uuid(parent.id)&&child.parentRequestId!==parent.id)return false;
 return true;
}
/** One entry per shared job; completed translation subscriptions remain visible
 * until their own audio child exists, including when that child needs approval. */
export function audioRequestRows(list,{profileId}={}){
 if(!Array.isArray(list)||list.length>1000)throw Object.assign(new Error('Неверный список аудиозаявок'),{code:'AUDIO_REQUESTS'});
 const eligible=list.filter(valid),jobs=new Map();
 for(const row of eligible){const known=jobs.get(row.jobId);if(!known||newer(row,known,profileId))jobs.set(row.jobId,row);}
 return [...jobs.values()].filter(row=>row.kind!=='translation'||!eligible.some(child=>childFor(row,child))).map(row=>{const parent=row.kind==='audio'&&row.originChapterRange?eligible.find(parent=>parent.kind==='translation'&&parent.chapterRange&&childFor(parent,row)):null;return {...row,...(parent?{continuationParent:{...parent}}:{})};});
}
export function shouldPollAudioRequests(list,options={}){
 return audioRequestRows(list,options).some(row=>{
  const status=state(row);if(status==='completed')return row.kind==='translation'&&row.audio===true;
  return !terminal.has(status);
 });
}
export function audioRequestStatus(row){
 const status=state(row);
 if(status==='completed')return row?.kind==='translation'&&row?.audio===true?'Перевод готов, ожидается озвучка':'Готово';
 if(status==='paused'){
  const reason=row?.pauseReason||row?.job?.pauseReason||'';
  if(/thermal|overheat|temperature|cooldown/i.test(reason))return 'Ожидаем охлаждения ПК';
  if(/resource|memory|pressure/i.test(reason))return 'Ожидаем свободные ресурсы ПК';
 }
 return ({'pending-approval':'Ожидает разрешения владельца','approval-required':'Ожидает разрешения владельца',queued:'В очереди',processing:'Обрабатывается',paused:'Приостановлено',blocked:'Остановлено для проверки безопасности',failed:'Нужна проверка на сервере',cancelled:'Отменено',rejected:'Отклонено'})[status]||'В обработке';
}
