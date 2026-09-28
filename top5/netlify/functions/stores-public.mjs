import { checkRequest } from '../lib/access.mjs';
import { CURRENCY, PRICE, accessMode, paypalEnv } from '../lib/config.mjs';
import { json } from '../lib/http.mjs';
import { getLive, publicView } from '../lib/lists.mjs';

// Public list: the free store in full, every other store as { position, category }.
export default async (req) => {
  const [live, access] = await Promise.all([getLive(), checkRequest(req)]);
  return json({
    ...publicView(live),
    unlocked: access.ok,
    accessState: access.ok ? 'ok' : access.reason,
    price: PRICE,
    currency: CURRENCY,
    accessMode: accessMode(),
    paypal: { clientId: process.env.PAYPAL_CLIENT_ID || null, env: paypalEnv() },
  });
};
