import test from 'node:test';
import assert from 'node:assert/strict';
import {createExtraBookSources,EXTRA_BOOK_SOURCES} from '../server/mvp-extra-books.mjs';

const html=value=>new Response(value,{headers:{'content-type':'text/html; charset=utf-8'}});
const path='/knigi/fantastika-i-fjentezi/uzhasy-i-mistika/430898-robert-chambers-korol-v-zheltom.html';
const libcatId=Buffer.from(path).toString('base64url');
const paragraph='Русский текст книги для чтения. Достаточно длинный абзац, проверяющий настоящий текст страницы.';
const libcatSearch=(title='Король в Желтом',author='Роберт Чамберс',p=path)=>`<div class="tg-postbook"><span class="tg-bookwriter">${author}</span><div class="tg-booktitle"><h3><a href="${p}">${title}</a></h3></div></div>`;
const libcatBook=(page=1)=>`<link rel="canonical" href="https://libcat.ru${path}"><div itemprop="name">Король в Желтом</div><a itemprop="author">Роберт Чамберс</a><div itemprop="about">Аннотация</div><div id="read" data-count="3" data-cur="${page}"><div class="navigation"><p>Навигация 1 2 3</p></div><div class="cpab"><p>Реклама</p></div><p>${paragraph}</p><p>Второй абзац.</p><script>malicious()</script><a class="load_text">Читать дальше</a></div>`;
const lifeCard=(id,title,author='Автор',available=true)=>`<div class="card-body"><h3><a href="https://litlife.club/books/${id}">${title}</a></h3><a class="author name">${author}</a>${available?`<a href="https://litlife.club/books/${id}/read/online">Читать онлайн</a>`:''}</div>`;
const lifeBook=(id,available=true)=>`<link rel="canonical" href="https://litlife.club/books/${id}"><h2 class="title" itemprop="name">Настоящая книга</h2><h3 itemprop="author">Настоящий автор</h3><div id="annotation">Описание</div>${available?`<a href="https://litlife.club/books/${id}/read/online">Читать онлайн</a>`:'<script>var s="Эта книга недоступна для чтения и скачивания"</script>'}`;
const lifeRead=(id,page=1)=>`<link rel="canonical" href="https://litlife.club/books/${id}/read?page=${page}"><div class="page_text"><p>${paragraph}</p><div id="read_online_ad"><p>Рекламный шум</p></div></div><ul class="pagination"><a href="https://litlife.club/books/${id}/read?page=3">3</a></ul>`;

test('two real Russian catalogues are declared and adapter methods are usable',()=>{
 assert.deepEqual(EXTRA_BOOK_SOURCES.map(s=>s.id),['litlife','libcat']);
 assert.ok(EXTRA_BOOK_SOURCES.every(s=>s.kind==='book'&&s.description));
});

test('Russian ё/е share one live search request; irrelevant broad matches are excluded',async()=>{
 const calls=[],adapter=createExtraBookSources({fetchImpl:async u=>{calls.push(u);return html(libcatSearch()+libcatSearch('Железный король','Другой автор','/knigi/fentezi/999-another.html'));}});
 const first=await adapter.search('libcat','Король в жёлтом'),second=await adapter.search('libcat','Король в желтом');
 assert.equal(calls.length,1);assert.equal(new URL(calls[0]).searchParams.get('q'),'Король в желтом');
 assert.equal(first.items.length,1);assert.equal(first.items[0].author,'Роберт Чамберс');assert.deepEqual(first,second);
});

test('series discovery follows real catalogue links and returns dynamic concrete books',async()=>{
 const calls=[],adapter=createExtraBookSources({fetchImpl:async u=>{calls.push(u);const url=new URL(u);if(url.pathname==='/books')return html(lifeCard('901','Коты-воители: Атлас','Новый автор'));if(url.pathname==='/sequences')return html('<a class="sequence name" href="https://litlife.club/sequences/456">Коты-воители</a><a class="sequence name" href="https://evil.test/sequences/4">Коты-воители</a>');if(url.pathname==='/sequences/456')return html('<table><tr><td><h3><a href="https://litlife.club/books/902">Новая книга серии</a></h3></td><td><a class="author name">Хантер Эрин</a></td></tr></table>');throw Error('Unexpected URL');}});
 const result=await adapter.search('litlife','Коты–воители');
 assert.deepEqual(result.items.map(x=>x.id),['901','902']);assert.equal(result.items[1].description,'Серия: Коты-воители');assert.equal(result.items[1].author,'Хантер Эрин');
 assert.ok(calls.every(u=>new URL(u).hostname==='litlife.club'));assert.equal(calls.length,3);
});

test('Libcat book has complete page inventory and chapter two uses its own page URL',async()=>{
 const calls=[],adapter=createExtraBookSources({fetchImpl:async u=>{calls.push(u);return html(libcatBook(u.includes('430898-2-')?2:1));}});
 const book=await adapter.book('libcat',libcatId);assert.equal(book.title,'Король в Желтом');assert.equal(book.chapterCount,3);assert.equal(book.language,'ru');
 const chapter=await adapter.chapter('libcat',libcatId,'2');assert.equal(chapter.sourceUrl,'https://libcat.ru'+path.replace('430898-','430898-2-'));
 assert.ok(chapter.text.includes(paragraph));assert.equal(chapter.paragraphs.length,2);assert.doesNotMatch(chapter.text,/Навигация|Реклама|malicious|Читать дальше/u);assert.equal(calls.length,2);
});

test('Litlife book inventory and cached page contain prose without advertising',async()=>{
 const calls=[],adapter=createExtraBookSources({fetchImpl:async u=>{calls.push(u);return html(new URL(u).pathname.endsWith('/read')?lifeRead('91'):lifeBook('91'));}});
 const book=await adapter.book('litlife','91'),chapter=await adapter.chapter('litlife','91','1');assert.equal(book.chapters.length,3);assert.equal(book.author,'Настоящий автор');assert.equal(chapter.text,paragraph);assert.equal(calls.length,3);assert.match(calls[2],/read\?page=1$/u);
 await adapter.chapter('litlife','91','1');assert.equal(calls.length,3);
});

test('closed rightsholder edition stays unavailable and no reader endpoint is attempted',async()=>{
 const calls=[],adapter=createExtraBookSources({fetchImpl:async u=>{calls.push(u);return html(lifeBook('91',false));}});
 const book=await adapter.book('litlife','91');assert.equal(book.available,false);assert.deepEqual(book.chapters,[]);
 await assert.rejects(()=>adapter.chapter('litlife','91','1'),{code:'SOURCE_RESTRICTED'});assert.equal(calls.length,1);
});

test('IDs and source parameters reject URLs, traversal, noncanonical base64 and oversized pages before network',async()=>{
 let requests=0;const adapter=createExtraBookSources({fetchImpl:async()=>{requests++;throw Error('must not fetch');}});
 for(const id of ['https://evil.test','../1','01','1?host=evil.test','1/../2'])await assert.rejects(()=>adapter.book('litlife',id),{code:'INPUT'});
 for(const path of ['/knigi/../private/1-a.html','https://evil.test/1-a.html','/knigi/a/1-a.html?token=x','/knigi/a/%2e%2e/1-a.html'])await assert.rejects(()=>adapter.book('libcat',Buffer.from(path).toString('base64url')),{code:'INPUT'});
 await assert.rejects(()=>adapter.book('unknown','1'),{code:'INPUT'});await assert.rejects(()=>adapter.search('libcat','a',5001),{code:'INPUT'});await assert.rejects(()=>adapter.chapter('litlife','1','1e3'),{code:'INPUT'});assert.equal(requests,0);
});

test('chapter must belong to selected book inventory',async()=>{
 let calls=0;const adapter=createExtraBookSources({fetchImpl:async()=>{calls++;return html(libcatBook());}});
 await assert.rejects(()=>adapter.chapter('libcat',libcatId,'4'),{code:'NOT_FOUND'});assert.equal(calls,1);
});

test('a successful response cannot silently substitute another book or repeat the first page',async()=>{
 const wrongBook=createExtraBookSources({fetchImpl:async()=>html(lifeBook('92'))});await assert.rejects(()=>wrongBook.book('litlife','91'),{code:'SOURCE_IDENTITY'});
 const repeated=createExtraBookSources({fetchImpl:async()=>html(libcatBook(1))});await assert.rejects(()=>repeated.chapter('libcat',libcatId,'2'),{code:'SOURCE_IDENTITY'});
 const wrongPage=createExtraBookSources({fetchImpl:async u=>html(new URL(u).pathname.endsWith('/read')?lifeRead('91',1):lifeBook('91'))});await assert.rejects(()=>wrongPage.chapter('litlife','91','2'),{code:'SOURCE_IDENTITY'});
});

test('redirect to another host is rejected before following it',async()=>{
 const calls=[],adapter=createExtraBookSources({fetchImpl:async(u,options)=>{calls.push(u);assert.equal(options.redirect,'manual');return new Response(null,{status:302,headers:{location:'https://evil.test/private'}});}});
 await assert.rejects(()=>adapter.book('litlife','91'),{code:'SOURCE_URL'});assert.equal(calls.length,1);
});

test('source byte limit applies both declared length and streamed bytes',async()=>{
 const declared=createExtraBookSources({fetchImpl:async()=>new Response('x',{headers:{'content-length':String(5*1024*1024)}})});
 await assert.rejects(()=>declared.book('litlife','91'),{code:'SOURCE_LIMIT'});
 const streamed=createExtraBookSources({fetchImpl:async()=>new Response(new Uint8Array(4*1024*1024+1))});
 await assert.rejects(()=>streamed.book('litlife','91'),{code:'SOURCE_LIMIT'});
});

test('legacy cp1251 metadata and body are decoded without replacement characters',async()=>{
 const cp1251=value=>Uint8Array.from([...value].map(c=>c.charCodeAt(0)>=1040&&c.charCodeAt(0)<=1103?c.charCodeAt(0)-848:c==='ё'?184:c==='Ё'?168:c.charCodeAt(0)));
 const adapter=createExtraBookSources({fetchImpl:async()=>new Response(cp1251(libcatBook()),{headers:{'content-type':'text/html; charset=windows-1251'}})});
 const book=await adapter.book('libcat',libcatId),chapter=await adapter.chapter('libcat',libcatId,'1');assert.equal(book.author,'Роберт Чамберс');assert.ok(chapter.text.includes(paragraph));assert.doesNotMatch(chapter.text,/�/u);
});

test('rate limits and CAPTCHA stay clear source errors without automatic bypass',async()=>{
 let calls=0;const adapter=createExtraBookSources({fetchImpl:async()=>{calls++;return new Response('slow',{status:429});}});
 await assert.rejects(()=>adapter.search('libcat','Запрос'),{code:'SOURCE_RATE_LIMIT',status:429,retryAfterMs:60000});assert.equal(calls,1);
 const challenge=createExtraBookSources({fetchImpl:async()=>html('<title>Just a moment...</title>')});await assert.rejects(()=>challenge.book('litlife','91'),{code:'SOURCE_RESTRICTED'});
});

test('random selection uses current catalogue records',async()=>{
 const adapter=createExtraBookSources({fetchImpl:async()=>html(libcatSearch())});const chosen=await adapter.random('libcat');assert.equal(chosen.book.id,libcatId);assert.equal(chosen.selection.candidates,1);
});
