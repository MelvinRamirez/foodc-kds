import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKdsApiClient, classifyResponseText, isRelock } from '../js/api.js';

const BASE_URL = 'https://example.test/exec';

function noopTimer() {
  return {
    setTimer: () => 'fake-timer-id',
    clearTimer: () => {},
  };
}

function okResponse(body) {
  return new Response(JSON.stringify(body));
}

function makeClient({ fetchImpl, getPin = () => '123456', ...rest } = {}) {
  return createKdsApiClient({
    baseUrl: BASE_URL,
    getPin,
    fetchImpl,
    timeouts: { poll: 15000, verify: 15000, complete: 30000 },
    ...noopTimer(),
    ...rest,
  });
}

// --- Task 8.3 RED test (threat-matrix case 5, client side): the PIN must
// never leak into the request URL, for every call and every PIN input,
// including a null PIN. Written and confirmed failing BEFORE js/api.js
// existed (no module to import); kept here as the permanent regression
// test per task 8.5. ---

test('verifyPin never puts the PIN in the request URL, for any pin value', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return okResponse({ ok: true, data: { valid: true } });
  };
  const client = makeClient({ fetchImpl });

  for (const pin of ['123456', null, '000000000000', '', 'abc123']) {
    await client.verifyPin(pin);
  }

  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.equal(call.url, BASE_URL);
  }
});

test('getOrders never puts the PIN in the request URL, for any pin value', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return okResponse({ ok: true, data: [] });
  };

  for (const pin of ['123456', null, '000000000000', '']) {
    const client = makeClient({ fetchImpl, getPin: () => pin });
    await client.getOrders('Pendiente');
  }

  // getPin()===null short-circuits with zero fetch calls (see dedicated
  // test below), so only the non-null pins reach fetchImpl here.
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.equal(call.url, BASE_URL);
  }
});

test('updateOrderStatus never puts the PIN in the request URL, for any pin value', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return okResponse({ ok: true, data: { order_id: 'ORD-1' } });
  };

  for (const pin of ['123456', null, '000000000000', '']) {
    const client = makeClient({ fetchImpl, getPin: () => pin });
    await client.updateOrderStatus('ORD-1');
  }

  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.equal(call.url, BASE_URL);
  }
});

// --- classifyResponseText: copied verbatim, same rows as foodc-cliente ---

test('classifyResponseText: ok:false with error object classifies as definitive (any code)', () => {
  const result = classifyResponseText(
    JSON.stringify({ ok: false, error: { code: 'LOCK_TIMEOUT', message: 'busy' } }),
    () => true,
  );
  assert.deepStrictEqual(result, {
    kind: 'definitive',
    code: 'LOCK_TIMEOUT',
    message: 'busy',
    details: null,
  });
});

test('classifyResponseText: ok:false with an unlisted code is still definitive', () => {
  const result = classifyResponseText(
    JSON.stringify({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Invalid kitchen PIN' } }),
    () => true,
  );
  assert.equal(result.kind, 'definitive');
  assert.equal(result.code, 'UNAUTHORIZED');
});

test('classifyResponseText: ok:true with valid data classifies as success', () => {
  const result = classifyResponseText(JSON.stringify({ ok: true, data: [] }), () => true);
  assert.deepStrictEqual(result, { kind: 'success', data: [], meta: null });
});

test('classifyResponseText: ok:true with invalid data shape classifies as ambiguous/invalid_response', () => {
  const result = classifyResponseText(JSON.stringify({ ok: true, data: null }), () => false);
  assert.deepStrictEqual(result, { kind: 'ambiguous', reason: 'invalid_response' });
});

test('classifyResponseText: non-JSON body classifies as ambiguous/invalid_response', () => {
  const result = classifyResponseText('<html>not json</html>', () => true);
  assert.deepStrictEqual(result, { kind: 'ambiguous', reason: 'invalid_response' });
});

test('classifyResponseText: JSON missing boolean ok classifies as ambiguous/invalid_response', () => {
  const result = classifyResponseText(JSON.stringify({ data: [] }), () => true);
  assert.deepStrictEqual(result, { kind: 'ambiguous', reason: 'invalid_response' });
});

// --- transport options (fixed for all three calls) ---

test('verifyPin sends the exact fixed POST transport options and body', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return okResponse({ ok: true, data: { valid: true } });
  };
  const client = makeClient({ fetchImpl, getPin: () => null });

  await client.verifyPin('123456');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, BASE_URL);
  assert.equal(calls[0].options.method, 'POST');
  assert.deepStrictEqual(calls[0].options.headers, { 'Content-Type': 'text/plain;charset=utf-8' });
  assert.equal(calls[0].options.redirect, 'follow');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.cache, 'no-store');
  assert.ok(calls[0].options.signal);
  assert.deepStrictEqual(JSON.parse(calls[0].options.body), { action: 'verifyPin', pin: '123456' });
});

test('getOrders sends the exact fixed POST transport options and body, default status Pendiente', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return okResponse({ ok: true, data: [] });
  };
  const client = makeClient({ fetchImpl, getPin: () => '654321' });

  await client.getOrders();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, BASE_URL);
  assert.equal(calls[0].options.method, 'POST');
  assert.deepStrictEqual(calls[0].options.headers, { 'Content-Type': 'text/plain;charset=utf-8' });
  assert.equal(calls[0].options.redirect, 'follow');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.cache, 'no-store');
  assert.deepStrictEqual(JSON.parse(calls[0].options.body), {
    action: 'getOrders',
    status: 'Pendiente',
    pin: '654321',
  });
});

test('updateOrderStatus sends the exact fixed POST transport options and body', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return okResponse({ ok: true, data: { order_id: 'ORD-9' } });
  };
  const client = makeClient({ fetchImpl, getPin: () => '654321' });

  await client.updateOrderStatus('ORD-9');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, BASE_URL);
  assert.equal(calls[0].options.method, 'POST');
  assert.deepStrictEqual(calls[0].options.headers, { 'Content-Type': 'text/plain;charset=utf-8' });
  assert.equal(calls[0].options.redirect, 'follow');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.cache, 'no-store');
  assert.deepStrictEqual(JSON.parse(calls[0].options.body), {
    action: 'updateOrderStatus',
    order_id: 'ORD-9',
    pin: '654321',
  });
});

// --- validators ---

test('verifyPin: data.valid === true classifies as success; anything else is ambiguous/invalid_response', async () => {
  const client1 = makeClient({
    fetchImpl: async () => okResponse({ ok: true, data: { valid: true } }),
  });
  assert.deepStrictEqual(await client1.verifyPin('123456'), {
    kind: 'success',
    data: { valid: true },
    meta: null,
  });

  const client2 = makeClient({
    fetchImpl: async () => okResponse({ ok: true, data: { valid: false } }),
  });
  assert.deepStrictEqual(await client2.verifyPin('123456'), {
    kind: 'ambiguous',
    reason: 'invalid_response',
  });

  const client3 = makeClient({
    fetchImpl: async () => okResponse({ ok: true, data: {} }),
  });
  assert.deepStrictEqual(await client3.verifyPin('123456'), {
    kind: 'ambiguous',
    reason: 'invalid_response',
  });
});

test('getOrders: array of objects with string order_id classifies as success; otherwise ambiguous', async () => {
  const client1 = makeClient({
    fetchImpl: async () => okResponse({ ok: true, data: [{ order_id: 'A' }, { order_id: 'B' }] }),
  });
  const r1 = await client1.getOrders();
  assert.equal(r1.kind, 'success');
  assert.deepStrictEqual(r1.data, [{ order_id: 'A' }, { order_id: 'B' }]);

  const client2 = makeClient({
    fetchImpl: async () => okResponse({ ok: true, data: [{ order_id: 'A' }, { order_id: 5 }] }),
  });
  assert.deepStrictEqual(await client2.getOrders(), { kind: 'ambiguous', reason: 'invalid_response' });

  const client3 = makeClient({
    fetchImpl: async () => okResponse({ ok: true, data: {} }),
  });
  assert.deepStrictEqual(await client3.getOrders(), { kind: 'ambiguous', reason: 'invalid_response' });

  const client4 = makeClient({
    fetchImpl: async () => okResponse({ ok: true, data: [] }),
  });
  assert.deepStrictEqual(await client4.getOrders(), { kind: 'success', data: [], meta: null });
});

test('updateOrderStatus: data.order_id string classifies as success; otherwise ambiguous', async () => {
  const client1 = makeClient({
    fetchImpl: async () => okResponse({ ok: true, data: { order_id: 'ORD-1' } }),
  });
  assert.deepStrictEqual(await client1.updateOrderStatus('ORD-1'), {
    kind: 'success',
    data: { order_id: 'ORD-1' },
    meta: null,
  });

  const client2 = makeClient({
    fetchImpl: async () => okResponse({ ok: true, data: { order_id: 5 } }),
  });
  assert.deepStrictEqual(await client2.updateOrderStatus('ORD-1'), {
    kind: 'ambiguous',
    reason: 'invalid_response',
  });
});

// --- timeout behavior (fake timers, one per call kind) ---

test('verifyPin times out using timeouts.verify', async () => {
  let capturedTimeoutMs;
  let timerCallback;
  const setTimer = (cb, ms) => {
    timerCallback = cb;
    capturedTimeoutMs = ms;
    return 'timer-id';
  };
  const clearTimer = () => {};
  const fetchImpl = (url, options) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });

  const client = createKdsApiClient({
    baseUrl: BASE_URL,
    getPin: () => '123456',
    fetchImpl,
    timeouts: { poll: 15000, verify: 15000, complete: 30000 },
    setTimer,
    clearTimer,
  });

  const promise = client.verifyPin('123456');
  timerCallback();
  const result = await promise;

  assert.equal(capturedTimeoutMs, 15000);
  assert.deepStrictEqual(result, { kind: 'ambiguous', reason: 'timeout' });
});

test('getOrders times out using timeouts.poll', async () => {
  let capturedTimeoutMs;
  let timerCallback;
  const setTimer = (cb, ms) => {
    timerCallback = cb;
    capturedTimeoutMs = ms;
    return 'timer-id';
  };
  const clearTimer = () => {};
  const fetchImpl = (url, options) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });

  const client = createKdsApiClient({
    baseUrl: BASE_URL,
    getPin: () => '123456',
    fetchImpl,
    timeouts: { poll: 15000, verify: 15000, complete: 30000 },
    setTimer,
    clearTimer,
  });

  const promise = client.getOrders();
  timerCallback();
  const result = await promise;

  assert.equal(capturedTimeoutMs, 15000);
  assert.deepStrictEqual(result, { kind: 'ambiguous', reason: 'timeout' });
});

test('updateOrderStatus times out using timeouts.complete', async () => {
  let capturedTimeoutMs;
  let timerCallback;
  const setTimer = (cb, ms) => {
    timerCallback = cb;
    capturedTimeoutMs = ms;
    return 'timer-id';
  };
  const clearTimer = () => {};
  const fetchImpl = (url, options) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });

  const client = createKdsApiClient({
    baseUrl: BASE_URL,
    getPin: () => '123456',
    fetchImpl,
    timeouts: { poll: 15000, verify: 15000, complete: 30000 },
    setTimer,
    clearTimer,
  });

  const promise = client.updateOrderStatus('ORD-1');
  timerCallback();
  const result = await promise;

  assert.equal(capturedTimeoutMs, 30000);
  assert.deepStrictEqual(result, { kind: 'ambiguous', reason: 'timeout' });
});

test('a network rejection not caused by the timeout is classified as ambiguous/network', async () => {
  const client = makeClient({
    fetchImpl: async () => {
      throw new Error('network down');
    },
  });
  assert.deepStrictEqual(await client.getOrders(), { kind: 'ambiguous', reason: 'network' });
});

// --- getPin()===null short-circuit on protected calls ---

test('getOrders short-circuits locally to UNAUTHORIZED with zero fetch calls when getPin() is null', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls++;
    return okResponse({ ok: true, data: [] });
  };
  const client = makeClient({ fetchImpl, getPin: () => null });

  const result = await client.getOrders();

  assert.equal(fetchCalls, 0);
  assert.deepStrictEqual(result, { kind: 'definitive', code: 'UNAUTHORIZED', message: '', details: null });
});

test('updateOrderStatus short-circuits locally to UNAUTHORIZED with zero fetch calls when getPin() is null', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls++;
    return okResponse({ ok: true, data: { order_id: 'ORD-1' } });
  };
  const client = makeClient({ fetchImpl, getPin: () => null });

  const result = await client.updateOrderStatus('ORD-1');

  assert.equal(fetchCalls, 0);
  assert.deepStrictEqual(result, { kind: 'definitive', code: 'UNAUTHORIZED', message: '', details: null });
});

test('verifyPin does NOT short-circuit when getPin() is null (verifyPin checks a just-entered pin, not getPin())', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls++;
    return okResponse({ ok: true, data: { valid: true } });
  };
  const client = makeClient({ fetchImpl, getPin: () => null });

  const result = await client.verifyPin('123456');

  assert.equal(fetchCalls, 1);
  assert.deepStrictEqual(result, { kind: 'success', data: { valid: true }, meta: null });
});

// --- isRelock ---

test('isRelock: true only for definitive UNAUTHORIZED', () => {
  assert.equal(isRelock({ kind: 'definitive', code: 'UNAUTHORIZED', message: '', details: null }), true);
  assert.equal(isRelock({ kind: 'definitive', code: 'PIN_NOT_CONFIGURED', message: '', details: null }), false);
  assert.equal(isRelock({ kind: 'ambiguous', reason: 'timeout' }), false);
  assert.equal(isRelock({ kind: 'success', data: [], meta: null }), false);
});
