import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCompanyPage, parseSearchLinks } from '../lib/registries/companies-house.js';
import { parseCslbPage } from '../lib/registries/cslb.js';
import { parseNpiResult } from '../lib/registries/npi.js';
import { parseNzRecord, parseNzSearch } from '../lib/registries/nz-companies.js';
import { coverageMatrix, normalizeJurisdiction, normalizeType, resolveRegistries } from '../lib/registry.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (name) => readFileSync(join(fixtures, name), 'utf8');

test('Companies House parser reads a live overview page', () => {
  const parsed = parseCompanyPage(read('companies-house-tesco.md'), {
    url: 'https://find-and-update.company-information.service.gov.uk/company/00445790',
  });
  assert.equal(parsed.number, '00445790');
  assert.equal(parsed.name, 'TESCO PLC');
  assert.equal(parsed.status, 'active');
  assert.equal(parsed.status_detail, 'Active');
  assert.equal(parsed.fields.company_type, 'Public limited Company');
  assert.equal(parsed.fields.incorporated_on, '1947-11-27');
  assert.equal(parsed.fields.next_confirmation_statement_due, '2027-07-02');
  assert.equal(parsed.fields.sic[0].startsWith('47110'), true);
  assert.match(parsed.notes[0], /no expiry date/i);
});

test('Companies House parser rejects pages that are not a company record', () => {
  assert.equal(parseCompanyPage('Not found', { url: 'https://example.com' }), null);
});

test('Companies House search links are restricted to company records', () => {
  const numbers = parseSearchLinks([
    'https://find-and-update.company-information.service.gov.uk/company/00445790',
    'https://find-and-update.company-information.service.gov.uk/company/SC123456/',
    'https://find-and-update.company-information.service.gov.uk/search/companies?q=tesco',
    'https://evil.example/company/12345678',
  ]);
  assert.deepEqual(numbers, ['00445790', 'SC123456']);
});

test('CSLB parser reads a revoked contractor licence', () => {
  const parsed = parseCslbPage(read('cslb-738180.html'), { url: 'https://www.cslb.ca.gov/738180' });
  assert.equal(parsed.exists, true);
  assert.equal(parsed.name, 'DONE RIGHT DISCOUNT FLOORING');
  assert.equal(parsed.number, '738180');
  assert.equal(parsed.status, 'suspended');
  assert.equal(parsed.fields.issue_date, '1997-07-17');
  assert.equal(parsed.fields.expire_date, '2017-05-28');
  assert.equal(parsed.fields.complaint_disclosure, 'on file');
  assert.ok(parsed.fields.classifications.some((c) => c.includes('C15')));
  assert.match(parsed.disciplinary[0], /complaint disclosure/i);
});

test('CSLB parser reports a missing licence instead of inventing one', () => {
  const parsed = parseCslbPage('<html><body>License Number does not exist.</body></html>', { url: 'https://www.cslb.ca.gov/1000000' });
  assert.equal(parsed.exists, false);
  assert.equal(parsed.number, '1000000');
});

test('NPI parser reads an individual provider record', () => {
  const payload = JSON.parse(read('npi-0.json').replace(/\\_/g, '_'));
  const parsed = parseNpiResult(payload.results[0]);
  assert.equal(parsed.number, '1295346773');
  assert.equal(parsed.name, 'PLANISE JEAN LOUIS');
  assert.equal(parsed.status, 'active');
  assert.equal(parsed.fields.enumeration_type, 'Individual (NPI-1)');
  assert.equal(parsed.fields.primary_taxonomy, 'Nurse Practitioner, Family');
  assert.equal(parsed.fields.state_licence_number, 'APRN11008477');
  assert.equal(parsed.fields.state_licence_state, 'FL');
});

test('NPI parser reads an organisation record', () => {
  const payload = JSON.parse(read('npi-1.json').replace(/\\_/g, '_'));
  const parsed = parseNpiResult(payload.results[0]);
  assert.equal(parsed.name, 'MAYO CLINIC');
  assert.equal(parsed.fields.enumeration_type, 'Organisation (NPI-2)');
  assert.match(parsed.notes[0], /does not publish state licence status/i);
});

test('registry resolution accepts aliases and rejects unsupported pairs', () => {
  assert.deepEqual(resolveRegistries('company', 'United Kingdom').map((r) => r.meta.id), ['companies-house-uk']);
  assert.deepEqual(resolveRegistries('builder', 'California').map((r) => r.meta.id), ['cslb-ca']);
  assert.deepEqual(resolveRegistries('doctor', 'USA').map((r) => r.meta.id), ['npi-us']);
  assert.deepEqual(resolveRegistries('company', 'New Zealand').map((r) => r.meta.id), ['nz-companies']);
  assert.deepEqual(resolveRegistries('medical', 'NZ'), []);
  assert.equal(normalizeType('Healthcare'), 'health');
  assert.equal(normalizeJurisdiction('New Zealand'), 'NZ');
});

test('coverage matrix only lists combinations we can actually serve', () => {
  const matrix = coverageMatrix();
  assert.deepEqual(matrix.types.sort(), ['business', 'contractor', 'health']);
  assert.deepEqual(matrix.jurisdictions.sort(), ['NZ', 'UK', 'US', 'US-CA']);
  assert.equal(matrix.combinations.length, 4);
  for (const combo of matrix.combinations) assert.ok(combo.registries.length > 0);
});

test('NZ search parser reads company numbers, names and statuses', () => {
  const results = parseNzSearch(read('nz-search.html'));
  assert.ok(results.length >= 10);
  const anz = results.find((r) => r.number === '104799');
  assert.equal(anz.name, 'AIR NEW ZEALAND LIMITED');
  assert.equal(anz.status, 'Registered');
  assert.equal(anz.entity_type, 'NZ Limited Company');
  assert.equal(anz.nzbn, '9429040402543');
  assert.equal(anz.source_url, 'https://app.companiesoffice.govt.nz/co/104799');

  const removed = results.find((r) => r.number === '116030');
  assert.equal(removed.name, 'AIR NEW ZEALAND HOLIDAYS LIMITED');
  assert.equal(removed.status, 'Removed');
  assert.equal(new Set(results.map((r) => r.number)).size, results.length);
});

test('NZ record parser reads the official company summary', () => {
  const parsed = parseNzRecord(read('nz-record.html'), { url: 'https://app.companiesoffice.govt.nz/co/104799' });
  assert.equal(parsed.name, 'AIR NEW ZEALAND LIMITED');
  assert.equal(parsed.number, '104799');
  assert.equal(parsed.status, 'active');
  assert.equal(parsed.status_detail, 'Registered');
  assert.equal(parsed.fields.nzbn, '9429040402543');
  assert.equal(parsed.fields.entity_type, 'NZ Limited Company');
  assert.equal(parsed.fields.incorporated_on, '1940-04-26');
  assert.match(parsed.fields.registered_office, /185 Fanshawe Street/);
  assert.equal(parsed.fields.registered_office.includes('\n'), false);
  assert.equal(parsed.fields.annual_return_last_filed, '2026-03-11');
  assert.deepEqual(parsed.fields.previous_names, ['TASMAN EMPIRE AIRWAYS LIMITED (from 26 Apr 1940 to 01 Apr 1965)']);
  assert.equal(parseNzRecord('not a record'), null);
});
