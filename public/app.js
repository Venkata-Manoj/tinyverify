/* TinyVerify front-end. Vanilla JS, no dependencies.
   Structure: dom utils → api wrapper → app state → verify flow →
   result renderers → monitors → init. No innerHTML; all dynamic text
   is set via textContent. */
(() => {
  'use strict';

  /* ---------------- dom utils ---------------- */

  const $ = (id) => document.getElementById(id);

  function el(tag, cls, text, attrs, children) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    if (attrs) for (const k of Object.keys(attrs)) node.setAttribute(k, attrs[k]);
    if (children) for (const child of children) if (child) node.appendChild(child);
    return node;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICON_PATHS = {
    tick: 'M2.5 6.4l2.3 2.3L9.7 3.6',
    'arrow-up-right': 'M4 8L8.2 3.8M4.8 3.8h3.4v3.4'
  };

  function icon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 12 12');
    svg.setAttribute('width', '12');
    svg.setAttribute('height', '12');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.6');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', ICON_PATHS[name] || '');
    svg.appendChild(path);
    return svg;
  }

  function clearNode(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  const prefersNoMotion = () =>
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function smoothScrollTo(node) {
    node.scrollIntoView({ block: 'start', behavior: prefersNoMotion() ? 'auto' : 'smooth' });
  }

  /* ---------------- formatting ---------------- */

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function pad(n) { return String(n).padStart(2, '0'); }

  function fmtDateTime(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
  }

  function fmtDateOnly(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  }

  function humaniseKey(key) {
    const clean = String(key)
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/_/g, ' ')
      .toLowerCase()
      .trim();
    const acronyms = new Set(['sic', 'npi', 'uk', 'us', 'id', 'url', 'vat', 'ceo', 'nzbn', 'nz', 'ca']);
    return clean
      .split(' ')
      .map((word) => (acronyms.has(word) ? word.toUpperCase() : word))
      .join(' ')
      .replace(/^\w/, (c) => c.toUpperCase());
  }

  function humaniseCron(cron) {
    const parts = String(cron || '').trim().split(/\s+/);
    if (parts.length === 5 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])) {
      return `Daily at ${pad(Number(parts[1]))}:${pad(Number(parts[0]))} UTC`;
    }
    return null;
  }

  const STATUS_LABELS = { active: 'Active', expired: 'Expired', suspended: 'Suspended', revoked: 'Revoked', unknown: 'Unknown' };

  /* ---------------- api ---------------- */

  const FETCH_TIMEOUT_MS = 180000;

  class ApiError extends Error {
    constructor(message, code) { super(message); this.code = code || 'UNKNOWN'; }
  }

  /* A random per-browser token scopes watches to this browser. The server
     stores only its hash and never returns it. */
  const OWNER_KEY = 'tinyverify.owner.v1';

  function ownerToken() {
    try {
      const stored = localStorage.getItem(OWNER_KEY);
      if (/^[a-f0-9]{32}$/.test(stored || '')) return stored;
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      const token = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
      localStorage.setItem(OWNER_KEY, token);
      return token;
    } catch {
      return null;
    }
  }

  const OWNER = ownerToken();

  async function readJsonBody(res) {
    try { return await res.json(); } catch { return null; }
  }

  /* Wrapper supporting a caller AbortController plus a hard 180s timeout. */
  async function apiFetch(path, { method = 'GET', body, signal } = {}) {
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', forwardAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      const headers = Object.assign({ 'Accept': 'application/json' }, body ? { 'Content-Type': 'application/json' } : null);
      if (OWNER) headers['X-TinyVerify-Owner'] = OWNER;
      res = await fetch(path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });
    } catch (err) {
      throw new ApiError('Network error — the request could not be completed.', 'NETWORK');
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', forwardAbort);
    }
    const data = await readJsonBody(res);
    if (!res.ok) {
      const msg = (data && data.error && data.error.message) || `The request failed (HTTP ${res.status}).`;
      throw new ApiError(msg, (data && data.error && data.error.code) || String(res.status));
    }
    return data;
  }

  /* ---------------- app state ---------------- */

  const FALLBACK_TYPES = ['business', 'contractor', 'health'];
  const FALLBACK_JURISDICTIONS = ['UK', 'NZ', 'US', 'US-CA'];

  const state = {
    modes: [],            // supported {type, jurisdiction, registry} combinations
    currentQuery: null,   // query object behind the current result
    verifyAbort: null     // AbortController for the in-flight verify
  };

  /* ---------------- elements ---------------- */

  const formEl = $('verify-form');
  const subjectInput = $('subject');
  const typeSelect = $('licence-type');
  const jurisdictionSelect = $('jurisdiction');
  const numberInput = $('number');
  const submitButton = $('submit-button');
  const loadingEl = $('loading');
  const stagesEl = $('stages');
  const loadingTimerEl = $('loading-timer');
  const loadingSubjectEl = $('loading-subject-name');
  const errorEl = $('error-banner');
  const errorMessageEl = $('error-message');
  const resultEl = $('result');
  const resultTitleEl = $('result-title');
  const resultBodyEl = $('result-body');
  const monitorsEl = $('monitors');
  const monitorsBodyEl = $('monitors-body');

  /* ---------------- global notice ---------------- */

  function showError(message, code) {
    clearNode(errorMessageEl);
    if (code) errorMessageEl.appendChild(el('code', 'mono', `${code} — `));
    errorMessageEl.appendChild(document.createTextNode(message));
    errorEl.hidden = false;
  }

  function hideError() { errorEl.hidden = true; }

  /* ---------------- registries ---------------- */

  function collectModes(registries) {
    const modes = [];
    for (const reg of registries) {
      for (const type of reg.types || []) {
        for (const jurisdiction of reg.jurisdictions || []) {
          modes.push({ type, jurisdiction, registry: reg.name, registryId: reg.id });
        }
      }
    }
    return modes;
  }

  function fillSelect(select, values, preferred) {
    clearNode(select);
    for (const value of values) {
      const opt = el('option', null, value);
      opt.value = value;
      select.appendChild(opt);
    }
    if (values.includes(preferred)) select.value = preferred;
  }

  async function loadRegistries() {
    try {
      const data = await apiFetch('/api/registries');
      const registries = (data && data.registries) || [];
      state.modes = collectModes(registries);
      if ((data.types || []).length) fillSelect(typeSelect, data.types, 'business');
      if ((data.jurisdictions || []).length) fillSelect(jurisdictionSelect, data.jurisdictions, 'UK');
    } catch {
      /* fallback options were populated at init */
    }
  }

  /* ---------------- staged loading ---------------- */

  const STAGES = [
    'Searching for the official registry…',
    'Fetching the live record…',
    'Extracting and normalising fields…',
    'Checking the source link…'
  ];
  const STAGE_INTERVAL_MS = 5000;

  let stageTimer = null;
  let elapsedTimer = null;

  function renderStages(currentIndex) {
    clearNode(stagesEl);
    STAGES.forEach((message, i) => {
      let cls = null;
      if (i < currentIndex) cls = 'done';
      else if (i === currentIndex) cls = 'current';
      stagesEl.appendChild(el('li', cls, null, null, [
        el('span', 'stage-dot'),
        el('span', null, message)
      ]));
    });
  }

  function startLoading(subject) {
    loadingSubjectEl.textContent = subject;
    loadingTimerEl.textContent = '0s';
    renderStages(0);
    let stage = 0;
    stageTimer = setInterval(() => {
      stage = Math.min(stage + 1, STAGES.length - 1);
      renderStages(stage);
    }, STAGE_INTERVAL_MS);
    let seconds = 0;
    elapsedTimer = setInterval(() => {
      seconds += 1;
      loadingTimerEl.textContent = `${seconds}s`;
    }, 1000);
    loadingEl.hidden = false;
  }

  function stopLoading() {
    clearInterval(stageTimer); stageTimer = null;
    clearInterval(elapsedTimer); elapsedTimer = null;
    loadingEl.hidden = true;
  }

  function cancelVerify() {
    if (state.verifyAbort) state.verifyAbort.abort();
  }

  /* ---------------- verify flow ---------------- */

  function readQuery() {
    const subject = subjectInput.value.trim();
    if (!subject) {
      showError('Enter a person or business name to check.');
      subjectInput.focus();
      return null;
    }
    const query = {
      subject,
      licence_type: typeSelect.value,
      jurisdiction: jurisdictionSelect.value
    };
    const number = numberInput.value.trim();
    if (number) query.number = number;
    return query;
  }

  async function runVerify(query) {
    hideError();
    resultEl.hidden = true;
    submitButton.disabled = true;
    const controller = new AbortController();
    state.verifyAbort = controller;
    startLoading(query.subject);
    try {
      const payload = await apiFetch('/api/verify', {
        method: 'POST',
        body: query,
        signal: controller.signal
      });
      state.currentQuery = query;
      renderResult(payload);
    } catch (err) {
      if (!controller.signal.aborted) {
        console.error('verify failed', err);
        showError(err instanceof ApiError ? err.message : 'Unexpected failure — no result was produced.', err.code);
      }
      /* cancelled by the user → return quietly to the form */
    } finally {
      stopLoading();
      state.verifyAbort = null;
      submitButton.disabled = false;
    }
  }

  /* ---------------- status / match-quality primitives ---------------- */

  function statusPill(status) {
    const s = STATUS_LABELS[status] ? status : 'unknown';
    const pill = el('span', `pill pill-${s}`, STATUS_LABELS[s]);
    if (s === 'active') {
      const tick = icon('tick');
      tick.classList.add('pill-tick');
      pill.insertBefore(tick, pill.firstChild);
    }
    return pill;
  }

  const MQ_MESSAGES = {
    exact: 'Exact match',
    close: 'Close match — verify the name',
    multiple: 'Multiple matches — pick the right record',
    no_match: 'No match found',
    unsupported: 'Jurisdiction not supported yet'
  };

  function matchBanner(quality) {
    const q = MQ_MESSAGES[quality] ? quality : null;
    const label = q ? MQ_MESSAGES[q] : `Match quality: ${quality}`;
    return el('span', `q-banner ${q ? `q-${q}` : 'q-no_match'}`, label);
  }

  function cachedNote(record) {
    if (!record || !record.cached) return null;
    const at = fmtDateTime(record.checked_at) || 'an earlier time';
    return el('span', 'cached-note', `Cached result from ${at}`);
  }

  /* ---------------- result renderers ---------------- */

  function safeHttpUrl(value) {
    try {
      const url = new URL(String(value), document.baseURI);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
    } catch {
      return null;
    }
  }

  function sourceAnchor(url, text, cls) {
    const href = safeHttpUrl(url);
    if (!href) return el('span', cls, text);
    const a = el('a', cls, text, { href, target: '_blank', rel: 'noopener noreferrer' });
    a.appendChild(icon('arrow-up-right'));
    return a;
  }

  function copyJsonButton(material) {
    const btn = el('button', 'link-copy', 'Copy JSON', { type: 'button' });
    btn.addEventListener('click', () => {
      const json = JSON.stringify(material, null, 2);
      let copied = Promise.reject(new Error('unsupported'));
      if (navigator.clipboard && navigator.clipboard.writeText) {
        copied = navigator.clipboard.writeText(json);
      } else {
        try {
          const ta = document.createElement('textarea');
          ta.value = json;
          ta.setAttribute('readonly', 'readonly');
          ta.style.position = 'absolute';
          ta.style.left = '-9999px';
          document.body.appendChild(ta);
          ta.select();
          copied = Promise.resolve(document.execCommand('copy'));
          ta.remove();
        } catch { /* copied stays rejected */ }
      }
      copied.then(() => { btn.textContent = 'Copied'; })
        .catch(() => { btn.textContent = 'Copy failed — use “View raw JSON”'; })
        .finally(() => setTimeout(() => { btn.textContent = 'Copy JSON'; }, 1600));
    });
    return btn;
  }

  function rawJsonDetails(material, label) {
    const summary = el('summary', null, label || 'View raw JSON');
    const details = el('details', 'rawjson', null, null, [summary]);
    const pre = el('pre', null, JSON.stringify(material, null, 2));
    details.appendChild(pre);
    return details;
  }

  function sourceStripPanel(record) {
    const panel = el('div', 'panel aside-card source-aside');
    panel.appendChild(el('h3', 'aside-title', 'Source'));
    const at = fmtDateTime(record.checked_at);
    const strip = el('div', 'source-strip source-strip-flat');
    strip.appendChild(el('span', 'source-name', record.source_name || record.registry_name || 'Official registry'));
    if (at) strip.appendChild(el('span', 'source-time', `Checked ${at}`));
    if (record.source_url) strip.appendChild(sourceAnchor(record.source_url, 'Verify at source', 'source-script'));
    strip.appendChild(copyJsonButton(record));
    panel.appendChild(strip);
    if (record.registry_id) {
      panel.appendChild(el('p', 'source-meta', `Registry id: ${record.registry_id} · ${record.registry_name || ''}`));
    }
    panel.appendChild(rawJsonDetails(record));
    return panel;
  }

  function fieldCell(labelText, valueChildren, cls) {
    const cell = el('div', `cell${cls ? ' ' + cls : ''}`);
    cell.appendChild(el('span', 'cell-label', labelText));
    const value = el('div', 'cell-value');
    for (const child of valueChildren) value.appendChild(child);
    cell.appendChild(value);
    return cell;
  }

  function textOrDash(text) {
    return text ? document.createTextNode(text) : el('span', 'na', '—');
  }

  function primaryCard(record) {
    const wrap = el('article', 'panel record-card');

    const banner = el('div', 'status-banner');
    banner.appendChild(statusPill(record.status));
    banner.appendChild(matchBanner(record.match_quality || 'exact'));
    const cached = cachedNote(record);
    if (cached) banner.appendChild(cached);
    wrap.appendChild(banner);

    const grid = el('div', 'fields-grid');

    const subjectCell = el('div', 'cell');
    subjectCell.classList.add('cell-full');
    subjectCell.appendChild(el('span', 'cell-label', 'Subject / matched name'));
    const subjValue = el('div', 'cell-value');
    subjValue.appendChild(el('strong', 'name', record.subject || '—'));
    if (record.matched_name && record.matched_name !== record.subject) {
      subjValue.appendChild(el('div', 'card-meta', `Matched as “${record.matched_name}” in the register`));
    }
    subjectCell.appendChild(subjValue);
    grid.appendChild(subjectCell);

    grid.appendChild(fieldCell('Licence or record number',
      [el('span', 'cell-num mono', record.licence_number || '—')]));

    const expiryCell = (record.expiry_date === null || record.expiry_date === undefined)
      ? fieldCell('Expiry date', [
          el('span', 'na', 'Not applicable'),
          el('span', 'na-hint', 'no expiry recorded', { title: 'The registry does not provide an expiry date for this record.' })
        ])
      : fieldCell('Expiry date', [el('span', 'cell-num mono', String(record.expiry_date))]);
    grid.appendChild(expiryCell);

    grid.appendChild(fieldCell('Status detail', [textOrDash(record.status_detail)]));
    grid.appendChild(fieldCell('Registry', [textOrDash(record.registry_name || record.source_name)]));

    const discCell = el('div', 'cell cell-full');
    discCell.appendChild(el('span', 'cell-label', 'Disciplinary actions'));
    const discList = el('ul', 'actions-list');
    (record.disciplinary_actions && record.disciplinary_actions.length
      ? record.disciplinary_actions : ['—']
    ).forEach((item) => discList.appendChild(el('li', null, String(item))));
    discCell.appendChild(discList);
    grid.appendChild(discCell);

    wrap.appendChild(grid);

    const extra = record.fields;
    if (extra && typeof extra === 'object') {
      const keys = Object.keys(extra);
      if (keys.length) {
        const dl = el('dl', 'extra-fields');
        for (const key of keys) {
          const raw = extra[key];
          const printableRaw = Array.isArray(raw)
            ? raw.join('; ')
            : raw && typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
          const printable = /^\d{4}-\d{2}-\d{2}$/.test(printableRaw)
            ? (fmtDateOnly(printableRaw) || printableRaw)
            : printableRaw;
          const row = el('div');
          const isNumericKey = printable.length <= 4 && !/\s/.test(printable);
          row.appendChild(el('dt', isNumericKey ? 'mono-field' : null, humaniseKey(key)));
          row.appendChild(el('dd', null, printable));
          dl.appendChild(row);
        }
        wrap.appendChild(dl);
      }
    }
    return wrap;
  }

  function watchPanel() {
    const panel = el('div', 'panel aside-card watch-card');
    panel.appendChild(el('h3', 'aside-title', 'Watch this record'));
    panel.appendChild(el('p', 'aside-desc',
      'Add this record to your watch list. The registry is re-checked daily and every change is logged with old and new values.'));
    const btn = el('button', 'btn-outline watch-btn', 'Watch this record', { type: 'button' });
    btn.addEventListener('click', () => createWatch(panel, btn));
    panel.appendChild(btn);
    return panel;
  }

  function candidateCard(cand) {
    const card = el('article', 'panel candidate-card');
    const row1 = el('div', 'row1');
    row1.appendChild(el('strong', 'name', cand.name || 'Unnamed record'));
    row1.appendChild(statusPill(STATUS_LABELS[cand.status] ? cand.status : 'unknown'));
    card.appendChild(row1);
    const meta = el('div', 'card-meta');
    meta.appendChild(el('span', 'name-mono mono', cand.licence_number || 'no number'));
    if (cand.registry_name) meta.appendChild(document.createTextNode(` · ${cand.registry_name}`));
    if (cand.jurisdiction) meta.appendChild(document.createTextNode(` · ${cand.jurisdiction}`));
    card.appendChild(meta);
    if (cand.source_url) card.appendChild(sourceAnchor(cand.source_url, 'Verify at the source', 'card-link'));
    const btn = el('button', 'btn-outline', 'Verify this record', { type: 'button' });
    btn.addEventListener('click', () => {
      numberInput.value = cand.licence_number || '';
      const query = readQuery();
      if (query) runVerify(query);
    });
    card.appendChild(btn);
    return card;
  }

  function searchedTable(searched) {
    const table = el('table', 'targets-list');
    const thead = el('thead');
    const headRow = el('tr', null, null, null, [
      el('th', null, 'Registry searched'),
      el('th', null, 'Outcome'),
      el('th', null, 'Detail')
    ]);
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = el('tbody');
    for (const s of searched) {
      const row = el('tr');
      const regCell = el('td');
      regCell.appendChild(el('div', null, s.registry_name || s.registry_id || '—'));
      if (s.source_url) regCell.appendChild(sourceAnchor(s.source_url, 'Open source', 'card-link'));
      row.appendChild(regCell);
      const outcome = s.outcome || 'unknown';
      row.appendChild(el('td', `outcome outcome-${outcome}`, outcome));
      row.appendChild(el('td', null, s.detail || '—'));
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    return table;
  }

  function unsupportedCard() {
    const wrap = el('div');
    wrap.appendChild(el('p', 'no-match-lede',
      'This licence type and jurisdiction combination is not supported yet. Currently available checks:'));
    const grid = el('div', 'candidates');
    if (!state.modes.length) {
      grid.appendChild(el('div', 'panel empty-state', 'The registry catalogue is unavailable right now — reload this page to retry.'));
    } else {
      for (const m of state.modes) {
        const chip = el('button', 'panel candidate-card mode-combo', null, { type: 'button' });
        chip.addEventListener('click', () => {
          typeSelect.value = m.type;
          jurisdictionSelect.value = m.jurisdiction;
          formEl.dispatchEvent(new Event('submit', { cancelable: true }));
        });
        chip.appendChild(el('strong', 'name', `${m.jurisdiction} · ${m.type}`));
        chip.appendChild(el('span', 'card-meta', m.registry));
        grid.appendChild(chip);
      }
    }
    wrap.appendChild(grid);
    return wrap;
  }

  function notesList(notes) {
    const wrap = el('div');
    wrap.appendChild(el('p', 'section-label', 'Notes from the registries'));
    const ul = el('ul', 'notes-list');
    for (const note of notes) ul.appendChild(el('li', null, String(note)));
    wrap.appendChild(ul);
    return wrap;
  }

  function renderPrimaryResult(payload) {
    const body = el('div', 'result-record');
    const record = payload.primary;
    if (payload.results && payload.results.length > 1) {
      body.appendChild(el('p', 'card-meta',
        `${payload.results.length} records were returned; the best match is shown below and the rest are listed underneath.`));
    }

    const grid = el('div', 'result-grid');
    const main = el('div');
    main.appendChild(primaryCard(record));
    if (payload.notes && payload.notes.length) main.appendChild(notesList(payload.notes));
    grid.appendChild(main);

    const aside = el('div', 'aside-stack');
    aside.appendChild(sourceStripPanel(record));
    aside.appendChild(watchPanel());
    grid.appendChild(aside);

    body.appendChild(grid);

    const primaryKey = record.source_url || `${record.registry_id}:${record.licence_number}`;
    const others = (payload.results || []).filter((r) => (r.source_url || `${r.registry_id}:${r.licence_number}`) !== primaryKey);
    if (others.length) {
      body.appendChild(el('p', 'section-label', 'Also returned by the registries'));
      const wrap = el('div', 'candidates');
      for (const r of others) {
        wrap.appendChild(candidateCard({
          name: r.matched_name || r.subject,
          licence_number: r.licence_number,
          jurisdiction: r.jurisdiction,
          status: r.status,
          source_url: r.source_url,
          registry_name: r.registry_name
        }));
      }
      body.appendChild(wrap);
    }
    return body;
  }

  function renderMultipleResult(payload) {
    const body = el('div', 'result-record');
    body.appendChild(el('p', 'no-match-lede',
      'The registries returned several possible records. Identify the right one — we never pick for you.'));
    const wrap = el('div', 'candidates');
    for (const cand of payload.candidates || []) wrap.appendChild(candidateCard(cand));
    if (!(payload.candidates || []).length && (payload.results || []).length) {
      for (const r of payload.results) {
        wrap.appendChild(candidateCard({
          name: r.matched_name || r.subject,
          licence_number: r.licence_number,
          jurisdiction: r.jurisdiction,
          status: r.status,
          source_url: r.source_url,
          registry_name: r.registry_name
        }));
      }
    }
    body.appendChild(wrap);
    if (payload.notes && payload.notes.length) body.appendChild(notesList(payload.notes));
    return body;
  }

  function renderNoMatchResult(payload) {
    const body = el('div', 'result-record');
    body.appendChild(el('p', 'no-match-lede',
      payload.incomplete
        ? 'No confident record was returned by the registries that responded. One or more registries could not be reached, so this is not a clearance: the name may be recorded differently, or the record may sit in a registry not connected here.'
        : 'No record was found in the official registries for this subject, licence type and jurisdiction. '
          + 'This is not a clearance: the name may be recorded differently, or the record may sit in a registry not connected here.'));
    const searched = payload.searched || [];
    if (searched.length) {
      body.appendChild(el('p', 'section-label', 'What was searched'));
      body.appendChild(searchedTable(searched));
    }
    if (payload.suggestions && payload.suggestions.length) {
      body.appendChild(el('p', 'section-label', 'Try a name variant'));
      const row = el('div', 'samples');
      for (const suggestion of payload.suggestions) {
        const chip = el('button', 'chip', suggestion.value, { type: 'button', title: suggestion.reason || '' });
        chip.addEventListener('click', () => {
          subjectInput.value = suggestion.value;
          numberInput.value = '';
          const next = readQuery();
          if (next) runVerify(next);
        });
        row.appendChild(chip);
      }
      body.appendChild(row);
    }
    if (payload.near_misses && payload.near_misses.length) {
      body.appendChild(el('p', 'section-label', 'Closest records — not matches'));
      body.appendChild(el('p', 'card-meta',
        'These records were found at the source but fell below the match threshold. They are not returned as matches; confirm the identity at the source before relying on one.'));
      const wrap = el('div', 'candidates');
      for (const cand of payload.near_misses) wrap.appendChild(candidateCard(cand));
      body.appendChild(wrap);
    }
    if (payload.notes && payload.notes.length) body.appendChild(notesList(payload.notes));
    return body;
  }

  function renderResult(payload) {
    clearNode(resultBodyEl);
    const q = state.currentQuery || {};
    resultTitleEl.textContent = `Result — ${q.subject || ''}`;

    let renderer;
    switch (payload.match_quality) {
      case 'unsupported': renderer = unsupportedCard; break;
      case 'multiple': renderer = renderMultipleResult; break;
      case 'no_match': renderer = renderNoMatchResult; break;
      default: renderer = () => renderPrimaryResult(payload);
    }

    if (payload.incomplete && Array.isArray(payload.errors) && payload.errors.length) {
      const warn = el('div', 'monitor-inline-banner p-change');
      warn.appendChild(el('h4', null, 'Incomplete result'));
      warn.appendChild(el('p', null,
        `These registries could not be read: ${payload.errors
          .map((e) => `${e.registry_name || e.registry_id || 'registry'} — ${e.message}`)
          .join(' · ')}`));
      resultBodyEl.appendChild(warn);
    }

    resultBodyEl.appendChild(renderer(payload));

    if (payload.duration_ms !== undefined) {
      resultBodyEl.appendChild(el('p', 'source-meta',
        `Completed in ${(payload.duration_ms / 1000).toFixed(1)}s · match quality: ${payload.match_quality}`));
    }

    const wasHidden = resultEl.hidden;
    resultEl.hidden = false;
    if (wasHidden) {
      smoothScrollTo(resultEl);
      resultTitleEl.focus({ preventScroll: true });
    }
  }

  /* ---------------- monitors ---------------- */

  function eventLine(event) {
    const li = el('li');
    li.appendChild(el('div', 'kv-line', event.summary || 'Change recorded'));
    const changed = event.changed_fields || [];
    if (changed.length && event.old && event.new) {
      for (const key of changed) {
        const line = el('div', 'kv-changes');
        line.appendChild(el('span', 'kv', humaniseKey(key)));
        line.appendChild(document.createTextNode(`: ${String(event.old[key])} → ${String(event.new[key])}`));
        li.appendChild(line);
      }
    }
    const at = fmtDateTime(event.checked_at);
    if (at) li.appendChild(el('div', 'card-meta', `Checked ${at}`));
    if (event.source_url) li.appendChild(sourceAnchor(event.source_url, 'View source', 'card-link'));
    return li;
  }

  function renderMonitorDetail(detail, container) {
    clearNode(container);
    const monitor = detail.monitor;
    container.appendChild(el('p', 'since-row',
      `Watching since ${fmtDateTime(monitor.created_at) || '—'} · last checked ${fmtDateTime(monitor.last_checked_at) || '—'}`));
    container.appendChild(el('p', 'section-label', 'Change log'));
    if (!detail.events || !detail.events.length) {
      container.appendChild(el('p', 'card-meta', 'No changes recorded yet.'));
    } else {
      const timeline = el('ol', 'timeline');
      for (const event of detail.events) timeline.appendChild(eventLine(event));
      container.appendChild(timeline);
    }
  }

  async function loadMonitorDetail(id, container) {
    clearNode(container);
    container.appendChild(el('p', 'loading-note', 'Loading history…'));
    try {
      const detail = await apiFetch(`/api/monitors/${encodeURIComponent(id)}`);
      renderMonitorDetail(detail, container);
    } catch (err) {
      clearNode(container);
      container.appendChild(el('p', 'loading-note load-note--warn',
        `History could not be loaded — ${err.message}`));
    }
  }

  async function checkMonitor(id, bannerHost, onChecked) {
    clearNode(bannerHost);
    bannerHost.appendChild(el('p', 'loading-note', 'Checking now…'));
    try {
      const data = await apiFetch(`/api/monitors/${encodeURIComponent(id)}/check`, { method: 'POST' });
      clearNode(bannerHost);
      if (data.event) {
        const box = el('div', 'monitor-inline-banner p-change');
        box.appendChild(el('h4', null, 'Change detected'));
        box.appendChild(eventLine(data.event));
        bannerHost.appendChild(box);
      } else {
        bannerHost.appendChild(el('div', 'monitor-inline-banner', 'No change since the last check.'));
      }
      if (onChecked) onChecked(data.monitor, data.event);
    } catch (err) {
      clearNode(bannerHost);
      bannerHost.appendChild(el('p', 'loading-note load-note--warn', `Check failed — ${err.message}`));
    }
  }

  function monitorCard(monitor, opts) {
    const inline = Boolean(opts && opts.inline);
    const card = el('article', 'panel monitor-card');
    card.dataset.monitorId = monitor.id;

    let pillNode = statusPill((monitor.snapshot && monitor.snapshot.status) || 'unknown');

    const head = el('div', 'monitor-row-head');
    head.appendChild(el('strong', 'monitor-name', monitor.subject));
    head.appendChild(pillNode);
    head.appendChild(el('span', 'monitor-head-fill'));
    card.appendChild(head);

    const numLine = el('div', 'monitor-num');
    numLine.appendChild(el('span', 'name-mono mono',
      (monitor.snapshot && monitor.snapshot.licence_number) || 'no number'));
    numLine.appendChild(document.createTextNode(` · ${monitor.licence_type} · ${monitor.jurisdiction}`));
    card.appendChild(numLine);

    const sched = humaniseCron(monitor.schedule_cron);
    const schedule = el('div', 'monitor-schedule', sched || monitor.schedule_cron);
    if (!sched) schedule.title = `Cron schedule: ${monitor.schedule_cron}`;
    card.appendChild(schedule);
    if (monitor.source_url) {
      card.appendChild(sourceAnchor(monitor.source_url, 'Verify at the source', 'card-link'));
    }

    const bannerHost = el('div');
    card.appendChild(bannerHost);

    let detail = null;
    let open = false;
    const historyBtn = el('button', 'btn-outline', 'History', { type: 'button' });
    historyBtn.addEventListener('click', () => {
      open = !open;
      if (!detail) detail = el('div', 'mini-detail');
      if (open) {
        historyBtn.textContent = 'Hide history';
        loadMonitorDetail(monitor.id, detail);
        card.appendChild(detail);
      } else {
        historyBtn.textContent = 'History';
        detail.remove();
      }
    });

    function updateFrom(updated) {
      const fresh = statusPill((updated.snapshot && updated.snapshot.status) || 'unknown');
      pillNode.replaceWith(fresh);
      pillNode = fresh;
    }

    const checkBtn = el('button', 'btn-outline', 'Check now', { type: 'button' });
    checkBtn.addEventListener('click', () => {
      checkMonitor(monitor.id, bannerHost, (updated) => {
        if (updated) updateFrom(updated);
        if (open && detail) loadMonitorDetail(monitor.id, detail);
      });
    });

    const deleteBtn = el('button', 'link-delete', 'Delete', { type: 'button' });
    deleteBtn.addEventListener('click', () => deleteMonitor(monitor.id));

    const btns = el('div', 'monitor-btns');
    btns.appendChild(checkBtn);
    btns.appendChild(historyBtn);
    btns.appendChild(deleteBtn);
    head.appendChild(btns);

    if (inline) {
      card.appendChild(el('p', 'card-meta', 'This record is now watched — it joins the list below.'));
    }
    return card;
  }

  async function createWatch(panel, button) {
    const query = state.currentQuery;
    if (!query) return;
    button.disabled = true;
    button.textContent = 'Adding…';
    try {
      const body = {
        subject: query.subject,
        licence_type: query.licence_type,
        jurisdiction: query.jurisdiction
      };
      if (query.number) body.number = query.number;
      const data = await apiFetch('/api/monitors', { method: 'POST', body });
      clearNode(panel);
      panel.appendChild(el('h3', 'aside-title', 'Watched'));
      panel.appendChild(monitorCard(data.monitor, { inline: false }));
      refreshMonitors();
    } catch (err) {
      button.disabled = false;
      button.textContent = 'Watch this record';
      const note = el('p', 'load-note--warn card-meta', `Could not add the watch — ${err.message}`);
      panel.appendChild(note);
    }
  }

  async function deleteMonitor(id) {
    if (!window.confirm('Delete this watch? The record will no longer be checked for changes.')) return;
    try {
      await apiFetch(`/api/monitors/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch (err) {
      showError(`Could not delete the watch — ${err.message}`, err.code);
    }
    refreshMonitors();
  }

  async function refreshMonitors() {
    let monitors = [];
    try {
      const data = await apiFetch('/api/monitors');
      monitors = data.monitors || [];
    } catch (err) {
      clearNode(monitorsBodyEl);
      monitorsBodyEl.appendChild(el('p', 'loading-note load-note--warn',
        `Watched records could not be loaded — ${err.message}`));
      monitorsEl.hidden = false;
      return;
    }
    clearNode(monitorsBodyEl);
    if (!monitors.length) {
      const empty = el('div', 'panel empty-state');
      empty.appendChild(el('p', null, 'No watched records yet.'));
      empty.appendChild(el('p', 'hint',
        'Run a check and press “Watch this record” to be notified when its status changes.'));
      monitorsBodyEl.appendChild(empty);
    } else {
      for (const monitor of monitors) monitorsBodyEl.appendChild(monitorCard(monitor));
    }
    monitorsEl.hidden = false;
  }

  /* ---------------- form wiring ---------------- */

  function bindEvents() {
    formEl.addEventListener('submit', (e) => {
      e.preventDefault();
      const query = readQuery();
      if (query) runVerify(query);
    });

    for (const chip of document.querySelectorAll('.sample-chip')) {
      chip.addEventListener('click', () => {
        subjectInput.value = chip.dataset.subject;
        typeSelect.value = chip.dataset.type;
        jurisdictionSelect.value = chip.dataset.jurisdiction;
        numberInput.value = chip.dataset.number || '';
        const query = readQuery();
        if (query) runVerify(query);
      });
    }

    $('verify-cancel').addEventListener('click', cancelVerify);
  }

  async function init() {
    fillSelect(typeSelect, FALLBACK_TYPES, 'business');
    fillSelect(jurisdictionSelect, FALLBACK_JURISDICTIONS, 'UK');
    bindEvents();
    refreshMonitors();
    loadRegistries();
  }

  init();
})();
