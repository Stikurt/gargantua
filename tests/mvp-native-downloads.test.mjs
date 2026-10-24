import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeDownloadManager} from '../src/mvp/native-downloads.mjs';
import {downloadId,downloadOutlineId} from '../src/mvp/download-identity.mjs';
import {chapterOrigin,originKey} from '../src/mvp/api.mjs';

const book={source:'ranobelib',id:'fixture',title:'Сохранённая книга',defaultBranchId:'team'};
const chapters=[{id:'first',title:'Первая'},{id:'second',title:'Вторая'}];
const content={paragraphs:['Собственный короткий текст теста.']};
const items=chapters.map(chapter=>({key:originKey(chapterOrigin(book,chapter,'team')),chapter,origin:chapterOrigin(book,chapter,'team'),status:'downloaded'}));
const oldJob=()=>({id:downloadId(book,'team'),book,branchId:'team',items:structuredClone(items),outlineKey:downloadOutlineId(book,chapters,'team'),status:'paused'});
function harness({legacy=[],native=[]}={}){
  const values=new Map(),cache=new Map(items.map(item=>[item.chapter.id,content])),committed=new Map(),jobs=new Map(native.map(job=>[job.id,structuredClone(job)])),calls=[];
  const storage={listDownloads:async()=>structuredClone(legacy),get:async key=>values.get(key),put:async(key,value)=>values.set(key,value),removeDownload:async id=>{calls.push(['removeLegacy',id]);legacy=legacy.filter(job=>job.id!==id)},readLegacyChapter:async(_book,chapter)=>cache.get(chapter.id),update:async()=>{},flush:async()=>calls.push(['flush'])};
  const bridge={list:async()=>[...jobs.values()].map(({items,...header})=>({...header,total:items?.length||0,downloaded:items?.filter(item=>committed.has(item.key)).length||0})),start:async()=>{calls.push(['start'])},saveChapter:async(key,value)=>{calls.push(['save',key]);committed.set(key,value);return true},enqueue:async job=>{calls.push(['enqueue',structuredClone(job),committed.size]);jobs.set(job.id,structuredClone(job));},pause:async id=>{calls.push(['pause',id]);jobs.get(id).status='paused'},resume:async id=>{calls.push(['resume',id]);jobs.get(id).status='queued'},cancel:async id=>{calls.push(['cancel',id]);jobs.delete(id)}};
  const target=new EventTarget();target.document={visibilityState:'visible'};
  const manager=createNativeDownloadManager({bridge,storage,eventTarget:target,schedule:()=>({unref(){}}),cancelSchedule:()=>{}});
  return {manager,bridge,storage,calls,cache,committed,jobs,values,target};
}
test('legacy cache is durably handed off before queue ownership, with intentional pause preserved',async()=>{
  const h=harness({legacy:[oldJob()]});await h.manager.init();
  const call=h.calls.find(call=>call[0]==='enqueue');assert.equal(call[2],2);assert.equal(call[1].status,'paused');assert.equal(call[1].imported,true);
  assert.deepEqual(h.calls.map(call=>call[0]),['save','save','enqueue','removeLegacy','start']);
  assert.equal(h.manager.getSnapshot()[0].native,true);assert.equal(h.manager.getSnapshot()[0].downloaded,2);
  assert.equal(h.values.get('native-download-migrated:'+oldJob().id),oldJob().outlineKey);
});
test('an active legacy queue retains resumable intent and cooldown through the native handoff',async()=>{
  const job={...oldJob(),status:'waiting',retryAt:200000,sourceCooldowns:{ranobelib:200000},sourcePacingMs:{ranobelib:2000}};
  const h=harness({legacy:[job]});await h.manager.init();const saved=h.jobs.get(job.id);
  assert.equal(saved.status,'waiting');assert.equal(saved.retryAt,200000);assert.deepEqual(saved.sourceCooldowns,job.sourceCooldowns);
  await h.manager.shutdown();assert.equal(h.jobs.get(job.id).status,'waiting');assert(!h.calls.some(call=>['pause','resume','cancel'].includes(call[0])));
});
test('a native job already in progress is never replaced by an older IndexedDB checkpoint',async()=>{
  const job={...oldJob(),status:'downloading'},h=harness({legacy:[oldJob()],native:[job]});await h.manager.init();
  assert(!h.calls.some(call=>call[0]==='enqueue'));assert.equal(h.jobs.get(job.id).status,'downloading');assert(!h.calls.some(call=>call[0]==='save'));
});
test('a failed durable cache handoff leaves the legacy queue available for retry',async()=>{
  const job=oldJob(),h=harness({legacy:[job]});h.bridge.saveChapter=async()=>{throw Error('disk full')};
  await assert.rejects(h.manager.init(),/disk full/);assert(!h.calls.some(call=>call[0]==='enqueue'||call[0]==='removeLegacy'));
  assert.equal(await h.storage.get('native-download-migrated:'+job.id),undefined);
});
test('legacy jobs without an outline hash are migrated instead of silently discarded',async()=>{
  const job=oldJob();delete job.outlineKey;const h=harness({legacy:[job]});await h.manager.init();assert(h.jobs.has(job.id));assert(h.jobs.get(job.id).outlineKey);
});
test('merged enqueue keeps each origin branch, reuses old text and delegates all network ownership',async()=>{
  const h=harness();const merged={source:'merged',id:'m',title:'Объединение',defaultBranchId:'base-team'};
  const outline=[{id:'first',origin:{source:'ranobeme',bookId:'other',chapterId:'c9',branchId:''}},{id:'second',origin:{source:'ranobelib',bookId:'tail',chapterId:'v1-c2',branchId:'tail-team'}}];
  await h.manager.enqueue(merged,outline,'base-team');const saved=[...h.jobs.values()][0];
  assert.equal(saved.branchId,'');assert.equal(saved.items[0].origin.branchId,'');assert.equal(saved.items[1].origin.branchId,'tail-team');
  assert.equal(saved.items[0].key,originKey(saved.items[0].origin));assert.equal(h.calls.find(call=>call[0]==='enqueue')[2],2);assert.equal(saved.imported,undefined);
});
test('cancellation survives another cold start even if an old checkpoint is still present',async()=>{
  const job=oldJob(),h=harness({native:[job]});await h.manager.init();await h.manager.cancel(job.id);assert.equal(h.jobs.size,0);
  h.storage.listDownloads=async()=>[job];const cold=createNativeDownloadManager({bridge:h.bridge,storage:h.storage,eventTarget:new EventTarget()});await cold.init();
  assert.equal(h.jobs.size,0);assert(!h.calls.some(call=>call[0]==='enqueue'));await cold.shutdown();
});
test('foreground progress events refresh only summaries and closing the renderer never stops the service',async()=>{
  const job=oldJob(),h=harness({native:[job]});await h.manager.init();let updates=0;h.manager.subscribe(()=>updates++);
  h.jobs.get(job.id).status='complete';h.target.dispatchEvent(new Event('gargantua-downloads-changed'));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.manager.getSnapshot()[0].status,'complete');assert(updates>0);await h.manager.shutdown();assert(!h.calls.some(call=>['pause','cancel'].includes(call[0])));
});
