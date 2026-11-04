# Discord post — #showcase

```
TinyVerify — live licence and company checks from official registries, with a paper trail

Demo: https://tinyverify.vercel.app
Repo: https://github.com/Venkata-Manoj/tinyverify

Give it a name, a record type and a jurisdiction. It reads the official registry live and
returns status, licence/registration number, expiry, disciplinary flags, the source URL and
the checked-at timestamp. Nothing is hardcoded and nothing is inferred.

Four registries:
• UK Companies House (business / UK)
• NZ Companies Office (business / NZ)
• California CSLB (contractor / US-CA)
• US NPPES NPI Registry (health / US)

Try these:
• "Tesco PLC" · business · UK              → exact, active, 00445790
• "Air New Zealand Limited" · business · NZ → exact, active, 104799, NZBN 9429040402543
• "Air New Zealand" · business · NZ         → 11 candidates, nothing auto-selected
• "DONE RIGHT DISCOUNT FLOORING" · contractor · US-CA → revoked licence, expiry 2017-05-28
• "ZZZ Not A Real Company 999" · business · UK → no_match + the searches that ran

How TinyFish is used (4 endpoints):
• Search  — resolves official record URLs, domain-filtered; anything off-domain is dropped.
• Fetch   — reads registry pages and the NPPES JSON API (Node fetch gets EAI_AGAIN there).
• Agent   — drives CSLB's session-based "Check A License" form when no page is indexed.
            It returns licence numbers only; status and dates still come from the official page.
• Monitor — daily watch per record with a webhook back into the app.

Watches store a snapshot (status, number, expiry, disciplinary, status detail) and diff on every
check. A registry outage keeps the previous snapshot and emits no event — "the site was down"
is not "the licence was revoked".

40 unit tests on pages captured from the live registries, zero runtime deps, Node 22.
Known gaps are documented rather than faked: HCPC sits behind Cloudflare, GMC is client-rendered,
AHPRA only works through a buffed agent run and would need a disambiguation rule.
```

Post it as plain text, keep the line breaks, and attach one screenshot of the NZ result and one
of the candidate list if the channel allows images.
