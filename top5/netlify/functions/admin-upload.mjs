import { guardAdmin } from '../lib/admin.mjs';
import { images } from '../lib/blobs.mjs';
import { fail, json } from '../lib/http.mjs';
import { randomId } from '../lib/tokens.mjs';

const MAX_BYTES = 2 * 1024 * 1024;
// Check real file signatures, not just the declared type. No SVG (it can carry scripts).
const SIGNATURES = {
  'image/png': (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46,
  'image/webp': (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45,
};

// POST raw image bytes with Content-Type set. Returns { id, url }.
export default async (req) => {
  const denied = guardAdmin(req);
  if (denied) return denied;
  if (req.method !== 'POST') return fail(405, 'Method not allowed');
  const type = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!SIGNATURES[type]) return fail(415, 'Use a PNG, JPEG, WebP or GIF image');
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (!bytes.length) return fail(400, 'Empty file');
  if (bytes.length > MAX_BYTES) return fail(413, 'Image must be 2 MB or smaller');
  if (!SIGNATURES[type](bytes)) return fail(415, 'The file does not look like the image type it claims to be');
  const id = randomId();
  await images().set(id, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { metadata: { contentType: type } });
  return json({ id, url: `/.netlify/functions/image?id=${id}` });
};
