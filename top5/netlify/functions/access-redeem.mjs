import { accessCookie, checkToken } from '../lib/access.mjs';
import { siteUrl } from '../lib/config.mjs';

// Magic link target (/access?t=...). Valid token -> set the access cookie on
// this device and send the visitor to the list.
export default async (req) => {
  const token = new URL(req.url).searchParams.get('t') || '';
  const result = await checkToken(token);
  const headers = new Headers({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex' });
  let state = result.ok ? 'ok' : result.reason;
  if (result.ok || state === 'pending' || state === 'expired') headers.append('set-cookie', accessCookie(token));
  else state = state === 'refunded' ? 'refunded' : 'invalid';
  headers.set('location', `${siteUrl()}/?access=${state}#list`);
  return new Response(null, { status: 302, headers });
};
