import { ADMIN_COOKIE } from './config.mjs';
import { fail, getCookie, isSameOrigin } from './http.mjs';
import { verify } from './tokens.mjs';

export function isAdmin(req) {
  if (!process.env.ADMIN_PASSWORD) return false;
  const payload = verify('admin', getCookie(req, ADMIN_COOKIE));
  return payload?.r === 'admin';
}

// Every admin endpoint starts with this. Returns a Response to send back when
// the request must be rejected, or null when it may continue.
export function guardAdmin(req) {
  if (!isAdmin(req)) return fail(401, 'Not signed in');
  if (req.method !== 'GET' && !isSameOrigin(req)) return fail(403, 'Cross-site request blocked');
  return null;
}
