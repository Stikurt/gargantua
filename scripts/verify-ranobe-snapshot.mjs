// Execute inside the running app container with node --input-type=module,
// forwarding this file over stdin. This verifier never writes to production.
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const requestId=process.env.GARGANTUA_VERIFY_REQUEST_ID;
assert.match(requestId??'',/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,'explicit request UUID required');
const expectedBranch=process.env.GARGANTUA_VERIFY_BRANCH;
assert.match(expectedBranch??'',/^(?:default|[1-9][0-9]{0,14})$/u,'explicit expected branch required');
const expectedCount=Number(process.env.GARGANTUA_VERIFY_CHAPTERS);
assert.ok(Number.isSafeInteger(expectedCount)&&expectedCount>=1&&expectedCount<=20000,'explicit expected chapter count required');
const serverRoot=path.resolve('server');
const load=name=>import(pathToFileURL(path.join(serverRoot,name)).href);
const [{pool},{readPublication},{checkedPublicationView},{ranobeChapterFingerprint}]=await Promise.all([
  load('db.mjs'),load('publication-files.mjs'),load('publication-model.mjs'),load('ranobe-store.mjs')
]);
const client=await pool.connect();
try{
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query("SET LOCAL statement_timeout='15s'");
  await client.query("SET LOCAL lock_timeout='2s'");
  assert.equal((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only,'on');
  const request=(await client.query('SELECT id,status,requested_by,import_id,outputs FROM discovery_requests WHERE id=$1',[requestId])).rows[0];
  assert.ok(request,'request exists');assert.equal(request.status,'book-ready','full book must be ready');
  const job=(await client.query('SELECT id,kind,status,security_state,options FROM imports WHERE id=$1',[request.import_id])).rows[0];
  assert.equal(job?.kind,'ranobe');assert.equal(job.status,'completed');assert.equal(job.security_state,'passed');assert.equal(job.options.mode,'full');
  const feed=(await client.query('SELECT id,remote_id,branch_key,language,head_run_id FROM ranobe_feeds WHERE id=$1',[job.options.feedId])).rows[0];
  assert.ok(feed);assert.equal(feed.branch_key,expectedBranch);
  const links=(await client.query('SELECT DISTINCT result_run_id FROM ranobe_feed_requests WHERE feed_id=$1 AND import_id=$2 AND profile_id=$3',[feed.id,job.id,request.requested_by])).rows;
  assert.equal(links.length,1,'exact initiative has one immutable result');assert.ok(links[0].result_run_id);
  const run=(await client.query('SELECT * FROM ranobe_runs WHERE id=$1 AND feed_id=$2',[links[0].result_run_id,feed.id])).rows[0];
  assert.equal(run?.status,'ready');assert.ok(run.activated_at);assert.equal(run.chapter_count,expectedCount);
  const maps=(await client.query('SELECT m.ordinal,m.source_key,m.chapter_id,c.content_sha256,c.raw_sha256,c.scanner_version,c.parser_version,c.book_id,c.chapter_index FROM ranobe_run_chapters m LEFT JOIN ranobe_chapters c ON c.id=m.chapter_id WHERE m.run_id=$1 ORDER BY m.ordinal',[run.id])).rows;
  assert.equal(maps.length,expectedCount);assert.equal(new Set(maps.map(m=>m.source_key)).size,expectedCount);
  const prefix=`ranobelib:${feed.remote_id}:${expectedBranch==='default'?'default':`branch:${expectedBranch}`}:`;
  for(const [ordinal,map] of maps.entries()){
    assert.equal(map.ordinal,ordinal);assert.ok(map.chapter_id);assert.ok(map.source_key.startsWith(prefix),'chapter belongs to selected work and branch');
    assert.match(map.content_sha256??'',/^[a-f0-9]{64}$/u);assert.match(map.raw_sha256??'',/^[a-f0-9]{64}$/u);
    assert.ok(map.scanner_version?.length);assert.ok(map.parser_version?.length);
  }
  const parts=(await client.query('SELECT p.*,b.security_state,b.chapter_count,b.content_bytes,b.content_sha256,b.package_sha256 AS actual_package FROM ranobe_run_parts p JOIN books b ON b.id=p.book_id WHERE p.run_id=$1 ORDER BY p.ordinal',[run.id])).rows;
  assert.ok(parts.length);let covered=0,totalBytes=0,totalTextCharacters=0,imageBlocks=0;
  const chapterIds=new Set(),publicationIds=new Set(),packages=[];
  for(const part of parts){
    assert.equal(part.status,'ready');assert.equal(part.security_state,'passed');assert.equal(part.ordinal,covered);
    assert.equal(part.package_sha256,part.actual_package);assert.equal(part.chapter_count,part.source_keys.length);assert.ok(!publicationIds.has(part.book_id));publicationIds.add(part.book_id);
    assert.deepEqual(part.source_keys,maps.slice(covered,covered+part.source_keys.length).map(map=>map.source_key));
    const stored=(await client.query('SELECT * FROM books WHERE id=$1',[part.book_id])).rows[0];
    const checked=await readPublication(process.env.LIBRARY_DIR,stored);checkedPublicationView(stored,checked.content);
    assert.equal(checked.content.chapters.length,part.source_keys.length);
    let textCharacters=0,images=0;
    for(let index=0;index<checked.content.chapters.length;index++){
      const map=maps[covered+index],chapter=checked.content.chapters[index],structure=checked.content.structure.chapters[index];
      assert.equal(map.book_id,part.book_id);assert.equal(map.chapter_index,index);
      assert.equal(ranobeChapterFingerprint(checked.content,index),map.content_sha256,'published chapter matches immutable verified checkpoint');
      assert.ok(!chapterIds.has(structure.id));chapterIds.add(structure.id);
      textCharacters+=chapter.blocks.reduce((sum,block)=>sum+(block.type==='image'?0:block.text.length),0);
      images+=chapter.blocks.filter(block=>block.type==='image').length;
    }
    const bytes=Number(part.content_bytes);assert.ok(Number.isSafeInteger(bytes)&&bytes>0);
    totalBytes+=bytes;totalTextCharacters+=textCharacters;imageBlocks+=images;
    packages.push({publicationId:part.book_id,firstChapter:covered+1,chapters:part.chapter_count,bytes,contentSha256:part.content_sha256,packageSha256:part.package_sha256,textCharacters,imageBlocks:images});
    covered+=part.chapter_count;
  }
  assert.equal(covered,expectedCount);assert.equal(chapterIds.size,expectedCount);
  assert.equal(request.outputs.book.snapshotId,run.id);assert.equal(request.outputs.book.chapterCount,expectedCount);
  assert.deepEqual(request.outputs.book.publicationIds,packages.map(part=>part.publicationId));
  await client.query('COMMIT');
  console.log(JSON.stringify({ok:true,observedAt:new Date().toISOString(),readOnly:true,requestId,importId:job.id,feedId:feed.id,snapshotId:run.id,sourceWorkId:feed.remote_id,branch:feed.branch_key,language:feed.language,coverage:'source-inventory-snapshot',originalWorkComplete:false,chapterCount:covered,uniqueSourceKeys:expectedCount,uniqueChapterIds:chapterIds.size,parts:packages,totalBytes,totalTextCharacters,imageBlocks,inventorySha256:run.inventory_sha256,scannerVersions:[...new Set(maps.map(m=>m.scanner_version))],parserVersions:[...new Set(maps.map(m=>m.parser_version))],allFileHashesVerified:true,allChapterFingerprintsVerified:true,originalSourceReFetched:false,antivirusRescannedNow:false},null,2));
}catch(error){await client.query('ROLLBACK').catch(()=>{});console.error(JSON.stringify({ok:false,observedAt:new Date().toISOString(),requestId,code:error.code??error.name,error:error.message},null,2));process.exitCode=1;}
finally{client.release();await pool.end();}
