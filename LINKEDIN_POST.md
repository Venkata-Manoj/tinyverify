# LinkedIn post

Post from the account that built the project. When you paste it, type `@TinyFish` and pick the TinyFish company page from the dropdown so the tag is real (a plain-text "@TinyFish" is not a tag).

---

Most licensing checks still start with a search engine and end with a PDF nobody can verify.

I built **TinyVerify** for the TinyFish bounty: give it a name, a record type and a jurisdiction, and it returns the live record from the official registry — status, licence or registration number, expiry, disciplinary flags, the source URL, and the exact time it was checked.

Four registries are wired today:

• UK Companies House — company status, incorporation, registered office, filings
• NZ Companies Office — company status, NZBN, entity type, annual returns
• California CSLB — contractor licence status, issue and expiry dates, classifications, bond and complaint disclosure
• US NPPES NPI Registry — provider enrolment, NPI, taxonomy, declared state licence

The part I care about is what it refuses to do. It will not pick a record when several match. Ask for "Air New Zealand" and you get 11 candidates with their real statuses and no auto-selection; ask for "Air New Zealand Limited" and you get the exact company, NZBN 9429040402543, active. Ask for a company that does not exist and you get `no_match` plus the searches that were run — not a plausible-looking guess.

Then it watches. A watch stores a snapshot of status, number, expiry and disciplinary fields against the official record URL and re-checks daily. A real change produces an event with old value, new value, summary, source and timestamp. A registry outage or a page that stops parsing is **not** a change — the previous snapshot is kept, because "the site was down" is not "the licence was revoked".

@TinyFish did the parts plain HTTP could not:

→ **Search** resolves official record URLs on domains I trust and discards everything else.
→ **Fetch** reads the registry pages, including the NPPES JSON API that my own fetch could not reach.
→ **Agent** drives CSLB's session-based "Check A License" form when no record page is indexed. It returns licence numbers only — the status and dates are still read from the official detail page, so the agent stays out of the trust path.
→ **Monitor** runs a daily watch on each record URL with a webhook back into the app.

Live demo: https://tinyverify.vercel.app
Code: https://github.com/Venkata-Manoj/tinyverify

Node 22, zero runtime dependencies, 40 unit tests against pages captured from the live registries. Try the three sample chips — UK, NZ and California — or put a licence number in the optional number field for an exact lookup.

#TinyFish #AI #Compliance #OpenSource

---

## Shorter variant (if the long one feels heavy)

Most licence checks end with a screenshot nobody can verify.

I built **TinyVerify** for the @TinyFish bounty. Name + record type + jurisdiction in, live official record out: status, licence number, expiry, disciplinary flags, source URL and checked-at time. Four registries: UK Companies House, NZ Companies Office, California CSLB, US NPPES.

It returns candidates instead of guessing when several records match, and `no_match` when none do. Watches store a snapshot and only fire when the registry actually changes — an outage is not a revocation.

@TinyFish Search finds the official record URLs, Fetch reads the pages, Agent drives the CSLB form when nothing is indexed, and Monitor keeps the daily watch.

Demo: https://tinyverify.vercel.app
Code: https://github.com/Venkata-Manoj/tinyverify

#TinyFish #AI #Compliance
