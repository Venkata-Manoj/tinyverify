import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cached } from '../lib/cache.js';
import { makeRecord } from '../lib/schema.js';
import { verify } from '../lib/verify.js';

const meta = (id) => ({
  id,
  name: `Registry ${id}`,
  source_name: `Registry ${id}`,
  source_url: 'https://registry.example/',
  types: ['business'],
  jurisdictions: ['UK'],
});

const query = { subject: 'Tesco PLC', licence_type: 'business', jurisdiction: 'UK' };

function record(subject = 'Tesco PLC') {
  return makeRecord({
    subject,
    licence_type: 'business',
    jurisdiction: 'UK',
    status: 'active',
    licence_number: '00445790',
    source_name: 'Fake UK Registry',
    source_url: 'https://registry.example/company/00445790',
    checked_at: '2026-11-17T00:00:00.000Z',
    match_quality: 'exact',
    matched_name: 'TESCO PLC',
    exists: true,
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const registry = (id, outcome, delayMs = 0) => ({
  meta: meta(id),
  lookup: async () => {
    if (delayMs) await sleep(delayMs);
    return outcome;
  },
});

test('registries run in parallel, so total latency is not the sum of every lookup', async () => {
  const started = Date.now();
  const result = await verify(query, {
    registries: [
      registry('one', { outcome: 'no_match' }, 180),
      registry('two', { outcome: 'no_match' }, 180),
      registry('three', { outcome: 'no_match' }, 180),
    ],
    registryBudgetMs: 2000,
  });
  const elapsed = Date.now() - started;
  assert.equal(result.match_quality, 'no_match');
  assert.ok(elapsed < 480, `expected parallel execution under 480ms, took ${elapsed}ms`);
  assert.equal(result.searched.length, 3);
});

test('a registry over its budget is a timeout row, never a no-match', async () => {
  const result = await verify(query, {
    registries: [
      registry('slow', { outcome: 'no_match' }, 500),
      registry('fast', { outcome: 'match', record: record() }),
    ],
    registryBudgetMs: 60,
  });

  const row = result.searched.find((entry) => entry.registry_id === 'slow');
  assert.equal(row.outcome, 'timeout');
  assert.match(row.detail, /not checked/i);
  assert.equal(result.incomplete, true);
  assert.equal(result.results.length, 1, 'the finished registry is still returned');
  assert.equal(result.results[0].registry_id, 'fast');
  assert.match(result.notes.join(' '), /not checked \(timed out/i);
  assert.doesNotMatch(result.notes.join(' '), /No registry returned a confident match/);
});

test('a timed-out registry never contributes a fabricated record', async () => {
  const result = await verify(query, {
    registries: [
      registry('slow', { outcome: 'match', record: record() }, 500),
      registry('fast', { outcome: 'no_match' }),
    ],
    registryBudgetMs: 40,
  });
  assert.equal(result.match_quality, 'no_match');
  assert.equal(result.results.length, 0);
  assert.equal(result.searched.find((row) => row.registry_id === 'slow').outcome, 'timeout');
  assert.equal(result.incomplete, true);
});

test('the shared cache returns cached true with an age, and ttl=0 bypasses it', async () => {
  const key = ['cache-test', `${process.pid}-${Date.now()}`];
  const first = await cached(key, 60, async () => ({ value: 41 }));
  assert.equal(first.cached, false);
  assert.equal(first.value, 41);

  const second = await cached(key, 60, async () => {
    throw new Error('the producer must not run on a cache hit');
  });
  assert.equal(second.cached, true);
  assert.equal(second.value, 41);
  assert.ok(second.cache_age_seconds >= 0);

  const bypass = await cached(key, 0, async () => ({ value: 42 }));
  assert.equal(bypass.cached, false);
  assert.equal(bypass.value, 42);
});
