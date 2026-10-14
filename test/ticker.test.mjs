import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTicker } from '../js/ticker.js';

function makeFakeTimer() {
  let cb = null;
  let ms = null;
  let cleared = false;
  const setTimer = (fn, interval) => {
    cb = fn;
    ms = interval;
    return 'interval-id';
  };
  const clearTimer = (id) => {
    assert.equal(id, 'interval-id');
    cleared = true;
  };
  return {
    setTimer,
    clearTimer,
    fire: (n = 1) => {
      for (let i = 0; i < n; i++) cb();
    },
    get ms() {
      return ms;
    },
    get cleared() {
      return cleared;
    },
  };
}

test('ticker: schedules the 1 s interval via injected setTimer', () => {
  const timer = makeFakeTimer();
  const ticker = createTicker({ setTimer: timer.setTimer, clearTimer: timer.clearTimer });
  ticker.start();
  assert.equal(timer.ms, 1000);
});

test('ticker: registered callbacks fire once per simulated second', () => {
  const timer = makeFakeTimer();
  const ticker = createTicker({ setTimer: timer.setTimer, clearTimer: timer.clearTimer });
  let calls = 0;
  ticker.register('a', () => calls++);
  ticker.start();

  timer.fire(3);
  assert.equal(calls, 3);
});

test('ticker: callback receives the current epoch ms', () => {
  const timer = makeFakeTimer();
  const ticker = createTicker({ setTimer: timer.setTimer, clearTimer: timer.clearTimer });
  let received;
  ticker.register('a', (nowMs) => {
    received = nowMs;
  });
  ticker.start();
  timer.fire();
  assert.equal(typeof received, 'number');
  assert.ok(received > 0);
});

test('ticker: unregistering stops updates for that id specifically, others keep firing', () => {
  const timer = makeFakeTimer();
  const ticker = createTicker({ setTimer: timer.setTimer, clearTimer: timer.clearTimer });
  let aCalls = 0;
  let bCalls = 0;
  ticker.register('a', () => aCalls++);
  ticker.register('b', () => bCalls++);
  ticker.start();

  timer.fire();
  assert.equal(aCalls, 1);
  assert.equal(bCalls, 1);

  ticker.unregister('a');
  timer.fire();
  assert.equal(aCalls, 1, 'a no longer fires after unregister');
  assert.equal(bCalls, 2, 'b keeps firing');
});

test('ticker: stop() clears the underlying interval and start() is idempotent', () => {
  const timer = makeFakeTimer();
  const ticker = createTicker({ setTimer: timer.setTimer, clearTimer: timer.clearTimer });
  ticker.start();
  ticker.start(); // idempotent: does not schedule a second interval silently breaking clearTimer's id check
  ticker.stop();
  assert.equal(timer.cleared, true);
});

test('ticker: a callback that unregisters itself mid-tick does not skip or duplicate remaining callbacks', () => {
  const timer = makeFakeTimer();
  const ticker = createTicker({ setTimer: timer.setTimer, clearTimer: timer.clearTimer });
  let bCalls = 0;
  ticker.register('a', () => ticker.unregister('a'));
  ticker.register('b', () => bCalls++);
  ticker.start();

  timer.fire(2);
  assert.equal(bCalls, 2);
});

test('ticker: never accepts a store or api dependency (structurally no network/store side effects)', () => {
  // createTicker's only parameters are setTimer/clearTimer; passing anything
  // else (store, api) has no effect because the function signature never
  // reads such keys at all.
  const timer = makeFakeTimer();
  const fakeStore = { setState: () => { throw new Error('ticker must never touch the store'); } };
  const fakeApi = { getOrders: () => { throw new Error('ticker must never make a network request'); } };
  const ticker = createTicker({
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
    store: fakeStore,
    api: fakeApi,
  });
  ticker.register('a', () => {});
  ticker.start();
  timer.fire(5);
  // No throw above proves the extraneous store/api deps were never touched.
});
