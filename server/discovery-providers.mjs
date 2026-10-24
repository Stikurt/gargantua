/** Bounded metadata discovery, not acquisition or a complete bibliography.
 * Primary contracts checked 2026-10-23:
 * https://openlibrary.org/dev/docs/api/search
 * https://openlibrary.org/dev/docs/api/authors
 * https://openlibrary.org/developers/api (1 request/s unidentified, no bulk crawl)
 * https://github.com/internetarchive/openlibrary/blob/master/openlibrary/plugins/worksearch/schemes/works.py
 * https://github.com/internetarchive/openlibrary/blob/master/openlibrary/plugins/worksearch/code.py (parallel series arrays)
 * https://gutendex.com/ and https://github.com/garethbjohnson/gutendex
 * Ranobe is the existing narrow api.cdnlibs adapter, not a guaranteed public API.
 * All returned text is untrusted plain text; clients must never render it as HTML.
 */
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {normalizeSearchQuery} from '../src/search-query.mjs';
// Lazy production transport keeps fixture-only discovery independent of server
// packages; it never falls back to global fetch or a less restrictive client.
const defaultFetchSafe=(...args)=>import('./fetch.mjs').then(module=>module.fetchSafe(...args));

const MAX_BYTES=2*1024*1024,MAX_CACHE_BYTES=4*1024*1024,CACHE_MS=5*60*1000;
const OPEN='https://openlibrary.org',GUT='https://gutendex.com',RANOBE='https://api.cdnlibs.org';
const FIELDS='key,title,author_name,author_key,language,first_publish_year,edition_count,series_key,series_name,series_position,id_project_gutenberg';
const AUTHOR_PREFIX=/^(?:все\s+(?:книги|произведения)\s+(?:(?:автора|писателя)\s+)?|(?:книги|произведения)\s+(?:автора|писателя)\s+|автор\s*:?\s+|all\s+(?:books|works)\s+(?:by|of)\s+|(?:books|works)\s+by\s+|author\s*:?\s+)/iu;
const SERIES_PREFIX=/^(?:(?:серия|цикл)(?:\s+книг)?\s*:?\s+|(?:book\s+)?series\s*:?\s+)/iu;
const plain=value=>typeof value==='string'?value.normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu,' ').replace(/\s+/gu,' ').trim():'';
const clean=(value,max=300)=>plain(value).slice(0,max);
const norm=value=>clean(value).toLowerCase().replace(/ё/gu,'е').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const person=value=>norm(value).split(' ').sort().join(' ');
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const boundedInt=(value,fallback,max,name)=>{value??=fallback;if(!Number.isSafeInteger(value)||value<1||value>max)throw new TypeError(`Недопустимый ${name}`);return value;};
const hash=value=>createHash('sha256').update(value).digest('hex').slice(0,32);
const candidateId=(provider,kind,remoteId)=>`dsc_${hash(JSON.stringify([provider,kind,remoteId]))}`;
const fail=code=>Object.assign(new Error(code),{code});
const phrase=value=>'"'+value.replace(/\\/gu,'\\\\').replace(/"/gu,'\\"')+'"';
const OL_ID=/^OL[1-9][0-9]{0,14}[WA]$/u;
function olid(value,kind){
 if(typeof value!=='string')return null;
 const prefix=kind==='A'?'/authors/':'/works/';
 const id=value.startsWith(prefix)?value.slice(prefix.length):value;
 return OL_ID.test(id)&&id.endsWith(kind)?id:null;
}
const LANGUAGE_MAP={rus:'ru',eng:'en',fre:'fr',fra:'fr',ger:'de',deu:'de',spa:'es',ita:'it',jpn:'ja',chi:'zh',zho:'zh',kor:'ko',por:'pt',ukr:'uk',kaz:'kk',pol:'pl'};
function languages(value){
 if(!Array.isArray(value))return [];
 return [...new Set(value.slice(0,64).map(item=>typeof item==='string'?item:record(item)&&typeof item.key==='string'?item.key.replace(/^\/languages\//u,''):'').map(item=>LANGUAGE_MAP[item]??item).filter(item=>/^[a-z]{2}$/u.test(item)))].sort().slice(0,16);
}
const authorAliases=new Set(['артур кларк','артура кларка','артура кларк','артур чарльз кларк','arthur c clarke','arthur clarke','arthur charles clarke']);
const warriorsAliases=new Set(['коты воители','котов воителей','коты войтели','котов войтели','warriors','warrior cats','warriors by erin hunter']);
const ramaAliases=new Set(['свидание с рамой','rendezvous with rama']);
// Copied from the repository's reviewed warriors-first-arc-order.json. Exactly
// six novels in the first arc; no claim about every book/adaptation/translation.
const FIRST_ARC=['Into the Wild','Fire and Ice','Forest of Secrets','Rising Storm','A Dangerous Path','The Darkest Hour'];
const CURATED_EVIDENCE='https://warriorcats.com/content/article/the-structure-of-warrior-cats-how-to-read-the-books';
const GUT_STOPWORDS=new Set('a an the of on in into with and or by for to from at all book books work works author series volume и в во на из для о об по от с со у к ко без не все книги книга произведения автора автор серия цикл'.split(' '));

/** Gutendex currently ANDs the first four space-separated icontains terms
 * (official books/views.py). Keep at most three useful literal words; this is
 * only a search formulation, never a replacement for exact identity checks. */
export function gutenbergSearchTerms(value){
 const tokens=plain(value).replace(/['’]s\b/giu,'').match(/[\p{L}\p{N}]+/gu)??[];
 const distinct=tokens.filter((token,index)=>tokens.findIndex(other=>other.toLocaleLowerCase('en')===token.toLocaleLowerCase('en'))===index);
 const useful=distinct.filter(token=>!GUT_STOPWORDS.has(token.toLocaleLowerCase('en'))&&!/^\p{L}$/u.test(token));
 return (useful.length?useful:distinct).slice(0,3).join(' ');
}

const stripQuotes=value=>value.replace(/^[«“"]|[»”"]$/gu,'').trim();
const canonicalAuthor=value=>authorAliases.has(norm(value))?'Arthur C. Clarke':clean(value,200);
function curatedBook(remoteId){
 const match=/^warriors:tpc:([1-6])$/u.exec(remoteId);if(!match)return null;
 const index=Number(match[1])-1,title=FIRST_ARC[index],item=base('curated',remoteId,'book',title,[{name:'Erin Hunter',remoteId:null}],{provider:'curated',remoteId,type:'series-seed',url:CURATED_EVIDENCE,access:'metadata-only',fileVerified:false});
 item.order=index+1;item.orderEvidence='official-first-arc-only';return item;
}

/** Capability check for a stored candidate. This is not authorization, proof of
 * a downloadable file, or permission to trust a client-supplied object. */
export function canExpandDiscoveryCandidate(candidate){
 if(!record(candidate)||!record(candidate.identity)||!['author','book'].includes(candidate.kind)||candidate.conflictingMetadata||candidate.identityEvidenceIncomplete||candidate.sourceResolutionAttempted)return false;
 const {provider,remoteId}=candidate.identity;if(typeof remoteId!=='string'||candidate.id!==candidateId(provider,candidate.kind,remoteId))return false;
 return provider==='openlibrary'&&remoteId===olid(remoteId,candidate.kind==='author'?'A':'W')||provider==='curated'&&candidate.kind==='book'&&/^warriors:tpc:[1-6]$/u.test(remoteId);
}

function validContinuation(value){
 if(!record(value)||value.provider!=='openlibrary'||!Number.isSafeInteger(value.offset)||value.offset<1||value.offset>10000)return false;
 const keys=Object.keys(value).sort().join(',');
 return value.kind==='author-works'&&keys==='kind,offset,provider,remoteId'&&typeof value.remoteId==='string'&&value.remoteId===olid(value.remoteId,'A')||value.kind==='series-search'&&keys==='kind,offset,provider,term'&&typeof value.term==='string'&&value.term.length>=2&&value.term.length<=300&&clean(value.term)===value.term;
}

/** Only inspect a plan loaded from the database. A continuation is an explicit
 * user request for one bounded next page, never a background bulk crawl. */
export function canContinueDiscoveryPlan(plan){
 if(record(plan)&&record(plan.plan))plan=plan.plan;
 if(!record(plan)||!validContinuation(plan.continuation))return false;
 const next=plan.continuation;
 return plan.kind==='author'&&next.kind==='author-works'&&plan.authorCandidateId===candidateId('openlibrary','author',next.remoteId)||plan.kind==='series'&&next.kind==='series-search'&&norm(plan.title)===norm(next.term);
}

export function interpretDiscoveryQuery(value,{intent='auto'}={}){
 const query=normalizeSearchQuery(value);
 if(!['auto','book','author','series'].includes(intent))throw new TypeError('Неизвестный тип запроса');
 const authorMatch=AUTHOR_PREFIX.test(query),seriesMatch=SERIES_PREFIX.test(query);
 const actual=intent==='auto'?(authorMatch||authorAliases.has(norm(query))?'author':seriesMatch||warriorsAliases.has(norm(query))?'series':'book'):intent;
 let term=query.replace(actual==='author'?AUTHOR_PREFIX:actual==='series'?SERIES_PREFIX:/^$/u,'').trim();
 let specifiedAuthor=null;
 if(actual==='book'||actual==='series'){
  const match=/^(.+?)\s+(?:автора|автор\s*:|author\s*:)\s+(.+)$/iu.exec(term)??/^[«“"](.+)[»”"]\s+by\s+(.+)$/iu.exec(term);
  if(match){if(plain(match[2]).length>200)throw new TypeError('Имя автора: не более 200 символов');term=stripQuotes(match[1]);specifiedAuthor=canonicalAuthor(match[2]);if(specifiedAuthor.length<2)throw new TypeError('Уточните имя автора');}
 }
 term=stripQuotes(term);
 if(term.length<2)throw new TypeError('Уточните название или имя автора');
 const normalized=norm(term),clarke=actual==='author'&&authorAliases.has(normalized),warriors=actual==='series'&&warriorsAliases.has(normalized),rama=actual==='book'&&ramaAliases.has(normalized);
 return {query,intent:actual,term,searchTerm:clarke?'Arthur C. Clarke':warriors?'Warriors':rama?'Rendezvous with Rama':term,
  titleAliases:rama?['Свидание с Рамой','Rendezvous with Rama']:[term],
  authorHint:specifiedAuthor?{name:specifiedAuthor,...(specifiedAuthor==='Arthur C. Clarke'?{openLibraryId:'OL2623461A',knownWork:'Rendezvous with Rama'}:{})}:clarke||rama?{name:'Arthur C. Clarke',openLibraryId:'OL2623461A',knownWork:'Rendezvous with Rama'}:null,
  curatedSeries:warriors?'warriors-the-prophecies-begin':null};
}

function indexedSeries(item){
 const keys=item.series_key,names=item.series_name,positions=item.series_position;
 if(!Array.isArray(keys)||!Array.isArray(names)||!Array.isArray(positions)||keys.length!==names.length||keys.length!==positions.length||keys.length>16)return [];
 const result=[];
 for(let index=0;index<keys.length;index++){
  const key=keys[index],name=clean(names[index]);
  // Open Library's current series registry uses /series/OL<n>L, not OL<n>S.
  if(typeof key!=='string'||!/^(?:\/series\/)?OL[1-9][0-9]{0,14}L$/u.test(key)||!name||typeof names[index]!=='string'||plain(names[index]).length>300)continue;
  const id=key.replace(/^\/?(?:series\/)?/u,''),position=typeof positions[index]==='string'?clean(positions[index],40):null;
  const sequence=position!==null&&/^(?:0|[1-9][0-9]{0,5})(?:\.[0-9]{1,6})?$/u.test(position)?Number(position):null;
  const old=result.find(edge=>edge.remoteId===id);
  if(old){if(norm(old.name)!==norm(name)||old.position!==position)return [];continue;}
  result.push({provider:'openlibrary',remoteId:id,name,position,sequence,evidence:'openlibrary-indexed-series-edge',url:`${OPEN}/series/${id}`});
 }
 return result;
}

function languageGate(candidate,language,allowOriginal){
 const target=candidate.languages.includes(language),known=candidate.languages.length>0;
 candidate.languageSelection={target,known,allowOriginal,requiresTranslation:!target&&known&&allowOriginal};
 candidate.eligibleForAcquisition=target||(known&&allowOriginal);
 if(!candidate.eligibleForAcquisition)candidate.blockedReason=known?'ORIGINAL_NOT_ALLOWED':'SOURCE_LANGUAGE_UNKNOWN';
 return candidate;
}
function base(provider,remoteId,kind,title,authors,sourceBinding){
 return {id:candidateId(provider,kind,remoteId),identity:{provider,remoteId},kind,title,authors,languages:[],
  metadataOnly:true,availability:'metadata-only',downloadSelections:[],sourceBinding};
}
function olBook(item,{author=null}={}){
 if(!record(item))return null;
 const remoteId=olid(item.key,'W'),title=clean(item.title);
 if(!remoteId||!title)return null;
 const names=Array.isArray(item.author_name)?item.author_name.slice(0,16):[];
 const keys=Array.isArray(item.author_key)?item.author_key.slice(0,16).map(x=>olid(x,'A')).filter(Boolean):[];
 const workAuthorKeys=Array.isArray(item.authors)?item.authors.slice(0,16).map(x=>olid(x?.author?.key,'A')).filter(Boolean):[];
 // Parallel search arrays do not establish an index-by-index name/ID link.
 let authors=names.map(name=>({name:clean(name,200),remoteId:null})).filter(a=>a.name);
 if(author&&workAuthorKeys.length&&!workAuthorKeys.includes(author.identity.remoteId))return null;
 if(!authors.length&&author)authors=[{name:author.title,remoteId:author.identity.remoteId}];
 const result=base('openlibrary',remoteId,'book',title,authors,{provider:'openlibrary',remoteId,type:'work',url:`${OPEN}/works/${remoteId}`,access:'metadata-only',fileVerified:false});
 result.languages=languages(item.language??item.languages);
 result.identityEvidenceIncomplete=typeof item.title!=='string'||plain(item.title).length>300||names.some(name=>typeof name!=='string'||plain(name).length>200)||Array.isArray(item.author_name)&&item.author_name.length>16||Array.isArray(item.author_key)&&item.author_key.length>16||Array.isArray(item.authors)&&item.authors.length>16;
 result.languageEvidence='work-editions-not-selected-file';
 result.authorsComplete=names.length>0;
 result.authorRemoteIds=[...new Set([...keys,...workAuthorKeys,...(author?[author.identity.remoteId]:[])])];
 result.seriesMemberships=indexedSeries(item);
 result.externalIdentifiers=Array.isArray(item.id_project_gutenberg)?[...new Set(item.id_project_gutenberg.filter(value=>typeof value==='string'&&/^[1-9][0-9]{0,9}$/u.test(value)))].slice(0,16).map(remoteId=>({provider:'gutenberg',remoteId,evidence:'openlibrary-provider-identifier'})):[];
 if(Number.isSafeInteger(item.first_publish_year)&&item.first_publish_year>0&&item.first_publish_year<10000)result.firstPublicationYear=item.first_publish_year;
 return result;
}
function olAuthor(item){
 if(!record(item))return null;
 const remoteId=olid(item.key,'A'),title=clean(item.name,200);if(!remoteId||!title)return null;
 const result=base('openlibrary',remoteId,'author',title,[],{provider:'openlibrary',remoteId,type:'author',url:`${OPEN}/authors/${remoteId}`});
 result.identityEvidenceIncomplete=typeof item.name!=='string'||plain(item.name).length>200;
 result.aliases=Array.isArray(item.alternate_names)?item.alternate_names.slice(0,12).filter(value=>typeof value==='string'&&plain(value).length<=200).map(x=>clean(x,200)).filter(Boolean):[];
 result.topWork=clean(item.top_work);result.birthDate=clean(item.birth_date,60);
 if(Number.isSafeInteger(item.work_count)&&item.work_count>=0)result.reportedWorkCount=item.work_count;
 return result;
}

// Only fixed official mirror paths are acquisition attempts. The exact TXT
// website route has a deterministic cache mapping, checked for ebook 11 on
// 2026-10-22. This is not a file-presence guarantee: 404 is a normal safe failure.
// Other /ebooks routes and /files hierarchy are not guessed or crawled.
// https://www.gutenberg.org/MIRRORS.ALL + /help/mirroring.html, 2026-10-22.
export function gutenbergDownloadSelection(value,mime,id){
 if(typeof value!=='string'||value.length>2000||/[\p{Cc}\p{Cf}\\%]/u.test(value)||typeof mime!=='string'||!/^\d{1,10}$/u.test(id))return null;
 let url;try{url=new URL(value);}catch{return null;}
 if(!/^https:\/\/(?:www\.)?gutenberg\.org\//iu.test(value)||url.protocol!=='https:'||!['www.gutenberg.org','gutenberg.org'].includes(url.hostname)||url.username||url.password||url.port||url.hash||url.search)return null;
 const epub=mime==='application/epub+zip',txt=/^text\/plain(?:;\s*charset=(?:utf-8|us-ascii))?$/iu.test(mime);
 if(!epub&&!txt)return null;
 const escaped=id.replace(/^0+(?=\d)/u,'');let path=url.pathname,pathVerification='canonical-metadata-path-not-presence';
 if(escaped!==id)return null;
 if(txt&&path===`/ebooks/${id}.txt.utf-8`){path=`/cache/epub/${id}/pg${id}.txt`;pathVerification='deterministic-attempt-not-presence';}
 const cache=new RegExp(`^/cache/epub/${id}/pg${id}${epub?'(?:-(?:images|noimages)(?:-3)?)?\\.epub':'(?:-0)?\\.txt'}$`,'u');
 if(!cache.test(path))return null;
 return {url:`https://gutenberg.pglaf.org${path}`,originalUrl:url.href,extension:epub?'epub':'txt',mimeType:mime,
  maxRedirects:0,pathVerification,mappingPolicy:txt?'gutenberg-generated-txt-cache-v1':'gutenberg-canonical-cache-path-v1',mirrorEvidence:'https://www.gutenberg.org/MIRRORS.ALL',mirrorPolicy:'https://www.gutenberg.org/help/mirroring.html'};
}
function gutBook(item,{language,allowOriginal}){
 if(!record(item)||!Number.isSafeInteger(item.id)||item.id<1||item.id>9999999999)return null;
 const title=clean(item.title);if(!title)return null;
 const remoteId=String(item.id),authors=Array.isArray(item.authors)?item.authors.slice(0,16).filter(record).map(x=>({name:clean(x.name,200),remoteId:null})).filter(x=>x.name):[];
 const result=base('gutendex',remoteId,'book',title,authors,{provider:'gutenberg',remoteId,type:'ebook',url:`https://www.gutenberg.org/ebooks/${remoteId}`,copyright:item.copyright===false?false:item.copyright===true?true:null,rightsTerritory:'US'});
 result.identityEvidenceIncomplete=typeof item.title!=='string'||plain(item.title).length>300||Array.isArray(item.authors)&&(item.authors.length>16||item.authors.some(author=>!record(author)||typeof author.name!=='string'||plain(author.name).length>200));
 result.languages=languages(item.languages);result.languageEvidence='gutenberg-ebook';languageGate(result,language,allowOriginal);
 if(item.copyright!==false||item.media_type!=='Text'||!record(item.formats)||!result.eligibleForAcquisition)return result;
 const selections=[];
 for(const [mime,url] of Object.entries(item.formats).slice(0,32)){
  const selected=gutenbergDownloadSelection(url,mime,remoteId);if(!selected)continue;
  selections.push({...selected,id:`dl_${hash(`${remoteId}|${selected.url}`)}`,requiresQuarantine:true,
   expected:{provider:'gutenberg',remoteId,title,authors:authors.map(a=>a.name),language:result.languages.length===1?result.languages[0]:null,languages:[...result.languages]},
   rights:{basis:'gutendex-copyright-false',territory:'US',contentVerificationRequired:true},
   sourcePolicy:'https://www.gutenberg.org/policy/robot_access.html'});
 }
 selections.sort((a,b)=>(a.extension==='epub'?0:1)-(b.extension==='epub'?0:1)||a.url.localeCompare(b.url));
 result.downloadSelections=selections.filter((item,index,all)=>all.findIndex(x=>x.extension===item.extension)===index).slice(0,2);
 if(result.downloadSelections.length)result.availability='fetchable';
 else result.blockedReason='MIRROR_PATH_UNVERIFIED';
 return result;
}
function ranobeBook(item){
 if(!record(item)||typeof item.slug_url!=='string'||!/^[1-9][0-9]{0,9}--[a-zA-Z0-9_-]{1,150}$/u.test(item.slug_url))return null;
 const title=clean(item.rus_name||item.name),original=clean(item.name);if(!title)return null;
 const remoteId=item.slug_url.split('--')[0];
 const result=base('ranobelib',remoteId,'book',title,[],{provider:'ranobelib',remoteId,type:'card',slug:item.slug_url,url:`https://ranobelib.me/ru/book/${item.slug_url}`,requiresBranchSelection:true,requiresPreview:true,completeness:'unknown',previewIsCompleteBook:false});
 result.originalTitle=original;result.availability='needs-preview';
 result.identityEvidenceIncomplete=plain(item.rus_name||item.name).length>300||plain(item.name).length>300;
 // Site/interface language does not prove the language of any selected branch.
 result.languageEvidence='unresolved-branch';return result;
}

function abortable(operation,signal){
 return new Promise((resolve,reject)=>{
  let done=false;
  const finish=(error,value)=>{if(done)return;done=true;signal.removeEventListener('abort',abort);error?reject(error):resolve(value);};
  const abort=()=>finish(signal.reason??fail('ABORTED'));
  if(signal.aborted){abort();return;}signal.addEventListener('abort',abort,{once:true});
  Promise.resolve().then(()=>{signal.throwIfAborted();return operation();}).then(value=>finish(null,value),error=>finish(error));
 });
}
const ERRORS={ABORTED:'Поиск отменён',DEADLINE:'Истекло время поиска',REQUEST_BUDGET:'Достигнут предел запросов',RESPONSE_FORMAT:'Источник вернул неподдерживаемый ответ',RESPONSE_LIMIT:'Ответ источника превышает лимит',SOURCE_UNAVAILABLE:'Источник недоступен',SOURCE_ACCESS_DENIED:'Источник ограничил доступ; требуется проверка владельцем',MALFORMED_ITEM:'Часть записей источника пропущена',CONFLICTING_METADATA:'Источник вернул противоречивые записи одного идентификатора'};
function retryableFailure(error){
 return error?.code==='FETCH_HTTP'&&[408,425,429,500,502,503,504].includes(error.httpStatus)||['FETCH_DNS','FETCH_IDLE_TIMEOUT','FETCH_DEADLINE','FETCH_TRUNCATED','ECONNRESET','ETIMEDOUT','EAI_AGAIN'].includes(error?.code)||error?.code==='SOURCE_UNAVAILABLE'&&error.transient===true;
}
function safeError(error,signal){
 if(signal.aborted)return signal.reason?.code==='DEADLINE'?'DEADLINE':'ABORTED';
 if(error?.code==='FETCH_HTTP'&&[401,403,410,451].includes(error.httpStatus))return 'SOURCE_ACCESS_DENIED';
 if(Object.hasOwn(ERRORS,error?.code))return error.code;
 if(error?.code==='FETCH_TOO_LARGE')return 'RESPONSE_LIMIT';
 return 'SOURCE_UNAVAILABLE';
}

/** Factory DI is for owner-controlled fixture transports/clocks only. No job
 * accepts a custom origin, token, endpoint, request header or fetch function. */
export function createDiscoverySearch({fetchSafe=defaultFetchSafe,clock=()=>performance.now(),sleep=(ms,signal)=>delay(ms,undefined,{signal})}={}){
 if(typeof fetchSafe!=='function'||typeof clock!=='function'||typeof sleep!=='function')throw new TypeError('Неверный transport DI');
 const cache=new Map();let cacheBytes=0,openQueue=Promise.resolve(),nextOpenAt=0;
 const pace=signal=>{
  const scheduled=openQueue.then(async()=>{signal.throwIfAborted();const wait=nextOpenAt-clock();if(wait>0)await abortable(()=>sleep(wait,signal),signal);signal.throwIfAborted();nextOpenAt=clock()+1050;});
  openQueue=scheduled.catch(()=>{});return abortable(()=>scheduled,signal);
 };
 return async function discover(query,options={}){
  if(!record(options))throw new TypeError('Нужны параметры поиска');
  const interpreted=interpretDiscoveryQuery(query,options),language=options.language??'ru',allowOriginal=options.allowOriginal??false;
  // Internal worker-only selector, reconstructed from a persisted candidate.
  // Its identifiers select fixed API paths; no name, URL or headers are trusted.
  const continuation=options.continuation??null;
  if(continuation!==null&&!validContinuation(continuation))throw new TypeError('Неверное продолжение поиска');
  let trusted=options.trustedFilter??null;
  if(continuation?.kind==='author-works'){
   if(trusted!==null&&(trusted.provider!=='openlibrary'||trusted.kind!=='author'||trusted.remoteId!==continuation.remoteId))throw new TypeError('Продолжение не соответствует автору');
   trusted={provider:'openlibrary',kind:'author',remoteId:continuation.remoteId};
  }else if(continuation&& (trusted!==null||interpreted.intent!=='series'||norm(interpreted.term)!==norm(continuation.term)))throw new TypeError('Продолжение не соответствует серии');
  if(trusted!==null){
   if(!record(trusted)||Object.keys(trusted).sort().join(',')!=='kind,provider,remoteId'||typeof trusted.remoteId!=='string'||!['author','book'].includes(trusted.kind)||!['openlibrary','gutendex','curated'].includes(trusted.provider)||trusted.kind==='author'&&trusted.provider!=='openlibrary'||(trusted.provider==='openlibrary'?trusted.remoteId!==olid(trusted.remoteId,trusted.kind==='author'?'A':'W'):trusted.provider==='curated'?!/^warriors:tpc:[1-6]$/u.test(trusted.remoteId):!/^[1-9][0-9]{0,9}$/u.test(trusted.remoteId)))throw new TypeError('Некорректный внутренний фильтр источника');
   interpreted.intent=trusted.kind;
  }
  if(typeof language!=='string'||!/^[a-z]{2}$/u.test(language)||typeof allowOriginal!=='boolean')throw new TypeError('Неверный язык поиска');
  if(options.expandSelectedSources!==undefined&&typeof options.expandSelectedSources!=='boolean')throw new TypeError('Неверный режим уточнения источника');
  const gutenbergHint=options.trustedGutenbergHint??null;
  if(gutenbergHint!==null&&(!record(gutenbergHint)||Object.keys(gutenbergHint).sort().join(',')!=='provider,remoteId'||gutenbergHint.provider!=='gutenberg'||typeof gutenbergHint.remoteId!=='string'||!/^[1-9][0-9]{0,9}$/u.test(gutenbergHint.remoteId)||trusted?.provider!=='openlibrary'||trusted?.kind!=='book'||options.expandSelectedSources!==true))throw new TypeError('Неверная внутренняя подсказка источника');
  const maxCandidates=boundedInt(options.maxCandidates,20,20,'maxCandidates'),maxRequests=boundedInt(options.maxRequests,4,4,'maxRequests'),timeoutMs=boundedInt(options.timeoutMs,45000,45000,'timeoutMs');
  const selected=options.selectedCandidateId??null;
  if(selected!==null&&(typeof selected!=='string'||!/^dsc_[a-f0-9]{32}$/u.test(selected)))throw new TypeError('Некорректный выбранный кандидат');
  if(trusted&&selected&&selected!==candidateId(trusted.provider,trusted.kind,trusted.remoteId))throw new TypeError('Выбор не соответствует внутреннему фильтру');
  const parent=options.signal;if(parent&&(typeof parent.aborted!=='boolean'||typeof parent.addEventListener!=='function'||typeof parent.removeEventListener!=='function'))throw new TypeError('Нужен AbortSignal');
  const controller=new AbortController(),signal=controller.signal,deadline=clock()+timeoutMs;
  const cancel=()=>controller.abort(fail('ABORTED'));if(parent?.aborted)cancel();else parent?.addEventListener('abort',cancel,{once:true});
  const timer=setTimeout(()=>controller.abort(fail('DEADLINE')),timeoutMs);
  const result={query:interpreted.query,intent:interpreted.intent,language,allowOriginal,metadataOnly:true,candidates:[],clarifications:[],providerErrors:[],hasMore:false,requestCount:0,retryCount:0,cacheHits:0,status:'not_found',selectedCandidateId:null,nextAction:'none',plan:null};
  const identities=new Map(),signatures=new Map(),skippedItemCounts=new Map();
  const addError=(provider,code,{retryable=false}={})=>{const old=result.providerErrors.find(e=>e.provider===provider&&e.code===code);if(old){old.retryable=old.retryable||retryable;}else result.providerErrors.push({provider,code,retryable,message:ERRORS[code]??ERRORS.SOURCE_UNAVAILABLE});};
  const add=candidate=>{
   if(!candidate)return false;
   const signature=JSON.stringify([candidate.title,candidate.authors,candidate.authorRemoteIds,candidate.languages,candidate.sourceBinding,candidate.downloadSelections,candidate.availability,candidate.seriesMemberships,candidate.externalIdentifiers,candidate.identityEvidenceIncomplete]);
   const old=identities.get(candidate.id);
   if(old){if(signatures.get(candidate.id)!==signature){old.conflictingMetadata=true;old.downloadSelections=[];old.availability='metadata-only';old.eligibleForAcquisition=false;old.blockedReason='CONFLICTING_METADATA';addError(candidate.identity.provider,'CONFLICTING_METADATA');}return true;}
   if(result.candidates.length>=maxCandidates){result.hasMore=true;return false;}
   languageGate(candidate,language,allowOriginal);identities.set(candidate.id,candidate);signatures.set(candidate.id,signature);result.candidates.push(candidate);return true;
  };
  const request=async(provider,path,params={})=>{
   signal.throwIfAborted();
   const origin=provider==='openlibrary'?OPEN:provider==='gutendex'?GUT:RANOBE;
   const url=new URL(path,origin);url.search=new URLSearchParams(params).toString();
   const key=url.href,hit=cache.get(key);
   if(hit&&hit.expires>clock()){result.cacheHits++;return JSON.parse(hit.raw.toString('utf8'));}
   if(hit){cache.delete(key);cacheBytes-=hit.raw.length;}
   const headers={accept:'application/json','user-agent':'Gargantua-Discovery/0.1 (personal metadata lookup)',...(provider==='ranobelib'?{'Site-Id':'3',Referer:'https://ranobelib.me/'}:{})};
   let response;
   for(let attempt=0;;attempt++){
    if(provider==='openlibrary')await pace(signal);
    if(clock()>=deadline)controller.abort(fail('DEADLINE'));
    signal.throwIfAborted();if(result.requestCount>=maxRequests)throw fail('REQUEST_BUDGET');result.requestCount++;
    const remainingMs=deadline-clock(),attemptController=new AbortController(),cancelAttempt=()=>attemptController.abort(signal.reason),timeoutMs=Math.min(12000,Math.max(1,Math.ceil(remainingMs)));
    signal.addEventListener('abort',cancelAttempt,{once:true});if(signal.aborted)cancelAttempt();
    // Near the global deadline a second, rounded-down timer can fire first,
    // classify the timeout as one source's failure and start another source
    // with a fraction of a millisecond left. Let the global timer own that
    // boundary; an independent source timer is needed only for its shorter cap.
    const attemptTimer=remainingMs>12000?setTimeout(()=>attemptController.abort(fail('FETCH_DEADLINE')),12000):null;
    try{response=await abortable(()=>fetchSafe(url.href,{maxBytes:MAX_BYTES,signal:attemptController.signal,timeoutMs,maxRedirects:0,headers}),attemptController.signal);break;}
    catch(error){
     const transient=retryableFailure(error);
     if(attempt>=1||!transient||result.requestCount>=maxRequests||deadline-clock()<=2000||signal.aborted)throw error;
     result.retryCount++;await abortable(()=>sleep(1500,signal),signal);
    }finally{if(attemptTimer!==null)clearTimeout(attemptTimer);signal.removeEventListener('abort',cancelAttempt);}
   }
   if(!record(response)||!Buffer.isBuffer(response.buffer)||response.buffer.length>MAX_BYTES)throw fail('RESPONSE_LIMIT');
   if(!/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|\s*$)/iu.test(response.type??'')||response.url!==url.href)throw fail('RESPONSE_FORMAT');
   let json;try{json=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(response.buffer));}catch{throw fail('RESPONSE_FORMAT');}
   if(!record(json))throw fail('RESPONSE_FORMAT');
   while(cache.size>=16||cacheBytes+response.buffer.length>MAX_CACHE_BYTES){const first=cache.keys().next().value;if(first===undefined)break;cacheBytes-=cache.get(first).raw.length;cache.delete(first);}
   const raw=Buffer.from(response.buffer);cache.set(key,{raw,expires:clock()+CACHE_MS});cacheBytes+=raw.length;return json;
  };
  const run=async(provider,operation)=>{try{await operation();}catch(error){const code=safeError(error,signal);addError(provider,code,{retryable:code==='DEADLINE'||code!=='ABORTED'&&retryableFailure(error)});}};
  const rows=(data,key,max,provider)=>{if(!Array.isArray(data[key])||data[key].length>max)throw fail('RESPONSE_FORMAT');return data[key];};
  const ingest=(items,map,provider)=>{let malformed=0,accepted=0;const quota=interpreted.intent==='author'?maxCandidates:Math.min(maxCandidates,7);for(const item of items){const candidate=map(item);if(!candidate){malformed++;continue;}if(accepted>=quota&&!identities.has(candidate.id)){result.hasMore=true;continue;}if(!identities.has(candidate.id))accepted++;add(candidate);}if(malformed){skippedItemCounts.set(provider,(skippedItemCounts.get(provider)??0)+malformed);addError(provider,'MALFORMED_ITEM');}};
  const more=(data,count,loaded,offset=0)=>{const total=data[count];if(!Number.isSafeInteger(total)||total<offset+loaded||total<0)throw fail('RESPONSE_FORMAT');if(total>offset+loaded)result.hasMore=true;};
  const openBooks=async()=>{
   const data=await request('openlibrary','/search.json',{q:`title:${phrase(interpreted.searchTerm)}`,...(interpreted.authorHint?{author:interpreted.authorHint.name}:{}),fields:FIELDS,limit:String(Math.min(maxCandidates,7)),lang:language});
   const items=rows(data,'docs',100,'openlibrary');more(data,Object.hasOwn(data,'numFound')?'numFound':'num_found',items.length);ingest(items,item=>olBook(item),'openlibrary');
  };
  const gutBooks=async(author=null,{title=null}={})=>{
   const search=gutenbergSearchTerms(title?`${title} ${author?.title??''}`.trim():author?author.title:interpreted.searchTerm);
   if(!search)return;
   const data=await request('gutendex','/books/',{search,copyright:'false',...(!allowOriginal?{languages:language}:{})});
   const items=rows(data,'results',32,'gutendex');more(data,'count',items.length);
   if(data.next!==null&&(typeof data.next!=='string'||!data.next.length||data.next.length>2000))throw fail('RESPONSE_FORMAT');
   const names=author?new Set([author.title,...author.aliases].map(person)):null;
   const filtered=names?items.filter(item=>record(item)&&Array.isArray(item.authors)&&item.authors.some(a=>record(a)&&names.has(person(a.name)))):items;
   ingest(filtered,item=>gutBook(item,{language,allowOriginal}),'gutendex');if(data.next!==null)result.hasMore=true;
  };
  const ranobeBooks=async()=>{
   if(interpreted.term.length>150){addError('ranobelib','RESPONSE_LIMIT');return;}
   const data=await request('ranobelib','/api/manga',{q:interpreted.term,'site_id[]':'3'}),items=rows(data,'data',100,'ranobelib');
   ingest(items,ranobeBook,'ranobelib');if(items.length>=24||record(data.meta)&&Number.isSafeInteger(data.meta.last_page)&&data.meta.last_page>1)result.hasMore=true;
  };
  const matchesAuthor=(candidate,hint)=>!hint||!!(hint.openLibraryId&&candidate.authorRemoteIds?.includes(hint.openLibraryId))||candidate.authors.some(a=>hint.openLibraryId&&a.remoteId===hint.openLibraryId||person(a.name)===person(hint.name));
  const matchesTitle=(candidate,aliases)=>[candidate.title,candidate.originalTitle].filter(Boolean).some(title=>aliases.some(alias=>norm(alias)===norm(title)));
  const resolveExpanded=()=>{
   const exact=result.candidates.filter(c=>!c.sourceResolutionAttempted&&!c.conflictingMetadata&&!c.identityEvidenceIncomplete&&matchesTitle(c,interpreted.titleAliases)&&matchesAuthor(c,interpreted.authorHint));
   const possible=exact.filter(c=>c.availability==='fetchable'||c.availability==='needs-preview');
   const picked=possible.length===1&&!result.hasMore&&!result.providerErrors.length?possible[0]:null;
   if(picked){result.status='resolved';result.selectedCandidateId=picked.id;result.nextAction=picked.availability==='fetchable'?'acquire':'needs_preview';picked.resolutionEvidence={kind:'selected-work-title-and-author',sourceIdentity:result.sourceResolutionFor};}
   else{result.status='needs_clarification';result.nextAction='needs_source';result.clarifications.push({code:possible.length?'CHOOSE_BOOK':'SOURCE_NOT_FOUND',message:possible.length?'Выберите источник и издание выбранного произведения.':'Подходящий файл выбранного произведения не подтверждён. Можно уточнить запрос, выбрать другой источник или импортировать свой файл.',candidateIds:result.candidates.filter(c=>!c.sourceResolutionAttempted).map(c=>c.id)});}
  };
  try{
   if(trusted?.provider==='curated'){
    const candidate=curatedBook(trusted.remoteId);if(!candidate)throw new TypeError('Неверная проверенная серия');
    interpreted.term=candidate.title;interpreted.searchTerm=candidate.title;interpreted.titleAliases=[candidate.title];interpreted.authorHint={name:'Erin Hunter'};
    result.sourceResolutionFor={...candidate.identity};
    await run('openlibrary',openBooks);await run('gutendex',()=>gutBooks({title:'Erin Hunter',aliases:[]},{title:candidate.title}));await run('ranobelib',ranobeBooks);resolveExpanded();
   }else if(trusted?.kind==='book'){
    await run(trusted.provider,async()=>{
     const item=await request(trusted.provider,trusted.provider==='openlibrary'?`/works/${trusted.remoteId}.json`:`/books/${trusted.remoteId}/`);
     const candidate=trusted.provider==='openlibrary'?olBook(item):gutBook(item,{language,allowOriginal});
     if(!candidate||candidate.identity.remoteId!==trusted.remoteId)throw fail('RESPONSE_FORMAT');add(candidate);
    });
    const candidate=result.candidates[0];
    if(candidate&&trusted.provider==='openlibrary'&&options.expandSelectedSources){
     candidate.sourceResolutionAttempted=true;result.sourceResolutionFor={...candidate.identity};
     interpreted.term=candidate.title;interpreted.searchTerm=candidate.title;interpreted.titleAliases=[candidate.title];
     let selectedAuthor=null;
     if(!candidate.identityEvidenceIncomplete&&candidate.authorRemoteIds.length===1)await run('openlibrary',async()=>{
      const id=candidate.authorRemoteIds[0],data=await request('openlibrary',`/authors/${id}.json`),author=olAuthor(data);
      if(!author||author.identity.remoteId!==id||author.identityEvidenceIncomplete)throw fail('RESPONSE_FORMAT');selectedAuthor=author;candidate.authors=[{name:author.title,remoteId:id}];
     });
     if(selectedAuthor){
      interpreted.authorHint={name:selectedAuthor.title,openLibraryId:selectedAuthor.identity.remoteId};
      const freshHints=candidate.externalIdentifiers??[],hint=freshHints.length===1?freshHints[0]:freshHints.length===0?gutenbergHint:null;
      if(hint)await run('gutendex',async()=>{
       const item=await request('gutendex',`/books/${hint.remoteId}/`),book=gutBook(item,{language,allowOriginal});
       if(!book||book.identity.remoteId!==hint.remoteId)throw fail('RESPONSE_FORMAT');
       if(!matchesTitle(book,interpreted.titleAliases)||!matchesAuthor(book,interpreted.authorHint))throw fail('CONFLICTING_METADATA');
       book.sourceLookupEvidence='fixed-provider-ID-rechecked-title-and-author';add(book);
      });else await run('gutendex',()=>gutBooks(selectedAuthor,{title:candidate.title}));
      await run('ranobelib',ranobeBooks);resolveExpanded();
     }else{result.status='needs_clarification';result.nextAction='needs_source';result.clarifications.push({code:'AUTHOR_IDENTITY_UNRESOLVED',message:'Не удалось однозначно проверить автора выбранного произведения. Уточните автора или источник.',candidateIds:[candidate.id]});}
    }else if(candidate){result.status='resolved';result.selectedCandidateId=candidate.id;result.nextAction=candidate.availability==='fetchable'?'acquire':'needs_source';}
   }else if(interpreted.curatedSeries&&!trusted){
    for(const index of FIRST_ARC.keys())add(curatedBook(`warriors:tpc:${index+1}`));
    result.plan={kind:'series',title:'Коты-воители — первый цикл',scope:'first-arc-only',order:'official-cycle-order',requiresConfirmation:true,bibliographyComplete:false,totalKnown:6,items:result.candidates.map(c=>({candidateId:c.id,sequence:c.order,title:c.title,author:'Erin Hunter',searchQuery:`${c.title} Erin Hunter`,needsSourceResolution:true})),evidence:CURATED_EVIDENCE};
    result.clarifications.push({code:'CONFIRM_SERIES_SCOPE',message:'Начать с шести романов первого цикла «Воители»? Другие циклы и графические адаптации выбираются отдельно.',candidateIds:result.candidates.map(c=>c.id)});
   }else if(interpreted.intent==='author'){
    await run('openlibrary',async()=>{
     if(trusted){
      const data=await request('openlibrary',`/authors/${trusted.remoteId}.json`),candidate=olAuthor(data);
      if(!candidate||candidate.identity.remoteId!==trusted.remoteId)throw fail('RESPONSE_FORMAT');add(candidate);
     }else{
      const data=await request('openlibrary','/search/authors.json',{q:phrase(interpreted.searchTerm),limit:String(Math.min(maxCandidates,10))});
      const items=rows(data,'docs',100,'openlibrary');more(data,'numFound',items.length);ingest(items,olAuthor,'openlibrary');
     }
    });
    const authors=result.candidates.filter(c=>c.kind==='author');
    let author=trusted?authors.find(c=>c.identity.remoteId===trusted.remoteId):selected?authors.find(c=>c.id===selected&&!c.conflictingMetadata):null;
    if(!selected&&authors.length===1&&!result.hasMore&&!result.providerErrors.length&&!authors[0].conflictingMetadata&&!authors[0].identityEvidenceIncomplete&&[authors[0].title,...authors[0].aliases].some(name=>person(name)===person(interpreted.searchTerm)))author=authors[0];
    if(author){
     let authorPage=null;
     await run('openlibrary',async()=>{
      const start=continuation?.kind==='author-works'?continuation.offset:0,limit=Math.max(1,Math.min(10,maxCandidates-authors.length)),data=await request('openlibrary',`/authors/${author.identity.remoteId}/works.json`,{limit:String(limit),offset:String(start)});
      const items=rows(data,'entries',100,'openlibrary');if(items.length>limit||items.length===0&&data.size>start)throw fail('RESPONSE_FORMAT');more(data,'size',items.length,start);ingest(items,item=>olBook(item,{author}),'openlibrary');authorPage={offset:start+items.length,total:data.size};
     });
     if(!continuation)await run('gutendex',()=>gutBooks(author));
     if(authorPage&&authorPage.offset<authorPage.total&&result.candidates.length<maxCandidates&&result.requestCount<maxRequests)await run('openlibrary',async()=>{
      const limit=Math.min(10,maxCandidates-result.candidates.length),data=await request('openlibrary',`/authors/${author.identity.remoteId}/works.json`,{limit:String(limit),offset:String(authorPage.offset)}),items=rows(data,'entries',100,'openlibrary');
      if(!Number.isSafeInteger(data.size)||data.size!==authorPage.total||items.length>limit||items.length===0||data.size<authorPage.offset+items.length)throw fail('RESPONSE_FORMAT');
      const previous=result.candidates.length;ingest(items,item=>olBook(item,{author}),'openlibrary');if(result.candidates.length===previous)throw fail('RESPONSE_FORMAT');authorPage.offset+=items.length;
     });
     const books=result.candidates.filter(c=>c.kind==='book'&&!c.conflictingMetadata).sort((a,b)=>(a.firstPublicationYear??10000)-(b.firstPublicationYear??10000)||a.title.localeCompare(b.title,'ru')||a.id.localeCompare(b.id));
     result.plan={kind:'author',authorCandidateId:author.id,title:author.title,scope:'bounded-provider-pages',order:'first-publication-year-then-title',orderIsReadingOrder:false,requiresConfirmation:true,bibliographyComplete:false,providerCoverage:authorPage?{provider:'openlibrary',loaded:authorPage.offset,totalReported:authorPage.total,completePageSet:authorPage.offset===authorPage.total}:null,items:books.map(c=>({candidateId:c.id,title:c.title,sequence:null,firstPublicationYear:c.firstPublicationYear??null,needsSourceResolution:c.availability!=='fetchable'}))};
     if(skippedItemCounts.get('openlibrary')){result.plan.partialMetadata=true;result.plan.skippedSourceItems=skippedItemCounts.get('openlibrary');if(result.plan.providerCoverage){result.plan.providerCoverage.recordsComplete=false;result.plan.providerCoverage.malformedItemsSkipped=result.plan.skippedSourceItems;}}
     if(authorPage&&authorPage.offset<authorPage.total&&authorPage.offset<=10000&&authorPage.offset>(continuation?.offset??0)&&!result.providerErrors.some(error=>error.provider==='openlibrary'&&error.code!=='MALFORMED_ITEM'))result.plan.continuation={kind:'author-works',provider:'openlibrary',remoteId:author.identity.remoteId,offset:authorPage.offset};
     result.clarifications.push({code:'CONFIRM_AUTHOR_PLAN',message:'Проверьте ограниченный список произведений. Это не полная библиография; одинаковые названия и издания не объединены.',candidateIds:result.plan.items.map(c=>c.candidateId)});
    }else result.clarifications.push({code:selected?'SELECTION_NOT_FOUND':'CHOOSE_AUTHOR',message:interpreted.authorHint?'Вы имеете в виду Артура Ч. Кларка, автора «Свидания с Рамой»? Выберите запись автора.':'Уточните автора по имени, известному произведению или датам.',candidateIds:authors.map(c=>c.id)});
   }else{
    let seriesPage=null;
    if(interpreted.intent==='series')await run('openlibrary',async()=>{
     const offset=continuation?.offset??0,limit=Math.min(maxCandidates,7),data=await request('openlibrary','/search.json',{q:`series_name:${phrase(interpreted.searchTerm)}`,...(interpreted.authorHint?{author:interpreted.authorHint.name}:{}),fields:FIELDS,limit:String(limit),offset:String(offset),lang:language,sort:'key'}),items=rows(data,'docs',100,'openlibrary'),count=Object.hasOwn(data,'numFound')?'numFound':'num_found';
     if(items.length>limit||items.length===0&&data[count]>offset)throw fail('RESPONSE_FORMAT');more(data,count,items.length,offset);ingest(items,olBook,'openlibrary');seriesPage={offset:offset+items.length,total:data[count]};
    });else await run('openlibrary',openBooks);
    if(!continuation){await run('gutendex',()=>gutBooks());await run('ranobelib',ranobeBooks);}
    if(interpreted.intent==='series'){
     const groups=new Map();
     for(const candidate of result.candidates.filter(c=>!c.conflictingMetadata&&!c.identityEvidenceIncomplete&&matchesAuthor(c,interpreted.authorHint)))for(const membership of candidate.seriesMemberships??[]){
      if(norm(membership.name)!==norm(interpreted.term))continue;
      let group=groups.get(membership.remoteId);if(!group){group={remoteId:membership.remoteId,title:membership.name,evidence:membership.evidence,url:membership.url,items:[]};groups.set(membership.remoteId,group);}
      if(!group.items.some(item=>item.candidateId===candidate.id))group.items.push({candidateId:candidate.id,title:candidate.title,sequence:membership.sequence,position:membership.position,needsSourceResolution:candidate.availability!=='fetchable'});
     }
     const variants=[...groups.values()],group=variants.length===1?variants[0]:null;
     const ordered=!!group&&group.items.every(item=>item.sequence!==null)&&new Set(group.items.map(item=>item.sequence)).size===group.items.length;
     if(group)group.items.sort((a,b)=>ordered?a.sequence-b.sequence:a.title.localeCompare(b.title,'ru')||a.candidateId.localeCompare(b.candidateId));
     result.plan={kind:'series',title:interpreted.term,scope:group?'provider-asserted-series-membership':'unverified-series-membership',order:ordered?'provider-series-position':'unconfirmed',orderIsReadingOrder:false,requiresConfirmation:true,bibliographyComplete:false,seriesIdentity:group?{provider:'openlibrary',remoteId:group.remoteId}:null,items:group?group.items:[],seriesVariants:variants,suggestedCandidateIds:result.candidates.filter(candidate=>!group?.items.some(item=>item.candidateId===candidate.id)).map(c=>c.id)};
     if(skippedItemCounts.get('openlibrary')){result.plan.partialMetadata=true;result.plan.skippedSourceItems=skippedItemCounts.get('openlibrary');}
     if(seriesPage&&seriesPage.offset<seriesPage.total&&seriesPage.offset<=10000&&seriesPage.offset>(continuation?.offset??0)&&!result.providerErrors.some(error=>error.provider==='openlibrary'&&error.code!=='MALFORMED_ITEM'))result.plan.continuation={kind:'series-search',provider:'openlibrary',term:interpreted.term,offset:seriesPage.offset};
     result.clarifications.push({code:variants.length>1?'CHOOSE_SERIES':group?'CONFIRM_SERIES_PLAN':'CONFIRM_SERIES_MEMBERSHIP',message:variants.length>1?'Найдены разные серии с одинаковым названием. Уточните автора и цикл.':group?'Проверьте состав и номера томов по данным каталога. Номер в серии не доказывает рекомендуемый порядок чтения.':'Уточните автора, цикл и порядок томов: результаты поиска ещё не доказывают принадлежность к серии.',candidateIds:group?group.items.map(item=>item.candidateId):result.candidates.map(c=>c.id)});
    }else{
     const exact=result.candidates.filter(c=>!c.identityEvidenceIncomplete&&matchesTitle(c,interpreted.titleAliases)&&matchesAuthor(c,interpreted.authorHint));
     const picked=selected?result.candidates.find(c=>c.id===selected):exact.length===1&&!result.hasMore&&!result.providerErrors.length?exact[0]:null;
     if(picked&&!picked.conflictingMetadata){result.status='resolved';result.selectedCandidateId=picked.id;result.nextAction=picked.availability==='fetchable'?'acquire':picked.availability==='needs-preview'?'needs_preview':'needs_source';}
     else if(result.candidates.length||selected)result.clarifications.push({code:selected?'SELECTION_NOT_FOUND':'CHOOSE_BOOK',message:'Уточните книгу, автора, язык и источник; совпадение названия не объединяет разные произведения.',candidateIds:result.candidates.map(c=>c.id)});
    }
   }
   // A title, ISBN, or an author string alone never collapses provider records.
   // An explicit Gutenberg ID supplied by OL is only a relationship hint until
   // the separately quarantined file passes its own identity verification.
   result.identityLinks=[];
   for(const candidate of result.candidates.filter(c=>c.identity.provider==='openlibrary'&&!c.conflictingMetadata))for(const external of candidate.externalIdentifiers??[]){
    const peer=result.candidates.find(c=>c.identity.provider==='gutendex'&&c.identity.remoteId===external.remoteId&&!c.conflictingMetadata);if(!peer)continue;
    const titleCompatible=norm(candidate.title)===norm(peer.title),authorCompatible=candidate.authors.some(author=>peer.authors.some(other=>person(author.name)===person(other.name)));
    result.identityLinks.push({candidateIds:[candidate.id,peer.id],evidence:external.evidence,provider:'gutenberg',remoteId:external.remoteId,metadataCompatible:titleCompatible&&authorCompatible,mergeAllowed:false,fileVerificationRequired:true});
   }
   const blocked=result.candidates.filter(c=>c.kind==='book'&&c.blockedReason==='ORIGINAL_NOT_ALLOWED');
   if(blocked.length&&!allowOriginal)result.clarifications.push({code:'ALLOW_ORIGINAL',message:'Есть метаданные книги на другом языке. Разрешить оригинал для последующего перевода?',candidateIds:blocked.map(c=>c.id)});
   if(result.clarifications.length&&result.status!=='resolved')result.status='needs_clarification';
   if(signal.aborted){result.status='incomplete';result.selectedCandidateId=null;result.nextAction='none';}
   else if(!result.candidates.length&&result.providerErrors.length)result.status='unavailable';
   return result;
  }finally{clearTimeout(timer);parent?.removeEventListener('abort',cancel);}
 };
}

const defaultSearch=createDiscoverySearch();
/** fetchSafe/clock/sleep are owner-only DI for tests, never JSON job options. */
export async function searchDiscovery(query,options={}){
 const {fetchSafe,clock,sleep,...searchOptions}=options;
 return fetchSafe||clock||sleep?createDiscoverySearch({fetchSafe,clock,sleep})(query,searchOptions):defaultSearch(query,searchOptions);
}

/** Only pass a candidate loaded from the server's stored discovery result, not
 * an object supplied by an HTTP client. The stable identity is rechecked and
 * metadata is fetched again from the fixed provider endpoint before use. */
export async function searchSelectedDiscovery(selection,options={}){
 if(!record(selection)||!record(selection.identity)||!['author','book'].includes(selection.kind)||typeof selection.identity.remoteId!=='string'||selection.id!==candidateId(selection.identity.provider,selection.kind,selection.identity.remoteId)||selection.conflictingMetadata||!canExpandDiscoveryCandidate(selection)&&!(selection.kind==='book'&&selection.identity.provider==='gutendex'&&/^[1-9][0-9]{0,9}$/u.test(selection.identity.remoteId)))throw new TypeError('Нужен сохранённый кандидат поиска');
 const label=clean(selection.title);
 const hints=selection.kind==='book'&&selection.identity.provider==='openlibrary'&&Array.isArray(selection.externalIdentifiers)&&selection.externalIdentifiers.length<=16?selection.externalIdentifiers.filter(item=>record(item)&&item.provider==='gutenberg'&&typeof item.remoteId==='string'&&/^[1-9][0-9]{0,9}$/u.test(item.remoteId)):[];
 const ids=[...new Set(hints.map(item=>item.remoteId))];
 return searchDiscovery(label.length>=2?label:'Selected book',{...options,expandSelectedSources:true,trustedGutenbergHint:ids.length===1?{provider:'gutenberg',remoteId:ids[0]}:null,trustedFilter:{kind:selection.kind,provider:selection.identity.provider,remoteId:selection.identity.remoteId}});
}
