import { parseServerStamp } from './time.js';

/**
 * @param {import('./completion.js').PendingCompletion[]} pending
 * @returns {Set<string>} every pending order_id, confirmed or not.
 */
export function hiddenIds(pending) {
  const ids = new Set();
  for (const entry of pending) {
    if (entry && typeof entry.order_id === 'string') ids.add(entry.order_id);
  }
  return ids;
}

/**
 * Filters hidden (pending-completion) orders out of the server list,
 * preserving the server's array order exactly (never re-sorted).
 *
 * @param {object[]} orders
 * @param {import('./completion.js').PendingCompletion[]} pending
 * @returns {object[]}
 */
export function visibleOrders(orders, pending) {
  const hidden = hiddenIds(pending);
  return orders.filter((order) => !hidden.has(order.order_id));
}

function isWellFormedItem(item) {
  return (
    item !== null &&
    typeof item === 'object' &&
    typeof item.name === 'string' &&
    item.name.length > 0 &&
    typeof item.quantity === 'number' &&
    Number.isFinite(item.quantity)
  );
}

/**
 * @param {object} order
 * @param {number} nowMs
 * @returns {{ id: string, table: string, createdAtMs: number|null,
 *   items: {name: string, quantity: number}[]|null, summaryText: string|null,
 *   notes: string|null }}
 */
// eslint-disable-next-line no-unused-vars -- nowMs is part of the contract; elapsed/urgency are derived by the view via the ticker, not here.
export function toCardModel(order, nowMs) {
  const createdAtMs = parseServerStamp(order.created_at);

  let items = null;
  if (
    Array.isArray(order.order_details) &&
    order.order_details.length > 0 &&
    order.order_details.every(isWellFormedItem)
  ) {
    items = order.order_details.map((it) => ({ name: it.name, quantity: it.quantity }));
  }

  // A3 fallback: whenever order_details is not a usable list, fall back to
  // items_summary verbatim rather than attempting to repair/partially read it.
  const summaryText = items === null && typeof order.items_summary === 'string' ? order.items_summary : null;

  const rawNotes = typeof order.customer_notes === 'string' ? order.customer_notes.trim() : '';
  const notes = rawNotes.length > 0 ? rawNotes : null;

  return {
    id: order.order_id,
    table: String(order.table_number),
    createdAtMs,
    items,
    summaryText,
    notes,
  };
}
