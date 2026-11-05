// Phase 0 proof: exercise the raw TinyFish endpoints and save real samples.
// Run: node spikes/api-proof.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(
  readFileSync(join(root, '.env'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
);
const KEY = env.TINYFISH_API_KEY;
if (!KEY) throw new Error('TINYFISH_API_KEY missing from .env');

const out = { ran_at: new Date().toISOString(), steps: [] };
const save = () => writeFileSync(join(root, 'spikes', 'api-proof.json'), JSON.stringify(out, null, 2));

async function step(name, fn) {
  const started = Date.now();
  try {
    const value = await fn();
    out.steps.push({ name, ok: true, ms: Date.now() - started, value });
    console.log(`PASS ${name} (${Date.now() - started}ms)`);
    return value;
  } catch (err) {
    out.steps.push({ name, ok: false, ms: Date.now() - started, error: String(err) });
    console.log(`FAIL ${name}: ${err}`);
  } finally {
    save();
  }
}

await step('search', async () => {
  const url = new URL('https://api.search.tinyfish.ai');
  url.searchParams.set('query', 'UK General Medical Council check a doctor registration');
  url.searchParams.set('location', 'GB');
  url.searchParams.set('language', 'en');
  const res = await fetch(url, { headers: { 'X-API-Key': KEY } });
  const body = await res.json();
  return { status: res.status, results: (body.results ?? []).slice(0, 3) };
});

const CH_URL = 'https://find-and-update.company-information.service.gov.uk/company/00445790';
await step('fetch', async () => {
  const res = await fetch('https://api.fetch.tinyfish.ai', {
    method: 'POST',
    headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls: [CH_URL], format: 'markdown' }),
  });
  const body = await res.json();
  const text = body.results?.[0]?.text ?? '';
  return { status: res.status, text_head: text.slice(0, 1200), text_len: text.length, errors: body.errors };
});

await step('agent', async () => {
  const res = await fetch('https://agent.tinyfish.ai/v1/automation/run', {
    method: 'POST',
    headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: CH_URL,
      goal: 'Extract the company name, company number, company status, incorporation date, and registered office address. Return JSON with keys company_name, company_number, status, incorporation_date, registered_office.',
      output_schema: {
        type: 'object',
        properties: {
          company_name: { type: 'string' },
          company_number: { type: 'string' },
          status: { type: 'string' },
          incorporation_date: { type: 'string' },
          registered_office: { type: 'string' },
        },
        required: ['company_name', 'company_number', 'status'],
      },
      agent_config: { max_duration_seconds: 120 },
    }),
  });
  const body = await res.json();
  return { status: res.status, run_status: body.status, result: body.result, error: body.error, steps: body.num_of_steps };
});

await step('monitor_create', async () => {
  const res = await fetch('https://agent.tinyfish.ai/v1/monitors', {
    method: 'POST',
    headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'fetch',
      name: 'TinyVerify spike - Companies House',
      config: { url: CH_URL, format: 'markdown' },
      schedule_cron: '0 8 * * *',
      purpose: 'The company status or registered details change',
    }),
  });
  const body = await res.json();
  return { status: res.status, monitor: body.monitor, baseline_run: body.run ? { id: body.run.id, is_baseline: body.run.is_baseline, text_head: body.run.results?.[0]?.text?.slice(0, 300) } : null };
});

await step('monitor_run_and_delete', async () => {
  const monitors = await (await fetch('https://agent.tinyfish.ai/v1/monitors', { headers: { 'X-API-Key': KEY } })).json();
  const mine = (monitors.monitors ?? []).find((m) => m.name?.startsWith('TinyVerify spike'));
  if (!mine) throw new Error('spike monitor not found');
  const run = await (await fetch(`https://agent.tinyfish.ai/v1/monitors/${mine.id}/runs`, { method: 'POST', headers: { 'X-API-Key': KEY } })).json();
  const del = await (await fetch(`https://agent.tinyfish.ai/v1/monitors/${mine.id}`, { method: 'DELETE', headers: { 'X-API-Key': KEY } })).json();
  return { monitor_id: mine.id, run_id: run.run?.id, run_text_head: run.run?.results?.[0]?.text?.slice(0, 300), deleted: del };
});

console.log('\nSaved spikes/api-proof.json');
