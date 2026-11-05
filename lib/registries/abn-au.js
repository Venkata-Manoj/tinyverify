import { badNumber, CLOSE_THRESHOLD, classifyMatch, cleanText, nameSimilarity, normalizeDate, normalizeStatus } from '../normalize.js';
import { makeRecord } from '../schema.js';

/**
 * Australian Business Register — ABN Lookup.
 *
 * The public site is server-rendered HTML. Search is a POST to /Search/Run
 * which redirects to /Search/ResultsActive; a record lives at /ABN/View.
 * No API key or ABR GUID is required for the public pages.
 */

const HOME = 'https://abr.business.gov.au';
const SEARCH = `${HOME}/Search/ResultsAll`;
const recordUrl = (abn) => `${HOME}/ABN/View?id=${abn}`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const ENTITIES = { '&amp;': '&', '&nbsp;': ' ', '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>' };

function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|td|th|dt|dd|caption|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&[a-z]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

function cellsOf(row) {
  return [...String(row).matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
    .map((match) => cleanText(htmlToText(match[1])))
    .filter((value, index, all) => value || index < all.length);
}

/** Parse the official search results table. */
export function parseAbnSearch(html) {
  const body = String(html || '');
  const total = Number((body.match(/found\s+([\d,]+)\s+matches?/i)?.[1] || '').replace(/,/g, '')) || 0;
  const results = [];
  const seen = new Set();
  for (const match of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row = match[1];
    const abn = row.match(/\/ABN\/View\?(?:abn|id)=(\d{11})/i)?.[1];
    if (!abn || seen.has(abn)) continue;
    const cells = cellsOf(row);
    const name = cells[1] || '';
    if (!name) continue;
    const rawStatus = cleanText(row.match(/<span[^>]*class="[^"]*(?:active|inactive|cancelled)[^"]*"[^>]*>([\s\S]*?)<\/span>/i)?.[1] || '');
    const type = cells[2] || null;
    const address = cells[3] || null;
    seen.add(abn);
    results.push({
      abn,
      name,
      type,
      address,
      raw_status: rawStatus || null,
      status: normalizeStatus(rawStatus).status,
      source_url: recordUrl(abn),
    });
  }
  return { total, results };
}

function thValue(body, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = body.match(new RegExp(`<th[^>]*>\\s*${escaped}\\s*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>`, 'i'));
  return match ? cleanText(htmlToText(match[1])) : null;
}

function tableNames(body, caption) {
  const needle = caption.toLowerCase();
  // Pick the caption whose text actually matches. Matching from the first
  // <caption> would stop at the ABN details table before reaching this one.
  const captions = [...body.matchAll(/<caption[^>]*>([\s\S]*?)<\/caption>/gi)];
  const target = captions.find((match) => htmlToText(match[1]).toLowerCase().includes(needle));
  if (!target) return [];
  const rest = body.slice(target.index + target[0].length);
  const end = rest.search(/<\/table>/i);
  const table = end >= 0 ? rest.slice(0, end) : rest;
  const names = [];
  for (const row of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = cellsOf(row[1]);
    // Business/trading name tables have a name and a "from" date. Skip the
    // explanatory colspan row and the <th> header.
    if (cells.length < 2) continue;
    if (/^(business name|trading name)$/i.test(cells[0])) continue;
    if (cells[0]) names.push(cells[0]);
  }
  return [...new Set(names)];
}

/** Parse one official ABN detail page. */
export function parseAbnPage(html, { url } = {}) {
  const body = String(html || '');
  const text = htmlToText(body);
  if (/not found|no record|invalid abn/i.test(text.slice(0, 500))) return null;

  const heading = text.match(/Current details for ABN\s*([\d ]{11,14})/i)?.[1]?.replace(/\D/g, '')
    || text.match(/Historical details for ABN\s*([\d ]{11,14})/i)?.[1]?.replace(/\D/g, '');
  const number = heading || String(url || '').match(/(?:id|abn)=(\d{11})/i)?.[1] || null;
  const name = cleanText(htmlToText(body.match(/<span[^>]*itemprop="legalName"[^>]*>([\s\S]*?)<\/span>/i)?.[1] || ''));
  if (!number || !name) return null;

  const rawStatus = thValue(body, 'ABN status:');
  const { status, detail } = normalizeStatus(rawStatus);
  const cancelledOn = rawStatus?.match(/cancelled from\s+(.+)$/i)?.[1];
  const activeFrom = rawStatus?.match(/active from\s+(.+)$/i)?.[1];
  const businessNames = tableNames(body, 'Business name(s)');
  const tradingNames = tableNames(body, 'Trading name(s)');
  const addressLocality = cleanText(htmlToText(body.match(/<span[^>]*itemprop="addressLocality"[^>]*>([\s\S]*?)<\/span>/i)?.[1] || ''));
  const updated = cleanText(htmlToText(body.match(/ABN last updated:\s*<\/strong>\s*([^<]+)/i)?.[1] || ''));

  const fields = {
    abn: `${number.slice(0, 2)} ${number.slice(2, 5)} ${number.slice(5, 8)} ${number.slice(8)}`,
    entity_type: thValue(body, 'Entity type:'),
    gst_registered_from: thValue(body, 'Goods & Services Tax (GST):'),
    main_business_location: addressLocality || null,
    business_names: businessNames,
    trading_names: tradingNames,
    abn_last_updated: updated ? normalizeDate(updated) || updated : null,
    cancellation_date: cancelledOn ? normalizeDate(cancelledOn) || cancelledOn : null,
    status_effective_from: activeFrom ? normalizeDate(activeFrom) || activeFrom : null,
  };
  for (const key of Object.keys(fields)) {
    if (fields[key] === null || (Array.isArray(fields[key]) && !fields[key].length)) delete fields[key];
  }

  return {
    name,
    number,
    raw_status: rawStatus,
    status,
    status_detail: detail,
    fields,
    names: [...new Set([name, ...businessNames, ...tradingNames])],
    notes: [
      'An ABN has no expiry date; the register publishes the ABN status and the date it took effect.',
      'ABN Lookup does not publish disciplinary actions. Business names are cross-checked on the ASIC Business Names Register separately.',
    ],
  };
}

async function fetchHtml(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml', ...(options.headers || {}) },
    redirect: 'follow',
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`ABN Lookup returned ${res.status} for ${url}`);
  return { html: await res.text(), url: res.url };
}

async function searchByName(query) {
  // ResultsActive hides cancelled ABNs. ResultsAll is the official view that
  // includes them, so a former business is reported as cancelled rather than
  // "not found".
  const url = new URL(SEARCH);
  url.searchParams.set('SearchText', query);
  url.searchParams.set('AllNames', 'True');
  url.searchParams.set('SearchType', 'AllAbns');
  url.searchParams.set('AllStates', 'True');
  return fetchHtml(url.toString());
}

/** Validate the official ABN checksum. */
export function isValidAbn(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!/^\d{11}$/.test(digits)) return false;
  const weights = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  const sum = digits.split('').reduce((total, digit, index) => {
    const number = Number(digit) - (index === 0 ? 1 : 0);
    return total + number * weights[index];
  }, 0);
  return sum % 89 === 0;
}

function bestSimilarity(subject, names) {
  return Math.max(0, ...names.map((name) => nameSimilarity(subject, name)));
}

function toCandidate(result, subject) {
  return {
    name: result.name,
    licence_number: result.abn,
    jurisdiction: 'AU',
    status: result.status,
    status_detail: result.raw_status,
    source_url: result.source_url,
    source_name: 'Australian Business Register',
    registry_name: 'Australian Business Register (ABN Lookup)',
    registry_id: 'abn-au',
    confidence: nameSimilarity(subject, result.name),
    extra: { entity_type: result.type, location: result.address },
  };
}

function toRecord(parsed, subject, confidence, counts = {}) {
  return makeRecord({
    subject,
    licence_type: 'business',
    jurisdiction: 'AU',
    status: parsed.status,
    licence_number: parsed.number,
    expiry_date: null,
    disciplinary_actions: ['not published by this registry'],
    source_name: 'Australian Business Register',
    source_url: recordUrl(parsed.number),
    checked_at: new Date().toISOString(),
    match_quality: classifyMatch(subject, parsed.name),
    registry_id: 'abn-au',
    registry_name: 'Australian Business Register (ABN Lookup)',
    status_detail: parsed.status_detail,
    matched_name: parsed.name,
    confidence,
    ...counts,
    fields: parsed.fields,
    notes: parsed.notes,
  });
}

function countState(total, fetched) {
  const capped = Number(total) > Number(fetched) && Number(fetched) > 0;
  return {
    total_found: capped ? null : (Number(total) || Number(fetched) || null),
    total_capped: capped,
    total_capped_at: capped ? Number(fetched) : null,
    total_display: capped ? `${Number(fetched)}+ (capped)` : null,
  };
}

export const abnAu = {
  meta: {
    id: 'abn-au',
    name: 'Australian Business Register (ABN Lookup)',
    source_name: 'Australian Business Register',
    kind: 'fetch-direct',
    types: ['business'],
    jurisdictions: ['AU'],
    source_url: HOME,
    description: 'Official Australian Business Register: ABN, entity name, ABN status, entity type, GST registration and business names.',
    fields: ['status', 'licence_number', 'expiry_date (n/a)', 'disciplinary_actions (n/a)', 'ABN status', 'entity type', 'GST'],
  },

  async lookup({ subject, number }) {
    const searched = [];

    if (number) {
      const digits = String(number).replace(/\D/g, '');
      if (!isValidAbn(digits)) throw badNumber('An ABN must be 11 digits and pass the ABN checksum (for example 33 051 775 556).');
      const { html, url } = await fetchHtml(recordUrl(digits));
      searched.push({ url, kind: 'record', via: 'number' });
      const parsed = parseAbnPage(html, { url });
      if (!parsed) {
        return { outcome: 'no_match', source_url: recordUrl(digits), searched, candidates: [], detail: `ABN Lookup has no record for ABN ${digits}.` };
      }
      const confidence = bestSimilarity(subject, parsed.names);
      return {
        outcome: 'match',
        record: toRecord(parsed, subject, confidence, { total_found: 1, total_capped: false, total_display: null }),
        source_url: recordUrl(parsed.number),
        total_found: 1,
        total_capped: false,
        total_display: null,
        searched,
        detail: `Fetched ABN ${parsed.number} directly from the Australian Business Register.`,
      };
    }

    const { html, url } = await searchByName(subject);
    const { total, results } = parseAbnSearch(html);
    searched.push({ url, kind: 'search-list', via: 'official-search', results: results.length, total });
    const counts = countState(total, results.length);
    const countLabel = counts.total_display || String(counts.total_found ?? total ?? results.length);

    if (!results.length) {
      return {
        outcome: 'no_match',
        source_url: url,
        searched,
        candidates: [],
        ...counts,
        detail: `ABN Lookup returned no active or cancelled ABNs for "${subject}".`,
      };
    }

    const scored = results
      .map((result) => ({ result, confidence: nameSimilarity(subject, result.name) }))
      .sort((a, b) => b.confidence - a.confidence);
    const plausible = scored.filter((item) => item.confidence >= CLOSE_THRESHOLD);

    const fetchParsed = async (result) => {
      try {
        const page = await fetchHtml(recordUrl(result.abn));
        return { parsed: parseAbnPage(page.html, { url: page.url }), result };
      } catch {
        return { parsed: null, result };
      }
    };

    if (plausible.length === 1) {
      const { parsed, result } = await fetchParsed(plausible[0].result);
      if (!parsed) throw new Error(`ABN ${result.abn} detail page could not be parsed`);
      const confidence = bestSimilarity(subject, parsed.names);
      return {
        outcome: 'match',
        record: toRecord(parsed, subject, confidence, counts),
        source_url: recordUrl(parsed.number),
        ...counts,
        searched,
        detail: `One plausible ABN among ${countLabel} search results.`,
      };
    }

    if (plausible.length > 1) {
      return {
        outcome: 'multiple',
        source_url: url,
        searched,
        ...counts,
        candidates: plausible.slice(0, 15).map(({ result }) => toCandidate(result, subject)),
        detail: `${countLabel} ABN records matched "${subject}". Add an ABN to choose one.`,
      };
    }

    return {
      outcome: 'no_match',
      source_url: url,
      searched,
      ...counts,
      candidates: scored.slice(0, 8).map(({ result }) => toCandidate(result, subject)),
      detail: `ABN Lookup returned ${countLabel} records, but none matched "${subject}" closely enough to return without guessing.`,
    };
  },
};
