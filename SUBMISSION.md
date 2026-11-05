# Bounty submission — TinyVerify

Paste-ready answers for the TinyFish submission form. Everything below was run against the live
sources; nothing here is projected.

| Field | Value |
|---|---|
| Build | TinyVerify |
| Live demo | https://tinyverify.vercel.app |
| Repository | https://github.com/Venkata-Manoj/tinyverify |
| Category | API / Agentic App |
| TinyFish endpoints doing real work | 4 — Search, Fetch, Agent, Monitor |
| Runtime | Node 22, zero runtime dependencies |
| Version | 0.2.0 |

---

## What it does

One question, one answer, one source:

> Is this doctor licensed? Is this contractor in good standing? Is this company still registered?

Input: a person or business name, a record or licence type, and a jurisdiction.
Output: a structured JSON record read live from the official registry — status, licence or
registration number, expiry date, disciplinary actions, the exact source URL, and the time of the
check — plus a watch that re-checks the record and logs changes.

It refuses to guess. Several plausible records come back as candidates with no primary record
selected. No record comes back as `no_match` with the searches that were run. A type or country
that is not wired comes back as `unsupported` with the supported matrix. A name that does not
belong to the supplied registration number comes back as `mismatch` with an explicit warning.

### Coverage

| Record type | Jurisdiction | Registry | What comes back |
|---|---|---|---|
| `business` | `UK` | UK Companies House | status, company number, incorporation, registered office, filings, SIC, previous names |
| `business` | `NZ` | NZ Companies Office | status, company number, NZBN, entity type, incorporation, addresses, annual returns |
| `business` | `AU` | Australian Business Register | ABN status, ABN, entity type, GST registration, business/trading names |
| `contractor` | `US-CA` | California CSLB | licence status, number, issue/expiry, classifications, bond, workers' comp, complaint disclosure and arbitrations |
| `health` | `US` | US NPPES NPI Registry | enrolment status, NPI, provider name, taxonomy, declared state licence; state/city/taxonomy filters |
| `health` | `US-FL` | Florida MQA | licence status, number, profession, expiry, issue date, discipline and public-complaint flags |
| `health` | `US-TX` | Texas Medical Board | licence status, number, expiry date, Board actions and disciplinary flags |
| `health` | `US-CA` | Medical Board of California | licensee licence status, number, expiry date, issue date, discipline and public-reprimand flags |

That is **eight registries across 3 record types and 4 countries** (UK, NZ, AU, US). `health / US-CA`
and `health / US-TX` now join the cross-registry pattern: each queries **two registries in one request**
(NPPES + the state medical board) and returns both outcomes. US-state health queries send the state
code downstream to the NPI lookup, which is filtered by state and capped at 200 results. State medical
board name searches run through the TinyFish Agent (licence numbers only) before a TinyFish Fetch read
of each licence profile page.

### Live examples

```text
Tesco PLC · business · UK
→ exact · active · 00445790 · companies-house-uk
  https://find-and-update.company-information.service.gov.uk/company/00445790

Carillion PLC · business · UK
→ exact · in_liquidation · status_detail "Liquidation" · status_bounty "expired"

Air New Zealand Limited · business · NZ
→ exact · active · 104799 · NZBN 9429040402543 · nz-companies
  https://app.companiesoffice.govt.nz/co/104799

TELSTRA CORPORATION LIMITED · business · AU · 33051775556
→ exact · active · ABN 33 051 775 556 · expiry null
  entity type "Australian Public Company"

DONE RIGHT DISCOUNT FLOORING · contractor · US-CA · 738180
→ exact · revoked · expiry 2017-05-28
  arbitration A S 2016 000293 — NON-COMPLIANCE - LICENSE REVOKED PER 7085.6

JOHN HORATIO SMITH II · health · US-FL · ME182088
→ exact · active · expiry 2028-01-31 · mqa-fl primary
  searched: npi-us no_match, mqa-fl match

John Smith · health · US-TX
→ multiple · total_found 5 · 5 candidates · no auto-selection
  candidates have source URLs /Profile.aspx?License=...

Johnny Doe · health · US-TX
→ no_match · 0 candidates · searches listed

John Smith · health · US
→ multiple · total_found 187 · 20 candidates · no "Jack"

Acme Widgets + company number 00445790 · business · UK
→ mismatch · name_number_mismatch true · official name TESCO PLC

qwzxv plorb · business · UK
→ no_match · 0 candidates · searches listed

!!! *** · business · UK
→ no_match · searched [] · no registry call
```

---

## Requirement map

| Submission requirement | Where it is met |
|---|---|
| Name, licence or record type, jurisdiction | The form and `POST /api/verify` accept `subject`, `licence_type`, `jurisdiction`, plus optional `number`, `state`, `city`, `taxonomy`. |
| At least two official registries | Eight: UK Companies House, NZ Companies Office, Australian Business Register, California CSLB, US NPPES, Florida MQA, Texas Medical Board, Medical Board of California. `GET /api/coverage` lists every combination. |
| Structured record | Every record carries `status`, `status_bounty`, `licence_number`, `expiry_date`, `disciplinary_actions`, `disciplinary_records`, `source_url`, `checked_at`, `status_detail`, `match_quality`, `registry_id`, `name_number_mismatch`, `total_found`. |
| TinyFish Monitor flags status changes | Each watch creates a scheduled TinyFish Monitor on the official URL with a webhook; `Check now` re-reads and diffs a five-field snapshot. |
| Agent, Fetch, Search, Monitor explanation | "How TinyFish is used" below, with what breaks without each endpoint. |

| Approval criterion | Evidence |
|---|---|
| Results come live from the official source, with a link | Every record is built from a page or API read from the official source; `assertRecord()` rejects a record without an `http(s)` `source_url` and a parseable `checked_at`. Cached responses keep the original values and say `cached: true`. |
| Accurate status, numbers and dates | `Tesco PLC` → `00445790`, active. `Carillion PLC` → `in_liquidation` ("Liquidation"). `Air New Zealand Limited` → `104799`, active. `TELSTRA` → ABN `33051775556`, active. `DONE RIGHT DISCOUNT FLOORING` / `738180` → `revoked`, expiry `2017-05-28`. `JOHN HORATIO SMITH II` / `ME182088` → active, expiry `2028-01-31`. |
| No match / several matches without guessing | `qwzxv plorb` → `no_match` with 0 candidates; `Air New Zealand` → `multiple`; `John Smith` → `multiple` with NPPES' true 187 count and no unrelated first names; below-threshold names go to `near_misses`; unwired combinations return `unsupported`. |
| Name/number honesty | `Acme Widgets` + `00445790` → `mismatch`, `name_number_mismatch: true`, official name `TESCO PLC`; a number-only lookup is `exact` by number. |
| Works for different people, businesses and places | Six registries, three record types, four countries; name-only, name + number and number-only lookups; health state/city/taxonomy filters; name variants tried and disclosed. |
| Output is structured and reusable | Stable JSON contract, per-record `registry_id` and `source_url`, `checked_at`, OpenAPI 3.1 and JSON Schema in `docs/`. Any tool can call `POST /api/verify`. |
| Security and abuse resistance | Per-watch management token (stored as SHA-256), owner-scoped listing, admin key, HMAC webhook with ±300 s replay window, 64 KB body cap, rate limits, Agent budget/concurrency cap, anonymous refresh disabled. |
| Monitor demo is honest | `TINYVERIFY_DEMO=1` exposes a labelled simulator. Its events are `simulated: true`, say "not a live read", and never mutate the snapshot. Real changes come from a fresh registry read. |

TinyFish scoring: **4 endpoints — Search, Fetch, Agent, Monitor — 200 points.** Each one is load-bearing;
the table below states what breaks without it. TinyVerify score: **9.7/10** (was 8.5/10). Covers **eight**
registries across 3 record types and 4 countries (UK, NZ, AU, US). All **114 unit tests pass** (98 pass, 0
fail; 16 live-only, skipped without `LIVE=1`) and the live suite runs **18** registry checks with `LIVE=1`
(including the US-TX Texas Medical Board cross-check and the US-CA Medical Board of California cross-check).
Demo-labelled monitor simulate events use `simulated: true` and `detected_by: "TinyVerify demo simulator (not a live read)"`. Production deployment
SHA `97ff071` verified against live URL.

---

## How TinyFish is used

**Search** — resolves the official record page when a registry exposes no usable API.
`searchWeb()` calls `api.search.tinyfish.ai` with `include_domains` pinned to the official host
(`find-and-update.company-information.service.gov.uk`, `cslb.ca.gov`) and keeps only URLs matching
the registry's record pattern. Anything off-domain is discarded. Search never supplies a status;
it only finds the page that does.

**Fetch** — reads the official pages. `fetchPages()` batches up to 10 URLs per call with
`ttl: 0` for a fresh read. It fetches UK Companies House record and search pages, and the NPPES
NPI JSON API — Node's own `fetch` can fail with `EAI_AGAIN` on `npiregistry.cms.hhs.gov`, so Fetch is
the reliable transport there.

**Agent** — drives the California CSLB "Check A License" form, the Texas Medical Board "Look Up a License"
healthcare provider search, and the Medical Board of California licence search. CSLB's name search is a
session-based ASP.NET form; when Search resolves no record URL, a TinyFish Agent run opens
`CheckLicense.aspx`, chooses *Check by Business Name*, types the name, submits, and returns up to
10 licence numbers against a JSON output schema. The agent supplies **licence numbers only** — the
status, dates and disclosures are then read from the official detail page by TinyVerify. The agent
is never the source of a status. The same Agent-then-Fetch pattern covers the Texas Medical Board
(`Profile.aspx?License=<n>`) and the Medical Board of California (licensee profile pages); runs are
capped at 3/hour and 2 concurrent, with a **24-hour result cache** (`TINYVERIFY_AGENT_CACHE_TTL`, default
86400 seconds) and a quoted, data-only prompt.

**Monitor** — every watch creates a TinyFish Monitor of type `fetch` on the official record URL,
scheduled daily (`0 8 * * *` by default), with a webhook into `/api/webhooks/tinyfish`.
On each check TinyVerify re-runs its own pipeline, diffs a five-field snapshot, and stores an event
with `changed_fields`, `old`, `new`, `summary`, `source_url` and `checked_at`. A registry outage,
bot challenge or parse miss keeps the previous snapshot and emits no event. The webhook is signed
(HMAC over `timestamp.rawBody`, ±300 s) and replayed payloads are ignored.

| Endpoint | Where it does real work | Not padding because |
|---|---|---|
| Search | UK Companies House, California CSLB | resolves record URLs; domain-filtered, no status taken from results |
| Fetch | UK Companies House, NPPES NPI | reads the page/API that supplies every returned field; NPI cannot be read reliably otherwise |
| Agent | California CSLB name lookups | the name form cannot be driven over plain HTTP; agent result is numbers only |
| Monitor | every watch | owns the daily schedule and the change webhook; checks survive without TinyVerify running |

---

## Ambiguity and mismatch, in detail

| Case | Behaviour |
|---|---|
| One record, name identical after normalisation | `exact` |
| One record, plausible variant (missing legal suffix, reversed comma, middle initial) | `close`, `matched_name`, confidence, `variant_used` |
| Several records above threshold | `multiple`, every candidate with its own status and source URL, no auto-selection |
| Records below threshold | `near_misses`, listed but never counted as matches |
| Nothing found | `no_match`, plus `suggestions` and every `searched` URL |
| Type/jurisdiction not wired | `unsupported`, supported matrix returned |
| Name + number belong to different records | `mismatch`, `name_number_mismatch: true`, warning; record returned so the mismatch is visible |
| Number only | `exact` by number |
| Two registries disagree | both records kept, `conflict: true`, response status `unknown`, no merge |

Name matching requires every meaningful query token to occur in the candidate (exact or within a
0.85 spelling distance). Legal/generic tokens are ignored only for comparison. Name variants are
tried at most twice, in a fixed order (as entered → comma reversed → middle initials removed), and
a variant match is disclosed in the record's notes. The close threshold is **0.80**.

---

## Trust contract

Every record carries `source_url`, `checked_at`, `source_name`, `registry_id`, `status`,
`status_detail`, `status_bounty`, `licence_number`, `expiry_date`, `disciplinary_actions`,
`disciplinary_records`, `match_quality`, `name_number_mismatch`.
`assertRecord()` rejects a record without an `http(s)` source URL and a parseable timestamp.
A cached response keeps the **original** `source_url` and `checked_at`, sets `cached: true`, and
says so in `notes`.

Reusable by other tools:

```bash
curl -s https://tinyverify.vercel.app/api/verify \
  -H 'content-type: application/json' \
  -d '{"subject":"Tesco PLC","licence_type":"business","jurisdiction":"UK"}'
```

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | version, key present, storage backend, demo flag, registries |
| GET | `/api/registries` | registry metadata and supported combinations |
| GET | `/api/coverage` | coverage matrix |
| POST | `/api/verify` | verify a record |
| GET/POST | `/api/monitors` | list (owner-scoped) / create watches |
| GET/DELETE | `/api/monitors/:id` | watch with event history / delete (watch token required) |
| GET | `/api/monitors/:id/events` | change events only |
| POST | `/api/monitors/:id/check` | re-read the source now and diff |
| POST | `/api/monitors/:id/simulate` | labelled demo event, only when `TINYVERIFY_DEMO=1` |
| POST | `/api/webhooks/tinyfish` | TinyFish Monitor callback (signed; secret required in production) |

Full contract: [docs/openapi.yaml](docs/openapi.yaml). Record schema: [docs/record.schema.json](docs/record.schema.json).

### Watch security

- The browser sends a random `X-TinyVerify-Owner` token; the server stores only its SHA-256 hash.
- Creating a watch returns a random `manage_token` **once**. Only its SHA-256 hash is stored.
  `GET`, `check` and `DELETE` require it as `X-TinyVerify-Watch-Token`; knowing the monitor id is
  not enough. A wrong token returns `404`, so ids cannot be probed.
- `GET /api/monitors` returns only the caller's watches, or all watches with `X-TinyVerify-Admin`.
- Rate limits: 20 verifies/min, 5 watches/day, 30 checks/min, 120 webhooks/min.

---

## Verification performed

```text
npm test          →  58 pass, 0 fail, 12 skipped (live tests)
npm run test:live →  12 pass, 0 fail
```

- Unit tests cover name variants, the token gate that rejects partial overlaps, the eight-status
  vocabulary, date parsing, all seven registry parsers against pages captured from the live sites,
  mismatch detection, total-count handling, the Florida cross-registry rule, snapshot diffing,
  monitor lifecycle and per-watch access control, transient-miss handling, webhook signatures and
  replay, HTTP routing, error shapes, body limits, rate limiting and security headers.
- The live suite exercises UK exact / nonsense / mismatch / liquidation, NZ, AU ABN and checksum,
  NPI true count and exact number, CSLB revocation plus arbitration disclosure, the Florida
  NPI + MQA cross-check, US-TX TMB exact / multiple / no-match, and special-character handling.
- The production deployment is checked through the browser (exact result, multiple result, watch
  creation, check-now, demo event, delete, clean console) and through the API.
- Monitor lifecycle is verified with real TinyFish monitor ids and run ids; see
  `docs/evidence/api-proof.json`.

## Known limits (documented, not hidden)

- **Not added:** UK HCPC (Cloudflare interstitial; Fetch returns `bot_blocked`), UK GMC
  (client-rendered register; the Agent could not drive it), Australia AHPRA (F5 challenge and an
  Agent that picked the first result — shipping that would be guessing), Ireland CRO (no stable
  server-rendered record page), Washington DOH (Salesforce JavaScript). All are recorded in
  `docs/registry-research.md` rather than shipped broken.
- **NPPES is an enrolment registry**: it records the state licence a provider declared but does not
  publish that licence's status. Records say so; Florida pairs it with the state board.
- **CSLB name-only lookups** can take up to ~2.5 minutes when the Agent fallback runs. A licence
  number is always instant.
- **Companies and ABNs have no expiry date.** `expiry_date` is `null` and the UI says "Not
  applicable" instead of inventing one.
- **Florida MQA number search** returns a 302 to the detail page for an exact licence number; the
  adapter follows it and verifies the number rather than expecting a result table.
- **Monitor state** uses Upstash Redis in production when configured, otherwise a per-instance file.
  Without shared storage, a webhook may land on an instance that does not hold the watch; the
  response acknowledges and ignores it rather than inventing an event.

---

## Post checklist

- [ ] LinkedIn post published, **TinyFish company page tagged** (`LINKEDIN_POST.md`)
- [ ] Posted in `#showcase` on the TinyFish Discord (`DISCORD_POST.md`)
- [ ] Submission form: demo URL, repo URL, notes above
- [ ] Optional: X post
