import { getStore } from '@netlify/blobs';

// Store names used across the site:
//   lists      -> "draft", "live", "meta"
//   purchases  -> "order-<id>", "capture-<id>" (capture id -> order id), "created-<id>"
//   events     -> processed webhook event ids
//   ratelimit  -> login / order-creation counters
//   images     -> uploaded logos and screenshots
export const blobStore = (name) => getStore({ name, consistency: 'strong' });

export const lists = () => blobStore('lists');
export const purchases = () => blobStore('purchases');
export const events = () => blobStore('events');
export const rateLimits = () => blobStore('ratelimit');
export const images = () => blobStore('images');
