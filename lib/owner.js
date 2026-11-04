import { createHash } from 'node:crypto';

/**
 * Watches belong to the browser that created them. The client generates a
 * random token and keeps it in localStorage; only its hash is stored, so the
 * monitor list cannot be scraped and a leaked store does not expose the token.
 */
const TOKEN_RE = /^[a-f0-9]{32,64}$/i;

export function ownerHashFromRequest(req) {
  const raw = String(req?.headers?.['x-tinyverify-owner'] ?? '').trim();
  if (!TOKEN_RE.test(raw)) return null;
  return createHash('sha256').update(raw).digest('hex');
}

export function ownerHashFromToken(token) {
  const raw = String(token ?? '').trim();
  if (!TOKEN_RE.test(raw)) return null;
  return createHash('sha256').update(raw).digest('hex');
}
