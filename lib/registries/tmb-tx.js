import { cleanText, CLOSE_THRESHOLD, classifyMatch, nameSimilarity, normalizeStatus } from '../normalize.js';
import { makeRecord } from '../schema.js';

/**
 * Texas Medical Board — licence lookup through the Board's official licence
 * extract on the Texas Open Data Portal (dataset tm3v-pfq9, published by TMB
 * and refreshed daily).
 *
 * The TMB public search is a stateful ASP.NET postback whose profile URL only
 * exists inside one browser session, so it cannot be cited as a durable source
 * link. The Board publishes the same licence fields here, with a stable URL per
 * query, which is what a verification result must carry.
 */

const DATASET = 'https://data.texas.gov/d/tm3v-pfq9';
const API = 'https://data.texas.gov/resource/tm3v-pfq9.json';
const SOURCE_NAME = 'Texas Medical Board';
const JURISDICTION = 'US-TX';
const LIMIT = 100;

const RECORD_NUMBER = /^[A-Z]{0,3}\d{2,10}$/;

const compactNumber = (value) => String(value ?? '').replace(/[\s-]/g, '').toUpperCase();

export function normalizeTmbNumber(value) {
  const compact = compactNumber(value);
  return RECORD_NUMBER.test(compact) ? compact : null;
}

/** TODO: name splitting is shared with other adapters; keep it local for now. */
function splitName(value) {
  const clean = cleanText(value);
  if (!clean) return { first: '', last: '' };
  if (clean.includes(',')) {
    const [last, ...rest] = clean.split(',');
    return { first: rest.join(' ').trim(), last: last.trim() };
  }
  const tokens = clean.split(' ').filter(Boolean);
  if (tokens.length === 1) return { first: '', last: tokens[0] };
  return { first: tokens.slice(0, -1).join(' '), last: tokens.at(-1) };
}

function displayName(row) {
  return cleanText([row.first_name, row.last_name, row.suffix].filter(Boolean).join(' '));
}

export function tmbStatus(row) {
  const detail = cleanText(row.registration_status || row.license_status) || null;
  const normalized = normalizeStatus(detail);
  if (normalized.status !== 'unknown') return normalized;
  if (/active/i.test(detail || '')) return { status: 'active', detail };
  if (/deceased|retired|terminated|surrendered/i.test(detail || '')) return { status: 'inactive', detail };
  return { status: 'unknown', detail };
}

/** One TMB dataset row -> the shared licence shape. */
export function parseTmbRow(row) {
  const number = compactNumber(row.license_number);
  const name = displayName(row);
  if (!number || !name) return null;
  const status = tmbStatus(row);
  const disciplineStatus = cleanText(row.disciplinary_status);
  const hasDiscipline = Boolean(disciplineStatus && !/^none$/i.test(disciplineStatus));
  const expiry = row.license_expiration_date ? String(row.license_expiration_date).slice(0, 10) : null;
  const issue = row.license_issue_date ? String(row.license_issue_date).slice(0, 10) : null;
  return {
    exists: true,
    number,
    name,
    degree: cleanText(row.degree) || null,
    licence_type: cleanText(row.license_type) || null,
    status: status.status,
    status_detail: status.detail,
    issue_date: issue,
    expiry_date: expiry,
    has_discipline: hasDiscipline,
    discipline: hasDiscipline ? disciplineStatus : null,
    currently_licensed: row.currently_licensed === 'Y',
    practice_city: cleanText(row.practice_city) || null,
    practice_state: cleanText(row.practice_state) || null,
    row,
  };
}

const recordUrl = (number) => `${API}?license_number=${encodeURIComponent(number)}`;

function apiUrl({ number, subject, state }) {
  const url = new URL(API);
  url.searchParams.set('$limit', String(LIMIT));
  url.searchParams.set('$order', 'last_name');
  if (number) {
    url.searchParams.set('license_number', number);
    return url.toString();
  }
  if (state) url.searchParams.set('practice_state', String(state).toUpperCase());
  const { first, last } = splitName(subject);
  if (last) url.searchParams.set('last_name', last.toUpperCase());
  // First names are stored with middle names ("JOHN FLINT"); an exact match on
  // the first token would miss them, so use a prefix search when possible.
  if (first) url.searchParams.set('$where', `upper(first_name) like '${first.toUpperCase().replace(/'/g, "''")}%'`);
  return url.toString();
}

async function fetchJson(url, fetchImpl) {
  const res = await fetchImpl(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'TinyVerify/0.3 (+https://tinyverify.vercel.app)',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`The Texas Medical Board data API returned HTTP ${res.status}.`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('The Texas Medical Board data API returned an unexpected payload.');
  return data;
}

export function createTmbTx({ fetchImpl = fetch } = {}) {
  const meta = {
    id: 'tmb-tx',
    name: SOURCE_NAME,
    source_name: SOURCE_NAME,
    kind: 'fetch-api',
    types: ['health'],
    jurisdictions: [JURISDICTION],
    source_url: DATASET,
    description: 'Texas Medical Board licence extract: licence status, number, issue and expiry dates, degree and disciplinary status.',
    fields: ['status', 'licence_number', 'expiry_date', 'disciplinary_actions', 'status_detail', 'degree'],
  };

  const registry = { meta, lookup: null };

  const toCandidate = (parsed, subject) => ({
    name: parsed.name,
    licence_number: parsed.number,
    jurisdiction: JURISDICTION,
    status: parsed.status,
    status_detail: parsed.status_detail,
    expiry_date: parsed.expiry_date,
    source_url: recordUrl(parsed.number),
    source_name: SOURCE_NAME,
    registry_id: meta.id,
    registry_name: meta.name,
    confidence: nameSimilarity(subject, parsed.name),
    extra: {
      licence_type: parsed.licence_type,
      degree: parsed.degree,
      issue_date: parsed.issue_date,
      has_discipline: parsed.has_discipline,
      discipline: parsed.discipline,
      practice_city: parsed.practice_city,
      practice_state: parsed.practice_state,
    },
  });

  const toRecord = (parsed, subject) => makeRecord({
    subject,
    licence_type: 'health',
    jurisdiction: JURISDICTION,
    status: parsed.status,
    licence_number: parsed.number,
    expiry_date: parsed.expiry_date,
    disciplinary_actions: parsed.has_discipline ? [parsed.discipline] : ['none found'],
    status_detail: parsed.status_detail,
    source_name: SOURCE_NAME,
    source_url: recordUrl(parsed.number),
    checked_at: new Date().toISOString(),
    match_quality: classifyMatch(subject, parsed.name),
    registry_id: meta.id,
    registry_name: meta.name,
    matched_name: parsed.name,
    exists: parsed.exists,
    confidence: nameSimilarity(subject, parsed.name),
    fields: {
      licence_number: parsed.number,
      licence_type: parsed.licence_type,
      degree: parsed.degree,
      status_detail: parsed.status_detail,
      issue_date: parsed.issue_date,
      expiry_date: parsed.expiry_date,
      currently_licensed: parsed.currently_licensed,
      has_discipline: parsed.has_discipline,
      discipline: parsed.discipline,
      practice_city: parsed.practice_city,
      practice_state: parsed.practice_state,
      dataset: DATASET,
    },
    notes: [
      'Read from the Texas Medical Board licence extract published on the Texas Open Data Portal. The extract is refreshed daily and is the Board-published record behind its Look Up a License tool.',
    ],
  });

  registry.lookup = async ({ subject, number, variant, state }) => {
    const normalised = number ? normalizeTmbNumber(number) : null;
    if (number && !normalised) {
      const error = new Error('A Texas Medical Board licence number must be letters plus digits (for example L5138).');
      error.status = 400;
      throw error;
    }

    const query = variant || subject;
    const url = apiUrl({ number: normalised, subject: query, state });
    const searched = [{ url, kind: 'api', via: 'https' }];
    const rows = await fetchJson(url, fetchImpl);
    const parsed = rows.map(parseTmbRow).filter(Boolean);

    if (normalised) {
      const found = parsed.find((item) => item.number === normalised);
      if (!found) {
        return {
          outcome: 'no_match',
          source_url: url,
          searched,
          candidates: [],
          total_found: 0,
          total_capped: false,
          total_display: null,
          detail: `The Texas Medical Board licence extract has no record for ${normalised}.`,
        };
      }
      return {
        outcome: 'match',
        record: toRecord(found, subject),
        source_url: recordUrl(found.number),
        total_found: 1,
        total_capped: false,
        total_display: null,
        searched,
        detail: `Fetched the Texas Medical Board licence record ${found.number}.`,
      };
    }

    const scored = parsed
      .map((item) => ({ parsed: item, confidence: nameSimilarity(subject, item.name) }))
      .sort((a, b) => b.confidence - a.confidence);
    const plausible = scored.filter((item) => item.confidence >= CLOSE_THRESHOLD);

    if (plausible.length === 1) {
      return {
        outcome: 'match',
        record: toRecord(plausible[0].parsed, subject),
        source_url: recordUrl(plausible[0].parsed.number),
        total_found: parsed.length,
        total_capped: false,
        total_display: null,
        searched,
        detail: `One plausible Texas Medical Board record matched "${query}".`,
      };
    }
    if (plausible.length > 1) {
      return {
        outcome: 'multiple',
        source_url: url,
        searched,
        total_found: parsed.length,
        total_capped: false,
        total_display: null,
        candidates: plausible.slice(0, 20).map(({ parsed: item }) => toCandidate(item, subject)),
        detail: `${plausible.length} Texas Medical Board records matched "${query}". Add a licence number to choose one.`,
      };
    }
    return {
      outcome: 'no_match',
      source_url: url,
      searched,
      total_found: parsed.length,
      total_capped: false,
      total_display: null,
      candidates: scored.slice(0, 5).map(({ parsed: item }) => toCandidate(item, subject)),
      detail: parsed.length
        ? `The Texas Medical Board returned ${parsed.length} record(s) for "${query}", but none matched closely enough to return without guessing.`
        : `The Texas Medical Board licence extract has no record for "${query}".`,
    };
  };

  return registry;
}

export const tmbTx = createTmbTx();
