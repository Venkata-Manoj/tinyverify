import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { verify, HttpError } from './verify.js';
import { snapshotOf, diffSnapshots, summarizeChange } from './schema.js';
import {
  createMonitor as createTinyfishMonitor,
  deleteMonitor as deleteTinyfishMonitor,
  runMonitor as runTinyfishMonitor,
} from './tinyfish.js';
import {
  appendEvent,
  findMonitorByTinyfishId,
  getMonitor,
  insertMonitor,
  listMonitors,
  removeMonitor,
  updateMonitor,
} from './store.js';

const newId = (prefix) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

function httpsOrigin(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Resolve our public origin from configuration, never from the request Host.
 * A forged Host header must not be able to point TinyFish's webhook at an
 * attacker-controlled domain.
 */
function publicBaseUrl() {
  const withScheme = (value) => {
    if (!value) return null;
    return /^https?:\/\//i.test(value) ? value : `https://${value}`;
  };
  const candidates = [
    process.env.TINYVERIFY_PUBLIC_URL,
    withScheme(process.env.VERCEL_PROJECT_PRODUCTION_URL),
    withScheme(process.env.VERCEL_URL),
  ];
  for (const candidate of candidates) {
    const origin = httpsOrigin(candidate);
    if (origin) return origin;
  }
  return null;
}

function webhookUrlFor() {
  const base = publicBaseUrl();
  return base ? `${base}/api/webhooks/tinyfish` : null;
}

function monitorSummary(monitor) {
  const { events, owner_hash: _ownerHash, ...rest } = monitor;
  return { ...rest, event_count: Array.isArray(events) ? events.length : 0 };
}

function assertOwner(monitor, ownerHash) {
  if (monitor.owner_hash && monitor.owner_hash !== ownerHash) {
    throw new HttpError(404, 'NOT_FOUND', `No monitor with id ${monitor.id}.`);
  }
}

function pickRecord(verification) {
  if (verification?.primary) return verification.primary;
  const confident = (verification?.results ?? []).filter((r) => r.match_quality === 'exact' || r.match_quality === 'close');
  return confident.length === 1 ? confident[0] : null;
}

export async function createWatch(input, {
  verifyFn = verify,
  createMonitorFn = createTinyfishMonitor,
  ownerHash = null,
} = {}) {
  const verification = await verifyFn(input, { refresh: true });
  const record = pickRecord(verification);
  if (!record) {
    throw new HttpError(
      422,
      'NO_CONFIRMED_RECORD',
      verification.match_quality === 'multiple'
        ? 'Multiple records matched. Choose a specific record or add a registration number before watching it.'
        : 'No confirmed record was found, so there is nothing to watch yet.',
      { verification },
    );
  }

  const now = new Date().toISOString();
  const monitor = {
    id: newId('mon'),
    subject: record.subject,
    licence_type: record.licence_type,
    jurisdiction: record.jurisdiction,
    number: record.licence_number,
    registry_id: record.registry_id,
    registry_name: record.registry_name ?? record.source_name,
    source_name: record.source_name,
    source_url: record.source_url,
    schedule_cron: config.monitorCron,
    status: 'active',
    created_at: now,
    updated_at: now,
    last_checked_at: record.checked_at ?? now,
    last_check: { ok: true, at: now, note: 'Baseline captured from a live verification.' },
    last_error: null,
    snapshot: snapshotOf(record),
    events: [],
    owner_hash: ownerHash,
    tinyfish_monitor_id: null,
    tinyfish_monitor_status: null,
    baseline: {
      status: record.status,
      status_detail: record.status_detail,
      matched_name: record.matched_name,
    },
  };

  // The TinyFish Monitor re-reads the official source on a schedule and can
  // call our webhook. If TinyFish is unavailable we still keep a local watch
  // that works through "Check now".
  try {
    const created = await createMonitorFn({
      name: `TinyVerify - ${record.matched_name || record.subject} (${record.licence_number || record.registry_id})`,
      type: 'fetch',
      config: { url: record.source_url, format: 'markdown', links: false, image_links: false, ttl: 0 },
      scheduleCron: config.monitorCron,
      purpose: `Watch the official ${record.source_name} record for ${record.subject} and alert TinyVerify when status or licence details change.`,
      webhookUrl: webhookUrlFor(),
    });
    const tiny = created?.monitor ?? created;
    if (tiny?.id) {
      monitor.tinyfish_monitor_id = tiny.id;
      monitor.tinyfish_monitor_status = tiny.status ?? 'active';
    }
  } catch (err) {
    monitor.last_error = `TinyFish Monitor was not created: ${err.message}`;
  }

  await insertMonitor(monitor);
  return { monitor: monitorSummary(monitor), record };
}

export async function listWatches({ ownerHash } = {}) {
  const monitors = await listMonitors();
  const visible = ownerHash === undefined
    ? monitors
    : ownerHash
      ? monitors.filter((monitor) => monitor.owner_hash === ownerHash)
      : [];
  return visible.map(monitorSummary);
}

export async function getWatch(id, { ownerHash } = {}) {
  const monitor = await getMonitor(id);
  if (!monitor) throw new HttpError(404, 'NOT_FOUND', `No monitor with id ${id}.`);
  assertOwner(monitor, ownerHash);
  return { monitor: monitorSummary(monitor), events: monitor.events ?? [] };
}

function nextRecord(verification) {
  const record = pickRecord(verification);
  if (record) return record;
  // One remaining result with no ambiguity is still a valid re-read.
  return verification?.results?.length === 1 ? verification.results[0] : null;
}

export async function checkWatch(id, { verifyFn = verify, runTinyfish = true, ownerHash } = {}) {
  const monitor = await getMonitor(id);
  if (!monitor) throw new HttpError(404, 'NOT_FOUND', `No monitor with id ${id}.`);
  assertOwner(monitor, ownerHash);

  const checkedAt = new Date().toISOString();
  const query = {
    subject: monitor.subject,
    licence_type: monitor.licence_type,
    jurisdiction: monitor.jurisdiction,
    number: monitor.number || undefined,
  };

  const tinyfishPromise = runTinyfish && monitor.tinyfish_monitor_id
    ? runTinyfishMonitor(monitor.tinyfish_monitor_id).then(
      (result) => ({ ok: true, run_id: result?.run?.id ?? result?.run_id ?? result?.id ?? null }),
      (err) => ({ ok: false, error: err.message }),
    )
    : Promise.resolve(null);

  let verification;
  let verifyError = null;
  try {
    verification = await verifyFn(query, { refresh: true });
  } catch (err) {
    verifyError = err;
  }

  const tinyfishRun = await tinyfishPromise;

  let nextMonitor = {
    ...monitor,
    last_checked_at: checkedAt,
    last_tinyfish_run: tinyfishRun ? { ...tinyfishRun, at: checkedAt } : monitor.last_tinyfish_run ?? null,
  };

  if (verifyError || !verification) {
    nextMonitor.last_check = {
      ok: false,
      at: checkedAt,
      note: `Live re-check failed: ${verifyError?.message ?? 'unknown error'}. The previous snapshot was kept.`,
    };
    nextMonitor.last_error = verifyError?.message ?? 'Live re-check failed';
    const updated = await updateMonitor(id, nextMonitor);
    return { event: null, monitor: monitorSummary(updated), note: nextMonitor.last_check.note };
  }

  const record = nextRecord(verification);
  if (!record) {
    // A transient search miss must not be reported as a licence change.
    nextMonitor.last_check = {
      ok: false,
      at: checkedAt,
      note: 'The registry returned no confident record on this check. The previous snapshot was kept; this is not reported as a change.',
    };
    nextMonitor.last_error = 'No confident record on re-check';
    const updated = await updateMonitor(id, nextMonitor);
    return { event: null, monitor: monitorSummary(updated), note: nextMonitor.last_check.note };
  }

  const nextSnapshot = snapshotOf(record);
  const diff = diffSnapshots(monitor.snapshot, nextSnapshot);
  nextMonitor.snapshot = nextSnapshot;
  nextMonitor.last_check = {
    ok: true,
    at: checkedAt,
    note: diff.changed_fields.length ? summarizeChange(diff) : 'No change since the previous check.',
  };
  nextMonitor.last_error = null;
  nextMonitor.number = record.licence_number ?? nextMonitor.number;
  nextMonitor.source_url = record.source_url;
  nextMonitor.registry_name = record.registry_name ?? nextMonitor.registry_name;

  let event = null;
  if (diff.changed_fields.length) {
    event = {
      id: newId('evt'),
      changed_fields: diff.changed_fields,
      old: diff.old,
      new: diff.new,
      checked_at: checkedAt,
      source_url: record.source_url,
      registry_name: record.registry_name ?? record.source_name,
      summary: summarizeChange(diff),
      detected_by: 'TinyVerify live re-check',
    };
    nextMonitor = appendEvent(nextMonitor, event);
  }

  const updated = await updateMonitor(id, nextMonitor);
  return {
    event,
    monitor: monitorSummary(updated),
    note: event ? event.summary : 'No change since the previous check.',
  };
}

export async function deleteWatch(id, { deleteMonitorFn = deleteTinyfishMonitor, ownerHash } = {}) {
  const monitor = await getMonitor(id);
  if (!monitor) throw new HttpError(404, 'NOT_FOUND', `No monitor with id ${id}.`);
  assertOwner(monitor, ownerHash);

  let tinyfishDeleted = false;
  let tinyfishError = null;
  if (monitor.tinyfish_monitor_id) {
    try {
      await deleteMonitorFn(monitor.tinyfish_monitor_id);
      tinyfishDeleted = true;
    } catch (err) {
      tinyfishError = err.message;
    }
  }
  await removeMonitor(id);
  return { deleted: true, id, tinyfish_deleted: tinyfishDeleted, tinyfish_error: tinyfishError };
}

/**
 * TinyFish calls this when a scheduled Monitor run detects a change.
 * We never trust the payload as the source of truth: the record is re-read and
 * diffed against the stored snapshot before any event is created.
 */
export async function handleTinyfishWebhook(payload) {
  const tinyfishId = payload?.monitor_id
    || payload?.monitorId
    || payload?.monitor?.id
    || payload?.id
    || null;
  if (!tinyfishId) return { ok: true, ignored: true, reason: 'No monitor id in payload.' };

  const monitor = await findMonitorByTinyfishId(tinyfishId);
  if (!monitor) {
    // The TinyFish monitor may be stale, or this instance has no local state.
    return { ok: true, ignored: true, reason: `No local watch for TinyFish monitor ${tinyfishId}.` };
  }
  // TinyFish just ran the monitor; do not start another run from the webhook
  // (that would be a paid round trip and could loop). Re-read the source only.
  const result = await checkWatch(monitor.id, { ownerHash: monitor.owner_hash, runTinyfish: false });
  return { ok: true, ignored: false, monitor_id: monitor.id, event: result.event };
}

export { monitorSummary };
