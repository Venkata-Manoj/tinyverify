import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTmbTx, normalizeTmbNumber, parseTmbRow } from '../lib/registries/tmb-tx.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const readJson = (name) => JSON.parse(readFileSync(join(fixtures, name), 'utf8'));
const rows = readJson('tmb-license-l5138.json');

const response = (data) => ({ ok: true, status: 200, json: async () => data });

test('TMB parser reads a real licence row', () => {
  const parsed = parseTmbRow(rows[0]);
  assert.equal(parsed.exists, true);
  assert.equal(parsed.number, 'L5138');
  assert.equal(parsed.name, 'JOHN FLINT SMITH JR');
  assert.equal(parsed.status, 'active');
  assert.equal(parsed.issue_date, '2002-10-04');
  assert.equal(parsed.expiry_date, '2028-05-31');
  assert.equal(parsed.has_discipline, false);
  assert.equal(parsed.degree, 'MD');
  assert.equal(parsed.licence_type, 'Physician License');
});

test('a licence number returns the official TMB record with a stable source URL', async () => {
  const registry = createTmbTx({ fetchImpl: async () => response(rows) });
  const result = await registry.lookup({ subject: 'John Flint Smith', number: 'L5138' });
  assert.equal(result.outcome, 'match');
  assert.equal(result.record.registry_id, 'tmb-tx');
  assert.equal(result.record.licence_number, 'L5138');
  assert.equal(result.record.matched_name, 'JOHN FLINT SMITH JR');
  assert.equal(result.record.status, 'active');
  assert.equal(result.record.expiry_date, '2028-05-31');
  assert.match(result.record.source_url, /data\.texas\.gov\/resource\/tm3v-pfq9\.json\?license_number=L5138/);
});

test('a made-up TMB licence number is a clean no_match', async () => {
  const registry = createTmbTx({ fetchImpl: async () => response([]) });
  const result = await registry.lookup({ subject: 'Zqxjv Flarnbot', number: 'L999999' });
  assert.equal(result.outcome, 'no_match');
  assert.equal(result.candidates.length, 0);
});

test('a made-up TMB name is a clean no_match, not an error', async () => {
  const registry = createTmbTx({ fetchImpl: async () => response([]) });
  const result = await registry.lookup({ subject: 'Zqxjv Flarnbot' });
  assert.equal(result.outcome, 'no_match');
  assert.match(result.detail, /no record/);
});

test('several plausible TMB records become candidates, never an auto-selection', async () => {
  const second = { ...rows[0], license_number: 'L5139', first_name: 'JOHN', last_name: 'SMITH' };
  const registry = createTmbTx({ fetchImpl: async () => response([rows[0], second]) });
  const result = await registry.lookup({ subject: 'John Smith' });
  assert.equal(result.outcome, 'multiple');
  assert.equal(result.candidates.length, 2);
  assert.ok(result.candidates.every((candidate) => candidate.registry_id === 'tmb-tx'));
});

test('a TMB API failure is an error, not a no_match', async () => {
  const registry = createTmbTx({ fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
  await assert.rejects(() => registry.lookup({ subject: 'John Smith' }), /HTTP 503/);
});

test('TMB licence numbers are validated', () => {
  assert.equal(normalizeTmbNumber('l 5138'), 'L5138');
  assert.equal(normalizeTmbNumber('BP20100682'), 'BP20100682');
  assert.equal(normalizeTmbNumber('not a number'), null);
});
