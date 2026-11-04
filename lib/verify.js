import { config } from './config.js';
import { cached } from './cache.js';
import { nameSimilarity, nameVariants } from './normalize.js';
import { coverageMatrix, normalizeJurisdiction, normalizeType, registryById, resolveRegistries } from './registry.js';
import { reconcileStatuses } from './schema.js';

export class HttpError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const MAX_SUBJECT = 200;
const MAX_NUMBER = 32;
const MAX_FIELD = 40;

function validate(input) {
  const subject = String(input?.subject ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  const number = input?.number ? String(input.number).replace(/[\u0000-\u001f]/g, '').trim() : null;
  const licenceType = normalizeType(input?.licence_type);
  const jurisdiction = normalizeJurisdiction(input?.jurisdiction);

  if (!subject && !number) throw new HttpError(400, 'BAD_REQUEST', 'Provide a person or business name (or a registration number).');
  if (subject.length > MAX_SUBJECT) throw new HttpError(400, 'BAD_REQUEST', `Name must be ${MAX_SUBJECT} characters or fewer.`);
  if (number && number.length > MAX_NUMBER) throw new HttpError(400, 'BAD_REQUEST', `Registration number must be ${MAX_NUMBER} characters or fewer.`);
  if (String(input?.licence_type ?? '').length > MAX_FIELD || String(input?.jurisdiction ?? '').length > MAX_FIELD) {
    throw new HttpError(400, 'BAD_REQUEST', 'licence_type and jurisdiction must be short names (40 characters or fewer).');
  }
  if (!licenceType) throw new HttpError(400, 'BAD_REQUEST', 'licence_type is required (business, contractor, health).');
  if (!jurisdiction) throw new HttpError(400, 'BAD_REQUEST', 'jurisdiction is required (UK, US, US-CA).');

  return {
    subject: subject || `registration ${number}`,
    subject_provided: Boolean(subject),
    number,
    licence_type: licenceType,
    jurisdiction,
  };
}

function dedupeBy(list, keyFn) {
  const seen = new Set();
  return list.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function runVerification(query, registries) {
  const started = Date.now();
  const variants = nameVariants(query.subject);
  const attempts = [variants[0], ...variants.slice(1, 1 + Math.max(0, config.maxVariants))].filter(Boolean);

  const records = [];
  const candidates = [];
  const nearMisses = [];
  const notes = [];
  const errors = [];
  const registryOutcomes = [];

  for (const registry of registries) {
    let outcome = null;
    let usedVariant = attempts[0];
    let lastError = null;

    for (const variant of attempts) {
      try {
        const result = await registry.lookup({ ...query, variant: variant.value });
        if (result.outcome === 'match' || result.outcome === 'multiple') {
          outcome = result;
          usedVariant = variant;
          break;
        }
        outcome = result;
        usedVariant = variant;
      } catch (err) {
        // A malformed registration number is the caller's error, not a registry
        // outage. Surface it instead of disguising it as "no match".
        if (err?.status === 400) throw err;
        lastError = err;
        break;
      }
    }

    if (!outcome) {
      const message = lastError?.message || 'Registry lookup failed';
      errors.push({ registry_id: registry.meta.id, registry_name: registry.meta.name, message });
      registryOutcomes.push({
        registry_id: registry.meta.id,
        registry_name: registry.meta.name,
        outcome: 'error',
        source_url: registry.meta.source_url,
        detail: message,
      });
      notes.push(`${registry.meta.name}: ${message}`);
      continue;
    }

    if (outcome.outcome === 'match' && outcome.record) {
      const record = outcome.record;

      // A registration number is an identity, not a fuzzy name search. If the
      // caller also supplied a name and it does not resemble the official name,
      // say so instead of claiming an exact name match.
      if (query.number) {
        const similarity = query.subject_provided
          ? nameSimilarity(query.subject, record.matched_name || record.subject)
          : 1;
        record.confidence = similarity;
        record.match_quality = 'exact';
        if (query.subject_provided && similarity < 0.62) {
          record.match_quality = 'close';
          record.notes.push('The name entered does not closely match the official record. The record was returned because the registration number matched; confirm the number before relying on it.');
        }
      }

      if (usedVariant && usedVariant.reason !== 'as entered') {
        record.notes.push(`Matched using name variant "${usedVariant.value}" (${usedVariant.reason}).`);
        record.variant_used = usedVariant.value;
      }
      record.registry_id = registry.meta.id;
      record.registry_name = registry.meta.name;
      records.push(record);
      registryOutcomes.push({
        registry_id: registry.meta.id,
        registry_name: registry.meta.name,
        outcome: 'match',
        source_url: record.source_url,
        detail: outcome.detail ?? null,
      });
    } else if (outcome.outcome === 'multiple') {
      const list = (outcome.candidates ?? []).map((candidate) => ({
        ...candidate,
        registry_id: registry.meta.id,
        registry_name: registry.meta.name,
        source_name: candidate.source_name ?? registry.meta.source_name,
      }));
      candidates.push(...list);
      registryOutcomes.push({
        registry_id: registry.meta.id,
        registry_name: registry.meta.name,
        outcome: 'multiple',
        source_url: outcome.source_url ?? registry.meta.source_url,
        detail: outcome.detail ?? `${list.length} candidates`,
      });
    } else {
      registryOutcomes.push({
        registry_id: registry.meta.id,
        registry_name: registry.meta.name,
        outcome: 'no_match',
        source_url: outcome.source_url ?? registry.meta.source_url,
        detail: outcome.detail ?? null,
      });
      // Records that failed the similarity bar are near misses, not candidates.
      // They must never flip a no_match into a multiple-match result.
      if ((outcome.candidates ?? []).length) {
        nearMisses.push(...outcome.candidates.map((candidate) => ({
          ...candidate,
          registry_id: registry.meta.id,
          registry_name: registry.meta.name,
          source_name: candidate.source_name ?? registry.meta.source_name,
          reason: outcome.detail ?? 'below the match threshold',
        })));
      }
    }
  }

  const candidateKey = (c) => `${c.registry_id}:${c.licence_number ?? c.name}`;
  const uniqueCandidates = dedupeBy(candidates, candidateKey).slice(0, 25);
  const uniqueNearMisses = dedupeBy(nearMisses, candidateKey).slice(0, 10);

  // If every registry errored, this is not a no-match. Returning "not found"
  // would read as "not licensed", which the evidence does not support.
  if (!records.length && !uniqueCandidates.length && errors.length && errors.length === registries.length) {
    throw new HttpError(
      502,
      'REGISTRY_UNAVAILABLE',
      'None of the official registries could be reached or read. Nothing was inferred; try again shortly.',
      { errors, searched: registryOutcomes },
    );
  }

  let matchQuality = 'no_match';
  let primary = null;
  let conflict = false;

  if (records.length === 1 && uniqueCandidates.length === 0) {
    primary = records[0];
    matchQuality = records[0].match_quality === 'close' ? 'close' : 'exact';
  } else if (records.length > 0) {
    // Several registries agree on the subject: return every record, do not merge them.
    const reconciled = reconcileStatuses(records);
    conflict = reconciled.conflict;
    if (conflict) {
      notes.push(reconciled.note);
    } else {
      primary = records[0];
      notes.push(`Checked ${records.length} registries; all returned a record. Each record is shown separately.`);
    }
    matchQuality = records.some((r) => r.match_quality === 'exact') ? 'exact' : 'close';
  } else if (uniqueCandidates.length) {
    matchQuality = 'multiple';
  }

  if (matchQuality === 'multiple') {
    notes.push('More than one plausible record matched. Nothing was auto-selected; choose the correct record or add a registration number.');
  }

  if (matchQuality === 'no_match' && !errors.length) {
    notes.push(`No registry returned a confident match for "${query.subject}". Nothing was inferred or guessed.`);
  }

  if (matchQuality === 'no_match') {
    const suggestions = variants.slice(1).map((variant) => ({ value: variant.value, reason: variant.reason }));
    if (suggestions.length) notes.push('Try a name variant listed in suggestions, or add a registration number.');
    return {
      ok: true,
      query: publicQuery(query),
      match_quality: 'no_match',
      primary: null,
      results: [],
      candidates: uniqueCandidates,
      near_misses: uniqueNearMisses,
      suggestions,
      searched: registryOutcomes,
      notes: [...new Set(notes)],
      errors,
      incomplete: errors.length > 0,
      duration_ms: Date.now() - started,
      checked_at: new Date().toISOString(),
    };
  }

  return {
    ok: true,
    query: publicQuery(query),
    match_quality: matchQuality,
    conflict,
    primary,
    results: records,
    candidates: uniqueCandidates,
    near_misses: uniqueNearMisses,
    suggestions: [],
    searched: registryOutcomes,
    notes: [...new Set(notes)],
    errors,
    incomplete: errors.length > 0,
    duration_ms: Date.now() - started,
    checked_at: new Date().toISOString(),
  };
}

function publicQuery(query) {
  return { subject: query.subject, licence_type: query.licence_type, jurisdiction: query.jurisdiction, number: query.number };
}

function unsupported(query) {
  const matrix = coverageMatrix();
  const sameType = matrix.combinations.filter((c) => c.licence_type === query.licence_type);
  return {
    ok: true,
    query: publicQuery(query),
    match_quality: 'unsupported',
    primary: null,
    results: [],
    candidates: [],
    suggestions: [],
    searched: [],
    notes: [
      `No registry adapter is enabled for ${query.licence_type} in ${query.jurisdiction}.`,
      sameType.length
        ? `Supported ${query.licence_type} jurisdictions: ${sameType.map((c) => c.jurisdiction).join(', ')}.`
        : `Supported licence types: ${matrix.types.join(', ')}.`,
    ],
    supported: matrix,
    errors: [],
    incomplete: false,
    duration_ms: 0,
    checked_at: new Date().toISOString(),
  };
}

/**
 * Verify a subject against every registry that covers its (type, jurisdiction).
 * Results are cached briefly; a cached response keeps its original checked_at and source_url.
 */
export async function verify(input, { refresh = false, ttlSeconds } = {}) {
  const query = validate(input);
  const registries = resolveRegistries(query.licence_type, query.jurisdiction);
  if (!registries.length) return unsupported(query);

  const ttl = ttlSeconds ?? (refresh ? 0 : config.cacheTtlSeconds);
  const key = [query.subject.toLowerCase(), query.licence_type, query.jurisdiction, query.number ?? ''];

  const response = await cached(key, ttl, () => runVerification(query, registries));
  if (!response.cached) return response;

  const markCached = (record) => (record ? { ...record, cached: true, cache_age_seconds: response.cache_age_seconds } : null);
  return {
    ...response,
    primary: markCached(response.primary),
    results: (response.results ?? []).map(markCached),
    notes: [...new Set([...(response.notes ?? []), `Served from a ${response.cache_age_seconds}s cache; source and checked_at are from the original live read.`])],
  };
}

export { coverageMatrix, registryById, resolveRegistries };
