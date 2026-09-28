import { accessTokenFor, isOrderId, magicLinkFor } from '../lib/access.mjs';
import { guardAdmin } from '../lib/admin.mjs';
import { fail, json, readJson } from '../lib/http.mjs';
import { getPurchase, listPurchases } from '../lib/purchases.mjs';

// GET: all purchases.  POST { orderId }: a fresh magic link for that buyer
// (for "I lost my link" emails).
export default async (req) => {
  const denied = guardAdmin(req);
  if (denied) return denied;

  if (req.method === 'GET') {
    const items = await listPurchases();
    const paid = items.filter((p) => p.status === 'COMPLETED' && !p.refunded);
    return json({
      purchases: items.map((p) => ({
        orderId: p.orderId,
        captureId: p.captureId || null,
        payerEmail: p.payerEmail || null,
        payerName: p.payerName || null,
        amount: p.amount || null,
        currency: p.currency || null,
        createdAt: p.createdAt,
        edition: p.edition,
        status: p.status || 'UNKNOWN',
        refunded: Boolean(p.refunded),
        refundedAt: p.refundedAt || null,
        sources: p.sources || [],
      })),
      totals: { count: paid.length, revenue: paid.reduce((sum, p) => sum + Number(p.amount || 0), 0).toFixed(2) },
    });
  }

  if (req.method === 'POST') {
    let body;
    try {
      body = await readJson(req, 1000);
    } catch (err) {
      return fail(400, err.message);
    }
    if (!isOrderId(body.orderId) || !(await getPurchase(body.orderId))) return fail(404, 'Purchase not found');
    return json({ magicLink: magicLinkFor(accessTokenFor(body.orderId)) });
  }
  return fail(405, 'Method not allowed');
};
