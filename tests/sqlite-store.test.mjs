import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import native from '../desktop/sqlite-store.cjs';

const { SqliteStore } = native;
const OWNER = '10000000-0000-4000-8000-000000000001';
const BOOK = '20000000-0000-4000-8000-000000000002';
const BOOK_KEY = `${OWNER}:book:${BOOK}`;
const key = suffix => `${OWNER}:${suffix}`;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const packet = text => ({ book: { id: BOOK, title: text }, content: { chapters: [{ title: 'Глава', blocks: [{ type: 'text', text }] }] } });
async function fixture(action) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gargantua-sqlite-test-'));
  const stores = [];
  const open = (options = {}) => { const store = new SqliteStore(path.join(root, 'library'), options); stores.push(store); return store; };
  try { return await action({ root, library: path.join(root, 'library'), open }); }
  finally {
    for (const store of stores.reverse()) await store.close().catch(() => {});
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.match(path.basename(root), /^gargantua-sqlite-test-/);
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('new native SQLite authority uses WAL/FULL and a verified complete marker', () => fixture(async ({ open }) => {
  const store = open(); await store.init();
  assert.deepEqual(await store.keys(''), []);
  const database = new DatabaseSync(store.databasePath, { readOnly: true });
  try {
    assert.equal(database.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.equal(database.prepare('PRAGMA application_id').get().application_id, 0x47504c32);
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(store.db.prepare('PRAGMA synchronous').get().synchronous, 2);
    assert.equal(store.db.prepare('PRAGMA trusted_schema').get().trusted_schema, 0);
    const marker = JSON.parse((await fs.readFile(path.join(store.storageRoot, 'migration.json'))).toString('utf8'));
    assert.equal(marker.entries, 0); assert.equal(marker.status, 'complete'); assert.equal(marker.sourceFiles.length, 0);
  } finally { database.close(); }
}));

test('JSON metadata and literal prefixes survive a full close and reopen', () => fixture(async ({ open }) => {
  let store = open();
  await store.put(key('sync:profile'), { title: 'Книга', quote: "'); DROP TABLE kv;--", falseValue: false, array: [1, null, 'я'] });
  await store.put('lastProfile', { id: OWNER, login: 'fixture' });
  await store.close(); store = open();
  assert.equal((await store.get(key('sync:profile'))).title, 'Книга');
  assert.deepEqual(await store.keys('%'), []);
  assert.deepEqual(await store.entries('last'), [['lastProfile', { id: OWNER, login: 'fixture' }]]);
  assert.equal(await store.get(key('absent')), null);
}));

test('book bytes stay in an immutable hash-addressed file outside SQLite', () => fixture(async ({ open }) => {
  let store = open(); const value = packet('Настоящий локальный текст'); await store.put(BOOK_KEY, value);
  const row = store.db.prepare('SELECT * FROM kv WHERE key=?').get(BOOK_KEY);
  assert.equal(row.kind, 'book'); assert.equal(row.value_json, null);
  const file = path.join(store.objectsRoot, row.object_sha + '.json'), bytes = await fs.readFile(file);
  assert.equal(digest(bytes), row.object_sha); assert.equal(row.bytes, bytes.length);
  assert.deepEqual(JSON.parse(bytes.toString()).value, value);
  await store.close(); store = open(); assert.deepEqual(await store.get(BOOK_KEY), value);
}));

test('position and durable outbox commit in the same transaction', () => fixture(async ({ open }) => {
  const store = open(); await store.put(key('obsolete'), { old: true });
  await store.apply([
    { type: 'put', key: key('position:' + BOOK), value: { chapter: 3, position: 0.4 } },
    { type: 'put', key: key('sync:stream'), value: { mutationId: BOOK, counter: 1 } },
    { type: 'remove', key: key('obsolete') }
  ]);
  assert.equal((await store.get(key('position:' + BOOK))).chapter, 3);
  assert.equal((await store.get(key('sync:stream'))).counter, 1);
  assert.equal(await store.get(key('obsolete')), null);
}));

test('one complete 10000-entity reader snapshot plus its cursor can commit atomically', () => fixture(async ({ open }) => {
  const store = open();
  await store.apply([...Array.from({ length: 10000 }, (_, i) => ({ type: 'put', key: key('projection:' + i), value: { revision: 1, deleted: false } })), { type: 'put', key: key('sync:cursor'), value: { cursor: 'fixture-cursor' } }]);
  assert.equal((await store.keys(key('projection:'))).length, 10000);
  assert.deepEqual(await store.get(key('sync:cursor')), { cursor: 'fixture-cursor' });
}));

test('SQLite constraints refuse a book reference with no immutable object identity', () => fixture(async ({ open }) => {
  const store = open(); await store.init();
  assert.throws(() => store.db.prepare("INSERT INTO kv VALUES(?,'book',NULL,NULL,1)").run(BOOK_KEY), /constraint/i);
  assert.equal(await store.get(BOOK_KEY), null);
}));

test('a failure before COMMIT rolls back all metadata and book references', () => fixture(async ({ open }) => {
  const initial = open(); await initial.put(BOOK_KEY, packet('Прежний текст')); await initial.put(key('position'), { chapter: 1 }); await initial.close();
  const failing = open({ fault: phase => { if (phase === 'apply-before-commit') throw Error('fixture failure'); } });
  await assert.rejects(() => failing.apply([
    { type: 'put', key: BOOK_KEY, value: packet('Непринятый текст') },
    { type: 'put', key: key('position'), value: { chapter: 9 } },
    { type: 'put', key: key('sync:pending'), value: { counter: 1 } }
  ]), /fixture failure/);
  assert.equal((await failing.get(BOOK_KEY)).book.title, 'Прежний текст');
  assert.equal((await failing.get(key('position'))).chapter, 1); assert.equal(await failing.get(key('sync:pending')), null);
  await failing.close(); const recovered = open(); await recovered.init();
  assert.equal((await fs.readdir(recovered.objectsRoot)).length, 1);
}));

test('flush reports a failed local write until the same data is saved successfully', () => fixture(async ({ open }) => {
  let fail = true;
  const store = open({ fault: phase => { if (phase === 'apply-before-commit' && fail) throw Error('Fixture disk failure'); } });
  await assert.rejects(() => store.put(key('unsaved'), { position: 0.5 }), /Fixture disk failure/);
  await assert.rejects(() => store.flush(), /не сохранены/);
  fail = false; await store.put(key('unsaved'), { position: 0.5 }); await store.flush();
  assert.deepEqual(await store.get(key('unsaved')), { position: 0.5 });
}));

test('validation rejects an entire batch before changing any record', () => fixture(async ({ open }) => {
  const store = open(); await store.put(key('keep'), 1);
  for (const invalid of [
    [{ type: 'put', key: key('keep'), value: 2 }, { type: 'put', key: '../../escape', value: 3 }],
    [{ type: 'put', key: key('keep'), value: 2 }, { type: 'remove', key: key('keep') }],
    [{ type: 'remove', key: key('keep'), value: null }],
    [{ type: 'put', key: key('keep'), value: undefined }],
    [{ type: 'put', key: BOOK_KEY + ':other', value: 4 }],
    [{ type: 'put', key: key('keep'), value: 2, arbitrary: true }]
  ]) await assert.rejects(() => store.apply(invalid));
  assert.equal(await store.get(key('keep')), 1);
}));

test('record and batch bounds reject oversized work without a partial save', () => fixture(async ({ open }) => {
  const store = open();
  await assert.rejects(() => store.put(key('large'), 'x'.repeat(32 * 1024 * 1024)), /32 МБ/);
  await assert.rejects(() => store.apply(Array.from({ length: 12001 }, (_, i) => ({ type: 'put', key: key('n:' + i), value: i }))));
  await assert.rejects(() => store.apply(Array.from({ length: 3 }, (_, i) => ({ type: 'put', key: key('large:' + i), value: 'x'.repeat(23 * 1024 * 1024) }))), /64 МБ/);
  assert.deepEqual(await store.keys(''), []);
}));

test('an update at 30000 records remains possible, a new record is rejected atomically', () => fixture(async ({ open }) => {
  const store = open(); await store.init(); const insert = store.db.prepare("INSERT INTO kv VALUES(?,'metadata','0',NULL,100)");
  store.db.exec('BEGIN IMMEDIATE');
  try { for (let i = 0; i < 30000; i++) insert.run(key('n:' + i)); store.db.exec('COMMIT'); }
  catch (error) { store.db.exec('ROLLBACK'); throw error; }
  await store.put(key('n:0'), 42); assert.equal(await store.get(key('n:0')), 42);
  await assert.rejects(() => store.put(key('new'), 1), /30000/);
  await store.apply([{ type: 'remove', key: key('n:1') }, { type: 'put', key: key('new'), value: 9 }]);
  assert.equal((await store.keys('')).length, 30000); assert.equal(await store.get(key('new')), 9);
}));

test('different store handles serialize file lifetimes in one process', () => fixture(async ({ open }) => {
  const first = open(), second = open();
  await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? first : second).put(key('parallel:' + i), { i })));
  assert.equal((await first.keys(key('parallel:'))).length, 12);
  await Promise.all([first.put(BOOK_KEY, packet('A')), second.put(BOOK_KEY, packet('B'))]);
  assert.ok(['A', 'B'].includes((await first.get(BOOK_KEY)).book.title));
  assert.equal((await fs.readdir(first.objectsRoot)).length, 1);
}));

test('tampering with a same-size object is detected before returning book text', () => fixture(async ({ open }) => {
  const store = open(); await store.put(BOOK_KEY, packet('Original'));
  const row = store.db.prepare('SELECT object_sha FROM kv WHERE key=?').get(BOOK_KEY), filename = path.join(store.objectsRoot, row.object_sha + '.json');
  const bytes = await fs.readFile(filename); bytes[bytes.indexOf(Buffer.from('Original'))] = 0x58; await fs.writeFile(filename, bytes);
  await assert.rejects(() => store.get(BOOK_KEY), /Контрольная сумма/);
}));

test('a missing committed book fails closed instead of exposing an empty library', () => fixture(async ({ open }) => {
  const first = open(); await first.put(BOOK_KEY, packet('Keep')); const row = first.db.prepare('SELECT object_sha FROM kv WHERE key=?').get(BOOK_KEY); await first.close();
  await fs.unlink(path.join(first.objectsRoot, row.object_sha + '.json'));
  const reopened = open(); await assert.rejects(() => reopened.init());
}));

test('a changed migration marker is never silently rewritten', () => fixture(async ({ open }) => {
  const first = open(); await first.put(key('keep'), 1); await first.close();
  await fs.writeFile(path.join(first.storageRoot, 'migration.json'), '{"fake":true}');
  const reopened = open(); await assert.rejects(() => reopened.init(), /Маркер миграции/);
  assert.equal(await fs.readFile(path.join(first.storageRoot, 'migration.json'), 'utf8'), '{"fake":true}');
}));

test('the backup API includes uncheckpointed data and every referenced object', () => fixture(async ({ root, open }) => {
  const store = open(); await store.put(BOOK_KEY, packet('Backup text')); await store.put(key('outbox'), { counter: 5 });
  assert.ok((await fs.stat(store.databasePath + '-wal')).size > 0);
  const destination = path.join(root, 'snapshot'), report = await store.exportSnapshot(destination);
  assert.equal(report.status, 'complete'); assert.ok(report.files.some(file => file.path.startsWith('objects/')));
  const copied = new DatabaseSync(path.join(destination, 'library.sqlite'), { readOnly: true });
  try { assert.equal(JSON.parse(copied.prepare('SELECT value_json FROM kv WHERE key=?').get(key('outbox')).value_json).counter, 5); }
  finally { copied.close(); }
  await store.put(BOOK_KEY, packet('After backup')); await store.put(key('outbox'), { counter: 6 });
  const restoredRoot = path.join(root, 'restored'), restoredPath = path.join(restoredRoot, 'storage-v2');
  await fs.mkdir(restoredRoot); await fs.cp(destination, restoredPath, { recursive: true });
  const restored = new SqliteStore(restoredRoot);
  try { assert.equal((await restored.get(BOOK_KEY)).book.title, 'Backup text'); assert.equal((await restored.get(key('outbox'))).counter, 5); }
  finally { await restored.close(); }
  await assert.rejects(() => store.exportSnapshot(destination), /уже существует/);
}));

test('export rejects unsafe targets and leaves an incomplete marker on object corruption', () => fixture(async ({ root, open }) => {
  const store = open(); await store.put(BOOK_KEY, packet('Keep'));
  await assert.rejects(() => store.exportSnapshot(path.join(store.root, 'nested')));
  await assert.rejects(() => store.exportSnapshot(root));
  const row = store.db.prepare('SELECT object_sha FROM kv WHERE key=?').get(BOOK_KEY);
  await fs.writeFile(path.join(store.objectsRoot, row.object_sha + '.json'), 'broken');
  const target = path.join(root, 'bad-snapshot'); await assert.rejects(() => store.exportSnapshot(target));
  assert.equal(JSON.parse(await fs.readFile(path.join(target, 'incomplete.json'), 'utf8')).status, 'incomplete');
  await assert.rejects(() => fs.stat(path.join(target, 'manifest.json')), { code: 'ENOENT' });
}));
