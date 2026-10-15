import { messages } from '../messages.js';
import { visibleOrders, toCardModel } from '../queue.js';
import { select } from '../store.js';
import { el } from './dom.js';
import { createCardNode, updateCardNode, updateTimer } from './order-card-view.js';

/**
 * Status/empty text for the queue area itself, per design.md's A2 table
 * ("Stale data is never hidden; connectivity escalates at 60 s") "Queue
 * area" column. The "empty queue" text is rendered ONLY when
 * `sync.status === 'ok'` AND zero orders are visible — a successful `[]` is
 * the only thing that proves there is nothing pending; `stale` has its own
 * distinct empty text ("Sin conexión: no se puede confirmar si hay
 * pedidos"). `connecting` (unlocked, no successful poll yet) shows a
 * neutral "never the empty state" placeholder instead.
 *
 * @param {{ status: string }} sync
 * @param {number} visibleCount
 * @returns {string|null} null when cards should render instead.
 */
function emptyOrConnectingText(sync, visibleCount) {
  if (sync.status === 'connecting') return messages.sync.connecting;
  if (visibleCount === 0 && sync.status === 'ok') return messages.sync.emptyQueueOk;
  if (visibleCount === 0 && sync.status === 'stale') return messages.sync.emptyQueueStale;
  // retrying/contract/not_configured with zero KNOWN orders yet (no
  // successful poll has ever landed in this streak): design's A2 table only
  // names dedicated empty-area text for 'ok' and 'stale'. Judgment call:
  // render nothing extra here rather than inventing unspecified copy; the
  // status bar (status-bar-view.js) already carries the full explanatory
  // banner for every other sync.status.
  return null;
}

/**
 * The generic "datos sin confirmar" ribbon shown above the grid whenever
 * the last known cards might not be current: `stale`, `contract` and
 * `not_configured` all read "Last known cards with the ribbon" in design's
 * A2 table, so all three reuse the same `staleRibbon` text rather than each
 * inventing a distinct ribbon string design never specifies.
 *
 * @param {{ status: string }} sync
 * @returns {string|null}
 */
function ribbonText(sync) {
  if (sync.status === 'stale' || sync.status === 'contract' || sync.status === 'not_configured') {
    return messages.sync.staleRibbon;
  }
  return null;
}

/**
 * Mounts the order queue: a landscape CSS grid of cards keyed by
 * `order_id`, reusing DOM nodes across polls (no rebuild/flicker when a
 * poll returns the same orders), plus the distinct status texts from
 * design's A2 table.
 *
 * `handlers.ticker` is the `{ register, unregister }` pair of the single
 * `ticker.js` instance `main.js` owns (judgment call, not spelled out in
 * design's "common contract": the common view signature is
 * `mount(root, store, handlers)` with no separate ticker parameter, and
 * folding it into `handlers` keeps that 3-argument shape for every view
 * instead of special-casing queue-view's signature).
 *
 * @param {HTMLElement} root
 * @param {import('../store.js').createStore<any>} store
 * @param {{ onComplete: (orderId: string) => void,
 *           ticker: { register(id: string, cb: (nowMs: number) => void): void,
 *                     unregister(id: string): void } }} handlers
 * @returns {() => void} unmount
 */
export function mountQueueView(root, store, handlers) {
  /** @type {Map<string, HTMLElement>} */
  const cardNodes = new Map();

  function renderNow() {
    const state = store.getState();
    const nowMs = Date.now();
    const visible = visibleOrders(state.queue.orders, state.completions.pending);
    const cardModels = visible.map((order) => toCardModel(order, nowMs));
    const visibleIds = new Set(cardModels.map((m) => m.id));

    // Drop nodes for order_ids no longer visible (completed, or filtered by
    // a pending completion that just got queued).
    for (const [id, node] of cardNodes) {
      if (!visibleIds.has(id)) {
        handlers.ticker.unregister(id);
        node.remove();
        cardNodes.delete(id);
      }
    }

    const statusText = emptyOrConnectingText(state.sync, cardModels.length);

    root.replaceChildren();

    const ribbon = ribbonText(state.sync);
    if (ribbon) {
      root.appendChild(
        el('p', { class: 'queue-view__ribbon rounded-lg bg-red-100 px-3 py-1 text-xs font-bold text-red-800', role: 'status' }, [
          ribbon,
        ]),
      );
    }

    if (statusText !== null) {
      root.appendChild(
        el('p', { class: 'queue-view__status text-center text-lg font-semibold text-slate-500', role: 'status' }, [
          statusText,
        ]),
      );
      return;
    }

    const grid = el('div', {
      class: 'queue-view__grid grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4',
    });

    for (const cardModel of cardModels) {
      let node = cardNodes.get(cardModel.id);
      if (!node) {
        node = createCardNode(cardModel, nowMs);
        cardNodes.set(cardModel.id, node);
        handlers.ticker.register(cardModel.id, (tickNowMs) => updateTimer(node, cardModel, tickNowMs));
      } else {
        updateCardNode(node, cardModel, nowMs);
      }
      grid.appendChild(node); // appendChild on an existing child reorders it in place, no rebuild.
    }
    root.appendChild(grid);
  }

  function dispatchFromEvent(event) {
    const target = event.target.closest ? event.target.closest('[data-action="complete"]') : null;
    if (!target || !root.contains(target)) return;
    const orderId = target.dataset.orderId;
    if (orderId) handlers.onComplete(orderId);
  }

  renderNow();
  root.addEventListener('click', dispatchFromEvent);
  const unsubQueue = select(store, (state) => state.queue, renderNow);
  const unsubCompletions = select(store, (state) => state.completions, renderNow);
  const unsubSync = select(store, (state) => state.sync, renderNow);

  return function unmount() {
    unsubQueue();
    unsubCompletions();
    unsubSync();
    root.removeEventListener('click', dispatchFromEvent);
    for (const id of cardNodes.keys()) {
      handlers.ticker.unregister(id);
    }
    cardNodes.clear();
  };
}
