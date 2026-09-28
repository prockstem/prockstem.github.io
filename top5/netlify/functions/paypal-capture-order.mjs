import { accessCookie, accessTokenFor, isOrderId, magicLinkFor } from '../lib/access.mjs';
import { purchases } from '../lib/blobs.mjs';
import { fail, isSameOrigin, json, readJson } from '../lib/http.mjs';
import { getMeta } from '../lib/lists.mjs';
import { captureOrder, evaluateOrder, getOrder } from '../lib/paypal.mjs';
import { getPurchase, upsertPurchase } from '../lib/purchases.mjs';

// Captures an approved order server-side and grants access only if PayPal
// reports a COMPLETED capture of exactly 15.00 USD.
export default async (req) => {
  if (req.method !== 'POST') return fail(405, 'Method not allowed');
  if (!isSameOrigin(req)) return fail(403, 'Cross-site request blocked');
  let body;
  try {
    body = await readJson(req, 2000);
  } catch (err) {
    return fail(400, err.message);
  }
  const orderId = body.orderID;
  if (!isOrderId(orderId)) return fail(400, 'Invalid order id');

  const created = await purchases().get(`created-${orderId}`, { type: 'json' });
  if (!created) return fail(400, 'Unknown order');

  let res;
  try {
    res = await captureOrder(orderId);
    if (!res.ok && res.data?.details?.[0]?.issue === 'ORDER_ALREADY_CAPTURED') res = await getOrder(orderId);
  } catch (err) {
    console.error('capture error', err);
    return fail(502, 'Could not reach PayPal to confirm the payment. Please try again in a moment.');
  }
  if (!res.ok) {
    const issue = res.data?.details?.[0]?.issue;
    if (issue === 'INSTRUMENT_DECLINED') return fail(402, 'Your payment method was declined. Please try another one.', { retry: true });
    console.error('capture failed', res.status, JSON.stringify(res.data));
    return fail(402, 'The payment could not be completed.');
  }

  const order = res.data;
  const result = evaluateOrder(order);
  if (result.state === 'invalid') {
    console.error('capture rejected', orderId, result.reason);
    return fail(402, 'The payment did not match this purchase and was not accepted.');
  }

  const existing = await getPurchase(orderId);
  if (existing?.refunded) return fail(402, 'This payment was refunded.');

  const meta = await getMeta();
  const purchase = await upsertPurchase(
    orderId,
    {
      captureId: result.capture.id,
      payerEmail: order.payer?.email_address,
      payerName: [order.payer?.name?.given_name, order.payer?.name?.surname].filter(Boolean).join(' '),
      amount: result.capture.amount.value,
      currency: result.capture.amount.currency_code,
      edition: existing?.edition || meta.edition,
      status: result.state === 'completed' ? 'COMPLETED' : 'PENDING',
    },
    'capture'
  );

  const token = accessTokenFor(orderId);
  return json(
    { ok: true, status: purchase.status, magicLink: magicLinkFor(token) },
    200,
    { 'set-cookie': accessCookie(token) }
  );
};
