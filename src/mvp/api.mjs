const BASE = '/api/mvp';
function responseError(value, status) {
  const error = new Error(value?.error || value?.message || `Сервер не выполнил запрос (${status})`);
  error.status = Number.isFinite(status) ? status : Number.isFinite(value?.status) ? value.status : 0;
  error.code = value?.code;
  if (Number.isFinite(value?.retryAfterMs) && value.retryAfterMs >= 0) error.retryAfterMs = value.retryAfterMs;
  return error;
}

export async function request(path, options = {}) {
  const address = path.startsWith('/api/') ? path : BASE + path;
  const method = options.method || 'GET';
  const headers = { 'Accept': 'application/json', 'X-Cotology': '1', ...options.headers };
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  if (body) headers['Content-Type'] = 'application/json';
  let value;
  try {
    if (window.gargantua?.request) {
      value = await window.gargantua.request(address, { method, headers, ...(body ? { body } : {}) });
      if (value?.error && !value.items && !value.book) throw responseError(value, value.status);
      return value;
    }
    let response;
    if (window.cotologyNative?.request) {
      const result = await window.cotologyNative.request(address, { method, headers, ...(body ? { body } : {}) });
      const bytes = Uint8Array.from(atob(result.data), char => char.charCodeAt(0));
      response = new Response(bytes, { status: result.status, headers: { 'Content-Type': result.type || 'application/json' } });
    } else {
      response = await fetch(address, { method, headers, body, signal: AbortSignal.timeout(90000) });
    }
    try { value = await response.json(); } catch { throw new Error('Сервер вернул непонятный ответ. Повторите попытку.'); }
    if (!response.ok) {
      throw responseError(value, response.status);
    }
    return value;
  } catch (error) {
    if (/Error invoking remote method/.test(error.message || '')) error.message = error.message.replace(/^Error invoking remote method[\s\S]*?:\s*Error:\s*/, '');
    if (error.name === 'TimeoutError' || error.name === 'AbortError') throw Object.assign(new Error('Источник отвечает слишком долго. Повторите поиск или выберите другой источник.'), {code:'SOURCE_TIMEOUT',status:0});
    if (error instanceof TypeError && /fetch|network/i.test(error.message)) throw Object.assign(new Error('Нет связи с сервером. Проверьте подключение и повторите попытку.'), {code:'SERVER_OFFLINE',status:0});
    throw error;
  }
}

export function endpoint(path, values = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  return path + (params.size ? '?' + params : '');
}

const SOURCE_REGISTRY = 'gargantua-source-registry';
export function savedSources() {
  try {
    const values = JSON.parse(globalThis.localStorage?.getItem(SOURCE_REGISTRY) || '[]');
    return Array.isArray(values) ? values.filter(value => value && typeof value.id === 'string' && typeof value.name === 'string') : [];
  } catch { return []; }
}
export const sourceNames = {
  ranobelib: 'RanobeLib', gutenberg: 'Project Gutenberg', wikisource: 'Викитека',
  litlife: 'ЛитЛайф', libcat: 'ЛибКат', ranobeme: 'Ranobe.me', ranobehub: 'RanobeHub', merged: 'Объединённая книга',
  ...Object.fromEntries(savedSources().map(value => [value.id, value.name])),
};
export function registerSources(values) {
  const registry = new Map(savedSources().map(value => [value.id, value]));
  for (const value of Array.isArray(values) ? values : []) {
    const id = value.id || value.source;
    if (typeof id !== 'string' || typeof value.name !== 'string') continue;
    sourceNames[id] = value.name;
    const previous = registry.get(id);
    registry.set(id, { id, name: value.name, kind: value.kind || previous?.kind, description: value.description || previous?.description });
  }
  try { globalThis.localStorage?.setItem(SOURCE_REGISTRY, JSON.stringify([...registry.values()])); } catch {}
}
export const bookKey = book => `${book.source}:${book.id}`;
export const sourceName = book => book?.sourceName || sourceNames[book?.source] || book?.source || 'Каталог';
export const authorName = book => Array.isArray(book?.author) ? book.author.join(', ') : book?.author || (Array.isArray(book?.authors) ? book.authors.map(author => typeof author === 'string' ? author : author.name).join(', ') : 'Автор не указан');

// Chapter identity survives outline extensions and library merges.
export function chapterOrigin(book, chapter, branchId) {
  const origin = chapter?.origin || {};
  return {
    source: origin.source || book.source,
    bookId: origin.bookId ?? origin.id ?? book.id,
    chapterId: origin.chapterId ?? chapter?.id ?? chapter?.number ?? chapter?.index,
    // A merged descriptor owns its branch. A reader bookmark from the base
    // edition must never select that branch in a different source.
    branchId: chapter?.origin ? origin.branchId ?? '' : branchId ?? chapter?.branchId ?? book.defaultBranchId ?? '',
  };
}
export const originKey = origin => JSON.stringify([String(origin.source), String(origin.bookId), String(origin.branchId ?? ''), String(origin.chapterId)]);

