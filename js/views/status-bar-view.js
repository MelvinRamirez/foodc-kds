import { messages } from '../messages.js';
import { select } from '../store.js';
import { el } from './dom.js';

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Formats an epoch-ms timestamp as a wall-clock `HH:MM:SS` using the
 * tablet's local time. Deliberately NOT in `time.js`: that module is about
 * elapsed-time math and urgency tiers against the fixed server UTC offset,
 * never wall-clock formatting of "now" on the device itself — a small local
 * helper is more honest about what this is than stretching time.js's scope.
 *
 * @param {number|null} epochMs
 * @returns {string} '--:--:--' when `epochMs` is not a finite number.
 */
export function formatWallClock(epochMs) {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) return '--:--:--';
  const d = new Date(epochMs);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/**
 * `state.sync` -> status-bar text, per design.md's A2 table "Status bar"
 * column. `connecting`/`contract`/`not_configured` carry fixed copy;
 * `ok`/`retrying`/`stale` are functions of the formatted last-sync time.
 *
 * @param {{ status: string }} sync
 * @param {number|null} lastSyncAt
 * @returns {string}
 */
export function syncStatusText(sync, lastSyncAt) {
  const time = formatWallClock(lastSyncAt);
  if (sync.status === 'connecting') return messages.sync.connecting;
  if (sync.status === 'ok') return messages.sync.ok(time);
  if (sync.status === 'retrying') return messages.sync.retrying(time);
  if (sync.status === 'stale') return messages.sync.stale(time);
  if (sync.status === 'contract') return messages.sync.contract;
  if (sync.status === 'not_configured') return messages.sync.notConfigured;
  return '';
}

const STATUS_DOT_CLASS = {
  connecting: 'bg-slate-400',
  ok: 'bg-emerald-500',
  retrying: 'bg-amber-500',
  stale: 'bg-red-600',
  contract: 'bg-red-600',
  not_configured: 'bg-red-600',
};

const STATUS_BANNER_CLASS = {
  stale: 'bg-red-600 text-white',
  contract: 'bg-red-600 text-white',
  not_configured: 'bg-red-600 text-white',
};

function render({ sync, lastSyncAt, wake }) {
  const fragment = document.createDocumentFragment();
  const isBanner = sync.status === 'stale' || sync.status === 'contract' || sync.status === 'not_configured';
  const text = syncStatusText(sync, lastSyncAt);

  const bar = el(
    'div',
    {
      class: isBanner
        ? `status-bar flex items-center justify-between gap-3 px-3 py-2 rounded-lg ${STATUS_BANNER_CLASS[sync.status]}`
        : 'status-bar flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-white',
      role: isBanner ? 'alert' : 'status',
    },
    [
      el('div', { class: 'status-bar__sync flex min-w-0 items-center gap-2' }, [
        el('span', {
          class: `status-bar__dot h-2.5 w-2.5 shrink-0 rounded-full ${STATUS_DOT_CLASS[sync.status] || 'bg-slate-400'}`,
          'aria-hidden': 'true',
        }),
        el('span', { class: 'status-bar__text min-w-0 text-sm font-semibold' }, [text]),
      ]),
      el(
        'button',
        {
          type: 'button',
          class:
            'status-bar__lock min-h-11 min-w-11 shrink-0 whitespace-nowrap rounded-lg border border-slate-300 px-3 py-1 text-sm font-bold text-slate-700',
          'data-action': 'lock',
        },
        [messages.pin.lockButton],
      ),
    ],
  );
  fragment.appendChild(bar);

  if (wake === 'unsupported' || wake === 'denied') {
    fragment.appendChild(
      el('p', { class: 'status-bar__wake-hint text-xs text-slate-500 px-3', role: 'status' }, [
        messages.wake.fallbackHint,
      ]),
    );
  }

  return fragment;
}

/**
 * Mounts the status bar: sync status + last-sync time (A2 table), the
 * wake-lock fallback hint when `state.wake` is `unsupported`/`denied`
 * (never shown for `active`/`idle`), and the manual "Bloquear" button
 * (`data-action="lock"` → `handlers.onLock()` → `effects.lock(ctx)`).
 *
 * @param {HTMLElement} root
 * @param {import('../store.js').createStore<any>} store
 * @param {{ onLock: () => void }} handlers
 * @returns {() => void} unmount
 */
export function mountStatusBarView(root, store, handlers) {
  function renderNow() {
    const state = store.getState();
    root.replaceChildren(
      render({ sync: state.sync, lastSyncAt: state.queue.lastSyncAt, wake: state.wake }),
    );
  }

  function dispatchFromEvent(event) {
    const target = event.target.closest ? event.target.closest('[data-action="lock"]') : null;
    if (!target || !root.contains(target)) return;
    handlers.onLock();
  }

  renderNow();
  root.addEventListener('click', dispatchFromEvent);
  const unsubSync = select(store, (state) => state.sync, renderNow);
  const unsubQueue = select(store, (state) => state.queue.lastSyncAt, renderNow);
  const unsubWake = select(store, (state) => state.wake, renderNow);

  return function unmount() {
    unsubSync();
    unsubQueue();
    unsubWake();
    root.removeEventListener('click', dispatchFromEvent);
  };
}
