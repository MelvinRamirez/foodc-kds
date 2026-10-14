/**
 * A 1 s timer that updates registered timer-node callbacks in place. It
 * never writes to the store (re-rendering every card each second would be
 * wasteful) and never makes a network request — it is structurally
 * incapable of either: its only dependencies are `setTimer`/`clearTimer`,
 * never a `store` or an `api` client.
 *
 * @param {{ setTimer?: typeof setInterval, clearTimer?: typeof clearInterval }} [deps]
 * @returns {{ register(id: string, callback: (nowMs: number) => void): void,
 *             unregister(id: string): void,
 *             start(): void,
 *             stop(): void }}
 */
export function createTicker({ setTimer = setInterval, clearTimer = clearInterval } = {}) {
  const callbacks = new Map();
  let intervalId = null;

  function tick() {
    const nowMs = Date.now();
    // Iterate a snapshot: a callback that unregisters itself or another id
    // mid-tick must not skip or duplicate remaining callbacks.
    for (const callback of Array.from(callbacks.values())) {
      callback(nowMs);
    }
  }

  /**
   * @param {string} id
   * @param {(nowMs: number) => void} callback invoked once per second with
   *   the current epoch ms, for every currently-registered id.
   */
  function register(id, callback) {
    callbacks.set(id, callback);
  }

  /** @param {string} id */
  function unregister(id) {
    callbacks.delete(id);
  }

  function start() {
    if (intervalId !== null) return;
    intervalId = setTimer(tick, 1000);
  }

  function stop() {
    if (intervalId === null) return;
    clearTimer(intervalId);
    intervalId = null;
  }

  return { register, unregister, start, stop };
}
