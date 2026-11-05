# Production verification — 5 Nov 2026

Deployment: `https://tinyverify.vercel.app` (Vercel deployment `dpl_GoF2Uu48rPbjhH7twohC1NaR8tFA`, code commit `d99e562`, version `0.2.0`).

All checks below were run against the production URL, not localhost. Requests used `curl.exe`; JSON was reduced to the fields shown. No secrets, watch tokens or admin keys are recorded here.

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
  -H "X-TinyVerify-Owner: 0123456789abcdef0123456789abcdef" \
  --data-binary '{"subject":"Tesco PLC","licence_type":"business","jurisdiction":"UK","refresh":true}'
```

| Case | HTTP | Result |
|---|---|---|
| `Tesco PLC`, business, UK | 200 | `exact`, `active`, `00445790`, source `company/00445790`, `checked_at` present |
| `qwzxv plorb`, business, UK | 200 | `no_match`, `primary: null`, 0 candidates, 1 registry searched |
| `Acme Widgets` + `00445790`, business, UK | 200 | `mismatch`, `name_number_mismatch: true`, official name `TESCO PLC`, similarity 0 |
| `Carillion PLC`, business, UK | 200 | `exact`, `in_liquidation`, detail `Liquidation`, `status_bounty: expired` |
| `Air New Zealand Limited` + `104799`, business, NZ | 200 | `exact`, `active`, NZBN `9429040402543` |
| `TELSTRA CORPORATION LIMITED` + `33051775556`, business, AU | 200 | `exact`, `active`, expiry `null`, entity type `Australian Public Company` |
| `John Smith`, health, US | 200 | `multiple`, `total_found: 187`, 20 candidates, no candidate named Jack |
| `Planise Jean Louis` + `1295346773`, health, US | 200 | `exact`, `active`, number `1295346773` |
| `DONE RIGHT DISCOUNT FLOORING` + `738180`, contractor, US-CA | 200 | `exact`, `revoked`, expiry `2017-05-28`, arbitration `A S 2016 000293` |
| `JOHN HORATIO SMITH II` + `ME182088`, health, US-FL | 200 | `exact`, `active`, expiry `2028-01-31`, `mqa-fl` primary, searched `npi-us:no_match` and `mqa-fl:match` |
| same subject, health, US with `state: FL` | 200 | same two-registry result as US-FL |
| `!!! ***`, business, UK | 200 | `no_match`, `searched: []`, no registry call |
| `Test Person`, health, JP | 200 | `unsupported`, supported jurisdictions `US, US-FL` |
| `Telstra` + bad ABN `33051775557`, business, AU | 400 | `BAD_NUMBER`, checksum rejected before any fetch |

## Watch security

```bash
curl -sS https://tinyverify.vercel.app/api/monitors
curl -sS -X POST https://tinyverify.vercel.app/api/monitors \
  -H "Content-Type: application/json" \
  --data-binary '{"subject":"Tesco PLC","licence_type":"business","jurisdiction":"UK","number":"00445790"}'
```

| Check | HTTP | Result |
|---|---|---|
| List without an owner token | 200 | `monitors: []` |
| Create without an owner token | 401 | `OWNER_REQUIRED` |
| Create with an owner token | 201 | watch created; `manage_token` returned once (32 chars); `manage_hash` absent |
| GET without watch token | 401 | `WATCH_TOKEN_REQUIRED` |
| GET with wrong watch token | 404 | `NOT_FOUND` |
| GET with correct watch token | 200 | monitor and events returned |
| List as a different owner | 200 | 0 watches |
| List as the owning browser | 200 | exactly that watch |
| Admin list with `X-TinyVerify-Admin` | 200 | all watches, including the owner's |
| DELETE without watch token | 401 | `WATCH_TOKEN_REQUIRED` |
| DELETE with watch token | 200 | local watch and TinyFish monitor deleted |
| List after delete | 200 | watch gone |
| Verify rate limit | 20 × 400 then 429 | 21st request in the minute returns `RATE_LIMITED` |

## Monitor demo and webhook

| Check | HTTP | Result |
|---|---|---|
| `POST /simulate` | 200 | `simulated: true`, `changed_fields: ["status"]`, `detected_by` says it is not a live read, snapshot stays `active` |
| Events after simulate | 200 | 1 event, marked simulated, snapshot still `active` |
| Real check after simulate | 200 | `event: null`, `last_check.ok: true` |
| Webhook without a signature | 401 | `BAD_SIGNATURE` |
| Signed webhook, unknown monitor | 200 | `ignored: true`, no local watch |
| Replay of the same signed payload | 200 | `ignored: true`, duplicate payload in replay window |
| Signed webhook with a timestamp 1 hour old | 401 | `BAD_SIGNATURE` |
| Signed webhook for a real watch | 200 | `ignored: false`, re-read the registry, `event: null`, `last_check.ok: true` |
| Delete the webhook watch | 200 | local and TinyFish monitor deleted |

## UI

Playwright against the production page:

- Tesco sample chip returns `Active` and `Exact match`, with the source link.
- `Acme Widgets` + `00445790` renders the red banner “Name and number do not describe the same record”, the `mismatch` quality label, and the official name `TESCO PLC`.
- Pressing “Watch this record” shows the confirmation once and exactly one card in “Watched records”.
- The card shows “Simulate change (demo)”; pressing it renders a `Demo`-badged event and the note that the snapshot was not modified.
- Deleting the watch returns the list to “No watched records yet”.
- At 375 px: viewport 375, document width 360, no horizontal overflow, fields grid one column (294 px).
- At 414 px: viewport 414, document width 399, no horizontal overflow, fields grid one column (333 px).
- Console errors: 0.
