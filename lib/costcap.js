import { config } from './config.js';

/**
 * Daily global ceiling for paid TinyFish work (Agent runs and Monitor
 * creation). The per-IP and per-owner limits in ratelimit.js stop one client;
 * this cap protects the shared API key from a distributed spike.
 *
 * KV is authoritative when configured. If it is unavailable, the in-process
 * counter still applies on that lambda. The failure mode is deliberately
 * "less spend", never "unbounded spend".
 */

const counters = new Map();

const dayKey = () => new Date().toISOString().slice(0, 10);

function secondsUntilTomorrow() {
  const now = new Date();
  const tomorrow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((tomorrow - now.getTime()) / 1000));
}

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
  if (!res.ok) throw new Error(`KV cost cap failed: ${res.status}`);
  const data = await res.json();
  const count = Number(Array.isArray(data) ? data[0]?.result : NaN);
  if (!Number.isFinite(count)) throw new Error('KV cost cap returned no counter');
  return count;
}

function memoryIncrement(key) {
  const current = counters.get(key) || 0;
  const next = current + 1;
  counters.set(key, next);
  if (counters.size > 500) {
    const today = dayKey();
    for (const stored of counters.keys()) {
      if (!stored.endsWith(today)) counters.delete(stored);
    }
  }
  return next;
}

export function dailyCapFor(kind) {
  if (kind === 'agent') return config.agentDailyCap;
  if (kind === 'monitor') return config.monitorDailyCap;
  return 0;
}

/**
 * Count one unit of paid work and say whether it is inside today's cap.
 * A non-positive limit disables the cap (useful in tests).
 */
export async function consumeDailyCap(kind, { limit = dailyCapFor(kind) } = {}) {
  const retryAfter = secondsUntilTomorrow();
  if (!Number.isFinite(limit) || limit <= 0) {
    return { allowed: true, remaining: null, retryAfter, count: null, limit: null };
  }

  const key = `tinyverify:cap:${kind}:${dayKey()}`;
  let count;
  try {
    if (config.kvUrl && config.kvToken) count = await kvIncrement(key, retryAfter + 60);
  } catch {
    // KV outage: fall through to the in-process counter.
  }
  if (count === undefined) count = memoryIncrement(key);

  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    retryAfter,
    count,
    limit,
  };
}

export function resetDailyCaps() {
  counters.clear();
}
