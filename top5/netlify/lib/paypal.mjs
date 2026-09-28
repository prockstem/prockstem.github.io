import { CURRENCY, PRICE, paypalEnv, siteUrl } from './config.mjs';

function apiBase() {
  const env = paypalEnv();
  if (env === 'live') return 'https://api-m.paypal.com';
  // "mock" exists only for automated local tests (scripts/mock-paypal.mjs).
  if (env === 'mock') return process.env.PAYPAL_API_BASE || 'http://localhost:9999';
  return 'https://api-m.sandbox.paypal.com';
}

let cachedToken = null;

async function accessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set');
  const res = await fetch(`${apiBase()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`PayPal auth failed (${res.status})`);
  const data = await res.json();
  cachedToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.value;
}

async function call(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { ok: res.ok, status: res.status, data };
}

export function createOrder({ edition }) {
  return call('/v2/checkout/orders', {
    method: 'POST',
    body: {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: 'top5-access',
          custom_id: `top5:edition:${edition}`,
          description: 'TOP 5 ECOM STORES: access to the curated list',
          amount: { currency_code: CURRENCY, value: PRICE },
        },
      ],
      application_context: {
        brand_name: 'TOP 5 ECOM STORES',
        shipping_preference: 'NO_SHIPPING',
        user_action: 'PAY_NOW',
        return_url: `${siteUrl()}/success`,
        cancel_url: `${siteUrl()}/`,
      },
    },
  });
}

// PayPal-Request-Id makes a retried capture idempotent.
export const captureOrder = (orderId) =>
  call(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    method: 'POST',
    body: {},
    headers: { 'paypal-request-id': `capture-${orderId}` },
  });

export const getOrder = (orderId) => call(`/v2/checkout/orders/${encodeURIComponent(orderId)}`);

export const isExpectedAmount = (amount) => amount?.currency_code === CURRENCY && amount?.value === PRICE;

// Decide from PayPal's own order data (never from the browser) whether this
// order paid exactly PRICE CURRENCY. Returns { state: 'completed' | 'pending' | 'invalid' }.
export function evaluateOrder(order) {
  const units = order?.purchase_units;
  if (!Array.isArray(units) || units.length !== 1) return { state: 'invalid', reason: 'unexpected purchase units' };
  const captures = units[0].payments?.captures;
  if (!Array.isArray(captures) || captures.length !== 1) return { state: 'invalid', reason: 'expected exactly one capture' };
  const capture = captures[0];
  if (!isExpectedAmount(capture.amount)) return { state: 'invalid', reason: 'wrong amount or currency', capture };
  if (order.status === 'COMPLETED' && capture.status === 'COMPLETED') return { state: 'completed', capture };
  if (capture.status === 'PENDING') return { state: 'pending', capture };
  return { state: 'invalid', reason: `capture status ${capture.status}`, capture };
}

export async function verifyWebhookSignature(headers, event) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) throw new Error('PAYPAL_WEBHOOK_ID is not set');
  const need = ['paypal-auth-algo', 'paypal-cert-url', 'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time'];
  if (need.some((h) => !headers.get(h))) return false;
  const res = await call('/v1/notifications/verify-webhook-signature', {
    method: 'POST',
    body: {
      auth_algo: headers.get('paypal-auth-algo'),
      cert_url: headers.get('paypal-cert-url'),
      transmission_id: headers.get('paypal-transmission-id'),
      transmission_sig: headers.get('paypal-transmission-sig'),
      transmission_time: headers.get('paypal-transmission-time'),
      webhook_id: webhookId,
      webhook_event: event,
    },
  });
  return res.ok && res.data?.verification_status === 'SUCCESS';
}
