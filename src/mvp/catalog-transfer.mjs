import { authorName, bookKey, chapterOrigin, originKey, sourceName } from './api.mjs';
import * as deviceStorage from './storage.mjs';
import { libraryOrganization } from './library-organization.mjs';

export const CATALOG_FORMAT = 'gargantua-catalog';
export const CATALOG_LIMITS = Object.freeze({ books: 1000, chapters: 50000, manifestBytes: 8 * 1024 * 1024 });
const sources = new Set(['ranobelib', 'ranobeme', 'ranobehub', 'libcat', 'litlife', 'wikisource', 'gutenberg', 'merged', 'catalog']);
const cleanText = (value, maximum = 500) => String(value ?? '').replace(/https?:\/\/\S+/giu, '').replace(/\b(?:[a-z0-9-]+\.)+ts\.net\b/giu, '').replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().replace(/\s+/gu, ' ').slice(0, maximum);
const fail = message => { throw Object.assign(new Error(message), { code: 'CATALOG_INVALID' }); };
const assert = (condition, message) => { if (!condition) fail(message); };
const present = value => Array.isArray(value?.paragraphs) ? value.paragraphs.some(text => typeof text === 'string' && text.trim()) : typeof value?.text === 'string' && Boolean(value.text.trim());
const branchFor = row => row.book.source === 'merged' || row.book.localCatalog ? '' : String(row.position?.branchId ?? row.downloadBranchId ?? row.book.defaultBranchId ?? row.branches?.[0]?.id ?? '');

function safeOrigin(value) {
  assert(value && sources.has(value.source) && value.source !== 'merged', 'В каталоге указан неизвестный источник главы.');
  const origin = { source: value.source, bookId: String(value.bookId ?? ''), chapterId: String(value.chapterId ?? ''), branchId: String(value.branchId ?? '') };
  assert(origin.bookId && origin.chapterId && [origin.bookId, origin.chapterId, origin.branchId].every(value => value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value) && !/https?:\/\//iu.test(value)), 'В каталоге неверный адрес главы.');
  return origin;
}

function safeBook(value) {
  assert(value && sources.has(value.source), 'В каталоге указан неизвестный источник книги.');
  const id = String(value.id ?? '');
  assert(id && id.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(id) && !/https?:\/\//iu.test(id), 'В каталоге неверный идентификатор книги.');
  const title = cleanText(value.title);
  assert(title, 'В каталоге у книги отсутствует название.');
  return { source: value.source, id, title, author: cleanText(authorName(value)), kind: value.kind === 'novel' ? 'novel' : 'book', language: cleanText(value.language, 40), sourceName: cleanText(sourceName(value), 80) };
}

function safeChapter(value, origin, index) {
  const id = String(value?.id ?? value?.number ?? index);
  assert(id.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(id), 'В каталоге неверный номер главы.');
  return { id, ...(typeof value?.number === 'number' || typeof value?.number === 'string' ? { number: cleanText(value.number, 80) } : {}), title: cleanText(value?.title) || `Раздел ${index + 1}`, available: value?.available !== false, origin };
}

/** Rebuild a whitelist-only manifest; neither settings nor reading history pass through. */
export function validateCatalogManifest(value) {
  assert(value?.format === CATALOG_FORMAT && value.schemaVersion === 1, 'Это не поддерживаемый каталог Гаргантюа.');
  assert(Array.isArray(value.books) && value.books.length > 0 && value.books.length <= CATALOG_LIMITS.books, 'В каталоге должно быть от 1 до 1000 книг.');
  let chapterCount = 0, cachedChapterCount = 0;
  const bookKeys = new Set(), cachedOrigins = new Set();
  const books = value.books.map(entry => {
    const book = safeBook(entry?.book), identity = bookKey(book);
    assert(!bookKeys.has(identity), 'В каталоге повторяется одна и та же книга.'); bookKeys.add(identity);
    assert(Array.isArray(entry.chapters), 'В каталоге отсутствует оглавление книги.');
    chapterCount += entry.chapters.length;
    assert(chapterCount <= CATALOG_LIMITS.chapters, 'В каталоге больше 50 000 разделов.');
    const chapters = entry.chapters.map((chapter, index) => safeChapter(chapter, safeOrigin(chapter?.origin), index));
    const chapterKeys = chapters.map(chapter => originKey(chapter.origin));
    assert(new Set(chapterKeys).size === chapterKeys.length, 'В оглавлении книги повторяется одна и та же глава.');
    assert(Array.isArray(entry.chapterKeys) && JSON.stringify(entry.chapterKeys) === JSON.stringify(chapterKeys), 'Оглавление каталога не совпадает с адресами глав.');
    assert(Array.isArray(entry.cachedChapterKeys) && new Set(entry.cachedChapterKeys).size === entry.cachedChapterKeys.length, 'В каталоге неверный список сохранённых глав.');
    const allowed = new Set(chapterKeys);
    assert(entry.cachedChapterKeys.every(key => typeof key === 'string' && allowed.has(key)), 'В каталоге есть текст без главы в оглавлении.');
    const cachedSet = new Set(entry.cachedChapterKeys), cachedChapterKeys = chapterKeys.filter(key => cachedSet.has(key));
    cachedChapterCount += cachedChapterKeys.length;
    for (const key of cachedChapterKeys) cachedOrigins.add(key);
    return { book, chapters, branches: [], downloadBranchId: '', chapterKeys, cachedChapterKeys };
  });
  assert(value.chapterCount === chapterCount && value.cachedChapterCount === cachedChapterCount, 'Количество разделов в каталоге не совпадает с оглавлением.');
  const manifest = { format: CATALOG_FORMAT, schemaVersion: 1, name: cleanText(value.name, 80) || 'Открытый каталог', createdAt: typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt)) ? new Date(value.createdAt).toISOString() : new Date().toISOString(), books, chapterCount, cachedChapterCount, uniqueCachedChapterCount: cachedOrigins.size };
  assert(new TextEncoder().encode(JSON.stringify(manifest)).length <= CATALOG_LIMITS.manifestBytes, 'Оглавление каталога больше 8 МБ. Разделите книги на несколько папок.');
  return manifest;
}

export async function prepareCatalog({ name, rows, storage = deviceStorage, native = globalThis.window?.gargantua, onProgress = () => {}, now = Date.now }) {
  assert(Array.isArray(rows) && rows.length > 0 && rows.length <= CATALOG_LIMITS.books, 'Выберите папку, в которой есть книги. В одном файле может быть не больше 1000 книг.');
  const total = rows.reduce((count, row) => count + (row.chapters?.length || 0), 0);
  assert(total <= CATALOG_LIMITS.chapters, 'В папке больше 50 000 разделов. Разделите её перед сохранением.');
  let processed = 0, cached = 0, previousProgress = 0;
  const books = [], seen = new Set();
  onProgress({ stage: 'preparing', processed, total, cached });
  for (const row of rows) {
    const book = safeBook(row.book), identity = bookKey(book);
    assert(!seen.has(identity), 'Одна и та же книга добавлена в каталог дважды.'); seen.add(identity);
    const branchId = branchFor(row), chapters = [], chapterKeys = [], cachedChapterKeys = [];
    for (const [index, chapter] of (row.chapters || []).entries()) {
      const origin = safeOrigin(chapterOrigin(row.book, chapter, branchId)), key = originKey(origin);
      chapters.push(safeChapter(chapter, origin, index)); chapterKeys.push(key);
      const content = await storage.readChapter(row.book, chapter, branchId);
      if (present(content)) {
        // Migrate legacy IndexedDB text before native ZIP reads its own committed cache.
        if (native?.downloads?.saveChapter) await native.downloads.saveChapter(key, content);
        cachedChapterKeys.push(key); cached++;
      }
      processed++;
      if (processed === total || now() - previousProgress > 100) { onProgress({ stage: 'preparing', processed, total, cached }); previousProgress = now(); }
    }
    books.push({ book, chapters, branches: [], downloadBranchId: '', chapterKeys, cachedChapterKeys });
  }
  return validateCatalogManifest({ format: CATALOG_FORMAT, schemaVersion: 1, name, createdAt: new Date(now()).toISOString(), books, chapterCount: total, cachedChapterCount: cached });
}

export async function exportCatalog(options) {
  const native = options.native || globalThis.window?.gargantua;
  assert(typeof native?.catalogs?.export === 'function', 'Сохранение каталогов доступно в Android-приложении.');
  const manifest = await prepareCatalog({ ...options, native });
  options.onProgress?.({ stage: 'saving', processed: manifest.chapterCount, total: manifest.chapterCount, cached: manifest.cachedChapterCount });
  const result = await native.catalogs.export(manifest, { share: Boolean(options.share) });
  return { ...result, bookCount: manifest.books.length, chapterCount: result?.chapterCount ?? manifest.chapterCount, cachedChapterCount: result?.cachedChapterCount ?? manifest.cachedChapterCount, name: manifest.name };
}

export async function importCatalog({ native = globalThis.window?.gargantua, storage = deviceStorage, organization = libraryOrganization, onProgress = () => {} } = {}) {
  assert(typeof native?.catalogs?.import === 'function', 'Открытие каталогов доступно в Android-приложении.');
  onProgress({ stage: 'opening', processed: 0, total: 0, cached: 0 });
  // Native validates ZIP paths, limits and every hash, rejects conflicting cache,
  // then atomically commits chapter text before returning this manifest.
  const manifest = validateCatalogManifest(await native.catalogs.import());
  const existing = new Map((await storage.listBooks()).map(row => [bookKey(row.book), row]));
  const created = [], imported = [], extended = [];
  let reusedBooks = 0, skippedOutlineUpdates = 0;
  try {
    for (const [index, entry] of manifest.books.entries()) {
      const identity = bookKey(entry.book), previous = existing.get(identity);
      if (previous) {
        reusedBooks++;
        const oldKeys = (previous.chapters || []).map(chapter => originKey(chapterOrigin(previous.book, chapter, branchFor(previous))));
        const same = JSON.stringify(oldKeys) === JSON.stringify(entry.chapterKeys);
        const prefix = oldKeys.length > 0 && oldKeys.length < entry.chapterKeys.length && oldKeys.every((key, index) => entry.chapterKeys[index] === key);
        if (prefix) {
          await storage.saveBook(previous.book, [...previous.chapters, ...entry.chapters.slice(oldKeys.length)], previous.branches || []);
          extended.push(identity);
        } else if (!same) skippedOutlineUpdates++;
        imported.push(previous.book);
      } else {
        const cached = new Set(entry.cachedChapterKeys);
        const book = { ...entry.book, localCatalog: true, defaultBranchId: '', chapterCount: entry.chapters.length, catalogCache: { total: entry.chapters.length, cached: entry.cachedChapterKeys.length } };
        await storage.saveBook(book, entry.chapters.map((chapter, index) => ({ ...chapter, catalogCached: cached.has(entry.chapterKeys[index]) })), []);
        created.push(book); imported.push(book);
      }
      onProgress({ stage: 'importing', processed: index + 1, total: manifest.books.length, cached: manifest.cachedChapterCount });
    }
    const state = await organization.importFolder(manifest.name, imported);
    return { name: state.folders.find(folder => folder.id === state.selectedFolder)?.name || manifest.name, organization: state, bookCount: imported.length, newBooks: created.length, reusedBooks, extendedOutlines: extended.length, skippedOutlineUpdates, chapterCount: manifest.chapterCount, cachedChapterCount: manifest.cachedChapterCount };
  } catch (error) {
    // Only newly-created rows are rolled back; old editions and shared text stay.
    await Promise.allSettled(created.map(book => storage.removeBook(book)));
    throw error;
  }
}
