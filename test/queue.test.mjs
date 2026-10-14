import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hiddenIds, visibleOrders, toCardModel } from '../js/queue.js';

function order(overrides = {}) {
  return {
    order_id: 'ORD-1',
    created_at: '2026-10-13 12:00:00',
    table_number: '05',
    items_summary: '2x Baleada, 1x Soda',
    order_details: null,
    customer_notes: '',
    total_amount: 100,
    status: 'Pendiente',
    updated_at: '2026-10-13 12:00:00',
    ...overrides,
  };
}

// --- hiddenIds ---

test('hiddenIds: collects every pending order_id, confirmed or not', () => {
  const pending = [
    { order_id: 'A', confirmedAtSeq: null },
    { order_id: 'B', confirmedAtSeq: 7 },
  ];
  assert.deepStrictEqual(hiddenIds(pending), new Set(['A', 'B']));
});

test('hiddenIds: empty pending yields an empty set', () => {
  assert.deepStrictEqual(hiddenIds([]), new Set());
});

// --- visibleOrders ---

test('visibleOrders: preserves server order exactly, never re-sorted or reversed', () => {
  const orders = [order({ order_id: 'C' }), order({ order_id: 'A' }), order({ order_id: 'B' })];
  const result = visibleOrders(orders, []);
  assert.deepStrictEqual(
    result.map((o) => o.order_id),
    ['C', 'A', 'B'],
  );
});

test('visibleOrders: filters out orders whose id is in the pending set', () => {
  const orders = [order({ order_id: 'A' }), order({ order_id: 'B' }), order({ order_id: 'C' })];
  const pending = [{ order_id: 'B', confirmedAtSeq: null }];
  const result = visibleOrders(orders, pending);
  assert.deepStrictEqual(
    result.map((o) => o.order_id),
    ['A', 'C'],
  );
});

test('visibleOrders: a confirmed-but-not-yet-purged pending entry still hides the order', () => {
  const orders = [order({ order_id: 'A' })];
  const pending = [{ order_id: 'A', confirmedAtSeq: 5 }];
  assert.deepStrictEqual(visibleOrders(orders, pending), []);
});

// --- toCardModel: items_summary / order_details fallback (A3) ---

test('toCardModel: well-formed order_details array produces items and no summaryText', () => {
  const model = toCardModel(
    order({ order_details: [{ item_id: 'I1', name: 'Baleada', quantity: 2 }] }),
    0,
  );
  assert.deepStrictEqual(model.items, [{ name: 'Baleada', quantity: 2 }]);
  assert.equal(model.summaryText, null);
});

test('toCardModel: order_details null falls back to items_summary verbatim', () => {
  const model = toCardModel(order({ order_details: null, items_summary: '2x Baleada, 1x Soda' }), 0);
  assert.equal(model.items, null);
  assert.equal(model.summaryText, '2x Baleada, 1x Soda');
});

test('toCardModel: order_details empty array falls back to items_summary', () => {
  const model = toCardModel(order({ order_details: [] }), 0);
  assert.equal(model.items, null);
  assert.equal(model.summaryText, '2x Baleada, 1x Soda');
});

test('toCardModel: order_details with a malformed entry (missing quantity) falls back entirely', () => {
  const model = toCardModel(order({ order_details: [{ item_id: 'I1', name: 'Baleada' }] }), 0);
  assert.equal(model.items, null);
  assert.equal(model.summaryText, '2x Baleada, 1x Soda');
});

test('toCardModel: order_details with a non-array value falls back to items_summary', () => {
  const model = toCardModel(order({ order_details: 'not-an-array' }), 0);
  assert.equal(model.items, null);
  assert.equal(model.summaryText, '2x Baleada, 1x Soda');
});

test('toCardModel: order_details with a malformed entry among well-formed ones still falls back entirely', () => {
  const model = toCardModel(
    order({
      order_details: [
        { item_id: 'I1', name: 'Baleada', quantity: 2 },
        { item_id: 'I2', name: '', quantity: 1 }, // empty name: malformed
      ],
    }),
    0,
  );
  assert.equal(model.items, null);
});

test('toCardModel: items_summary itself missing/non-string yields summaryText null too', () => {
  const model = toCardModel(order({ order_details: null, items_summary: undefined }), 0);
  assert.equal(model.items, null);
  assert.equal(model.summaryText, null);
});

// --- toCardModel: notes ---

test('toCardModel: trims customer_notes', () => {
  const model = toCardModel(order({ customer_notes: '  sin cebolla  ' }), 0);
  assert.equal(model.notes, 'sin cebolla');
});

test('toCardModel: blank/whitespace-only notes become null', () => {
  assert.equal(toCardModel(order({ customer_notes: '' }), 0).notes, null);
  assert.equal(toCardModel(order({ customer_notes: '   ' }), 0).notes, null);
});

test('toCardModel: non-string customer_notes becomes null', () => {
  assert.equal(toCardModel(order({ customer_notes: null }), 0).notes, null);
});

// --- toCardModel: plain strings, no HTML construction at this level ---

test('toCardModel: notes and summaryText are carried as plain strings, not markup', () => {
  const model = toCardModel(
    order({ customer_notes: '<b>urgente</b>', items_summary: '<i>2x Baleada</i>', order_details: null }),
    0,
  );
  assert.equal(typeof model.notes, 'string');
  assert.equal(model.notes, '<b>urgente</b>');
  assert.equal(model.summaryText, '<i>2x Baleada</i>');
});

test('toCardModel: carries id, table (as string) and createdAtMs', () => {
  const model = toCardModel(order({ order_id: 'ORD-9', table_number: 7, created_at: '2026-10-13 12:00:00' }), 0);
  assert.equal(model.id, 'ORD-9');
  assert.equal(model.table, '7');
  assert.equal(typeof model.createdAtMs, 'number');
});

test('toCardModel: unparseable created_at yields createdAtMs null', () => {
  const model = toCardModel(order({ created_at: 'garbage' }), 0);
  assert.equal(model.createdAtMs, null);
});
