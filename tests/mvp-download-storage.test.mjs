import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal asynchronous transactional IDB harness. No browser or test dependency.
function indexedDatabase() {
  const data = new Map(), puts = [], cursors = [];
  let tail = Promise.resolve();
  const db = { close() {}, transaction() {
    const queue = [];
    let finish, aborted = false;
    const done = new Promise(resolve => { finish = resolve; });
    const transaction = { abort() { aborted = true; }, objectStore() { return store; } };
    const operation = fn => { const request = {}; queue.push(() => { fn(request); request.onsuccess?.(); }); return request; };
    const store = {
      get(key) { return operation(request => { request.result = structuredClone(data.get(key)); }); },
      put(value, key) { const copy = structuredClone(value); return operation(() => { data.set(key, copy); puts.push({key, bytes:JSON.stringify(copy).length}); }); },
      delete(key) { return operation(() => data.delete(key)); },
      openCursor(range) {
        const request = {};
        let keys, index = 0;
        const next = () => queue.push(() => {
          keys ||= [...data.keys()].sort().filter(key => !range || key >= range.lower && key <= range.upper);
          const key = keys[index++];
          request.result = key === undefined ? null : { key, value:structuredClone(data.get(key)), continue:next, delete:() => store.delete(key) };
          if (key !== undefined) cursors.push(key);
          request.onsuccess?.();
        });
        next(); return request;
      },
    };
    tail = tail.then(async () => {
      await new Promise(resolve => setImmediate(resolve));
      while (queue.length && !aborted) queue.shift()();
      if (aborted) transaction.onabort?.(); else transaction.oncomplete?.();
      finish();
    });
    void done;
    return transaction;
  } };
  return { data, puts, cursors, open() { const request = {result:db}; queueMicrotask(() => request.onsuccess?.()); return request; } };
}

test('large outlines are written once while compact progress rehydrates after cold storage startup', async () => {
  const previousIDB = globalThis.indexedDB, previousRange = globalThis.IDBKeyRange;
  const db = indexedDatabase();
  globalThis.indexedDB = db; globalThis.IDBKeyRange = {bound:(lower,upper)=>({lower,upper})};
  try {
    const storage = await import('../src/mvp/storage.mjs?download-storage-compact');
    const items = Array.from({length:4531}, (_,index) => ({key:`origin-${index}`, chapter:{id:`c${index}`,title:`Глава ${index}`,origin:{source:'ranobeme',bookId:'297',chapterId:index}},origin:{source:'ranobeme',bookId:'297',chapterId:index},status:'pending',error:'',attempts:0}));
    const job = {id:'large',book:{source:'merged',id:'large',title:'Большая книга'},outlineKey:'4531-key',items,status:'waiting',retryAt:181000,sourceCooldowns:{ranobelib:181000},sourcePacingMs:{ranobelib:2000},rateLimitCounts:{ranobelib:2}};
    await storage.saveDownload(job);
    for (let index=0; index<4; index++) { items[index].status='downloaded'; await storage.saveDownload(job); }
    items[4].status='failed'; items[4].error='Источник удалил главу'; items[4].attempts=2;
    items[5].status='unavailable'; await storage.saveDownload(job);
    assert.equal(db.puts.filter(value=>value.key==='download-manifest:large').length,1);
    assert.ok(db.puts.filter(value=>value.key==='download:large').every(value=>value.bytes<6000));
    assert.equal(db.data.get('download:large').items, undefined);
    const cold = await import('../src/mvp/storage.mjs?download-storage-cold');
    const [restored] = await cold.listDownloads();
    assert.equal(restored.items.length,4531); assert.equal(restored.items[3].status,'downloaded');
    assert.equal(restored.items[4].status,'failed'); assert.equal(restored.items[4].attempts,2); assert.equal(restored.items[4].error,'Источник удалил главу');
    assert.equal(restored.items[5].status,'unavailable'); assert.equal(restored.items[6].status,'pending');
    assert.equal(restored.status,'waiting'); assert.equal(restored.retryAt,181000);
    assert.deepEqual(restored.sourceCooldowns,{ranobelib:181000}); assert.deepEqual(restored.sourcePacingMs,{ranobelib:2000}); assert.deepEqual(restored.rateLimitCounts,{ranobelib:2});
    await cold.saveDownload(restored); assert.equal(db.puts.filter(value=>value.key==='download-manifest:large').length,1);
    restored.outlineKey='4532-key'; restored.items.push({...items[0],key:'new-origin'}); await cold.saveDownload(restored);
    assert.equal(db.puts.filter(value=>value.key==='download-manifest:large').length,2);
    await cold.removeDownload('large'); assert.equal(db.data.has('download:large'),false); assert.equal(db.data.has('download-manifest:large'),false);
  } finally { globalThis.indexedDB=previousIDB; globalThis.IDBKeyRange=previousRange; }
});

test('book/queue cursors never load cached prose; removing book deletes its jobs and retains shared caches', async () => {
  const previousIDB = globalThis.indexedDB, previousRange = globalThis.IDBKeyRange;
  const db = indexedDatabase(); globalThis.indexedDB=db; globalThis.IDBKeyRange={bound:(lower,upper)=>({lower,upper})};
  try {
    const storage = await import('../src/mvp/storage.mjs?download-storage-ranges');
    const book={source:'ranobelib',id:'one',title:'Книга'};
    await storage.saveBook(book,[{id:'c1'}]);
    await storage.put('text:shared',{paragraphs:['Большой русский текст']});
    await storage.saveDownload({id:'one-a',book,outlineKey:'1-a',items:[{key:'c1',chapter:{id:'c1'},origin:{source:'ranobelib',bookId:'one',chapterId:'c1'},status:'downloaded'}]});
    await storage.saveDownload({id:'one-b',book,outlineKey:'1-b',items:[]});
    await storage.saveDownload({id:'other',book:{source:'ranobeme',id:'other'},outlineKey:'0-other',items:[]});
    assert.equal((await storage.listBooks()).length,1); assert.equal((await storage.listDownloads()).length,3);
    await storage.removeBook(book);
    assert.equal(db.data.has('book:ranobelib:one'),false); assert.equal(db.data.has('download:one-a'),false); assert.equal(db.data.has('download-manifest:one-b'),false);
    assert.equal(db.data.has('download:other'),true); assert.equal(db.data.has('text:shared'),true);
    assert.ok(!db.cursors.some(key=>key.startsWith('text:')));
  } finally { globalThis.indexedDB=previousIDB; globalThis.IDBKeyRange=previousRange; }
});

test('concurrent saved outline and reader position updates preserve both records', async () => {
  const previousIDB=globalThis.indexedDB, previousRange=globalThis.IDBKeyRange;
  const db=indexedDatabase(); globalThis.indexedDB=db; globalThis.IDBKeyRange={bound:(lower,upper)=>({lower,upper})};
  try {
    const storage=await import('../src/mvp/storage.mjs?download-storage-concurrent');
    const book={source:'merged',id:'book',title:'Сборная книга'};
    await storage.saveBook(book,[{id:'first'}]);
    await Promise.all([storage.saveBook(book,[{id:'first'},{id:'new'}],['kept']),storage.savePosition(book,{chapterIndex:0,fraction:.4},{activate:false})]);
    const saved=await storage.get('book:merged:book'); assert.equal(saved.chapters.length,2); assert.equal(saved.position.fraction,.4); assert.deepEqual(saved.branches,['kept']);
    await storage.flush();
  } finally { globalThis.indexedDB=previousIDB; globalThis.IDBKeyRange=previousRange; }
});
