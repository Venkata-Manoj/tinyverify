import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cacheSize, cached } from '../lib/cache.js';
import { ownerHashFromRequest, ownerHashFromToken } from '../lib/owner.js';
import { rateLimit, resetRateLimits } from '../lib/ratelimit.js';

test('rate limiter blocks over the limit and keys by client address', async () => {
  resetRateLimits();
  const first = { headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }, socket: {} };
  const second = { headers: { 'x-forwarded-for': '198.51.100.7' }, socket: {} };

  assert.equal((await rateLimit(first, 'verify', { limit: 2, windowSeconds: 60 })).allowed, true);
  const edge = await rateLimit(first, 'verify', { limit: 2, windowSeconds: 60 });
  assert.equal(edge.allowed, true);
  assert.equal(edge.remaining, 0);
  const blocked = await rateLimit(first, 'verify', { limit: 2, windowSeconds: 60 });
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfter >= 1);

  assert.equal((await rateLimit(second, 'verify', { limit: 2, windowSeconds: 60 })).allowed, true);
  // A different route has its own bucket.
  assert.equal((await rateLimit(first, 'monitor-create', { limit: 2, windowSeconds: 60 })).allowed, true);
});

test('rate limiter uses the shared KV counter when configured', async () => {
  resetRateLimits();
  const { config } = await import('../lib/config.js');
  const original = { url: config.kvUrl, token: config.kvToken, fetch: globalThis.fetch };
  let calls = 0;
  config.kvUrl = 'https://kv.example';
  config.kvToken = 'test-token';
  globalThis.fetch = async (url, options) => {
    calls += 1;
    assert.match(String(url), /\/pipeline$/);
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    const body = JSON.parse(options.body);
    assert.equal(body[0][0], 'INCR');
    assert.equal(body[1][0], 'EXPIRE');
    return { ok: true, json: async () => [{ result: 2 }, { result: 1 }] };
  };
  try {
    const outcome = await rateLimit({ headers: { 'x-real-ip': '203.0.113.44' } }, 'verify', { limit: 2, windowSeconds: 60 });
    assert.equal(outcome.allowed, true);
    assert.equal(outcome.remaining, 0);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original.fetch;
    config.kvUrl = original.url;
    config.kvToken = original.token;
  }
});

test('a KV outage falls back to the in-memory limiter', async () => {
  resetRateLimits();
  const { config } = await import('../lib/config.js');
  const original = { url: config.kvUrl, token: config.kvToken, fetch: globalThis.fetch };
  config.kvUrl = 'https://kv.example';
  config.kvToken = 'test-token';
  globalThis.fetch = async () => { throw new Error('KV unreachable'); };
  try {
    const req = { headers: { 'x-real-ip': '203.0.113.45' } };
    assert.equal((await rateLimit(req, 'verify', { limit: 1, windowSeconds: 60 })).allowed, true);
    assert.equal((await rateLimit(req, 'verify', { limit: 1, windowSeconds: 60 })).allowed, false);
  } finally {
    globalThis.fetch = original.fetch;
    config.kvUrl = original.url;
    config.kvToken = original.token;
  }
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
