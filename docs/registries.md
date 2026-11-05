# Registries

Six official sources are wired. Each adapter lives in `lib/registries/`, declares its coverage in `meta`, and returns the shared record shape from `lib/schema.js`.

| Registry | `registry_id` | Type | Jurisdiction | Transport |
|---|---|---|---|---|
| UK Companies House | `companies-house-uk` | `business` | `UK` | TinyFish Search + Fetch |
| NZ Companies Office | `nz-companies` | `business` | `NZ` | Direct HTTPS |
| Australian Business Register | `abn-au` | `business` | `AU` | Direct HTTPS |
| California CSLB | `cslb-ca` | `contractor` | `US-CA` | TinyFish Search + direct HTTPS, Agent fallback |
| US NPPES NPI Registry | `npi-us` | `health` | `US` | TinyFish Fetch (JSON API) |
| Florida MQA | `mqa-fl` | `health` | `US-FL` | Direct HTTPS (ASP.NET form + detail page) |

`GET /api/registries` returns this metadata plus the supported combinations; `GET /api/coverage` returns the matrix alone.

`health / US-FL` resolves to **two** adapters (`npi-us` + `mqa-fl`). `health / US` with `state=FL` does the same; `health / US` without a state stays federal-only.

---

## UK Companies House

**Official site:** https://find-and-update.company-information.service.gov.uk

**Why this source:** the UK register is the canonical record for company status, incorporation and filings, and its pages are server-rendered.

**Flow**

1. With a company number: fetch `/company/<number>` directly.
2. Without a number: TinyFish Search with `include_domains=find-and-update.company-information.service.gov.uk` and the query `"<name>" company`. Only `/company/<number>` URLs survive.
3. If Search has no record URL, fetch the official search page (`/search/companies?q=<name>`) with links enabled and parse company links.
4. Fetch up to 8 candidate company pages in one TinyFish Fetch batch, parse each, score names, and return one match, several candidates, or no match.

**Record URL:** `/company/<number>` (stable).

**Parsed fields**

- `status` from the "Company status" row (`Active`, `Dissolved`, `Struck off`, `Liquidation`, …)
- `company_number`, `company_type`, `incorporated_on`
- `registered_office`
- `next_accounts_made_up_to`, `next_accounts_due`
- `next_confirmation_statement_date`, `next_confirmation_statement_due`
- `sic` (array), `previous_names` (array)
- `disqualified_officers: "not checked"`

**Caveats**

- Companies have no expiry date. `expiry_date` is `null` and a note explains that the register has no such concept.
- Officer disqualifications live in a **separate** register. The adapter does not read that register; the record says `"not checked"` and includes a link to the disqualification search. It does not claim the company is clear.
- "Active - proposal to strike off" keeps the native wording and maps to `active`; `status_detail` carries the warning.
- Liquidation wording maps to `in_liquidation`, not `expired`; `status_bounty` still reports `expired`.

---

## NZ Companies Office

**Official site:** https://www.companiesoffice.govt.nz (application host: `app.companiesoffice.govt.nz`)

**Why this source:** fully server-rendered, no bot wall, and it publishes a stable short link per company.

**Flow**

1. With a company number (1–9 digits): read `https://app.companiesoffice.govt.nz/co/<number>`.
2. Without a number: read the advanced search page

   ```text
   /companies/app/ui/pages/companies/search?q=<name>&entityTypes=ALL&entityStatusGroups=ALL&start=0&limit=15&advancedPanel=true&mode=advanced
   ```

3. Parse result rows. Names and statuses sit inside `javascript:viewCompanyDetails('<number>')` anchors — the HTML is parsed directly because markdown extraction drops the names.
4. If exactly one plausible result exists, read its record page. If several do, return candidates. If none do, return no match.

**Record URL:** `/co/<number>` (redirects to the full record page; the short link is what the API returns).

**Parsed fields**

- `status` from the "Company Status" row (`Registered`, `Removed`, `Liquidation`, …)
- `nzbn`, `entity_type`, `incorporated_on`
- `registered_office`, `address_for_service`
- `annual_return_month`, `annual_return_last_filed`
- `last_updated_on_source`, `constitution_filed`
- `previous_names`

**Caveats**

- No expiry date; the record exposes the annual-return cycle instead.
- No disciplinary data on the company page. NZ banned-director decisions are a separate register and are not merged into this record.
- `"air new zealand"` returns hundreds of entities; the adapter returns the plausible ones as candidates rather than guessing. Supplying the company number is exact.
- `Removed` maps to `dissolved`; `Liquidation` maps to `in_liquidation`.

---

## Australian Business Register (ABN Lookup)

**Official site:** https://abr.business.gov.au

**Why this source:** the ABR is the authoritative Australian business number register; the public pages are server-rendered and need no ABR GUID/API key.

**Flow**

1. With an 11-digit ABN: validate the official **ABN checksum** before any network call, then read `/ABN/View?id=<abn>`.
2. Without a number: POST the official search form (`/Search/Run`) with `SearchParameters.SearchText` and `SearchParameters.AllNames=true`, which redirects to `/Search/ResultsActive`.
3. Parse the result rows, fetch the plausible detail pages, and score names against the legal name, business names and trading names.
4. Return one match, several candidates, or no match.

**Record URL:** `https://abr.business.gov.au/ABN/View?id=<abn>`.

**Parsed fields**

- `status` from the `ABN status:` row (`Active`, `Cancelled`, …)
- `abn` (formatted), `entity_type`
- `gst_registered_from`
- `main_business_location`
- `business_names`, `trading_names`
- `abn_last_updated`

**Caveats**

- An ABN has **no expiry date**. `expiry_date` is `null`; the register publishes the status and its effective date.
- ABN Lookup publishes no disciplinary actions. The record says `["not published by this registry"]`.
- The active search excludes cancelled ABNs. A cancelled ABN must be checked by number; the adapter says so when a name search returns nothing.
- A transposed or invented ABN is rejected with HTTP 400 before any fetch (checksum), rather than being sent to the register.

---

## California CSLB

**Official site:** https://www.cslb.ca.gov

**Why this source:** California's Contractors State License Board is the licensing authority for contractors, and its detail pages are server-rendered.

**Flow**

1. With a licence number: read `https://www.cslb.ca.gov/<number>` directly and parse the detail page.
2. Without a number: TinyFish Search with `include_domains=cslb.ca.gov` and the query `"<name>" contractor license`. Only URLs of the form `cslb.ca.gov/<digits>` survive.
3. Fetch every resolved licence page, score names, and return a match / candidates / no match.
4. If Search resolves nothing, run **TinyFish Agent** on `https://www.cslb.ca.gov/OnlineServices/CheckLicenseII/CheckLicense.aspx`:
   - goal: choose *Check by Business Name*, enter the name, submit, return up to 10 licence numbers;
   - schema: `{ found, matches: [{ business_name, licence_number }], page_note }`;
   - agent output is treated as **licence numbers only**; each official detail page is then fetched and parsed by TinyVerify.
5. Agent results are cached for 10 minutes per name. The fallback runs only on the as-entered name variant, is capped at 3 runs/hour and 2 concurrent runs, and has a 150 s default budget.

**Record URL:** `https://www.cslb.ca.gov/<licence-number>` (the `LicenseDetail.aspx?LicNum=` form redirects to a generic page and is not used).

**Parsed fields**

- `status` from the "License Status" block (`Active`, `Expired`, `Canceled`, `Revoked`, …)
- `business_name`, `address`, `phone`, `entity`
- `issue_date`, `expire_date` (US month-first dates)
- `classifications` (array, e.g. `C15 - Flooring`)
- `bond_number`, `workers_compensation`
- `complaint_disclosure` (`on file` / `none` / `not shown`) and `data_current_as_of`
- `additional_status`

**Complaint disclosure**

When CSLB flags complaint disclosure, the adapter also reads `ComplaintDisclosure.aspx?LicType=LIC&LicNum=<number>` with a browser user-agent and a CSLB referer. Each arbitration becomes a structured `disciplinary_records` entry (`type`, `date`, `description`, `status`, `source_url`). The arbitration number is kept inside `description`; `disciplinary_actions` is the human-readable summary.

**Caveats**

- CSLB's name search is a session-based ASP.NET form. TinyFish Search resolves most indexed records; the Agent handles the rest and can take up to ~2.5 minutes.
- A licence number is always the fastest and most reliable input.
- Complaint disclosure is a legal disclosure under B&P 7124.6. TinyVerify reports what CSLB publishes; it does not summarise the allegations or decide whether they matter.
- If CSLB says disclosure exists but the complaint page cannot be read, the licence record is still returned and a note says the complaint detail is missing.

---

## US NPPES NPI Registry

**Official site:** https://npiregistry.cms.hhs.gov

**Why this source:** the National Plan and Provider Enumeration System is the US federal provider registry, with a public JSON API.

**Flow**

1. Build the official API URL (`/api/?version=2.1&number=<npi>` or `&first_name=&last_name=` / `&organization_name=`), with `limit=200` and `use_first_name_alias=false`.
2. Add optional filters: `state`, `city`, `taxonomy_description`.
3. Read it with **TinyFish Fetch** using `format: 'html'`. Node's `fetch` can fail with `EAI_AGAIN` against this host; TinyFish Fetch returns the JSON body reliably.
4. Parse `result_count` and `results[]`. `total_found` is the registry's true `result_count`, not the number of rows returned.
5. With a number, the first result is the record. Without one, score every result and return a match / candidates / no match.

**Record URL:** `https://npiregistry.cms.hhs.gov/provider-view/<npi>` (the public provider view).

**Parsed fields**

- `status` from `basic.status` (`A` → active)
- `number` (NPI), provider name (individual or organisation)
- `enumeration_type` (`Individual (NPI-1)` / `Organisation (NPI-2)`)
- `primary_taxonomy`, all taxonomies
- `state_licence_number`, `state_licence_state`
- addresses (location and mailing), enumeration/certification dates

**Caveats**

- NPPES is an **enrolment** registry. It records the state licence number a provider declared but does not publish that licence's status. The record carries a note saying so. For Florida, pair it with the MQA adapter.
- Organisations (NPI-2) are legal entities, not licensed practitioners; the record says so.
- NPIs are 10 digits. Number lookups are validated before the call. When NPPES is queried alongside a state board and the supplied number is a state licence (e.g. `ME182088`), NPPES is skipped with an explicit `no_match` detail instead of failing the whole check.

---

## Florida Department of Health (MQA)

**Official site:** https://mqa-internet.doh.state.fl.us/MQASearchServices/HealthCareProviders

**Why this source:** the Florida Medical Quality Assurance registry is the state licensing authority for physicians, nurses and other health professions, and it publishes status, expiry and discipline.

**Flow**

1. GET the search form to obtain the ASP.NET anti-forgery token and session cookie.
2. POST `SearchDto.*` fields with `LicenseStatus=ALL`.
3. If the POST answers with a **302 to `LicenseVerification`**, that is an exact licence-number hit: read the detail page directly. This is the normal number-lookup path.
4. Otherwise parse the result table (`SearchDto.LicenseNumber`, `LastName`/`FirstName`, `BusinessName`, city/county/zip filters), fetch detail pages, and score names.
5. If the detail page flags discipline or a public complaint, fetch `LoadEnforcementActionsTab` and parse the actions.

**Record URL:** `https://mqa-internet.doh.state.fl.us/MQASearchServices/HealthCareProviders/LicenseVerification?LicInd=<id>&ProCde=<profession>`

**Parsed fields**

- `status` from `License Status` (`Clear/Active`, `Delinquent`, `Suspended`, `Revoked`, …)
- `number`, `profession`
- `expiry_date` (License Expiration Date), `issue_date` (License Original Issue Date)
- `address_of_record`, `qualifications`
- `has_discipline`, `has_public_complaint`
- `discipline` records from the enforcement-actions tab

**Caveats**

- The search form's help text says to omit spaces; TinyVerify also normalises case and whitespace before posting.
- An exact number returns a redirect, not a result table. Reading only the table is the bug that made valid numbers look absent; the adapter follows the redirect and verifies that the detail page's licence number matches the requested one.
- `Delinquent` maps to `expired` (the licence is not in good standing), while the native wording stays in `status_detail`.
- MQA is a state board; it does not publish an NPI. The cross-registry response keeps the NPI `no_match` visible rather than hiding it.

---

## Rejected sources

These were investigated and deliberately not shipped, because a broken or guessed check is worse than an honest gap.

| Source | Finding | Decision |
|---|---|---|
| **UK HCPC** | Search results page sits behind a Cloudflare interstitial; TinyFish Fetch returns `bot_blocked`, and an Agent run hit a "Verify you are human" challenge. The detail page is server-rendered but the registrant-selection parameter was not confirmed. | Not wired. Documented as [UNKNOWN] in `docs/registry-research.md`. |
| **UK GMC** | The register search is a client-side widget; query parameters are ignored server-side. An Agent run could not operate the profession dropdown, and the registrant page renders its fields client-side. GMC publishes a daily bulk register download, but access terms were not confirmed. | Not wired. Bulk download is the likely future path. |
| **Australia AHPRA** | F5 bot-defence challenge on the search page. A stealth Agent run succeeded and returned a record from the Medical Board sub-site, but it picked the first search result. Without a disambiguation rule, that is exactly the guessing TinyVerify forbids. | Not wired until registration-number lookup and exact-name matching are proven. |
| **Ireland CRO** | The public search is a session-based form; no stable server-rendered record page was found for a direct read. | Not wired. |
| **Washington DOH** | Provider credential search is a Salesforce JavaScript application; the HTML does not contain the record. | Not wired. |
| **Texas TMB** | The verification flow is form/session based and did not yield a directly parseable record page. | Not wired. |
| **Florida DBPR** | Separate from the Department of Health MQA; the public search did not yield a stable direct record URL in the time available. | Not wired. |
| **California DCA** | The public API requires `app_id` and `app_key`; without credentials it cannot be read honestly. | Not wired. |

The registry metadata is intentionally a closed list: `/api/verify` returns `unsupported` for anything not in the matrix instead of pretending to check it.
