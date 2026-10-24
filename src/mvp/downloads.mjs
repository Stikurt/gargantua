import { bookKey, chapterOrigin, endpoint, originKey, request as chapterRequest } from './api.mjs';
import * as deviceStorage from './storage.mjs';
import { downloadBranch as branchFor, downloadId, downloadOutlineId } from './download-identity.mjs';
import { createNativeDownloadManager } from './native-downloads.mjs';
export { downloadId, downloadOutlineId } from './download-identity.mjs';


function textPresent(value) {
  return Array.isArray(value?.paragraphs)
    ? value.paragraphs.some(text => typeof text === 'string' && text.trim())
    : Boolean(typeof value?.text === 'string' && value.text.trim());
}
function networkError(error) {
  if ([408, 503, 504].includes(error?.status)) return true;
  if (error?.code) return ['SOURCE_NETWORK', 'SOURCE_TIMEOUT', 'SOURCE_UNAVAILABLE', 'SERVER_OFFLINE'].includes(error.code);
  if (error?.status >= 400) return false;
  return /network|fetch|offline|timeout|timed out|нет связи|нет подключения|недоступен|не отвечает|не ответил|слишком долго|подключени|соединени|ECONN|ENOTFOUND|ETIMEDOUT|socket/i.test(error?.message || '');
}
const rateLimited = error => error?.status === 429 || error?.code === 'SOURCE_RATE_LIMIT';
const messageOf = error => error?.message || String(error || 'Не удалось загрузить раздел.');
const clone = value => typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
const runnable = job => ['queued', 'downloading', 'waiting'].includes(job.status);

/** One polite request at a time. Only committed chapter text counts as downloaded. */
export function createDownloadManager({ storage = deviceStorage, request = chapterRequest, now = Date.now,
  schedule = setTimeout, cancelSchedule = clearTimeout, requestDelayMs = 300, retryDelayMs = 30000 } = {}) {
  const jobs = new Map();
  const sourceCooldowns = new Map(), sourcePacing = new Map();
  const listeners = new Set();
  let snapshot = [];
  let initialized;
  let stopped = false;
  let running = false;
  let timer;
  let epoch = 0;
  let persistence = Promise.resolve();

  function publish() {
    snapshot = [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).map(job => {
      job.total = job.items.length;
      job.downloaded = job.items.filter(item => item.status === 'downloaded').length;
      job.failed = job.items.filter(item => item.status === 'failed').length;
      job.unavailable = job.items.filter(item => item.status === 'unavailable').length;
      const { items, ...summary } = job;
      return clone({ ...summary, failedChapters: items.filter(item => item.status === 'failed').slice(0, 50).map(item => ({ title: item.chapter.title, origin: item.origin, error: item.error })) });
    });
    for (const listener of listeners) { try { listener(); } catch {} }
  }
  function queueWrite(operation) {
    const write = persistence.then(operation);
    persistence = write.catch(() => {});
    return write;
  }
  async function persist(job) {
    job.updatedAt = now();
    publish();
    // Descriptor objects are immutable; checkpoint only copies mutable states.
    const saved = { ...job, items: job.items.map(item => ({ ...item })) };
    try { await queueWrite(() => storage.saveDownload(saved)); }
    catch (error) {
      if (jobs.get(job.id) === job) {
        job.status = 'error'; job.error = 'Загрузка остановлена: ' + messageOf(error); job.currentTitle = ''; job.currentSource = ''; publish();
      }
      throw error;
    }
  }
  function terminal(job) {
    if (job.items.some(item => item.status === 'pending')) return false;
    job.status = job.items.some(item => ['failed', 'unavailable'].includes(item.status)) ? 'partial' : 'complete';
    job.currentTitle = ''; job.currentSource = ''; job.currentOrigin = null;
    job.error = job.status === 'partial' ? 'Сохранены доступные разделы. Некоторые разделы недоступны или требуют повторной загрузки.' : '';
    return true;
  }
  function kick(delay) {
    if (stopped || !initialized || running) return;
    if (timer !== undefined) cancelSchedule(timer);
    const active = [...jobs.values()].filter(runnable);
    if (!active.length) { timer = undefined; return; }
    const next = delay ?? Math.max(0, Math.min(...active.map(job => job.status === 'waiting' ? (job.retryAt || now()) - now() : 0)));
    timer = schedule(() => { timer = undefined; void tick(); }, next);
    timer?.unref?.();
  }
  async function tick() {
    if (running || stopped) return;
    const job = [...jobs.values()].find(value => runnable(value) && (value.status !== 'waiting' || (value.retryAt || 0) <= now()));
    if (!job) { kick(); return; }
    running = true;
    const token = epoch;
    const current = () => !stopped && token === epoch && jobs.get(job.id) === job;
    let requested = false, requestedSource;
    try {
      if (terminal(job)) { await persist(job); return; }
      const item = job.items.find(value => value.status === 'pending');
      job.status = 'downloading'; job.currentTitle = item.chapter.title || `Раздел ${job.items.indexOf(item) + 1}`;
      job.currentOrigin = item.origin; job.currentSource = item.origin.source; job.error = '';
      await persist(job);
      if (!current() || job.status === 'paused') return;
      let content;
      try { content = await storage.readChapter(job.book, item.chapter, job.branchId || undefined); }
      catch (error) { job.status = 'error'; job.error = 'Не удалось прочитать сохранённые разделы: ' + messageOf(error); await persist(job); return; }
      if (!current() || !job.items.includes(item)) return;
      if (job.status === 'paused') return;
      if (!textPresent(content)) {
        const cooldown = Math.max(sourceCooldowns.get(item.origin.source) || 0, job.sourceCooldowns?.[item.origin.source] || 0);
        if (cooldown > now()) {
          job.sourceCooldowns ??= {}; job.sourceCooldowns[item.origin.source] = cooldown;
          job.retryAt = cooldown; job.status = 'waiting';
          job.error = 'Источник просит снизить частоту запросов. Ожидаем разрешённое время продолжения.';
          job.currentTitle = ''; job.currentSource = ''; await persist(job); return;
        }
        requested = true;
        requestedSource = item.origin.source;
        try {
          content = await request(endpoint('/chapter', { source: item.origin.source, id: item.origin.bookId, chapterId: item.origin.chapterId, branchId: item.origin.branchId || undefined }));
          if (!current() || !job.items.includes(item)) return;
          if (!textPresent(content)) throw new Error('Источник вернул раздел без текста.');
        } catch (error) {
          if (!current() || !job.items.includes(item)) return;
          item.error = messageOf(error); item.attempts = (item.attempts || 0) + 1;
          if (rateLimited(error) || networkError(error)) {
            if (job.status !== 'paused') job.status = 'waiting';
            if (rateLimited(error)) {
              const source = item.origin.source;
              job.rateLimitCounts ??= {}; job.sourcePacingMs ??= {}; job.sourceCooldowns ??= {};
              job.rateLimitCounts[source] = (job.rateLimitCounts[source] || 0) + 1;
              const pacing = Math.max(requestDelayMs, sourcePacing.get(source) || 0, Math.min(30000, 1000 * 2 ** Math.min(5, job.rateLimitCounts[source] - 1)));
              job.sourcePacingMs[source] = pacing; sourcePacing.set(source, pacing);
              const delay = Number.isFinite(error.retryAfterMs) && error.retryAfterMs >= 0 ? Math.max(1000, error.retryAfterMs) : 60000;
              job.retryAt = Math.max(sourceCooldowns.get(source) || 0, now() + delay);
              job.sourceCooldowns[source] = job.retryAt; sourceCooldowns.set(source, job.retryAt);
            } else job.retryAt = now() + Math.min(300000, retryDelayMs * 2 ** Math.min(4, item.attempts - 1));
            job.error = item.error; job.currentTitle = ''; job.currentSource = ''; await persist(job); return;
          }
          item.status = 'failed';
          if (job.status !== 'paused') { job.status = 'queued'; terminal(job); }
          job.error = item.error; job.currentTitle = ''; job.currentSource = ''; await persist(job); return;
        }
        // Commit the text before updating progress; a quota error must not become a success.
        try { await storage.saveChapter(job.book, item.chapter, job.branchId || undefined, content); }
        catch (error) {
          if (!current()) return;
          job.status = 'error'; job.error = 'Загрузка остановлена: ' + messageOf(error); job.currentTitle = ''; job.currentSource = ''; await persist(job); return;
        }
      }
      if (!current() || !job.items.includes(item)) return;
      item.status = 'downloaded'; item.error = ''; job.retryAt = null;
      job.currentTitle = ''; job.currentSource = ''; job.currentOrigin = null;
      if (job.status !== 'paused') { job.status = 'queued'; terminal(job); }
      await persist(job);
    } catch { /* persist() already exposes storage failure and stops this job. */ }
    finally { running = false; kick(job.status === 'waiting' ? undefined : requested ? Math.max(requestDelayMs, sourcePacing.get(requestedSource) || 0, job.sourcePacingMs?.[requestedSource] || 0) : 0); }
  }

  async function init() {
    if (!initialized) initialized = (async () => {
      for (const stored of await storage.listDownloads()) {
        if (!stored?.id || !stored.book || !Array.isArray(stored.items)) continue;
        const job = clone(stored);
        for (const [source, until] of Object.entries(job.sourceCooldowns || {})) if (Number.isFinite(until)) sourceCooldowns.set(source, Math.max(sourceCooldowns.get(source) || 0, until));
        for (const [source, pacing] of Object.entries(job.sourcePacingMs || {})) if (Number.isFinite(pacing)) sourcePacing.set(source, Math.max(sourcePacing.get(source) || 0, pacing));
        if (runnable(job)) { job.status = job.retryAt > now() ? 'waiting' : 'queued'; job.currentTitle = ''; job.currentSource = ''; job.currentOrigin = null; }
        jobs.set(job.id, job);
      }
      publish(); kick();
      return snapshot;
    })();
    return initialized;
  }
  async function enqueue(book, chapters, branchId) {
    await init();
    if (stopped) throw new Error('Загрузка уже завершается. Откройте приложение снова.');
    if (!Array.isArray(chapters) || !chapters.length) throw new Error('В оглавлении пока нет разделов для загрузки.');
    const branch = branchFor(book, branchId);
    const id = downloadId(book, branch);
    const old = jobs.get(id);
    const previous = new Map((old?.items || []).map(item => [item.key, item]));
    const items = chapters.map(chapter => {
      const origin = chapterOrigin(book, chapter, branch);
      const key = originKey(origin);
      const prior = previous.get(key);
      return { key, chapter: clone(chapter), origin, status: chapter.available === false ? 'unavailable' : prior?.status === 'downloaded' ? 'downloaded' : 'pending', error: '', attempts: prior?.status === 'pending' ? prior.attempts || 0 : 0 };
    });
    // A replacement object invalidates any result still in flight for an older outline.
    const savedBook = clone(book);
    delete savedBook.chapters;
    const job = { id, version: 1, book: savedBook, title: book.title || 'Книга', branchId: branch, items,
      outlineKey: downloadOutlineId(book, chapters, branch), status: old?.retryAt > now() ? 'waiting' : 'queued', currentTitle: '', currentSource: '', currentOrigin: null,
      sourcePacingMs: clone(old?.sourcePacingMs || {}), sourceCooldowns: clone(old?.sourceCooldowns || {}), rateLimitCounts: clone(old?.rateLimitCounts || {}),
      error: '', createdAt: old?.createdAt || now(), updatedAt: now(), retryAt: old?.retryAt > now() ? old.retryAt : null };
    if (storage.update) await storage.update('book:' + bookKey(book), row => row ? { ...row, downloadBranchId: branch } : row);
    jobs.set(id, job); terminal(job);
    await persist(job); kick();
    return snapshot.find(value => value.id === id);
  }
  async function pause(id) {
    await init();
    const job = jobs.get(id);
    if (!job || ['complete', 'partial', 'error'].includes(job.status)) return;
    job.status = 'paused'; job.currentTitle = ''; job.currentSource = ''; await persist(job); kick();
  }
  async function resume(id) {
    await init();
    if (stopped) return;
    const job = jobs.get(id);
    if (!job) return;
    for (const item of job.items) if (item.status === 'failed') { item.status = 'pending'; item.error = ''; item.attempts = 0; }
    job.status = job.retryAt > now() ? 'waiting' : 'queued';
    if (job.status !== 'waiting') { job.error = ''; job.retryAt = null; }
    terminal(job);
    await persist(job); kick();
  }
  async function cancel(id) {
    await init();
    jobs.delete(id); publish();
    await queueWrite(() => storage.removeDownload(id)); kick();
  }
  async function shutdown() {
    stopped = true; epoch++;
    if (timer !== undefined) { cancelSchedule(timer); timer = undefined; }
    if (!initialized) return;
    await initialized;
    // Store resumable state without waiting for a potentially stalled native request.
    for (const job of jobs.values()) {
      if (runnable(job)) { job.status = job.retryAt > now() ? 'waiting' : 'queued'; job.currentTitle = ''; job.currentSource = ''; job.currentOrigin = null; await persist(job).catch(() => {}); }
    }
    await persistence;
  }
  return { init, enqueue, pause, resume, cancel, shutdown, getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
}

const nativeDownloads = globalThis.window?.gargantua?.downloads;
export const downloads = nativeDownloads
  ? createNativeDownloadManager({ bridge: nativeDownloads, storage: deviceStorage })
  : createDownloadManager();
