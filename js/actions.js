import { STALE_ALERT_MS } from './config.js';
import * as completion from './completion.js';

/**
 * Store state shape, per design.md "Data Flow > State":
 *
 * {
 *   auth:  { status: 'locked'|'verifying'|'unlocked',
 *            error: null|'wrong_pin'|'offline'|'not_configured'|'contract' },
 *   queue: { orders: Order[], lastSyncAt: number|null, pollSeq: number },
 *   sync:  { status: 'idle'|'connecting'|'ok'|'retrying'|'stale'|'contract'|'not_configured',
 *            failingSince: number|null },
 *   completions: { pending: PendingCompletion[] },
 *   notice: null | { kind: 'restored', table_number: string },
 *   wake: 'active'|'unsupported'|'denied'|'idle',
 * }
 *
 * `queue.pollSeq` is not spelled out in design's literal state block; it is
 * kept here as plain bookkeeping (last applied poll sequence) alongside the
 * two fields design does name, never read by any reducer's branching logic.
 *
 * @param {{ pending?: import('./completion.js').PendingCompletion[], hasPin?: boolean }} [hydrated]
 */
export function initialState({ pending = [], hasPin = false } = {}) {
  return {
    auth: { status: hasPin ? 'unlocked' : 'locked', error: null },
    queue: { orders: [], lastSyncAt: null, pollSeq: 0 },
    // A2: 'connecting' only applies once unlocked and no successful poll has
    // landed yet; while locked there is no polling at all, hence 'idle'.
    sync: { status: hasPin ? 'connecting' : 'idle', failingSince: null },
    completions: { pending },
    notice: null,
    wake: 'idle',
  };
}

export const actions = {
  unlockStarted(state) {
    return { ...state, auth: { status: 'verifying', error: null } };
  },

  unlockSucceeded(state) {
    return {
      ...state,
      auth: { status: 'unlocked', error: null },
      sync: { status: 'connecting', failingSince: null },
    };
  },

  unlockFailed(state, { error }) {
    return { ...state, auth: { status: 'locked', error } };
  },

  // Re-lock never clears the queue or pending completions (design is
  // explicit about this): the cards the cook was looking at, and anything
  // mid-flight to the server, must survive a PIN rejection/rotation.
  relock(state, { reason }) {
    return { ...state, auth: { status: 'locked', error: reason } };
  },

  pollSucceeded(state, { orders, seq, at }) {
    return {
      ...state,
      queue: { orders, lastSyncAt: at, pollSeq: seq },
      sync: { status: 'ok', failingSince: null },
      completions: { pending: completion.purgeAfterPoll(state.completions.pending, seq) },
    };
  },

  pollFailed(state, { kind, at }) {
    // failingSince is set once per failing streak: only when the previous
    // state had no clock running yet (reset to null by the last pollSucceeded).
    const failingSince = state.sync.failingSince === null ? at : state.sync.failingSince;
    const status = kind === 'transient' ? 'retrying' : kind; // 'contract' | 'not_configured' pass through
    return { ...state, sync: { status, failingSince } };
  },

  staleCheck(state, { at }) {
    const { status, failingSince } = state.sync;
    if (status === 'retrying' && failingSince !== null && at - failingSince >= STALE_ALERT_MS) {
      return { ...state, sync: { status: 'stale', failingSince } };
    }
    return state;
  },

  completionQueued(state, { order, at }) {
    return { ...state, completions: { pending: completion.enqueue(state.completions.pending, order, at) } };
  },

  completionConfirmed(state, { id, seq }) {
    return { ...state, completions: { pending: completion.markConfirmed(state.completions.pending, id, seq) } };
  },

  completionRetry(state, { id, at }) {
    return { ...state, completions: { pending: completion.markRetry(state.completions.pending, id, at) } };
  },

  completionRestored(state, { id }) {
    const entry = state.completions.pending.find((p) => p.order_id === id);
    return {
      ...state,
      completions: { pending: completion.restore(state.completions.pending, id) },
      notice: { kind: 'restored', table_number: entry ? entry.table_number : null },
    };
  },

  dismissNotice(state) {
    if (state.notice === null) return state;
    return { ...state, notice: null };
  },

  wakeChanged(state, status) {
    return { ...state, wake: status };
  },
};
