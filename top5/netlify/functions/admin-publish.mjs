import { guardAdmin } from '../lib/admin.mjs';
import { fail, json, readJson } from '../lib/http.mjs';
import { publish } from '../lib/lists.mjs';

// POST { newEdition: boolean }: copy the draft to the live list and bump
// "Last updated". With newEdition, buyers of the previous edition keep access
// for the grace period (ACCESS_GRACE_DAYS) and new buyers pay for this one.
export default async (req) => {
  const denied = guardAdmin(req);
  if (denied) return denied;
  if (req.method !== 'POST') return fail(405, 'Method not allowed');
  try {
    const body = await readJson(req, 1000);
    const live = await publish({ newEdition: body.newEdition === true });
    return json({ edition: live.edition, publishedAt: live.publishedAt, count: live.stores.length });
  } catch (err) {
    return fail(400, err.message);
  }
};
