/** Public Russian novel catalogues. Source contracts inspected 2026-10-24.
 * Ranobe.me: public HTML catalogue, TOC and reader.
 * RanobeHub: SSR catalogue metadata + the same public chapter API its reader uses.
 * Numbers are source/title coordinates; array positions never become chapter numbers.
 */
import {randomInt} from 'node:crypto';
import {mvpRateLimitError} from './mvp-errors.mjs';

export const EXTRA_NOVEL_SOURCES = [
  {id:'ranobeme',name:'Ranobe.me',kind:'novel',description:'Русские переводы новелл, полные оглавления и продолжения'},
  {id:'ranobehub',name:'RanobeHub',kind:'novel',description:'Ранобэ, веб-новеллы и переводы читательских команд'},
];
const HOSTS={ranobeme:'ranobe.me',ranobehub:'ranobehub.org'};
const err=(code,message,status=502,source)=>Object.assign(new Error(message),{code,status,source});
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const plain=(x,max=2500)=>typeof x==='string'?x.replace(/[\p{Cc}\p{Cf}]/gu,' ').replace(/\s+/gu,' ').trim().slice(0,max):'';
const positive=/^[1-9]\d{0,10}$/u;
const hubId=/^[1-9]\d{0,10}-[a-zA-Z0-9_-]{1,180}$/u;
const zero=/^(?:0|[1-9]\d{0,10})$/u;
const decimal=x=>/^(?:0|[1-9]\d{0,8})(?:[.,]\d{1,5})?$/u.test(String(x))?String(x).replace(',','.'):'';
const fallbackExtract=html=>({paragraphs:String(html).replace(/<(script|style|nav|footer)\b[^>]*>[\s\S]*?<\/\1>/giu,'').replace(/<\/?(?:p|div|br|li|h[1-6]|blockquote)\b[^>]*>/giu,'\n').replace(/<[^>]*>/gu,'').replace(/&nbsp;/giu,' ').replace(/&amp;/giu,'&').replace(/&quot;/giu,'"').replace(/&#39;/giu,"'").split(/\n/gu).map(x=>x.trim()).filter(Boolean)});
const sourceOf=source=>{if(!Object.hasOwn(HOSTS,source))throw err('INPUT','Неизвестный источник новелл',400);return source;};
const idOf=(source,id)=>{id=String(id??'');if(!(source==='ranobeme'?positive:hubId).test(id))throw err('INPUT','Неверный идентификатор новеллы',400,source);return id;};
const unavailable=x=>x?.isDraft===true||x?.isPaid===true||x?.isLocked===true||x?.restricted===true||x?.locked===true||Number(x?.price??0)>0||x?.scheduledFor!=null;

// RSC payloads are JSON data, never evaluated as JavaScript. Ignore module refs
// and long-text records; only complete JSON records can contain catalogue props.
export function mvpNovelsFlightObjects(html){
  const records=[],objects=[];let count=0;
  const visit=(x,depth=0)=>{if(depth>45||++count>180000)throw err('SOURCE_FORMAT','Слишком сложные данные каталога');if(Array.isArray(x)){for(const v of x)visit(v,depth+1);}else if(obj(x)){objects.push(x);for(const v of Object.values(x))visit(v,depth+1);}};
  const payload=[...String(html).matchAll(/self\.__next_f\.push\((\[[\s\S]*?\])\)<\/script>/gu)].map(m=>{try{const value=JSON.parse(m[1]);return value[0]===1&&typeof value[1]==='string'?value[1]:'';}catch{return '';}}).join('');
  for(const line of payload.split('\n')){const m=/^[0-9a-f]+:([\[{].*)$/u.exec(line);if(!m)continue;try{records.push(JSON.parse(m[1]));}catch{}}
  // Flight long-text (T) records are byte-length framed and can end immediately
  // before the next JSON record. Catalogue pages with 24 descriptions therefore
  // need a balanced JSON fallback, independent of newline record boundaries.
  for(const match of payload.matchAll(/\{(?="result":|"bookId":\d+,"slug":)/gu)){
    let depth=0,quoted=false,escaped=false;
    for(let i=match.index;i<payload.length;i++){
      const c=payload[i];if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
      if(c==='"')quoted=true;else if(c==='{')depth++;else if(c==='}'&&--depth===0){try{records.push(JSON.parse(payload.slice(match.index,i+1)));}catch{}break;}
    }
  }
  for(const value of records)visit(value);return objects;
}

/** Visible chapter title, not a site's sortable internal sequence. */
export function mvpNovelsCoordinates(title){
  const number=/(?:^|\s)(?:Глава|Гл\.)\s*([0-9]+(?:[.,][0-9]+)?)(?=\s|[.:—–-]|$)/iu.exec(title)?.[1]??'';
  const volume=/(?:^|\s)Том\s*([0-9]+(?:[.,][0-9]+)?)(?=\s|[.:—–-]|$)/iu.exec(title)?.[1]??'';
  const part=/(?:часть|части|ч\.)\s*([0-9]+)/iu.exec(title)?.[1]??'';
  return {number:decimal(number),...(volume?{volume:decimal(volume)}:{}),...(part?{part}:{} )};
}

const numberingOf=chapters=>{
  const numbered=chapters.filter(x=>x.number),byNumber=new Map(),minima=new Map();let restarts=false;
  for(const c of numbered){const volume=byNumber.get(c.number);if(volume!==undefined&&volume!==c.volume)restarts=true;byNumber.set(c.number,c.volume);minima.set(c.volume,Math.min(minima.get(c.volume)??Infinity,Number(c.number)));}
  if(numbered.length<chapters.length*.75)return 'unknown';
  if(restarts)return [...minima.values()].every(n=>n<=3)?'volume':'unknown';
  return 'global';
};

export function createExtraNovelSources({fetchImpl=globalThis.fetch,extractHtml=fallbackExtract,timeoutMs=18000}={}){
  if(typeof fetchImpl!=='function'||typeof extractHtml!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>45000)throw new TypeError('Неверные параметры источников новелл');
  const text=html=>extractHtml(html).paragraphs.map(x=>plain(x,300000)).filter(Boolean);
  const string=html=>text(html).join(' ');
  const cache=new Map(),pending=new Map();let cacheBytes=0;
  const cached=async(key,work)=>{const hit=cache.get(key);if(hit?.expires>Date.now())return hit.value;if(pending.has(key))return pending.get(key);const p=(async()=>{const value=await work(),bytes=Buffer.byteLength(JSON.stringify(value));if(bytes<=24*1024*1024){if(hit){cacheBytes-=hit.bytes;cache.delete(key);}while(cache.size>=36||cacheBytes+bytes>40*1024*1024){const first=cache.keys().next().value;if(first===undefined)break;cacheBytes-=cache.get(first).bytes;cache.delete(first);}cache.set(key,{value,bytes,expires:Date.now()+300000});cacheBytes+=bytes;}return value;})();pending.set(key,p);try{return await p;}finally{pending.delete(key);}};
  const request=async(source,path,json=false)=>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);let url=new URL(path,'https://'+HOSTS[source]);
    try{
      let response;
      for(let hop=0;hop<4;hop++){
        if(url.protocol!=='https:'||url.hostname!==HOSTS[source]||url.username||url.password||url.port&&url.port!=='443')throw err('SOURCE_URL','Источник вернул неподдерживаемую ссылку',502,source);
        response=await fetchImpl(url.href,{redirect:'manual',signal:controller.signal,headers:{'User-Agent':'Gargantua-MVP/1.0 (personal desktop reader)',Accept:json?'application/json':'text/html'}});
        if([301,302,303,307,308].includes(response.status)){const next=response.headers.get('location');await response.body?.cancel();if(!next||hop===3)throw err('SOURCE_REDIRECT','Слишком много перенаправлений источника',502,source);url=new URL(next,url);continue;}break;
      }
      if(!response.ok){await response.body?.cancel();if(response.status===429)throw mvpRateLimitError(response,source);throw err(response.status===404?'NOT_FOUND':[401,403,451].includes(response.status)?'SOURCE_RESTRICTED':'SOURCE_UNAVAILABLE',response.status===404?'Новелла или глава не найдена':[401,403,451].includes(response.status)?'Источник ограничил доступ к материалу':'Источник новелл временно недоступен',response.status===404?404:502,source);}
      const max=12*1024*1024;if(Number(response.headers.get('content-length'))>max){await response.body?.cancel();throw err('SOURCE_LIMIT','Слишком большой ответ источника',502,source);}
      const reader=response.body.getReader(),chunks=[];let bytes=0;
      while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>max){await reader.cancel();throw err('SOURCE_LIMIT','Слишком большой ответ источника',502,source);}chunks.push(Buffer.from(part.value));}
      const body=Buffer.concat(chunks).toString('utf8');if(!json)return body;try{return JSON.parse(body);}catch{throw err('SOURCE_FORMAT','Источник вернул страницу вместо данных',502,source);}
    }catch(error){if(error?.code&&error?.status)throw error;throw err(controller.signal.aborted?'SOURCE_TIMEOUT':'SOURCE_NETWORK',controller.signal.aborted?'Источник новелл не ответил вовремя':'Не удалось соединиться с источником новелл',502,source);}finally{clearTimeout(timer);}
  };
  const field=(html,pattern)=>string(pattern.exec(html)?.[1]??'');
  const baseCard=(source,id,title,fields={})=>({source,id,title:plain(title,500),author:'',description:'',cover:null,url:`https://${HOSTS[source]}/${source==='ranobeme'?'ranobe'+id:'ranobe/'+id}`,kind:'novel',language:'ru',available:true,...fields});
  const hubCard=x=>{const id=String(x.id)+'-'+x.slug;if(!hubId.test(id)||!plain(x.title))return null;const description=typeof x.description==='string'&&!/^\$[a-z0-9]+$/iu.test(x.description)?x.description:x.shortDescription;return baseCard('ranobehub',id,x.title,{originalTitle:plain(x.originalTitle,500),aliases:[plain(x.originalTitle,500)].filter(Boolean),description:plain(description),available:Number(x.chapters)>0,chapterCount:Number.isSafeInteger(x.chapters)?x.chapters:null});};

  const search=async(source,query='',page=1)=>{
    source=sourceOf(source);query=String(query??'').trim();page=Number(page);if(query.length>500||!Number.isSafeInteger(page)||page<1||page>5000)throw err('INPUT','Неверные параметры поиска',400,source);
    return cached(`search:${source}:${page}:${query}`,async()=>{
      if(source==='ranobehub'){
        const html=await request(source,'/ranobe?'+new URLSearchParams({...(query?{q:query}:{}),page:String(page)}));
        const result=mvpNovelsFlightObjects(html).find(x=>obj(x.result)&&Array.isArray(x.result.items)&&x.result.items.every(i=>obj(i)&&typeof i.slug==='string'))?.result;
        if(!result)throw err('SOURCE_FORMAT','Не удалось прочитать каталог RanobeHub',502,source);
        const items=result.items.map(hubCard).filter(Boolean),total=Number.isSafeInteger(result.total)?result.total:null;
        return {items,total,hasMore:typeof result.hasMore==='boolean'?result.hasMore:total!==null?page*24<total:items.length===24};
      }
      const html=await request(source,query?'/index.php?'+new URLSearchParams({section:'search',str:query,page:String(page)}):'/catalog?page='+page);
      const items=[];
      for(const block of html.split(/<div\b[^>]*\bid=["']fic_/iu).slice(1)){
        const m=/<a\b[^>]*href=["']\/ranobe([1-9]\d*)["'][^>]*>([^<]+)<\/a>/iu.exec(block);if(!m)continue;
        const count=Number(field(block,/<span\b[^>]*class=["']ChaptersCount["'][^>]*>([\s\S]*?)<\/span>/iu));
        items.push(baseCard(source,m[1],string(m[2]),{description:field(block,/<div\b[^>]*class=["']FicTable_Description["'][^>]*>([\s\S]*?)<\/div>/iu),chapterCount:count,available:count>0}));
      }
      const title=field(html,/<h1\b[^>]*>([\s\S]*?)<\/h1>/iu);
      const empty=/ничего не найдено/iu.test(string(html));
      if(!items.length&&!empty&&!/(?:Найдено\s*0|не найден|Все ранобэ|Поиск)/iu.test(title))throw err('SOURCE_FORMAT','Не удалось прочитать каталог Ranobe.me',502,source);
      const total=/Найдено\s*([\d ]+)/iu.exec(title)?.[1];
      const pages=[...html.matchAll(/[?&](?:amp;)?page=([1-9]\d*)/gu)].map(m=>Number(m[1]));
      return {items,total:total?Number(total.replace(/ /gu,'')):empty?0:null,hasMore:pages.some(n=>n>page)};
    });
  };
  const book=async(source,id)=>{
    source=sourceOf(source);id=idOf(source,id);
    return cached(`book:${source}:${id}`,async()=>{
      if(source==='ranobeme'){
        const html=await request(source,'/ranobe'+id),identity=/<div\b[^>]*id=["']fic_id["'][^>]*>\s*(\d+)\s*<\/div>/iu.exec(html)?.[1];
        if(identity!==id)throw err('SOURCE_IDENTITY','Источник вернул другую новеллу',502,source);
        const title=field(html,/<h1\b[^>]*>([\s\S]*?)<\/h1>/iu),author=field(html,/<a\b[^>]*href=["']\/catalog\/author\/\d+["'][^>]*>([\s\S]*?)<\/a>/iu);
        const names=text(/Названия ранобэ:<\/div>\s*<div\b[^>]*class=["']content["'][^>]*>([\s\S]*?)<\/div>/iu.exec(html)?.[1]??''),chapters=[],seen=new Set();
        // Each source volume has its own sibling <ul class="FicContents">.
        // Reading only the first list silently returned three prologue chapters.
        const tocStart=/<ul\b[^>]*class=["']FicContents["'][^>]*>/iu.exec(html),toc=tocStart?html.slice(tocStart.index):undefined;if(toc===undefined)throw err('SOURCE_FORMAT','Не удалось прочитать оглавление Ranobe.me',502,source);
        for(const m of toc.matchAll(/<a\b[^>]*href=["']\/ranobe([1-9]\d*)\/(\d+)["'][^>]*>([\s\S]*?)<\/a>/giu)){
          if(m[1]!==id||seen.has(m[2]))continue;seen.add(m[2]);const chapterTitle=string(m[3]),coordinates=mvpNovelsCoordinates(chapterTitle);
          chapters.push({id:m[2],title:chapterTitle,volume:coordinates.volume??'1',...coordinates,available:true,sourceIndex:m[2]});
        }
        const originalTitle=names.find(n=>/[a-z]/iu.test(n))??'';
        const description=field(html,new RegExp(`<div\\b[^>]*id=["']summary_${id}["'][^>]*>([\\s\\S]*?)<\\/div>`,'iu'));
        const numbering=numberingOf(chapters);for(const c of chapters)c.numbering=numbering;
        return {...baseCard(source,id,title,{author,originalTitle,aliases:names.filter(n=>n!==title),description,available:chapters.length>0}),numbering,chapters,chapterCount:chapters.length};
      }
      const numeric=id.split('-')[0],html=await request(source,'/ranobe/'+id),objects=mvpNovelsFlightObjects(html);
      const inventory=objects.find(x=>String(x.bookId)===numeric&&typeof x.slug==='string'&&Array.isArray(x.volumes));
      if(!inventory||numeric+'-'+inventory.slug!==id)throw err('SOURCE_IDENTITY','Источник вернул другую новеллу',502,source);
      const title=field(html,/<h1\b[^>]*>([\s\S]*?)<\/h1>/iu),originalTitle=field(html,/<p\b[^>]*class=["']book-original-title["'][^>]*>([\s\S]*?)<\/p>/iu);
      const authors=[...html.matchAll(/<a\b[^>]*class=["'][^"']*\bis-author\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/giu)].map(m=>field(m[1],/<strong\b[^>]*>([\s\S]*?)<\/strong>/iu)).filter(Boolean);
      const description=objects.find(x=>typeof x.descriptionHtml==='string')?.descriptionHtml??'';
      const raw=[],seen=new Set();let offset=0,total=null;
      // Request every page of the public TOC. The SSR page intentionally has
      // only 24 initial chapters per volume; treating it as complete loses tails.
      for(let page=0;page<120;page++){
        const data=await request(source,`/api/books/${numeric}/chapters?`+new URLSearchParams({sort:'asc',limit:'180',offset:String(offset)}),true);
        if(!Array.isArray(data.items)||data.items.length>200||!Number.isSafeInteger(data.total)||data.total<0||data.total>20000)throw err('SOURCE_FORMAT','Не удалось прочитать полное оглавление RanobeHub',502,source);
        total=data.total;
        for(const chapter of data.items){if(String(chapter.bookId)!==numeric||!positive.test(String(chapter.id))||typeof chapter.title!=='string')throw err('SOURCE_IDENTITY','В оглавлении обнаружена глава другой новеллы',502,source);if(!seen.has(chapter.id)){seen.add(chapter.id);raw.push(chapter);}}
        if(data.nextOffset===null)break;
        if(!Number.isSafeInteger(data.nextOffset)||data.nextOffset<=offset)throw err('SOURCE_FORMAT','Повреждена пагинация оглавления RanobeHub',502,source);offset=data.nextOffset;
      }
      if(raw.length!==total)throw err('SOURCE_FORMAT','Источник вернул неполное оглавление RanobeHub',502,source);
      const chapters=raw.map(x=>{const title=plain(x.title,500),c=mvpNovelsCoordinates(title);return {id:String(x.id),title,number:c.number,volume:decimal(x.volume)||c.volume||'',...(c.part?{part:c.part}:{}),sourceNumber:decimal(x.number),available:!unavailable(x),branchId:'main',branchIds:['main']};});
      // Some older translations switch from volume-local title numbers to
      // global numbers mid-book. They cannot safely share numeric merge keys.
      const numbering=numberingOf(chapters);for(const c of chapters)c.numbering=numbering;
      return {...baseCard(source,id,title,{author:[...new Set(authors)].join(', '),originalTitle,aliases:[originalTitle].filter(Boolean),description:plain(string(description)),available:chapters.some(c=>c.available)}),numbering,chapters,chapterCount:chapters.length,defaultBranchId:'main',branches:[{id:'main',name:'Основной перевод источника',chapterCount:chapters.length,availableCount:chapters.filter(c=>c.available).length}]};
    });
  };
  const chapter=async(source,id,chapterId,{branchId}={})=>{
    source=sourceOf(source);id=idOf(source,id);chapterId=String(chapterId??'');if(!(source==='ranobeme'?zero:positive).test(chapterId))throw err('INPUT','Неверный идентификатор главы',400,source);
    if(branchId&&branchId!=='main')throw err('SOURCE_RESTRICTED','Этот перевод отсутствует в источнике',400,source);
    const meta=await book(source,id),entry=meta.chapters.find(c=>c.id===chapterId);if(!entry)throw err('NOT_FOUND','Глава отсутствует в оглавлении этой новеллы',404,source);if(!entry.available)throw err('SOURCE_RESTRICTED','Глава закрыта источником',502,source);
    return cached(`chapter:${source}:${id}:${chapterId}`,async()=>{
      let paragraphs,title=entry.title,sourceUrl;
      if(source==='ranobeme'){
        sourceUrl=`https://${HOSTS[source]}/ranobe${id}/${chapterId}`;const html=await request(source,sourceUrl);
        const parent=/Ранобэ:\s*<a\b[^>]*href=["']\/ranobe([1-9]\d*)["'][^>]*>([\s\S]*?)<\/a>/iu.exec(html);
        if(!parent||parent[1]!==id||string(parent[2])!==meta.title)throw err('SOURCE_IDENTITY','Источник вернул главу другой новеллы',502,source);
        if(!new RegExp(`<div\\b[^>]*class=["'][^"']*\\bchapter\\b[^"']*["'][^>]*id=["']c${chapterId}["']`,'iu').test(html))throw err('SOURCE_IDENTITY','Источник вернул другую главу',502,source);
        const actual=field(html,/<h1\b[^>]*>([\s\S]*?)<\/h1>/iu);if(actual!==title)throw err('SOURCE_IDENTITY','Название главы не совпадает с оглавлением',502,source);
        paragraphs=[...html.matchAll(/<p\b[^>]*class=["']fict["'][^>]*>([\s\S]*?)(?:<\/p>|(?=<p\b))/giu)].flatMap(m=>text(m[1]));
      }else{
        sourceUrl=`https://${HOSTS[source]}/ranobe/${id}/chapter/${chapterId}`;const data=await request(source,'/api/chapters/'+chapterId,true),value=data.chapter;
        if(!obj(value)||String(value.bookId)!==id.split('-')[0]||String(value.id)!==chapterId||value.bookSlug!==id.split('-').slice(1).join('-')||plain(value.title,500)!==title||decimal(value.volume)!==entry.volume||decimal(value.number)!==entry.sourceNumber||value.translationBranch?.slug&&value.translationBranch.slug!=='main')throw err('SOURCE_IDENTITY','Источник вернул другую главу',502,source);
        if(unavailable(value)||typeof value.html!=='string')throw err('SOURCE_RESTRICTED','Источник не открыл текст этой главы',502,source);
        paragraphs=text(value.html);
      }
      if(!paragraphs.length||paragraphs.join('').length<30)throw err('SOURCE_FORMAT','Источник вернул пустую главу',502,source);
      return {source,bookId:id,id:chapterId,title,paragraphs,text:paragraphs.join('\n\n'),sourceUrl,branchId:source==='ranobehub'?'main':undefined};
    });
  };
  const random=async(source)=>{source=sourceOf(typeof source==='object'?source.source:source);const catalogue=await search(source,'',1);if(!catalogue.items.length)throw err('NOT_FOUND','Каталог источника пуст',404,source);return {book:catalogue.items[randomInt(catalogue.items.length)],source};};
  return {search,book,chapter,random};
}
