/**
 * Screen Wake Lock with an explicit, visible fallback (design A6).
 *
 * @param {{ navigator: { wakeLock?: { request(type: 'screen'): Promise<any> } },
 *           document: { visibilityState?: string, addEventListener?: Function } }} deps
 * @returns {{ request(): Promise<'active'|'unsupported'|'denied'>,
 *             release(): void,
 *             readonly state: 'active'|'unsupported'|'denied' }}
 */
export function createWakeLock({ navigator, document }) {
  let state = 'unsupported';
  let sentinel = null;

  function supported() {
    return Boolean(navigator) && 'wakeLock' in navigator;
  }

  /** @returns {Promise<'active'|'unsupported'|'denied'>} */
  async function request() {
    if (!supported()) {
      state = 'unsupported';
      return state;
    }
    try {
      sentinel = await navigator.wakeLock.request('screen');
      state = 'active';
    } catch {
      state = 'denied';
    }
    return state;
  }

  function release() {
    if (sentinel && typeof sentinel.release === 'function') {
      sentinel.release();
    }
    sentinel = null;
  }

  // The browser releases the lock whenever the page is hidden, so it must
  // be re-requested on every transition back to visible.
  if (document && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        request();
      }
    });
  }

  return {
    request,
    release,
    get state() {
      return state;
    },
  };
}
