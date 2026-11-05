# LinkedIn post

Post from the account that built the project. When you paste it, type `@TinyFish` and pick the TinyFish company page from the dropdown so the tag is real (a plain-text "@TinyFish" is not a tag).

---

Most licensing checks still start with a search engine and end with a PDF nobody can verify.

I built **TinyVerify** for the TinyFish bounty: give it a name, a record type and a jurisdiction, and it returns the live record from the official registry — status, licence or registration number, expiry, disciplinary actions, the source URL, and the exact time it was checked.

Six registries are wired today:

• UK Companies House — company status, incorporation, registered office, filings
• NZ Companies Office — company status, NZBN, entity type, annual returns
• Australian Business Register — ABN status, entity type, GST, business and trading names
• California CSLB — contractor licence status, issue and expiry dates, classifications, bond and real complaint/arbitration disclosure
• US NPPES NPI Registry — provider enrolment, NPI, taxonomy, declared state licence
• Florida MQA — physician/nurse licence status, expiry, issue date, discipline and public complaints

Florida is checked as a pair: one request queries the federal NPI registry and the Florida board together, keeps both outcomes, and prefers the state record because it carries expiry and discipline.

The part I care about is what it refuses to do. It will not pick a record when several match. Ask for "Air New Zealand" and you get candidates with their real statuses and no auto-selection; ask for "Air New Zealand Limited" and you get the exact company, NZBN 9429040402543, active. Ask for a company that does not exist and you get `no_match` plus the searches that were run — not a plausible-looking guess. Give it a real company name with the wrong company number and it returns the record but flags `mismatch`, because the number matched and the name did not.

Then it watches. A watch stores a snapshot of status, number, expiry and disciplinary fields against the official record URL and re-checks daily. A real change produces an event with old value, new value, summary, source and timestamp. A registry outage or a page that stops parsing is **not** a change — the previous snapshot is kept, because "the site was down" is not "the licence was revoked". The demo simulator is clearly labelled, writes `simulated: true`, and never touches the live snapshot.

@TinyFish did the parts plain HTTP could not:

→ **Search** resolves official record URLs on domains I trust and discards everything else.
→ **Fetch** reads the registry pages, including the NPPES JSON API that my own fetch could not reach.
→ **Agent** drives CSLB's session-based "Check A License" form when no record page is indexed. It returns licence numbers only — status and dates are still read from the official detail page, so the agent stays out of the trust path.
→ **Monitor** runs a daily watch on each record URL with a signed webhook back into the app.

Live demo: https://tinyverify.vercel.app
Code: https://github.com/Venkata-Manoj/tinyverify

Node 22, zero runtime dependencies, 58 unit tests against pages captured from the live registries and 12 live checks. Try the sample chips for the UK, NZ, Australia, California and Florida, or put a licence number in the optional number field for an exact lookup.

#TinyFish #AI #Compliance #OpenSource

---

## Shorter variant (if the long one feels heavy)

Most licence checks end with a screenshot nobody can verify.

I built **TinyVerify** for the @TinyFish bounty. Name + record type + jurisdiction in, live official record out: status, licence number, expiry, disciplinary actions, source URL and checked-at time. Six registries: UK Companies House, NZ Companies Office, Australian Business Register, California CSLB, US NPPES and Florida MQA — including a single Florida request that queries the federal NPI registry and the state board together.

It returns candidates instead of guessing when several records match, `no_match` when none do, and `mismatch` when a name and a number describe different records. Watches store a snapshot and only fire when the registry actually changes — an outage is not a revocation.

@TinyFish Search finds the official record URLs, Fetch reads the pages, Agent drives the CSLB form when nothing is indexed, and Monitor keeps the daily watch with a signed webhook.

Demo: https://tinyverify.vercel.app
Code: https://github.com/Venkata-Manoj/tinyverify

#TinyFish #AI #Compliance
