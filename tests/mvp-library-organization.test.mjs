import test from 'node:test';
import assert from 'node:assert/strict';
import { createLibraryOrganization, LIBRARY_ORGANIZATION_KEY, matchesLibrarySearch, normalizeOrganization, orderedLibrary } from '../src/mvp/library-organization.mjs';

function deviceStore(initial = []) {
  const data = new Map(initial.map(([key, value]) => [key, structuredClone(value)]));
  let tail = Promise.resolve();
  return { data, async get(key) { await tail; return structuredClone(data.get(key)); }, update(key, transform) {
    const work = tail.then(() => {
      const result = transform(structuredClone(data.get(key)));
      if (result !== undefined) data.set(key, structuredClone(result));
      return structuredClone(result);
    });
    tail = work.catch(() => {});
    return work;
  } };
}
const row = (id, source = 'ranobelib', extra = {}) => ({ book: { source, id, title: `Книга ${id}` }, ...extra });
const keys = rows => rows.map(value => `${value.book.source}:${value.book.id}`);
function app(storage) { let id = 0; return createLibraryOrganization({ storage, createId: () => `folder-${++id}`, now: () => 123 }); }

test('the first library order survives reading, cold restart, a new book and source identity collisions', async () => {
  const storage = deviceStore(), organization = app(storage);
  const old = [row('a'), row('b'), row('a', 'ranobehub')];
  await organization.sync(old);
  await organization.moveBook(old[2], -1, old);
  const afterReading = [row('b', 'ranobelib', { lastRead: 999 }), old[2], old[0]];
  const cold = app(storage);
  let state = await cold.sync(afterReading);
  assert.deepEqual(keys(orderedLibrary(afterReading, state)), ['ranobelib:a', 'ranobehub:a', 'ranobelib:b']);
  state = await cold.sync([row('new', 'merged'), ...afterReading]);
  assert.deepEqual(keys(orderedLibrary([row('new', 'merged'), ...afterReading], state)), ['ranobelib:a', 'ranobehub:a', 'ranobelib:b', 'merged:new']);
  assert.equal(new Set(state.order).size, 4);
});

test('concurrent folder creation is atomic; names are trimmed and case-equivalent duplicates fail without writes', async () => {
  const storage = deviceStore(), organization = app(storage);
  await Promise.all([organization.createFolder('  Русская   классика  '), organization.createFolder('Новеллы')]);
  const before = await organization.read();
  assert.deepEqual(before.folders.map(folder => folder.name), ['Русская классика', 'Новеллы']);
  assert.equal(before.folders[0].createdAt, 123);
  await assert.rejects(organization.createFolder('РУССКАЯ классика'), /уже есть/u);
  await assert.rejects(organization.createFolder('   '), /Введите/u);
  await assert.rejects(organization.createFolder('я'.repeat(81)), /80/u);
  assert.deepEqual(await organization.read(), before);
});

test('folder deletion unfiles its books while preserving every book, chapter, bookmark and manual position', async () => {
  const book = row('a'), chapter = { paragraphs: ['Сохранённая глава'] }, bookmark = [{ id: 'mark', fraction: .4 }];
  const storage = deviceStore([['book:ranobelib:a', book], ['text:cached', chapter], ['bookmarks:ranobelib:a', bookmark], ['position:ranobelib:a', { fraction: .4 }]]);
  const organization = app(storage);
  await organization.sync([book, row('b')]);
  const folder = (await organization.createFolder('Читаю')).folders[0];
  await organization.moveToFolder(book, folder.id);
  await organization.moveBook(row('b'), -1, [book, row('b')]);
  const state = await organization.deleteFolder(folder.id);
  assert.equal(state.selectedFolder, 'unfiled');
  assert.deepEqual(state.assignments, {});
  assert.deepEqual(state.order, ['ranobelib:b', 'ranobelib:a']);
  assert.deepEqual(storage.data.get('book:ranobelib:a'), book);
  assert.deepEqual(storage.data.get('text:cached'), chapter);
  assert.deepEqual(storage.data.get('bookmarks:ranobelib:a'), bookmark);
  assert.deepEqual(storage.data.get('position:ranobelib:a'), { fraction: .4 });
  assert.equal(storage.data.size, 5);
});

test('folder and filtered-list reordering swaps only visible neighbors and cannot wrap around', async () => {
  const storage = deviceStore(), organization = app(storage), books = ['a', 'outside', 'b', 'c'].map(id => row(id));
  await organization.sync(books);
  const folder = (await organization.createFolder('Серия')).folders[0];
  await organization.moveToFolder(books[0], folder.id);
  await organization.moveToFolder(books[2], folder.id);
  await organization.moveToFolder(books[3], folder.id);
  let state = await organization.moveBook(books[2], -1, [books[0], books[2], books[3]], folder.id);
  assert.deepEqual(state.order, ['ranobelib:a', 'ranobelib:outside', 'ranobelib:b', 'ranobelib:c']);
  assert.deepEqual(keys(orderedLibrary(books, state, folder.id)), ['ranobelib:b', 'ranobelib:a', 'ranobelib:c']);
  assert.deepEqual(keys(orderedLibrary(books, state, 'unfiled')), ['ranobelib:outside']);
  const before = state;
  state = await organization.moveBook(books[2], -1, [books[0], books[2], books[3]], folder.id);
  assert.deepEqual(state, before);
  await assert.rejects(organization.moveBook(books[0], 5, books), /направление/u);
  assert.deepEqual(await organization.read(), before);
});

test('renaming keeps folder identity and assignments; selected filter survives a cold start', async () => {
  const storage = deviceStore(), organization = app(storage);
  const folder = (await organization.createFolder('Старое название')).folders[0];
  await organization.moveToFolder(row('a'), folder.id);
  await organization.renameFolder(folder.id, 'Новое название');
  let cold = await app(storage).read();
  assert.equal(cold.selectedFolder, folder.id);
  assert.equal(cold.assignments['ranobelib:a'], folder.id);
  assert.equal(cold.folders[0].name, 'Новое название');
  await organization.selectFolder('unfiled');
  cold = await app(storage).read();
  assert.equal(cold.selectedFolder, 'unfiled');
  await organization.moveToFolder(row('a'), '');
  assert.deepEqual((await organization.read()).assignments, {});
});

test('unknown folders and duplicate renames leave existing organization unchanged', async () => {
  const storage = deviceStore(), organization = app(storage);
  const first = (await organization.createFolder('Один')).selectedFolder;
  await organization.createFolder('Два');
  const before = await organization.read();
  await assert.rejects(organization.renameFolder(first, 'два'), /уже есть/u);
  await assert.rejects(organization.moveToFolder(row('a'), 'missing'), /не существует/u);
  await assert.rejects(organization.selectFolder('missing'), /не существует/u);
  await assert.rejects(organization.deleteFolder('missing'), /не существует/u);
  assert.deepEqual(await organization.read(), before);
});

test('removing a library book forgets only its organization and readding appends it', async () => {
  const storage = deviceStore(), organization = app(storage), books = [row('a'), row('b')];
  await organization.sync(books);
  const folder = (await organization.createFolder('Папка')).selectedFolder;
  await organization.moveToFolder(books[0], folder);
  await organization.forgetBook(books[0]);
  const state = await organization.sync(books);
  assert.deepEqual(state.order, ['ranobelib:b', 'ranobelib:a']);
  assert.deepEqual(state.assignments, {});
  assert.equal(state.folders.length, 1);
});

test('normalization recovers stale folder references but refuses to overwrite a future schema', async () => {
  assert.deepEqual(normalizeOrganization(null), { schemaVersion: 1, folders: [], assignments: {}, folderReferences: {}, folderOrders: {}, order: [], selectedFolder: 'all', view: 'home' });
  const malformed = { folders: [{ id: 'folder', name: 'Рабочая' }, { id: 'folder', name: 'Дубликат' }, { id: 'all', name: 'Зарезервированная' }], assignments: { 'ranobelib:a': 'removed', 'ranobelib:b': 'folder' }, order: ['ranobelib:a', 'ranobelib:a', '', null], selectedFolder: 'removed' };
  const state = normalizeOrganization(malformed);
  assert.equal(state.folders.length, 1);
  assert.deepEqual(state.assignments, { 'ranobelib:b': 'folder' });
  assert.deepEqual(state.order, ['ranobelib:a']);
  assert.equal(state.selectedFolder, 'all');
  const future = { schemaVersion: 2, folders: ['new-format'] }, storage = deviceStore([[LIBRARY_ORGANIZATION_KEY, future]]);
  await assert.rejects(app(storage).sync([row('a')]), /новой версией/u);
  assert.deepEqual(storage.data.get(LIBRARY_ORGANIZATION_KEY), future);
});

test('home navigation is additive, remembers the last folder and survives restart without changing book organization', async () => {
  const storage = deviceStore(), organization = app(storage), books = [row('a'), row('b')];
  await organization.sync(books); const folder = (await organization.createFolder('Читаю')).selectedFolder;
  await organization.organizeBooks(books, folder, 'add'); const before = await organization.read();
  const home = await organization.showHome();
  assert.equal(home.view, 'home'); assert.equal(home.selectedFolder, folder);
  assert.deepEqual(home.folderOrders, before.folderOrders); assert.deepEqual(home.order, before.order);
  assert.equal((await app(storage).read()).view, 'home');
  const opened = await organization.selectFolder(folder); assert.equal(opened.view, 'folder');
  assert.equal((await app(storage).read()).selectedFolder, folder);
  assert.equal(normalizeOrganization({ ...before, view: undefined }).view, 'home', 'Old records initially show catalogs without clearing old selected folder');
});

test('removing several folder references is atomic and keeps all other memberships, orders and user data', async () => {
  const books = [row('a'), row('b'), row('c')], storage = deviceStore([['position:ranobelib:a', { fraction: .4 }], ['bookmarks:ranobelib:a', [{ id: 'saved' }]], ['text:old', { text: 'Existing cache' }]]), organization = app(storage);
  await organization.sync(books); const first = (await organization.createFolder('Один')).selectedFolder;
  await organization.organizeBooks(books, first, 'move'); const second = (await organization.importFolder('Два', [books[1], books[0]])).selectedFolder;
  const before = await organization.read(), data = [...storage.data].filter(([key]) => key !== LIBRARY_ORGANIZATION_KEY);
  const after = await organization.removeFromFolder([books[0], books[1]], first);
  assert.deepEqual(keys(orderedLibrary(books, after, first)), ['ranobelib:c']);
  assert.deepEqual(keys(orderedLibrary(books, after, second)), ['ranobelib:b', 'ranobelib:a']);
  assert.deepEqual(after.folderOrders[second], before.folderOrders[second]); assert.deepEqual(after.order, before.order);
  assert.deepEqual([...storage.data].filter(([key]) => key !== LIBRARY_ORGANIZATION_KEY), data);
  await assert.rejects(organization.removeFromFolder(books, 'missing'), /не существует/u);
  assert.deepEqual(await organization.read(), after);
});

test('bulk add appends in selected order and bulk move alone removes older references', async () => {
  const storage = deviceStore(), organization = app(storage), books = [row('a'), row('b'), row('c')];
  await organization.sync(books); const first = (await organization.createFolder('Один')).selectedFolder;
  await organization.organizeBooks([books[0], books[1]], first, 'add'); const second = (await organization.createFolder('Два')).selectedFolder;
  await organization.organizeBooks([books[2]], second, 'add');
  let state = await organization.organizeBooks([books[1], books[0]], second, 'add');
  assert.deepEqual(keys(orderedLibrary(books, state, second)), ['ranobelib:c', 'ranobelib:b', 'ranobelib:a']);
  assert.deepEqual(keys(orderedLibrary(books, state, first)), ['ranobelib:a', 'ranobelib:b']);
  state = await organization.organizeBooks([books[0], books[1]], second, 'move');
  assert.deepEqual(keys(orderedLibrary(books, state, first)), []);
  assert.deepEqual(keys(orderedLibrary(books, state, second)), ['ranobelib:c', 'ranobelib:a', 'ranobelib:b']);
  assert.deepEqual(state.order, ['ranobelib:a', 'ranobelib:b', 'ranobelib:c']);
});

test('adding the same books repeatedly creates only references once and never duplicates or rewrites book rows', async () => {
  const books = [row('a'), row('b')], storage = deviceStore(books.map(book => ['book:' + keys([book])[0], book])), organization = app(storage);
  await organization.sync(books); const folder = (await organization.createFolder('Общее')).selectedFolder;
  const once = await organization.organizeBooks(books, folder, 'add');
  const twice = await organization.organizeBooks([books[0], books[0], books[1]], folder, 'add');
  assert.deepEqual(twice, once); assert.equal(orderedLibrary(books, twice, folder).length, 2); assert.equal(orderedLibrary(books, twice, 'all').length, 2);
  assert.deepEqual(storage.data.get('book:ranobelib:a'), books[0]); assert.deepEqual(storage.data.get('book:ranobelib:b'), books[1]);
  assert.equal([...storage.data.keys()].filter(key => key.startsWith('book:')).length, 2);
});

test('local library search matches title/author tokens in any order, normalizes ё and punctuation, and never searches source badges', () => {
  const book = { title: 'Огонь и лёд', author: 'Эрин Хантер', sourceName: 'ЛибКат', description: 'Недоступное описание' };
  for (const query of ['хантер эрин', 'ОГОНЬ ЛЕД', 'лёд, Эрин!', 'Хантер — огонь', '']) assert.equal(matchesLibrarySearch(book, query), true, query);
  assert.equal(matchesLibrarySearch({ book: { ...book, author: 'Хантер, Эрин' } }, 'эрин хантер'), true);
  for (const query of ['ЛибКат', 'описание', 'огонь другой']) assert.equal(matchesLibrarySearch(book, query), false, query);
});

test('contextual bulk move changes only the source catalog, preserves other memberships and target order, and is atomic', async () => {
  const books = [row('a'), row('b'), row('c')], storage = deviceStore([['text:old', { text: 'Unchanged saved text' }]]), organization = app(storage);
  await organization.sync(books); const original = (await organization.createFolder('Серия')).selectedFolder;
  await organization.organizeBooks(books, original, 'move'); const from = (await organization.importFolder('А', [books[0], books[1]])).selectedFolder;
  const target = (await organization.importFolder('Б', [books[2], books[1]])).selectedFolder, before = await organization.read();
  const moved = await organization.organizeBooks([books[0], books[1]], target, 'move', from);
  assert.deepEqual(keys(orderedLibrary(books, moved, from)), []);
  assert.deepEqual(keys(orderedLibrary(books, moved, target)), ['ranobelib:c', 'ranobelib:b', 'ranobelib:a']);
  assert.deepEqual(keys(orderedLibrary(books, moved, original)), ['ranobelib:a', 'ranobelib:b', 'ranobelib:c']);
  assert.deepEqual(moved.assignments, before.assignments); assert.deepEqual(moved.order, before.order);
  assert.deepEqual(storage.data.get('text:old'), { text: 'Unchanged saved text' });
  const sameFolder = await organization.organizeBooks(books, target, 'move', target); assert.deepEqual(sameFolder, moved);
  await assert.rejects(organization.organizeBooks(books, target, 'move', 'missing'), /не существует/u); assert.deepEqual(await organization.read(), moved);
});

test('imported catalogs reference existing books without duplicate rows or changes to older folder orders', async () => {
  const storage = deviceStore(), organization = app(storage), books = [row('a'), row('b'), row('c')];
  await organization.sync(books);
  const original = (await organization.createFolder('Оригинал')).selectedFolder;
  await organization.moveToFolder(books[0], original);
  await organization.moveToFolder(books[1], original);
  const before = await organization.read();
  let imported = await organization.importFolder('Присланное', [books[1], books[0], books[2]]);
  const received = imported.selectedFolder;
  assert.deepEqual(keys(orderedLibrary(books, imported, received)), ['ranobelib:b', 'ranobelib:a', 'ranobelib:c']);
  assert.deepEqual(keys(orderedLibrary(books, imported, original)), ['ranobelib:a', 'ranobelib:b']);
  assert.deepEqual(imported.order, before.order);
  assert.deepEqual(imported.assignments, before.assignments);
  assert.equal(orderedLibrary(books, imported, 'all').length, 3);
  imported = await organization.moveBook(books[0], -1, [books[1], books[0], books[2]], received);
  assert.deepEqual(keys(orderedLibrary(books, imported, received)), ['ranobelib:a', 'ranobelib:b', 'ranobelib:c']);
  assert.deepEqual(keys(orderedLibrary(books, imported, original)), ['ranobelib:a', 'ranobelib:b']);
  const again = await organization.importFolder('Присланное', [books[2], books[0]]);
  assert.equal(again.folders.at(-1).name, 'Присланное (2)');
  assert.equal(orderedLibrary(books, again, 'all').length, 3);
  await organization.deleteFolder(received);
  const after = await organization.read();
  assert.deepEqual(keys(orderedLibrary(books, after, original)), ['ranobelib:a', 'ranobelib:b']);
  assert.deepEqual(keys(orderedLibrary(books, after, again.selectedFolder)), ['ranobelib:c', 'ranobelib:a']);
});

test('explicit move removes old catalog references; removing a reference folder never removes a book', async () => {
  const storage = deviceStore(), organization = app(storage), book = row('a');
  await organization.sync([book]);
  const first = (await organization.createFolder('Первая')).selectedFolder;
  await organization.moveToFolder(book, first);
  const reference = (await organization.importFolder('Каталог', [book])).selectedFolder;
  const moved = await organization.moveToFolder(book, '');
  assert.equal(orderedLibrary([book], moved, first).length, 0);
  assert.equal(orderedLibrary([book], moved, reference).length, 0);
  assert.equal(orderedLibrary([book], moved, 'unfiled').length, 1);
  assert.deepEqual(moved.order, ['ranobelib:a']);
});

test('adding a book reference preserves every older membership and ordering; explicit moves append to destination', async () => {
  const storage = deviceStore(), organization = app(storage), books = [row('a'), row('b')];
  await organization.sync(books);
  const first = (await organization.createFolder('Первая')).selectedFolder;
  await organization.moveToFolder(books[0], first); await organization.moveToFolder(books[1], first);
  const second = (await organization.createFolder('Вторая')).selectedFolder;
  const added = await organization.addToFolder(books[0], second);
  assert.deepEqual(keys(orderedLibrary(books, added, first)), ['ranobelib:a', 'ranobelib:b']);
  assert.deepEqual(keys(orderedLibrary(books, added, second)), ['ranobelib:a']);
  assert.deepEqual(added.order, ['ranobelib:a', 'ranobelib:b']);
  const deleted = await organization.deleteFolder(second);
  assert.deepEqual(keys(orderedLibrary(books, deleted, first)), ['ranobelib:a', 'ranobelib:b']);
  const appended = await organization.moveToFolder(books[0], first);
  assert.deepEqual(keys(orderedLibrary(books, appended, first)), ['ranobelib:b', 'ranobelib:a']);
  assert.deepEqual(appended.order, ['ranobelib:a', 'ranobelib:b']);
});
