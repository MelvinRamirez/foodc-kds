import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWakeLock } from '../js/wake-lock.js';

function makeDocument() {
  let visibilityState = 'visible';
  const listeners = [];
  return {
    get visibilityState() {
      return visibilityState;
    },
    setVisibility(v) {
      visibilityState = v;
    },
    addEventListener(event, cb) {
      listeners.push({ event, cb });
    },
    fire(event) {
      for (const l of listeners) {
        if (l.event === event) l.cb();
      }
    },
  };
}

test('wake-lock: unsupported API (no wakeLock in navigator) resolves immediately to unsupported, no request attempted', async () => {
  const navigator = {}; // no wakeLock key at all
  const document = makeDocument();
  const wakeLock = createWakeLock({ navigator, document });

  const result = await wakeLock.request();
  assert.equal(result, 'unsupported');
  assert.equal(wakeLock.state, 'unsupported');
});

test('wake-lock: API present and request() resolves -> active', async () => {
  let requestCalls = 0;
  const navigator = {
    wakeLock: {
      request: async (type) => {
        requestCalls++;
        assert.equal(type, 'screen');
        return { release: () => {} };
      },
    },
  };
  const document = makeDocument();
  const wakeLock = createWakeLock({ navigator, document });

  const result = await wakeLock.request();
  assert.equal(result, 'active');
  assert.equal(wakeLock.state, 'active');
  assert.equal(requestCalls, 1);
});

test('wake-lock: API present but request() rejects -> denied', async () => {
  const navigator = {
    wakeLock: {
      request: async () => {
        throw new Error('not allowed');
      },
    },
  };
  const document = makeDocument();
  const wakeLock = createWakeLock({ navigator, document });

  const result = await wakeLock.request();
  assert.equal(result, 'denied');
  assert.equal(wakeLock.state, 'denied');
});

test('wake-lock: re-request fires on visibilitychange -> visible', async () => {
  let requestCalls = 0;
  const navigator = {
    wakeLock: {
      request: async () => {
        requestCalls++;
        return { release: () => {} };
      },
    },
  };
  const document = makeDocument();
  createWakeLock({ navigator, document });

  document.setVisibility('visible');
  document.fire('visibilitychange');
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(requestCalls, 1, 'navigator.wakeLock.request called again after simulating the event');
});

test('wake-lock: visibilitychange to hidden does not trigger a re-request', async () => {
  let requestCalls = 0;
  const navigator = {
    wakeLock: {
      request: async () => {
        requestCalls++;
        return { release: () => {} };
      },
    },
  };
  const document = makeDocument();
  createWakeLock({ navigator, document });

  document.setVisibility('hidden');
  document.fire('visibilitychange');
  await Promise.resolve();

  assert.equal(requestCalls, 0);
});

test('wake-lock: release() calls the sentinel\'s release', async () => {
  let released = false;
  const navigator = {
    wakeLock: {
      request: async () => ({ release: () => { released = true; } }),
    },
  };
  const document = makeDocument();
  const wakeLock = createWakeLock({ navigator, document });
  await wakeLock.request();
  wakeLock.release();
  assert.equal(released, true);
});
