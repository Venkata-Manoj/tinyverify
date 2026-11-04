import { agentExtract, searchWeb } from '../tinyfish.js';
import { config } from '../config.js';
import { classifyMatch, cleanText, nameSimilarity, normalizeDate, normalizeStatus } from '../normalize.js';
import { makeRecord } from '../schema.js';

const DOMAIN = 'cslb.ca.gov';
const HOME = `https://www.${DOMAIN}`;
const detailUrl = (number) => `${HOME}/${String(number).replace(/\D/g, '')}`;
const numberFromUrl = (url) => {
  const value = String(url || '');
  const short = value.match(/^https?:\/\/www\.cslb\.ca\.gov\/(\d{3,8})\/?$/i)?.[1];
  if (short) return short;
  return value.match(/LicNum=(\d{3,8})/i)?.[1] ?? null;
};

const ENTITIES = { '&amp;': '&', '&nbsp;': ' ', '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>' };
function htmlToLines(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|td|th|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&[a-z]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

const afterLabel = (text, label) => {
  const re = new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\n+([^\\n]+)`, 'i');
  const m = text.match(re);
  return m ? cleanText(m[1]) : null;
};

const section = (text, start, end) => {
  const from = text.search(new RegExp(start, 'i'));
  if (from < 0) return '';
  const rest = text.slice(from + text.slice(from).search(/\n/) + 1);
  const to = end ? rest.search(new RegExp(end, 'i')) : -1;
  return to >= 0 ? rest.slice(0, to) : rest;
};

/** Parse the server-rendered CSLB licence detail page. */
export function parseCslbPage(html, { url } = {}) {
  const text = htmlToLines(html);
  if (/License Number does not exist/i.test(text)) {
    return { exists: false, number: numberFromUrl(url) };
  }

  const header = text.match(/Contractor's License Detail for License #\s*\n?\s*(\d{3,8})/i);
  const number = header?.[1] || numberFromUrl(url);
  const businessBlock = section(text, 'Business Information', 'Business Phone Number|Entity\\b');
  const lines = businessBlock.split('\n').map(cleanText).filter(Boolean);
  const name = lines[0] || null;
  const addressLines = lines.slice(1).filter((l) => !/^Business Phone/i.test(l));
  const stateIndex = addressLines.findIndex((l) => /,\s*[A-Z]{2}\s+\d{5}/.test(l) || /^[A-Z]{2}\s+\d{5}/.test(l));
  const address = stateIndex >= 0
    ? [addressLines[0], addressLines.slice(1, stateIndex + 1).join(' ')].filter(Boolean).join(', ')
    : addressLines.join(', ');
  const phone = text.match(/Business Phone Number:\s*([^\n]+)/i)?.[1]?.trim() || null;

  const rawStatus = afterLabel(text, 'License Status');
  const { status, detail } = normalizeStatus(rawStatus);
  const additional = section(text, 'Additional Status', 'Classifications|Bonding Information|Workers');
  const complaintDisclosure = /There is Complaint Disclosure information for this license/i.test(text);
  const noComplaint = /No Complaint Disclosure information/i.test(text);

  const classifications = [];
  for (const line of section(text, 'Classifications', 'Bonding Information|Workers').split('\n')) {
    const value = cleanText(line);
    if (/^[A-Z0-9][A-Z0-9 /&.-]{0,12}\s*-\s*.+/.test(value)) classifications.push(value);
  }

  const bond = section(text, "Contractor's Bond", 'Bond of Qualifying Individual|Workers');
  const bondNumber = bond.match(/Bond Number:\s*([A-Z0-9-]+)/i)?.[1] ?? null;
  const workers = /workers compensation insurance/i.test(text)
    ? 'Covered'
    : /exempt from having workers compensation/i.test(text)
      ? 'Exempt'
      : null;

  if (!name || !number) return { exists: false, number };

  const fields = {
    business_name: name,
    address: address || null,
    phone,
    entity: afterLabel(text, 'Entity'),
    issue_date: normalizeDate(afterLabel(text, 'Issue Date'), { dayFirst: false }),
    expire_date: normalizeDate(afterLabel(text, 'Expire Date'), { dayFirst: false }),
    classifications,
    complaint_disclosure: complaintDisclosure ? 'on file' : noComplaint ? 'none' : 'not shown',
    additional_status: cleanText(additional) || null,
    bond_number: bondNumber,
    workers_compensation: workers,
    data_current_as_of: text.match(/Data current as of\s*([^\n]+)/i)?.[1]?.trim() || null,
  };

  const disciplinary = complaintDisclosure
    ? ['Public complaint disclosure on file — review the CSLB source for details']
    : ['none found'];

  const notes = [
    'CSLB is the California state contractor licensing board. Expiry date is the licence expiration shown by CSLB.',
  ];
  if (complaintDisclosure) notes.push('Complaint disclosure is published by CSLB under B&P 7124.6; read the source before relying on it.');

  return {
    exists: true,
    name,
    number,
    raw_status: rawStatus,
    status,
    status_detail: detail,
    fields,
    disciplinary,
    notes,
  };
}

function toCandidate(parsed, subject) {
  return {
    name: parsed.name,
    licence_number: parsed.number,
    jurisdiction: 'US-CA',
    status: parsed.status,
    status_detail: parsed.status_detail,
    source_url: detailUrl(parsed.number),
    source_name: 'California CSLB',
    registry_name: 'California CSLB',
    registry_id: 'cslb-ca',
    confidence: nameSimilarity(subject, parsed.name),
    extra: { expiry_date: parsed.fields?.expire_date ?? null, entity: parsed.fields?.entity ?? null },
  };
}

function toRecord(parsed, subject, confidence) {
  return makeRecord({
    subject,
    licence_type: 'contractor',
    jurisdiction: 'US-CA',
    status: parsed.status,
    licence_number: parsed.number,
    expiry_date: parsed.fields?.expire_date ?? null,
    disciplinary_actions: parsed.disciplinary,
    source_name: 'California CSLB',
    source_url: detailUrl(parsed.number),
    checked_at: new Date().toISOString(),
    match_quality: classifyMatch(subject, parsed.name),
    registry_id: 'cslb-ca',
    registry_name: 'California CSLB',
    status_detail: parsed.status_detail,
    matched_name: parsed.name,
    confidence,
    fields: parsed.fields,
    notes: parsed.notes,
  });
}

async function fetchDetail(number) {
  const url = detailUrl(number);
  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; TinyVerify/0.1; licence verification tool)' },
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`CSLB returned ${res.status} for licence ${number}`);
  return { html: await res.text(), url };
}

/* CSLB's name search is a session-based ASP.NET form that plain fetches cannot
   drive. When TinyFish Search finds no record URL, TinyFish Agent drives the real
   form in a browser and returns the licence numbers, which are then verified
   against the official detail pages — the agent never supplies a status. */

const AGENT_SCHEMA = {
  type: 'object',
  properties: {
    found: { type: 'boolean' },
    matches: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          business_name: { type: 'string' },
          licence_number: { type: 'string' },
        },
        required: ['business_name', 'licence_number'],
      },
    },
    page_note: { type: 'string' },
  },
  required: ['found', 'matches'],
};

const agentSeconds = () => Number(process.env.TINYVERIFY_CSLB_AGENT_SECONDS || 150);
const agentCache = new Map(); // query -> { at, value }; keeps a slow fallback from running twice
const AGENT_CACHE_MS = 10 * 60 * 1000;

async function agentLicenceNumbers(query) {
  if (!config.allowAgent) return { ok: false, numbers: [], note: 'Agent fallback is disabled.' };
  const key = query.trim().toLowerCase();
  const cached = agentCache.get(key);
  if (cached && Date.now() - cached.at < AGENT_CACHE_MS) return cached.value;
  const goal = `Use the CSLB "Check A License" public tool on this page. Choose "Check by Business Name", type "${query}" into the business name field, and submit the search. Return up to 10 matching contractor licence numbers and business names exactly as shown in the results. Do not guess or invent a licence number. If the search returns no results or the form cannot be used, set found=false and explain why in page_note.`;
  const run = await agentExtract({
    url: `${HOME}/OnlineServices/CheckLicenseII/CheckLicense.aspx`,
    goal,
    schema: AGENT_SCHEMA,
    maxDurationSeconds: agentSeconds(),
  });
  const result = run.result && typeof run.result === 'object' ? run.result : {};
  const matches = Array.isArray(result.matches) ? result.matches : [];
  const numbers = [...new Set(matches
    .map((match) => String(match?.licence_number ?? '').replace(/\D/g, ''))
    .filter((value) => /^\d{3,8}$/.test(value)))];
  const value = {
    ok: true,
    numbers,
    matches,
    found: result.found === true,
    note: result.page_note ? String(result.page_note).slice(0, 500) : null,
    run_id: run.run_id ?? null,
    steps: run.steps ?? null,
  };
  agentCache.set(key, { at: Date.now(), value });
  return value;
}

export const cslb = {
  meta: {
    id: 'cslb-ca',
    name: 'California CSLB',
    source_name: 'California CSLB',
    kind: 'fetch-direct',
    types: ['contractor'],
    jurisdictions: ['US-CA'],
    source_url: HOME,
    description: 'California Contractors State License Board: licence status, number, expiry, classifications and public complaint disclosure.',
    fields: ['status', 'licence_number', 'expiry_date', 'disciplinary_actions', 'classifications', 'bond'],
  },

  async lookup({ subject, number, variant }) {
    const searched = [];
    const query = variant || subject;

    if (number) {
      const normalized = String(number).replace(/\D/g, '');
      if (!/^\d{3,8}$/.test(normalized)) throw new Error('A CSLB licence number must be 3-8 digits');
      const { html, url } = await fetchDetail(normalized);
      const parsed = parseCslbPage(html, { url });
      searched.push({ url, kind: 'record', via: 'number' });
      if (!parsed?.exists) {
        return { outcome: 'no_match', source_url: url, searched, candidates: [], detail: `CSLB has no licence number ${normalized}.` };
      }
      const confidence = nameSimilarity(subject, parsed.name);
      return {
        outcome: 'match',
        record: toRecord(parsed, subject, confidence),
        source_url: url,
        searched,
        detail: `Fetched CSLB licence ${normalized} directly.`,
      };
    }

    // CSLB's server-side name search is form/session based; TinyFish Search resolves
    // the official short record URL instead, which is stable and scrapeable.
    const search = await searchWeb({
      query: `"${query}" contractor license`,
      includeDomains: DOMAIN,
      location: 'US',
      language: 'en',
    });
    searched.push({ url: `${HOME}/OnlineServices/CheckLicenseII/CheckLicense.aspx`, kind: 'search', via: 'tinyfish-search', results: search.results?.length ?? 0 });

    const numbers = [...new Set((search.results || []).map((r) => numberFromUrl(r.url)).filter(Boolean))].slice(0, 6);
    if (numbers.length) {
      const pages = await Promise.all(numbers.map(async (n) => {
        try {
          const { html, url } = await fetchDetail(n);
          return parseCslbPage(html, { url });
        } catch {
          return null;
        }
      }));
      const parsedPages = pages.filter((p) => p?.exists);
      const scored = parsedPages
        .map((parsed) => ({ parsed, confidence: nameSimilarity(subject, parsed.name) }))
        .sort((a, b) => b.confidence - a.confidence);

      const plausible = scored.filter((item) => item.confidence >= 0.62);
      if (plausible.length === 1) {
        const { parsed, confidence } = plausible[0];
        return {
          outcome: 'match',
          record: toRecord(parsed, subject, confidence),
          source_url: detailUrl(parsed.number),
          searched,
          detail: `One plausible CSLB licence among ${parsedPages.length} official records.`,
        };
      }
      if (plausible.length > 1) {
        return {
          outcome: 'multiple',
          source_url: `${HOME}/OnlineServices/CheckLicenseII/CheckLicense.aspx`,
          searched,
          candidates: plausible.map(({ parsed }) => toCandidate(parsed, subject)),
          detail: `${plausible.length} CSLB licences matched "${query}".`,
        };
      }
      return {
        outcome: 'no_match',
        source_url: `${HOME}/OnlineServices/CheckLicenseII/CheckLicense.aspx`,
        searched,
        candidates: scored.slice(0, 5).map(({ parsed }) => toCandidate(parsed, subject)),
        detail: `CSLB returned ${scored.length} records, but none matched "${query}" closely enough to return without guessing.`,
      };
    }

    // Search could not resolve a record URL: drive CSLB's form with the Agent.
    // Only on the first (as-entered) name variant so retries cannot multiply runs.
    let agent = null;
    if (!variant || variant === subject) {
      try {
        agent = await agentLicenceNumbers(query);
        searched.push({
          url: `${HOME}/OnlineServices/CheckLicenseII/CheckLicense.aspx`,
          kind: 'search',
          via: 'tinyfish-agent',
          results: agent.numbers.length,
          detail: `TinyFish Agent run ${agent.run_id || 'unknown'}${agent.note ? `: ${agent.note}` : ''}`,
        });
      } catch (err) {
        searched.push({
          url: `${HOME}/OnlineServices/CheckLicenseII/CheckLicense.aspx`,
          kind: 'search',
          via: 'tinyfish-agent',
          results: 0,
          detail: `TinyFish Agent fallback failed: ${err.message}`,
        });
      }
    }

    const agentNumbers = (agent?.numbers ?? []).slice(0, 6);
    if (!agentNumbers.length) {
      return {
        outcome: 'no_match',
        source_url: `${HOME}/OnlineServices/CheckLicenseII/CheckLicense.aspx`,
        searched,
        candidates: [],
        detail: `Neither TinyFish Search nor the TinyFish Agent found a CSLB licence page for "${query}". CSLB name search is form-based, so a licence number is the reliable input.`,
      };
    }

    const agentPages = await Promise.all(agentNumbers.map(async (n) => {
      try {
        const { html, url } = await fetchDetail(n);
        return parseCslbPage(html, { url });
      } catch {
        return null;
      }
    }));
    const agentScored = agentPages
      .filter((p) => p?.exists)
      .map((parsed) => ({ parsed, confidence: nameSimilarity(subject, parsed.name) }))
      .sort((a, b) => b.confidence - a.confidence);
    const agentPlausible = agentScored.filter((item) => item.confidence >= 0.62);

    if (agentPlausible.length === 1) {
      const { parsed, confidence } = agentPlausible[0];
      return {
        outcome: 'match',
        record: toRecord(parsed, subject, confidence),
        source_url: detailUrl(parsed.number),
        searched,
        detail: `TinyFish Agent resolved ${agentNumbers.length} CSLB licence number(s) from the form; ${parsed.number} was the only plausible match.`,
      };
    }
    if (agentPlausible.length > 1) {
      return {
        outcome: 'multiple',
        source_url: `${HOME}/OnlineServices/CheckLicenseII/CheckLicense.aspx`,
        searched,
        candidates: agentPlausible.map(({ parsed }) => toCandidate(parsed, subject)),
        detail: `TinyFish Agent resolved ${agentNumbers.length} CSLB licence numbers; ${agentPlausible.length} matched "${query}".`,
      };
    }
    return {
      outcome: 'no_match',
      source_url: `${HOME}/OnlineServices/CheckLicenseII/CheckLicense.aspx`,
      searched,
      candidates: agentScored.slice(0, 5).map(({ parsed }) => toCandidate(parsed, subject)),
      detail: `The Agent found ${agentNumbers.length} licence number(s) but none of the official records matched "${query}" closely enough.`,
    };
  },
};
