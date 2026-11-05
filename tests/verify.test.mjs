import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRecord } from '../lib/schema.js';
import { verify } from '../lib/verify.js';

const meta = (id = 'fake-uk', name = 'Fake UK Registry') => ({
  id,
  name,
  source_name: name,
  source_url: 'https://registry.example/',
  types: ['business'],
  jurisdictions: ['UK'],
});

function record(overrides = {}) {
  return makeRecord({
    subject: 'Tesco PLC',
    licence_type: 'business',
    jurisdiction: 'UK',
    status: 'active',
    licence_number: '00445790',
    source_name: 'Fake UK Registry',
    source_url: 'https://registry.example/company/00445790',
    checked_at: '2026-11-05T12:00:00.000Z',
    match_quality: 'exact',
    registry_id: 'fake-uk',
    registry_name: 'Fake UK Registry',
    status_detail: 'Active',
    matched_name: 'TESCO PLC',
    ...overrides,
  });
}

function registry(outcome, id = 'fake-uk') {
  return { meta: meta(id), lookup: async () => outcome };
}

const query = { subject: 'Tesco PLC', licence_type: 'business', jurisdiction: 'UK' };

test('a nonsense query is no_match even when the registry returns a weak candidate', async () => {
  let calls = 0;
  const fake = {
    meta: meta(),
    lookup: async () => {
      calls += 1;
      return {
        outcome: 'no_match',
        source_url: 'https://registry.example/search?q=qwzxv',
        candidates: [{ name: 'STORE LOCATOR WIDGETS LTD', licence_number: '14279625', status: 'active' }],
        detail: '1 record, none matched the name',
      };
    },
  };
  const result = await verify({ subject: 'qwzxv plorb', licence_type: 'business', jurisdiction: 'UK' }, { registries: [fake] });
  assert.equal(calls, 1);
  assert.equal(result.match_quality, 'no_match');
  assert.equal(result.primary, null);
  assert.deepEqual(result.candidates, []);
  assert.equal(result.near_misses.length, 1);
  assert.equal(result.near_misses[0].name, 'STORE LOCATOR WIDGETS LTD');
});

test('a matching name and number returns an exact record with source and timestamp', async () => {
  const result = await verify(query, { registries: [registry({ outcome: 'match', record: record(), total_found: 1 })] });
  assert.equal(result.match_quality, 'exact');
  assert.equal(result.primary.licence_number, '00445790');
  assert.equal(result.primary.source_url, 'https://registry.example/company/00445790');
  assert.match(result.primary.checked_at, /^2026-11-05T/);
  assert.equal(result.primary.status_bounty, 'active');
});

test('a number that belongs to a different name is flagged as a mismatch', async () => {
  const result = await verify(
    { subject: 'Acme Widgets', licence_type: 'business', jurisdiction: 'UK', number: '00445790' },
    { registries: [registry({ outcome: 'match', record: record() })] },
  );
  assert.equal(result.match_quality, 'mismatch');
  assert.equal(result.name_number_mismatch, true);
  assert.equal(result.primary.name_number_mismatch, true);
  assert.equal(result.primary.match_quality, 'mismatch');
  assert.equal(result.name_number_check.matched, false);
  assert.match(result.primary.notes.join(' '), /does not match the official record/i);
  assert.ok(result.primary.confidence < 0.8);
});

test('a number-only lookup is exact even when the registry name differs from the alias', async () => {
  const numeric = record({ match_quality: 'close', subject: 'TESCO', matched_name: 'TESCO PLC' });
  const result = await verify(
    { number: '00445790', licence_type: 'business', jurisdiction: 'UK' },
    { registries: [registry({ outcome: 'match', record: numeric })] },
  );
  assert.equal(result.match_quality, 'exact');
  assert.equal(result.name_number_mismatch, false);
  assert.equal(result.primary.name_number_check, undefined);
});

test('special characters are rejected as no_match without calling a registry', async () => {
  let calls = 0;
  const fake = { meta: meta(), lookup: async () => { calls += 1; return { outcome: 'no_match' }; } };
  const result = await verify({ subject: '!!! ***', licence_type: 'business', jurisdiction: 'UK' }, { registries: [fake] });
  assert.equal(calls, 0);
  assert.equal(result.match_quality, 'no_match');
  assert.match(result.notes.join(' '), /no letters or digits/i);
});

test('total_found reports the largest single-registry count, never a sum', async () => {
  const first = registry({ outcome: 'match', record: record(), total_found: 187 }, 'fake-a');
  const second = registry({ outcome: 'match', record: record({ registry_id: 'fake-b', registry_name: 'Fake B' }), total_found: 40 }, 'fake-b');
  const result = await verify(query, { registries: [first, second] });
  assert.equal(result.total_found, 187);
  assert.equal(result.results.length, 2);
  assert.equal(result.conflict, false);
});

test('a missing registry count stays null instead of becoming zero', async () => {
  const result = await verify(query, { registries: [registry({ outcome: 'match', record: record() })] });
  assert.equal(result.total_found, null);
  assert.equal(result.total_capped, false);
  assert.equal(result.total_display, null);
  assert.equal(result.primary.total_found, null);
});

test('a capped page is reported as a lower bound, never as the full count', async () => {
  const fake = registry({
    outcome: 'multiple',
    source_url: 'https://registry.example/search',
    total_found: null,
    total_capped: true,
    total_capped_at: 200,
    total_display: '200+ (capped)',
    candidates: [{
      name: 'JOHN SMITH',
      licence_number: '1234567893',
      status: 'active',
      source_url: 'https://registry.example/provider/1234567893',
    }],
    detail: '200+ (capped) records matched',
  });
  const result = await verify({ subject: 'John Smith', licence_type: 'business', jurisdiction: 'UK' }, { registries: [fake] });
  assert.equal(result.total_found, null);
  assert.equal(result.total_capped, true);
  assert.equal(result.total_display, '200+ (capped)');
  assert.equal(result.searched[0].total_capped, true);
});

test('one name/number mismatch forces the overall quality to mismatch', async () => {
  const mismatched = record({
    registry_id: 'fake-a',
    registry_name: 'Fake A',
    matched_name: 'ACME WIDGETS LTD',
  });
  const exact = record({ registry_id: 'fake-b', registry_name: 'Fake B' });
  const result = await verify(
    { subject: 'Tesco PLC', licence_type: 'business', jurisdiction: 'UK', number: '00445790' },
    { registries: [registry({ outcome: 'match', record: mismatched }, 'fake-a'), registry({ outcome: 'match', record: exact }, 'fake-b')] },
  );
  assert.equal(result.name_number_mismatch, true);
  assert.equal(result.match_quality, 'mismatch');
});

test('several plausible candidates return multiple and never auto-select one', async () => {
  const fake = registry({
    outcome: 'multiple',
    source_url: 'https://registry.example/search',
    candidates: [
      { name: 'TESCO PLC', licence_number: '00445790', status: 'active' },
      { name: 'TESCO AQUA LIMITED', licence_number: '11223344', status: 'active' },
    ],
  });
  const result = await verify({ subject: 'Tesco', licence_type: 'business', jurisdiction: 'UK' }, { registries: [fake] });
  assert.equal(result.match_quality, 'multiple');
  assert.equal(result.primary, null);
  assert.equal(result.candidates.length, 2);
  assert.equal(result.results.length, 0);
});

test('disagreeing registries are returned side by side with an explicit conflict', async () => {
  const active = registry({ outcome: 'match', record: record() }, 'fake-a');
  const dissolved = registry({
    outcome: 'match',
    record: record({
      status: 'dissolved',
      status_detail: 'Dissolved',
      registry_id: 'fake-b',
      registry_name: 'Fake B',
      matched_name: 'TESCO PLC',
    }),
  }, 'fake-b');
  const result = await verify(query, { registries: [active, dissolved] });
  assert.equal(result.results.length, 2);
  assert.equal(result.conflict, true);
  assert.equal(result.primary, null);
  assert.equal(result.status, 'unknown');
  assert.match(result.notes.join(' '), /Registries disagree/i);
  assert.deepEqual(result.results.map((r) => r.status).sort(), ['active', 'dissolved']);
});

test('an unsupported combination still returns the required empty arrays', async () => {
  const result = await verify({ subject: 'A Person', licence_type: 'medical', jurisdiction: 'NZ' });
  assert.equal(result.match_quality, 'unsupported');
  assert.deepEqual(result.near_misses, []);
  assert.equal(result.primary, null);
});
