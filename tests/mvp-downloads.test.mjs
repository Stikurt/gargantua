import test from 'node:test';
import assert from 'node:assert/strict';
import { createDownloadManager, downloadId, downloadOutlineId } from '../src/mvp/downloads.mjs';
import { cachedChapterKey } from '../src/mvp/storage.mjs';

const book = { source: 'ranobelib', id: 'book', title: 'Книга', defaultBranchId: 'default' };
const chapters = count => Array.from({ length: count }, (_, index) => ({ id: `c${index + 1}`, title: `Глава ${index + 1}` }));
const content = title => ({ title, paragraphs: ['Сохранённый русский текст.'] });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function memory() {
  const jobs = new Map(), texts = new Map(), rows = new Map();
  const storage = {
    jobs, texts, rows, writes: [],
    async listDownloads() { return structuredClone([...jobs.values()]); },
    async saveDownload(job) { storage.writes.push(structuredClone(job)); jobs.set(job.id, structuredClone(job)); },
    async removeDownload(id) { jobs.delete(id); },
    async readChapter(book, chapter, branch) { return texts.get(cachedChapterKey(book, chapter, branch)); },
    async saveChapter(book, chapter, branch, value) { texts.set(cachedChapterKey(book, chapter, branch), structuredClone(value)); },
    async update(key, transform) { const value = transform(rows.get(key)); if (value !== undefined) rows.set(key, value); return value; },
  };
  return storage;
}
const manager = (storage, request, extra = {}) => createDownloadManager({ storage, request, requestDelayMs: 0, retryDelayMs: 60000, ...extra });
async function until(check, label = 'condition') {
  for (let index = 0; index < 500; index++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail(`Timed out: ${label}`);
}
const jobOf = value => value.getSnapshot()[0];

test('normal book stores every chapter with selected branch and stable summary snapshots', async () => {
  const storage = memory(), paths = [];
  const value = manager(storage, async path => { paths.push(new URL(path, 'http://local')); return content('Глава'); });
  const empty = value.getSnapshot(); assert.strictEqual(value.getSnapshot(), empty);
  const calls = []; const unsubscribe = value.subscribe(() => calls.push(value.getSnapshot()));
  await value.enqueue(book, chapters(3), 'translation');
  await until(() => jobOf(value)?.status === 'complete');
  assert.equal(paths.length, 3);
  assert.ok(paths.every(path => path.searchParams.get('branchId') === 'translation'));
  assert.equal(jobOf(value).downloaded, 3); assert.equal(jobOf(value).total, 3);
  assert.equal(jobOf(value).failed, 0); assert.equal(jobOf(value).items, undefined);
  assert.ok(calls.length >= 4); unsubscribe(); await value.shutdown();
});

test('merged source descriptors own branch and canonical cache while old base texts are reused', async () => {
  const storage = memory(), paths = [];
  const merged = { source: 'merged', id: 'm', title: 'Объединённая книга', defaultBranchId: 'base-only' };
  const toc = [
    { id: 'mc1', origin: { source: 'ranobelib', bookId: 'base', chapterId: 'c1', branchId: 'base-only' } },
    { id: 'mc2', origin: { source: 'ranobeme', bookId: 'other', chapterId: 1167 } },
  ];
  await storage.saveChapter({source:'ranobelib', id:'base'}, {id:'c1'}, 'base-only', content('Исходная'));
  const value = manager(storage, async path => { paths.push(new URL(path, 'http://local')); return content('Продолжение'); });
  await value.enqueue(merged, toc, 'base-only'); await until(() => jobOf(value)?.status === 'complete');
  assert.equal(paths.length, 1); assert.equal(paths[0].searchParams.get('source'), 'ranobeme');
  assert.equal(paths[0].searchParams.has('branchId'), false); assert.equal(jobOf(value).downloaded, 2);
  assert.equal(downloadId(merged, 'base-only'), downloadId(merged, ''));
  assert.ok(await storage.readChapter(merged, toc[1], 'default')); await value.shutdown();
});

test('progress waits for durable text commit and storage failure never reports success', async () => {
  const storage = memory(), save = deferred(); let started = false;
  storage.saveChapter = async () => { started = true; await save.promise; };
  const value = manager(storage, async () => content('Глава'));
  await value.enqueue(book, chapters(1)); await until(() => started);
  assert.equal(jobOf(value).downloaded, 0); assert.equal(jobOf(value).status, 'downloading');
  save.reject(new Error('Недостаточно свободного места.'));
  await until(() => jobOf(value).status === 'error');
  assert.equal(jobOf(value).downloaded, 0); assert.match(jobOf(value).error, /свободного места/);
  await value.shutdown();
});

test('restart resumes remaining chapters without downloading durable cache twice', async () => {
  const storage = memory(), firstPending = deferred(), firstCalls = [];
  const first = manager(storage, async path => { firstCalls.push(path); return firstCalls.length === 1 ? content('Первая') : firstPending.promise; });
  await first.enqueue(book, chapters(3)); await until(() => firstCalls.length === 2);
  assert.equal(jobOf(first).downloaded, 1);
  await first.shutdown();
  const secondCalls = [], second = manager(storage, async path => { secondCalls.push(path); return content('Следующая'); });
  await second.init(); await until(() => jobOf(second)?.status === 'complete');
  assert.equal(secondCalls.length, 2); assert.ok(secondCalls.every(path => !path.includes('chapterId=c1&') && !path.endsWith('chapterId=c1')));
  firstPending.resolve(content('Опоздавшая')); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(storage.jobs.get(downloadId(book)).status, 'complete');
  await second.shutdown();
});

test('intentional pause survives cold startup until explicit resume', async () => {
  const storage = memory(), pending = deferred(); let calls = 0;
  const first = manager(storage, async () => { calls++; return pending.promise; });
  await first.enqueue(book, chapters(2)); await until(() => calls === 1);
  await first.pause(downloadId(book)); await first.shutdown();
  const second = manager(storage, async () => { calls++; return content('Глава'); });
  await second.init(); await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(jobOf(second).status, 'paused'); assert.equal(calls, 1);
  await second.resume(downloadId(book)); await until(() => jobOf(second).status === 'complete');
  assert.equal(calls, 3); pending.resolve(content('Опоздавшая')); await second.shutdown();
});

test('pause during a live request allows that durable result, then stops at chapter boundary', async () => {
  const storage = memory(), pending = deferred(); let calls = 0;
  const value = manager(storage, async () => { calls++; return calls === 1 ? pending.promise : content('Далее'); });
  await value.enqueue(book, chapters(2)); await until(() => calls === 1); await value.pause(downloadId(book));
  pending.resolve(content('Первая')); await until(() => jobOf(value).downloaded === 1);
  assert.equal(jobOf(value).status, 'paused'); assert.equal(calls, 1);
  await value.resume(downloadId(book)); await until(() => jobOf(value).status === 'complete'); await value.shutdown();
});

test('network failure waits without spinning, auto resumes on next startup, keeps checkpoint', async () => {
  const storage = memory(); let calls = 0, clock = 1000;
  const first = manager(storage, async () => { calls++; throw new Error('Сервер недоступен. Проверьте подключение.'); }, {now:()=>clock});
  await first.enqueue(book, chapters(2)); await until(() => jobOf(first).status === 'waiting');
  await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(calls, 1);
  assert.equal(jobOf(first).failed, 0); assert.equal(jobOf(first).downloaded, 0); await first.shutdown();
  clock += 60000;
  const second = manager(storage, async () => { calls++; return content('Вернулась сеть'); }, {now:()=>clock});
  await second.init(); await until(() => jobOf(second).status === 'complete'); assert.equal(calls, 3); await second.shutdown();
});

function virtualClock() {
  let current = 1000, serial = 0;
  const tasks = new Map();
  return {
    now:()=>current,
    schedule(callback, delay) { const id=++serial; tasks.set(id,{callback,at:current+delay}); return id; },
    cancelSchedule(id) { tasks.delete(id); },
    async advance(milliseconds=0) {
      current += milliseconds;
      for(let count=0;count<100;count++) {
        const due=[...tasks].find(([,task])=>task.at<=current);
        if(!due) { await new Promise(resolve=>setImmediate(resolve)); if(![...tasks.values()].some(task=>task.at<=current))return; continue; }
        tasks.delete(due[0]); due[1].callback(); await new Promise(resolve=>setImmediate(resolve));
      }
      assert.fail('Timer loop did not settle');
    },
  };
}

test('429 cooldown, exact Retry-After and source pacing survive restart, resume and repeat enqueue', async () => {
  const storage=memory(), clock=virtualClock(), calls=[];
  const toc=chapters(4); let throttles=0;
  const request=async path=>{calls.push({path,at:clock.now()}); if(path.includes('chapterId=c2')&&throttles++<2)throw Object.assign(new Error('Источник просит снизить частоту запросов'),{status:429,code:'SOURCE_RATE_LIMIT',retryAfterMs:180000}); return content('Текст');};
  const first=manager(storage,request,clock); await first.enqueue(book,toc); await clock.advance();
  assert.equal(calls.length,2); assert.equal(jobOf(first).downloaded,1); assert.equal(jobOf(first).failed,0);
  assert.equal(jobOf(first).status,'waiting'); const deadline=jobOf(first).retryAt;
  assert.equal(deadline,181000); assert.equal(jobOf(first).sourcePacingMs.ranobelib,1000);
  await first.shutdown(); assert.equal(storage.jobs.get(downloadId(book)).status,'waiting');
  const second=manager(storage,request,clock); await second.init(); await second.resume(downloadId(book)); await second.enqueue(book,toc);
  await clock.advance(179999); assert.equal(calls.length,2); assert.equal(jobOf(second).downloaded,1);
  assert.equal(jobOf(second).retryAt,deadline); assert.equal(jobOf(second).status,'waiting');
  await clock.advance(1); assert.equal(calls.length,3); assert.equal(jobOf(second).failed,0);
  assert.equal(jobOf(second).retryAt,361000); assert.equal(jobOf(second).sourcePacingMs.ranobelib,2000);
  await clock.advance(180000); assert.equal(calls.length,4); assert.equal(jobOf(second).downloaded,2);
  await clock.advance(1999); assert.equal(calls.length,4);
  await clock.advance(1); assert.equal(calls.length,5);
  await clock.advance(2000); assert.equal(calls.length,6); assert.equal(jobOf(second).status,'complete');
  assert.equal(jobOf(second).downloaded,4); assert.equal(jobOf(second).error,'');
  assert.equal(calls.filter(call=>call.path.includes('chapterId=c1')).length,1);
  await second.shutdown();
});

test('429 without Retry-After waits one minute, pauses other jobs for that source, not other providers', async () => {
  const storage=memory(), clock=virtualClock(), calls=[];
  const request=async path=>{calls.push(path); if(path.includes('id=book&'))throw Object.assign(new Error('Снизьте частоту'),{status:429,code:'SOURCE_RATE_LIMIT'}); return content('Другая книга');};
  const value=manager(storage,request,clock); await value.enqueue(book,chapters(1)); await clock.advance();
  assert.equal(jobOf(value).retryAt,61000); assert.equal(calls.length,1);
  await value.enqueue({...book,id:'second'},chapters(1)); await clock.advance(); assert.equal(calls.length,1);
  await value.enqueue({source:'ranobeme',id:'third',title:'Другая книга'},chapters(1)); await clock.advance();
  assert.equal(calls.length,2); assert.equal(value.getSnapshot().find(job=>job.book.id==='third').status,'complete');
  assert.equal(value.getSnapshot().find(job=>job.book.id==='second').sourcePacingMs?.ranobeme,undefined);
  await value.shutdown();
});

test('nontransient 502 format and limit failures stop that section, not endless network waiting', async () => {
  for(const code of ['SOURCE_FORMAT','SOURCE_LIMIT']) {
    const storage=memory(); let calls=0;
    const value=manager(storage,async()=>{calls++;throw Object.assign(new Error('Источник вернул неподдерживаемые данные'),{status:502,code});});
    await value.enqueue(book,chapters(1)); await until(()=>jobOf(value).status==='partial');
    assert.equal(jobOf(value).failed,1); assert.equal(calls,1); await value.shutdown();
  }
});

test('unavailable and failed sections stay honest; retry fetches only the failed section', async () => {
  const storage = memory(), calls = []; let fail = true;
  const value = manager(storage, async path => {
    calls.push(path);
    if (path.includes('chapterId=c2') && fail) throw Object.assign(new Error('Раздел удалён источником.'), {status:404});
    return content('Текст');
  });
  const toc = chapters(4); toc[3].available = false;
  await value.enqueue(book, toc); await until(() => jobOf(value).status === 'partial');
  assert.equal(jobOf(value).total, 4); assert.equal(jobOf(value).downloaded, 2); assert.equal(jobOf(value).failed, 1); assert.equal(jobOf(value).unavailable, 1);
  assert.equal(jobOf(value).failedChapters.length, 1);
  fail = false; await value.resume(downloadId(book)); await until(() => jobOf(value).downloaded === 3);
  assert.equal(jobOf(value).status, 'partial'); assert.equal(jobOf(value).failed, 0); assert.equal(calls.length, 4);
  await value.shutdown();
});

test('blank cached and returned text cannot become a completed download', async () => {
  const storage = memory(); await storage.saveChapter(book, chapters(1)[0], 'default', {paragraphs:['  '],text:'Reader ignores text when paragraphs is an array.'});
  let calls = 0;
  const value = manager(storage, async () => { calls++; return {paragraphs: [' '], text:'Reader ignores this text fallback too.'}; });
  await value.enqueue(book, chapters(1)); await until(() => jobOf(value).status === 'partial');
  assert.equal(calls, 1); assert.equal(jobOf(value).downloaded, 0); assert.equal(jobOf(value).failed, 1); await value.shutdown();
});

test('cancel invalidates late network result and never resurrects removed queue', async () => {
  const storage = memory(), pending = deferred(); let calls = 0;
  const value = manager(storage, async () => { calls++; return pending.promise; });
  await value.enqueue(book, chapters(1)); await until(() => calls === 1);
  await value.cancel(downloadId(book)); pending.resolve(content('Опоздавшая'));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(value.getSnapshot().length, 0); assert.equal(storage.jobs.size, 0); assert.equal(storage.texts.size, 0); await value.shutdown();
});

test('shutdown checkpoints without waiting for a stuck native request', async () => {
  const storage = memory(), stuck = deferred(); let calls = 0;
  const value = manager(storage, async () => { calls++; return stuck.promise; });
  await value.enqueue(book, chapters(2)); await until(() => calls === 1);
  await Promise.race([value.shutdown(), new Promise((_, reject) => setTimeout(() => reject(new Error('shutdown waited for network')), 100))]);
  assert.equal(storage.jobs.get(downloadId(book)).status, 'queued');
  stuck.resolve(content('Слишком поздно')); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(storage.texts.size, 0); assert.equal(storage.jobs.get(downloadId(book)).downloaded, 0);
});

test('changed outline keeps committed origins but downloads added/replaced chapters', async () => {
  const storage = memory(), calls = [];
  const value = manager(storage, async path => { calls.push(path); return content('Текст'); });
  await value.enqueue(book, chapters(2)); await until(() => jobOf(value).status === 'complete');
  const firstKey = jobOf(value).outlineKey, next = [...chapters(2), {id:'c3'}];
  await value.enqueue(book, next); await until(() => jobOf(value).status === 'complete');
  assert.notEqual(jobOf(value).outlineKey, firstKey); assert.equal(calls.length, 3);
  next[1] = { id:'replacement' }; await value.enqueue(book, next); await until(() => jobOf(value).status === 'complete');
  assert.equal(calls.length, 4); assert.equal(jobOf(value).downloaded, 3); await value.shutdown();
});

test('all unavailable outline is partial without making a request; branch preference preserves existing reader data', async () => {
  const storage = memory(); let calls = 0;
  const row = { book, chapters:chapters(1), branches:['old'], position:{branchId:'old', fraction:.7} };
  storage.rows.set('book:ranobelib:book', row);
  const value = manager(storage, async () => { calls++; return content('Нельзя'); });
  await value.enqueue(book, [{id:'missing', available:false}], 'new');
  assert.equal(jobOf(value).status, 'partial'); assert.equal(jobOf(value).unavailable, 1); assert.equal(calls, 0);
  assert.deepEqual(storage.rows.get('book:ranobelib:book').position, row.position);
  assert.deepEqual(storage.rows.get('book:ranobelib:book').branches, ['old']);
  assert.equal(storage.rows.get('book:ranobelib:book').downloadBranchId, 'new');
  assert.notEqual(downloadOutlineId(book, chapters(1), 'a'), downloadOutlineId(book, chapters(1), 'b')); await value.shutdown();
});

test('failed queue checkpoint never produces false complete and can recover from durable chapter cache', async () => {
  const storage = memory(), original = storage.saveDownload; let writes = 0;
  storage.saveDownload = async job => { writes++; if (writes === 3) throw new Error('Нет места для очереди.'); return original(job); };
  const value = manager(storage, async () => content('Текст'));
  await value.enqueue(book, chapters(1)); await until(() => jobOf(value).status === 'error');
  assert.equal(storage.jobs.get(downloadId(book)).downloaded, 0); assert.equal(storage.texts.size, 1);
  await value.shutdown(); storage.saveDownload = original;
  let calls = 0; const cold = manager(storage, async () => { calls++; return content('Не нужно повторять'); });
  await cold.init(); await until(() => jobOf(cold).status === 'complete');
  assert.equal(calls, 0); assert.equal(jobOf(cold).downloaded, 1); await cold.shutdown();
});
