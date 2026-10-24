// Presentation only. The server owns identities, permissions and quarantine.
import {normalizeSearchQuery,SEARCH_QUERY_LIMITS} from './search-query.mjs';
import {chapterRangeInput,chapterBatchLabel} from './chapter-batches.mjs';
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const candidateId=/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/;
const statuses=new Set(['pending-approval','queued','processing','needs-review','selected','acquiring','book-ready','cancelled','error']);
export const DISCOVERY_INTENTS=[['auto','Определить автоматически'],['book','Название книги'],['author','Автор'],['series','Серия или цикл']];
export const DISCOVERY_DEFAULTS={query:'',intent:'auto',language:'ru',allowOriginal:false,audio:true,chapterRange:{start:1,count:5}};
export const DISCOVERY_LABELS={'pending-approval':'Ждёт разрешения владельца',queued:'В очереди',processing:'Ищем и проверяем','needs-review':'Нужно уточнение',selected:'Источник выбран',acquiring:'Получаем и проверяем книгу','book-ready':'Книга на сервере',cancelled:'Отменено',error:'Поиск остановлен'};
export function discoveryInput(value){
 if(!record(value))throw Error('Введите название, автора или серию');
 const query=normalizeSearchQuery(value.query);
 const intent=value.intent??'auto',language=value.language??'ru',allowOriginal=value.allowOriginal??false,audio=value.audio??true;
 if(!DISCOVERY_INTENTS.some(([id])=>id===intent)||!/^[a-z]{2}$/.test(language)||typeof allowOriginal!=='boolean'||typeof audio!=='boolean')throw Error('Проверьте параметры поиска');
 return {query,intent,language,allowOriginal,audio,...(value.chapterRange!==undefined?{chapterRange:chapterRangeInput(value.chapterRange)}:{})};
}
/** Query suggestions use display metadata already visible to this reader.
 * They cannot carry a source URL or select/download a server candidate. */
export function discoveryQueryHints({books=[],localBooks=[],rows=[]}={}){
 const hints=[],seen=new Set();
 const add=(title,kind,source,id,aliases=[])=>{
  if(hints.length>=SEARCH_QUERY_LIMITS.knownRecords||!['book','author','series'].includes(kind))return;
  let query;try{query=normalizeSearchQuery(title);}catch{return;}
  const key=kind+'|'+query.toLowerCase();if(seen.has(key))return;seen.add(key);
  hints.push({title:query,kind,source,...(typeof id==='string'&&candidateId.test(id)?{id}:{}),aliases:Array.isArray(aliases)?aliases.filter(value=>typeof value==='string').slice(0,SEARCH_QUERY_LIMITS.aliasesPerRecord):[]});
 };
 // Keep a selected request's actual source metadata ahead of an arbitrarily
 // large library, so a multipart display suffix does not hide the work title.
 for(const row of Array.isArray(rows)?rows.slice(0,50):[]){
  for(const candidate of Array.isArray(row?.plan?.candidates)?row.plan.candidates.slice(0,20):[]){
   add(candidate.title,candidate.kind,'search-result',candidate.id,[candidate.originalTitle,...(Array.isArray(candidate.aliases)?candidate.aliases:[])].filter(Boolean));
   for(const author of Array.isArray(candidate.authors)?candidate.authors.slice(0,16):[])add(author?.name,'author','search-result',author?.remoteId);
  }
  if(row?.plan?.plan?.kind==='series')add(row.plan.plan.title,'series','search-result');
 }
 for(const [source,list]of [['server-library',books],['local-library',localBooks]])for(const book of Array.isArray(list)?list.slice(0,256):[]){add(book?.title,'book',source,book?.id);add(book?.author,'author',source);}
 return hints;
}
export function discoveryRow(value){
 if(!record(value)||!uuid.test(value.id)||!uuid.test(value.requested_by)||!Number.isSafeInteger(value.revision)||value.revision<1||!Number.isSafeInteger(value.plan_revision)||value.plan_revision<0||!statuses.has(value.status)||!record(value.input)||typeof value.query_text!=='string')throw Error('Сервер вернул неподдерживаемый ответ поиска. Обновите приложение и сервер.');
 return value;
}
export function createdDiscovery(value){if(!record(value))throw Error('Некорректный ответ создания поиска');return discoveryRow(value.request);}
export function discoveryList(value){if(!Array.isArray(value)||value.length>100)throw Error('Некорректный список поисковых заявок');return value.map(discoveryRow);}
export function newestDiscoveryRow(current,incoming){discoveryRow(incoming);return current?.id===incoming.id&&current.revision>incoming.revision?current:incoming;}
export function pollingDiscovery(row){return Boolean(row&&(['pending-approval','queued','processing','selected','acquiring'].includes(row.status)||row.status==='book-ready'&&['translation','audio'].some(kind=>['pending-provider','queued','processing','paused','approval-required','waiting-translation','waiting-provider'].includes(row.outputs?.[kind]?.status))));}
export function discoveryActions(row,profile){
 discoveryRow(row);const writable=row.requested_by===profile?.id||profile?.role==='owner',unlinked=!row.import_id;
 return {approve:writable&&profile?.role==='owner'&&row.status==='pending-approval',retry:writable&&unlinked&&row.status==='error',refine:writable&&unlinked&&['error','needs-review'].includes(row.status),select:writable&&['needs-review','selected'].includes(row.status),more:writable&&row.status==='needs-review'&&unlinked&&canContinue(row.plan)&&row.plan.continuationRequested!==true,cancel:writable&&['pending-approval','queued','processing','needs-review','selected','acquiring'].includes(row.status)};
}
function canContinue(result){
 const plan=result?.plan,next=plan?.continuation;if(!record(next)||next.provider!=='openlibrary'||!Number.isSafeInteger(next.offset)||next.offset<1||next.offset>10000)return false;
 return plan.kind==='author'&&next.kind==='author-works'&&/^OL[1-9][0-9]{0,14}A$/.test(next.remoteId)&&candidateId.test(plan.authorCandidateId??'')||plan.kind==='series'&&next.kind==='series-search'&&typeof next.term==='string'&&next.term.length>=2&&next.term.length<=300;
}
export function candidateChoice(candidate){
 if(!record(candidate)||!candidateId.test(candidate.id??'')||candidate.conflictingMetadata||candidate.identityEvidenceIncomplete)return null;
 const provider=candidate.identity?.provider,remote=candidate.identity?.remoteId,source=candidate.sourceBinding;
 const metadataAllowed=!candidate.blockedReason||['SOURCE_LANGUAGE_UNKNOWN','ORIGINAL_NOT_ALLOWED'].includes(candidate.blockedReason);
 if(metadataAllowed&&!candidate.sourceResolutionAttempted){
  if(provider==='openlibrary'&&typeof remote==='string'&&new RegExp('^OL[1-9][0-9]{0,14}'+(candidate.kind==='author'?'A':'W')+'$').test(remote)&&['author','book'].includes(candidate.kind))return {label:candidate.kind==='author'?'Показать книги автора':'Найти доступный текст',kind:'expand'};
  if(provider==='curated'&&candidate.kind==='book'&&/^warriors:tpc:[1-6]$/.test(remote??''))return {label:'Найти этот том',kind:'expand'};
  if(provider==='ranobelib'&&candidate.kind==='book'&&candidate.availability==='needs-preview'&&source?.provider==='ranobelib'&&source.remoteId===remote&&typeof source.slug==='string'&&source.slug.startsWith(remote+'--'))return {label:'Проверить главы и ветки',kind:'expand'};
 }
 if(candidate.kind!=='book'||candidate.eligibleForAcquisition!==true||candidate.blockedReason)return null;
 if(candidate.availability==='library'&&provider==='library'&&uuid.test(candidate.bookId??'')&&remote===candidate.bookId)return {label:'Использовать книгу из библиотеки',kind:'acquire'};
 if(candidate.availability==='ranobe-full'&&provider==='ranobelib'&&source?.provider==='ranobelib'&&source.remoteId===remote&&Object.hasOwn(source,'branchId')&&source.completeness?.verified===true)return {label:'Получить эту ветку целиком',kind:'acquire'};
 if(candidate.availability==='fetchable'&&provider!=='ranobelib'&&Array.isArray(candidate.downloadSelections)&&candidate.downloadSelections.length)return {label:'Получить и проверить книгу',kind:'acquire'};
 return null;
}
export function discoveryDecision(row,action,changes={}){
 discoveryRow(row);if(!['approve','cancel','select','retry','refine','more'].includes(action))throw Error('Неизвестное действие поиска');
 const body={action,expectedRevision:row.revision};
 if(['select','more'].includes(action))body.planRevision=row.plan_revision;
 if(action==='select'){
  const candidate=row.plan?.candidates?.find(item=>item.id===changes.candidateId);
  if(!candidateChoice(candidate))throw Error('Для этого варианта не подтверждён доступный источник. Уточните запрос.');
  body.candidateId=candidate.id;
 }
 if(action==='refine')Object.assign(body,discoveryInput(changes));
 return body;
}
export function discoveryOutput(row){
 const value=row.outputs||{},book=value.book||{},translation=value.translation||{},audio=value.audio||{};
 const label=(kind,output)=>{
  const name=kind==='audio'?'Озвучивание':'Перевод';
  if(output.status==='not-requested')return `${name} не запрашивалось.`;
  if(output.status==='not-required')return 'Перевод не требуется.';
  if(output.status==='ready')return kind==='audio'?'Аудио готово.':'Перевод готов.';
  if(output.status==='pending-provider')return kind==='audio'?'Озвучивание ещё не запущено. Сервер ожидает проверенную книгу и доступный обработчик.':'Перевод ещё не запущен. Сервер ожидает проверку языка и доступный обработчик.';
  if(['pending-approval','approval-required'].includes(output.status))return `${name} ожидает разрешения владельца.`;
  if(['queued','pending'].includes(output.status))return `${name} в очереди. Прогресс сохраняется на сервере.`;
  if(['running','processing'].includes(output.status))return `${name} выполняется. Прогресс сохраняется на сервере.`;
  if(['paused','paused-resources'].includes(output.status))return `${name} приостановлено до появления ресурсов.`;
  if(output.status==='waiting-translation')return 'Озвучивание начнётся после завершения перевода.';
  if(output.status==='waiting-provider')return `${name} ожидает доступного обработчика.`;
  if(output.status==='needs-chapter-range')return `${name}: выберите диапазон в пределах полученной книги.`;
  if(['awaiting-language','language-review','unsupported-language','needs-review','needs-language'].includes(output.status))return `${name} ожидает уточнения языка или проверки владельцем.`;
  if(output.status==='unsupported')return `${name} для этого языка пока не поддерживается.`;
  if(['failed','error','blocked'].includes(output.status))return `${name} остановлено. Книга и её оригинал сохраняются отдельно.`;
  if(output.status==='cancelled')return `${name} отменено.`;
  return null;
 };
 const describe=(kind,output)=>{const status=label(kind,output),range=chapterBatchLabel(output);return status&&range?`${status} ${range}.`:status;};
 return {book:book.status==='ready'?'Книга проверена и доступна в серверной библиотеке.':'Содержимое появится в библиотеке после получения и проверки.',translation:describe('translation',translation),audio:describe('audio',audio),ready:book.status==='ready',audioReady:audio.status==='ready',translationReady:translation.status==='ready',publicationIds:discoveryPublicationIds(row)};
}
export function discoveryPublicationIds(row){
 const book=row?.outputs?.book;if(book?.status!=='ready')return [];
 const ids=book.multipart===true?book.publicationIds:[book.publicationId];
 if(!Array.isArray(ids)||!ids.length||ids.length>20000||ids.some(value=>typeof value!=='string'||!uuid.test(value))||new Set(ids.map(value=>value.toLowerCase())).size!==ids.length)return [];
 return ids.map(value=>value.toLowerCase());
}
export function candidateNote(candidate){
 if(candidate.conflictingMetadata)return 'Противоречивые данные источника: требуется уточнение.';
 if(candidate.identityEvidenceIncomplete)return 'Данных для проверки книги недостаточно.';
 const reasons={ORIGINAL_NOT_ALLOWED:'Другой язык. Разрешите оригинал в уточнении запроса.',SOURCE_LANGUAGE_UNKNOWN:'Язык источника пока не подтверждён.',MIRROR_PATH_UNVERIFIED:'Адрес поддерживаемого файла не подтверждён.',CONFLICTING_METADATA:'Противоречивые данные источника.'};
 if(candidate.blockedReason)return reasons[candidate.blockedReason]||'Автоматическое получение этого варианта недоступно.';
 return ({'metadata-only':'Найдена запись в каталоге; наличие полного текста ещё не подтверждено.','needs-preview':'Нужно проверить доступные главы и выбрать ветку перевода.','ranobe-full':'Доступное оглавление ветки проверено. Новые главы будут отслеживаться сервером.',fetchable:'Найден поддерживаемый файл. После выбора обязательны карантин и проверка.',library:'Книга уже есть в серверной библиотеке.'})[candidate.availability]||'Источник требует проверки.';
}
const storageLocks=new WeakMap();
async function withStorageLock(storage,key,operation){
 let locks=storageLocks.get(storage);if(!locks){locks=new Map();storageLocks.set(storage,locks);}
 const before=locks.get(key)||Promise.resolve();let release;const after=new Promise(resolve=>{release=resolve;});locks.set(key,after);
 await before.catch(()=>{});try{return await (globalThis.navigator?.locks?.request?globalThis.navigator.locks.request(`gargantua-discovery:${key}`,operation):operation());}finally{release();if(locks.get(key)===after)locks.delete(key);}
}
async function digest(value){const bytes=await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));return [...new Uint8Array(bytes)].map(n=>n.toString(16).padStart(2,'0')).join('');}
export async function discoveryStorageScope(profileId,serverIdentity=globalThis.location?.origin||'http://127.0.0.1:3080'){
 if(!uuid.test(profileId??''))throw Error('Для серверного поиска нужен вход в профиль');
 let origin;try{const url=new URL(serverIdentity);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||!['','/'].includes(url.pathname))throw Error();origin=url.origin;}catch{throw Error('Не удалось определить адрес сервера поиска');}
 return `${profileId.toLowerCase()}:discovery:${await digest(origin)}`;
}
// Reserve before sending. A separate ticket for each input preserves A→B→A
// retries, including a lost response and a restart on a different server.
export async function reserveDiscoverySubmission(storage,profileId,value,makeId=()=>globalThis.crypto.randomUUID(),serverIdentity){
 const input=discoveryInput(value),scope=await discoveryStorageScope(profileId,serverIdentity),key=`${scope}:submit:${await digest(JSON.stringify(input))}`;
 return withStorageLock(storage,key,async()=>{
  const old=await storage.get(key);
  if(record(old)&&uuid.test(old.idempotencyKey??'')){
   try{if(JSON.stringify(discoveryInput(old))===JSON.stringify(input))return {key,body:{idempotencyKey:old.idempotencyKey,...input}};}catch{}
  }
  const body={idempotencyKey:makeId(),...input};if(!uuid.test(body.idempotencyKey))throw Error('Не удалось создать ключ поисковой заявки');
  await storage.put(key,body);return {key,body};
 });
}

const copy=value=>structuredClone(value);
function controllerError(error){return {message:String(error?.message||'Не удалось связаться с сервером').slice(0,500),status:Number.isInteger(error?.status)?error.status:null,code:typeof error?.code==='string'?error.code:null};}
function historyOrder(rows){return [...rows].sort((a,b)=>String(b.created_at||'').localeCompare(String(a.created_at||''))||a.id.localeCompare(b.id));}
function cachePayload(state){
 const rows=[],candidates=state.selected?[state.selected,...state.rows.filter(row=>row.id!==state.selected.id)]:state.rows;
 let bytes=0;for(const row of candidates.slice(0,50)){const size=new TextEncoder().encode(JSON.stringify(row)).byteLength;if(size>1024*1024)continue;if(bytes+size>2*1024*1024)break;bytes+=size;rows.push(row);}
 return {schemaVersion:1,selectedId:state.selected?.id??null,rows};
}

// The controller does not acquire books or bypass server approval. It only
// coordinates durable search intentions and revision-checked decisions.
export function createDiscoveryController({api,storage,profile,serverIdentity,makeId=()=>globalThis.crypto.randomUUID(),onChange,setTimer=setTimeout,clearTimer=clearTimeout,pollMs=3000}={}){
 if(typeof api!=='function'||!storage||!uuid.test(profile?.id??'')||!Number.isInteger(pollMs)||pollMs<250||pollMs>60000)throw Error('Некорректные параметры поиска');
 const state={rows:[],selected:null,busy:false,loading:false,error:null,offline:false,restored:false};
 const listeners=new Set(onChange?[onChange]:[]),scope=discoveryStorageScope(profile.id,serverIdentity);
 let disposed=false,polling=false,timer=null,pollGeneration=0,sequence=0,acceptedVersion=0,persistQueue=Promise.resolve(),persistedCache=null;
 const getState=()=>copy(state);
 function emit(){if(disposed)return;const snapshot=getState();for(const listener of listeners)listener(snapshot);}
 function authorize(row){discoveryRow(row);if(row.requested_by.toLowerCase()!==profile.id.toLowerCase()&&profile.role!=='owner')throw Error('Сервер вернул заявку другого профиля');return row;}
 function merge(row,{select=false}={}){
  authorize(row);const fresh=newestDiscoveryRow(state.rows.find(item=>item.id===row.id),row);
  state.rows=historyOrder([fresh,...state.rows.filter(item=>item.id!==row.id)]).slice(0,100);
  if(select||state.selected?.id===fresh.id)state.selected=fresh;
  acceptedVersion++;
  emit();return fresh;
 }
 function save(){const payload=cachePayload(state),encoded=JSON.stringify(payload);const queued=persistQueue.catch(()=>{}).then(async()=>{if(encoded!==persistedCache){await storage.put(`${await scope}:state`,payload);persistedCache=encoded;}});persistQueue=queued;return queued;}
 async function restore(){
  const version=acceptedVersion,old=await storage.get(`${await scope}:state`);if(disposed)return getState();
  if(version!==acceptedVersion){state.restored=true;emit();return getState();}
  if(old!=null){if(!record(old)||old.schemaVersion!==1||!Array.isArray(old.rows)||old.rows.length>100)throw Error('Повреждён локальный список поисков. Сохранённые книги не затронуты.');
   const rows=old.rows.map(authorize);if(new Set(rows.map(row=>row.id)).size!==rows.length)throw Error('Повреждён локальный список поисков');
   state.rows=historyOrder(rows);state.selected=rows.find(row=>row.id===old.selectedId)||null;persistedCache=JSON.stringify(old);
  }
  state.restored=true;emit();return getState();
 }
 function noteFailure(error){state.error=controllerError(error);state.offline=!error?.status||error.status>=500;if(error?.status===401||error?.status===403)stopPolling();emit();}
 async function list({initial=false}={}){
  const generation=++sequence;state.loading=true;emit();
  try{
   const rows=discoveryList(await api('/discovery/requests')).map(authorize);if(disposed||generation!==sequence)return getState();
   state.rows=historyOrder([...rows.map(row=>newestDiscoveryRow(state.rows.find(old=>old.id===row.id),row)),...state.rows.filter(old=>!rows.some(row=>row.id===old.id))]).slice(0,100);
   const selectedId=state.selected?.id;if(selectedId)state.selected=state.rows.find(row=>row.id===selectedId)||state.selected;
   else if(initial)state.selected=state.rows.find(row=>row.requested_by===profile.id)||null;
   acceptedVersion++;
   state.error=null;state.offline=false;await save();return getState();
  }catch(error){if(!disposed&&generation===sequence)noteFailure(error);throw error;}
  finally{if(!disposed&&generation===sequence){state.loading=false;emit();}}
 }
 async function refresh(id=state.selected?.id){
  if(!uuid.test(id??''))throw Error('Выберите поисковую заявку');
  try{const row=authorize(discoveryRow(await api(`/discovery/requests/${id}`)));if(row.id!==id)throw Error('Сервер вернул другую поисковую заявку');if(disposed)return row;const fresh=merge(row);state.error=null;state.offline=false;await save();emit();return fresh;}catch(error){if(!disposed)noteFailure(error);throw error;}
 }
 async function exclusive(operation){
  if(disposed)throw Error('Экран поиска закрыт');if(state.busy)throw Object.assign(Error('Дождитесь завершения текущего действия'),{code:'DISCOVERY_CLIENT_BUSY'});
  state.busy=true;state.error=null;emit();try{return await operation();}catch(error){if(!disposed)noteFailure(error);throw error;}finally{state.busy=false;emit();}
 }
 async function select(id){
  return exclusive(async()=>{if(!uuid.test(id??''))throw Error('Некорректная поисковая заявка');const cached=state.rows.find(row=>row.id===id);if(cached){state.selected=cached;acceptedVersion++;emit();await save();}const row=authorize(discoveryRow(await api(`/discovery/requests/${id}`)));if(row.id!==id)throw Error('Сервер вернул другую поисковую заявку');if(disposed)return row;const result=merge(row,{select:true});state.offline=false;await save();return result;});
 }
 async function submit(input){
  return exclusive(async()=>{
   const ticket=await reserveDiscoverySubmission(storage,profile.id,input,makeId,serverIdentity);
   if(disposed)throw Error('Экран поиска закрыт');
   const row=authorize(createdDiscovery(await api('/discovery/requests',{method:'POST',body:ticket.body})));
   if(row.requested_by.toLowerCase()!==profile.id.toLowerCase())throw Error('Сервер вернул заявку другого профиля');
   if(!disposed){merge(row,{select:true});state.offline=false;await save();}
   // Keep the key if either the POST or the durable receipt could not finish.
   if(!disposed)await storage.remove(ticket.key);
   return row;
  });
 }
 async function decide(action,changes={}){
  const captured=state.selected;if(!captured)throw Error('Выберите поисковую заявку');
  const allowed=discoveryActions(captured,profile);if(!allowed[action])throw Error('Это действие сейчас недоступно. Обновите заявку.');
  const body=discoveryDecision(captured,action,changes);
  return exclusive(async()=>{
   try{
    const row=authorize(discoveryRow(await api(`/discovery/requests/${captured.id}/decision`,{method:'POST',body})));
    if(row.id!==captured.id)throw Error('Сервер вернул другую поисковую заявку');
    if(!disposed){merge(row);state.offline=false;await save();}return row;
   }catch(error){
    if(error?.status===409&&!disposed){try{await refresh(captured.id);}catch{/* Retain the original revision error and the last durable state. */}}
    // Never repeat a decision with a newly read revision. It needs a new click.
    throw error;
   }
  });
 }
 function stopPolling(){polling=false;pollGeneration++;if(timer!==null)clearTimer(timer);timer=null;}
 function startPolling(){
  if(disposed||polling)return;polling=true;const generation=++pollGeneration;
  const tick=async()=>{
   timer=null;if(disposed||!polling||generation!==pollGeneration)return;
   if(!state.busy&&pollingDiscovery(state.selected)){try{await refresh();}catch{/* The persisted intention can be resumed after reconnection. */}}
   if(!disposed&&polling&&generation===pollGeneration)timer=setTimer(tick,state.error?Math.min(30000,pollMs*4):pollMs);
  };
  timer=setTimer(tick,pollMs);
 }
 return {getState,restore,list,refresh,select,submit,decide,startPolling,stopPolling,subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},async flush(){await persistQueue;},dispose(){disposed=true;sequence++;stopPolling();listeners.clear();}};
}
