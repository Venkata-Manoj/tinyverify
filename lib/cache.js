import { createHash } from 'node:crypto';
import { config } from './config.js';
import { kvCommand } from './store.js';

/**
 * Shared TTL cache.
 *
 * Production writes every entry to Vercel KV / Upstash Redis so separate
 * function instances see the same answer; the in-process map is the local
 * fallback and the first-level read. Entries keep checked_at/source_url from
 * the original live read.
 */
const memory = new Map();
const MAX_ENTRIES = 500;
const KV_PREFIX = 'tinyverify:cache:v1:';

const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 40);
const kvEnabled = () => Boolean(config.kvUrl && config.kvToken);

async function readShared(key) {
  if (!kvEnabled()) return null;
  try {
    const raw = await kvCommand(['GET', key]);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    return entry && typeof entry === 'object' ? entry : null;
  } catch {
    // A cache outage must never fail a verification.
    return null;
  }
}

async function writeShared(key, entry, ttlSeconds) {
  if (!kvEnabled()) return;
  try {
    await kvCommand(['SET', key, JSON.stringify(entry), 'EX', Math.max(1, Math.ceil(ttlSeconds))]);
  } catch {
    // Degrade to the process-local copy.
  }
}

export async function cached(keyParts, ttlSeconds, producer) {
  if (!ttlSeconds || ttlSeconds <= 0) return { ...(await producer()), cached: false, cache_age_seconds: 0 };

  const key = `${KV_PREFIX}${hash(JSON.stringify(keyParts))}`;
  const now = Date.now();
  let hit = memory.get(key);
  if (!hit) {
    hit = await readShared(key);
    if (hit) memory.set(key, hit);
  }

  if (hit && Number(hit.expiresAt) > now) {
    // Refresh insertion order so eviction is least-recently-used.
    memory.delete(key);
    memory.set(key, hit);
    const age = Math.max(0, Math.round((now - Number(hit.storedAt || now)) / 1000));
    return typeof hit.value === 'object' && hit.value !== null
      ? { ...hit.value, cached: true, cache_age_seconds: age }
      : { value: hit.value, cached: true, cache_age_seconds: age };
  }
  if (hit) memory.delete(key);

  const value = await producer();
  const entry = { value, storedAt: now, expiresAt: now + ttlSeconds * 1000 };

  memory.set(key, entry);
  if (memory.size > MAX_ENTRIES) {
    for (const [k, item] of memory) {
      if (item.expiresAt <= now) memory.delete(k);
    }
    while (memory.size > MAX_ENTRIES) memory.delete(memory.keys().next().value);
  }
  await writeShared(key, entry, ttlSeconds);
  return { ...value, cached: false, cache_age_seconds: 0 };
}

/** Test helper. */
export function cacheSize() {
  return memory.size;
}
