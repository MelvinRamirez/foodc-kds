import { actions } from './actions.js';
import * as pin from './pin.js';
import * as completion from './completion.js';
import { isRelock } from './api.js';
import { POLL_INTERVAL_MS } from './config.js';

/**
 * Internal engine. `ctx` is created once by `main.js` (the composition root)
 * and shared across every effect call for the life of the page, so the
 * running poll loop, the running completion runner, and the monotonic poll
 * sequence counter are stashed as private fields directly on that same
 * `ctx` object:
 *
 *   ctx.__poll              - { running, inFlight, timer, stop, pollOnce }
 *   ctx.__runner            - { running, paused, timer, busy, wake, stop, pause }
 *   ctx.__pollSeqCounter    - number, the last seq handed to a poll attempt
 *
 * This is a deliberate judgment call (flagged in the final report): the
 * `effects.js` contract in design.md takes a single `ctx` parameter with no
 * dedicated "handles" slot, yet `unlock` must be able to wake the already-
 * running completion runner and `relock` must be able to stop the already-
 * running poller — both of which are created by separate calls
 * (`startPolling`/`startCompletionRunner`) that only `main.js` invokes once.
 * Storing the live handles on `ctx` itself (rather than, say, module-level
 * globals) keeps every effect pure with respect to its inputs and keeps a
 * second independent `ctx` (as used throughout this test suite) fully
 * isolated from any other page/test's polling or runner state.
 */

const CONTRACT_ERROR_CODES = new Set(['UNKNOWN_ACTION', 'INVALID_JSON', 'VALIDATION_ERROR']);

function ensurePollSeqCounter(ctx) {
  if (typeof ctx.__pollSeqCounter !== 'number') {
    ctx.__pollSeqCounter = ctx.store.getState().queue.pollSeq || 0;
  }
  return ctx.__pollSeqCounter;
}

/** Increments and returns the seq used as THIS poll attempt's startedSeq. */
function incrementPollSeq(ctx) {
  ensurePollSeqCounter(ctx);
  ctx.__pollSeqCounter += 1;
  return ctx.__pollSeqCounter;
}

/** Peeks (without incrementing) the seq the NEXT poll attempt will receive. */
function peekNextPollSeq(ctx) {
  ensurePollSeqCounter(ctx);
  return ctx.__pollSeqCounter + 1;
}

function mapPollFailureKind(result) {
  if (result.kind === 'definitive') {
    if (result.code === 'PIN_NOT_CONFIGURED') return 'not_configured';
    if (CONTRACT_ERROR_CODES.has(result.code)) return 'contract';
    return 'transient';
  }
  return 'transient'; // ambiguous
}

/**
 * Shared re-lock path for "any protected call -> UNAUTHORIZED -> relock":
 * clears the stored PIN, dispatches `actions.relock`, stops the poller and
 * pauses the completion runner. `queue.orders` and `completions.pending` are
 * left untouched by `actions.relock` itself (see actions.js).
 */
function doRelock(ctx, reason) {
  pin.clearPin(ctx.pinStorage);
  ctx.store.setState((s) => actions.relock(s, { reason }));
  if (ctx.__poll) {
    ctx.__poll.stop();
  }
  if (ctx.__runner) {
    ctx.__runner.pause();
  }
}

// --- unlock ---------------------------------------------------------------

export async function unlock(ctx, pinValue) {
  ctx.store.setState((s) => actions.unlockStarted(s));
  const result = await ctx.api.verifyPin(pinValue);

  if (result.kind === 'success') {
    pin.savePin(ctx.pinStorage, pinValue);
    ctx.store.setState((s) => actions.unlockSucceeded(s));
    startPolling(ctx);
    if (ctx.__runner) {
      ctx.__runner.wake();
    }
    if (ctx.wakeLock && typeof ctx.wakeLock.request === 'function') {
      ctx.wakeLock.request();
    }
    return;
  }

  let error;
  if (result.kind === 'definitive' && result.code === 'UNAUTHORIZED') {
    error = 'wrong_pin';
  } else if (result.kind === 'definitive' && result.code === 'PIN_NOT_CONFIGURED') {
    error = 'not_configured';
  } else if (result.kind === 'definitive' && CONTRACT_ERROR_CODES.has(result.code)) {
    error = 'contract';
  } else {
    error = 'offline';
  }
  ctx.store.setState((s) => actions.unlockFailed(s, { error }));
}

// --- polling loop (no overlap) ---------------------------------------------

export function startPolling(ctx) {
  if (ctx.__poll && ctx.__poll.running) {
    return ctx.__poll.stop;
  }

  const poll = { running: true, inFlight: false, timer: null };
  ctx.__poll = poll;

  function stop() {
    poll.running = false;
    if (poll.timer !== null) {
      ctx.clearTimer(poll.timer);
      poll.timer = null;
    }
  }
  poll.stop = stop;

  function scheduleNext() {
    if (!poll.running) return;
    poll.timer = ctx.setTimer(() => {
      poll.timer = null;
      pollOnce();
    }, POLL_INTERVAL_MS);
  }

  async function pollOnce() {
    if (!poll.running || poll.inFlight) return;

    // "seq <- ++pollSeqCounter" happens before the unlocked check, per
    // design's "Polling loop" sequence diagram.
    const seq = incrementPollSeq(ctx);

    if (ctx.store.getState().auth.status !== 'unlocked') {
      stop();
      return;
    }

    poll.inFlight = true;
    const result = await ctx.api.getOrders('Pendiente');
    poll.inFlight = false;

    if (!poll.running) return; // stopped (e.g. relocked) while this poll was in flight

    if (result.kind === 'success') {
      ctx.store.setState((s) => actions.pollSucceeded(s, { orders: result.data, seq, at: ctx.now() }));
      scheduleNext();
      return;
    }

    if (isRelock(result)) {
      doRelock(ctx, 'rejected');
      return; // no reschedule
    }

    const kind = mapPollFailureKind(result);
    ctx.store.setState((s) => actions.pollFailed(s, { kind, at: ctx.now() }));
    // The 60 s stale escalation has no timer of its own: it piggybacks on
    // this 5 s poll cadence, since ticker.js never writes to the store.
    ctx.store.setState((s) => actions.staleCheck(s, { at: ctx.now() }));
    scheduleNext();
  }

  poll.pollOnce = pollOnce;
  pollOnce();
  return stop;
}

export function pollNow(ctx) {
  const poll = ctx.__poll;
  if (!poll || !poll.running) return;
  if (poll.inFlight) return; // ignored; the in-flight poll will reschedule
  if (poll.timer !== null) {
    ctx.clearTimer(poll.timer);
    poll.timer = null;
  }
  poll.pollOnce();
}

// --- completion ------------------------------------------------------------

export function completeOrder(ctx, orderId) {
  const state = ctx.store.getState();
  const order = state.queue.orders.find((o) => o.order_id === orderId);
  const table_number = order ? order.table_number : null;
  ctx.store.setState((s) =>
    actions.completionQueued(s, { order: { order_id: orderId, table_number }, at: ctx.now() }),
  );
  if (ctx.__runner) {
    ctx.__runner.wake();
  }
}

export function startCompletionRunner(ctx) {
  if (ctx.__runner && ctx.__runner.running) {
    return { wake: ctx.__runner.wake, stop: ctx.__runner.stop };
  }

  const runner = { running: true, paused: false, timer: null, busy: false };
  ctx.__runner = runner;

  function clearPendingTimer() {
    if (runner.timer !== null) {
      ctx.clearTimer(runner.timer);
      runner.timer = null;
    }
  }

  function stop() {
    runner.running = false;
    clearPendingTimer();
  }

  function pause() {
    runner.paused = true;
    clearPendingTimer();
  }

  function wake() {
    if (!runner.running) return;
    runner.paused = false;
    clearPendingTimer();
    tick();
  }

  runner.stop = stop;
  runner.pause = pause;
  runner.wake = wake;

  async function tick() {
    if (!runner.running || runner.paused || runner.busy) return;
    // Defense in depth alongside the explicit `paused` flag set by
    // `doRelock`/`pause()`: the runner never processes entries while the
    // app is not unlocked, even if `wake()` is called while locked (e.g. by
    // an `online`/`visibilitychange` listener that does not itself know the
    // current auth state).
    if (ctx.store.getState().auth.status !== 'unlocked') return;

    const state = ctx.store.getState();
    const entry = completion.nextDue(state.completions.pending, ctx.now());
    if (!entry) return; // idle until wake() or the entry's own retry timer

    runner.busy = true;
    const result = await ctx.api.updateOrderStatus(entry.order_id);
    runner.busy = false;

    if (!runner.running) return;

    const confirmed = result.kind === 'success' || (result.kind === 'definitive' && result.code === 'NOT_FOUND');
    if (confirmed) {
      const nextSeq = peekNextPollSeq(ctx);
      ctx.store.setState((s) => actions.completionConfirmed(s, { id: entry.order_id, seq: nextSeq }));
      tick(); // keep draining while entries are due
      return;
    }

    if (isRelock(result)) {
      doRelock(ctx, 'rejected'); // relock: entry stays pending, runner paused
      return;
    }

    const isContractBug = result.kind === 'definitive' && CONTRACT_ERROR_CODES.has(result.code);
    if (isContractBug) {
      ctx.store.setState((s) => actions.completionRestored(s, { id: entry.order_id }));
      tick();
      return;
    }

    // Transient-ish (LOCK_TIMEOUT, SHEET_UNAVAILABLE, INTERNAL_ERROR,
    // PIN_NOT_CONFIGURED) or ambiguous: keep hidden, retry with backoff.
    ctx.store.setState((s) => actions.completionRetry(s, { id: entry.order_id, at: ctx.now() }));
    if (!runner.running || runner.paused) return;
    const updated = ctx.store
      .getState()
      .completions.pending.find((p) => p.order_id === entry.order_id);
    const delay = updated ? Math.max(0, updated.nextAttemptAt - ctx.now()) : 0;
    clearPendingTimer();
    runner.timer = ctx.setTimer(() => {
      runner.timer = null;
      tick();
    }, delay);
  }

  tick();
  return { wake, stop };
}

// --- manual lock ("Bloquear" button) ---------------------------------------

export function lock(ctx) {
  doRelock(ctx, 'manual');
}
