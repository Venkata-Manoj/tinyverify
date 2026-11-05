import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertRecord,
  diffSnapshots,
  makeRecord,
  reconcileStatuses,
  snapshotOf,
  summarizeChange,
} from '../lib/schema.js';

const base = {
  subject: 'Tesco PLC',
  licence_type: 'business',
  jurisdiction: 'UK',
  status: 'active',
  licence_number: '00445790',
  expiry_date: null,
  disciplinary_actions: ['none found'],
  source_name: 'UK Companies House',
  source_url: 'https://find-and-update.company-information.service.gov.uk/company/00445790',
  checked_at: '2026-11-04T12:00:00.000Z',
  match_quality: 'exact',
};

test('makeRecord fills the required record shape', () => {
  const record = makeRecord(base);
  assert.equal(record.status, 'active');
  assert.equal(record.match_quality, 'exact');
  assert.deepEqual(record.disciplinary_actions, ['none found']);
  assert.deepEqual(record.fields, {});
  assert.deepEqual(record.notes, []);
  assert.equal(record.cached, false);
});

test('a missing result count stays null instead of becoming zero', () => {
  assert.equal(makeRecord(base).total_found, null);
  assert.equal(makeRecord({ ...base, total_found: 0 }).total_found, 0);
  assert.equal(makeRecord({ ...base, total_found: 187 }).total_found, 187);
  assert.equal(makeRecord({ ...base, total_found: null }).total_found, null);
});

test('makeRecord rejects impossible values instead of guessing', () => {
  assert.equal(makeRecord({ ...base, status: 'probably-fine' }).status, 'unknown');
  assert.equal(makeRecord({ ...base, match_quality: 'vibes' }).match_quality, 'no_match');
  assert.throws(() => assertRecord({ ...base, source_url: 'not-a-url' }), /source_url/);
  assert.throws(() => assertRecord({ ...base, checked_at: 'yesterday' }), /checked_at/);
  assert.throws(() => assertRecord({ ...base, status: 'active', source_name: '' }), /required fields/);
});

test('snapshot and diff detect only meaningful record changes', () => {
  const before = snapshotOf(makeRecord(base));
  const after = snapshotOf(makeRecord({ ...base, status: 'suspended', status_detail: 'Revoked' }));
  const diff = diffSnapshots(before, after);
  assert.deepEqual(diff.changed_fields, ['status', 'status_detail']);
  assert.equal(diff.old.status, 'active');
  assert.equal(diff.new.status, 'suspended');
  assert.match(summarizeChange(diff), /Status changed from active to suspended/);
  assert.deepEqual(diffSnapshots(before, before).changed_fields, []);
});

test('reconcileStatuses refuses to merge disagreeing registries', () => {
  const active = makeRecord(base);
  const expired = makeRecord({ ...base, source_name: 'Another register', source_url: 'https://example.gov/record', status: 'expired' });
  const result = reconcileStatuses([active, expired]);
  assert.equal(result.conflict, true);
  assert.equal(result.status, 'unknown');
  assert.match(result.note, /disagree/);

  const agree = reconcileStatuses([active, { ...expired, status: 'active' }]);
  assert.equal(agree.conflict, false);
  assert.equal(agree.status, 'active');
});
