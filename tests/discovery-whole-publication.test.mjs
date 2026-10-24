import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalJson,sha256} from '../server/publication-model.mjs';
import {wholeLibraryPublication} from '../server/discovery-whole-publication.mjs';
import {findLocalDiscoveryPlan,reuseDiscoveredSources} from '../server/discovery-library.mjs';
const id=n=>'90000000-0000-4000-8000-'+String(n).padStart(12,'0'),hash=x=>sha256(Buffer.from(canonicalJson(x)));
function original(n=1,count=4){return {id:id(n),title:'Same title',author:'Author',language:'en',chapter_count:count,work_id:id(900),expression_id:id(n+100),edition_id:id(n+200),publication_sha256:'a'.repeat(64),package_sha256:'b'.repeat(64),security_state:'passed',artifact_manifest:{schemaVersion:1,files:[]},publication_manifest:{readingOrder:Array.from({length:count},(_,c)=>({chapterId:'c-'+c}))},expression_kind:'original',has_derived_lineage:false,is_ranobe_part:false,import_kind:'upload'};}
function translation(source,{n=2,version=2,start=1,count=source.chapter_count}={}){
 const book={...original(n,count),language:'ru',expression_kind:'machine-translation',has_derived_lineage:true,import_kind:'derived-translation'},manifest={schemaVersion:version,sourceLanguage:source.language,workId:source.work_id,expressionId:source.expression_id,snapshotId:null,parts:[{ordinal:0,publicationId:source.id,editionId:source.edition_id,publicationSha256:source.publication_sha256,packageSha256:source.package_sha256,chapterCount:source.chapter_count}]};
 if(version===2)manifest.selection={schemaVersion:1,start,count,total:source.chapter_count,chapters:Array.from({length:count},(_,i)=>({ordinal:start-1+i,partIndex:0,publicationId:source.id,chapterIndex:start-1+i,chapterId:'c-'+(start-1+i)}))};
 const recipe={kind:'translation',language:'ru',manifest:{profile:'fixture'}},sourceSha=hash(manifest),recipeSha=hash(recipe),jobId=id(n+300),attemptId=id(n+400),result={schemaVersion:1,jobId,kind:'translation',sourceSha256:sourceSha,recipeSha256:recipeSha,quality:'machine-draft',publicationIds:[book.id],segments:[{schemaVersion:1,ordinal:0,jobId,attemptId,kind:'translation',recipeSha256:recipeSha,inputSha256:'c'.repeat(64),profileSha256:'d'.repeat(64),file:{path:attemptId+'/000000.txt',sha256:'e'.repeat(64),bytes:1,mediaType:'text/plain; charset=utf-8'},scan:{sha256:'e'.repeat(64),version:'synthetic-test-only',checkedAt:'2026-10-24T00:00:00.000Z'},quality:'machine-draft'}]};
 return {book,expression:{id:book.expression_id,kind:'machine-translation',language:'ru',work_id:book.work_id,source_expression_id:source.expression_id},source:{...source,ordinal:0,pinned_publication_sha256:source.publication_sha256,pinned_package_sha256:source.package_sha256},origin:{job_id:jobId,work_id:book.work_id,expression_id:book.expression_id,edition_id:book.edition_id,manifest:result,sha256:hash(result),bytes:Buffer.byteLength(canonicalJson(result)),job_kind:'translation',job_status:'completed',job_total_segments:1,job_completed_segments:1,pinned_source_sha256:sourceSha,pinned_recipe_sha256:recipeSha,source_manifest:manifest,source_work_id:source.work_id,source_expression_id:source.expression_id,source_snapshot_id:null,recipe_kind:recipe.kind,recipe_language:recipe.language,recipe_manifest:recipe.manifest}};
}
function database(items,searchRows){const calls=[];return {calls,query:async(sql,args=[])=>{calls.push({sql,args});if(sql.startsWith('SELECT * FROM expressions'))return {rows:items.filter(item=>item.expression.id===args[0]).map(item=>item.expression)};if(sql.includes('FROM derived_results r JOIN'))return {rows:items.filter(item=>item.book.expression_id===args[0]).flatMap(item=>Array.isArray(item.origin)?item.origin:[item.origin])};if(sql.includes('FROM derived_source_parts p'))return {rows:items.filter(item=>(Array.isArray(item.origin)?item.origin[0]:item.origin)?.pinned_source_sha256===args[0]).flatMap(item=>item.sources??[item.source])};if(sql.startsWith('SELECT expression_id FROM editions'))return {rows:items.filter(item=>item.book.edition_id===args[0]).map(item=>({expression_id:item.book.expression_id}))};if(sql.includes('FROM books b WHERE')||sql.includes('FROM imports i JOIN books'))return {rows:searchRows??items.map(item=>item.book)};throw Error('Unexpected fixture query');}};}

test('ordinary publications remain reusable while adapter packets never claim whole-book coverage',async()=>{
 const book=original();assert.equal((await wholeLibraryPublication({query:()=>{throw Error('Ordinary reuse needs no derivative query');}},book)).whole,true);
 assert.equal((await wholeLibraryPublication({}, {...book,is_ranobe_part:true})).whole,false);
});
test('complete single-publication v1 and v2 translations retain verified whole-book reuse',async()=>{
 for(const version of [1,2]){const item=translation(original(),{version}),db=database([item]),result=await wholeLibraryPublication(db,item.book,{lock:true});assert.equal(result.whole,true);assert.deepEqual(result.books.map(book=>book.id),[item.book.id,item.source.id]);assert.ok(db.calls.filter(call=>call.sql.includes('FROM derived_results r JOIN')||call.sql.includes('FROM derived_source_parts p')).every(call=>call.sql.includes('FOR SHARE')));}
});
test('partial translated packages are excluded from exact-title and verified-source local search',async()=>{
 const item=translation(original(),{start:3,count:1}),db=database([item]),input={query:'Same title',language:'ru',allowOriginal:false};assert.equal((await wholeLibraryPublication(db,item.book)).whole,false);assert.equal(await findLocalDiscoveryPlan(db,input,{titles:['Same title']}),null);
 const candidate={id:'remote',identity:{provider:'gutendex',remoteId:'11'},availability:'fetchable',eligibleForAcquisition:true,downloadSelections:[{extension:'epub',expected:{provider:'gutenberg',remoteId:'11'}}]},plan={candidates:[candidate],selectedCandidateId:'remote'};assert.equal(await reuseDiscoveredSources(db,plan,input),plan);
});
test('a full wrapper around a partial machine ancestor never becomes a whole book',async()=>{
 const partial=translation(original(),{start:3,count:1}),wrapper=translation(partial.book,{n:3}),db=database([partial,wrapper]);assert.equal((await wholeLibraryPublication(db,wrapper.book)).whole,false);
});
test('missing ambiguous blocked changed or multipart lineage fails closed',async()=>{
 const changes=[item=>item.origin=[],item=>item.origin=[item.origin,structuredClone(item.origin)],item=>item.origin.manifest.publicationIds.push(id(99)),item=>item.origin.source_manifest.parts.push({...item.origin.source_manifest.parts[0],ordinal:1}),item=>item.source.security_state='blocked',item=>item.source.package_sha256='c'.repeat(64),item=>item.source.is_ranobe_part=true,item=>item.origin.source_manifest.selection.chapters[0].chapterId='wrong-id',item=>item.origin.source_manifest.selection.start=2,item=>item.origin.job_completed_segments=0,item=>item.expression.source_expression_id=id(99),item=>item.origin.sha256='0'.repeat(64)];
 for(const change of changes){const item=translation(original());change(item);assert.equal((await wholeLibraryPublication(database([item]),item.book)).whole,false);}
});
test('translated identity cannot disappear by omitting its expression kind or become eligible through a title',async()=>{
 const item=translation(original());for(const change of [{expression_kind:null},{expression_id:null},{work_id:null},{edition_id:null}])assert.equal((await wholeLibraryPublication({}, {...item.book,...change})).whole,false);
 const cyclic=translation(original());cyclic.source={...cyclic.book,ordinal:0,pinned_publication_sha256:cyclic.book.publication_sha256,pinned_package_sha256:cyclic.book.package_sha256};assert.equal((await wholeLibraryPublication(database([cyclic]),cyclic.book,{ancestors:new Set([cyclic.book.id])})).whole,false);
});

test('malformed or resealed lineage is rejected as incomplete without throwing an internal error',async()=>{
 const changes=[
  item=>item.origin.manifest.segments=[null],
  item=>item.origin.manifest.segments[0].scan.sha256='f'.repeat(64),
  item=>item.origin.manifest.segments[0].quality='technical-unlistened',
  item=>item.origin.manifest.segments[0].file.path='../000000.txt',
  item=>item.origin.source_manifest.parts=[null],
  item=>item.origin.recipe_manifest=null,
  item=>item.expression.language='en',
  item=>item.book.security_state='blocked'
 ];
 for(const change of changes){const item=translation(original());change(item);item.origin.sha256=hash(item.origin.manifest);item.origin.bytes=Buffer.byteLength(canonicalJson(item.origin.manifest));assert.equal((await wholeLibraryPublication(database([item]),item.book)).whole,false);}
});

test('full coverage cannot be manufactured by rehashing a changed selection or source relation',async()=>{
 for(const change of [item=>item.origin.source_manifest.selection.chapters[0].chapterId='another-chapter',item=>item.origin.source_manifest.parts[0].editionId=id(999),item=>item.source.pinned_publication_sha256='f'.repeat(64)]){
  const item=translation(original());change(item);item.origin.pinned_source_sha256=hash(item.origin.source_manifest);item.origin.manifest.sourceSha256=item.origin.pinned_source_sha256;item.origin.sha256=hash(item.origin.manifest);item.origin.bytes=Buffer.byteLength(canonicalJson(item.origin.manifest));assert.equal((await wholeLibraryPublication(database([item]),item.book)).whole,false);
 }
});

test('one complete translation and one partial translation do not create a false edition ambiguity',async()=>{
 const source=original(),partial=translation(source,{start:3,count:1}),full=translation(source,{n:3}),db=database([partial,full]),plan=await findLocalDiscoveryPlan(db,{query:'Same title',language:'ru',allowOriginal:false},{titles:['Same title']});
 assert.equal(plan.status,'resolved');assert.deepEqual(plan.candidates.map(candidate=>candidate.bookId),[full.book.id]);
});
