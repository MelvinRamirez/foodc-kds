/**
 * @typedef {{ kind: 'success', data: any, meta: any }
 *   | { kind: 'definitive', code: string, message: string, details: object|null }
 *   | { kind: 'ambiguous', reason: 'network'|'timeout'|'invalid_response' }} ApiResult
 */

/**
 * Clasificador puro del cuerpo de respuesta ya leído como texto. No conoce
 * fetch, timers ni AbortController: solo decide `success` / `definitive` /
 * `ambiguous(invalid_response)` a partir del texto y de `validateData`.
 * Copiado verbatim de foodc-cliente/js/api.js.
 *
 * @param {string} text
 * @param {(data: any) => boolean} validateData
 * @returns {ApiResult}
 */
export function classifyResponseText(text, validateData) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { kind: 'ambiguous', reason: 'invalid_response' };
  }

  if (!body || typeof body !== 'object' || typeof body.ok !== 'boolean') {
    return { kind: 'ambiguous', reason: 'invalid_response' };
  }

  if (body.ok === false) {
    const error = body.error && typeof body.error === 'object' ? body.error : {};
    return {
      kind: 'definitive',
      code: typeof error.code === 'string' ? error.code : 'UNKNOWN_ERROR',
      message: typeof error.message === 'string' ? error.message : '',
      details: error.details ?? null,
    };
  }

  // body.ok === true
  if (!validateData(body.data)) {
    return { kind: 'ambiguous', reason: 'invalid_response' };
  }

  return { kind: 'success', data: body.data, meta: body.meta ?? null };
}

function validateVerifyPinData(data) {
  return data?.valid === true;
}

function validateGetOrdersData(data) {
  return Array.isArray(data) && data.every((item) => typeof item.order_id === 'string');
}

function validateUpdateOrderStatusData(data) {
  return typeof data?.order_id === 'string';
}

const LOCAL_UNAUTHORIZED = Object.freeze({
  kind: 'definitive',
  code: 'UNAUTHORIZED',
  message: '',
  details: null,
});

/**
 * @param {{
 *   baseUrl: string,
 *   getPin: () => string|null,
 *   fetchImpl?: typeof fetch,
 *   timeouts: { poll: number, verify: number, complete: number },
 *   setTimer?: typeof setTimeout,
 *   clearTimer?: typeof clearTimeout,
 * }} options
 */
export function createKdsApiClient({
  baseUrl,
  getPin,
  fetchImpl = globalThis.fetch.bind(globalThis),
  timeouts: { poll, verify, complete },
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  /**
   * Fixed POST transport for all three KDS calls. The URL is always exactly
   * `baseUrl` (never a query string), so the PIN can never appear in a URL.
   *
   * @param {object} body
   * @param {number} timeoutMs
   * @param {(data: any) => boolean} validateData
   * @returns {Promise<ApiResult>}
   */
  async function post(body, timeoutMs, validateData) {
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimer(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);

    try {
      const res = await fetchImpl(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body),
        redirect: 'follow',
        credentials: 'omit',
        cache: 'no-store',
        signal: ctrl.signal,
      });
      // El timer sigue activo durante la lectura del body.
      const text = await res.text();
      return classifyResponseText(text, validateData);
    } catch {
      return { kind: 'ambiguous', reason: timedOut ? 'timeout' : 'network' };
    } finally {
      clearTimer(timer);
    }
  }

  async function verifyPin(pin) {
    // Deliberately NOT guarded by getPin()===null: verifyPin's whole job is
    // to check a just-entered PIN, which has not been stored via getPin() yet.
    return post({ action: 'verifyPin', pin }, verify, validateVerifyPinData);
  }

  async function getOrders(status = 'Pendiente') {
    const pin = getPin();
    if (pin === null) {
      return LOCAL_UNAUTHORIZED;
    }
    return post({ action: 'getOrders', status, pin }, poll, validateGetOrdersData);
  }

  async function updateOrderStatus(order_id) {
    const pin = getPin();
    if (pin === null) {
      return LOCAL_UNAUTHORIZED;
    }
    return post({ action: 'updateOrderStatus', order_id, pin }, complete, validateUpdateOrderStatusData);
  }

  return { verifyPin, getOrders, updateOrderStatus };
}

export function isRelock(result) {
  return result.kind === 'definitive' && result.code === 'UNAUTHORIZED';
}
