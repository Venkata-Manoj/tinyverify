import { badNumber, CLOSE_THRESHOLD, classifyMatch, cleanText, nameSimilarity, normalizeDate, normalizeStatus } from '../normalize.js';
import { makeRecord } from '../schema.js';

/**
 * Florida Department of Health — Medical Quality Assurance (MQA) licence search.
 *
 * The public service is an ASP.NET MVC form: a GET issues an anti-forgery token
 * and session cookie, the POST returns the result table, and each row links to
 * a server-rendered licence detail page. No API key is required.
 */

const BASE = 'https://mqa-internet.doh.state.fl.us/MQASearchServices/HealthCareProviders';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const detailUrl = (licInd, proCde) => `${BASE}/LicenseVerification?LicInd=${encodeURIComponent(licInd)}&ProCde=${encodeURIComponent(proCde)}`;

const ENTITIES = { '&amp;': '&', '&nbsp;': ' ', '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>' };

function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|td|th|dt|dd|section|article)>/gi, '\n')
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
    .map((match) => cleanText(htmlToText(match[1])));
}

/** Parse the MQA search result table. */
export function parseMqaSearch(html) {
  const body = String(html || '');
  const total = Number((body.match(/Search Results Total:\s*([\d,]+)/i)?.[1] || '').replace(/,/g, '')) || 0;
  const results = [];
  const seen = new Set();
  for (const match of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row = match[1];
    const link = row.match(/href="([^"]*LicenseVerification[^"]*)"/i)?.[1]?.replace(/&amp;/g, '&');
    if (!link) continue;
    const parsed = new URL(link, BASE);
    const licInd = parsed.searchParams.get('LicInd');
    const proCde = parsed.searchParams.get('ProCde');
    if (!licInd || !proCde) continue;
    const cells = cellsOf(row);
    const number = cleanText(cells[0]);
    const name = cleanText(cells[1]);
    if (!number || !name || seen.has(`${licInd}:${proCde}`)) continue;
    seen.add(`${licInd}:${proCde}`);
    const rawStatus = cleanText(cells[4] || '');
    results.push({
      number,
      name,
      profession: cleanText(cells[2] || '') || null,
      city: cleanText(cells[3] || '') || null,
      raw_status: rawStatus || null,
      status: normalizeStatus(rawStatus).status,
      lic_ind: licInd,
      pro_cde: proCde,
      source_url: detailUrl(licInd, proCde),
    });
  }
  return { total, results };
}

/** Parse a detail page's <dt>/<dd> label pairs, including labels that wrap an icon link. */
function labelPairs(body) {
  const pairs = new Map();
  const re = /<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi;
  for (const match of body.matchAll(re)) {
    const label = cleanText(htmlToText(match[1]).replace(/[?ⓘ]/g, ' '));
    const value = cleanText(htmlToText(match[2]));
    if (!label) continue;
    if (!pairs.has(label)) pairs.set(label, []);
    pairs.get(label).push(value);
  }
  return pairs;
}

const first = (pairs, label) => pairs.get(label)?.find((value) => value) ?? null;

function disciplineFlag(pairs, label) {
  const value = first(pairs, label);
  if (!value) return null;
  if (/^yes\b/i.test(value)) return true;
  if (/^no\b/i.test(value)) return false;
  return null;
}

/**
 * Parse the enforcement-actions tab. Only real table rows are evidence.
 * A page with no recognisable table is "unread", never "none found": the
 * detail page already told us discipline or a public complaint exists.
 */
export function parseEnforcementActions(html) {
  const body = String(html || '');
  const text = htmlToText(body);
  if (!text) return { records: [], readable: false };
  if (/no (disciplinary|enforcement|public complaint)|no actions? on file/i.test(text)) {
    return { records: [], readable: true };
  }
  const records = [];
  for (const row of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = cellsOf(row[1]).filter(Boolean);
    if (cells.length < 2) continue;
    if (cells.every((cell) => /^(discipline|action|type|date|status|description|case|order)$/i.test(cell))) continue;
    records.push({
      type: 'board enforcement action',
      date: normalizeDate(cells.find((cell) => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(cell)), { dayFirst: false }) || null,
      description: cells.join(' · '),
      status: null,
      source_url: null,
    });
  }
  return { records, readable: records.length > 0 };
}

/** Parse one MQA licence detail page. */
export function parseMqaPage(html, { url } = {}) {
  const body = String(html || '');
  const text = htmlToText(body);
  const pairs = labelPairs(body);
  const number = cleanText(text.match(/License Number:\s*([A-Z]{1,4}\d{2,10})/i)?.[1] || first(pairs, 'License') || '');
  const profession = first(pairs, 'Profession');
  // The holder's name is the first <h3> that is not the "License Number:" line.
  const nameFromHeading = [...body.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/gi)]
    .map((match) => cleanText(htmlToText(match[1])))
    .find((value) => value && !/^license number/i.test(value)) || null;
  // The search row still wins when available: it is the display name in the
  // register's own "Last, First" order.
  const rawStatus = first(pairs, 'License Status');
  const { status, detail } = normalizeStatus(rawStatus);
  const expiry = normalizeDate(first(pairs, 'License Expiration Date'), { dayFirst: false });
  const issued = normalizeDate(first(pairs, 'License Original Issue Date'), { dayFirst: false });
  const discipline = disciplineFlag(pairs, 'Discipline on File');
  const publicComplaint = disciplineFlag(pairs, 'Public Complaint');
  const licInd = String(url || '').match(/[?&]LicInd=([^&]+)/i)?.[1] ?? null;
  const proCde = String(url || '').match(/[?&]ProCde=([^&]+)/i)?.[1] ?? null;

  if (!number) return null;

  return {
    number,
    name: nameFromHeading || null,
    profession,
    raw_status: rawStatus,
    status,
    status_detail: detail,
    expiry_date: expiry,
    issue_date: issued,
    has_discipline: discipline,
    has_public_complaint: publicComplaint,
    lic_ind: licInd,
    pro_cde: proCde,
    address: first(pairs, 'Address of Record'),
    fields: {
      profession,
      license_number: number,
      license_status: rawStatus,
      license_expiration_date: expiry,
      license_original_issue_date: issued,
      address_of_record: first(pairs, 'Address of Record'),
      discipline_on_file: discipline === null ? 'not shown' : discipline ? 'yes' : 'no',
      public_complaint: publicComplaint === null ? 'not shown' : publicComplaint ? 'yes' : 'no',
      qualifications: pairs.get('Qualifications')?.filter(Boolean) ?? [],
    },
  };
}

async function getForm() {
  const res = await fetch(BASE, { headers: { 'user-agent': UA, accept: 'text/html' }, signal: AbortSignal.timeout(25_000) });
  if (!res.ok) throw new Error(`Florida MQA returned ${res.status} for the search form`);
  const html = await res.text();
  const token = html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/i)?.[1];
  if (!token) throw new Error('Florida MQA search form did not include an anti-forgery token');
  const cookies = res.headers.getSetCookie?.() ?? [];
  const cookie = cookies.map((value) => value.split(';')[0]).join('; ')
    || String(res.headers.get('set-cookie') || '').split(/,(?=[^;]+=)/).map((value) => value.split(';')[0]).join('; ');
  return { token, cookie };
}

/**
 * An exact licence number is answered with a 302 to the detail page instead of
 * a result table. Normalise that Location so the caller can read it directly.
 */
export function parseDirectLicenseUrl(location) {
  if (!location) return null;
  let url;
  try {
    url = new URL(location, BASE);
  } catch {
    return null;
  }
  if (!/LicenseVerification/i.test(url.pathname + url.search)) return null;
  const licInd = url.searchParams.get('LicInd');
  const proCde = url.searchParams.get('ProCde') || url.searchParams.get('Procde');
  if (!licInd || !proCde) return null;
  return detailUrl(licInd, proCde);
}

const NAME_SUFFIXES = new Set(['JR', 'SR', 'II', 'III', 'IV', 'V']);

function stripSuffix(parts) {
  const next = [...parts];
  while (next.length > 1 && NAME_SUFFIXES.has(String(next.at(-1)).replace(/\./g, '').toUpperCase())) next.pop();
  return next;
}

/**
 * Split a name for MQA's LastName/FirstName fields. Generational suffixes
 * (II, Jr) are not surnames; leaving them in LastName made "John Smith II"
 * search for a person called "II".
 */
export function splitMqaName(value) {
  const raw = String(value || '').replace(/\s+/g, ' ').trim();
  if (!raw) return { last: '', first: '' };
  if (raw.includes(',')) {
    const [last, ...rest] = raw.split(',');
    return {
      last: last.trim(),
      first: stripSuffix(rest.join(' ').replace(/,/g, ' ').split(' ').filter(Boolean)).join(' '),
    };
  }
  const parts = stripSuffix(raw.split(' ').filter(Boolean));
  if (parts.length >= 2) return { last: parts.at(-1), first: parts.slice(0, -1).join(' ') };
  return { last: parts[0] || '', first: '' };
}

async function search({ subject, number }) {
  const { token, cookie } = await getForm();
  const body = new URLSearchParams({
    __RequestVerificationToken: token,
    'SearchDto.Board': '',
    'SearchDto.Profession': '',
    'SearchDto.LicenseNumber': number ? String(number) : '',
    'SearchDto.BusinessName': '',
    'SearchDto.LastName': number ? '' : '',
    'SearchDto.FirstName': '',
    'SearchDto.City': '',
    'SearchDto.County': '',
    'SearchDto.ZipCode': '',
    'SearchDto.LicenseStatus': 'ALL',
  });
  if (!number) {
    const { last, first } = splitMqaName(subject);
    if (last) body.set('SearchDto.LastName', last);
    if (first) body.set('SearchDto.FirstName', first);
  }
  const res = await fetch(BASE, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'user-agent': UA,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'text/html',
      ...(cookie ? { cookie } : {}),
      referer: BASE,
    },
    body,
    signal: AbortSignal.timeout(40_000),
  });
  const directUrl = res.status >= 300 && res.status < 400 ? parseDirectLicenseUrl(res.headers.get('location')) : null;
  if (directUrl) return { html: '', cookie, directUrl };
  if (!res.ok) throw new Error(`Florida MQA search returned ${res.status}`);
  return { html: await res.text(), cookie, directUrl: null };
}

async function fetchDetail(result, cookie) {
  const res = await fetch(result.source_url, {
    headers: { 'user-agent': UA, accept: 'text/html', ...(cookie ? { cookie } : {}) },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Florida MQA detail returned ${res.status} for ${result.number}`);
  const html = await res.text();
  const parsed = parseMqaPage(html, { url: result.source_url });
  if (parsed) {
    // The search row carries the display name in "Last, First" order.
    if (result.name) parsed.name = result.name;
    parsed.profession = parsed.profession || result.profession;
  }
  return parsed;
}

/**
 * Read the enforcement tab when the detail page flags discipline or a public
 * complaint. The result distinguishes "read and none" from "could not read":
 * a failed tab must never be rendered as "none found".
 */
async function enforcementActions(parsed, cookie) {
  if (!parsed) return { records: [], status: 'unread', note: 'the licence detail was not available' };
  if (parsed.has_discipline === false && parsed.has_public_complaint === false) {
    return { records: [], status: 'none', note: null };
  }
  if (parsed.has_discipline === null && parsed.has_public_complaint === null) {
    return { records: [], status: 'unread', note: 'the detail page did not show discipline flags' };
  }
  if (!parsed.lic_ind || !parsed.pro_cde) {
    return { records: [], status: 'unread', note: 'the detail page did not expose the enforcement-tab identifiers' };
  }
  const url = `${BASE}/LoadEnforcementActionsTab?licInd=${encodeURIComponent(parsed.lic_ind)}&proCde=${encodeURIComponent(parsed.pro_cde)}`
    + `&hasDiscipline=${parsed.has_discipline ? 'True' : 'False'}&hasPublicComplaint=${parsed.has_public_complaint ? 'True' : 'False'}`;
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'text/html', ...(cookie ? { cookie } : {}), referer: parsed.source_url || BASE },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { records: [], status: 'unread', note: `the enforcement tab returned HTTP ${res.status}` };
    const parsedActions = parseEnforcementActions(await res.text());
    if (parsedActions.records.length) return { records: parsedActions.records, status: 'found', note: null };
    if (parsedActions.readable) return { records: [], status: 'none', note: null };
    return { records: [], status: 'unread', note: 'the enforcement tab did not contain a recognised action table' };
  } catch (err) {
    return { records: [], status: 'unread', note: `the enforcement tab could not be read (${err.message})` };
  }
}

function toCandidate(result, subject) {
  return {
    name: result.name,
    licence_number: result.number,
    jurisdiction: 'US-FL',
    status: result.status,
    status_detail: result.raw_status,
    source_url: result.source_url,
    source_name: 'Florida Department of Health (MQA)',
    registry_name: 'Florida Department of Health (MQA)',
    registry_id: 'mqa-fl',
    confidence: nameSimilarity(subject, result.name),
    extra: { profession: result.profession, city: result.city },
  };
}

function toRecord(parsed, subject, confidence, totalFound, discipline, sourceUrl) {
  const readState = discipline?.status || 'unread';
  const records = discipline?.records ?? [];
  const actions = records.length
    ? records.map((item) => [item.type, item.date, item.description, item.status].filter(Boolean).join(' — '))
    : readState === 'none'
      ? ['none found']
      : ['not read — the board’s enforcement tab could not be read'];
  const notes = [
    'Florida MQA publishes licence status, expiry and discipline for health professions licensed by the Florida Department of Health.',
  ];
  if (readState === 'none') notes.push('The detail page reports no discipline and no public complaint on file.');
  else if (readState === 'found') notes.push('Discipline or public-complaint records were read from the board’s enforcement tab.');
  else notes.push(`The detail page flags discipline or a public complaint, but the enforcement records could not be read: ${discipline?.note || 'unknown reason'}. This is not a clearance.`);
  return makeRecord({
    subject,
    licence_type: 'health',
    jurisdiction: 'US-FL',
    status: parsed.status,
    licence_number: parsed.number,
    expiry_date: parsed.expiry_date ?? null,
    disciplinary_actions: actions,
    disciplinary_records: records.map((item) => ({ ...item, source_url: sourceUrl || item.source_url })),
    source_name: 'Florida Department of Health (MQA)',
    source_url: sourceUrl || detailUrl(parsed.lic_ind, parsed.pro_cde),
    checked_at: new Date().toISOString(),
    match_quality: classifyMatch(subject, parsed.name),
    registry_id: 'mqa-fl',
    registry_name: 'Florida Department of Health (MQA)',
    status_detail: parsed.status_detail,
    matched_name: parsed.name,
    confidence,
    total_found: totalFound,
    fields: { ...parsed.fields, enforcement_actions_read: readState },
    notes,
  });
}

export const mqaFl = {
  meta: {
    id: 'mqa-fl',
    name: 'Florida Department of Health (MQA)',
    source_name: 'Florida Department of Health (MQA)',
    kind: 'fetch-direct',
    types: ['health'],
    jurisdictions: ['US-FL'],
    source_url: BASE,
    description: 'Florida MQA licence verification: profession, licence status, expiry, issue date and public discipline or complaint flags.',
    fields: ['status', 'licence_number', 'expiry_date', 'disciplinary_actions', 'profession', 'public complaint'],
  },

  async lookup({ subject, number }) {
    const searched = [];
    if (number && !/^[A-Z]{0,4}\d{2,10}$/i.test(String(number).replace(/\s/g, ''))) {
      throw badNumber('A Florida licence number must be 2-10 digits, optionally prefixed by letters (for example ME182088).');
    }
    const licenceNumber = number ? String(number).replace(/\s+/g, '').toUpperCase() : '';
    const { html, cookie, directUrl } = await search({ subject, number: licenceNumber });

    if (directUrl) {
      searched.push({ url: directUrl, kind: 'licence-detail', via: 'official-number-redirect', results: 1 });
      const parsed = await fetchDetail({ source_url: directUrl, number: licenceNumber, name: null }, cookie);
      const sameNumber = parsed && String(parsed.number).replace(/[^A-Z0-9]/gi, '').toUpperCase()
        === licenceNumber.replace(/[^A-Z0-9]/gi, '').toUpperCase();
      if (!parsed || !sameNumber) {
        return {
          outcome: 'no_match',
          source_url: directUrl,
          searched,
          candidates: [],
          total_found: 1,
          detail: parsed
            ? `Florida MQA redirected to licence ${parsed.number}, which is not "${licenceNumber}".`
            : `Florida MQA could not read licence ${licenceNumber}.`,
        };
      }
      const discipline = await enforcementActions(parsed, cookie);
      return {
        outcome: 'match',
        record: toRecord(parsed, subject, nameSimilarity(subject, parsed.name), 1, discipline, directUrl),
        source_url: directUrl,
        total_found: 1,
        searched,
        detail: `Florida MQA resolved licence ${parsed.number} directly from the official number search.`,
      };
    }

    const { total, results } = parseMqaSearch(html);
    searched.push({ url: BASE, kind: 'search-list', via: 'official-search', results: results.length });

    if (!results.length) {
      return {
        outcome: 'no_match',
        source_url: BASE,
        searched,
        candidates: [],
        total_found: total,
        detail: number
          ? `Florida MQA returned no licence for "${number}".`
          : `Florida MQA returned no licences for "${subject}".`,
      };
    }

    const scored = results
      .map((result) => ({ result, confidence: nameSimilarity(subject, result.name) }))
      .sort((a, b) => b.confidence - a.confidence);
    const plausible = scored.filter((item) => item.confidence >= CLOSE_THRESHOLD);

    const materialize = async (result) => {
      const parsed = await fetchDetail(result, cookie);
      if (!parsed) return null;
      const discipline = await enforcementActions(parsed, cookie);
      const sourceUrl = parsed.lic_ind && parsed.pro_cde ? detailUrl(parsed.lic_ind, parsed.pro_cde) : result.source_url;
      return { parsed, discipline, sourceUrl };
    };

    if (number) {
      const chosen = scored[0];
      const material = await materialize(chosen.result);
      if (!material) {
        return { outcome: 'no_match', source_url: chosen.result.source_url, searched, candidates: [], total_found: total, detail: `Florida MQA could not read licence ${number}.` };
      }
      const returned = String(material.parsed.number).replace(/[^A-Z0-9]/gi, '').toUpperCase();
      if (returned !== licenceNumber) {
        return {
          outcome: 'no_match',
          source_url: material.sourceUrl,
          searched,
          candidates: [],
          total_found: total,
          detail: `Florida MQA returned licence ${material.parsed.number}, not the requested ${licenceNumber}.`,
        };
      }
      return {
        outcome: 'match',
        record: toRecord(material.parsed, subject, chosen.confidence, total, material.discipline, material.sourceUrl),
        source_url: material.sourceUrl,
        total_found: total,
        searched,
        detail: `Fetched Florida licence ${material.parsed.number} directly.`,
      };
    }

    if (plausible.length === 1) {
      const material = await materialize(plausible[0].result);
      if (!material) throw new Error(`Florida MQA licence ${plausible[0].result.number} could not be read`);
      return {
        outcome: 'match',
        record: toRecord(material.parsed, subject, plausible[0].confidence, total, material.discipline, material.sourceUrl),
        source_url: material.sourceUrl,
        total_found: total,
        searched,
        detail: `One plausible Florida licence among ${results.length} search results.`,
      };
    }

    if (plausible.length > 1) {
      return {
        outcome: 'multiple',
        source_url: BASE,
        searched,
        total_found: total,
        candidates: plausible.slice(0, 20).map(({ result }) => toCandidate(result, subject)),
        detail: `${Math.max(plausible.length, total)} Florida licences matched "${subject}". Add a licence number to choose one.`,
      };
    }

    return {
      outcome: 'no_match',
      source_url: BASE,
      searched,
      total_found: total,
      candidates: scored.slice(0, 10).map(({ result }) => toCandidate(result, subject)),
      detail: `Florida MQA returned ${total || results.length} licences, but none matched "${subject}" closely enough to return without guessing.`,
    };
  },
};
