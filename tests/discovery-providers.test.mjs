import test from 'node:test';
import assert from 'node:assert/strict';
import {createDiscoverySearch,searchDiscovery,searchSelectedDiscovery,interpretDiscoveryQuery,gutenbergDownloadSelection,gutenbergSearchTerms,canExpandDiscoveryCandidate,canContinueDiscoveryPlan} from '../server/discovery-providers.mjs';

const openBook=(key='OL1W',title='Test Book',changes={})=>({key:`/works/${key}`,title,author_name:['Test Author'],author_key:['OL1A'],language:['rus'],...changes});
const author=(key='OL2623461A',name='Arthur C. Clarke',changes={})=>({key,name,top_work:'Rendezvous with Rama',alternate_names:['Arthur Charles Clarke'],...changes});
const gutenberg=(changes={})=>({id:11,title:'Test Book',authors:[{name:'Test Author'}],languages:['ru'],copyright:false,media_type:'Text',formats:{'application/epub+zip':'https://www.gutenberg.org/cache/epub/11/pg11-images.epub','text/plain; charset=utf-8':'https://www.gutenberg.org/cache/epub/11/pg11.txt'},...changes});
const jsonResponse=(value,url,type='application/json; charset=utf-8')=>({buffer:Buffer.from(JSON.stringify(value)),type,url});
function fixture({open=[],authors=[],works=[],gut=[],ranobe=[],custom,openCount=open.length,gutCount=gut.length}={}){
 const calls=[],sleeps=[];let now=0;
 const search=createDiscoverySearch({clock:()=>now,sleep:async(ms,signal)=>{signal.throwIfAborted();sleeps.push(ms);now+=ms;},fetchSafe:async(url,options)=>{
  calls.push({url,options,time:now});
  assert.ok(options.maxBytes<=2*1024*1024);assert.ok(options.timeoutMs>0&&options.timeoutMs<=12000);assert.equal(options.maxRedirects,0);
  assert.equal(options.headers.accept,'application/json');assert.equal(typeof options.signal.aborted,'boolean');
  const parsed=new URL(url);assert.ok(['openlibrary.org','gutendex.com','api.cdnlibs.org'].includes(parsed.hostname));
  if(custom){const response=await custom(parsed,options,calls.length);if(response!==undefined)return response;}
  let value;
  if(parsed.pathname==='/search.json')value={docs:open,numFound:openCount};
  else if(parsed.pathname==='/search/authors.json')value={docs:authors,numFound:authors.length};
  else if(/^\/authors\/OL\d+A\/works.json$/u.test(parsed.pathname))value={entries:works,size:works.length};
  else if(parsed.hostname==='gutendex.com')value={results:gut,count:gutCount,next:null};
  else value={data:ranobe};
  return jsonResponse(value,url);
 }});
 return {search,calls,sleeps};
}

test('RU/EN intent prefixes and reviewed aliases preserve the original query',()=>{
 for(const query of ['все книги автора Артура Кларка','all books by Arthur Clarke','книги автора Артура Кларк']){
  const value=interpretDiscoveryQuery(query);assert.equal(value.intent,'author');assert.equal(value.searchTerm,'Arthur C. Clarke');assert.equal(value.query,query);
 }
 assert.equal(interpretDiscoveryQuery('серия книг котов войтели').curatedSeries,'warriors-the-prophecies-begin');
 assert.equal(interpretDiscoveryQuery('book series Warriors').intent,'series');
 assert.equal(interpretDiscoveryQuery('Свидание с Рамой').searchTerm,'Rendezvous with Rama');
 assert.equal(interpretDiscoveryQuery('Test Book',{intent:'author'}).intent,'author');
 assert.equal(interpretDiscoveryQuery('Bad\nquery').query,'Bad query');
 for(const query of ['', 'x', 'x'.repeat(301),'Bad\u202equery'])assert.throws(()=>interpretDiscoveryQuery(query),TypeError);
});

test('one exact book selects a source but never downloads the file',async()=>{
 const f=fixture({gut:[gutenberg()]});const result=await f.search('Test Book');
 assert.equal(result.status,'resolved');assert.equal(result.nextAction,'acquire');assert.equal(result.metadataOnly,true);assert.equal(result.requestCount,3);
 const candidate=result.candidates[0];assert.equal(result.selectedCandidateId,candidate.id);assert.ok(candidate.id.length<=120);
 assert.deepEqual(candidate.identity,{provider:'gutendex',remoteId:'11'});assert.equal(candidate.sourceBinding.remoteId,'11');assert.equal(candidate.availability,'fetchable');
 assert.equal(candidate.downloadSelections.length,2);assert.equal(candidate.downloadSelections[0].extension,'epub');
 assert.deepEqual(candidate.downloadSelections[0].expected,{provider:'gutenberg',remoteId:'11',title:'Test Book',authors:['Test Author'],language:'ru',languages:['ru']});
 assert.equal(candidate.downloadSelections[0].requiresQuarantine,true);assert.equal(candidate.downloadSelections[0].rights.territory,'US');
 assert.equal(new URL(candidate.downloadSelections[0].url).hostname,'gutenberg.pglaf.org');assert.equal(new URL(candidate.downloadSelections[0].originalUrl).hostname,'www.gutenberg.org');assert.equal(candidate.downloadSelections[0].maxRedirects,0);
 assert.ok(f.calls.every(c=>!new URL(c.url).hostname.endsWith('gutenberg.org')),'Discovery must fetch metadata only');
});
test('a large metadata catalogue cannot crowd out a downloadable source',async()=>{
 const f=fixture({open:Array.from({length:20},(_,n)=>openBook(`OL${n+1}W`,`Test Book ${n+1}`)),gut:[gutenberg()],openCount:500});
 const result=await f.search('Test Book');assert.equal(result.hasMore,true);assert.ok(result.candidates.some(candidate=>candidate.identity.provider==='gutendex'&&candidate.availability==='fetchable'));assert.ok(result.candidates.filter(candidate=>candidate.identity.provider==='openlibrary').length<=7);assert.ok(result.candidates.length<=20);
 assert.equal(new URL(f.calls.find(call=>new URL(call.url).pathname==='/search.json').url).searchParams.get('limit'),'7');
});

test('Open Library work languages/fulltext flags never manufacture a downloadable edition',async()=>{
 const f=fixture({open:[openBook('OL1W','Test Book',{has_fulltext:true,public_scan_b:true,ia:['a-file']})]});
 const result=await f.search('Test Book');const candidate=result.candidates[0];
 assert.equal(result.status,'resolved');assert.equal(result.nextAction,'needs_source');assert.equal(candidate.availability,'metadata-only');assert.deepEqual(candidate.downloadSelections,[]);
 assert.deepEqual(candidate.languages,['ru']);assert.equal(candidate.languageEvidence,'work-editions-not-selected-file');assert.equal(candidate.sourceBinding.fileVerified,false);
});

test('same title across IDs/providers stays separate, and selection is constrained to returned candidates',async()=>{
 const f=fixture({open:[openBook('OL1W'),openBook('OL2W','Test Book',{author_name:['Other Author'],author_key:['OL2A']})],gut:[gutenberg()]});
 const first=await f.search('Test Book');assert.equal(first.candidates.length,3);assert.equal(first.status,'needs_clarification');assert.equal(first.selectedCandidateId,null);
 assert.equal(new Set(first.candidates.map(c=>c.id)).size,3);
 const second=await f.search('Test Book',{selectedCandidateId:first.candidates[2].id});assert.equal(second.status,'resolved');assert.equal(second.nextAction,'acquire');assert.equal(second.requestCount,0);assert.equal(second.cacheHits,3);
 const absent=await f.search('Test Book',{selectedCandidateId:'dsc_'+'a'.repeat(32)});assert.equal(absent.selectedCandidateId,null);assert.ok(absent.clarifications.some(c=>c.code==='SELECTION_NOT_FOUND'));
});

test('duplicate provider ID is idempotent, conflicting metadata blocks automatic selection',async()=>{
 const good=fixture({open:[openBook(),openBook()]});assert.equal((await good.search('Test Book')).candidates.length,1);
 const bad=fixture({open:[openBook(),openBook('OL1W','Completely Different Book')]});const result=await bad.search('Test Book');
 assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].conflictingMetadata,true);assert.notEqual(result.status,'resolved');
 assert.ok(result.providerErrors.some(e=>e.code==='CONFLICTING_METADATA'));
});

test('original-language permission is explicit and language filters are not trusted as proof',async()=>{
 const f=fixture({gut:[gutenberg({languages:['en']})]});
 const blocked=await f.search('Test Book');assert.equal(blocked.candidates[0].availability,'metadata-only');assert.deepEqual(blocked.candidates[0].downloadSelections,[]);
 assert.equal(blocked.candidates[0].eligibleForAcquisition,false);assert.ok(blocked.clarifications.some(c=>c.code==='ALLOW_ORIGINAL'));
 const allowed=await f.search('Test Book',{allowOriginal:true});assert.equal(allowed.candidates[0].availability,'fetchable');assert.equal(allowed.candidates[0].languageSelection.requiresTranslation,true);
 assert.equal(new URL(f.calls.find(c=>c.url.includes('gutendex')).url).searchParams.get('languages'),'ru');
 assert.equal(new URL(f.calls.filter(c=>c.url.includes('gutendex')).at(-1).url).searchParams.has('languages'),false);
 const unknown=await fixture({gut:[gutenberg({languages:[]})]}).search('Test Book',{allowOriginal:true});assert.equal(unknown.candidates[0].eligibleForAcquisition,false);
});

test('copyright true/unknown, non-Text and unsupported formats never offer automatic files',async()=>{
 for(const changes of [{copyright:true},{copyright:null},{copyright:0},{copyright:'false'},{media_type:'Sound'},{formats:{'text/html':'https://www.gutenberg.org/files/11/11-h.htm'}},{languages:['eng-impostor']}]){
  const result=await fixture({gut:[gutenberg(changes)]}).search('Test Book');
  assert.equal(result.candidates[0].availability,'metadata-only');assert.deepEqual(result.candidates[0].downloadSelections,[]);
 }
});

test('Gutenberg format gate binds exact host, ID, path and supported MIME without URL injection',()=>{
 assert.equal(gutenbergDownloadSelection('https://www.gutenberg.org/cache/epub/11/pg11.txt','text/plain; charset=utf-8','11').extension,'txt');
 for(const value of ['http://www.gutenberg.org/ebooks/11.epub3.images','https://evil.test/ebooks/11.epub3.images','https://www.gutenberg.org.evil.test/ebooks/11.epub3.images','https://u:p@www.gutenberg.org/ebooks/11.epub3.images','https://www.gutenberg.org:444/ebooks/11.epub3.images','https://www.gutenberg.org/ebooks/12.epub3.images','https://www.gutenberg.org/ebooks/11.epub3.images?token=secret','https://www.gutenberg.org/ebooks/11.epub3.images#fragment','https://www.gutenberg.org/ebooks/%31%31.epub3.images','https://www.gutenberg.org/files/11/evil.exe','https://www.gutenberg.org/cache/epub/11/pg12.epub'])assert.equal(gutenbergDownloadSelection(value,'application/epub+zip','11'),null,value);
 assert.equal(gutenbergDownloadSelection('https://www.gutenberg.org/ebooks/11.epub3.images','text/plain','11'),null);
 assert.equal(gutenbergDownloadSelection('https://www.gutenberg.org/files/11/11-8.txt','text/plain; charset=iso-8859-1','11'),null);
});

test('author ambiguity stops expansion until a returned author is explicitly chosen',async()=>{
 const f=fixture({authors:[author(),author('OL2A','Arthur C. Clarke, Stanley Kubrick')],works:[openBook('OL3W','Rendezvous with Rama')]});
 const first=await f.search('все книги автора Артура Кларка');assert.equal(first.requestCount,1);assert.equal(first.plan,null);assert.equal(first.status,'needs_clarification');assert.ok(first.clarifications.some(c=>c.code==='CHOOSE_AUTHOR'));
 assert.ok(!f.calls.some(c=>c.url.includes('/works.json')));
 const result=await f.search('все книги автора Артура Кларка',{selectedCandidateId:first.candidates[0].id});
 assert.equal(result.plan.kind,'author');assert.equal(result.plan.authorCandidateId,first.candidates[0].id);assert.equal(result.plan.bibliographyComplete,false);assert.equal(result.plan.requiresConfirmation,true);
 assert.equal(result.plan.items.length,1);assert.equal(result.requestCount,2);assert.equal(result.selectedCandidateId,null);assert.equal(result.status,'needs_clarification');
 assert.ok(f.calls.some(c=>new URL(c.url).pathname==='/authors/OL2623461A/works.json'));assert.ok(f.sleeps.some(ms=>ms>=1050));
});

test('unique exact author builds a bounded plan; title text matching an author is not authorship',async()=>{
 const f=fixture({authors:[author()],works:[{key:'/works/OL3W',title:'Rendezvous with Rama'}],gut:[gutenberg({title:'Arthur C. Clarke biography',authors:[{name:'Someone Else'}]}),gutenberg({id:12,title:'A verified-author item',authors:[{name:'Clarke, Arthur C.'}],formats:{'text/plain':'https://www.gutenberg.org/cache/epub/12/pg12.txt'}})]});
 const result=await f.search('all books by Arthur Clarke');assert.equal(result.requestCount,3);assert.equal(result.plan.items.length,2);
 assert.ok(result.candidates.some(c=>c.identity.remoteId==='12'));assert.ok(!result.candidates.some(c=>c.title==='Arthur C. Clarke biography'));
 assert.equal(result.candidates.find(c=>c.identity.remoteId==='OL3W').authors[0].remoteId,'OL2623461A');assert.equal(result.candidates.find(c=>c.identity.remoteId==='OL3W').authorsComplete,false);
});

test('Warriors plan contains precisely the six first-arc novels and makes no file/whole-franchise claim',async()=>{
 const f=fixture();const result=await f.search('серия Коты воители');
 assert.equal(result.requestCount,0);assert.equal(result.candidates.length,6);assert.equal(result.plan.scope,'first-arc-only');assert.equal(result.plan.bibliographyComplete,false);assert.equal(result.plan.requiresConfirmation,true);
 assert.deepEqual(result.plan.items.map(c=>c.sequence),[1,2,3,4,5,6]);assert.equal(result.plan.items[0].title,'Into the Wild');assert.equal(result.plan.items[5].title,'The Darkest Hour');
 assert.ok(result.candidates.every(c=>c.availability==='metadata-only'&&c.languages.length===0&&c.downloadSelections.length===0));assert.equal(result.status,'needs_clarification');
 const bounded=await f.search('series Warriors',{maxCandidates:2});assert.equal(bounded.plan.items.length,2);assert.equal(bounded.hasMore,true);assert.equal(bounded.plan.totalKnown,6);
});

test('unknown series has no fabricated order or automatic membership',async()=>{
 const result=await fixture({open:[openBook()]}).search('серия Неизвестный цикл');
 assert.equal(result.plan.scope,'unverified-series-membership');assert.deepEqual(result.plan.items,[]);assert.equal(result.plan.suggestedCandidateIds.length,1);assert.equal(result.status,'needs_clarification');
});

test('Rama alias translates the search phrase while retaining author disambiguation',async()=>{
 const f=fixture({open:[openBook('OL3W','Rendezvous with Rama',{author_name:['Arthur C. Clarke'],author_key:['OL2623461A'],language:['eng','rus']})]});
 const result=await f.search('Свидание с Рамой');assert.equal(result.status,'resolved');assert.equal(result.nextAction,'needs_source');
 const url=new URL(f.calls[0].url);assert.equal(url.searchParams.get('q'),'title:"Rendezvous with Rama"');assert.equal(url.searchParams.get('author'),'Arthur C. Clarke');
 const wrong=await fixture({gut:[gutenberg({title:'Rendezvous with Rama',authors:[{name:'Different Writer'}]})]}).search('Свидание с Рамой');assert.notEqual(wrong.status,'resolved');
});

test('Ranobe card never implies branch language, full book or a default 20-chapter acquisition',async()=>{
 const f=fixture({ranobe:[{slug_url:'123--test-book',rus_name:'Книга',name:'Test Book'},{slug_url:'123--test-book',rus_name:'Книга',name:'Test Book'},{slug_url:'../../admin',rus_name:'Injected'}]});
 const result=await f.search('Книга');const card=result.candidates[0];assert.equal(card.identity.remoteId,'123');assert.equal(card.availability,'needs-preview');assert.deepEqual(card.downloadSelections,[]);assert.deepEqual(card.languages,[]);
 assert.equal(card.sourceBinding.requiresBranchSelection,true);assert.equal(card.sourceBinding.previewIsCompleteBook,false);assert.equal(card.sourceBinding.completeness,'unknown');assert.ok(!Object.hasOwn(card.sourceBinding,'chapters'));
 assert.ok(result.providerErrors.some(e=>e.code==='MALFORMED_ITEM'));
 const call=f.calls.find(c=>c.url.includes('cdnlibs'));assert.equal(call.options.headers['Site-Id'],'3');assert.equal(new URL(call.url).searchParams.get('site_id[]'),'3');
});

test('query text is encoded as a literal Solr phrase and never changes endpoint or headers',async()=>{
 const query='book" OR *:* / evil.test?token=secret';const f=fixture();await f.search(query);
 const url=new URL(f.calls[0].url);assert.equal(url.origin,'https://openlibrary.org');assert.equal(url.pathname,'/search.json');assert.equal(url.searchParams.get('q'),'title:"book\\" OR *:* / evil.test?token=secret"');
 assert.ok(f.calls.every(c=>!Object.values(c.options.headers).includes(query)));
 const denied=fixture();await assert.rejects(()=>denied.search('book" OR *:* / https://evil.test?token=secret'),TypeError);assert.equal(denied.calls.length,0);
});

test('candidate/request/count bounds and hidden pages prevent unwarranted auto resolution',async()=>{
 const rows=Array.from({length:30},(_,i)=>openBook(`OL${i+1}W`,i?'Other '+i:'Test Book'));
 const f=fixture({open:rows,openCount:500});const result=await f.search('Test Book',{maxCandidates:5,maxRequests:1});
 assert.equal(result.candidates.length,5);assert.equal(result.requestCount,1);assert.equal(f.calls.length,1);assert.equal(result.hasMore,true);assert.notEqual(result.status,'resolved');assert.ok(result.providerErrors.some(e=>e.code==='REQUEST_BUDGET'));
 for(const options of [{maxCandidates:21},{maxCandidates:0},{maxRequests:5},{timeoutMs:45001},{timeoutMs:Infinity},{allowOriginal:1},{language:'ru-RU'},{selectedCandidateId:'https://evil.test'}])await assert.rejects(()=>f.search('Test Book',options),TypeError);
});

test('malformed records/IDs and oversized arrays do not become arbitrary source bindings',async()=>{
 const f=fixture({open:[null,{key:'/works/../../authors/OL1W',title:'Injected'},{key:'OL2A',title:'Author as book'},openBook()],gut:[gutenberg({id:1.5}),gutenberg({id:-1}),gutenberg({id:99999999999})],ranobe:[{slug_url:'1--x/../../secrets',rus_name:'Injected'}]});
 const result=await f.search('Test Book');assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].identity.remoteId,'OL1W');assert.ok(result.providerErrors.filter(e=>e.code==='MALFORMED_ITEM').length>=2);
 const huge=await fixture({open:Array.from({length:101},()=>openBook())}).search('Test Book');assert.ok(huge.providerErrors.some(e=>e.code==='RESPONSE_FORMAT'));
});

test('non-JSON, oversized, invalid UTF8 and redirected metadata responses fail safely',async()=>{
 const cases=[url=>({buffer:Buffer.from('<html>secret</html>'),type:'text/html',url}),url=>({buffer:Buffer.alloc(2*1024*1024+1),type:'application/json',url}),url=>({buffer:Buffer.from([0xff]),type:'application/json',url}),url=>jsonResponse({docs:[],numFound:0},'https://evil.test/?token=secret')];
 for(const response of cases){const f=fixture({custom:async parsed=>parsed.hostname==='openlibrary.org'?response(parsed.href):undefined});const result=await f.search('Test Book');assert.ok(result.providerErrors.length);assert.ok(!JSON.stringify(result).includes('token=secret'));assert.ok(!JSON.stringify(result).includes('<html>'));}
});

test('provider failure preserves other providers and exposes no raw error/secret URL',async()=>{
 const f=fixture({gut:[gutenberg()],custom:async parsed=>{if(parsed.hostname==='openlibrary.org')throw Object.assign(new Error('<html>secret https://host/?token=SECRET</html>'),{code:'FETCH_HTTP'});}});
 const result=await f.search('Test Book');assert.equal(result.candidates.length,1);assert.equal(result.providerErrors[0].code,'SOURCE_UNAVAILABLE');assert.notEqual(result.status,'resolved');assert.ok(!JSON.stringify(result).includes('SECRET'));
});

test('deadline and cancellation stop even a fixture transport that ignores its AbortSignal',async()=>{
 const search=createDiscoverySearch({fetchSafe:async()=>new Promise(()=>{})});
 const started=Date.now(),result=await search('Test Book',{timeoutMs:30});assert.equal(result.status,'incomplete');assert.equal(result.requestCount,1);assert.ok(result.providerErrors.some(e=>e.code==='DEADLINE'));assert.ok(Date.now()-started<1000);
 const controller=new AbortController();controller.abort();let calls=0;
 const aborted=await searchDiscovery('Test Book',{signal:controller.signal,fetchSafe:async()=>{calls++;throw new Error('must not run');}});assert.equal(calls,0);assert.equal(aborted.status,'incomplete');assert.ok(aborted.providerErrors.some(e=>e.code==='ABORTED'));
});

test('fractional remaining deadline has one timer owner and cannot start an extra provider early',async context=>{
 context.mock.timers.enable({apis:['setTimeout']});
 let now=0.1,settled=false;const calls=[];
 const search=createDiscoverySearch({clock:()=>now,fetchSafe:async(url,options)=>{calls.push({url,options});return new Promise(()=>{});}});
 const pending=search('Test Book',{timeoutMs:30}).then(result=>{settled=true;return result;});
 // The shared search budget begins at 0.1ms, then the first transport starts
 // after some fractional scheduling overhead. The old child timer floored its
 // 29.5ms budget to 29ms and attempted Gutendex before the 30ms global timeout.
 now=0.6;
 const flush=async()=>{for(let index=0;index<25;index++)await Promise.resolve();};
 await flush();assert.equal(calls.length,1);assert.equal(calls[0].options.timeoutMs,30);
 context.mock.timers.tick(29);await flush();
 assert.equal(calls.length,1);assert.equal(calls[0].options.signal.aborted,false);assert.equal(settled,false);
 context.mock.timers.tick(1);const result=await pending;
 assert.equal(result.status,'incomplete');assert.equal(result.requestCount,1);assert.equal(result.retryCount,0);assert.equal(calls.length,1);assert.equal(calls[0].options.signal.aborted,true);assert.ok(result.providerErrors.some(error=>error.code==='DEADLINE'));
});

test('shared factory paces Open Library requests and bounded cache avoids repeated metadata traffic',async()=>{
 const f=fixture({open:[openBook()]});const first=await f.search('Test Book'),second=await f.search('Test Book');assert.equal(first.requestCount,3);assert.equal(second.requestCount,0);assert.equal(second.cacheHits,3);assert.equal(f.calls.length,3);
 await f.search('Other Book');assert.ok(f.sleeps.some(ms=>ms>=1050));
});

test('hidden authors, malformed metadata and conflicting author IDs block automatic expansion',async()=>{
 const partial=fixture({authors:[author()],custom:async parsed=>parsed.pathname==='/search/authors.json'?jsonResponse({docs:[author()],numFound:10},parsed.href):undefined});
 const first=await partial.search('all books by Arthur Clarke');assert.equal(first.plan,null);assert.equal(first.requestCount,1);assert.equal(first.hasMore,true);assert.ok(first.clarifications.some(c=>c.code==='CHOOSE_AUTHOR'));
 const conflict=fixture({authors:[author(),author('OL2623461A','Different Author')]});const second=await conflict.search('all books by Arthur Clarke');assert.equal(second.plan,null);assert.equal(second.requestCount,1);assert.ok(second.candidates[0].conflictingMetadata);
 const selected=await conflict.search('all books by Arthur Clarke',{selectedCandidateId:second.candidates[0].id});assert.equal(selected.plan,null);assert.ok(!conflict.calls.some(c=>c.url.includes('/works.json')));
});

test('duplicate Gutenberg safety-field conflicts revoke file selections in either record order',async()=>{
 for(const changes of [{copyright:true},{languages:['en']},{formats:{'application/epub+zip':'https://evil.test/file.epub'}},{media_type:'Sound'}]){
  for(const books of [[gutenberg(),gutenberg(changes)],[gutenberg(changes),gutenberg()]]){
   const f=fixture({gut:books}),result=await f.search('Test Book');const candidate=result.candidates[0];
   assert.equal(candidate.conflictingMetadata,true);assert.equal(candidate.availability,'metadata-only');assert.deepEqual(candidate.downloadSelections,[]);assert.notEqual(result.status,'resolved');
   const explicit=await f.search('Test Book',{selectedCandidateId:candidate.id});assert.equal(explicit.selectedCandidateId,null);assert.notEqual(explicit.status,'resolved');
  }
 }
});

test('invalid provider count/pagination prevents an apparently unique book being resolved',async()=>{
 for(const data of [{docs:[openBook()]},{docs:[openBook()],numFound:-1},{docs:[openBook()],numFound:0},{docs:[openBook()],numFound:'1'}]){
  const f=fixture({custom:async parsed=>parsed.pathname==='/search.json'?jsonResponse(data,parsed.href):undefined});
  const result=await f.search('Test Book');assert.equal(result.candidates.length,0);assert.ok(result.providerErrors.some(c=>c.code==='RESPONSE_FORMAT'));
 }
 const f=fixture({custom:async parsed=>parsed.hostname==='gutendex.com'?jsonResponse({results:[gutenberg()],count:1,next:123},parsed.href):undefined});
 const result=await f.search('Test Book');assert.equal(result.candidates.length,0);assert.ok(result.providerErrors.some(c=>c.code==='RESPONSE_FORMAT'));
});

test('author works that explicitly contradict selected author identity are rejected',async()=>{
 const f=fixture({authors:[author()],works:[{key:'/works/OL3W',title:'Other author work',authors:[{author:{key:'/authors/OL999A'}}]}]});
 const result=await f.search('all books by Arthur Clarke');assert.equal(result.plan.items.length,0);assert.ok(result.providerErrors.some(c=>c.code==='MALFORMED_ITEM'));
});

test('website routes and arbitrary mirror hosts are not guessed into downloadable mirror paths',async()=>{
 const f=fixture({gut:[gutenberg({formats:{'application/epub+zip':'https://www.gutenberg.org/ebooks/11.epub3.images','text/plain':'https://www.gutenberg.org/files/11/11-0.txt'}})]});
 const result=await f.search('Test Book');assert.deepEqual(result.candidates[0].downloadSelections,[]);assert.equal(result.candidates[0].blockedReason,'MIRROR_PATH_UNVERIFIED');assert.equal(result.nextAction,'needs_source');
 assert.equal(gutenbergDownloadSelection('https://gutenberg.pglaf.org/cache/epub/11/pg11.epub','application/epub+zip','11'),null,'Only canonical metadata URLs enter the fixed mirror rewrite');
 assert.equal(gutenbergDownloadSelection('https://mirror.example/cache/epub/11/pg11.epub','application/epub+zip','11'),null);
});

test('trusted selected author/book identifiers use fixed bounded metadata endpoints',async()=>{
 const f=fixture({works:[openBook('OL3W','Rama')],custom:async parsed=>{
  if(parsed.pathname==='/authors/OL2623461A.json')return jsonResponse(author(),parsed.href);
  if(parsed.pathname==='/works/OL3W.json')return jsonResponse(openBook('OL3W','Rama'),parsed.href);
  if(parsed.pathname==='/books/11/')return jsonResponse(gutenberg(),parsed.href);
 }});
 const byAuthor=await f.search('Ignored label',{trustedFilter:{provider:'openlibrary',kind:'author',remoteId:'OL2623461A'}});assert.equal(byAuthor.plan.kind,'author');assert.equal(byAuthor.requestCount,3);assert.ok(f.calls.every(c=>!new URL(c.url).pathname.includes('/search/authors')));
 const byBook=await f.search('Ignored label',{trustedFilter:{provider:'gutendex',kind:'book',remoteId:'11'}});assert.equal(byBook.requestCount,1);assert.equal(byBook.selectedCandidateId,byBook.candidates[0].id);assert.equal(byBook.nextAction,'acquire');
 const byWork=await f.search('Ignored label',{trustedFilter:{provider:'openlibrary',kind:'book',remoteId:'OL3W'}});assert.equal(byWork.requestCount,1);assert.equal(byWork.nextAction,'needs_source');
});

test('persisted selection wrapper rechecks identity and does not follow its display URL',async()=>{
 const first=await fixture({gut:[gutenberg()]}).search('Test Book');const selected=first.candidates[0];let seen;
 const result=await searchSelectedDiscovery({...selected,sourceBinding:{url:'https://evil.test/?secret=1'}},{fetchSafe:async(url)=>{seen=url;return jsonResponse(gutenberg(),url);}});
 assert.equal(seen,'https://gutendex.com/books/11/');assert.equal(result.requestCount,1);assert.equal(result.selectedCandidateId,selected.id);
 await assert.rejects(()=>searchSelectedDiscovery({...selected,id:'dsc_'+'a'.repeat(32)}),TypeError);
});

test('trusted filter rejects raw URLs, path aliases, unsupported selectors and returned wrong IDs',async()=>{
 const f=fixture();for(const trustedFilter of [{provider:'openlibrary',kind:'author',remoteId:'/authors/OL1A'},{provider:'openlibrary',kind:'author',remoteId:'../OL1A'},{provider:'gutendex',kind:'author',remoteId:'11'},{provider:'gutendex',kind:'book',remoteId:'11',url:'https://evil.test'},{provider:'gutendex',kind:'book',remoteId:'011'}])await assert.rejects(()=>f.search('Test Book',{trustedFilter}),TypeError);
 assert.equal(f.calls.length,0);
 const wrong=await fixture({custom:async parsed=>parsed.pathname==='/books/11/'?jsonResponse(gutenberg({id:12}),parsed.href):undefined}).search('Test Book',{trustedFilter:{provider:'gutendex',kind:'book',remoteId:'11'}});
 assert.equal(wrong.candidates.length,0);assert.equal(wrong.status,'unavailable');assert.equal(wrong.providerErrors[0].code,'RESPONSE_FORMAT');
});

test('deterministic TXT route maps same ID to official cache attempt without claiming file presence',async()=>{
 const original='https://www.gutenberg.org/ebooks/11.txt.utf-8',mapped=gutenbergDownloadSelection(original,'text/plain; charset=utf-8','11');
 assert.equal(mapped.url,'https://gutenberg.pglaf.org/cache/epub/11/pg11.txt');assert.equal(mapped.originalUrl,original);assert.equal(mapped.pathVerification,'deterministic-attempt-not-presence');assert.equal(mapped.maxRedirects,0);
 for(const url of ['https://www.gutenberg.org/ebooks/12.txt.utf-8','https://www.gutenberg.org/ebooks/11.txt.utf-8?download=1','https://www.gutenberg.org:443/ebooks/11.txt.utf-8','https://www.gutenberg.org:444/ebooks/11.txt.utf-8','https://www.gutenberg.org/ebooks/11.txt.utf-8#fragment'])assert.equal(gutenbergDownloadSelection(url,'text/plain; charset=utf-8','11'),null);
 assert.equal(gutenbergDownloadSelection('https://www.gutenberg.org/ebooks/11.epub3.images','application/epub+zip','11'),null);
 const result=await fixture({gut:[gutenberg({formats:{'text/plain; charset=utf-8':original}})]}).search('Test Book');assert.equal(result.candidates[0].availability,'fetchable');assert.equal(result.candidates[0].downloadSelections[0].pathVerification,'deterministic-attempt-not-presence');
});

test('bare reviewed author/series names infer intent and explicit book intent remains authoritative',()=>{
 assert.equal(interpretDiscoveryQuery('Артур Кларк').intent,'author');
 assert.equal(interpretDiscoveryQuery('Коты-воители').intent,'series');
 assert.equal(interpretDiscoveryQuery('Arthur C. Clarke',{intent:'book'}).intent,'book');
 assert.equal(interpretDiscoveryQuery('Death by Water').term,'Death by Water');
 const specified=interpretDiscoveryQuery('«Свидание с Рамой» автора Артура Кларка');
 assert.equal(specified.term,'Свидание с Рамой');assert.equal(specified.authorHint.openLibraryId,'OL2623461A');
 assert.equal(interpretDiscoveryQuery('"Rama II" by Arthur C. Clarke').authorHint.name,'Arthur C. Clarke');
 const series=interpretDiscoveryQuery('серия Рама автора Артура Кларка');assert.equal(series.term,'Рама');assert.equal(series.authorHint.name,'Arthur C. Clarke');
});

test('explicit book author narrows metadata matches and remains literal provider input',async()=>{
 const f=fixture({gut:[gutenberg({authors:[{name:'Other Writer'}]})]});
 const result=await f.search('Test Book автора Expected Writer');assert.notEqual(result.status,'resolved');
 assert.equal(new URL(f.calls[0].url).searchParams.get('author'),'Expected Writer');
});

const seriesBook=(id,title,position,changes={})=>openBook(id,title,{series_key:['OL50L'],series_name:['Known Cycle'],series_position:[position],...changes});
test('generic series uses exact indexed membership and numeric source positions without asserting reading order',async()=>{
 const f=fixture({open:[seriesBook('OL2W','Second','2'),seriesBook('OL1W','First','1'),seriesBook('OL3W','Interlude','1.5'),openBook('OL4W','Unrelated result')],gut:[gutenberg({title:'Known Cycle companion'})]});
 const result=await f.search('series Known Cycle');
 assert.equal(new URL(f.calls[0].url).searchParams.get('q'),'series_name:"Known Cycle"');
 assert.equal(result.plan.scope,'provider-asserted-series-membership');assert.deepEqual(result.plan.seriesIdentity,{provider:'openlibrary',remoteId:'OL50L'});
 assert.deepEqual(result.plan.items.map(item=>item.sequence),[1,1.5,2]);assert.equal(result.plan.order,'provider-series-position');assert.equal(result.plan.orderIsReadingOrder,false);assert.equal(result.plan.bibliographyComplete,false);
 assert.equal(result.plan.suggestedCandidateIds.length,2);assert.ok(result.clarifications.some(item=>item.code==='CONFIRM_SERIES_PLAN'));
});

test('series parallel-array mismatches, unsafe keys, absent names and ranges cannot invent numeric ordering',async()=>{
 const changes=[{series_position:[]},{series_key:['../../evil']},{series_name:['Different Cycle']},{series_key:['/OL50L']},{series_key:['OL50S']}];
 for(const change of changes){const result=await fixture({open:[seriesBook('OL1W','First','1',change)]}).search('series Known Cycle');assert.deepEqual(result.plan.items,[],JSON.stringify(change));}
 for(const position of ['1-3','Book One','-1','1e2','Infinity','1000000','1.1234567',null]){
  const result=await fixture({open:[seriesBook('OL1W','First',position)]}).search('series Known Cycle');assert.equal(result.plan.items[0].sequence,null,String(position));assert.equal(result.plan.order,'unconfirmed');
 }
 const duplicate=await fixture({open:[seriesBook('OL1W','First','1'),seriesBook('OL2W','Other','1')]}).search('series Known Cycle');assert.equal(duplicate.plan.order,'unconfirmed');
});

test('different indexed series with identical names require clarification without mixed membership',async()=>{
 const result=await fixture({open:[seriesBook('OL1W','A','1'),seriesBook('OL2W','B','2',{series_key:['/series/OL51L']})]}).search('series Known Cycle');
 assert.equal(result.plan.seriesVariants.length,2);assert.equal(result.plan.seriesIdentity,null);assert.deepEqual(result.plan.items,[]);assert.ok(result.clarifications.some(item=>item.code==='CHOOSE_SERIES'));
});

test('a duplicate provider work with contradictory series membership is excluded from the plan',async()=>{
 const result=await fixture({open:[seriesBook('OL1W','A','1'),seriesBook('OL1W','A','2')]}).search('series Known Cycle');
 assert.ok(result.candidates[0].conflictingMetadata);assert.deepEqual(result.plan.items,[]);
});

test('author works can use one extra bounded page and are sorted by known publication year',async()=>{
 const f=fixture({authors:[author()],custom:async parsed=>{
  if(parsed.pathname!=='/authors/OL2623461A/works.json')return;
  const offset=parsed.searchParams.get('offset');
  return jsonResponse({size:3,entries:offset==='0'?[openBook('OL1W','Later',{first_publish_year:1970}),openBook('OL2W','Earlier',{first_publish_year:1950})]:[openBook('OL3W','Unknown date')],links:{next:'https://evil.test/?secret=1'}},parsed.href);
 }});
 const result=await f.search('Arthur Clarke');assert.equal(result.requestCount,4);assert.equal(result.plan.order,'first-publication-year-then-title');assert.equal(result.plan.orderIsReadingOrder,false);
 assert.deepEqual(result.plan.items.map(item=>item.title),['Earlier','Later','Unknown date']);assert.deepEqual(result.plan.providerCoverage,{provider:'openlibrary',loaded:3,totalReported:3,completePageSet:true});assert.equal(result.plan.bibliographyComplete,false);
 assert.equal(new URL(f.calls.at(-1).url).searchParams.get('offset'),'2');assert.ok(f.calls.every(call=>!call.url.includes('evil.test')));
});

test('author pagination rejects changed totals, repeated pages and empty progress',async()=>{
 for(const next of [{size:3,entries:[]},{size:4,entries:[openBook('OL2W','New')]},{size:3,entries:[openBook('OL1W','Original')]}]){
  const f=fixture({authors:[author()],custom:async parsed=>parsed.pathname==='/authors/OL2623461A/works.json'?jsonResponse(parsed.searchParams.get('offset')==='0'?{size:3,entries:[openBook('OL1W','Original')]}:next,parsed.href):undefined});
  const result=await f.search('Arthur Clarke');assert.equal(result.requestCount,4);assert.equal(result.plan.items.length,1);assert.ok(result.providerErrors.some(item=>item.code==='RESPONSE_FORMAT'));
 }
});

test('metadata relationship uses explicit Gutenberg ID and never merges titles or skips file verification',async()=>{
 const linked=await fixture({open:[openBook('OL1W','Test Book',{id_project_gutenberg:['11']})],gut:[gutenberg()]}).search('Test Book');
 assert.equal(linked.candidates.length,2);assert.equal(linked.identityLinks.length,1);assert.equal(linked.identityLinks[0].metadataCompatible,true);assert.equal(linked.identityLinks[0].mergeAllowed,false);assert.equal(linked.identityLinks[0].fileVerificationRequired,true);
 const titleOnly=await fixture({open:[openBook()],gut:[gutenberg()]}).search('Test Book');assert.deepEqual(titleOnly.identityLinks,[]);
 const conflict=await fixture({open:[openBook('OL1W','Wrong title',{id_project_gutenberg:['11','0011','https://evil.test']})],gut:[gutenberg()]}).search('Test Book');assert.equal(conflict.identityLinks.length,1);assert.equal(conflict.identityLinks[0].metadataCompatible,false);
});

test('selected metadata work refreshes canonical identity then searches sources without trusting saved labels',async()=>{
 const initial=await fixture({open:[openBook()]}).search('Test Book');const selected=initial.candidates[0],calls=[];
 const result=await searchSelectedDiscovery({...selected,title:'DO NOT TRUST LABEL',authors:[{name:'Attacker'}],sourceBinding:{url:'https://evil.test'}},{fetchSafe:async url=>{
  calls.push(url);const parsed=new URL(url);
  if(parsed.pathname==='/works/OL1W.json')return jsonResponse({key:'/works/OL1W',title:'Actual Book',authors:[{author:{key:'/authors/OL1A'}}]},url);
  if(parsed.pathname==='/authors/OL1A.json')return jsonResponse(author('OL1A','Canonical Writer'),url);
  if(parsed.hostname==='gutendex.com')return jsonResponse({count:1,next:null,results:[gutenberg({title:'Actual Book',authors:[{name:'Writer, Canonical'}]})]},url);
  return jsonResponse({data:[]},url);
 },sleep:async()=>{}});
 assert.equal(result.status,'resolved');assert.equal(result.nextAction,'acquire');assert.equal(result.requestCount,4);assert.equal(result.selectedCandidateId,result.candidates[1].id);
 assert.deepEqual(result.sourceResolutionFor,{provider:'openlibrary',remoteId:'OL1W'});assert.equal(result.candidates[0].sourceResolutionAttempted,true);assert.equal(canExpandDiscoveryCandidate(result.candidates[0]),false);
 assert.equal(new URL(calls[2]).searchParams.get('search'),'Actual Canonical Writer');assert.ok(calls.every(url=>!url.includes('evil.test')&&!url.includes('DO%20NOT')));
 assert.equal(result.candidates[1].resolutionEvidence.kind,'selected-work-title-and-author');
});

test('selected metadata work cannot auto substitute another author or unknown-author Ranobe card',async()=>{
 const selected=(await fixture({open:[openBook()]}).search('Test Book')).candidates[0];
 const result=await searchSelectedDiscovery(selected,{fetchSafe:async url=>{
  const parsed=new URL(url);return jsonResponse(parsed.pathname==='/works/OL1W.json'?openBook():parsed.pathname==='/authors/OL1A.json'?author('OL1A','Expected Writer'):parsed.hostname==='gutendex.com'?{results:[gutenberg({authors:[{name:'Other Writer'}]})],count:1,next:null}:{data:[{slug_url:'123--test-book',name:'Test Book',rus_name:'Test Book'}]},url);
 },sleep:async()=>{}});
 assert.equal(result.status,'needs_clarification');assert.equal(result.selectedCandidateId,null);assert.ok(result.clarifications.some(item=>item.code==='SOURCE_NOT_FOUND'));assert.equal(result.candidates.filter(item=>item.availability==='needs-preview').length,1);
});

test('selected work without one stable author does not search by guessed names',async()=>{
 const selected=(await fixture({open:[openBook()]}).search('Test Book')).candidates[0];
 for(const authors of [[],[{author:{key:'/authors/OL1A'}},{author:{key:'/authors/OL2A'}}]]){
  const result=await searchSelectedDiscovery(selected,{fetchSafe:async url=>jsonResponse({key:'/works/OL1W',title:'Test Book',authors},url)});
  assert.equal(result.requestCount,1);assert.equal(result.selectedCandidateId,null);assert.ok(result.clarifications.some(item=>item.code==='AUTHOR_IDENTITY_UNRESOLVED'));
 }
});

test('selected curated book derives source search title/author from the reviewed local seed',async()=>{
 const selected=(await fixture().search('Коты-воители')).candidates[0],calls=[];
 assert.equal(canExpandDiscoveryCandidate(selected),true);
 const result=await searchSelectedDiscovery({...selected,title:'Injected title',authors:[{name:'Injected Writer'}]},{fetchSafe:async url=>{
  calls.push(url);const parsed=new URL(url);return jsonResponse(parsed.hostname==='openlibrary.org'?{docs:[],numFound:0}:parsed.hostname==='gutendex.com'?{results:[gutenberg({title:'Into the Wild',authors:[{name:'Erin Hunter'}]})],count:1,next:null}:{data:[]},url);
 }});
 assert.equal(result.requestCount,3);assert.equal(result.status,'resolved');assert.equal(result.nextAction,'acquire');assert.equal(new URL(calls[0]).searchParams.get('author'),'Erin Hunter');assert.equal(new URL(calls[1]).searchParams.get('search'),'Wild Erin Hunter');
});

test('expansion capability checks exact stable identity and rejects unsafe selectors before traffic',async()=>{
 const selected=(await fixture().search('Warriors')).candidates[0];assert.equal(canExpandDiscoveryCandidate(selected),true);
 for(const candidate of [null,{}, {...selected,id:'dsc_'+'0'.repeat(32)},{...selected,conflictingMetadata:true},{...selected,sourceResolutionAttempted:true},{...selected,identityEvidenceIncomplete:true},{...selected,identity:{provider:'curated',remoteId:'warriors:tpc:7'}}])assert.equal(canExpandDiscoveryCandidate(candidate),false);
 const cyclic={};cyclic.self=cyclic;assert.equal(canExpandDiscoveryCandidate({...selected,identity:{provider:'curated',remoteId:cyclic}}),false);
 let calls=0;await assert.rejects(()=>searchSelectedDiscovery({...selected,identity:{provider:'curated',remoteId:'warriors:tpc:7'}},{fetchSafe:async()=>{calls++;}}),TypeError);assert.equal(calls,0);
});

test('one transient metadata retry shares the same hard request budget and keeps other sources bounded',async()=>{
 const f=fixture({gut:[gutenberg()],custom:async(parsed,_options,count)=>{
  if(parsed.hostname==='openlibrary.org'&&count===1)throw Object.assign(new Error('private'),{code:'FETCH_HTTP',httpStatus:503});
 }});
 const result=await f.search('Test Book');assert.equal(result.retryCount,1);assert.equal(result.requestCount,4);assert.equal(result.providerErrors.length,0);assert.equal(result.status,'resolved');assert.ok(f.sleeps.includes(1500));
 const exhausted=fixture({custom:async parsed=>{if(parsed.hostname==='openlibrary.org')throw Object.assign(new Error('private'),{code:'FETCH_HTTP',httpStatus:503});}});
 const limited=await exhausted.search('Test Book',{maxRequests:1});assert.equal(limited.requestCount,1);assert.equal(limited.retryCount,0);assert.equal(exhausted.calls.length,1);
});

test('access denial, TLS/SSRF, malformed bodies and arbitrary errors are never retried',async()=>{
 for(const error of [{code:'FETCH_HTTP',httpStatus:403},{code:'FETCH_HTTP',httpStatus:451},{code:'FETCH_SSRF'},{code:'CERT_HAS_EXPIRED'},{code:'FETCH_REDIRECT_LIMIT'},{code:'UNKNOWN'}]){
  const f=fixture({custom:async parsed=>{if(parsed.hostname==='openlibrary.org')throw Object.assign(new Error('secret'),error);}});
  const result=await f.search('Test Book');assert.equal(result.retryCount,0);assert.equal(result.requestCount,3);assert.ok(!JSON.stringify(result).includes('secret'));
 }
});

test('truncation cannot turn a longer source title into an apparently exact autonomous match',async()=>{
 const prefix='A'.repeat(300),result=await fixture({gut:[gutenberg({title:prefix+' different book'})]}).search(prefix);
 assert.equal(result.candidates[0].identityEvidenceIncomplete,true);assert.notEqual(result.status,'resolved');assert.equal(result.selectedCandidateId,null);
});

test('author continuation advances server-owned bounded pages instead of restarting the first author page',async()=>{
 const f=fixture({authors:[author()],custom:async parsed=>{
  if(parsed.pathname==='/authors/OL2623461A.json')return jsonResponse(author(),parsed.href);
  if(parsed.pathname==='/authors/OL2623461A/works.json'){
   const offset=Number(parsed.searchParams.get('offset')),limit=Number(parsed.searchParams.get('limit'));
   return jsonResponse({size:866,entries:Array.from({length:limit},(_,i)=>openBook(`OL${offset+i+1}W`,`Work ${offset+i+1}`))},parsed.href);
  }
 }});
 const first=await f.search('все книги Артура Кларка');assert.equal(first.requestCount,4);assert.equal(first.plan.items.length,19);assert.equal(canContinueDiscoveryPlan(first.plan),true);assert.deepEqual(first.plan.continuation,{kind:'author-works',provider:'openlibrary',remoteId:'OL2623461A',offset:19});
 const second=await f.search('все книги Артура Кларка',{continuation:first.plan.continuation});assert.equal(second.requestCount,3);assert.equal(second.plan.items.length,19);assert.equal(second.plan.continuation.offset,38);assert.equal(second.plan.bibliographyComplete,false);
 assert.equal(second.plan.items.some(item=>first.plan.items.some(old=>old.candidateId===item.candidateId)),false);
 assert.equal(f.calls.filter(call=>new URL(call.url).pathname==='/search/authors.json').length,1);assert.equal(f.calls.filter(call=>new URL(call.url).hostname==='gutendex.com').length,1);
});

test('author continuation ends at last reported row and never follows provider next links',async()=>{
 const next={kind:'author-works',provider:'openlibrary',remoteId:'OL2623461A',offset:19};
 const f=fixture({custom:async parsed=>parsed.pathname==='/authors/OL2623461A.json'?jsonResponse(author(),parsed.href):parsed.pathname==='/authors/OL2623461A/works.json'?jsonResponse({size:20,entries:[openBook('OL20W','Last item')],links:{next:'https://evil.test'}},parsed.href):undefined});
 const result=await f.search('Author continuation',{continuation:next});assert.equal(result.requestCount,2);assert.equal(result.plan.items.length,1);assert.equal(Object.hasOwn(result.plan,'continuation'),false);assert.equal(canContinueDiscoveryPlan(result.plan),false);assert.equal(result.plan.providerCoverage.completePageSet,true);assert.equal(result.hasMore,false);
});

test('generic series continuation uses stable fixed query and offset with no extra source sweep',async()=>{
 const f=fixture({custom:async parsed=>{
  if(parsed.pathname==='/search.json'){const start=Number(parsed.searchParams.get('offset')??0);return jsonResponse({numFound:9,docs:Array.from({length:Math.min(7,9-start)},(_,index)=>seriesBook(`OL${start+index+1}W`,`Part ${start+index+1}`,String(start+index+1)))},parsed.href);}
 }});
 const first=await f.search('series Known Cycle');assert.equal(first.plan.items.length,7);assert.equal(canContinueDiscoveryPlan(first.plan),true);assert.deepEqual(first.plan.continuation,{kind:'series-search',provider:'openlibrary',term:'Known Cycle',offset:7});
 const second=await f.search('series Known Cycle',{continuation:first.plan.continuation});assert.equal(second.requestCount,1);assert.deepEqual(second.plan.items.map(item=>item.sequence),[8,9]);assert.equal(Object.hasOwn(second.plan,'continuation'),false);assert.equal(second.hasMore,false);
 assert.equal(new URL(f.calls.at(-1).url).searchParams.get('sort'),'key');
});

test('continuation tokens reject arbitrary URLs, invalid boundaries, switched authors and changed series context',async()=>{
 const f=fixture();
 for(const continuation of [{kind:'author-works',provider:'evil',remoteId:'OL1A',offset:1},{kind:'author-works',provider:'openlibrary',remoteId:'../OL1A',offset:1},{kind:'author-works',provider:'openlibrary',remoteId:'OL1A',offset:0},{kind:'author-works',provider:'openlibrary',remoteId:'OL1A',offset:10001},{kind:'author-works',provider:'openlibrary',remoteId:'OL1A',offset:1,url:'https://evil.test'},{kind:'series-search',provider:'openlibrary',term:'Different Cycle',offset:1}])await assert.rejects(()=>f.search('series Known Cycle',{continuation}),TypeError);
 await assert.rejects(()=>f.search('Author',{trustedFilter:{provider:'openlibrary',kind:'author',remoteId:'OL2A'},continuation:{kind:'author-works',provider:'openlibrary',remoteId:'OL1A',offset:10}}),TypeError);assert.equal(f.calls.length,0);
 assert.equal(canContinueDiscoveryPlan({kind:'author',authorCandidateId:'dsc_'+'0'.repeat(32),continuation:{kind:'author-works',provider:'openlibrary',remoteId:'OL1A',offset:10}}),false);
 assert.equal(canContinueDiscoveryPlan({kind:'series',title:'Different Cycle',continuation:{kind:'series-search',provider:'openlibrary',term:'Known Cycle',offset:1}}),false);
});

test('pagination never issues a continuation past the provider offset safety cap',async()=>{
 const f=fixture({custom:async parsed=>parsed.pathname==='/authors/OL2623461A.json'?jsonResponse(author(),parsed.href):parsed.pathname==='/authors/OL2623461A/works.json'?jsonResponse({size:20000,entries:[openBook('OL10001W','Very late item')]},parsed.href):undefined});
 const result=await f.search('Author',{maxRequests:2,continuation:{kind:'author-works',provider:'openlibrary',remoteId:'OL2623461A',offset:10000}});assert.equal(result.requestCount,2);assert.equal(result.hasMore,true);assert.equal(Object.hasOwn(result.plan,'continuation'),false);assert.equal(result.plan.bibliographyComplete,false);
});

test('ancillary source outages do not remove a valid bounded Open Library next page',async()=>{
 for(const series of [false,true]){
  const f=fixture({authors:[author()],custom:async parsed=>{
   if(parsed.hostname==='gutendex.com')throw Object.assign(new Error('private outage'),{code:'FETCH_HTTP',httpStatus:403});
   if(parsed.pathname==='/authors/OL2623461A/works.json'){const index=Number(parsed.searchParams.get('offset'))+1;return jsonResponse({size:866,entries:[openBook(`OL${index}W`,`Work ${index}`)]},parsed.href);}
   if(series&&parsed.pathname==='/search.json')return jsonResponse({numFound:50,docs:[seriesBook('OL1W','First','1')]},parsed.href);
  }});
  const result=await f.search(series?'series Known Cycle':'Arthur Clarke');assert.ok(result.providerErrors.some(item=>item.provider==='gutendex'));assert.equal(canContinueDiscoveryPlan(result),true);assert.equal(result.plan.bibliographyComplete,false);assert.notEqual(result.status,'resolved');
 }
});

test('conflicting repeated series edges do not silently pick the first claimed position',async()=>{
 const result=await fixture({open:[seriesBook('OL1W','First','1',{series_key:['OL50L','/series/OL50L'],series_name:['Known Cycle','Known Cycle'],series_position:['1','2']})]}).search('series Known Cycle');
 assert.deepEqual(result.plan.items,[]);assert.equal(result.plan.scope,'unverified-series-membership');
});

test('noisy author metadata keeps honest partial results and advances by raw source rows',async()=>{
 const f=fixture({authors:[author()],custom:async parsed=>{
  if(parsed.pathname==='/authors/OL2623461A.json')return jsonResponse(author(),parsed.href);
  if(parsed.pathname==='/authors/OL2623461A/works.json'){
   const offset=Number(parsed.searchParams.get('offset'));
   return jsonResponse({size:13,entries:offset===0?[...Array.from({length:7},(_,index)=>openBook(`OL${index+1}W`,`Work ${index+1}`)),null,{key:'/works/not-an-ID',title:'Unusable'},{key:'/works/OL99W',title:'Wrong author',authors:[{author:{key:'/authors/OL999A'}}]}]:Array.from({length:3},(_,index)=>openBook(`OL${index+11}W`,`Work ${index+11}`))},parsed.href);
  }
  if(parsed.hostname==='gutendex.com')throw Object.assign(new Error('source blocked'),{code:'FETCH_HTTP',httpStatus:403});
 }});
 const first=await f.search('Arthur Clarke',{maxRequests:3});assert.equal(first.plan.items.length,7);assert.equal(first.plan.partialMetadata,true);assert.equal(first.plan.skippedSourceItems,3);assert.equal(first.plan.providerCoverage.loaded,10);assert.equal(first.plan.providerCoverage.recordsComplete,false);assert.equal(first.plan.providerCoverage.malformedItemsSkipped,3);assert.equal(first.plan.bibliographyComplete,false);assert.equal(first.plan.continuation.offset,10);assert.equal(canContinueDiscoveryPlan(first),true);assert.equal(first.status,'needs_clarification');
 assert.ok(first.providerErrors.some(error=>error.provider==='openlibrary'&&error.code==='MALFORMED_ITEM'&&error.retryable===false));
 const second=await f.search('Arthur Clarke',{continuation:first.plan.continuation});assert.equal(second.plan.items.length,3);assert.equal(second.plan.providerCoverage.loaded,13);assert.equal(second.plan.providerCoverage.completePageSet,true);assert.equal(second.plan.bibliographyComplete,false);assert.equal(Object.hasOwn(second.plan,'continuation'),false);assert.equal(second.plan.items.some(item=>first.plan.items.some(old=>old.candidateId===item.candidateId)),false);
});

test('malformed individual series rows allow a bounded next page but contradictory duplicate identities do not',async()=>{
 const partial=await fixture({custom:async parsed=>parsed.pathname==='/search.json'?jsonResponse({numFound:10,docs:[seriesBook('OL1W','Good','1'),null]},parsed.href):undefined}).search('series Known Cycle');
 assert.equal(partial.plan.partialMetadata,true);assert.equal(partial.plan.skippedSourceItems,1);assert.equal(partial.plan.items.length,1);assert.equal(partial.plan.continuation.offset,2);assert.equal(canContinueDiscoveryPlan(partial),true);
 const conflicting=await fixture({custom:async parsed=>parsed.pathname==='/search.json'?jsonResponse({numFound:10,docs:[seriesBook('OL1W','First','1'),seriesBook('OL1W','Changed title','1')]},parsed.href):undefined}).search('series Known Cycle');
 assert.ok(conflicting.providerErrors.some(error=>error.code==='CONFLICTING_METADATA'&&error.retryable===false));assert.equal(Object.hasOwn(conflicting.plan,'continuation'),false);
});

test('known transient transport failures advertise durable retry eligibility without leaking raw errors',async()=>{
 for(const error of [{code:'FETCH_HTTP',httpStatus:503},{code:'FETCH_HTTP',httpStatus:429},{code:'FETCH_DNS'},{code:'FETCH_IDLE_TIMEOUT'},{code:'FETCH_DEADLINE'},{code:'FETCH_TRUNCATED'},{code:'ECONNRESET'},{code:'ETIMEDOUT'},{code:'EAI_AGAIN'},{code:'SOURCE_UNAVAILABLE',transient:true}]){
  const f=fixture({custom:async parsed=>{if(parsed.hostname==='openlibrary.org')throw Object.assign(new Error('SECRET transient diagnostics'),error);}});
  const result=await f.search('Test Book',{maxRequests:1});const issue=result.providerErrors.find(item=>item.provider==='openlibrary');assert.equal(issue.code,'SOURCE_UNAVAILABLE',error.code);assert.equal(issue.retryable,true,error.code);assert.equal(result.requestCount,1);assert.ok(!JSON.stringify(result).includes('SECRET'));
 }
});

test('permanent access, TLS, format and unknown failures never advertise a durable retry',async()=>{
 for(const error of [{code:'FETCH_HTTP',httpStatus:401},{code:'FETCH_HTTP',httpStatus:403},{code:'FETCH_HTTP',httpStatus:410},{code:'FETCH_HTTP',httpStatus:451},{code:'FETCH_HTTP',httpStatus:404},{code:'FETCH_HTTP',httpStatus:'503'},{code:'FETCH_SSRF'},{code:'CERT_HAS_EXPIRED'},{code:'ERR_TLS_CERT_ALTNAME_INVALID'},{code:'FETCH_REDIRECT_LIMIT'},{code:'RESPONSE_FORMAT'},{code:'SOURCE_UNAVAILABLE'},{code:'UNKNOWN'}]){
  const f=fixture({custom:async parsed=>{if(parsed.hostname==='openlibrary.org')throw Object.assign(new Error('SECRET permanent diagnostics'),error);}});
  const result=await f.search('Test Book',{maxRequests:1}),issue=result.providerErrors.find(item=>item.provider==='openlibrary');assert.equal(issue.retryable,false,JSON.stringify(error));assert.equal(issue.code,error.code==='FETCH_HTTP'&&[401,403,410,451].includes(error.httpStatus)?'SOURCE_ACCESS_DENIED':error.code==='RESPONSE_FORMAT'?'RESPONSE_FORMAT':'SOURCE_UNAVAILABLE');assert.equal(result.retryCount,0);assert.ok(!JSON.stringify(result).includes('SECRET'));
 }
 const malformed=await fixture({open:[null]}).search('Test Book');assert.equal(malformed.providerErrors.find(item=>item.code==='MALFORMED_ITEM').retryable,false);
});

test('Gutendex queries use at most three useful words without weakening exact result identity',async()=>{
 assert.equal(gutenbergSearchTerms("Alice's Adventures in Wonderland"),'Alice Adventures Wonderland');
 assert.equal(gutenbergSearchTerms('Rendezvous with Rama'),'Rendezvous Rama');
 assert.equal(gutenbergSearchTerms('Arthur C. Clarke'),'Arthur Clarke');assert.equal(gutenbergSearchTerms('The'),'The');assert.equal(gutenbergSearchTerms('A'),'A');assert.equal(gutenbergSearchTerms('2001: A Space Odyssey'),'2001 Space Odyssey');
 const title="Alice's Adventures in Wonderland",f=fixture({gut:[gutenberg({title,authors:[{name:'Carroll, Lewis'}]})]});
 const result=await f.search(title);assert.equal(new URL(f.calls.find(call=>new URL(call.url).hostname==='gutendex.com').url).searchParams.get('search'),'Alice Adventures Wonderland');assert.equal(result.status,'resolved');assert.equal(result.candidates[0].title,title);
 const adapted=await fixture({gut:[gutenberg({title:title+' (adapted)'})]}).search(title);assert.notEqual(adapted.status,'resolved');assert.equal(adapted.selectedCandidateId,null);
});

test('selected OL Gutenberg hint uses only fixed ID after fresh canonical title and author checks',async()=>{
 const selected=(await fixture({open:[openBook('OL1W','Saved label',{id_project_gutenberg:['11']})]}).search('Saved label')).candidates[0],calls=[];
 const result=await searchSelectedDiscovery({...selected,title:'Injected label',authors:[{name:'Injected author'}]},{fetchSafe:async url=>{
  calls.push(url);const parsed=new URL(url);
  return jsonResponse(parsed.pathname==='/works/OL1W.json'?{key:'/works/OL1W',title:'Actual Book',authors:[{author:{key:'/authors/OL1A'}}]}:parsed.pathname==='/authors/OL1A.json'?author('OL1A','Canonical Writer'):parsed.pathname==='/books/11/'?gutenberg({title:'Actual Book',authors:[{name:'Writer, Canonical'}]}):{data:[]},url);
 },sleep:async()=>{}});
 assert.equal(result.status,'resolved');assert.equal(result.nextAction,'acquire');assert.equal(result.requestCount,4);assert.equal(calls[2],'https://gutendex.com/books/11/');assert.equal(result.candidates[1].sourceLookupEvidence,'fixed-provider-ID-rechecked-title-and-author');assert.equal(result.candidates[1].title,'Actual Book');assert.ok(calls.every(url=>!url.includes('search=')));
});

test('Gutenberg hint mismatch cannot substitute another work or remove file verification',async()=>{
 const selected=(await fixture({open:[openBook('OL1W','Test Book',{id_project_gutenberg:['11']})]}).search('Test Book')).candidates[0];
 for(const changes of [{id:12},{title:'Different Book'},{authors:[{name:'Other Writer'}]}]){
  const result=await searchSelectedDiscovery(selected,{fetchSafe:async url=>{
   const parsed=new URL(url);return jsonResponse(parsed.pathname==='/works/OL1W.json'?openBook():parsed.pathname==='/authors/OL1A.json'?author('OL1A','Test Author'):parsed.hostname==='gutendex.com'?gutenberg(changes):{data:[]},url);
  },sleep:async()=>{}});
  assert.notEqual(result.status,'resolved');assert.equal(result.selectedCandidateId,null);assert.ok(result.providerErrors.some(error=>['RESPONSE_FORMAT','CONFLICTING_METADATA'].includes(error.code)&&error.retryable===false));
 }
 const f=fixture();await assert.rejects(()=>f.search('Test Book',{trustedGutenbergHint:{provider:'gutenberg',remoteId:'../11'}}),TypeError);assert.equal(f.calls.length,0);
});
