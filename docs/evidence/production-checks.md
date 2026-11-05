# Production verification — 5 Nov 2026

Deployment: `https://tinyverify.vercel.app` (Vercel deployment `dpl_FNjVU158WQg8y8woYJuLS4aAorg7`, code commit `ab86a70`, version `0.2.0`).

All checks below were run against the production URL, not localhost. Requests used `curl.exe`; JSON was reduced to the fields shown. No secrets, watch tokens, webhook URLs or admin keys are recorded here.

## Health and coverage

```bash
curl -sS https://tinyverify.vercel.app/api/health
curl -sS https://tinyverify.vercel.app/api/coverage
```

```json
{"ok":true,"name":"TinyVerify","version":"0.2.0","api_key_configured":true,"demo":true,"storage":"kv","registries":["companies-house-uk","cslb-ca","npi-us","nz-companies","abn-au","mqa-fl"]}
```

Coverage reports six combinations:

| Type | Jurisdiction | Registries |
|---|---|---|
| business | UK | companies-house-uk |
| business | NZ | nz-companies |
| business | AU | abn-au |
| contractor | US-CA | cslb-ca |
| health | US | npi-us |
| health | US-FL | npi-us + mqa-fl |

## Verify criteria

Request shape:

```bash
curl -sS -X POST https://tinyverify.vercel.app/api/verify \
  -H "Content-Type: application/json" \
  --data-binary '{"subject":"Tesco PLC","licence_type":"business","jurisdiction":"UK"}'
```

| Case | HTTP | Result |
|---|---|---|
| `Tesco PLC`, business, UK | 200 | `exact`, `active`, `00445790`, source `company/00445790`, `checked_at` present |
| `qwzxv plorb`, business, UK | 200 | `no_match`, `primary: null`, 0 candidates, 1 registry searched |
| `Acme Widgets` + `00445790`, business, UK | 200 | `mismatch`, `name_number_mismatch: true`, official name `TESCO PLC` |
| `Carillion PLC`, business, UK | 200 | `exact`, `in_liquidation`, detail `Liquidation`, `status_bounty: expired` |
| `Air New Zealand Limited` + `104799`, business, NZ | 200 | `exact`, `active`, NZBN `9429040402543` |
| `TELSTRA CORPORATION LIMITED` + `33051775556`, business, AU | 200 | `exact`, `active`, expiry `null`, entity type `Australian Public Company` |
| `John Smith`, health, US | 200 | `multiple`, `total_found: 187`, 20 candidates, no candidate named Jack |
| `JOHN HORATIO SMITH II` + `ME182088`, health, US-FL | 200 | `exact`, `active`, expiry `2028-01-31`, `mqa-fl` primary, searched `npi-us:no_match` and `mqa-fl:match` |
| `DONE RIGHT DISCOUNT FLOORING` + `738180`, contractor, US-CA | 200 | `exact`, `revoked`, detail “This license is revoked…”, expiry `2017-05-28`, arbitration `A S 2016 000293`, `status_bounty: suspended` |
| same subject, health, US with `state: FL` | 200 | same two-registry result as US-FL |
| `!!! ***`, business, UK | 200 | `no_match`, `searched: []`, no registry call |
| `Test Person`, health, JP | 200 | `unsupported`, supported jurisdictions `US, US-FL` |
| `Telstra` + bad ABN `33051775557`, business, AU | 400 | `BAD_NUMBER`, checksum rejected before any fetch |

Cache bypass is admin-only. A browser owner token plus `refresh: true` after a priming read returned `cached: true`, `cache_age_seconds: 23`; the same body with a wrong admin key also returned `cached: true`. The positive admin path is covered by unit tests (`refreshAllowed`).

## Watch security

```bash
curl -sS https://tinyverify.vercel.app/api/monitors
curl -sS -X POST https://tinyverify.vercel.app/api/monitors \
  -H "Content-Type: application/json" \
  -H "X-TinyVerify-Owner: <32 hex>" \
  --data-binary '{"subject":"Tesco PLC","licence_type":"business","jurisdiction":"UK","number":"00445790"}'
```

| Check | HTTP | Result |
|---|---|---|
| List without an owner token | 200 | `monitors: []` |
| Create without an owner token | 401 | `OWNER_REQUIRED` |
| Create from a name/number mismatch | 422 | `NAME_NUMBER_MISMATCH`; no TinyFish monitor created |
| Create with an owner token | 201 | watch created; `manage_token` returned once (32 chars); no `manage_hash` in the response |
| GET without watch token | 401 | `WATCH_TOKEN_REQUIRED` |
| GET with wrong watch token | 404 | `NOT_FOUND` |
| GET with correct watch token | 200 | monitor and 0 events returned |
| List as a different owner | 200 | 0 watches |
| List as the owning browser | 200 | exactly that watch; no hash field |
| List as a different owner with a wrong admin key | 200 | 0 watches; the admin header did not elevate |
| DELETE without watch token | 401 | `WATCH_TOKEN_REQUIRED` |
| DELETE with wrong watch token | 404 | `NOT_FOUND` |
| DELETE with correct watch token | 200 | local watch and TinyFish monitor deleted |
| List after delete | 200 | watch gone |
| Verify rate limit | 21 × malformed JSON | first 20 return 400, requests 21–22 return 429 `RATE_LIMITED` |

The positive admin-list path is covered by unit tests; the production admin key was not available to this check, so it is not claimed as a live observation.

## Monitor demo and webhook

The watch created above registered a callback URL with TinyFish. Reading that monitor back through the TinyFish API (without printing the URL) confirmed:

| Check | Result |
|---|---|
| Webhook URL origin | `https://tinyverify.vercel.app` |
| Webhook path | `/api/webhooks/tinyfish` |
| Deployment token in URL | present |

| Check | HTTP | Result |
|---|---|---|
| POST to the registered URL with `fetch_monitor_id` | 200 | `ignored: false`, re-read the registry, `event: null` (no real status change) |
| Replay of the same payload | 200 | `ignored: true`, `Duplicate webhook payload (replay window)` |
| Unsigned webhook, no token | 401 | `BAD_SIGNATURE` |
| Webhook with a wrong URL token | 401 | `BAD_SIGNATURE` |
| `POST /simulate` | 200 | `simulated: true`, fields `status,status_detail`, `detected_by` says it is not a live read |
| Events after simulate | 200 | 1 event; stored snapshot still `active` |
| Real check after simulate | 200 | `event: null`, `last_check.ok: true` |

The timestamped-HMAC path, stale-timestamp rejection and body-only-signature rejection are covered by the router unit tests. The production HMAC secret cannot be pulled from Vercel Secrets, so a new signed delivery was not re-issued.

## UI

Playwright against the production page:

- The Tesco sample chip returns `Active` and `Exact match`, with the Companies House source link.
- A conflict payload injected at the network boundary (same response shape as `lib/verify.js`) renders the heading “Registries disagree”, two record cards with `ACTIVE` and `DISSOLVED`, and two separate source links. This exercises the production UI bundle without pretending a live conflict exists.
- Pressing “Watch this record” adds exactly one card to “Watched records”.
- The card shows “Simulate change (demo)”; pressing it renders a `DEMO`-badged event “Status changed from active to suspended”, the note that the snapshot was not modified, and the live status stays `Active`.
- Deleting the watch returns the list to “No watched records yet”.
- At 375 px: viewport 375, document width 360, no horizontal overflow, form fields one column (294 px).
- At 414 px: viewport 414, document width 399, no horizontal overflow, form fields one column (333 px).
- Console errors: 0.
