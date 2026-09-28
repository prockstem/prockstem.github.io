// A tiny stand-in for the PayPal REST API, for automated local tests only.
// Run: node scripts/mock-paypal.mjs   (listens on :9999)
// Then start `netlify dev` with PAYPAL_ENV=mock. Never used in production:
// lib/paypal.mjs only talks to it when PAYPAL_ENV is exactly "mock".
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

const PORT = Number(process.env.MOCK_PAYPAL_PORT || 9999);
const orders = new Map();
const newId = () => randomBytes(8).toString('hex').toUpperCase();

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const orderView = (o) => ({
  id: o.id,
  status: o.status,
  payer: o.payer,
  purchase_units: [
    {
      reference_id: o.reference_id,
      custom_id: o.custom_id,
      amount: o.amount,
      payments: o.capture ? { captures: [o.capture] } : undefined,
    },
  ],
});

createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw && req.headers['content-type']?.includes('json') ? JSON.parse(raw) : {};
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  let m;

  if (req.method === 'POST' && p === '/v1/oauth2/token') return send(res, 200, { access_token: 'mock-token', expires_in: 3600 });

  if (req.method === 'POST' && p === '/v2/checkout/orders') {
    const unit = body.purchase_units?.[0] || {};
    const o = { id: newId(), status: 'CREATED', amount: unit.amount, reference_id: unit.reference_id, custom_id: unit.custom_id };
    orders.set(o.id, o);
    return send(res, 201, { id: o.id, status: o.status });
  }

  if (req.method === 'POST' && (m = p.match(/^\/v2\/checkout\/orders\/([^/]+)\/capture$/))) {
    const o = orders.get(m[1]);
    if (!o) return send(res, 404, { name: 'RESOURCE_NOT_FOUND', details: [{ issue: 'INVALID_RESOURCE_ID' }] });
    if (o.status === 'COMPLETED') return send(res, 422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] });
    if (o.status !== 'APPROVED') return send(res, 422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_NOT_APPROVED' }] });
    o.status = 'COMPLETED';
    o.capture = { id: `CAP${newId()}`, status: o.captureStatus || 'COMPLETED', amount: o.amount };
    return send(res, 201, orderView(o));
  }

  if (req.method === 'GET' && (m = p.match(/^\/v2\/checkout\/orders\/([^/]+)$/))) {
    const o = orders.get(m[1]);
    return o ? send(res, 200, orderView(o)) : send(res, 404, { name: 'RESOURCE_NOT_FOUND' });
  }

  if (req.method === 'POST' && p === '/v1/notifications/verify-webhook-signature') {
    const ok = body.transmission_sig === 'valid-signature' && body.webhook_id === process.env.EXPECT_WEBHOOK_ID;
    return send(res, 200, { verification_status: ok ? 'SUCCESS' : 'FAILURE' });
  }

  // ---- test controls (not part of PayPal's API) ----
  if (req.method === 'POST' && (m = p.match(/^\/__approve\/([^/]+)$/))) {
    const o = orders.get(m[1]);
    if (!o) return send(res, 404, {});
    o.status = 'APPROVED';
    o.payer = { email_address: body.email || 'sandbox-buyer@example.com', name: { given_name: 'Sandbox', surname: 'Buyer' } };
    if (body.captureStatus) o.captureStatus = body.captureStatus;
    return send(res, 200, orderView(o));
  }
  if (req.method === 'POST' && (m = p.match(/^\/__tamper\/([^/]+)$/))) {
    const o = orders.get(m[1]);
    if (!o) return send(res, 404, {});
    o.amount = body.amount;
    return send(res, 200, orderView(o));
  }
  if (req.method === 'GET' && (m = p.match(/^\/__order\/([^/]+)$/))) {
    const o = orders.get(m[1]);
    return o ? send(res, 200, { ...orderView(o), capture: o.capture }) : send(res, 404, {});
  }

  send(res, 404, { name: 'NOT_FOUND', path: p });
}).listen(PORT, () => console.log(`mock PayPal on http://localhost:${PORT}`));
