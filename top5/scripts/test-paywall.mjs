// End-to-end paywall tests against a running `netlify dev` that talks to
// scripts/mock-paypal.mjs. See README "Automated paywall test".
//
//   BASE=http://localhost:8888 PAYPAL_MOCK=http://localhost:9999 ADMIN_PASSWORD=... node scripts/test-paywall.mjs
//
// Uses a fresh local database: run it right after deleting .netlify/blobs-serve.

const BASE = process.env.BASE || 'http://localhost:8888';
const MOCK = process.env.PAYPAL_MOCK || 'http://localhost:9999';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const FN = `${BASE}/.netlify/functions`;

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? `  (${detail})` : ''}`);
  }
}

async function req(path, { method = 'GET', body, cookie, headers = {}, raw } = {}) {
  const res = await fetch(path.startsWith('http') ? path : `${FN}/${path}`, {
    method,
    redirect: 'manual',
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { status: res.status, headers: res.headers, text, data };
}

const cookieFrom = (res) => (res.headers.get('set-cookie') || '').split(';')[0];
const mock = (path, body) => fetch(`${MOCK}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());

function webhook(event, signature = 'valid-signature') {
  return req('paypal-webhook', {
    method: 'POST',
    body: event,
    headers: {
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-mock',
      'paypal-transmission-id': `t-${Math.random()}`,
      'paypal-transmission-sig': signature,
      'paypal-transmission-time': new Date().toISOString(),
    },
  });
}

async function buy() {
  const created = await req('paypal-create-order', { method: 'POST', body: { amount: '0.01', price: '0.01' } });
  await mock(`/__approve/${created.data.id}`);
  const captured = await req('paypal-capture-order', { method: 'POST', body: { orderID: created.data.id } });
  return { orderId: created.data.id, captured, cookie: cookieFrom(captured) };
}

console.log('\n1. Before payment: nothing locked reaches the browser');
const html = await req(`${BASE}/`);
const appJs = await req(`${BASE}/js/app.js`);
const pub = await req('stores-public');
check('public list loads', pub.status === 200 && pub.data.stores.length === 5);
const locked = pub.data.stores.filter((s) => s.locked);
check('4 stores are locked', locked.length === 4);
check('locked entries carry only position + category', locked.every((s) => Object.keys(s).sort().join() === 'category,locked,position'));
const free = pub.data.stores.find((s) => !s.locked);
check('free store is sent in full', free && free.name && free.listingUrl && free.multiple > 0);
const noAccess = await req('stores-full');
check('full list refused without access (401)', noAccess.status === 401);
const forged = await req('stores-full', { cookie: 't5_access=eyJvIjoiQUJDREVGR0gxMjMifQ.bm90LWEtcmVhbC1zaWduYXR1cmU' });
check('forged access cookie refused', forged.status === 401);

console.log('\n2. Unpaid, fake and tampered orders do not unlock anything');
const fake = await req('paypal-capture-order', { method: 'POST', body: { orderID: 'FAKEORDER12345' } });
check('made-up order id rejected', fake.status === 400 && !fake.headers.get('set-cookie'), `${fake.status} ${fake.text}`);
const bad = await req('paypal-capture-order', { method: 'POST', body: { orderID: '../../v1/x' } });
check('malformed order id rejected', bad.status === 400);

const direct = await fetch(`${MOCK}/v2/checkout/orders`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ intent: 'CAPTURE', purchase_units: [{ amount: { currency_code: 'USD', value: '0.01' } }] }),
}).then((r) => r.json());
await mock(`/__approve/${direct.id}`);
const directCap = await req('paypal-capture-order', { method: 'POST', body: { orderID: direct.id } });
check('order created outside the site (e.g. $0.01 via client-side SDK) rejected', directCap.status === 400 && !directCap.headers.get('set-cookie'), `${directCap.status}`);

const priced = await req('paypal-create-order', { method: 'POST', body: { amount: '0.01', value: '0.01', currency: 'EUR' } });
const orderOnPaypal = await fetch(`${MOCK}/__order/${priced.data.id}`).then((r) => r.json());
check('server sets 15.00 USD, ignoring any price sent by the browser', orderOnPaypal.purchase_units[0].amount.value === '15.00' && orderOnPaypal.purchase_units[0].amount.currency_code === 'USD');
const unapproved = await req('paypal-capture-order', { method: 'POST', body: { orderID: priced.data.id } });
check('order the buyer never approved rejected', unapproved.status === 402 && !unapproved.headers.get('set-cookie'), `${unapproved.status}`);

const tampered = await req('paypal-create-order', { method: 'POST', body: {} });
await mock(`/__tamper/${tampered.data.id}`, { amount: { currency_code: 'USD', value: '1.00' } });
await mock(`/__approve/${tampered.data.id}`);
const tamperedCap = await req('paypal-capture-order', { method: 'POST', body: { orderID: tampered.data.id } });
check('capture for the wrong amount rejected', tamperedCap.status === 402 && !tamperedCap.headers.get('set-cookie'), `${tamperedCap.status}`);

const eur = await req('paypal-create-order', { method: 'POST', body: {} });
await mock(`/__tamper/${eur.data.id}`, { amount: { currency_code: 'EUR', value: '15.00' } });
await mock(`/__approve/${eur.data.id}`);
const eurCap = await req('paypal-capture-order', { method: 'POST', body: { orderID: eur.data.id } });
check('capture in the wrong currency rejected', eurCap.status === 402 && !eurCap.headers.get('set-cookie'));

const pending = await req('paypal-create-order', { method: 'POST', body: {} });
await mock(`/__approve/${pending.data.id}`, { captureStatus: 'PENDING' });
const pendingCap = await req('paypal-capture-order', { method: 'POST', body: { orderID: pending.data.id } });
const pendingFull = await req('stores-full', { cookie: cookieFrom(pendingCap) });
check('PENDING capture recorded but does not unlock', pendingCap.status === 200 && pendingCap.data.status === 'PENDING' && pendingFull.status === 401);

const crossSite = await req('paypal-create-order', { method: 'POST', body: {}, headers: { origin: 'https://evil.example' } });
check('cross-site order creation blocked', crossSite.status === 403);

console.log('\n3. A real payment unlocks everything');
const purchase = await buy();
check('capture of approved 15.00 USD order succeeds', purchase.captured.status === 200 && purchase.captured.data.status === 'COMPLETED', purchase.captured.text);
const setCookie = purchase.captured.headers.get('set-cookie') || '';
check('access cookie is HttpOnly, Secure, SameSite=Lax, host-only', /HttpOnly/.test(setCookie) && /Secure/.test(setCookie) && /SameSite=Lax/.test(setCookie) && !/Domain=/i.test(setCookie), setCookie);
check('magic link uses SITE_URL', purchase.captured.data.magicLink?.startsWith(`${BASE}/access?t=`));
const full = await req('stores-full', { cookie: purchase.cookie });
check('full list returned with access', full.status === 200 && full.data.stores.every((s) => !s.locked && s.name));

const secrets = full.data.stores.filter((s) => !s.free).flatMap((s) => [s.name, s.whyPicked.slice(0, 40), String(s.askingPrice), String(s.monthlyRevenue)]);
const beforePayment = html.text + appJs.text + pub.text;
const leaked = secrets.filter((x) => beforePayment.includes(x));
check('none of the locked names, notes or numbers appeared before payment', leaked.length === 0, leaked.join(' | '));

const again = await req('paypal-capture-order', { method: 'POST', body: { orderID: purchase.orderId } });
check('re-running capture for the same order is idempotent', again.status === 200);

const [body, sig] = purchase.cookie.split('=')[1].split('.');
const otherOrder = Buffer.from(JSON.stringify({ o: tampered.data.id, iat: Date.now() })).toString('base64url');
const swapped = await req('stores-full', { cookie: `t5_access=${otherOrder}.${sig}` });
check('token with edited payload refused', swapped.status === 401);
const flipped = await req('stores-full', { cookie: `t5_access=${body}.${sig.slice(0, -2)}AA` });
check('token with edited signature refused', flipped.status === 401);

const token = decodeURIComponent(purchase.cookie.split('=')[1]);
const redeem = await req(`${BASE}/access?t=${encodeURIComponent(token)}`);
check('magic link sets cookie on a new device and redirects', redeem.status === 302 && /t5_access=/.test(redeem.headers.get('set-cookie') || '') && /access=ok/.test(redeem.headers.get('location')), `${redeem.status} ${redeem.headers.get('location')}`);
const redeemBad = await req(`${BASE}/access?t=nonsense.token`);
check('bad magic link sets no cookie', redeemBad.status === 302 && !redeemBad.headers.get('set-cookie') && /access=invalid/.test(redeemBad.headers.get('location')));
const status = await req('access-status', { cookie: purchase.cookie });
check('success page gets the magic link', status.data.valid && status.data.magicLink?.includes('/access?t='));

console.log('\n4. Webhook: signature check, backup record, refunds revoke access');
const orderData = await fetch(`${MOCK}/__order/${purchase.orderId}`).then((r) => r.json());
const captureId = orderData.capture.id;
const refundEvent = {
  id: `WH-${Date.now()}`,
  event_type: 'PAYMENT.CAPTURE.REFUNDED',
  resource: { id: 'REFUND1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '15.00' }, links: [{ rel: 'up', href: `https://api.sandbox.paypal.com/v2/payments/captures/${captureId}` }] },
};
const unsigned = await req('paypal-webhook', { method: 'POST', body: refundEvent });
check('webhook without PayPal signature headers rejected', unsigned.status === 400);
const badSig = await webhook(refundEvent, 'forged');
check('webhook with invalid signature rejected', badSig.status === 400);
const stillOk = await req('stores-full', { cookie: purchase.cookie });
check('access untouched by rejected webhooks', stillOk.status === 200);

// Backup record: a payment whose browser capture call never arrived.
const lost = await req('paypal-create-order', { method: 'POST', body: {} });
await mock(`/__approve/${lost.data.id}`, { email: 'lost-tab@example.com' });
const lostCapture = await fetch(`${MOCK}/v2/checkout/orders/${lost.data.id}/capture`, { method: 'POST' }).then((r) => r.json());
const completedEvent = {
  id: `WH-C-${Date.now()}`,
  event_type: 'PAYMENT.CAPTURE.COMPLETED',
  resource: { ...lostCapture.purchase_units[0].payments.captures[0], supplementary_data: { related_ids: { order_id: lost.data.id } } },
};
const completed = await webhook(completedEvent);
check('signed CAPTURE.COMPLETED accepted', completed.status === 200, completed.text);

const refunded = await webhook(refundEvent);
check('signed CAPTURE.REFUNDED accepted', refunded.status === 200, refunded.text);
const afterRefund = await req('stores-full', { cookie: purchase.cookie });
check('refund revokes access', afterRefund.status === 401 && afterRefund.data.reason === 'refunded');
const dup = await webhook(refundEvent);
check('duplicate webhook event ignored', dup.status === 200 && /Already/.test(dup.text));
const recapture = await req('paypal-capture-order', { method: 'POST', body: { orderID: purchase.orderId } });
check('refunded order cannot be re-captured for a new cookie', recapture.status === 402 && !recapture.headers.get('set-cookie'));

console.log('\n5. Admin');
for (const [fn, method] of [['admin-stores', 'GET'], ['admin-stores', 'PUT'], ['admin-publish', 'POST'], ['admin-purchases', 'GET'], ['admin-upload', 'POST']]) {
  const r = await req(fn, { method, body: method === 'GET' ? undefined : {} });
  check(`${method} ${fn} without session → 401`, r.status === 401, String(r.status));
}
const fakeAdmin = await req('admin-stores', { cookie: 't5_admin=eyJyIjoiYWRtaW4ifQ.c2lnbmF0dXJl' });
check('forged admin cookie refused', fakeAdmin.status === 401);
const reuse = await req('admin-stores', { cookie: `t5_admin=${purchase.cookie.split('=')[1]}` });
check('buyer access token cannot be used as admin session', reuse.status === 401);

if (!ADMIN_PASSWORD) {
  console.log('  (skipping signed-in admin tests: ADMIN_PASSWORD not set)');
} else {
  const login = await req('admin-session', { method: 'POST', body: { password: ADMIN_PASSWORD } });
  const admin = cookieFrom(login);
  check('admin login works', login.status === 200 && admin.startsWith('t5_admin='));
  check('admin cookie is HttpOnly + Secure + SameSite=Lax', /HttpOnly/.test(login.headers.get('set-cookie')) && /Secure/.test(login.headers.get('set-cookie')) && /SameSite=Lax/.test(login.headers.get('set-cookie')));
  const st = await req('admin-stores', { cookie: admin });
  check('admin can read the draft', st.status === 200 && st.data.draft.stores.length === 5);
  const reordered = { stores: [...st.data.draft.stores].reverse(), freeId: st.data.draft.stores[4].id };
  const put = await req('admin-stores', { method: 'PUT', body: reordered, cookie: admin });
  check('admin can reorder and change the free pick', put.status === 200 && put.data.unpublishedChanges === true);
  const invalid = await req('admin-stores', { method: 'PUT', body: { stores: [{ ...reordered.stores[0], listingUrl: 'javascript:alert(1)' }] }, cookie: admin });
  check('javascript: listing URLs rejected', invalid.status === 400);
  const csrf = await req('admin-publish', { method: 'POST', body: { newEdition: false }, cookie: admin, headers: { origin: 'https://evil.example' } });
  check('cross-site admin POST blocked', csrf.status === 403);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const up = await req('admin-upload', { method: 'POST', raw: png, headers: { 'content-type': 'image/png' }, cookie: admin });
  check('admin image upload works', up.status === 200 && /^[a-f0-9]{32}$/.test(up.data.id), up.text);
  const img = await fetch(`${BASE}${up.data.url}`);
  check('uploaded image is served', img.status === 200 && img.headers.get('content-type') === 'image/png');
  const fakeImg = await req('admin-upload', { method: 'POST', raw: '<svg onload=alert(1)>', headers: { 'content-type': 'image/png' }, cookie: admin });
  check('non-image upload rejected', fakeImg.status === 415);

  const buyer2 = await buy();
  const pubBefore = await req('stores-public');
  const publish = await req('admin-publish', { method: 'POST', body: { newEdition: true }, cookie: admin });
  check('publish creates a new edition', publish.status === 200 && publish.data.edition === pubBefore.data.edition + 1);
  const pubAfter = await req('stores-public');
  check('public page shows the new order and free pick', pubAfter.data.stores[0].name === reordered.stores[0].name && pubAfter.data.stores[0].free === true);
  check('"Last updated" was bumped', pubAfter.data.updatedAt > pubBefore.data.updatedAt);
  const grace = await req('stores-full', { cookie: buyer2.cookie });
  check('previous-edition buyer keeps access during the 30-day grace period', grace.status === 200 && grace.data.expiresAt);
  const purchasesList = await req('admin-purchases', { cookie: admin });
  const rows = purchasesList.data.purchases;
  check('purchases list shows payer, amount, order id and refund flag', rows.some((p) => p.orderId === purchase.orderId && p.refunded && p.payerEmail && p.amount === '15.00'));
  check('webhook-only purchase recorded as backup', rows.some((p) => p.orderId === lost.data.id && p.payerEmail === 'lost-tab@example.com' && p.sources.includes('webhook')));
  const link = await req('admin-purchases', { method: 'POST', body: { orderId: buyer2.orderId }, cookie: admin });
  check('admin can issue a new magic link', link.status === 200 && link.data.magicLink.includes('/access?t='));
  const logout = await req('admin-session', { method: 'DELETE', cookie: admin });
  check('logout clears the admin cookie', /t5_admin=;/.test(logout.headers.get('set-cookie')));

  // Rate limiting last, since it locks this IP out of logins for 15 minutes.
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await req('admin-session', { method: 'POST', body: { password: `wrong-${i}` } })).status);
  check('wrong passwords rejected, then rate-limited', codes.slice(0, 5).every((c) => c === 401) && codes[5] === 429, codes.join(','));
  const lockedOut = await req('admin-session', { method: 'POST', body: { password: ADMIN_PASSWORD } });
  check('even the right password waits out the lockout', lockedOut.status === 429);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
