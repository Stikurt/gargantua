import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../android/mvp/src/main/assets/native-bridge.js', import.meta.url), 'utf8');
function nativeBridge() {
  const requests = [], timers = new Set();
  const window = {GargantuaAndroid: {postMessage: value => requests.push(JSON.parse(value))}};
  vm.runInNewContext(source, {window, setTimeout: () => { const id = {}; timers.add(id); return id; }, clearTimeout: id => timers.delete(id)});
  function reply(value, responseError) {
    const request = requests.shift(); assert(request, 'Actual bridge request must precede its native response.');
    window.GargantuaAndroid.onmessage({data: JSON.stringify({id: request.id, ...(responseError ? {error: responseError} : {value})})});
    return request;
  }
  return {api: window.gargantua, requests, timers, reply};
}
const plain = value => JSON.parse(JSON.stringify(value));

test('actual Android bridge returns waiting, partial and error job metadata rather than rejecting job.error', async () => {
  const bridge = nativeBridge();
  for (const status of ['waiting', 'partial', 'error']) {
    const job = {id: 'book-download', status, error: 'Источник просит подождать перед продолжением.', sourcePacingMs: {litlife: 8000}, sourceCooldowns: {litlife: 1792843600000}, items: []};
    const result = bridge.api.downloads.getJob(job.id);
    assert.deepEqual(bridge.reply(job), {id: status === 'waiting' ? 1 : status === 'partial' ? 2 : 3, method: 'downloadsGetJob', jobId: job.id});
    assert.deepEqual(plain(await result), job);
  }
  assert.equal(bridge.timers.size, 0);
});

test('actual Android enqueue, pause and resume responses preserve legitimate diagnostic fields', async () => {
  const bridge = nativeBridge(), job = {id: 'book-download', status: 'waiting', error: 'Нет связи с сервером.', retryAt: 1792843600000};
  for (const [method, argument] of [['enqueue', job], ['pause', job.id], ['resume', job.id]]) {
    const result = bridge.api.downloads[method](argument);
    bridge.reply(job);
    assert.deepEqual(plain(await result), job);
  }
  assert.equal(bridge.timers.size, 0);
});

test('actual Android bridge rejects structured native storage, validation and foreground-start failures', async () => {
  const bridge = nativeBridge();
  for (const [status, code] of [[0, 'SERVER_OFFLINE'], [400, 'DOWNLOAD_INVALID'], [507, 'DOWNLOAD_STORAGE'], [503, 'DOWNLOAD_START']]) {
    const result = bridge.api.downloads.getJob('book-download'), error = {error: 'Операция не выполнена.', status, code};
    const rejected = assert.rejects(result, value => value.message === error.error && value.status === status && value.code === code);
    bridge.reply(error); await rejected;
  }
  assert.equal(bridge.timers.size, 0);
});

test('actual Android catalog calls still reject RPC failure values and the native error envelope', async () => {
  const bridge = nativeBridge();
  const importing = bridge.api.catalogs.import(), conflict = assert.rejects(importing, error => error.code === 'CATALOG_CONFLICT' && error.status === 400);
  bridge.reply({error: 'В каталоге другая версия сохранённого раздела.', status: 400, code: 'CATALOG_CONFLICT'}); await conflict;
  const exporting = bridge.api.catalogs.export({format: 'gargantua-catalog'}), cancelled = assert.rejects(exporting, error => error.message === 'Отменено' && error.code === 'CATALOG_CANCELLED');
  bridge.reply(null, {message: 'Отменено', code: 'CATALOG_CANCELLED'}); await cancelled;
  assert.equal(bridge.timers.size, 0);
});

test('actual Android bridge does not interpret application data with string status as a transport error', async () => {
  const bridge = nativeBridge(), job = {id: 'book-download', status: 'waiting', error: 'Источник просит подождать.', code: 'SOURCE_RATE_LIMIT'};
  const result = bridge.api.downloads.getJob(job.id); bridge.reply(job); assert.deepEqual(plain(await result), job);
});
