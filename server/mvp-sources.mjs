/** Gargantua MVP: bounded, direct source adapters. No queue, database or audio.
 * Live contracts checked 2026-10-24: api.cdnlibs.org (Site-Id 3),
 * https://gutendex.com/, https://www.mediawiki.org/wiki/API:Search.
 * Source markup is converted to plain paragraphs, never sent as executable HTML.
 */
import {randomInt} from 'node:crypto';
import {EXTRA_BOOK_SOURCES,createExtraBookSources} from './mvp-extra-books.mjs';
import {EXTRA_NOVEL_SOURCES,createExtraNovelSources} from './mvp-extra-novels.mjs';
import {mvpRateLimitError} from './mvp-errors.mjs';

export const MVP_SOURCE_LIST = [
  {id:'ranobelib',name:'RanobeLib',kind:'novel',description:'Ранобэ и новеллы на русском'},
  {id:'wikisource',name:'Викитека',kind:'book',description:'Русская классика и переводы'},
  {id:'gutenberg',name:'Project Gutenberg',kind:'book',description:'Книги на языке оригинала'},
  ...EXTRA_BOOK_SOURCES,
  ...EXTRA_NOVEL_SOURCES,
];
const SOURCE_IDS = MVP_SOURCE_LIST.map(source=>source.id);
const RANOBE='https://api.cdnlibs.org/api/manga';
const WIKI='https://ru.wikisource.org/w/api.php';
const GUT='https://gutendex.com/books/';
const HEADERS={'User-Agent':'Gargantua-MVP/1.0 (personal desktop reader)','Accept':'application/json'};
const SLUG=/^[1-9]\d{0,10}--[a-zA-Z0-9_-]{1,180}$/u;
const POSITIVE=/^[1-9]\d{0,11}$/u;
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const plain=(value,max=500)=>typeof value==='string'?value.replace(/[\p{Cc}\p{Cf}]/gu,' ').replace(/\s+/gu,' ').trim().slice(0,max):'';
const fail=(code,message,status=502,source)=>Object.assign(new Error(message),{code,status,source});
const checkedSource=(source,all=false)=>{if(!SOURCE_IDS.includes(source)&&!(all&&source==='all'))throw fail('INPUT','Неизвестный источник',400);return source;};
const idOf=(source,id)=>{id=String(id??'');if(!(source==='ranobelib'?SLUG:POSITIVE).test(id))throw fail('INPUT','Неверный идентификатор книги',400);return id;};
const boundedPage=value=>{const number=Number(value??1);if(!Number.isSafeInteger(number)||number<1||number>5000)throw fail('INPUT','Неверный номер страницы',400);return number;};
const safeImage=value=>{try{const url=new URL(value);if(url.protocol==='https:'&&!url.username&&!url.password&&(!url.port||url.port==='443')&&['imglib.info','cdnlibs.org','gutenberg.org','wikimedia.org'].some(host=>url.hostname===host||url.hostname.endsWith('.'+host)))return url.href;}catch{}return null;};
const entities={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',mdash:'—',ndash:'–',hellip:'…',laquo:'«',raquo:'»',lsquo:'‘',rsquo:'’',ldquo:'“',rdquo:'”',copy:'©',bull:'•',middot:'·',thinsp:' ',ensp:' ',emsp:' ',shy:''};
export function decodeMvpEntities(value){return String(value).replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]+);/giu,(match,key)=>{if(key[0]!=='#')return entities[key]??match;const number=Number.parseInt(key.slice(key[1]?.toLowerCase()==='x'?2:1),key[1]?.toLowerCase()==='x'?16:10);return number>0&&number<=0x10ffff&&!(number>=0xd800&&number<=0xdfff)?String.fromCodePoint(number):'';});}
const attributes=value=>Object.fromEntries([...value.matchAll(/([a-z][a-z0-9_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/giu)].map(match=>[match[1].toLowerCase(),decodeMvpEntities(match[2]??match[3]??match[4])]));

/** A small text extractor, not an HTML renderer. Even malformed tags only
 * produce inert strings. Navigation and source metadata are excluded. */
export function extractMvpHtml(html){
  if(typeof html!=='string'||Buffer.byteLength(html)>12*1024*1024)throw fail('SOURCE_FORMAT','Слишком большой текст источника');
  const stack=[],paragraphs=[],links=[];let buffer='',nodes=0;
  const flush=()=>{const preformatted=stack.some(item=>item.tag==='pre');for(const segment of preformatted?buffer.split(/\n\s*\n/gu):[buffer]){let value=decodeMvpEntities(segment).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu,'').replace(/[ \t\r\n]+/gu,' ').trim();if(preformatted)value=value.replace(/'{2,5}([^']+)'{2,5}/gu,'$1');if(value)paragraphs.push(value);}buffer='';};
  const blocks=new Set(['p','div','li','blockquote','h1','h2','h3','h4','h5','h6','tr','section','article','pre']);
  const voids=new Set(['br','hr','img','input','meta','link','wbr','source','area','base','embed','param','track','col']);
  for(const match of html.matchAll(/<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>|[^<]+|</gu)){
    if(++nodes>300000)throw fail('SOURCE_FORMAT','Слишком сложная разметка источника');
    const token=match[0];if(token.startsWith('<!--'))continue;
    if(token[0]!=='<'){if(!stack.at(-1)?.skip)buffer+=token;continue;}
    const parsed=/^<(\/?)([a-zA-Z][a-zA-Z0-9]*)/u.exec(token);if(!parsed)continue;
    const tag=parsed[2].toLowerCase();
    if(parsed[1]){const index=stack.map(item=>item.tag).lastIndexOf(tag);if(index>=0){if(!stack.at(-1)?.skip&&blocks.has(tag))flush();stack.length=index;}continue;}
    const attrs=attributes(token),marker=(attrs.class??'')+' '+(attrs.id??'');
    const skip=Boolean(stack.at(-1)?.skip)||['script','style','nav','footer','sup'].includes(tag)||/(?:^|\s)(?:ws-noexport|headertemplate|mw-editsection|mw-empty-elt|noprint|toc|metadata|catlinks|printfooter|header_notes|sistersitebox|navigation-not-searchable)(?:\s|$)/iu.test(marker)||/^(?:headertemplate|toc|catlinks|footer)/iu.test(attrs.id??'');
    if(!skip&&(blocks.has(tag)||['br','hr'].includes(tag)))flush();
    if(!skip&&tag==='a'&&typeof attrs.href==='string')links.push({href:attrs.href,title:attrs.title??''});
    if(!voids.has(tag)&&!token.endsWith('/>'))stack.push({tag,skip});
  }
  flush();return {paragraphs,links};
}

/** Newer RanobeLib editor responses contain blockquotes, lists and headings.
 * Recursing over typed containers preserves their text without rejecting whole
 * chapters merely because the source added cosmetic formatting. */
export function extractMvpEditor(content){
  if(typeof content==='string')return extractMvpHtml(content).paragraphs;
  const paragraphs=[];let nodes=0;
  const inline=(node,depth=0)=>{if(++nodes>60000||depth>30||!record(node))throw fail('SOURCE_FORMAT','Повреждён текст главы');if(node.type==='text')return typeof node.text==='string'?node.text:'';if(node.type==='hardBreak')return '\n';if(node.type==='image')return '[Иллюстрация]';return Array.isArray(node.content)?node.content.map(child=>inline(child,depth+1)).join(''):'';};
  const walk=(node,depth=0)=>{if(++nodes>60000||depth>30||!record(node))throw fail('SOURCE_FORMAT','Повреждён текст главы');if(['paragraph','heading','codeBlock'].includes(node.type)){const value=inline(node).trim();if(value)paragraphs.push(value);}else if(node.type==='horizontalRule')paragraphs.push('***');else if(node.type==='image')paragraphs.push('[Иллюстрация]');else if(Array.isArray(node.content))for(const child of node.content)walk(child,depth+1);};
  walk(content);return paragraphs;
}
const unavailable=item=>item?.is_licensed===true||item?.is_paid===true||item?.is_locked===true||item?.is_blocked===true||item?.is_deleted===true||item?.expired_at!=null||item?.bundle_id!=null||item?.expired_type!=null&&!['0',0].includes(item.expired_type)||Number(item?.price??0)>0;
const wikiUrl=title=>'https://ru.wikisource.org/wiki/'+encodeURIComponent(title.replace(/ /gu,'_'));
const romanNumber=value=>{const symbols={I:1,V:5,X:10,L:50,C:100,D:500,M:1000};if(!/^[IVXLCDM]+$/u.test(value))return 0;return [...value].reduce((sum,c,i)=>sum+(symbols[c]<(symbols[value[i+1]]??0)?-symbols[c]:symbols[c]),0);};
const natural=(a,b)=>a.replace(/\b[IVXLCDM]+\b/gu,x=>String(romanNumber(x)).padStart(6,'0')).localeCompare(b.replace(/\b[IVXLCDM]+\b/gu,x=>String(romanNumber(x)).padStart(6,'0')),'ru',{numeric:true});
const GUT_STOPWORDS=new Set('a an the and or of in on at to by for with from as is are this that volume vol part book edition translated illustrated de la le les des du et der die das und'.split(' '));
/** The official Gutendex implementation ANDs only its first four literal
 * space-separated terms. Remove punctuation and select useful title words. */
export function gutenbergMvpTerms(value){const tokens=plain(value,500).normalize('NFKC').replace(/['’]s\b/giu,'').match(/[\p{L}\p{N}]+/gu)??[];const unique=[...new Map(tokens.map(token=>[token.toLowerCase(),token])).values()];const useful=unique.filter(token=>token.length>1&&!GUT_STOPWORDS.has(token.toLowerCase()));return (useful.length?useful:unique).slice(0,3).join(' ');}
const WIKI_STOPWORDS=new Set('и в во на по за из от до об со ко для при или но а не ни же ли'.split(' '));
/** Wikisource's default full-text search returns incidental mentions even when
 * the requested book does not exist. Every useful token must match its title;
 * author names in source titles remain searchable with the same rule. */
export function wikisourceMvpQuery(value){const tokens=plain(value,500).normalize('NFKC').match(/[\p{L}\p{N}]+/gu)??[];const seen=new Set();return tokens.filter(token=>{const key=token.toLowerCase().replace(/ё/gu,'е');if(token.length<2||WIKI_STOPWORDS.has(key)||seen.has(key))return false;seen.add(key);return true;}).map(token=>'intitle:'+token).join(' ');}
export function parseMvpGutenbergSearch(html){
  const items=[];
  for(const match of html.matchAll(/<li\b[^>]*class=["'][^"']*\bbooklink\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/giu)){
    const body=match[1],id=/href=["']\/ebooks\/([1-9]\d*)["']/iu.exec(body)?.[1];if(!id)continue;
    const field=name=>extractMvpHtml(new RegExp(`<span\\b[^>]*class=["'][^"']*\\b${name}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/span>`,'iu').exec(body)?.[1]??'').paragraphs.join(' ');
    const title=field('title');if(!title)continue;
    items.push({source:'gutenberg',id,title:plain(title),author:plain(field('subtitle')),description:'',cover:`https://www.gutenberg.org/cache/epub/${id}/pg${id}.cover.medium.jpg`,url:'https://www.gutenberg.org/ebooks/'+id,kind:'book',language:'',available:true});
  }
  const metadata={};for(const match of html.matchAll(/<meta\b[^>]*>/giu)){const attr=attributes(match[0]);if(attr.name)metadata[attr.name]=attr.content;}
  if(!items.length&&!Object.hasOwn(metadata,'totalResults'))throw fail('SOURCE_FORMAT','Не удалось прочитать поиск Project Gutenberg',502,'gutenberg');
  const total=Number(metadata.totalResults);return {items,total:Number.isSafeInteger(total)?total:null,hasMore:items.length>0&&Number(metadata.startIndex??1)+items.length<=total};
}

export function splitMvpText(text){
  text=text.replace(/^\uFEFF/u,'').replace(/\r\n?/gu,'\n');
  const start=/\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\n/iu.exec(text);if(start)text=text.slice(start.index+start[0].length);
  const end=/\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK/iu.exec(text);if(end)text=text.slice(0,end.index);
  const paragraphs=text.split(/\n\s*\n/gu).map(part=>part.trim()).filter(Boolean),parts=[];let current=[],size=0;
  for(const paragraph of paragraphs){if(size>=14000&&current.length){parts.push(current);current=[];size=0;}current.push(paragraph);size+=paragraph.length;}
  if(current.length)parts.push(current);return parts;
}

export function createMvpSources({fetchImpl=globalThis.fetch,timeoutMs=18000,pickIndex=length=>randomInt(length)}={}){
  if(typeof fetchImpl!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>45000)throw new TypeError('Неверные параметры источников');
  const extras=[{ids:new Set(EXTRA_BOOK_SOURCES.map(source=>source.id)),adapter:createExtraBookSources({fetchImpl,extractHtml:extractMvpHtml,timeoutMs})},{ids:new Set(EXTRA_NOVEL_SOURCES.map(source=>source.id)),adapter:createExtraNovelSources({fetchImpl,extractHtml:extractMvpHtml,timeoutMs})}];
  const extraFor=source=>extras.find(entry=>entry.ids.has(source))?.adapter;
  const cache=new Map(),pending=new Map();let cacheBytes=0;
  const cached=async(key,operation,ttl=5*60*1000)=>{const hit=cache.get(key);if(hit&&hit.expires>Date.now())return hit.value;if(pending.has(key))return pending.get(key);const promise=(async()=>{const value=await operation(),bytes=Buffer.byteLength(JSON.stringify(value));if(bytes<=24*1024*1024){if(hit){cacheBytes-=hit.bytes;cache.delete(key);}while(cache.size>=80||cacheBytes+bytes>40*1024*1024){const first=cache.keys().next().value;if(first===undefined)break;cacheBytes-=cache.get(first).bytes;cache.delete(first);}cache.set(key,{value,bytes,expires:Date.now()+ttl});cacheBytes+=bytes;}return value;})();pending.set(key,promise);try{return await promise;}finally{pending.delete(key);}};
  const request=async(url,source,{json=true,maxBytes=3*1024*1024,requestTimeoutMs=timeoutMs}={})=>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),requestTimeoutMs);
    try{
      let current=new URL(url),response;
      for(let hop=0;hop<4;hop++){
        const permitted=source==='ranobelib'?current.hostname==='api.cdnlibs.org':source==='wikisource'?current.hostname==='ru.wikisource.org':['gutendex.com','www.gutenberg.org','gutenberg.org','gutenberg.pglaf.org'].includes(current.hostname);
        if(current.protocol!=='https:'||!permitted||current.username||current.password||current.port&&current.port!=='443')throw fail('SOURCE_URL','Источник вернул неподдерживаемую ссылку',502,source);
        response=await fetchImpl(current.href,{redirect:'manual',signal:controller.signal,headers:{...HEADERS,...(source==='ranobelib'?{'Site-Id':'3',Referer:'https://ranobelib.me/'}:{})}});
        if([301,302,303,307,308].includes(response.status)){const location=response.headers.get('location');await response.body?.cancel();if(!location||hop===3)throw fail('SOURCE_REDIRECT','Слишком много перенаправлений источника',502,source);current=new URL(location,current);continue;}break;
      }
      if(!response.ok){await response.body?.cancel();const status=response.status;if(status===429)throw mvpRateLimitError(response,source);throw fail(status===404?'NOT_FOUND':[401,403,451].includes(status)?'SOURCE_RESTRICTED':'SOURCE_UNAVAILABLE',status===404?'Книга или глава не найдена':[401,403,451].includes(status)?'Источник ограничил доступ к этому материалу':'Источник временно недоступен',status===404?404:502,source);}
      if(Number(response.headers.get('content-length'))>maxBytes){await response.body?.cancel();throw fail('SOURCE_LIMIT','Текст превышает ограничение MVP',502,source);}
      const reader=response.body.getReader(),buffers=[];let size=0;
      while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>maxBytes){await reader.cancel();throw fail('SOURCE_LIMIT','Текст превышает ограничение MVP',502,source);}buffers.push(Buffer.from(chunk.value));}
      const body=Buffer.concat(buffers).toString('utf8');if(!json)return body;
      try{return JSON.parse(body);}catch{throw fail('SOURCE_FORMAT','Источник вернул страницу вместо данных',502,source);}
    }catch(error){if(error?.code&&error?.status)throw error;throw fail(controller.signal.aborted?'SOURCE_TIMEOUT':'SOURCE_NETWORK',controller.signal.aborted?'Источник не ответил вовремя. Попробуйте ещё раз.':'Не удалось соединиться с источником',502,source);}finally{clearTimeout(timer);}
  };
  const ranobeCard=item=>{if(!record(item)||!SLUG.test(item.slug_url??'')||item.site!==undefined&&item.site!==3)return null;return {source:'ranobelib',id:item.slug_url,title:plain(item.rus_name||item.name),originalTitle:plain(item.eng_name||item.name),author:(item.authors??[]).map(author=>plain(author.name,120)).join(', '),description:plain(item.summary??item.description??'',2500),cover:safeImage(item.cover?.thumbnail??item.cover?.default),url:'https://ranobelib.me/ru/book/'+item.slug_url,kind:'novel',language:'ru',available:!unavailable(item),status:plain(item.status?.label),ageRating:plain(item.ageRestriction?.label)};};
  const gutenbergCard=item=>{if(!record(item)||!POSITIVE.test(String(item.id))||item.media_type!=='Text')return null;return {source:'gutenberg',id:String(item.id),title:plain(item.title),author:(item.authors??[]).map(author=>plain(author.name,120)).join(', '),description:plain(item.summaries?.[0],2500),cover:safeImage(item.formats?.['image/jpeg']),url:'https://www.gutenberg.org/ebooks/'+item.id,kind:'book',language:(item.languages??[]).join(', '),available:item.copyright===false&&Object.keys(item.formats??{}).some(key=>key.startsWith('text/plain'))};};
  const wikiCard=item=>{const id=String(item.pageid??item.id);if(!POSITIVE.test(id)||typeof item.title!=='string')return null;const author=/\(([^();]+)(?:;[^)]*)?\)(?:\/.*)?$/u.exec(item.title)?.[1]??'';return {source:'wikisource',id,title:plain(item.title),author,description:extractMvpHtml(item.snippet??'').paragraphs.join(' '),cover:null,url:wikiUrl(item.title),kind:'book',language:'ru',available:true};};
  const wikiRequest=params=>request(WIKI+'?'+new URLSearchParams({format:'json',formatversion:'2',utf8:'1',...params}),'wikisource',{maxBytes:12*1024*1024});
  const gutenbergHtmlSearch=async(query,page)=>parseMvpGutenbergSearch(await request('https://www.gutenberg.org/ebooks/search/?'+new URLSearchParams(query?{query:gutenbergMvpTerms(query),...(page>1?{start_index:String((page-1)*25+1)}:{})}:{sort_order:'downloads',start_index:String((page-1)*25+1)}),'gutenberg',{json:false}));
  const gutenbergMeta=async id=>{
    try{return await request(GUT+id+'/','gutenberg',{requestTimeoutMs:Math.min(timeoutMs,6000)});}catch{}
    const html=await request('https://www.gutenberg.org/ebooks/'+id,'gutenberg',{json:false}),fields={};
    for(const match of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)){
      const key=extractMvpHtml(/<th\b[^>]*>([\s\S]*?)<\/th>/iu.exec(match[1])?.[1]??'').paragraphs.join(' '),value=extractMvpHtml(/<td\b[^>]*>([\s\S]*?)<\/td>/iu.exec(match[1])?.[1]??'').paragraphs.join(' ');if(key&&!fields[key])fields[key]=value;
    }
    if(fields['eBook-No.']!==id||!fields.Title)throw fail('SOURCE_IDENTITY','Источник вернул другую книгу',502,'gutenberg');
    const language=/<tr\b[^>]*itemprop=["']inLanguage["'][^>]*content=["']([^"']+)["']/iu.exec(html)?.[1]??'';
    const hasText=[...html.matchAll(/<a\b[^>]*>/giu)].map(match=>attributes(match[0])).some(attr=>attr.type?.startsWith('text/plain')&&new RegExp(`^/ebooks/${id}\\.txt`).test(attr.href??''));
    return {id:Number(id),title:fields.Title,authors:fields.Author?[{name:fields.Author}]:[],media_type:fields.Category==='Text'?'Text':'Unknown',copyright:/Public domain/iu.test(fields.Copyright)?false:null,languages:language?[language]:[],formats:{...(hasText?{'text/plain; charset=utf-8':`https://www.gutenberg.org/ebooks/${id}.txt.utf-8`}:{}),'image/jpeg':`https://www.gutenberg.org/cache/epub/${id}/pg${id}.cover.medium.jpg`}};
  };

  const sourceSearch=async(source,query,page)=>cached(`search:${source}:${page}:${query}`,async()=>{
    const extra=extraFor(source);if(extra)return extra.search(source,query,page);
    if(source==='ranobelib'){
      const result=await request(RANOBE+'?'+new URLSearchParams({'site_id[]':'3',limit:'24',page:String(page),...(query?{q:query.slice(0,150)}:{})}),source);
      if(!Array.isArray(result.data)||result.data.length>100)throw fail('SOURCE_FORMAT','Не удалось прочитать каталог RanobeLib',502,source);
      return {items:result.data.map(ranobeCard).filter(Boolean),total:result.meta?.total??null,hasMore:result.meta?.has_next_page===true||Boolean(result.links?.next)};
    }
    if(source==='gutenberg'){
      // The official catalogue is fast for new searches; the shared Gutendex
      // instance often takes over a minute for previously unseen combinations.
      if(query)return gutenbergHtmlSearch(query,page);
      // Keep the public API's frequently cached query shape. Adding several
      // redundant filters makes otherwise fast catalogue queries take minutes.
      // Availability is checked against each record and again before reading.
      let result;try{result=await request(GUT+'?'+new URLSearchParams({page:String(page)}),source,{requestTimeoutMs:Math.min(timeoutMs,6000)});}catch{return gutenbergHtmlSearch('',page);}
      if(!Array.isArray(result.results)||result.results.length>100)throw fail('SOURCE_FORMAT','Не удалось прочитать каталог Gutenberg',502,source);
      return {items:result.results.map(gutenbergCard).filter(Boolean),total:result.count??null,hasMore:Boolean(result.next)};
    }
    if(query){
      const titleQuery=wikisourceMvpQuery(query);if(!titleQuery)return {items:[],total:0,hasMore:false};
      const result=await wikiRequest({action:'query',list:'search',srsearch:titleQuery,srnamespace:'0',srlimit:'24',sroffset:String((page-1)*24)});
      if(!Array.isArray(result.query?.search))throw fail('SOURCE_FORMAT','Не удалось прочитать поиск Викитеки',502,source);
      return {items:result.query.search.map(wikiCard).filter(Boolean),total:result.query.searchinfo?.totalhits??null,hasMore:Boolean(result.continue)};
    }
    // Actual literary catalogue, rather than the encyclopedia-heavy random-page API.
    const result=await cached('wiki:catalogue',()=>wikiRequest({action:'query',list:'categorymembers',cmtitle:'Категория:Романы',cmtype:'page',cmnamespace:'0',cmlimit:'500'}),30*60*1000);
    if(!Array.isArray(result.query?.categorymembers))throw fail('SOURCE_FORMAT','Не удалось прочитать каталог Викитеки',502,source);
    const items=result.query.categorymembers.map(wikiCard).filter(Boolean);return {items:items.slice((page-1)*24,page*24),total:items.length,hasMore:page*24<items.length,catalogueLimited:Boolean(result.continue)};
  });

  const search=async({query='',q,source='all',page=1}={})=>{
    source=checkedSource(source,true);page=boundedPage(page);query=plain(q??query,501);if(query.length>500)throw fail('INPUT','Поисковый запрос слишком длинный',400);
    const sources=source==='all'?SOURCE_IDS:[source],results=await Promise.all(sources.map(async id=>{try{return {id,status:'ok',...await sourceSearch(id,query,page)};}catch(error){return {id,status:'error',error:{code:error.code??'SOURCE_UNAVAILABLE',message:error.message},items:[],hasMore:false,total:null};}}));
    const errors=results.filter(result=>result.status==='error').map(result=>({source:result.id,...result.error}));
    const lists=results.map(result=>[...result.items]),items=[];while(lists.some(list=>list.length))for(const list of lists)if(list.length)items.push(list.shift());
    return {query,source,page,items,hasMore:results.some(result=>result.hasMore),total:results.every(result=>Number.isInteger(result.total))?results.reduce((sum,result)=>sum+result.total,0):null,sources:results.map(({items,...result})=>({...result,count:items.length})),errors};
  };

  const wikiParsed=(selector,value)=>cached(`wiki:parse:${selector}:${value}`,async()=>{const result=await wikiRequest({action:'parse',[selector]:String(value),prop:'text|links',disablelimitreport:'1'});if(result.error)throw fail('NOT_FOUND','Страница Викитеки не найдена',404,'wikisource');if(!result.parse||typeof result.parse.text!=='string')throw fail('SOURCE_FORMAT','Не удалось прочитать страницу Викитеки',502,'wikisource');return result.parse;});
  const wikiChildren=page=>{
    const allowed=new Set((page.links??[]).filter(link=>link.ns===0&&link.exists===true&&link.title.startsWith(page.title+'/')).map(link=>link.title));
    const ordered=[];for(const link of extractMvpHtml(page.text).links){let title;try{const url=new URL(link.href,'https://ru.wikisource.org');if(url.hostname!=='ru.wikisource.org'||!url.pathname.startsWith('/wiki/'))continue;title=decodeURIComponent(url.pathname.slice(6)).replace(/_/gu,' ');}catch{continue;}if(allowed.has(title)&&!ordered.includes(title))ordered.push(title);}
    for(const title of [...allowed].sort(natural))if(!ordered.includes(title))ordered.push(title);
    // Prefer leaf pages to TOC pages when both are linked by the source.
    return ordered.filter(title=>!ordered.some(other=>other.startsWith(title+'/'))).slice(0,1000);
  };

  const loadBook=async(source,id)=>cached(`book:${source}:${id}`,async()=>{
    if(source==='ranobelib'){
      const [meta,list]=await Promise.all([request(RANOBE+'/'+id+'?fields[]=authors&fields[]=chap_count',source),request(RANOBE+'/'+id+'/chapters',source,{maxBytes:12*1024*1024})]);
      const card=ranobeCard(meta.data);if(!card||String(meta.data.id)!==id.split('--')[0])throw fail('SOURCE_IDENTITY','Источник вернул другую книгу',502,source);
      if(!Array.isArray(list.data)||list.data.length>25000)throw fail('SOURCE_FORMAT','Не удалось прочитать оглавление',502,source);
      const branchMap=new Map(),rawChapters=new Map();
      for(const chapter of list.data){
        if(!record(chapter)||!Array.isArray(chapter.branches))continue;
        const counted=new Set(),availableCounted=new Set();
        for(const branch of chapter.branches){
          const key=String(branch.branch_id??'default');
          if(!branchMap.has(key))branchMap.set(key,{id:key,teams:new Set(),chapterCount:0,availableCount:0});
          const summary=branchMap.get(key);for(const team of branch.teams??[]){const name=plain(team.name,120);if(name)summary.teams.add(name);}
          // One logical branch can contain several teams' releases at the
          // same chapter coordinate. Count the chapter once, not each release.
          if(!counted.has(key)){summary.chapterCount++;counted.add(key);}
          if(!unavailable(branch)&&!unavailable(chapter)&&!availableCounted.has(key)){summary.availableCount++;availableCounted.add(key);}
        }
        const key=`v${chapter.volume}-c${chapter.number}`;if(!/^v\d+(?:\.\d+)?-c\d+(?:\.\d+)?$/u.test(key)||rawChapters.has(key))throw fail('SOURCE_FORMAT','Источник вернул неоднозначное оглавление',502,source);rawChapters.set(key,chapter);
      }
      const branches=[...branchMap.values()].map(({teams,...branch})=>{const name=[...teams].join(', ').slice(0,500)||'Основной перевод';return {...branch,name,title:name,label:name};}).sort((a,b)=>b.availableCount-a.availableCount),defaultBranchId=branches[0]?.id??null;
      const chapters=[...rawChapters].map(([key,chapter])=>{const branchIds=[...new Set(chapter.branches.filter(branch=>!unavailable(branch)&&!unavailable(chapter)).map(branch=>String(branch.branch_id??'default')))];return {id:key,title:plain(chapter.name)||`Глава ${chapter.number}`,number:String(chapter.number),volume:String(chapter.volume),branchId:branchIds.includes(defaultBranchId)?defaultBranchId:branchIds[0]??null,branchIds,available:card.available&&branchIds.length>0};});
      return {public:{...card,chapters,branches,defaultBranchId,chapterCount:chapters.length,coverage:'Доступные главы источника на момент открытия'},rawChapters:Object.fromEntries(rawChapters)};
    }
    if(source==='gutenberg'){
      const meta=await cached(`gut:meta:${id}`,()=>gutenbergMeta(id));const card=gutenbergCard(meta);if(!card||card.id!==id)throw fail('SOURCE_IDENTITY','Источник вернул другую книгу',502,source);
      const entries=Object.entries(meta.formats??{}).filter(([mime])=>mime.startsWith('text/plain')).sort(([a],[b])=>Number(b.includes('utf-8'))-Number(a.includes('utf-8')));if(!card.available||!entries.length)throw fail('SOURCE_RESTRICTED','У книги нет доступного текстового файла',502,source);
      let url;try{url=new URL(entries[0][1]);}catch{throw fail('SOURCE_URL','Нет ссылки на текст книги',502,source);}
      if(!['www.gutenberg.org','gutenberg.org'].includes(url.hostname)||!new RegExp(`^/(?:ebooks/${id}\\.txt\\.utf-8|cache/epub/${id}/pg${id}\\.txt|files/${id}/${id}(?:-0|-8)?\\.txt)$`,'u').test(url.pathname))throw fail('SOURCE_URL','Ссылка на текст не соответствует книге',502,source);
      // Use the deterministic UTF-8 cache file instead of a redirecting format alias.
      const body=await request(`https://www.gutenberg.org/cache/epub/${id}/pg${id}.txt`,source,{json:false,maxBytes:12*1024*1024});
      if(/<html\b|<body\b/iu.test(body.slice(0,2000)))throw fail('SOURCE_FORMAT','Источник вернул страницу вместо текста',502,source);
      const parts=splitMvpText(body);if(!parts.length)throw fail('SOURCE_EMPTY','Текст книги пуст',502,source);
      const chapters=parts.map((part,index)=>({id:String(index+1),title:parts.length===1?'Полный текст':`Часть текста ${index+1}`,number:String(index+1),volume:'1',available:true,branchId:null}));
      return {public:{...card,chapters,branches:[],defaultBranchId:null,chapterCount:chapters.length,coverage:'Полный текст; длинные книги разбиты на части для удобства чтения'},parts};
    }
    let page=await wikiParsed('pageid',id),resolvedFrom=null,children=wikiChildren(page),paragraphs=extractMvpHtml(page.text).paragraphs;
    // Edition-selector pages contain almost no prose. Follow one existing
    // modern edition, while retaining the source edition in the book card.
    if(children.length&&paragraphs.join(' ').length<2200&&children.every(title=>/\/\d{4}(?:\s|\/|$)/u.test(title.slice(page.title.length)))){
      const selected=[...children].sort((a,b)=>Number(b.includes('(СО)'))-Number(a.includes('(СО)'))||b.localeCompare(a,'ru',{numeric:true}))[0];resolvedFrom=page.title;page=await wikiParsed('page',selected);children=wikiChildren(page);paragraphs=extractMvpHtml(page.text).paragraphs;
    }
    const card=wikiCard({pageid:id,title:resolvedFrom??page.title});
    const parts=children.length?[]:splitMvpText(paragraphs.join('\n\n'));
    const chapters=children.length?children.map((title,index)=>({id:title,title:title.slice(page.title.length+1),number:String(index+1),volume:'1',available:true,branchId:null})):parts.map((_,index)=>({id:parts.length===1?'full':`part-${index+1}`,title:parts.length===1?'Полный текст':`Часть текста ${index+1}`,number:String(index+1),volume:'1',available:true,branchId:null}));
    return {public:{...card,edition:resolvedFrom?page.title:undefined,chapters,branches:[],defaultBranchId:null,chapterCount:chapters.length,coverage:'Текст и разделы выбранной страницы Викитеки'},wikiTitle:page.title,paragraphs:parts.length===1?parts[0]:[],parts};
  });

  const book=async(source,id)=>{source=checkedSource(source);const extra=extraFor(source);if(extra)return extra.book(source,id);id=idOf(source,id);return (await loadBook(source,id)).public;};
  const chapter=async(source,id,chapterId,{branchId}={})=>{
    source=checkedSource(source);const extra=extraFor(source);if(extra)return extra.chapter(source,id,chapterId,{branchId});id=idOf(source,id);chapterId=String(chapterId??'');if(chapterId.length>600)throw fail('INPUT','Неверный идентификатор главы',400,source);
    const loaded=await loadBook(source,id),descriptor=loaded.public.chapters.find(item=>item.id===chapterId);if(!descriptor)throw fail('NOT_FOUND','Глава не найдена в оглавлении книги',404,source);if(!descriptor.available)throw fail('SOURCE_RESTRICTED','Источник ограничил доступ к этой главе',502,source);
    let paragraphs,sourceUrl=loaded.public.url,selectedBranch=null;
    if(source==='ranobelib'){
      const raw=loaded.rawChapters[chapterId],selected=String(branchId??descriptor.branchId??loaded.public.defaultBranchId);if(!descriptor.branchIds.includes(selected))throw fail('SOURCE_RESTRICTED','В выбранном переводе эта глава недоступна. Выберите другую ветку.',502,source);
      const params=new URLSearchParams({number:String(raw.number),volume:String(raw.volume)});if(selected!=='default')params.set('branch_id',selected);
      const result=await cached(`ran:chapter:${id}:${chapterId}:${selected}`,()=>request(`${RANOBE}/${id}/chapter?${params}`,source,{maxBytes:4*1024*1024}));const data=result.data;
      // The source chooses one of the inventory's releases for a logical
      // branch. Require the returned exact release ID to exist at THIS chapter
      // coordinate in THIS branch, rather than assuming the first array item.
      const release=record(data)&&POSITIVE.test(String(data.id))?raw.branches.find(item=>String(item.branch_id??'default')===selected&&String(item.id)===String(data.id)):null;
      if(!record(data)||!release||String(data.manga_id)!==id.split('--')[0]||String(data.volume)!==String(raw.volume)||String(data.number)!==String(raw.number)||String(data.branch_id??'default')!==selected)throw fail('SOURCE_IDENTITY','Источник вернул другую главу или перевод',502,source);
      if(unavailable(data)||unavailable(release))throw fail('SOURCE_RESTRICTED','Источник ограничил доступ к этой главе',502,source);paragraphs=extractMvpEditor(data.content);selectedBranch=selected;sourceUrl+=`/read/v${raw.volume}/c${raw.number}`;
    }else if(source==='gutenberg')paragraphs=loaded.parts[Number(chapterId)-1];
    else {if(chapterId==='full')paragraphs=loaded.paragraphs;else if(/^part-\d+$/u.test(chapterId))paragraphs=loaded.parts[Number(chapterId.slice(5))-1];else{if(!chapterId.startsWith(loaded.wikiTitle+'/'))throw fail('INPUT','Глава не принадлежит книге',400,source);const page=await wikiParsed('page',chapterId);paragraphs=extractMvpHtml(page.text).paragraphs;sourceUrl=wikiUrl(page.title);}}
    if(!Array.isArray(paragraphs)||!paragraphs.some(value=>value.trim()))throw fail('SOURCE_EMPTY','Источник не отдал текст главы',502,source);
    return {source,bookId:id,id:chapterId,chapterId,title:descriptor.title,branchId:selectedBranch,paragraphs,text:paragraphs.join('\n\n'),sourceUrl,url:sourceUrl,characterCount:paragraphs.reduce((sum,value)=>sum+value.length,0)};
  };
  const random=async({source='ranobelib'}={})=>{
    checkedSource(source,true);if(source==='all')source=SOURCE_IDS[pickIndex(SOURCE_IDS.length)];
    const extra=extraFor(source);if(extra?.random)return extra.random(source);
    const first=await sourceSearch(source,'',1);let page=1;
    if(source==='ranobelib')page=1+pickIndex(30);else if(Number.isInteger(first.total)&&first.total>0)page=1+pickIndex(Math.max(1,Math.min(source==='gutenberg'?50:5000,Math.ceil(first.total/(source==='gutenberg'?32:24)))));
    let result=first;if(page!==1){try{result=await sourceSearch(source,'',page);}catch{page=1;}}
    if(!result.items.some(item=>item.available)){result=first;page=1;}
    const available=result.items.filter(item=>item.available);if(!available.length)throw fail('SOURCE_EMPTY','В каталоге нет доступных книг',502,source);const selected=available[pickIndex(available.length)];
    return {book:selected,source,selection:{method:'random-existing-catalogue-item',scope:source==='ranobelib'?'Первые 30 страниц каталога':source==='gutenberg'?'Первые 50 страниц каталога':'Первые 500 романов каталога',page,candidates:available.length}};
  };
  return {search,random,book,chapter,sources:MVP_SOURCE_LIST};
}
export const mvpSources=createMvpSources();
