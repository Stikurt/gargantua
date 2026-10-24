import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import native from '../desktop/sqlite-store.cjs';
import legacy from '../desktop/store.cjs';

const { SqliteStore } = native, { FileStore } = legacy;
const OWNER = '10000000-0000-4000-8000-000000000001', BOOK = '20000000-0000-4000-8000-000000000002';
const BOOK_KEY = `${OWNER}:book:${BOOK}`, key = suffix => `${OWNER}:${suffix}`;
const packet = text => ({ book: { id: BOOK, title: text }, content: { chapters: [{ title: 'Глава', blocks: [{ text }] }] } });
const self = fileURLToPath(import.meta.url), sha = bytes => createHash('sha256').update(bytes).digest('hex');
const childMode = process.env.GARGANTUA_SQLITE_FIXTURE_CHILD;

function checkFixtureRoot(root) {
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  assert.equal(path.basename(root), 'library'); assert.match(path.basename(path.dirname(root)), /^gargantua-sqlite-process-/);
}
if (childMode) {
  const root = process.env.GARGANTUA_SQLITE_FIXTURE_ROOT; checkFixtureRoot(root);
  if (!['apply-before-commit', 'apply-after-commit', 'migration-record', 'migration-after-commit', 'lease'].includes(childMode)) throw Error('Unknown isolated child mode');
  const store = new SqliteStore(root, { fault: async phase => {
    if (phase === childMode) { process.stdout.write('FIXTURE_READY\n'); await new Promise(() => { process.stdin.resume(); }); }
  } });
  await store.init();
  if (childMode === 'lease') {
    store.guard.exec('BEGIN EXCLUSIVE'); process.stdout.write('FIXTURE_READY\n'); process.stdin.resume();
    await new Promise(resolve => process.stdin.once('data', resolve)); store.guard.exec('ROLLBACK'); await store.close();
  } else if (childMode.startsWith('apply-')) {
    await store.apply([{ type: 'put', key: BOOK_KEY, value: packet('After') }, { type: 'put', key: key('position'), value: { chapter: 9 } }, { type: 'put', key: key('outbox'), value: { counter: 2 } }]);
  }
} else {
  async function temporary(action) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gargantua-sqlite-process-')), library = path.join(root, 'library');
    const stores = [], children = [];
    const open = () => { const store = new SqliteStore(library); stores.push(store); return store; };
    const child = mode => {
      const processChild = spawn(process.execPath, [self], { env: { ...process.env, GARGANTUA_SQLITE_FIXTURE_CHILD: mode, GARGANTUA_SQLITE_FIXTURE_ROOT: library }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      children.push(processChild); return processChild;
    };
    try { return await action({ root, library, open, child, children, old: new FileStore(library) }); }
    finally {
      for (const processChild of children) await kill(processChild);
      for (const store of stores.reverse()) await store.close().catch(() => {});
      checkFixtureRoot(library); await fs.rm(root, { recursive: true, force: true });
    }
  }
  async function ready(processChild) {
    await new Promise((resolve, reject) => {
      let output = '', stderr = ''; const timeout = setTimeout(() => finish(Error('Isolated child readiness timeout: ' + stderr.slice(-1000))), 10000);
      const onData = data => { output += data.toString('utf8'); if (/FIXTURE_READY\r?\n/.test(output)) finish(); if (output.length > 1024 * 1024) finish(Error('Child output exceeded its limit')); };
      const onErrorData = data => { stderr = (stderr + data.toString('utf8')).slice(-4096); };
      const onExit = (code, signal) => finish(Error(`Isolated child exited before readiness (${code}/${signal}): ${stderr}`));
      const finish = error => { clearTimeout(timeout); processChild.stdout.off('data', onData); processChild.stderr.off('data', onErrorData); processChild.off('exit', onExit); processChild.off('error', finish); error ? reject(error) : resolve(); };
      processChild.stdout.on('data', onData); processChild.stderr.on('data', onErrorData); processChild.once('exit', onExit); processChild.once('error', finish);
    });
  }
  async function kill(processChild) {
    if (processChild.exitCode !== null || processChild.signalCode !== null) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Owned child did not stop')), 10000);
      processChild.once('exit', () => { clearTimeout(timer); resolve(); }); processChild.once('error', () => { clearTimeout(timer); resolve(); });
      processChild.kill('SIGKILL');
    });
  }
  async function legacyHashes(root) {
    const output = [];
    const walk = async target => {
      let entries; try { entries = await fs.readdir(target, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
      for (const entry of entries) { const filename = path.join(target, entry.name); if (entry.isDirectory()) await walk(filename); else output.push([path.relative(root, filename), sha(await fs.readFile(filename))]); }
    };
    await walk(path.join(root, 'books')); await walk(path.join(root, 'metadata'));
    output.push(['index.json', sha(await fs.readFile(path.join(root, 'index.json')))]); return output.sort(([a], [b]) => a.localeCompare(b, 'en'));
  }

  test('real process termination before COMMIT preserves old book, position and outbox together', () => temporary(async ({ open, child }) => {
    const initial = open(); await initial.apply([{ type: 'put', key: BOOK_KEY, value: packet('Before') }, { type: 'put', key: key('position'), value: { chapter: 1 } }, { type: 'put', key: key('outbox'), value: { counter: 1 } }]); await initial.close();
    const processChild = child('apply-before-commit'); await ready(processChild); await kill(processChild);
    const recovered = open(); assert.equal((await recovered.get(BOOK_KEY)).book.title, 'Before'); assert.deepEqual(await recovered.get(key('position')), { chapter: 1 }); assert.deepEqual(await recovered.get(key('outbox')), { counter: 1 });
    assert.equal((await fs.readdir(recovered.objectsRoot)).length, 1);
  }));

  test('real process termination after COMMIT retains new book, position and outbox together', () => temporary(async ({ open, child }) => {
    const initial = open(); await initial.put(BOOK_KEY, packet('Before')); await initial.close();
    const processChild = child('apply-after-commit'); await ready(processChild); await kill(processChild);
    const recovered = open(); assert.equal((await recovered.get(BOOK_KEY)).book.title, 'After'); assert.deepEqual(await recovered.get(key('position')), { chapter: 9 }); assert.deepEqual(await recovered.get(key('outbox')), { counter: 2 });
    assert.equal((await fs.readdir(recovered.objectsRoot)).length, 1);
  }));

  test('a killed migration retries from unchanged legacy source and never publishes a partial index', () => temporary(async ({ library, old, open, child }) => {
    await old.put(BOOK_KEY, packet('Legacy')); await old.put(key('position'), { chapter: 2 }); await old.put('lastProfile', { id: OWNER });
    const before = await legacyHashes(library), processChild = child('migration-record'); await ready(processChild); await kill(processChild);
    await assert.rejects(() => fs.stat(path.join(library, 'storage-v2', 'migration.json')), { code: 'ENOENT' });
    const recovered = open(); assert.equal((await recovered.get(BOOK_KEY)).book.title, 'Legacy'); assert.equal((await recovered.keys('')).length, 3);
    assert.deepEqual(await legacyHashes(library), before); assert.equal(recovered.migration.entries, 3);
  }));

  test('committed migration recovers its missing filesystem marker after a killed process', () => temporary(async ({ library, old, open, child }) => {
    await old.put(BOOK_KEY, packet('Legacy')); const before = await legacyHashes(library);
    const processChild = child('migration-after-commit'); await ready(processChild); await kill(processChild);
    await assert.rejects(() => fs.stat(path.join(library, 'storage-v2', 'migration.json')), { code: 'ENOENT' });
    const recovered = open(); assert.equal((await recovered.get(BOOK_KEY)).book.title, 'Legacy');
    assert.equal(JSON.parse(await fs.readFile(path.join(library, 'storage-v2', 'migration.json'), 'utf8')).migrationId, recovered.migration.migrationId);
    assert.deepEqual(await legacyHashes(library), before);
  }));

  test('real interprocess SQLite lease rejects a competing writer and unlocks automatically after termination', () => temporary(async ({ open, child }) => {
    const initial = open(); await initial.put(key('keep'), 1); await initial.close();
    const processChild = child('lease'); await ready(processChild);
    const blocked = open(); const started = Date.now(); await assert.rejects(() => blocked.put(key('keep'), 9), /locked|busy/i); assert.ok(Date.now() - started >= 4500);
    await kill(processChild); const recovered = open(); assert.equal(await recovered.get(key('keep')), 1); await recovered.put(key('keep'), 2); assert.equal(await recovered.get(key('keep')), 2);
  }));

  test('Windows FileShare.None lock on an object fails closed and never overwrites the locked book', { skip: process.platform !== 'win32' }, () => temporary(async ({ root, open, children }) => {
    const store = open(); await store.put(BOOK_KEY, packet('Locked'));
    const row = store.db.prepare('SELECT object_sha FROM kv WHERE key=?').get(BOOK_KEY), filename = path.join(store.objectsRoot, row.object_sha + '.json');
    const project = path.resolve(path.dirname(self), '..'), pwsh = path.join(project, '.local', 'tools', 'runtime', 'powershell-7.6.5', 'pwsh.exe');
    await fs.access(pwsh);
    const script = path.join(root, 'hold-object.ps1');
    await fs.writeFile(script, "$ErrorActionPreference='Stop'\n$handle=[IO.File]::Open($env:GARGANTUA_FIXTURE_OBJECT,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)\ntry {[Console]::WriteLine('FIXTURE_READY');[Console]::Out.Flush();$null=[Console]::In.ReadLine()} finally {$handle.Dispose()}\n");
    const holder = spawn(pwsh, ['-NoProfile', '-NonInteractive', '-File', script], { env: { ...process.env, GARGANTUA_FIXTURE_OBJECT: filename }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); children.push(holder);
    await ready(holder); await assert.rejects(() => store.get(BOOK_KEY)); await kill(holder);
    assert.equal((await store.get(BOOK_KEY)).book.title, 'Locked');
  }));
}
