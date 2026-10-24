const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const { DatabaseSync, backup } = require('node:sqlite');

const APPLICATION_ID = 0x47504c32;
const SCHEMA_VERSION = 1;
const MAX_VALUE = 32 * 1024 * 1024;
const MAX_TOTAL = 2 * 1024 * 1024 * 1024;
const MAX_RECORDS = 30000;
const MAX_BATCH = 12000;
const MAX_BATCH_BYTES = 64 * 1024 * 1024;
const MAX_WALK = 100000;
const MAX_MARKER = 16 * 1024 * 1024;
const KEY = /^(lastProfile|[a-f0-9-]{36}:[a-zA-Z0-9:-]{1,180})$/;
const UUID_TEXT = /^[a-f0-9-]{36}$/;
const SHA = /^[a-f0-9]{64}$/;
const decoder = new TextDecoder('utf-8', { fatal: true });
const objectQueues = new Map();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const bytesOf = value => Buffer.from(JSON.stringify(value), 'utf8');

function checkKey(key) {
  if (typeof key !== 'string' || !KEY.test(key)) throw Error('Недопустимый ключ локальной библиотеки');
  const parts = key.split(':');
  if (parts[1] === 'book' && (parts.length !== 3 || !UUID_TEXT.test(parts[2]))) throw Error('Недопустимый ключ книги');
  return key;
}
function bookKey(key) { return key.split(':')[1] === 'book'; }
function within(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}
async function noLinks(target) {
  let current = path.resolve(target);
  while (true) {
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw Error('Ссылки и junction в локальном хранилище запрещены'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}
async function directory(target) {
  await noLinks(target); await fs.mkdir(target, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Неверный каталог локального хранилища');
}
async function syncDirectory(target) {
  let handle;
  try { handle = await fs.open(target, constants.O_RDONLY); await handle.sync(); }
  catch (error) {
    // Windows does not expose directory fsync through Node. File bytes and
    // SQLite commits still use their own FlushFileBuffers-backed sync calls.
    if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EISDIR', 'EINVAL', 'ENOTSUP', 'EBADF'].includes(error.code)) throw error;
  } finally { await handle?.close(); }
}
async function regularBytes(filename, maximum) {
  await noLinks(filename);
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximum || stat.size < 1) throw Error('Неверный размер или тип локального файла');
    const bytes = await handle.readFile();
    if (bytes.length !== stat.size || bytes.length > maximum) throw Error('Локальный файл изменился при чтении');
    return bytes;
  } finally { await handle.close(); }
}
async function regularDigest(filename, maximum) {
  await noLinks(filename);
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat(); if (!stat.isFile() || stat.size < 1 || stat.size > maximum) throw Error('Неверный размер файла резервной копии');
    const hash = createHash('sha256'), buffer = Buffer.alloc(256 * 1024); let position = 0;
    while (position < stat.size) {
      const part = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - position), position);
      if (!part.bytesRead) throw Error('Файл резервной копии изменился при чтении');
      hash.update(buffer.subarray(0, part.bytesRead)); position += part.bytesRead;
    }
    if ((await handle.stat()).size !== stat.size) throw Error('Файл резервной копии изменился при чтении');
    return { sha256: hash.digest('hex'), bytes: position };
  } finally { await handle.close(); }
}
async function syncFile(filename) { const handle = await fs.open(filename, 'r+'); try { await handle.sync(); } finally { await handle.close(); } }
async function writeAtomic(filename, bytes) {
  await directory(path.dirname(filename));
  const temporary = path.join(path.dirname(filename), '.write-' + randomUUID() + '.tmp');
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
    await noLinks(filename); await fs.rename(temporary, filename); await syncDirectory(path.dirname(filename));
  } finally { await handle?.close(); await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
function checkedEnvelope(key, value) {
  checkKey(key);
  let text;
  try { text = JSON.stringify({ key, value }); } catch { throw Error('Локальная запись должна содержать JSON-данные'); }
  if (value === undefined || !text) throw Error('Локальная запись должна содержать значение');
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > MAX_VALUE) throw Error('Локальный пакет превышает 32 МБ');
  const decoded = JSON.parse(text);
  if (!Object.hasOwn(decoded, 'value')) throw Error('Локальная запись должна содержать значение');
  return { key, valueJson: JSON.stringify(decoded.value), bytes, size: bytes.length, kind: bookKey(key) ? 'book' : 'metadata' };
}
function parseEnvelope(bytes, expectedKey) {
  let envelope;
  try { envelope = JSON.parse(decoder.decode(bytes)); } catch { throw Error('Повреждён JSON локальной записи'); }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || Object.keys(envelope).length !== 2 || envelope.key !== expectedKey || !Object.hasOwn(envelope, 'value')) throw Error('Неверная запись локальной библиотеки');
  return envelope.value;
}
function oldLocation(root, key) {
  checkKey(key); const parts = key.split(':');
  return bookKey(key) ? path.join(root, 'books', parts[0], parts[2] + '.cotology.json') : path.join(root, 'metadata', digest(Buffer.from(key)) + '.json');
}

/** Private host service. Renderer callers receive only the narrow storage IPC. */
class SqliteStore {
  constructor(root, options = {}) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw Error('Нужен абсолютный путь хранилища');
    this.root = path.resolve(root); this.storageRoot = path.join(this.root, 'storage-v2');
    this.databasePath = path.join(this.storageRoot, 'library.sqlite'); this.objectsRoot = path.join(this.storageRoot, 'objects');
    this.queue = Promise.resolve(); this.initializing = null; this.ready = false; this.closed = false; this.db = null; this.guard = null; this.failedWrites = new Set();
    // Used only by isolated fault fixtures; not configurable through IPC.
    this.fault = typeof options.fault === 'function' ? options.fault : async () => {};
  }
  async init() {
    if (this.closed) throw Error('Локальное хранилище закрыто');
    if (this.ready) return;
    if (!this.initializing) this.initializing = this.initialize().catch(error => {
      try { this.db?.close(); } catch {} try { this.guard?.close(); } catch {} this.db = null; this.guard = null; this.initializing = null; throw error;
    });
    await this.initializing;
  }
  async initialize() {
    await directory(this.root); await directory(this.storageRoot); await directory(this.objectsRoot);
    return this.withObjectLock(async () => {
    for (const suffix of ['', '-wal', '-shm']) await noLinks(this.databasePath + suffix);
    this.db = new DatabaseSync(this.databasePath, { allowExtension: false, enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false });
    this.db.enableDefensive(true);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
    const identity = this.db.prepare('PRAGMA application_id').get().application_id;
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if ((identity !== 0 && identity !== APPLICATION_ID) || (version !== 0 && version !== SCHEMA_VERSION)) throw Error('Неподдерживаемая версия локальной БД');
    if (identity === 0 && this.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get().n !== 0) throw Error('Неизвестная локальная БД; автоматическая перезапись запрещена');
    if (this.db.prepare('PRAGMA quick_check').all().some(row => row.quick_check !== 'ok')) throw Error('Проверка локальной БД не пройдена');
    if (this.db.prepare('PRAGMA journal_mode=WAL').get().journal_mode !== 'wal') throw Error('SQLite WAL недоступен');
    this.db.exec('PRAGMA wal_autocheckpoint=256; PRAGMA journal_size_limit=16777216;');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`CREATE TABLE IF NOT EXISTS store_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS kv (
          key TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('metadata','book')),
          value_json TEXT,object_sha TEXT,bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND ${MAX_VALUE}),
          CHECK((kind='metadata' AND value_json IS NOT NULL AND json_valid(value_json) AND object_sha IS NULL) OR
                (kind='book' AND value_json IS NULL AND object_sha IS NOT NULL AND length(object_sha)=64 AND object_sha NOT GLOB '*[^a-f0-9]*'))
        ) STRICT;
        CREATE INDEX IF NOT EXISTS kv_object_reference ON kv(object_sha) WHERE kind='book';
        PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA_VERSION};`);
      const saved = this.db.prepare("SELECT value FROM store_meta WHERE key='migration'").get();
      if (saved) { this.migration = this.validateMigration(saved.value); }
      else {
        if (this.db.prepare('SELECT count(*) AS n FROM kv').get().n !== 0) throw Error('Незавершённое хранилище содержит неизвестные данные');
        this.migration = await this.migrateLegacy();
        this.db.prepare("INSERT INTO store_meta(key,value) VALUES('migration',?)").run(JSON.stringify(this.migration));
      }
      await this.fault('migration-before-commit'); this.db.exec('COMMIT'); await this.fault('migration-after-commit');
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw error; }
    await this.publishMigrationMarker();
    await this.reconcileObjects(); this.ready = true;
    });
  }
  async withObjectLock(action) {
    // A separate SQLite OS lock protects immutable-file lifetimes. It is not
    // library authority and is not exported. A process crash releases its lock.
    // This prevents GC racing a backup/read in another store process. The JS
    // queue also avoids blocking one event loop behind its own async file IO.
    const previous = objectQueues.get(this.storageRoot) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      if (!this.guard) {
        const guardPath = path.join(this.storageRoot, 'objects-lock.sqlite'); await noLinks(guardPath); await noLinks(guardPath + '-journal');
        this.guard = new DatabaseSync(guardPath, { allowExtension: false });
        this.guard.exec('PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF; PRAGMA synchronous=EXTRA; CREATE TABLE IF NOT EXISTS object_lease (id INTEGER PRIMARY KEY CHECK(id=1)) STRICT;');
      }
      this.guard.exec('BEGIN EXCLUSIVE');
      try { return await action(); } finally { this.guard.exec('ROLLBACK'); }
    });
    objectQueues.set(this.storageRoot, next);
    try { return await next; } finally { if (objectQueues.get(this.storageRoot) === next) objectQueues.delete(this.storageRoot); }
  }
  validateMigration(text) {
    if (Buffer.byteLength(text) > MAX_MARKER) throw Error('Слишком большой маркер миграции');
    let marker; try { marker = JSON.parse(text); } catch { throw Error('Повреждён маркер миграции'); }
    if (marker?.schemaVersion !== 1 || marker.kind !== 'gargantua-native-storage-v2' || marker.status !== 'complete' || typeof marker.migrationId !== 'string' || !UUID_TEXT.test(marker.migrationId) || !SHA.test(marker.sourceSha256) || !Number.isSafeInteger(marker.entries) || marker.entries < 0 || marker.entries > MAX_RECORDS || !Number.isSafeInteger(marker.bytes) || marker.bytes < 0 || marker.bytes > MAX_TOTAL) throw Error('Неверный маркер миграции');
    return marker;
  }
  async publishMigrationMarker() {
    const filename = path.join(this.storageRoot, 'migration.json'), expected = bytesOf(this.migration);
    try {
      const actual = await regularBytes(filename, MAX_MARKER);
      if (!actual.equals(expected)) throw Error('Маркер миграции не соответствует БД; автоматическая замена запрещена');
    } catch (error) { if (error.code !== 'ENOENT') throw error; await writeAtomic(filename, expected); }
  }
  async legacyFiles() {
    const sources = new Map(); let walked = 0, ignoredTemporary = 0;
    const walk = async (target, depth, kind) => {
      let iterator;
      try { await noLinks(target); iterator = await fs.opendir(target); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      for await (const entry of iterator) {
        if (++walked > MAX_WALK) throw Error('Превышен предел файлов старой библиотеки');
        const filename = path.join(target, entry.name), stat = await fs.lstat(filename);
        if (stat.isSymbolicLink()) throw Error('Ссылка в старой библиотеке; миграция остановлена');
        if (entry.name.endsWith('.tmp') && stat.isFile()) { ignoredTemporary++; continue; }
        if (stat.isDirectory() && kind === 'book' && depth === 0 && UUID_TEXT.test(entry.name)) { await walk(filename, 1, kind); continue; }
        const valid = stat.isFile() && (kind === 'book' ? depth === 1 && /^[a-f0-9-]{36}\.cotology\.json$/.test(entry.name) : depth === 0 && /^[a-f0-9]{64}\.json$/.test(entry.name));
        if (!valid) throw Error('Неизвестный файл в старой библиотеке; миграция остановлена');
        sources.set(path.relative(this.root, filename), filename);
      }
    };
    await walk(path.join(this.root, 'books'), 0, 'book'); await walk(path.join(this.root, 'metadata'), 0, 'metadata');
    return { sources, ignoredTemporary };
  }
  async migrateLegacy() {
    const indexPath = path.join(this.root, 'index.json'); let index = {}, indexBytes = null;
    try {
      indexBytes = await regularBytes(indexPath, 4 * 1024 * 1024); index = JSON.parse(decoder.decode(indexBytes));
      if (!index || typeof index !== 'object' || Array.isArray(index) || Object.keys(index).length > MAX_RECORDS) throw Error('Неверный индекс старой библиотеки');
      for (const [key, value] of Object.entries(index)) if (!checkKey(key) || !Number.isSafeInteger(value) || value < 0 || value > MAX_VALUE) throw Error('Повреждён индекс старой библиотеки');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const { sources, ignoredTemporary } = await this.legacyFiles();
    for (const key of Object.keys(index)) {
      const filename = oldLocation(this.root, key);
      if (!sources.has(path.relative(this.root, filename))) throw Error('Файл из старого индекса отсутствует; исходные данные сохранены');
    }
    const sourceRows = [], knownKeys = new Set(); let total = 0, unindexed = 0, staleSizes = 0;
    for (const [relative, filename] of [...sources].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
      const bytes = await regularBytes(filename, MAX_VALUE); let envelope;
      try { envelope = JSON.parse(decoder.decode(bytes)); } catch { throw Error('Повреждена запись старой библиотеки'); }
      const key = checkKey(envelope?.key);
      parseEnvelope(bytes, key);
      if (path.resolve(oldLocation(this.root, key)) !== path.resolve(filename)) throw Error('Ключ старой записи не соответствует её файлу');
      if (knownKeys.has(key)) throw Error('Повтор ключа старой библиотеки'); knownKeys.add(key);
      if (knownKeys.size > MAX_RECORDS || (total += bytes.length) > MAX_TOTAL) throw Error('Старая библиотека превышает предел 2 ГБ / 30000 записей');
      if (!Object.hasOwn(index, key)) unindexed++; else if (index[key] !== bytes.length) staleSizes++;
      if (bookKey(key)) {
        const sha = await this.writeObject(bytes);
        this.db.prepare("INSERT INTO kv(key,kind,value_json,object_sha,bytes) VALUES(?,'book',NULL,?,?)").run(key, sha, bytes.length);
      } else {
        this.db.prepare("INSERT INTO kv(key,kind,value_json,object_sha,bytes) VALUES(?,'metadata',?,NULL,?)").run(key, JSON.stringify(envelope.value), bytes.length);
      }
      sourceRows.push({ path: relative.replaceAll(path.sep, '/'), sha256: digest(bytes), bytes: bytes.length });
      await this.fault('migration-record', { key, count: knownKeys.size });
    }
    // The old store is retained. If another old client changed it during the
    // copy, the new authority is not published from a mixed source snapshot.
    const after = await this.legacyFiles();
    if (after.sources.size !== sources.size || [...after.sources.keys()].some(key => !sources.has(key))) throw Error('Старая библиотека изменилась во время миграции');
    for (const row of sourceRows) if (digest(await regularBytes(path.join(this.root, row.path), MAX_VALUE)) !== row.sha256) throw Error('Старая запись изменилась во время миграции');
    let afterIndex = null; try { afterIndex = await regularBytes(indexPath, 4 * 1024 * 1024); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (indexBytes ? !afterIndex?.equals(indexBytes) : afterIndex !== null) throw Error('Старый индекс изменился во время миграции');
    return { schemaVersion: 1, kind: 'gargantua-native-storage-v2', status: 'complete', migrationId: randomUUID(), completedAt: new Date().toISOString(),
      entries: knownKeys.size, bytes: total, indexedEntries: Object.keys(index).length, recoveredUnindexedEntries: unindexed, staleIndexSizes: staleSizes, ignoredTemporaryFiles: ignoredTemporary,
      indexSha256: indexBytes ? digest(indexBytes) : null, sourceSha256: digest(bytesOf(sourceRows)), sourceFiles: sourceRows };
  }
  async writeObject(bytes) {
    const sha = digest(bytes), filename = path.join(this.objectsRoot, sha + '.json');
    try { const actual = await regularBytes(filename, MAX_VALUE); if (actual.length !== bytes.length || digest(actual) !== sha) throw Error('Повреждён неизменяемый файл книги'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await writeAtomic(filename, bytes); }
    return sha;
  }
  async readObject(row, root = this.objectsRoot) {
    if (!SHA.test(row.object_sha)) throw Error('Неверная ссылка на файл книги');
    const bytes = await regularBytes(path.join(root, row.object_sha + '.json'), MAX_VALUE);
    if (bytes.length !== row.bytes || digest(bytes) !== row.object_sha) throw Error('Контрольная сумма локальной книги не совпала');
    return parseEnvelope(bytes, row.key);
  }
  async reconcileObjects() {
    const referenced = new Map();
    for (const row of this.db.prepare("SELECT key,object_sha,bytes FROM kv WHERE kind='book'").all()) {
      checkKey(row.key); if (!SHA.test(row.object_sha)) throw Error('Неверная ссылка на локальную книгу');
      const filename = path.join(this.objectsRoot, row.object_sha + '.json'); await noLinks(filename); const stat = await fs.lstat(filename);
      if (!stat.isFile() || stat.size !== row.bytes) throw Error('Файл сохранённой книги отсутствует или повреждён'); referenced.set(row.object_sha, true);
    }
    let count = 0; const orphaned = [];
    for await (const entry of await fs.opendir(this.objectsRoot)) {
      if (++count > MAX_RECORDS * 3) throw Error('Слишком много файлов локального хранилища');
      const filename = path.join(this.objectsRoot, entry.name), stat = await fs.lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Неизвестный объект локального хранилища');
      if (/^\.write-[a-f0-9-]{36}\.tmp$/.test(entry.name)) { orphaned.push(filename); continue; }
      if (!/^[a-f0-9]{64}\.json$/.test(entry.name)) throw Error('Неизвестный объект локального хранилища');
      if (!referenced.has(entry.name.slice(0, 64))) orphaned.push(filename);
    }
    // These content-addressed objects are not authoritative without a committed
    // SQLite reference. Legacy source files and exported copies are never GC'd.
    for (const filename of orphaned) await fs.unlink(filename);
    if (orphaned.length) await syncDirectory(this.objectsRoot);
  }
  async removeUnreferencedObjects(shas) {
    let removed = false;
    for (const sha of shas) {
      if (!SHA.test(sha)) throw Error('Неверный идентификатор локального файла');
      if (this.db.prepare("SELECT 1 AS present FROM kv WHERE kind='book' AND object_sha=? LIMIT 1").get(sha)) continue;
      const filename = path.join(this.objectsRoot, sha + '.json'); await noLinks(filename);
      try { const stat = await fs.lstat(filename); if (!stat.isFile()) throw Error('Неверный объект локального хранилища'); await fs.unlink(filename); removed = true; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (removed) await syncDirectory(this.objectsRoot);
  }
  async get(key) {
    checkKey(key); await this.init();
    return this.withObjectLock(async () => {
      const row = this.db.prepare('SELECT * FROM kv WHERE key=?').get(key);
      if (!row) return null;
      return row.kind === 'book' ? this.readObject(row) : JSON.parse(row.value_json);
    });
  }
  async put(key, value) { return this.apply([{ type: 'put', key, value }]); }
  async remove(key) { return this.apply([{ type: 'remove', key }]); }
  async apply(operations) {
    if (!Array.isArray(operations) || operations.length < 1 || operations.length > MAX_BATCH) throw Error('Недопустимый пакет локальных изменений');
    const keys = new Set(); let bytes = 0;
    const prepared = operations.map(operation => {
      if (!operation || typeof operation !== 'object' || Array.isArray(operation) || !['put', 'remove'].includes(operation.type) || Object.keys(operation).some(name => !['type', 'key', 'value'].includes(name))) throw Error('Неверная локальная операция');
      const key = checkKey(operation.key); if (keys.has(key)) throw Error('Повтор ключа в локальной транзакции'); keys.add(key);
      if (operation.type === 'remove') { if (Object.hasOwn(operation, 'value')) throw Error('Удаление не принимает значение'); return { type: 'remove', key }; }
      const value = checkedEnvelope(key, operation.value); bytes += value.size;
      if (bytes > MAX_BATCH_BYTES) throw Error('Локальная транзакция превышает 64 МБ');
      return { type: 'put', ...value };
    });
    const job = async () => {
      await this.init(); return this.withObjectLock(async () => { this.db.exec('BEGIN IMMEDIATE');
      try {
        const before = this.db.prepare('SELECT count(*) AS n,COALESCE(sum(bytes),0) AS bytes FROM kv').get(); let count = before.n, total = before.bytes; const obsolete = new Set();
        for (const operation of prepared) {
          const old = this.db.prepare('SELECT bytes,object_sha FROM kv WHERE key=?').get(operation.key);
          if (old) { count--; total -= old.bytes; if (old.object_sha) obsolete.add(old.object_sha); }
          if (operation.type === 'put') { count++; total += operation.size; }
        }
        if (count > MAX_RECORDS || total > MAX_TOTAL) throw Error('Локальное хранилище заполнено (2 ГБ / 30000 записей)');
        for (const operation of prepared) {
          if (operation.type === 'remove') this.db.prepare('DELETE FROM kv WHERE key=?').run(operation.key);
          else {
            const sha = operation.kind === 'book' ? await this.writeObject(operation.bytes) : null;
            this.db.prepare('INSERT INTO kv(key,kind,value_json,object_sha,bytes) VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET kind=excluded.kind,value_json=excluded.value_json,object_sha=excluded.object_sha,bytes=excluded.bytes')
              .run(operation.key, operation.kind, sha ? null : operation.valueJson, sha, operation.size);
          }
          await this.fault('apply-record', { key: operation.key });
        }
        await this.fault('apply-before-commit'); this.db.exec('COMMIT'); await this.fault('apply-after-commit');
        await this.removeUnreferencedObjects(obsolete);
      } catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw error; }
      });
    };
    const next = this.queue.then(job).then(value => { for (const operation of prepared) this.failedWrites.delete(operation.key); return value; }, error => { for (const operation of prepared) this.failedWrites.add(operation.key); throw error; });
    this.queue = next.catch(() => {}); return next;
  }
  async keys(prefix) {
    if (typeof prefix !== 'string' || prefix.length > 220) throw Error('Неверный фильтр'); await this.init();
    return this.withObjectLock(async () => this.db.prepare('SELECT key FROM kv WHERE substr(key,1,length(?))=? ORDER BY key').all(prefix, prefix).map(row => row.key));
  }
  async entries(prefix) {
    if (typeof prefix !== 'string' || prefix.length > 220) throw Error('Неверный фильтр'); await this.init();
    return this.withObjectLock(async () => {
      const out = [];
      for (const row of this.db.prepare('SELECT * FROM kv WHERE substr(key,1,length(?))=? ORDER BY key').iterate(prefix, prefix)) out.push([row.key, row.kind === 'book' ? await this.readObject(row) : JSON.parse(row.value_json)]);
      return out;
    });
  }
  async exportSnapshot(destination) {
    if (typeof destination !== 'string' || !path.isAbsolute(destination)) throw Error('Нужен абсолютный путь резервной копии');
    destination = path.resolve(destination);
    if (destination === this.root || within(this.root, destination) || within(destination, this.root)) throw Error('Резервная копия должна находиться вне активного хранилища');
    const job = async () => {
      await this.init(); return this.withObjectLock(async () => { await noLinks(destination);
      try { await fs.lstat(destination); throw Error('Каталог резервной копии уже существует'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await fs.mkdir(destination, { mode: 0o700 }); await directory(path.join(destination, 'objects'));
      const target = path.join(destination, 'library.sqlite'); let copy;
      try {
        // The SQLite backup API includes committed WAL frames. Copying only a
        // live .sqlite file would silently omit recent acknowledged changes.
        await backup(this.db, target);
        copy = new DatabaseSync(target, { readOnly: true, allowExtension: false });
        if (copy.prepare('PRAGMA quick_check').all().some(row => row.quick_check !== 'ok')) throw Error('Резервная БД не прошла проверку');
        const marker = copy.prepare("SELECT value FROM store_meta WHERE key='migration'").get(); this.validateMigration(marker?.value);
        const files = [], seen = new Set(); let total = 0;
        for (const row of copy.prepare('SELECT * FROM kv ORDER BY key').iterate()) {
          checkKey(row.key); total += row.bytes;
          if (row.kind !== 'book' || seen.has(row.object_sha)) continue;
          await this.readObject(row); seen.add(row.object_sha);
          const source = path.join(this.objectsRoot, row.object_sha + '.json'), relative = 'objects/' + row.object_sha + '.json';
          await fs.copyFile(source, path.join(destination, relative), constants.COPYFILE_EXCL); await syncFile(path.join(destination, relative));
          const bytes = await regularBytes(path.join(destination, relative), MAX_VALUE);
          if (digest(bytes) !== row.object_sha || bytes.length !== row.bytes) throw Error('Копия файла книги не прошла проверку');
          files.push({ path: relative, sha256: row.object_sha, bytes: bytes.length });
        }
        copy.close(); copy = null;
        await syncFile(target); files.unshift({ path: 'library.sqlite', ...await regularDigest(target, MAX_TOTAL + 256 * 1024 * 1024) });
        const migrationBytes = bytesOf(this.migration); await writeAtomic(path.join(destination, 'migration.json'), migrationBytes);
        files.push({ path: 'migration.json', sha256: digest(migrationBytes), bytes: migrationBytes.length });
        const report = { schemaVersion: 1, kind: 'gargantua-native-snapshot', status: 'complete', createdAt: new Date().toISOString(), logicalBytes: total, files };
        await writeAtomic(path.join(destination, 'manifest.json'), bytesOf(report)); return report;
      } catch (error) {
        copy?.close(); await writeAtomic(path.join(destination, 'incomplete.json'), bytesOf({ schemaVersion: 1, status: 'incomplete', reason: 'Snapshot validation failed' })).catch(() => {}); throw error;
      }
      });
    };
    const next = this.queue.then(job); this.queue = next.catch(() => {}); return next;
  }
  async backup(destination) { return this.exportSnapshot(destination); }
  async flush() {
    await this.queue; if (this.initializing) await this.initializing;
    await objectQueues.get(this.storageRoot)?.catch(() => {});
    if (this.failedWrites.size) throw Error('Некоторые изменения не сохранены; повторите их сохранение перед закрытием');
    if (this.db && !this.closed) await this.withObjectLock(async () => { this.db.exec('PRAGMA wal_checkpoint(PASSIVE)'); });
  }
  async close() {
    if (!this.closing) this.closing = (async () => {
      await this.queue; if (this.initializing) await this.initializing.catch(() => {});
      await objectQueues.get(this.storageRoot)?.catch(() => {});
      if (this.db) { this.db.close(); this.db = null; } this.guard?.close(); this.guard = null; this.ready = false; this.closed = true;
    })();
    return this.closing;
  }
}

module.exports = { SqliteStore };
