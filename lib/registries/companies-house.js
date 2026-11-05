import { fetchPage, fetchPages, searchWeb } from '../tinyfish.js';
import { badNumber, CLOSE_THRESHOLD, cleanText, classifyMatch, nameSimilarity, normalizeDate, normalizeStatus } from '../normalize.js';
import { makeRecord } from '../schema.js';

const DOMAIN = 'find-and-update.company-information.service.gov.uk';
const HOME = `https://${DOMAIN}`;
const COMPANY_URL = (number) => `${HOME}/company/${number}`;
const COMPANY_RE = /\/company\/([A-Z0-9]{6,10})\/?$/i;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const labelValue = (text, label) => {
  const m = text.match(new RegExp(`\\*\\s*${escapeRe(label)}\\s*\\n+\\s*\\*\\s*([^\\n]+)`, 'i'));
  return m ? cleanText(m[1]) : null;
};

export function normalizeCompanyNumber(value) {
  const raw = String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-Z0-9]{6,10}$/.test(raw) ? raw : null;
}

/** Parse the overview page markdown returned by TinyFish Fetch. */
export function parseCompanyPage(text, { url, title } = {}) {
  const body = cleanText(text);
  const overview = body.match(/Company Overview for (.+?)\s*\(([A-Z0-9]{6,10})\)/i);
  const titleName = title?.match(/^(.+?)\s*-\s*Company Overview/i)?.[1]?.trim();
  const name = cleanText(overview?.[1] || titleName || '');
  const number = (overview?.[2] || url?.match(COMPANY_RE)?.[1] || '').toUpperCase();

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

  if (!name || !number) return null;

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
    const m = String(link).match(new RegExp(`^https?://${escapeRe(DOMAIN)}/company/([A-Z0-9]{6,10})/?$`, 'i'));
    if (m && !numbers.includes(m[1].toUpperCase())) numbers.push(m[1].toUpperCase());
  }
  return numbers;
}

function toRecord({ parsed, subject, matchQuality, confidence, cached = false, cacheAge = 0 }) {
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
    confidence,
    cached,
    cache_age_seconds: cacheAge,
    fields: parsed.fields,
    notes: parsed.notes,
  });
}

function toCandidate(parsed, subject) {
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
      throw badNumber('A UK company number must be 6-10 letters or digits (for example 00445790 or SC123456).');
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

      const confidence = nameSimilarity(subject, parsed.name);
      return {
        outcome: 'match',
        record: toRecord({ parsed, subject, matchQuality: 'exact', confidence }),
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
        const confidence = nameSimilarity(subject, parsed.name);
        // Only short-circuit on a genuine exact hit. A broad query such as
        // "Tesco" must see the official result list so it can return candidates instead
        // of silently picking the most prominent company.
        if (classifyMatch(subject, parsed.name) === 'exact') {
          return {
            outcome: 'match',
            record: toRecord({ parsed, subject, matchQuality: classifyMatch(subject, parsed.name), confidence }),
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
      .map((parsed) => ({ parsed, confidence: nameSimilarity(subject, parsed.name) }))
      .sort((a, b) => b.confidence - a.confidence);

    const plausible = scored.filter((item) => item.confidence >= CLOSE_THRESHOLD);
    if (plausible.length === 1) {
      const { parsed, confidence } = plausible[0];
      return {
        outcome: 'match',
        record: toRecord({ parsed, subject, matchQuality: classifyMatch(subject, parsed.name), confidence }),
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
        candidates: plausible.map(({ parsed }) => toCandidate(parsed, subject)),
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
