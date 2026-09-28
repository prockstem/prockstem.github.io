import { purchases } from '../lib/blobs.mjs';
import { clientIp, fail, isSameOrigin, json } from '../lib/http.mjs';
import { getLive } from '../lib/lists.mjs';
import { createOrder } from '../lib/paypal.mjs';
import { checkLimit, hit } from '../lib/ratelimit.mjs';

const LIMIT = { limit: 20, windowMs: 60 * 60 * 1000 };

// Creates the PayPal order server-side. Amount and currency are fixed in
// lib/config.mjs; nothing in the request body is used.
export default async (req, context) => {
  if (req.method !== 'POST') return fail(405, 'Method not allowed');
  if (!isSameOrigin(req)) return fail(403, 'Cross-site request blocked');
  const ip = clientIp(req, context);
  const limit = await checkLimit('order', ip, LIMIT);
  if (!limit.allowed) return fail(429, 'Too many attempts. Try again later.');
  await hit('order', ip, LIMIT);

  const live = await getLive();
  if (live.stores.length < 2) return fail(409, 'There is nothing to unlock right now.');

  let res;
  try {
    res = await createOrder({ edition: live.edition });
  } catch (err) {
    console.error('create order error', err);
    return fail(502, 'Could not reach PayPal. Please try again.');
  }
  if (!res.ok || !res.data?.id) {
    console.error('create order failed', res.status, JSON.stringify(res.data));
    return fail(502, 'PayPal could not create the order. Please try again.');
  }
  // Remember that we created this order; capture refuses anything else.
  await purchases().setJSON(`created-${res.data.id}`, { createdAt: new Date().toISOString(), edition: live.edition });
  return json({ id: res.data.id });
};
