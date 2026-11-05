import { fetchPage, fetchPages, searchWeb } from '../tinyfish.js';
import { badNumber, CLOSE_THRESHOLD, cleanText, classifyMatch, nameSimilarity, normalizeDate, normalizeStatus } from '../normalize.js';
import { makeRecord } from '../schema.js';

const DOMAIN = 'find-and-update.company-information.service.gov.uk';
const HOME = `https://${DOMAIN}`;
const COMPANY_URL = (number) => `${HOME}/company/${number}`;
// UK company numbers are exactly eight characters: eight digits, or two
// letters followed by six digits (SC, NI, OC, SO, NC, FC, ...). Anything else
// on a page — including a parenthesised place name such as "(BRADFORD)" — is
// not a company number.
const COMPANY_NUMBER = /^(?:\d{8}|[A-Z]{2}\d{6})$/;
const COMPANY_RE = /\/company\/(\d{8}|[A-Z]{2}\d{6})\/?$/i;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const labelValue = (text, label) => {
  const m = text.match(new RegExp(`\\*\\s*${escapeRe(label)}\\s*\\n+\\s*\\*\\s*([^\\n]+)`, 'i'));
  return m ? cleanText(m[1]) : null;
};

export function normalizeCompanyNumber(value) {
  const raw = String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (/^\d{1,8}$/.test(raw)) return raw.padStart(8, '0');
  return COMPANY_NUMBER.test(raw) ? raw : null;
}

/**
 * Former names arrive as "Current Name (from 01 Jan 1900 to 01 Jan 1970)". The
 * date range is a filing-history annotation, not part of the entity's name, so
 * it is dropped before comparing a query against a previous name.
 */
function withoutDateRange(value) {
  return String(value ?? '').replace(/\([^()]*\b(19|20)\d{3}\b[^()]*\)/g, ' ');
}

/**
 * The previous name a query may have used, if any. A hit at or above the close
 * threshold is a former-name match; the caller then reports the current name as
 * the official one and says the query matched a previous name.
 */
function previousNameHit(subject, parsed) {
  const previousNames = parsed.fields?.previous_names ?? [];
  let best = null;
  for (const candidate of previousNames) {
    const score = nameSimilarity(subject, withoutDateRange(candidate));
    if (score >= CLOSE_THRESHOLD && (!best || score > best.confidence)) best = { name: String(candidate), confidence: score };
  }
  return best;
}

/**
 * Score a parsed record against the subject, considering the current name and
 * any previous names. Returns the confidence and the name that produced it.
 */
function matchContext(subject, parsed) {
  const current = nameSimilarity(subject, parsed.name);
  const previous = previousNameHit(subject, parsed);
  const viaPrevious = previous && previous.confidence > current ? previous : null;
  return { confidence: viaPrevious ? previous.confidence : current, viaPrevious };
}

/** Parse the overview page markdown returned by TinyFish Fetch. */
export function parseCompanyPage(text, { url, title } = {}) {
  const body = cleanText(text);
  const urlNumber = String(url ?? '').match(COMPANY_RE)?.[1]?.toUpperCase() || null;
  // The company number sits in the final parenthetical of the overview line.
  // A non-greedy capture used to stop at "(BRADFORD)" in
  // "MARKS AND SPENCER (BRADFORD) LIMITED (10011863)" and returned BRADFORD as
  // the number. Capture the name greedily, then require a real number shape.
  const overview = body.match(/Company Overview for\s+(.+)\s*\((\d{8}|[A-Z]{2}\d{6})\)/i);
  const numberLine = body.match(/Company number\s+(\d{8}|[A-Z]{2}\d{6})\b/i)?.[1] || null;
  const titleName = title?.match(/^(.+?)\s+(?:overview|company overview)\s*[-–—]/i)?.[1]?.trim()
    || title?.match(/^(.+?)\s*-\s*Company Overview/i)?.[1]?.trim();
  const headingName = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const name = cleanText(overview?.[1] || titleName || headingName || '');
  const number = (overview?.[2] || numberLine || urlNumber || '').toUpperCase();

  const rawStatus = labelValue(body, 'Company status');
  const { status, detail } = normalizeStatus(rawStatus);
  const incorporated = normalizeDate(labelValue(body, 'Incorporated on'));
  const dissolved = normalizeDate(labelValue(body, 'Dissolved on'));

  const accounts = body.match(/Next accounts made up to\s+([^\n]+?)\s*\n+\s*due by\s*\n?\s*([^\n]+)/i);
  const confirmation = body.match(/Next statement date\s+([^\n]+?)\s*\n+\s*due by\s*\n?\s*([^\n]+)/i);

  const sic = [];
  const sicSection = body.split(/Nature of business \(SIC\)/i)[1]?.split(/\n##\s/)[0] ?? '';
  for (const m of sicSection.matchAll(/^\*\s*(\d{5})\s*-\s*(.+)$/gm)) sic.push(`${m[1]} - ${cleanText(m[2])}`);

  const previousNames = [];
  const prevSection = body.split(/Previous company names/i)[1]?.split(/\n##\s/)[0] ?? '';
  for (const m of prevSection.matchAll(/^\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/gm)) {
    if (/^name$/i.test(m[1]) || /^-+$/.test(m[1])) continue;
    previousNames.push(`${cleanText(m[1])} (${cleanText(m[2])})`);
  }

  if (!name || !COMPANY_NUMBER.test(number)) return null;

  const fields = {
    company_type: labelValue(body, 'Company type'),
    // This overview page is not the disqualification register. Saying so is
    // more honest than leaving the question unanswered.
    disqualified_officers: 'not checked',
  };
  if (incorporated) fields.incorporated_on = incorporated;
  if (dissolved) fields.dissolved_on = dissolved;
  const registeredOffice = labelValue(body, 'Registered office address');
  if (registeredOffice) fields.registered_office = registeredOffice;
  if (accounts) {
    fields.next_accounts_made_up_to = normalizeDate(accounts[1]) || cleanText(accounts[1]);
    fields.next_accounts_due = normalizeDate(accounts[2]) || cleanText(accounts[2]);
  }
  if (confirmation) {
    fields.next_confirmation_statement_date = normalizeDate(confirmation[1]) || cleanText(confirmation[1]);
    fields.next_confirmation_statement_due = normalizeDate(confirmation[2]) || cleanText(confirmation[2]);
  }
  if (sic.length) fields.sic = sic;
  if (previousNames.length) fields.previous_names = previousNames;

  const notes = [
    'Company registration has no expiry date; the next confirmation statement date is shown instead.',
    `Officer disqualifications are a separate register and were not checked here: ${HOME}/search/disqualified-officers?q=${encodeURIComponent(name)}`,
  ];
  if (confirmation?.[2]) {
    const due = normalizeDate(confirmation[2]);
    if (due) notes[0] = `Company registration has no expiry date. Next confirmation statement due ${due}.`;
  }

  return {
    name,
    number,
    raw_status: rawStatus,
    status,
    status_detail: detail,
    fields,
    notes,
  };
}

/** Parse candidate company links from a Companies House search page. */
export function parseSearchLinks(links = []) {
  const numbers = [];
  for (const link of links) {
    let parsed;
    try { parsed = new URL(String(link).trim()); } catch { continue; }
    if (parsed.hostname.toLowerCase() !== DOMAIN) continue;
    if (!/^\/company\/[A-Z0-9]{8}\/?$/i.test(parsed.pathname)) continue;
    const number = parsed.pathname.split('/').filter(Boolean)[1]?.toUpperCase();
    if (!number || !COMPANY_NUMBER.test(number) || numbers.includes(number)) continue;
    numbers.push(number);
  }
  return numbers;
}

function toRecord({ parsed, subject, matchQuality, confidence, cached = false, cacheAge = 0, matchedVia = null, previousName = null }) {
  return makeRecord({
    subject,
    licence_type: 'business',
    jurisdiction: 'UK',
    status: parsed.status,
    licence_number: parsed.number,
    expiry_date: null,
    disciplinary_actions: ['not published by this registry'],
    source_name: 'UK Companies House',
    source_url: COMPANY_URL(parsed.number),
    checked_at: new Date().toISOString(),
    match_quality: matchQuality,
    registry_id: 'companies-house-uk',
    registry_name: 'UK Companies House',
    status_detail: parsed.status_detail,
    matched_name: parsed.name,
    matched_via: matchedVia,
    previous_name: previousName,
    confidence,
    cached,
    cache_age_seconds: cacheAge,
    fields: parsed.fields,
    notes: parsed.notes,
  });
}

function toCandidate(parsed, subject, matchedVia = null, previousName = null) {
  return {
    name: parsed.name,
    licence_number: parsed.number,
    jurisdiction: 'UK',
    status: parsed.status,
    status_detail: parsed.status_detail,
    source_url: COMPANY_URL(parsed.number),
    source_name: 'UK Companies House',
    registry_name: 'UK Companies House',
    registry_id: 'companies-house-uk',
    confidence: nameSimilarity(subject, parsed.name),
    matched_via: matchedVia,
    previous_name: previousName,
  };
}

export const companiesHouse = {
  meta: {
    id: 'companies-house-uk',
    name: 'UK Companies House',
    source_name: 'UK Companies House',
    kind: 'fetch',
    types: ['business'],
    jurisdictions: ['UK'],
    source_url: HOME,
    description: 'Official UK company register: status, company number, incorporation, filing dates and SIC codes.',
    fields: ['status', 'licence_number', 'expiry_date (n/a)', 'disciplinary_actions (n/a)', 'registered office', 'incorporation date'],
  },

  async lookup({ subject, number, variant }) {
    const searched = [];
    const query = variant || subject;

    // 1. A supplied registration number is authoritative and saves two network calls.
    const directNumber = normalizeCompanyNumber(number);
    if (number && !directNumber) {
      throw badNumber('A UK company number must be eight characters: eight digits or two letters and six digits (for example 00445790 or SC123456).');
    }
    if (directNumber) {
      const companyUrl = COMPANY_URL(directNumber);
      let page = null;
      let fetchError = null;
      try {
        [page] = await fetchPages([companyUrl], { ttl: 0 });
      } catch (err) {
        fetchError = err;
      }
      const parsed = page ? parseCompanyPage(page.text, { url: page.final_url, title: page.title }) : null;
      searched.push({ url: companyUrl, kind: 'record', via: 'number' });

      if (!parsed) {
        // Confirm against the official search before calling this a no-match:
        // a genuine outage must stay an error, while a bogus number must not.
        const lookupUrl = `${HOME}/search/companies?q=${encodeURIComponent(directNumber)}`;
        let numbers = [];
        let searchFailed = false;
        try {
          const searchPage = await fetchPage(lookupUrl, { ttl: 0, links: true });
          numbers = parseSearchLinks(searchPage.links ?? []);
          searched.push({ url: lookupUrl, kind: 'search-list', via: 'official-search', results: numbers.length });
        } catch {
          searchFailed = true;
        }
        if (!searchFailed && !numbers.includes(directNumber)) {
          return {
            outcome: 'no_match',
            source_url: lookupUrl,
            searched,
            candidates: [],
            detail: `Companies House has no company numbered ${directNumber}.`,
          };
        }
        throw fetchError || new Error(`Companies House page for ${directNumber} could not be parsed`);
      }

      const ctx = matchContext(subject, parsed);
      const previous = ctx.viaPrevious;
      return {
        outcome: 'match',
        record: toRecord({
          parsed,
          subject,
          matchQuality: previous ? 'close' : 'exact',
          confidence: previous ? previous.confidence : ctx.confidence,
          matchedVia: previous ? 'previous_name' : null,
          previousName: previous ? previous.name : null,
        }),
        source_url: COMPANY_URL(directNumber),
        searched,
        detail: `Fetched company ${directNumber} directly from Companies House.`,
      };
    }

    // 2. TinyFish Search resolves a specific official record page when one exists.
    const search = await searchWeb({
      query: `"${query}" company`,
      includeDomains: DOMAIN,
      location: 'GB',
      language: 'en',
    });
    const direct = (search.results || [])
      .map((r) => ({ ...r, number: r.url?.match(COMPANY_RE)?.[1]?.toUpperCase() }))
      .find((r) => r.number);
    searched.push({ url: search.results?.[0]?.url || `${HOME}/search/companies?q=${encodeURIComponent(query)}`, kind: 'search', via: 'tinyfish-search', results: search.results?.length ?? 0 });

    if (direct) {
      const [page] = await fetchPages([COMPANY_URL(direct.number)], { ttl: 0 });
      const parsed = parseCompanyPage(page.text, { url: page.final_url, title: page.title });
      if (parsed) {
        const ctx = matchContext(subject, parsed);
        const quality = ctx.viaPrevious ? 'close' : classifyMatch(subject, parsed.name);
        // Only short-circuit on a genuine exact hit. A broad query such as
        // "Tesco" must see the official result list so it can return candidates instead
        // of silently picking the most prominent company.
        if (quality === 'exact') {
          return {
            outcome: 'match',
            record: toRecord({ parsed, subject, matchQuality: quality, confidence: ctx.confidence, matchedVia: ctx.viaPrevious ? 'previous_name' : null, previousName: ctx.viaPrevious ? ctx.viaPrevious.name : null }),
            source_url: COMPANY_URL(parsed.number),
            searched,
            detail: `TinyFish Search resolved the official record ${parsed.number}.`,
          };
        }
      }
    }

    // 3. Fall back to the official search page, then batch-fetch the top matches.
    const searchUrl = `${HOME}/search/companies?q=${encodeURIComponent(query)}`;
    let searchPage;
    try {
      searchPage = await fetchPages([searchUrl], { ttl: 0, links: true });
    } catch (err) {
      // A search page with no extractable content means no usable results for
      // this name (e.g. punctuation-heavy input). Do not dress that up as an
      // outage, and do not claim the company does not exist.
      if (err.code === 'FETCH_EMPTY') {
        return {
          outcome: 'no_match',
          source_url: searchUrl,
          searched,
          candidates: [],
          detail: `Companies House returned no readable search results for "${query}". Nothing was inferred.`,
        };
      }
      throw err;
    }
    const numbers = parseSearchLinks(searchPage[0]?.links ?? []).slice(0, 6);
    searched.push({ url: searchUrl, kind: 'search-list', via: 'official-search', results: numbers.length });

    if (!numbers.length) {
      return {
        outcome: 'no_match',
        source_url: searchUrl,
        searched,
        detail: `No company records matched "${query}" on Companies House.`,
        candidates: [],
      };
    }

    const pages = await fetchPages(numbers.map(COMPANY_URL), { ttl: 0 });
    const parsedPages = pages
      .map((page) => parseCompanyPage(page.text, { url: page.final_url, title: page.title }))
      .filter(Boolean);

    const scored = parsedPages
      .map((parsed) => {
        const ctx = matchContext(subject, parsed);
        return { parsed, confidence: ctx.confidence, viaPrevious: ctx.viaPrevious ?? null };
      })
      .sort((a, b) => b.confidence - a.confidence);

    const plausible = scored.filter((item) => item.confidence >= CLOSE_THRESHOLD);
    if (plausible.length === 1) {
      const { parsed, confidence, viaPrevious } = plausible[0];
      return {
        outcome: 'match',
        record: toRecord({
          parsed,
          subject,
          matchQuality: viaPrevious ? 'close' : classifyMatch(subject, parsed.name),
          confidence,
          matchedVia: viaPrevious ? 'previous_name' : null,
          previousName: viaPrevious ? viaPrevious.name : null,
        }),
        source_url: COMPANY_URL(parsed.number),
        searched,
        detail: `One plausible match among ${parsedPages.length} official results.`,
      };
    }
    if (plausible.length > 1) {
      return {
        outcome: 'multiple',
        source_url: searchUrl,
        searched,
        candidates: plausible.map(({ parsed, viaPrevious }) => toCandidate(
          parsed,
          subject,
          viaPrevious ? 'previous_name' : null,
          viaPrevious ? viaPrevious.name : null,
        )),
        detail: `${plausible.length} plausible company records matched "${query}".`,
      };
    }
    if (scored.length) {
      return {
        outcome: 'no_match',
        source_url: searchUrl,
        searched,
        candidates: scored.slice(0, 5).map(({ parsed }) => toCandidate(parsed, subject)),
        detail: `Found ${scored.length} official records, but none matched "${query}" closely enough to return without guessing.`,
      };
    }
    return {
      outcome: 'no_match',
      source_url: searchUrl,
      searched,
      candidates: [],
      detail: `Companies House returned results for "${query}", but their detail pages could not be parsed.`,
    };
  },
};
