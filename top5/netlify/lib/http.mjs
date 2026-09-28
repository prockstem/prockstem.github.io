import { siteUrl } from './config.mjs';

export function json(data, status = 200, extraHeaders = {}) {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex',
  });
  for (const [k, v] of Object.entries(extraHeaders)) {
    if (Array.isArray(v)) v.forEach((item) => headers.append(k, item));
    else headers.set(k, v);
  }
  return new Response(JSON.stringify(data), { status, headers });
}

export const fail = (status, error, extra = {}, headers = {}) => json({ error, ...extra }, status, headers);

export function getCookie(req, name) {
  const header = req.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

// Host-only cookie: no Domain attribute, so it is sent to top5.prockstem.com
// only, never to other prockstem.com subdomains.
export function setCookie(name, value, maxAgeSeconds) {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSeconds}; Secure; HttpOnly; SameSite=Lax`;
}

export function clearCookie(name) {
  return `${name}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
}

// Basic CSRF defence for state-changing requests: browsers always send
// Origin on cross-site POSTs, so reject any request whose Origin is foreign.
export function isSameOrigin(req) {
  if (req.headers.get('sec-fetch-site') === 'cross-site') return false;
  const origin = req.headers.get('origin');
  if (!origin) return true;
  const allowed = new Set([new URL(req.url).origin, new URL(siteUrl()).origin]);
  return allowed.has(origin);
}

export async function readJson(req, maxBytes = 50_000) {
  const text = await req.text();
  if (text.length > maxBytes) throw new Error('Request body too large');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON');
  }
}

export function clientIp(req, context) {
  return context?.ip || req.headers.get('x-nf-client-connection-ip') || req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}
