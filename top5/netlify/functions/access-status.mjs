import { checkRequest, magicLinkFor } from '../lib/access.mjs';
import { accessMode } from '../lib/config.mjs';
import { json } from '../lib/http.mjs';

// Used by /success: tells the buyer whether their pass works and gives them
// their personal magic link to bookmark.
export default async (req) => {
  const access = await checkRequest(req);
  const hasPurchase = access.ok || access.reason === 'pending' || access.reason === 'expired';
  return json({
    valid: access.ok,
    reason: access.ok ? 'ok' : access.reason,
    magicLink: hasPurchase ? magicLinkFor(access.token) : null,
    expiresAt: access.expiresAt || null,
    accessMode: accessMode(),
    purchasedAt: hasPurchase ? access.purchase.createdAt : null,
  });
};
