const { randomUUID } = require('node:crypto');

/** Host close gate. Only the matching successful renderer ACK may close data. */
function createCloseCoordinator({ send, onAccepted, onBlocked, timeoutMs = 15000, nonce = randomUUID, setTimer = setTimeout, clearTimer = clearTimeout }) {
  if (typeof send !== 'function' || typeof onAccepted !== 'function' || typeof onBlocked !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw Error('Invalid close coordinator');
  let state = 'open', attemptId = null, timer = null, pending = Promise.resolve();
  const clear = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const blocked = (reason, id, error) => {
    if (attemptId !== id || !['waiting', 'finalizing'].includes(state)) return;
    if (reason === 'timeout' && state !== 'waiting') return;
    clear(); state = 'open'; attemptId = null;
    try { Promise.resolve(onBlocked({ reason, attemptId: id, error })).catch(() => {}); } catch {}
  };
  return {
    get state() { return state; },
    get attemptId() { return attemptId; },
    request() {
      if (state !== 'open') return null;
      const id = nonce();
      if (typeof id !== 'string' || !id || id.length > 128) throw Error('Invalid close attempt identity');
      state = 'waiting'; attemptId = id;
      timer = setTimer(() => blocked('timeout', id), timeoutMs);
      try { send({ attemptId: id }); } catch (error) { blocked('renderer-unavailable', id, error); }
      return id;
    },
    acknowledge(message) {
      if (state !== 'waiting' || !message || typeof message !== 'object' || message.attemptId !== attemptId) return false;
      const id = attemptId;
      if (message.flushFailed !== false || !Number.isSafeInteger(message.rejectedPromises) || message.rejectedPromises !== 0) {
        blocked('renderer-save-failed', id); return false;
      }
      clear(); state = 'finalizing';
      pending = Promise.resolve().then(() => onAccepted({ attemptId: id, acknowledged: true, rejectedPromises: 0 })).then(() => {
        if (state === 'finalizing' && attemptId === id) state = 'closed';
      }, error => blocked('host-save-failed', id, error));
      return true;
    },
    settled() { return pending; }
  };
}

module.exports = { createCloseCoordinator };
