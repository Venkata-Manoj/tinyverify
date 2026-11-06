# Discord post — #showcase

```
TinyVerify — live licence and company checks from official registries, with a paper trail

Demo: https://tinyverify.vercel.app
Repo: https://github.com/Venkata-Manoj/tinyverify

Give it a name, a record type and a jurisdiction. It reads the official registry live and
returns status, licence/registration number, expiry, disciplinary actions, the source URL and
the checked-at timestamp. Nothing is hardcoded and nothing is inferred.

Six registries:
• UK Companies House (business / UK)
• NZ Companies Office (business / NZ)
• Australian Business Register (business / AU)
• California CSLB (contractor / US-CA)
• US NPPES NPI Registry (health / US)
• Florida MQA (health / US-FL)

Try these:
• "Tesco PLC" · business · UK              → exact, active, 00445790
• "Air New Zealand Limited" · business · NZ → exact, active, 104799, NZBN 9429040402543
• "Air New Zealand" · business · NZ         → candidates, nothing auto-selected
• "TELSTRA CORPORATION LIMITED" + 33051775556 · business · AU → exact, active
• "DONE RIGHT DISCOUNT FLOORING" + 738180 · contractor · US-CA → revoked, expiry 2017-05-28,
  arbitration A S 2016 000293
• "JOHN HORATIO SMITH II" + ME182088 · health · US-FL → NPI + Florida board in one request,
  active, expiry 2028-01-31
• "Acme Widgets" + 00445790 · business · UK → mismatch (number belongs to TESCO PLC)
• "ZZZ Not A Real Company 999" · business · UK → no_match + the searches that ran
• "!!! ***" · business · UK → no_match, zero registry calls

How TinyFish is used (4 endpoints):
• Search  — resolves official record URLs, domain-filtered; anything off-domain is dropped.
• Fetch   — reads registry pages and the NPPES JSON API (Node fetch can fail EAI_AGAIN there).
• Agent   — drives CSLB's session-based "Check A License" form when no page is indexed.
            It returns licence numbers only; status and dates still come from the official page.
• Monitor — daily watch per record with a signed webhook back into the app.

Watches store a snapshot (status, number, expiry, disciplinary, status detail) and diff on every
check. A registry outage keeps the previous snapshot and emits no event — "the site was down"
is not "the licence was revoked". The demo simulator is clearly labelled and never changes the
live snapshot.

Watch access: each watch has its own management token, shown once and stored only as a SHA-256
hash. Knowing the monitor id is not enough to read, re-check or delete it. The webhook requires
a shared secret in production, uses HMAC with a ±300 s window, and ignores replayed payloads.

102 unit tests on pages captured from the live registries, 13 live checks, zero runtime deps, Node 22.
Known gaps are documented rather than faked: HCPC sits behind Cloudflare, GMC is client-rendered,
AHPRA only works through a browser agent and would need a disambiguation rule.
```

Post it as plain text, keep the line breaks, and attach one screenshot of the NZ result and one
of the candidate list if the channel allows images.
