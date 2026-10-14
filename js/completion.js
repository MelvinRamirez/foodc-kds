import { COMPLETION_BACKOFF_MS, PENDING_MAX_AGE_MS } from './config.js';

/**
 * @typedef {{ order_id: string, table_number: string, tappedAt: number,
 *   attempts: number, nextAttemptAt: number, confirmedAtSeq: number|null }} PendingCompletion
 */

/**
 * @param {number} attempts 1-indexed count of attempts made so far.
 * @returns {number} delay in ms before the next attempt; the last value of
 *   COMPLETION_BACKOFF_MS repeats forever once `attempts` exceeds its length.
 */
export function backoffMs(attempts) {
  const clamped = Math.min(Math.max(attempts, 1), COMPLETION_BACKOFF_MS.length);
  return COMPLETION_BACKOFF_MS[clamped - 1];
}

/**
 * Adds `order` to the pending-completion set. No-op (returns the SAME array
 * reference) when `order.order_id` is already present, so a double tap never
 * duplicates the entry.
 *
 * @param {PendingCompletion[]} pending
 * @param {{ order_id: string, table_number: string }} order
 * @param {number} nowMs
 * @returns {PendingCompletion[]}
 */
export function enqueue(pending, order, nowMs) {
  if (pending.some((entry) => entry.order_id === order.order_id)) {
    return pending;
  }
  return [
    ...pending,
    {
      order_id: order.order_id,
      table_number: order.table_number,
      tappedAt: nowMs,
      attempts: 0,
      nextAttemptAt: nowMs,
      confirmedAtSeq: null,
    },
  ];
}

/**
 * @param {PendingCompletion[]} pending
 * @param {number} nowMs
 * @returns {PendingCompletion|null} the oldest (by tappedAt) unconfirmed
 *   entry whose nextAttemptAt has arrived, or null when none is due.
 */
export function nextDue(pending, nowMs) {
  let best = null;
  for (const entry of pending) {
    if (entry.confirmedAtSeq !== null) continue;
    if (entry.nextAttemptAt > nowMs) continue;
    if (best === null || entry.tappedAt < best.tappedAt) best = entry;
  }
  return best;
}

/**
 * @param {PendingCompletion[]} pending
 * @param {string} id order_id to retry.
 * @param {number} nowMs
 * @returns {PendingCompletion[]} new array; the matching entry gets
 *   attempts+1 and nextAttemptAt = nowMs + backoffMs(attempts+1).
 */
export function markRetry(pending, id, nowMs) {
  return pending.map((entry) => {
    if (entry.order_id !== id) return entry;
    const attempts = entry.attempts + 1;
    return { ...entry, attempts, nextAttemptAt: nowMs + backoffMs(attempts) };
  });
}

/**
 * Tombstones the matching entry (does not delete it yet).
 *
 * @param {PendingCompletion[]} pending
 * @param {string} id
 * @param {number} seq the sequence number the NEXT poll will receive.
 * @returns {PendingCompletion[]}
 */
export function markConfirmed(pending, id, seq) {
  return pending.map((entry) => (entry.order_id === id ? { ...entry, confirmedAtSeq: seq } : entry));
}

/**
 * Removes tombstoned entries once a poll that STARTED at or after their
 * confirmation sequence has succeeded. This is the race design.md calls
 * out explicitly: a poll that started BEFORE the write commits can return
 * the order as still "Pendiente" after the completion has already been
 * confirmed. Deleting the ID at confirmation time would let that stale
 * response flash the card back onto the queue; purging only once
 * `startedSeq >= confirmedAtSeq` guarantees the poll being applied was
 * started no earlier than the confirmation itself.
 *
 * @param {PendingCompletion[]} pending
 * @param {number} startedSeq the seq of the poll that just succeeded.
 * @returns {PendingCompletion[]}
 */
export function purgeAfterPoll(pending, startedSeq) {
  return pending.filter((entry) => !(entry.confirmedAtSeq !== null && startedSeq >= entry.confirmedAtSeq));
}

/**
 * Removes an entry entirely, used on the contract-bug path
 * (VALIDATION_ERROR / INVALID_JSON / UNKNOWN_ACTION on updateOrderStatus):
 * the card goes back to the visible queue.
 *
 * @param {PendingCompletion[]} pending
 * @param {string} id
 * @returns {PendingCompletion[]}
 */
export function restore(pending, id) {
  return pending.filter((entry) => entry.order_id !== id);
}

/**
 * Drops entries older than PENDING_MAX_AGE_MS. Used at hydration only, so a
 * never-confirmed entry cannot hide a real order forever.
 *
 * @param {PendingCompletion[]} pending
 * @param {number} nowMs
 * @returns {PendingCompletion[]}
 */
export function dropExpired(pending, nowMs) {
  return pending.filter((entry) => nowMs - entry.tappedAt <= PENDING_MAX_AGE_MS);
}
