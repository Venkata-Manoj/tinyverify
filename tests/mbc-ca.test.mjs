import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMbcCa, normalizeDcaNumber, parseDcaProfile } from '../lib/registries/mbc-ca.js';
import { assertRecord, makeRecord } from '../lib/schema.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (name) => readFileSync(join(fixtures, name), 'utf8');

const PROFILE_URL = 'https://search.dca.ca.gov/profile/800/8002/93764/A';
const homePage = { final_url: 'https://search.dca.ca.gov/', text: 'DCA License Search' };

test('DCA profile parser reads status, expiry, name and the disciplinary section', () => {
  const parsed = parseDcaProfile(read('mbc-ca-detail.md'), { url: PROFILE_URL });
  assert.equal(parsed.exists, true);
  assert.equal(parsed.number, 'A 93764');
  assert.equal(parsed.name, 'YUN, DENNIS');
  assert.equal(parsed.licence_type, 'Physician and Surgeon A');
  assert.equal(parsed.status, 'active');
  assert.equal(parsed.status_detail, 'License Renewed & Current');
  assert.equal(parsed.issue_date, '2006-01-06');
  assert.equal(parsed.expiry_date, '2028-01-31');
  assert.equal(parsed.has_discipline, false);
  assert.equal(parsed.source_url, PROFILE_URL);
});

test('a public disciplinary entry is surfaced, not silently ignored', () => {
  const text = [
    '## Licensing details for: A 12345',
    'Name: DOE, JANE',
    'Primary Status: License Renewed & Current',
    'Administrative Disciplinary Actions',
    'Public Reprimand issued 2 January 2024',
    'Court Order  (No Records)',
  ].join('\n');
  const parsed = parseDcaProfile(text, { url: 'https://search.dca.ca.gov/profile/800/8002/12345/A' });
  assert.equal(parsed.has_discipline, true);
  assert.match(parsed.discipline, /Public Reprimand/);
});

test('a made-up licence number is a clean no_match, never a fabricated exact record', async () => {
  const registry = createMbcCa({ fetchPage: async () => homePage });
  const result = await registry.lookup({ subject: 'Made Up Person', number: 'A999999' });
  assert.equal(result.outcome, 'no_match');
  assert.equal(result.record, undefined);
  assert.equal(result.candidates.length, 0);
});

test('an unreadable DCA page is an error, not a no_match', async () => {
  const registry = createMbcCa({
    fetchPage: async () => ({ final_url: 'https://search.dca.ca.gov/profile/800/8002/999999/A', text: 'Service unavailable' }),
  });
  await assert.rejects(
    () => registry.lookup({ subject: 'Made Up Person', number: 'A999999' }),
    /could not be read/,
  );
});

test('a page for a different licence prefix is not returned as the requested record', async () => {
  const registry = createMbcCa({
    fetchPage: async () => ({ final_url: 'https://search.dca.ca.gov/profile/800/8002/100/A', text: [
      '## Licensing details for: G 100',
      'Name: ENGLEHORN, THEODORE D',
      'Primary Status: Licensee Deceased',
      'Expiration Date',
      'January 31, 2020',
    ].join('\n') }),
  });
  const result = await registry.lookup({ subject: 'Theodore Englehorn', number: 'A100' });
  assert.equal(result.outcome, 'no_match');
  assert.match(result.detail, /different licence/);
});

test('a licence number lookup returns the official record from the profile page', async () => {
  const registry = createMbcCa({
    fetchPage: async () => ({ final_url: PROFILE_URL, text: read('mbc-ca-detail.md') }),
  });
  const result = await registry.lookup({ subject: 'Dennis Yun', number: 'A93764' });
  assert.equal(result.outcome, 'match');
  const record = result.record;
  assert.equal(record.exists, true);
  assert.equal(record.matched_name, 'YUN, DENNIS');
  assert.equal(record.licence_number, 'A 93764');
  assert.equal(record.status, 'active');
  assert.equal(record.expiry_date, '2028-01-31');
  assert.equal(record.match_quality, 'exact');
});

test('a name search matches only after the profile page carries the name and number', async () => {
  const registry = createMbcCa({
    agentExtract: async () => ({ run_id: 'run-1', result: { found: true, matches: [{ name: 'YUN, DENNIS', licence_number: 'A93764' }] } }),
    fetchPage: async () => ({ final_url: PROFILE_URL, text: read('mbc-ca-detail.md') }),
  });
  const result = await registry.lookup({ subject: 'Dennis Yun' });
  assert.equal(result.outcome, 'match');
  assert.equal(result.record.matched_name, 'YUN, DENNIS');
  assert.equal(result.record.licence_number, 'A 93764');
  assert.equal(result.record.exists, true);
});

test('a name search whose profile page has no licensee name is an error, not a match', async () => {
  const registry = createMbcCa({
    agentExtract: async () => ({ run_id: 'run-2', result: { found: true, matches: [{ name: 'YUN, DENNIS', licence_number: 'A93764' }] } }),
    fetchPage: async () => ({ final_url: PROFILE_URL, text: 'Licensing details for: A 93764' }),
  });
  await assert.rejects(() => registry.lookup({ subject: 'Dennis Yun' }), /could not be read|none could be read/);
});

test('DCA licence numbers require a letter prefix', () => {
  assert.deepEqual(normalizeDcaNumber('a 93 764'), {
    number: 'A 93764',
    compact: 'A93764',
    prefix: 'A',
    digits: '93764',
    url: PROFILE_URL,
  });
  assert.equal(normalizeDcaNumber('93764'), null);
  assert.deepEqual(normalizeDcaNumber('A999999'), normalizeDcaNumber('a999999'));
});

test('the exact-match invariant is enforced in one place', () => {
  const base = {
    subject: 'Dennis Yun',
    licence_type: 'health',
    jurisdiction: 'US-CA',
    status: 'active',
    licence_number: 'A 93764',
    source_name: 'Medical Board of California',
    source_url: PROFILE_URL,
    checked_at: '2026-11-17T00:00:00.000Z',
    match_quality: 'exact',
  };
  const withoutName = makeRecord(base);
  assert.equal(withoutName.match_quality, 'close');
  assert.equal(withoutName.exists, false);

  const withName = makeRecord({ ...base, matched_name: 'YUN, DENNIS', exists: true });
  assert.equal(withName.match_quality, 'exact');
  assert.equal(withName.exists, true);

  assert.throws(() => assertRecord({ ...base, exists: true }), /exact match requires/);
});
