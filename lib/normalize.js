/** Name/status/date normalisation shared by every registry adapter. */

const TITLES = new Set(['dr', 'doctor', 'mr', 'mrs', 'ms', 'miss', 'mx', 'prof', 'professor', 'sir', 'dame', 'lord', 'lady', 'rev']);
const SUFFIXES = new Set(['md', 'phd', 'mbbs', 'mbchb', 'bsc', 'msc', 'frcs', 'frcgp', 'frgs', 'jr', 'sr', 'ii', 'iii', 'iv', 'esq', 'cpa', 'rn', 'np']);
const LEGAL_SUFFIX = new Map([
  ['ltd', 'limited'], ['plc', 'public limited company'], ['inc', 'incorporated'], ['corp', 'corporation'],
  ['co', 'company'], ['llc', 'limited liability company'], ['llp', 'limited liability partnership'],
  ['pty', 'proprietary'], ['gmbh', 'gesellschaft mit beschrankter haftung'],
]);

export function foldAccents(value) {
  return String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

/** Lowercase, strip punctuation and professional/legal noise. Display values are never mutated. */
export function normalizeName(raw) {
  let value = foldAccents(raw).toLowerCase();
  value = value.replace(/\([^)]*\)/g, ' ');
  value = value.replace(/[.,'’`]/g, ' ').replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  let tokens = value.split(' ').filter(Boolean);
  while (tokens.length > 1 && TITLES.has(tokens[0])) tokens.shift();
  while (tokens.length > 1 && (TITLES.has(tokens.at(-1)) || SUFFIXES.has(tokens.at(-1)))) tokens.pop();
  tokens = tokens.map((t) => LEGAL_SUFFIX.get(t) ?? t);
  return tokens.join(' ').trim();
}

function tokenKey(value) {
  // Mc/Mac equivalence is a real-world variant, not a different person.
  return value.replace(/\bmac([a-z])/g, 'mc$1');
}

/** Ordered, de-duplicated lookup variants with a human-readable reason. */
export function nameVariants(raw) {
  const original = String(raw ?? '').trim();
  const variants = [{ value: original, reason: 'as entered' }];
  const add = (value, reason) => {
    const clean = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    if (!variants.some((v) => normalizeName(v.value) === normalizeName(clean))) variants.push({ value: clean, reason });
  };

  // "Smith, Jane" -> "Jane Smith"
  let commaReversed = null;
  if (original.includes(',')) {
    const [last, ...rest] = original.split(',');
    if (last.trim() && rest.join(',').trim()) {
      commaReversed = `${rest.join(' ').trim()} ${last.trim()}`;
      add(commaReversed, 'comma order reversed');
    }
  }

  const normalized = normalizeName(original);
  add(normalized, 'titles and suffixes removed');

  // Drop middle initials: "Jane A Smith" -> "Jane Smith" (and the reversed form).
  const baseForms = [normalized];
  if (commaReversed) baseForms.push(normalizeName(commaReversed));
  for (const base of [...new Set(baseForms)]) {
    const tokens = base.split(' ').filter(Boolean);
    if (tokens.length > 2) {
      const withoutInitials = tokens.filter((t) => t.length > 1);
      if (withoutInitials.length >= 2) add(withoutInitials.join(' '), 'middle initials removed');
    }
  }

  // Mc/Mac spelling
  const mc = normalized.replace(/\bmac([a-z])/g, 'mc$1');
  const mac = normalized.replace(/\bmc([a-z])/g, 'mac$1');
  add(mc, 'Mc/Mac variant');
  add(mac, 'Mc/Mac variant');

  // Hyphen <-> space
  if (original.includes('-')) add(original.replace(/-/g, ' '), 'hyphen removed');
  return variants.slice(0, 6);
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(row[j - 1] + 1, prev[j] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

/** 0..1 similarity tuned for organisation and person names. */
export function nameSimilarity(a, b) {
  const left = tokenKey(normalizeName(a));
  const right = tokenKey(normalizeName(b));
  if (!left || !right) return 0;
  if (left === right) return 1;
  const lt = new Set(left.split(' '));
  const rt = new Set(right.split(' '));
  const intersection = [...lt].filter((t) => rt.has(t)).length;
  const union = new Set([...lt, ...rt]).size;
  const jaccard = union ? intersection / union : 0;
  const lev = 1 - levenshtein(left, right) / Math.max(left.length, right.length);
  const containment = left.includes(right) || right.includes(left) ? 0.85 : 0;
  return Math.max(0, Math.min(1, Math.max(jaccard, lev, containment)));
}

export function classifyMatch(query, candidate) {
  const q = normalizeName(query);
  const c = normalizeName(candidate);
  if (!q || !c) return 'no_match';
  if (q === c) return 'exact';
  const score = nameSimilarity(query, candidate);
  if (score >= 0.92) return 'exact';
  if (score >= 0.62) return 'close';
  return 'no_match';
}

/* -------------------------------- Status -------------------------------- */

const ACTIVE_PATTERNS = [
  /^(active|registered|current|licensed|valid|renewed|in good standing|good standing)\b/i,
  /\b(active|registered|licensed to practise|licence to practise)\b/i,
];
const SUSPENDED_PATTERNS = [
  /suspended|suspension|\brestricted\b|\bconditions?\b|interim order|prohibition|disqualified|revoked/i,
];
const EXPIRED_PATTERNS = [
  /expired|expiry|lapsed|dissolved|closed|ceased|surrendered|inactive|not registered|removed|deceased|cancelled|canceled|struck off|withdrawn|no longer/i,
];

/**
 * Maps a registry-native status string to the shared 4-value vocabulary.
 * Native wording is preserved in `detail`; nothing is silently merged.
 */
export function normalizeStatus(raw) {
  const detail = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!detail) return { status: 'unknown', detail: null };
  // "Active - proposal to strike off" is still active; active wins before expiry words.
  if (ACTIVE_PATTERNS.some((re) => re.test(detail))) return { status: 'active', detail };
  if (SUSPENDED_PATTERNS.some((re) => re.test(detail))) return { status: 'suspended', detail };
  if (EXPIRED_PATTERNS.some((re) => re.test(detail))) return { status: 'expired', detail };
  return { status: 'unknown', detail };
}

const MONTHS = new Map([
  ['january', 1], ['february', 2], ['march', 3], ['april', 4], ['may', 5], ['june', 6],
  ['july', 7], ['august', 8], ['september', 9], ['october', 10], ['november', 11], ['december', 12],
  ['jan', 1], ['feb', 2], ['mar', 3], ['apr', 4], ['jun', 6], ['jul', 7], ['aug', 8], ['sep', 9],
  ['sept', 9], ['oct', 10], ['nov', 11], ['dec', 12],
]);

const iso = (y, m, d) => {
  if (!y || !m || !d) return null;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (Number.isNaN(date.getTime())) return null;
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() !== Number(m) - 1 || date.getUTCDate() !== Number(d)) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

/** Accepts ISO, "27 November 1947", "31/05/2027", "May 31, 2027". Defaults ambiguous slash dates to day-first. */
export function normalizeDate(raw, { dayFirst = true } = {}) {
  const value = String(raw ?? '').trim();
  if (!value || /^(n\/?a|not applicable|none|unknown|-|—)$/i.test(value)) return null;

  let m = value.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return iso(m[1], m[2], m[3]);

  m = value.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const year = Number(m[3]);
    const firstIsDay = dayFirst || a > 12;
    return firstIsDay ? iso(year, b, a) : iso(year, a, b);
  }

  m = value.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+),?\s+(\d{4})$/);
  if (m) return iso(m[3], MONTHS.get(m[2].toLowerCase()), m[1]);

  m = value.match(/^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/);
  if (m) return iso(m[3], MONTHS.get(m[1].toLowerCase()), m[2]);

  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  return null;
}

export function humanizeKey(key) {
  const words = String(key)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .trim();
  return words.replace(/^\w/, (c) => c.toUpperCase());
}

export function cleanText(value) {
  return String(value ?? '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** Turn a values list into ["none found"] rather than an empty, ambiguous array. */
export function disciplinaryList(values) {
  const list = (Array.isArray(values) ? values : values ? [values] : [])
    .map((v) => cleanText(typeof v === 'string' ? v : JSON.stringify(v)))
    .filter(Boolean)
    .filter((v) => !/^(none|n\/a|no|nil|none found|no actions?|no restrictions?)$/i.test(v));
  return list.length ? list : ['none found'];
}
