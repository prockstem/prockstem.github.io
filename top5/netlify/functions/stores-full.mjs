import { checkRequest } from '../lib/access.mjs';
import { fail, json } from '../lib/http.mjs';
import { fullView, getLive } from '../lib/lists.mjs';

// Full data for all stores. Only for visitors holding a valid access cookie.
export default async (req) => {
  const access = await checkRequest(req);
  if (!access.ok) return fail(401, 'No valid access pass', { reason: access.reason });
  return json({ ...fullView(await getLive()), expiresAt: access.expiresAt });
};
