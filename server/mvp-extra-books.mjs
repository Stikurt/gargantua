import {randomInt} from 'node:crypto';
import {mvpRateLimitError} from './mvp-errors.mjs';

export const EXTRA_BOOK_SOURCES=Object.freeze([
  {id:'litlife',name:'ЛитЛайф',kind:'book',description:'Русские книги, авторы и серии. Закрытые правообладателем издания отмечены недоступными.'},
  {id:'libcat',name:'ЛибКат',kind:'book',description:'Русскоязычная библиотека с чтением по страницам.'}
]);
const HOSTS={litlife:'litlife.club',libcat:'libcat.ru'},POSITIVE=/^[1-9]\d{0,8}$/u;
const PATH=/^\/knigi\/(?:[a-z0-9-]+\/){1,6}[1-9]\d{0,8}-[a-z0-9-]{1,250}\.html$/u;
const error=(code,message,status=502,source)=>Object.assign(new Error(message),{code,status,source});
const plain=(value,max=500)=>String(value??'').replace(/[\p{Cc}\p{Cf}]/gu,' ').replace(/\s+/gu,' ').trim().slice(0,max);
const normal=value=>plain(value).normalize('NFKC').toLowerCase().replace(/ё/gu,'е').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const entities={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',mdash:'—',ndash:'–',hellip:'…',laquo:'«',raquo:'»',shy:''};
const decode=value=>String(value??'').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu,(all,key)=>{if(key[0]!=='#')return entities[key]??all;const number=parseInt(key.slice(/^#x/i.test(key)?2:1),/^#x/i.test(key)?16:10);return number>0&&number<=0x10ffff&&!(number>=0xd800&&number<=0xdfff)?String.fromCodePoint(number):'';});
const attrs=token=>Object.fromEntries([...token.matchAll(/([a-z][a-z0-9:_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/giu)].map(m=>[m[1].toLowerCase(),decode(m[2]??m[3]??m[4])]));
const has=(node,name)=>(node.attrs.class??'').split(/\s+/u).includes(name);
const find=(root,predicate)=>root.nodes.filter(predicate);
const first=(root,predicate)=>root.nodes.find(predicate);
const descendant=(root,node,predicate)=>root.nodes.find(child=>child.start>node.start&&child.end<=node.end&&predicate(child));
const inside=(root,node)=>root.html.slice(node.openEnd,node.closeStart);

/** Bounded HTML index. We never execute source scripts or render source HTML. */
function parse(html){
  const root={html,nodes:[]},stack=[];let count=0;
  for(const match of html.matchAll(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>|<\/?[a-z][^>]*>/giu)){
    if(++count>150000)throw error('SOURCE_FORMAT','Слишком сложная страница книги');
    const token=match[0];if(token.startsWith('<!--')||/^<(script|style)\b/iu.test(token))continue;
    const parts=/^<(\/?)([a-z][\w:-]*)/iu.exec(token);if(!parts)continue;const tag=parts[2].toLowerCase();
    if(parts[1]){const index=stack.map(n=>n.tag).lastIndexOf(tag);if(index>=0){for(const node of stack.slice(index)){node.closeStart=match.index;node.end=match.index+token.length;}stack.length=index;}continue;}
    const node={tag,attrs:attrs(token),start:match.index,openEnd:match.index+token.length,closeStart:html.length,end:html.length,parent:stack.at(-1)};root.nodes.push(node);
    if(!/^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/u.test(tag)&&!token.endsWith('/>'))stack.push(node);
    if(stack.length>150)throw error('SOURCE_FORMAT','Слишком глубокая разметка книги');
  }
  return root;
}
const fallbackExtract=html=>({paragraphs:html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu,'').replace(/<\/(?:p|div|h[1-6]|blockquote)>|<br\s*\/?\s*>/giu,'\n').replace(/<[^>]*>/gu,'').split(/\n+/u).map(x=>plain(decode(x),30000)).filter(Boolean)});

export function createExtraBookSources({fetchImpl=globalThis.fetch,extractHtml=fallbackExtract,timeoutMs=18000}={}){
  if(typeof fetchImpl!=='function'||typeof extractHtml!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>45000)throw new TypeError('Неверные параметры книжных источников');
  const text=(root,node)=>node?plain(extractHtml(inside(root,node)).paragraphs.join(' '),5000):'';
  const cache=new Map(),pending=new Map();let bytes=0;
  const cached=async(key,operation)=>{const hit=cache.get(key);if(hit?.expires>Date.now())return hit.value;if(pending.has(key))return pending.get(key);const work=(async()=>{const value=await operation(),size=Buffer.byteLength(JSON.stringify(value));if(size<=8*1024*1024){if(hit){bytes-=hit.size;cache.delete(key);}while(cache.size>=100||bytes+size>24*1024*1024){const oldest=cache.keys().next().value;if(oldest===undefined)break;bytes-=cache.get(oldest).size;cache.delete(oldest);}cache.set(key,{value,size,expires:Date.now()+300000});bytes+=size;}return value;})();pending.set(key,work);try{return await work;}finally{pending.delete(key);}};
  const sourceOf=source=>{if(!Object.hasOwn(HOSTS,source))throw error('INPUT','Неизвестный книжный источник',400);return source;};
  const pathOf=(source,id)=>{sourceOf(source);id=String(id??'');if(source==='litlife'){if(!POSITIVE.test(id))throw error('INPUT','Неверный идентификатор книги',400);return '/books/'+id;}if(!/^[A-Za-z0-9_-]{10,750}$/u.test(id))throw error('INPUT','Неверный идентификатор книги',400);const path=Buffer.from(id,'base64url').toString('utf8');if(!PATH.test(path)||Buffer.from(path).toString('base64url')!==id)throw error('INPUT','Неверный идентификатор книги',400);return path;};
  const checkedUrl=(source,value)=>{let url;try{url=new URL(value,'https://'+HOSTS[source]);}catch{throw error('SOURCE_URL','Неверная ссылка источника',502,source);}if(url.protocol!=='https:'||url.hostname!==HOSTS[source]||url.username||url.password||url.port&&url.port!=='443')throw error('SOURCE_URL','Источник вернул неподдерживаемую ссылку',502,source);return url;};
  const request=async(source,path)=>cached('html:'+source+':'+path,async()=>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);try{
      let url=checkedUrl(source,path),response;
      for(let hop=0;hop<4;hop++){
        response=await fetchImpl(url.href,{redirect:'manual',signal:controller.signal,headers:{'User-Agent':'Gargantua-MVP/1.0 (personal desktop reader)',Accept:'text/html'}});
        if([301,302,303,307,308].includes(response.status)){const location=response.headers.get('location');await response.body?.cancel();if(!location||hop===3)throw error('SOURCE_REDIRECT','Слишком много перенаправлений',502,source);url=checkedUrl(source,new URL(location,url).href);continue;}break;
      }
      if(!response.ok){await response.body?.cancel();if(response.status===429)throw mvpRateLimitError(response,source);throw error(response.status===404?'NOT_FOUND':[401,403,451].includes(response.status)?'SOURCE_RESTRICTED':'SOURCE_UNAVAILABLE',response.status===404?'Книга или страница не найдена':[401,403,451].includes(response.status)?'Источник закрыл доступ к этой книге':'Источник временно недоступен',response.status===404?404:502,source);}
      const limit=4*1024*1024;if(Number(response.headers.get('content-length'))>limit){await response.body?.cancel();throw error('SOURCE_LIMIT','Страница превышает ограничение',502,source);}const reader=response.body.getReader(),buffers=[];let size=0;while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>limit){await reader.cancel();throw error('SOURCE_LIMIT','Страница превышает ограничение',502,source);}buffers.push(Buffer.from(chunk.value));}
      const data=Buffer.concat(buffers),head=data.subarray(0,5000).toString('ascii'),encoding=response.headers.get('content-type')?.match(/charset=["']?([\w-]+)/iu)?.[1]??head.match(/charset=["']?([\w-]+)/iu)?.[1]??'utf-8';let html;try{html=new TextDecoder(encoding).decode(data);}catch{html=data.toString('utf8');}if(/<title>\s*(?:Just a moment|Access denied)|cf-chl-|captcha-container/iu.test(html))throw error('SOURCE_RESTRICTED','Источник требует проверку доступа',502,source);return html;
    }catch(e){if(e.code&&e.status)throw e;throw error(controller.signal.aborted?'SOURCE_TIMEOUT':'SOURCE_NETWORK',controller.signal.aborted?'Источник не ответил вовремя':'Не удалось соединиться с источником',502,source);}finally{clearTimeout(timer);}
  });
  const card=(source,id,title,author='',description='',available=true)=>({source,id,title:plain(title),author:plain(author),description:plain(description,2500),url:'https://'+HOSTS[source]+pathOf(source,id),cover:null,kind:'book',language:'ru',available});
  const checkIdentity=(source,root,path,page)=>{
    const canonical=first(root,n=>n.tag==='link'&&n.attrs.rel==='canonical');let url;try{url=checkedUrl(source,canonical?.attrs.href??'');}catch{throw error('SOURCE_IDENTITY','Источник вернул другую книгу',502,source);}
    if(!canonical||url.pathname!==path||page!==undefined&&source==='litlife'&&Number(url.searchParams.get('page')??1)!==page)throw error('SOURCE_IDENTITY','Источник вернул другую книгу или страницу',502,source);
    if(page!==undefined&&source==='libcat'&&Number(first(root,n=>n.attrs.id==='read')?.attrs['data-cur'])!==page)throw error('SOURCE_IDENTITY','Источник вернул другую страницу книги',502,source);
  };
  const positivePage=value=>{const page=Number(value??1);if(!Number.isSafeInteger(page)||page<1||page>5000)throw error('INPUT','Неверный номер страницы',400);return page;};
  const pagination=(root,page)=>find(root,n=>n.tag==='a'&&typeof n.attrs.href==='string').some(n=>{try{return Number(new URL(n.attrs.href,'https://litlife.club').searchParams.get('page'))>page;}catch{return false;}});
  const litlifeCards=(html,series='')=>{
    const root=parse(html),items=[];for(const heading of find(root,n=>n.tag==='h3')){
      const link=descendant(root,heading,n=>n.tag==='a'&&/^https:\/\/litlife\.club\/books\/[1-9]\d*$/u.test(n.attrs.href??''));if(!link)continue;
      const id=link.attrs.href.split('/').at(-1);let container=heading.parent;while(container?.parent&&!has(container,'card-body')&&container.tag!=='tr')container=container.parent;
      const author=container?find(root,n=>n.start>container.start&&n.end<=container.end&&n.tag==='a'&&has(n,'author')).map(n=>text(root,n)).join(', '):'';
      const available=container?find(root,n=>n.start>container.start&&n.end<=container.end&&n.tag==='a'&&n.attrs.href===`https://litlife.club/books/${id}/read/online`).length>0:true;
      items.push(card('litlife',id,text(root,link),author,series?`Серия: ${series}`:'',container?.tag==='tr'||available));
    }return {items,root};
  };
  const libcatCards=html=>{
    const root=parse(html),items=[];for(const node of find(root,n=>has(n,'tg-postbook'))){const titleNode=descendant(root,node,n=>has(n,'tg-booktitle')),link=titleNode&&descendant(root,titleNode,n=>n.tag==='a'&&PATH.test(n.attrs.href??''));if(!link)continue;const author=descendant(root,node,n=>has(n,'tg-bookwriter'));items.push(card('libcat',Buffer.from(link.attrs.href).toString('base64url'),text(root,link),text(root,author)));}return {items,root};
  };
  const matches=(item,query)=>{const words=normal(query).split(' ').filter(x=>x.length>1&&!['в','во','на','и','с','по','из'].includes(x)),haystack=normal(item.title+' '+item.author+' '+item.description);return words.every(word=>haystack.includes(word));};
  const search=async(source,query='',page=1)=>{
    sourceOf(source);page=positivePage(page);if(typeof query!=='string'||query.length>200)throw error('INPUT','Слишком длинный поисковый запрос',400);query=plain(query,150).replace(/ё/gu,'е').replace(/Ё/gu,'Е').replace(/[‐‑‒–—]/gu,'-');
    return cached(`search:${source}:${query}:${page}`,async()=>{
      if(source==='libcat'){
        const path=query?'/search/?'+new URLSearchParams({q:query,...(page>1?{page:String(page)}:{})}):page===1?'/':'/page/'+page+'/',{items,root}=libcatCards(await request(source,path));
        const filtered=query?items.filter(item=>matches(item,query)):items;return {items:filtered.slice(0,48),total:null,hasMore:pagination(root,page)};
      }
      const url='/books?'+new URLSearchParams({...query?{search:query}:{},page:String(page)}),direct=litlifeCards(await request(source,url));let items=direct.items,hasMore=pagination(direct.root,page);
      if(query){
        const sequences=parse(await request(source,'/sequences?'+new URLSearchParams({search:query,order:'book_count_desc'})));
        const links=find(sequences,n=>n.tag==='a'&&has(n,'sequence')&&/^https:\/\/litlife\.club\/sequences\/[1-9]\d*$/u.test(n.attrs.href??'')).map(n=>({href:n.attrs.href,label:text(sequences,n)})).filter(n=>normal(n.label).includes(normal(query))).sort((a,b)=>(normal(a.label)===normal(query)?-1:normal(b.label)===normal(query)?1:0));
        for(const sequence of links.slice(0,3)){const parsed=litlifeCards(await request(source,sequence.href+'?page='+page),sequence.label);items.push(...parsed.items);hasMore||=pagination(parsed.root,page);}
      }
      items=[...new Map(items.map(item=>[item.id,item])).values()];return {items:items.slice(0,72),total:null,hasMore};
    });
  };
  const book=async(source,id)=>{
    const path=pathOf(source,id);id=String(id);return cached('book:'+source+':'+id,async()=>{
      const html=await request(source,path),root=parse(html);checkIdentity(source,root,path);let metadata,reader,count=0,available=true;
      if(source==='litlife'){
        const heading=first(root,n=>n.tag==='h2'&&has(n,'title')&&n.attrs.itemprop==='name');if(!heading)throw error('SOURCE_FORMAT','Не удалось прочитать карточку книги',502,source);
        const author=first(root,n=>n.attrs.itemprop==='author'),description=first(root,n=>n.attrs.id==='annotation');
        available=!/Эта книга недоступна для чтения и скачивания/iu.test(html)&&find(root,n=>n.tag==='a'&&n.attrs.href===`https://litlife.club/books/${id}/read/online`).length>0;
        metadata=card(source,id,text(root,heading),text(root,author),text(root,description),available);
        if(available){reader=parse(await request(source,path+'/read'));checkIdentity(source,reader,path+'/read',1);if(!first(reader,n=>has(n,'page_text')))throw error('SOURCE_FORMAT','Источник не вернул текст книги',502,source);count=Math.max(1,...find(reader,n=>n.tag==='a'&&typeof n.attrs.href==='string').map(n=>{try{const url=checkedUrl(source,n.attrs.href);return url.pathname===path+'/read'?Number(url.searchParams.get('page')??1):0;}catch{return 0;}}).filter(Number.isSafeInteger));}
      }else{
        const read=first(root,n=>n.attrs.id==='read'),title=first(root,n=>n.attrs.itemprop==='name'&&n.tag==='div'),author=first(root,n=>n.attrs.itemprop==='author'),description=first(root,n=>n.attrs.itemprop==='about');
        if(!title)throw error('SOURCE_FORMAT','Не удалось прочитать карточку книги',502,source);available=Boolean(read);metadata=card(source,id,text(root,title),text(root,author),text(root,description),available);count=Number(read?.attrs['data-count']??0);
      }
      if(!Number.isSafeInteger(count)||count<0||count>20000)throw error('SOURCE_LIMIT','Некорректное число страниц книги',502,source);
      return {...metadata,chapters:Array.from({length:count},(_,index)=>({id:String(index+1),title:'Страница '+(index+1),number:String(index+1),volume:'',available:true})),chapterCount:count,readingUnit:'page',...(available?{}:{availabilityNote:'Издание закрыто источником для чтения'})};
    });
  };
  const chapter=async(source,id,chapterId)=>{
    const path=pathOf(source,id);if(!POSITIVE.test(String(chapterId??'')))throw error('INPUT','Неверный номер страницы',400);chapterId=String(chapterId);const loaded=await book(source,id);if(!loaded.available)throw error('SOURCE_RESTRICTED','Источник закрыл доступ к этой книге',502,source);if(Number(chapterId)>loaded.chapters.length)throw error('NOT_FOUND','Страница книги не найдена',404,source);
    return cached(`chapter:${source}:${id}:${chapterId}`,async()=>{
      const chapterPath=source==='litlife'?path+'/read?page='+chapterId:chapterId==='1'?path:path.replace(/\/(\d+)-([^/]+)\.html$/u,`/$1-${chapterId}-$2.html`),sourceUrl='https://'+HOSTS[source]+chapterPath,html=await request(source,chapterPath),root=parse(html),reader=first(root,n=>source==='litlife'?has(n,'page_text'):n.attrs.id==='read');
      checkIdentity(source,root,source==='litlife'?path+'/read':path,Number(chapterId));if(!reader)throw error('SOURCE_FORMAT','Источник не вернул текст страницы',502,source);let fragment=inside(root,reader);
      const omitted=find(root,n=>n.start>=reader.openEnd&&n.end<=reader.closeStart&&(has(n,'navigation')||has(n,'cpab')||has(n,'load_text')||/^read_online_ad$|^yandex_rtb/iu.test(n.attrs.id??''))).filter((n,i,list)=>!list.some((p,j)=>i!==j&&p.start<n.start&&p.end>=n.end)).sort((a,b)=>b.start-a.start);
      for(const node of omitted){const start=node.start-reader.openEnd,end=node.end-reader.openEnd;fragment=fragment.slice(0,start)+fragment.slice(end);}
      const paragraphs=extractHtml(fragment).paragraphs.map(p=>plain(p,30000)).filter(Boolean);if(paragraphs.join('').length<50)throw error('SOURCE_FORMAT','На странице не найден читаемый текст',502,source);return {title:'Страница '+chapterId,paragraphs,text:paragraphs.join('\n\n'),sourceUrl};
    });
  };
  const random=async(source)=>{const result=await search(source,'',1),available=result.items.filter(item=>item.available);if(!available.length)throw error('NOT_FOUND','В каталоге не найдено доступных книг',404,source);return {book:available[randomInt(available.length)],source,selection:{method:'random-existing-catalogue-item',scope:'Первая страница живого каталога',page:1,candidates:available.length}};};
  return {search,book,chapter,random};
}
