import test from 'node:test';
import assert from 'node:assert/strict';
import {chapterOrigin, originKey, registerSources, savedSources, sourceName} from '../src/mvp/api.mjs';

test('base bookmark branch never leaks into an explicit merged chapter origin or its cache identity', () => {
  const book = {source: 'merged', id: 'combined', defaultBranchId: 'default'};
  const chapter = {id: 'mc-tail', origin: {source: 'ranobeme', bookId: 'novel-1', chapterId: '1166'}};
  const afterBaseBookmark = chapterOrigin(book, chapter, 'default');
  assert.deepEqual(afterBaseBookmark, {source: 'ranobeme', bookId: 'novel-1', chapterId: '1166', branchId: ''});
  assert.equal(originKey(afterBaseBookmark), originKey(chapterOrigin(book, chapter, '')));
  assert.equal(chapterOrigin(book, {...chapter, origin: {...chapter.origin, branchId: 'main'}}, 'default').branchId, 'main');
});

test('original chapters use their selected branch, then chapter branch, then book default', () => {
  const book = {source: 'ranobelib', id: 'novel-1', defaultBranchId: 'book-team'};
  const chapter = {id: 'v1-c1', branchId: 'chapter-team'};
  assert.equal(chapterOrigin(book, chapter, 'selected-team').branchId, 'selected-team');
  assert.equal(chapterOrigin(book, chapter).branchId, 'chapter-team');
  assert.equal(chapterOrigin(book, {id: 'v1-c2'}).branchId, 'book-team');
  assert.equal(chapterOrigin({...book, defaultBranchId: null}, {id: 'v1-c3'}).branchId, '');
});

test('all shipped source names are readable before a network registry is loaded', () => {
  assert.equal(sourceName({source: 'litlife'}), 'ЛитЛайф');
  assert.equal(sourceName({source: 'libcat'}), 'ЛибКат');
  assert.equal(sourceName({source: 'ranobeme'}), 'Ranobe.me');
  assert.equal(sourceName({source: 'ranobehub'}), 'RanobeHub');
});

test('source metadata survives an offline cold module startup and blocked local storage is harmless', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map();
  try {
    Object.defineProperty(globalThis, 'localStorage', {configurable: true, value: {getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value)}});
    registerSources([{id: 'future-catalog', name: 'Новый каталог', kind: 'novel', description: 'Новые истории'}]);
    registerSources([{id: 'future-catalog', status: 'unavailable'}]);
    assert.deepEqual(savedSources().find(value => value.id === 'future-catalog'), {id: 'future-catalog', name: 'Новый каталог', kind: 'novel', description: 'Новые истории'});
    const cold = await import('../src/mvp/api.mjs?offline-registry-check');
    assert.equal(cold.sourceName({source: 'future-catalog'}), 'Новый каталог');
    Object.defineProperty(globalThis, 'localStorage', {configurable: true, get() { throw new Error('Storage disabled'); }});
    assert.deepEqual(cold.savedSources(), []);
    assert.doesNotThrow(() => cold.registerSources([{id: 'litlife', name: 'ЛитЛайф'}]));
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  }
});
