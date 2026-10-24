import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';

const main = await fs.readFile(new URL('../desktop/main.cjs', import.meta.url), 'utf8');
const preload = await fs.readFile(new URL('../desktop/preload.cjs', import.meta.url), 'utf8');
const startupPrefix = main.slice(0, main.indexOf('const single='));
function mode(args, env = {}) {
  const settings = {};
  const electron = { protocol: { registerSchemesAsPrivileged() {} }, app: {
    setName() {}, setAppUserModelId() {}, getPath: () => path.join(os.tmpdir(), 'fake-appdata'), setPath: (key, value) => { settings[key] = value; }
  } };
  const result = vm.runInNewContext(startupPrefix + '\n({SERVER,selfCheck,mediaSelfCheck,readerSelfCheck,offlineCheck})', {
    process: { argv: ['fixture', 'main.cjs', ...args], env }, URL,
    require: name => name === 'electron' ? electron : name === 'node:path' ? path : {}
  });
  return { ...result, settings };
}

test('media self-check selects only its own loopback server and isolated userData', () => {
  const result = mode(['--reader-media-self-check'], { COTOLOGY_READER_MEDIA_FIXTURE_ORIGIN: 'http://127.0.0.1:49275' });
  assert.equal(result.SERVER, 'http://127.0.0.1:49275'); assert.equal(result.mediaSelfCheck, true); assert.equal(result.readerSelfCheck, false);
  assert.equal(path.basename(result.settings.userData), 'Cotology-MediaSelfCheck');
});

test('media online mode cannot accidentally fall back to production', () => {
  assert.throws(() => mode(['--reader-media-self-check']), /explicit loopback fixture/);
  for (const origin of ['http://127.0.0.1:3080', 'http://localhost:49512', 'https://127.0.0.1:49512', 'http://192.168.1.1:49512', 'http://127.0.0.1:0', 'http://127.0.0.1:65536', 'http://127.0.0.1:49275/path', 'http://127.0.0.1:49275?query=1', 'http://127.0.0.1:49275/']) {
    assert.throws(() => mode(['--reader-media-self-check'], { COTOLOGY_READER_MEDIA_FIXTURE_ORIGIN: origin }), /Invalid isolated/);
  }
});

test('media offline mode remains isolated without a live fixture', () => {
  const result = mode(['--reader-media-self-check', '--offline']);
  assert.equal(result.offlineCheck, true); assert.equal(path.basename(result.settings.userData), 'Cotology-MediaSelfCheck');
});

test('normal launch ignores the test-only origin and keeps the existing data identity', () => {
  const result = mode([], { COTOLOGY_READER_MEDIA_FIXTURE_ORIGIN: 'http://127.0.0.1:49275' });
  assert.equal(result.SERVER, 'http://127.0.0.1:3080'); assert.equal(result.selfCheck, false); assert.equal(path.basename(result.settings.userData), 'Cotology');
});

test('mixed self-check modes are refused before touching any data path', () => {
  for (const other of ['--self-check', '--reader-self-check', '--audio-self-check']) assert.throws(() => mode(['--reader-media-self-check', other]), /own isolated mode/);
});

test('preload exposes media and offline flags without enabling the ordinary reader fixture', () => {
  let native;
  vm.runInNewContext(preload, {
    process: { argv: ['fixture', '--cotology-self-check', '--cotology-media-self-check', '--cotology-self-check-offline'] },
    require: () => ({ contextBridge: { exposeInMainWorld: (_name, api) => { native = api; } }, ipcRenderer: { on() {}, invoke() {} } })
  });
  assert.equal(native.selfCheckMedia, true); assert.equal(native.selfCheckReader, false); assert.equal(native.selfCheckAudio, false); assert.equal(native.selfCheckOffline, true);
});
