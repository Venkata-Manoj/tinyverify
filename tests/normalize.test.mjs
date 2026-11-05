import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyMatch,
  disciplinaryList,
  nameSimilarity,
  nameVariants,
  normalizeDate,
  normalizeName,
  normalizeStatus,
  humanizeKey,
} from '../lib/normalize.js';

test('normalizeName removes legal suffixes, titles and punctuation', () => {
  assert.equal(normalizeName('Tesco PLC'), 'tesco public limited company');
  assert.equal(normalizeName('Dr. Jane A. Smith, MD'), 'jane a smith');
  assert.equal(normalizeName('  ACME   Ltd. '), 'acme limited');
  assert.equal(normalizeName('Ó Briain'), 'o briain');
});

test('nameVariants proposes ordered, de-duplicated alternatives', () => {
  const variants = nameVariants('Smith, Jane A');
  const values = variants.map((v) => v.value);
  const normalized = variants.map((v) => normalizeName(v.value));
  assert.equal(values[0], 'Smith, Jane A');
  assert.ok(normalized.includes('jane a smith'));
  assert.ok(normalized.includes('jane smith'));
  assert.equal(new Set(normalized).size, variants.length);
});

test('nameSimilarity and classifyMatch are conservative', () => {
  assert.equal(nameSimilarity('Tesco PLC', 'TESCO PLC'), 1);
  assert.equal(classifyMatch('Tesco PLC', 'TESCO PLC'), 'exact');
  assert.equal(classifyMatch('Tesco', 'TESCO PLC'), 'close');
  assert.equal(classifyMatch('Hala Tree Service', 'HALABI CONSTRUCTION'), 'no_match');
  assert.ok(nameSimilarity('MacDonald', 'McDonald') > 0.9);
  // Regression: a nonsense query must not match a generic "STORE LOCATOR ..." name.
  assert.equal(classifyMatch('qwzxv plorb', 'STORE LOCATOR WIDGETS LTD'), 'no_match');
  // Every query token must occur in the candidate; "John" alone cannot match "Johnathan".
  assert.equal(classifyMatch('John Smith', 'JOHNATHAN SMITH'), 'no_match');
});

test('normalizeStatus maps registry wording into the eight-value vocabulary', () => {
  assert.equal(normalizeStatus('Active').status, 'active');
  assert.equal(normalizeStatus('This license is revoked and not able to contract at this time.').status, 'revoked');
  assert.equal(normalizeStatus('Suspended pending hearing').status, 'suspended');
  assert.equal(normalizeStatus('Dissolved').status, 'dissolved');
  assert.equal(normalizeStatus('Struck off').status, 'dissolved');
  assert.equal(normalizeStatus('Liquidation').status, 'in_liquidation');
  assert.equal(normalizeStatus('Cancelled').status, 'inactive');
  assert.equal(normalizeStatus('Null And Void').status, 'inactive');
  assert.equal(normalizeStatus('Delinquent/Active').status, 'expired');
  assert.equal(normalizeStatus('Something new').status, 'unknown');
  assert.equal(normalizeStatus('').status, 'unknown');
  // The native wording is always preserved for status_detail.
  assert.equal(normalizeStatus('Dissolved').detail, 'Dissolved');
});

test('normalizeDate handles day-first and month-first registry formats', () => {
  assert.equal(normalizeDate('27 November 1947'), '1947-11-27');
  assert.equal(normalizeDate('2027-07-02'), '2027-07-02');
  assert.equal(normalizeDate('05/28/2017', { dayFirst: false }), '2017-05-28');
  assert.equal(normalizeDate('31/05/2027'), '2027-05-31');
  assert.equal(normalizeDate('May 31, 2027'), '2027-05-31');
  assert.equal(normalizeDate('not applicable'), null);
  assert.equal(normalizeDate('31/02/2020'), null);
});

test('disciplinaryList never leaves an ambiguous empty list', () => {
  assert.deepEqual(disciplinaryList([]), ['none found']);
  assert.deepEqual(disciplinaryList(['None']), ['none found']);
  assert.deepEqual(disciplinaryList(['Suspension lifted']), ['Suspension lifted']);
});

test('humanizeKey produces readable labels for extra fields', () => {
  assert.equal(humanizeKey('next_confirmation_statement_due'), 'Next confirmation statement due');
  assert.equal(humanizeKey('registeredOffice'), 'Registered office');
});
