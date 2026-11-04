# Registry research log

What was probed before writing each adapter, what worked, and what was rejected. All checks were run on **2026-11-04/05** against the live public sites. Statuses are HTTP codes unless noted.

## Summary

| Candidate | Transport tested | Result | Shipped? |
|---|---|---|---|
| NZ Companies Office | plain HTTPS | **200, server-rendered** | **Yes** (`nz-companies`) |
| UK Companies House | TinyFish Search + Fetch | 200, stable record pages | **Yes** (`companies-house-uk`) |
| California CSLB | TinyFish Search + HTTPS + Agent | 200; name form needs the Agent | **Yes** (`cslb-ca`) |
| US NPPES NPI | TinyFish Fetch (JSON) | 200; Node fetch fails `EAI_AGAIN` | **Yes** (`npi-us`) |
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
