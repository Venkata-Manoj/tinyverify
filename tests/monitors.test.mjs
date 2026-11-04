import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeRecord } from '../lib/schema.js';

const dataDir = await mkdtemp(join(tmpdir(), 'tinyverify-monitors-'));
process.env.TINYVERIFY_DATA_DIR = dataDir;
process.env.TINYVERIFY_LOG = '0';
process.env.TINYVERIFY_ALLOW_AGENT = 'false';

const { createWatch, checkWatch, getWatch, listWatches, deleteWatch } = await import('../lib/monitors.js');

function record(overrides = {}) {
  return makeRecord({
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
    registry_id: 'companies-house-uk',
    registry_name: 'UK Companies House',
    status_detail: 'Active',
    matched_name: 'TESCO PLC',
    ...overrides,
  });
}

const verification = (result) => ({ match_quality: result.match_quality ?? 'exact', primary: result, results: [result], candidates: [] });
const fakeCreateMonitor = async () => ({ monitor: { id: 'tf_fake_1', status: 'active' }, baseline_run: {} });
const fakeDeleteMonitor = async () => ({ deleted: true });

let monitorId;

after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

test('createWatch stores a baseline snapshot and the TinyFish monitor id', async () => {
  const result = await createWatch(
    { subject: 'Tesco PLC', licence_type: 'business', jurisdiction: 'UK' },
    { verifyFn: async () => verification(record()), createMonitorFn: fakeCreateMonitor },
  );
  monitorId = result.monitor.id;
  assert.match(monitorId, /^mon_/);
  assert.equal(result.monitor.tinyfish_monitor_id, 'tf_fake_1');
  assert.deepEqual(result.monitor.snapshot, {
    status: 'active',
    licence_number: '00445790',
    expiry_date: null,
    disciplinary_actions: ['none found'],
    status_detail: 'Active',
  });
  assert.equal(result.record.licence_number, '00445790');

  const listed = await listWatches();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].event_count, 0);
});

test('createWatch refuses ambiguous results', async () => {
  const ambiguous = {
    match_quality: 'multiple',
    primary: null,
    results: [],
    candidates: [{ name: 'TESCO PLC' }, { name: 'TESCO AQUA' }],
  };
  await assert.rejects(
    () => createWatch(
      { subject: 'Tesco', licence_type: 'business', jurisdiction: 'UK' },
      { verifyFn: async () => ambiguous, createMonitorFn: fakeCreateMonitor },
    ),
    (err) => err.status === 422 && err.code === 'NO_CONFIRMED_RECORD' && err.details.verification.match_quality === 'multiple',
  );
});

test('checkWatch records a status change once and updates the snapshot', async () => {
  const changed = record({ status: 'suspended', status_detail: 'Proposal to strike off', checked_at: '2026-11-05T08:00:00.000Z' });
  const first = await checkWatch(monitorId, { verifyFn: async () => verification(changed), runTinyfish: false });
  assert.ok(first.event);
  assert.deepEqual(first.event.changed_fields, ['status', 'status_detail']);
  assert.equal(first.event.old.status, 'active');
  assert.equal(first.event.new.status, 'suspended');
  assert.match(first.event.summary, /Status changed from active to suspended/);
  assert.equal(first.event.source_url, changed.source_url);
  assert.equal(first.monitor.snapshot.status, 'suspended');

  const second = await checkWatch(monitorId, { verifyFn: async () => verification(changed), runTinyfish: false });
  assert.equal(second.event, null);
  assert.match(second.note, /No change/);

  const { events } = await getWatch(monitorId);
  assert.equal(events.length, 1);
});

test('a transient registry miss never becomes a change event', async () => {
  const before = await getWatch(monitorId);
  const result = await checkWatch(monitorId, {
    verifyFn: async () => ({ match_quality: 'no_match', primary: null, results: [], candidates: [] }),
    runTinyfish: false,
  });
  assert.equal(result.event, null);
  assert.equal(result.monitor.snapshot.status, before.monitor.snapshot.status);
  assert.match(result.note, /previous snapshot was kept/i);
});

test('deleteWatch removes the local watch and the TinyFish monitor', async () => {
  let deletedTinyfishId = null;
  const result = await deleteWatch(monitorId, {
    deleteMonitorFn: async (id) => { deletedTinyfishId = id; return { deleted: true }; },
  });
  assert.deepEqual(result, { deleted: true, id: monitorId, tinyfish_deleted: true, tinyfish_error: null });
  assert.equal(deletedTinyfishId, 'tf_fake_1');
  await assert.rejects(() => getWatch(monitorId), (err) => err.status === 404);
});

test('watches are scoped to the browser token that created them', async () => {
  const owner = 'a'.repeat(64);
  const other = 'b'.repeat(64);
  const created = await createWatch(
    { subject: 'Tesco PLC', licence_type: 'business', jurisdiction: 'UK' },
    { verifyFn: async () => verification(record()), createMonitorFn: fakeCreateMonitor, ownerHash: owner },
  );
  const id = created.monitor.id;
  assert.equal('owner_hash' in created.monitor, false);

  assert.ok((await listWatches({ ownerHash: owner })).some((monitor) => monitor.id === id));
  assert.equal((await listWatches({ ownerHash: other })).some((monitor) => monitor.id === id), false);
  assert.deepEqual(await listWatches({ ownerHash: null }), []);

  await assert.rejects(() => getWatch(id, { ownerHash: other }), (err) => err.status === 404);
  await assert.rejects(
    () => deleteWatch(id, { ownerHash: other, deleteMonitorFn: fakeDeleteMonitor }),
    (err) => err.status === 404,
  );

  const deleted = await deleteWatch(id, { ownerHash: owner, deleteMonitorFn: fakeDeleteMonitor });
  assert.equal(deleted.deleted, true);
});
