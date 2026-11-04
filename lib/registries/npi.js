import { fetchPages } from '../tinyfish.js';
import { badNumber, classifyMatch, cleanText, nameSimilarity, normalizeName } from '../normalize.js';
import { makeRecord } from '../schema.js';

const HOME = 'https://npiregistry.cms.hhs.gov';
const API = `${HOME}/api/`;
const recordUrl = (npi) => `${HOME}/provider-view/${npi}`;

function apiUrls(subject, number) {
  const base = new URL(API);
  base.searchParams.set('version', '2.1');
  base.searchParams.set('limit', '10');
  if (number) {
    base.searchParams.set('number', String(number).replace(/\D/g, ''));
    return [base.toString()];
  }

  const clean = normalizeName(subject);
  const tokens = clean.split(' ').filter(Boolean);
  const params = [{ organization_name: clean }];
  if (tokens.length >= 2) {
    params.push({ first_name: tokens[0], last_name: tokens.slice(1).join(' ') });
    params.push({ first_name: tokens.slice(0, -1).join(' '), last_name: tokens.at(-1) });
    params.push({ first_name: tokens[0], last_name: tokens.at(-1) });
  } else if (tokens.length === 1) {
    params.push({ last_name: tokens[0] });
  }

  const urls = [];
  const seen = new Set();
  for (const entry of params) {
    const url = new URL(base);
    for (const [key, value] of Object.entries(entry)) url.searchParams.set(key, value);
    const href = url.toString();
    if (!seen.has(href)) { seen.add(href); urls.push(href); }
  }
  return urls.slice(0, 5);
}

function parseJsonPayload(text) {
  const raw = String(text || '').replace(/\\_/g, '_');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
}

function displayName(result) {
  const basic = result.basic || {};
  if (result.enumeration_type === 'NPI-2' || basic.organization_name) {
    return cleanText(basic.organization_name || '');
  }
  return cleanText([basic.first_name, basic.middle_name, basic.last_name, basic.credential].filter(Boolean).join(' '));
}

/** Turn one NPPES result object into the fields TinyVerify returns. */
export function parseNpiResult(result) {
  const basic = result.basic || {};
  const name = displayName(result);
  const number = String(result.number || '');
  const taxonomies = result.taxonomies || [];
  const primary = taxonomies.find((t) => t.primary) || taxonomies[0] || null;
  const location = (result.addresses || []).find((a) => a.address_purpose === 'LOCATION') || (result.addresses || [])[0] || null;
  const statusDetail = basic.status === 'A' ? 'Active (NPPES)' : basic.status === 'I' ? 'Inactive (NPPES)' : basic.status ? `NPPES status ${basic.status}` : 'Unknown (NPPES)';
  const status = basic.status === 'A' ? 'active' : basic.status === 'I' ? 'expired' : 'unknown';

  const address = location
    ? cleanText([location.address_1, location.address_2, `${location.city || ''}, ${location.state || ''} ${location.postal_code || ''}`.trim(), location.country_name].filter(Boolean).join(', '))
    : null;

  return {
    name,
    number,
    status,
    status_detail: statusDetail,
    fields: {
      npi: number,
      enumeration_type: result.enumeration_type === 'NPI-2' ? 'Organisation (NPI-2)' : 'Individual (NPI-1)',
      enumeration_date: basic.enumeration_date || null,
      last_updated: basic.last_updated || null,
      certification_date: basic.certification_date || null,
      sole_proprietor: basic.sole_proprietor || null,
      primary_taxonomy: primary?.desc || null,
      taxonomy_code: primary?.code || null,
      state_licence_number: primary?.license || null,
      state_licence_state: primary?.state || null,
      location_address: address,
      phone: location?.telephone_number || null,
    },
    notes: [
      'NPPES confirms the NPI record and its enrolment status. It does not publish state licence status, expiry dates or disciplinary actions; check the relevant state licensing board for those.',
    ],
  };
}

function toCandidate(parsed, subject) {
  return {
    name: parsed.name,
    licence_number: parsed.number,
    jurisdiction: 'US',
    status: parsed.status,
    status_detail: parsed.status_detail,
    source_url: recordUrl(parsed.number),
    source_name: 'US NPPES NPI Registry',
    registry_name: 'US NPPES NPI Registry',
    registry_id: 'npi-us',
    confidence: nameSimilarity(subject, parsed.name),
    extra: {
      primary_taxonomy: parsed.fields.primary_taxonomy,
      state_licence_number: parsed.fields.state_licence_number,
      state_licence_state: parsed.fields.state_licence_state,
    },
  };
}

function toRecord(parsed, subject, confidence) {
  return makeRecord({
    subject,
    licence_type: 'health',
    jurisdiction: 'US',
    status: parsed.status,
    licence_number: parsed.number,
    expiry_date: null,
    disciplinary_actions: ['none found'],
    source_name: 'US NPPES NPI Registry',
    source_url: recordUrl(parsed.number),
    checked_at: new Date().toISOString(),
    match_quality: classifyMatch(subject, parsed.name),
    registry_id: 'npi-us',
    registry_name: 'US NPPES NPI Registry',
    status_detail: parsed.status_detail,
    matched_name: parsed.name,
    confidence,
    fields: parsed.fields,
    notes: parsed.notes,
  });
}

export const npi = {
  meta: {
    id: 'npi-us',
    name: 'US NPPES NPI Registry',
    source_name: 'US NPPES NPI Registry',
    kind: 'fetch-api',
    types: ['health'],
    jurisdictions: ['US'],
    source_url: HOME,
    description: 'US federal NPI registry (NPPES): provider name, NPI number, active enrolment status, taxonomy and state licence number.',
    fields: ['status', 'licence_number', 'expiry_date (n/a)', 'disciplinary_actions (n/a)', 'taxonomy', 'state licence number'],
  },

  async lookup({ subject, number, variant }) {
    const query = variant || subject;
    if (number && !/^\d{10}$/.test(String(number).replace(/\D/g, ''))) {
      throw badNumber('An NPI must be exactly 10 digits (for example 1295346773).');
    }
    const urls = apiUrls(query, number);
    const pages = await fetchPages(urls, { format: 'html', ttl: 0 });
    const searched = urls.map((url) => ({ url, kind: 'api', via: 'tinyfish-fetch' }));

    const byNumber = new Map();
    for (const page of pages) {
      const payload = parseJsonPayload(page.text);
      for (const result of payload?.results || []) {
        if (result?.number && !byNumber.has(String(result.number))) byNumber.set(String(result.number), result);
      }
    }

    const parsed = [...byNumber.values()]
      .map((result) => ({ result, parsed: parseNpiResult(result) }))
      .filter(({ parsed: p }) => p.number && p.name)
      .map(({ parsed: p }) => ({ ...p, confidence: nameSimilarity(subject, p.name) }))
      .sort((a, b) => b.confidence - a.confidence);

    if (number) {
      const found = parsed.find((p) => p.number === String(number).replace(/\D/g, ''));
      if (!found) {
        return { outcome: 'no_match', source_url: `${API}?version=2.1&number=${encodeURIComponent(number)}`, searched, candidates: [], detail: `NPPES returned no record for NPI ${number}.` };
      }
      return {
        outcome: 'match',
        record: toRecord(found, subject, found.confidence),
        source_url: recordUrl(found.number),
        searched,
        detail: `Fetched NPPES record ${found.number} directly.`,
      };
    }

    const plausible = parsed.filter((p) => p.confidence >= 0.62);
    if (plausible.length === 1) {
      const found = plausible[0];
      return {
        outcome: 'match',
        record: toRecord(found, subject, found.confidence),
        source_url: recordUrl(found.number),
        searched,
        detail: `One plausible NPPES record among ${parsed.length} results.`,
      };
    }
    if (plausible.length > 1) {
      return {
        outcome: 'multiple',
        source_url: `${HOME}/`,
        searched,
        candidates: plausible.slice(0, 10).map((p) => toCandidate(p, subject)),
        detail: `${plausible.length} NPPES provider records matched "${query}".`,
      };
    }
    if (parsed.length) {
      return {
        outcome: 'no_match',
        source_url: `${HOME}/`,
        searched,
        candidates: parsed.slice(0, 5).map((p) => toCandidate(p, subject)),
        detail: `NPPES returned ${parsed.length} records, but none matched "${query}" closely enough to return without guessing.`,
      };
    }
    return {
      outcome: 'no_match',
      source_url: `${HOME}/`,
      searched,
      candidates: [],
      detail: `NPPES returned no provider record for "${query}". Try a full legal name or an NPI number.`,
    };
  },
};
