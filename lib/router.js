import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { coverageMatrix, listRegistryMetadata } from './registry.js';
import { verify } from './verify.js';
import { checkWatch, createWatch, deleteWatch, getWatch, handleTinyfishWebhook, listWatches } from './monitors.js';
import { storageKind } from './store.js';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_WEBHOOK_BYTES = 256 * 1024;

class BodyError extends Error {
  constructor(message) {
    super(message);
    this.status = 413;
    this.code = 'PAYLOAD_TOO_LARGE';
  }
}

async function readRawBody(req, limit = MAX_BODY_BYTES) {
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (typeof req.body === 'string') return req.body;
  if (req.body && typeof req.body === 'object') return JSON.stringify(req.body);
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new BodyError(`Request body is larger than ${limit} bytes.`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
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

function sendJson(res, status, payload, extraHeaders = {}) {
  if (res.headersSent) return;
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
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
  return req.headers['x-request-id'] || randomUUID();
}

function publicBaseUrl(req) {
  const configured = process.env.TINYVERIFY_PUBLIC_URL;
  if (configured) return configured;
  const host = req.headers.host;
  if (!host) return '';
  const proto = req.headers['x-forwarded-proto'] || (host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https');
  return `${proto}://${host}`;
}

function validWebhook(req, raw) {
  if (!config.webhookSecret) return true;
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  if (token && token === config.webhookSecret) return true;
  const supplied = req.headers['x-tinyfish-signature']
    || req.headers['x-webhook-signature']
    || req.headers['x-tinyverify-signature'];
  if (!supplied) return false;
  const expected = createHmac('sha256', config.webhookSecret).update(raw).digest('hex');
  const clean = String(supplied).replace(/^sha256=/, '').trim();
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

  if (method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Request-Id');
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
    const body = await readJson(req);
    const result = await verify(body, { refresh: Boolean(body.refresh) });
    sendJson(res, 200, result);
    return;
  }

  if (path === '/api/monitors' && method === 'GET') {
    sendJson(res, 200, { ok: true, monitors: await listWatches() });
    return;
  }

  if (path === '/api/monitors' && method === 'POST') {
    const body = await readJson(req);
    const result = await createWatch(body, { req });
    sendJson(res, 201, { ok: true, ...result });
    return;
  }

  const monitorMatch = path.match(/^\/api\/monitors\/([A-Za-z0-9_-]+)(\/check|\/events)?$/);
  if (monitorMatch) {
    const id = monitorMatch[1];
    const action = monitorMatch[2] || '';
    if (!action && method === 'GET') {
      sendJson(res, 200, { ok: true, ...(await getWatch(id)) });
      return;
    }
    if (action === '/events' && method === 'GET') {
      const result = await getWatch(id);
      sendJson(res, 200, { ok: true, monitor: result.monitor, events: result.events });
      return;
    }
    if (action === '/check' && method === 'POST') {
      const result = await checkWatch(id);
      sendJson(res, 200, { ok: true, ...result });
      return;
    }
    if (!action && method === 'DELETE') {
      const result = await deleteWatch(id);
      sendJson(res, 200, { ok: true, ...result });
      return;
    }
  }

  if (path === '/api/webhooks/tinyfish' && method === 'POST') {
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
    res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id');
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

export { publicBaseUrl };
