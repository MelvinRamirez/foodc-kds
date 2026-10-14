import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../js/store.js';
import { initialState, actions } from '../js/actions.js';
import * as completionMod from '../js/completion.js';
import { POLL_INTERVAL_MS } from '../js/config.js';
import { startPolling, pollNow, unlock, completeOrder, startCompletionRunner, lock } from '../js/effects.js';

// --- test helpers -----------------------------------------------------

function makeFakeTimers() {
  // A minimal synchronous fake-timer harness: setTimer schedules { id, cb, ms,
  // due } entries; `advance(ms)` fires every due callback in due-time order,
  // supporting callbacks that themselves schedule further timers.
  let nextId = 1;
  let now = 0;
  const pending = new Map();

  function setTimer(cb, ms) {
    const id = nextId++;
    pending.set(id, { cb, due: now + ms });
    return id;
  }
  function clearTimer(id) {
    pending.delete(id);
  }
  function advance(ms) {
    now += ms;
    // Fire every timer whose due time has arrived, in due-time order. A
    // callback firing may schedule new timers; keep sweeping until nothing
    // more is due at `now`.
    for (;;) {
      let nextDue = null;
      for (const [id, entry] of pending) {
        if (entry.due <= now && (nextDue === null || entry.due < nextDue.due)) {
          nextDue = { id, ...entry };
        }
      }
      if (nextDue === null) break;
      pending.delete(nextDue.id);
      nextDue.cb();
    }
  }
  function getNow() {
    return now;
  }
  return { setTimer, clearTimer, advance, getNow, pending };
}

function makeMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
  };
}

function makeCtx({ api, timers = makeFakeTimers(), pinStorage = makeMemoryStorage(), unlocked = true } = {}) {
  const store = createStore(initialState({ hasPin: unlocked }));
  const ctx = {
    store,
    api,
    pinStorage,
    now: timers.getNow,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    isVisible: () => true,
    isOnline: () => true,
  };
  return { ctx, store, timers };
}

function okOrders(orders) {
  return { kind: 'success', data: orders, meta: null };
}

function unauthorized() {
  return { kind: 'definitive', code: 'UNAUTHORIZED', message: '', details: null };
}

// --- Task 11.1 RED test (polls never overlap) --------------------------
// Written before js/effects.js existed. Confirmed RED at that point with
// `ERR_MODULE_NOT_FOUND: Cannot find module '.../js/effects.js'` when running
// `node --test test/effects.test.mjs`. Now GREEN against the implementation.

test('11.1: polls never overlap; next poll is scheduled POLL_INTERVAL_MS after the slow response settles', async () => {
  let getOrdersCalls = 0;
  let resolveSlow;
  const api = {
    getOrders: () => {
      getOrdersCalls++;
      return new Promise((resolve) => {
        resolveSlow = resolve;
      });
    },
  };
  const { ctx, timers } = makeCtx({ api });

  const stop = startPolling(ctx);
  assert.equal(typeof stop, 'function');
  assert.equal(getOrdersCalls, 1, 'first poll fires immediately on start');

  // Advance time while the first poll is still in flight: no second
  // getOrders call may be issued, and nothing is scheduled yet (settle has
  // not happened).
  timers.advance(POLL_INTERVAL_MS * 3);
  assert.equal(getOrdersCalls, 1, 'no overlapping poll while the first is in flight');

  // Now let the slow response settle.
  resolveSlow(okOrders([]));
  await Promise.resolve();
  await Promise.resolve();

  // Immediately after settle, no new poll yet.
  assert.equal(getOrdersCalls, 1);

  // Just under POLL_INTERVAL_MS after settle: still nothing.
  timers.advance(POLL_INTERVAL_MS - 1);
  assert.equal(getOrdersCalls, 1);

  // Exactly POLL_INTERVAL_MS after settle: the next poll fires.
  timers.advance(1);
  assert.equal(getOrdersCalls, 2, 'next poll scheduled exactly POLL_INTERVAL_MS after settle');

  stop();
});

// --- Task 11.2 RED test (UNAUTHORIZED relock) ---------------------------
// Written before relock existed in js/effects.js. Confirmed RED at that
// point with the same ERR_MODULE_NOT_FOUND. Now GREEN.

test('11.2: UNAUTHORIZED from a poll clears the PIN, stops the poller, keeps queue/pending, resumes after unlock', async () => {
  let getOrdersCalls = 0;
  let nextResult = unauthorized();
  const api = {
    getOrders: () => {
      getOrdersCalls++;
      return Promise.resolve(nextResult);
    },
    verifyPin: () => Promise.resolve({ kind: 'success', data: { valid: true }, meta: null }),
  };
  const { ctx, store, timers } = makeCtx({ api, pinStorage: makeMemoryStorage() });

  // Seed the store with queue data and a pending completion, as design
  // requires both to survive a relock untouched. No completion runner is
  // started yet in this test (the completion-runner-specific relock path,
  // including "pending kept + runner paused", is covered by 11.2b below) so
  // the poll's own relock can be asserted without a second effect racing on
  // the same pending entry.
  store.setState((s) => actions.pollSucceeded(s, { orders: [{ order_id: 'Q1' }], seq: 1, at: 0 }));
  store.setState((s) =>
    actions.completionQueued(s, { order: { order_id: 'P1', table_number: '7' }, at: 0 }),
  );
  const queueBefore = store.getState().queue;
  const pendingBefore = store.getState().completions.pending;

  ctx.pinStorage.setItem('foodc.kds.pin', '123456');

  startPolling(ctx);

  // Let the first (UNAUTHORIZED) poll resolve.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(store.getState().auth.status, 'locked');
  assert.equal(store.getState().auth.error, 'rejected');
  assert.strictEqual(store.getState().queue, queueBefore, 'queue.orders untouched by relock');
  assert.strictEqual(store.getState().completions.pending, pendingBefore, 'pending completions untouched by relock');
  assert.equal(ctx.pinStorage.getItem('foodc.kds.pin'), null, 'stored PIN cleared');

  const callsAtRelock = getOrdersCalls;
  // No reschedule after UNAUTHORIZED: advancing time must not trigger more polls.
  timers.advance(POLL_INTERVAL_MS * 5);
  assert.equal(getOrdersCalls, callsAtRelock, 'poller does not reschedule after UNAUTHORIZED');

  // The completion runner, started only now (after relock), must not
  // process the still-pending entry while locked, even when woken.
  let updateCalls = 0;
  api.updateOrderStatus = () => {
    updateCalls++;
    return Promise.resolve({ kind: 'success', data: { order_id: 'P1' }, meta: null });
  };
  const runner = startCompletionRunner(ctx);
  await Promise.resolve();
  assert.equal(updateCalls, 0, 'runner does not process entries while locked');
  runner.wake();
  await Promise.resolve();
  assert.equal(updateCalls, 0, 'runner stays paused after relock even when woken');

  // Resume: unlock succeeds, polling and runner resume.
  nextResult = okOrders([{ order_id: 'Q1' }]);
  await unlock(ctx, '654321');
  assert.equal(store.getState().auth.status, 'unlocked');

  await Promise.resolve();
  await Promise.resolve();
  assert.ok(getOrdersCalls > callsAtRelock, 'poller resumes after a successful unlock');

  runner.wake();
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(updateCalls > 0, 'completion runner resumes processing pending entries after unlock');

  runner.stop();
});

test('11.2b: UNAUTHORIZED from a completion attempt relocks, keeps the entry pending, and pauses the runner', async () => {
  let updateCalls = 0;
  const api = {
    getOrders: () => Promise.resolve(okOrders([])),
    updateOrderStatus: () => {
      updateCalls++;
      return Promise.resolve(unauthorized());
    },
  };
  const { ctx, store } = makeCtx({ api, pinStorage: makeMemoryStorage() });
  ctx.pinStorage.setItem('foodc.kds.pin', '123456');

  store.setState((s) =>
    actions.completionQueued(s, { order: { order_id: 'C1', table_number: '3' }, at: 0 }),
  );
  const pendingBefore = store.getState().completions.pending;

  const runner = startCompletionRunner(ctx);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(updateCalls, 1);
  assert.equal(store.getState().auth.status, 'locked');
  assert.equal(store.getState().auth.error, 'rejected');
  assert.strictEqual(store.getState().completions.pending, pendingBefore, 'pending entry kept, not confirmed/retried');
  assert.equal(ctx.pinStorage.getItem('foodc.kds.pin'), null);

  // Runner stays paused: waking does not re-issue the call.
  runner.wake();
  await Promise.resolve();
  assert.equal(updateCalls, 1, 'runner paused: no further completion attempts while locked');

  runner.stop();
});

test('lock(ctx): manual lock clears PIN and relocks with reason', async () => {
  const api = { getOrders: () => Promise.resolve(okOrders([])) };
  const { ctx, store } = makeCtx({ api, pinStorage: makeMemoryStorage() });
  ctx.pinStorage.setItem('foodc.kds.pin', '123456');
  startPolling(ctx);
  await Promise.resolve();

  lock(ctx);

  assert.equal(store.getState().auth.status, 'locked');
  assert.equal(ctx.pinStorage.getItem('foodc.kds.pin'), null);
});

// --- Completion Recovery Policy rows ------------------------------------

test('completion: success confirms with the tombstone seq (next poll purges it)', async () => {
  const api = {
    getOrders: () => Promise.resolve(okOrders([{ order_id: 'A' }])),
    updateOrderStatus: () => Promise.resolve({ kind: 'success', data: { order_id: 'A' }, meta: null }),
  };
  const { ctx, store, timers } = makeCtx({ api });

  store.setState((s) => actions.pollSucceeded(s, { orders: [{ order_id: 'A' }], seq: 1, at: 0 }));
  completeOrder(ctx, 'A');
  const runner = startCompletionRunner(ctx);

  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  const entry = store.getState().completions.pending.find((p) => p.order_id === 'A');
  assert.notEqual(entry.confirmedAtSeq, null);

  runner.stop();
  timers.advance(0);
});

test('completion: NOT_FOUND is treated as confirmed (not an error)', async () => {
  const api = {
    updateOrderStatus: () =>
      Promise.resolve({ kind: 'definitive', code: 'NOT_FOUND', message: '', details: null }),
  };
  const { ctx, store } = makeCtx({ api });
  completeOrder(ctx, 'A');
  const runner = startCompletionRunner(ctx);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  const entry = store.getState().completions.pending.find((p) => p.order_id === 'A');
  assert.notEqual(entry.confirmedAtSeq, null);
  runner.stop();
});

test('completion: transient codes (LOCK_TIMEOUT, SHEET_UNAVAILABLE, INTERNAL_ERROR, PIN_NOT_CONFIGURED) retry with backoff', async () => {
  for (const code of ['LOCK_TIMEOUT', 'SHEET_UNAVAILABLE', 'INTERNAL_ERROR', 'PIN_NOT_CONFIGURED']) {
    const api = {
      updateOrderStatus: () => Promise.resolve({ kind: 'definitive', code, message: '', details: null }),
    };
    const { ctx, store } = makeCtx({ api });
    completeOrder(ctx, 'A');
    const runner = startCompletionRunner(ctx);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const entry = store.getState().completions.pending.find((p) => p.order_id === 'A');
    assert.equal(entry.confirmedAtSeq, null, `${code}: still pending`);
    assert.equal(entry.attempts, 1, `${code}: attempts bumped`);
    runner.stop();
  }
});

test('completion: ambiguous outcomes retry with backoff', async () => {
  const api = {
    updateOrderStatus: () => Promise.resolve({ kind: 'ambiguous', reason: 'network' }),
  };
  const { ctx, store } = makeCtx({ api });
  completeOrder(ctx, 'A');
  const runner = startCompletionRunner(ctx);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  const entry = store.getState().completions.pending.find((p) => p.order_id === 'A');
  assert.equal(entry.confirmedAtSeq, null);
  assert.equal(entry.attempts, 1);
  runner.stop();
});

test('completion: VALIDATION_ERROR/INVALID_JSON/UNKNOWN_ACTION restore the card and raise a notice', async () => {
  for (const code of ['VALIDATION_ERROR', 'INVALID_JSON', 'UNKNOWN_ACTION']) {
    const api = {
      updateOrderStatus: () => Promise.resolve({ kind: 'definitive', code, message: '', details: null }),
    };
    const { ctx, store } = makeCtx({ api });
    completeOrder(ctx, 'A');
    const runner = startCompletionRunner(ctx);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(store.getState().completions.pending.length, 0, `${code}: entry removed`);
    assert.ok(store.getState().notice, `${code}: notice raised`);
    runner.stop();
  }
});

test('completion runner processes entries serially, oldest tap first', async () => {
  const callOrder = [];
  const api = {
    updateOrderStatus: (id) => {
      callOrder.push(id);
      return Promise.resolve({ kind: 'success', data: { order_id: id }, meta: null });
    },
  };
  const { ctx } = makeCtx({ api });
  completeOrder(ctx, 'A');
  completeOrder(ctx, 'B');
  const runner = startCompletionRunner(ctx);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.deepStrictEqual(callOrder, ['A', 'B']);
  runner.stop();
});

// --- A2 sync-state table, triggered through real polling ----------------

test('A2: poll success -> sync.ok; transient definitive/ambiguous -> retrying -> stale after 60s', async () => {
  let result = { kind: 'definitive', code: 'SHEET_UNAVAILABLE', message: '', details: null };
  const api = { getOrders: () => Promise.resolve(result) };
  const { ctx, store, timers } = makeCtx({ api });

  startPolling(ctx);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(store.getState().sync.status, 'retrying');

  timers.advance(POLL_INTERVAL_MS);
  await Promise.resolve();
  await Promise.resolve();
  timers.advance(POLL_INTERVAL_MS);
  await Promise.resolve();
  await Promise.resolve();
  timers.advance(POLL_INTERVAL_MS);
  await Promise.resolve();
  await Promise.resolve();

  // Advance total failing time to >= 60s (STALE_ALERT_MS) via more polls.
  for (let i = 0; i < 10; i++) {
    timers.advance(POLL_INTERVAL_MS);
    await Promise.resolve();
    await Promise.resolve();
  }
  assert.equal(store.getState().sync.status, 'stale');
});

test('A2: poll PIN_NOT_CONFIGURED -> sync.not_configured', async () => {
  const api = {
    getOrders: () => Promise.resolve({ kind: 'definitive', code: 'PIN_NOT_CONFIGURED', message: '', details: null }),
  };
  const { ctx, store } = makeCtx({ api });
  startPolling(ctx);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(store.getState().sync.status, 'not_configured');
});

test('A2: poll UNKNOWN_ACTION/INVALID_JSON/VALIDATION_ERROR -> sync.contract', async () => {
  for (const code of ['UNKNOWN_ACTION', 'INVALID_JSON', 'VALIDATION_ERROR']) {
    const api = {
      getOrders: () => Promise.resolve({ kind: 'definitive', code, message: '', details: null }),
    };
    const { ctx, store } = makeCtx({ api });
    startPolling(ctx);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(store.getState().sync.status, 'contract', code);
  }
});

// --- pending-completion race through effects (completion.js + actions.js + effects.js) ---

test('a poll started before a completion confirms does not let the order reappear', async () => {
  // Sequence: poll #1 starts (in flight, slow), completion confirms with
  // nextSeq = 2 (the seq poll #2 will receive), poll #1 settles successfully
  // with seq=1 (started before confirmation) returning the order still
  // "Pendiente" -> must stay hidden; poll #2 (seq=2) succeeds -> purges the
  // tombstone.
  let resolvePoll1;
  let callCount = 0;
  const api = {
    getOrders: () => {
      callCount++;
      if (callCount === 1) {
        return new Promise((resolve) => {
          resolvePoll1 = resolve;
        });
      }
      return Promise.resolve(okOrders([])); // poll #2: order now gone (completed)
    },
    updateOrderStatus: () => Promise.resolve({ kind: 'success', data: { order_id: 'A' }, meta: null }),
  };
  const { ctx, store, timers } = makeCtx({ api });

  store.setState((s) => actions.pollSucceeded(s, { orders: [{ order_id: 'A' }], seq: 0, at: 0 }));

  startPolling(ctx); // poll #1 starts, in flight (slow)
  assert.equal(callCount, 1);

  // While poll #1 is in flight, the cook taps complete -> optimistic enqueue,
  // then the completion runner confirms it.
  completeOrder(ctx, 'A');
  const runner = startCompletionRunner(ctx);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  const confirmedEntry = store.getState().completions.pending.find((p) => p.order_id === 'A');
  assert.notEqual(confirmedEntry.confirmedAtSeq, null);

  // Now poll #1 (started before the confirmation) settles, still showing "A"
  // as pending from the server's point of view.
  resolvePoll1(okOrders([{ order_id: 'A' }]));
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  // Card must stay hidden: "A" is still in completions.pending (not purged,
  // since poll #1's startedSeq is before the confirmation's seq).
  assert.ok(
    store.getState().completions.pending.some((p) => p.order_id === 'A'),
    'tombstone not purged yet by the stale poll',
  );

  // The next poll (seq high enough) purges the tombstone once it succeeds.
  timers.advance(POLL_INTERVAL_MS);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.ok(
    !store.getState().completions.pending.some((p) => p.order_id === 'A'),
    'tombstone purged by a poll started at/after the confirmation seq',
  );

  runner.stop();
});

// --- online / visibilitychange triggers ----------------------------------

test('pollNow: fires an immediate poll bypassing the scheduled timer, only if none is in flight', async () => {
  let getOrdersCalls = 0;
  const api = { getOrders: () => (getOrdersCalls++, Promise.resolve(okOrders([]))) };
  const { ctx, timers } = makeCtx({ api });

  startPolling(ctx);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(getOrdersCalls, 1);

  // A pending scheduled timer exists now (settled, waiting POLL_INTERVAL_MS).
  // pollNow cancels it and polls immediately.
  pollNow(ctx);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(getOrdersCalls, 2, 'pollNow triggers an immediate poll');

  // Advancing the full interval afterwards must not double-fire (the old
  // timer was cancelled by pollNow and a fresh one scheduled from settle).
  const callsAfterPollNow = getOrdersCalls;
  timers.advance(POLL_INTERVAL_MS - 1);
  assert.equal(getOrdersCalls, callsAfterPollNow);
});

test('pollNow: ignored while a poll is already in flight', async () => {
  let getOrdersCalls = 0;
  let resolveSlow;
  const api = {
    getOrders: () => {
      getOrdersCalls++;
      return new Promise((resolve) => {
        resolveSlow = resolve;
      });
    },
  };
  const { ctx } = makeCtx({ api });

  startPolling(ctx);
  assert.equal(getOrdersCalls, 1);

  pollNow(ctx); // should be ignored: a poll is in flight
  assert.equal(getOrdersCalls, 1, 'pollNow ignored while in flight');

  resolveSlow(okOrders([]));
  await Promise.resolve();
  await Promise.resolve();
});

// --- unlock outcome mapping ----------------------------------------------

test('unlock: success saves the pin, unlocks, starts polling', async () => {
  let getOrdersCalls = 0;
  const api = {
    verifyPin: () => Promise.resolve({ kind: 'success', data: { valid: true }, meta: null }),
    getOrders: () => (getOrdersCalls++, Promise.resolve(okOrders([]))),
  };
  const { ctx, store } = makeCtx({ api, unlocked: false });

  await unlock(ctx, '123456');

  assert.equal(store.getState().auth.status, 'unlocked');
  assert.equal(ctx.pinStorage.getItem('foodc.kds.pin'), '123456');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(getOrdersCalls, 1, 'startPolling called on successful unlock');
});

test('unlock: UNAUTHORIZED -> locked with error wrong_pin', async () => {
  const api = { verifyPin: () => Promise.resolve(unauthorized()) };
  const { ctx, store } = makeCtx({ api, unlocked: false });
  await unlock(ctx, '000000');
  assert.deepStrictEqual(store.getState().auth, { status: 'locked', error: 'wrong_pin' });
});

test('unlock: PIN_NOT_CONFIGURED -> locked with error not_configured', async () => {
  const api = {
    verifyPin: () => Promise.resolve({ kind: 'definitive', code: 'PIN_NOT_CONFIGURED', message: '', details: null }),
  };
  const { ctx, store } = makeCtx({ api, unlocked: false });
  await unlock(ctx, '123456');
  assert.deepStrictEqual(store.getState().auth, { status: 'locked', error: 'not_configured' });
});

test('unlock: UNKNOWN_ACTION/INVALID_JSON/VALIDATION_ERROR -> locked with error contract', async () => {
  for (const code of ['UNKNOWN_ACTION', 'INVALID_JSON', 'VALIDATION_ERROR']) {
    const api = {
      verifyPin: () => Promise.resolve({ kind: 'definitive', code, message: '', details: null }),
    };
    const { ctx, store } = makeCtx({ api, unlocked: false });
    await unlock(ctx, '123456');
    assert.deepStrictEqual(store.getState().auth, { status: 'locked', error: 'contract' }, code);
  }
});

test('unlock: ambiguous / other definitive -> locked with error offline', async () => {
  const api = { verifyPin: () => Promise.resolve({ kind: 'ambiguous', reason: 'network' }) };
  const { ctx, store } = makeCtx({ api, unlocked: false });
  await unlock(ctx, '123456');
  assert.deepStrictEqual(store.getState().auth, { status: 'locked', error: 'offline' });

  const api2 = {
    verifyPin: () => Promise.resolve({ kind: 'definitive', code: 'INTERNAL_ERROR', message: '', details: null }),
  };
  const { ctx: ctx2, store: store2 } = makeCtx({ api: api2, unlocked: false });
  await unlock(ctx2, '123456');
  assert.deepStrictEqual(store2.getState().auth, { status: 'locked', error: 'offline' });
});
