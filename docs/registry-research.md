# Registry research log

What was probed before writing each adapter, what worked, and what was rejected. All checks were run on **2026-11-04/05** against the live public sites. Statuses are HTTP codes unless noted.

## Summary

| Candidate | Transport tested | Result | Shipped? |
|---|---|---|---|
| NZ Companies Office | plain HTTPS | **200, server-rendered** | **Yes** (`nz-companies`) |
| UK Companies House | TinyFish Search + Fetch | 200, stable record pages | **Yes** (`companies-house-uk`) |
| California CSLB | TinyFish Search + HTTPS + Agent | 200; name form needs the Agent | **Yes** (`cslb-ca`) |
| US NPPES NPI | TinyFish Fetch (JSON) | 200; Node fetch can fail `EAI_AGAIN` | **Yes** (`npi-us`) |
| Australian Business Register | plain HTTPS | **200, server-rendered; POST search → 302 results** | **Yes** (`abn-au`) |
| Florida MQA | plain HTTPS | **200; exact number → 302 detail page** | **Yes** (`mqa-fl`) |
| UK HCPC | HTTPS + Fetch + Agent | Cloudflare interstitial / `bot_blocked` | No |
| Australia AHPRA | HTTPS + Fetch + Agent | F5 challenge; stealth Agent works but ambiguous | No |
| UK GMC | HTTPS + Fetch + Agent | Client-rendered search and record; Agent could not drive it | No |

---

## NZ Companies Office — verified end to end

**Official site:** `https://www.companiesoffice.govt.nz`
**Application host:** `https://app.companiesoffice.govt.nz`

### Evidence

- Search page: `GET /companies/app/ui/pages/companies/search?q=air+new+zealand&entityTypes=ALL&entityStatusGroups=ALL&start=0&limit=15&advancedPanel=true&mode=advanced` → **200**, `text/html`, 274,104 bytes, title `Search the register`, page text `Displaying 1 - 15 of 307 results`.
- Record page: `GET /companies/app/ui/pages/companies/104799` → **200**, 236,029 bytes.
- Short link: `GET /co/104799` → **200**, redirects to the long record page.
- TinyFish Fetch on the record page returned the same fields as markdown in ~1.7 s.

### What the page contains

```text
Company number: 104799
NZBN: 9429040402543
Incorporation Date: 26 Apr 1940
Company Status: Registered
Entity type: NZ Limited Company
Registered Office: Air New Zealand House, 185 Fanshawe Street, Auckland, 1010, New Zealand
AR filing month: March, last filed on 11 Mar 2026
Last updated on: 05 Oct 2026
Previous names: TASMAN EMPIRE AIRWAYS LIMITED (from 26 Apr 1940 to 01 Apr 1965)
```

### Traps found

1. **Markdown output drops result names.** On the search page, names sit inside `href="javascript:viewCompanyDetails('104799')"` anchors. TinyFish Fetch in markdown mode returned addresses and dates but no names. The adapter parses raw HTML (`span.entityName`, `span.entityInfo`, `span.entityType`).
2. **Ambiguity is severe.** `"air new zealand"` returns 307 results because of subsidiaries and former names. The register recommends searching by company number or NZBN. The adapter returns plausible candidates instead of picking one.
3. **No expiry date** exists for a company. The record exposes the annual-return month and last-filed date instead.
4. **No disciplinary data** on the company page. Banned-director decisions live on a separate register.

---

## Australian Business Register — verified end to end

**Official site:** `https://abr.business.gov.au`

### Evidence

- Search form: `GET /Search` → **200**, server-rendered ASP.NET form.
- Search POST: `POST /Search/Run` with `SearchParameters.SearchText=Telstra` and `SearchParameters.AllNames=true` → **302** to `/Search/ResultsActive?SearchText=Telstra` → **200**, 146 active matches.
- Record page: `GET /ABN/View?id=33051775556` → **200**, legal name `TELSTRA CORPORATION LIMITED`, `ABN status: Active from 01 Nov 1999`, entity type `Australian Public Company`.
- ABN `33051775557` fails the official checksum and is rejected before the fetch.

### Traps found

1. **Search is a POST, not a query string.** A plain GET to `/Search/ResultsActive` is not the same as submitting the form; the adapter posts `SearchParameters.*`.
2. **Names live in multiple tables.** The legal name is in `itemprop="legalName"`; business and trading names are in separate `<caption>` tables. Matching against all of them avoids false negatives for trading names.
3. **Cancelled ABNs are not in the active results.** A name search therefore cannot prove an ABN was never registered; the record says to add the ABN for a cancelled check.
4. **No expiry date exists.** The register publishes status and its effective date only.

---

## Florida MQA — verified end to end

**Official site:** `https://mqa-internet.doh.state.fl.us/MQASearchServices/HealthCareProviders`

### Evidence

- Search form: `GET /HealthCareProviders` → **200**, ASP.NET MVC form with `__RequestVerificationToken`, `SearchDto.Board`, `SearchDto.Profession`, `SearchDto.LicenseNumber`, `SearchDto.LastName`, `SearchDto.FirstName`, `SearchDto.LicenseStatus`.
- Name search: `LastName=Smith`, `FirstName=John`, `Profession=1501` → **200**, `Search Results Total: 7`, first row `ME182088 Smith, John Horatio Medical Doctor ATLANTA Clear/Active`.
- Number search: `SearchDto.LicenseNumber=ME182088` → **302** `Location: /MQASearchServices/HealthcareProviders/LicenseVerification?LicInd=182095&Procde=1501`.
- Detail page → **200**, `License Number: ME182088`, status `Clear/Active`, expiry `01/31/2028`, issue date `06/01/2026`, `Discipline on File: No`.
- NPI `1295346773` and MQA `ME182088` are different identifiers; the cross-registry check queries both and shows the NPI `no_match` rather than hiding it.

### Traps found

1. **An exact number does not return a table.** It returns a 302 to the detail page. A parser that waits for `Search Results Total` sees zero rows and falsely reports `no_match`. The adapter uses `redirect: 'manual'`, recognises the `LicenseVerification` Location, follows it, and checks the detail page's number against the requested one.
2. **The redirect spells `Procde`, not `ProCde`.** The detail URL builder normalises both spellings.
3. **The search form is stateful.** The anti-forgery token and session cookie from the GET must be sent with the POST, and the detail/enforcement requests reuse the cookie.
4. **Discipline is a second request.** The detail page only carries flags; `LoadEnforcementActionsTab` carries the actions. The adapter fetches it only when a flag is positive.
5. **`Delinquent` is not active.** It maps to `expired`; the native wording stays in `status_detail`.

---

## UK HCPC — blocked, not shipped

**Target:** `https://www.hcpc-uk.org/check-the-register/`

- The search page returns **200** with a POST form (`Query`, `Profession`, `__RequestVerificationToken`) and a `js-reg-search-form` id.
- Posting the form with token and cookies → **403**, title `Just a moment...`, body `Enable JavaScript and cookies to continue` — **Cloudflare interstitial**.
- TinyFish Fetch on the results URL → per-URL error **`bot_blocked`**.
- TinyFish Agent with a stealth profile (240 s) → `status: completed`, `blocked: true`. Its note described a Cloudflare CAPTCHA and a "Verify you are human" checkbox. No record data.

**Possible future path:** `https://www.hcpc-uk.org/check-the-register/professional-registration-detail/` returned **200** and was not Cloudflare-challenged when fetched without a registrant selected. The parameter that selects a registrant was **not confirmed** (`[UNKNOWN]`). HCPC also publishes a multiple-registrant search (up to 100 numbers), which was not tested.

**Decision:** do not ship a check that cannot be completed reliably.

---

## Australia AHPRA — agent works, disambiguation not solved

**Target:** `https://www.ahpra.gov.au/Register_Search.aspx`

- Direct fetch → **200 but only 3,519 bytes**, containing F5 BIG-IP `TSPD` challenge scripts and no form.
- TinyFish Fetch → intro prose only ("A maximum of 50 results will be returned…").
- TinyFish Agent (stealth) → `found: true, blocked: false`, one run. Returned:
  - search page: `https://www.medicalboard.gov.au/Registration/Search-Practitioners.aspx`
  - record: `https://www.medicalboard.gov.au/Registration/Registers-of-Practitioners/MED0001391846`
  - fields: `MED0001391846`, Medical Practitioner, `Registered`, expiry `30/09/2027`, "No conditions, undertakings, or reprimands".
- Re-fetching the record URL directly → **200 but F5 challenge**, zero occurrences of the registration number or status. TinyFish Fetch → `empty_content`.

**Blocker:** the Agent selected the **first** search result. Production would need an exact-name rule or a registration-number lookup. That was not proven, so AHPRA is documented rather than wired.

---

## UK GMC — weakest candidate

**Target:** `https://www.gmc-uk.org/registration-and-licensing/our-registers`

- The register search is a JavaScript widget: `href="javascript:RunLRMP_v3(...)"`, `action="#"`. No server-side search.
- `/registrants?name=Smith&profession=doctors&page=1&lastNameText=Smith` → **200**, 150,131 bytes, but TinyFish Fetch rendered `Please start your search to see results.` — query parameters are ignored server-side.
- TinyFish Agent → `found: false, blocked: false`; the profession dropdown did not open and no results were returned.
- `https://www.gmc-uk.org/registrants/4630838` → **200**, title `Registrant details page`, but no GMC number, registration status or licence-to-practise strings in the HTML — client-side rendered. `https://www.gmc-uk.org/doctors/4630838` → **403**.
- Official bulk route: `/registration-and-licensing/our-registers/download-our-registers` advertises a daily full-register download. Access mechanism and terms were **not confirmed**.

**Decision:** not wired. A bulk register import is the sensible next step, not scraping a client-rendered page.

---

## US NPPES NPI — transport quirk

- Node 22 `fetch` to `https://npiregistry.cms.hhs.gov/api/?version=2.1&number=...` fails with **`EAI_AGAIN`** in this environment.
- TinyFish Fetch with `format: 'html'` returns the JSON body intact and reliably. The adapter parses it as JSON.
- NPPES is an enrolment registry: it records the state licence number a provider declared, but does not publish that licence's current status. Records say this explicitly.

---

## Selection rules used

1. **Official domain only.** A search result from any other domain is discarded.
2. **Server-rendered beats client-rendered.** A page that cannot be read deterministically is not shipped.
3. **No agent in the trust path.** The CSLB Agent returns licence numbers only; status and dates are always read from the official detail page.
4. **Ambiguity is a feature.** A registry that cannot disambiguate returns candidates, not a guess.
