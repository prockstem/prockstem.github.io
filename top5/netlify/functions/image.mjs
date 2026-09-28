import { images } from '../lib/blobs.mjs';

// Serves an uploaded logo/screenshot. Ids are random 128-bit values that only
// appear in data the visitor is allowed to see.
export default async (req) => {
  const id = new URL(req.url).searchParams.get('id') || '';
  if (!/^[a-f0-9]{32}$/.test(id)) return new Response('Not found', { status: 404 });
  const entry = await images().getWithMetadata(id, { type: 'arrayBuffer' });
  if (!entry) return new Response('Not found', { status: 404 });
  return new Response(entry.data, {
    headers: {
      'content-type': entry.metadata?.contentType || 'application/octet-stream',
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'",
    },
  });
};
