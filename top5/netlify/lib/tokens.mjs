import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const sha256 = (s) => createHash('sha256').update(String(s)).digest();

function secret() {
  const s = process.env.ADMIN_SESSION_SECRET;
  if (!s || s.length < 32) throw new Error('ADMIN_SESSION_SECRET is missing or shorter than 32 characters');
  return s;
}

// One secret, separate derived keys per purpose, so an access token can never
// be replayed as an admin session and vice versa. The admin key also mixes in
// the password hash: changing ADMIN_PASSWORD logs out every admin session.
function keyFor(purpose) {
  const material = purpose === 'admin' ? `admin|${sha256(process.env.ADMIN_PASSWORD || '').toString('hex')}` : purpose;
  return createHmac('sha256', secret()).update(`top5:${material}`).digest();
}

export function sign(purpose, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', keyFor(purpose)).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verify(purpose, token) {
  if (typeof token !== 'string' || token.length > 1000) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = createHmac('sha256', keyFor(purpose)).update(body).digest();
  let given;
  try {
    given = Buffer.from(sig, 'base64url');
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// Constant-time comparison of two strings via their SHA-256 hashes.
export function hashedEqual(a, b) {
  return timingSafeEqual(sha256(a), sha256(b));
}

export const randomId = () => randomBytes(16).toString('hex');
export const hashIp = (ip) => sha256(ip).toString('hex').slice(0, 32);
