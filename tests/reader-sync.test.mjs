import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createReaderSync, readerMutationIdV2, READER_CATALOG_ID, READER_INSTALLATION_KEY} from '../src/reader-sync.mjs';
import {readerMutationIdV2 as serverMutationId, normalizeReaderMutation} from '../server/reader-data-model.mjs';

const PROFILE = '10000000-0000-4000-8000-000000000001';
const OTHER = '20000000-0000-4000-8000-000000000002';
const BOOK = '30000000-0000-4000-8000-000000000003';
const MARK = '40000000-0000-4000-8000-000000000004';
const COPY = value => value === undefined ? undefined : structuredClone(value);
const copyStore = storage => [...storage.values].map(([key, value]) => [key, COPY(value)]);
const cursor = (profile, revision) => Buffer.from(JSON.stringify({schemaVersion: 1, profileId: profile, revision})).toString('base64url');
const payload = (position = .25) => ({publicationId: BOOK, publicationRevision: 1, locator: {type: 'legacy', chapter: 0, position}, shelf: 'reading'});
const stagePosition = (position, writes = []) => ({scope: 'server', entityType: 'reading', entityId: BOOK, operation: 'upsert', payload: payload(position), writes});
const catalogPayload = title => ({catalogs: [{id: OTHER, title, parent: null, items: []}]});
const stageCatalog = (title, expectedBaseRevision, writes = []) => ({scope: 'server', entityType: 'catalog', entityId: READER_CATALOG_ID, operation: 'upsert', payload: catalogPayload(title), expectedBaseRevision, writes});
function remoteCatalog(server, revision, title) { server.entities.set('catalog:' + READER_CATALOG_ID, {entityType: 'catalog', entityId: READER_CATALOG_ID, revision, deleted: false, payload: catalogPayload(title)}); server.revision++; }
const mutationError = (status, code, rest = {}) => Object.assign(new Error(code), {status, code, ...rest});
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; };

class MemoryStorage {
  values = new Map(); batches = []; failure = null;
  async get(key) { return COPY(this.values.get(key)); }
  async entries(prefix) { return [...this.values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, COPY(value)]); }
  async keys(prefix) { return [...this.values.keys()].filter(key => key.startsWith(prefix)); }
  async apply(operations) {
    const next = new Map([...this.values].map(([key, value]) => [key, COPY(value)]));
    for (let index = 0; index < operations.length; index++) {
      const operation = operations[index];
      if (this.failure?.(operations, index)) throw new Error('injected atomic storage failure');
      if (operation.type === 'put') next.set(operation.key, COPY(operation.value)); else next.delete(operation.key);
    }
    this.values = next; this.batches.push(COPY(operations));
  }
}
class ServerModel {
  profile = PROFILE; revision = 0; entities = new Map(); devices = new Map(); receipts = new Map(); calls = []; beforePost = null; afterPost = null; failure = null;
  snapshot() { return {schemaVersion: 1, cursor: cursor(this.profile, this.revision), entities: [...this.entities.values()].map(COPY), devices: [...this.devices.values()].map(COPY)}; }
  update(position) {
    const key = 'reading:' + BOOK, current = this.entities.get(key);
    const entity = {entityType: 'reading', entityId: BOOK, revision: (current?.revision ?? 0) + 1, deleted: false, payload: payload(position)};
    this.entities.set(key, entity); this.revision++; return COPY(entity);
  }
  api = async (path, options = {}) => {
    this.calls.push({path, options: COPY(options)});
    if (this.failure) await this.failure(path, options);
    if (path === '/me') return {id: this.profile, login: 'synthetic-reader'};
    if (path === '/v2/reader/snapshot') return this.snapshot();
    assert.equal(path, '/v2/reader/mutations');
    if (this.beforePost) await this.beforePost(options.body.mutations[0]);
    const incoming = options.body.mutations[0], mutation = normalizeReaderMutation(incoming);
    assert.equal(mutation.protocolVersion, 2);
    assert.equal(mutation.mutationId, serverMutationId(this.profile, mutation.deviceId, mutation.counter));
    const existing = this.receipts.get(mutation.mutationId);
    let result;
    if (existing) {
      assert.deepEqual(existing.mutation, mutation); result = COPY(existing.result);
    } else {
      const device = this.devices.get(mutation.deviceId) ?? {deviceId: mutation.deviceId, protocolVersion: 2, lastCounter: 0, compactedThrough: 0, compactedCount: 0};
      if (mutation.counter <= device.compactedThrough) throw mutationError(409, 'READER_RECEIPT_COMPACTED', {consumed: true, snapshotRequired: true, expectedCounter: device.lastCounter + 1});
      if (mutation.counter !== device.lastCounter + 1) throw mutationError(409, 'READER_COUNTER', {expectedCounter: device.lastCounter + 1});
      const key = mutation.entityType + ':' + mutation.entityId, current = this.entities.get(key) ?? null;
      if (mutation.baseRevision !== (current?.revision ?? 0)) result = {mutationId: mutation.mutationId, status: 'conflict', code: 'REVISION_CONFLICT', current: COPY(current), proposed: COPY(mutation)};
      else {
        const entity = {entityType: mutation.entityType, entityId: mutation.entityId, revision: (current?.revision ?? 0) + 1, deleted: mutation.operation === 'delete', payload: mutation.operation === 'delete' ? current?.payload ?? null : COPY(mutation.payload)};
        this.entities.set(key, entity); this.revision++;
        result = {mutationId: mutation.mutationId, status: 'accepted', entity: COPY(entity)};
      }
      device.lastCounter = mutation.counter; this.devices.set(device.deviceId, device);
      this.receipts.set(mutation.mutationId, {mutation: COPY(mutation), result: COPY(result)});
    }
    if (this.afterPost) await this.afterPost(mutation, result);
    return {schemaVersion: 1, cursor: cursor(this.profile, this.revision), results: [result]};
  };
  posts() { return this.calls.filter(call => call.path === '/v2/reader/mutations'); }
}
async function fixture(options = {}) {
  const storage = options.storage ?? new MemoryStorage(), server = options.server ?? new ServerModel();
  const config = {storage, api: server.api, crypto: webcrypto, serverIdentity: options.serverIdentity ?? 'https://synthetic-reader.invalid', profileId: options.profileId ?? PROFILE, ...(options.projectEntity ? {projectEntity: options.projectEntity} : {})};
  return {storage, server, config, engine: await createReaderSync(config)};
}

test('browser v2 mutation identities match server fixtures including safe integer edges and profile binding', async () => {
  for (const counter of [1, 2, 1_000_000, Number.MAX_SAFE_INTEGER]) {
    assert.equal(await readerMutationIdV2(webcrypto, PROFILE, OTHER, counter), serverMutationId(PROFILE, OTHER, counter));
  }
  assert.notEqual(await readerMutationIdV2(webcrypto, PROFILE, OTHER, 1), await readerMutationIdV2(webcrypto, OTHER, OTHER, 1));
});

test('a local-only book writes metadata without adding a server operation or contacting an API', async () => {
  const {storage, server, engine} = await fixture();
  await engine.stage({...stagePosition(.4), scope: 'device', writes: [{type: 'put', key: 'local-position', value: {position: .4}}]});
  assert.deepEqual(await storage.get('local-position'), {position: .4});
  assert.equal((await engine.getState()).desired.length, 0);
  assert.equal(server.calls.length, 0);
});

test('metadata and desired operation commit together, including failure after the first write', async () => {
  const {storage, engine} = await fixture();
  storage.failure = (operations, index) => operations.some(operation => operation.key === 'local-position') && index === 1;
  await assert.rejects(engine.stage(stagePosition(.4, [{type: 'put', key: 'local-position', value: {position: .4}}])), /atomic storage failure/);
  assert.equal(await storage.get('local-position'), undefined);
  assert.equal((await engine.getState()).desired.length, 0);
  storage.failure = null;
  await engine.stage(stagePosition(.4, [{type: 'put', key: 'local-position', value: {position: .4}}]));
  const batch = storage.batches.at(-1);
  assert.deepEqual(batch.map(operation => operation.key), ['local-position', engine.stateKey]);
  assert.equal(batch[1].value.desired[0].payload.locator.position, .4);
});

test('unsent reading positions coalesce before consuming any counter', async () => {
  const {engine, server} = await fixture();
  for (let index = 0; index < 50; index++) await engine.stage(stagePosition(index / 100));
  let state = await engine.getState();
  assert.equal(state.desired.length, 1); assert.equal(state.nextCounter, 1); assert.equal(state.inflight, null);
  assert.equal(state.desired[0].payload.locator.position, .49);
  await engine.sync(); state = await engine.getState();
  assert.equal(server.posts().length, 1); assert.equal(state.nextCounter, 2); assert.equal(state.desired.length, 0);
  assert.equal(server.entities.get('reading:' + BOOK).payload.locator.position, .49);
});

test('a committed server request survives a lost ACK and restart with exactly the original request', async () => {
  const {engine, server, config} = await fixture();
  let failOnce = true;
  server.afterPost = async () => { if (failOnce) { failOnce = false; throw new Error('lost ACK'); } };
  await engine.stage(stagePosition(.31));
  await assert.rejects(engine.sync(), /lost ACK/);
  const allocated = (await engine.getState()).inflight;
  assert.equal(server.entities.get('reading:' + BOOK).revision, 1);
  const restarted = await createReaderSync(config);
  await restarted.sync();
  assert.deepEqual(server.posts()[0].options.body, server.posts()[1].options.body);
  assert.equal(server.entities.get('reading:' + BOOK).revision, 1);
  assert.equal((await restarted.getState()).inflight, null);
  assert.equal(allocated.mutation.counter, 1);
});

test('replayed historical ACK cannot replace a newer snapshot position from another device', async () => {
  const storage = new MemoryStorage(), server = new ServerModel(), localKey = PROFILE + ':position:' + BOOK;
  const {engine, config} = await fixture({storage, server, projectEntity: entity => [{type: 'put', key: localKey, value: entity.payload.locator.position}]});
  let once = true; server.afterPost = async () => { if (once) { once = false; throw new Error('lost ACK'); } };
  await engine.stage(stagePosition(.3)); await assert.rejects(engine.sync(), /lost ACK/);
  server.update(.9);
  const restarted = await createReaderSync(config); await restarted.sync();
  assert.equal(await storage.get(localKey), .9);
  assert.equal((await restarted.getState()).remote['reading:' + BOOK].revision, 2);
  assert.equal(server.entities.get('reading:' + BOOK).revision, 2);
});

test('replayed historical bookmark ACK cannot resurrect a newer server tombstone', async () => {
  const storage = new MemoryStorage(), server = new ServerModel(), localKey = PROFILE + ':mark:' + MARK;
  const {engine, config} = await fixture({storage, server, projectEntity: entity => entity.deleted ? [{type: 'remove', key: localKey}] : [{type: 'put', key: localKey, value: entity.payload.note}]});
  let once = true; server.afterPost = async () => { if (once) { once = false; throw new Error('lost ACK'); } };
  await engine.stage({scope: 'server', entityType: 'bookmark', entityId: MARK, operation: 'upsert', payload: {publicationId: BOOK, publicationRevision: 1, locator: {type: 'legacy', chapter: 0, position: .2}, note: 'Метка'}, writes: [{type: 'put', key: localKey, value: 'Метка'}]});
  await assert.rejects(engine.sync(), /lost ACK/);
  server.entities.set('bookmark:' + MARK, {...server.entities.get('bookmark:' + MARK), revision: 2, deleted: true}); server.revision++;
  const restarted = await createReaderSync(config); await restarted.sync();
  assert.equal(await storage.get(localKey), undefined);
  assert.equal((await restarted.getState()).remote['bookmark:' + MARK].deleted, true);
});

test('failure to commit allocation sends nothing and consumes no counter', async () => {
  const {storage, server, engine} = await fixture();
  await engine.stage(stagePosition(.1));
  let once = true;
  storage.failure = operations => {
    if (once && operations.some(operation => operation.key === engine.stateKey && operation.value?.inflight)) { once = false; return true; }
    return false;
  };
  await assert.rejects(engine.sync(), /atomic storage failure/);
  assert.equal(server.posts().length, 0);
  assert.equal((await engine.getState()).nextCounter, 1);
  storage.failure = null; await engine.sync();
  assert.equal(server.posts()[0].options.body.mutations[0].counter, 1);
});

test('failure to commit a received ACK keeps the immutable outbox for restart', async () => {
  const {storage, server, engine, config} = await fixture();
  await engine.stage(stagePosition(.3));
  let once = true;
  storage.failure = operations => {
    if (once && server.posts().length && operations.some(operation => operation.key === engine.stateKey && operation.value?.inflight === null)) { once = false; return true; }
    return false;
  };
  await assert.rejects(engine.sync(), /atomic storage failure/);
  assert.ok((await engine.getState()).inflight);
  storage.failure = null;
  await (await createReaderSync(config)).sync();
  assert.deepEqual(server.posts()[0].options.body, server.posts()[1].options.body);
  assert.equal(server.entities.get('reading:' + BOOK).revision, 1);
});

test('staging during a delayed network request stays immediate; old ACK cannot overwrite the newer local position', async () => {
  const storage = new MemoryStorage(), server = new ServerModel(), entered = deferred(), release = deferred();
  const localKey = PROFILE + ':position:' + BOOK;
  const projectEntity = async entity => [{type: 'put', key: localKey, value: {position: entity.payload.locator.position}}];
  const {engine} = await fixture({storage, server, projectEntity});
  server.beforePost = async mutation => {
    if (mutation.counter === 1) { entered.resolve(); await release.promise; }
    else assert.deepEqual(await storage.get(localKey), {position: .8}, 'previous ACK replaced a newer position');
  };
  await engine.stage(stagePosition(.2, [{type: 'put', key: localKey, value: {position: .2}}]));
  const active = engine.sync(); await entered.promise;
  await engine.stage(stagePosition(.8, [{type: 'put', key: localKey, value: {position: .8}}]));
  assert.deepEqual(await storage.get(localKey), {position: .8});
  const before = await engine.getState();
  assert.equal(before.inflight.mutation.payload.locator.position, .2);
  assert.equal(before.desired[0].payload.locator.position, .8);
  release.resolve(); await active;
  assert.deepEqual(server.posts().map(call => call.options.body.mutations[0].counter), [1, 2]);
  assert.equal(server.entities.get('reading:' + BOOK).payload.locator.position, .8);
});

test('a CAS conflict keeps the original proposal and requires an explicit local resolution', async () => {
  const {engine, server} = await fixture();
  server.update(.1); await engine.sync(); await engine.stage(stagePosition(.2));
  let race = true;
  server.beforePost = async () => { if (race) { race = false; server.update(.7); } };
  await engine.sync();
  let state = await engine.getState();
  assert.equal(state.reviews.length, 1); assert.equal(state.reviews[0].reason, 'revision-conflict');
  assert.equal(state.reviews[0].proposed.payload.locator.position, .2);
  assert.equal(server.entities.get('reading:' + BOOK).payload.locator.position, .7);
  assert.equal(state.nextCounter, 2); assert.equal(state.inflight, null);
  await engine.sync(); assert.equal(server.posts().length, 1, 'review was resent automatically');
  await engine.resolve(state.reviews[0].id, 'local'); await engine.sync();
  state = await engine.getState();
  assert.equal(state.reviews.length, 0); assert.equal(server.entities.get('reading:' + BOOK).revision, 3);
  assert.equal(server.entities.get('reading:' + BOOK).payload.locator.position, .2);
});

test('a conflict retains both the immutable sent proposal and newer local edits made during the request', async () => {
  const {engine, server} = await fixture(), entered = deferred(), release = deferred();
  server.update(.1); await engine.sync();
  let once = true;
  server.beforePost = async () => { if (once) { once = false; entered.resolve(); await release.promise; server.update(.7); } };
  await engine.stage(stagePosition(.2)); const active = engine.sync(); await entered.promise;
  await engine.stage(stagePosition(.8)); release.resolve(); await active;
  const state = await engine.getState(), review = state.reviews[0];
  assert.equal(review.proposed.payload.locator.position, .2);
  assert.equal(review.latestLocal.payload.locator.position, .8);
  assert.equal(state.desired.length, 0); assert.equal(server.posts().length, 1);
  await engine.stage(stagePosition(.9));
  assert.equal((await engine.getState()).reviews[0].latestLocal.payload.locator.position, .9);
  await engine.resolve(review.id, 'local'); await engine.sync();
  assert.equal(server.entities.get('reading:' + BOOK).payload.locator.position, .9);
});

test('choosing remote projects it atomically and archives the local proposal', async () => {
  const storage = new MemoryStorage(), server = new ServerModel(), localKey = PROFILE + ':position:' + BOOK;
  const {engine} = await fixture({storage, server, projectEntity: entity => [{type: 'put', key: localKey, value: entity.payload.locator.position}]});
  server.update(.1); await engine.sync(); await engine.stage(stagePosition(.2, [{type: 'put', key: localKey, value: .2}]));
  server.update(.7); await engine.sync();
  const review = (await engine.getState()).reviews[0];
  assert.equal(review.reason, 'remote-changed');
  await engine.resolve(review.id, 'remote');
  assert.equal(await storage.get(localKey), .7);
  assert.equal((await engine.getState()).reviews.length, 0);
  const archives = await storage.entries('00000000-0000-4000-8000-000000000001:review:');
  assert.equal(archives.length, 1); assert.equal(archives[0][1].review.proposed.payload.locator.position, .2);
  assert.equal(storage.batches.at(-1).at(-1).key, engine.stateKey);
});

test('offline edits without a known remote base are reviewed instead of overwriting an existing position', async () => {
  const {engine, server} = await fixture(); server.update(.9);
  await engine.stage(stagePosition(.1)); await engine.sync();
  assert.equal(server.posts().length, 0);
  const review = (await engine.getState()).reviews[0];
  assert.equal(review.reason, 'unbased-local-intent'); assert.equal(review.proposed.payload.locator.position, .1);
});

for (const status of [401, 403, 423, 429]) test(`${status} never deletes the allocated operation; an explicit retry uses identical bytes`, async () => {
  const {engine, server} = await fixture();
  server.failure = path => { if (path === '/v2/reader/mutations') throw mutationError(status, 'SYNTHETIC_REJECT'); };
  await engine.stage(stagePosition(.2));
  await assert.rejects(engine.sync(), error => error.status === status);
  const state = await engine.getState(); assert.ok(state.inflight); assert.equal(state.blocked.status, status);
  server.failure = null; await engine.sync();
  assert.deepEqual(server.posts()[0].options.body, server.posts()[1].options.body);
});

test('compacted consumed responses fetch a snapshot and retain review without reissuing a fresh intent', async () => {
  const {engine, server} = await fixture();
  let once = true; server.afterPost = async () => { if (once) { once = false; throw new Error('lost ACK'); } };
  await engine.stage(stagePosition(.3)); await assert.rejects(engine.sync(), /lost ACK/);
  const flight = (await engine.getState()).inflight;
  server.receipts.delete(flight.mutation.mutationId);
  const device = server.devices.get(flight.mutation.deviceId); device.compactedThrough = 1; device.compactedCount = 1;
  await engine.sync();
  const state = await engine.getState();
  assert.equal(state.inflight, null); assert.equal(state.nextCounter, 2);
  assert.equal(state.reviews[0].reason, 'receipt-compacted');
  assert.equal(state.reviews[0].proposed.mutationId, flight.mutation.mutationId);
  await assert.rejects(engine.resolve(state.reviews[0].id, 'local'), error => error.code === 'SYNC_MANUAL_EDIT_REQUIRED');
  await engine.sync(); assert.equal(server.posts().length, 2); assert.equal(server.entities.get('reading:' + BOOK).revision, 1);
});

test('a compacted receipt accepts a different manually edited proposal only after explicit edited resolution', async () => {
  const {engine, server, storage} = await fixture();
  let once = true; server.afterPost = async () => { if (once) { once = false; throw new Error('lost ACK'); } };
  await engine.stage(stagePosition(.3)); await assert.rejects(engine.sync(), /lost ACK/);
  const flight = (await engine.getState()).inflight;
  server.receipts.delete(flight.mutation.mutationId);
  const device = server.devices.get(flight.mutation.deviceId); device.compactedThrough = 1; device.compactedCount = 1;
  await engine.sync(); const review = (await engine.getState()).reviews[0];
  await assert.rejects(engine.resolve(review.id, 'edited'), error => error.code === 'SYNC_REVIEW');
  await engine.stage(stagePosition(.85));
  await engine.sync(); assert.equal(server.posts().length, 2, 'a new manual edit was sent without confirmation');
  await assert.rejects(engine.resolve(review.id, 'local'), error => error.code === 'SYNC_MANUAL_EDIT_REQUIRED');
  await engine.resolve(review.id, 'edited');
  const confirmed = await engine.getState();
  assert.equal(confirmed.reviews.length, 0); assert.equal(confirmed.desired[0].baseRevision, 1);
  assert.equal(confirmed.desired[0].payload.locator.position, .85);
  const archive = (await storage.entries('00000000-0000-4000-8000-000000000001:review:'))[0][1];
  assert.equal(archive.choice, 'edited'); assert.equal(archive.review.proposed.payload.locator.position, .3);
  assert.equal(archive.review.latestLocal.payload.locator.position, .85);
  await engine.sync();
  assert.equal(server.entities.get('reading:' + BOOK).payload.locator.position, .85);
  assert.deepEqual(server.posts().map(call => call.options.body.mutations[0].counter), [1, 1, 2]);
});

test('edited resolution is unavailable for ordinary conflicts even when another local edit exists', async () => {
  const {engine, server, storage} = await fixture();
  server.update(.1); await engine.stage(stagePosition(.2)); await engine.sync();
  const review = (await engine.getState()).reviews[0]; await engine.stage(stagePosition(.4));
  const before = copyStore(storage);
  await assert.rejects(engine.resolve(review.id, 'edited'), error => error.code === 'SYNC_REVIEW');
  assert.deepEqual(copyStore(storage), before);
});

for (const code of ['READER_COUNTER', 'READER_IDEMPOTENCY', 'READER_PROTOCOL']) test(`${code} pauses the stream for explicit review instead of retrying a changed request`, async () => {
  const {engine, server} = await fixture();
  server.failure = path => { if (path === '/v2/reader/mutations') throw mutationError(409, code, {expectedCounter: 1}); };
  await engine.stage(stagePosition(.2));
  await assert.rejects(engine.sync(), error => error.code === 'SYNC_COUNTER_REVIEW');
  const state = await engine.getState();
  assert.ok(state.inflight); assert.equal(state.blocked.code, 'SYNC_COUNTER_REVIEW'); assert.equal(state.reviews.length, 1);
  assert.equal(state.reviews[0].expectedCounter, 1);
  server.failure = null; await engine.sync();
  assert.equal(server.posts().length, 1, 'unsafe stream retried without review');
  await engine.restartStream({acknowledged: true});
  assert.notEqual((await engine.getState()).deviceId, state.deviceId);
});

test('server counter rollback pauses instead of resetting or silently reissuing old operations', async () => {
  const {engine, server} = await fixture(); await engine.stage(stagePosition(.1)); await engine.sync();
  const previous = await engine.getState();
  server.devices.get(previous.deviceId).lastCounter = 0;
  await engine.stage(stagePosition(.2));
  await assert.rejects(engine.sync(), error => error.code === 'SYNC_COUNTER_REVIEW');
  const paused = await engine.getState();
  assert.equal(paused.nextCounter, 2); assert.equal(paused.desired[0].payload.locator.position, .2);
  assert.equal(paused.reviews[0].reason, 'server-counter-rollback'); assert.equal(server.posts().length, 1);
  await assert.rejects(engine.restartStream(), error => error.code === 'SYNC_COUNTER_REVIEW');
  await engine.restartStream({acknowledged: true});
  const reset = await engine.getState(); assert.notEqual(reset.deviceId, previous.deviceId); assert.equal(reset.nextCounter, 1);
  assert.equal(reset.desired.length, 0); assert.ok(reset.reviews.some(review => review.reason === 'previous-stream'));
});

test('switching the session profile cannot flush another profile queue', async () => {
  const {engine, server} = await fixture(); await engine.stage(stagePosition(.3)); server.profile = OTHER;
  await assert.rejects(engine.sync(), error => error.code === 'SYNC_AUTHORITY');
  assert.equal(server.posts().length, 0); assert.equal((await engine.getState()).desired.length, 1);
});

test('a foreign profile snapshot cursor is rejected before any remote metadata projection', async () => {
  const storage = new MemoryStorage(), server = new ServerModel();
  server.snapshot = () => ({schemaVersion: 1, cursor: cursor(OTHER, 0), entities: [server.update(.2)], devices: []});
  const {engine} = await fixture({storage, server, projectEntity: () => [{type: 'put', key: 'leaked', value: true}]});
  await engine.stage(stagePosition(.3));
  await assert.rejects(engine.sync(), error => error.code === 'SYNC_AUTHORITY');
  assert.equal(await storage.get('leaked'), undefined); assert.equal(server.posts().length, 0);
});

test('server and profile scopes have separate queues and stream IDs with a separate v2 installation identity', async () => {
  const storage = new MemoryStorage();
  const a = await fixture({storage}), b = await fixture({storage, profileId: OTHER}), c = await fixture({storage, serverIdentity: 'https://other-reader.invalid'});
  await a.engine.stage(stagePosition(.2));
  assert.equal((await b.engine.getState()).desired.length, 0); assert.equal((await c.engine.getState()).desired.length, 0);
  assert.equal(new Set([a.engine.stateKey, b.engine.stateKey, c.engine.stateKey]).size, 3);
  assert.equal(new Set([(await a.engine.getState()).deviceId, (await b.engine.getState()).deviceId, (await c.engine.getState()).deviceId]).size, 3);
  assert.ok(a.engine.stateKey.length <= 180);
  assert.equal((await storage.get(READER_INSTALLATION_KEY)).protocolVersion, 2);
});

test('concurrent sync calls share one network loop and preserve positions staged during it', async () => {
  const {engine, server, config} = await fixture(), entered = deferred(), release = deferred();
  server.beforePost = async mutation => { if (mutation.counter === 1) { entered.resolve(); await release.promise; } };
  await engine.stage(stagePosition(.1));
  const first = engine.sync(); await entered.promise;
  const secondInstance = await createReaderSync(config), second = secondInstance.sync();
  assert.equal(first, second);
  await secondInstance.stage(stagePosition(.5));
  release.resolve(); await Promise.all([first, second]);
  assert.equal(server.posts().length, 2); assert.equal(server.devices.size, 1);
});

test('separate browser contexts coordinate network loops while the storage lock remains available for staging', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator'), pending = new Map();
  const locks = {request(name, operation) {
    const next = (pending.get(name) ?? Promise.resolve()).catch(() => {}).then(operation);
    pending.set(name, next); return next;
  }};
  Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {locks}});
  const entered = deferred(), release = deferred(); let first, second;
  try {
    const a = await import('../src/reader-sync.mjs?synthetic-browser-a'), b = await import('../src/reader-sync.mjs?synthetic-browser-b');
    const storage = new MemoryStorage(), server = new ServerModel();
    const config = {storage, api: server.api, crypto: webcrypto, serverIdentity: 'https://synthetic-browser-context.invalid', profileId: PROFILE};
    const left = await a.createReaderSync(config), right = await b.createReaderSync(config);
    server.beforePost = async mutation => { if (mutation.counter === 1) { entered.resolve(); await release.promise; } };
    await left.stage(stagePosition(.1)); first = left.sync(); await entered.promise;
    second = right.sync();
    await right.stage(stagePosition(.6));
    release.resolve(); await Promise.all([first, second]);
    assert.equal(server.posts().length, 2);
    assert.equal(server.entities.get('reading:' + BOOK).payload.locator.position, .6);
    assert.deepEqual((await right.getState()).desired, []);
  } finally {
    release.resolve(); await Promise.allSettled([first, second].filter(Boolean));
    if (original) Object.defineProperty(globalThis, 'navigator', original); else delete globalThis.navigator;
  }
});

test('legacy pending records are archived for review and removed in the same transaction, never sent blindly', async () => {
  const {storage, engine, server} = await fixture();
  const legacyKey = PROFILE + ':pending:reading:' + BOOK;
  const legacy = {url: '/books/' + BOOK + '/reading', method: 'PUT', body: {chapter: 0, position: .4}};
  await storage.apply([{type: 'put', key: legacyKey, value: legacy}]);
  const proposal = {entityType: 'reading', entityId: BOOK, operation: 'upsert', payload: payload(.4)};
  let once = true;
  storage.failure = operations => { if (once && operations.some(operation => operation.type === 'remove' && operation.key === legacyKey)) { once = false; return true; } return false; };
  await assert.rejects(engine.stageLegacy([{legacyKey, proposal}]), /atomic storage failure/);
  assert.deepEqual(await storage.get(legacyKey), legacy); assert.equal((await engine.getState()).reviews.length, 0);
  storage.failure = null; await engine.stageLegacy([{legacyKey, proposal}]);
  assert.equal(await storage.get(legacyKey), undefined);
  const state = await engine.getState(); assert.deepEqual(state.reviews[0].legacy.original, legacy);
  assert.equal(state.reviews[0].reason, 'legacy-unverified');
  await engine.sync(); assert.equal(server.posts().length, 0);
  await assert.rejects(engine.stageLegacy([{legacyKey: OTHER + ':pending:x', proposal}]), error => error.code === 'SYNC_LEGACY');
});

test('choosing a missing remote entity removes the local proposal using a local absence projection', async () => {
  const storage = new MemoryStorage(), localKey = PROFILE + ':mark:' + MARK;
  const {engine} = await fixture({storage, projectEntity: entity => entity.deleted ? [{type: 'remove', key: localKey}] : []});
  const legacyKey = PROFILE + ':pending:mark:' + MARK;
  await storage.apply([{type: 'put', key: localKey, value: {id: MARK}}, {type: 'put', key: legacyKey, value: {note: 'Старая метка'}}]);
  await engine.stageLegacy([{legacyKey, proposal: {entityType: 'bookmark', entityId: MARK, operation: 'upsert', payload: {publicationId: BOOK, publicationRevision: 1, locator: {type: 'legacy', chapter: 0, position: .1}, note: 'Старая метка'}}}]);
  await engine.sync(); await engine.resolve((await engine.getState()).reviews[0].id, 'remote');
  assert.equal(await storage.get(localKey), undefined);
});

test('bookmark deletion and catalog structure use distinct typed entities; downloaded file data is never uploaded', async () => {
  const {engine, server} = await fixture(); await engine.sync();
  await engine.stage({scope: 'server', entityType: 'bookmark', entityId: MARK, operation: 'upsert', payload: {publicationId: BOOK, publicationRevision: 1, locator: {type: 'legacy', chapter: 0, position: .2}, note: 'Приватная заметка'}});
  await engine.sync();
  await engine.stage({scope: 'server', entityType: 'bookmark', entityId: MARK, operation: 'delete'});
  await engine.stage({scope: 'server', entityType: 'catalog', entityId: READER_CATALOG_ID, operation: 'upsert', payload: {catalogs: []}});
  await engine.sync();
  assert.equal(server.entities.get('bookmark:' + MARK).deleted, true);
  assert.equal(server.entities.get('catalog:' + READER_CATALOG_ID).revision, 1);
  assert.ok(server.posts().every(call => !JSON.stringify(call.options).includes('book.json')));
});

test('corrupted persisted counter identities fail closed before transmission and preserve the stored data', async () => {
  const {engine, server, storage, config} = await fixture();
  server.failure = path => { if (path === '/v2/reader/mutations') throw new Error('offline'); };
  await engine.stage(stagePosition(.2)); await assert.rejects(engine.sync(), /offline/);
  const broken = await storage.get(engine.stateKey); broken.inflight.mutation.mutationId = MARK;
  await storage.apply([{type: 'put', key: engine.stateKey, value: broken}]); server.failure = null;
  const restarted = await createReaderSync(config);
  await assert.rejects(restarted.sync(), error => error.code === 'SYNC_STATE');
  assert.equal(server.posts().length, 1);
  assert.equal((await storage.get(engine.stateKey)).inflight.mutation.mutationId, MARK);
});

test('a maximum server snapshot and 10000 metadata projections commit in one bounded transaction', async () => {
  const storage = new MemoryStorage(), server = new ServerModel();
  for (let index = 0; index < 10000; index++) {
    const id = '40000000-0000-4000-8000-' + index.toString(16).padStart(12, '0');
    server.entities.set('bookmark:' + id, {entityType: 'bookmark', entityId: id, revision: 1, deleted: true, payload: null});
  }
  server.revision = 10000;
  const {engine} = await fixture({storage, server, projectEntity: entity => [{type: 'put', key: 'projection:' + entity.entityId, value: entity.deleted}]});
  await engine.sync();
  assert.equal(storage.batches.find(batch => batch.length === 10001)?.at(-1).key, engine.stateKey);
  assert.equal(Object.keys((await engine.getState()).remote).length, 10000);
});

test('an oversized projection batch fails before writing metadata or advancing the cached snapshot', async () => {
  const storage = new MemoryStorage(), server = new ServerModel();
  for (let index = 0; index < 6100; index++) {
    const id = '40000000-0000-4000-8000-' + index.toString(16).padStart(12, '0');
    server.entities.set('bookmark:' + id, {entityType: 'bookmark', entityId: id, revision: 1, deleted: true, payload: null});
  }
  server.revision = 6100;
  const {engine} = await fixture({storage, server, projectEntity: entity => [{type: 'put', key: 'projection-a:' + entity.entityId, value: true}, {type: 'put', key: 'projection-b:' + entity.entityId, value: true}]});
  await engine.stage(stagePosition(.4));
  await assert.rejects(engine.sync(), error => error.code === 'SYNC_CAPACITY');
  assert.equal((await storage.keys('projection-')).length, 0);
  const state = await engine.getState(); assert.equal(state.cursor, null); assert.equal(Object.keys(state.remote).length, 0);
  assert.equal(state.desired[0].payload.locator.position, .4);
});

test('a fresh background snapshot cannot silently rebase a catalog still displayed at an earlier revision', async () => {
  const {engine, server, storage} = await fixture();
  remoteCatalog(server, 4, 'Версия, открытая в окне'); await engine.sync();
  remoteCatalog(server, 5, 'Правка с другого устройства'); await engine.sync();
  await storage.apply([{type: 'put', key: 'local-workspace', value: 'unchanged'}]);
  const before = copyStore(storage), batchCount = storage.batches.length;
  await assert.rejects(engine.stage(stageCatalog('Устаревшая локальная правка', 4, [{type: 'put', key: 'local-workspace', value: 'must not write'}])), error => error.code === 'SYNC_REVISION_REVIEW' && error.status === 409);
  assert.deepEqual(copyStore(storage), before); assert.equal(storage.batches.length, batchCount);
  assert.equal(server.posts().length, 0);
});

test('a staged catalog keeps its explicit revision when another snapshot arrives before allocation', async () => {
  const {engine, server} = await fixture(); remoteCatalog(server, 4, 'Исходная серия'); await engine.sync();
  await engine.stage(stageCatalog('Локальный порядок', 4));
  remoteCatalog(server, 5, 'Новый серверный порядок'); await engine.sync();
  const state = await engine.getState();
  assert.equal(server.posts().length, 0); assert.equal(state.reviews[0].proposed.baseRevision, 4);
  assert.equal(state.reviews[0].proposed.expectedBaseRevision, 4); assert.equal(state.reviews[0].current.revision, 5);
});

test('a catalog race after allocation reaches the server with the original explicit CAS base', async () => {
  const {engine, server} = await fixture(); remoteCatalog(server, 4, 'Исходная серия'); await engine.sync();
  await engine.stage(stageCatalog('Мой порядок', 4));
  server.beforePost = async mutation => { assert.equal(mutation.baseRevision, 4); remoteCatalog(server, 5, 'Чужой порядок'); };
  await engine.sync();
  const review = (await engine.getState()).reviews[0];
  assert.equal(review.reason, 'revision-conflict'); assert.equal(review.proposed.baseRevision, 4);
  assert.equal(server.entities.get('catalog:' + READER_CATALOG_ID).payload.catalogs[0].title, 'Чужой порядок');
});

test('an explicit catalog revision survives pending coalescing and the ACK of an earlier in-flight edit', async () => {
  const {engine, server} = await fixture(), entered = deferred(), release = deferred();
  remoteCatalog(server, 4, 'Исходный порядок'); await engine.sync();
  server.beforePost = async mutation => { if (mutation.counter === 1) { entered.resolve(); await release.promise; } };
  await engine.stage(stageCatalog('Первая правка', 4)); const active = engine.sync(); await entered.promise;
  await engine.stage(stageCatalog('Вторая правка ещё из версии 4', 4));
  const afterStaging = await engine.getState();
  assert.equal(afterStaging.desired[0].baseRevision, 4); assert.equal(afterStaging.desired[0].expectedBaseRevision, 4);
  // A later coalesced UI edit without a new explicit base must not erase the pin.
  const coalesced = stageCatalog('Последняя локальная правка', 4); delete coalesced.expectedBaseRevision;
  await engine.stage(coalesced);
  release.resolve(); await active;
  const state = await engine.getState();
  assert.equal(server.posts().length, 1, 'a prior ACK silently rebased another explicit edit');
  assert.equal(state.reviews[0].proposed.baseRevision, 4); assert.equal(state.reviews[0].current.revision, 5);
  assert.equal(state.reviews[0].proposed.payload.catalogs[0].title, 'Последняя локальная правка');
});

test('explicit catalog staging fixes the latest proposal revision even when a review already exists', async () => {
  const {engine, server, storage} = await fixture(); remoteCatalog(server, 4, 'Исходный порядок'); await engine.sync();
  await engine.stage(stageCatalog('Старая локальная правка', 4)); remoteCatalog(server, 5, 'Чужая правка'); await engine.sync();
  await engine.stage(stageCatalog('Новая локальная правка из версии 5', 5));
  let state = await engine.getState();
  assert.equal(state.reviews[0].latestLocal.baseRevision, 5); assert.equal(state.reviews[0].latestLocal.expectedBaseRevision, 5);
  const before = copyStore(storage);
  await assert.rejects(engine.stage(stageCatalog('Снова устаревшая правка', 4)), error => error.code === 'SYNC_REVISION_REVIEW');
  assert.deepEqual(copyStore(storage), before);
  state = await engine.getState(); assert.equal(state.reviews[0].latestLocal.payload.catalogs[0].title, 'Новая локальная правка из версии 5');
});

test('invalid explicit revisions fail before any local metadata or outbox write', async () => {
  const {engine, storage} = await fixture();
  for (const invalid of [-1, 1.5, null, true, Number.NaN, Number.MAX_SAFE_INTEGER]) {
    const before = copyStore(storage);
    await assert.rejects(engine.stage(stageCatalog('Проверка', invalid, [{type: 'put', key: 'must-not-exist', value: true}])), error => error.code === 'SYNC_DATA');
    assert.deepEqual(copyStore(storage), before);
  }
});
