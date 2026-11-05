import { assertApiKey, config } from './config.js';
import { consumeDailyCap } from './costcap.js';

const BASES = {
  search: 'https://api.search.tinyfish.ai',
  fetch: 'https://api.fetch.tinyfish.ai',
  agent: 'https://agent.tinyfish.ai',
};

export class TinyFishError extends Error {
  constructor(message, { status = 502, code = 'TINYFISH_ERROR', body = null, retryAfter = null } = {}) {
    super(message);
    this.name = 'TinyFishError';
    this.status = status;
    this.code = code;
    this.body = body;
    this.retryAfter = retryAfter;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(url, { method = 'GET', body, timeoutMs = 30_000, retries = 2 } = {}) {
  assertApiKey();
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          'X-API-Key': config.apiKey,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      lastError = new TinyFishError(`TinyFish request failed: ${err.message}`, { status: 502, code: 'NETWORK' });
      if (attempt < retries) { await sleep(400 * 2 ** attempt); continue; }
      throw lastError;
    }

    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 2000) }; }

    if (res.ok) return data;

    const code = data?.error?.code || data?.code || `HTTP_${res.status}`;
    const message = data?.error?.message || data?.message || `TinyFish returned ${res.status}`;
    lastError = new TinyFishError(message, { status: res.status === 401 ? 500 : res.status, code, body: data });
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await sleep(600 * 2 ** attempt);
      continue;
    }
    throw lastError;
  }
  throw lastError;
}

/** Ranked web results. Search is free (12k/day) and never cached here. */
export async function searchWeb({ query, location, language, includeDomains, excludeDomains, recencyMinutes, page = 0 } = {}) {
  const url = new URL(BASES.search);
  url.searchParams.set('query', query);
  if (location) url.searchParams.set('location', location);
  if (language) url.searchParams.set('language', language);
  if (includeDomains) url.searchParams.set('include_domains', includeDomains);
  if (excludeDomains) url.searchParams.set('exclude_domains', excludeDomains);
  if (recencyMinutes) url.searchParams.set('recency_minutes', String(recencyMinutes));
  if (page) url.searchParams.set('page', String(page));
  const data = await request(url.toString(), { timeoutMs: 20_000 });
  return { query: data.query ?? query, results: data.results ?? [], total: data.total_results ?? 0 };
}

/** Fetch and extract 1-10 URLs in one batch. ttl=0 asks for fresh content. */
export async function fetchPages(urls, { format = 'markdown', ttl = 0, links = false } = {}) {
  const list = [...new Set((Array.isArray(urls) ? urls : [urls]).filter(Boolean))].slice(0, 10);
  if (!list.length) return [];
  const data = await request(BASES.fetch, {
    method: 'POST',
    body: { urls: list, format, ttl, links },
    timeoutMs: 150_000,
  });
  const errors = data.errors || [];
  const results = (data.results || []).map((result) => ({
    url: result.url,
    final_url: result.final_url || result.url,
    title: result.title || null,
    text: result.text || '',
    links: result.links || [],
    latency_ms: result.latency_ms ?? null,
  }));
  if (!results.length) {
    const error = errors[0];
    throw new TinyFishError(error?.message || `Fetch returned no content for ${list[0]}`, {
      status: 502,
      code: error?.code || 'FETCH_EMPTY',
      body: data,
    });
  }
  return results.map((result) => ({
    ...result,
    errors: errors.filter((e) => e.url === result.url || e.url === result.final_url),
  }));
}

/** Fetch and extract one URL. */
export async function fetchPage(url, options = {}) {
  const [result] = await fetchPages([url], options);
  return result;
}

/**
 * TinyFish Agent run with a structured-output schema.
 * The agent drives the real page (JS/Cloudflare included) and returns JSON.
 */
export async function agentExtract({ url, goal, schema, maxDurationSeconds = config.agentMaxSeconds }) {
  if (!config.allowAgent) {
    throw new TinyFishError('Agent extraction is disabled by TINYVERIFY_ALLOW_AGENT', { status: 503, code: 'AGENT_DISABLED' });
  }
  const cap = await consumeDailyCap('agent');
  if (!cap.allowed) {
    throw new TinyFishError(
      `The daily Agent cap (${cap.limit} runs) has been reached. Agent extraction resumes after ${cap.retryAfter}s.`,
      { status: 429, code: 'DAILY_CAP', retryAfter: cap.retryAfter },
    );
  }
  const data = await request(`${BASES.agent}/v1/automation/run`, {
    method: 'POST',
    body: {
      url,
      goal,
      ...(schema ? { output_schema: schema } : {}),
      agent_config: { max_duration_seconds: maxDurationSeconds },
    },
    timeoutMs: (maxDurationSeconds + 45) * 1000,
    retries: 1,
  });

  if (data.status !== 'COMPLETED') {
    throw new TinyFishError(
      data.error?.message || `Agent run finished with status ${data.status}`,
      { status: 502, code: data.error?.code || 'AGENT_FAILED', body: data },
    );
  }

  let result = data.result;
  if (typeof result === 'string') {
    const match = result.match(/\{[\s\S]*\}/);
    if (match) {
      try { result = JSON.parse(match[0]); } catch { /* keep string */ }
    }
  }
  return { run_id: data.run_id, status: data.status, steps: data.num_of_steps, result, raw: data };
}

/* ------------------------------- Monitors ------------------------------- */

export async function createMonitor({ name, type = 'fetch', config: monitorConfig, scheduleCron, purpose, webhookUrl }) {
  const cap = await consumeDailyCap('monitor');
  if (!cap.allowed) {
    throw new TinyFishError(
      `The daily Monitor-creation cap (${cap.limit}) has been reached. Try again after ${cap.retryAfter}s.`,
      { status: 429, code: 'DAILY_CAP', retryAfter: cap.retryAfter },
    );
  }
  return request(`${BASES.agent}/v1/monitors`, {
    method: 'POST',
    body: {
      type,
      name,
      config: monitorConfig,
      schedule_cron: scheduleCron,
      ...(purpose ? { purpose } : {}),
      ...(webhookUrl ? { webhook_url: webhookUrl } : {}),
    },
    timeoutMs: 60_000,
  });
}

export async function listMonitors() {
  const data = await request(`${BASES.agent}/v1/monitors`, { timeoutMs: 30_000 });
  return data.monitors ?? [];
}

export async function getMonitor(id) {
  return request(`${BASES.agent}/v1/monitors/${encodeURIComponent(id)}`, { timeoutMs: 30_000 });
}

export async function runMonitor(id) {
  return request(`${BASES.agent}/v1/monitors/${encodeURIComponent(id)}/runs`, {
    method: 'POST',
    timeoutMs: 150_000,
  });
}

export async function deleteMonitor(id) {
  return request(`${BASES.agent}/v1/monitors/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    timeoutMs: 30_000,
  });
}
