import React, { useEffect, useMemo, useRef, useState } from 'react';
import { authorName, bookKey, chapterOrigin, endpoint, originKey, registerSources, request, savedSources, sourceName, sourceNames } from './api.mjs';
import * as storage from './storage.mjs';
import { downloads, downloadId, downloadOutlineId } from './downloads.mjs';
import './mvp.css';

const CATALOGS = [
  { id: 'ranobelib', name: 'RanobeLib', kind: 'novel', description: 'Ранобэ и веб-новеллы' },
  { id: 'wikisource', name: 'Викитека', kind: 'book', description: 'Книги на русском' },
  { id: 'gutenberg', name: 'Project Gutenberg', kind: 'book', description: 'Мировая классика' },
];
const TYPES = [['all', 'Всё'], ['book', 'Книги'], ['novel', 'Новеллы']];
const textOf = error => error?.message || 'Не удалось выполнить действие. Повторите попытку.';
const chapterId = (chapter, index) => chapter.id ?? chapter.number ?? index;
const chapterName = (chapter, index) => chapter.title || `Глава ${chapter.number ?? index + 1}`;
const normalizeBook = value => value?.book ? { ...value.book, ...value, book: undefined } : value;
const mergeChapterKey = chapter => chapter.mergeKey || originKey(chapter.origin || {});
function extendMergedBook(existing, incoming) {
  if (!existing || existing.source !== 'merged') return incoming;
  const outline = new Map((existing.chapters || []).map(chapter => [mergeChapterKey(chapter), chapter]));
  const order = new Map((existing.chapters || []).map((chapter, index) => [mergeChapterKey(chapter), index]));
  const families = new Map();
  for (const chapter of existing.chapters || []) if (chapter.coordinateKey) {
    if (!families.has(chapter.coordinateKey)) families.set(chapter.coordinateKey, []);
    families.get(chapter.coordinateKey).push(chapter);
  }
  let incompatibleParts = 0;
  for (const chapter of incoming.chapters || []) {
    const key = mergeChapterKey(chapter);
    const previous = outline.get(key);
    if (!previous) {
      const family = families.get(chapter.coordinateKey) || [];
      if (family.some(value => value.part == null || chapter.part == null)) { incompatibleParts++; continue; }
      outline.set(key, chapter);
      if (chapter.coordinateKey) families.set(chapter.coordinateKey, [...family, chapter]);
    }
    else {
      const chosen = previous.available === false && chapter.available !== false ? chapter : previous;
      outline.set(key, { ...chapter, ...chosen, alternateOrigins: [...new Map([...(previous.alternateOrigins || []), ...(chapter.alternateOrigins || []), previous.origin, chapter.origin].filter(Boolean).map(origin => [originKey(origin), origin])).values()].filter(origin => originKey(origin) !== originKey(chosen.origin)) });
    }
  }
  const coordinates = chapter => {
    const key = chapter.mergeKey || '';
    if (key.startsWith('g:')) return [0, Number(key.split(':')[1]), Number(chapter.part ?? 0)];
    if (key.startsWith('v:')) return [Number(key.split(':')[1]), Number(key.split(':')[2]), Number(chapter.part ?? 0)];
    if (key.startsWith('coord:')) return [...key.slice(6).split(':').map(Number), Number(chapter.part ?? 0)];
    return null;
  };
  const chapters = [...outline.values()].sort((a, b) => {
    const left = coordinates(a), right = coordinates(b);
    if (!left && !right) return (order.get(mergeChapterKey(a)) ?? Infinity) - (order.get(mergeChapterKey(b)) ?? Infinity);
    if (!left) return (order.get(mergeChapterKey(a)) ?? Infinity) < 3 ? -1 : 1;
    if (!right) return (order.get(mergeChapterKey(b)) ?? Infinity) < 3 ? 1 : -1;
    return (left[0] - right[0]) || (left[1] - right[1]) || (left[2] - right[2]);
  });
  const contributors = [...new Map([...(existing.contributors || []), ...(incoming.contributors || [])].map(value => [bookKey(value), value])).values()];
  const warnings = [...new Set([...(existing.warnings || []), ...(incoming.warnings || []), ...(incompatibleParts ? [`Из другого издания пропущено ${incompatibleParts} записей: целая глава и её отдельные части не заменяют друг друга.`] : [])])];
  return { ...existing, ...incoming, chapters, contributors, chapterCount: chapters.length, warnings };
}
const initialBranch = (book, saved) => {
  const branches = Array.isArray(book.branches) ? book.branches : [];
  const previous = saved?.position?.branchId ?? saved?.downloadBranchId;
  if (previous !== undefined && previous !== null && (!branches.length || branches.some(branch => String(branch.id) === String(previous)))) return String(previous);
  return String(book.defaultBranchId ?? branches[0]?.id ?? '');
};
const bookDownloadBranch = (book, saved) => book.source === 'merged' ? '' : String(saved?.position?.branchId ?? saved?.downloadBranchId ?? initialBranch(book, saved));
const activeDownload = job => ['queued', 'downloading', 'waiting'].includes(job?.status);
const downloadPercent = job => Math.min(100, Math.floor((job?.downloaded || 0) / Math.max(1, job?.total || 0) * 100));
const downloadStatus = job => ({
  queued: 'В очереди', downloading: 'Скачиваем', paused: 'На паузе', waiting: 'Ожидание · продолжим автоматически',
  partial: 'Скачано частично', complete: 'Вся книга доступна без интернета', error: 'Загрузка остановлена',
}[job?.status] || 'Не скачана');

function Icon({ name, size = 20, ...props }) {
  const paths = {
    book: 'M4 4h5a4 4 0 0 1 3 1.4A4 4 0 0 1 15 4h5v15h-5a4 4 0 0 0-3 1.4A4 4 0 0 0 9 19H4z M12 5.4v15',
    search: 'M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15 M16 16l5 5',
    library: 'M4 4v16 M9 4v16 M14 4v16 M18 4l3 16',
    shuffle: 'M3 6h3c4 0 8 12 12 12h3 M17 14l4 4-4 4 M3 18h3c1.3 0 2.6-1.3 4-3.3 M14 9.3C15.4 7.3 16.7 6 18 6h3 M17 2l4 4-4 4',
    arrow: 'M14 5l-7 7 7 7',
    next: 'M10 5l7 7-7 7',
    close: 'M6 6l12 12 M6 18L18 6',
    check: 'M5 12l4 4L19 6',
    plus: 'M12 5v14 M5 12h14',
    external: 'M14 3h7v7 M10 14L21 3 M10 3H4v17h17v-6',
    refresh: 'M20 10a8 8 0 1 0-1 7 M20 4v6h-6',
    list: 'M8 6h13 M8 12h13 M8 18h13 M3 6h.01 M3 12h.01 M3 18h.01',
    device: 'M3 4h18v13H3z M8 21h8 M12 17v4',
    alert: 'M12 3L2 21h20z M12 9v5 M12 17h.01',
    trash: 'M4 6h16 M9 6V3h6v3 M6 6l1 15h10l1-15 M10 10v7 M14 10v7',
    sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1.5 1.5 M17.5 17.5L19 19 M5 19l1.5-1.5 M17.5 6.5L19 5',
    bookmark: 'M6 3h12v18l-6-4-6 4z',
    download: 'M12 3v12 M7 10l5 5 5-5 M4 16v5h16v-5',
    pause: 'M8 5v14 M16 5v14',
    settings: 'M4 7h16 M4 17h16 M8 4v6 M16 14v6',
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}><path d={paths[name] || paths.book} /></svg>;
}

function Spinner({ small = false }) { return <span className={`mvp-spinner${small ? ' small' : ''}`} aria-hidden="true" />; }

function Notice({ children, error = false, action }) {
  return <div className={`mvp-notice${error ? ' error' : ''}`} role={error ? 'alert' : 'status'}><Icon name={error ? 'alert' : 'device'} size={18} /><div>{children}</div>{action}</div>;
}

function Cover({ book, small = false }) {
  const letters = (book.title || 'Г').split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]).join('').toUpperCase();
  const tone = [...String(book.id || book.title)].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 5;
  return <div className={`mvp-cover tone-${tone}${small ? ' small' : ''}`} aria-hidden="true"><span className="mvp-cover-rule" /><span className="mvp-cover-monogram">{letters}</span><span className="mvp-cover-type">{book.kind === 'novel' ? 'НОВЕЛЛА' : 'КНИГА'}</span><span className="mvp-cover-mark">Г.</span></div>;
}

function BookCard({ book, saved, onOpen, onContinue, library = false, downloadJob, onDownload }) {
  const position = saved?.position;
  return <article className="mvp-book-card" data-testid={library ? 'library-book' : 'book-card'} data-source={book.source} data-book-id={book.id}>
    <button type="button" className="mvp-card-open" onClick={() => onOpen(book)} data-testid={library ? 'open-library-book' : 'open-book'} aria-label={`Открыть книгу ${book.title}`}>
      <Cover book={book} />
      <div className="mvp-card-body"><div className="mvp-card-kind"><span>{sourceName(book)}</span>{saved && <span className="mvp-saved-dot" title="В библиотеке"><Icon name="check" size={13} /></span>}</div><h3>{book.title}</h3><p className="mvp-card-author">{authorName(book)}</p><div className="mvp-card-meta"><span>{book.kind === 'novel' ? 'Новелла' : 'Книга'}</span>{book.language && <span>{book.language.toUpperCase()}</span>}{library && position && <span>Раздел {position.chapterIndex + 1}</span>}</div></div>
    </button>
    <div className="mvp-card-bottom"><span>{library ? saved?.lastRead ? 'Вы уже читаете' : 'В вашей библиотеке' : book.description ? book.description.replace(/<[^>]*>/g, '').slice(0, 110) : 'Открыть описание и главы'}</span><Icon name="next" size={16} /></div>
    {library && position && <button type="button" className="mvp-card-continue" data-testid="continue-reading" onClick={() => onContinue(saved)}><Icon name="bookmark" size={15} />Продолжить чтение<span>Раздел {position.chapterIndex + 1}</span></button>}
    {library && <div className="mvp-card-download"><span className={downloadJob?.status === 'complete' ? 'mvp-offline-badge complete' : 'mvp-offline-badge'} data-testid="offline-badge" data-status={downloadJob?.status || 'none'}><Icon name={downloadJob?.status === 'complete' ? 'check' : 'device'} size={13} />{downloadJob ? downloadJob.status === 'complete' ? 'Вся книга без интернета' : `${downloadJob.downloaded || 0} из ${downloadJob.total} · ${downloadStatus(downloadJob)}` : 'Полная книга ещё не скачана'}</span><button type="button" className="mvp-text-button" data-testid="download-library-book" onClick={() => onDownload(saved)}><Icon name="download" size={14} />{downloadJob ? 'Открыть загрузку' : 'Скачать целиком'}</button></div>}
  </article>;
}

function DownloadProgress({ job, compact = false }) {
  return <div className={`mvp-download-progress${compact ? ' compact' : ''}`}>
    <div className="mvp-download-count"><span>{job.downloaded || 0} из {job.total || 0} разделов</span><strong>{downloadPercent(job)}%</strong></div>
    <progress data-testid="download-progress" aria-label={`Скачано ${job.downloaded || 0} из ${job.total || 0} разделов`} value={job.downloaded || 0} max={Math.max(1, job.total || 0)} />
    <p data-testid="download-status" className={['error', 'partial'].includes(job.status) ? 'has-problem' : ''}>{downloadStatus(job)}</p>
  </div>;
}

function DownloadPanel({ jobs, error, onClose, onAction, onOpen }) {
  const panelRef = useRef(null);
  useDialogFocus(panelRef, onClose);
  return <div className="mvp-dialog-backdrop mvp-download-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={panelRef} className="mvp-download-panel" role="dialog" aria-modal="true" aria-label="Скачивание книг" data-testid="download-panel">
      <header className="mvp-dialog-top"><div><span className="mvp-eyebrow">НА ЭТОМ УСТРОЙСТВЕ</span><h2>Загрузки</h2></div><button type="button" className="mvp-icon-button" data-autofocus data-testid="close-download-panel" aria-label="Закрыть загрузки" onClick={onClose}><Icon name="close" /></button></header>
      <div className="mvp-download-scroll"><p className="mvp-download-hint">Скачаем все разделы по порядку, включая объединённые источники. Можно читать и закрывать окно: после запуска продолжим с сохранённого места.</p>{error && <Notice error>{error}</Notice>}
        {!jobs.length ? <EmptyState icon="download" title="Книги с вами без интернета">Откройте карточку книги и нажмите «Скачать целиком». Уже сохранённые главы повторно не загружаются.</EmptyState> : jobs.map(job => <article className="mvp-download-job" data-testid="download-job" data-job-id={job.id} data-source={job.book.source} data-book-id={job.book.id} data-status={job.status} data-downloaded={job.downloaded || 0} data-total={job.total || 0} data-failed={job.failed || 0} data-unavailable={job.unavailable || 0} key={job.id}>
          <div className="mvp-download-heading"><div><span className="mvp-source-label">{sourceName(job.book)}{job.branchName ? ` · ${job.branchName}` : ''}</span><h3>{job.title || job.book.title}</h3></div><Icon name={job.status === 'complete' ? 'check' : 'download'} size={21} /></div>
          <DownloadProgress job={job} />
          {activeDownload(job) && job.currentTitle && <p className="mvp-download-current" data-testid="download-current">{job.currentSource || job.currentOrigin?.source ? `${sourceName({ source: job.currentSource || job.currentOrigin?.source })} · ` : ''}{job.currentTitle}</p>}
          {Boolean(job.failed || job.unavailable) && <p className="mvp-download-problem" data-testid="download-problem">{job.failed ? `Не удалось скачать: ${job.failed}. ` : ''}{job.unavailable ? `Недоступно в источнике: ${job.unavailable}. Откройте карточку позднее, чтобы обновить оглавление. ` : ''}Книга пока доступна без интернета не целиком.</p>}
          {job.error && <p className="mvp-download-problem" data-testid="download-error">{job.error}</p>}
          <div className="mvp-download-actions">{activeDownload(job) ? <button type="button" className="mvp-button secondary" data-testid="download-pause" onClick={() => onAction('pause', job.id)}><Icon name="pause" size={15} />Пауза</button> : job.status !== 'complete' && (job.status !== 'partial' || job.failed > 0) && <button type="button" className="mvp-button primary" data-testid="download-resume" onClick={() => onAction('resume', job.id)}><Icon name="refresh" size={15} />{job.status === 'paused' ? 'Продолжить' : 'Повторить недостающие'}</button>}<button type="button" className="mvp-button secondary" data-testid="download-open-book" onClick={() => onOpen(job.book)}>Открыть книгу<Icon name="next" size={15} /></button>{job.status !== 'complete' && <button type="button" className="mvp-text-button" data-testid="download-cancel" onClick={() => onAction('cancel', job.id)}>Отменить загрузку</button>}</div>
        </article>)}
      </div><footer className="mvp-download-footer"><Icon name="device" size={16} /><span>Пауза и отмена сохраняют скачанный текст. Удалить книгу можно в библиотеке.</span></footer>
    </section>
  </div>;
}

function EmptyState({ icon = 'search', title, children, action }) {
  return <div className="mvp-empty"><span className="mvp-empty-icon"><Icon name={icon} size={31} /></span><h2>{title}</h2><p>{children}</p>{action}</div>;
}

function useDialogFocus(ref, onClose, active = true) {
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement;
    const timer = setTimeout(() => ref.current?.querySelector('[data-autofocus]')?.focus(), 0);
    const keydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); close.current(); }
      if (event.key !== 'Tab' || !ref.current) return;
      const elements = [...ref.current.querySelectorAll('button:not(:disabled),a[href],select,input,[tabindex="0"]')].filter(element => element.getClientRects().length);
      if (!elements.length) return;
      if (event.shiftKey && document.activeElement === elements[0]) { event.preventDefault(); elements.at(-1).focus(); }
      else if (!event.shiftKey && document.activeElement === elements.at(-1)) { event.preventDefault(); elements[0].focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { clearTimeout(timer); document.removeEventListener('keydown', keydown); previous?.focus?.(); };
  }, [active]);
}

function BookDialog({ candidate, saved, onClose, onSave, onRead, onMerged, onOpenAlternative, jobs, onDownload, suspended }) {
  const [book, setBook] = useState(candidate);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [cached, setCached] = useState(false);
  const [saving, setSaving] = useState(false);
  const [opening, setOpening] = useState(false);
  const [branchId, setBranchId] = useState('');
  const [visibleCount, setVisibleCount] = useState(24);
  const [retry, setRetry] = useState(0);
  const [related, setRelated] = useState(null);
  const [relatedBusy, setRelatedBusy] = useState(false);
  const [relatedError, setRelatedError] = useState('');
  const [mergeBusy, setMergeBusy] = useState('');
  const [mergePreview, setMergePreview] = useState(null);
  const [downloading, setDownloading] = useState(false);
  const dialogRef = useRef(null);
  useDialogFocus(dialogRef, onClose, !suspended);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(''); setCached(false);
    if (candidate.source === 'merged') {
      const detail = { ...candidate, ...saved?.book, chapters: saved?.chapters || candidate.chapters || [], branches: [] };
      setBook(detail); setBranchId(''); setLoading(false);
      return () => { active = false; };
    }
    request(endpoint('/book', { source: candidate.source, id: candidate.id })).then(value => {
      if (!active) return;
      const detail = { ...candidate, ...normalizeBook(value) };
      setBook(detail); setBranchId(initialBranch(detail, saved));
    }).catch(async error => {
      const local = saved || await storage.get('book:' + bookKey(candidate)).catch(() => null);
      if (!active) return;
      if (local) { const detail = { ...local.book, chapters: local.chapters, branches: local.branches }; setBook(detail); setBranchId(initialBranch(detail, local)); setCached(true); }
      else setError(textOf(error));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [candidate.source, candidate.id, retry]);
  const chapters = Array.isArray(book.chapters) ? book.chapters : [];
  const branches = Array.isArray(book.branches) ? book.branches : [];
  const available = chapters.some(chapter => chapter.available !== false);
  const downloadBranch = book.source === 'merged' ? '' : branchId;
  const previousDownloadJob = jobs.find(job => job.id === downloadId(book, downloadBranch));
  const downloadJob = previousDownloadJob?.outlineKey === downloadOutlineId(book, chapters, downloadBranch) ? previousDownloadJob : undefined;
  async function findRelated() {
    setRelatedBusy(true); setRelatedError(''); setMergePreview(null);
    const base = book.mergeBase || book;
    try { setRelated(await request(endpoint('/related', { source: base.source, id: base.id, title: book.title, branchId: base.branchId ?? branchId }))); }
    catch (error) { setRelatedError(textOf(error)); }
    finally { setRelatedBusy(false); }
  }
  async function previewMerge(alternative) {
    setMergeBusy(bookKey(alternative.book)); setRelatedError('');
    const base = book.mergeBase || book;
    try {
      const value = await request(endpoint('/merge', { baseSource: base.source, baseId: base.id, baseBranchId: base.branchId ?? branchId, otherSource: alternative.book.source, otherId: alternative.book.id, otherBranchId: alternative.branchId }));
      const detail = normalizeBook(value);
      if (detail.source !== 'merged' || !Array.isArray(detail.chapters) || !detail.chapters.length) throw new Error('Источник не вернул объединённое оглавление.');
      const previous = book.source === 'merged' ? book : (await storage.get('book:' + bookKey(detail)))?.book;
      const extended = extendMergedBook(previous, detail);
      const previousChapters = previous?.chapters || chapters;
      const previousKeys = new Set(previousChapters.filter(chapter => chapter.mergeKey).map(mergeChapterKey));
      const previousOrigins = new Set(previousChapters.map(chapter => originKey(chapterOrigin(book, chapter, branchId))));
      const added = extended.chapters.filter(chapter => !previousKeys.has(mergeChapterKey(chapter)) && !previousOrigins.has(originKey(chapter.origin))).length;
      setMergePreview({ book: extended, warnings: extended.warnings || value.warnings || [], added });
    } catch (error) { setRelatedError(textOf(error)); }
    finally { setMergeBusy(''); }
  }
  async function applyMerge() {
    if (!mergePreview || saving) return;
    setSaving(true); setRelatedError('');
    try {
      const merged = mergePreview.book;
      await storage.saveBook(book, chapters, branches);
      await storage.saveMergedBook(book, merged, merged.chapters, []);
      setBook(merged); setBranchId(''); setMergePreview(null);
      await onMerged(merged);
    } catch (error) { setRelatedError(textOf(error)); }
    finally { setSaving(false); }
  }
  async function save() {
    if (saving) return;
    setSaving(true); setError('');
    try { await onSave(book, chapters, branches); } catch (error) { setError(textOf(error)); } finally { setSaving(false); }
  }
  async function read(index) {
    if (opening) return;
    setOpening(true); setError('');
    try { await onRead(book, chapters, branches, branchId || undefined, index); } catch (error) { setError(textOf(error)); setOpening(false); }
  }
  async function download() {
    if (downloading) return;
    setDownloading(true); setError('');
    try { await onDownload(book, chapters, branches, downloadBranch); }
    catch (error) { setError(textOf(error)); }
    finally { setDownloading(false); }
  }
  return <div className="mvp-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogRef} className="mvp-book-dialog" role="dialog" aria-modal="true" aria-label="Карточка книги" data-source={book.source} data-book-id={book.id}>
      <div className="mvp-dialog-top"><span className="mvp-eyebrow">О книге</span><button type="button" className="mvp-icon-button" onClick={onClose} aria-label="Закрыть карточку" data-autofocus data-testid="close-book"><Icon name="close" /></button></div>
      <div className="mvp-dialog-scroll"><div className="mvp-detail-heading"><Cover book={book} small /><div><span className="mvp-source-label">{sourceName(book)} <span>· {book.kind === 'novel' ? 'Новелла' : 'Книга'}</span></span><h2 data-testid="book-title">{book.title}</h2><p data-testid="book-author">{authorName(book)}</p>{book.language && <span className="mvp-badge">{book.language.toUpperCase()}</span>}</div></div>
        {loading ? <div className="mvp-loading" role="status"><Spinner /><span>Получаем описание и оглавление…</span></div> : <>
          {cached && <Notice>Открыта сохранённая карточка. Для чтения без интернета используем скачанные главы.</Notice>}
          {error && <Notice error action={!chapters.length && <button type="button" onClick={() => setRetry(value => value + 1)} className="mvp-text-button">Повторить</button>}>{error}</Notice>}
          {book.description && <section className="mvp-description"><h3>Описание</h3><p>{String(book.description).replace(/<[^>]*>/g, '')}</p></section>}
          {book.url && <a className="mvp-source-link" data-testid="source-link" href={book.url} target="_blank" rel="noreferrer">Открыть в {sourceName(book)}<Icon name="external" size={15} /></a>}
          {book.source === 'merged' && <Notice><strong>Объединённая книга · источников: {(book.contributors || []).length}.</strong> {book.contributors?.map(value => sourceName(value)).join(' · ')}. Прочитанные главы и закладки сохранены.</Notice>}
          <section className="mvp-related" aria-label="Продолжение в других источниках">
            <button type="button" className="mvp-button secondary mvp-related-search" data-testid="find-related" disabled={relatedBusy || Boolean(mergeBusy) || saving} onClick={findRelated}>{relatedBusy ? <Spinner small /> : <Icon name="search" size={17} />}{relatedBusy ? 'Сравниваем источники…' : book.source === 'merged' ? 'Обновить объединённую книгу' : 'Найти продолжение и другие источники'}</button>
            <p className="mvp-related-hint">Сравним доступные главы. Текущий перевод остаётся основным, новые главы дополняют оглавление.</p>
            {relatedError && <Notice error>{relatedError}</Notice>}
            {related && <div className="mvp-related-results" data-testid="related-results">
              <div className="mvp-section-heading"><h3>Другие издания и продолжение</h3><span>{related.alternatives?.length || 0} вариантов</span></div>
              {!related.alternatives?.length && <p className="mvp-muted">Других источников пока не найдено. Можно повторить проверку позднее.</p>}
              {(related.alternatives || []).map(alternative => <article className="mvp-related-item" data-testid="related-book" data-source={alternative.book.source} data-book-id={alternative.book.id} key={bookKey(alternative.book)}>
                <span className="mvp-source-label">{sourceName(alternative.book)}</span><h4>{alternative.book.title}</h4><p>{alternative.chaptersCount ?? 0} разделов · доступно {alternative.availableCount ?? alternative.chaptersCount ?? 0}{alternative.canMerge ? ` · новых ${alternative.addedCount ?? 0}` : ' · отдельное издание'}</p>
                {Boolean(alternative.matchedCount) && <small>Совпало по нумерации: {alternative.matchedCount}</small>}
                {(alternative.warnings || []).map((warning, index) => <p className="mvp-merge-warning" key={index}>{typeof warning === 'string' ? warning : warning.message || JSON.stringify(warning)}</p>)}
                <div className="mvp-related-actions"><button type="button" className="mvp-button secondary" data-testid="open-related" disabled={Boolean(mergeBusy) || saving} onClick={() => onOpenAlternative(alternative.book)}>Открыть источник<Icon name="next" size={15} /></button><button type="button" className="mvp-button primary" data-testid="merge-related" disabled={!alternative.canMerge || Boolean(mergeBusy) || saving} onClick={() => previewMerge(alternative)}>{mergeBusy === bookKey(alternative.book) ? <Spinner small /> : <Icon name="plus" size={16} />}{book.source === 'merged' ? 'Обновить оглавление' : 'Объединить оглавление'}</button></div>
              </article>)}
              {(related.errors || []).length > 0 && <Notice error>Не все источники ответили. {(related.errors || []).map(value => `${sourceName({ source: value.source || value.id })}: ${value.error || value.message || ''}`).join(' · ')}</Notice>}
            </div>}
            {mergePreview && <section className="mvp-merge-preview" data-testid="merge-preview" aria-label="Предпросмотр объединения"><h3>Объединённое оглавление</h3><p>Всего {mergePreview.book.chapters.length} разделов · добавится {mergePreview.added}. Главы из текущего источника, сохранённый текст и закладки сохранятся.</p>{mergePreview.warnings.map((warning, index) => <p className="mvp-merge-warning" key={index}>{typeof warning === 'string' ? warning : warning.message || JSON.stringify(warning)}</p>)}<div className="mvp-related-actions"><button type="button" className="mvp-button secondary" onClick={() => setMergePreview(null)} disabled={saving}>Отмена</button><button type="button" className="mvp-button primary" data-testid="apply-merge" onClick={applyMerge} disabled={saving}>{saving ? <Spinner small /> : <Icon name="check" size={16} />}Сохранить объединённую книгу</button></div></section>}
          </section>
          {branches.length > 1 && <label className="mvp-field mvp-branch-field"><span>Ветка перевода</span><select value={branchId} disabled={relatedBusy || Boolean(mergeBusy) || saving} onChange={event => { setBranchId(event.target.value); setRelated(null); setMergePreview(null); }}>{branches.map(branch => <option value={String(branch.id)} key={branch.id}>{branch.name || branch.title || branch.label || `Ветка ${branch.id}`}</option>)}</select></label>}
          <section className="mvp-detail-chapters"><div className="mvp-section-heading"><h3>Оглавление</h3><span>{chapters.length ? `${chapters.length} разделов` : 'Нет доступных глав'}</span></div>{chapters.length ? <><div className="mvp-chapter-preview">{chapters.slice(0, visibleCount).map((chapter, index) => <button type="button" data-testid="chapter-button" data-chapter-id={chapterId(chapter, index)} className="mvp-chapter-row" key={String(chapterId(chapter, index)) + ':' + index} disabled={chapter.available === false || opening} onClick={() => read(index)}><span className="mvp-chapter-number">{chapter.number ?? index + 1}</span><span>{chapterName(chapter, index)}</span>{chapter.available === false ? <small>Недоступна</small> : <Icon name="next" size={16} />}</button>)}</div>{chapters.length > visibleCount && <button type="button" className="mvp-text-button mvp-more-chapters" onClick={() => setVisibleCount(value => value + 100)}>Показать ещё {Math.min(chapters.length - visibleCount, 100)} глав</button>}</> : !error && <p className="mvp-muted mvp-no-chapters">{book.message || 'Источник не предоставил доступный текст этой книги. Можно сохранить карточку и вернуться позже.'}</p>}</section>
        </>}
      </div>
      <div className="mvp-dialog-footer"><div className="mvp-detail-download">{downloadJob ? <DownloadProgress job={downloadJob} compact /> : <p><Icon name="device" size={15} />Скачайте книгу целиком для чтения без интернета</p>}<button type="button" data-testid="download-book" className="mvp-button secondary" onClick={download} disabled={loading || !chapters.length || saving || downloading}>{downloading ? <Spinner small /> : <Icon name="download" size={17} />}{downloading ? 'Добавляем…' : downloadJob ? downloadJob.status === 'complete' ? 'Проверить загрузку' : 'Открыть загрузку' : 'Скачать целиком'}</button></div><div><button type="button" data-testid="save-book" className="mvp-button secondary" onClick={save} disabled={loading || saving || Boolean(saved)}>{saving ? <Spinner small /> : <Icon name={saved ? 'check' : 'plus'} size={18} />}{saving ? 'Сохраняем…' : saved ? 'В библиотеке' : 'В библиотеку'}</button><button type="button" data-testid="read-book" className="mvp-button primary" disabled={loading || !available || opening} onClick={() => read()}>{opening ? <Spinner small /> : <Icon name="book" size={18} />}{opening ? 'Открываем…' : saved?.position ? 'Продолжить' : 'Читать'}</button></div></div>
    </section>
  </div>;
}

function Reader({ session, onClose, onLibraryChange, suspended = false }) {
  const { book, chapters, branches = [] } = session;
  const [index, setIndex] = useState(session.index || 0);
  const [branchId, setBranchId] = useState(session.branchId || '');
  const [content, setContent] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [cached, setCached] = useState(false);
  const [cacheWarning, setCacheWarning] = useState('');
  const [fontSize, setFontSize] = useState(20);
  const [theme, setTheme] = useState('dark');
  const [outline, setOutline] = useState(false);
  const [bookmarkPanel, setBookmarkPanel] = useState(false);
  const [settingsPanel, setSettingsPanel] = useState(false);
  const [bookmarks, setBookmarks] = useState([]);
  const [bookmarkName, setBookmarkName] = useState('');
  const [bookmarkBusy, setBookmarkBusy] = useState(false);
  const [bookmarkMessage, setBookmarkMessage] = useState('');
  const [chapterFilter, setChapterFilter] = useState('');
  const [retry, setRetry] = useState(0);
  const scrollRef = useRef(null);
  const positionTimer = useRef(null);
  const restoring = useRef(true);
  const generation = useRef(0);
  const restorePosition = useRef(session.position || null);
  const readingRef = useRef(null); readingRef.current = { content, chapter: chapters[index], index, branchId };
  const chapter = chapters[index];
  useEffect(() => {
    storage.get('reader-preferences').then(value => { if (value?.fontSize) setFontSize(Math.min(30, Math.max(16, value.fontSize))); if (value?.theme) setTheme(value.theme); }).catch(() => {});
    storage.getBookmarks(book).then(setBookmarks).catch(error => setCacheWarning(textOf(error)));
    return () => clearTimeout(positionTimer.current);
  }, []);
  useEffect(() => {
    const token = ++generation.current;
    let frame;
    clearTimeout(positionTimer.current);
    restoring.current = true;
    setLoading(true); setError(''); setContent(null); setCached(false); setCacheWarning('');
    if (!chapter) { setLoading(false); setError('Эта глава отсутствует в оглавлении.'); return; }
    (async () => {
      try {
        let value = await storage.readChapter(book, chapter, branchId || undefined).catch(() => null);
        const fromCache = Boolean(value);
        if (!value) {
          const origin = chapterOrigin(book, chapter, branchId || undefined);
          value = await request(endpoint('/chapter', { source: origin.source, id: origin.bookId, chapterId: origin.chapterId, branchId: origin.branchId || undefined }));
          try { await storage.saveChapter(book, chapter, branchId || undefined, value); }
          catch (error) { if (token === generation.current) setCacheWarning(textOf(error)); }
        }
        if (token !== generation.current) return;
        const paragraphs = Array.isArray(value.paragraphs) ? value.paragraphs.filter(text => typeof text === 'string' && text.trim()) : String(value.text || '').split(/\n\s*\n|\n/).filter(text => text.trim());
        if (!paragraphs.length) throw new Error('Источник вернул главу без текста. Попробуйте другую главу или ветку перевода.');
        setContent({ ...value, paragraphs }); setCached(fromCache); setLoading(false);
        const position = restorePosition.current || await storage.getPosition(book).catch(() => null);
        if (token !== generation.current) return;
        restorePosition.current = null;
        const fraction = storage.positionIndex(book, chapters, position, branchId) === index ? Math.min(1, Math.max(0, Number(position.fraction) || 0)) : 0;
        frame = requestAnimationFrame(() => {
          if (token !== generation.current) return;
          const node = scrollRef.current;
          if (node) node.scrollTop = fraction * Math.max(0, node.scrollHeight - node.clientHeight);
          restoring.current = false;
        });
        await storage.savePosition(book, { chapterIndex: index, chapterId: chapterId(chapter, index), branchId, origin: chapterOrigin(book, chapter, branchId), fraction }).catch(error => { if (token === generation.current) setCacheWarning(textOf(error)); });
        onLibraryChange();
      } catch (error) { if (token === generation.current) { setError(textOf(error)); setLoading(false); restoring.current = false; } }
    })();
    return () => { generation.current++; cancelAnimationFrame(frame); };
  }, [book.source, book.id, index, branchId, retry]);
  function currentPosition() {
    const current = readingRef.current;
    if (restoring.current || !current.content || !scrollRef.current || !current.chapter) return null;
    const node = scrollRef.current;
    return { chapterIndex: current.index, chapterId: chapterId(current.chapter, current.index), branchId: current.branchId, origin: chapterOrigin(book, current.chapter, current.branchId), fraction: node.scrollTop / Math.max(1, node.scrollHeight - node.clientHeight) };
  }
  function persistCurrentPosition() {
    clearTimeout(positionTimer.current);
    const position = currentPosition();
    return position ? storage.savePosition(book, position) : Promise.resolve();
  }
  function saveScroll() {
    if (!currentPosition()) return;
    clearTimeout(positionTimer.current);
    positionTimer.current = setTimeout(() => persistCurrentPosition().catch(error => setCacheWarning(textOf(error))), 180);
  }
  async function close() {
    await persistCurrentPosition().catch(() => {});
    await storage.clearActiveReading().catch(() => {});
    onLibraryChange(); onClose();
  }
  function changeChapter(nextIndex) {
    if (nextIndex < 0 || nextIndex >= chapters.length || chapters[nextIndex].available === false) return;
    persistCurrentPosition().catch(error => setCacheWarning(textOf(error)));
    restoring.current = true;
    setIndex(nextIndex); setOutline(false); setSettingsPanel(false);
  }
  function changeBranch(value) {
    persistCurrentPosition().catch(error => setCacheWarning(textOf(error)));
    restoring.current = true;
    setBranchId(value);
  }
  async function createBookmark(event) {
    event.preventDefault();
    const position = currentPosition();
    if (!position || bookmarkBusy) return;
    setBookmarkBusy(true); setBookmarkMessage('');
    try {
      await storage.addBookmark(book, position, bookmarkName.trim() || `${chapterName(chapter, index)} · ${Math.round(position.fraction * 100)}%`);
      setBookmarks(await storage.getBookmarks(book)); setBookmarkName(''); setBookmarkMessage('Закладка сохранена');
      await persistCurrentPosition();
    } catch (error) { setBookmarkMessage(textOf(error)); }
    finally { setBookmarkBusy(false); }
  }
  async function jumpBookmark(bookmark) {
    const nextBranch = String(bookmark.branchId || '');
    const nextIndex = storage.positionIndex(book, chapters, bookmark, nextBranch);
    if (nextIndex < 0) { setBookmarkMessage('Глава этой закладки отсутствует в оглавлении.'); return; }
    await persistCurrentPosition().catch(() => {});
    restoring.current = true;
    restorePosition.current = bookmark;
    setIndex(nextIndex); setBranchId(nextBranch); setBookmarkPanel(false); setOutline(false); setRetry(value => value + 1);
  }
  async function deleteBookmark(id) {
    try { await storage.removeBookmark(book, id); setBookmarks(await storage.getBookmarks(book)); }
    catch (error) { setBookmarkMessage(textOf(error)); }
  }
  useEffect(() => {
    const handler = event => {
      if (suspended) return;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
      if (event.key === 'Escape') { if (settingsPanel) setSettingsPanel(false); else if (bookmarkPanel) setBookmarkPanel(false); else if (outline) setOutline(false); else close(); }
      if (event.altKey && event.key === 'ArrowRight') { event.preventDefault(); changeChapter(index + 1); }
      if (event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); changeChapter(index - 1); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [index, outline, bookmarkPanel, settingsPanel, content, branchId, suspended]);
  useEffect(() => {
    const back = event => {
      if (suspended || event.defaultPrevented || event.detail?.handled) return;
      event.preventDefault();
      if (event.detail) event.detail.handled = true;
      if (settingsPanel) setSettingsPanel(false);
      else if (bookmarkPanel) setBookmarkPanel(false);
      else if (outline) setOutline(false);
      else close();
    };
    window.addEventListener('gargantua-back', back);
    return () => window.removeEventListener('gargantua-back', back);
  }, [settingsPanel, bookmarkPanel, outline, suspended]);
  useEffect(() => {
    const beforeClose = event => {
      event.detail?.waitUntil?.(persistCurrentPosition());
    };
    const pagehide = () => { persistCurrentPosition().then(() => storage.flush()).catch(() => {}); };
    window.addEventListener('cotology-before-close', beforeClose);
    window.addEventListener('gargantua-before-close', beforeClose);
    window.addEventListener('pagehide', pagehide);
    window.addEventListener('gargantua-background', pagehide);
    document.addEventListener('visibilitychange', pagehide);
    return () => { window.removeEventListener('cotology-before-close', beforeClose); window.removeEventListener('gargantua-before-close', beforeClose); window.removeEventListener('pagehide', pagehide); window.removeEventListener('gargantua-background', pagehide); document.removeEventListener('visibilitychange', pagehide); };
  }, [book]);
  function preference(size, nextTheme = theme) {
    setFontSize(size); setTheme(nextTheme); storage.put('reader-preferences', { fontSize: size, theme: nextTheme }).catch(() => {});
  }
  const matching = useMemo(() => chapters.map((chapter, chapterIndex) => ({ chapter, chapterIndex })).filter(({ chapter, chapterIndex }) => !chapterFilter || chapterName(chapter, chapterIndex).toLocaleLowerCase().includes(chapterFilter.toLocaleLowerCase())), [chapters, chapterFilter]);
  const visibleOutline = chapterFilter ? matching.slice(0, 250) : matching.slice(Math.max(0, index - 80), Math.max(200, index + 100));
  const renderedTitle = content?.title || (chapter ? chapterName(chapter, index) : '');
  const normalizeHeading = value => String(value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  const displayParagraphs = content?.paragraphs?.slice(normalizeHeading(content.paragraphs[0]) === normalizeHeading(renderedTitle) ? 1 : 0) || [];
  return <main className={`mvp-reader theme-${theme}`} data-testid="reader" data-source={book.source} data-book-id={book.id} data-chapter-id={chapter ? chapterId(chapter, index) : undefined} data-branch-id={branchId} aria-label="Чтение книги">
    <header className="mvp-reader-toolbar">
      <button type="button" className="mvp-button ghost" onClick={close} data-testid="close-reader" aria-label="К библиотеке"><Icon name="arrow" size={20} /><span>К библиотеке</span></button>
      <div className="mvp-reader-title"><strong>{book.title}</strong><span>{chapter && chapterName(chapter, index)}</span></div>
      <div className="mvp-reader-tools">
        <div className={`mvp-reading-preferences${settingsPanel ? ' is-open' : ''}`} data-testid="reader-settings-panel" role="group" aria-label="Настройки чтения">
          <div className="mvp-mobile-preference-heading"><strong>Настройки чтения</strong><button type="button" className="mvp-icon-button" data-testid="close-reader-settings" aria-label="Закрыть настройки чтения" onClick={() => setSettingsPanel(false)}><Icon name="close" /></button></div>
          <span className="mvp-mobile-preference-label">Размер текста</span><div className="mvp-font-controls"><button type="button" className="mvp-icon-button" data-testid="font-decrease" onClick={() => preference(Math.max(16, fontSize - 2))} aria-label="Уменьшить шрифт" disabled={fontSize <= 16}>A−</button><span className="mvp-font-value" aria-live="polite">{fontSize}</span><button type="button" className="mvp-icon-button" data-testid="font-increase" onClick={() => preference(Math.min(30, fontSize + 2))} aria-label="Увеличить шрифт" disabled={fontSize >= 30}>A+</button></div>
          <span className="mvp-toolbar-divider" /><button type="button" className="mvp-icon-button mvp-reader-theme" data-testid="reader-theme-toggle" aria-label={theme === 'dark' ? 'Светлый фон чтения' : 'Тёмный фон чтения'} title="Сменить фон" onClick={() => preference(fontSize, theme === 'dark' ? 'paper' : 'dark')}><Icon name="sun" /><span>{theme === 'dark' ? 'Светлый фон' : 'Тёмный фон'}</span></button>
        </div>
        <button type="button" className={`mvp-icon-button mvp-reader-settings-toggle${settingsPanel ? ' active' : ''}`} data-testid="reader-settings-toggle" aria-label="Настройки чтения" aria-expanded={settingsPanel} onClick={() => { setSettingsPanel(value => !value); setBookmarkPanel(false); setOutline(false); }}><Icon name="settings" /></button>
        <button type="button" className={`mvp-icon-button${bookmarkPanel ? ' active' : ''}`} data-testid="bookmarks-toggle" onClick={() => { setBookmarkPanel(value => !value); setOutline(false); setSettingsPanel(false); setBookmarkMessage(''); }} aria-label="Закладки" title="Закладки" aria-expanded={bookmarkPanel}><Icon name="bookmark" /></button>
        <button type="button" className={`mvp-icon-button${outline ? ' active' : ''}`} data-testid="outline-toggle" onClick={() => { setOutline(value => !value); setBookmarkPanel(false); setSettingsPanel(false); }} aria-label="Оглавление" aria-expanded={outline}><Icon name="list" /></button>
      </div>
    </header>
    <div className="mvp-reader-body">{bookmarkPanel && <aside className="mvp-reader-outline mvp-bookmarks" data-testid="bookmarks-panel" aria-label="Закладки книги"><div className="mvp-section-heading"><h2>Закладки</h2><button type="button" className="mvp-icon-button" data-testid="close-bookmarks" aria-label="Скрыть закладки" onClick={() => setBookmarkPanel(false)}><Icon name="close" size={18} /></button></div><form className="mvp-bookmark-form" onSubmit={createBookmark}><label><span>Название закладки</span><input data-testid="bookmark-name" value={bookmarkName} onChange={event => setBookmarkName(event.target.value)} maxLength={160} placeholder={chapter ? chapterName(chapter, index) : 'Место в книге'} /></label><button type="submit" className="mvp-button primary" data-testid="save-bookmark" disabled={loading || !content || bookmarkBusy}>{bookmarkBusy ? <Spinner small /> : <Icon name="bookmark" size={16} />}Поставить закладку</button></form>{bookmarkMessage && <p className="mvp-bookmark-message" role="status">{bookmarkMessage}</p>}<p className="mvp-bookmark-hint">Место чтения сохраняется автоматически. Эти закладки можно назвать и открыть в любой момент.</p><div className="mvp-bookmark-list">{bookmarks.map(bookmark => <div className="mvp-bookmark-item" data-testid="bookmark-item" key={bookmark.id}><button type="button" data-testid="open-bookmark" onClick={() => jumpBookmark(bookmark)}><strong>{bookmark.name}</strong><span>Раздел {bookmark.chapterIndex + 1} · {Math.round(bookmark.fraction * 100)}%</span></button><button type="button" className="mvp-icon-button" aria-label={'Удалить закладку ' + bookmark.name} onClick={() => deleteBookmark(bookmark.id)}><Icon name="trash" size={15} /></button></div>)}{!bookmarks.length && <p className="mvp-muted">Здесь появятся ваши закладки.</p>}</div></aside>}{outline && <aside className="mvp-reader-outline" data-testid="outline-panel" aria-label="Оглавление книги"><div className="mvp-section-heading"><h2>Оглавление</h2><button type="button" className="mvp-icon-button" data-testid="close-outline" aria-label="Скрыть оглавление" onClick={() => setOutline(false)}><Icon name="close" size={18} /></button></div><input className="mvp-outline-search" aria-label="Найти главу" placeholder="Найти главу…" value={chapterFilter} onChange={event => setChapterFilter(event.target.value)} />{branches.length > 1 && <select className="mvp-outline-branch" aria-label="Ветка перевода" value={branchId} onChange={event => changeBranch(event.target.value)}>{branches.map(branch => <option value={String(branch.id)} key={branch.id}>{branch.name || branch.title || branch.label || `Ветка ${branch.id}`}</option>)}</select>}<div className="mvp-outline-list">{!chapterFilter && index > 80 && <small className="mvp-outline-hint">Главы рядом с текущей. Для перехода к другой главе используйте поиск.</small>}{visibleOutline.map(({ chapter, chapterIndex }) => <button type="button" className={chapterIndex === index ? 'active' : ''} aria-current={chapterIndex === index ? 'page' : undefined} data-testid="chapter-button" data-chapter-id={chapterId(chapter, chapterIndex)} key={String(chapterId(chapter, chapterIndex)) + ':' + chapterIndex} disabled={chapter.available === false} onClick={() => changeChapter(chapterIndex)}><span>{chapter.number ?? chapterIndex + 1}</span><span>{chapterName(chapter, chapterIndex)}</span></button>)}{!matching.length && <p className="mvp-muted">Такой главы нет в оглавлении.</p>}{chapterFilter && matching.length > 250 && <small className="mvp-outline-hint">Найдено {matching.length} глав. Уточните запрос, чтобы увидеть нужную.</small>}</div></aside>}
      <div ref={scrollRef} className="mvp-reader-scroll" data-testid="reader-scroll" onScroll={saveScroll} tabIndex={0} aria-label="Текст главы"><div className="mvp-reading-column" style={{ '--reader-font-size': `${fontSize}px` }}>{loading ? <div className="mvp-loading reader-loading" role="status"><Spinner /><span>Открываем главу…</span></div> : error ? <EmptyState icon="alert" title="Не удалось открыть главу" action={<button type="button" className="mvp-button primary" onClick={() => setRetry(value => value + 1)}><Icon name="refresh" size={18} />Повторить</button>}>{error} Сохранённые главы доступны через оглавление.</EmptyState> : content && <><div className="mvp-reading-eyebrow"><span data-testid="chapter-source">{chapter ? sourceName({ source: chapterOrigin(book, chapter, branchId).source }) : sourceName(book)}</span><span><Icon name="device" size={14} />{cacheWarning ? 'Глава не сохранена' : cached ? 'Сохранена на устройстве' : 'Сохранена для чтения без сети'}</span></div>{cacheWarning && <Notice error>{cacheWarning}</Notice>}<h1>{renderedTitle}</h1><article className="mvp-reader-content" data-testid="reader-content">{displayParagraphs.map((paragraph, paragraphIndex) => <p key={paragraphIndex}>{paragraph}</p>)}</article><div className="mvp-end-chapter"><span>Глава прочитана</span>{index < chapters.length - 1 ? <button type="button" className="mvp-button primary" onClick={() => changeChapter(index + 1)} disabled={chapters[index + 1]?.available === false}>Следующая глава<Icon name="next" size={17} /></button> : <button type="button" className="mvp-button secondary" onClick={close}>Вернуться в библиотеку</button>}</div></>}</div></div>
    </div>
    <footer className="mvp-reader-footer"><button type="button" className="mvp-button ghost" onClick={() => changeChapter(index - 1)} disabled={index <= 0 || chapters[index - 1]?.available === false}><Icon name="arrow" size={16} />Предыдущая</button><button type="button" className="mvp-reader-progress" onClick={() => { setOutline(value => !value); setBookmarkPanel(false); }} aria-label="Открыть оглавление">Раздел {index + 1} из {chapters.length}<span><i style={{ width: `${(index + 1) / Math.max(1, chapters.length) * 100}%` }} /></span></button><button type="button" className="mvp-button ghost" onClick={() => changeChapter(index + 1)} disabled={index >= chapters.length - 1 || chapters[index + 1]?.available === false}>Следующая<Icon name="next" size={16} /></button></footer>
  </main>;
}

export default function MvpApp() {
  const isAndroid = window.gargantua?.platform === 'android';
  const [tab, setTab] = useState('search');
  const [query, setQuery] = useState('');
  const [type, setType] = useState('all');
  const [source, setSource] = useState('all');
  const [sources, setSources] = useState(() => [...new Map([...CATALOGS, ...savedSources()].map(source => [source.id, { ...source, status: 'unknown' }])).values()]);
  const [items, setItems] = useState([]);
  const [searched, setSearched] = useState(false);
  const [submitted, setSubmitted] = useState('');
  const [busy, setBusy] = useState(false);
  const [randomBusy, setRandomBusy] = useState(false);
  const [error, setError] = useState('');
  const [sourceErrors, setSourceErrors] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [library, setLibrary] = useState([]);
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [libraryError, setLibraryError] = useState('');
  const [libraryFilter, setLibraryFilter] = useState('');
  const [selected, setSelected] = useState(null);
  const [reader, setReader] = useState(null);
  const [restoringReader, setRestoringReader] = useState(true);
  const [toast, setToast] = useState('');
  const [connection, setConnection] = useState('checking');
  const [downloadJobs, setDownloadJobs] = useState(() => downloads.getSnapshot());
  const [downloadPanel, setDownloadPanel] = useState(false);
  const [downloadError, setDownloadError] = useState('');
  const [serverSettingsBusy, setServerSettingsBusy] = useState(false);
  const searchRef = useRef(null);
  const requestGeneration = useRef(0);
  const toastTimer = useRef(null);
  const submittedParams = useRef(null);
  const libraryByKey = useMemo(() => new Map(library.map(row => [bookKey(row.book), row])), [library]);
  const availableSources = sources.filter(catalog => type === 'all' || catalog.kind === type);
  const visibleItems = type === 'all' ? items : items.filter(book => book.kind === type);
  const visibleLibrary = useMemo(() => library.filter(row => `${row.book.title} ${authorName(row.book)} ${sourceName(row.book)}`.toLocaleLowerCase().includes(libraryFilter.toLocaleLowerCase())), [library, libraryFilter]);
  const activeDownloadCount = downloadJobs.filter(activeDownload).length;
  function currentDownload(book, chapters, branchId) {
    const job = downloadJobs.find(value => value.id === downloadId(book, branchId));
    return job?.outlineKey === downloadOutlineId(book, chapters, branchId) ? job : undefined;
  }

  function notify(message) { clearTimeout(toastTimer.current); setToast(message); toastTimer.current = setTimeout(() => setToast(''), 4500); }
  async function loadLibrary() {
    try { setLibrary(await storage.listBooks()); setLibraryError(''); } catch (error) { setLibraryError(textOf(error)); }
    finally { setLibraryLoading(false); }
  }
  function updateSources(values) {
    if (!Array.isArray(values)) return;
    registerSources(values);
    setSources(current => {
      const catalog = new Map(current.map(value => [value.id, value]));
      for (const value of values) {
        const id = value.id || value.source;
        if (id) catalog.set(id, { status: 'unknown', ...catalog.get(id), ...value, id });
      }
      return [...catalog.values()];
    });
  }
  async function connect() {
    setConnection('checking');
    try {
      const result = await request('/sources'); updateSources(Array.isArray(result) ? result : result.sources); setConnection('online');
    } catch { setConnection('offline'); }
  }
  async function configureServer() {
    if (serverSettingsBusy) return;
    setServerSettingsBusy(true);
    try {
      await window.gargantua?.configureServer?.();
      await connect();
    } catch (error) { notify(textOf(error)); }
    finally { setServerSettingsBusy(false); }
  }
  useEffect(() => {
    document.title = 'Гаргантюа — книги и новеллы';
    let mounted = true;
    const unsubscribeDownloads = downloads.subscribe(() => { if (mounted) setDownloadJobs(downloads.getSnapshot()); });
    downloads.init().then(() => { if (mounted) setDownloadJobs(downloads.getSnapshot()); }).catch(error => { if (mounted) setDownloadError(textOf(error)); });
    loadLibrary(); connect();
    storage.getActiveReading().then(async active => {
      if (!active?.bookKey) return;
      const saved = await storage.get('book:' + active.bookKey);
      if (!mounted || !saved?.chapters?.length) return;
      const position = active.position || await storage.getPosition(saved.book);
      const branchId = String(position?.branchId ?? initialBranch(saved.book, saved));
      const index = storage.positionIndex(saved.book, saved.chapters, position, branchId);
      if (index >= 0 && saved.chapters[index].available !== false) {
        setReader({ book: saved.book, chapters: saved.chapters, branches: saved.branches || [], branchId, index, position });
        setTab('library');
      }
    }).catch(error => { if (mounted) setLibraryError(textOf(error)); }).finally(() => { if (mounted) setRestoringReader(false); });
    const close = event => event.detail?.waitUntil?.(Promise.resolve(downloads.shutdown()).then(() => storage.flush()));
    window.addEventListener('cotology-before-close', close);
    window.addEventListener('gargantua-before-close', close);
    const background = event => { const pending = storage.flush(); pending.catch(() => {}); event.detail?.waitUntil?.(pending); };
    const resume = () => { loadLibrary(); connect(); };
    window.addEventListener('gargantua-background', background);
    window.addEventListener('gargantua-resume', resume);
    window.addEventListener('gargantua-server-changed', resume);
    const unsubscribe = window.gargantua?.onBeforeClose?.(async () => {
      await downloads.shutdown();
      const pending = [];
      window.dispatchEvent(new CustomEvent('gargantua-before-close', { detail: { waitUntil: promise => pending.push(Promise.resolve(promise)) } }));
      await Promise.all(pending);
      await storage.flush();
    });
    return () => { mounted = false; unsubscribe?.(); unsubscribeDownloads(); downloads.shutdown().catch(() => {}); clearTimeout(toastTimer.current); window.removeEventListener('cotology-before-close', close); window.removeEventListener('gargantua-before-close', close); window.removeEventListener('gargantua-background', background); window.removeEventListener('gargantua-resume', resume); window.removeEventListener('gargantua-server-changed', resume); };
  }, []);
  useEffect(() => {
    const back = event => {
      if (event.defaultPrevented || event.detail?.handled) return;
      let handled = true;
      if (downloadPanel) setDownloadPanel(false);
      else if (selected) setSelected(null);
      else if (!reader && tab !== 'search') setTab('search');
      else handled = false;
      if (handled) { event.preventDefault(); if (event.detail) event.detail.handled = true; }
    };
    window.addEventListener('gargantua-back', back);
    return () => window.removeEventListener('gargantua-back', back);
  }, [downloadPanel, selected, reader, tab]);
  useEffect(() => {
    const shortcut = event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (reader || selected || downloadPanel) return;
        setTab('search'); requestAnimationFrame(() => { searchRef.current?.focus(); searchRef.current?.select(); });
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [reader, selected, downloadPanel]);
  function selectType(nextType) {
    setType(nextType);
    if (source !== 'all' && sources.find(catalog => catalog.id === source)?.kind !== nextType && nextType !== 'all') setSource('all');
  }
  function searchSource() {
    if (source !== 'all') return source;
    return 'all';
  }
  async function search(event, append = false, forceAll = false) {
    event?.preventDefault();
    const text = query.trim();
    if (!text) { searchRef.current?.focus(); return; }
    if (isAndroid && event) searchRef.current?.blur();
    const token = ++requestGeneration.current;
    const chosenSource = forceAll ? 'all' : searchSource();
    const params = append ? submittedParams.current : { q: text, source: chosenSource, targets: chosenSource === 'all' ? sources.filter(catalog => forceAll || type === 'all' || catalog.kind === type).map(catalog => catalog.id) : [chosenSource] };
    if (!params) return;
    const nextPage = append ? page + 1 : 1;
    if (!append) { submittedParams.current = params; setItems([]); setSubmitted(text); setSourceErrors([]); }
    setBusy(true); setRandomBusy(false); setError(''); setSearched(true); setTab('search');
    try {
      const errors = [];
      let more = false;
      let successful = 0;
      await Promise.all(params.targets.map(async target => {
        try {
          const result = await request(endpoint('/search', { q: params.q, source: target, page: nextPage }));
          if (token !== requestGeneration.current) return;
          if (!Array.isArray(result.items)) throw new Error('Источник не вернул список книг.');
          successful++;
          const resultItems = result.items.filter(book => book?.source && book?.id != null && book?.title);
          setItems(current => [...new Map([...current, ...resultItems].map(book => [bookKey(book), book])).values()]);
          more ||= Boolean(result.hasMore);
          updateSources(result.sources);
          if (Array.isArray(result.errors)) { errors.push(...result.errors); setSourceErrors([...errors]); }
          setConnection('online');
        } catch (error) {
          if (token !== requestGeneration.current) return;
          errors.push({ source: target, error: textOf(error) }); setSourceErrors([...errors]);
          updateSources([{ id: target, status: 'unavailable', error: textOf(error) }]);
        }
      }));
      if (token !== requestGeneration.current) return;
      setPage(nextPage); setHasMore(more);
      if (!successful) setError('Каталоги сейчас недоступны. Проверьте подключение и повторите поиск.');
    } catch (error) { if (token === requestGeneration.current) { setError(textOf(error)); setHasMore(false); } }
    finally { if (token === requestGeneration.current) setBusy(false); }
  }
  async function random() {
    const token = ++requestGeneration.current;
    setRandomBusy(true); setBusy(false); setError(''); setSourceErrors([]); setHasMore(false);
    try {
      const candidates = availableSources.filter(value => !['error', 'unavailable', 'blocked'].includes(value.status));
      const randomSource = source !== 'all' ? source : type === 'all' ? 'all' : candidates[Math.floor(Math.random() * candidates.length)]?.id || availableSources[0]?.id || 'all';
      const result = await request(endpoint('/random', { source: randomSource }));
      if (token !== requestGeneration.current) return;
      const book = result.book || result.item;
      if (!book?.title || !book?.source || book.id == null) throw new Error('Каталог не вернул случайную книгу. Повторите попытку.');
      setItems([book]); setSubmitted('Случайный выбор из каталога'); setSearched(true); setSelected(book); setConnection('online'); updateSources(result.sources);
    } catch (error) { if (token === requestGeneration.current) setError(textOf(error)); }
    finally { if (token === requestGeneration.current) setRandomBusy(false); }
  }
  async function saveBook(book, chapters, branches) {
    await storage.saveBook(book, chapters, branches); await loadLibrary();
    notify('Книга добавлена в библиотеку. Главы сохраняются при чтении.');
  }
  async function startReading(book, chapters, branches, branchId, targetIndex) {
    if (!chapters.length) throw new Error('В этой книге пока нет доступных глав.');
    const position = await storage.getPosition(book);
    let index = targetIndex;
    if (index === undefined) index = storage.positionIndex(book, chapters, position, branchId);
    if (!Number.isInteger(index) || index < 0 || index >= chapters.length) index = chapters.findIndex(chapter => chapter.available !== false);
    if (index < 0) throw new Error('В этой книге пока нет доступных глав.');
    if (chapters[index]?.available === false) throw new Error('Эта глава недоступна в источнике. Выберите другую.');
    await storage.saveBook(book, chapters, branches);
    const resumedPosition = storage.positionIndex(book, chapters, position, branchId) === index ? position : null;
    setSelected(null); setReader({ book, chapters, branches, branchId, index, position: resumedPosition }); await loadLibrary();
  }
  async function continueReading(row) {
    try { await startReading(row.book, row.chapters, row.branches || [], String(row.position?.branchId ?? initialBranch(row.book, row))); }
    catch (error) { setLibraryError(textOf(error)); }
  }
  async function mergedBookReady(book) {
    await loadLibrary(); setSelected(book); notify('Оглавление объединено. Позиция чтения и закладки сохранены.');
  }
  async function downloadBook(book, chapters, branches = [], branchId = '') {
    const selectedBranch = book.source === 'merged' ? '' : String(branchId);
    const job = currentDownload(book, chapters, selectedBranch);
    setDownloadError('');
    if (!job || !activeDownload(job) && job.status !== 'paused') {
      await storage.saveBook(book, chapters, branches);
      await downloads.enqueue(book, chapters, selectedBranch);
      await loadLibrary();
    }
    setDownloadPanel(true);
  }
  async function downloadFromLibrary(row) {
    try { await downloadBook(row.book, row.chapters || [], row.branches || [], bookDownloadBranch(row.book, row)); }
    catch (error) { setDownloadError(textOf(error)); setDownloadPanel(true); }
  }
  async function downloadAction(action, id) {
    setDownloadError('');
    try { await downloads[action](id); }
    catch (error) { setDownloadError(textOf(error)); }
  }
  async function remove(book) {
    try { for (const job of downloadJobs.filter(value => bookKey(value.book) === bookKey(book))) await downloads.cancel(job.id); await storage.removeBook(book); await loadLibrary(); notify('Книга удалена из библиотеки на этом устройстве.'); }
    catch (error) { setLibraryError(textOf(error)); }
  }
  const currentSourceStatus = sources.filter(value => source === 'all' || value.id === source);
  const searchEverywhereAction = source !== 'all' || type !== 'all' ? <button type="button" className="mvp-button primary" onClick={() => { setType('all'); setSource('all'); search(null, false, true); }}><Icon name="search" size={18} />Искать во всех источниках</button> : null;
  return <div className={`mvp-shell${isAndroid ? ' is-android' : ''}${reader ? ' is-reading' : ''}`}>
    <aside className="mvp-sidebar"><a className="mvp-brand" href="#" onClick={event => { event.preventDefault(); if (!reader) setTab('search'); }} aria-label="Гаргантюа, на главную"><span className="mvp-brand-symbol">Г<span>.</span></span><div><strong>Гаргантюа</strong><small>Личная библиотека</small></div></a><div className="mvp-nav-caption">ВАШЕ ПРОСТРАНСТВО</div><nav aria-label="Основная навигация"><button type="button" className={!reader && tab === 'search' ? 'active' : ''} data-testid="search-tab" onClick={() => { if (reader) return; setTab('search'); }} disabled={Boolean(reader)}><Icon name="search" /><span>Поиск книг</span></button><button type="button" className={!reader && tab === 'library' ? 'active' : ''} data-testid="library-tab" onClick={() => { if (reader) return; setTab('library'); loadLibrary(); }} disabled={Boolean(reader)}><Icon name="library" /><span>Моя библиотека</span><span className="mvp-nav-count">{library.length}</span></button><button type="button" className={downloadPanel ? 'active' : ''} data-testid="download-panel-toggle" aria-label="Загрузки" aria-expanded={downloadPanel} onClick={() => setDownloadPanel(true)}><Icon name="download" /><span>Загрузки</span>{activeDownloadCount > 0 && <span className="mvp-nav-count">{activeDownloadCount}</span>}</button></nav><div className="mvp-sidebar-note"><span className="mvp-small-book"><Icon name="book" size={23} /></span><strong>История начинается<br />с хорошей книги.</strong><p>Найдите свою.<br />Остальное подождёт.</p></div><div className="mvp-sidebar-bottom"><span className={`mvp-connection-dot ${connection}`} /><span>{connection === 'online' ? 'Сервер подключён' : connection === 'checking' ? 'Подключаемся…' : 'Нет связи с сервером'}</span><button type="button" className="mvp-icon-button" onClick={connect} aria-label="Проверить подключение" title="Проверить подключение"><Icon name="refresh" size={15} /></button></div></aside>
    <header className="mvp-mobile-header"><a href="#" onClick={event => { event.preventDefault(); if (!reader) setTab('search'); }} aria-label="Гаргантюа, на главную"><span>Г.</span><strong>Гаргантюа</strong></a>{isAndroid ? <button type="button" data-testid="server-settings-button" className="mvp-mobile-connection" onClick={configureServer} disabled={serverSettingsBusy} aria-label="Подключение к серверу" title="Настроить подключение"><span className={`mvp-connection-dot ${connection}`} /><span>{serverSettingsBusy ? 'Подключаем…' : connection === 'online' ? 'Подключён' : connection === 'checking' ? 'Подключаем…' : 'Нет связи'}</span><Icon name="settings" size={20} /></button> : <button type="button" className="mvp-mobile-connection" onClick={connect} aria-label="Проверить подключение"><span className={`mvp-connection-dot ${connection}`} /><Icon name="refresh" size={20} /></button>}</header>
    {restoringReader ? <main className="mvp-main"><div className="mvp-loading" role="status"><Spinner />Возвращаемся к месту чтения…</div></main> : reader ? <Reader key={bookKey(reader.book)} session={reader} onClose={() => { setReader(null); setTab('library'); }} onLibraryChange={loadLibrary} suspended={downloadPanel} /> : <main className="mvp-main"><header className="mvp-topbar"><div><Icon name={tab === 'search' ? 'search' : 'library'} size={16} /><span>{tab === 'search' ? 'Поиск книг и новелл' : 'Моя библиотека'}</span></div><span className="mvp-topbar-hint">Ваш следующий мир — на расстоянии книги</span><span className="mvp-version">MVP</span></header>
      <div className="mvp-page">{tab === 'search' ? <><section className="mvp-search-section"><p className="mvp-eyebrow">БОЛЬШЕ ИСТОРИЙ. МЕНЬШЕ ЛИШНЕГО.</p><div className="mvp-page-heading"><div><h1>Что будем читать?</h1><p>Книги и новеллы из открытых каталогов — в одной библиотеке.</p></div></div><form className="mvp-search-form" onSubmit={search}><div className="mvp-search-input-wrap"><Icon name="search" size={23} /><input ref={searchRef} enterKeyHint="search" type="search" data-testid="search-input" aria-label="Название книги или автор" placeholder="Название книги или автор…" value={query} onChange={event => setQuery(event.target.value)} maxLength={500} autoComplete="off" /><kbd>Ctrl K</kbd></div><button type="submit" className="mvp-button primary" data-testid="search-submit" disabled={busy || randomBusy || !query.trim()}>{busy ? <Spinner small /> : <Icon name="search" size={18} />}{busy ? 'Ищем…' : 'Найти'}</button></form>
        <div className="mvp-search-filters"><div className="mvp-type-filter" aria-label="Вид произведения">{TYPES.map(([value, label]) => <button type="button" key={value} aria-pressed={type === value} className={type === value ? 'active' : ''} onClick={() => selectType(value)}>{label}</button>)}</div><label className="mvp-source-select"><span>Источник</span><select data-testid="source-filter" aria-label="Источник" value={source} onChange={event => setSource(event.target.value)}><option value="all">Все источники</option>{availableSources.map(catalog => <option value={catalog.id} key={catalog.id}>{catalog.name}</option>)}</select></label><button type="button" className="mvp-button secondary mvp-random-button" data-testid="random-book" disabled={busy || randomBusy} onClick={random}>{randomBusy ? <Spinner small /> : <Icon name="shuffle" size={18} />}{randomBusy ? 'Выбираем…' : 'Случайная книга'}</button></div>
        <div className="mvp-source-statuses" aria-label="Состояние источников">{currentSourceStatus.map(catalog => <span key={catalog.id} title={catalog.error || catalog.message || (catalog.status === 'unknown' ? 'Доступность будет проверена при поиске' : catalog.description)} className={['error', 'unavailable', 'blocked'].includes(catalog.status) ? 'unavailable' : catalog.status === 'unknown' ? 'unknown' : ''}><i />{catalog.name || sourceNames[catalog.id]}{['error', 'unavailable', 'blocked'].includes(catalog.status) ? ' · недоступен' : ''}</span>)}</div>
      </section>
      {connection === 'offline' && <Notice error action={<button type="button" className="mvp-text-button" onClick={connect}>Повторить</button>}>Нет связи с сервером. Сохранённые главы доступны в вашей библиотеке.</Notice>}
      {error && <Notice error>{error}<button type="button" className="mvp-text-button" onClick={() => submittedParams.current ? search(null, false) : random()}>Повторить</button></Notice>}
      {sourceErrors.length > 0 && <Notice error><strong>Некоторые источники не ответили.</strong> {sourceErrors.map((value, index) => <span key={index}>{sourceNames[value.source || value.id] || value.source || 'Источник'}: {value.error || value.message || String(value)}{index < sourceErrors.length - 1 ? ' · ' : ''}</span>)} Найденные книги показаны ниже.</Notice>}
      {busy && !items.length ? <section className="mvp-results"><div className="mvp-section-heading"><h2>Ищем в каталогах</h2><span role="status">Поиск может занять до 20 секунд…</span></div><div className="mvp-book-grid" aria-hidden="true">{[0, 1, 2, 3].map(value => <div className="mvp-card-skeleton" key={value}><div /><span /><span /><span /></div>)}</div></section> : searched ? <section className="mvp-results"><div className="mvp-section-heading"><div><h2>{submitted === 'Случайный выбор из каталога' ? 'Выбор случая' : 'Результаты поиска'}</h2><p>{submitted === 'Случайный выбор из каталога' ? 'Настоящая книга из каталога источника' : `По запросу «${submitted}»`}{busy ? ' · Остальные каталоги ещё отвечают…' : ''}</p></div><span>{visibleItems.length} {visibleItems.length === 1 ? 'книга' : visibleItems.length >= 2 && visibleItems.length <= 4 ? 'книги' : 'книг'}{hasMore ? '+' : ''}</span></div>{visibleItems.length ? <><div className="mvp-book-grid">{visibleItems.map(book => <BookCard book={book} key={bookKey(book)} saved={libraryByKey.get(bookKey(book))} onOpen={setSelected} />)}</div>{hasMore && <div className="mvp-load-more"><button type="button" className="mvp-button secondary" disabled={busy} onClick={() => search(null, true)}>{busy ? <Spinner small /> : null}{busy ? 'Загружаем…' : 'Показать ещё'}</button></div>}</> : !error && <EmptyState action={searchEverywhereAction} title={sourceErrors.length ? 'Источники временно недоступны' : 'По этому запросу книг нет'}>{sourceErrors.length ? 'Повторите поиск позже или выберите другой каталог.' : 'Попробуйте более короткое название, имя автора или другой источник. У новеллы может быть несколько вариантов перевода названия.'}</EmptyState>}</section> : !randomBusy && <section className="mvp-start"><div className="mvp-start-copy"><span className="mvp-start-mark"><Icon name="book" size={35} /></span><h2>Ваша следующая история<br />уже где-то ждёт.</h2><p>Начните с названия или автора.<br />А если хочется открытия — доверьтесь случаю.</p></div><div className="mvp-catalog-list"><h3>Где мы ищем</h3>{sources.map(catalog => <button key={catalog.id} type="button" onClick={() => { setType(catalog.kind); setSource(catalog.id); searchRef.current?.focus(); }}><span className={`mvp-catalog-symbol ${catalog.id}`}>{catalog.name?.[0] || catalog.id[0]}</span><span><strong>{catalog.name}</strong><small>{catalog.description}</small></span><Icon name="next" size={16} /></button>)}</div></section>}
      <footer className="mvp-page-footer"><span>Найдите книгу → откройте главу → продолжайте в библиотеке</span><span>Чтение в вашем ритме</span></footer>
    </> : <><section className="mvp-library-header"><p className="mvp-eyebrow">ВАШИ ИСТОРИИ РЯДОМ</p><div className="mvp-page-heading"><div><h1>Моя библиотека</h1><p>Сохранённые книги и место, на котором вы остановились.</p></div><button type="button" className="mvp-button secondary" onClick={() => { setTab('search'); requestAnimationFrame(() => searchRef.current?.focus()); }}><Icon name="plus" size={18} />Найти книгу</button></div></section>{libraryError && <Notice error action={<button type="button" className="mvp-text-button" onClick={loadLibrary}>Повторить</button>}>{libraryError}</Notice>}{libraryLoading ? <div className="mvp-loading" role="status"><Spinner />Открываем библиотеку…</div> : library.length ? <><div className="mvp-library-filter"><div className="mvp-search-input-wrap"><Icon name="search" size={19} /><input type="search" aria-label="Найти в моей библиотеке" placeholder="Найти в библиотеке…" value={libraryFilter} onChange={event => setLibraryFilter(event.target.value)} /></div><span>{visibleLibrary.length} из {library.length} книг</span></div><div className="mvp-book-grid">{visibleLibrary.map(row => <div className="mvp-library-card-wrap" key={bookKey(row.book)}><BookCard book={row.book} saved={row} onOpen={setSelected} onContinue={continueReading} library downloadJob={currentDownload(row.book, row.chapters || [], bookDownloadBranch(row.book, row))} onDownload={downloadFromLibrary} /><button type="button" className="mvp-remove-book" onClick={() => remove(row.book)} aria-label={`Удалить ${row.book.title} из библиотеки`} title="Удалить с этого устройства"><Icon name="trash" size={16} /></button></div>)}</div>{!visibleLibrary.length && <EmptyState title="Такой книги в библиотеке нет">Измените запрос или найдите новую книгу в каталогах.</EmptyState>}<p className="mvp-library-note"><Icon name="device" size={17} />Скачайте книгу целиком, чтобы все её главы были с вами без интернета. Прогресс — в «Загрузках».</p></> : <EmptyState icon="library" title="Здесь будут ваши книги" action={<button type="button" className="mvp-button primary" onClick={() => { setTab('search'); requestAnimationFrame(() => searchRef.current?.focus()); }}><Icon name="search" size={18} />Найти первую книгу</button>}>Добавьте книгу из поиска или откройте первую главу. Гаргантюа запомнит, где вы остановились.</EmptyState>}</>}
      </div></main>}
    {selected && <BookDialog key={bookKey(selected)} candidate={selected} saved={libraryByKey.get(bookKey(selected))} onClose={() => setSelected(null)} onSave={saveBook} onRead={startReading} onMerged={mergedBookReady} onOpenAlternative={setSelected} jobs={downloadJobs} onDownload={downloadBook} suspended={downloadPanel} />}
    {downloadPanel && <DownloadPanel jobs={downloadJobs} error={downloadError} onClose={() => setDownloadPanel(false)} onAction={downloadAction} onOpen={book => { setDownloadPanel(false); setSelected(book); }} />}
    {toast && <div className="mvp-toast" role="status"><Icon name="check" size={18} />{toast}<button type="button" aria-label="Скрыть уведомление" onClick={() => setToast('')}><Icon name="close" size={16} /></button></div>}
  </div>;
}
