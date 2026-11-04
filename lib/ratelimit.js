/**
 * Best-effort, per-instance rate limiting.
 *
 * Vercel may run several instances, so this is a cost guard rather than a
 * security boundary. It stops a single client from hammering the paid TinyFish
 * endpoints or creating unlimited monitors from one warm instance.
 */

const buckets = new Map();
const MAX_KEYS = 10_000;

function clientIp(req) {
  const real = req?.headers?.['x-real-ip'];
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  // The right-most hop is the one added by the closest trusted proxy. Using
  // the left-most value lets a client spoof its way around the limiter.
  const candidate = String(real || forwarded.at(-1) || req?.socket?.remoteAddress || 'unknown').trim();
  return candidate.slice(0, 64) || 'unknown';
}

export function rateLimit(req, name, { limit, windowSeconds }) {
  const now = Date.now();
  const key = `${name}:${clientIp(req)}`;
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

/** Test helper. */
export function resetRateLimits() {
  buckets.clear();
}

export { clientIp };
