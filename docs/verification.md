# Verification rules

This document defines what TinyVerify promises and how each promise is enforced.

## 1. The trust contract

A record is only returned when TinyVerify has **read the official registry during this request** (or a cache entry created from such a read). Every record carries:

| Field | Meaning | Enforcement |
|---|---|---|
| `source_url` | The exact official page the data came from | Must be `http(s)`; `assertRecord` rejects anything else |
| `checked_at` | ISO timestamp of the live read | Must parse as a date; cache preserves the original value |
| `source_name` | Registry name shown to the user | Required, non-empty |
| `registry_id` | Stable adapter id (`companies-house-uk`, `cslb-ca`, `npi-us`, `nz-companies`, `abn-au`, `mqa-fl`) | Set by the pipeline |
| `status` | `active` / `expired` / `suspended` / `revoked` / `dissolved` / `in_liquidation` / `inactive` / `unknown` | Only these eight values are accepted |
| `status_bounty` | `active` / `expired` / `suspended` / `unknown` | Derived from `status`, never from raw text |
| `status_detail` | The registry's own wording, unchanged | Stored alongside the mapped status |
| `match_quality` | `exact` / `close` / `mismatch` / `multiple` / `no_match` / `unsupported` | Only these six values are accepted |
| `licence_number` | Registration / licence / NPI / ABN number | `null` only when the registry has no such concept |
| `expiry_date` | `YYYY-MM-DD` or `null` | Never inferred from other dates |
| `disciplinary_actions` | Array; `["none found"]` when a disciplinary section exists but is empty | Empty arrays become `["none found"]`; registers with no disciplinary data say `["not published by this registry"]` |
| `disciplinary_records` | Structured actions | `{type, date, description, status, source_url}`; extra source fields are dropped |
| `name_number_mismatch` | `true` when a supplied name and number do not describe the same record | Set only by the name/number comparison |
| `total_found` | The registry's true result count | Reported as returned; never inferred from the page slice |

`makeRecord()` in `lib/schema.js` builds this shape and `assertRecord()` validates it. A parser that cannot fill the required fields returns no record instead of a partial one.

## 2. Name matching

Names are normalised before comparison: case, punctuation, diacritics, titles (`Dr`, `Mr`), professional suffixes (`MD`, `RN`, `II`) and repeated whitespace are removed. Legal forms are expanded for display-faithful comparison (`Ltd` → `limited`, `PLC` → `public limited company`).

The comparison then drops **generic entity words** (`Ltd`, `Limited`, `PLC`, `Inc`, `LLC`, `Group`, `Services`, `The`, …) from a separate `nameCore()`. Display values are never mutated.

`nameSimilarity()` is deliberately strict:

1. If the full normalised names match, score `1`.
2. If the core names match, score `0.99`.
3. Every token in the query must occur in the candidate, exactly or at a character-level similarity of at least `0.85`. If **any** query token is missing, the score is `0`.
4. Otherwise the score is the token-coverage F1.

That token gate is what stops `qwzxv plorb` or a partial overlap from being reported as a plausible match.

`classifyMatch()` uses these thresholds:

| Score | Classification |
|---|---|
| Normalised names identical | `exact` |
| Core names identical (only legal/generic words differ) | `close` |
| Score ≥ 0.95 | `exact` |
| 0.80 ≤ score < 0.95 | `close` |
| < 0.80 | `no_match` |

Name variants are generated in this order and tried at most twice beyond the entered name:

1. As entered.
2. Comma order reversed (`Smith, Jane` → `Jane Smith`).
3. Titles and suffixes removed.
4. Middle initials removed.
5. Mc/Mac spelling variants.
6. Hyphen removed.

When a variant other than the entered name produces the match, `variant_used` is set and a note explains which variant was used.

## 3. Ambiguity and mismatches

The pipeline never picks a record out of several plausible ones.

- **One record, no competing candidates** → `exact` or `close`.
- **Several plausible records** → `multiple`; every candidate is returned with its own `source_url` and status. `primary` is `null` when there is no single record to prefer.
- **Records below 0.80** → `near_misses`. They are returned for human review but do **not** count as matches and cannot turn a `no_match` into a `multiple`.
- **No records at all** → `no_match`; `suggestions` lists the variants that were tried, and `searched` lists every registry, URL and outcome.
- **Unsupported pair** → `unsupported`; the response lists the combinations that are supported.

A registration number is an identity, not a fuzzy name search:

- If a number is supplied **without** a subject, the record is `exact` by number.
- If a name **and** number are supplied, the official name is compared with the supplied name. Below the 0.80 threshold the record becomes `mismatch`, `name_number_mismatch` is `true`, and a note says the number matched but the name did not. The record is still returned — hiding it would make the mismatch invisible — but the caller is told not to treat the pair as verified.

Two registries resolving the same subject are returned as **separate records** with a note. If their statuses disagree, `reconcileStatuses()` sets `conflict: true` and the response status becomes `unknown`; neither record is modified. The UI shows both and explains the disagreement. The Florida check is the deliberate cross-registry case: NPPES and MQA are both queried, and the state board record is preferred as `primary` because it carries expiry and discipline.

## 4. Status mapping

Registry wording is mapped to a shared eight-value vocabulary, but the original string is always kept in `status_detail`.

| Order | Registry says | Mapped status |
|---|---|---|
| 1 | Starts with Active, Registered, Current, Licensed, Valid, Renewed, In good standing, Clear/Active | `active` |
| 2 | Revoked, Revocation | `revoked` |
| 3 | Suspended, Restricted, Conditions, Interim order, Prohibited, Disqualified | `suspended` |
| 4 | Liquidat…, Receivership, Administration, Voluntary arrangement, Winding up | `in_liquidation` |
| 5 | Dissolved, Struck off, Removed from register | `dissolved` |
| 6 | Inactive, Not registered, Cancelled/Canceled, Null and Void, Surrendered, Withdrawn, Deceased, No longer, Closed, Ceased | `inactive` |
| 7 | Delinquent | `expired` |
| 8 | Contains Active/Registered/Licensed to practise | `active` |
| 9 | Expired, Expiry, Lapsed | `expired` |
| 10 | Anything else | `unknown` |

Order matters: "Active — proposal to strike off" is `active` because active wording is checked first; "Delinquent/Active" is `expired` because the delinquency rule is checked before the broad active-word rule; "Liquidation" is `in_liquidation`, not `dissolved`.

`status_bounty` is the coarser view used by a clearance check:

| `status` | `status_bounty` |
|---|---|
| `active` | `active` |
| `suspended`, `revoked` | `suspended` |
| `expired`, `dissolved`, `in_liquidation`, `inactive` | `expired` |
| `unknown` | `unknown` |

A registry string that matches no rule is `unknown`, never a guess.

## 5. Cache and refresh

- TTL: 10 minutes (`TINYVERIFY_CACHE_TTL`).
- Cache key: subject + type + jurisdiction + number + state + city + taxonomy.
- A cached response is marked `cached: true`, keeps the **original** `source_url` and `checked_at`, reports `cache_age_seconds`, and adds a note saying it was served from cache.
- `refresh: true` bypasses and replaces the cache entry. Because it costs an upstream read, the API honours it only for a caller presenting a valid admin key; every other caller gets the normal cached response.
- Monitor checks always refresh.

## 6. Watches and change events

A watch stores a snapshot of the five fields that matter:

```js
['status', 'licence_number', 'expiry_date', 'disciplinary_actions', 'status_detail']
```

On every check:

1. TinyVerify re-runs the full verification pipeline (`refresh: true`) — not just the TinyFish Monitor payload.
2. If the registry returns no confident record, or the request errors, the **previous snapshot is kept** and the check is marked `ok: false`. No change event is emitted. A site outage, bot challenge or parser miss is not a licence change.
3. If a record is returned, the new snapshot is diffed against the stored one. Only changed fields produce an event, with `old`, `new`, `summary`, `checked_at` and `source_url`.
4. A change event is appended to the watch history (maximum 50 events) and returned to the caller.
5. A manual check also triggers the TinyFish Monitor run when a monitor id exists; the response records the run id. The webhook path deliberately does **not** start another run — that would be a paid round trip and could loop.

The TinyFish webhook (`POST /api/webhooks/tinyfish`) never trusts the payload as data. It looks up the local watch by TinyFish monitor id and performs the same re-verify-and-diff. Unknown monitor ids are acknowledged and ignored.

The demo simulator (`POST /api/monitors/:id/simulate`) is available only when `TINYVERIFY_DEMO=1`. It appends an event marked `simulated: true` and `detected_by: "TinyVerify demo simulator (not a live read)"` and leaves `snapshot` untouched. A simulated event can never be mistaken for a registry change.

## 7. Watch access control

- The browser generates a random **owner token**; the server stores only its SHA-256 hash and never returns it.
- Creating a watch returns a random **`manage_token`** exactly once. The server stores only its SHA-256 hash. `GET`, `check` and `DELETE` require it as `X-TinyVerify-Watch-Token`; possession of a monitor id is not enough.
- A wrong token returns `404` with the same message as a missing watch, so ids cannot be probed.
- `GET /api/monitors` returns only the caller's watches. With `X-TinyVerify-Admin: <TINYVERIFY_ADMIN_KEY>` it returns all watches.
- A legacy watch without a `manage_hash` falls back to the owner hash. A watch with neither credential is denied with `401 WATCH_TOKEN_REQUIRED`.

## 8. Manual live matrix

Run against the live sources on **2026-11-05**; the automated live suite repeats these checks.

| Input | Type / jurisdiction | Observed |
|---|---|---|
| `Tesco PLC` | business / UK | `exact`, `active`, `00445790`, Companies House source |
| `qwzxv plorb` | business / UK | `no_match`, 0 candidates, searches listed |
| `Acme Widgets` + `00445790` | business / UK | `mismatch`, `name_number_mismatch: true`, official name `TESCO PLC` |
| `Carillion PLC` | business / UK | `exact`, `in_liquidation`, `status_detail: "Liquidation"`, `status_bounty: "expired"` |
| `Air New Zealand Limited` + `104799` | business / NZ | `exact`, `active`, NZBN `9429040402543` |
| `TELSTRA CORPORATION LIMITED` + `33051775556` | business / AU | `exact`, `active`, expiry `null`, entity `Australian Public Company` |
| `33051775557` | business / AU | HTTP 400 `BAD_NUMBER` (ABN checksum) |
| `John Smith` | health / US | `multiple`, `total_found: 187`, 20 candidates, no `Jack` |
| `Planise Jean Louis` + `1295346773` | health / US | `exact`, `active`, NPI matched |
| `DONE RIGHT DISCOUNT FLOORING` + `738180` | contractor / US-CA | `exact`, `revoked`, expiry `2017-05-28`, arbitration `A S 2016 000293` |
| `JOHN HORATIO SMITH II` + `ME182088` | health / US-FL | `exact`, `active`, expiry `2028-01-31`, NPI `no_match`, MQA `match` |
| `!!! ***` | business / UK | `no_match`, `searched: []`, no registry call |
| `Test Doctor` | health / JP | `unsupported`, supported health jurisdictions listed |

## 9. What TinyVerify will not do

- It will not return a status without a `source_url` from the official registry.
- It will not treat a search-engine snippet as a record.
- It will not merge disagreeing registries into one status.
- It will not turn an empty result into a "likely" match.
- It will not accept a name/number pair as verified when the number belongs to a different name.
- It will not describe a record as safe, approved or suitable for hire; it reports what the register says.
