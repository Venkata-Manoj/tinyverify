import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { coverageMatrix, listRegistryMetadata } from './registry.js';
import { verify } from './verify.js';
import { checkWatch, createWatch, deleteWatch, getWatch, handleTinyfishWebhook, listWatches } from './monitors.js';
import { storageKind } from './store.js';
import { ownerHashFromRequest } from './owner.js';
import { rateLimit } from './ratelimit.js';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_WEBHOOK_BYTES = 256 * 1024;

const RATE_LIMITS = {
  verify: { limit: 60, windowSeconds: 60 },
  monitorCreate: { limit: 20, windowSeconds: 60 },
  monitorCheck: { limit: 30, windowSeconds: 60 },
  webhook: { limit: 120, windowSeconds: 60 },
};

class BodyError extends Error {
  constructor(message) {
    super(message);
    this.status = 413;
    this.code = 'PAYLOAD_TOO_LARGE';
  }
}

function tooLarge(limit) {
  return new BodyError(`Request body is larger than ${limit} bytes.`);
}

async function readRawBody(req, limit = MAX_BODY_BYTES) {
  if (Buffer.isBuffer(req.body)) {
    if (req.body.length > limit) throw tooLarge(limit);
    return req.body.toString('utf8');
  }
  if (typeof req.body === 'string') {
    if (Buffer.byteLength(req.body) > limit) throw tooLarge(limit);
    return req.body;
  }
  if (req.body && typeof req.body === 'object') {
    const raw = JSON.stringify(req.body);
    if (Buffer.byteLength(raw) > limit) throw tooLarge(limit);
    return raw;
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];

    // Never destroy the socket on an oversized body: that kills the response
    // before it is written and the platform reports it as a 500. Drain instead.
    const fail = (err) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.resume();
      reject(err);
    };
    function onData(chunk) {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        fail(tooLarge(limit));
        return;
      }
      chunks.push(chunk);
    }
    function onEnd() {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    }
    function onError(err) {
      fail(err);
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

async function readJson(req, limit) {
  const raw = await readRawBody(req, limit);
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    const err = new Error('Request body must be a JSON object.');
    err.status = 400;
    err.code = 'INVALID_JSON';
    throw err;
  }
}

function requireJson(req) {
  const value = String(req.headers['content-type'] || '');
  if (!/^application\/(?:[a-z0-9.+-]*\+)?json\b/i.test(value)) {
    const err = new Error('Content-Type must be application/json.');
    err.status = 415;
    err.code = 'UNSUPPORTED_MEDIA_TYPE';
    throw err;
  }
}

function enforceRateLimit(req, res, name, { limit, windowSeconds }) {
  const outcome = rateLimit(req, name, { limit, windowSeconds });
  res.setHeader('X-RateLimit-Limit', String(limit));
  res.setHeader('X-RateLimit-Remaining', String(outcome.remaining));
  if (outcome.allowed) return true;
  res.setHeader('Retry-After', String(outcome.retryAfter));
  sendJson(res, 429, {
    ok: false,
    error: { code: 'RATE_LIMITED', message: `Too many requests. Try again in ${outcome.retryAfter}s.` },
  });
  return false;
}

function sendJson(res, status, payload, extraHeaders = {}) {
  if (res.headersSent) return;
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  for (const [key, value] of Object.entries(extraHeaders)) res.setHeader(key, value);
  res.end(body);
}

function sendError(res, err, requestId) {
  const status = err?.status && Number.isInteger(err.status) ? err.status : 500;
  const code = err?.code || (status === 500 ? 'INTERNAL_ERROR' : `HTTP_${status}`);
  if (status >= 500) {
    console.error(JSON.stringify({ request_id: requestId, code, message: err?.message, stack: err?.stack }));
  }
  sendJson(res, status, {
    ok: false,
    error: {
      code,
      message: status >= 500 && !err?.expose
        ? 'The request failed. The source may be unavailable; try again shortly.'
        : err?.message || 'Request failed.',
      ...(err?.details ? { details: err.details } : {}),
    },
    request_id: requestId,
  });
}

function requestId(req) {
  const supplied = String(req.headers['x-request-id'] || '').trim();
  return /^[A-Za-z0-9._:-]{1,64}$/.test(supplied) ? supplied : randomUUID();
}

function validWebhook(req, raw) {
  if (!config.webhookSecret) return true;
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  if (token) {
    const expected = Buffer.from(config.webhookSecret, 'utf8');
    const supplied = Buffer.from(token, 'utf8');
    if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) return true;
  }
  const header = req.headers['x-tinyfish-signature']
    || req.headers['x-webhook-signature']
    || req.headers['x-tinyverify-signature'];
  if (!header) return false;
  const expected = createHmac('sha256', config.webhookSecret).update(raw).digest('hex');
  const clean = String(header).replace(/^sha256=/, '').trim();
  if (clean.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(clean, 'utf8'), Buffer.from(expected, 'utf8'));
  } catch {
    return false;
  }
}

function registryPayload() {
  const matrix = coverageMatrix();
  return {
    registries: listRegistryMetadata().map((meta) => ({
      id: meta.id,
      name: meta.name,
      kind: meta.kind,
      types: meta.types,
      jurisdictions: meta.jurisdictions,
      source_url: meta.source_url,
      description: meta.description,
      fields: meta.fields,
    })),
    types: matrix.types,
    jurisdictions: matrix.jurisdictions,
    combinations: matrix.combinations,
  };
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = String(req.method || 'GET').toUpperCase();
  const owner = ownerHashFromRequest(req);

  if (method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Request-Id, X-TinyVerify-Owner');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.end();
    return;
  }

  if (path === '/api/health' && method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      name: 'TinyVerify',
      version: config.version,
      time: new Date().toISOString(),
      api_key_configured: Boolean(config.apiKey),
      storage: storageKind(),
      registries: listRegistryMetadata().map((r) => r.id),
    });
    return;
  }

  if (path === '/api/registries' && method === 'GET') {
    sendJson(res, 200, { ok: true, ...registryPayload() });
    return;
  }

  if (path === '/api/coverage' && method === 'GET') {
    sendJson(res, 200, { ok: true, ...coverageMatrix() });
    return;
  }

  if (path === '/api/verify' && method === 'POST') {
    if (!enforceRateLimit(req, res, 'verify', RATE_LIMITS.verify)) return;
    requireJson(req);
    const body = await readJson(req);
    const refresh = body.refresh === true || body.refresh === 'true';
    const result = await verify(body, { refresh });
    sendJson(res, 200, result);
    return;
  }

  if (path === '/api/monitors' && method === 'GET') {
    // Watches are scoped to the browser token that created them. No token
    // means no list, so personal names cannot be scraped from the demo.
    sendJson(res, 200, { ok: true, monitors: owner ? await listWatches({ ownerHash: owner }) : [] });
    return;
  }

  if (path === '/api/monitors' && method === 'POST') {
    if (!enforceRateLimit(req, res, 'monitor-create', RATE_LIMITS.monitorCreate)) return;
    requireJson(req);
    const body = await readJson(req);
    const result = await createWatch(body, { req, ownerHash: owner });
    sendJson(res, 201, { ok: true, ...result });
    return;
  }

  const monitorMatch = path.match(/^\/api\/monitors\/([A-Za-z0-9_-]+)(\/check|\/events)?$/);
  if (monitorMatch) {
    const id = monitorMatch[1];
    const action = monitorMatch[2] || '';
    if (!action && method === 'GET') {
      sendJson(res, 200, { ok: true, ...(await getWatch(id, { ownerHash: owner })) });
      return;
    }
    if (action === '/events' && method === 'GET') {
      const result = await getWatch(id, { ownerHash: owner });
      sendJson(res, 200, { ok: true, monitor: result.monitor, events: result.events });
      return;
    }
    if (action === '/check' && method === 'POST') {
      if (!enforceRateLimit(req, res, 'monitor-check', RATE_LIMITS.monitorCheck)) return;
      const result = await checkWatch(id, { ownerHash: owner });
      sendJson(res, 200, { ok: true, ...result });
      return;
    }
    if (!action && method === 'DELETE') {
      const result = await deleteWatch(id, { ownerHash: owner });
      sendJson(res, 200, { ok: true, ...result });
      return;
    }
  }

  if (path === '/api/webhooks/tinyfish' && method === 'POST') {
    if (!enforceRateLimit(req, res, 'webhook', RATE_LIMITS.webhook)) return;
    const raw = await readRawBody(req, MAX_WEBHOOK_BYTES);
    if (!validWebhook(req, raw)) {
      sendJson(res, 401, { ok: false, error: { code: 'BAD_SIGNATURE', message: 'Webhook signature did not match.' } });
      return;
    }
    let payload = {};
    try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = {}; }
    const result = await handleTinyfishWebhook(payload);
    sendJson(res, 200, result);
    return;
  }

  sendJson(res, 404, {
    ok: false,
    error: { code: 'NOT_FOUND', message: `No route for ${method} ${path}.` },
  });
}

/** Node HTTP handler shared by server.js and the Vercel function. */
export async function handleRequest(req, res) {
  const id = requestId(req);
  res.setHeader('X-Request-Id', id);
  if (String(req.url || '').startsWith('/api/')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, X-RateLimit-Limit, X-RateLimit-Remaining, Retry-After');
  }
  const started = Date.now();
  try {
    await route(req, res);
  } catch (err) {
    if (!err.status) err.status = err.name === 'TinyFishError' ? 502 : 500;
    err.expose = err.status < 500;
    sendError(res, err, id);
  } finally {
    if (process.env.TINYVERIFY_LOG !== '0') {
      console.log(JSON.stringify({ request_id: id, method: req.method, url: req.url, status: res.statusCode, ms: Date.now() - started }));
    }
  }
}
