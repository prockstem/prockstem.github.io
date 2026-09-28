import { isAdmin } from '../lib/admin.mjs';
import { ADMIN_COOKIE, ADMIN_SESSION_HOURS } from '../lib/config.mjs';
import { clearCookie, clientIp, fail, isSameOrigin, json, readJson, setCookie } from '../lib/http.mjs';
import { checkLimit, hit, reset } from '../lib/ratelimit.mjs';
import { hashedEqual, sign } from '../lib/tokens.mjs';

const LIMIT = { limit: 5, windowMs: 15 * 60 * 1000 };

// GET: am I signed in?  POST { password }: sign in.  DELETE: sign out.
export default async (req, context) => {
  if (req.method === 'GET') return json({ signedIn: isAdmin(req) });
  if (!isSameOrigin(req)) return fail(403, 'Cross-site request blocked');
  if (req.method === 'DELETE') return json({ signedIn: false }, 200, { 'set-cookie': clearCookie(ADMIN_COOKIE) });
  if (req.method !== 'POST') return fail(405, 'Method not allowed');

  const expected = process.env.ADMIN_PASSWORD;
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!expected || !secret || secret.length < 32) return fail(500, 'Admin login is not configured (ADMIN_PASSWORD / ADMIN_SESSION_SECRET).');

  const ip = clientIp(req, context);
  const limit = await checkLimit('login', ip, LIMIT);
  if (!limit.allowed) {
    return fail(429, `Too many failed attempts. Try again in ${Math.ceil(limit.retryAfter / 60)} min.`, {}, { 'retry-after': String(limit.retryAfter) });
  }

  let body;
  try {
    body = await readJson(req, 2000);
  } catch (err) {
    return fail(400, err.message);
  }
  const password = typeof body.password === 'string' ? body.password : '';
  if (!password || !hashedEqual(password, expected)) {
    const count = await hit('login', ip, LIMIT);
    await new Promise((r) => setTimeout(r, 400));
    return fail(401, 'Wrong password', { attemptsLeft: Math.max(0, LIMIT.limit - count.count) });
  }

  await reset('login', ip);
  const token = sign('admin', { r: 'admin', exp: Date.now() + ADMIN_SESSION_HOURS * 3600 * 1000 });
  return json({ signedIn: true }, 200, { 'set-cookie': setCookie(ADMIN_COOKIE, token, ADMIN_SESSION_HOURS * 3600) });
};
