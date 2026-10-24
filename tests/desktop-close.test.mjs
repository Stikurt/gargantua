import test from 'node:test';
import assert from 'node:assert/strict';
import closeModule from '../desktop/close-coordinator.cjs';

const { createCloseCoordinator } = closeModule;
function host(options = {}) {
  let now = 0, sequence = 0, timerId = 0;
  const timers = new Map(), allTimers = new Map(), sent = [], blocked = [], accepted = [];
  const storage = { open: true, value: 'old', writes: 0 };
  const coordinator = createCloseCoordinator({
    nonce: () => 'attempt-' + (++sequence), timeoutMs: 15000,
    setTimer: (action, delay) => { const id = ++timerId; const timer = { at: now + delay, action }; timers.set(id, timer); allTimers.set(id, timer); return id; },
    clearTimer: id => timers.delete(id),
    send: message => { sent.push(message); options.send?.(message); },
    onBlocked: event => { blocked.push(event); options.onBlocked?.(event); },
    onAccepted: async event => {
      accepted.push(event); await options.beforeClose?.(event);
      storage.open = false;
    }
  });
  return {
    coordinator, storage, sent, blocked, accepted, allTimers,
    tick(milliseconds) { now += milliseconds; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.action(); } },
    write(value) { assert.equal(storage.open, true, 'Host must keep accepting native writes until a valid save ACK'); storage.value = value; storage.writes++; },
    ack(id, override = {}) { return coordinator.acknowledge({ attemptId: id, rejectedPromises: 0, flushFailed: false, ...override }); }
  };
}

test('host does not flush or close data while the renderer is still saving', async () => {
  const h = host(), id = h.coordinator.request(); h.tick(14999);
  assert.equal(h.coordinator.state, 'waiting'); assert.equal(h.storage.open, true); assert.equal(h.accepted.length, 0);
  h.write('saved before ACK'); assert.equal(h.ack(id), true); await h.coordinator.settled();
  assert.equal(h.storage.value, 'saved before ACK'); assert.equal(h.storage.open, false); assert.equal(h.coordinator.state, 'closed');
  assert.equal(h.accepted[0].acknowledged, true);
});

test('absent ACK times out by keeping the window and store open, never by closing them', async () => {
  const h = host(), id = h.coordinator.request(); h.tick(15000); await h.coordinator.settled();
  assert.equal(h.coordinator.state, 'open'); assert.equal(h.storage.open, true); assert.equal(h.accepted.length, 0);
  assert.equal(h.blocked.length, 1); assert.equal(h.blocked[0].reason, 'timeout'); assert.equal(h.blocked[0].attemptId, id);
  h.write('native write after timeout'); assert.equal(h.storage.value, 'native write after timeout');
});

test('a renderer save delayed beyond the timeout still reaches native storage and its old ACK is ignored', async () => {
  const h = host(), first = h.coordinator.request(); h.tick(20000);
  h.write('latest reading position'); assert.equal(h.ack(first), false);
  assert.equal(h.storage.open, true); assert.equal(h.accepted.length, 0);
  const second = h.coordinator.request(); assert.notEqual(second, first);
  assert.equal(h.ack(second), true); await h.coordinator.settled();
  assert.equal(h.storage.value, 'latest reading position'); assert.equal(h.storage.open, false);
});

test('a late old ACK cannot close a new retry, including an old rejected ACK', async () => {
  const h = host(), first = h.coordinator.request(); h.tick(15000); const second = h.coordinator.request();
  assert.equal(h.ack(first), false); assert.equal(h.ack(first, { flushFailed: true }), false);
  assert.equal(h.coordinator.state, 'waiting'); assert.equal(h.coordinator.attemptId, second); assert.equal(h.storage.open, true);
  h.write('second save'); assert.equal(h.ack(second), true); await h.coordinator.settled();
  assert.equal(h.accepted.length, 1); assert.equal(h.accepted[0].attemptId, second);
});

test('failed or rejected renderer saves retain the live store and permit a fresh retry', async () => {
  for (const rejection of [{ flushFailed: true }, { rejectedPromises: 1 }, { rejectedPromises: -1 }, { rejectedPromises: undefined }, { flushFailed: undefined }]) {
    const h = host(), first = h.coordinator.request(); assert.equal(h.ack(first, rejection), false);
    assert.equal(h.storage.open, true); assert.equal(h.coordinator.state, 'open'); assert.equal(h.accepted.length, 0);
    assert.equal(h.blocked[0].reason, 'renderer-save-failed');
    const second = h.coordinator.request(); h.write('retry saved'); assert.equal(h.ack(second), true); await h.coordinator.settled(); assert.equal(h.storage.value, 'retry saved');
  }
});

test('repeated close requests and duplicate ACKs cannot create a second finalizer', async () => {
  let release; const delayed = new Promise(resolve => { release = resolve; });
  const h = host({ beforeClose: () => delayed }), id = h.coordinator.request();
  assert.equal(h.coordinator.request(), null); assert.equal(h.sent.length, 1); assert.equal(h.ack(id), true);
  await Promise.resolve(); assert.equal(h.coordinator.state, 'finalizing'); assert.equal(h.coordinator.request(), null); assert.equal(h.ack(id), false);
  release(); await h.coordinator.settled(); assert.equal(h.accepted.length, 1); assert.equal(h.coordinator.request(), null);
});

test('an already queued canceled timer cannot cancel an accepted close', async () => {
  let release; const delayed = new Promise(resolve => { release = resolve; });
  const h = host({ beforeClose: () => delayed }), id = h.coordinator.request(), oldTimer = h.allTimers.get(1);
  assert.equal(h.ack(id), true); oldTimer.action(); assert.equal(h.coordinator.state, 'finalizing'); assert.equal(h.blocked.length, 0);
  release(); await h.coordinator.settled(); assert.equal(h.storage.open, false);
});

test('an old timer cannot affect a newer attempt', () => {
  const h = host(), first = h.coordinator.request(), oldTimer = h.allTimers.get(1); h.tick(15000); const second = h.coordinator.request();
  oldTimer.action(); assert.equal(h.coordinator.state, 'waiting'); assert.equal(h.coordinator.attemptId, second); assert.notEqual(second, first); assert.equal(h.blocked.length, 1);
});

test('host flush failure keeps the gate open and a successful retry can finish', async () => {
  let fail = true;
  const h = host({ beforeClose: () => { if (fail) throw Error('disk unavailable'); } }), first = h.coordinator.request();
  assert.equal(h.ack(first), true); await h.coordinator.settled();
  assert.equal(h.storage.open, true); assert.equal(h.coordinator.state, 'open'); assert.equal(h.blocked[0].reason, 'host-save-failed');
  fail = false; const second = h.coordinator.request(); assert.equal(h.ack(second), true); await h.coordinator.settled(); assert.equal(h.storage.open, false);
});

test('unavailable renderer and malformed or foreign acknowledgments never close native storage', () => {
  const h = host({ send: () => { throw Error('renderer gone'); } }); h.coordinator.request(); assert.equal(h.coordinator.state, 'open'); assert.equal(h.storage.open, true); assert.equal(h.blocked[0].reason, 'renderer-unavailable');
  const healthy = host(), id = healthy.coordinator.request();
  for (const message of [null, {}, { attemptId: 'foreign' }, { attemptId: id, flushFailed: false, rejectedPromises: '0' }]) assert.equal(healthy.coordinator.acknowledge(message), false);
  assert.equal(healthy.storage.open, true); assert.equal(healthy.accepted.length, 0);
});
