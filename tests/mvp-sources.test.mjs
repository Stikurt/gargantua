import test from 'node:test';
import assert from 'node:assert/strict';
import {MVP_SOURCE_LIST,createMvpSources,extractMvpEditor,extractMvpHtml,splitMvpText,parseMvpGutenbergSearch,gutenbergMvpTerms,wikisourceMvpQuery} from '../server/mvp-sources.mjs';

const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
const slug='42--real-novel';
const card={id:42,site:3,slug_url:slug,rus_name:'Настоящая новелла',authors:[{name:'Автор'}],is_licensed:false};
const rawChapter={id:101,volume:'1',number:'0',name:'Пролог',branches:[{id:101,branch_id:7,teams:[{name:'Первый перевод'}],expired_type:0},{id:102,branch_id:8,teams:[{name:'Второй перевод'}],expired_type:0}]};

test('editor keeps newer real source containers such as blockquotes and lists',()=>{
  const text=value=>({type:'paragraph',content:[{type:'text',text:value}]});
  const content={type:'doc',content:[text('Начало'),{type:'blockquote',content:[text('Цитата')]},{type:'bulletList',content:[{type:'listItem',content:[text('Пункт')]}]},text('<script>only text</script>')]};
  assert.deepEqual(extractMvpEditor(content),['Начало','Цитата','Пункт','<script>only text</script>']);
});

test('HTML extraction returns inert paragraphs and excludes metadata, scripts and navigation',()=>{
  const html='<div><div id="headertemplate"><p>Служебный заголовок</p></div><p>Первый &amp; второй</p><script>evil()</script><nav>Меню</nav><p>«Текст»<br/>продолжение &#x41;.</p></div>';
  assert.deepEqual(extractMvpHtml(html).paragraphs,['Первый & второй','«Текст»','продолжение A.']);
});

test('legacy preformatted Wikisource novels retain paragraph boundaries and remove source formatting marks',()=>{
  assert.deepEqual(extractMvpHtml("<pre>'''Автор'''\n\nПервый абзац\nпродолжение.\n\nВторой абзац.</pre>").paragraphs,['Автор','Первый абзац продолжение.','Второй абзац.']);
});

test('official Gutenberg search cards and true empty results are parsed without invented metadata',()=>{
  const html='<meta name="totalResults" content="1"><meta name="startIndex" content="1"><li class="booklink"><a href="/ebooks/84"><span class="title">Frankenstein; or, the modern prometheus</span><span class="subtitle">Mary Wollstonecraft Shelley</span></a></li>';
  const result=parseMvpGutenbergSearch(html);assert.equal(result.items[0].id,'84');assert.equal(result.items[0].author,'Mary Wollstonecraft Shelley');assert.equal(result.hasMore,false);
  assert.deepEqual(parseMvpGutenbergSearch('<meta name="totalResults" content="0">').items,[]);
  assert.throws(()=>parseMvpGutenbergSearch('<h1>Access denied</h1>'),{code:'SOURCE_FORMAT'});
  assert.equal(gutenbergMvpTerms('The Ten Books on Architecture'),'Ten Books Architecture');
});

test('search accepts source titles up to 500 characters while rejecting longer inputs',async()=>{
  let observed='';const adapter=createMvpSources({fetchImpl:async url=>{observed=new URL(url).searchParams.get('srsearch');return json({query:{search:[],searchinfo:{totalhits:0}}});}});
  await adapter.search({source:'wikisource',query:'Я'.repeat(500)});assert.equal(observed,'intitle:'+'Я'.repeat(500));
  await assert.rejects(adapter.search({query:'Я'.repeat(501)}),{code:'INPUT'});
});

test('Wikisource searches useful title and author tokens, never incidental full-text mentions',async()=>{
  assert.equal(wikisourceMvpQuery('Война и мир'),'intitle:Война intitle:мир');
  assert.equal(wikisourceMvpQuery('война мир'),'intitle:война intitle:мир');
  assert.equal(wikisourceMvpQuery('Толстой'),'intitle:Толстой');
  assert.equal(wikisourceMvpQuery('Грюнвальдский бой, или Славяне и немцы (Хрущов-Сокольников)'),'intitle:Грюнвальдский intitle:бой intitle:Славяне intitle:немцы intitle:Хрущов intitle:Сокольников');
  assert.equal(wikisourceMvpQuery('Король в жёлтом желтом OR: foo* -bar'),'intitle:Король intitle:жёлтом intitle:OR intitle:foo intitle:bar');
  const observed=[],adapter=createMvpSources({fetchImpl:async url=>{observed.push(new URL(url).searchParams.get('srsearch'));return json({query:{search:[],searchinfo:{totalhits:0}}});}});
  const result=await adapter.search({source:'wikisource',query:'король в желтом'});
  assert.deepEqual(observed,['intitle:король intitle:желтом']);assert.equal(result.items.length,0);assert.equal(result.total,0);
  await adapter.search({source:'wikisource',query:'и в а'});assert.equal(observed.length,1,'stop words must not trigger an unrestricted search');
});

test('search exposes an upstream failure separately from genuine empty results',async()=>{
  const calls=[];
  const adapter=createMvpSources({fetchImpl:async(url,options)=>{calls.push({url,options});if(url.includes('api.cdnlibs'))return json({data:[],meta:{has_next_page:false}});if(url.includes('wikisource'))return json({query:{search:[{pageid:123,title:'Реальная книга (Автор)',snippet:'<b>книга</b>'}],searchinfo:{totalhits:1}}});return new Response('blocked',{status:503});}});
  const result=await adapter.search({query:'Реальная книга',source:'all'});
  assert.equal(result.items.length,1);assert.equal(result.items[0].source,'wikisource');
  assert.equal(result.sources.find(source=>source.id==='ranobelib').status,'ok');
  assert.equal(result.sources.find(source=>source.id==='ranobelib').count,0);
  assert.deepEqual(result.errors.map(error=>[error.source,error.code]),MVP_SOURCE_LIST.filter(source=>!['ranobelib','wikisource'].includes(source.id)).map(source=>[source.id,'SOURCE_UNAVAILABLE']));
  const ranobe=calls.find(call=>call.url.includes('api.cdnlibs'));
  assert.equal(new URL(ranobe.url).searchParams.get('q'),'Реальная книга');assert.equal(ranobe.options.headers['Site-Id'],'3');
});

test('random choice, book and chapter preserve the selected real source identity and translation',async()=>{
  const calls=[];
  const adapter=createMvpSources({pickIndex:()=>0,fetchImpl:async(url)=>{
    calls.push(url);
    if(url.includes('/chapter?')){
      const branch=Number(new URL(url).searchParams.get('branch_id'));
      const content={type:'doc',content:[{type:'blockquote',content:[{type:'paragraph',content:[{type:'text',text:'Доступный текст выбранного перевода.'}]}]}]};
      return json({data:{...rawChapter,id:branch===8?102:101,manga_id:42,branch_id:branch,content}});
    }
    if(url.endsWith('/chapters'))return json({data:[rawChapter]});
    if(url.includes('/'+slug+'?'))return json({data:card});
    return json({data:[card],meta:{has_next_page:true}});
  }});
  const random=await adapter.random({source:'ranobelib'});assert.equal(random.book.id,slug);
  const book=await adapter.book('ranobelib',slug);assert.equal(book.defaultBranchId,'7');assert.deepEqual(book.chapters[0].branchIds,['7','8']);
  const chapter=await adapter.chapter('ranobelib',slug,'v1-c0',{branchId:'8'});
  assert.equal(chapter.branchId,'8');assert.deepEqual(chapter.paragraphs,['Доступный текст выбранного перевода.']);
  await assert.rejects(adapter.chapter('ranobelib',slug,'v1-c0',{branchId:'999'}),{code:'SOURCE_RESTRICTED'});
  assert.equal(calls.filter(url=>url.endsWith('/chapters')).length,1,'opening a chapter reuses the verified book inventory');
});

test('a chapter from a different book is rejected even when the HTTP request succeeds',async()=>{
  const adapter=createMvpSources({fetchImpl:async url=>url.includes('/chapter?')?json({data:{...rawChapter,manga_id:999,branch_id:7,content:'<p>Wrong book</p>'}}):url.endsWith('/chapters')?json({data:[rawChapter]}):json({data:card})});
  await assert.rejects(adapter.chapter('ranobelib',slug,'v1-c0'),{code:'SOURCE_IDENTITY'});
});

test('RanobeLib logical branches accept only their exact inventoried releases, including non-first team releases',async()=>{
  // Live 2026-10-24: book 111229 v1/c1 has three separate releases in branch
  // 21373; its chapter endpoint selects Yokai's 1979987, not first 2820624.
  const realSlug='111229--preference-for-the-possessed';
  const inventory={id:2820624,volume:'1',number:'1',name:'Эра перерождений',branches:[
    {id:2820624,branch_id:21373,teams:[{name:'Kronisea Translate'}],expired_type:0},
    {id:1979987,branch_id:21373,teams:[{name:'Yokai legends'}],expired_type:0},
    {id:2380392,branch_id:21373,teams:[{name:'Runiump'}],expired_type:0},
    {id:3473601,branch_id:21374,teams:[{name:'Astarminas'}],expired_type:0},
  ]};
  const response={id:1979987,manga_id:111229,volume:'1',number:'1',branch_id:21373,content:'<p>Акт 1. Эпоха перерождения</p>'};
  const adapterFor=overrides=>createMvpSources({fetchImpl:async url=>url.includes('/chapter?')?json({data:{...response,...overrides}}):url.endsWith('/chapters')?json({data:[inventory]}):json({data:{...card,id:111229,slug_url:realSlug}})});
  const adapter=adapterFor({}),book=await adapter.book('ranobelib',realSlug);
  assert.deepEqual(book.chapters[0].branchIds,['21373','21374']);
  assert.equal(book.branches.find(branch=>branch.id==='21373').chapterCount,1);
  assert.equal(book.branches.find(branch=>branch.id==='21373').availableCount,1);
  assert.equal(book.branches.find(branch=>branch.id==='21373').name,'Kronisea Translate, Yokai legends, Runiump');
  assert.deepEqual((await adapter.chapter('ranobelib',realSlug,'v1-c1',{branchId:'21373'})).paragraphs,['Акт 1. Эпоха перерождения']);
  for(const override of [{id:9999999},{id:3473601},{manga_id:111230},{volume:'2'},{number:'2'},{branch_id:21374}]){
    await assert.rejects(adapterFor(override).chapter('ranobelib',realSlug,'v1-c1',{branchId:'21373'}),{code:'SOURCE_IDENTITY'});
  }
});

test('Gutenberg catalogue uses the fast public query and imports a matching complete text',async()=>{
  const calls=[],meta={id:84,title:'Frankenstein',authors:[{name:'Shelley, Mary'}],media_type:'Text',copyright:false,languages:['en'],formats:{'text/plain; charset=utf-8':'https://www.gutenberg.org/ebooks/84.txt.utf-8'}};
  const adapter=createMvpSources({fetchImpl:async url=>{calls.push(url);if(url.includes('/cache/epub/84/'))return new Response('Notice\n*** START OF THE PROJECT GUTENBERG EBOOK FRANKENSTEIN ***\n\nFirst paragraph.\n\nLast paragraph.\n\n*** END OF THE PROJECT GUTENBERG EBOOK FRANKENSTEIN ***\nLicense');return json(url.includes('/84/')?meta:{count:1,next:null,results:[meta]});}});
  const found=await adapter.search({source:'gutenberg'});assert.equal(found.items[0].id,'84');
  assert.equal(calls[0],'https://gutendex.com/books/?page=1');
  const book=await adapter.book('gutenberg','84'),chapter=await adapter.chapter('gutenberg','84',book.chapters[0].id);
  assert.deepEqual(chapter.paragraphs,['First paragraph.','Last paragraph.']);
  assert.equal(calls.filter(url=>url.includes('/cache/')).length,1);
});

test('Gutenberg book reading survives unavailable Gutendex metadata using the official card',async()=>{
  const adapter=createMvpSources({fetchImpl:async url=>{
    if(url.includes('gutendex.com'))return new Response('unavailable',{status:503});
    if(url.includes('/cache/epub/84/'))return new Response('*** START OF THE PROJECT GUTENBERG EBOOK TEST ***\n\nReal text.\n\n*** END OF THE PROJECT GUTENBERG EBOOK TEST ***');
    return new Response('<table><tr><th>Title</th><td>Frankenstein</td></tr><tr><th>Author</th><td>Mary Shelley</td></tr><tr><th>Category</th><td>Text</td></tr><tr><th>eBook-No.</th><td>84</td></tr><tr><th>Copyright</th><td>Public domain in the USA.</td></tr></table><a type="text/plain; charset=utf-8" href="/ebooks/84.txt.utf-8">Plain Text</a>');
  }});
  const book=await adapter.book('gutenberg','84');assert.equal(book.title,'Frankenstein');
  const chapter=await adapter.chapter('gutenberg','84',book.chapters[0].id);assert.deepEqual(chapter.paragraphs,['Real text.']);
});

test('Wikisource follows source TOC links in reading order and returns chapter prose',async()=>{
  const root='Книга (Автор)',first=root+'/Глава I',second=root+'/Глава II';
  const adapter=createMvpSources({fetchImpl:async url=>{const params=new URL(url).searchParams;return json({parse:params.has('pageid')?{pageid:55,title:root,text:`<p><a href="/wiki/${encodeURIComponent(first)}">Первая</a></p><p><a href="/wiki/${encodeURIComponent(second)}">Вторая</a></p>`,links:[{ns:0,title:second,exists:true},{ns:0,title:first,exists:true}]}:{pageid:56,title:first,text:'<div id="headertemplate">Навигация</div><p>Содержимое первой главы.</p>',links:[]}});}});
  const book=await adapter.book('wikisource','55');assert.deepEqual(book.chapters.map(chapter=>chapter.id),[first,second]);
  const chapter=await adapter.chapter('wikisource','55',first);assert.deepEqual(chapter.paragraphs,['Содержимое первой главы.']);
  await assert.rejects(adapter.chapter('wikisource','55','Чужая книга/Глава I'),{code:'NOT_FOUND'});
});

test('long Gutenberg texts are partitioned without dropping or duplicating paragraphs',()=>{
  const paragraphs=Array.from({length:20},(_,index)=>`Paragraph ${index} `+'word '.repeat(900));
  const parts=splitMvpText(paragraphs.join('\n\n'));assert.ok(parts.length>1);assert.deepEqual(parts.flat(),paragraphs.map(value=>value.trim()));
});
