import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, actions } from '../js/actions.js';

// --- initialState ---

test('initialState: locked / idle sync when no persisted pin', () => {
  const s = initialState();
  assert.deepStrictEqual(s.auth, { status: 'locked', error: null });
  assert.deepStrictEqual(s.sync, { status: 'idle', failingSince: null });
  assert.deepStrictEqual(s.queue, { orders: [], lastSyncAt: null, pollSeq: 0 });
  assert.deepStrictEqual(s.completions, { pending: [] });
  assert.equal(s.notice, null);
  assert.equal(s.wake, 'idle');
});

test('initialState: unlocked / connecting sync when hasPin is true', () => {
  const s = initialState({ hasPin: true });
  assert.deepStrictEqual(s.auth, { status: 'unlocked', error: null });
  assert.deepStrictEqual(s.sync, { status: 'connecting', failingSince: null });
});

test('initialState: carries hydrated pending completions', () => {
  const pending = [{ order_id: 'A' }];
  const s = initialState({ pending });
  assert.strictEqual(s.completions.pending, pending);
});

// --- unlock lifecycle ---

test('unlockStarted: moves auth to verifying, clears error', () => {
  const s = actions.unlockStarted(initialState());
  assert.deepStrictEqual(s.auth, { status: 'verifying', error: null });
});

test('unlockSucceeded: unlocks and resets sync to connecting', () => {
  let s = initialState();
  s = actions.unlockStarted(s);
  s = actions.unlockSucceeded(s);
  assert.deepStrictEqual(s.auth, { status: 'unlocked', error: null });
  assert.deepStrictEqual(s.sync, { status: 'connecting', failingSince: null });
});

test('unlockFailed: stays locked with the given error', () => {
  const s = actions.unlockFailed(initialState(), { error: 'wrong_pin' });
  assert.deepStrictEqual(s.auth, { status: 'locked', error: 'wrong_pin' });
});

// --- relock: queue and pending completions untouched ---

test('relock: locks auth with the reason, leaving queue and pending completions untouched', () => {
  let s = initialState({ hasPin: true });
  s = actions.pollSucceeded(s, { orders: [{ order_id: 'A' }], seq: 1, at: 1000 });
  s = actions.completionQueued(s, { order: { order_id: 'B', table_number: '05' }, at: 1000 });
  const before = { queue: s.queue, completions: s.completions };

  const relocked = actions.relock(s, { reason: 'rejected' });

  assert.deepStrictEqual(relocked.auth, { status: 'locked', error: 'rejected' });
  assert.strictEqual(relocked.queue, before.queue);
  assert.strictEqual(relocked.completions, before.completions);
});

// --- pollSucceeded ---

test('pollSucceeded: updates queue, sets sync ok, resets failingSince, purges tombstones', () => {
  let s = initialState({ hasPin: true });
  s = actions.completionQueued(s, { order: { order_id: 'A', table_number: '05' }, at: 100 });
  s = actions.completionConfirmed(s, { id: 'A', seq: 5 });
  s = actions.pollFailed(s, { kind: 'transient', at: 200 }); // simulate a prior failing streak

  const orders = [{ order_id: 'B' }];
  s = actions.pollSucceeded(s, { orders, seq: 5, at: 300 });

  assert.deepStrictEqual(s.queue, { orders, lastSyncAt: 300, pollSeq: 5 });
  assert.deepStrictEqual(s.sync, { status: 'ok', failingSince: null });
  assert.deepStrictEqual(s.completions.pending, []); // purged: startedSeq(5) >= confirmedAtSeq(5)
});

test('pollSucceeded: the "empty queue, sync ok" state is only reachable via pollSucceeded', () => {
  // pollFailed and staleCheck never set sync.status to 'ok'; only a
  // pollSucceeded can, and here it does so with an empty order list.
  let s = initialState({ hasPin: true });
  s = actions.pollFailed(s, { kind: 'transient', at: 100 });
  assert.notEqual(s.sync.status, 'ok');
  s = actions.staleCheck(s, { at: 100 });
  assert.notEqual(s.sync.status, 'ok');

  s = actions.pollSucceeded(s, { orders: [], seq: 1, at: 200 });
  assert.equal(s.sync.status, 'ok');
  assert.deepStrictEqual(s.queue.orders, []);
});

// --- pollFailed / staleCheck: full A2 transition table ---

test('pollFailed: transient maps to retrying and sets failingSince once', () => {
  let s = initialState({ hasPin: true });
  s = actions.pollFailed(s, { kind: 'transient', at: 1000 });
  assert.deepStrictEqual(s.sync, { status: 'retrying', failingSince: 1000 });

  // A second consecutive failure does not move failingSince forward.
  s = actions.pollFailed(s, { kind: 'transient', at: 2000 });
  assert.deepStrictEqual(s.sync, { status: 'retrying', failingSince: 1000 });
});

test('pollFailed: contract and not_configured pass through as distinct statuses', () => {
  let s = initialState({ hasPin: true });
  const contractState = actions.pollFailed(s, { kind: 'contract', at: 1000 });
  assert.deepStrictEqual(contractState.sync, { status: 'contract', failingSince: 1000 });

  const notConfiguredState = actions.pollFailed(s, { kind: 'not_configured', at: 1000 });
  assert.deepStrictEqual(notConfiguredState.sync, { status: 'not_configured', failingSince: 1000 });
});

test('staleCheck: no-op (same reference) below the 60 s boundary', () => {
  let s = initialState({ hasPin: true });
  s = actions.pollFailed(s, { kind: 'transient', at: 1000 });
  const result = actions.staleCheck(s, { at: 1000 + 59999 });
  assert.strictEqual(result, s);
  assert.equal(result.sync.status, 'retrying');
});

test('staleCheck: escalates to stale exactly at the 60 s (STALE_ALERT_MS) boundary', () => {
  let s = initialState({ hasPin: true });
  s = actions.pollFailed(s, { kind: 'transient', at: 1000 });
  const result = actions.staleCheck(s, { at: 1000 + 60000 });
  assert.deepStrictEqual(result.sync, { status: 'stale', failingSince: 1000 });
});

test('staleCheck: no-op when sync.status is not retrying', () => {
  let s = initialState({ hasPin: true }); // sync.status === 'connecting'
  const result = actions.staleCheck(s, { at: 999999 });
  assert.strictEqual(result, s);
});

test('retrying -> ok recovery clears failingSince', () => {
  let s = initialState({ hasPin: true });
  s = actions.pollFailed(s, { kind: 'transient', at: 1000 });
  s = actions.pollSucceeded(s, { orders: [], seq: 1, at: 2000 });
  assert.deepStrictEqual(s.sync, { status: 'ok', failingSince: null });
});

test('stale -> ok recovery clears failingSince', () => {
  let s = initialState({ hasPin: true });
  s = actions.pollFailed(s, { kind: 'transient', at: 1000 });
  s = actions.staleCheck(s, { at: 1000 + 60000 });
  assert.equal(s.sync.status, 'stale');
  s = actions.pollSucceeded(s, { orders: [], seq: 1, at: 70000 });
  assert.deepStrictEqual(s.sync, { status: 'ok', failingSince: null });
});

// --- completions reducers ---

test('completionQueued: enqueues via completion.enqueue', () => {
  const s = actions.completionQueued(initialState(), { order: { order_id: 'A', table_number: '05' }, at: 1000 });
  assert.equal(s.completions.pending.length, 1);
  assert.equal(s.completions.pending[0].order_id, 'A');
});

test('completionConfirmed: tombstones the matching entry', () => {
  let s = actions.completionQueued(initialState(), { order: { order_id: 'A', table_number: '05' }, at: 1000 });
  s = actions.completionConfirmed(s, { id: 'A', seq: 9 });
  assert.equal(s.completions.pending[0].confirmedAtSeq, 9);
});

test('completionRetry: bumps attempts and reschedules', () => {
  let s = actions.completionQueued(initialState(), { order: { order_id: 'A', table_number: '05' }, at: 1000 });
  s = actions.completionRetry(s, { id: 'A', at: 5000 });
  assert.equal(s.completions.pending[0].attempts, 1);
  assert.equal(s.completions.pending[0].nextAttemptAt, 5000 + 2000);
});

test('completionRestored: removes the entry and raises a restored notice with its table_number', () => {
  let s = actions.completionQueued(initialState(), { order: { order_id: 'A', table_number: '12' }, at: 1000 });
  s = actions.completionRestored(s, { id: 'A' });
  assert.equal(s.completions.pending.length, 0);
  assert.deepStrictEqual(s.notice, { kind: 'restored', table_number: '12' });
});

// --- dismissNotice ---

test('dismissNotice: clears the notice', () => {
  let s = actions.completionQueued(initialState(), { order: { order_id: 'A', table_number: '12' }, at: 1000 });
  s = actions.completionRestored(s, { id: 'A' });
  s = actions.dismissNotice(s);
  assert.equal(s.notice, null);
});

test('dismissNotice: no-op (same reference) when there is no notice', () => {
  const s = initialState();
  assert.strictEqual(actions.dismissNotice(s), s);
});

// --- wakeChanged ---

test('wakeChanged: sets wake status', () => {
  const s = actions.wakeChanged(initialState(), 'active');
  assert.equal(s.wake, 'active');
});
