# Registries

Four official sources are wired. Each adapter lives in `lib/registries/`, declares its coverage in `meta`, and returns the shared record shape from `lib/schema.js`.

| Registry | `registry_id` | Type | Jurisdiction | Transport |
|---|---|---|---|---|
| UK Companies House | `companies-house-uk` | `business` | `UK` | TinyFish Search + Fetch |
| NZ Companies Office | `nz-companies` | `business` | `NZ` | Direct HTTPS |
| California CSLB | `cslb-ca` | `contractor` | `US-CA` | TinyFish Search + direct HTTPS, Agent fallback |
| US NPPES NPI Registry | `npi-us` | `health` | `US` | TinyFish Fetch (JSON API) |

`GET /api/registries` returns this metadata plus the supported combinations; `GET /api/coverage` returns the matrix alone.

---

## UK Companies House

**Official site:** https://find-and-update.company-information.service.gov.uk

**Why this source:** the UK register is the canonical record for company status, incorporation and filings, and its pages are server-rendered.

**Flow**

1. With a company number: fetch `https://find-and-update.company-information.service.gov.uk/company/<number>` directly.
2. Without a number: TinyFish Search with `include_domains=find-and-update.company-information.service.gov.uk` and the query `"<name>" company`. Only `/company/<number>` URLs survive.
3. If Search has no record URL, fetch the official search page (`/search/companies?q=<name>`) with links enabled and parse company links.
4. Fetch up to 8 candidate company pages in one TinyFish Fetch batch, parse each, score names, and return one match, several candidates, or no match.

**Record URL:** `/company/<number>` (stable).

**Parsed fields**

- `status` from the "Company status" row (`Active`, `Dissolved`, `Struck off`, `In administration`, …)
- `company_number`, `company_type`, `incorporated_on`
- `registered_office`
- `next_accounts_made_up_to`, `next_accounts_due`
- `next_confirmation_statement_date`, `next_confirmation_statement_due`
- `sic` (array), `previous_names` (array)

**Caveats**

- Companies have no expiry date. `expiry_date` is `null` and a note explains that the register has no such concept.
- Disciplinary actions are not a Companies House concept; the record says `["none found"]` with a note.
- The register lists some entities as `Active - proposal to strike off`. The mapper keeps the native wording and classifies it `active`; the detail string carries the warning.

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

- `status` from the "Company Status" row (`Registered`, `Removed`, …); liquidation/administration wording maps to `suspended`
- `nzbn`, `entity_type`, `incorporated_on`
- `registered_office`, `address_for_service`
- `annual_return_month`, `annual_return_last_filed`
- `last_updated_on_source`, `constitution_filed`
- `previous_names`

**Caveats**

- No expiry date; the record exposes the annual-return cycle instead.
- No disciplinary data on the company page. NZ banned-director decisions are a separate register and are not merged into this record.
- `"air new zealand"` returns hundreds of entities; the adapter returns the plausible ones as candidates rather than guessing. Supplying the company number is exact.

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
5. Agent results are cached for 10 minutes per name to avoid repeat browser runs. Agent fallback only runs on the as-entered name variant.

**Record URL:** `https://www.cslb.ca.gov/<licence-number>` (the `LicenseDetail.aspx?LicNum=` form redirects to a generic page and is not used).

**Parsed fields**

- `status` from the "License Status" block (`Active`, `Expired`, `Canceled`, `Revoked`, …)
- `business_name`, `address`, `phone`, `entity`
- `issue_date`, `expire_date` (US month-first dates)
- `classifications` (array, e.g. `C15 - Flooring`)
- `bond_number`, `workers_compensation`
- `complaint_disclosure` (`on file` / `none` / `not shown`) and `data_current_as_of`
- `additional_status`

**Caveats**

- CSLB's name search is a session-based ASP.NET form. TinyFish Search resolves most indexed records; the Agent handles the rest and can take up to ~2.5 minutes.
- A licence number is always the fastest and most reliable input.
- Complaint disclosure is a legal disclosure under B&P 7124.6. TinyVerify reports that it exists; it does not summarise the allegations.

---

## US NPPES NPI Registry

**Official site:** https://npiregistry.cms.hhs.gov

**Why this source:** the National Plan and Provider Enumeration System is the US federal provider registry, with a public JSON API.

**Flow**

1. Build the official API URL (`/api/?version=2.1&number=<npi>` or `&first_name=&last_name=` / `&organization_name=`).
2. Read it with **TinyFish Fetch** using `format: 'html'`. Node's `fetch` fails with `EAI_AGAIN` against this host; TinyFish Fetch returns the JSON body reliably.
3. Parse `result_count` and `results[]`.
4. With a number, the first result is the record. Without one, score every result and return a match / candidates / no match.

**Record URL:** `https://npiregistry.cms.hhs.gov/provider-view/<npi>` (the public provider view).

**Parsed fields**

- `status` from `basic.status` (`A` → active)
- `number` (NPI), provider name (individual or organisation)
- `enumeration_type` (`Individual (NPI-1)` / `Organisation (NPI-2)`)
- `primary_taxonomy`, all taxonomies
- `state_licence_number`, `state_licence_state`
- addresses (location and mailing), enumeration/certification dates

**Caveats**

- NPPES is an **enrolment** registry. It records the state licence number a provider declared but does not publish that licence's status. The record carries a note saying so.
- Organisations (NPI-2) are legal entities, not licensed practitioners; the record says so.
- NPIs are 10 digits. `number` lookups are validated before the call.

---

## Rejected sources

These were investigated and deliberately not shipped, because a broken or guessed check is worse than an honest gap.

| Source | Finding | Decision |
|---|---|---|
| **UK HCPC** | Search results page sits behind a Cloudflare interstitial; TinyFish Fetch returns `bot_blocked`, and an Agent run hit a "Verify you are human" challenge. The detail page is server-rendered but the registrant-selection parameter was not confirmed. | Not wired. Documented as [UNKNOWN] in `docs/registry-research.md`. |
| **UK GMC** | The register search is a client-side widget; query parameters are ignored server-side. An Agent run could not operate the profession dropdown, and the registrant page renders its fields client-side. GMC publishes a daily bulk register download, but access terms were not confirmed. | Not wired. Bulk download is the likely future path. |
| **Australia AHPRA** | F5 bot-defence challenge on the search page. A stealth Agent run succeeded and returned a record from the Medical Board sub-site, but it picked the first search result. Without a disambiguation rule, that is exactly the guessing TinyVerify forbids. | Not wired until registration-number lookup and exact-name matching are proven. |
| **US state boards (other than CA)** | Each state has a different portal, many form-based or captcha-protected. | Not wired in this build. |

The registry metadata is intentionally a closed list: `/api/verify` returns `unsupported` for anything not in the matrix instead of pretending to check it.
