import { disciplinaryList, statusBounty } from './normalize.js';

export const STATUSES = ['active', 'expired', 'suspended', 'revoked', 'dissolved', 'in_liquidation', 'inactive', 'unknown'];
export const MATCH_QUALITIES = ['exact', 'close', 'mismatch', 'multiple', 'no_match', 'unsupported'];
export const SNAPSHOT_FIELDS = ['status', 'licence_number', 'expiry_date', 'disciplinary_actions', 'status_detail'];

const asArray = (value) => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);
const plainObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

/** A missing count must stay null; Number(null) would silently become 0. */
export function finiteCount(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function disciplinaryRecords(value) {
  return asArray(value)
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    .map((item) => ({
      type: String(item.type ?? '').trim() || 'disciplinary action',
      date: item.date ?? null,
      description: String(item.description ?? '').trim() || null,
      status: String(item.status ?? '').trim() || null,
      source_url: String(item.source_url ?? '').trim() || null,
    }))
    .filter((item) => item.description || item.status || item.date);
}

/**
 * Build the public record shape. Extra fields are additive; the core §1.1 keys are always present.
 */
export function makeRecord(input = {}) {
  const status = STATUSES.includes(input.status) ? input.status : 'unknown';
  const matchQuality = MATCH_QUALITIES.includes(input.match_quality) ? input.match_quality : 'no_match';
  const record = {
    subject: String(input.subject ?? '').trim(),
    licence_type: String(input.licence_type ?? '').trim(),
    jurisdiction: String(input.jurisdiction ?? '').trim(),
    status,
    status_bounty: statusBounty(status),
    licence_number: input.licence_number ? String(input.licence_number).trim() : null,
    expiry_date: input.expiry_date || null,
    disciplinary_actions: disciplinaryList(input.disciplinary_actions),
    disciplinary_records: disciplinaryRecords(input.disciplinary_records),
    source_name: String(input.source_name ?? '').trim(),
    source_url: String(input.source_url ?? '').trim(),
    checked_at: input.checked_at || new Date().toISOString(),
    match_quality: matchQuality,
    name_number_mismatch: Boolean(input.name_number_mismatch),
    registry_id: input.registry_id ?? null,
    registry_name: input.registry_name ?? input.source_name ?? null,
    status_detail: input.status_detail ?? null,
    matched_name: input.matched_name ?? null,
    variant_used: input.variant_used ?? null,
    confidence: typeof input.confidence === 'number' ? Math.round(input.confidence * 100) / 100 : null,
    total_found: finiteCount(input.total_found),
    cached: Boolean(input.cached),
    cache_age_seconds: Number(input.cache_age_seconds || 0),
    fields: plainObject(input.fields),
    notes: asArray(input.notes).map(String),
  };
  assertRecord(record);
  return record;
}

export function assertRecord(record) {
  const missing = ['subject', 'licence_type', 'jurisdiction', 'source_name', 'source_url', 'checked_at', 'match_quality']
    .filter((key) => record[key] === undefined || record[key] === null || record[key] === '');
  if (missing.length) throw new Error(`Record is missing required fields: ${missing.join(', ')}`);
  if (!STATUSES.includes(record.status)) throw new Error(`Invalid status: ${record.status}`);
  if (!MATCH_QUALITIES.includes(record.match_quality)) throw new Error(`Invalid match_quality: ${record.match_quality}`);
  if (!/^https?:\/\//.test(record.source_url)) throw new Error('source_url must be an http(s) URL');
  if (Number.isNaN(Date.parse(record.checked_at))) throw new Error('checked_at must be an ISO timestamp');
  return record;
}

/** The subset TinyVerify watches for changes. Keep this stable: monitor events depend on it. */
export function snapshotOf(record) {
  const snap = {};
  for (const field of SNAPSHOT_FIELDS) {
    const value = record?.[field];
    snap[field] = Array.isArray(value) ? [...value] : value ?? null;
  }
  return snap;
}

const canonical = (value) => JSON.stringify(value ?? null);

export function diffSnapshots(previous, next) {
  const before = previous ?? {};
  const after = next ?? {};
  const changed = SNAPSHOT_FIELDS.filter((field) => canonical(before[field]) !== canonical(after[field]));
  const oldValues = {};
  const newValues = {};
  for (const field of changed) {
    oldValues[field] = before[field] ?? null;
    newValues[field] = after[field] ?? null;
  }
  return { changed_fields: changed, old: oldValues, new: newValues };
}

const LABELS = {
  status: 'Status',
  licence_number: 'Licence / record number',
  expiry_date: 'Expiry date',
  disciplinary_actions: 'Disciplinary actions',
  status_detail: 'Status detail',
};

export function summarizeChange(diff) {
  if (!diff.changed_fields.length) return 'No change';
  return diff.changed_fields.map((field) => {
    const label = LABELS[field] ?? field;
    const oldValue = Array.isArray(diff.old[field]) ? diff.old[field].join('; ') : diff.old[field];
    const newValue = Array.isArray(diff.new[field]) ? diff.new[field].join('; ') : diff.new[field];
    return `${label} changed from ${oldValue ?? 'none'} to ${newValue ?? 'none'}`;
  }).join('. ');
}

/**
 * Never merge disagreeing registries silently: a conflict becomes status=unknown
 * with both records and an explicit note.
 */
export function reconcileStatuses(records) {
  const usable = (records ?? []).filter((r) => r && r.match_quality !== 'no_match');
  const statuses = [...new Set(usable.map((r) => r.status).filter((s) => s !== 'unknown'))];
  if (usable.length > 1 && statuses.length > 1) {
    return {
      status: 'unknown',
      conflict: true,
      note: `Registries disagree: ${usable.map((r) => `${r.source_name} reports ${r.status}`).join('; ')}. Both records are returned unchanged.`,
    };
  }
  return { status: statuses[0] ?? 'unknown', conflict: false, note: null };
}
