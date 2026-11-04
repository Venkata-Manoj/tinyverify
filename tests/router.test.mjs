import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = await mkdtemp(join(tmpdir(), 'tinyverify-router-'));
process.env.TINYVERIFY_DATA_DIR = dataDir;
process.env.TINYVERIFY_LOG = '0';

const { handleRequest } = await import('../lib/router.js');

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

test('GET /api/health reports configuration without leaking the key', async () => {
  const { status, data } = await call('/api/health');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(typeof data.api_key_configured, 'boolean');
  assert.equal(typeof data.storage, 'string');
});

test('GET /api/registries exposes the live coverage matrix', async () => {
  const { status, data } = await call('/api/registries');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.deepEqual(data.registries.map((r) => r.id).sort(), ['companies-house-uk', 'cslb-ca', 'npi-us', 'nz-companies']);
  assert.deepEqual(data.combinations.map((c) => `${c.licence_type}/${c.jurisdiction}`).sort(), [
    'business/NZ',
    'business/UK',
    'contractor/US-CA',
    'health/US',
  ]);
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

test('GET /api/monitors starts empty and the webhook ignores unknown ids', async () => {
  const list = await call('/api/monitors');
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.monitors, []);

  const hook = await call('/api/webhooks/tinyfish', { method: 'POST', body: { monitor_id: 'not-ours', event: 'change' } });
  assert.equal(hook.status, 200);
  assert.equal(hook.data.ignored, true);
});

test('unknown routes return a JSON 404 and CORS preflight is handled', async () => {
  const missing = await call('/api/nope');
  assert.equal(missing.status, 404);
  assert.equal(missing.data.error.code, 'NOT_FOUND');

  const preflight = await call('/api/verify', { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
});
