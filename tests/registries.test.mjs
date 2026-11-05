import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCompanyPage, parseSearchLinks, normalizeCompanyNumber } from '../lib/registries/companies-house.js';
import { nameSimilarity, normalizeName } from '../lib/normalize.js';
import { parseComplaintDisclosure, parseCslbPage, readCslbPages } from '../lib/registries/cslb.js';
import { parseNpiResult } from '../lib/registries/npi.js';
import { parseNzRecord, parseNzSearch } from '../lib/registries/nz-companies.js';
import { isValidAbn, parseAbnPage, parseAbnSearch } from '../lib/registries/abn-au.js';
import { parseDirectLicenseUrl, parseEnforcementActions, parseMqaPage, parseMqaSearch, splitMqaName } from '../lib/registries/mqa-fl.js';
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
    'https://find-and-update.company-information.service.gov.uk/company/BRADFORD',
    'https://find-and-update.company-information.service.gov.uk/search/companies?q=tesco',
    'https://evil.example/company/12345678',
  ]);
  assert.deepEqual(numbers, ['00445790', 'SC123456']);
});

test('Companies House parser keeps a parenthesised place name out of the number', () => {
  const parsed = parseCompanyPage(read('companies-house-ms-bradford.md'), {
    url: 'https://find-and-update.company-information.service.gov.uk/company/10011863',
    title: 'MARKS AND SPENCER (BRADFORD) LIMITED overview - Find and update company information - GOV.UK',
  });
  assert.equal(parsed.number, '10011863');
  assert.equal(parsed.name, 'MARKS AND SPENCER (BRADFORD) LIMITED');
  assert.equal(parsed.status, 'active');
});

test('Companies House parser reads a dotted P.L.C. legal name', () => {
  const parsed = parseCompanyPage(read('companies-house-ms-group.md'), {
    url: 'https://find-and-update.company-information.service.gov.uk/company/04256886',
    title: 'MARKS AND SPENCER GROUP P.L.C. overview - Find and update company information - GOV.UK',
  });
  assert.equal(parsed.number, '04256886');
  assert.equal(parsed.name, 'MARKS AND SPENCER GROUP P.L.C.');
  assert.equal(parsed.status, 'active');
  assert.equal(parsed.fields.company_type, 'Public limited Company');
});

test('company numbers are validated and zero-padded, never guessed from a place name', () => {
  assert.equal(normalizeCompanyNumber('00445790'), '00445790');
  assert.equal(normalizeCompanyNumber('445790'), '00445790');
  assert.equal(normalizeCompanyNumber('SC123456'), 'SC123456');
  assert.equal(normalizeCompanyNumber('SC 123 456'), 'SC123456');
  assert.equal(normalizeCompanyNumber('BRADFORD'), null);
  assert.equal(normalizeCompanyNumber('1234567'), '01234567');
  assert.equal(normalizeCompanyNumber('123456789'), null);
});

test('name comparison folds ampersands and dotted legal suffixes', () => {
  assert.equal(normalizeName('Marks & Spencer Group P.L.C.'), 'marks and spencer group public limited company');
  assert.equal(nameSimilarity('Marks and Spencer Group', 'MARKS AND SPENCER GROUP P.L.C.'), 0.99);
  assert.equal(nameSimilarity('Marks & Spencer', 'MARKS AND SPENCER P.L.C.'), 0.99);
});

test('CSLB parser reads a revoked contractor licence', () => {
  const parsed = parseCslbPage(read('cslb-738180.html'), { url: 'https://www.cslb.ca.gov/738180' });
  assert.equal(parsed.exists, true);
  assert.equal(parsed.name, 'DONE RIGHT DISCOUNT FLOORING');
  assert.equal(parsed.number, '738180');
  assert.equal(parsed.status, 'revoked');
  assert.equal(parsed.fields.issue_date, '1997-07-17');
  assert.equal(parsed.fields.expire_date, '2017-05-28');
  assert.equal(parsed.fields.complaint_disclosure, 'on file');
  assert.ok(parsed.fields.classifications.some((c) => c.includes('C15')));
  assert.match(parsed.notes.join(' '), /complaint disclosure/i);
});

test('CSLB complaint disclosure parser reads a real arbitration record', () => {
  const parsed = parseComplaintDisclosure(read('cslb-complaint.html'), { number: '738180' });
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].type, 'arbitration');
  assert.equal(parsed.records[0].arbitration_number, 'A S 2016 000293');
  assert.equal(parsed.records[0].date, '2017-05-28');
  assert.equal(parsed.records[0].status, 'NON-COMPLIANCE - LICENSE REVOKED PER 7085.6');
  assert.match(parsed.actions[0], /2017-05-28/);
});

test('CSLB parser reports a missing licence instead of inventing one', () => {
  const parsed = parseCslbPage('<html><body>License Number does not exist.</body></html>', { url: 'https://www.cslb.ca.gov/1000000' });
  assert.equal(parsed.exists, false);
  assert.equal(parsed.number, '1000000');
});

test('NPI parser reads an individual provider record', () => {
  const payload = JSON.parse(read('npi-0.json').replace(/\\_/g, '_'));
  const parsed = parseNpiResult(payload.results[0]);
  assert.equal(parsed.number, '1234567893');
  assert.equal(parsed.name, 'JORDAN AVERY SAMPLE');
  assert.equal(parsed.status, 'active');
  assert.equal(parsed.fields.enumeration_type, 'Individual (NPI-1)');
  assert.equal(parsed.fields.primary_taxonomy, 'Nurse Practitioner, Family');
  assert.equal(parsed.fields.state_licence_number, 'APRN00000000');
  assert.equal(parsed.fields.state_licence_state, 'FL');
  assert.equal(parsed.fields.location_city, 'SAMPLE CITY');
  assert.equal(parsed.fields.location_state, 'FL');
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
  assert.deepEqual(resolveRegistries('business', 'Australia').map((r) => r.meta.id), ['abn-au']);
  assert.deepEqual(resolveRegistries('health', 'US-FL').map((r) => r.meta.id), ['npi-us', 'mqa-fl']);
  assert.deepEqual(resolveRegistries('health', 'USA', { state: 'FL' }).map((r) => r.meta.id), ['npi-us', 'mqa-fl']);
  assert.deepEqual(resolveRegistries('health', 'USA').map((r) => r.meta.id), ['npi-us']);
  assert.deepEqual(resolveRegistries('medical', 'NZ'), []);
  assert.equal(normalizeType('Healthcare'), 'health');
  assert.equal(normalizeJurisdiction('New Zealand'), 'NZ');
});

test('coverage matrix only lists combinations we can actually serve', () => {
  const matrix = coverageMatrix();
  assert.deepEqual(matrix.types.sort(), ['business', 'contractor', 'health']);
  assert.deepEqual(matrix.jurisdictions.sort(), ['AU', 'NZ', 'UK', 'US', 'US-CA', 'US-FL', 'US-TX']);
  assert.deepEqual(
    matrix.combinations.map((c) => `${c.licence_type}/${c.jurisdiction}`).sort(),
    ['business/AU', 'business/NZ', 'business/UK', 'contractor/US-CA', 'health/US', 'health/US-FL', 'health/US-TX'],
  );
  for (const combo of matrix.combinations) assert.ok(combo.registries.length > 0);
});

test('ABN parser reads the official search results and detail page', () => {
  const { total, results } = parseAbnSearch(read('abn-search.html'));
  assert.equal(total, 146);
  assert.ok(results.length >= 20);
  const telstra = results.find((row) => row.abn === '33051775556');
  assert.equal(telstra.name, 'TELSTRA');
  assert.equal(telstra.status, 'active');
  assert.equal(telstra.source_url, 'https://abr.business.gov.au/ABN/View?id=33051775556');

  const detail = parseAbnPage(read('abn-detail.html'), { url: 'https://abr.business.gov.au/ABN/View?id=33051775556' });
  assert.equal(detail.number, '33051775556');
  assert.equal(detail.name, 'TELSTRA CORPORATION LIMITED');
  assert.equal(detail.status, 'active');
  assert.equal(detail.status_detail, 'Active from 01 Nov 1999');
  assert.equal(detail.fields.abn, '33 051 775 556');
  assert.equal(detail.fields.entity_type, 'Australian Public Company');
  assert.equal(detail.fields.abn_last_updated, '2024-02-15');
  assert.ok(detail.fields.business_names.includes('TELSTRA INFRACO'));
  assert.ok(detail.fields.trading_names.includes('TELSTRA'));
  assert.equal(parseAbnPage('<html>No record found</html>', {}), null);
});

test('ABN checksum rejects transposed or invented numbers', () => {
  assert.equal(isValidAbn('33 051 775 556'), true);
  assert.equal(isValidAbn('33051775557'), false);
  assert.equal(isValidAbn('12345678901'), false);
  assert.equal(isValidAbn('123'), false);
});

test('ABN all-results search includes cancelled ABNs, not only active ones', () => {
  const { total, results } = parseAbnSearch(read('abn-search-all.html'));
  assert.equal(total, 155);
  const cancelled = results.find((row) => row.abn === '97342304522');
  assert.equal(cancelled.name, 'THE WOOLWORTHS');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.raw_status, 'Cancelled');
  const woolworths = results.find((row) => row.abn === '88000014675');
  assert.equal(woolworths.status, 'active');
});

test('ABN detail page reports a cancellation date and native status', () => {
  const parsed = parseAbnPage(read('abn-detail-cancelled.html'), {
    url: 'https://abr.business.gov.au/ABN/View?id=97342304522',
  });
  assert.equal(parsed.number, '97342304522');
  assert.equal(parsed.name, 'THE WOOLWORTHS');
  assert.equal(parsed.status, 'cancelled');
  assert.equal(parsed.status_detail, 'Cancelled from 14 Oct 2016');
  assert.equal(parsed.fields.cancellation_date, '2016-10-14');
});

test('Florida MQA parsers read the search table and a physician detail page', () => {
  const { total, results } = parseMqaSearch(read('mqa-search.html'));
  assert.equal(total, 7);
  assert.equal(results.length, 7);
  const smith = results.find((row) => row.number === 'ME182088');
  assert.equal(smith.name, 'Smith, John Horatio');
  assert.equal(smith.profession, 'Medical Doctor');
  assert.equal(smith.status, 'active');
  assert.equal(smith.raw_status, 'Clear/Active');

  const detail = parseMqaPage(read('mqa-detail.html'), {
    url: 'https://mqa-internet.doh.state.fl.us/MQASearchServices/HealthCareProviders/LicenseVerification?LicInd=182095&ProCde=1501',
  });
  assert.equal(detail.number, 'ME182088');
  assert.equal(detail.name, 'JOHN HORATIO SMITH II');
  assert.equal(detail.status, 'active');
  assert.equal(detail.status_detail, 'Clear/Active');
  assert.equal(detail.expiry_date, '2028-01-31');
  assert.equal(detail.issue_date, '2026-06-01');
  assert.equal(detail.has_discipline, false);
  assert.equal(detail.fields.profession, 'Medical Doctor');
  assert.equal(detail.fields.discipline_on_file, 'no');
});

test('Florida MQA number search follows the exact-hit redirect', () => {
  assert.equal(
    parseDirectLicenseUrl('/MQASearchServices/HealthcareProviders/LicenseVerification?LicInd=182095&Procde=1501'),
    'https://mqa-internet.doh.state.fl.us/MQASearchServices/HealthCareProviders/LicenseVerification?LicInd=182095&ProCde=1501',
  );
  assert.equal(parseDirectLicenseUrl('https://example.com/other?LicInd=1&ProCde=2'), null);
  assert.equal(parseDirectLicenseUrl('/LicenseVerification?LicInd=182095'), null);
  assert.equal(parseDirectLicenseUrl(null), null);
});

test('MQA names keep generational suffixes out of the surname field', () => {
  assert.deepEqual(splitMqaName('John Horatio Smith II'), { last: 'Smith', first: 'John Horatio' });
  assert.deepEqual(splitMqaName('Smith, John Horatio II'), { last: 'Smith', first: 'John Horatio' });
  assert.deepEqual(splitMqaName('John Smith Jr.'), { last: 'Smith', first: 'John' });
  assert.deepEqual(splitMqaName('Smith, John'), { last: 'Smith', first: 'John' });
  assert.deepEqual(splitMqaName('Cher'), { last: 'Cher', first: '' });
});

test('MQA enforcement parsing never fabricates records from page text', () => {
  const table = parseEnforcementActions(`
    <table>
      <tr><th>Date</th><th>Action</th><th>Status</th></tr>
      <tr><td>01/15/2024</td><td>Fine imposed</td><td>Final</td></tr>
    </table>`);
  assert.equal(table.readable, true);
  assert.equal(table.records.length, 1);
  assert.equal(table.records[0].date, '2024-01-15');
  assert.match(table.records[0].description, /Fine imposed/);

  const prose = parseEnforcementActions('<p>Discipline exists. Contact the board for details.</p>');
  assert.equal(prose.readable, false);
  assert.deepEqual(prose.records, []);

  const cleared = parseEnforcementActions('<p>No public complaint information is available.</p>');
  assert.equal(cleared.readable, true);
  assert.deepEqual(cleared.records, []);
});

test('CSLB unreadable record pages are an error, not a no-match', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => '' });
  try {
    await assert.rejects(() => readCslbPages(['123456']), /none could be read/i);
  } finally {
    globalThis.fetch = original;
  }

  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => 'License Number does not exist.' });
  try {
    const result = await readCslbPages(['1000000']);
    assert.equal(result.failed.length, 0);
    assert.deepEqual(result.pages, [null]);
  } finally {
    globalThis.fetch = original;
  }
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
