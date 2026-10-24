import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import native from '../desktop/sqlite-store.cjs';
import legacy from '../desktop/store.cjs';

const { SqliteStore } = native, { FileStore } = legacy;
const OWNER = '10000000-0000-4000-8000-000000000001', BOOK = '20000000-0000-4000-8000-000000000002';
const BOOK_KEY = `${OWNER}:book:${BOOK}`, key = suffix => `${OWNER}:${suffix}`;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(action) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gargantua-sqlite-migration-')), library = path.join(root, 'library'), stores = [];
  const open = options => { const store = new SqliteStore(library, options); stores.push(store); return store; };
  try { return await action({ root, library, open, old: new FileStore(library) }); }
  finally {
    for (const store of stores.reverse()) await store.close().catch(() => {});
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); assert.match(path.basename(root), /^gargantua-sqlite-migration-/);
    await fs.rm(root, { recursive: true, force: true });
  }
}
async function sourceFiles(root) {
  const rows = [];
  async function walk(target) {
    let entries; try { entries = await fs.readdir(target, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) { const filename = path.join(target, entry.name); if (entry.isDirectory()) await walk(filename); else rows.push([path.relative(root, filename), sha(await fs.readFile(filename))]); }
  }
  await walk(path.join(root, 'books')); await walk(path.join(root, 'metadata'));
  try { rows.push(['index.json', sha(await fs.readFile(path.join(root, 'index.json')))]); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return rows.sort(([a], [b]) => a.localeCompare(b, 'en'));
}
async function rawRecord(root, entryKey, value) {
  const bytes = Buffer.from(JSON.stringify({ key: entryKey, value }));
  const parts = entryKey.split(':');
  const filename = parts[1] === 'book' ? path.join(root, 'books', parts[0], parts[2] + '.cotology.json') : path.join(root, 'metadata', sha(Buffer.from(entryKey)) + '.json');
  await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, bytes); return filename;
}

test('legacy books, metadata, pending writes and workspace migrate without changing one source byte', () => fixture(async ({ old, library, open }) => {
  const book = { book: { id: BOOK, title: 'Сохранённая книга' }, content: { chapters: [{ title: 'Первая', blocks: [{ text: 'Текст' }] }] } };
  const values = [[BOOK_KEY, book], ['lastProfile', { id: OWNER, login: 'fixture' }], [key('position:' + BOOK), { chapter: 0, position: 0.4 }],
    [key('pending:mark:' + BOOK), { url: '/fixture', method: 'POST', body: { note: 'Не потерять' } }], [key('workspace'), { catalogs: [], tabs: [{ id: BOOK }], revision: 0 }]];
  for (const [entryKey, value] of values) await old.put(entryKey, value);
  const before = await sourceFiles(library), store = open(); await store.init();
  for (const [entryKey, value] of values) assert.deepEqual(await store.get(entryKey), value);
  assert.deepEqual(await sourceFiles(library), before);
  const marker = store.migration; assert.equal(marker.entries, values.length); assert.equal(marker.recoveredUnindexedEntries, 0);
  await store.close(); const reopened = open(); await reopened.init(); assert.equal(reopened.migration.migrationId, marker.migrationId);
  assert.deepEqual(await sourceFiles(library), before);
}));

test('complete but unindexed files are recovered and stale size entries use checked actual bytes', () => fixture(async ({ old, library, open }) => {
  await old.put(key('indexed'), { n: 1 });
  await rawRecord(library, key('unindexed'), { n: 2 }); await rawRecord(library, BOOK_KEY, { book: { title: 'Сиротская книга' }, content: { chapters: [] } });
  const indexPath = path.join(library, 'index.json'), index = JSON.parse(await fs.readFile(indexPath, 'utf8')); index[key('indexed')] = 1; await fs.writeFile(indexPath, JSON.stringify(index));
  const before = await sourceFiles(library), store = open(); await store.init();
  assert.equal((await store.get(BOOK_KEY)).book.title, 'Сиротская книга'); assert.equal((await store.get(key('unindexed'))).n, 2);
  assert.equal(store.migration.recoveredUnindexedEntries, 2); assert.equal(store.migration.staleIndexSizes, 1);
  assert.deepEqual(await sourceFiles(library), before);
}));

test('a library with no old index recovers complete files but never promotes an interrupted .tmp write', () => fixture(async ({ library, open }) => {
  const original = await rawRecord(library, key('saved'), { n: 1 }); await fs.writeFile(original + '.tmp', JSON.stringify({ key: key('saved'), value: { n: 99 } }));
  const store = open(); await store.init(); assert.deepEqual(await store.get(key('saved')), { n: 1 });
  assert.equal(store.migration.recoveredUnindexedEntries, 1); assert.equal(store.migration.ignoredTemporaryFiles, 1);
  assert.ok((await fs.stat(original + '.tmp')).isFile());
}));

test('invalid old JSON fails without publishing a usable partial migration, then a corrected fixture can retry', () => fixture(async ({ old, library, open }) => {
  await old.put(key('keep'), { n: 1 }); const bad = await rawRecord(library, BOOK_KEY, { content: {} }); await fs.writeFile(bad, '{broken');
  const before = await sourceFiles(library), failing = open(); await assert.rejects(() => failing.init());
  assert.deepEqual(await sourceFiles(library), before); await assert.rejects(() => fs.stat(path.join(library, 'storage-v2', 'migration.json')), { code: 'ENOENT' });
  await rawRecord(library, BOOK_KEY, { content: { chapters: [] } }); const reopened = open(); await reopened.init(); assert.equal((await reopened.keys('')).length, 2);
}));

test('a missing indexed file is not concealed as an empty or successful migration', () => fixture(async ({ old, library, open }) => {
  await old.put(BOOK_KEY, { content: { chapters: [] } });
  await fs.unlink(path.join(library, 'books', OWNER, BOOK + '.cotology.json'));
  const before = await sourceFiles(library), store = open(); await assert.rejects(() => store.init(), /отсутствует/);
  assert.deepEqual(await sourceFiles(library), before);
}));

test('changing the legacy source during the migration rolls back new authority and preserves the changed source', () => fixture(async ({ old, library, open }) => {
  await old.put(key('keep'), { n: 1 }); let altered = false;
  const store = open({ fault: async phase => { if (phase === 'migration-record' && !altered) { altered = true; await rawRecord(library, key('keep'), { n: 2 }); } } });
  await assert.rejects(() => store.init(), /изменилась/);
  assert.equal(JSON.parse(await fs.readFile(path.join(library, 'metadata', sha(Buffer.from(key('keep'))) + '.json'), 'utf8')).value.n, 2);
  await assert.rejects(() => fs.stat(path.join(library, 'storage-v2', 'migration.json')), { code: 'ENOENT' });
}));

test('a record key must match its legacy hashed filename and book ownership path', () => fixture(async ({ old, library, open }) => {
  await old.put(key('keep'), 1);
  const filename = path.join(library, 'metadata', sha(Buffer.from(key('keep'))) + '.json');
  await fs.writeFile(filename, JSON.stringify({ key: key('other'), value: 2 }));
  const before = await sourceFiles(library); await assert.rejects(() => open().init(), /не соответствует/);
  assert.deepEqual(await sourceFiles(library), before);
}));

test('junctions in either legacy metadata or storage-v2 fail before following them', () => fixture(async ({ root, library, open }) => {
  const outside = path.join(root, 'outside'); await fs.mkdir(outside); await fs.mkdir(library);
  const junction = path.join(library, 'metadata'); await fs.symlink(outside, junction, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(() => open().init(), /Ссыл|junction/); assert.deepEqual(await fs.readdir(outside), []);
  await fs.unlink(junction); await fs.rm(path.join(library, 'storage-v2'), { recursive: true, force: true });
  await fs.symlink(outside, path.join(library, 'storage-v2'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(() => open().init(), /Ссыл|junction/); assert.deepEqual(await fs.readdir(outside), []);
}));

test('unknown or future SQLite schemas are refused without replacing their data', () => fixture(async ({ library, open }) => {
  const target = path.join(library, 'storage-v2'); await fs.mkdir(target, { recursive: true });
  let database = new DatabaseSync(path.join(target, 'library.sqlite')); database.exec("CREATE TABLE foreign_data(value TEXT); INSERT INTO foreign_data VALUES('keep');"); database.close();
  await assert.rejects(() => open().init(), /Неизвестная локальная БД/);
  database = new DatabaseSync(path.join(target, 'library.sqlite')); assert.equal(database.prepare('SELECT * FROM foreign_data').get().value, 'keep');
  database.exec('PRAGMA application_id=1196444722; PRAGMA user_version=99;'); database.close();
  await assert.rejects(() => open().init(), /Неподдерживаемая версия/);
}));

test('flush waits for acknowledged queued writes and close is idempotent', () => fixture(async ({ open }) => {
  const store = open(); const pending = Array.from({ length: 8 }, (_, i) => store.put(key('flush:' + i), i));
  await store.flush(); await Promise.all(pending); await Promise.all([store.close(), store.close()]);
  const reopened = open(); assert.equal((await reopened.keys(key('flush:'))).length, 8);
}));
