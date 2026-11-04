import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cacheSize, cached } from '../lib/cache.js';
import { ownerHashFromRequest, ownerHashFromToken } from '../lib/owner.js';
import { rateLimit, resetRateLimits } from '../lib/ratelimit.js';

test('rate limiter blocks over the limit and keys by client address', () => {
  resetRateLimits();
  const first = { headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }, socket: {} };
  const second = { headers: { 'x-forwarded-for': '198.51.100.7' }, socket: {} };

  assert.equal(rateLimit(first, 'verify', { limit: 2, windowSeconds: 60 }).allowed, true);
  const edge = rateLimit(first, 'verify', { limit: 2, windowSeconds: 60 });
  assert.equal(edge.allowed, true);
  assert.equal(edge.remaining, 0);
  const blocked = rateLimit(first, 'verify', { limit: 2, windowSeconds: 60 });
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfter >= 1);

  assert.equal(rateLimit(second, 'verify', { limit: 2, windowSeconds: 60 }).allowed, true);
  // A different route has its own bucket.
  assert.equal(rateLimit(first, 'monitor-create', { limit: 2, windowSeconds: 60 }).allowed, true);
});

test('owner tokens are hashed and malformed tokens are rejected', () => {
  const token = 'a'.repeat(32);
  const req = { headers: { 'x-tinyverify-owner': token } };
  const hash = ownerHashFromRequest(req);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(hash, ownerHashFromToken(token));
  assert.equal(ownerHashFromRequest({ headers: {} }), null);
  assert.equal(ownerHashFromRequest({ headers: { 'x-tinyverify-owner': 'not a token' } }), null);
  assert.equal(ownerHashFromRequest({ headers: { 'x-tinyverify-owner': token.slice(0, 16) } }), null);
});

test('cache never grows past its entry cap', async () => {
  for (let i = 0; i < 620; i++) {
    await cached(['security-test', i], 300, async () => ({ value: i }));
  }
  assert.ok(cacheSize() <= 500, `cache size ${cacheSize()} exceeds 500`);
  const fresh = await cached(['security-test', 'fresh'], 300, async () => ({ value: 'fresh' }));
  assert.equal(fresh.value, 'fresh');
});
