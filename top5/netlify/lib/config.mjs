// Central settings. Everything that differs between local, sandbox and live
// comes from environment variables (see README).

// The price is fixed here and only here. It never comes from the browser.
export const PRICE = '15.00';
export const CURRENCY = 'USD';

export const ACCESS_COOKIE = 't5_access';
export const ADMIN_COOKIE = 't5_admin';
export const ADMIN_SESSION_HOURS = 12;

export const MAX_STORES = 5;

export function siteUrl() {
  return (process.env.SITE_URL || 'http://localhost:8888').replace(/\/+$/, '');
}

// ACCESS_MODE=edition (default): access covers the edition that was live when
// the buyer paid, plus ACCESS_GRACE_DAYS (default 30) after that edition is
// replaced by a newer one. ACCESS_MODE=forever: access never expires.
export function accessMode() {
  return (process.env.ACCESS_MODE || 'edition').toLowerCase() === 'forever' ? 'forever' : 'edition';
}

export function accessGraceDays() {
  const n = Number(process.env.ACCESS_GRACE_DAYS ?? 30);
  return Number.isFinite(n) && n >= 0 ? n : 30;
}

export function paypalEnv() {
  const e = (process.env.PAYPAL_ENV || 'sandbox').toLowerCase();
  return ['live', 'sandbox', 'mock'].includes(e) ? e : 'sandbox';
}
