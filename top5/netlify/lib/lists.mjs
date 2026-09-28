import { lists } from './blobs.mjs';
import { MAX_STORES } from './config.mjs';
import { SEED_STORES } from './seed.mjs';

// Blob layout (store "lists"):
//   draft: { stores: Store[], freeId }             admin's working copy
//   live:  { stores, freeId, edition, publishedAt } what visitors see
//   meta:  { edition, editions: { [n]: { publishedAt, supersededAt } } }

export async function ensureSeeded() {
  const store = lists();
  let live = await store.get('live', { type: 'json' });
  if (live) return live;
  const now = new Date().toISOString();
  const stores = SEED_STORES.map((s) => ({ ...s }));
  live = { stores, freeId: stores[0].id, edition: 1, publishedAt: now };
  await store.setJSON('draft', { stores, freeId: stores[0].id });
  await store.setJSON('meta', { edition: 1, editions: { 1: { publishedAt: now, supersededAt: null } } });
  await store.setJSON('live', live);
  return live;
}

export const getLive = ensureSeeded;

export async function getDraft() {
  await ensureSeeded();
  return (await lists().get('draft', { type: 'json' })) || { stores: [], freeId: null };
}

export async function getMeta() {
  await ensureSeeded();
  return (await lists().get('meta', { type: 'json' })) || { edition: 1, editions: {} };
}

export async function saveDraft(draft) {
  await lists().setJSON('draft', draft);
}

export async function publish({ newEdition }) {
  const store = lists();
  const draft = await getDraft();
  if (!draft.stores.length) throw new Error('Add at least one store before publishing');
  const meta = await getMeta();
  const now = new Date().toISOString();
  if (newEdition) {
    const prev = meta.editions[meta.edition] || { publishedAt: now };
    meta.editions[meta.edition] = { ...prev, supersededAt: now };
    meta.edition += 1;
    meta.editions[meta.edition] = { publishedAt: now, supersededAt: null };
  }
  const live = { stores: draft.stores, freeId: resolveFreeId(draft), edition: meta.edition, publishedAt: now };
  await store.setJSON('meta', meta);
  await store.setJSON('live', live);
  return live;
}

export function resolveFreeId({ stores, freeId }) {
  return stores.some((s) => s.id === freeId) ? freeId : stores[0]?.id ?? null;
}

export function multiple(s) {
  const annual = s.monthlyProfit * 12;
  return annual > 0 ? Math.round((s.askingPrice / annual) * 10) / 10 : null;
}

function fullStore(s, position, free) {
  return {
    id: s.id,
    position,
    free,
    locked: false,
    name: s.name,
    category: s.category,
    platform: s.platform,
    monthlyRevenue: s.monthlyRevenue,
    monthlyProfit: s.monthlyProfit,
    askingPrice: s.askingPrice,
    multiple: multiple(s),
    storeAgeMonths: s.storeAgeMonths,
    monthlyTraffic: s.monthlyTraffic,
    whyPicked: s.whyPicked,
    listingUrl: s.listingUrl,
    listingSource: s.listingSource,
    imageUrl: s.imageId ? `/.netlify/functions/image?id=${s.imageId}` : null,
  };
}

// What anyone can see. Locked stores are reduced to position + category:
// no name, numbers, notes, link or image id ever leave the server.
export function publicView(live) {
  const freeId = resolveFreeId(live);
  return {
    edition: live.edition,
    updatedAt: live.publishedAt,
    count: live.stores.length,
    stores: live.stores.map((s, i) =>
      s.id === freeId ? fullStore(s, i + 1, true) : { position: i + 1, category: s.category, locked: true }
    ),
  };
}

export function fullView(live) {
  const freeId = resolveFreeId(live);
  return {
    edition: live.edition,
    updatedAt: live.publishedAt,
    count: live.stores.length,
    stores: live.stores.map((s, i) => fullStore(s, i + 1, s.id === freeId)),
  };
}

// ---- validation for admin input ----

const str = (v, field, max, { required = true } = {}) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && !s) throw new Error(`${field} is required`);
  if (s.length > max) throw new Error(`${field} must be ${max} characters or fewer`);
  return s;
};

const num = (v, field, { integer = false, max = 1e10 } = {}) => {
  const n = typeof v === 'string' ? Number(v.replace(/[$,\s]/g, '')) : Number(v);
  if (v === '' || v === null || v === undefined || !Number.isFinite(n)) throw new Error(`${field} must be a number`);
  if (n < 0 || n > max) throw new Error(`${field} is out of range`);
  return integer ? Math.round(n) : Math.round(n * 100) / 100;
};

export function cleanStore(input) {
  if (!input || typeof input !== 'object') throw new Error('Invalid store');
  const id = typeof input.id === 'string' && /^[a-z0-9]{8,40}$/.test(input.id) ? input.id : null;
  if (!id) throw new Error('Invalid store id');
  const listingUrl = str(input.listingUrl, 'Listing URL', 500);
  let url;
  try {
    url = new URL(listingUrl);
  } catch {
    throw new Error('Listing URL must be a full URL starting with https://');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Listing URL must start with http:// or https://');
  const imageId = input.imageId && /^[a-f0-9]{32}$/.test(input.imageId) ? input.imageId : null;
  return {
    id,
    name: str(input.name, 'Name', 80),
    category: str(input.category, 'Niche / category', 60),
    platform: str(input.platform, 'Platform', 40),
    monthlyRevenue: num(input.monthlyRevenue, 'Monthly revenue'),
    monthlyProfit: num(input.monthlyProfit, 'Monthly profit'),
    askingPrice: num(input.askingPrice, 'Asking price'),
    storeAgeMonths: num(input.storeAgeMonths, 'Store age (months)', { integer: true, max: 1200 }),
    monthlyTraffic: num(input.monthlyTraffic, 'Monthly traffic', { integer: true }),
    whyPicked: str(input.whyPicked, 'Why I picked it', 800),
    listingUrl: url.toString(),
    listingSource: str(input.listingSource, 'Listing source', 40, { required: false }),
    imageId,
  };
}

export function cleanDraft(input) {
  if (!input || !Array.isArray(input.stores)) throw new Error('Invalid draft');
  if (input.stores.length > MAX_STORES) throw new Error(`The list holds at most ${MAX_STORES} stores`);
  const stores = input.stores.map(cleanStore);
  if (new Set(stores.map((s) => s.id)).size !== stores.length) throw new Error('Duplicate store ids');
  return { stores, freeId: resolveFreeId({ stores, freeId: input.freeId }) };
}
