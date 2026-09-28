import { rateLimits } from './blobs.mjs';
import { hashIp } from './tokens.mjs';

// Fixed-window counter per (bucket, IP). Good enough for a single-admin site;
// not meant to stop a determined distributed attacker.
export async function checkLimit(bucket, ip, { limit, windowMs }) {
  const key = `${bucket}-${hashIp(ip)}`;
  const entry = await rateLimits().get(key, { type: 'json' });
  const now = Date.now();
  if (entry && entry.resetAt > now && entry.count >= limit) {
    return { allowed: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000), key };
  }
  return { allowed: true, key };
}

export async function hit(bucket, ip, { windowMs }) {
  const key = `${bucket}-${hashIp(ip)}`;
  const store = rateLimits();
  const entry = await store.get(key, { type: 'json' });
  const now = Date.now();
  const next = entry && entry.resetAt > now ? { count: entry.count + 1, resetAt: entry.resetAt } : { count: 1, resetAt: now + windowMs };
  await store.setJSON(key, next);
  return next;
}

export async function reset(bucket, ip) {
  await rateLimits().delete(`${bucket}-${hashIp(ip)}`);
}
