import {DEVICE, validateCatalogs} from './catalogs.mjs';

export const READER_CATALOG_ID = '00000000-0000-4000-8000-000000000002';
export const READER_INSTALLATION_KEY = `${DEVICE}:sync:installation:v2`;
const TYPES = ['reading', 'bookmark', 'catalog'];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const mutexes = new Map(), synchronizations = new Map();
const MAX_QUEUE = 2000, MAX_STATE_BYTES = 8 * 1024 * 1024;
export const READER_SYNC_TRANSACTION_LIMITS = Object.freeze({operations: 12000, bytes: 32 * 1024 * 1024});
const STREAM_REVIEWS = ['server-counter-rollback', 'device-counter-ahead', 'device-counter-mismatch', 'device-identity-collision', 'device-protocol-changed'];
const fail = (code, message, status = 409) => { throw Object.assign(new Error(message), {code, status}); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
const uuid = value => { if (typeof value !== 'string' || !UUID.test(value)) fail('SYNC_DATA', 'Некорректный идентификатор', 400); return value.toLowerCase(); };
const exact = (value, fields) => { if (!plain(value) || Object.keys(value).some(key => !fields.includes(key))) fail('SYNC_DATA', 'Неизвестные поля данных', 400); };
const clone = value => JSON.parse(canonical(value));
function canonical(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value === 'string') {
    if (value.isWellFormed && !value.isWellFormed()) fail('SYNC_DATA', 'Повреждённый текст', 400);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (plain(value)) {
    if (Object.keys(value).some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) fail('SYNC_DATA', 'Недопустимое поле данных', 400);
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  fail('SYNC_DATA', 'Нужны обычные JSON-данные', 400);
}
function text(value, maximum, multiline = false, minimum = 0) {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum || (multiline ? /[\p{Cf}\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u : /[\p{Cc}\p{Cf}]/u).test(value)) fail('SYNC_DATA', 'Недопустимый текст данных читателя', 400);
  canonical(value); return value;
}
function locator(value, publicationId) {
  if (value?.type === 'legacy') {
    exact(value, ['type', 'chapter', 'position']);
    if (!integer(value.chapter, 0, 19999) || typeof value.position !== 'number' || !Number.isFinite(value.position) || value.position < 0 || value.position > 1) fail('SYNC_DATA', 'Неверная позиция чтения', 400);
    return clone(value);
  }
  exact(value, ['publicationId', 'publicationRevision', 'chapterId', 'blockId', 'offset', 'quote', 'progression']);
  if (uuid(value.publicationId) !== publicationId || value.publicationRevision !== 1 || typeof value.chapterId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(value.chapterId)) fail('SYNC_DATA', 'Неверная версия или глава публикации', 400);
  if (value.blockId !== undefined && (typeof value.blockId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(value.blockId)) || value.offset !== undefined && (!value.blockId || !integer(value.offset, 0, 100000)) || value.progression !== undefined && (typeof value.progression !== 'number' || !Number.isFinite(value.progression) || value.progression < 0 || value.progression > 1)) fail('SYNC_DATA', 'Неверный текстовый якорь', 400);
  if (value.quote !== undefined) {
    if (!value.blockId) fail('SYNC_DATA', 'Цитате нужен текстовый блок', 400);
    exact(value.quote, ['exact', 'prefix', 'suffix']); text(value.quote.exact, 1000, true, 1);
    for (const key of ['prefix', 'suffix']) if (value.quote[key] !== undefined) text(value.quote[key], 200, true);
  }
  return clone(value);
}
export function normalizeSyncPayload(type, value) {
  if (type === 'catalog') {
    exact(value, ['catalogs']);
    const catalogs = clone(value.catalogs);
    validateCatalogs(catalogs);
    for (const catalog of catalogs) {
      exact(catalog, ['id', 'title', 'parent', 'items']); catalog.id = uuid(catalog.id);
      catalog.title = text(catalog.title, 120, false, 1).trim();
      if (catalog.parent !== null) catalog.parent = uuid(catalog.parent);
      const seen = new Set();
      for (const item of catalog.items) {
        exact(item, ['id', 'scope', 'title', 'author']); item.id = uuid(item.id);
        text(item.title, 250); text(item.author, 250);
        if (seen.has(item.scope + ':' + item.id)) fail('SYNC_DATA', 'Повтор книги в каталоге', 400);
        seen.add(item.scope + ':' + item.id);
      }
    }
    const payload = {catalogs};
    if (new TextEncoder().encode(canonical(payload)).length > 24000) fail('SYNC_DATA', 'Каталоги превышают 24 КБ', 413);
    return payload;
  }
  if (!['reading', 'bookmark'].includes(type)) fail('SYNC_DATA', 'Неизвестный тип данных читателя', 400);
  const field = type === 'reading' ? 'shelf' : 'note';
  exact(value, ['publicationId', 'publicationRevision', 'locator', field]);
  const publicationId = uuid(value.publicationId);
  if (value.publicationRevision !== 1) fail('SYNC_DATA', 'Неизвестная версия публикации', 400);
  const payload = {publicationId, publicationRevision: 1, locator: locator(value.locator, publicationId)};
  if (type === 'reading') {
    payload.shelf = value.shelf ?? 'reading';
    if (!['reading', 'planned', 'finished', 'paused', 'dropped', 'favorite'].includes(payload.shelf)) fail('SYNC_DATA', 'Неизвестная полка', 400);
  } else payload.note = text(value.note ?? '', 500, true);
  return payload;
}
function identity(type, id) {
  if (!TYPES.includes(type)) fail('SYNC_DATA', 'Неизвестный тип данных', 400);
  const value = uuid(id);
  if (type === 'catalog' && value !== READER_CATALOG_ID) fail('SYNC_DATA', 'Неверный идентификатор каталогов', 400);
  return type + ':' + value;
}
function entityRecord(value) {
  exact(value, ['entityType', 'entityId', 'revision', 'deleted', 'payload', 'updatedAt']);
  identity(value.entityType, value.entityId);
  if (!integer(value.revision, value.entityType === 'catalog' ? 0 : 1, 2147483647) || typeof value.deleted !== 'boolean' || value.revision === 0 && value.deleted) fail('SYNC_RESPONSE', 'Неверная версия серверной записи');
  const entity = {...value, entityId: uuid(value.entityId)};
  if (value.updatedAt !== undefined && (typeof value.updatedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(value.updatedAt) || !Number.isFinite(Date.parse(value.updatedAt)))) fail('SYNC_RESPONSE', 'Неверное время серверной записи');
  entity.payload = value.deleted && value.payload === null ? null : normalizeSyncPayload(value.entityType, value.payload);
  if (value.entityType === 'reading' && entity.payload && entity.entityId !== entity.payload.publicationId) fail('SYNC_RESPONSE', 'Позиция относится к другой книге');
  return clone(entity);
}
async function sha256(crypto, value) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}
export async function readerMutationIdV2(crypto, profile, device, counter) {
  if (!integer(counter, 1)) fail('SYNC_COUNTER', 'Исчерпан счётчик устройства');
  const bytes = (await sha256(crypto, `gargantua-reader-v2\0${uuid(profile)}\0${uuid(device)}\0${counter}`)).slice(0, 16);
  bytes[6] = (bytes[6] & 15) | 128; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function randomId(crypto) {
  if (crypto.randomUUID) return uuid(crypto.randomUUID());
  const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function scopedCursor(value, profileId) {
  try {
    if (typeof value !== 'string' || value.length > 200 || !/^[A-Za-z0-9_-]+$/.test(value)) throw Error();
    const source = value.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(source + '='.repeat((4 - source.length % 4) % 4)), character => character.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
    if (!plain(parsed) || Object.keys(parsed).sort().join(',') !== 'profileId,revision,schemaVersion' || parsed.schemaVersion !== 1 || parsed.profileId !== profileId || !integer(parsed.revision)) throw Error();
    return value;
  } catch { fail('SYNC_AUTHORITY', 'Ответ относится к другому профилю или версии сервера', 403); }
}
async function mutex(key, operation) {
  const previous = mutexes.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  mutexes.set(key, current);
  try { return await current; } finally { if (mutexes.get(key) === current) mutexes.delete(key); }
}
function writes(input = []) {
  if (!Array.isArray(input) || input.length > 100) fail('SYNC_DATA', 'Слишком много локальных изменений', 400);
  return input.map(operation => {
    exact(operation, ['type', 'key', 'value']);
    if (!['put', 'remove'].includes(operation.type) || typeof operation.key !== 'string' || !operation.key || operation.key.length > 220 || operation.key.includes(':sync:')) fail('SYNC_DATA', 'Неверная локальная запись', 400);
    return operation.type === 'put' ? {type: 'put', key: operation.key, value: clone(operation.value)} : {type: 'remove', key: operation.key};
  });
}
function revision(state, key) { return state.remote[key]?.revision ?? 0; }
const brief = error => ({code: String(error?.code ?? 'SYNC_OFFLINE'), status: Number.isInteger(error?.status) ? error.status : 0, message: String(error?.message || 'Сервер недоступен').slice(0, 500)});

/** Dependency-injected, local-first v2 synchronization. Network operations never
 * hold the storage lock. The allocated request is persisted before transmission.
 */
export async function createReaderSync({storage, api, crypto = globalThis.crypto, serverIdentity, profileId, projectEntity, withLock}) {
  profileId = uuid(profileId);
  if (!storage?.get || !storage?.apply || typeof api !== 'function' || !crypto?.subtle) fail('SYNC_DEPENDENCY', 'Недоступно безопасное локальное хранилище', 503);
  let authority;
  try {
    const url = new URL(serverIdentity);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error();
    authority = url.origin + url.pathname.replace(/\/+$/, '');
  } catch { fail('SYNC_AUTHORITY', 'Не указан адрес именно подключённого сервера', 400); }
  const serverHash = [...await sha256(crypto, authority)].map(value => value.toString(16).padStart(2, '0')).join('');
  const stateKey = `${DEVICE}:sync:${serverHash}:${profileId}`, listeners = new Set();
  const lock = (key, operation) => mutex(key, () => withLock ? withLock(operation) : globalThis.navigator?.locks?.request ? navigator.locks.request(`gargantua-reader-sync:${key}`, operation) : operation());
  let installation;
  await lock(READER_INSTALLATION_KEY, async () => {
    installation = await storage.get(READER_INSTALLATION_KEY);
    if (installation) {
      if (installation.schemaVersion !== 1 || installation.protocolVersion !== 2) fail('SYNC_STATE', 'Неизвестная версия установки');
      uuid(installation.installationId);
    } else {
      installation = {schemaVersion: 1, protocolVersion: 2, installationId: randomId(crypto)};
      await storage.apply([{type: 'put', key: READER_INSTALLATION_KEY, value: installation}]);
    }
  });
  const fresh = () => ({schemaVersion: 1, protocolVersion: 2, serverHash, profileId, installationId: installation.installationId, deviceId: randomId(crypto), nextCounter: 1, cursor: null, remote: {}, devices: [], desired: [], inflight: null, reviews: [], blocked: null});
  function checked(state) {
    if (!plain(state) || state.schemaVersion !== 1 || state.protocolVersion !== 2 || state.serverHash !== serverHash || state.profileId !== profileId || state.installationId !== installation.installationId || !integer(state.nextCounter, 1) || !Array.isArray(state.desired) || !Array.isArray(state.reviews) || !plain(state.remote)) fail('SYNC_STATE', 'Локальный журнал повреждён; исходные данные сохранены');
    uuid(state.deviceId);
    state.devices ??= [];
    if (!Array.isArray(state.devices) || state.devices.length > 100) fail('SYNC_STATE', 'Повреждён снимок счётчиков устройств');
    if (state.cursor !== null) scopedCursor(state.cursor, profileId);
    if (state.inflight !== null) {
      exact(state.inflight, ['intentId', 'mutation']); uuid(state.inflight.intentId);
      const mutation = state.inflight.mutation;
      exact(mutation, ['mutationId', 'deviceId', 'counter', 'protocolVersion', 'entityType', 'entityId', 'baseRevision', 'operation', 'payload']);
      uuid(mutation.mutationId); identity(mutation.entityType, mutation.entityId);
      if (mutation.deviceId !== state.deviceId || mutation.protocolVersion !== 2 || !integer(mutation.counter, 1) || mutation.counter !== state.nextCounter - 1 || !integer(mutation.baseRevision, 0, 2147483646) || !['upsert', 'delete'].includes(mutation.operation)) fail('SYNC_STATE', 'Повреждена отправляемая операция; исходные данные сохранены');
      if (mutation.operation === 'upsert') {
        const payload = normalizeSyncPayload(mutation.entityType, mutation.payload);
        if (canonical(payload) !== canonical(mutation.payload) || mutation.entityType === 'reading' && mutation.entityId !== payload.publicationId) fail('SYNC_STATE', 'Изменено содержимое отправляемой операции');
      } else if (mutation.payload !== undefined) fail('SYNC_STATE', 'Удаление содержит неизвестные данные');
    }
    if (state.desired.length > MAX_QUEUE || state.reviews.length > MAX_QUEUE || new TextEncoder().encode(canonical(state)).length > MAX_STATE_BYTES) fail('SYNC_CAPACITY', 'Локальный журнал переполнен; нужна проверка', 429);
    return state;
  }
  const read = async () => checked(clone(await storage.get(stateKey)));
  const emit = state => { for (const listener of listeners) { try { listener(clone(state)); } catch {} } };
  async function save(state, extra = []) {
    checked(state);
    if (extra.length + 1 > READER_SYNC_TRANSACTION_LIMITS.operations) fail('SYNC_CAPACITY', 'Изменений слишком много для одной безопасной записи', 429);
    const operations = [...extra, {type: 'put', key: stateKey, value: state}];
    if (new TextEncoder().encode(canonical(operations)).length > READER_SYNC_TRANSACTION_LIMITS.bytes) fail('SYNC_CAPACITY', 'Локальная транзакция превышает 32 МиБ', 429);
    await storage.apply(operations);
    emit(state);
    return clone(state);
  }
  await lock(stateKey, async () => {
    const saved = await storage.get(stateKey);
    if (saved) checked(saved); else await save(fresh());
  });
  const projection = async entity => projectEntity ? writes(await projectEntity(clone(entity))) : [];
  const keyOf = intent => identity(intent.entityType, intent.entityId);
  function addReview(state, reason, proposed, current = null, latestLocal = null) {
    const review = {id: randomId(crypto), reason, entityType: proposed.entityType, entityId: proposed.entityId, proposed: clone(proposed), current: current ? clone(current) : null, latestLocal: latestLocal ? clone(latestLocal) : null};
    state.reviews.push(review); return review;
  }
  function recheckDesired(state) {
    const retained = [];
    for (const desired of state.desired) {
      if (desired.afterMutationId || state.reviews.some(review => keyOf(review) === keyOf(desired))) { retained.push(desired); continue; }
      const current = state.remote[keyOf(desired)] ?? null, currentRevision = current?.revision ?? 0;
      if (desired.baseRevision === null && current === null) desired.baseRevision = 0;
      if (desired.baseRevision === null || desired.baseRevision !== currentRevision) addReview(state, desired.baseRevision === null ? 'unbased-local-intent' : 'remote-changed', desired, current);
      else retained.push(desired);
    }
    state.desired = retained;
  }
  async function authenticate() {
    const me = await api('/me');
    if (me?.id !== profileId) fail('SYNC_AUTHORITY', 'Открыт другой профиль. Локальные изменения сохранены отдельно.', 403);
  }
  async function fetchSnapshot() {
    const value = await api('/v2/reader/snapshot');
    if (value?.schemaVersion !== 1 || !Array.isArray(value.entities) || value.entities.length > 10000 || !Array.isArray(value.devices) || value.devices.length > 100) fail('SYNC_RESPONSE', 'Сервер вернул неподдерживаемый снимок');
    scopedCursor(value.cursor, profileId);
    const remote = {}, devices = new Map();
    for (const row of value.entities) {
      const entity = entityRecord(row), key = identity(entity.entityType, entity.entityId);
      if (remote[key]) fail('SYNC_RESPONSE', 'Повтор записи серверного снимка');
      remote[key] = entity;
    }
    for (const row of value.devices) {
      const deviceId = uuid(row.deviceId);
      if (devices.has(deviceId) || !integer(row.lastCounter) || ![1, 2].includes(row.protocolVersion) || !integer(row.compactedThrough, 0, row.lastCounter) || !integer(row.compactedCount, 0, row.compactedThrough)) fail('SYNC_RESPONSE', 'Неверный счётчик серверного снимка');
      devices.set(deviceId, clone(row));
    }
    return {cursor: value.cursor, remote, devices};
  }
  async function installSnapshot(snapshot, {consumed = false} = {}) {
    return lock(stateKey, async () => {
      const state = await read(), device = snapshot.devices.get(state.deviceId), remoteCounter = device?.lastCounter ?? 0;
      if (device && device.protocolVersion !== 2) fail('SYNC_PROTOCOL', 'Этот поток устройства закреплён за старым протоколом');
      const expected = state.nextCounter - 1, minimum = state.inflight ? state.inflight.mutation.counter - 1 : expected;
      if (!consumed && (remoteCounter < minimum || remoteCounter > expected)) {
        const reason = remoteCounter < minimum ? 'server-counter-rollback' : 'device-counter-ahead';
        state.blocked = {code: 'SYNC_COUNTER_REVIEW', status: 409, message: 'Счётчик сервера изменился. Автоматическая отправка приостановлена.'};
        if (!state.reviews.some(review => review.reason === reason)) {
          const proposed = state.inflight?.mutation ?? state.desired[0] ?? {entityType: 'catalog', entityId: READER_CATALOG_ID, operation: 'upsert', payload: {catalogs: []}};
          addReview(state, reason, proposed, snapshot.remote[keyOf(proposed)] ?? null);
        }
        await save(state); fail('SYNC_COUNTER_REVIEW', state.blocked.message);
      }
      state.remote = snapshot.remote; state.devices = [...snapshot.devices.values()]; state.cursor = snapshot.cursor;
      const extra = [];
      for (const [key, entity] of Object.entries(state.remote)) {
        if (!state.desired.some(intent => keyOf(intent) === key) && (!state.inflight || keyOf(state.inflight.mutation) !== key) && !state.reviews.some(review => keyOf(review) === key)) extra.push(...await projection(entity));
      }
      if (consumed) state.nextCounter = remoteCounter + 1;
      recheckDesired(state);
      return save(state, extra);
    });
  }
  async function pause(error) {
    await lock(stateKey, async () => { const state = await read(); state.blocked = brief(error); await save(state); });
  }
  async function stage(input) {
    exact(input, ['scope', 'entityType', 'entityId', 'operation', 'payload', 'writes', 'expectedBaseRevision']);
    if (!['device', 'server'].includes(input.scope)) fail('SYNC_SCOPE', 'Нужно явно выбрать локальную или серверную книгу', 400);
    if (input.expectedBaseRevision !== undefined && !integer(input.expectedBaseRevision, 0, 2147483646)) fail('SYNC_DATA', 'Неверная ожидаемая версия данных', 400);
    const localWrites = writes(input.writes);
    if (input.scope === 'device') { await storage.apply(localWrites); return {localOnly: true, queued: false}; }
    const key = identity(input.entityType, input.entityId);
    if (!['upsert', 'delete'].includes(input.operation)) fail('SYNC_DATA', 'Неизвестная операция', 400);
    const normalized = {entityType: input.entityType, entityId: uuid(input.entityId), operation: input.operation};
    if (input.operation === 'upsert') {
      normalized.payload = normalizeSyncPayload(input.entityType, input.payload);
      if (input.entityType === 'reading' && normalized.entityId !== normalized.payload.publicationId) fail('SYNC_DATA', 'Позиция относится к другой книге', 400);
    } else if (input.payload !== undefined) fail('SYNC_DATA', 'Удаление не принимает содержимое', 400);
    return lock(stateKey, async () => {
      const state = await read(), previous = state.desired.find(intent => keyOf(intent) === key), flight = state.inflight && keyOf(state.inflight.mutation) === key ? state.inflight.mutation : null;
      const pinned = input.expectedBaseRevision !== undefined;
      if (pinned && revision(state, key) !== input.expectedBaseRevision) fail('SYNC_REVISION_REVIEW', 'Серверная версия изменилась. Сначала согласуйте её с открытой локальной версией.');
      const pinnedRevision = pinned ? input.expectedBaseRevision : previous?.expectedBaseRevision;
      const desired = {...normalized, intentId: previous?.intentId ?? randomId(crypto), baseRevision: pinned ? input.expectedBaseRevision : previous?.baseRevision ?? (flight ? flight.baseRevision + 1 : state.cursor === null ? null : revision(state, key)), ...(pinnedRevision !== undefined ? {expectedBaseRevision: pinnedRevision} : {}), ...(flight ? {afterMutationId: flight.mutationId} : {})};
      const review = state.reviews.find(entry => keyOf(entry) === key);
      if (review) review.latestLocal = desired;
      else if (previous) state.desired[state.desired.indexOf(previous)] = desired;
      else state.desired.push(desired);
      await save(state, localWrites);
      return {localOnly: false, queued: !review, reviewRequired: Boolean(review)};
    });
  }
  async function allocate() {
    return lock(stateKey, async () => {
      const state = await read();
      if (state.blocked?.code === 'SYNC_COUNTER_REVIEW') return null;
      if (state.inflight) {
        if (state.inflight.mutation.mutationId !== await readerMutationIdV2(crypto, profileId, state.deviceId, state.inflight.mutation.counter)) fail('SYNC_STATE', 'ID отправляемой операции не совпадает с её счётчиком');
        return clone(state.inflight);
      }
      recheckDesired(state);
      const index = state.desired.findIndex(intent => !intent.afterMutationId && !state.reviews.some(review => keyOf(review) === keyOf(intent)));
      if (index < 0) { await save(state); return null; }
      const intent = state.desired[index], counter = state.nextCounter;
      if (!integer(counter, 1, Number.MAX_SAFE_INTEGER - 1)) fail('SYNC_COUNTER', 'Исчерпан счётчик устройства');
      const mutation = {mutationId: await readerMutationIdV2(crypto, profileId, state.deviceId, counter), deviceId: state.deviceId, counter, protocolVersion: 2, entityType: intent.entityType, entityId: intent.entityId, baseRevision: intent.baseRevision, operation: intent.operation, ...(intent.operation === 'upsert' ? {payload: intent.payload} : {})};
      state.desired.splice(index, 1); state.inflight = {intentId: intent.intentId, mutation}; state.nextCounter++;
      await save(state); return clone(state.inflight);
    });
  }
  async function acknowledge(flight, response) {
    if (response?.schemaVersion !== 1 || !Array.isArray(response.results) || response.results.length !== 1) fail('SYNC_RESPONSE', 'Неполное подтверждение сервера');
    scopedCursor(response.cursor, profileId);
    const result = response.results[0], mutation = flight.mutation, key = keyOf(mutation);
    if (result?.mutationId !== mutation.mutationId || !['accepted', 'conflict'].includes(result.status)) fail('SYNC_RESPONSE', 'Ответ не соответствует отправленной операции');
    const entity = result.status === 'accepted' ? entityRecord(result.entity) : result.current === null ? null : entityRecord(result.current);
    if (entity && identity(entity.entityType, entity.entityId) !== key) fail('SYNC_RESPONSE', 'Подтверждение относится к другой записи');
    if (result.status === 'accepted' && (result.compacted || entity.revision !== mutation.baseRevision + 1 || entity.deleted !== (mutation.operation === 'delete') || mutation.operation === 'upsert' && canonical(entity.payload) !== canonical(mutation.payload))) fail('SYNC_RESPONSE', 'Содержимое подтверждения изменилось');
    if (result.status === 'conflict' && (result.code !== 'REVISION_CONFLICT' || canonical(result.proposed) !== canonical(mutation) || (entity?.revision ?? 0) === mutation.baseRevision)) fail('SYNC_RESPONSE', 'Неполные данные конфликта');
    return lock(stateKey, async () => {
      const state = await read();
      if (!state.inflight || canonical(state.inflight) !== canonical(flight)) {
        // A second browser context may receive the same idempotent ACK after
        // the first context has already committed it. Never project it again.
        if (state.nextCounter > mutation.counter && state.inflight?.mutation.counter !== mutation.counter) return clone(state);
        fail('SYNC_STATE', 'Локальное подтверждение устарело');
      }
      const following = state.desired.find(intent => intent.afterMutationId === mutation.mutationId);
      state.inflight = null; state.cursor = response.cursor; state.blocked = null;
      // An idempotent receipt is a historical result. A snapshot may already
      // contain a later edit or tombstone from another device. Its newer entity
      // must survive replay of this older ACK.
      const known = state.remote[key] ?? null;
      const current = known && (!entity || known.revision > entity.revision) ? known : entity;
      if (current) state.remote[key] = current; else delete state.remote[key];
      if (result.status === 'conflict') {
        const review = addReview(state, 'revision-conflict', mutation, current, following);
        if (entity && current?.revision !== entity.revision) review.receiptCurrent = entity;
        if (following) state.desired.splice(state.desired.indexOf(following), 1);
      } else if (following) {
        delete following.afterMutationId;
        if (following.expectedBaseRevision === undefined) following.baseRevision = entity.revision;
      }
      return save(state, result.status === 'accepted' && !following ? await projection(current) : []);
    });
  }
  async function compacted(flight) {
    const snapshot = await fetchSnapshot();
    await lock(stateKey, async () => {
      const state = await read(), device = snapshot.devices.get(state.deviceId);
      if (!state.inflight || canonical(state.inflight) !== canonical(flight) || !device || device.protocolVersion !== 2 || device.lastCounter < flight.mutation.counter || device.compactedThrough < flight.mutation.counter) fail('SYNC_RESPONSE', 'Нет безопасного подтверждения сокращённого журнала');
      const key = keyOf(flight.mutation), following = state.desired.find(intent => intent.afterMutationId === flight.mutation.mutationId);
      state.remote = snapshot.remote; state.devices = [...snapshot.devices.values()]; state.cursor = snapshot.cursor; state.nextCounter = device.lastCounter + 1;
      addReview(state, 'receipt-compacted', flight.mutation, state.remote[key] ?? null, following);
      if (following) state.desired.splice(state.desired.indexOf(following), 1);
      state.inflight = null; state.blocked = null; recheckDesired(state);
      await save(state);
    });
  }
  async function reviewStream(flight, error) {
    const reason = error.code === 'READER_IDEMPOTENCY' ? 'device-identity-collision' : error.code === 'READER_PROTOCOL' ? 'device-protocol-changed' : 'device-counter-mismatch';
    await lock(stateKey, async () => {
      const state = await read();
      if (!state.inflight || canonical(state.inflight) !== canonical(flight)) return;
      if (!state.reviews.some(review => STREAM_REVIEWS.includes(review.reason))) {
        const review = addReview(state, reason, flight.mutation, state.remote[keyOf(flight.mutation)] ?? null);
        if (integer(error.expectedCounter, 1)) review.expectedCounter = error.expectedCounter;
      }
      state.blocked = {code: 'SYNC_COUNTER_REVIEW', status: 409, message: 'Поток устройства не совпадает с сервером. Очередь сохранена для проверки.'};
      await save(state);
    });
    fail('SYNC_COUNTER_REVIEW', 'Поток устройства требует проверки. Автоматическая отправка приостановлена.');
  }
  async function synchronize() {
    try {
      await authenticate(); await installSnapshot(await fetchSnapshot());
      for (let count = 0; count < 100; count++) {
        const flight = await allocate();
        if (!flight) break;
        try {
          const response = await api('/v2/reader/mutations', {method: 'POST', body: {mutations: [clone(flight.mutation)]}});
          await acknowledge(flight, response);
        } catch (error) {
          if (error?.status === 409 && error.code === 'READER_RECEIPT_COMPACTED' && error.consumed === true && error.snapshotRequired === true) await compacted(flight);
          else if (error?.status === 409 && ['READER_COUNTER', 'READER_IDEMPOTENCY', 'READER_PROTOCOL'].includes(error.code)) await reviewStream(flight, error);
          else throw error;
        }
      }
      return lock(stateKey, read);
    } catch (error) { await pause(error); throw error; }
  }
  function sync() {
    if (synchronizations.has(stateKey)) return synchronizations.get(stateKey);
    // A separate coordinator lock can span network calls without blocking the
    // short storage lock used by stage(). Desktop also permits one main window.
    const active = globalThis.navigator?.locks?.request ? navigator.locks.request(`gargantua-reader-sync-network:${stateKey}`, synchronize) : synchronize();
    synchronizations.set(stateKey, active);
    active.finally(() => { if (synchronizations.get(stateKey) === active) synchronizations.delete(stateKey); }).catch(() => {});
    return active;
  }
  async function resolve(reviewId, choice) {
    uuid(reviewId);
    if (!['local', 'remote', 'edited'].includes(choice)) fail('SYNC_REVIEW', 'Выберите локальную, серверную или новую ручную правку', 400);
    return lock(stateKey, async () => {
      const state = await read(), index = state.reviews.findIndex(review => review.id === reviewId);
      if (index < 0) fail('SYNC_REVIEW', 'Предложение уже согласовано', 404);
      const review = state.reviews[index], key = keyOf(review), current = state.remote[key] ?? null;
      if (STREAM_REVIEWS.includes(review.reason)) fail('SYNC_COUNTER_REVIEW', 'Сначала явно создайте новый поток после проверки копии сервера');
      if (choice === 'local' && review.reason === 'receipt-compacted') fail('SYNC_MANUAL_EDIT_REQUIRED', 'Прежняя операция уже учтена. Сверьте версии; новое изменение нужно сделать вручную.');
      if (choice === 'edited' && (review.reason !== 'receipt-compacted' || !review.latestLocal)) fail('SYNC_REVIEW', 'Сначала сделайте новую ручную правку и проверьте её перед отправкой', 400);
      const archiveHash = [...await sha256(crypto, stateKey + '\0' + review.id)].map(value => value.toString(16).padStart(2, '0')).join('');
      const archiveKey = `${DEVICE}:review:${archiveHash}`;
      const extra = [{type: 'put', key: archiveKey, value: {schemaVersion: 1, serverHash, profileId, choice, review}}];
      state.reviews.splice(index, 1);
      if (choice === 'local' || choice === 'edited') {
        const proposed = choice === 'edited' ? review.latestLocal : review.latestLocal ?? review.proposed;
        const intent = {intentId: randomId(crypto), entityType: proposed.entityType, entityId: proposed.entityId, operation: proposed.operation, baseRevision: current?.revision ?? 0};
        if (intent.operation === 'upsert') intent.payload = normalizeSyncPayload(intent.entityType, proposed.payload);
        state.desired = state.desired.filter(desired => keyOf(desired) !== key); state.desired.push(intent);
      } else {
        state.desired = state.desired.filter(desired => keyOf(desired) !== key);
        // Absence on the server is also an explicit choice. Its local projection
        // removes the proposal without inventing a server-side tombstone.
        extra.push(...await projection(current ?? {entityType: review.entityType, entityId: review.entityId, revision: 0, deleted: true, payload: review.latestLocal?.payload ?? review.proposed.payload ?? null}));
      }
      return save(state, extra);
    });
  }
  async function stageLegacy(entries) {
    if (!Array.isArray(entries) || entries.length > 100) fail('SYNC_LEGACY', 'Согласуйте не больше 100 старых записей за один раз', 400);
    return lock(stateKey, async () => {
      const state = await read(), extra = [], seen = new Set();
      for (const entry of entries) {
        exact(entry, ['legacyKey', 'proposal']);
        if (typeof entry.legacyKey !== 'string' || !entry.legacyKey.startsWith(profileId + ':pending:') || seen.has(entry.legacyKey)) fail('SYNC_LEGACY', 'Неверная область старого журнала', 400);
        seen.add(entry.legacyKey);
        const raw = await storage.get(entry.legacyKey);
        if (raw === undefined || raw === null) continue;
        if (new TextEncoder().encode(canonical(raw)).length > 128000) fail('SYNC_LEGACY', 'Старая запись превышает безопасный размер', 413);
        const proposal = entry.proposal;
        identity(proposal.entityType, proposal.entityId);
        if (!['upsert', 'delete'].includes(proposal.operation)) fail('SYNC_LEGACY', 'Неизвестная старая операция', 400);
        const proposed = {entityType: proposal.entityType, entityId: uuid(proposal.entityId), operation: proposal.operation, ...(proposal.operation === 'upsert' ? {payload: normalizeSyncPayload(proposal.entityType, proposal.payload)} : {})};
        const review = addReview(state, 'legacy-unverified', proposed, state.remote[keyOf(proposed)] ?? null);
        review.legacy = {key: entry.legacyKey, original: clone(raw)};
        extra.push({type: 'remove', key: entry.legacyKey});
      }
      return save(state, extra);
    });
  }
  async function restartStream({acknowledged = false} = {}) {
    if (!acknowledged) fail('SYNC_COUNTER_REVIEW', 'Нужно явно подтвердить создание нового потока');
    return lock(stateKey, async () => {
      const state = await read();
      if (!state.reviews.some(review => STREAM_REVIEWS.includes(review.reason))) fail('SYNC_REVIEW', 'Сбоя счётчика нет');
      if (state.inflight) addReview(state, 'previous-stream', state.inflight.mutation, state.remote[keyOf(state.inflight.mutation)] ?? null);
      for (const desired of state.desired) addReview(state, 'previous-stream', desired, state.remote[keyOf(desired)] ?? null);
      state.reviews = state.reviews.filter(review => !STREAM_REVIEWS.includes(review.reason));
      state.inflight = null; state.desired = []; state.deviceId = randomId(crypto); state.nextCounter = 1; state.blocked = null;
      return save(state);
    });
  }
  return Object.freeze({stateKey, serverHash, profileId, stage, sync, resolve, stageLegacy, restartStream,
    getState: () => lock(stateKey, read), subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }});
}
