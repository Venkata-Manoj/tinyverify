import { badNumber, classifyMatch, cleanText, nameSimilarity, normalizeDate, normalizeStatus } from '../normalize.js';
import { makeRecord } from '../schema.js';

/**
 * New Zealand Companies Office — the official company register.
 *
 * The public search page is server-rendered HTML but its result rows use
 * javascript: links, so the HTML is parsed directly. Record pages are stable
 * at /co/{number} (short link, redirects to the full record).
 */

const HOST = 'https://app.companiesoffice.govt.nz';
const HOME = 'https://www.companiesoffice.govt.nz';
const searchUrl = (query) => `${HOST}/companies/app/ui/pages/companies/search?q=${encodeURIComponent(query)}&entityTypes=ALL&entityStatusGroups=ALL&start=0&limit=15&advancedPanel=true&mode=advanced`;
const recordUrl = (number) => `${HOST}/co/${number}`;
const NUMBER_RE = /^\d{1,9}$/;

const ENTITIES = { '&amp;': '&', '&nbsp;': ' ', '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>' };

function textOf(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|td|th|dt|dd|section|article|label)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&[a-z]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/** Registry-native status wording, mapped conservatively. */
function mapNzStatus(raw) {
  const detail = cleanText(raw);
  const mapped = normalizeStatus(detail);
  if (mapped.status !== 'unknown') return mapped;
  if (/liquidation|receivership|administration|compromise|ceasing/i.test(detail)) {
    return { status: 'suspended', detail };
  }
  return mapped;
}

function cleanAddress(html) {
  return cleanText(textOf(html))
    .replace(/\s*\n\s*,/g, ',')
    .replace(/\s*\n\s*/g, ', ')
    .replace(/(,\s*){2,}/g, ', ')
    .replace(/^[,\s]+|[,\s]+$/g, '');
}

function labelValue(block, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp(`<label[^>]*>\\s*${escaped}\\s*</label>\\s*([\\s\\S]*?)</div>`, 'i'));
  return match ? cleanText(textOf(match[1])) : null;
}

/** Parse one search result row. The anchors carry the company number, not an href. */
export function parseNzSearch(html) {
  const results = [];
  const seen = new Set();
  const anchorRe = /<a[^>]*viewCompanyDetails\('(\d+)'\)[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of String(html || '').matchAll(anchorRe)) {
    const number = match[1];
    if (seen.has(number)) continue;
    const inner = match[2];
    const name = cleanText(textOf(inner.match(/<span[^>]*class="[^"]*entityName[^"]*"[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? ''));
    if (!name) continue;
    const infoHtml = inner.match(/<span[^>]*class="[^"]*entityInfo[^"]*"[^>]*>([\s\S]*?)<\/span>\s*$/i)?.[1]
      ?? inner.match(/<span[^>]*class="[^"]*entityInfo[^"]*"[^>]*>([\s\S]*?)<\/span>/i)?.[1]
      ?? '';
    const entityType = cleanText(textOf(infoHtml.match(/<span[^>]*class="[^"]*entityType[^"]*"[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? ''));
    const info = cleanText(textOf(infoHtml.replace(/<span[^>]*class="[^"]*entityType[^"]*"[^>]*>[\s\S]*?<\/span>/gi, ' ')));
    const status = cleanText(info.replace(/^\(\d+\)\s*/, '').replace(/\(NZBN:[^)]*\)/i, '')) || null;
    const nzbn = info.match(/NZBN:\s*(\d+)/i)?.[1] ?? null;
    seen.add(number);
    results.push({ number, name, status, entity_type: entityType || null, nzbn, source_url: recordUrl(number) });
  }
  return results;
}

/** Parse the official company summary page. */
export function parseNzRecord(html, { url } = {}) {
  const body = String(html || '');
  const header = body.match(/<h1[^>]*>([\s\S]*?)<span[^>]*class="[^"]*entityIdentifier[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
  const name = cleanText(textOf(header?.[1] ?? ''));
  const identifier = cleanText(textOf(header?.[2] ?? ''));
  const number = identifier.match(/\((\d{1,9})\)/)?.[1] ?? String(url || '').match(/\/co\/(\d+)|\/companies\/(\d+)/)?.slice(1).find(Boolean) ?? null;

  const summary = body.split(/class="readonly companySummary"/i)[1]?.split(/<div class="row buttons">/i)[0] ?? '';
  const rawStatus = labelValue(summary, 'Company Status:');
  const { status, detail } = mapNzStatus(rawStatus);

  const previousNames = [];
  for (const match of body.matchAll(/<div[^>]*class="[^"]*previousNames[^"]*"[^>]*>([\s\S]*?)<\/div>/gi)) {
    for (const line of textOf(match[1]).split('\n')) {
      const value = cleanText(line);
      if (value && !previousNames.includes(value)) previousNames.push(value);
    }
  }

  const registeredOfficeBlock = body.match(/<strong>\s*Registered Office\s*<\/strong>\s*<br\s*\/?>([\s\S]*?)<\/div>/i)?.[1];
  const serviceBlock = body.match(/<strong>\s*Address for service\s*<\/strong>\s*<br\s*\/?>([\s\S]*?)<\/div>/i)?.[1];
  const ar = cleanText(textOf(body)).match(/AR filing month:\s*([A-Za-z]+)\s*,?\s*last filed on\s*([^\n]+)/i);
  const lastUpdated = cleanText(textOf(body)).match(/Last updated on\s*([^\n]+)/i)?.[1]?.trim() ?? null;

  if (!name || !number) return null;

  const fields = {
    nzbn: labelValue(summary, 'NZBN:'),
    entity_type: labelValue(summary, 'Entity type:'),
    incorporated_on: normalizeDate(labelValue(summary, 'Incorporation Date:')),
    registered_office: registeredOfficeBlock ? cleanAddress(registeredOfficeBlock) : null,
    address_for_service: serviceBlock ? cleanAddress(serviceBlock) : null,
    annual_return_month: ar?.[1] ?? null,
    annual_return_last_filed: ar ? normalizeDate(ar[2]) || cleanText(ar[2]) : null,
    last_updated_on_source: lastUpdated ? normalizeDate(lastUpdated) || lastUpdated : null,
    constitution_filed: labelValue(summary, 'Constitution filed:'),
    previous_names: previousNames,
  };
  for (const key of Object.keys(fields)) {
    if (fields[key] === null || (Array.isArray(fields[key]) && !fields[key].length)) delete fields[key];
  }

  const notes = [
    'Company registration has no expiry date; the Companies Office shows the latest annual return instead.',
    'This page does not list disciplinary actions; NZ banned-director decisions are published on a separate register.',
  ];

  return { name, number, raw_status: rawStatus, status, status_detail: detail, fields, notes, previous_names: previousNames };
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; TinyVerify/0.1; official-register verification)',
      accept: 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`NZ Companies Office returned ${res.status} for ${url}`);
  return { html: await res.text(), url: res.url };
}

function toCandidate(parsed, subject) {
  return {
    name: parsed.name,
    licence_number: parsed.number,
    jurisdiction: 'NZ',
    status: mapNzStatus(parsed.status).status,
    status_detail: parsed.status,
    source_url: recordUrl(parsed.number),
    source_name: 'NZ Companies Office',
    registry_name: 'NZ Companies Office',
    registry_id: 'nz-companies',
    confidence: nameSimilarity(subject, parsed.name),
    extra: { nzbn: parsed.nzbn, entity_type: parsed.entity_type },
  };
}

function toRecord(parsed, subject, confidence, matchQuality) {
  return makeRecord({
    subject,
    licence_type: 'business',
    jurisdiction: 'NZ',
    status: parsed.status,
    licence_number: parsed.number,
    expiry_date: null,
    disciplinary_actions: ['none found'],
    source_name: 'NZ Companies Office',
    source_url: recordUrl(parsed.number),
    checked_at: new Date().toISOString(),
    match_quality: matchQuality,
    registry_id: 'nz-companies',
    registry_name: 'NZ Companies Office',
    status_detail: parsed.status_detail,
    matched_name: parsed.name,
    confidence,
    fields: parsed.fields,
    notes: parsed.notes,
  });
}

export const nzCompanies = {
  meta: {
    id: 'nz-companies',
    name: 'NZ Companies Office',
    source_name: 'NZ Companies Office',
    kind: 'fetch-direct',
    types: ['business'],
    jurisdictions: ['NZ'],
    source_url: HOME,
    description: 'Official New Zealand company register: company number, NZBN, status, incorporation date, registered office and annual return.',
    fields: ['status', 'licence_number', 'expiry_date (n/a)', 'disciplinary_actions (n/a)', 'NZBN', 'registered office', 'annual return'],
  },

  async lookup({ subject, number, variant }) {
    const query = variant || subject;
    const searched = [];

    const directNumber = number ? String(number).replace(/\D/g, '') : null;
    if (number && !NUMBER_RE.test(directNumber ?? '')) {
      throw badNumber('An NZ company number must be 1-9 digits (or supply the company name).');
    }
    if (directNumber) {
      let html = null;
      let url = recordUrl(directNumber);
      let fetchError = null;
      try {
        ({ html, url } = await fetchHtml(recordUrl(directNumber)));
      } catch (err) {
        fetchError = err;
      }
      let parsed = html ? parseNzRecord(html, { url }) : null;
      searched.push({ url: recordUrl(directNumber), kind: 'record', via: 'number' });

      if (!parsed) {
        // The Companies Office returns 500 for a non-existent company page.
        // Confirm with the official search so an outage is not reported as a
        // clean "no record", and a bogus number is not reported as an outage.
        const lookupUrl = searchUrl(directNumber);
        let results = [];
        let searchFailed = false;
        try {
          const search = await fetchHtml(lookupUrl);
          results = parseNzSearch(search.html);
          searched.push({ url: lookupUrl, kind: 'search-list', via: 'official-search', results: results.length });
        } catch {
          searchFailed = true;
        }
        if (!searchFailed && !results.some((result) => result.number === directNumber)) {
          return {
            outcome: 'no_match',
            source_url: lookupUrl,
            searched,
            candidates: [],
            detail: `The NZ Companies Office has no company numbered ${directNumber}.`,
          };
        }
        throw fetchError || new Error(`NZ company ${directNumber} page could not be parsed`);
      }

      const confidence = nameSimilarity(subject, parsed.name);
      return {
        outcome: 'match',
        record: toRecord(parsed, subject, confidence, 'exact'),
        source_url: recordUrl(parsed.number),
        searched,
        detail: `Fetched NZ company ${directNumber} directly from the Companies Office.`,
      };
    }

    const url = searchUrl(query);
    const { html } = await fetchHtml(url);
    const results = parseNzSearch(html);
    searched.push({ url, kind: 'search-list', via: 'official-search', results: results.length });

    if (!results.length) {
      return {
        outcome: 'no_match',
        source_url: HOME,
        searched,
        candidates: [],
        detail: `The NZ Companies Office returned no companies for "${query}".`,
      };
    }

    const scored = results
      .map((result) => ({ result, confidence: nameSimilarity(subject, result.name) }))
      .sort((a, b) => b.confidence - a.confidence);
    const plausible = scored.filter((item) => item.confidence >= 0.62);

    // A clear exact winner can be fetched directly; otherwise the user chooses.
    const top = plausible[0];
    const second = plausible[1];
    if (top && top.confidence >= 0.98 && (!second || top.confidence - second.confidence >= 0.12)) {
      const { html: recordHtml, url: finalUrl } = await fetchHtml(recordUrl(top.result.number));
      const parsed = parseNzRecord(recordHtml, { url: finalUrl });
      if (parsed) {
        return {
          outcome: 'match',
          record: toRecord(parsed, subject, top.confidence, 'exact'),
          source_url: recordUrl(parsed.number),
          searched,
          detail: `Exact company match among ${results.length} official search results.`,
        };
      }
    }

    if (plausible.length === 1) {
      const { result, confidence } = plausible[0];
      const { html: recordHtml, url: finalUrl } = await fetchHtml(recordUrl(result.number));
      const parsed = parseNzRecord(recordHtml, { url: finalUrl });
      if (!parsed) throw new Error(`NZ company ${result.number} page could not be parsed`);
      return {
        outcome: 'match',
        record: toRecord(parsed, subject, confidence, classifyMatch(subject, parsed.name)),
        source_url: recordUrl(parsed.number),
        searched,
        detail: `One plausible company among ${results.length} official search results.`,
      };
    }

    if (plausible.length > 1) {
      return {
        outcome: 'multiple',
        source_url: url,
        searched,
        candidates: plausible.slice(0, 12).map(({ result }) => toCandidate(result, subject)),
        detail: `${plausible.length} NZ companies matched "${query}".`,
      };
    }

    return {
      outcome: 'no_match',
      source_url: url,
      searched,
      candidates: scored.slice(0, 8).map(({ result }) => toCandidate(result, subject)),
      detail: `The NZ Companies Office returned ${results.length} companies, but none matched "${query}" closely enough to return without guessing.`,
    };
  },
};
