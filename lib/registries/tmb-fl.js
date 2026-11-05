import { badNumber, CLOSE_THRESHOLD, classifyMatch, cleanText, nameSimilarity, normalizeName, normalizeStatus } from '../normalize.js';
import { makeRecord } from '../schema.js';

const HOME = 'https://profile.tmb.state.tx.us';
const SEARCH = `${HOME}/Search.aspx`;
const DETAIL = (npiOrLicense) => `${HOME}/Profile.aspx?License=${npiOrLicense}`;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<(\/p|div|li|tr|h[1-6]|td|th|dt|dd|caption|section|article)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

function cellsOfRow(row) {
  return [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
    .map((m) => htmlToText(m[1]))
    .filter((v, i, all) => v || i < all.length);
}

function thValue(body, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = body.match(new RegExp(`<th[^>]*>\\s*${escaped}\\s*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>`, 'i'));
  return match ? htmlToText(match[1]) : null;
}

function parseSearchResults(html) {
  const body = htmlToText(html);
  const results = [];
  // The search table has rows with physician data
  for (const tr of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const rowHtml = tr[1];
    // Skip header rows and non-data rows
    if (/^(License Number|Name|License Type|Active)/i.test(rowHtml)) continue;
    const cells = cellsOfRow(rowHtml);
    if (cells.length < 4) continue;
    const abnOrNumber = cells[0] || '';
    const lastName = cells[1] || '';
    const firstName = cells[2] || '';
    const licenseType = cells[3] || '';
    const status = cells[4] || '';
    const name = [lastName, firstName].filter(Boolean).join(' ').trim() || undefined;
    if (!name) continue;
    results.push({
      abn: abnOrNumber,
      name,
      license_type: licenseType,
      status,
      source_url: `${DETAIL(abnOrNumber)}`,
    });
  }
  return results;
}

function parseDetailPage(html) {
  const body = htmlToText(html);
  const number = body.match(/License Number:\s*([^\n]+)/i)?.[1]?.trim() || '';
  const name = body.match(/Physician Name:\s*([^\n]+)/i)?.[1]?.trim() || '';
  const statusRaw = body.match(/License Status:\s*([^\n]+)/i)?.[1]?.trim() || '';
  const { status, detail } = normalizeStatus(statusRaw);
  const expiryRaw = body.match(/Expiry Date:\s*([^\n]+)/i)?.[1]?.trim() || null;
  const expiry = expiryRaw ? normalizeDate(expiryRaw) : null;
  const disciplineRaw = body.match(/Board Actions:\s*([^\n]+)/i)?.[1]?.trim() || null;
  const hasDiscipline = disciplineRaw ? /(suspended|revoked|prohibit|order|action)/i.test(disciplineRaw) : false;
  const discipline = disciplineRaw || null;
  const sourceUrl = `${HOME}/Profile.aspx?License=${number}`;

  return {
    number: number || undefined,
    name: name || undefined,
    status,
    status_detail: detail,
    expiry_date: expiry,
    has_discipline: hasDiscipline,
    discipline,
    source_url: sourceUrl,
  };
}

export const tmbFl = {
  meta: {
    id: 'tmb-fl',
    name: 'Texas Medical Board',
    source_name: 'Texas Medical Board',
    kind: 'fetch-direct',
    types: ['health'],
    jurisdictions: ['US-TX'],
    source_url: HOME,
    description: 'Texas Medical Board: look up physician licence status, expiry date and Board actions.',
    fields: ['status', 'licence_number', 'expiry_date', 'disciplinary_actions', 'status_detail'],
  },

  async lookup({ subject, number, variant }) {
    const searched = [];

    if (number) {
      // Number lookup: fetch detail page directly
      const detailUrl = new URL(`${DETAIL(number)}`, HOME).href;
      let page;
      try {
        const res = await fetch(detailUrl, {
          headers: { 'User-Agent': UA, accept: 'text/html' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        page = { html: await res.text(), url: res.url };
      } catch (err) {
        return {
          outcome: 'no_match',
          source_url: detailUrl,
          searched,
          candidates: [],
          detail: `Texas Medical Board detail page could not be fetched for license ${number}.`,
        };
      }
      const parsed = parseDetailPage(page.html);
      if (!parsed.number || !parsed.name) {
        return {
          outcome: 'no_match',
          source_url: detailUrl,
          searched,
          candidates: [],
          detail: `Texas Medical Board has no record for license ${number}.`,
        };
      }
      const confidence = nameSimilarity(subject, parsed.name);
      return {
        outcome: 'match',
        record: toRecord(parsed, subject, confidence, { total_found: 1, total_capped: false, total_display: null }),
        source_url: parsed.source_url,
        total_found: 1,
        total_capped: false,
        total_display: null,
        searched: [{ url: detailUrl, kind: 'record', via: 'number' }],
        detail: `Fetched Texas Medical Board record ${parsed.number} directly.`,
      };
    }

    // Search by name
    const form = new URLSearchParams(f);
    let page;
    try {
      const res = await fetch(SEARCH, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      page = { html: await res.text(), url: res.url };
    } catch (err) {
      return {
        outcome: 'no_match',
        source_url: SEARCH,
        searched,
        candidates: [],
        detail: `Texas Medical Board search page could not be fetched.`,
      };
    }
    searched.push({ url: SEARCH, kind: 'search-list', via: 'official-search' });

    const results = parseSearchResults(page.html);
    if (!results.length) {
      return {
        outcome: 'no_match',
        source_url: SEARCH,
        searched,
        candidates: [],
        total_found: 0,
        total_capped: false,
        total_display: null,
        detail: `Texas Medical Board returned no results for "${subject}".`,
      };
    }

    // Score and filter
    const scored = results.map((r) => ({ result: r, confidence: nameSimilarity(subject, r.name) })).sort((a, b) => b.confidence - a.confidence);
    const plausible = scored.filter((item) => item.confidence >= CLOSE_THRESHOLD);

    if (plausible.length === 1) {
      const { result, confidence } = plausible[0];
      const detailPage = await fetchHtml(result.source_url);
      const parsed = parseDetailPage(detailPage.html);
      const confidence2 = nameSimilarity(subject, parsed.name);
      return {
        outcome: 'match',
        record: toRecord(parsed, subject, confidence2, { total_found: 1, total_capped: false, total_display: null }),
        source_url: parsed.source_url,
        total_found: 1,
        total_capped: false,
        total_display: null,
        searched: [{ url: SEARCH, kind: 'search-list', via: 'official-search' }, { url: result.source_url, kind: 'record', via: 'detail' }],
        detail: `One plausible Texas Medical Board record matched "${subject}".`,
      };
    }

    if (plausible.length > 1) {
      return {
        outcome: 'multiple',
        source_url: SEARCH,
        searched,
        total_found: plausible.length,
        total_capped: false,
        total_display: null,
        candidates: plausible.slice(0, 10).map(({ result }) => ({
          name: result.name,
          licence_number: result.abn,
          jurisdiction: 'US-TX',
          status: result.status,
          source_url: result.source_url,
        })),
        detail: `${plausible.length} Texas Medical Board records matched "${subject}". Add a license number to choose one.`,
      };
    }

    return {
      outcome: 'no_match',
      source_url: SEARCH,
      searched,
      total_found: 0,
      total_capped: false,
      total_display: null,
      candidates: scored.slice(0, 5).map(({ result }) => ({
        name: result.name,
        licence_number: result.abn,
        jurisdiction: 'US-TX',
        status: result.status,
        source_url: result.source_url,
      })),
      detail: `Texas Medical Board returned results but none matched "${subject}" closely enough.`,
    };
  },
};

function toRecord(parsed, subject, confidence, counts = {}) {
  return makeRecord({
    subject,
    licence_type: 'health',
    jurisdiction: 'US-TX',
    status: parsed.status,
    licence_number: parsed.number,
    expiry_date: parsed.expiry_date,
    disciplinary_actions: parsed.has_discipline ? [parsed.discipline] : ['none found'],
    status_detail: parsed.status_detail,
    source_name: 'Texas Medical Board',
    source_url: parsed.source_url,
    checked_at: new Date().toISOString(),
    match_quality: classifyMatch(subject, parsed.name),
    confidence,
    ...counts,
    fields: {
      licence_number: parsed.number,
      status_detail: parsed.status_detail,
      expiry_date: parsed.expiry_date,
      has_discipline: parsed.has_discipline,
      discipline: parsed.discipline,
    },
    notes: ['Texas Medical Board confirms the licence enrolment status. It does not publish disciplinary details beyond board actions; check the Board order directly for specifics.'],
  });
}