import { events } from '../lib/blobs.mjs';
import { getMeta } from '../lib/lists.mjs';
import { getOrder, isExpectedAmount, verifyWebhookSignature } from '../lib/paypal.mjs';
import { getPurchase, orderIdForCapture, upsertPurchase } from '../lib/purchases.mjs';

// PayPal webhook: https://top5.prockstem.com/.netlify/functions/paypal-webhook
// Backup record of completed captures, and access revocation on refunds.
export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  let event;
  try {
    event = JSON.parse(await req.text());
  } catch {
    return new Response('Bad request', { status: 400 });
  }

  let verified = false;
  try {
    verified = await verifyWebhookSignature(req.headers, event);
  } catch (err) {
    console.error('webhook verification error', err);
    return new Response('Verification unavailable', { status: 500 }); // PayPal retries on non-2xx
  }
  if (!verified) return new Response('Invalid signature', { status: 400 });

  const seen = await events().get(`event-${event.id}`);
  if (seen) return new Response('Already processed', { status: 200 });

  const type = event.event_type;
  const resource = event.resource || {};
  try {
    if (type === 'PAYMENT.CAPTURE.COMPLETED') await captureCompleted(resource);
    else if (type === 'PAYMENT.CAPTURE.REFUNDED' || type === 'PAYMENT.CAPTURE.REVERSED') await captureRefunded(resource, type);
  } catch (err) {
    console.error('webhook handling error', type, err);
    return new Response('Error', { status: 500 });
  }

  await events().setJSON(`event-${event.id}`, { type, at: new Date().toISOString() });
  return new Response('OK', { status: 200 });
};

async function captureCompleted(capture) {
  const orderId = capture.supplementary_data?.related_ids?.order_id;
  if (!orderId || !isExpectedAmount(capture.amount)) {
    console.warn('ignoring capture', capture.id, 'order', orderId, 'amount', JSON.stringify(capture.amount));
    return;
  }
  const existing = await getPurchase(orderId);
  let payerEmail;
  let payerName;
  if (!existing?.payerEmail) {
    // The capture payload has no payer details; fetch them from the order.
    const order = await getOrder(orderId).catch(() => null);
    payerEmail = order?.data?.payer?.email_address;
    payerName = [order?.data?.payer?.name?.given_name, order?.data?.payer?.name?.surname].filter(Boolean).join(' ');
  }
  const meta = await getMeta();
  await upsertPurchase(
    orderId,
    {
      captureId: capture.id,
      payerEmail,
      payerName,
      amount: capture.amount.value,
      currency: capture.amount.currency_code,
      edition: existing?.edition || meta.edition,
      status: 'COMPLETED',
    },
    'webhook'
  );
}

async function captureRefunded(resource, type) {
  // For refunds the resource is the refund; its "up" link points at the capture.
  const up = (resource.links || []).find((l) => l.rel === 'up')?.href || '';
  const captureId = up.match(/\/captures\/([A-Z0-9]+)/)?.[1] || resource.id;
  const orderId =
    (captureId && (await orderIdForCapture(captureId))) || resource.supplementary_data?.related_ids?.order_id || null;
  if (!orderId) {
    console.warn('refund for unknown capture', captureId);
    return;
  }
  await upsertPurchase(orderId, { refunded: true, refundedAt: new Date().toISOString(), refundReason: type }, 'webhook');
}
