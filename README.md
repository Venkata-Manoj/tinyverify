# TinyVerify

**Live demo:** https://tinyverify.vercel.app
**Repo:** https://github.com/Venkata-Manoj/tinyverify

TinyVerify answers a question a hiring manager or compliance team actually has to answer:

> Is this doctor licensed? Is this contractor in good standing? Is this company still registered?

You give it a **name**, a **record type** and a **jurisdiction**. TinyVerify reads the **live official registry**, returns a structured record with the **source link** and a **`checked_at` timestamp**, and can **watch that record** so a status change is caught without re-checking by hand.

It never invents a record. If the official source cannot confirm one, the answer is `no_match`. If several records could be the same subject, every candidate is returned and none is auto-selected. If the name and a supplied registration number describe different records, the response is flagged `mismatch` instead of pretending the pair is verified.

![TinyVerify returning the live NZ Companies Office record for Air New Zealand Limited](docs/screenshot-exact.png)

---

## Try it

Open https://tinyverify.vercel.app and press one of the sample chips:

| Sample | What it proves |
|---|---|
| **Tesco PLC** · business · UK | Exact match on the UK company register |
| **DONE RIGHT DISCOUNT FLOORING** · contractor · US-CA | Revoked California licence with expiry and a real complaint disclosure |
| **Air New Zealand Limited** · business · NZ | New Zealand company with NZBN, registered office and annual-return data |
| **TELSTRA CORPORATION LIMITED** · business · AU | Australian ABN with GST and entity type |
| **JOHN HORATIO SMITH II** · health · US-FL | Federal NPI and Florida medical board checked together |

Or verify from the CLI:

```bash
node cli.js verify "Tesco PLC" --type business --jurisdiction UK
node cli.js verify "Air New Zealand Limited" --type business --jurisdiction NZ --json
node cli.js watch "Tesco PLC" --type business --jurisdiction UK
node cli.js check mon_xxxxxxxxxxxx
```

---

## Coverage

| Record type | Jurisdiction | Official source | What comes back |
|---|---|---|---|
| `business` | `UK` | [UK Companies House](https://find-and-update.company-information.service.gov.uk) | status, company number, incorporation, registered office, SIC codes, filing dates, previous names, disqualification-register pointer |
| `business` | `NZ` | [NZ Companies Office](https://www.companiesoffice.govt.nz) | status, company number, NZBN, entity type, incorporation, registered office, annual-return data, previous names |
| `business` | `AU` | [Australian Business Register](https://abr.business.gov.au) | ABN status, ABN, entity type, GST registration, business and trading names |
| `contractor` | `US-CA` | [California CSLB](https://www.cslb.ca.gov) | licence status, number, issue/expiry dates, classifications, bond, workers' comp, complaint disclosure and arbitration records |
| `health` | `US` | [US NPPES NPI Registry](https://npiregistry.cms.hhs.gov) | enrolment status, NPI, provider name, taxonomy, declared state licence; optional state/city/taxonomy filters |
| `health` | `US-FL` | [Florida MQA](https://mqa-internet.doh.state.fl.us/MQASearchServices/HealthCareProviders) | licence status, number, profession, expiry, issue date, discipline and public-complaint flags |
| `health` | `US-TX` | [Texas Medical Board](https://profile.tmb.state.tx.us) | licence status, number, expiry date, Board actions and disciplinary flags |

`health / US-FL` is a **cross-registry** check: TinyVerify queries the federal NPI registry and the Florida medical board together, keeps both records, and prefers the state board record because it carries expiry and discipline. `health / US` with `"state": "FL"` does the same.

Every adapter returns the same record shape, so adding a registry does not change the API or the UI:

```json
{
  "subject": "Tesco PLC",
  "licence_type": "business",
  "jurisdiction": "UK",
  "status": "active",
  "status_bounty": "active",
  "licence_number": "00445790",
  "expiry_date": null,
  "disciplinary_actions": ["not published by this registry"],
  "disciplinary_records": [],
  "source_name": "UK Companies House",
  "source_url": "https://find-and-update.company-information.service.gov.uk/company/00445790",
  "checked_at": "2026-11-05T05:26:28.639Z",
  "match_quality": "exact",
  "name_number_mismatch": false,
  "registry_id": "companies-house-uk",
  "status_detail": "Active",
  "matched_name": "TESCO PLC",
  "total_found": 1,
  "fields": {
    "company_type": "Public limited Company",
    "incorporated_on": "1947-11-27",
    "registered_office": "Tesco House, Shire Park, Kestrel Way, Welwyn Garden City, United Kingdom, AL7 1GA",
    "sic": ["47110 - Retail sale in non-specialised stores with food, beverages or tobacco predominating"]
  },
  "notes": ["Officer disqualifications are a separate register and were not checked here: ..."]
}
```

`status` is the register's own state mapped to a shared vocabulary; `status_bounty` is the coarser active / expired / suspended / unknown view. Field meanings, thresholds and the full status table are in [docs/verification.md](docs/verification.md). Per-registry notes and rejected sources are in [docs/registries.md](docs/registries.md). Machine-readable contracts: [docs/openapi.yaml](docs/openapi.yaml) and [docs/record.schema.json](docs/record.schema.json).

---

## How TinyFish is used

TinyFish does the web work that plain HTTP cannot. Four endpoints are used, each for a job the other cannot do.

### 1. TinyFish Search — resolve the official record page

Some registries have no usable public search API. TinyVerify asks TinyFish Search for the record on the official domain, then filters results so only official record URLs survive:

- **UK Companies House** — `include_domains=find-and-update.company-information.service.gov.uk`, keeps only `/company/<number>` links.
- **California CSLB** — `include_domains=cslb.ca.gov`, keeps only `cslb.ca.gov/<licence-number>` links.

A result from any other domain is discarded. Search never supplies a status; it only finds the URL of the page that does.

### 2. TinyFish Fetch — read the official page

`lib/tinyfish.js` batches up to 10 URLs per Fetch call (`format: markdown` or `html`, `ttl: 0` for a fresh read). Used by:

- **UK Companies House** — fetch the company overview page and the paginated search result list (HTML parsing for links).
- **US NPPES NPI Registry** — Node's `fetch` can fail with `EAI_AGAIN` for `npiregistry.cms.hhs.gov`; TinyFish Fetch reads the JSON API reliably, returned as `html` and parsed as JSON.

Australia and Florida are read over direct HTTPS because their pages are server-rendered and need no browser. CSLB detail pages are also read directly; Search only resolves the short record URL.

### 3. TinyFish Agent — drive CSLB's form when Search fails

CSLB's "Check A License" name search is a session-based ASP.NET form. TinyFish Search often resolves a known business, but not every contractor has an indexed record page.

When Search returns no CSLB record URL, TinyVerify starts a **TinyFish Agent** run on `CheckLicense.aspx`, tells it to choose *Check by Business Name*, enter the name, submit, and return up to 10 licence numbers using a JSON output schema. The Agent only supplies **licence numbers**; TinyVerify then fetches each official detail page and reads the status, dates and disclosures itself. That keeps the agent out of the trust path.

The fallback is budgeted: **3 runs per hour per instance**, **2 concurrent runs**, a 10-minute result cache, and a hard cap on the prompt's subject text. The subject is quoted as a JSON literal and described as data, not instructions.

### 4. TinyFish Monitor — watch the record for changes

Creating a watch does two things:

1. Verifies the record live and stores a **baseline snapshot** (`status`, `licence_number`, `expiry_date`, `disciplinary_actions`, `status_detail`).
2. Creates a **TinyFish Monitor** of type `fetch` on the official record URL, scheduled daily (`0 8 * * *` by default), with a webhook back to TinyVerify when the page changes.

A monitor check re-reads the source and diffs the new snapshot against the stored one. Only real changes produce events:

```json
{
  "id": "evt_...",
  "changed_fields": ["status", "status_detail"],
  "old": { "status": "active", "status_detail": "Active" },
  "new": { "status": "suspended", "status_detail": "Proposal to strike off" },
  "summary": "Status changed from active to suspended. Status detail changed from Active to Proposal to strike off",
  "checked_at": "2026-11-05T08:00:00.000Z",
  "source_url": "https://find-and-update.company-information.service.gov.uk/company/00445790"
}
```

A transient registry miss — a timeout, a bot challenge, a page that no longer parses — is **not** a change. The previous snapshot is kept and the check is marked failed, because "the site was down" is not "the licence was revoked".

When `TINYVERIFY_DEMO=1`, the UI exposes a clearly labelled **Simulate change (demo)** button. It appends an event marked `simulated: true` and `detected_by: "TinyVerify demo simulator (not a live read)"`; it **never mutates the live snapshot**. Everything else in the change log comes from a real re-read.

---

## Matching, ambiguity and status

`match_quality` is always one of `exact`, `close`, `mismatch`, `multiple`, `no_match`, `unsupported`.

| Situation | Behaviour |
|---|---|
| One record, name identical after normalisation | `exact` |
| One record, plausible variant (missing legal suffix, reversed comma, middle initial) | `close`, with `matched_name`, confidence and `variant_used` |
| Several records above the threshold | `multiple` — every candidate returned, **nothing auto-selected** |
| Records below the threshold | `near_misses` — shown separately, never counted as matches |
| No record at all | `no_match`, plus the exact searches performed |
| Name supplied with a number that belongs to a different name | `mismatch`, `name_number_mismatch: true`, explicit note; record still returned because the number matched |
| Number supplied without a name | `exact` by number, never a fuzzy name guess |
| Type/jurisdiction not covered | `unsupported`, with the supported combinations |

Name matching requires **every meaningful query token to occur in the candidate** (exact or within a 0.85 spelling distance). Legal and generic tokens (`Ltd`, `PLC`, `Group`, `Services`, …) are dropped only for comparison, never from the displayed name. A partial word overlap therefore cannot become a "close" match, which is what stops a nonsense UK query from returning a random company. The close threshold is **0.80**.

Registry wording is preserved in `status_detail`; the shared status vocabulary is:

`active`, `expired`, `suspended`, `revoked`, `dissolved`, `in_liquidation`, `inactive`, `unknown`.

`status_bounty` collapses that to `active`, `expired`, `suspended`, `unknown` for a simple clearance view. Disagreeing registries are returned side by side with `conflict: true` and `status: "unknown"` — never merged.

![TinyVerify returning multiple candidates for "Air New Zealand" with no auto-selection](docs/screenshot-candidates.png)

---

## HTTP API

All responses are JSON. `POST /api/verify` is the main entry point. See [docs/openapi.yaml](docs/openapi.yaml) for the full contract.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Version, configured registries, storage backend, demo flag |
| `GET` | `/api/registries` | Registry metadata + supported combinations |
| `GET` | `/api/coverage` | Coverage matrix only |
| `POST` | `/api/verify` | Verify a record |
| `GET` | `/api/monitors` | List watches owned by the caller's `X-TinyVerify-Owner` token (admin key sees all) |
| `POST` | `/api/monitors` | Create a watch from a confirmed record; returns its `manage_token` once |
| `GET` | `/api/monitors/:id` | Watch + change events (watch token required) |
| `GET` | `/api/monitors/:id/events` | Change events only (watch token required) |
| `POST` | `/api/monitors/:id/check` | Re-read the source now, diff, return any event (watch token required) |
| `POST` | `/api/monitors/:id/simulate` | Demo-only labelled event; requires `TINYVERIFY_DEMO=1` |
| `DELETE` | `/api/monitors/:id` | Delete the watch and its TinyFish Monitor (watch token required) |
| `POST` | `/api/webhooks/tinyfish` | TinyFish Monitor callback |

```bash
curl -s https://tinyverify.vercel.app/api/verify \
  -H 'content-type: application/json' \
  -d '{"subject":"Air New Zealand Limited","licence_type":"business","jurisdiction":"NZ"}'
```

```bash
curl -s https://tinyverify.vercel.app/api/verify \
  -H 'content-type: application/json' \
  -d '{"subject":"JOHN HORATIO SMITH II","licence_type":"health","jurisdiction":"US-FL","number":"ME182088"}'
```

Every successful response includes `checked_at` and, per record, `source_url`. Results are cached for 10 minutes; a cached response keeps the original `source_url` and `checked_at` and says so in `notes`, with `cached: true`.

### Watch security model

- A watch is created with a random browser **owner token** (`X-TinyVerify-Owner`); the server stores only its SHA-256 hash.
- Creation also returns a random per-watch **`manage_token`** exactly once. Only its SHA-256 hash is stored. `GET`, `check` and `DELETE` require it as `X-TinyVerify-Watch-Token`; knowing a monitor id is not enough.
- `GET /api/monitors` returns only watches owned by the caller, or all watches when `X-TinyVerify-Admin` matches `TINYVERIFY_ADMIN_KEY`.
- A watch created before per-watch tokens still accepts its owner-scoped credential. A watch with neither credential is denied with `401 WATCH_TOKEN_REQUIRED`; there is no anonymous fallback.

### Rate limits and abuse controls

| Action | Limit |
|---|---|
| `POST /api/verify` | 20 / minute per client |
| Create a watch | 5 / day per client |
| Check a watch | 30 / minute per client |
| TinyFish webhook | 120 / minute per client |
| CSLB Agent fallback | 3 runs / hour, 2 concurrent |

`refresh: true` bypasses the short cache and costs an upstream read, so it is honoured only for a caller presenting a valid `X-TinyVerify-Admin` key. Every other request receives the normal cached response.

Request bodies are capped at 64 KB (256 KB for webhooks). Security headers include a strict CSP, `frame-ancestors 'none'`, `nosniff`, `no-referrer` and HSTS.

### Webhook verification

In production, `TINYVERIFY_WEBHOOK_SECRET` is required; without it the webhook returns `503 WEBHOOK_NOT_CONFIGURED`. Accepted proof:

- `?token=<secret>` in the callback URL, or
- HMAC-SHA256 of `<timestamp>.<raw body>` in `X-TinyFish-Signature`, with `X-TinyFish-Timestamp` within **±300 seconds**.

The URL token exists because TinyFish Monitor scheduled webhooks are not signed; a monitor's stored URL cannot be read back, so treat it as a secret. The HMAC path accepts only the timestamped form — a body-only signature is rejected. The replay claim is atomic (`SET NX EX` in Redis/KV, in-process fallback) and lasts 10 minutes; a failed re-check releases the claim so TinyFish's retry can proceed. The webhook never trusts the payload as the source of truth: it re-reads the official record through TinyVerify's pipeline before creating an event.

---

## Run it locally

Requires Node 22+. Zero runtime dependencies.

```bash
cp .env.example .env          # add TINYFISH_API_KEY
npm run dev                   # http://localhost:3000
npm test                      # 89 unit tests, no network
npm run test:live             # 12 real registry checks (LIVE=1)
npm run check                 # syntax check of entry points
```

`.env`:

```ini
TINYFISH_API_KEY=...
TINYVERIFY_WEBHOOK_SECRET=...        # required in production
TINYVERIFY_ADMIN_KEY=...             # optional admin view
TINYVERIFY_DEMO=1                    # optional demo simulator
TINYVERIFY_MONITOR_CRON=0 8 * * *
TINYVERIFY_PUBLIC_URL=https://your-deployment
KV_REST_API_URL=...
KV_REST_API_TOKEN=...
```

Monitors persist in Upstash Redis (`KV_REST_API_URL` + `KV_REST_API_TOKEN`) in the deployed app; locally they use an atomic JSON file under `data/`. The TinyFish API key is only read server-side and is never returned by any endpoint.

---

## Tests and evidence

```text
npm test        →  58 pass, 0 fail, 12 skipped (live tests)
npm run test:live →  12 pass, 0 fail
```

Unit coverage: name normalisation and variants, the token gate that rejects partial overlaps, status vocabulary (including liquidation / dissolved / inactive), date parsing, all six registry parsers against pages captured from the live sites, mismatch detection, total-count handling, registry resolution (including the Florida cross-registry rule), snapshot diffing, monitor lifecycle and per-watch access control, transient-miss handling, webhook signatures/replay, HTTP routing, error shapes, body limits, rate limiting and security headers.

The live suite checks: UK exact / nonsense / name-number mismatch / liquidation, NZ, AU ABN and checksum, NPI true count and exact number, CSLB revocation plus arbitration disclosure, the Florida NPI + MQA cross-check, and special-character handling. Live probe evidence is in `docs/evidence/` (`api-proof.json` for Search/Fetch/Agent/Monitor responses, `cslb-agent.mjs` for the Agent run, `probe-mqa.mjs` for the Florida number-search redirect).

## Known limits

- **Not covered:** UK HCPC (Cloudflare), UK GMC (client-rendered), Australia AHPRA (F5 challenge and no disambiguation rule), Ireland CRO (no clean public record page), Washington DOH (Salesforce JS), Texas TMB, Florida DBPR, and California DCA (API requires `app_id`/`app_key`). Each is documented as a rejected source in [docs/registry-research.md](docs/registry-research.md) rather than shipped broken.
- **CSLB name search** depends on either TinyFish Search finding a record URL or the Agent fallback running; a name-only lookup can take up to ~2.5 minutes. Supplying a licence number is always faster and exact.
- **NPI is an enrolment registry**, not a state licence board. It shows the state licence number a provider declared but does not publish that licence's status; the record says so, and the Florida check pairs it with the state board.
- **UK Companies House / NZ / AU** records have no expiry date. `expiry_date` is `null` and the UI says "Not applicable" instead of inventing one.
- **Florida MQA number search** answers an exact licence number with a 302 straight to the detail page. The adapter follows that redirect; it does not read a result table that is not sent.
- **Monitors** re-verify through TinyVerify's own pipeline on every check, so a change event always carries a fresh `source_url` and `checked_at`, even if the TinyFish webhook payload is incomplete.

## Licence and data

Application code: MIT. Registry data remains subject to each registry's terms. Companies House data is Crown copyright; CSLB, NPPES and Florida MQA are US public records; NZ Companies Office data is published by the New Zealand Companies Office; ABN data is published by the Australian Business Register. TinyVerify reports records; it does not give legal or hiring advice.
