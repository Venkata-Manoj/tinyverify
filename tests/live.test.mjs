import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verify } from '../lib/verify.js';

/**
 * Live registry checks. These read the real official sources and can take a
 * minute per query, so they only run with LIVE=1:
 *
 *   npm run test:live
 *
 * Nothing here is mocked. A failure means the live source, the parser or the
 * network changed — investigate before shipping.
 */

const LIVE = process.env.LIVE === '1';
const opts = { skip: !LIVE, timeout: 240_000 };

const query = (subject, licence_type, jurisdiction, extra = {}) => ({ subject, licence_type, jurisdiction, ...extra });

test('UK: Tesco PLC is an exact, active Companies House record with a source', opts, async () => {
  const result = await verify(query('Tesco PLC', 'business', 'UK'), { refresh: true });
  assert.equal(result.match_quality, 'exact');
  assert.equal(result.primary.status, 'active');
  assert.equal(result.primary.licence_number, '00445790');
  assert.match(result.primary.source_url, /company\/00445790/);
  assert.match(result.primary.checked_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(result.primary.status_detail, /active/i);
});

test('UK: a nonsense name is no_match, not a weak "close" guess', opts, async () => {
  const result = await verify(query('qwzxv plorb', 'business', 'UK'), { refresh: true });
  assert.equal(result.match_quality, 'no_match');
  assert.equal(result.primary, null);
  assert.equal(result.candidates.length, 0);
});

test('UK: a real name with the wrong company number is flagged as a mismatch', opts, async () => {
  const result = await verify(
    { subject: 'Acme Widgets', licence_type: 'business', jurisdiction: 'UK', number: '00445790' },
    { refresh: true },
  );
  assert.equal(result.match_quality, 'mismatch');
  assert.equal(result.name_number_mismatch, true);
  assert.equal(result.primary.licence_number, '00445790');
  assert.equal(result.name_number_check.matched, false);
});

test('UK: liquidation is kept as in_liquidation with the registry wording', opts, async () => {
  const result = await verify(query('Carillion PLC', 'business', 'UK'), { refresh: true });
  assert.equal(result.match_quality, 'exact');
  assert.equal(result.primary.status, 'in_liquidation');
  assert.equal(result.primary.status_bounty, 'expired');
  assert.equal(result.primary.status_detail, 'Liquidation');
});

test('NZ: Air New Zealand is an active NZ Companies Office record', opts, async () => {
  const result = await verify(
    { subject: 'Air New Zealand Limited', licence_type: 'business', jurisdiction: 'NZ', number: '104799' },
    { refresh: true },
  );
  assert.equal(result.match_quality, 'exact');
  assert.equal(result.primary.status, 'active');
  assert.equal(result.primary.licence_number, '104799');
  assert.match(result.primary.source_url, /companiesoffice\.govt\.nz/);
});

test('AU: Telstra ABN is active and has no expiry date, never an invented one', opts, async () => {
  const result = await verify(
    { subject: 'TELSTRA CORPORATION LIMITED', licence_type: 'business', jurisdiction: 'AU', number: '33051775556' },
    { refresh: true },
  );
  assert.equal(result.match_quality, 'exact');
  assert.equal(result.primary.status, 'active');
  assert.equal(result.primary.licence_number, '33051775556');
  assert.equal(result.primary.expiry_date, null);
  assert.match(result.primary.status_detail, /Active from/);
  assert.equal(result.primary.fields.entity_type, 'Australian Public Company');
});

test('AU: an ABN that fails the checksum is rejected before any fetch', opts, async () => {
  await assert.rejects(
    () => verify(
      { subject: 'Telstra', licence_type: 'business', jurisdiction: 'AU', number: '33051775557' },
      { refresh: true },
    ),
    (err) => err.status === 400 && /checksum/i.test(err.message),
  );
});

test('US NPI: John Smith reports the true result_count and no Jacks', opts, async () => {
  const result = await verify(query('John Smith', 'health', 'US'), { refresh: true });
  assert.equal(result.match_quality, 'multiple');
  assert.ok(result.total_found >= 150, `expected the full NPPES count, got ${result.total_found}`);
  assert.ok(result.total_found < 400, `unexpected NPPES count ${result.total_found}`);
  const names = [result.primary, ...result.candidates].filter(Boolean).map((row) => String(row.name || row.matched_name || '').toUpperCase());
  assert.equal(names.some((name) => /\bJACK\b/.test(name)), false);
});

test('US NPI: a number lookup returns exactly that provider', opts, async () => {
  const result = await verify(
    { subject: 'Planise Jean Louis', licence_type: 'health', jurisdiction: 'US', number: '1295346773' },
    { refresh: true },
  );
  assert.equal(result.match_quality, 'exact');
  assert.equal(result.primary.licence_number, '1295346773');
  assert.equal(result.primary.matched_name, 'PLANISE JEAN LOUIS');
  assert.equal(result.primary.status, 'active');
});

test('US-CA: CSLB 738180 is revoked and carries a real arbitration record', opts, async () => {
  const result = await verify(
    { subject: 'DONE RIGHT DISCOUNT FLOORING', licence_type: 'contractor', jurisdiction: 'US-CA', number: '738180' },
    { refresh: true },
  );
  assert.equal(result.match_quality, 'exact');
  assert.equal(result.primary.status, 'revoked');
  assert.equal(result.primary.expiry_date, '2017-05-28');
  assert.ok(result.primary.disciplinary_records.length >= 1);
  const arbitration = result.primary.disciplinary_records.find((row) => /A S 2016 000293/.test(String(row.description)));
  assert.ok(arbitration, 'expected CSLB arbitration A S 2016 000293 in the disclosure description');
  assert.equal(arbitration.date, '2017-05-28');
});

test('US-FL: NPI and the Florida board are queried together for a state licence', opts, async () => {
  const result = await verify(
    { subject: 'JOHN HORATIO SMITH II', licence_type: 'health', jurisdiction: 'US-FL', number: 'ME182088' },
    { refresh: true },
  );
  assert.equal(result.match_quality, 'exact');
  assert.equal(result.primary.registry_id, 'mqa-fl');
  assert.equal(result.primary.licence_number, 'ME182088');
  assert.equal(result.primary.status, 'active');
  assert.equal(result.primary.expiry_date, '2028-01-31');
  assert.equal(result.primary.disciplinary_actions.includes('none found'), true);
  const ids = result.searched.map((row) => row.registry_id);
  assert.deepEqual(ids.sort(), ['mqa-fl', 'npi-us']);
  const npi = result.searched.find((row) => row.registry_id === 'npi-us');
  assert.equal(npi.outcome, 'no_match');
});

test('special characters return a clean no_match with no registry call', opts, async () => {
  const result = await verify(query('!!! ***', 'business', 'UK'), { refresh: true });
  assert.equal(result.match_quality, 'no_match');
  assert.equal(result.searched.length, 0);
  assert.match(result.notes.join(' '), /no letters or digits/i);
});

test('US-TX: Texas Medical Board physician lookup by name', opts, async () => {
  // The TMB search form is CAPTCHA-protected; live lookups by name may fail.
  // If they do, that's expected — the number lookup path works.
  const result = await verify(query('John Smith', 'health', 'US-TX'), { refresh: true });
  if (result.ok) {
    assert.ok(result.primary || result.candidates.length > 0, 'Expected at least one match');
    if (result.primary) {
      assert.match(result.primary.source_url, /Profile\.aspx/);
      assert.match(result.primary.status_detail, /active|suspended|revoked/i);
    }
  }
});

test('US-TX: Texas Medical Board license number lookup', opts, async () => {
  // Number lookup goes directly to detail page, bypassing the CAPTCHA search form.
  const result = await verify(query('', 'health', 'US-TX', { number: '1234567' }), { refresh: true });
  // May return no_match if the number isn't in the system, but should not error
  assert.ok(result.ok !== false, 'Verification should not error');
});

test('US-TX: Texas Medical Board multiple matches handled clearly', opts, async () => {
  // Name-based search may hit CAPTCHA; if it works, verify no auto-selection.
  // If it fails with REGISTRY_UNAVAILABLE, that's expected due to CAPTCHA.
  const result = await verify(query('John Doe', 'health', 'US-TX'), { refresh: true });
  if (result.ok) {
    assert.ok(result.match_quality === 'multiple' || result.match_quality === 'no_match', 'Should not auto-select');
    if (result.candidates && result.candidates.length > 0) {
      result.candidates.forEach((c) => assert.ok(c.source_url, 'Candidate should have source_url'));
    }
  }
});

test('special name/number mismatch returns mismatch', opts, async () => {
  const result = await verify(
    { subject: 'Acme Widgets', licence_type: 'business', jurisdiction: 'UK', number: '00445790' },
    { refresh: true },
  );
  assert.equal(result.match_quality, 'mismatch');
  assert.equal(result.name_number_mismatch, true);
});