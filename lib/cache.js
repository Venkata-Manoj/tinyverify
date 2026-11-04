import { createHash } from 'node:crypto';
import { config } from './config.js';

/** Small in-process TTL cache. Keeps checked_at/source_url from the original live read. */
const memory = new Map();
const MAX_ENTRIES = 500;

const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 32);

export async function cached(keyParts, ttlSeconds, producer) {
  if (!ttlSeconds || ttlSeconds <= 0) return { ...(await producer()), cached: false, cache_age_seconds: 0 };
  const key = hash(JSON.stringify(keyParts));
  const now = Date.now();
  const hit = memory.get(key);
  if (hit && hit.expiresAt > now) {
    return { ...hit.value, cached: true, cache_age_seconds: Math.round((now - hit.storedAt) / 1000) };
  }
  const value = await producer();
  memory.set(key, { value, storedAt: now, expiresAt: now + ttlSeconds * 1000 });
  if (memory.size > MAX_ENTRIES) {
    for (const [k, entry] of memory) {
      if (entry.expiresAt <= now) memory.delete(k);
      if (memory.size <= MAX_ENTRIES) break;
    }
  }
  return { ...value, cached: false, cache_age_seconds: 0 };
}

export function clearCache() {
  memory.clear();
}

export function cacheStats() {
  return { entries: memory.size, ttl_seconds: config.cacheTtlSeconds };
}
