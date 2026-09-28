import { purchases } from './blobs.mjs';
import { ACCESS_COOKIE, accessGraceDays, accessMode, siteUrl } from './config.mjs';
import { getCookie, setCookie } from './http.mjs';
import { getMeta } from './lists.mjs';
import { sign, verify } from './tokens.mjs';

const DAY = 24 * 60 * 60 * 1000;
// Browsers cap cookie lifetime at 400 days; real validity is checked server-side.
const COOKIE_MAX_AGE = 400 * 24 * 60 * 60;

export const orderKey = (orderId) => `order-${orderId}`;
export const isOrderId = (id) => typeof id === 'string' && /^[A-Z0-9]{8,40}$/.test(id);

// The token only names a purchase. Whether it still grants access is decided
// on every request from the purchase record, so refunds revoke immediately.
export const accessTokenFor = (orderId) => sign('access', { o: orderId, iat: Date.now() });
export const accessCookie = (token) => setCookie(ACCESS_COOKIE, token, COOKIE_MAX_AGE);
export const magicLinkFor = (token) => `${siteUrl()}/access?t=${encodeURIComponent(token)}`;

export async function checkToken(token) {
  const payload = verify('access', token);
  if (!payload || !isOrderId(payload.o)) return { ok: false, reason: 'invalid' };
  const purchase = await purchases().get(orderKey(payload.o), { type: 'json' });
  if (!purchase) return { ok: false, reason: 'invalid' };
  if (purchase.refunded) return { ok: false, reason: 'refunded', purchase };
  if (purchase.status !== 'COMPLETED') return { ok: false, reason: 'pending', purchase };
  if (accessMode() === 'forever') return { ok: true, purchase, expiresAt: null };

  const meta = await getMeta();
  if (purchase.edition >= meta.edition) return { ok: true, purchase, expiresAt: null };
  const superseded = meta.editions?.[purchase.edition]?.supersededAt;
  const expiresAt = superseded ? new Date(Date.parse(superseded) + accessGraceDays() * DAY) : null;
  if (expiresAt && Date.now() < expiresAt.getTime()) return { ok: true, purchase, expiresAt: expiresAt.toISOString() };
  return { ok: false, reason: 'expired', purchase };
}

export async function checkRequest(req) {
  const token = getCookie(req, ACCESS_COOKIE);
  if (!token) return { ok: false, reason: 'none' };
  return { ...(await checkToken(token)), token };
}
