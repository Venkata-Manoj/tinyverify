import { config } from './config.js';

/**
 * Per-client rate limiting for the paid endpoints.
 *
 * When Upstash Redis is configured the counter is shared by every server
 * instance, so a client cannot exceed the limit by landing on another lambda.
 * Without it (local dev, tests, KV outage) a per-instance in-memory window
 * still applies; that is a cost guard, not a security boundary.
 */

const buckets = new Map();
const MAX_KEYS = 10_000;

function clientIp(req) {
  const socketAddress = String(req?.socket?.remoteAddress || '').trim();
  // Proxy headers are attacker-controlled unless a trusted proxy sets them.
  // Vercel does; a self-hosted deployment must opt in with TRUST_PROXY=1.
  const trustedProxy = process.env.TRUST_PROXY === '1' || Boolean(process.env.VERCEL);
  if (!trustedProxy) return (socketAddress || 'unknown').slice(0, 64);
  const real = req?.headers?.['x-real-ip'];
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  // The right-most hop is the one added by the closest trusted proxy. Using
  // the left-most value lets a client spoof its way around the limiter.
  const candidate = String(real || forwarded.at(-1) || socketAddress || 'unknown').trim();
  return candidate.slice(0, 64) || 'unknown';
}

function memoryLimit(key, limit, windowSeconds) {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowSeconds * 1000 };
    buckets.set(key, bucket);
  }
  bucket.count += 1;

  if (buckets.size > MAX_KEYS) {
    for (const [k, value] of buckets) {
      if (value.resetAt <= now) buckets.delete(k);
    }
    while (buckets.size > MAX_KEYS) buckets.delete(buckets.keys().next().value);
  }

  return {
    allowed: bucket.count <= limit,
    remaining: Math.max(0, limit - bucket.count),
    retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
  };
}

/**
 * INCR is atomic, so concurrent requests cannot slip past the limit. The TTL
 * is refreshed on each hit: a client that keeps hammering stays blocked, and
 * the counter disappears once they stop.
 */
async function kvIncrement(key, ttlSeconds) {
  const res = await fetch(`${config.kvUrl.replace(/\/$/, '')}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.kvToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([['INCR', key], ['EXPIRE', key, ttlSeconds]]),
    signal: AbortSignal.timeout(800),
  });
  if (!res.ok) throw new Error(`KV rate limit failed: ${res.status}`);
  const data = await res.json();
  const count = Number(Array.isArray(data) ? data[0]?.result : NaN);
  if (!Number.isFinite(count)) throw new Error('KV rate limit returned no counter');
  return count;
}

export async function rateLimit(req, name, { limit, windowSeconds, ownerHash } = {}) {
  const now = Date.now();
  // A per-owner bucket stops one client from rotating IPs; the per-IP bucket
  // stops many tokens from hammering one host. Routes call both when an owner
  // token is present.
  const subject = ownerHash ? `owner:${ownerHash}` : `ip:${clientIp(req)}`;
  const key = `${name}:${subject}`;
  const windowNumber = Math.floor(now / (windowSeconds * 1000));

  if (config.kvUrl && config.kvToken) {
    try {
      const count = await kvIncrement(`tinyverify:rl:${key}:${windowNumber}`, windowSeconds + 5);
      const resetAt = (windowNumber + 1) * windowSeconds * 1000;
      return {
        allowed: count <= limit,
        remaining: Math.max(0, limit - count),
        retryAfter: Math.max(1, Math.ceil((resetAt - now) / 1000)),
      };
    } catch {
      // A KV outage must not take verification down; fall back to memory.
    }
  }

  return memoryLimit(key, limit, windowSeconds);
}

/** Test helper. */
export function resetRateLimits() {
  buckets.clear();
}

export { clientIp };
