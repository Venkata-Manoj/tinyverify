import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { config, ROOT } from '../lib/config.js';
import { handleRequest } from '../lib/router.js';
import { listRegistryMetadata } from '../lib/registry.js';
import { storageKind } from '../lib/store.js';

const PUBLIC_DIR = resolve(ROOT, 'public');
const PORT = Number(process.env.PORT || 3000);

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.woff2', 'font/woff2'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
]);

function sendText(res, status, text, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  res.end(text);
}

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    sendText(res, 400, 'Bad request');
    return;
  }
  if (pathname === '/' || pathname === '') pathname = '/index.html';

  const target = resolve(PUBLIC_DIR, `.${normalize(pathname)}`);
  if (target !== PUBLIC_DIR && !target.startsWith(`${PUBLIC_DIR}${process.platform === 'win32' ? '\\' : '/'}`)) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  let filePath = target;
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = join(filePath, 'index.html');
  } catch {
    // SPA fallback: unknown paths without a file extension render the app shell.
    if (!extname(pathname)) {
      filePath = join(PUBLIC_DIR, 'index.html');
    } else {
      sendText(res, 404, 'Not found');
      return;
    }
  }

  try {
    const body = await readFile(filePath);
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME.get(extname(filePath).toLowerCase()) || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method === 'HEAD') res.end();
    else res.end(body);
  } catch {
    sendText(res, 404, 'Not found');
  }
}

const server = createServer((req, res) => {
  if (String(req.url || '').startsWith('/api/')) {
    handleRequest(req, res);
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
    return;
  }
  serveStatic(req, res).catch((err) => {
    console.error(err);
    sendText(res, 500, 'Internal server error');
  });
});

server.requestTimeout = 300_000;
server.headersTimeout = 320_000;

server.listen(PORT, () => {
  const registries = listRegistryMetadata().map((r) => r.name).join(', ');
  console.log(`TinyVerify ${config.version} listening on http://localhost:${PORT}`);
  console.log(`Registries: ${registries}`);
  console.log(`Monitor storage: ${storageKind()}${storageKind() === 'file' ? ` (${config.dataDir})` : ''}`);
  console.log(`TinyFish API key: ${config.apiKey ? 'configured' : 'MISSING — add TINYFISH_API_KEY to .env'}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n${signal} received, shutting down.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
