import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

/**
 * Watches belong to the browser that created them. The server issues a signed
 * owner token; only its hash is stored, so the monitor list cannot be scraped
 * and a leaked store does not expose the token.
 *
 * The signature matters: before v0.3 the browser minted its own 32-hex token,
 * which any client could forge to bypass per-owner limits. Signed tokens are
 * validated before they are used for a new watch. Legacy tokens are still
 * accepted for reading existing watches so a deploy does not orphan them.
 */
const LEGACY_RE = /^[a-f0-9]{32,64}$/i;
const SIGNED_RE = /^tv1\.([a-f0-9]{32})\.([a-f0-9]{32})$/;

// Production sets TINYVERIFY_OWNER_SECRET (or reuses the webhook secret). With
// neither, a per-process secret keeps local development working; tokens do not
// survive a restart, which is acceptable when there are no shared watches.
const FALLBACK_SECRET = randomBytes(32).toString('hex');
const signingSecret = () => config.ownerSecret || config.webhookSecret || FALLBACK_SECRET;

function sign(nonce) {
  return createHmac('sha256', signingSecret()).update(`tinyverify-owner:${nonce}`).digest('hex').slice(0, 32);
}

export function issueOwnerToken() {
  const nonce = randomBytes(16).toString('hex');
  return `tv1.${nonce}.${sign(nonce)}`;
}

export function isSignedOwnerToken(token) {
  const raw = String(token ?? '').trim();
  const match = raw.match(SIGNED_RE);
  if (!match) return false;
  const expected = Buffer.from(sign(match[1]), 'utf8');
  const supplied = Buffer.from(match[2], 'utf8');
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export function isLegacyOwnerToken(token) {
  return LEGACY_RE.test(String(token ?? '').trim());
}

function rawOwnerToken(req) {
  return String(req?.headers?.['x-tinyverify-owner'] ?? '').trim();
}

export function ownerHashFromRequest(req) {
  const raw = rawOwnerToken(req);
  if (!isSignedOwnerToken(raw) && !isLegacyOwnerToken(raw)) return null;
  return createHash('sha256').update(raw).digest('hex');
}

export function ownerHashFromToken(token) {
  const raw = String(token ?? '').trim();
  if (!isSignedOwnerToken(raw) && !isLegacyOwnerToken(raw)) return null;
  return createHash('sha256').update(raw).digest('hex');
}

export function ownerTokenFromRequest(req) {
  const raw = rawOwnerToken(req);
  return isSignedOwnerToken(raw) ? raw : null;
}
