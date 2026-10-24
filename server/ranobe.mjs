/** Narrow observed RanobeLib API adapter; no authentication/protection bypass.
 * Primary API observation: api.cdnlibs.org, Site-Id 3, 2026-10-22.
 * A source-inventory snapshot is not proof of a complete original work. */
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {normalizeRanobeContent} from './ranobe-content.mjs';
const defaultFetch=(...args)=>import('./fetch.mjs').then(module=>module.fetchSafe(...args));
const BASE='https://api.cdnlibs.org',MAX_BYTES=2*1024*1024,MAX_CHAPTERS=20000,MAX_BRANCHES=50;
const SLUG=/^[1-9][0-9]{0,9}--[a-zA-Z0-9_-]{1,150}$/u;
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=(value,max=300)=>typeof value==='string'?value.replace(/[\p{Cc}\p{Cf}]/gu,' ').replace(/\s+/gu,' ').trim().slice(0,max):'';
const digest=value=>createHash('sha256').update(value).digest('hex');
const messages={RANOBE_IDENTITY:'Источник вернул другую книгу, главу или ветку',RANOBE_INVENTORY:'Оглавление источника неоднозначно или повреждено',RANOBE_INCOMPLETE:'Полнота оглавления источника не подтверждена',RANOBE_RESTRICTED:'Источник ограничил доступ; требуется рассмотрение',RANOBE_CONTENT:'Глава недоступна или имеет неподдерживаемый формат',RANOBE_RESPONSE:'Источник вернул неподдерживаемый ответ',RANOBE_TIMEOUT:'Превышено время обращения к источнику',RANOBE_ABORTED:'Обращение к источнику отменено',RANOBE_UNAVAILABLE:'Источник временно недоступен',RANOBE_INPUT:'Некорректные параметры адаптера'};
const error=code=>Object.assign(new Error(messages[code]||'Проверка источника не пройдена'),{code});
/** Shared by API and chapter-image transport. Never retain upstream messages,
 * URLs, response bodies or arbitrary properties; retry remains an allowlist. */
export function sanitizeRanobeTransportError(failure){
 const status=failure?.httpStatus,hasStatus=Number.isInteger(status)&&status>=100&&status<=599,temporary=[408,425,429,500,502,503,504];
 if(Object.hasOwn(messages,failure?.code??'')){
  const safe=error(failure.code);
  // Preserve a previously classified transient result across a second boundary,
  // without promoting a permanent HTTP failure through an arbitrary flag.
  if(failure.code==='RANOBE_UNAVAILABLE'){
   safe.transient=failure.transient===true&&(!hasStatus||temporary.includes(status));if(hasStatus)safe.httpStatus=status;
  }
  return safe;
 }
 if(failure?.code==='FETCH_HTTP'){
  if([401,403,410,451].includes(status))return error('RANOBE_RESTRICTED');
  if(status===404)return error('RANOBE_CONTENT');
  return Object.assign(error('RANOBE_UNAVAILABLE'),{transient:temporary.includes(status),...(hasStatus?{httpStatus:status}:{})});
 }
 if(failure?.code==='ABORT_ERR'||failure?.name==='AbortError')return error('RANOBE_ABORTED');
 const transient=['FETCH_DNS','FETCH_DEADLINE','FETCH_IDLE_TIMEOUT','FETCH_TRUNCATED','ECONNRESET','ETIMEDOUT','ECONNREFUSED','EAI_AGAIN','ENOTFOUND','EHOSTUNREACH','ENETUNREACH','EPIPE'].includes(failure?.code);
 return Object.assign(error('RANOBE_UNAVAILABLE'),{transient});
}
function identifier(value,{nullable=false}={}){
 if(nullable&&value===null)return null;
 if(typeof value==='number'&&Number.isSafeInteger(value)&&value>0&&value<=999999999999999)return String(value);
 if(typeof value==='string'&&/^[1-9][0-9]{0,14}$/u.test(value)&&Number.isSafeInteger(Number(value)))return value;
 throw error('RANOBE_IDENTITY');
}
export function canonicalRanobeNumber(value){
 if(typeof value==='number'){if(!Number.isSafeInteger(value)||value<0)throw error('RANOBE_INVENTORY');value=String(value);}
 if(typeof value!=='string'||!/^\d{1,12}(?:\.\d{1,9})?$/u.test(value))throw error('RANOBE_INVENTORY');
 let [integer,fraction='']=value.split('.');integer=integer.replace(/^0+(?=\d)/u,'');fraction=fraction.replace(/0+$/u,'');
 return integer+(fraction?'.'+fraction:'');
}
export function compareRanobeNumbers(a,b){
 const [ai,af='']=canonicalRanobeNumber(a).split('.'),[bi,bf='']=canonicalRanobeNumber(b).split('.');
 if(ai.length!==bi.length)return ai.length<bi.length?-1:1;if(ai!==bi)return ai<bi?-1:1;
 const size=Math.max(af.length,bf.length),left=af.padEnd(size,'0'),right=bf.padEnd(size,'0');return left===right?0:left<right?-1:1;
}
const branchKey=value=>value===null?'default':'branch:'+identifier(value);
const timestamp=value=>typeof value==='string'&&value.length<=40&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/u.test(value)&&Number.isFinite(Date.parse(value))?value:null;
function restricted(data){
 for(const field of ['is_licensed','is_locked','is_restricted','is_paid','is_deleted','is_blocked','blocked'])if(Object.hasOwn(data,field)&&![false,0,null].includes(data[field]))return true;
 if(Object.hasOwn(data,'expired_type')&&![0,'0',null].includes(data.expired_type))return true;
 if(data.expired_at!==undefined&&data.expired_at!==null)return true;
 if(data.bundle_id!==undefined&&data.bundle_id!==null)return true;
 if(data.price!==undefined&&data.price!==null&&!/^(?:0|0\.0+)$/u.test(String(data.price)))return true;
 return false;
}
export function ranobeSlug(value){
 let url;try{url=new URL(value);}catch{throw error('RANOBE_INPUT');}
 if(url.href.length>2000||url.protocol!=='https:'||url.hostname!=='ranobelib.me'||url.username||url.password||url.port||url.hash)throw error('RANOBE_INPUT');
 const found=/^\/(?:[a-z]{2}\/)?book\/([^/]+)\/?$/u.exec(url.pathname);
 if(!found||!SLUG.test(found[1]))throw error('RANOBE_INPUT');return found[1];
}
function checkedSlug(value){if(typeof value!=='string'||!SLUG.test(value))throw error('RANOBE_INPUT');return value;}
function paginationIncomplete(envelope){
 if(!record(envelope))return false;
 if(Object.keys(envelope).some(key=>!['data','meta','links'].includes(key)))return true;
 if(Object.hasOwn(envelope,'links')&&envelope.links!==null&&!record(envelope.links)||Object.hasOwn(envelope,'meta')&&envelope.meta!==null&&!record(envelope.meta))return true;
 if(record(envelope.links)&&(Object.keys(envelope.links).some(key=>!['next','prev','first','last'].includes(key))||Object.values(envelope.links).some(value=>value!==null)))return true;
 if(record(envelope.meta)){
  if(Object.keys(envelope.meta).some(key=>!['current_page','last_page','total','has_more','hasMore'].includes(key)))return true;
  const {current_page:current,last_page:last}=envelope.meta;
  if(current!==undefined&&(!Number.isSafeInteger(current)||current!==1)||last!==undefined&&(!Number.isSafeInteger(last)||last!==1))return true;
  for(const flag of ['has_more','hasMore'])if(Object.hasOwn(envelope.meta,flag)&&envelope.meta[flag]!==false)return true;
 }
 return false;
}
/** Exact API order is retained. No float comparison or automatic sorting. */
function normalizeRanobeInventoryObservation({slug,meta,list,envelope={}}){
 checkedSlug(slug);const workId=slug.split('--')[0];
 if(!record(meta)||identifier(meta.id)!==workId||meta.slug_url!==undefined&&meta.slug_url!==slug||meta.site!==undefined&&meta.site!==3)throw error('RANOBE_IDENTITY');
 if(restricted(meta))throw error('RANOBE_RESTRICTED');
 if(!Array.isArray(list)||list.length>MAX_CHAPTERS)throw error('RANOBE_INVENTORY');if(paginationIncomplete(envelope))throw error('RANOBE_INCOMPLETE');
 const coordinates=new Set(),releaseIds=new Set(),branches=new Map(),chapters=[];let previous=null,previousIndex=null;
 for(const [apiOrder,item] of list.entries()){
  if(!record(item)||!Array.isArray(item.branches)||!item.branches.length||item.branches.length>MAX_BRANCHES||restricted(item))throw error('RANOBE_INVENTORY');
  const volume=canonicalRanobeNumber(item.volume),number=canonicalRanobeNumber(item.number),coordinate=volume+'|'+number;
  if(coordinates.has(coordinate))throw error('RANOBE_INVENTORY');coordinates.add(coordinate);
  if(previous&&(compareRanobeNumbers(volume,previous.volume)<0||compareRanobeNumbers(volume,previous.volume)===0&&compareRanobeNumbers(number,previous.number)<=0))throw error('RANOBE_INVENTORY');
  if(item.index!==undefined&&(!Number.isSafeInteger(item.index)||item.index<0||previousIndex!==null&&item.index<=previousIndex))throw error('RANOBE_INVENTORY');if(item.index!==undefined)previousIndex=item.index;
  if(item.branches_count!==undefined&&item.branches_count!==item.branches.length)throw error('RANOBE_INVENTORY');
  const localBranches=new Set(),normalized=[];
  for(const branch of item.branches){
   if(!record(branch)||!Object.hasOwn(branch,'branch_id'))throw error('RANOBE_INVENTORY');
   const remote=identifier(branch.branch_id,{nullable:true}),key=branchKey(remote),releaseId=identifier(branch.id);
   if(localBranches.has(key)||releaseIds.has(releaseId))throw error('RANOBE_INVENTORY');localBranches.add(key);releaseIds.add(releaseId);
   if(branch.teams!==undefined&&(!Array.isArray(branch.teams)||branch.teams.length>20))throw error('RANOBE_INVENTORY');
   const teams=(branch.teams??[]).map(team=>{if(!record(team))throw error('RANOBE_INVENTORY');return {id:identifier(team.id),name:text(team.name,100)};});
   const blocked=restricted(branch),row={id:Number(releaseId),branch_id:remote===null?null:Number(remote),releaseId,branchKey:key,teams,restricted:blocked,created_at:timestamp(branch.created_at),updated_at:timestamp(branch.updated_at)};
   normalized.push(row);
   if(!branches.has(key))branches.set(key,{id:row.branch_id,key,label:teams.map(t=>t.name).filter(Boolean).join(', ').slice(0,300)||'Основная ветка',chapterCount:0,restrictedCount:0,language:null,languageEvidence:'not-provided-by-observed-api'});
   const summary=branches.get(key);summary.chapterCount++;if(blocked)summary.restrictedCount++;
  }
  const itemId=identifier(item.id);if(!normalized.some(branch=>branch.releaseId===itemId))throw error('RANOBE_INVENTORY');
  const chapter={id:Number(itemId),volume,number,name:text(item.name),number_secondary:item.number_secondary===undefined?null:canonicalRanobeNumber(item.number_secondary),index:item.index??null,apiOrder,branches:normalized,branches_count:normalized.length};
  chapters.push(chapter);previous=chapter;
 }
 const uploaded=meta.items_count?.uploaded;
 if(uploaded!==undefined&&(!Number.isSafeInteger(uploaded)||uploaded<0||uploaded>chapters.length))throw error('RANOBE_INCOMPLETE');
 if(record(envelope.meta)&&envelope.meta.total!==undefined&&envelope.meta.total!==chapters.length)throw error('RANOBE_INCOMPLETE');
 const mismatch=Number.isSafeInteger(uploaded)&&uploaded<chapters.length;
 const completeness={kind:'source-inventory-snapshot',verified:Number.isSafeInteger(uploaded)&&uploaded===chapters.length,reportedUploaded:uploaded??null,received:chapters.length,originalWorkComplete:false,paginationObserved:false,...(mismatch?{counterMismatch:{code:'SOURCE_CARD_COUNT_BEHIND_INVENTORY',reportedUploaded:uploaded,received:chapters.length}}:{})};
 const snapshot={workId,order:'api-ascending-volume-chapter',chapters,completeness};
 return {slug,workId,title:text(meta.rus_name||meta.name||slug),author:(Array.isArray(meta.authors)?meta.authors.slice(0,16).map(x=>text(x?.name,200)).join(', '):'').slice(0,300),language:null,chapters:chapters.length,branches:[...branches.values()],list:chapters,inventory:snapshot,completeness,inventorySha256:digest(JSON.stringify(snapshot))};
}
/** A lagging card counter is not enough to reject newer chapters visible in
 * the source's own complete endpoint. Its narrow exception needs TWO fresh,
 * independently fetched, identically normalized inventories and card counts.
 * A short/paged/changing response never receives this verification basis. */
export function normalizeRanobeInventory(input){
 const first=normalizeRanobeInventoryObservation(input);
 if(!first.completeness.counterMismatch)return first;
 const confirmation=input?.confirmation;
 if(!record(confirmation))throw error('RANOBE_INCOMPLETE');
 const second=normalizeRanobeInventoryObservation({slug:input.slug,meta:confirmation.meta,list:confirmation.list,envelope:confirmation.envelope});
 if(first.inventorySha256!==second.inventorySha256||first.title!==second.title||first.author!==second.author||second.completeness.reportedUploaded!==first.completeness.reportedUploaded)throw error('RANOBE_INCOMPLETE');
 first.completeness={...first.completeness,verified:true,verificationBasis:'stable-unpaginated-source-inventory',observations:2};
 first.inventory={...first.inventory,completeness:first.completeness};first.inventorySha256=digest(JSON.stringify(first.inventory));
 return first;
}
export function selectRanobeBranch(info,branchId,{requireComplete=false}={}){
 const key=branchKey(identifier(branchId,{nullable:true}));
 if(!record(info)||!Array.isArray(info.list)||!Array.isArray(info.branches)||!info.branches.some(branch=>branch.key===key))throw error('RANOBE_IDENTITY');
 if(requireComplete&&!info.completeness?.verified)throw error('RANOBE_INCOMPLETE');
 const list=info.list.filter(chapter=>chapter.branches.some(branch=>branch.branchKey===key));
 if(!list.length||list.some(chapter=>chapter.branches.find(branch=>branch.branchKey===key).restricted))throw error('RANOBE_RESTRICTED');
 return {branchId:branchId===null?null:Number(identifier(branchId)),branchKey:key,language:null,chapters:list,inventorySha256:info.inventorySha256,completeness:info.completeness};
}
export function verifyRanobeChapter(data,{slug,chapter,branchId}){
 checkedSlug(slug);const selectedId=identifier(branchId,{nullable:true}),key=branchKey(selectedId);
 if(!record(data)||!record(chapter)||!Array.isArray(chapter.branches))throw error('RANOBE_IDENTITY');
 const release=chapter.branches.find(branch=>branch.branchKey===key||Object.hasOwn(branch,'branch_id')&&branchKey(identifier(branch.branch_id,{nullable:true}))===key);
 if(!release||identifier(data.manga_id)!==slug.split('--')[0]||!Object.hasOwn(data,'branch_id')||identifier(data.branch_id,{nullable:true})!==selectedId||identifier(data.id)!==identifier(release.releaseId??release.id)||canonicalRanobeNumber(data.volume)!==canonicalRanobeNumber(chapter.volume)||canonicalRanobeNumber(data.number)!==canonicalRanobeNumber(chapter.number))throw error('RANOBE_IDENTITY');
 if(chapter.number_secondary!==null&&chapter.number_secondary!==undefined&&data.number_secondary!==undefined&&canonicalRanobeNumber(chapter.number_secondary)!==canonicalRanobeNumber(data.number_secondary))throw error('RANOBE_IDENTITY');
 if(restricted(data)||release.restricted)throw error('RANOBE_RESTRICTED');
 if(data.type!==undefined&&data.type!=='chapter')throw error('RANOBE_CONTENT');const content=normalizeRanobeContent(data.content,{attachments:data.attachments,validateImage:value=>validateRanobeImageUrl(value,{slug,releaseId:release.releaseId??release.id})});
 const volume=canonicalRanobeNumber(data.volume),number=canonicalRanobeNumber(data.number);
 return {sourceChapterKey:`ranobelib:${slug.split('--')[0]}:${key}:v${volume}:c${number}`,releaseId:identifier(data.id),branchId:selectedId===null?null:Number(selectedId),volume,number,name:text(data.name),content,contentSha256:digest(Buffer.from(content)),language:null,identityVerified:true,revisionHints:{createdAt:timestamp(data.created_at),updatedAt:timestamp(data.updated_at),contentRevisionKnown:false,timestampIsContentRevision:false}};
}
export function validateRanobeImageUrl(value,{slug,releaseId}={}){
 if(typeof value!=='string'||value.length>2000||/[\p{Cc}\p{Cf}]/u.test(value))throw error('RANOBE_CONTENT');
 let url;try{url=new URL(value);}catch{throw error('RANOBE_CONTENT');}
 if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash)throw error('RANOBE_CONTENT');
 // Primary chapter 52 (release 1815571) demonstrated this one uploads layout.
 // Bind the path to this exact selected work/release, never a generic site URL.
 if(url.hostname==='ranobelib.me'){
  if(typeof slug!=='string'||!SLUG.test(slug)||releaseId===undefined||url.href!==value||value.includes('?')||value.includes('#')||url.pathname.includes('%'))throw error('RANOBE_CONTENT');
  let release;try{release=identifier(releaseId);}catch{throw error('RANOBE_CONTENT');}
  const prefix=[slug.slice(slug.indexOf('--')+2),slug.split('--')[0]].map(work=>`/uploads/ranobe/${work}/chapters/${release}/`).find(prefix=>url.pathname.startsWith(prefix));
  if(!prefix)throw error('RANOBE_CONTENT');const filename=url.pathname.slice(prefix.length);
  if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,179}\.(?:png|jpe?g|webp)$/iu.test(filename)||filename.includes('..'))throw error('RANOBE_CONTENT');
 }else if(!['cdnlibs.org','imglib.info'].some(host=>url.hostname===host||url.hostname.endsWith('.'+host)))throw error('RANOBE_CONTENT');
 return url.href;
}
function decodeAttribute(value){
 const decoded=value.replace(/&(?:amp|quot|apos|lt|gt|#\d{1,7}|#x[0-9a-f]{1,6});/giu,entity=>{
  const named={'&amp;':'&','&quot;':'"','&apos;':"'",'&lt;':'<','&gt;':'>'};if(named[entity.toLowerCase()])return named[entity.toLowerCase()];
  const hex=/^&#x/iu.test(entity),number=Number.parseInt(entity.slice(hex?3:2,-1),hex?16:10);
  if(number<1||number>0x10ffff||number>=0xd800&&number<=0xdfff)throw error('RANOBE_CONTENT');return String.fromCodePoint(number);
 });
 if(/&[a-z][a-z0-9]+;/iu.test(decoded))throw error('RANOBE_CONTENT');return decoded;
}
/** URL collection only, not HTML validation/sanitization. Exact HTML still
 * goes through the isolated parser; unsupported/missed markup must fail there.
 */
export function extractRanobeImageUrls(content,{maxImages=50,slug,releaseId}={}){
 if(typeof content!=='string'||Buffer.byteLength(content)>MAX_BYTES||!Number.isInteger(maxImages)||maxImages<1||maxImages>100)throw error('RANOBE_CONTENT');
 const result=[],seen=new Set();let tags=0;
 for(const match of content.matchAll(/<img\b[^>]*>/giu)){
  if(++tags>100||match[0].length>4000)throw error('RANOBE_CONTENT');
  const attrs=[...match[0].matchAll(/\s+src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/giu)];
  if(attrs.length!==1)throw error('RANOBE_CONTENT');
  const ref=decodeAttribute(attrs[0][1]??attrs[0][2]??attrs[0][3]),url=validateRanobeImageUrl(ref,{slug,releaseId});
  if(!seen.has(ref)){if(result.length>=maxImages)throw error('RANOBE_CONTENT');seen.add(ref);result.push({ref,url});}
 }
 return result;
}
function abortable(operation,signal){return new Promise((resolve,reject)=>{let done=false;const finish=(e,v)=>{if(done)return;done=true;signal.removeEventListener('abort',abort);e?reject(e):resolve(v);};const abort=()=>finish(signal.reason);if(signal.aborted){abort();return;}signal.addEventListener('abort',abort,{once:true});Promise.resolve().then(()=>{signal.throwIfAborted();return operation();}).then(value=>finish(null,value),e=>finish(e));});}
function suffixPath(suffix){
 if(typeof suffix!=='string'||suffix.length>1000||/[\p{Cc}\p{Cf}#\\]/u.test(suffix))throw error('RANOBE_INPUT');
 const parsed=new URL('https://adapter.invalid/'+suffix.replace(/^\//u,''));
 if(!['/','/chapters','/chapter'].includes(parsed.pathname))throw error('RANOBE_INPUT');
 const allowed=parsed.pathname==='/chapter'?['number','volume','branch_id']:parsed.pathname==='/chapters'?[]:['fields[]'];
 for(const [name,value] of parsed.searchParams){if(!allowed.includes(name)||parsed.searchParams.getAll(name).length>1&&name!=='fields[]')throw error('RANOBE_INPUT');if(name==='fields[]'&&!['authors','chap_count'].includes(value))throw error('RANOBE_INPUT');}
 if(parsed.pathname==='/chapter'){
  if(!parsed.searchParams.has('number')||!parsed.searchParams.has('volume'))throw error('RANOBE_INPUT');
  canonicalRanobeNumber(parsed.searchParams.get('number'));canonicalRanobeNumber(parsed.searchParams.get('volume'));if(parsed.searchParams.has('branch_id'))identifier(parsed.searchParams.get('branch_id'));
 }
 return (parsed.pathname==='/'?'':parsed.pathname)+(parsed.search?'?'+parsed.searchParams.toString():'');
}
export function createRanobeAdapter({fetchSafe=defaultFetch,clock=()=>performance.now(),sleep=(ms,signal)=>delay(ms,undefined,{signal})}={}){
 if(typeof fetchSafe!=='function'||typeof clock!=='function'||typeof sleep!=='function')throw error('RANOBE_INPUT');let queue=Promise.resolve(),nextAt=0;
 const request=async(path,{signal:parent,timeoutMs=15000}={})=>{
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>45000)throw error('RANOBE_INPUT');
  if(parent&&(typeof parent.aborted!=='boolean'||typeof parent.addEventListener!=='function'||typeof parent.removeEventListener!=='function'))throw error('RANOBE_INPUT');
  const controller=new AbortController(),signal=controller.signal,cancel=()=>controller.abort(error(parent?.reason?.code==='RANOBE_TIMEOUT'?'RANOBE_TIMEOUT':'RANOBE_ABORTED'));
  if(parent?.aborted)cancel();else parent?.addEventListener('abort',cancel,{once:true});
  const timer=setTimeout(()=>controller.abort(error('RANOBE_TIMEOUT')),timeoutMs),deadline=clock()+timeoutMs;
  try{
   const paced=queue.then(async()=>{signal.throwIfAborted();const wait=nextAt-clock();if(wait>0)await abortable(()=>sleep(wait,signal),signal);signal.throwIfAborted();nextAt=clock()+1500;});queue=paced.catch(()=>{});await abortable(()=>paced,signal);
   const maxBytes=path.split('?')[0].endsWith('/chapters')?8*1024*1024:MAX_BYTES;
   const url=BASE+path,response=await abortable(()=>fetchSafe(url,{maxBytes,signal,timeoutMs:Math.max(1,Math.floor(deadline-clock())),maxRedirects:0,headers:{'Site-Id':'3',Referer:'https://ranobelib.me/',Accept:'application/json','User-Agent':'Gargantua-Personal-Library/0.1'}}),signal);
   if(!record(response)||!Buffer.isBuffer(response.buffer)||response.buffer.length>maxBytes||response.url!==url||!/^application\/json(?:\s*;|\s*$)/iu.test(response.type??''))throw error('RANOBE_RESPONSE');
   let envelope;try{envelope=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(response.buffer));}catch{throw error('RANOBE_RESPONSE');}
   if(!record(envelope)||!Object.hasOwn(envelope,'data')||envelope.data===null||envelope.error||envelope.errors||envelope.success===false)throw error('RANOBE_RESPONSE');
   return {data:envelope.data,raw:response.buffer,envelope};
  }catch(failure){
   if(signal.aborted)throw signal.reason;
   throw sanitizeRanobeTransportError(failure);
  }
  finally{clearTimeout(timer);parent?.removeEventListener('abort',cancel);}
 };
 const ranobeJson=async(slug,suffix='',options={})=>{
  const checked=suffixPath(suffix),result=await request(`/api/manga/${checkedSlug(slug)}${checked}`,options);
  if(checked.startsWith('/chapter?')&&record(result.data)&&restricted(result.data))throw error('RANOBE_RESTRICTED');
  return result;
 };
 const searchRanobe=async(title,options={})=>{
  if(typeof title!=='string'||title.trim().length<2||title.trim().length>150||/[\p{Cc}\p{Cf}]/u.test(title))throw error('RANOBE_INPUT');
  const result=await request('/api/manga?'+new URLSearchParams({q:title.trim(),'site_id[]':'3'}),options);
  if(!Array.isArray(result.data)||result.data.length>100)throw error('RANOBE_RESPONSE');
  return result.data.slice(0,24).filter(x=>record(x)&&SLUG.test(x.slug_url??'')&&(x.site===undefined||x.site===3)).map(x=>({title:text(x.rus_name||x.name,250),original:text(x.name,250),url:`https://ranobelib.me/ru/book/${x.slug_url}`}));
 };
 const resolveRanobe=async(url,{signal,timeoutMs=45000}={})=>{
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>45000)throw error('RANOBE_INPUT');
  if(signal&&(typeof signal.aborted!=='boolean'||typeof signal.addEventListener!=='function'||typeof signal.removeEventListener!=='function'))throw error('RANOBE_INPUT');
  const slug=ranobeSlug(url),controller=new AbortController(),cancel=()=>controller.abort(error('RANOBE_ABORTED'));
  if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});const timer=setTimeout(()=>controller.abort(error('RANOBE_TIMEOUT')),timeoutMs);
  try{
   const meta=await ranobeJson(slug,'?fields[]=authors&fields[]=chap_count',{signal:controller.signal}),list=await ranobeJson(slug,'/chapters',{signal:controller.signal}),input={slug,meta:meta.data,list:list.data,envelope:list.envelope};
   const observed=normalizeRanobeInventoryObservation(input);
   if(!observed.completeness.counterMismatch)return observed;
   const freshMeta=await ranobeJson(slug,'?fields[]=authors&fields[]=chap_count',{signal:controller.signal}),freshList=await ranobeJson(slug,'/chapters',{signal:controller.signal});
   return normalizeRanobeInventory({...input,confirmation:{meta:freshMeta.data,list:freshList.data,envelope:freshList.envelope}});
  }
  finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
 };
 const fetchRanobeChapter=async(info,chapter,branchId,options={})=>{
  const params=new URLSearchParams({number:chapter.number,volume:chapter.volume});if(branchId!==null)params.set('branch_id',String(identifier(branchId)));
  const result=await ranobeJson(info.slug,'/chapter?'+params,options);
  return {data:verifyRanobeChapter(result.data,{slug:info.slug,chapter,branchId}),raw:result.raw};
 };
 return {searchRanobe,ranobeJson,resolveRanobe,fetchRanobeChapter};
}
const adapter=createRanobeAdapter();
export const searchRanobe=(...args)=>adapter.searchRanobe(...args);
export const ranobeJson=(...args)=>adapter.ranobeJson(...args);
export const resolveRanobe=(...args)=>adapter.resolveRanobe(...args);
export const fetchRanobeChapter=(...args)=>adapter.fetchRanobeChapter(...args);
