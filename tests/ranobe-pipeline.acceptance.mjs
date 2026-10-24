// Called only inside the guarded, disposable import-pipeline container.
// Source fixtures are explicit DI; antivirus, parser, filesystem and DB are real.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {normalizeRanobeInventory,verifyRanobeChapter} from '../server/ranobe.mjs';
import {processRanobeFull} from '../server/ranobe-acquisition.mjs';
import {claimImport,assertAttempt,renewImport,attemptStage,failImport} from '../server/import-jobs.mjs';
import {getRanobeFeed,getRanobeParts} from '../server/ranobe-store.mjs';
import {sha256} from '../server/publication-model.mjs';

export async function acceptRanobePipeline(ctx){
 const {pool,api,profile,roots,record,waitFor,start,stop,children,download,summary,control}=ctx;
 await stop(children.find(child=>child.name==='worker'&&!child.expectedStop));
 const slug='990099--synthetic-acceptance',url=`https://ranobelib.me/ru/book/${slug}`,state={count:3,fetches:[],threat:false};
 const inventory=()=>{const list=Array.from({length:state.count},(_,i)=>({id:90001+i,volume:'1',number:String(i+1),index:i+1,branches:[{id:90001+i,branch_id:null,expired_type:0,teams:[]}]}));return normalizeRanobeInventory({slug,meta:{id:990099,slug_url:slug,rus_name:'Synthetic Ranobe acceptance',authors:[{name:'Synthetic author'}],items_count:{uploaded:list.length,total:0}},list,envelope:{data:list}});};
 const adapter={resolveRanobe:async()=>inventory(),fetchRanobeChapter:async(info,chapter,branchId)=>{state.fetches.push(Number(chapter.number));const data={id:chapter.branches[0].id,manga_id:990099,branch_id:branchId,volume:chapter.volume,number:chapter.number,expired_type:0,content:state.threat&&chapter.number==='2'?control.toString('ascii'):`<h2>Глава ${chapter.number}</h2><p>Синтетический текст главы ${chapter.number}.</p>`};return {data:verifyRanobeChapter(data,{slug,chapter,branchId}),raw:Buffer.from(JSON.stringify({data}))};}};
 const request=async(force=false)=>(await(await api('/ranobe/requests',{method:'POST',json:{idempotencyKey:randomUUID(),url,branch:null,language:'ru',autoUpdate:false,force}})).json());
 const execute=async()=>{
  const parent=await claimImport(pool);assert.equal(parent.options.mode,'full');const report={checks:[]},controller=new AbortController();let error;
  const heartbeat=setInterval(()=>renewImport(pool,parent).catch(failure=>{error=failure;controller.abort(failure);}),3000);
  try{return await processRanobeFull(pool,parent,{quarantine:roots.quarantine,jobs:roots.jobs,library:roots.library,signal:controller.signal,allowed:async()=>{if(error)throw error;await assertAttempt(pool,parent);},waitResources:async()=>{},stage:value=>attemptStage(pool,parent,value),record:async()=>{},report,adapter});}
  catch(failure){await failImport(pool,parent,failure,report);throw failure;}finally{clearInterval(heartbeat);}
 };
 const created=await request(),first=await execute();assert.equal(first.status,'ready');const feedId=created.feed.id,firstParts=await getRanobeParts(pool,first.id);assert.equal(firstParts.length,1);
 let row=(await pool.query('SELECT * FROM books WHERE id=$1',[firstParts[0].book_id])).rows[0];let packet=await download(row.id,row.content_sha256);assert.equal(packet.chapters.length,3);assert.equal(new Set(packet.structure.chapters.map(chapter=>chapter.id)).size,3);assert.equal((await pool.query('SELECT count(*)::int AS n FROM ranobe_scratch')).rows[0].n,0);
 record('Ranobe fixture -> live antivirus -> actual sandbox parser per chapter -> complete immutable snapshot',{chapters:3,sourceFixture:true,realScanner:true,realParser:true});
 state.count=4;state.fetches=[];await request();const second=await execute();assert.deepEqual(state.fetches,[4]);const secondParts=await getRanobeParts(pool,second.id);row=(await pool.query('SELECT * FROM books WHERE id=$1',[secondParts[0].book_id])).rows[0];packet=await download(row.id,row.content_sha256);assert.equal(packet.chapters.length,4);assert.notEqual(firstParts[0].book_id,secondParts[0].book_id);assert.equal((await getRanobeFeed(pool,feedId)).head_run_id,second.id);
 const manifest=await(await api(`/ranobe/feeds/${feedId}/snapshots/${second.id}`)).json();assert.equal(manifest.chapterCount,4);assert.equal(manifest.parts[0].publicationId,row.id);assert.equal(manifest.branch,null);
 record('new source chapter appends without fetching old chapters and previous snapshot remains readable',{fetchedChapters:[4],currentChapters:4});
 state.fetches=[];await request();const third=await execute();assert.deepEqual(state.fetches,[]);assert.deepEqual((await getRanobeParts(pool,third.id)).map(part=>part.book_id),secondParts.map(part=>part.book_id));
 record('unchanged Ranobe check reuses checked parts without network chapter fetch or duplicate publication');
 state.threat=true;state.fetches=[];const forced=await request(true);assert.equal(forced.import.options.force,true);await assert.rejects(execute,error=>error.threat===true);assert.deepEqual(state.fetches,[1,2]);assert.equal((await getRanobeFeed(pool,feedId)).head_run_id,third.id);await download(row.id,row.content_sha256);
 record('malicious update is blocked by the live scanner while the previous complete snapshot stays readable');
 summary.ranobeFixture={sourceFixture:true,realScanner:true,realSandboxParser:true,chapterCounts:[3,4],appendFetches:[4],oldSnapshotPreserved:true};
 start('worker-after-ranobe-fixture','/app/server/worker.mjs');
 if(process.env.GARGANTUA_TEST_LIVE_RANOBE==='1'){
  const liveUrl='https://ranobelib.me/ru/book/107497--wo-julong-lingzhu';
  const live=await(await api('/ranobe/requests',{method:'POST',json:{idempotencyKey:randomUUID(),url:liveUrl,branch:null,language:'ru',autoUpdate:false}})).json();
  const done=await waitFor('complete live Ranobe source inventory',async()=>{const job=(await pool.query('SELECT status,stage,error,report FROM imports WHERE id=$1',[live.import.id])).rows[0];return ['completed','blocked','error','source-review'].includes(job.status)?job:false;},{timeout:1500000,interval:1000});
  summary.liveRanobeAttempt={status:done.status,stage:done.stage,error:done.error,source:done.report?.source,retryCount:done.report?.sourceRetryCount??0};
  assert.equal(done.status,'completed',done.error||done.stage);const feed=await getRanobeFeed(pool,live.feed.id),snapshot=await(await api(`/ranobe/feeds/${feed.id}/snapshots/${feed.head_run_id}`)).json();assert.equal(snapshot.status,'ready');assert.ok(snapshot.chapterCount>20);assert.equal(snapshot.originalWorkComplete,false);
  const parts=await getRanobeParts(pool,feed.head_run_id);let chapters=0,imageBlocks=0;const packages=[];
  for(const part of parts){const stored=(await pool.query('SELECT * FROM books WHERE id=$1',[part.book_id])).rows[0];const content=await download(stored.id,stored.content_sha256);assert.equal(content.chapters.length,part.source_keys.length);chapters+=content.chapters.length;imageBlocks+=content.chapters.flatMap(chapter=>chapter.blocks).filter(block=>block.type==='image').length;for(const encoded of Object.values(content.assets))assert.ok(Buffer.from(encoded,'base64').subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])));packages.push({chapters:content.chapters.length,images:Object.keys(content.assets).length,bytes:stored.content_bytes,sha256:stored.content_sha256});}
  assert.equal(chapters,snapshot.chapterCount);assert.equal(new Set(parts.flatMap(part=>part.source_keys)).size,chapters);
  assert.ok(imageBlocks>=9,'HTML and typed-JSON illustrations must both survive the real parser');
  summary.liveRanobe={url:liveUrl,branch:null,coverage:'source-inventory-snapshot',originalWorkComplete:false,chapters,parts:parts.length,imageBlocks,packages,identityChecked:true,realScanner:true,realSandboxParser:true};
  record('live Ranobe full selected branch -> every available inventory chapter -> quarantine/AV/sandbox -> ordered complete snapshot',{chapters,parts:parts.length});
 }
}
