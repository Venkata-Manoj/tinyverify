import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';

/**
 * Monitor persistence.
 *
 * Production: Vercel KV / Upstash Redis REST when KV_REST_API_URL + KV_REST_API_TOKEN exist.
 * Local: an atomic JSON file under TINYVERIFY_DATA_DIR (gitignored).
 *
 * The whole document is small (hundreds of monitors at most), so a single
 * read-modify-write document is simpler and easier to reason about than a schema.
 */

const KV_KEY = 'tinyverify:monitors:v1';
const filePath = () => join(config.dataDir, 'monitors.json');
const emptyDoc = () => ({ version: 1, updated_at: new Date().toISOString(), monitors: [] });

let writeChain = Promise.resolve();

/** Serialise writes inside one process; KV still wins across instances. */
function withLock(fn) {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => {});
  return run;
}

async function kvCommand(command) {
  const res = await fetch(config.kvUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.kvToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok || data.error) {
    throw new Error(`KV command ${command[0]} failed: ${data.error || res.status}`);
  }
  return data.result;
}

async function readDoc() {
  if (config.kvUrl && config.kvToken) {
    const raw = await kvCommand(['GET', KV_KEY]);
    if (!raw) return emptyDoc();
    try { return normalizeDoc(JSON.parse(raw)); } catch { return emptyDoc(); }
  }
  try {
    const raw = await readFile(filePath(), 'utf8');
    return normalizeDoc(JSON.parse(raw));
  } catch (err) {
    if (err.code === 'ENOENT') return emptyDoc();
    throw err;
  }
}

function normalizeDoc(doc) {
  return {
    version: 1,
    updated_at: doc?.updated_at ?? new Date().toISOString(),
    monitors: Array.isArray(doc?.monitors) ? doc.monitors : [],
  };
}

async function writeDoc(doc) {
  const next = { ...doc, version: 1, updated_at: new Date().toISOString() };
  if (config.kvUrl && config.kvToken) {
    await kvCommand(['SET', KV_KEY, JSON.stringify(next)]);
    return next;
  }
  const target = filePath();
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await rename(tmp, target);
  return next;
}

export function storageKind() {
  return config.kvUrl && config.kvToken ? 'kv' : 'file';
}

export async function listMonitors() {
  const doc = await readDoc();
  return [...doc.monitors].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

export async function getMonitor(id) {
  const doc = await readDoc();
  return doc.monitors.find((m) => m.id === id) ?? null;
}

export async function findMonitorByTinyfishId(tinyfishId) {
  if (!tinyfishId) return null;
  const doc = await readDoc();
  return doc.monitors.find((m) => m.tinyfish_monitor_id === tinyfishId) ?? null;
}

export async function insertMonitor(monitor) {
  return withLock(async () => {
    const doc = await readDoc();
    if (doc.monitors.some((m) => m.id === monitor.id)) throw new Error(`Monitor ${monitor.id} already exists`);
    doc.monitors.push(monitor);
    await writeDoc(doc);
    return monitor;
  });
}

export async function updateMonitor(id, updater) {
  return withLock(async () => {
    const doc = await readDoc();
    const index = doc.monitors.findIndex((m) => m.id === id);
    if (index < 0) return null;
    const current = doc.monitors[index];
    const next = typeof updater === 'function' ? await updater(structuredClone(current)) : { ...current, ...updater };
    doc.monitors[index] = { ...next, id, updated_at: new Date().toISOString() };
    await writeDoc(doc);
    return doc.monitors[index];
  });
}

export async function removeMonitor(id) {
  return withLock(async () => {
    const doc = await readDoc();
    const index = doc.monitors.findIndex((m) => m.id === id);
    if (index < 0) return null;
    const [removed] = doc.monitors.splice(index, 1);
    await writeDoc(doc);
    return removed;
  });
}

export function appendEvent(monitor, event, limit = 50) {
  const events = Array.isArray(monitor.events) ? [event, ...monitor.events] : [event];
  return { ...monitor, events: events.slice(0, limit) };
}
