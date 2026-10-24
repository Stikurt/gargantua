import test,{afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import express from 'express';
import {derivedRoutes,derivedRange,checkedDerivedResult,publicDerivedRequest,publicDerivedJob} from '../server/derived-api.mjs';
import {canonicalJson,sha256} from '../server/publication-model.mjs';
import {makeChapterSelection} from '../server/derived-selection.mjs';
import {parseAudioManifest} from '../src/audio.mjs';

const servers=[];
afterEach(async()=>{for(const server of servers.splice(0)){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}});
const profile={id:randomUUID(),role:'owner'},digest='a'.repeat(64),privateValue='DO_NOT_EXPOSE_PRIVATE_PATH_OR_TOKEN';
function fixture(kind='audio'){
 const jobId=randomUUID(),attempt=randomUUID(),sourceSha='b'.repeat(64),profileSha='c'.repeat(64),inputSha='d'.repeat(64);
 const bytes=kind==='audio'?Buffer.alloc(22050*2+44,1):Buffer.from('Перевод');
 const recipe={kind,language:'ru',manifest:{profileSha256:profileSha}},recipeSha=sha256(Buffer.from(canonicalJson(recipe)));recipe.sha256=recipeSha;
 const segment={schemaVersion:1,jobId,attemptId:attempt,ordinal:0,kind,inputSha256:inputSha,recipeSha256:recipeSha,profileSha256:profileSha,
  file:{path:`${attempt}/000000.${kind==='audio'?'wav':'txt'}`,sha256:sha256(bytes),bytes:bytes.length,mediaType:kind==='audio'?'audio/wav':'text/plain; charset=utf-8'},
  scan:{sha256:sha256(bytes),version:'fixture-scanner',checkedAt:new Date().toISOString()},quality:kind==='audio'?'technical-unlistened':'machine-draft',...(kind==='audio'?{pcm:{durationSeconds:1,sampleRate:22050}}:{})};
 const manifest={schemaVersion:1,jobId,kind,sourceSha256:sourceSha,recipeSha256:recipeSha,quality:segment.quality,segments:[segment],...(kind==='translation'?{publicationIds:[randomUUID()]}:{})};
 const source={sha256:sourceSha,work_id:randomUUID()},result={job_id:jobId,work_id:source.work_id,expression_id:randomUUID(),edition_id:randomUUID(),sha256:sha256(Buffer.from(canonicalJson(manifest))),manifest};
 const job={id:jobId,kind,status:'completed',source_sha256:sourceSha,recipe_sha256:recipeSha,total_segments:1,completed_segments:1,attempt_token:privateValue,plan:{sourceSha256:sourceSha,kind,segments:[{sourceSha256:inputSha,private:privateValue}]}};
 return {grant:{job,source,result},recipe,manifest,bytes};
}
async function appFor(overrides={},kind='audio'){
 const data=fixture(kind),calls=[];
 const services={getResult:async(_pool,p,id)=>{calls.push(['getResult',id]);if(p.role==='denied')throw Object.assign(Error('Не найдено'),{status:404});return structuredClone(data.grant);},getRecipe:async()=>structuredClone(data.recipe),readManifest:async()=>({manifest:structuredClone(data.manifest)}),readSegment:async()=>{calls.push(['readSegment']);return data.bytes;},
  request:async(_pool,p,input)=>{calls.push(['request',input]);return {request:{id:randomUUID(),job_id:data.grant.job.id,status:'active',revision:1,requested_by:p.id},job:data.grant.job,reused:false,idempotent:false};},
  getRequest:async()=>({id:randomUUID(),job_id:data.grant.job.id,status:'completed',revision:1,job:data.grant.job,result:data.grant.result,private:privateValue}),
  list:async()=>[{id:randomUUID(),job_id:data.grant.job.id,status:'active',revision:1,private:privateValue}],
  decide:async(_pool,_p,input)=>{calls.push(['decision',input]);return {id:input.id,job_id:data.grant.job.id,status:'active',revision:input.expectedRevision+1};},
  profiles:async()=>({profiles:{tts:{profileSha256:digest,descriptor:{id:'piper-denis-ru-v1',sourceLanguage:'ru',targetLanguage:'ru',qualityStatus:'NOT_LISTENED',private:privateValue}}}}),...overrides};
 const app=express();app.use(express.json({limit:'32kb'}));
 const auth=(req,_res,next)=>{if(req.get('Authorization')!=='fixture')return next(Object.assign(Error('Войдите'),{status:401}));req.profile={...profile,role:req.get('X-Test-Role')||'owner'};next();};
 derivedRoutes(app,{auth,pool:{},library:'/unused-private-library',wrap:fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next),error:(message,status)=>Object.assign(Error(message),{status}),services});
 app.use((error,_req,res,_next)=>res.status(error.name==='ZodError'?400:error.status||500).json({error:error.message}));
 const server=app.listen(0,'127.0.0.1');servers.push(server);await once(server,'listening');
 const base=`http://127.0.0.1:${server.address().port}`;
 const request=(path,options={})=>fetch(base+path,{...options,headers:{Authorization:'fixture',...(options.json?{'Content-Type':'application/json'}:{}),...options.headers},body:options.json?JSON.stringify(options.json):undefined});
 return {...data,services,calls,request,base};
}

test('strict request and decision schemas reject internal paths, recipes and loose booleans',async()=>{
 const h=await appFor(),valid={idempotencyKey:randomUUID(),kind:'translation',publicationIds:[randomUUID()],audio:false,glossary:{Moonbridge:'Лунный мост'}};
 for(const body of [{...valid,recipeSha256:digest},{...valid,url:'https://untrusted.invalid'},{...valid,audio:'false'},{...valid,profile:'/host/model'},{...valid,publicationIds:[]},{...valid,glossary:Object.fromEntries(Array.from({length:31},(_,i)=>['n'+i,'текст']))}])assert.equal((await h.request('/api/derived/requests',{method:'POST',json:body})).status,400);
 assert.equal(h.calls.length,0);
 const response=await h.request('/api/derived/requests',{method:'POST',json:valid});assert.equal(response.status,202);assert.equal(h.calls[0][1].audio,false);
 assert.equal(JSON.stringify(await response.json()).includes(privateValue),false);
 const route='/api/derived/requests/'+randomUUID()+'/decision';
 for(const body of [{action:'approve'},{action:'approve',expectedRevision:0},{action:'approve',expectedRevision:1,force:true}])assert.equal((await h.request(route,{method:'POST',json:body})).status,400);
 const changed=await h.request(route,{method:'POST',json:{action:'retry',expectedRevision:2}});assert.equal(changed.status,200);assert.equal((await changed.json()).revision,3);
});
test('all derived surfaces require a session before reading metadata or model profiles',async()=>{
 const h=await appFor();
 for(const path of ['/api/derived/requests','/api/derived/profiles','/api/derived/requests/'+randomUUID(),`/api/derived/jobs/${h.grant.job.id}/result`,`/api/derived/jobs/${h.grant.job.id}/audio/segments/0`])assert.equal((await fetch(h.base+path)).status,401);
 assert.equal(h.calls.length,0);
});
test('request/status/profile responses omit leases, paths and internal manifests',async()=>{
 const h=await appFor();
 for(const path of ['/api/derived/requests','/api/derived/profiles','/api/derived/requests/'+randomUUID()]){
  const response=await h.request(path);assert.equal(response.status,200);const text=await response.text();assert.equal(text.includes(privateValue),false);assert.equal(text.includes('attempt_token'),false);assert.equal(text.includes('plan'),false);
 }
 assert.equal((await h.request('/api/derived/requests?limit=101')).status,400);
 assert.equal((await h.request('/api/derived/requests?unknown=true')).status,400);
});
test('public requests expose only safe parent identities for translation-to-audio links',()=>{
 const parentJobId=randomUUID(),parentRequestId=randomUUID(),row={id:randomUUID(),job_id:randomUUID(),requested_by:profile.id,status:'active',revision:1,parent_job_id:parentJobId,parent_request_id:parentRequestId,attempt_token:privateValue,plan:{privateValue},private_path:privateValue};
 const body=publicDerivedRequest(row);assert.equal(body.parentJobId,parentJobId);assert.equal(body.parentRequestId,parentRequestId);assert.equal(JSON.stringify(body).includes(privateValue),false);
 assert.equal(publicDerivedRequest({...row,parent_job_id:'../../private',parent_request_id:privateValue}).parentJobId,null);assert.equal(publicDerivedRequest({...row,parent_job_id:null,parent_request_id:undefined}).parentRequestId,null);
});
test('request metadata is bounded plain text with an explicit source language',()=>{
 const body=publicDerivedRequest({id:randomUUID(),job_id:randomUUID(),source_title:'  Original\n<script>literal title</script>\0  ',source_authors:['Writer One','Writer\tTwo',null,{html:'ignored'}],source_language:'en'});
 assert.equal(body.title,'Original <script>literal title</script>');assert.equal(body.author,'Writer One, Writer Two');assert.equal(body.sourceLanguage,'en');assert.equal(body.title.includes('\0'),false);assert.equal(JSON.stringify(body).includes('ignored'),false);
 const long=publicDerivedRequest({source_title:'x'.repeat(299)+'😀'.repeat(100),source_authors:Array(100).fill('Writer '.repeat(100)),source_language:'<html>'});assert.equal(long.title.length,299);assert.ok(long.title.isWellFormed());assert.ok(long.author.length<=300);assert.equal(long.sourceLanguage,null);
 const absent=publicDerivedRequest({});assert.equal(absent.title,'');assert.equal(absent.author,'');assert.equal(absent.sourceLanguage,null);
});
test('chapter admission accepts bounded audio and translation ranges and rejects overflow or mutable selectors',async()=>{
 const h=await appFor(),body={idempotencyKey:randomUUID(),kind:'translation',publicationIds:[randomUUID()],audio:false};
 for(const chapterRange of [{start:0,count:5},{start:1,count:6},{start:1,count:0},{start:1,count:5,next:true}])assert.equal((await h.request('/api/derived/requests',{method:'POST',json:{...body,chapterRange}})).status,400);
 assert.equal((await h.request('/api/derived/requests',{method:'POST',json:{...body,chapterRange:{start:6,count:5}}})).status,202);
 assert.equal((await h.request('/api/derived/requests',{method:'POST',json:{...body,kind:'audio',chapterRange:{start:51,count:50}}})).status,202);
 assert.equal((await h.request('/api/derived/requests',{method:'POST',json:{...body,kind:'audio',chapterRange:{start:1,count:51}}})).status,400);
 assert.deepEqual(h.calls.filter(c=>c[0]==='request').map(c=>c[1].chapterRange),[{start:6,count:5},{start:51,count:50}]);
});
test('public range and legacy-client title expose partial coverage and original parent coordinates safely',()=>{
 const id=randomUUID(),book={id,chapter_count:275,publication_manifest:{readingOrder:Array.from({length:275},(_,i)=>({chapterId:'c-'+i}))}},manifest={schemaVersion:2,parts:[{ordinal:0,publicationId:id,chapterCount:275}],snapshotId:randomUUID(),selection:makeChapterSelection([book],{start:6,count:5})},source_title='Цивилизация Мудрецов',row={source_title,source_manifest:manifest,source_sha256:digest};
 const value=publicDerivedRequest(row);assert.equal(value.title,'Цивилизация Мудрецов · Главы 6–10 из 275');assert.equal(value.bookTitle,source_title);assert.equal(value.rangeInTitle,true);assert.equal(value.partial,true);assert.deepEqual(value.chapterRange,{start:6,count:5,total:275,hasMore:true,nextStart:11});assert.deepEqual(value.publicationIds,[id]);assert.equal(value.snapshotId,manifest.snapshotId);assert.equal(JSON.stringify(value).includes('readingOrder'),false);
 const childManifest={...manifest,parts:[{ordinal:0,publicationId:id,chapterCount:5}],selection:makeChapterSelection([{...book,chapter_count:5,publication_manifest:{readingOrder:book.publication_manifest.readingOrder.slice(0,5)}}],{start:1,count:5})},child=publicDerivedJob({...row,source_manifest:childManifest,parent_source_manifest:manifest});assert.equal(child.chapterRange.total,5);assert.equal(child.originChapterRange.start,6);assert.equal(child.partial,true);assert.equal(child.title,value.title);
 const {selection,...legacyManifest}=manifest,legacy=publicDerivedRequest({...row,source_manifest:{...legacyManifest,schemaVersion:1}});assert.equal(legacy.rangeInTitle,false);
});
test('result publishes safe URLs and rechecks grant after reading immutable files',async()=>{
 const h=await appFor();const response=await h.request(`/api/derived/jobs/${h.grant.job.id}/result`);assert.equal(response.status,200);
 const body=await response.json();assert.equal(body.segments[0].url,`/api/derived/jobs/${h.grant.job.id}/audio/segments/0`);assert.equal(body.quality,'technical-unlistened');assert.equal(JSON.stringify(body).includes(h.manifest.segments[0].file.path),false);assert.equal(JSON.stringify(body).includes(privateValue),false);
 assert.equal(h.calls.filter(c=>c[0]==='getResult').length,2);
});
test('actual HTTP audio result keeps the installed native manifest contract for v1 and v2 sources',async()=>{
 for(const schemaVersion of [1,2]){
  const h=await appFor(),publicationId=randomUUID(),parts=[{ordinal:0,publicationId,chapterCount:275}],book={id:publicationId,chapter_count:275,publication_manifest:{readingOrder:Array.from({length:275},(_,i)=>({chapterId:'c-'+i}))}},sourceManifest={schemaVersion,sourceLanguage:'ru',parts,snapshotId:randomUUID(),...(schemaVersion===2?{selection:makeChapterSelection([book],{start:6,count:5},'audio')}:{})};
  h.grant.source.manifest=sourceManifest;h.grant.job.source_manifest=sourceManifest;h.grant.job.source_title='Полное название книги';h.grant.job.source_sha256=h.grant.source.sha256;
  const response=await h.request(`/api/derived/jobs/${h.grant.job.id}/result`);assert.equal(response.status,200);const bytes=new Uint8Array(await response.arrayBuffer()),expectedSha256=response.headers.get('X-Content-SHA256'),parsed=await parseAudioManifest(bytes,{expectedJobId:h.grant.job.id,expectedSha256});
  assert.deepEqual(Object.keys(parsed.manifest).sort(),['schemaVersion','jobId','kind','sourceSha256','recipeSha256','quality','workId','expressionId','editionId','segments'].sort());assert.equal(parsed.sha256,expectedSha256);assert.equal(parsed.manifest.segments[0].bytes,h.bytes.length);assert.equal(parsed.manifest.sourceSha256,h.grant.source.sha256);
  const body=JSON.parse(new TextDecoder().decode(bytes));for(const key of ['chapterRange','partial','title','bookTitle','rangeInTitle','publicationIds','snapshotId','originChapterRange'])assert.equal(Object.hasOwn(body,key),false,key+' must stay on request/job projections');
  const metadata=publicDerivedJob(h.grant.job);assert.equal(metadata.chapterRange.count,schemaVersion===2?5:275);assert.equal(metadata.partial,schemaVersion===2);assert.equal(metadata.rangeInTitle,schemaVersion===2);
 }
});
test('audio supports exact/suffix/range/If-Range and conditional ETag without skipping grants',async()=>{
 const h=await appFor(),url=`/api/derived/jobs/${h.grant.job.id}/audio/segments/0`;
 const whole=await h.request(url);assert.equal(whole.status,200);assert.equal(whole.headers.get('accept-ranges'),'bytes');const etag=whole.headers.get('etag');assert.deepEqual(Buffer.from(await whole.arrayBuffer()),h.bytes);
 const part=await h.request(url,{headers:{Range:'bytes=2-7'}});assert.equal(part.status,206);assert.equal(part.headers.get('content-range'),`bytes 2-7/${h.bytes.length}`);assert.deepEqual(Buffer.from(await part.arrayBuffer()),h.bytes.subarray(2,8));
 const suffix=await h.request(url,{headers:{Range:'bytes=-4'}});assert.equal(suffix.status,206);assert.equal((await suffix.arrayBuffer()).byteLength,4);
 const stale=await h.request(url,{headers:{Range:'bytes=2-7','If-Range':'"old"'}});assert.equal(stale.status,200);assert.equal((await stale.arrayBuffer()).byteLength,h.bytes.length);
 const unchanged=await h.request(url,{headers:{'If-None-Match':'W/'+etag}});assert.equal(unchanged.status,304);assert.equal((await unchanged.arrayBuffer()).byteLength,0);
 const denied=await h.request(url,{headers:{'If-None-Match':etag,'X-Test-Role':'denied'}});assert.equal(denied.status,404);
 for(const range of [`bytes=${h.bytes.length+1}-`,'bytes=2-1','bytes=-0','bytes=0-1,3-4','items=0-1'])assert.equal((await h.request(url,{headers:{Range:range}})).status,416);
});
test('source pause during file read prevents bytes and even cached304',async()=>{
 let reads=0;const h=await appFor({getResult:async()=>{if(++reads===2)throw Object.assign(Error('Приостановлено'),{status:423});return structuredClone(h.grant);}});
 const response=await h.request(`/api/derived/jobs/${h.grant.job.id}/audio/segments/0`,{headers:{'If-None-Match':'*'}});assert.equal(response.status,423);assert.notEqual(response.headers.get('etag'),`"${sha256(h.bytes)}"`);assert.equal((await response.json()).error,'Приостановлено');
});
test('final manifest must match source, full recipe, segment source order and profile',async()=>{
 for(const mutation of [h=>h.manifest.sourceSha256='f'.repeat(64),h=>h.manifest.recipeSha256='f'.repeat(64),h=>h.manifest.segments[0].inputSha256='f'.repeat(64),h=>h.manifest.segments[0].profileSha256='f'.repeat(64),h=>h.recipe.manifest.profileSha256='f'.repeat(64),h=>h.grant.job.total_segments=2]){
  const h=fixture();mutation(h);assert.throws(()=>checkedDerivedResult(h.grant,{manifest:h.manifest},h.recipe));
 }
});
test('translation result links immutable publications and cannot use audio alias',async()=>{
 const h=await appFor({},'translation');const result=await h.request(`/api/derived/jobs/${h.grant.job.id}/result`);assert.equal(result.status,200);assert.match((await result.json()).publications[0].url,/revision=1$/);
 assert.equal((await h.request(`/api/derived/jobs/${h.grant.job.id}/audio/segments/0`)).status,404);
 const text=await h.request(`/api/derived/jobs/${h.grant.job.id}/segments/0`);assert.equal(text.status,200);assert.equal(await text.text(),'Перевод');
 for(const ordinal of ['-1','01','50000','1.2'])assert.equal((await h.request(`/api/derived/jobs/${h.grant.job.id}/segments/${ordinal}`)).status,400);
});
test('range arithmetic rejects overflow and clamps valid open/suffix bounds',()=>{
 assert.deepEqual(derivedRange('bytes=5-',10),{start:5,end:9});assert.deepEqual(derivedRange('bytes=-20',10),{start:0,end:9});assert.deepEqual(derivedRange('bytes=2-999',10),{start:2,end:9});
 for(const value of ['bytes=-','bytes=9999999999999999999-','bytes=9-2','bytes=10-','bytes=1-NaN'])assert.equal(derivedRange(value,10),null);
});
test('one shared bound permits two heavy reads and rejects third pending request',async()=>{
 let entered=0,release;
 const gate=new Promise(resolve=>{release=resolve;});
 const h=await appFor({getResult:async()=>{entered++;await gate;return structuredClone(h.grant);}});
 const url=`/api/derived/jobs/${h.grant.job.id}/result`,first=h.request(url),second=h.request(url);
 const deadline=Date.now()+2000;while(entered<2&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(entered,2);
 try{const third=await h.request(`/api/derived/jobs/${h.grant.job.id}/audio/segments/0`);assert.equal(third.status,429);assert.equal(third.headers.get('retry-after'),'1');}
 finally{release();}
 for(const response of await Promise.all([first,second])){assert.equal(response.status,200);await response.arrayBuffer();}
 const after=await h.request(url);assert.equal(after.status,200);await after.arrayBuffer();
});
