import test from 'node:test';
import assert from 'node:assert/strict';
import { chapterOrigin, originKey } from '../src/mvp/api.mjs';
import { createLibraryOrganization } from '../src/mvp/library-organization.mjs';
import { exportCatalog, importCatalog, prepareCatalog, validateCatalogManifest } from '../src/mvp/catalog-transfer.mjs';

const origin = id => ({ source: 'ranobelib', bookId: 'book', chapterId: id, branchId: 'translation' });
const book = { source: 'ranobelib', id: 'book', title: 'Книга', kind: 'novel', author: 'Автор', defaultBranchId: 'translation' };
const chapter = id => ({ id, title: `Глава ${id}`, origin: origin(id) });
const content = { paragraphs: ['Текст главы'] };
function store(initialRows = []) {
  const rows = new Map(initialRows.map(row => [`${row.book.source}:${row.book.id}`, structuredClone(row)])), data = new Map(), writes = [];
  let tail = Promise.resolve();
  return { rows, writes, async get(key) { await tail; return structuredClone(data.get(key)); }, update(key, transform) { const next = tail.then(() => { const value = transform(structuredClone(data.get(key))); data.set(key, structuredClone(value)); return structuredClone(value); }); tail = next.catch(() => {}); return next; },
    async listBooks() { return [...rows.values()].map(value => structuredClone(value)); },
    async readChapter(_book, descriptor) { return descriptor.id === 'missing' ? undefined : content; },
    async saveBook(value, chapters, branches) { const key = `${value.source}:${value.id}`, previous = rows.get(key); rows.set(key, { ...previous, book: structuredClone(value), chapters: structuredClone(chapters), branches: structuredClone(branches) }); writes.push(key); },
    async removeBook(value) { rows.delete(`${value.source}:${value.id}`); },
  };
}
function organization(storage) { let id = 0; return createLibraryOrganization({ storage, createId: () => 'folder-' + ++id }); }
async function manifest(rows, storage = store(rows)) { return prepareCatalog({ name: 'Каталог', rows, storage, now: () => 1234 }); }

test('export preserves source identity and order, commits legacy cached text, and strips settings and reading history', async () => {
  const storage = store(), saved = [], progress = [];
  const row = { book: { ...book, serverUrl: 'https://private.example.ts.net', description: 'личное', url: 'https://private.example.ts.net' }, chapters: [chapter('second'), chapter('first'), chapter('missing')], branches: [{ id: 'translation', secret: 'do not export' }], position: { fraction: .4, branchId: 'translation' }, bookmarks: ['private'] };
  const result = await prepareCatalog({ name: 'Папка', rows: [row], storage, native: { downloads: { async saveChapter(key, text) { saved.push({ key, text }); } } }, onProgress: value => progress.push(value), now: () => 1234 });
  assert.deepEqual(result.books[0].chapters.map(value => value.id), ['second', 'first', 'missing']);
  assert.deepEqual(result.books[0].chapterKeys, row.chapters.map(value => originKey(value.origin)));
  assert.equal(saved.length, 2); assert.equal(result.cachedChapterCount, 2); assert.equal(result.chapterCount, 3);
  assert.ok(saved.every(value => value.text === content));
  const serialized = JSON.stringify(result);
  for (const forbidden of ['serverUrl', 'private.example', 'description', 'bookmarks', 'position', 'secret', 'fraction']) assert.ok(!serialized.includes(forbidden), forbidden);
  assert.equal(progress[0].stage, 'preparing'); assert.equal(progress.at(-1).processed, 3);
});

test('shared origins are unique archive entries but count for each book outline', async () => {
  const rows = [{ book, chapters: [chapter('first')] }, { book: { source: 'merged', id: 'merged', title: 'Объединённая' }, chapters: [chapter('first')] }];
  const result = await manifest(rows);
  assert.equal(result.chapterCount, 2); assert.equal(result.cachedChapterCount, 2); assert.equal(result.uniqueCachedChapterCount, 1);
});

test('native export gets only the validated manifest and explicit share choice; native counts are authoritative', async () => {
  const storage = store(); let sent;
  const result = await exportCatalog({ name: 'Каталог', rows: [{ book, chapters: [chapter('first')] }], storage, share: true, native: { catalogs: { async export(value, options) { sent = { value, options }; return { saved: true, shared: true, chapterCount: 1, cachedChapterCount: 1 }; } } } });
  assert.equal(sent.value.format, 'gargantua-catalog'); assert.deepEqual(sent.options, { share: true }); assert.equal(result.saved, true); assert.equal(result.bookCount, 1);
});

test('import reuses one existing library book, preserves its old folder and position, and appends only a proven outline prefix', async () => {
  const existing = { book: { ...book, title: 'Своё название' }, chapters: [chapter('first')], branches: [{ id: 'translation' }], position: { chapterIndex: 0, fraction: .6 }, savedAt: 10 };
  const storage = store([existing]), folders = organization(storage);
  await folders.sync([existing]); const oldFolder = (await folders.createFolder('Моя папка')).selectedFolder; await folders.moveToFolder(book, oldFolder);
  const incoming = await manifest([{ book, chapters: [chapter('first'), chapter('second')] }]);
  const result = await importCatalog({ native: { catalogs: { async import() { return incoming; } } }, storage, organization: folders });
  assert.equal(storage.rows.size, 1); assert.equal(result.reusedBooks, 1); assert.equal(result.newBooks, 0); assert.equal(result.extendedOutlines, 1);
  const row = storage.rows.get('ranobelib:book');
  assert.equal(row.book.title, 'Своё название'); assert.deepEqual(row.position, existing.position); assert.deepEqual(row.branches, existing.branches); assert.equal(row.chapters.length, 2); assert.equal(row.savedAt, 10);
  assert.equal(result.organization.assignments['ranobelib:book'], oldFolder);
  assert.deepEqual(result.organization.folderReferences[result.organization.selectedFolder], ['ranobelib:book']);
});

test('an incompatible existing outline is preserved and reported instead of replacing a reader edition', async () => {
  const existing = { book, chapters: [chapter('different')], branches: [] }, storage = store([existing]), folders = organization(storage);
  await folders.sync([existing]);
  const incoming = await manifest([{ book, chapters: [chapter('first')] }]);
  const result = await importCatalog({ native: { catalogs: { async import() { return incoming; } } }, storage, organization: folders });
  assert.equal(result.skippedOutlineUpdates, 1); assert.equal(storage.writes.length, 0); assert.deepEqual(storage.rows.get('ranobelib:book'), existing);
});

test('new imported books are local, keep original identity, reset branch selection and explicitly mark missing file chapters', async () => {
  const storage = store(), folders = organization(storage), incoming = await manifest([{ book, chapters: [chapter('first'), chapter('missing')] }]);
  const result = await importCatalog({ native: { catalogs: { async import() { return incoming; } } }, storage, organization: folders });
  const row = storage.rows.get('ranobelib:book');
  assert.equal(result.newBooks, 1); assert.equal(row.book.localCatalog, true); assert.equal(row.book.defaultBranchId, ''); assert.deepEqual(row.branches, []);
  assert.equal(row.chapters[0].catalogCached, true); assert.equal(row.chapters[1].catalogCached, false);
  assert.deepEqual(chapterOrigin(row.book, row.chapters[0], 'another-reader-branch'), origin('first'));
  assert.deepEqual(row.book.catalogCache, { cached: 1, total: 2 });
  await importCatalog({ native: { catalogs: { async import() { return incoming; } } }, storage, organization: folders });
  assert.equal(storage.rows.size, 1); assert.equal((await folders.read()).folders.length, 2);
});

test('failed folder commit rolls back only new rows and never deletes an existing edition', async () => {
  const existing = { book, chapters: [chapter('first')] }, storage = store([existing]);
  const incoming = await manifest([existing, { book: { ...book, id: 'new', title: 'Новая' }, chapters: [chapter('second')] }]);
  await assert.rejects(importCatalog({ native: { catalogs: { async import() { return incoming; } } }, storage, organization: { async importFolder() { throw new Error('disk full'); } } }), /disk full/u);
  assert.equal(storage.rows.size, 1); assert.ok(storage.rows.has('ranobelib:book'));
});

test('format, mismatched keys/counts, duplicate books and unknown origins are rejected before JS metadata writes', async () => {
  const good = await manifest([{ book, chapters: [chapter('first')] }]);
  for (const mutate of [value => { value.format = 'other'; }, value => { value.books[0].chapterKeys[0] = 'wrong'; }, value => { value.cachedChapterCount = 999; }, value => { value.books.push(value.books[0]); }, value => { value.books[0].chapters[0].origin.source = 'private-server'; }]) {
    const bad = structuredClone(good); mutate(bad); const storage = store();
    await assert.rejects(importCatalog({ native: { catalogs: { async import() { return bad; } } }, storage, organization: organization(storage) }), { code: 'CATALOG_INVALID' });
    assert.equal(storage.rows.size, 0); assert.equal(storage.writes.length, 0);
  }
  assert.equal(validateCatalogManifest(good).cachedChapterCount, 1);
});

test('picker cancel and native cache conflicts propagate without touching the library', async () => {
  for (const code of ['CATALOG_CANCELLED', 'CATALOG_CONFLICT']) {
    const storage = store();
    await assert.rejects(importCatalog({ native: { catalogs: { async import() { throw Object.assign(new Error(code), { code }); } } }, storage, organization: organization(storage) }), { code });
    assert.equal(storage.writes.length, 0);
  }
});
