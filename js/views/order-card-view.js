import { elapsedMs, formatElapsed, urgencyTier } from '../time.js';
import { el } from './dom.js';

const TIER_CARD_CLASS = {
  normal: 'border-slate-200 bg-white',
  warning: 'border-amber-400 bg-amber-50',
  critical: 'border-red-500 bg-red-50',
};

const TIER_TIMER_CLASS = {
  normal: 'order-card__timer text-2xl font-mono text-slate-700',
  warning: 'order-card__timer text-2xl font-mono font-bold text-amber-700',
  critical: 'order-card__timer text-2xl font-mono font-bold text-red-700',
};

// A1: tier is never color-only. The timer label itself gains a text prefix.
const TIER_PREFIX = {
  normal: '',
  warning: 'Demorado ',
  critical: 'Urgente ',
};

const BASE_CARD_CLASS =
  'order-card flex flex-col gap-2 rounded-2xl border-2 p-3 shadow-sm transition-colors';

function timerText(cardModel, nowMs) {
  const elapsed = elapsedMs(cardModel.createdAtMs, nowMs);
  const tier = urgencyTier(elapsed);
  return { text: `${TIER_PREFIX[tier]}${formatElapsed(elapsed)}`, tier };
}

function renderItems(cardModel) {
  if (Array.isArray(cardModel.items)) {
    return el(
      'ul',
      { class: 'order-card__items flex flex-col gap-0.5 text-sm text-slate-800', 'data-role': 'items' },
      cardModel.items.map((item) => el('li', {}, [`${item.quantity}x ${item.name}`])),
    );
  }
  // A3 fallback: items_summary rendered verbatim, as plain text (never HTML).
  return el('p', { class: 'order-card__summary text-sm text-slate-800', 'data-role': 'items' }, [
    cardModel.summaryText || '',
  ]);
}

function renderNotes(cardModel) {
  if (cardModel.notes === null) return null;
  return el(
    'p',
    {
      class:
        'order-card__notes order-card__notes--highlight rounded-lg bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-900',
      'data-role': 'notes',
    },
    [cardModel.notes],
  );
}

/**
 * Builds a new card DOM node from scratch for `cardModel`. Used by
 * `queue-view` the first time a given `order_id` becomes visible; every
 * subsequent poll that still contains the same `order_id` reuses this exact
 * node (`updateCardNode`) instead of rebuilding it, so there is no flicker
 * and the "Completado" touch target never moves under the cook's thumb.
 *
 * @param {{ id: string, table: string, createdAtMs: number|null,
 *   items: {name: string, quantity: number}[]|null, summaryText: string|null,
 *   notes: string|null }} cardModel
 * @param {number} nowMs
 * @returns {HTMLElement}
 */
export function createCardNode(cardModel, nowMs) {
  const { text, tier } = timerText(cardModel, nowMs);

  const node = el(
    'article',
    {
      class: `${BASE_CARD_CLASS} ${TIER_CARD_CLASS[tier]}`,
      'data-order-id': cardModel.id,
      'data-role': 'card',
    },
    [
      el('header', { class: 'order-card__header flex items-center justify-between gap-2' }, [
        el('span', { class: 'order-card__table text-4xl font-black text-slate-900', 'data-role': 'table' }, [
          cardModel.table,
        ]),
        el('span', { class: TIER_TIMER_CLASS[tier], 'data-role': 'timer' }, [text]),
      ]),
      renderItems(cardModel),
      renderNotes(cardModel),
      el(
        'button',
        {
          type: 'button',
          class:
            'order-card__complete min-h-16 w-full rounded-xl bg-emerald-600 font-bold text-lg text-white active:bg-emerald-700',
          'data-action': 'complete',
          'data-order-id': cardModel.id,
        },
        ['Completado'],
      ),
    ].filter(Boolean),
  );

  return node;
}

/**
 * Recomputes ONLY the live timer text and the urgency tier's text prefix +
 * border/background/timer color classes, in place, via `textContent` and
 * `className` — never rebuilding the node. This is the exact function
 * `queue-view`/`main.js` registers per order with `ticker.js`
 * (`ticker.register(cardModel.id, (nowMs) => updateTimer(node, cardModel, nowMs))`),
 * so the card itself never runs its own timer (design.md "the card itself
 * doesn't run its own timer; it just exposes the DOM node ticker.js will
 * update").
 *
 * @param {HTMLElement} node
 * @param {{ createdAtMs: number|null }} cardModel
 * @param {number} nowMs
 */
export function updateTimer(node, cardModel, nowMs) {
  const { text, tier } = timerText(cardModel, nowMs);
  const timerEl = node.querySelector('[data-role="timer"]');
  if (timerEl) {
    timerEl.textContent = text;
    timerEl.className = TIER_TIMER_CLASS[tier];
  }
  node.className = `${BASE_CARD_CLASS} ${TIER_CARD_CLASS[tier]}`;
}

/**
 * Refreshes a REUSED card node's full content (table, items/summary, notes)
 * against a possibly-updated `cardModel` for the same `order_id`, plus the
 * timer/tier (via `updateTimer`). Called by `queue-view` once per poll for
 * every still-visible `order_id`, instead of replacing the node.
 *
 * @param {HTMLElement} node
 * @param {{ id: string, table: string, createdAtMs: number|null,
 *   items: {name: string, quantity: number}[]|null, summaryText: string|null,
 *   notes: string|null }} cardModel
 * @param {number} nowMs
 */
export function updateCardNode(node, cardModel, nowMs) {
  const tableEl = node.querySelector('[data-role="table"]');
  if (tableEl) tableEl.textContent = cardModel.table;

  const itemsEl = node.querySelector('[data-role="items"]');
  const replacement = renderItems(cardModel);
  if (itemsEl) itemsEl.replaceWith(replacement);

  const notesEl = node.querySelector('[data-role="notes"]');
  const nextNotes = renderNotes(cardModel);
  if (notesEl && nextNotes) {
    notesEl.replaceWith(nextNotes);
  } else if (notesEl && !nextNotes) {
    notesEl.remove();
  } else if (!notesEl && nextNotes) {
    const completeButton = node.querySelector('[data-action="complete"]');
    node.insertBefore(nextNotes, completeButton);
  }

  updateTimer(node, cardModel, nowMs);
}
