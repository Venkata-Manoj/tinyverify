# TinyVerify — working notes

TinyVerify checks a person, business or contractor against live official registries and returns a sourced, timestamped record. It also watches records and logs status changes.

## Non-negotiables

- Every result comes from an official source read at request time, with `source_url` and `checked_at`.
- Never invent, infer or hard-code a record or status.
- Ambiguity is returned as candidates. Nothing is auto-selected.
- A registry outage or parse miss is not a change. Keep the previous snapshot.
- Never commit `.env`, API keys or personal data.
- Report facts from the register, not legal or hiring advice.

## Map

| Path | Purpose |
|---|---|
| `public/` | Static UI (vanilla JS, no build step) |
| `api/index.js` | Legacy Vercel function entry (not used by the current deployment) |
| `scripts/dev-server.js` | HTTP server for local dev; also the Vercel server entrypoint |
| `lib/router.js` | API routes, body limits, CORS, webhook signature |
| `lib/verify.js` | Validation, variants, matching, response assembly |
| `lib/schema.js` | Record contract, snapshots, diffing, conflict handling |
| `lib/registry.js` | Adapter registry and coverage matrix |
| `lib/registries/` | One adapter per official source |
| `lib/tinyfish.js` | TinyFish Search / Fetch / Agent / Monitor client |
| `lib/monitors.js` | Watch creation, check, webhook, delete |
| `lib/store.js` | KV/Upstash or atomic file persistence |
| `tests/` | Node test runner, no network; fixtures captured from live pages |
| `docs/` | Verification rules and registry research |
| `spikes/` | Live API evidence and one-off probes (not runtime code) |

## Registries

| Adapter | Type | Jurisdiction | Transport |
|---|---|---|---|
| `companies-house-uk` | business | UK | TinyFish Search + Fetch |
| `nz-companies` | business | NZ | Direct HTTPS |
| `cslb-ca` | contractor | US-CA | TinyFish Search + HTTPS; Agent fallback |
| `npi-us` | health | US | TinyFish Fetch (JSON API) |

## Commands

```bash
npm run dev      # local server on :3000, reads .env
npm test         # unit tests, no network
npm run check    # syntax check
node cli.js verify "Tesco PLC" --type business --jurisdiction UK
```

Deployment: Vercel, no build step. `scripts/dev-server.js` serves `public/` and `/api/*`;
`vercel.json` includes `public/**` in the function bundle and sets a 300 s max duration.

## Deployment gotchas

- Vercel detects `scripts/dev-server.js` through `package.json#main`. Do not rename it without updating `main` and `vercel.json`.
- `public/**` must stay in `includeFiles` or static assets 404 inside the function bundle.
- Monitors use Upstash Redis when `KV_REST_API_URL` and `KV_REST_API_TOKEN` exist, otherwise a file under `TINYVERIFY_DATA_DIR`.
- The webhook is public; set `TINYVERIFY_WEBHOOK_SECRET` to require a token or HMAC signature.
