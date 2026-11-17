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

/** The "Previous company names" table section of a detail page, if any. */
const previousNamesSection = (text) =>
  cleanText(text).split(/Previous company names/i)[1]?.split(/\n##\s/)[0] ?? '';

/** Case-insensitive, punctuation-tolerant form of a name for table checks. */
const foldForConfirmation = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * FIX 3: a search page's "Matching previous names" row only marks a match when
 * the company detail page's own "Previous company names" table carries that
 * former name. Comparison folds case and punctuation, so "WILKO,LIMITED"
 * confirms "WILKO LIMITED" — but a different name never does.
 */
export function confirmsPreviousName(detailText, formerName) {
  const target = foldForConfirmation(formerName);
  if (!target) return false;
  for (const m of previousNamesSection(detailText).matchAll(/^\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/gm)) {
    if (/^name$/i.test(m[1]) || /^-+$/.test(m[1])) continue;
    if (foldForConfirmation(m[1]) === target) return true;
  }
  return false;
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
  const prevSection = previousNamesSection(body);
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

/**
 * FIX 3: companies whose FORMER name matched the query carry a "Matching
 * previous names" block on the search page. In the extracted markdown that
 * block belongs to the company number that FOLLOWS it, so former names are
 * buffered until the next numbered result line. Companies without a block get
 * an empty list.
 */
export function parseSearchResults(text) {
  const results = [];
  let pending = [];
  let expectingNames = false;
  for (const rawLine of cleanText(text).split('\n')) {
    const line = rawLine.trim();
    const numberMatch = line.match(/^(?:\*\s*)?(\d{8}|[A-Z]{2}\d{6})\s+-\s+\S/);
    if (numberMatch) {
      results.push({ number: numberMatch[1].toUpperCase(), previousNames: pending });
      pending = [];
      expectingNames = false;
      continue;
    }
    if (/^(?:\*\s*)?Matching previous names\b/i.test(line)) {
      expectingNames = true;
      continue;
    }
    if (expectingNames && line) {
      // The former names follow the label on the next line, separated by "·".
      pending.push(...line.split('·').map((name) => name.trim()).filter(Boolean));
      expectingNames = false;
    }
  }
  return results;
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

function toCandidate(parsed, subject, matchedVia = null, previousName = null, confidence = null) {
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
    confidence: confidence ?? nameSimilarity(subject, parsed.name),
    matched_via: matchedVia,
    previous_name: previousName,
  };
}

/**
 * FIX 3: score one fetched detail page against the subject. Former-name
 * candidates come from the search page's "Matching previous names" rows and
 * must be confirmed against the detail page's own "Previous company names"
 * table (confirmsPreviousName) before they may count; the table entries
 * themselves remain a second source via previousNameHit. A confirmed former
 * name only marks the match when it outscores the current name.
 */
function subjectMatch(subject, parsed, detailText, searchRows = []) {
  const current = nameSimilarity(subject, parsed.name);
  let previous = null;
  for (const formerName of searchRows) {
    if (!confirmsPreviousName(detailText, formerName)) continue;
    const score = nameSimilarity(subject, formerName);
    if (score >= CLOSE_THRESHOLD && (!previous || score > previous.confidence)) {
      previous = { name: String(formerName), confidence: score };
    }
  }
  const tableHit = previousNameHit(subject, parsed);
  if (tableHit && (!previous || tableHit.confidence > previous.confidence)) previous = tableHit;
  const viaPrevious = previous && previous.confidence > current ? previous : null;
  return { current, confidence: viaPrevious ? previous.confidence : current, viaPrevious };
}

/**
 * FIX 3: pick the outcome from the detail pages fetched for an official
 * search. A current-name company and a confirmed former-name company matching
 * together is 'multiple' with BOTH candidates; former-name-only matches return
 * the best one as a close match reported via previous_name.
 */
export function selectSearchMatch(subject, items, searchResults = []) {
  const rowsByNumber = new Map(searchResults.map((row) => [row.number, row.previousNames]));
  const scored = items
    .map(({ parsed, text }) => ({ parsed, ...subjectMatch(subject, parsed, text, rowsByNumber.get(parsed.number) ?? []) }))
    .sort((a, b) => b.confidence - a.confidence);

  const currentMatches = scored.filter((item) => !item.viaPrevious && item.current >= CLOSE_THRESHOLD);
  const previousMatches = scored.filter((item) => item.viaPrevious);

  if (currentMatches.length && previousMatches.length) {
    return {
      outcome: 'multiple',
      candidates: [
        ...currentMatches.map((item) => toCandidate(item.parsed, subject, null, null, item.confidence)),
        ...previousMatches.map((item) => toCandidate(item.parsed, subject, 'previous_name', item.viaPrevious.name, item.confidence)),
      ],
      detail: `${currentMatches.length} current-name and ${previousMatches.length} former-name record${previousMatches.length === 1 ? '' : 's'} matched "${subject}".`,
    };
  }
  if (previousMatches.length === 1) {
    const { parsed, confidence, viaPrevious } = previousMatches[0];
    return {
      outcome: 'match',
      record: toRecord({
        parsed,
        subject,
        matchQuality: 'close',
        confidence,
        matchedVia: 'previous_name',
        previousName: viaPrevious.name,
      }),
      detail: `One plausible match among ${items.length} official results.`,
    };
  }
  if (previousMatches.length > 1) {
    return {
      outcome: 'multiple',
      candidates: previousMatches.map((item) => toCandidate(item.parsed, subject, 'previous_name', item.viaPrevious.name, item.confidence)),
      detail: `${previousMatches.length} former-name records matched "${subject}".`,
    };
  }
  if (currentMatches.length === 1) {
    const { parsed, confidence } = currentMatches[0];
    return {
      outcome: 'match',
      record: toRecord({ parsed, subject, matchQuality: classifyMatch(subject, parsed.name), confidence }),
      detail: `One plausible match among ${items.length} official results.`,
    };
  }
  if (currentMatches.length > 1) {
    return {
      outcome: 'multiple',
      candidates: currentMatches.map((item) => toCandidate(item.parsed, subject, null, null, item.confidence)),
      detail: `${currentMatches.length} plausible company records matched "${subject}".`,
    };
  }
  if (scored.length) {
    return {
      outcome: 'no_match',
      candidates: scored.slice(0, 5).map(({ parsed }) => toCandidate(parsed, subject)),
      detail: `Found ${scored.length} official records, but none matched "${subject}" closely enough to return without guessing.`,
    };
  }
  return {
    outcome: 'no_match',
    candidates: [],
    detail: 'Companies House returned results, but their detail pages could not be parsed.',
  };
}

/**
 * FIX 3: companies whose former name also matches the subject, besides an
 * exact current-name record already in hand. Reads the official search page's
 * "Matching previous names" rows, keeps rows that could match the subject,
 * then fetches each company's detail page and keeps only former names that the
 * page's own "Previous company names" table confirms. `skipNumber` is the
 * exact record already found. Throws on network failure; the caller decides
 * how to report that against the exact record it already has.
 */
async function confirmedFormerNameMatches(subject, query, skipNumber, searched) {
  const searchUrl = `${HOME}/search/companies?q=${encodeURIComponent(query)}`;
  const searchPage = await fetchPages([searchUrl], { ttl: 0, links: true });
  const rows = parseSearchResults(searchPage[0]?.text ?? '');
  searched.push({ url: searchUrl, kind: 'search-list', via: 'former-name-check', results: parseSearchLinks(searchPage[0]?.links ?? []).length });

  const rowNumbers = [...new Set(rows
    .filter((row) => row.number !== skipNumber && row.previousNames.some((name) => nameSimilarity(subject, name) >= CLOSE_THRESHOLD))
    .map((row) => row.number))];
  if (!rowNumbers.length) return [];

  const pages = await fetchPages(rowNumbers.slice(0, 6).map(COMPANY_URL), { ttl: 0 });
  const rowsByNumber = new Map(rows.map((row) => [row.number, row.previousNames]));
  const competitors = [];
  for (const page of pages) {
    const parsed = parseCompanyPage(page.text, { url: page.final_url, title: page.title });
    if (!parsed) continue;
    const match = subjectMatch(subject, parsed, page.text, rowsByNumber.get(parsed.number) ?? []);
    if (match.viaPrevious) {
      competitors.push(toCandidate(parsed, subject, 'previous_name', match.viaPrevious.name, match.confidence));
    }
  }
  return competitors;
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
          // FIX 3: an exact current-name hit can coexist with a company whose
          // FORMER name matches the same query. The official search page's
          // "Matching previous names" rows name those companies; their detail
          // pages must confirm the former name before they may join the answer.
          let competitors = [];
          let competitorError = null;
          try {
            competitors = await confirmedFormerNameMatches(subject, query, parsed.number, searched);
          } catch (err) {
            competitorError = err;
          }
          if (competitors.length) {
            return {
              outcome: 'multiple',
              source_url: COMPANY_URL(parsed.number),
              searched,
              candidates: [toCandidate(parsed, subject, null, null, ctx.confidence), ...competitors],
              detail: `The exact record ${parsed.number} plus ${competitors.length} confirmed former-name match${competitors.length === 1 ? '' : 'es'}.`,
            };
          }
          const record = toRecord({ parsed, subject, matchQuality: quality, confidence: ctx.confidence, matchedVia: ctx.viaPrevious ? 'previous_name' : null, previousName: ctx.viaPrevious ? ctx.viaPrevious.name : null });
          if (competitorError) {
            // The exact record itself was verified; say plainly that the
            // former-name cross-check did not run to completion.
            record.notes.push(`Former-name cross-check failed (${competitorError.message}); only the current-name record above was checked.`);
          }
          return {
            outcome: 'match',
            record,
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
    const items = pages
      .map((page) => ({ parsed: parseCompanyPage(page.text, { url: page.final_url, title: page.title }), text: page.text }))
      .filter((item) => item.parsed);

    // FIX 3: the search page's own "Matching previous names" rows say which
    // companies matched through a former name; the detail pages confirm them.
    const selection = selectSearchMatch(subject, items, parseSearchResults(searchPage[0]?.text ?? ''));

    if (selection.outcome === 'match') {
      return {
        outcome: 'match',
        record: selection.record,
        source_url: COMPANY_URL(selection.record.licence_number),
        searched,
        detail: selection.detail,
      };
    }
    if (selection.outcome === 'multiple') {
      return {
        outcome: 'multiple',
        source_url: searchUrl,
        searched,
        candidates: selection.candidates,
        detail: selection.detail,
      };
    }
    return {
      outcome: 'no_match',
      source_url: searchUrl,
      searched,
      candidates: selection.candidates,
      detail: selection.detail,
    };
  },
};
