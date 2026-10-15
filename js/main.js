import {
  API_URL,
  POLL_TIMEOUT_MS,
  VERIFY_TIMEOUT_MS,
  COMPLETE_TIMEOUT_MS,
  STORAGE_KEY,
} from './config.js';
import { createStore, select } from './store.js';
import { initialState, actions } from './actions.js';
import { loadPersisted, attachPersistence } from './persistence.js';
import { createKdsApiClient } from './api.js';
import { loadPin } from './pin.js';
import * as effects from './effects.js';
import { createTicker } from './ticker.js';
import { createWakeLock } from './wake-lock.js';
import { messages } from './messages.js';
import { el } from './views/dom.js';
import { mountPinView } from './views/pin-view.js';
import { mountQueueView } from './views/queue-view.js';
import { mountStatusBarView } from './views/status-bar-view.js';

/**
 * Lee `localStorage`/`sessionStorage` de forma defensiva: algunos modos de
 * navegación privada lanzan al acceder a estos objetos globales, no solo al
 * leer/escribir una clave. Mismo patrón que foodc-cliente/js/main.js.
 * @returns {{ localStorage: Storage|null, sessionStorage: Storage|null }}
 */
function getBrowserStorages() {
  let local = null;
  let session = null;
  try {
    local = window.localStorage;
  } catch {
    local = null;
  }
  try {
    session = window.sessionStorage;
  } catch {
    session = null;
  }
  return { localStorage: local, sessionStorage: session };
}

function main() {
  const { localStorage: localStorageRef, sessionStorage: sessionStorageRef } = getBrowserStorages();

  const pending = loadPersisted(localStorageRef, STORAGE_KEY);
  const storedPin = loadPin(sessionStorageRef);

  const store = createStore(initialState({ pending, hasPin: storedPin !== null }));
  attachPersistence(store, localStorageRef, STORAGE_KEY);

  const ctx = {
    store,
    api: createKdsApiClient({
      baseUrl: API_URL,
      getPin: () => loadPin(sessionStorageRef),
      timeouts: { poll: POLL_TIMEOUT_MS, verify: VERIFY_TIMEOUT_MS, complete: COMPLETE_TIMEOUT_MS },
    }),
    pinStorage: sessionStorageRef,
    now: Date.now,
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (id) => window.clearTimeout(id),
    isVisible: () => document.visibilityState === 'visible',
    isOnline: () => navigator.onLine,
    wakeLock: createWakeLock({ navigator, document }),
  };

  const ticker = createTicker();

  const handlers = {
    onUnlock: (pin) => effects.unlock(ctx, pin),
    onComplete: (orderId) => effects.completeOrder(ctx, orderId),
    onLock: () => effects.lock(ctx),
    ticker: { register: ticker.register, unregister: ticker.unregister },
  };

  const pinRoot = document.getElementById('pin-root');
  const statusBarRoot = document.getElementById('status-bar-root');
  const queueRoot = document.getElementById('queue-root');
  const noticeRoot = document.getElementById('notice-root');

  mountPinView(pinRoot, store, handlers);
  mountStatusBarView(statusBarRoot, store, handlers);
  mountQueueView(queueRoot, store, handlers);

  // Visibility of each region is main.js's call (views render unconditionally,
  // pure given state): the PIN screen blocks everything else until unlocked.
  function syncVisibility(status) {
    const unlocked = status === 'unlocked';
    pinRoot.hidden = unlocked;
    statusBarRoot.hidden = !unlocked;
    queueRoot.hidden = !unlocked;
  }
  syncVisibility(store.getState().auth.status);
  select(store, (state) => state.auth.status, syncVisibility);

  // "Restored" notice (contract-bug completion path): no dedicated view file
  // in the Phase 13 file list, so it is rendered directly here against the
  // toast/notice region task 13.9 asks `index.html` to provide.
  function renderNotice(notice) {
    if (!notice) {
      noticeRoot.replaceChildren();
      return;
    }
    noticeRoot.replaceChildren(
      el(
        'div',
        {
          class:
            'notice flex items-center justify-between gap-3 rounded-lg bg-amber-100 px-3 py-2 text-sm text-amber-900 shadow',
          role: 'alert',
        },
        [
          el('span', {}, [messages.completion.restoredNotice(notice.table_number)]),
          el(
            'button',
            {
              type: 'button',
              class: 'notice__dismiss min-h-11 min-w-11 font-bold',
              'data-action': 'dismiss-notice',
            },
            [messages.completion.restoredDismiss],
          ),
        ],
      ),
    );
  }
  renderNotice(store.getState().notice);
  select(store, (state) => state.notice, renderNotice);
  noticeRoot.addEventListener('click', (event) => {
    const target = event.target.closest ? event.target.closest('[data-action="dismiss-notice"]') : null;
    if (!target) return;
    store.setState((state) => actions.dismissNotice(state));
  });

  effects.startCompletionRunner(ctx);
  ticker.start();

  if (store.getState().auth.status === 'unlocked') {
    // On load, if sessionStorage already holds a PIN, the state goes
    // straight to 'unlocked' (initialState({hasPin:true})) without
    // re-calling verifyPin — the first poll validates it.
    effects.startPolling(ctx);
    ctx.wakeLock.request();
  }

  window.addEventListener('online', () => effects.pollNow(ctx));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') effects.pollNow(ctx);
  });

  // Registra el service worker del app shell (kds-pwa-shell). Sin recarga
  // automática al actualizar (design.md, "Service worker update per deploy"):
  // la KDS corre horas en una sola pestaña, así que el shell nuevo se aplica
  // recién en la próxima navegación — por eso el checklist de deploy incluye
  // recargar manualmente la tablet una vez después de cada deploy. El fallo
  // de registro se ignora (`catch(() => {})`): sin service worker la app
  // sigue funcionando online, solo pierde precache/offline del shell.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {});
  }
}

main();
