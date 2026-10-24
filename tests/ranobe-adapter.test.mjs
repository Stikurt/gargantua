import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalRanobeNumber,compareRanobeNumbers,normalizeRanobeInventory,selectRanobeBranch,verifyRanobeChapter,createRanobeAdapter,ranobeSlug,extractRanobeImageUrls,validateRanobeImageUrl,sanitizeRanobeTransportError} from '../server/ranobe.mjs';
import {normalizeRanobeContent} from '../server/ranobe-content.mjs';
import {createHash} from 'node:crypto';
const slug='107497--wo-julong-lingzhu',url=`https://ranobelib.me/ru/book/${slug}`;
const branch=(id=100,branch_id=null,changes={})=>({id,branch_id,created_at:'2021-12-16T03:56:58.000000Z',expired_type:0,teams:[{id:7,name:'Team',user:{token:'private'}}],user:{username:'not retained'},...changes});
const chapter=(number='1',id=100,changes={})=>({id,index:Number(id)-99,volume:'1',number,number_secondary:'1',branches_count:1,branches:[branch(id)],name:'Chapter',...changes});
const meta=(count=2,changes={})=>({id:107497,site:3,slug_url:slug,rus_name:'Title',name:'Original',is_licensed:false,items_count:{uploaded:count,total:0},authors:[{name:'Writer',user_id:123}],...changes});
const normalize=(list=[chapter(),chapter('2',101)],changes={})=>normalizeRanobeInventory({slug,meta:meta(list.length),list,...changes});
const payload=(changes={})=>({id:100,manga_id:107497,branch_id:null,volume:'1',number:'1',number_secondary:'1',created_at:'2021-12-16T03:56:58.000000Z',expired_type:0,expired_at:null,bundle_id:null,name:'One',content:'<p>Actual inert-input HTML to quarantine.</p>',...changes});
function fixture({response,fetch,clock}={}){const calls=[],sleeps=[];let now=0;const adapter=createRanobeAdapter({clock:clock??(()=>now),sleep:async(ms,signal)=>{signal.throwIfAborted();sleeps.push(ms);now+=ms;},fetchSafe:async(url,options)=>{calls.push({url,options,time:now});if(fetch)return fetch(url,options);const path=new URL(url).pathname;const data=path.endsWith('/chapters')?[chapter(),chapter('2',101)]:path.endsWith('/chapter')?payload():path==='/api/manga'?[{slug_url:slug,rus_name:'Title',name:'Original',site:3}]:meta();const envelope=response?response(url):{data};return {buffer:Buffer.from(JSON.stringify(envelope)),url,type:'application/json'};}});return {adapter,calls,sleeps};}

test('decimal canonicalization and comparison never use floats or lexical 10-before-2 order',()=>{
 assert.equal(canonicalRanobeNumber('00190.100'),'190.1');assert.equal(canonicalRanobeNumber('0.000'),'0');
 assert.ok(compareRanobeNumbers('190','190.1')<0);assert.ok(compareRanobeNumbers('190.1','191')<0);assert.ok(compareRanobeNumbers('9','10')<0);assert.ok(compareRanobeNumbers('1.000000001','1.000000002')<0);assert.equal(compareRanobeNumbers('1.0','01'),0);
 for(const value of ['1e2','1/2','1a','1.','-1',' 1','1.1234567890','9'.repeat(13),1.1,NaN,Infinity])assert.throws(()=>canonicalRanobeNumber(value));
});
test('normalized inventory preserves API order and real fractional chapter, not original-work completeness',()=>{
 const list=[chapter('190',100),chapter('190.1',101),chapter('191',102)],info=normalize(list);
 assert.deepEqual(info.list.map(c=>c.number),['190','190.1','191']);assert.deepEqual(info.list.map(c=>c.apiOrder),[0,1,2]);assert.equal(info.completeness.verified,true);assert.equal(info.completeness.originalWorkComplete,false);assert.equal(info.language,null);assert.equal(info.branches[0].id,null);assert.equal(info.branches[0].chapterCount,3);assert.equal(info.inventorySha256.length,64);
 assert.ok(!JSON.stringify(info).includes('not retained'));assert.ok(!JSON.stringify(info).includes('private'));assert.ok(!JSON.stringify(info).includes('user_id'));
});
test('source count mismatch or pagination evidence cannot claim full inventory',()=>{
 for(const changes of [{meta:meta(3)},{envelope:{links:{next:'https://secret.test/?token=x'}}},{envelope:{meta:{current_page:1,last_page:2}}},{envelope:{meta:{total:3}}},{envelope:{pagination:{next_cursor:'hidden'}}},{envelope:{links:[]}}])assert.throws(()=>normalize(undefined,changes),{code:'RANOBE_INCOMPLETE'});
 const unknown=normalize(undefined,{meta:meta(2,{items_count:undefined})});assert.equal(unknown.completeness.verified,false);assert.throws(()=>selectRanobeBranch(unknown,null,{requireComplete:true}),{code:'RANOBE_INCOMPLETE'});
});
test('a lagging card count needs two identical complete observations and retains its discrepancy',()=>{
 const list=[chapter(),chapter('2',101)],first={slug,meta:meta(1),list,envelope:{data:list}},confirmation={meta:meta(1),list:structuredClone(list),envelope:{data:list}};
 assert.throws(()=>normalizeRanobeInventory(first),{code:'RANOBE_INCOMPLETE'});
 const info=normalizeRanobeInventory({...first,confirmation});assert.equal(info.completeness.verified,true);assert.equal(info.completeness.verificationBasis,'stable-unpaginated-source-inventory');assert.equal(info.completeness.observations,2);assert.equal(info.completeness.originalWorkComplete,false);assert.deepEqual(info.completeness.counterMismatch,{code:'SOURCE_CARD_COUNT_BEHIND_INVENTORY',reportedUploaded:1,received:2});assert.equal(selectRanobeBranch(info,null,{requireComplete:true}).chapters.length,2);
 const changed=[{meta:meta(2),list},{meta:meta(1,{id:999}),list},{meta:meta(1,{rus_name:'Another book'}),list},{meta:meta(1),list:[chapter(),chapter('3',101)]},{meta:meta(1),list:[chapter(),chapter('2',101,{branches:[branch(101,null,{is_paid:true})]})]},{meta:meta(1),list,envelope:{meta:{last_page:2}}},{meta:meta(3),list},{meta:meta(1),list:[],envelope:{}},{meta:meta(1),list,envelope:{links:{next:'https://example.invalid'}}}];
 for(const value of changed)assert.throws(()=>normalizeRanobeInventory({...first,confirmation:value}),error=>/^RANOBE_/u.test(error.code));
 for(const envelope of [{meta:{has_more:1}},{meta:{has_more:'true'}},{meta:{hasMore:null}},{meta:{pagination:{next_cursor:'more'}}},{meta:{next_page_url:'https://example.invalid/next'}},{links:{next_cursor:'more'}},{links:{prev:'https://example.invalid/page/1'}}]){
  assert.throws(()=>normalizeRanobeInventory({...first,envelope,confirmation}),{code:'RANOBE_INCOMPLETE'});
  assert.throws(()=>normalizeRanobeInventory({...first,confirmation:{...confirmation,envelope}}),{code:'RANOBE_INCOMPLETE'});
 }
 assert.throws(()=>normalizeRanobeInventory({...first,meta:meta(3),confirmation}),{code:'RANOBE_INCOMPLETE'});
});
test('adapter double-reads only a lagging counter, without fetching any chapter content',async()=>{
 let cards=0,lists=0;const f=fixture({response:url=>new URL(url).pathname.endsWith('/chapters')?(lists++,{data:[chapter(),chapter('2',101)]}):(cards++,{data:meta(1)})});const info=await f.adapter.resolveRanobe(url);assert.equal(info.completeness.verified,true);assert.equal(cards,2);assert.equal(lists,2);assert.equal(f.calls.length,4);assert.ok(f.calls.every(call=>!new URL(call.url).pathname.endsWith('/chapter')));
 const changing=fixture({response:url=>new URL(url).pathname.endsWith('/chapters')?{data:[chapter(),chapter(String(++lists),101)]}:{data:meta(1)}});await assert.rejects(()=>changing.adapter.resolveRanobe(url),error=>/^RANOBE_/u.test(error.code));
 const short=fixture({response:url=>new URL(url).pathname.endsWith('/chapters')?{data:[chapter()]}:{data:meta(3)}});await assert.rejects(()=>short.adapter.resolveRanobe(url),{code:'RANOBE_INCOMPLETE'});assert.equal(short.calls.length,2);
});
test('coordinates, release IDs, branch IDs, source indexes and branch counts are unambiguous',()=>{
 const bad=[ [chapter(),chapter('1.0',101)], [chapter('2',100),chapter('1',101)], [chapter(),chapter('2',101,{index:1})], [chapter(),chapter('2',101,{branches:[branch(100)]})], [chapter('1',100,{branches:[branch(100),branch(101)],branches_count:2})], [chapter('1',100,{branches_count:2})], [chapter('1',100,{branches:[{id:100}]})] ];
 for(const list of bad)assert.throws(()=>normalize(list),{code:'RANOBE_INVENTORY'});
 const reset=normalize([chapter('10',100),chapter('1',101,{volume:'2'})]);assert.equal(reset.list[1].volume,'2');
 assert.throws(()=>normalize([chapter('1',100,{branches:[branch(101)]})]),{code:'RANOBE_INVENTORY'});
});
test('branch choice is explicit, default null is real, changing teams does not invent a new branch',()=>{
 const info=normalize([chapter(),chapter('2',101,{branches:[branch(101,null,{teams:[{id:9,name:'Other team'}]})]})]);
 assert.equal(info.branches.length,1);assert.equal(selectRanobeBranch(info,null,{requireComplete:true}).chapters.length,2);assert.throws(()=>selectRanobeBranch(info,undefined),{code:'RANOBE_IDENTITY'});assert.throws(()=>selectRanobeBranch(info,77),{code:'RANOBE_IDENTITY'});
 const multi=normalize([chapter('1',100,{branches:[branch(100,null),branch(200,77)],branches_count:2})]);assert.equal(selectRanobeBranch(multi,77).chapters.length,1);assert.equal(multi.branches.length,2);
});
test('metadata bindings and access restriction signals fail closed',()=>{
 for(const changed of [{id:999},{site:1},{slug_url:'999--wrong'}])assert.throws(()=>normalize(undefined,{meta:meta(2,changed)}),{code:'RANOBE_IDENTITY'});
 assert.throws(()=>normalize(undefined,{meta:meta(2,{is_licensed:true})}),{code:'RANOBE_RESTRICTED'});
 const info=normalize([chapter('1',100,{branches:[branch(100,null,{expired_type:1})]})]);assert.equal(info.branches[0].restrictedCount,1);assert.throws(()=>selectRanobeBranch(info,null),{code:'RANOBE_RESTRICTED'});
});
test('chapter identity is work+branch+volume+number, release ID and optional secondary agree',()=>{
 const info=normalize(),verified=verifyRanobeChapter(payload(),{slug,chapter:info.list[0],branchId:null});
 assert.equal(verified.sourceChapterKey,'ranobelib:107497:default:v1:c1');assert.equal(verified.releaseId,'100');assert.equal(verified.identityVerified,true);assert.equal(verified.contentSha256.length,64);assert.equal(verified.language,null);assert.equal(verified.revisionHints.timestampIsContentRevision,false);assert.equal(verified.revisionHints.updatedAt,null);
 for(const changed of [{id:101},{manga_id:999},{branch_id:77},{volume:'2'},{number:'2'},{number_secondary:'2'},{branch_id:undefined}])assert.throws(()=>verifyRanobeChapter(payload(changed),{slug,chapter:info.list[0],branchId:null}),{code:'RANOBE_IDENTITY'});
 const revision=verifyRanobeChapter(payload({content:'<p>Changed text.</p>'}),{slug,chapter:info.list[0],branchId:null});assert.equal(revision.sourceChapterKey,verified.sourceChapterKey);assert.notEqual(revision.contentSha256,verified.contentSha256);
});
test('chapter restriction, absent/JSON content and overlarge HTML are not usable',()=>{
 const item=normalize().list[0];for(const changed of [{is_paid:true},{expired_type:1},{expired_at:'2099-01-01T00:00:00Z'},{bundle_id:9},{price:'1.00'},{is_locked:true}])assert.throws(()=>verifyRanobeChapter(payload(changed),{slug,chapter:item,branchId:null}),{code:'RANOBE_RESTRICTED'});
 for(const content of [null,[],{type:'doc'},'', ' ', 'x'.repeat(2*1024*1024+1)])assert.throws(()=>verifyRanobeChapter(payload({content}),{slug,chapter:item,branchId:null}),{code:'RANOBE_CONTENT'});
 assert.throws(()=>verifyRanobeChapter(payload({type:'manga'}),{slug,chapter:item,branchId:null}),{code:'RANOBE_CONTENT'});
});
test('observed typed doc/paragraph/text is escaped before the existing isolated HTML parser',async()=>{
 const content={type:'doc',content:[{type:'paragraph'},{type:'paragraph',content:[{type:'text',text:'<script>alert("x")</script> & \u041f\u0440\u0438\u0432\u0435\u0442'},{type:'text',text:" 'quoted'"}]}]},expected='<p></p><p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; Привет &#39;quoted&#39;</p>';
 assert.equal(normalizeRanobeContent(content),expected);const data=payload({content}),verified=verifyRanobeChapter(data,{slug,chapter:normalize().list[0],branchId:null});assert.equal(verified.content,expected);assert.equal(verified.identityVerified,true);assert.equal(verified.contentSha256,createHash('sha256').update(expected).digest('hex'));
 const f=fixture({response:request=>new URL(request).pathname.endsWith('/chapter')?{data}:{data:meta()}}),result=await f.adapter.fetchRanobeChapter(normalize(),normalize().list[0],null);assert.equal(result.data.content,expected);assert.equal(JSON.parse(result.raw).data.content.type,'doc','the original source response remains the raw AV input, not the converted markup');
 for(const changed of [{id:101},{manga_id:999},{branch_id:77},{expired_type:1}])assert.throws(()=>verifyRanobeChapter({...data,...changed},{slug,chapter:normalize().list[0],branchId:null}));
});
test('typed content rejects unknown nodes, properties, marks, malformed text and empty documents',()=>{
 const doc=child=>({type:'doc',content:[{type:'paragraph',content:[child]}]}),text={type:'text',text:'Safe fixture'};
 for(const value of [{type:'doc',content:[]},{type:'doc',content:[{type:'paragraph'}]},doc({type:'text',text:' \n\t '}),doc({type:'script',text:'bad'}),doc({...text,marks:[{type:'unobserved-mark'}]}),doc({...text,attrs:{onclick:'bad'}}),doc({...text,text:'\ud800'}),doc({...text,text:'control\u0000'}),{type:'doc',content:[{type:'paragraph',attrs:{style:'bad'},content:[text]}]},{type:'doc',content:[{type:'image',attrs:{src:'https://evil.invalid/image.png'}}]},doc({...text,text:12}),{type:'doc',content:[{type:'doc',content:[]}]}])assert.throws(()=>normalizeRanobeContent(value),{code:'RANOBE_CONTENT'});
 const cycle={type:'doc',content:[]};cycle.content.push(cycle);assert.throws(()=>normalizeRanobeContent(cycle),{code:'RANOBE_CONTENT'});
 let deep={};for(let i=0;i<10000;i++)deep={content:deep};assert.throws(()=>normalizeRanobeContent({type:'doc',content:[{type:'paragraph'}],unknown:deep}),{code:'RANOBE_CONTENT'});
});
test('observed typed scene breaks and bold/italic marks preserve inert text and source identity',()=>{
 const content={type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Before <script> &',marks:[{type:'italic'}]}]},{type:'horizontalRule'},{type:'paragraph',content:[{type:'text',text:'After',marks:[{type:'bold'},{type:'italic'}]}]}]},before=structuredClone(content);
 const expected='<p><em>Before &lt;script&gt; &amp;</em></p><p>***</p><p><strong><em>After</em></strong></p>';
 assert.equal(normalizeRanobeContent(content),expected);assert.deepEqual(content,before);
 const verified=verifyRanobeChapter(payload({content}),{slug,chapter:normalize().list[0],branchId:null});
 assert.equal(verified.content,expected);assert.equal(verified.identityVerified,true);
 assert.equal(verified.contentSha256,createHash('sha256').update(expected).digest('hex'));
 assert.equal(normalizeRanobeContent({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Unmarked',marks:[]}]}]}),'<p>Unmarked</p>');
});
test('typed marks and scene breaks reject attributes, duplicates, unknown shapes and wrong nesting',()=>{
 const text={type:'text',text:'Safe'},doc=child=>({type:'doc',content:[{type:'paragraph',content:[child]}]});
 for(const marks of [null,{},'italic',[{type:'italic',attrs:{href:'javascript:bad'}}],[{type:'bold',onclick:'bad'}],[{type:'italic'},{type:'italic'}],[{type:'bold'},{type:'italic'},{type:'bold'}],[{type:'link'}],[{type:'script'}],[{}]])assert.throws(()=>normalizeRanobeContent(doc({...text,marks})),{code:'RANOBE_CONTENT'});
 for(const rule of [{type:'horizontalRule',attrs:{}},{type:'horizontalRule',content:[]},{type:'horizontalRule',text:'unexpected'},{type:'horizontalRule',onclick:'bad'}])assert.throws(()=>normalizeRanobeContent({type:'doc',content:[{type:'paragraph',content:[text]},rule]}),{code:'RANOBE_CONTENT'});
 assert.throws(()=>normalizeRanobeContent(doc({type:'horizontalRule'})),{code:'RANOBE_CONTENT'});
 assert.throws(()=>normalizeRanobeContent({type:'doc',content:[{type:'horizontalRule'}]}),{code:'RANOBE_CONTENT'},'scene breaks alone are not a book chapter');
 const marked={type:'paragraph',content:[{...text,marks:[{type:'bold'},{type:'italic'}]}]};
 assert.throws(()=>normalizeRanobeContent({type:'doc',content:Array.from({length:5000},()=>marked)}),{code:'RANOBE_CONTENT'},'mark nodes count against the same bounded node budget');
});
test('observed centered typed paragraph keeps its text and marks without introducing CSS or attributes',()=>{
 const content={type:'doc',content:[{type:'paragraph',attrs:{textAlign:'center'},content:[{type:'text',text:'Centered <img src="bad">',marks:[{type:'bold'}]}]}]},before=structuredClone(content);
 assert.equal(normalizeRanobeContent(content),'<p><strong>Centered &lt;img src=&quot;bad&quot;&gt;</strong></p>');assert.deepEqual(content,before);
 for(const attrs of [null,[],{},{textAlign:'javascript:bad'},{textAlign:'center',style:'bad'},{textAlign:'center',onclick:'bad'},{style:'text-align:center'},{textAlign:{toString:'bad'}}])assert.throws(()=>normalizeRanobeContent({type:'doc',content:[{...content.content[0],attrs}]}),{code:'RANOBE_CONTENT'});
});
test('observed hard breaks preserve text order only inside paragraphs',()=>{
 const content={type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'First'},{type:'hardBreak'},{type:'text',text:'Second',marks:[{type:'italic'}]}]}]},before=structuredClone(content);
 assert.equal(normalizeRanobeContent(content),'<p>First<br><em>Second</em></p>');assert.deepEqual(content,before);
 for(const node of [{type:'hardBreak',attrs:{}},{type:'hardBreak',text:'bad'},{type:'hardBreak',marks:[]},{type:'hardBreak',content:[]}])assert.throws(()=>normalizeRanobeContent({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Safe'},node]}]}),{code:'RANOBE_CONTENT'});
 assert.throws(()=>normalizeRanobeContent({type:'doc',content:[{type:'hardBreak'}]}),{code:'RANOBE_CONTENT'});
 assert.throws(()=>normalizeRanobeContent({type:'doc',content:[{type:'paragraph',content:[{type:'hardBreak'}]}]}),{code:'RANOBE_CONTENT'});
});
test('typed content enforces node, individual text, serialized input and escaped-output budgets independently',()=>{
 const paragraph=text=>({type:'paragraph',content:[{type:'text',text}]}),doc=content=>({type:'doc',content});
 assert.equal(normalizeRanobeContent(doc([paragraph('Normal fixture')])), '<p>Normal fixture</p>');
 assert.throws(()=>normalizeRanobeContent(doc([paragraph('x'.repeat(100001))])),{code:'RANOBE_CONTENT'});
 assert.throws(()=>normalizeRanobeContent(doc(Array.from({length:5},()=>paragraph('&'.repeat(100000))))),{code:'RANOBE_CONTENT'},'escaping grows output beyond 2 MiB even when the source is small');
 assert.throws(()=>normalizeRanobeContent(doc(Array.from({length:11},()=>paragraph('\\'.repeat(100000))))),{code:'RANOBE_CONTENT'},'JSON escaping exceeds the input budget while escaped HTML stays below it');
 const allowed=Array.from({length:19997},()=>({type:'paragraph'}));allowed.push(paragraph('Safe'));assert.ok(normalizeRanobeContent(doc(allowed)).endsWith('<p>Safe</p>'));
 allowed.push({type:'paragraph'});assert.throws(()=>normalizeRanobeContent(doc(allowed)),{code:'RANOBE_CONTENT'},'20k typed node budget includes the document and text node');
});
test('observed JSON image UUID resolves through its exact declared attachment and selected work/release',()=>{
 const name='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',relative=`/uploads/ranobe/107497/chapters/100/${name}.jpg`,url='https://ranobelib.me'+relative;
 const attachment={filename:name+'.jpg',name,extension:'jpg',width:735,height:592,url:relative,previewUrl:relative,originalUrl:relative},content={type:'doc',content:[{type:'paragraph'},{type:'image',attrs:{description:null,images:[{image:name}]}}]},before=structuredClone(content);
 const verified=verifyRanobeChapter(payload({content,attachments:[attachment]}),{slug,chapter:normalize().list[0],branchId:null});assert.equal(verified.content,`<p></p><img src="${url}" alt="">`);assert.deepEqual(content,before,'conversion must not change the source editor object');
 assert.deepEqual(extractRanobeImageUrls(verified.content,{slug,releaseId:'100'}),[{ref:url,url}]);assert.equal(validateRanobeImageUrl(url,{slug,releaseId:'100'}),url);
 for(const replacements of [{attachments:[]},{attachments:null},{attachments:[attachment,attachment]},{attachments:[{...attachment,filename:'wrong.jpg'}]},{attachments:[{...attachment,width:0}]},{attachments:[{...attachment,height:20001}]},{attachments:[{...attachment,width:10000,height:10000}]},{attachments:[{...attachment,extension:'svg'}]},{attachments:[{...attachment,unexpected:'bad'}]},{attachments:[{...attachment,previewUrl:relative+'?x=1'}]},{attachments:[{...attachment,url:relative.replace('/100/','/101/'),previewUrl:relative.replace('/100/','/101/'),originalUrl:relative.replace('/100/','/101/')}]}])assert.throws(()=>verifyRanobeChapter(payload({content,attachments:[attachment],...replacements}),{slug,chapter:normalize().list[0],branchId:null}),{code:'RANOBE_CONTENT'});
 for(const changed of [relative.replace('/107497/','/999/'),relative.replace(name+'.jpg','other/../'+name+'.jpg'),relative.replace(name+'.jpg','%61'+name.slice(1)+'.jpg'),'//evil.invalid/'+name+'.jpg','https://evil.invalid/'+name+'.jpg'])assert.throws(()=>verifyRanobeChapter(payload({content,attachments:[{...attachment,url:changed,previewUrl:changed,originalUrl:changed}]}),{slug,chapter:normalize().list[0],branchId:null}),{code:'RANOBE_CONTENT'});
 assert.throws(()=>normalizeRanobeContent(content,{attachments:[attachment]}),{code:'RANOBE_CONTENT'},'attachments require the trusted caller URL policy callback');
 const image=structuredClone(content.content[1]);image.attrs.description='Unobserved caption';assert.throws(()=>verifyRanobeChapter(payload({content:{type:'doc',content:[image]},attachments:[attachment]}),{slug,chapter:normalize().list[0],branchId:null}),{code:'RANOBE_CONTENT'});
 const gallery=structuredClone(content.content[1]);gallery.attrs.images.push({image:name});assert.throws(()=>verifyRanobeChapter(payload({content:{type:'doc',content:[gallery]},attachments:[attachment]}),{slug,chapter:normalize().list[0],branchId:null}),{code:'RANOBE_CONTENT'});
 const repeated={type:'doc',content:Array.from({length:51},()=>structuredClone(content.content[1]))};assert.throws(()=>verifyRanobeChapter(payload({content:repeated,attachments:[attachment]}),{slug,chapter:normalize().list[0],branchId:null}),{code:'RANOBE_CONTENT'});
 assert.throws(()=>verifyRanobeChapter(payload({content:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Safe'}]}]},attachments:[attachment]}),{slug,chapter:normalize().list[0],branchId:null}),{code:'RANOBE_CONTENT'},'orphan declared images are not silently discarded');
});
test('canonical card URL rejects credentials, arbitrary paths, hostnames and fragment tricks',()=>{
 assert.equal(ranobeSlug(url+'?section=chapters'),slug);for(const value of ['http://ranobelib.me/ru/book/'+slug,'https://evil.test/ru/book/'+slug,'https://u:p@ranobelib.me/ru/book/'+slug,url+'#x','https://ranobelib.me/arbitrary/'+slug,url+'/chapter','https://ranobelib.me/ru/book/%31--x'])assert.throws(()=>ranobeSlug(value),{code:'RANOBE_INPUT'});
});
test('factory preserves manual search/resolve/list fields and emits fixed polite no-redirect requests',async()=>{
 const f=fixture(),search=await f.adapter.searchRanobe('  Title  ');assert.equal(search[0].url,url);const info=await f.adapter.resolveRanobe(url);assert.equal(info.chapters,2);assert.equal(info.list[0].branches[0].branch_id,null);assert.equal(info.branches[0].id,null);assert.ok(f.sleeps.length>=2);
 for(const call of f.calls){assert.equal(new URL(call.url).origin,'https://api.cdnlibs.org');assert.equal(call.options.maxRedirects,0);assert.equal(call.options.maxBytes,new URL(call.url).pathname.endsWith('/chapters')?8*1024*1024:2*1024*1024);assert.equal(call.options.headers['Site-Id'],'3');assert.equal(call.options.headers.Referer,'https://ranobelib.me/');assert.ok(call.options.timeoutMs<=15000);}
 const fetched=await f.adapter.fetchRanobeChapter(info,info.list[0],null);assert.equal(fetched.data.identityVerified,true);assert.ok(Buffer.isBuffer(fetched.raw));
});
test('suffix URLs and arbitrary API paths are refused before network I/O',async()=>{
 const f=fixture();for(const suffix of ['/../auth/me','/chapter?number=1&volume=1&token=x','/chapter?number=1&number=2&volume=1','?fields[]=password','/chapters?page=2','/chapter?number=1e2&volume=1','/chapter?number=1&volume=1&branch_id=0'])await assert.rejects(async()=>f.adapter.ranobeJson(slug,suffix));
 await assert.rejects(async()=>f.adapter.ranobeJson('../bad','/chapters'));assert.equal(f.calls.length,0);
});
test('malformed JSON/HTML, oversized responses, redirects and source errors reveal no raw secrets',async()=>{
 for(const fetch of [async(url)=>({url,type:'text/html',buffer:Buffer.from('<html>secret</html>')}),async(url)=>({url,type:'application/json',buffer:Buffer.from([0xff])}),async(url)=>({url,type:'application/json',buffer:Buffer.alloc(2*1024*1024+1)}),async()=>({url:'https://evil.test/?token=SECRET',type:'application/json',buffer:Buffer.from('{}')}),async()=>{throw new Error('raw https://secret.test/?token=SECRET');}]){
  const f=fixture({fetch});await assert.rejects(()=>f.adapter.ranobeJson(slug),(e)=>/^RANOBE_/u.test(e.code)&&!e.message.includes('SECRET'));
 }
 for(const response of [{error:'raw-secret',data:{}},{errors:{private:'raw'},data:{}},{success:false,data:{}},{data:null},[]])await assert.rejects(()=>fixture({response:()=>response}).adapter.ranobeJson(slug));
});
test('abort/deadline includes pacing and a transport ignoring cancellation, without retries',async()=>{
 const f=fixture({fetch:async()=>new Promise(()=>{})}),started=Date.now();await assert.rejects(()=>f.adapter.ranobeJson(slug,'',{timeoutMs:20}),{code:'RANOBE_TIMEOUT'});assert.ok(Date.now()-started<1000);assert.equal(f.calls.length,1);
 const controller=new AbortController();controller.abort();const aborted=fixture();await assert.rejects(()=>aborted.adapter.resolveRanobe(url,{signal:controller.signal}),{code:'RANOBE_ABORTED'});assert.equal(aborted.calls.length,0);
 const overall=fixture({fetch:async()=>new Promise(()=>{})});await assert.rejects(()=>overall.adapter.resolveRanobe(url,{timeoutMs:20}),{code:'RANOBE_TIMEOUT'});
 const safe=fixture({fetch:async()=>{throw Object.assign(new Error('https://secret.test/?token=SECRET'),{code:'RANOBE_RESPONSE'});}});await assert.rejects(()=>safe.adapter.ranobeJson(slug),e=>e.code==='RANOBE_RESPONSE'&&!e.message.includes('SECRET'));
});
test('HTTP access denial and missing chapters are permanent; only known temporary transport failures are retryable',async()=>{
 for(const status of [401,403,410,451])await assert.rejects(()=>fixture({fetch:async()=>{throw Object.assign(new Error('private upstream'),{code:'FETCH_HTTP',httpStatus:status});}}).adapter.ranobeJson(slug),{code:'RANOBE_RESTRICTED'});
 await assert.rejects(()=>fixture({fetch:async()=>{throw Object.assign(new Error('private'),{code:'FETCH_HTTP',httpStatus:404});}}).adapter.ranobeJson(slug),{code:'RANOBE_CONTENT'});
 for(const status of [408,425,429,500,502,503,504])await assert.rejects(()=>fixture({fetch:async()=>{throw Object.assign(new Error('private'),{code:'FETCH_HTTP',httpStatus:status});}}).adapter.ranobeJson(slug),e=>e.code==='RANOBE_UNAVAILABLE'&&e.transient===true&&e.httpStatus===status&&!e.message.includes('private'));
 for(const code of ['FETCH_SSRF','FETCH_TOO_LARGE','FETCH_REDIRECT_LIMIT','ERR_TLS_CERT_ALTNAME_INVALID'])await assert.rejects(()=>fixture({fetch:async()=>{throw Object.assign(new Error('private'),{code});}}).adapter.ranobeJson(slug),e=>e.code==='RANOBE_UNAVAILABLE'&&e.transient===false);
 await assert.rejects(()=>fixture({fetch:async()=>{throw Object.assign(new Error('private'),{code:'ECONNRESET'});}}).adapter.ranobeJson(slug),e=>e.code==='RANOBE_UNAVAILABLE'&&e.transient===true);
});
test('shared transport sanitizer keeps permanent image denials permanent and never exposes upstream data',()=>{
 const upstream=(code,extra={})=>Object.assign(new Error('PRIVATE https://secret.invalid/?token=SECRET'),{code,body:'PRIVATE',url:'https://secret.invalid/',...extra});
 for(const status of [401,403,410,451]){const safe=sanitizeRanobeTransportError(upstream('FETCH_HTTP',{httpStatus:status,transient:true}));assert.equal(safe.code,'RANOBE_RESTRICTED');assert.notEqual(safe.transient,true);assert.ok(!JSON.stringify(safe).includes('PRIVATE'));assert.ok(!safe.message.includes('SECRET'));}
 assert.equal(sanitizeRanobeTransportError(upstream('FETCH_HTTP',{httpStatus:404})).code,'RANOBE_CONTENT');
 for(const status of [408,425,429,500,502,503,504]){const safe=sanitizeRanobeTransportError(upstream('FETCH_HTTP',{httpStatus:status}));assert.equal(safe.code,'RANOBE_UNAVAILABLE');assert.equal(safe.transient,true);assert.equal(safe.httpStatus,status);const again=sanitizeRanobeTransportError(safe);assert.equal(again.code,safe.code);assert.equal(again.transient,true);assert.equal(again.httpStatus,status);}
 for(const code of ['RANOBE_IDENTITY','RANOBE_CONTENT','RANOBE_RESTRICTED','RANOBE_RESPONSE','RANOBE_TIMEOUT','RANOBE_ABORTED']){const safe=sanitizeRanobeTransportError(upstream(code,{transient:true}));assert.equal(safe.code,code);assert.notEqual(safe.transient,true);assert.ok(!safe.message.includes('PRIVATE'));assert.equal(safe.body,undefined);assert.equal(safe.url,undefined);}
 for(const code of ['FETCH_SSRF','FETCH_TOO_LARGE','FETCH_REDIRECT_LIMIT','ERR_TLS_CERT_ALTNAME_INVALID','UNKNOWN'])assert.equal(sanitizeRanobeTransportError(upstream(code,{transient:true})).transient,false);
 for(const code of ['FETCH_DNS','FETCH_DEADLINE','FETCH_IDLE_TIMEOUT','FETCH_TRUNCATED','ECONNRESET','ETIMEDOUT','ECONNREFUSED','EAI_AGAIN','ENOTFOUND','EHOSTUNREACH','ENETUNREACH','EPIPE'])assert.equal(sanitizeRanobeTransportError(upstream(code)).transient,true);
 assert.equal(sanitizeRanobeTransportError(upstream('ABORT_ERR')).code,'RANOBE_ABORTED');assert.equal(sanitizeRanobeTransportError(upstream('RANOBE_UNAVAILABLE',{httpStatus:403,transient:true})).transient,false);assert.equal(sanitizeRanobeTransportError(null).transient,false);
});
test('inventory max counts and numeric bounds are independent budgets',()=>{
 assert.throws(()=>normalize(Array.from({length:20001},()=>chapter())),{code:'RANOBE_INVENTORY'});
 assert.throws(()=>normalize([chapter('1',100,{branches:Array.from({length:51},(_,i)=>branch(100+i,i+1)),branches_count:51})]),{code:'RANOBE_INVENTORY'});
 assert.throws(()=>normalize([chapter('1',100,{branches:[branch(100,null,{teams:Array(21).fill({id:1,name:'Team'})})]})]),{code:'RANOBE_INVENTORY'});
});
test('image collector handles quoted/unquoted attributes and entities, preserving exact decoded refs',()=>{
 const refs=extractRanobeImageUrls('<p>Text</p><img alt="x" src="https://imglib.info/a.png?x=1&amp;y=2"><img SRC=https://cdnlibs.org/b.png><img src="https://imglib.info/a.png?x=1&#38;y=2">');
 assert.deepEqual(refs,[{ref:'https://imglib.info/a.png?x=1&y=2',url:'https://imglib.info/a.png?x=1&y=2'},{ref:'https://cdnlibs.org/b.png',url:'https://cdnlibs.org/b.png'}]);
 assert.equal(validateRanobeImageUrl('https://a.imglib.info/x.png'),'https://a.imglib.info/x.png');
 for(const ref of ['https://imglib.info.evil.test/a.png','https://evil.test/a.png','https://u:p@imglib.info/a.png','http://imglib.info/a.png','https://ranobelib.me/uploads/a.png','data:image/png;base64,A','//imglib.info/a.png'])assert.throws(()=>validateRanobeImageUrl(ref),{code:'RANOBE_CONTENT'});
});
test('image ambiguity/unknown attributes/limits are rejected without interpreting HTML as safe',()=>{
 for(const html of ['<img src="https://imglib.info/a.png" src="https://evil.test/a.png">','<img alt="no source">','<img src="https://imglib.info/a&unknown;.png">','<img src="https://imglib.info/a.png&#10;">'])assert.throws(()=>extractRanobeImageUrls(html),{code:'RANOBE_CONTENT'});
 assert.throws(()=>extractRanobeImageUrls('<img src="https://imglib.info/a.png"><img src="https://imglib.info/b.png">',{maxImages:1}),{code:'RANOBE_CONTENT'});
});
test('primary uploads image exception is bound to the selected work and release only',()=>{
 const image='https://ranobelib.me/uploads/ranobe/wo-julong-lingzhu/chapters/100/fixture_image.jpg',context={slug,releaseId:'100'};
 assert.equal(validateRanobeImageUrl(image,context),image);assert.deepEqual(extractRanobeImageUrls(`<p>Fixture</p><img loading="lazy" src="${image}">`,context),[{ref:image,url:image}]);
 for(const extension of ['png','jpeg','webp'])assert.equal(validateRanobeImageUrl(image.replace('.jpg','.'+extension),context),image.replace('.jpg','.'+extension));
 for(const options of [undefined,{}, {slug}, {releaseId:'100'}, {slug:'999--another-work',releaseId:'100'}, {slug,releaseId:'101'}, {slug,releaseId:'bad'}])assert.throws(()=>validateRanobeImageUrl(image,options),{code:'RANOBE_CONTENT'});
 const bad=[image+'?token=private',image+'#fragment',image.replace('https://','https://user:pass@'),image.replace('ranobelib.me','ranobelib.me:444'),image.replace('ranobelib.me','sub.ranobelib.me'),image.replace('/100/','/101/'),image.replace('wo-julong-lingzhu','another-work'),image.replace('fixture_image.jpg','../fixture_image.jpg'),image.replace('fixture_image.jpg','%2e%2e/fixture_image.jpg'),image.replace('fixture_image.jpg','%66ixture_image.jpg'),image.replace('fixture_image.jpg','nested/fixture_image.jpg'),image.replace('fixture_image.jpg','fixture..jpg'),image.replace('fixture_image.jpg','fixture.svg'),image.replace('/uploads/ranobe/','/uploads/other/'),image.replace('fixture_image.jpg','тест.jpg')];
 for(const value of bad)assert.throws(()=>validateRanobeImageUrl(value,context),{code:'RANOBE_CONTENT'});
 for(const value of [image+'?',image+'#',image.replace('ranobelib.me','ranobelib.me:443'),image.replace('fixture_image.jpg','other/../fixture_image.jpg'),image.replace('fixture_image.jpg','%2e/fixture_image.jpg'),image.replace('fixture_image.jpg','./fixture_image.jpg'),image.replace('fixture_image.jpg','other\\fixture_image.jpg')])assert.throws(()=>validateRanobeImageUrl(value,context),{code:'RANOBE_CONTENT'});
 assert.throws(()=>extractRanobeImageUrls(`<img src="${image}">`),{code:'RANOBE_CONTENT'});
 // Existing CDN support is unchanged and still does not need uploads context.
 assert.equal(validateRanobeImageUrl('https://a.imglib.info/fixture.png?x=1'),'https://a.imglib.info/fixture.png?x=1');
});
