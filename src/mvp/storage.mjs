import { bookKey, chapterOrigin, originKey } from './api.mjs';

const DATABASE = 'gargantua-mvp';
const ACTIVE_FALLBACK = 'gargantua-last-reading';
let database;
const pending = new Set();
const prefixRange = prefix => IDBKeyRange.bound(prefix, prefix + '\uffff');

function tracked(promise) {
  pending.add(promise);
  promise.finally(() => pending.delete(promise)).catch(() => {});
  return promise;
}
function open() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('items');
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); database = undefined; };
      resolve(request.result);
    };
    request.onerror = () => { database = undefined; reject(new Error('Не удалось открыть библиотеку на устройстве.')); };
    request.onblocked = () => { database = undefined; reject(new Error('Закройте другое окно Гаргантюа и повторите.')); };
  });
  return database;
}

export async function get(key) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('items', 'readonly');
    const request = transaction.objectStore('items').get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Не удалось прочитать сохранённую книгу.'));
  });
}

export function put(key, value) {
  return tracked((async () => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('items', 'readwrite');
      transaction.objectStore('items').put(value, key);
      transaction.oncomplete = () => resolve(value);
      transaction.onerror = () => reject(new Error('Не удалось сохранить данные на устройстве. Проверьте свободное место.'));
      transaction.onabort = () => reject(new Error('Сохранение не завершилось. Повторите попытку.'));
    });
  })());
}

// A single transaction protects concurrent reader, library and download updates.
export function update(key, transform) {
  return tracked((async () => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('items', 'readwrite');
      const store = transaction.objectStore('items');
      const request = store.get(key);
      let value;
      request.onsuccess = () => {
        try { value = transform(request.result); if (value !== undefined) store.put(value, key); }
        catch (error) { transaction.abort(); reject(error); }
      };
      transaction.oncomplete = () => resolve(value);
      transaction.onerror = () => reject(new Error('Не удалось сохранить данные на устройстве. Проверьте свободное место.'));
      transaction.onabort = () => reject(new Error('Сохранение не завершилось. Повторите попытку.'));
    });
  })());
}

export async function listDownloads() {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('items', 'readonly');
    const store = transaction.objectStore('items');
    const request = store.openCursor(prefixRange('download:'));
    const manifestRequest = store.openCursor(prefixRange('download-manifest:'));
    const jobs = [];
    const manifests = new Map();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (String(cursor.key).startsWith('download:')) jobs.push(cursor.value);
      cursor.continue();
    };
    manifestRequest.onsuccess = () => {
      const cursor = manifestRequest.result;
      if (!cursor) return;
      manifests.set(String(cursor.key).slice('download-manifest:'.length), cursor.value);
      cursor.continue();
    };
    transaction.oncomplete = () => {
      try {
        resolve(jobs.map(job => {
          if (job.schema !== 2) return job;
          const manifest = manifests.get(job.id);
          if (!manifest || manifest.outlineKey !== job.outlineKey) throw new Error('Не удалось прочитать оглавление сохранённой загрузки. Повторите загрузку книги.');
          const { itemStates, itemErrors, schema, bookIdentity, ...header } = job;
          return { ...header, book: manifest.book, items: manifest.items.map((item, index) => ({ ...item,
            status: ({ p: 'pending', d: 'downloaded', f: 'failed', u: 'unavailable' })[itemStates[index]] || 'pending',
            error: itemErrors[index]?.[0] || '', attempts: itemErrors[index]?.[1] || 0 })) };
        }));
      } catch (error) { reject(error); }
    };
    transaction.onerror = () => reject(new Error('Не удалось прочитать очередь загрузки на устройстве.'));
  });
}
// A large merged outline is immutable during a download. Store it once, while
// each checkpoint writes only compact states and sparse errors in the same DB.
const downloadManifests = new Map();
export function saveDownload(job) {
  return tracked((async () => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('items', 'readwrite');
      const store = transaction.objectStore('items');
      const { book, items, ...header } = job;
      const itemStates = items.map(item => ({ pending: 'p', downloaded: 'd', failed: 'f', unavailable: 'u' })[item.status] || 'p').join('');
      const itemErrors = Object.fromEntries(items.flatMap((item, index) => item.error || item.attempts ? [[index, [item.error || '', item.attempts || 0]]] : []));
      store.put({ ...header, schema: 2, bookIdentity: bookKey(book), itemStates, itemErrors }, 'download:' + job.id);
      const manifest = () => ({ outlineKey: job.outlineKey, book, items: items.map(({ key, chapter, origin }) => ({ key, chapter, origin })) });
      if (downloadManifests.get(job.id) !== job.outlineKey) {
        const request = store.get('download-manifest:' + job.id);
        request.onsuccess = () => { if (request.result?.outlineKey !== job.outlineKey) store.put(manifest(), 'download-manifest:' + job.id); };
      }
      transaction.oncomplete = () => { downloadManifests.set(job.id, job.outlineKey); resolve(job); };
      transaction.onerror = () => reject(new Error('Не удалось сохранить очередь загрузки. Проверьте свободное место на устройстве.'));
      transaction.onabort = () => reject(new Error('Сохранение очереди прервано. Проверьте свободное место на устройстве.'));
    });
  })());
}
export function removeDownload(id) {
  return tracked((async () => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('items', 'readwrite');
      transaction.objectStore('items').delete('download:' + id);
      transaction.objectStore('items').delete('download-manifest:' + id);
      transaction.oncomplete = () => { downloadManifests.delete(id); resolve(); };
      transaction.onerror = () => reject(new Error('Не удалось удалить загрузку. Повторите попытку.'));
    });
  })());
}

export async function listBooks() {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('items', 'readonly');
    const request = transaction.objectStore('items').openCursor(prefixRange('book:'));
    const books = [];
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (String(cursor.key).startsWith('book:')) books.push(cursor.value);
      cursor.continue();
    };
    transaction.oncomplete = () => resolve(books.sort((a, b) => (b.lastRead || b.savedAt || 0) - (a.lastRead || a.savedAt || 0)));
    transaction.onerror = () => reject(new Error('Не удалось загрузить библиотеку с устройства.'));
  });
}

export async function saveBook(book, chapters, branches = []) {
  const key = 'book:' + bookKey(book);
  return update(key, previous => ({ ...previous, book, chapters, branches, savedAt: previous?.savedAt || Date.now(), updatedAt: Date.now() }));
}

const legacyChapterKey = (book, chapter, branchId) => `chapter:${bookKey(book)}:${branchId ?? ''}:${chapter.id ?? chapter.number ?? chapter.index}`;
export const cachedChapterKey = (book, chapter, branchId) => `text:${originKey(chapterOrigin(book, chapter, branchId))}`;
export async function readLegacyChapter(book, chapter, branchId) {
  const key = cachedChapterKey(book, chapter, branchId);
  const current = await get(key);
  if (current) return current;
  const origin = chapterOrigin(book, chapter, branchId);
  // Preserve the previous cache while migrating each chapter on first use.
  const legacy = await get(legacyChapterKey({ source: origin.source, id: origin.bookId }, { id: origin.chapterId }, origin.branchId))
    || await get(legacyChapterKey(book, chapter, branchId));
  if (legacy) await put(key, legacy);
  return legacy;
}
export async function readChapter(book, chapter, branchId) {
  const native = globalThis.window?.gargantua?.downloads;
  if (native) {
    const content = await native.readChapter(originKey(chapterOrigin(book, chapter, branchId)));
    if (content) return content;
  }
  return readLegacyChapter(book, chapter, branchId);
}
export const saveChapter = (book, chapter, branchId, content) => {
  const native = globalThis.window?.gargantua?.downloads;
  return native
    ? tracked(native.saveChapter(originKey(chapterOrigin(book, chapter, branchId)), content))
    : put(cachedChapterKey(book, chapter, branchId), content);
};

export async function getPosition(book) {
  const position = await get('position:' + bookKey(book));
  try {
    const fallback = JSON.parse(localStorage.getItem(ACTIVE_FALLBACK) || 'null');
    if (fallback?.bookKey === bookKey(book) && fallback.position?.updatedAt > (position?.updatedAt || 0)) return fallback.position;
  } catch {}
  return position;
}
export function savePosition(book, position, { activate = true } = {}) {
  const savedPosition = { ...position, updatedAt: Date.now() };
  const active = { bookKey: bookKey(book), position: savedPosition, updatedAt: savedPosition.updatedAt };
  // Synchronous fallback also covers a close arriving during the scroll debounce.
  if (activate) try { localStorage.setItem(ACTIVE_FALLBACK, JSON.stringify(active)); } catch {}
  return tracked((async () => {
    await put('position:' + bookKey(book), savedPosition);
    if (activate) await put('active-reading', active);
    // Do not overwrite a newly extended outline with the reader's older copy.
    await update('book:' + bookKey(book), saved => saved ? { ...saved, lastRead: Date.now(), position: savedPosition } : saved);
  })());
}
export async function getActiveReading() {
  const active = await get('active-reading');
  try {
    const fallback = JSON.parse(localStorage.getItem(ACTIVE_FALLBACK) || 'null');
    if (fallback?.updatedAt > (active?.updatedAt || 0)) return fallback;
  } catch {}
  return active;
}
export async function clearActiveReading() {
  try { localStorage.removeItem(ACTIVE_FALLBACK); } catch {}
  return put('active-reading', null);
}

export const getBookmarks = async book => (await get('bookmarks:' + bookKey(book))) || [];
export async function addBookmark(book, position, name) {
  const bookmarks = await getBookmarks(book);
  const bookmark = { ...position, name: name.trim(), id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`, createdAt: Date.now() };
  await put('bookmarks:' + bookKey(book), [...bookmarks, bookmark]);
  return bookmark;
}
export async function removeBookmark(book, id) {
  return put('bookmarks:' + bookKey(book), (await getBookmarks(book)).filter(bookmark => bookmark.id !== id));
}

export function positionIndex(book, chapters, position, branchId) {
  if (!position) return -1;
  if (position.origin) {
    const found = chapters.findIndex(chapter => originKey(chapterOrigin(book, chapter, branchId)) === originKey(position.origin)
      || (chapter.alternateOrigins || []).some(origin => originKey(origin) === originKey(position.origin)));
    if (found >= 0) return found;
  }
  if (String(position.branchId || '') !== String(branchId || '')) return -1;
  if (position.chapterId !== undefined) return chapters.findIndex((chapter, index) => String(chapter.id ?? chapter.number ?? index) === String(position.chapterId));
  return Number.isInteger(position.chapterIndex) && position.chapterIndex >= 0 && position.chapterIndex < chapters.length ? position.chapterIndex : -1;
}

export async function saveMergedBook(baseBook, mergedBook, chapters, branches = []) {
  const previous = await get('book:' + bookKey(baseBook));
  const existingMerged = bookKey(baseBook) === bookKey(mergedBook) ? previous : await get('book:' + bookKey(mergedBook));
  const migrate = (position, fromBook, oldChapters) => {
    if (!position) return null;
    const oldChapter = oldChapters[position.chapterIndex];
    const origin = position.origin || (oldChapter ? chapterOrigin(fromBook, oldChapter, position.branchId) : null);
    const index = origin ? positionIndex(mergedBook, chapters, { ...position, origin }, position.branchId) : -1;
    return index < 0 ? null : { ...position, origin, chapterIndex: index, chapterId: chapters[index].id ?? chapters[index].number ?? index };
  };
  const baseChapters = previous?.chapters || baseBook.chapters || [];
  const mergedChapters = existingMerged?.chapters || mergedBook.chapters || [];
  const position = [migrate(await getPosition(baseBook), baseBook, baseChapters), migrate(await getPosition(mergedBook), mergedBook, mergedChapters)].filter(Boolean).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
  const bookmarks = (await getBookmarks(baseBook)).map(bookmark => migrate(bookmark, baseBook, baseChapters)).filter(Boolean);
  const existingBookmarks = (await getBookmarks(mergedBook)).map(bookmark => migrate(bookmark, mergedBook, mergedChapters)).filter(Boolean);
  await saveBook(mergedBook, chapters, branches);
  await put('bookmarks:' + bookKey(mergedBook), [...new Map([...bookmarks, ...existingBookmarks].map(bookmark => [bookmark.id, bookmark])).values()]);
  if (position) {
    const previousActive = await getActiveReading();
    await savePosition(mergedBook, position, { activate: previousActive?.bookKey === bookKey(baseBook) || previousActive?.bookKey === bookKey(mergedBook) });
  }
}

export async function removeBook(book) {
  const active = await getActiveReading();
  if (active?.bookKey === bookKey(book)) await clearActiveReading();
  const db = await open();
  const identity = bookKey(book);
  return tracked(new Promise((resolve, reject) => {
    const transaction = db.transaction('items', 'readwrite');
    const store = transaction.objectStore('items');
    store.delete('book:' + identity);
    store.delete('position:' + identity);
    store.delete('bookmarks:' + identity);
    const request = store.openCursor(prefixRange('download:'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (String(cursor.key).startsWith('download:') && (cursor.value?.bookIdentity === identity || cursor.value?.book && bookKey(cursor.value.book) === identity)) {
        store.delete('download-manifest:' + cursor.value.id);
        downloadManifests.delete(cursor.value.id);
        cursor.delete();
      }
      cursor.continue();
    };
    // Origin caches are shared with other editions and merged outlines.
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(new Error('Не удалось удалить книгу. Повторите попытку.'));
  }));
}

export async function flush() { while (pending.size) await Promise.all([...pending]); }
