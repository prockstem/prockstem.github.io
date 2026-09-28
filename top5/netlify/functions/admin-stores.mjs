import { guardAdmin } from '../lib/admin.mjs';
import { fail, json, readJson } from '../lib/http.mjs';
import { cleanDraft, getDraft, getLive, resolveFreeId, saveDraft } from '../lib/lists.mjs';

// GET: draft + live status.  PUT { stores, freeId }: replace the draft.
// Add / edit / delete / reorder / free-pick changes are all saved as a whole draft.
export default async (req) => {
  const denied = guardAdmin(req);
  if (denied) return denied;

  if (req.method === 'PUT') {
    let draft;
    try {
      draft = cleanDraft(await readJson(req, 200_000));
    } catch (err) {
      return fail(400, err.message);
    }
    await saveDraft(draft);
    return json(await state());
  }
  if (req.method === 'GET') return json(await state());
  return fail(405, 'Method not allowed');
};

async function state() {
  const [draft, live] = await Promise.all([getDraft(), getLive()]);
  const snapshot = (l) => JSON.stringify({ stores: l.stores, freeId: resolveFreeId(l) });
  return {
    draft: { ...draft, freeId: resolveFreeId(draft) },
    live: { edition: live.edition, publishedAt: live.publishedAt, count: live.stores.length },
    unpublishedChanges: snapshot(draft) !== snapshot(live),
  };
}
