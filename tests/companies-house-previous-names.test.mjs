import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { confirmsPreviousName, parseCompanyPage, parseSearchResults, selectSearchMatch } from '../lib/registries/companies-house.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (name) => readFileSync(join(fixtures, name), 'utf8');

test('Wilko search rows attach "Matching previous names" to the FOLLOWING company number', () => {
  const results = parseSearchResults(read('companies-house-wilko-search.md'));
  const byNumber = new Map(results.map((row) => [row.number, row.previousNames]));

  assert.deepEqual(byNumber.get('09563205'), [], 'the block printed below 09563205 belongs to the next number, not to it');
  assert.deepEqual(byNumber.get('00365335'), ['WILKO LIMITED', 'WILKO RETAIL LIMITED']);
  assert.deepEqual(byNumber.get('11121294'), ['WILKO']);
  assert.deepEqual(byNumber.get('09917442'), ['WILKO']);
  assert.deepEqual(byNumber.get('12701026'), ['WILKO PROPERTIES LIMITED']);
  assert.deepEqual(byNumber.get('06456335'), [], 'companies without a block stay empty');
  assert.deepEqual(byNumber.get('16052142'), []);
});

test('Royal Mail search rows attach the ROYAL MAIL PLC block to 08680755', () => {
  const results = parseSearchResults(read('companies-house-royal-mail-search.md'));
  const byNumber = new Map(results.map((row) => [row.number, row.previousNames]));
  assert.deepEqual(byNumber.get('14240638'), [], 'the ROYAL MAIL PLC block below this entry belongs to 08680755');
  assert.deepEqual(byNumber.get('08680755'), ['ROYAL MAIL PLC']);
  assert.deepEqual(byNumber.get('03087786'), ['ROYAL MAIL LIMITED']);
  assert.deepEqual(byNumber.get('03229377'), ['ROYAL MAIL INVESTMENTS LIMITED']);
});

test('a former name counts only when the detail page table confirms it literally', () => {
  const detail = read('companies-house-wilko-00365335.md');
  // Case-insensitive and punctuation-tolerant.
  assert.equal(confirmsPreviousName(detail, 'WILKO LIMITED'), true);
  assert.equal(confirmsPreviousName(detail, 'wilko limited'), true);
  assert.equal(confirmsPreviousName(detail, 'WILKO,  LIMITED'), true);
  assert.equal(confirmsPreviousName(detail, 'WILKINSON HARDWARE STORES LIMITED'), true, 'the register writes "STORES,LIMITED"; folding treats them as the same name');
  // A different name is never confirmed.
  assert.equal(confirmsPreviousName(detail, 'WILKO LIMITED GROUP'), false);
  assert.equal(confirmsPreviousName(detail, 'WILKO'), false, 'substring overlap is not a literal former name');
  assert.equal(confirmsPreviousName('no table on this page', 'WILKO LIMITED'), false);
});

test('detail-page confirmation marks the Wilko former-name hit as previous_name with the current official name', () => {
  const text = read('companies-house-wilko-00365335.md');
  const parsed = parseCompanyPage(text, { url: 'https://find-and-update.company-information.service.gov.uk/company/00365335' });
  assert.equal(parsed.number, '00365335');
  assert.equal(parsed.name, 'WL REALISATIONS (2023) LIMITED');

  const selection = selectSearchMatch('Wilko Limited', [{ parsed, text }], parseSearchResults(read('companies-house-wilko-search.md')));
  assert.equal(selection.outcome, 'match');
  assert.equal(selection.record.licence_number, '00365335');
  assert.equal(selection.record.matched_via, 'previous_name');
  assert.equal(selection.record.previous_name, 'WILKO LIMITED');
  assert.equal(selection.record.matched_name, 'WL REALISATIONS (2023) LIMITED');
  assert.equal(selection.record.match_quality, 'close');
  assert.equal(selection.record.status, 'in_liquidation');
});

test('Wilko current-name and former-name matches return multiple with BOTH candidates', () => {
  const formerParsed = parseCompanyPage(read('companies-house-wilko-00365335.md'), {
    url: 'https://find-and-update.company-information.service.gov.uk/company/00365335',
  });
  const currentParsed = {
    name: 'WILKO LIMITED',
    number: '09563205',
    raw_status: 'Active',
    status: 'active',
    status_detail: 'Active',
    fields: {},
    notes: [],
  };

  const selection = selectSearchMatch('Wilko Limited', [
    { parsed: currentParsed, text: 'Company Overview for WILKO LIMITED (09563205)' },
    { parsed: formerParsed, text: read('companies-house-wilko-00365335.md') },
  ], parseSearchResults(read('companies-house-wilko-search.md')));

  assert.equal(selection.outcome, 'multiple');
  assert.equal(selection.candidates.length, 2);

  const current = selection.candidates.find((c) => c.licence_number === '09563205');
  assert.equal(current.name, 'WILKO LIMITED');
  assert.equal(current.matched_via, null);
  assert.equal(current.previous_name, null);

  const former = selection.candidates.find((c) => c.licence_number === '00365335');
  assert.equal(former.name, 'WL REALISATIONS (2023) LIMITED', 'the former-name candidate carries the current official name');
  assert.equal(former.matched_via, 'previous_name');
  assert.equal(former.previous_name, 'WILKO LIMITED');
});

test('Royal Mail plc returns 08680755 marked previous_name', () => {
  const text = read('companies-house-royal-mail-08680755.md');
  const parsed = parseCompanyPage(text, { url: 'https://find-and-update.company-information.service.gov.uk/company/08680755' });
  assert.equal(parsed.number, '08680755');
  assert.equal(parsed.name, 'INTERNATIONAL DISTRIBUTION SERVICES LIMITED');

  const selection = selectSearchMatch('Royal Mail plc', [{ parsed, text }], parseSearchResults(read('companies-house-royal-mail-search.md')));
  assert.equal(selection.outcome, 'match');
  assert.equal(selection.record.licence_number, '08680755');
  assert.equal(selection.record.matched_via, 'previous_name');
  assert.equal(selection.record.previous_name, 'ROYAL MAIL PLC');
  assert.equal(selection.record.matched_name, 'INTERNATIONAL DISTRIBUTION SERVICES LIMITED');
  assert.equal(selection.record.match_quality, 'close');
  assert.equal(selection.record.status, 'active');
});

test('a previous-name hit the detail page does not confirm is never returned as a match', () => {
  // A real parsed page whose previous-names table lacks the row the search
  // page claims matched ("WILKO"): only WILKO RETAIL LIMITED is on record.
  const text = [
    '* Company Overview for SOME OTHER LIMITED (11121294)',
    '',
    '* Company status',
    '* Dissolved',
    '',
    '## Previous company names',
    '',
    '| Name | Period |',
    '| --- | --- |',
    '| WILKO RETAIL LIMITED | 11 Jun 2014 - 21 Apr 2021 |',
  ].join('\n');
  const parsed = parseCompanyPage(text, { url: 'https://find-and-update.company-information.service.gov.uk/company/11121294' });
  assert.equal(parsed.number, '11121294');
  assert.ok(parsed.fields.previous_names.length > 0);

  const selection = selectSearchMatch('Wilko Limited', [{ parsed, text }], parseSearchResults(read('companies-house-wilko-search.md')));
  assert.equal(selection.outcome, 'no_match', 'the unconfirmed WILKO row must not produce a previous_name match');
  assert.equal(selection.candidates.some((c) => c.matched_via === 'previous_name'), false);
  assert.equal(selection.candidates[0]?.licence_number, '11121294', 'the page stays visible as an unmatched candidate');
});
