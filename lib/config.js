import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Local development reads .env; deployed environments use real env vars.
try {
  const raw = readFileSync(join(ROOT, '.env'), 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const key = trimmed.slice(0, trimmed.indexOf('=')).trim();
    const value = trimmed.slice(trimmed.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
} catch {
  // No .env (production) — fine.
}

const bool = (v, fallback = false) => (v === undefined ? fallback : /^(1|true|yes)$/i.test(v));

export const config = {
  apiKey: process.env.TINYFISH_API_KEY || '',
  webhookSecret: process.env.TINYVERIFY_WEBHOOK_SECRET || '',
  monitorCron: process.env.TINYVERIFY_MONITOR_CRON || '0 8 * * *',
  monitorTimezone: process.env.TINYVERIFY_MONITOR_TZ || '',
  dataDir: process.env.TINYVERIFY_DATA_DIR || (process.env.VERCEL ? '/tmp/tinyverify' : join(ROOT, 'data')),
  cacheTtlSeconds: Number(process.env.TINYVERIFY_CACHE_TTL || 600),
  maxVariants: Number(process.env.TINYVERIFY_MAX_VARIANTS || 2),
  agentMaxSeconds: Number(process.env.TINYVERIFY_AGENT_MAX_SECONDS || 180),
  allowAgent: bool(process.env.TINYVERIFY_ALLOW_AGENT, true),
  allowDiscovery: bool(process.env.TINYVERIFY_ALLOW_DISCOVERY, true),
  kvUrl: process.env.KV_REST_API_URL || '',
  kvToken: process.env.KV_REST_API_TOKEN || '',
  version: '0.1.0',
};

export function assertApiKey() {
  if (!config.apiKey) {
    const err = new Error('TINYFISH_API_KEY is not configured. Copy .env.example to .env and add your key.');
    err.status = 500;
    err.code = 'NO_API_KEY';
    throw err;
  }
}
