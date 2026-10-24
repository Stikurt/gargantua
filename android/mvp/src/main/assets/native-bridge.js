(() => {
  'use strict';
  const native = window.GargantuaAndroid;
  if (!native?.postMessage || window.gargantua) return;
  let sequence = 0;
  const pending = new Map();
  const closeListeners = new Set();
  native.onmessage = event => {
    let response;
    try { response = JSON.parse(event.data); } catch { return; }
    const entry = pending.get(response.id);
    if (!entry) return;
    pending.delete(response.id);
    clearTimeout(entry.timer);
    if (response.error) entry.reject(Object.assign(new Error(response.error.message || 'Операция не выполнена.'), response.error));
    else entry.resolve(response.value);
  };
  function invoke(method, args = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Object.assign(new Error('Источник не ответил вовремя. Повторите запрос.'), {status: 0, code: 'SOURCE_TIMEOUT'}));
      }, method === 'configureServer' ? 24 * 60 * 60 * 1000 : 125000);
      pending.set(id, {resolve, reject, timer});
      try { native.postMessage(JSON.stringify({id, method, ...args})); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  }
  Object.defineProperty(window, 'gargantua', {value: Object.freeze({
    platform: 'android', version: '0.8.0',
    request: (path, options) => options?.method && options.method !== 'GET'
      ? Promise.resolve({error: 'В приложении доступны только запросы чтения.', status: 400, code: 'REQUEST_INVALID'})
      : invoke('request', {path}),
    getServer: () => invoke('getServer'),
    configureServer: () => invoke('configureServer'),
    configure: () => invoke('configureServer'),
    onBeforeClose: callback => { closeListeners.add(callback); return () => closeListeners.delete(callback); },
  }), configurable: false, writable: false});
  window.__gargantuaLifecycle = name => {
    const promises = [];
    window.dispatchEvent(new CustomEvent(name, {detail: {waitUntil: value => promises.push(Promise.resolve(value))}}));
    return Promise.allSettled(promises);
  };
  window.__gargantuaBack = () => {
    const detail = {handled: false};
    const event = new CustomEvent('gargantua-back', {cancelable: true, detail});
    window.dispatchEvent(event);
    return detail.handled || event.defaultPrevented;
  };
  window.__gargantuaClose = async () => {
    const values = await Promise.allSettled([...closeListeners].map(callback => Promise.resolve().then(callback)));
    const flushFailed = values.some(value => value.status === 'rejected');
    await invoke('closeReady', {flushFailed});
  };
})();
