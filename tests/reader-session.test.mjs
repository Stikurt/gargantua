/** Offline adapter acceptance with fault-injected transactions and a protocol
 * model. Does not claim native SQLite, Docker, browser UI or production tests. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createReaderSession} from '../src/reader-session.mjs';
import {DEVICE} from '../src/catalogs.mjs';
import {READER_CATALOG_ID} from '../src/reader-sync.mjs';
import {normalizeReaderMutation, readerMutationIdV2} from '../server/reader-data-model.mjs';
import {commitLocalBook,listLocalBooks} from '../src/library-state.mjs';
import {groupBookCards} from '../src/serial-groups.mjs';

const PROFILE = '10000000-0000-4000-8000-000000000001';
const BOOK = '30000000-0000-4000-8000-000000000003';
const SECOND_BOOK = '30000000-0000-4000-8000-000000000005';
const MARK = '40000000-0000-4000-8000-000000000004';
const CATALOG = '50000000-0000-4000-8000-000000000005';
const STAMP = '2026-10-23T12:00:00.000Z';
const copy = value => value === undefined ? undefined : structuredClone(value);
const cursor = (revision = 0) => Buffer.from(JSON.stringify({schemaVersion: 1, profileId: PROFILE, revision})).toString('base64url');
const reading = (id = BOOK, locator = {type: 'legacy', chapter: 0, position: .3}, shelf = 'reading') => ({entityType: 'reading', entityId: id, revision: 1, deleted: false, updatedAt: STAMP, payload: {publicationId: id, publicationRevision: 1, locator, shelf}});
const bookmark = (id = BOOK, deleted = false, includePayload = true) => ({entityType: 'bookmark', entityId: MARK, revision: 1, deleted, updatedAt: STAMP, payload: includePayload ? {publicationId: id, publicationRevision: 1, locator: {type: 'legacy', chapter: 0, position: .2}, note: 'Серверная метка'} : null});
const packet = (bookId = BOOK) => ({book: {id: bookId, title: 'Тестовая книга'}, content: {chapters: [{title: 'Глава', blocks: [{type: 'text', text: 'Безопасный текст'}]}], structure: {chapters: [{id: 'chapter-one', blocks: [{id: 'block-one', type: 'text', text: 'Безопасный текст'}]}]}}});

class TransactionStore {
  values = new Map(); batches = []; fail = null;
  async get(key) { return copy(this.values.get(key)); }
  async entries(prefix) { return [...this.values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, copy(value)]); }
  async keys(prefix) { return [...this.values.keys()].filter(key => key.startsWith(prefix)); }
  async apply(operations) {
    const next = new Map([...this.values].map(([key, value]) => [key, copy(value)]));
    for (let index = 0; index < operations.length; index++) {
      if (this.fail?.(operations, index)) throw new Error('atomic adapter storage failure');
      const operation = operations[index];
      if (operation.type === 'put') next.set(operation.key, copy(operation.value)); else next.delete(operation.key);
    }
    this.values = next; this.batches.push(copy(operations));
  }
}
class AdapterServer {
  entities = new Map(); devices = new Map(); receipts = new Map(); revision = 0; calls = []; offline = false; beforeMutation = null;
  add(entity) { this.entities.set(entity.entityType + ':' + entity.entityId, copy(entity)); this.revision++; }
  api = async (path, options = {}) => {
    this.calls.push({path, options: copy(options)});
    if (this.offline) throw new Error('synthetic server offline');
    if (path === '/me') return {id: PROFILE, login: 'synthetic-user'};
    if (path === '/v2/reader/snapshot') return {schemaVersion: 1, cursor: cursor(this.revision), entities: [...this.entities.values()].map(copy), devices: [...this.devices.values()].map(copy)};
    assert.equal(path, '/v2/reader/mutations');
    if (this.beforeMutation) await this.beforeMutation(options.body.mutations[0]);
    const mutation = normalizeReaderMutation(options.body.mutations[0]);
    assert.equal(mutation.mutationId, readerMutationIdV2(PROFILE, mutation.deviceId, mutation.counter));
    let result = this.receipts.get(mutation.mutationId);
    if (!result) {
      const key = mutation.entityType + ':' + mutation.entityId, current = this.entities.get(key) ?? null;
      const device = this.devices.get(mutation.deviceId) ?? {deviceId: mutation.deviceId, protocolVersion: 2, lastCounter: 0, compactedThrough: 0, compactedCount: 0};
      assert.equal(mutation.counter, device.lastCounter + 1);
      if (mutation.baseRevision !== (current?.revision ?? 0)) result = {mutationId: mutation.mutationId, status: 'conflict', code: 'REVISION_CONFLICT', current: copy(current), proposed: copy(mutation)};
      else {
        const entity = {entityType: mutation.entityType, entityId: mutation.entityId, revision: (current?.revision ?? 0) + 1, deleted: mutation.operation === 'delete', payload: mutation.operation === 'delete' ? current?.payload ?? null : copy(mutation.payload), updatedAt: STAMP};
        this.add(entity); result = {mutationId: mutation.mutationId, status: 'accepted', entity};
      }
      device.lastCounter = mutation.counter; this.devices.set(device.deviceId, device); this.receipts.set(mutation.mutationId, copy(result));
    }
    return {schemaVersion: 1, cursor: cursor(this.revision), results: [copy(result)]};
  };
  posts() { return this.calls.filter(call => call.path === '/v2/reader/mutations'); }
}
function fixture() {
  const storage = new TransactionStore(), server = new AdapterServer();
  const session = createReaderSession({storage, api: server.api, crypto: webcrypto, serverIdentity: 'https://reader-adapter.invalid'});
  return {storage, server, session};
}

test('local-device reading and bookmarks never create a server stream or call the network', async () => {
  const {storage, server, session} = fixture(), book = {id: BOOK, owner: DEVICE}; server.offline = true;
  await session.savePosition(book, 0, .5);
  const mark = await session.saveMark(book, 0, .4, 'Локальная метка');
  assert.equal((await storage.get(`${DEVICE}:position:${BOOK}`)).position, .5);
  assert.equal((await storage.get(`${DEVICE}:mark:${BOOK}:${mark.id}`)).note, 'Локальная метка');
  assert.equal(server.calls.length, 0); assert.equal((await storage.keys(`${DEVICE}:sync:`)).length, 0);
  await assert.rejects(session.forProfile(DEVICE), /серверный профиль/);
});

test('offline server reading commits its position and unsent intent in the same transaction', async () => {
  const {storage, server, session} = fixture(); server.offline = true;
  await session.savePosition({id: BOOK, owner: PROFILE}, 0, .4);
  const engine = await session.forProfile(PROFILE);
  await assert.rejects(engine.sync(), /server offline/);
  const batch = storage.batches.find(operations => operations.some(operation => operation.key === `${PROFILE}:position:${BOOK}`));
  assert.equal(batch.length, 2); assert.equal(batch[1].key, engine.stateKey);
  assert.equal(batch[1].value.desired[0].payload.locator.position, .4);
  assert.equal((await storage.get(`${PROFILE}:position:${BOOK}`)).position, .4);
  assert.equal((await engine.getState()).desired.length, 1);
});

test('failed position persistence leaves both the existing local position and the outbox intact', async () => {
  const {storage, server, session} = fixture(); server.offline = true;
  const key = `${PROFILE}:position:${BOOK}`, original = {chapter: 0, position: .1, shelf: 'reading'};
  await storage.apply([{type: 'put', key, value: original}]);
  const engine = await session.forProfile(PROFILE);
  storage.fail = (operations, index) => operations.some(operation => operation.key === key) && index === 1;
  await assert.rejects(session.savePosition({id: BOOK, owner: PROFILE}, 0, .2), /atomic adapter storage failure/);
  assert.deepEqual(await storage.get(key), original);
  assert.equal((await engine.getState()).desired.length, 0); assert.equal(server.calls.length, 0);
});

test('failed bookmark persistence cannot leave a visible local mark without its durable operation', async () => {
  const {storage, server, session} = fixture(); server.offline = true;
  const engine = await session.forProfile(PROFILE);
  storage.fail = (operations, index) => operations.some(operation => operation.key.startsWith(`${PROFILE}:mark:`)) && index === 1;
  await assert.rejects(session.saveMark({id: BOOK, owner: PROFILE}, 0, .2, 'Метка'), /atomic adapter storage failure/);
  assert.deepEqual(await storage.keys(`${PROFILE}:mark:`), []);
  assert.equal((await engine.getState()).desired.length, 0);
});

test('the same projected canonical anchor is retained when opening the reader without moving', async () => {
  const {storage, server, session} = fixture();
  await storage.apply([{type: 'put', key: `${PROFILE}:book:${BOOK}`, value: packet()}]);
  const anchor = {publicationId: BOOK, publicationRevision: 1, chapterId: 'chapter-one', blockId: 'block-one', offset: 5};
  server.add(reading(BOOK, anchor)); const engine = await session.connect({id: PROFILE, login: 'test'});
  const result = await session.savePosition({id: BOOK, owner: PROFILE}, 0, 0);
  assert.deepEqual(result, {unchanged: true});
  assert.deepEqual((await storage.get(`${PROFILE}:position:${BOOK}`)).remoteAnchor, anchor);
  assert.equal((await engine.getState()).desired.length, 0); assert.equal(server.posts().length, 0);
});

test('explicit A(.43) to B(0) to A(.43) updates local resume order even in one millisecond without remote edits',async t=>{
 const {storage,server,session}=fixture(),fixed=Date.parse(STAMP)+1000;t.mock.method(Date,'now',()=>fixed);
 const ids=[BOOK,SECOND_BOOK];
 for(const [index,id]of ids.entries()){
  const title='Immutable part '+index,content={title,author:'Author',language:'ru',chapters:[{title:'Chapter',blocks:[{type:'text',text:'Original text'}]}],assets:{}};
  await commitLocalBook(storage,{owner:PROFILE,book:{id,title,author:'Author',chapter_count:1,content_sha256:'b'.repeat(64),package_sha256:'c'.repeat(64),security_state:'passed'},content,scope:'server'});
  server.add(reading(id,{type:'legacy',chapter:0,position:index?0:.43}));
 }
 const engine=await session.connect({id:PROFILE,login:'test'}),syncBefore=await storage.get(engine.stateKey);
 await session.savePosition({id:BOOK,owner:PROFILE},0,.43,undefined,{touch:true});
 await session.savePosition({id:SECOND_BOOK,owner:PROFILE},0,0,undefined,{touch:true});
 const second=await storage.get(`${PROFILE}:position:${SECOND_BOOK}`);
 const result=await session.savePosition({id:BOOK,owner:PROFILE},0,.43,undefined,{touch:true}),first=await storage.get(`${PROFILE}:position:${BOOK}`);
 assert.deepEqual(result,{unchanged:true,touched:true});assert.equal(first.position,.43);assert.ok(first.lastRead>second.lastRead);assert.ok(second.lastRead>fixed);
 const group={schemaVersion:1,id:CATALOG,snapshotId:MARK,provider:'ranobelib',title:'One book',author:'Author',language:'ru',branch:'test',snapshotStatus:'ready',inventorySha256:'a'.repeat(64),totalChapters:2,parts:ids.map((publicationId,chapterOffset)=>({publicationId,chapterOffset,chapterCount:1,contentSha256:'b'.repeat(64),packageSha256:'c'.repeat(64),securityState:'passed'}))};
 const [card]=groupBookCards(await listLocalBooks(storage),[{schemaVersion:1,owner:PROFILE,group,headers:{},updatedAt:fixed,active:true}]);assert.equal(card.resumePublicationId,BOOK);assert.equal(card.position,.43);
 assert.deepEqual(await storage.get(engine.stateKey),syncBefore);assert.equal(server.posts().length,0);
});

test('explicit local recency touch preserves canonical anchor and revision while ordinary autosave stays a true no-op',async t=>{
 const {storage,server,session}=fixture();await storage.apply([{type:'put',key:`${PROFILE}:book:${BOOK}`,value:packet()}]);
 const anchor={publicationId:BOOK,publicationRevision:1,chapterId:'chapter-one',blockId:'block-one',offset:5};server.add(reading(BOOK,anchor));const engine=await session.connect({id:PROFILE,login:'test'}),key=`${PROFILE}:position:${BOOK}`,before=await storage.get(key),batches=storage.batches.length;
 t.mock.method(Date,'now',()=>before.lastRead);
 assert.deepEqual(await session.savePosition({id:BOOK,owner:PROFILE},0,0),{unchanged:true});assert.equal(storage.batches.length,batches);assert.deepEqual(await storage.get(key),before);
 await session.savePosition({id:BOOK,owner:PROFILE},0,0,undefined,{touch:true});const after=await storage.get(key);assert.equal(after.lastRead,before.lastRead+1);assert.deepEqual({...after,lastRead:before.lastRead},before);assert.deepEqual(after.remoteAnchor,anchor);assert.equal(after.remoteRevision,1);assert.equal(after.approximate,true);
 assert.equal((await engine.getState()).desired.length,0);assert.equal(server.posts().length,0);assert.equal(storage.batches.at(-1).length,1);assert.equal(storage.batches.at(-1)[0].key,key);
});

test('failed explicit touch leaves the saved anchor intact and creates no outbox or server call',async()=>{
 const {storage,server,session}=fixture(),key=`${PROFILE}:position:${BOOK}`,old={chapter:0,position:.43,shelf:'reading',lastRead:1,remoteAnchor:{type:'legacy',chapter:0,position:.43},remoteRevision:7,approximate:false};
 await storage.apply([{type:'put',key,value:old}]);storage.fail=operations=>operations.some(operation=>operation.key===key);
 await assert.rejects(session.savePosition({id:BOOK,owner:PROFILE},0,.43,undefined,{touch:true}),/atomic adapter storage failure/);assert.deepEqual(await storage.get(key),old);assert.deepEqual(await storage.keys(''),[key]);assert.equal(server.calls.length,0);
 storage.fail=null;assert.deepEqual(await session.savePosition({id:BOOK,owner:PROFILE},0,.43,undefined,{touch:true}),{unchanged:true,touched:true});assert.equal(server.calls.length,0);
});

test('explicit opening at a changed coordinate keeps exactly one normal durable server mutation',async()=>{
 const {storage,server,session}=fixture(),book={id:BOOK,owner:PROFILE};server.add(reading(BOOK,{type:'legacy',chapter:0,position:.1}));const engine=await session.connect({id:PROFILE,login:'test'});
 await session.savePosition(book,0,.43,undefined,{touch:true});await engine.sync();assert.equal(server.posts().length,1);assert.equal(server.entities.get('reading:'+BOOK).payload.locator.position,.43);
 const batches=storage.batches.length;assert.deepEqual(await session.savePosition(book,0,.43),{unchanged:true});assert.equal(storage.batches.length,batches);assert.equal(server.posts().length,1);
});

test('changing only a shelf preserves the canonical text anchor instead of downgrading it to a scroll ratio', async () => {
  const {storage, server, session} = fixture();
  await storage.apply([{type: 'put', key: `${PROFILE}:book:${BOOK}`, value: packet()}]);
  const anchor = {publicationId: BOOK, publicationRevision: 1, chapterId: 'chapter-one', blockId: 'block-one', offset: 5};
  server.add(reading(BOOK, anchor)); const engine = await session.connect({id: PROFILE, login: 'test'});
  await session.savePosition({id: BOOK, owner: PROFILE}, 0, 0, 'favorite'); await engine.sync();
  assert.deepEqual(server.entities.get('reading:' + BOOK).payload.locator, anchor);
  assert.equal(server.entities.get('reading:' + BOOK).payload.shelf, 'favorite');
});

test('a corrupt cached packet cannot partially apply another publication position from the same snapshot', async () => {
  const {storage, server, session} = fixture(), original = {chapter: 0, position: .05, shelf: 'reading'};
  await storage.apply([{type: 'put', key: `${PROFILE}:book:${BOOK}`, value: packet()}, {type: 'put', key: `${PROFILE}:book:${SECOND_BOOK}`, value: {book: {id: SECOND_BOOK}}}, {type: 'put', key: `${PROFILE}:position:${BOOK}`, value: original}]);
  server.add(reading()); server.add(reading(SECOND_BOOK, {publicationId: SECOND_BOOK, publicationRevision: 1, chapterId: 'chapter-one'}));
  await assert.rejects(session.connect({id: PROFILE, login: 'test'}));
  assert.deepEqual(await storage.get(`${PROFILE}:position:${BOOK}`), original);
  assert.equal(await storage.get(`${PROFILE}:position:${SECOND_BOOK}`), undefined);
  assert.equal((await (await session.forProfile(PROFILE)).getState()).cursor, null);
});

test('malformed saved metadata and an invalid shelf reject before replacing the local position', async () => {
  const {storage, session} = fixture(), key = `${PROFILE}:position:${BOOK}`, original = {chapter: 0, position: .1, shelf: 'unknown-shelf'};
  await storage.apply([{type: 'put', key, value: original}]);
  const engine = await session.forProfile(PROFILE);
  await assert.rejects(session.savePosition({id: BOOK, owner: PROFILE}, 0, .2), /полка/);
  assert.deepEqual(await storage.get(key), original); assert.equal((await engine.getState()).desired.length, 0);
});

test('a bookmark tombstone removes the local mark and does not touch another profile', async () => {
  const {storage, server, session} = fixture(), key = `${PROFILE}:mark:${BOOK}:${MARK}`, otherKey = `${DEVICE}:mark:${BOOK}:${MARK}`;
  await storage.apply([{type: 'put', key, value: {id: MARK}}, {type: 'put', key: otherKey, value: {id: MARK}}]);
  server.add(bookmark(BOOK, true)); await session.connect({id: PROFILE, login: 'test'});
  assert.equal(await storage.get(key), undefined); assert.deepEqual(await storage.get(otherKey), {id: MARK});
});

test('a safe bookmark tombstone does not require opening a corrupt cached book packet', async () => {
  const {storage, server, session} = fixture(), key = `${PROFILE}:mark:${BOOK}:${MARK}`;
  await storage.apply([{type: 'put', key: `${PROFILE}:book:${BOOK}`, value: {book: {id: BOOK}}}, {type: 'put', key, value: {id: MARK}}]);
  server.add(bookmark(BOOK, true)); await session.connect({id: PROFILE, login: 'test'});
  assert.equal(await storage.get(key), undefined);
  assert.deepEqual(await storage.get(`${PROFILE}:book:${BOOK}`), {book: {id: BOOK}});
});

test('a timestamp-optional server bookmark remains valid metadata for local projection', async () => {
  const {storage, server, session} = fixture(), entity = bookmark(); delete entity.updatedAt;
  server.add(entity); await session.connect({id: PROFILE, login: 'test'});
  const saved = await storage.get(`${PROFILE}:mark:${BOOK}:${MARK}`);
  assert.equal(saved.note, 'Серверная метка');
  assert.ok(typeof saved.created_at === 'string' && Number.isFinite(Date.parse(saved.created_at)));
});

test('a null-payload tombstone removes all stale locations of that bookmark within its own profile', async () => {
  const {storage, server, session} = fixture();
  await storage.apply([{type: 'put', key: `${PROFILE}:mark:${BOOK}:${MARK}`, value: {id: MARK}}, {type: 'put', key: `${PROFILE}:mark:${SECOND_BOOK}:${MARK}`, value: {id: MARK}}]);
  server.add(bookmark(BOOK, true, false)); await session.connect({id: PROFILE, login: 'test'});
  assert.deepEqual(await storage.keys(`${PROFILE}:mark:`), []);
});

test('a bookmark moved to another publication cannot remain duplicated at its old location', async () => {
  const {storage, server, session} = fixture(), oldKey = `${PROFILE}:mark:${BOOK}:${MARK}`, newKey = `${PROFILE}:mark:${SECOND_BOOK}:${MARK}`;
  await storage.apply([{type: 'put', key: oldKey, value: {id: MARK, note: 'Старое расположение'}}]);
  server.add(bookmark(SECOND_BOOK)); await session.connect({id: PROFILE, login: 'test'});
  assert.equal(await storage.get(oldKey), undefined); assert.equal((await storage.get(newKey)).note, 'Серверная метка');
});

test('legacy pending requests become review records atomically and unknown requests remain inert', async () => {
  const {storage, server, session} = fixture();
  const key = `${PROFILE}:pending:reading:${BOOK}`, unknown = `${PROFILE}:pending:unknown`;
  const request = {url: `/books/${BOOK}/reading`, method: 'PUT', body: {chapter: 0, position: .4, shelf: 'reading'}};
  await storage.apply([{type: 'put', key, value: request}, {type: 'put', key: unknown, value: {url: 'https://unknown.invalid', method: 'POST', body: {}}}]);
  const engine = await session.connect({id: PROFILE, login: 'test'}), state = await engine.getState();
  assert.equal(server.posts().length, 0); assert.equal(await storage.get(key), undefined);
  assert.deepEqual(state.reviews[0].legacy.original, request); assert.equal(state.reviews[0].reason, 'legacy-unverified');
  assert.ok(await storage.get(unknown));
});

test('failed legacy archiving retains the original pending operation for a later attempt', async () => {
  const {storage, session} = fixture(), key = `${PROFILE}:pending:reading:${BOOK}`;
  const request = {url: `/books/${BOOK}/reading`, method: 'PUT', body: {chapter: 0, position: .4}};
  await storage.apply([{type: 'put', key, value: request}]); const engine = await session.forProfile(PROFILE);
  storage.fail = operations => operations.some(operation => operation.type === 'remove' && operation.key === key);
  await assert.rejects(session.connect({id: PROFILE, login: 'test'}), /atomic adapter storage failure/);
  assert.deepEqual(await storage.get(key), request); assert.equal((await engine.getState()).reviews.length, 0);
});

test('inert unknown pending records cannot starve a valid later migration candidate', async () => {
  const {storage, session} = fixture();
  const unknown = Array.from({length: 100}, (_, index) => ({type: 'put', key: `${PROFILE}:pending:000-unknown-${index}`, value: {url: 'https://unknown.invalid', method: 'POST', body: {}}}));
  const validKey = `${PROFILE}:pending:reading:${BOOK}`;
  await storage.apply([...unknown, {type: 'put', key: validKey, value: {url: `/books/${BOOK}/reading`, method: 'PUT', body: {chapter: 0, position: .4}}}]);
  const engine = await session.connect({id: PROFILE, login: 'test'});
  assert.equal((await engine.getState()).reviews.length, 1);
  assert.equal(await storage.get(validKey), undefined);
  assert.equal((await storage.keys(`${PROFILE}:pending:000-unknown-`)).length, 100);
});

test('a malformed legacy proposal stays intact without blocking valid migrations and current synchronization', async () => {
  const {storage, server, session} = fixture(), badKey = `${PROFILE}:pending:000-bad`, validKey = `${PROFILE}:pending:mark:${MARK}`;
  const corrupt = {url: `/books/${BOOK}/reading`, method: 'PUT', body: {chapter: 'invalid', position: .1}};
  await storage.apply([{type: 'put', key: badKey, value: corrupt}, {type: 'put', key: validKey, value: {url: `/books/${BOOK}/bookmarks`, method: 'POST', body: {id: MARK, chapter: 0, position: .2, note: 'Валидная старая метка'}}}]);
  const engine = await session.connect({id: PROFILE, login: 'test'});
  assert.deepEqual(await storage.get(badKey), corrupt);
  assert.equal(await storage.get(validKey), undefined);
  assert.equal((await engine.getState()).reviews.length, 1);
  assert.equal(server.posts().length, 0);
});

test('a shared catalog is not projected into a local workspace without explicit adoption', async () => {
  const {storage, server, session} = fixture(), workspaceKey = `${DEVICE}:workspace`, original = {catalogs: [], tabs: []};
  await storage.apply([{type: 'put', key: workspaceKey, value: original}]);
  server.add({entityType: 'catalog', entityId: READER_CATALOG_ID, revision: 4, deleted: false, updatedAt: STAMP, payload: {catalogs: [{id: CATALOG, title: 'Серверная серия', parent: null, items: []}]}});
  await session.connect({id: PROFILE, login: 'test'});
  assert.deepEqual(await storage.get(workspaceKey), original); assert.equal(server.posts().length, 0);
});

test('manual catalog publication uses CAS and retains local structure when another edit wins', async () => {
  const {storage, server, session} = fixture(), workspaceKey = `${DEVICE}:workspace`;
  server.add({entityType: 'catalog', entityId: READER_CATALOG_ID, revision: 4, deleted: false, updatedAt: STAMP, payload: {catalogs: []}});
  const catalogs = [{id: CATALOG, title: 'Мой порядок томов', parent: null, items: []}];
  let once = true;
  server.beforeMutation = async mutation => {
    assert.equal(mutation.baseRevision, 4);
    if (once) { once = false; server.add({entityType: 'catalog', entityId: READER_CATALOG_ID, revision: 5, deleted: false, updatedAt: STAMP, payload: {catalogs: [{...catalogs[0], title: 'Правка с телефона'}]}}); }
  };
  const state = await session.saveCatalogs({id: PROFILE}, catalogs, [{type: 'put', key: workspaceKey, value: {catalogs}}]);
  assert.equal(state.reviews.length, 1); assert.equal(state.reviews[0].proposed.payload.catalogs[0].title, 'Мой порядок томов');
  assert.equal(server.entities.get('catalog:' + READER_CATALOG_ID).payload.catalogs[0].title, 'Правка с телефона');
  assert.deepEqual(await storage.get(workspaceKey), {catalogs});
});

test('a catalog revision checked by the UI is never silently rebased by a later snapshot', async () => {
 const {storage,server,session}=fixture(),catalogs=[{id:CATALOG,title:'Локальный порядок',parent:null,items:[]}];
 server.add({entityType:'catalog',entityId:READER_CATALOG_ID,revision:4,deleted:false,updatedAt:STAMP,payload:{catalogs:[]}});
 await session.connect({id:PROFILE}); // The UI has now checked revision 4.
 server.add({entityType:'catalog',entityId:READER_CATALOG_ID,revision:5,deleted:false,updatedAt:STAMP,payload:{catalogs:[{...catalogs[0],title:'Новая версия с телефона'}]}});
 const localKey=`${DEVICE}:workspace`;await storage.apply([{type:'put',key:localKey,value:{catalogs}}]);
 await assert.rejects(session.saveCatalogs({id:PROFILE},catalogs,[],4),e=>e.code==='SYNC_REVISION_REVIEW');
 assert.equal(server.posts().length,0);
 assert.equal(server.entities.get(`catalog:${READER_CATALOG_ID}`).payload.catalogs[0].title,'Новая версия с телефона');
 assert.deepEqual(await storage.get(localKey),{catalogs});
});

test('a catalog still behind a large outbox is reported as pending instead of saved on the server', async () => {
 const {server,session}=fixture(),engine=await session.connect({id:PROFILE});
 for(let n=1;n<=241;n++){
  const publicationId=`30000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
  await engine.stage({scope:'server',entityType:'reading',entityId:publicationId,operation:'upsert',payload:{publicationId,publicationRevision:1,locator:{type:'legacy',chapter:0,position:.2},shelf:'reading'}});
 }
 const state=await session.saveCatalogs({id:PROFILE},[{id:CATALOG,title:'Серия',parent:null,items:[]}],[],0);
 assert.equal(state.catalogSaved,false);
 assert.ok(state.desired.some(row=>row.entityType==='catalog'));
 assert.equal(server.entities.has(`catalog:${READER_CATALOG_ID}`),false);
 await engine.sync();
 assert.equal(server.entities.get(`catalog:${READER_CATALOG_ID}`).payload.catalogs[0].title,'Серия');
});
