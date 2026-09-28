import { orderKey } from './access.mjs';
import { purchases } from './blobs.mjs';

// Purchase record (store "purchases", key "order-<orderId>"):
// { orderId, captureId, payerEmail, payerName, amount, currency, createdAt,
//   edition, status: 'COMPLETED' | 'PENDING', refunded, refundedAt, sources[] }

export const getPurchase = (orderId) => purchases().get(orderKey(orderId), { type: 'json' });

export async function upsertPurchase(orderId, fields, source) {
  const store = purchases();
  const existing = (await store.get(orderKey(orderId), { type: 'json' })) || {};
  const merged = { ...existing };
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null && v !== '') merged[k] = v;
  }
  merged.orderId = orderId;
  merged.createdAt = existing.createdAt || new Date().toISOString();
  merged.refunded = Boolean(existing.refunded || fields.refunded);
  // A refund is final: later "completed" notifications can't restore access.
  if (existing.refunded) merged.refundedAt = existing.refundedAt;
  // Never downgrade a completed payment back to pending.
  if (existing.status === 'COMPLETED') merged.status = 'COMPLETED';
  merged.sources = [...new Set([...(existing.sources || []), source])];
  await store.setJSON(orderKey(orderId), merged);
  if (merged.captureId) await store.setJSON(`capture-${merged.captureId}`, { orderId });
  return merged;
}

export async function orderIdForCapture(captureId) {
  const entry = await purchases().get(`capture-${captureId}`, { type: 'json' });
  return entry?.orderId || null;
}

export async function listPurchases() {
  const store = purchases();
  const { blobs } = await store.list({ prefix: 'order-' });
  const items = await Promise.all(blobs.map((b) => store.get(b.key, { type: 'json' })));
  return items.filter(Boolean).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}
