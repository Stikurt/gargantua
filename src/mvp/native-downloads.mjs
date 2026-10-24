import { bookKey, chapterOrigin, originKey } from './api.mjs';
import { downloadBranch, downloadId, downloadOutlineId } from './download-identity.mjs';

const copy = value => typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
const runnable = job => ['queued', 'downloading', 'waiting'].includes(job.status);
const hasText = value => Array.isArray(value?.paragraphs) ? value.paragraphs.some(line => typeof line === 'string' && line.trim()) : typeof value?.text === 'string' && Boolean(value.text.trim());
const migrationKey = id => 'native-download-migrated:' + id;

/** Android owns requests and durable progress; this adapter only submits UI actions. */
export function createNativeDownloadManager({ bridge, storage, eventTarget = globalThis.window,
  schedule = setTimeout, cancelSchedule = clearTimeout, now = Date.now } = {}) {
  let snapshot = [], initializing, refreshing, stopped = false, timer;
  const listeners = new Set();
  function publish(value) {
    if (!Array.isArray(value)) throw new Error('Не удалось прочитать загрузки Android.');
    snapshot = value.map(job => ({ ...job, native: true }));
    for (const listener of listeners) { try { listener(); } catch {} }
    return snapshot;
  }
  async function refresh() {
    if (stopped) return snapshot;
    if (!refreshing) refreshing = Promise.resolve().then(() => bridge.list()).then(publish).finally(() => { refreshing = undefined; });
    return refreshing;
  }
  function poll() {
    if (stopped || !listeners.size || timer !== undefined) return;
    timer = schedule(async () => {
      timer = undefined;
      if (!eventTarget?.document || eventTarget.document.visibilityState !== 'hidden') await refresh().catch(() => {});
      poll();
    }, 1200);
    timer?.unref?.();
  }
  const changed = () => { void refresh().catch(() => {}); };
  async function copyLegacyCache(book, items, branchId) {
    const read = storage.readLegacyChapter || storage.readChapter;
    for (const item of items) {
      if (stopped) throw new Error('Перенос загрузки продолжится при следующем открытии.');
      const content = await read(book, item.chapter, branchId || undefined);
      if (hasText(content)) await bridge.saveChapter(item.key, content);
    }
  }
  async function init() {
    if (!initializing) initializing = (async () => {
      await refresh();
      const known = new Set(snapshot.map(job => job.id));
      for (const old of await storage.listDownloads()) {
        if (stopped) return snapshot;
        if (!old?.id || !old.book || !Array.isArray(old.items)) continue;
        const identity = old.outlineKey || downloadOutlineId(old.book, old.items.map(item => item.chapter), old.branchId);
        const migrated = await storage.get(migrationKey(old.id));
        if (!known.has(old.id) && migrated !== identity) {
          await copyLegacyCache(old.book, old.items, old.branchId);
          // Imported jobs retain intent but never launch a Service from this call.
          await bridge.enqueue({ ...copy(old), outlineKey: identity, imported: true });
          known.add(old.id);
        }
        await storage.put(migrationKey(old.id), identity);
        await storage.removeDownload(old.id);
      }
      if (!stopped) {
        eventTarget?.addEventListener?.('gargantua-downloads-changed', changed);
        eventTarget?.addEventListener?.('gargantua-resume', changed);
        eventTarget?.addEventListener?.('gargantua-server-changed', changed);
        // Only opening the foreground Activity calls init; paused jobs stay paused.
        if (typeof bridge.start === 'function') await bridge.start();
        await refresh(); poll();
      }
      return snapshot;
    })().catch(error => { initializing = undefined; throw error; });
    return initializing;
  }
  async function enqueue(book, chapters, branchId) {
    await init();
    if (stopped) throw new Error('Откройте приложение снова, чтобы начать загрузку.');
    if (!Array.isArray(chapters) || !chapters.length) throw new Error('В оглавлении пока нет разделов для загрузки.');
    const branch = downloadBranch(book, branchId), id = downloadId(book, branch);
    const items = chapters.map(chapter => {
      const origin = chapterOrigin(book, chapter, branch);
      return { key: originKey(origin), chapter: copy(chapter), origin, status: chapter.available === false ? 'unavailable' : 'pending', error: '', attempts: 0 };
    });
    await copyLegacyCache(book, items, branch);
    const savedBook = copy(book); delete savedBook.chapters;
    const old = snapshot.find(job => job.id === id);
    const job = { id, version: 1, book: savedBook, title: book.title || 'Книга', branchId: branch, items,
      outlineKey: downloadOutlineId(book, chapters, branch), status: 'queued', createdAt: old?.createdAt || now(), updatedAt: now(), retryAt: null,
      currentTitle: '', currentSource: '', currentOrigin: null, error: '' };
    await storage.update?.('book:' + bookKey(book), row => row ? { ...row, downloadBranchId: branch } : row);
    await bridge.enqueue(job);
    await refresh();
    return snapshot.find(value => value.id === id);
  }
  async function action(name, id) {
    await init();
    if (stopped) return;
    // A cancelled migrated legacy job must never reappear after another cold start.
    if (name === 'cancel') await storage.put(migrationKey(id), snapshot.find(job => job.id === id)?.outlineKey || 'legacy');
    await bridge[name](id); await refresh();
  }
  async function shutdown() {
    stopped = true;
    if (timer !== undefined) { cancelSchedule(timer); timer = undefined; }
    for (const name of ['gargantua-downloads-changed', 'gargantua-resume', 'gargantua-server-changed']) eventTarget?.removeEventListener?.(name, changed);
    // The foreground Service is deliberately independent from the closing WebView.
    await storage.flush?.();
  }
  return { init, enqueue, pause: id => action('pause', id), resume: id => action('resume', id), cancel: id => action('cancel', id), shutdown,
    getSnapshot: () => snapshot, subscribe(listener) { listeners.add(listener); if (initializing) poll(); return () => listeners.delete(listener); } };
}
