// Read-only acceptance probe. Forward over stdin to node --input-type=module
// inside the app container; no writes, leases, model execution or HTTP fetches.
// Required: GARGANTUA_VERIFY_BATCH_REQUEST_ID, _START, _COUNT, _TOTAL.
// Optional: _MODE=progress|completed, _SNAPSHOT_ID, _DISCOVERY_ID,
// _SOURCE_SHA256, _PARTS (exact original source publication count).
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const prefix='GARGANTUA_VERIFY_BATCH_',env=key=>process.env[prefix+key],UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,HASH=/^[a-f0-9]{64}$/u;
const requestId=env('REQUEST_ID');assert.match(requestId??'',UUID,'explicit derived request UUID required');
function integer(key,max){const raw=env(key);assert.match(raw??'',/^[1-9][0-9]*$/u,'explicit '+key+' required');const value=Number(raw);assert.ok(Number.isSafeInteger(value)&&value<=max,key+' out of bounds');return value;}
const expected={start:integer('START',20000000),count:integer('COUNT',50),total:integer('TOTAL',20000000)},mode=env('MODE')??'progress';assert.ok(['progress','completed'].includes(mode));assert.ok(expected.start+expected.count-1<=expected.total);
for(const key of ['SNAPSHOT_ID','DISCOVERY_ID'])if(env(key)!==undefined)assert.match(env(key),UUID,'invalid '+key);
if(env('SOURCE_SHA256')!==undefined)assert.match(env('SOURCE_SHA256'),HASH);
const expectedParts=env('PARTS')===undefined?null:integer('PARTS',20000),library=process.env.LIBRARY_DIR;assert.ok(typeof library==='string'&&path.isAbsolute(library),'absolute LIBRARY_DIR required');
const load=name=>import(pathToFileURL(path.join(path.resolve('server'),name)).href);
const [{pool},{readPublication},{canonicalJson,sha256,checkedPublicationView,structureFor},{sourceChapterSelection,assertSelectionBooks,publicChapterRange,selectedPartIndices},{derivedPlanForRecipe,derivedSourceUnitForRecipe},{readDerivedManifest,readDerivedSegment,derivedUuid},{translatedBooks},{ranobeChapterFingerprint}]=await Promise.all([
 load('db.mjs'),load('publication-files.mjs'),load('publication-model.mjs'),load('derived-selection.mjs'),load('derived-orchestrator.mjs'),load('derived-files.mjs'),load('derived-plan.mjs'),load('ranobe-store.mjs')
]);
const client=await pool.connect(),cache=new Map(),verifiedSources=new Map();let stage='read-only-transaction';
const key=(part,chapter)=>part+'|'+chapter;
async function verifiedSource(hash,ancestors=new Set()){
 stage='immutable-source-identity';
 assert.match(hash,HASH);assert.ok(!ancestors.has(hash)&&ancestors.size<16,'source chain is acyclic and bounded');if(verifiedSources.has(hash))return verifiedSources.get(hash);ancestors=new Set([...ancestors,hash]);
 const source=(await client.query('SELECT * FROM derived_sources WHERE sha256=$1',[hash])).rows[0];assert.ok(source,'pinned source exists');assert.equal(sha256(Buffer.from(canonicalJson(source.manifest))),hash,'source manifest hash');
 assert.equal(source.work_id,source.manifest.workId);assert.equal(source.expression_id,source.manifest.expressionId);assert.equal(source.snapshot_id,source.manifest.snapshotId);
 source.parts=(await client.query('SELECT p.ordinal,p.publication_sha256 AS pinned_publication_sha256,p.package_sha256 AS pinned_package_sha256,b.* FROM derived_source_parts p JOIN books b ON b.id=p.book_id WHERE p.source_sha256=$1 ORDER BY p.ordinal',[hash])).rows;assert.equal(source.parts.length,source.manifest.parts.length);
 for(const [index,part]of source.parts.entries()){
  stage='original-source-package-'+index;
  const pinned=source.manifest.parts[index];assert.equal(part.ordinal,index);assert.equal(pinned.ordinal,index);assert.equal(pinned.publicationId,part.id);assert.equal(pinned.editionId,part.edition_id);assert.equal(pinned.chapterCount,part.chapter_count);assert.equal(part.work_id,source.work_id);assert.equal(part.expression_id,source.expression_id);assert.equal(part.security_state,'passed');assert.equal(part.publication_sha256,pinned.publicationSha256);assert.equal(part.package_sha256,pinned.packageSha256);assert.equal(part.publication_sha256,part.pinned_publication_sha256);assert.equal(part.package_sha256,part.pinned_package_sha256);
  const checked=await readPublication(library,part);checkedPublicationView(part,checked.content);if(selectedPartIndices(source).includes(index))cache.set(part.id,checked.content);
 }
 assertSelectionBooks(source);
 let snapshot=null;
 if(source.snapshot_id){
  stage='full-snapshot-coverage';
  snapshot=(await client.query('SELECT r.*,f.remote_id,f.branch_key FROM ranobe_runs r JOIN ranobe_feeds f ON f.id=r.feed_id WHERE r.id=$1',[source.snapshot_id])).rows[0];assert.equal(snapshot?.status,'ready');assert.equal(snapshot.chapter_count,source.parts.reduce((n,p)=>n+p.chapter_count,0));
  const parts=(await client.query('SELECT * FROM ranobe_run_parts WHERE run_id=$1 ORDER BY ordinal',[snapshot.id])).rows;assert.equal(parts.length,source.parts.length);let offset=0;
  const chapters=(await client.query('SELECT m.ordinal,m.source_key,m.chapter_id,c.book_id,c.chapter_index,c.content_sha256 FROM ranobe_run_chapters m JOIN ranobe_chapters c ON c.id=m.chapter_id WHERE m.run_id=$1 ORDER BY m.ordinal',[snapshot.id])).rows;assert.equal(chapters.length,snapshot.chapter_count);assert.equal(new Set(chapters.map(c=>c.source_key)).size,chapters.length);
  for(const [index,part]of parts.entries()){
   const book=source.parts[index];assert.equal(part.ordinal,offset);assert.equal(part.status,'ready');assert.equal(part.book_id,book.id);assert.equal(part.package_sha256,book.package_sha256);assert.equal(part.source_keys.length,book.chapter_count);assert.deepEqual(part.source_keys,chapters.slice(offset,offset+book.chapter_count).map(c=>c.source_key));
   for(let c=0;c<book.chapter_count;c++){const chapter=chapters[offset+c];assert.equal(chapter.ordinal,offset+c);assert.equal(chapter.book_id,book.id);assert.equal(chapter.chapter_index,c);assert.match(chapter.content_sha256,HASH);}
   if(cache.has(book.id))for(let c=0;c<book.chapter_count;c++)assert.equal(ranobeChapterFingerprint(cache.get(book.id),c),chapters[offset+c].content_sha256,'selected source part matches quarantined chapter checkpoints');
   offset+=book.chapter_count;
  }
 }
 const expression=(await client.query('SELECT * FROM expressions WHERE id=$1',[source.expression_id])).rows[0];assert.ok(expression);let parent=null;
 if(expression.kind==='machine-translation'){
  stage='translation-origin-chain';
  const candidates=(await client.query("SELECT j.id,j.source_sha256,d.manifest FROM derived_jobs j JOIN derived_results d ON d.job_id=j.id WHERE j.kind='translation' AND j.status='completed' AND d.expression_id=$1",[source.expression_id])).rows.filter(row=>source.parts.every(part=>row.manifest.publicationIds?.includes(part.id)));assert.equal(candidates.length,1,'one completed translation origin');parent=await verifiedSource(candidates[0].source_sha256,ancestors);assert.equal(expression.source_expression_id,parent.source.expression_id);
 }
 const value={source,snapshot,parent};verifiedSources.set(hash,value);return value;
}
try{
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await client.query("SET LOCAL statement_timeout='15s'");await client.query("SET LOCAL lock_timeout='2s'");assert.equal((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only,'on');
 stage='approved-request-and-job';const request=(await client.query('SELECT * FROM derived_requests WHERE id=$1',[requestId])).rows[0];assert.ok(request,'derived request exists');if(env('DISCOVERY_ID'))assert.equal(request.discovery_request_id,env('DISCOVERY_ID'));assert.ok(['active','completed'].includes(request.status),'request is approved and not cancelled');
 const job=(await client.query('SELECT * FROM derived_jobs WHERE id=$1',[request.job_id])).rows[0];assert.ok(job);if(mode==='completed'){assert.equal(job.status,'completed');assert.equal(request.status,'completed');}else assert.ok(['queued','processing','paused','completed'].includes(job.status),'job is not failed, blocked or awaiting approval');
 if(env('SOURCE_SHA256'))assert.equal(job.source_sha256,env('SOURCE_SHA256'));
 const verified=await verifiedSource(job.source_sha256),source=verified.source,selection=sourceChapterSelection(source);stage='exact-expected-chapter-selection';assert.ok(selection,'new batch source is schema2');assert.equal(source.manifest.schemaVersion,2);assert.equal(selection.start,expected.start);assert.equal(selection.count,expected.count);assert.equal(selection.total,expected.total);assert.ok(selection.count<=(job.kind==='translation'?5:50));if(expectedParts!==null)assert.equal(source.parts.length,expectedParts);if(env('SNAPSHOT_ID'))assert.equal(source.snapshot_id,env('SNAPSHOT_ID'));
 if(request.discovery_request_id){const discovery=(await client.query('SELECT * FROM discovery_requests WHERE id=$1',[request.discovery_request_id])).rows[0];assert.equal(discovery.status,'book-ready');assert.equal(discovery.requested_by,request.requested_by);assert.equal(discovery.outputs.book.snapshotId??null,source.snapshot_id);assert.deepEqual(discovery.outputs.book.publicationIds??[discovery.outputs.book.publicationId],source.parts.map(p=>p.id));}
 if(request.parent_request_id){const parent=(await client.query('SELECT r.*,j.status AS job_status,j.source_sha256,d.manifest FROM derived_requests r JOIN derived_jobs j ON j.id=r.job_id JOIN derived_results d ON d.job_id=j.id WHERE r.id=$1',[request.parent_request_id])).rows[0];assert.equal(parent.job_id,request.parent_job_id);assert.equal(parent.job_status,'completed');assert.equal(parent.requested_by,request.requested_by);assert.equal(parent.audio_requested,true);assert.deepEqual(parent.manifest.publicationIds,source.parts.map(p=>p.id));assert.equal(selection.start,1);assert.equal(selection.count,selection.total);assert.equal(selection.count,sourceChapterSelection(verified.parent.source).count);}
 stage='immutable-recipe';const recipe=(await client.query('SELECT * FROM derived_recipes WHERE sha256=$1',[job.recipe_sha256])).rows[0];assert.ok(recipe);assert.equal(recipe.kind,job.kind);assert.equal(sha256(Buffer.from(canonicalJson({kind:recipe.kind,language:recipe.language,manifest:recipe.manifest}))),job.recipe_sha256);
 const partLoader=async index=>{const part=source.parts[index];assert.ok(part);if(!cache.has(part.id))cache.set(part.id,(await readPublication(library,part)).content);return cache.get(part.id);};
 stage='rebuild-selected-plan';const rebuilt=await derivedPlanForRecipe(source,partLoader,job.kind,recipe.manifest),selected=new Set(selection.chapters.map(c=>key(c.partIndex,c.chapterIndex))),eligibleText=new Set(),nonTextSelectedChapters=[],covered=new Set();
 // Both pinned segmentation revisions translate/narrate the chapter title and
 // block text (including image captions). An image with no title or caption
 // remains part of immutable physical coverage but needs no fake text unit.
 assert.ok(['translation','audio'].includes(job.kind));
 for(const entry of selection.chapters){const chapter=structureFor(await partLoader(entry.partIndex)).chapters[entry.chapterIndex];assert.equal(chapter.id,entry.chapterId);if([chapter.title,...chapter.blocks.map(block=>block.text)].some(text=>text.trim().length>0))eligibleText.add(key(entry.partIndex,entry.chapterIndex));else nonTextSelectedChapters.push({...entry,reason:'NO_SOURCE_TEXT'});}
 for(const [ordinal,unit]of rebuilt.manifest.segments.entries()){assert.equal(unit.ordinal,ordinal);assert.ok(selected.has(key(unit.partIndex,unit.chapterIndex)),'unit belongs to selected five, never another chapter');assert.equal(unit.publicationId,source.parts[unit.partIndex].id);const book=await partLoader(unit.partIndex);assert.equal(structureFor(book).chapters[unit.chapterIndex].id,selection.chapters.find(c=>c.partIndex===unit.partIndex&&c.chapterIndex===unit.chapterIndex).chapterId);const text=derivedSourceUnitForRecipe([book],{...unit,partIndex:0},job.kind,recipe.manifest);assert.equal(sha256(Buffer.from(text)),unit.sourceSha256);covered.add(key(unit.partIndex,unit.chapterIndex));}
 assert.deepEqual([...covered].sort(),[...eligibleText].sort(),'every selected chapter with source text must be covered, and no empty chapter may acquire invented text');
 if(job.plan){assert.equal(job.plan_sha256,rebuilt.sha256);assert.equal(sha256(Buffer.from(canonicalJson(job.plan))),rebuilt.sha256);assert.equal(canonicalJson(job.plan),canonicalJson(rebuilt.manifest));assert.equal(job.total_segments,rebuilt.segments);}else{assert.equal(job.completed_segments,0);assert.equal(job.total_segments,null);assert.equal(mode,'progress');}
 const checkpoints=(await client.query('SELECT * FROM derived_checkpoints WHERE job_id=$1 ORDER BY ordinal',[job.id])).rows;assert.equal(checkpoints.length,job.completed_segments);assert.ok(!checkpoints.length||job.plan);let checkpointBytes=0,audioSeconds=0;
 for(const [ordinal,checkpoint]of checkpoints.entries()){
  stage='committed-checkpoint-file-'+ordinal;
  const segment=checkpoint.manifest;assert.equal(checkpoint.ordinal,ordinal);assert.equal(checkpoint.source_sha256,rebuilt.manifest.segments[ordinal].sourceSha256);assert.equal(checkpoint.output_sha256,segment.file.sha256);assert.equal(Number(checkpoint.output_bytes),segment.file.bytes);assert.equal(checkpoint.attempt_token,segment.attemptId);assert.equal(segment.inputSha256,checkpoint.source_sha256);assert.equal(segment.recipeSha256,job.recipe_sha256);assert.equal(segment.profileSha256,recipe.manifest.profileSha256);
  const bytes=await readDerivedSegment(library,job.id,segment);assert.equal(sha256(bytes),checkpoint.output_sha256);checkpointBytes+=bytes.length;audioSeconds+=segment.pcm?.durationSeconds??0;
 }
 const result=(await client.query('SELECT * FROM derived_results WHERE job_id=$1',[job.id])).rows[0];let output=null;
 if(job.status==='completed'){
  stage='final-result-manifest';
  assert.ok(result);assert.equal(checkpoints.length,rebuilt.segments);const checked=await readDerivedManifest(library,result),manifest=checked.manifest;assert.equal(manifest.sourceSha256,job.source_sha256);assert.equal(manifest.recipeSha256,job.recipe_sha256);assert.equal(manifest.kind,job.kind);assert.equal(result.work_id,source.work_id);assert.equal(canonicalJson(manifest.segments),canonicalJson(checkpoints.map(c=>c.manifest)));
  if(job.kind==='audio')assert.equal(result.expression_id,source.expression_id);
  else{
   const publications=[];
   for(const p of selectedPartIndices(source)){
    const units=rebuilt.manifest.segments.filter(u=>u.partIndex===p),outputs=[];for(const unit of units)outputs.push(await readDerivedSegment(library,job.id,checkpoints[unit.ordinal].manifest));
    const expectedBooks=translatedBooks({...source,parts:[source.parts[p]]},[await partLoader(p)],{segments:units.map(u=>({...u,partIndex:0}))},outputs,{schemaVersion:1,kind:'machine-translation',quality:'machine-draft',sourceSha256:job.source_sha256,recipeSha256:job.recipe_sha256,jobId:job.id});assert.equal(expectedBooks.length,1);
    stage='compact-translated-publication-'+p;const id=derivedUuid(`translated-book|${job.id}|${p}`),row=(await client.query('SELECT * FROM books WHERE id=$1',[id])).rows[0];assert.ok(row);assert.equal(row.security_state,'passed');assert.equal(row.expression_id,result.expression_id);assert.equal(row.edition_id,derivedUuid(`translated-edition|${job.id}|${p}`));const checkedBook=await readPublication(library,row);checkedPublicationView(row,checkedBook.content);assert.equal(canonicalJson(checkedBook.content),canonicalJson(expectedBooks[0]));publications.push({publicationId:id,chapterCount:row.chapter_count});
   }
   assert.deepEqual(manifest.publicationIds,publications.map(p=>p.publicationId));assert.equal(publications.reduce((sum,p)=>sum+p.chapterCount,0),selection.count);output={publications};
  }
  output={...output,sha256:result.sha256,bytes:Number(result.bytes),quality:manifest.quality};
 }else assert.equal(result,undefined,'unfinished job has no published result');
 // Verify the immutable source seals again after checking generated files.
 stage='recheck-original-seals';for(const {source:original}of verifiedSources.values())for(const part of original.parts){const checked=await readPublication(library,part);checkedPublicationView(part,checked.content);}
 await client.query('COMMIT');
 console.log(JSON.stringify({ok:true,observedAt:new Date().toISOString(),readOnly:true,mode,requestId,jobId:job.id,kind:job.kind,jobStatus:job.status,requestStatus:request.status,discoveryRequestId:request.discovery_request_id,parentRequestId:request.parent_request_id,sourceSha256:source.sha256,snapshotId:source.snapshot_id,chapterRange:publicChapterRange(source.manifest),...(verified.parent?{originChapterRange:publicChapterRange(verified.parent.source.manifest)}:{}),selectedChapters:selection.chapters,textBearingSelectedChapters:eligibleText.size,nonTextSelectedChapters,pinnedParts:source.parts.map(p=>({publicationId:p.id,chapters:p.chapter_count,packageSha256:p.package_sha256,publicationSha256:p.publication_sha256})),allOriginalPartsAndChapters:selection.total,originalSealsVerifiedTwice:true,originalsUnchangedSinceSourcePinned:true,planCommitted:Boolean(job.plan),rebuiltPlanSha256:rebuilt.sha256,plannedSegments:rebuilt.segments,completedSegments:checkpoints.length,checkpointBytes,audioSeconds,allCommittedCheckpointFilesVerified:true,partial:selection.count<selection.total,selectedRangeOnlyPlanned:true,allEligibleSelectedTextCovered:true,output,antivirusRescannedNow:false,modelInferenceExecuted:false,networkSourceFetched:false},null,2));
}catch(error){await client.query('ROLLBACK').catch(()=>{});console.error(JSON.stringify({ok:false,observedAt:new Date().toISOString(),requestId,stage,code:error.code??error.name,error:'Verification failed; source text, SQL diagnostics and private paths omitted.'},null,2));process.exitCode=1;}
finally{client.release();await pool.end();}
