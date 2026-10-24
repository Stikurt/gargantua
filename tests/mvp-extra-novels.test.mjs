import test from 'node:test';
import assert from 'node:assert/strict';
import {createExtraNovelSources,mvpNovelsCoordinates,mvpNovelsFlightObjects,EXTRA_NOVEL_SOURCES} from '../server/mvp-extra-novels.mjs';
import {extractMvpHtml} from '../server/mvp-sources.mjs';
const json=x=>new Response(JSON.stringify(x),{headers:{'Content-Type':'application/json'}});
const html=x=>new Response(x);
const flight=x=>'<script>self.__next_f.push('+JSON.stringify([1,'1:'+JSON.stringify(x)+'\n'])+')</script>';
const meBook='<div id="fic_id">297</div><h1>Верховный Маг</h1><div class="title">Названия ранобэ:</div><div class="content">The Supreme Magus<br>Верховный Маг</div><a href="/catalog/author/276">Legion20</a><ul class="FicContents"><li><a href="/ranobe297/0">Глава 1. Пролог</a></li></ul><ul class="FicContents"><li><a href="/ranobe297/1167">Глава 1166. Сила Хаоса. Часть 2</a></li><li><a href="/ranobe297/4509">Глава 4508. Не гибрид. Часть 2</a></li></ul>';
const meChapter=(parent=297)=>`Ранобэ: <a href="/ranobe${parent}">Верховный Маг</a><h1>Глава 1166. Сила Хаоса. Часть 2</h1><div class="chapter activeurl" id="c1167"><p class="fict" id="c1167p1">Текст настоящей главы на русском языке, который остаётся инертным.</p><p class="fict" id="c1167p2">Второй абзац <script>evil()</script>текста &amp; продолжение.</p></div>`;
const hubMeta=flight({bookId:964,slug:'supreme-magus',volumes:[{number:1,chapterCount:3,chapters:[]}]})+'<h1>Верховный Маг</h1><p class="book-original-title">Supreme Magus</p><a class="book-credit-chip is-author"><strong>Legion20</strong></a>';
const hubChapter=(id,number,title,extras={})=>({id,bookId:964,volume:1,number,title,scheduledFor:null,...extras});
const first=hubChapter(100,1,'Глава 1. Начало'),second=hubChapter(101,2158,'Глава 2091. Резко обернувшись'),third=hubChapter(102,2159,'Послесловие',{isPaid:true});

test('two distinct live novel catalogues expose truthful source identities',()=>{
  assert.deepEqual(EXTRA_NOVEL_SOURCES.map(x=>x.id),['ranobeme','ranobehub']);assert.ok(EXTRA_NOVEL_SOURCES.every(x=>x.kind==='novel'));
  assert.deepEqual(mvpNovelsCoordinates('Глава 1166. Сила Хаоса. Часть 2'),{number:'1166',part:'2'});
  assert.deepEqual(mvpNovelsCoordinates('Том 3. Глава 2,5 — продолжение'),{number:'2.5',volume:'3'});
  assert.deepEqual(mvpNovelsCoordinates('Послесловие'),{number:''});
});

test('Ranobe.me follows every sibling TOC list and source chapter numbers rather than URL offsets',async()=>{
  const calls=[];const adapter=createExtraNovelSources({extractHtml:extractMvpHtml,fetchImpl:async url=>{calls.push(url);return html(url.includes('/1167')?meChapter():meBook);}});
  const book=await adapter.book('ranobeme','297');assert.equal(book.author,'Legion20');assert.equal(book.originalTitle,'The Supreme Magus');assert.equal(book.numbering,'global');assert.equal(book.chapters.length,3);
  assert.equal(book.chapters[1].number,'1166');assert.equal(book.chapters[1].id,'1167');assert.equal(book.chapters[2].number,'4508');assert.equal(book.chapters[2].part,'2');
  const chapter=await adapter.chapter('ranobeme','297','1167');assert.equal(chapter.sourceUrl,'https://ranobe.me/ranobe297/1167');assert.equal(chapter.paragraphs.length,2);assert.ok(!chapter.text.includes('evil'));
  await adapter.chapter('ranobeme','297','1167');assert.equal(calls.length,2,'book and chapter caches coalesce repeated source requests');
  await assert.rejects(adapter.chapter('ranobeme','297','999'),{code:'NOT_FOUND'});assert.equal(calls.length,2,'foreign chapter IDs never reach the source');
});

test('Ranobe.me verifies the parent book independently of chapter offset and title',async()=>{
  const adapter=createExtraNovelSources({extractHtml:extractMvpHtml,fetchImpl:async url=>html(url.includes('/1167')?meChapter(999):meBook)});
  await assert.rejects(adapter.chapter('ranobeme','297','1167'),{code:'SOURCE_IDENTITY'});
});

test('Ranobe.me Russian search uses its actual query field, and a genuine empty catalogue differs from an error page',async()=>{
  const urls=[];const adapter=createExtraNovelSources({extractHtml:extractMvpHtml,fetchImpl:async url=>{urls.push(url);return html(url.includes('page=2')?'ничего не найдено.<br>Попробуйте смягчить условия поиска.':'<h1>Найдено 1 ранобэ</h1><div id="fic_297" class="FicTable"><a href="/ranobe297">Верховный Маг</a><span class="ChaptersCount">4510</span><div class="FicTable_Description">Русское описание.</div></div>');}});
  const found=await adapter.search('ranobeme','Верховный Маг');assert.equal(new URL(urls[0]).searchParams.get('str'),'Верховный Маг');assert.equal(new URL(urls[0]).searchParams.get('section'),'search');assert.equal(found.items[0].chapterCount,4510);assert.equal(found.items[0].source,'ranobeme');
  assert.deepEqual(await adapter.search('ranobeme','Не существует',2),{items:[],total:0,hasMore:false});
  await assert.rejects(createExtraNovelSources({fetchImpl:async()=>html('<h1>Access denied</h1>')}).search('ranobeme','x'),{code:'SOURCE_FORMAT'});
});

test('RanobeHub reads catalogue JSON data without executing source scripts',async()=>{
  const data={items:[{id:964,slug:'supreme-magus',title:'Верховный Маг',originalTitle:'Supreme Magus',chapters:516}],total:1};
  const adapter=createExtraNovelSources({extractHtml:extractMvpHtml,fetchImpl:async()=>html(flight({result:data})+'<script>globalThis.pwned=true</script>')});
  const result=await adapter.search('ranobehub','Верховный Маг');assert.equal(result.items[0].id,'964-supreme-magus');assert.equal(result.items[0].chapterCount,516);assert.equal(result.hasMore,false);assert.equal(globalThis.pwned,undefined);
  assert.ok(mvpNovelsFlightObjects(flight({result:data})).some(x=>Array.isArray(x.items)));
});

test('the complete RanobeHub catalogue survives adjacent byte-framed Flight text records',async()=>{
  const data={items:[{id:556,slug:'dragon-life',title:'Жизнь дракона',originalTitle:'Dragon Life',description:'$31',chapters:51}],total:2871};
  const streamed='<script>self.__next_f.push('+JSON.stringify([1,'31:T4,текст32:'+JSON.stringify(['$','component',null,{result:data}])+'\n'])+')</script>';
  const adapter=createExtraNovelSources({fetchImpl:async()=>html(streamed)});const found=await adapter.search('ranobehub','');assert.equal(found.items[0].title,'Жизнь дракона');assert.equal(found.items[0].description,'');assert.equal(found.hasMore,true);
});

test('Ranobe.me retains explicit source volume resets rather than marking every novel globally numbered',async()=>{
  const body=meBook.replace('Глава 1166. Сила Хаоса. Часть 2','Том 2. Глава 1. Начало второго тома').replace('Глава 4508. Не гибрид. Часть 2','Том 2. Глава 2. Продолжение');
  const book=await createExtraNovelSources({extractHtml:extractMvpHtml,fetchImpl:async()=>html(body)}).book('ranobeme','297');assert.equal(book.numbering,'volume');assert.deepEqual(book.chapters.map(x=>[x.volume,x.number]),[['1','1'],['2','1'],['2','2']]);
});

test('RanobeHub loads the full paginated TOC, retains real title coordinates, and rejects locked chapters',async()=>{
  const calls=[];const adapter=createExtraNovelSources({extractHtml:extractMvpHtml,fetchImpl:async url=>{calls.push(url);if(url.includes('/api/books/'))return json(new URL(url).searchParams.get('offset')==='0'?{items:[first],total:3,nextOffset:1}:{items:[second,third],total:3,nextOffset:null});if(url.includes('/api/chapters/'))return json({chapter:{...second,bookSlug:'supreme-magus',html:'<p>Настоящий русский текст продолжения книги.</p>',translationBranch:{slug:'main'}}});return html(hubMeta);}});
  const book=await adapter.book('ranobehub','964-supreme-magus');assert.equal(book.author,'Legion20');assert.equal(book.chapters.length,3);assert.equal(book.chapters[1].number,'2091');assert.equal(book.chapters[1].sourceNumber,'2158');assert.equal(book.chapters[2].number,'');assert.equal(book.chapters[2].available,false);
  const chapter=await adapter.chapter('ranobehub','964-supreme-magus','101');assert.equal(chapter.paragraphs.length,1);assert.ok(chapter.text.includes('продолжения'));
  await assert.rejects(adapter.chapter('ranobehub','964-supreme-magus','102'),{code:'SOURCE_RESTRICTED'});assert.equal(calls.filter(x=>x.includes('/api/books/')).length,2);
});

test('RanobeHub rejects partial TOCs and chapter responses whose book, volume or internal coordinate differs',async()=>{
  await assert.rejects(createExtraNovelSources({fetchImpl:async url=>url.includes('/api/')?json({items:[first],total:3,nextOffset:null}):html(hubMeta)}).book('ranobehub','964-supreme-magus'),{code:'SOURCE_FORMAT'});
  for(const overrides of [{bookId:999},{volume:9},{number:2},{bookSlug:'another-book'},{translationBranch:{slug:'alternate'}}]){
    const adapter=createExtraNovelSources({extractHtml:extractMvpHtml,fetchImpl:async url=>url.includes('/api/books/')?json({items:[first],total:1,nextOffset:null}):url.includes('/api/chapters/')?json({chapter:{...first,bookSlug:'supreme-magus',html:'<p>Настоящий русский текст продолжения книги.</p>',...overrides}}):html(hubMeta)});
    await assert.rejects(adapter.chapter('ranobehub','964-supreme-magus','100'),{code:'SOURCE_IDENTITY'});
  }
});

test('ambiguous mixed volume/global title numbering remains unknown instead of inventing a global sequence',async()=>{
  const entries=[hubChapter(100,1,'Глава 1. Первая',{volume:1}),hubChapter(101,20,'Глава 1. Вторая',{volume:2}),hubChapter(102,1,'Глава 421. Третья',{volume:3})];
  const adapter=createExtraNovelSources({fetchImpl:async url=>url.includes('/api/')?json({items:entries,total:3,nextOffset:null}):html(hubMeta)});const book=await adapter.book('ranobehub','964-supreme-magus');assert.equal(book.numbering,'unknown');assert.deepEqual(book.chapters.map(x=>x.number),['1','1','421']);
});

test('novel requests reject external redirects and malformed source identifiers',async()=>{
  const urls=[];const adapter=createExtraNovelSources({fetchImpl:async url=>{urls.push(url);return new Response(null,{status:302,headers:{location:'https://127.0.0.1/private'}});}});
  await assert.rejects(adapter.search('ranobeme','x'),{code:'SOURCE_URL'});assert.equal(urls.length,1);
  await assert.rejects(adapter.book('ranobeme','../private'),{code:'INPUT'});await assert.rejects(adapter.book('ranobehub','abc'),{code:'INPUT'});await assert.rejects(adapter.search('foreign','x'),{code:'INPUT'});
});
