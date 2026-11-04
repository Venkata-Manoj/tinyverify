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

---

## What it does

One question, one answer, one source:

> Is this doctor licensed? Is this contractor in good standing? Is this company still registered?

Input: a person or business name, a record or licence type, and a jurisdiction.
Output: a structured JSON record read live from the official registry — status, licence or
registration number, expiry date, disciplinary flags, the exact source URL, and the time of the
check — plus a watch that re-checks the record and logs changes.

It refuses to guess. Several plausible records come back as candidates with no primary record
selected. No record comes back as `no_match` with the searches that were run. A type or country
that is not wired comes back as `unsupported` with the supported matrix.

### Coverage

| Record type | Jurisdiction | Registry | Record types |
|---|---|---|---|
| `business` | `UK` | UK Companies House | status, company number, incorporation, registered office, filings, SIC, previous names |
| `business` | `NZ` | NZ Companies Office | status, company number, NZBN, entity type, incorporation, addresses, annual returns |
| `contractor` | `US-CA` | California CSLB | licence status, number, issue/expiry, classifications, bond, workers' comp, complaint disclosure |
| `health` | `US` | US NPPES NPI Registry | enrolment status, NPI, provider name, taxonomy, declared state licence |

That is 4 registries across 3 record types and 3 countries (UK, NZ, US).

### Live examples

```text
Tesco PLC · business · UK
→ exact · active · 00445790 · companies-house-uk
  https://find-and-update.company-information.service.gov.uk/company/00445790

Air New Zealand Limited · business · NZ
→ exact · active · 104799 · NZBN 9429040402543 · nz-companies
  https://app.companiesoffice.govt.nz/co/104799

Air New Zealand · business · NZ
→ multiple · 11 candidates, statuses preserved (active and expired), primary: null

DONE RIGHT DISCOUNT FLOORING · contractor · US-CA
→ exact · revoked ("revoked and not able to contract") · 738180 · expiry 2017-05-28
  public complaint disclosure on file

HALA TREE SERVICE · contractor · US-CA
→ multiple · 574648 (cancelled 1993) and 1000000 (expired 2019), no auto-pick

Planise Jean Louis · health · US
→ exact · active · NPI 1295346773 · FL APRN11008477 declared · Nurse Practitioner, Family

ZZZ Not A Real Company 999 · business · UK
→ no_match · 0 candidates · the searches that were run are listed
```

---

## How TinyFish is used

**Search** — resolves the official record page when a registry exposes no usable API.
`searchWeb()` calls `api.search.tinyfish.ai` with `include_domains` pinned to the official host
(`find-and-update.company-information.service.gov.uk`, `cslb.ca.gov`) and keeps only URLs matching
the registry's record pattern. Anything off-domain is discarded. Search never supplies a status;
it only finds the page that does.

**Fetch** — reads the official pages. `fetchPages()` batches up to 10 URLs per call with
`ttl: 0` for a fresh read. It fetches UK Companies House record and search pages, and the NPPES
NPI JSON API — Node's own `fetch` fails with `EAI_AGAIN` on `npiregistry.cms.hhs.gov`, so Fetch is
the only reliable transport there.

**Agent** — drives the California CSLB "Check A License" form. CSLB's name search is a
session-based ASP.NET form; when Search resolves no record URL, a TinyFish Agent run opens
`CheckLicense.aspx`, chooses *Check by Business Name*, types the name, submits, and returns up to
10 licence numbers against a JSON output schema. The agent supplies **licence numbers only** — the
status, dates and disclosures are then read from the official detail page by TinyVerify. The agent
is never the source of a status. Results are cached for 10 minutes so a retry does not start
another browser run.

**Monitor** — every watch creates a TinyFish Monitor of type `fetch` on the official record URL,
scheduled daily (`0 8 * * *` by default), with a webhook back into `/api/webhooks/tinyfish`.
On each check TinyVerify re-runs its own pipeline, diffs a five-field snapshot, and stores an event
with `changed_fields`, `old`, `new`, `summary`, `source_url` and `checked_at`. A registry outage,
bot challenge or parse miss keeps the previous snapshot and emits no event.

| Endpoint | Where it does real work | Not padding because |
|---|---|---|
| Search | UK Companies House, California CSLB | resolves record URLs; domain-filtered, no status taken from results |
| Fetch | UK Companies House, NPPES NPI | reads the page/API that supplies every returned field; NPI cannot be read otherwise |
| Agent | California CSLB name lookups | the name form cannot be driven over plain HTTP; agent result is numbers only |
| Monitor | every watch | owns the daily schedule and the change webhook; checks survive without TinyVerify running |

---

## Ambiguity, in detail

| Case | Behaviour |
|---|---|
| One record, name identical after normalisation | `exact` |
| One record, plausible variant (missing legal suffix, reversed comma) | `close`, `matched_name`, confidence, `variant_used` |
| Several records above threshold | `multiple`, every candidate with its own status and source URL, `primary: null` |
| Records below threshold | `near_misses`, listed but never counted as matches |
| Nothing found | `no_match`, plus `suggestions` and every `searched` URL |
| Type/jurisdiction not wired | `unsupported`, supported matrix returned |
| Two registries disagree | both records kept, `conflict: true`, response status `unknown`, no merge |

Name variants are tried at most twice, in a fixed order (as entered → comma reversed → middle
initials removed). A variant match is disclosed in the record's notes.

---

## Trust contract

Every record carries `source_url`, `checked_at`, `source_name`, `registry_id`, `status`,
`status_detail`, `licence_number`, `expiry_date`, `disciplinary_actions`, `match_quality`.
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
| GET | `/api/health` | version, key present, storage backend, registries |
| GET | `/api/registries` | registry metadata and supported combinations |
| GET | `/api/coverage` | coverage matrix |
| POST | `/api/verify` | verify a record |
| GET/POST | `/api/monitors` | list / create watches |
| GET/DELETE | `/api/monitors/:id` | watch with event history / delete |
| POST | `/api/monitors/:id/check` | re-read the source now and diff |
| POST | `/api/webhooks/tinyfish` | TinyFish Monitor callback (optional shared secret) |

---

## Verification performed

- `npm test` → **40 tests, 40 pass**, no network. Covers name variants, status vocabulary, day-first
  and month-first date parsing, all four registry parsers against pages captured from the live
  sites, match classification, snapshot diffing, transient-miss handling, routing and error shapes.
- Each registry was exercised live end to end, including a no-match and a multi-match case.
- The production deployment was checked through the browser (exact result, watch creation,
  check-now, delete, clean console) and through the API (all routes above).
- Monitor lifecycle verified in production with real TinyFish monitor ids and run ids.

## Known limits (documented, not hidden)

- **HCPC** (UK) sits behind a Cloudflare interstitial: TinyFish Fetch returns `bot_blocked` and an
  Agent run hit a human challenge. **GMC** (UK) renders its register client-side; the agent could
  not drive the profession dropdown. **AHPRA** (Australia) works only through a stealth agent run
  that picked the first search result — shipping that would be guessing. All three are recorded as
  rejected sources in `docs/registry-research.md` rather than shipped broken.
- **NPPES is an enrolment registry**: it records the state licence a provider declared but does not
  publish that licence's status. Records say so.
- **CSLB name-only lookups** can take up to ~2.5 minutes when the agent fallback runs. A licence
  number is always instant.
- **Companies have no expiry date.** `expiry_date` is `null` and the UI says "Not applicable"
  instead of inventing one.

---

## Post checklist

- [ ] LinkedIn post published, **TinyFish company page tagged** (`LINKEDIN_POST.md`)
- [ ] Posted in `#showcase` on the TinyFish Discord (`DISCORD_POST.md`)
- [ ] Submission form: demo URL, repo URL, notes above
- [ ] Optional: X post
