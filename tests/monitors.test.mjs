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

const { createWatch, checkWatch, getWatch, listWatches, deleteWatch, simulateWatch, handleTinyfishWebhook } = await import('../lib/monitors.js');
const { insertMonitor, removeMonitor } = await import('../lib/store.js');

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
let manageToken;

after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

test('createWatch stores a baseline snapshot and the TinyFish monitor id', async () => {
  const result = await createWatch(
    { subject: 'Tesco PLC', licence_type: 'business', jurisdiction: 'UK' },
    { verifyFn: async () => verification(record()), createMonitorFn: fakeCreateMonitor, ownerHash: 'c'.repeat(64) },
  );
  monitorId = result.monitor.id;
  manageToken = result.manage_token;
  assert.match(monitorId, /^mon_/);
  assert.match(manageToken, /^[A-Za-z0-9_-]{20,}$/);
  assert.equal(result.monitor.manage_token_required, true);
  assert.equal('manage_hash' in result.monitor, false);
  assert.equal(result.monitor.tinyfish_monitor_id, 'tf_fake_1');
  assert.deepEqual(result.monitor.snapshot, {
    status: 'active',
    licence_number: '00445790',
    expiry_date: null,
    disciplinary_actions: ['none found'],
    status_detail: 'Active',
  });
  assert.equal(result.record.licence_number, '00445790');

  const listed = await listWatches({ ownerHash: 'c'.repeat(64) });
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
  const first = await checkWatch(monitorId, { verifyFn: async () => verification(changed), runTinyfish: false, manageToken });
  assert.ok(first.event);
  assert.deepEqual(first.event.changed_fields, ['status', 'status_detail']);
  assert.equal(first.event.old.status, 'active');
  assert.equal(first.event.new.status, 'suspended');
  assert.match(first.event.summary, /Status changed from active to suspended/);
  assert.equal(first.event.source_url, changed.source_url);
  assert.equal(first.monitor.snapshot.status, 'suspended');

  const second = await checkWatch(monitorId, { verifyFn: async () => verification(changed), runTinyfish: false, manageToken });
  assert.equal(second.event, null);
  assert.match(second.note, /No change/);

  const { events } = await getWatch(monitorId, { manageToken });
  assert.equal(events.length, 1);
});

test('a transient registry miss never becomes a change event', async () => {
  const before = await getWatch(monitorId, { manageToken });
  const result = await checkWatch(monitorId, {
    verifyFn: async () => ({ match_quality: 'no_match', primary: null, results: [], candidates: [] }),
    runTinyfish: false,
    manageToken,
  });
  assert.equal(result.event, null);
  assert.equal(result.monitor.snapshot.status, before.monitor.snapshot.status);
  assert.match(result.note, /previous snapshot was kept/i);
});

test('deleteWatch removes the local watch and the TinyFish monitor', async () => {
  let deletedTinyfishId = null;
  const result = await deleteWatch(monitorId, {
    deleteMonitorFn: async (id) => { deletedTinyfishId = id; return { deleted: true }; },
    manageToken,
  });
  assert.deepEqual(result, { deleted: true, id: monitorId, tinyfish_deleted: true, tinyfish_error: null });
  assert.equal(deletedTinyfishId, 'tf_fake_1');
  await assert.rejects(() => getWatch(monitorId, { manageToken }), (err) => err.status === 404);
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
  assert.equal('manage_hash' in created.monitor, false);

  assert.ok((await listWatches({ ownerHash: owner })).some((monitor) => monitor.id === id));
  assert.equal((await listWatches({ ownerHash: other })).some((monitor) => monitor.id === id), false);
  assert.deepEqual(await listWatches({ ownerHash: null }), []);

  // Knowing the monitor id, or the owner token, is not enough: the per-watch
  // management token is required for read, re-check and delete.
  await assert.rejects(
    () => getWatch(id, { ownerHash: owner }),
    (err) => err.status === 401 && err.code === 'WATCH_TOKEN_REQUIRED',
  );
  await assert.rejects(
    () => getWatch(id, { manageToken: 'wrong-token' }),
    (err) => err.status === 404,
  );
  await assert.rejects(
    () => deleteWatch(id, { ownerHash: owner, deleteMonitorFn: fakeDeleteMonitor }),
    (err) => err.status === 401,
  );

  const deleted = await deleteWatch(id, { ownerHash: owner, manageToken: created.manage_token, deleteMonitorFn: fakeDeleteMonitor });
  assert.equal(deleted.deleted, true);
});

test('simulateWatch appends a labelled demo event without changing the live snapshot', async () => {
  const created = await createWatch(
    { subject: 'Tesco PLC', licence_type: 'business', jurisdiction: 'UK' },
    { verifyFn: async () => verification(record()), createMonitorFn: fakeCreateMonitor },
  );
  const id = created.monitor.id;
  const before = await getWatch(id, { manageToken: created.manage_token });

  process.env.TINYVERIFY_DEMO = '1';
  try {
    const result = await simulateWatch(id, { manageToken: created.manage_token, patch: { status: 'suspended' } });
    assert.equal(result.event.simulated, true);
    assert.equal(result.event.detected_by, 'TinyVerify demo simulator (not a live read)');
    assert.deepEqual(result.event.changed_fields, ['status']);
    assert.equal(result.monitor.snapshot.status, before.monitor.snapshot.status);
  } finally {
    delete process.env.TINYVERIFY_DEMO;
  }
  await deleteWatch(id, { manageToken: created.manage_token, deleteMonitorFn: fakeDeleteMonitor });
});

test('simulateWatch is unavailable unless the demo flag is explicit', async () => {
  const created = await createWatch(
    { subject: 'Tesco PLC', licence_type: 'business', jurisdiction: 'UK' },
    { verifyFn: async () => verification(record()), createMonitorFn: fakeCreateMonitor },
  );
  await assert.rejects(
    () => simulateWatch(created.monitor.id, { manageToken: created.manage_token }),
    (err) => err.status === 404,
  );
  await deleteWatch(created.monitor.id, { manageToken: created.manage_token, deleteMonitorFn: fakeDeleteMonitor });
});

test('createWatch refuses a name/number mismatch', async () => {
  const mismatched = record({ match_quality: 'mismatch', name_number_mismatch: true });
  await assert.rejects(
    () => createWatch(
      { subject: 'Acme Widgets', licence_type: 'business', jurisdiction: 'UK', number: '00445790' },
      {
        verifyFn: async () => ({
          match_quality: 'mismatch',
          name_number_mismatch: true,
          primary: mismatched,
          results: [mismatched],
          candidates: [],
        }),
        createMonitorFn: fakeCreateMonitor,
      },
    ),
    (err) => err.status === 422 && err.code === 'NAME_NUMBER_MISMATCH',
  );
});

test('watches persist health filters and re-check with them', async () => {
  const healthRecord = record({
    subject: 'John Smith',
    matched_name: 'Smith, John',
    licence_type: 'health',
    jurisdiction: 'US-FL',
    licence_number: 'ME182088',
    registry_id: 'mqa-fl',
    registry_name: 'Florida Department of Health (MQA)',
    source_name: 'Florida Department of Health (MQA)',
    source_url: 'https://mqa-internet.doh.state.fl.us/MQASearchServices/HealthCareProviders/LicenseVerification?LicInd=1&ProCde=2',
  });
  const query = {
    subject: 'John Smith',
    licence_type: 'health',
    jurisdiction: 'US-FL',
    state: 'FL',
    city: 'Miami',
    taxonomy: '363L00000X',
  };
  const created = await createWatch(query, {
    verifyFn: async () => ({ ...verification(healthRecord), query: { ...query } }),
    createMonitorFn: fakeCreateMonitor,
    ownerHash: 'd'.repeat(64),
  });
  assert.equal(created.monitor.state, 'FL');
  assert.equal(created.monitor.city, 'Miami');
  assert.equal(created.monitor.taxonomy, '363L00000X');

  let seen = null;
  await checkWatch(created.monitor.id, {
    verifyFn: async (input) => {
      seen = input;
      return { ...verification(healthRecord), query: { ...query } };
    },
    runTinyfish: false,
    manageToken: created.manage_token,
  });
  assert.equal(seen.state, 'FL');
  assert.equal(seen.city, 'Miami');
  assert.equal(seen.taxonomy, '363L00000X');

  await deleteWatch(created.monitor.id, { manageToken: created.manage_token, deleteMonitorFn: fakeDeleteMonitor });
});

test('concurrent checks append one change event, not duplicates', async () => {
  const created = await createWatch(
    { subject: 'Tesco PLC', licence_type: 'business', jurisdiction: 'UK' },
    { verifyFn: async () => verification(record()), createMonitorFn: fakeCreateMonitor },
  );
  const changed = record({ status: 'suspended', status_detail: 'Suspended', checked_at: '2026-11-05T09:00:00.000Z' });
  const verifyFn = async () => verification(changed);
  const results = await Promise.all([
    checkWatch(created.monitor.id, { verifyFn, runTinyfish: false, manageToken: created.manage_token }),
    checkWatch(created.monitor.id, { verifyFn, runTinyfish: false, manageToken: created.manage_token }),
  ]);
  assert.equal(results.filter((result) => result.event).length, 1);
  const { events } = await getWatch(created.monitor.id, { manageToken: created.manage_token });
  assert.equal(events.length, 1);
  await deleteWatch(created.monitor.id, { manageToken: created.manage_token, deleteMonitorFn: fakeDeleteMonitor });
});

test('a watch with no management credential is denied by default', async () => {
  const id = 'mon_legacy_no_credentials';
  await insertMonitor({
    id,
    subject: 'Legacy Watch',
    licence_type: 'business',
    jurisdiction: 'UK',
    number: '00445790',
    created_at: '2026-01-01T00:00:00.000Z',
    events: [],
    snapshot: { status: 'active' },
  });
  try {
    await assert.rejects(() => getWatch(id), (err) => err.status === 401 && err.code === 'WATCH_TOKEN_REQUIRED');
    await assert.rejects(
      () => getWatch(id, { ownerHash: 'a'.repeat(64) }),
      (err) => err.status === 401 && err.code === 'WATCH_TOKEN_REQUIRED',
    );
  } finally {
    await removeMonitor(id);
  }
});

test('webhook resolves the TinyFish page-monitor id field', async () => {
  const created = await createWatch(
    { subject: 'Tesco PLC', licence_type: 'business', jurisdiction: 'UK' },
    {
      verifyFn: async () => verification(record()),
      createMonitorFn: async () => ({ monitor: { id: 'tf_hook_page_1', status: 'active' } }),
    },
  );
  try {
    const result = await handleTinyfishWebhook(
      { fetch_monitor_id: 'tf_hook_page_1', outcome: 'changed' },
      { verifyFn: async () => verification(record({ status: 'suspended', status_detail: 'Suspended' })) },
    );
    assert.equal(result.ignored, false);
    assert.equal(result.monitor_id, created.monitor.id);
    assert.ok(result.event);
    assert.equal(result.event.new.status, 'suspended');
  } finally {
    await deleteWatch(created.monitor.id, { manageToken: created.manage_token, deleteMonitorFn: fakeDeleteMonitor });
  }
});
