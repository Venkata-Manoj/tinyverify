import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { coverageMatrix, listRegistryMetadata } from './registry.js';
import { verify } from './verify.js';
import { checkWatch, createWatch, deleteWatch, getWatch, handleTinyfishWebhook, listWatches, simulateWatch } from './monitors.js';
import { claimReplay, releaseReplay, storageKind } from './store.js';
import { issueOwnerToken, isSignedOwnerToken, ownerHashFromRequest } from './owner.js';
import { rateLimit } from './ratelimit.js';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_WEBHOOK_BYTES = 256 * 1024;

const RATE_LIMITS = {
  verify: { limit: 20, windowSeconds: 60 },
  monitorCreate: { limit: 5, windowSeconds: 24 * 60 * 60 },
  monitorCheck: { limit: 30, windowSeconds: 60 },
  webhook: { limit: 120, windowSeconds: 60 },
};

const WEBHOOK_TOLERANCE_SECONDS = 300;
const WEBHOOK_REPLAY_TTL_SECONDS = 10 * 60;

function isProduction() {
  return Boolean(process.env.VERCEL) || process.env.NODE_ENV === 'production';
}

/** Cache-bypassing reads cost an upstream request; only admins may ask for one. */
export function refreshAllowed(body, admin) {
  return (body?.refresh === true || body?.refresh === 'true') && admin;
}

function adminFromRequest(req) {
  const supplied = String(req.headers['x-tinyverify-admin'] || '').trim();
  if (!supplied || !config.adminKey) return false;
  const expected = Buffer.from(config.adminKey, 'utf8');
  const actual = Buffer.from(supplied, 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function watchTokenFromRequest(req) {
  return String(req.headers['x-tinyverify-watch-token'] || '').trim() || null;
}

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

async function enforceRateLimit(req, res, name, { limit, windowSeconds }, ownerHash = null) {
  res.setHeader('X-RateLimit-Limit', String(limit));
  if (ownerHash) {
    // A per-owner bucket so one client cannot rotate IPs; the per-IP bucket
    // below stops many tokens hammering the same host.
    const ownerOutcome = await rateLimit(req, `${name}:owner`, { limit, windowSeconds, ownerHash });
    res.setHeader('X-RateLimit-Remaining', String(ownerOutcome.remaining));
    if (!ownerOutcome.allowed) {
      res.setHeader('Retry-After', String(ownerOutcome.retryAfter));
      sendJson(res, 429, {
        ok: false,
        error: { code: 'RATE_LIMITED', message: `Too many requests. Try again in ${ownerOutcome.retryAfter}s.` },
      });
      return false;
    }
  }
  const outcome = await rateLimit(req, name, { limit, windowSeconds });
  if (outcome.allowed) {
    if (!ownerHash) res.setHeader('X-RateLimit-Remaining', String(outcome.remaining));
    return true;
  }
  res.setHeader('X-RateLimit-Remaining', String(outcome.remaining));
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
  if (!config.webhookSecret) return false;
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  if (token) {
    // TinyFish Monitor webhooks are not signed, so the per-deployment token in
    // the webhook URL is the only credential it can present. The access log
    // records the pathname without the query string.
    const expected = Buffer.from(config.webhookSecret, 'utf8');
    const supplied = Buffer.from(token, 'utf8');
    if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) return true;
  }
  const header = req.headers['x-tinyfish-signature']
    || req.headers['x-webhook-signature']
    || req.headers['x-tinyverify-signature'];
  if (!header) return false;

  const timestamp = String(
    req.headers['x-tinyfish-timestamp']
    || req.headers['x-webhook-timestamp']
    || req.headers['x-tinyverify-timestamp']
    || '',
  ).trim();
  if (!/^\d{9,13}$/.test(timestamp)) return false;
  const seconds = timestamp.length > 10 ? Math.floor(Number(timestamp) / 1000) : Number(timestamp);
  if (!Number.isFinite(seconds) || Math.abs(Math.floor(Date.now() / 1000) - seconds) > WEBHOOK_TOLERANCE_SECONDS) return false;

  const expected = createHmac('sha256', config.webhookSecret).update(`${timestamp}.${raw}`).digest('hex');
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
  const signedOwner = isSignedOwnerToken(req.headers['x-tinyverify-owner']);
  const admin = adminFromRequest(req);
  const watchToken = watchTokenFromRequest(req);
  const access = { ownerHash: owner, manageToken: watchToken, admin };

  if (method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Request-Id, X-TinyVerify-Owner, X-TinyVerify-Watch-Token, X-TinyVerify-Admin');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.end();
    return;
  }

  if (path === '/api/owner' && method === 'GET') {
    // The browser asks for a signed owner token once, stores it, and sends it
    // back on watch requests. The server never returns the hash.
    sendJson(res, 200, { ok: true, owner_token: issueOwnerToken() });
    return;
  }

  if (path === '/api/health' && method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      name: 'TinyVerify',
      version: config.version,
      time: new Date().toISOString(),
      api_key_configured: Boolean(config.apiKey),
      demo: config.demo,
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
    if (!(await enforceRateLimit(req, res, 'verify', RATE_LIMITS.verify, owner || null))) return;
    requireJson(req);
    const body = await readJson(req);
    // Refresh bypasses the short cache and costs an upstream read. Anonymous
    // callers and self-minted owner headers do not get it.
    const refresh = refreshAllowed(body, admin);
    const result = await verify(body, { refresh });
    sendJson(res, 200, result);
    return;
  }

  if (path === '/api/monitors' && method === 'GET') {
    // Watches are scoped to the browser token that created them. No token
    // means no list, so personal names cannot be scraped from the demo.
    sendJson(res, 200, { ok: true, monitors: admin ? await listWatches({ admin: true }) : owner ? await listWatches({ ownerHash: owner }) : [] });
    return;
  }

  if (path === '/api/monitors' && method === 'POST') {
    if (!(await enforceRateLimit(req, res, 'monitor-create', RATE_LIMITS.monitorCreate, owner || null))) return;
    if ((!owner && !admin) || !signedOwner) {
      // Legacy (browser-minted) tokens can still read old watches but may not
      // create new ones; a forged token no longer buys a new watch.
      sendJson(res, 401, { ok: false, error: { code: 'OWNER_REQUIRED', message: 'A signed browser owner token is required to create a watch.' } });
      return;
    }
    requireJson(req);
    const body = await readJson(req);
    const result = await createWatch(body, { req, ownerHash: owner });
    sendJson(res, 201, { ok: true, ...result });
    return;
  }

  const monitorMatch = path.match(/^\/api\/monitors\/([A-Za-z0-9_-]+)(\/check|\/events|\/simulate)?$/);
  if (monitorMatch) {
    const id = monitorMatch[1];
    const action = monitorMatch[2] || '';
    if (!action && method === 'GET') {
      sendJson(res, 200, { ok: true, ...(await getWatch(id, access)) });
      return;
    }
    if (action === '/events' && method === 'GET') {
      const result = await getWatch(id, access);
      sendJson(res, 200, { ok: true, monitor: result.monitor, events: result.events });
      return;
    }
    if (action === '/check' && method === 'POST') {
      if (!(await enforceRateLimit(req, res, 'monitor-check', RATE_LIMITS.monitorCheck, owner || null))) return;
      const result = await checkWatch(id, access);
      sendJson(res, 200, { ok: true, ...result });
      return;
    }
    if (action === '/simulate' && method === 'POST') {
      if (!(await enforceRateLimit(req, res, 'monitor-check', RATE_LIMITS.monitorCheck, owner || null))) return;
      requireJson(req);
      const body = await readJson(req);
      const result = await simulateWatch(id, { ...access, patch: body });
      sendJson(res, 200, { ok: true, ...result });
      return;
    }
    if (!action && method === 'DELETE') {
      const result = await deleteWatch(id, access);
      sendJson(res, 200, { ok: true, ...result });
      return;
    }
  }

  if (path === '/api/webhooks/tinyfish' && method === 'POST') {
    if (!(await enforceRateLimit(req, res, 'webhook', RATE_LIMITS.webhook))) return;
    if (isProduction() && !config.webhookSecret) {
      sendJson(res, 503, { ok: false, error: { code: 'WEBHOOK_NOT_CONFIGURED', message: 'Webhooks are disabled until TINYVERIFY_WEBHOOK_SECRET is configured.' } });
      return;
    }
    const raw = await readRawBody(req, MAX_WEBHOOK_BYTES);
    if (!validWebhook(req, raw)) {
      sendJson(res, 401, { ok: false, error: { code: 'BAD_SIGNATURE', message: 'Webhook signature did not match.' } });
      return;
    }
    const replayKey = `tinyverify:wh:${createHmac('sha256', config.webhookSecret || 'unsigned').update(raw).digest('hex')}`;
    if (!(await claimReplay(replayKey, WEBHOOK_REPLAY_TTL_SECONDS))) {
      sendJson(res, 200, { ok: true, ignored: true, reason: 'Duplicate webhook payload (replay window).' });
      return;
    }
    let payload = {};
    try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = {}; }
    try {
      const result = await handleTinyfishWebhook(payload);
      sendJson(res, 200, result);
    } catch (err) {
      // A failed re-check must not burn the payload: let the retry through.
      await releaseReplay(replayKey);
      throw err;
    }
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
      let loggedPath = String(req.url || '');
      try { loggedPath = new URL(loggedPath, 'http://localhost').pathname; } catch { /* keep the raw value */ }
      console.log(JSON.stringify({ request_id: id, method: req.method, path: loggedPath, status: res.statusCode, ms: Date.now() - started }));
    }
  }
}
