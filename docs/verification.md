# Verification rules

This document defines what TinyVerify promises, and how each promise is enforced in code.

## 1. The trust contract

A record is only returned when TinyVerify has **read the official registry during this request** (or a cache entry created from such a read). Every record carries:

| Field | Meaning | Enforcement |
|---|---|---|
| `source_url` | The exact official page the data came from | Must be `http(s)`; `assertRecord` rejects anything else |
| `checked_at` | ISO timestamp of the live read | Must parse as a date; cache preserves the original value |
| `source_name` | Registry name shown to the user | Required, non-empty |
| `registry_id` | Stable adapter id (`companies-house-uk`, `cslb-ca`, `npi-us`, `nz-companies`) | Set by the pipeline |
| `status` | `active` / `expired` / `suspended` / `unknown` | Only these four values are accepted |
| `status_detail` | Registry's own wording, unchanged | Stored alongside the mapped status |
| `match_quality` | `exact` / `close` / `multiple` / `no_match` / `unsupported` | Only these five values are accepted |
| `licence_number` | Registration / licence / NPI number | `null` only when the registry has no such concept |
| `expiry_date` | `YYYY-MM-DD` or `null` | Never inferred from other dates |
| `disciplinary_actions` | Array; `["none found"]` when the registry shows none | Empty arrays are normalised to `["none found"]` |

`makeRecord()` in `lib/schema.js` builds this shape and `assertRecord()` validates it. A parser that cannot fill the required fields returns no record instead of a partial one.

## 2. Name matching

Names are normalised before comparison: case, punctuation, diacritics, titles (`Dr`, `Mr`), legal suffixes (`Ltd`, `Limited`, `PLC`, `Inc`, `LLC`) and repeated whitespace are removed.

`nameSimilarity()` combines token Jaccard similarity, Levenshtein similarity, and a containment bonus. `classifyMatch()` uses fixed thresholds:

| Score | Classification |
|---|---|
| names identical after normalisation, or score ≥ 0.92 | `exact` |
| 0.62 ≤ score < 0.92 | `close` |
| < 0.62 | `no_match` |

Name variants are generated in this order and tried at most twice:

1. As entered.
2. Comma order reversed (`Smith, Jane` → `Jane Smith`).
3. Middle initials removed (`Jane A Smith` → `Jane Smith`).

When a variant other than the entered name produces the match, the record's `variant_used` is set and a note explains which variant was used.

## 3. Ambiguity

The pipeline never picks a record out of several plausible ones.

- **One record, no competing candidates** → `exact` or `close`.
- **Several plausible records** → `multiple`; every candidate is returned with its own `source_url` and status. `primary` is `null`.
- **Records below 0.62** → `near_misses`. They are returned for human review but do **not** count as matches and cannot turn a `no_match` into a `multiple`.
- **No records at all** → `no_match`; `suggestions` lists the variants that were tried, and `searched` lists every registry, URL and outcome.
- **Unsupported pair** → `unsupported`; the response lists the combinations that are supported.

Two registries resolving the same subject are returned as **separate records** with a note. If their statuses disagree, `reconcileStatuses()` sets `conflict: true` and the response status becomes `unknown`; neither record is modified. The UI shows both and explains the disagreement.

## 4. Status mapping

Registry wording is mapped to a shared four-value vocabulary, but the original string is always kept in `status_detail`.

| Registry says | Mapped status |
|---|---|
| Active, Registered, Current, Licensed, Valid, In good standing | `active` |
| Suspended, Revoked, Restricted, Conditions, Interim order, Prohibited, Disqualified | `suspended` |
| Expired, Lapsed, Dissolved, Closed, Ceased, Surrendered, Inactive, Removed, Cancelled, Struck off, Withdrawn | `expired` |
| Anything else | `unknown` |

Order matters: "Active — proposal to strike off" is `active` because active wording is checked first. "This license is expired and not able to contract" is `expired`. A registry string that does not match any rule is `unknown`, never a guess.

## 5. Cache

- TTL: 10 minutes (`TINYVERIFY_CACHE_TTL`).
- Cache key: subject + type + jurisdiction + number.
- A cached response is marked `cached: true`, keeps the **original** `source_url` and `checked_at`, reports `cache_age_seconds`, and adds a note saying it was served from cache.
- `refresh: true` bypasses and replaces the cache entry. Monitor checks always refresh.

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
5. TinyFish Monitor runs are triggered on every manual check when a monitor id exists; the response records the TinyFish `run_id`.

The TinyFish webhook (`POST /api/webhooks/tinyfish`) never trusts the payload as data. It looks up the local watch by TinyFish monitor id and performs the same re-verify-and-diff. Unknown monitor ids are acknowledged and ignored.

## 7. Manual verification matrix

These were run against the live sources during the build. Expected values are the ones observed.

| Input | Type / jurisdiction | Expected |
|---|---|---|
| `Tesco PLC` | business / UK | `exact`, `active`, `00445790`, source on `find-and-update.company-information.service.gov.uk` |
| `Tesco` | business / UK | `multiple`, 4 candidates, no primary |
| `ZZZ Not A Real Company 999` | business / UK | `no_match`, suggestions, no invented record |
| `Air New Zealand Limited` | business / NZ | `exact`, `active`, `104799`, NZBN `9429040402543` |
| `Air New Zealand` | business / NZ | `multiple`, 9+ candidates, statuses preserved (active/expired) |
| `DONE RIGHT DISCOUNT FLOORING` / `738180` | contractor / US-CA | `exact`, `suspended`, expiry `2017-05-28`, complaint disclosure on file |
| `HALA TREE SERVICE` | contractor / US-CA | Agent fallback → `multiple`, `574648` and `1000000`, both `expired` |
| `Planise Jean Louis` / `1295346773` | health / US | `exact`, `active`, NPI `1295346773`, FL APRN licence |
| `Mayo Clinic` | health / US | `multiple`, 10 candidates, no auto-pick |
| `Test Doctor` | medical / NZ | `unsupported`, supported combinations listed |

## 8. What TinyVerify will not do

- It will not return a status without a `source_url` from the official registry.
- It will not treat a search-engine snippet as a record.
- It will not merge disagreeing registries into one status.
- It will not turn an empty result into a "likely" match.
- It will not describe a record as safe, approved or suitable for hire; it reports what the register says.
