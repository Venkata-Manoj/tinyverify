import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = await mkdtemp(join(tmpdir(), 'tinyverify-router-'));
process.env.TINYVERIFY_DATA_DIR = dataDir;
process.env.TINYVERIFY_LOG = '0';
process.env.TINYVERIFY_WEBHOOK_SECRET = 'test-webhook-secret';

const { handleRequest, refreshAllowed } = await import('../lib/router.js');

let server;
let base;

before(async () => {
  server = createServer(handleRequest);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
});

async function call(path, options = {}) {
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: options.body === undefined ? undefined : (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, headers: res.headers, data };
}

function signedPayload(payload, { timestamp = Math.floor(Date.now() / 1000), secret = 'test-webhook-secret' } = {}) {
  const raw = JSON.stringify(payload);
  const signature = createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
  return {
    body: raw,
    headers: {
      'x-tinyfish-signature': signature,
      'x-tinyfish-timestamp': String(timestamp),
    },
  };
}

test('GET /api/health reports configuration without leaking the key', async () => {
  const { status, data } = await call('/api/health');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(typeof data.api_key_configured, 'boolean');
  assert.equal(typeof data.demo, 'boolean');
  assert.equal(typeof data.storage, 'string');
  assert.equal(JSON.stringify(data).includes('TINYFISH_API_KEY'), false);
});

test('GET /api/registries exposes the live coverage matrix', async () => {
  const { status, data } = await call('/api/registries');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.deepEqual(data.registries.map((r) => r.id).sort(), [
    'abn-au', 'companies-house-uk', 'cslb-ca', 'mqa-ca', 'mqa-fl', 'npi-us', 'nz-companies', 'tmb-fl',
  ]);
  assert.deepEqual(data.combinations.map((c) => `${c.licence_type}/${c.jurisdiction}`).sort(), [
    'business/AU',
    'business/NZ',
    'business/UK',
    'contractor/US-CA',
    'health/US',
    'health/US-CA',
    'health/US-FL',
    'health/US-TX',
  ]);
  assert.deepEqual(data.registries.find((r) => r.id === 'mqa-fl').jurisdictions, ['US-FL']);
  assert.deepEqual(data.registries.find((r) => r.id === 'mqa-ca').jurisdictions, ['US-CA']);
});

test('POST /api/verify validates input before calling any registry', async () => {
  const missing = await call('/api/verify', { method: 'POST', body: { licence_type: 'business', jurisdiction: 'UK' } });
  assert.equal(missing.status, 400);
  assert.equal(missing.data.error.code, 'BAD_REQUEST');

  const invalidJson = await call('/api/verify', { method: 'POST', body: '{nope' });
  assert.equal(invalidJson.status, 400);
  assert.equal(invalidJson.data.error.code, 'INVALID_JSON');

  const unsupported = await call('/api/verify', { method: 'POST', body: { subject: 'A Person', licence_type: 'medical', jurisdiction: 'NZ' } });
  assert.equal(unsupported.status, 200);
  assert.equal(unsupported.data.match_quality, 'unsupported');
  assert.ok(unsupported.data.supported.combinations.length >= 3);
});

test('monitor routes return structured 404s', async () => {
  const get = await call('/api/monitors/mon_missing');
  assert.equal(get.status, 404);
  assert.equal(get.data.error.code, 'NOT_FOUND');
  const del = await call('/api/monitors/mon_missing', { method: 'DELETE' });
  assert.equal(del.status, 404);
});

test('GET /api/monitors starts empty and the webhook verifies its token', async () => {
  const list = await call('/api/monitors');
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.monitors, []);

  const unsigned = await call('/api/webhooks/tinyfish', { method: 'POST', body: { monitor_id: 'not-ours', event: 'change' } });
  assert.equal(unsigned.status, 401);
  assert.equal(unsigned.data.error.code, 'BAD_SIGNATURE');

  const hook = await call('/api/webhooks/tinyfish?token=test-webhook-secret', {
    method: 'POST',
    body: { monitor_id: 'not-ours', event: 'change' },
  });
  assert.equal(hook.status, 200);
  assert.equal(hook.data.ignored, true);
});

test('webhook accepts a timestamped HMAC and rejects body-only signatures', async () => {
  const payload = { fetch_monitor_id: 'not-ours', outcome: 'unchanged' };
  const signed = signedPayload(payload);
  const accepted = await call('/api/webhooks/tinyfish', {
    method: 'POST',
    headers: signed.headers,
    body: signed.body,
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.data.ignored, true);

  const raw = JSON.stringify(payload);
  const bodyOnly = createHmac('sha256', 'test-webhook-secret').update(raw).digest('hex');
  const rejected = await call('/api/webhooks/tinyfish', {
    method: 'POST',
    headers: { 'x-tinyfish-signature': bodyOnly, 'x-tinyfish-timestamp': String(Math.floor(Date.now() / 1000)) },
    body: raw,
  });
  assert.equal(rejected.status, 401);
  assert.equal(rejected.data.error.code, 'BAD_SIGNATURE');
});

test('webhook rejects a stale timestamp and duplicate payloads', async () => {
  const payload = { fetch_monitor_id: 'not-ours', outcome: 'replay-check-unique' };
  const stale = signedPayload(payload, { timestamp: Math.floor(Date.now() / 1000) - 3600 });
  const rejected = await call('/api/webhooks/tinyfish', { method: 'POST', headers: stale.headers, body: stale.body });
  assert.equal(rejected.status, 401);

  const fresh = signedPayload(payload);
  const first = await call('/api/webhooks/tinyfish', { method: 'POST', headers: fresh.headers, body: fresh.body });
  assert.equal(first.status, 200);
  assert.equal(first.data.ignored, true);
  const replay = await call('/api/webhooks/tinyfish', { method: 'POST', headers: fresh.headers, body: fresh.body });
  assert.equal(replay.status, 200);
  assert.match(replay.data.reason, /Duplicate webhook payload/i);
});

test('the webhook token is never written to the access log', async () => {
  const previousLog = process.env.TINYVERIFY_LOG;
  const previousLogFn = console.log;
  const lines = [];
  process.env.TINYVERIFY_LOG = '1';
  console.log = (...args) => { lines.push(args.map(String).join(' ')); };
  try {
    const result = await call('/api/webhooks/tinyfish?token=test-webhook-secret', {
      method: 'POST',
      body: { monitor_id: 'not-ours' },
    });
    assert.equal(result.status, 200);
  } finally {
    console.log = previousLogFn;
    if (previousLog === undefined) delete process.env.TINYVERIFY_LOG;
    else process.env.TINYVERIFY_LOG = previousLog;
  }
  assert.ok(lines.some((line) => line.includes('/api/webhooks/tinyfish')), 'request was logged');
  assert.equal(lines.some((line) => line.includes('test-webhook-secret')), false, 'token leaked to log');
});

test('refresh is admin-only', () => {
  assert.equal(refreshAllowed({ refresh: true }, false), false);
  assert.equal(refreshAllowed({ refresh: 'true' }, false), false);
  assert.equal(refreshAllowed({ refresh: true }, true), true);
  assert.equal(refreshAllowed({}, true), false);
});

test('watching requires an owner token and anonymous refresh is ignored', async () => {
  const create = await call('/api/monitors', {
    method: 'POST',
    body: { subject: 'Tesco PLC', licence_type: 'business', jurisdiction: 'UK' },
  });
  assert.equal(create.status, 401);
  assert.equal(create.data.error.code, 'OWNER_REQUIRED');

  const list = await call('/api/monitors', { headers: { 'X-TinyVerify-Owner': 'a'.repeat(32) } });
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.monitors, []);
});

test('unknown routes return a JSON 404 and CORS preflight is handled', async () => {
  const missing = await call('/api/nope');
  assert.equal(missing.status, 404);
  assert.equal(missing.data.error.code, 'NOT_FOUND');

  const preflight = await call('/api/verify', { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  assert.match(preflight.headers.get('access-control-allow-headers'), /X-TinyVerify-Owner/i);
});

test('oversized bodies return 413 instead of crashing the function', async () => {
  const body = JSON.stringify({ subject: 'x'.repeat(70 * 1024), licence_type: 'business', jurisdiction: 'UK' });
  const res = await fetch(`${base}/api/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  assert.equal(res.status, 413);
  const data = await res.json();
  assert.equal(data.error.code, 'PAYLOAD_TOO_LARGE');
});

test('non-JSON content types and overlong numbers are rejected before any registry call', async () => {
  const wrongType = await fetch(`${base}/api/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ subject: 'Tesco PLC', licence_type: 'business', jurisdiction: 'UK' }),
  });
  assert.equal(wrongType.status, 415);
  assert.equal((await wrongType.json()).error.code, 'UNSUPPORTED_MEDIA_TYPE');

  const longNumber = await call('/api/verify', {
    method: 'POST',
    body: { number: '1'.repeat(40), licence_type: 'contractor', jurisdiction: 'US-CA' },
  });
  assert.equal(longNumber.status, 400);
  assert.equal(longNumber.data.error.code, 'BAD_REQUEST');
});

test('API responses carry clickjacking and referrer protections', async () => {
  const { headers } = await call('/api/health');
  assert.equal(headers.get('x-frame-options'), 'DENY');
  assert.equal(headers.get('referrer-policy'), 'no-referrer');
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
});
